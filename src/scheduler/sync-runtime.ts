import { sanitizeDiagnosticText } from '../diagnostics.js';
import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
import type { FavoriteScanPort } from './favorite-scan.js';
import type { SyncWorkflowPort } from '../ports/scheduler-workflows.js';
import { createSyncWorkflow } from './sync-workflow.js';

export type SyncTrigger = 'auto' | 'manual' | 'reconcile' | 'remote_reconcile';

export interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}

export interface SchedulerSnapshot {
  status: 'idle' | 'queued' | 'running' | 'cooldown';
  mode: string | null;
  title: string;
  detail: string;
  userName?: string;
  folderTitle?: string;
  mediaId?: number;
  page?: number;
  pageSize?: number;
  indexed?: number;
  biliTotal?: number;
  checked?: number;
  total?: number;
  queuedActions: string[];
  lastError?: string;
  startedAt?: number;
  updatedAt?: number;
  nextRunAt?: number;
}

export interface SyncCycleStats {
  startedAt: string;
  trigger: SyncTrigger;
  newItems: number;
  queuedItems: number;
  remoteEligible: number;
  remoteChecked: number;
  remoteOk: number;
  remoteMissingDetected: number;
  remoteMissingUnavailable: number;
  requeuedFromRemoteMissing: number;
  remoteErrors: number;
  error?: string;
}

export interface SyncRuntimeDependencies {
  users(): BiliUser[];
  eligible(user: BiliUser): boolean;
  state: Pick<StateManager, 'getUserCooldown' | 'setUserCooldown'>;
  scan: FavoriteScanPort;
  accepting(): boolean;
  blocked(): boolean;
  now(): number;
  random(): number;
  sleep(ms: number): Promise<void>;
  triggerLabel(trigger: SyncTrigger): string;
  clearRemoteListings(): void;
  recoverStaleActiveBackups(): void;
  requeueRetryPendingBeforeScan(): number;
  verifyRemoteSamples(manual: boolean, force: boolean, cycle: SyncCycleStats): Promise<Partial<SyncCycleStats>>;
  logCycleSummary(stats: SyncCycleStats): void;
  scheduleQueued(options: TickOptions): void;
}

/**
 * Owns all mutable state for a synchronization cycle. The scheduler runtime
 * only supplies admission, projections and side effects through this port.
 */
export function createSyncRuntime(dependencies: SyncRuntimeDependencies): SyncWorkflowPort {
  let running = false;
  let pending: TickOptions | null = null;
  let progress: SchedulerSnapshot | null = null;
  let cycle: SyncCycleStats | null = null;
  let lastError = '';
  let stopped = false;
  const activeUsers = new Set<string>();

  const workflow = createSyncWorkflow({
    users: dependencies.users,
    eligible: dependencies.eligible,
    state: dependencies.state,
    scan: dependencies.scan,
    progress: patch => updateProgress(patch),
    enterUser: id => activeUsers.add(id),
    leaveUser: id => activeUsers.delete(id),
    random: dependencies.random,
    sleep: dependencies.sleep,
  });

  function createCycleStats(trigger: SyncTrigger): SyncCycleStats {
    return {
      startedAt: new Date(dependencies.now()).toISOString(),
      trigger,
      newItems: 0,
      queuedItems: 0,
      remoteEligible: 0,
      remoteChecked: 0,
      remoteOk: 0,
      remoteMissingDetected: 0,
      remoteMissingUnavailable: 0,
      requeuedFromRemoteMissing: 0,
      remoteErrors: 0,
    };
  }

  function mergeTickOptions(current: TickOptions | null, incoming: TickOptions): TickOptions {
    if (!current) return { ...incoming };
    const priority: Record<SyncTrigger, number> = { auto: 0, remote_reconcile: 1, manual: 2, reconcile: 3 };
    const currentTrigger = current.trigger || 'auto';
    const incomingTrigger = incoming.trigger || 'auto';
    return {
      trigger: priority[incomingTrigger] >= priority[currentTrigger] ? incomingTrigger : currentTrigger,
      forceFullRemoteVerify: Boolean(current.forceFullRemoteVerify || incoming.forceFullRemoteVerify),
      forceFullFavoriteScan: Boolean(current.forceFullFavoriteScan || incoming.forceFullFavoriteScan),
      skipFavoriteScan: Boolean(current.forceFullFavoriteScan || incoming.forceFullFavoriteScan)
        ? false : Boolean(current.skipFavoriteScan && incoming.skipFavoriteScan),
    };
  }

  function updateProgress(patch: Partial<SchedulerSnapshot>) {
    const previous = progress;
    const snapshot: SchedulerSnapshot = {
      status: 'running',
      mode: patch.mode ?? previous?.mode ?? cycle?.trigger ?? 'auto',
      title: patch.title ?? previous?.title ?? dependencies.triggerLabel(cycle?.trigger || 'auto'),
      detail: patch.detail ?? previous?.detail ?? '正在运行调度任务。',
      startedAt: previous?.startedAt || dependencies.now(),
      updatedAt: dependencies.now(),
      queuedActions: pending ? [dependencies.triggerLabel(pending.trigger || 'auto')] : [],
    };
    for (const key of ['userName', 'folderTitle', 'mediaId', 'page', 'pageSize', 'indexed', 'biliTotal', 'checked', 'total', 'lastError', 'nextRunAt'] as const) {
      if (key in patch) snapshot[key] = patch[key] as never;
    }
    progress = snapshot;
  }

  async function run(manual = false, options: TickOptions = {}) {
    if (stopped || !dependencies.accepting() || dependencies.blocked() || running) return false;
    const trigger = options.trigger || (manual ? 'manual' : 'auto');
    running = true;
    cycle = createCycleStats(trigger);
    progress = {
      status: 'running', mode: trigger, title: dependencies.triggerLabel(trigger),
      detail: '正在准备调度任务。', queuedActions: pending ? [dependencies.triggerLabel(pending.trigger || 'auto')] : [],
      startedAt: dependencies.now(), updatedAt: dependencies.now(),
    };
    lastError = '';
    try {
      dependencies.clearRemoteListings();
      if (!options.skipFavoriteScan) {
        dependencies.recoverStaleActiveBackups();
        cycle.queuedItems += dependencies.requeueRetryPendingBeforeScan();
        await workflow.run(manual, options.forceFullFavoriteScan === true);
      }
      Object.assign(cycle, await dependencies.verifyRemoteSamples(manual, options.forceFullRemoteVerify === true, cycle));
      dependencies.logCycleSummary(cycle);
    } catch (error: unknown) {
      const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 1_000);
      console.error('[Scheduler] Tick failed:', message);
      cycle.error = message;
      lastError = message;
      dependencies.logCycleSummary(cycle);
    } finally {
      cycle = null;
      running = false;
      progress = null;
      const queued = pending;
      pending = null;
      if (queued && !stopped && dependencies.accepting()) dependencies.scheduleQueued(queued);
    }
    return true;
  }

  function triggerOrQueue(options: TickOptions) {
    if (stopped || !dependencies.accepting() || dependencies.blocked()) return { started: false, queued: false };
    if (running) {
      pending = mergeTickOptions(pending, options);
      return { started: false, queued: true };
    }
    void run((options.trigger || 'auto') !== 'auto', options);
    return { started: true, queued: false };
  }

  return {
    start: () => { stopped = false; },
    stop: () => { stopped = true; pending = null; },
    run,
    triggerOrQueue,
    updateProgress,
    isBusy: () => running || activeUsers.size > 0,
    isIdle: () => !running && activeUsers.size === 0,
    async waitForIdle(timeoutMs = 20_000) {
      const deadline = dependencies.now() + timeoutMs;
      while ((running || activeUsers.size > 0) && dependencies.now() < deadline) await dependencies.sleep(Math.min(50, Math.max(1, deadline - dependencies.now())));
      return !running && activeUsers.size === 0;
    },
    resetAfterRebind: () => {
      if (running || activeUsers.size > 0) throw new Error('Cannot reset sync workflow while a cycle is active');
      pending = null;
      progress = null;
      cycle = null;
      lastError = '';
    },
    hasPending: () => pending !== null,
    isSyncing: (userId: string) => activeUsers.has(userId),
    getProgress: () => progress ? { ...progress, queuedActions: [...progress.queuedActions] } : null,
    getCycle: () => cycle ? { ...cycle } : null,
    getPending: () => pending ? { ...pending } : null,
    getLastError: () => lastError,
    recordScanCounts: (fresh: number, queued: number) => {
      if (cycle) {
        cycle.newItems += fresh;
        cycle.queuedItems += queued;
      }
    },
    addQueuedItems: (count: number) => { if (cycle) cycle.queuedItems += count; },
    clearPending: () => { pending = null; },
  };
}
