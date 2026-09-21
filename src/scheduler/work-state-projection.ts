import {
  PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES,
  type PersistentJobKind,
  type PersistentJobStore,
} from '../job-store.js';
import type { TaskQueue } from '../queue.js';

interface BusyWorkflow {
  busy: boolean;
}

interface SyncState {
  isBusy(): boolean;
  hasPending(): boolean;
}

interface RuntimeWorkStateDependencies {
  sync: SyncState;
  queues: readonly Pick<TaskQueue, 'isBusy' | 'getActiveCount'>[];
  accessProbe: { isBusy(): boolean };
  recoveryAutomation: BusyWorkflow;
  legacyCacheRecovery: BusyWorkflow;
  localCapacity: { pending: Promise<unknown> | null };
  localCleanup: { sweeping: boolean; busy: boolean };
  recovery: BusyWorkflow;
  accountRetirement: BusyWorkflow;
  quality: { isIdle(): boolean };
  anyMaintenanceLocked(): boolean;
  jobs: Pick<PersistentJobStore, 'counts'>;
}

const transferKinds: readonly PersistentJobKind[] = [
  'download',
  'upload',
  'history_upload',
  'verify_upload',
  'quality_download',
  'quality_upload',
  'quality_replace',
  'quality_cleanup',
];

/**
 * Read-only projection of scheduler work.  It owns no timers, locks, or
 * mutable task state; callers use it to make admission decisions without
 * reaching into SchedulerRuntime's implementation fields.
 */
export function createWorkStateProjection(deps: RuntimeWorkStateDependencies) {
  function hasRunningTransferTasks() {
    return deps.queues.some(queue => queue.isBusy())
      || Boolean(deps.recoveryAutomation.busy)
      || deps.accessProbe.isBusy()
      || Boolean(deps.accountRetirement.busy)
      || Boolean(deps.recovery.busy);
  }

  function isBusy() {
    return deps.sync.isBusy()
      || deps.queues.some(queue => queue.getActiveCount() > 0)
      || deps.accessProbe.isBusy()
      || Boolean(deps.legacyCacheRecovery.busy || deps.recoveryAutomation.busy || deps.localCapacity.pending || deps.localCleanup.sweeping)
      || Boolean(deps.recovery.busy || deps.accountRetirement.busy || deps.localCleanup.busy)
      || !deps.quality.isIdle();
  }

  function hasPersistentTransferWork() {
    const counts = deps.jobs.counts();
    return transferKinds.some(kind => {
      const statuses = counts[kind] || {};
      return PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES.some(status => Number(statuses[status] || 0) > 0);
    });
  }

  function hasActiveOrQueuedSchedulerWork() {
    return deps.sync.isBusy()
      || deps.sync.hasPending()
      || deps.anyMaintenanceLocked()
      || Boolean(deps.legacyCacheRecovery.busy)
      || Boolean(deps.localCleanup.sweeping)
      || Boolean(deps.recoveryAutomation.busy);
  }

  function canEnterCleanup() {
    return !deps.anyMaintenanceLocked()
      && !deps.localCleanup.sweeping
      && !deps.sync.isBusy()
      && !deps.sync.hasPending()
      && !hasRunningTransferTasks();
  }

  function canRebind() {
    return !deps.sync.isBusy()
      && !hasRunningTransferTasks()
      && !deps.legacyCacheRecovery.busy
      && !deps.localCleanup.sweeping
      && !deps.localCleanup.busy;
  }

  return {
    isBusy,
    hasRunningTransferTasks,
    hasPersistentTransferWork,
    hasActiveOrQueuedSchedulerWork,
    canEnterCleanup,
    canRebind,
  };
}
