import type { BBDownApiMode } from '../config.js';
import type { StateManager } from '../state.js';
import { computeDownloadStartDelayMs } from './retry-policy.js';
import type { RuntimeTimer } from './runtime-timers.js';
import { DownloadApiHealth, type DownloadApiTaskIdentity, type PersistedDownloadApiCooldown } from '../download-api-health.js';
import { DownloadTask, QualityUpgradeDownloadTask, type QualityUpgradeTask } from '../tasks.js';
import { readTaskFailure } from './task-failure.js';

export interface DownloadAdmissionDependencies {
  state: Pick<StateManager, 'setDownloadApiCooldown' | 'clearDownloadApiCooldown'>;
  now(): number;
  random(): number;
  hasTimer(name: RuntimeTimer): boolean;
  cancelTimer(name: RuntimeTimer): void;
  startTimer(name: RuntimeTimer, callback: () => void, delayMs: number): void;
  poke(): void;
}

/** Owns API health, probe cooldown persistence and the inter-download delay. */
export function createDownloadAdmission(dependencies: DownloadAdmissionDependencies) {
  const health = new DownloadApiHealth(dependencies.now);
  let nextStartAt = 0;
  let stopped = false;

  function persist(value: PersistedDownloadApiCooldown | null) {
    if (value) dependencies.state.setDownloadApiCooldown(value);
    else dependencies.state.clearDownloadApiCooldown();
  }

  function taskIdentity(task: DownloadTask | QualityUpgradeDownloadTask) {
    const cookie = task instanceof QualityUpgradeDownloadTask ? task.control.cookie : task.cookie;
    return { bvid: task.bvid, userId: String(task.userId || ''), hasAppToken: Boolean(cookie?.accessToken) };
  }

  function handleTaskFailure(task: DownloadTask | QualityUpgradeDownloadTask, rawError: unknown) {
    const error = readTaskFailure(rawError);
    const identity = taskIdentity(task);
    let persisted: PersistedDownloadApiCooldown | null;
    if (error.biliRiskControl && error.apiMode === 'web') {
      persisted = health.open(identity);
    } else if (task instanceof QualityUpgradeDownloadTask ? task.control.apiProbe : task.apiProbe) {
      persisted = health.probeFailed(identity, error.message || '风控探测失败', error.permanent);
    } else {
      return undefined;
    }
    persist(persisted);
    dependencies.poke();
    return health.getRetryAt();
  }

  function handleTaskReady(task: DownloadTask | QualityUpgradeTask) {
    const identity = { bvid: task.bvid, userId: String(task.userId || task.target?.userId || '') };
    const becameReady = health.ready(identity);
    if (becameReady) {
      persist(null);
      dependencies.poke();
    }
    return becameReady;
  }

  return {
    start() { stopped = false; },
    stop() { stopped = true; dependencies.cancelTimer('downloadStart'); },
    isIdle: () => true,
    waitForIdle: async () => true,
    resetAfterRebind() { nextStartAt = 0; },
    configure(mode: BBDownApiMode) { health.configure(mode); },
    restore(value?: PersistedDownloadApiCooldown | null) { health.restore(value); },
    getSnapshot: () => health.getSnapshot(),
    getRetryAt: () => health.getRetryAt(),
    open(identity: DownloadApiTaskIdentity, reason?: string) {
      const value = health.open(identity, reason);
      persist(value);
      dependencies.poke();
      return value;
    },
    probeFailed(identity: Pick<DownloadApiTaskIdentity, 'bvid' | 'userId'>, reason: string, permanent: boolean) {
      const value = health.probeFailed(identity, reason, permanent);
      persist(value);
      dependencies.poke();
      return value;
    },
    ready(identity: Pick<DownloadApiTaskIdentity, 'bvid' | 'userId'>) {
      const ready = health.ready(identity);
      if (ready) {
        persist(null);
        dependencies.poke();
      }
      return ready;
    },
    claimStart: (identity: DownloadApiTaskIdentity) => health.claimStart(identity),
    taskIdentity,
    handleTaskFailure,
    handleTaskReady,
    canQueueRecovery: (identity: Pick<DownloadApiTaskIdentity, 'bvid' | 'userId'>) => health.canQueueRecovery(identity),
    markStarted() {
      nextStartAt = dependencies.now() + computeDownloadStartDelayMs(dependencies.random);
    },
    beforeStart() {
      if (stopped) return false;
      if (dependencies.now() < nextStartAt) {
        if (!dependencies.hasTimer('downloadStart')) {
          dependencies.startTimer('downloadStart', dependencies.poke, Math.max(0, nextStartAt - dependencies.now()));
        }
        return false;
      }
      return true;
    },
    get nextStartAt() { return nextStartAt; },
  };
}
