import type { QueueBoardItem, Task, TaskQueue } from '../queue.js';
import type { JobRepository, PersistentJobKind } from '../repositories/jobs.js';

interface Dependencies {
  downloadQueue: Pick<TaskQueue,'getTasks'>;
  uploadQueue: Pick<TaskQueue,'getTasks'>;
  verificationQueue: Pick<TaskQueue,'getTasks'>;
  config: {queuePrefetchLimit?: number};
  jobs: Pick<JobRepository,'listForBoard' | 'counts' | 'countRecoverable' | 'accessProbeScheduleSummary'>;
  chargingRestrictions: {lastCheckedAt?: string};
  mapTask(task: Task, stage: QueueBoardItem['stage']): QueueBoardItem;
  mapJob(job: ReturnType<JobRepository['listForBoard']>[number]): QueueBoardItem;
  enrich(items: QueueBoardItem[]): void;
}

/** Projection has read-only store capabilities and no scheduling or reconciliation entry. */
export function projectQueueSnapshot<Extra extends object>(dependencies: Dependencies, extra: Extra) {
    const downloadPending: QueueBoardItem[] = [];
    const downloadRunning: QueueBoardItem[] = [];
    const uploadPending: QueueBoardItem[] = [];
    const uploadRunning: QueueBoardItem[] = [];
    const seenPersistentJobIds = new Set<string>();

    const addTask = (task: Task, stage: QueueBoardItem["stage"]) => {
      const item = dependencies.mapTask(task, stage);
      if (item.persistentJobId) seenPersistentJobIds.add(item.persistentJobId);
      const target = stage === "download_pending"
        ? downloadPending
        : stage === "download_running"
          ? downloadRunning
          : stage === "upload_running"
            ? uploadRunning
            : uploadPending;
      target.push(item);
    };

    for (const task of dependencies.downloadQueue.getTasks()) {
      if (task.status === "running") {
        addTask(task, "download_running");
      } else if (task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "download_pending");
      }
    }
    for (const task of dependencies.uploadQueue.getTasks()) {
      if (task.status === "running") {
        addTask(task, "upload_running");
      } else if (task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "upload_pending");
      }
    }
    for (const task of dependencies.verificationQueue.getTasks()) {
      if (task.status === "running" || task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "upload_pending");
      }
    }

    // Persisted jobs fill the board when they are waiting for manual action,
    // after a restart, or before the bounded in-memory prefetch queue sees
    // them. In-memory jobs are still excluded by their persistent ids.
    const boardLimit = Math.max(1, Number(dependencies.config.queuePrefetchLimit || 25));
    const appendPersistedJobs = (kinds: PersistentJobKind[], capacity: number) => {
      if (capacity <= 0) return;
      const persistentJobs = dependencies.jobs.listForBoard(kinds, capacity, undefined, [...seenPersistentJobIds]);
      for (const job of persistentJobs) {
        const item = dependencies.mapJob(job);
        if (item.stage === "download_running" || item.stage === "download_pending") {
          (item.stage === "download_running" ? downloadRunning : downloadPending).push(item);
        } else {
          uploadPending.push(item);
        }
      }
    };
    // The board limit applies to each pending column after in-memory tasks and
    // persisted jobs are combined. Query each side separately so upload jobs
    // cannot consume the download column's remaining display slots.
    appendPersistedJobs(["download", "quality_download"], boardLimit - downloadPending.length);
    appendPersistedJobs(["upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup", "verify_upload"], boardLimit - uploadPending.length);

    dependencies.enrich([...downloadPending, ...downloadRunning, ...uploadPending, ...uploadRunning]);

    const bySequence = (a: QueueBoardItem, b: QueueBoardItem) => {
      if (a.sequence !== undefined || b.sequence !== undefined) return Number(a.sequence || 0) - Number(b.sequence || 0);
      return Number(a.nextActionAt || a.retryAt || a.queuedAt || 0) - Number(b.nextActionAt || b.retryAt || b.queuedAt || 0);
    };
    const byStartedAt = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.startedAt || 0) - Number(b.startedAt || 0);
    downloadPending.sort(bySequence);
    uploadPending.sort(bySequence);
    downloadRunning.sort(byStartedAt);
    uploadRunning.sort(byStartedAt);

    const persistentCounts = dependencies.jobs.counts();
    const countRecoverable = (kinds: PersistentJobKind[]) => dependencies.jobs.countRecoverable(kinds);
    const leasedJobs = Object.values(persistentCounts).reduce((total, statuses) =>
      total + Number(statuses.leased || 0) + Number(statuses.running || 0), 0);
    const retryJobs = Object.entries(persistentCounts).reduce((total, [kind, statuses]) =>
      kind === "access_probe" ? total : total + Number(statuses.retry_wait || 0), 0);
    const chargingSchedule = dependencies.jobs.accessProbeScheduleSummary("charging");
    const availabilitySchedule = dependencies.jobs.accessProbeScheduleSummary("availability");
    const chargingRestrictions = dependencies.chargingRestrictions;
    const lastChargingCheckAt = Date.parse(chargingRestrictions.lastCheckedAt || "");
    return {
      ...extra, downloadPending,downloadRunning,uploadPending,uploadRunning,
      chargingAccess:{pending:chargingSchedule.count,nextCheckAt:chargingSchedule.nextAt,lastCheckedAt:Number.isFinite(lastChargingCheckAt)?lastChargingCheckAt:undefined},
      recovery:{pendingUploads:countRecoverable(['upload','history_upload','quality_upload']),pendingDownloads:countRecoverable(['download','quality_download']),
        pendingVerifications:countRecoverable(['verify_upload']),pendingQualityMaintenance:countRecoverable(['quality_replace','quality_cleanup']),chargingRestricted:chargingSchedule.count,availabilityChecks:availabilitySchedule.count,
        leasedJobs,retryJobs,prefetchLimit:dependencies.config.queuePrefetchLimit || 25},
    };
}
