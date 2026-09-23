import { sanitizeDiagnosticText } from '../diagnostics.js';
import type { PersistentJobStore } from '../job-store.js';
import type { TaskQueue } from '../queue.js';
import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
import { createQueueBoardProjection } from './queue-board-projection.js';
import { projectQueueSnapshot } from './queue-projection.js';
import type { SchedulerSnapshot, SyncTrigger } from './sync-runtime.js';

interface SyncProjectionPort {
  getPending(): { trigger?: SyncTrigger } | null;
  getProgress(): SchedulerSnapshot | null;
  getLastError(): string;
}

interface SchedulerStatusDependencies<
  LocalCache extends object,
  UploadHealth extends object,
  DownloadApiHealth extends object,
  DownloadRecovery,
  RecoverySnapshot extends object,
  MaintenanceSnapshot,
> {
  sync: SyncProjectionPort;
  nextRunAt(): number | undefined;
  state: Pick<StateManager, 'getAllCooldowns' | 'getVideoMetaBatch' | 'getChargingRestrictionSummary'>;
  eligibleUsers(): Array<Pick<BiliUser, 'id' | 'name'>>;
  queues: {
    download: Pick<TaskQueue, 'getTasks'>;
    upload: Pick<TaskQueue, 'getTasks'>;
    verification: Pick<TaskQueue, 'getTasks'>;
  };
  queuePrefetchLimit(): number | undefined;
  jobs: PersistentJobStore;
  now(): number;
  localCache(): LocalCache;
  uploadHealth(): UploadHealth;
  downloadApiHealth(): DownloadApiHealth;
  downloadRecovery(): DownloadRecovery;
  recoverySnapshot(): RecoverySnapshot;
  maintenanceSnapshot(): MaintenanceSnapshot;
}

export function schedulerTriggerLabel(trigger?: SyncTrigger) {
  switch (trigger) {
    case 'manual': return '立即同步';
    case 'reconcile': return '全量扫描并对账';
    case 'remote_reconcile': return '状态对账（仅远端存储）';
    case 'auto':
    default: return '自动同步';
  }
}

/** Builds the read-only scheduler and queue projections from narrow state ports. */
export function createSchedulerStatusProjection<
  LocalCache extends object,
  UploadHealth extends object,
  DownloadApiHealth extends object,
  DownloadRecovery,
  RecoverySnapshot extends object,
  MaintenanceSnapshot,
>(deps: SchedulerStatusDependencies<
  LocalCache,
  UploadHealth,
  DownloadApiHealth,
  DownloadRecovery,
  RecoverySnapshot,
  MaintenanceSnapshot
>) {
  const board = createQueueBoardProjection({ metadata: bvids => deps.state.getVideoMetaBatch(bvids) });

  function schedulerSnapshot(): SchedulerSnapshot {
    const pending = deps.sync.getPending();
    const queuedActions = pending ? [schedulerTriggerLabel(pending.trigger || 'auto')] : [];
    const progress = deps.sync.getProgress();
    const cooldowns = deps.state.getAllCooldowns();
    const eligibleUsers = Object.keys(cooldowns).length ? deps.eligibleUsers() : [];
    const coolingUsers = eligibleUsers.filter(user => cooldowns[user.id]);
    const accountCooldown = coolingUsers.length ? {
      count: coolingUsers.length,
      earliestUntil: coolingUsers.reduce((earliest, user) => Math.min(earliest, cooldowns[user.id].until), Number.POSITIVE_INFINITY),
      ...(coolingUsers.length === 1 ? { userName: coolingUsers[0].name } : {}),
    } : undefined;
    const nextRunAt = deps.nextRunAt();
    if (progress) {
      return {
        ...progress,
        queuedActions,
        lastError: sanitizeDiagnosticText(deps.sync.getLastError(), 500),
        nextRunAt,
        accountCooldown,
      };
    }

    if (!queuedActions.length && eligibleUsers.length > 0 && coolingUsers.length === eligibleUsers.length) {
      const onlyCooldown = coolingUsers.length === 1 ? cooldowns[coolingUsers[0].id] : undefined;
      return {
        status: 'cooldown',
        mode: 'cooldown',
        title: '账号冷却中',
        detail: onlyCooldown ? sanitizeDiagnosticText(onlyCooldown.reason, 500) : `${coolingUsers.length} 个账号处于冷却中`,
        userName: accountCooldown?.userName,
        queuedActions,
        lastError: sanitizeDiagnosticText(deps.sync.getLastError(), 500),
        updatedAt: deps.now(),
        nextRunAt,
        accountCooldown,
      };
    }

    return {
      status: queuedActions.length ? 'queued' : 'idle',
      mode: queuedActions.length ? 'queued' : 'idle',
      title: queuedActions.length ? '调度任务已排队' : '当前调度空闲',
      detail: queuedActions.length ? '已有同步/扫描/对账任务在等待当前任务结束后执行。' : '当前没有正在运行的同步、扫描或对账任务。',
      queuedActions,
      lastError: sanitizeDiagnosticText(deps.sync.getLastError(), 500),
      updatedAt: deps.now(),
      nextRunAt,
      accountCooldown,
    };
  }

  function getQueueSnapshot() {
    return projectQueueSnapshot({
      downloadQueue: deps.queues.download,
      uploadQueue: deps.queues.upload,
      verificationQueue: deps.queues.verification,
      config: { queuePrefetchLimit: deps.queuePrefetchLimit() },
      jobs: deps.jobs,
      chargingRestrictions: deps.state.getChargingRestrictionSummary(),
      mapTask: board.mapQueueTaskForBoard,
      mapJob: board.mapPersistentJobForBoard,
      enrich: board.enrichQueueBoardMetadata,
    }, {
      generatedAt: deps.now(),
      scheduler: schedulerSnapshot(),
      localCache: deps.localCache(),
      uploadHealth: deps.uploadHealth(),
      downloadApiHealth: deps.downloadApiHealth(),
      downloadRecovery: deps.downloadRecovery(),
      ...deps.recoverySnapshot(),
      maintenance: deps.maintenanceSnapshot(),
    });
  }

  return { schedulerSnapshot, getQueueSnapshot };
}
