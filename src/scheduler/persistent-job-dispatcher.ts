import type { ConfigStore } from '../config.js';
import { PersistentJobStore } from '../job-store.js';
import type { PersistentJobRecord } from '../database.js';
import { logManager } from '../logger.js';
import { TaskQueue } from '../queue.js';
import { createVerificationTaskFactory } from './verification-task-factory.js';
import { QualityUpgradeCleanupTask, QualityUpgradeDownloadTask, QualityUpgradeReplaceTask, QualityUpgradeUploadReplaceTask, type DownloadTask, type UploadTask, type QualityUpgradeTask } from '../tasks.js';
import { parseRecoveryUploadItem, type RecoveryUploadItem } from './upload-work.js';
import { joinRemotePath } from '../utils.js';
import type { TransferSessionStore } from '../transfer-session.js';

export interface PersistentJobDispatcherDependencies {
  configStore: Pick<ConfigStore, 'get'>;
  jobs: PersistentJobStore;
  downloadQueue: TaskQueue;
  uploadQueue: TaskQueue;
  verificationQueue: TaskQueue;
  sessions: TransferSessionStore;
  leaseOwner: string;
  now: () => number;
  accepting: () => boolean;
  maintenanceLocked: () => boolean;
  queueHighWater: (concurrency: number, prefetch: number) => number;
  canCreateDownloadTask: () => boolean;
  dispatchChargingAccessProbe: () => void;
  buildDownloadTask: (job: PersistentJobRecord) => DownloadTask | null;
  buildUploadTask: (item: RecoveryUploadItem) => UploadTask;
  buildQualityUpgradeTask: (job: PersistentJobRecord) => QualityUpgradeTask | null;
  scheduleWake: () => void;
}

/** Claims durable work and turns it into bounded in-memory tasks. */
export function createPersistentJobDispatcher(deps: PersistentJobDispatcherDependencies) {
  function renewLeases(force = true) {
    for (const queue of [deps.downloadQueue, deps.uploadQueue, deps.verificationQueue]) {
      const stale = new Set<string>();
      for (const task of queue.getTasks()) {
        if (!task.persistentJobId || (task.status !== 'pending' && task.status !== 'running' && task.status !== 'retry_wait')) continue;
        const duration = queue === deps.verificationQueue ? 5 * 60_000 : 30 * 60_000;
        if (!force && task.persistentJob?.leaseExpiresAt !== undefined && task.persistentJob.leaseExpiresAt > deps.now() + 60_000) continue;
        if (deps.jobs.extendLease(task.persistentJobId, deps.leaseOwner, duration)) {
          if (task.persistentJob) task.persistentJob.leaseExpiresAt = deps.now() + duration;
          continue;
        }
        if (task.status === 'running') {
          throw new Error(`Running task lost its lease: job=${task.persistentJobId}`);
        }
        stale.add(task.id);
      }
      queue.removePendingTasks(task => stale.has(task.id));
    }
  }
  const dispatch = () => {
    if (!deps.accepting() || deps.maintenanceLocked()) return;
    // Renew prefetched claims before any claimDue call recovers expired jobs.
    renewLeases(false);
    deps.dispatchChargingAccessProbe();
    const config = deps.configStore.get();
    const downloadCapacity = Math.max(0, deps.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit) - deps.downloadQueue.getSize());
    if (downloadCapacity > 0 && deps.canCreateDownloadTask()) {
      const jobs = deps.jobs.claimDue(['quality_download', 'download'], downloadCapacity, deps.leaseOwner, 30 * 60_000);
      const activeQualityArtifacts = new Set(deps.downloadQueue.getTasks()
        .filter(task => task instanceof QualityUpgradeDownloadTask)
        .map(task => String(task.control.artifactKey || task.bvid || '')));
      for (const job of jobs) {
        if (!deps.accepting()) return;
        if (deps.downloadQueue.hasPersistentJob(job.id)) continue;
        const qualityArtifact = String(job.payload.artifactKey || job.bvid || '');
        if (job.kind === 'quality_download' && activeQualityArtifacts.has(qualityArtifact)) {
          deps.jobs.defer(job.id, deps.leaseOwner, 'Shared quality download is active', deps.now() + 1_000);
          continue;
        }
        const control = job.kind === 'quality_download' ? deps.buildQualityUpgradeTask(job) : null;
        const task = control ? new QualityUpgradeDownloadTask(control) : deps.buildDownloadTask(job);
        if (!task) { deps.jobs.complete(job.id, deps.leaseOwner); continue; }
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!deps.downloadQueue.addTask(task)) {
          if (!deps.accepting()) return;
          deps.jobs.defer(job.id, deps.leaseOwner, 'Download queue is full', deps.now() + 1_000);
          continue;
        }
        if (job.kind === 'quality_download') activeQualityArtifacts.add(qualityArtifact);
      }
    }

    const uploadCapacity = Math.max(0, deps.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit) - deps.uploadQueue.getSize());
    if (uploadCapacity > 0) {
      const jobs = deps.jobs.claimDue(['upload', 'quality_upload', 'quality_replace', 'quality_cleanup', 'history_upload'], uploadCapacity, deps.leaseOwner, 30 * 60_000);
      for (const job of jobs) {
        if (!deps.accepting()) return;
        if (deps.uploadQueue.hasPersistentJob(job.id)) continue;
        if (['quality_upload', 'quality_replace', 'quality_cleanup'].includes(job.kind)) {
          const control = deps.buildQualityUpgradeTask(job);
          if (!control) { deps.jobs.complete(job.id, deps.leaseOwner); continue; }
          const task = job.kind === 'quality_replace'
            ? new QualityUpgradeReplaceTask(control)
            : (job.kind === 'quality_cleanup' ? new QualityUpgradeCleanupTask(control) : new QualityUpgradeUploadReplaceTask(control));
          task.maxRetries = 0;
          task.persistentJobId = job.id;
          task.persistentJob = job;
          if (!deps.uploadQueue.addTask(task)) {
            if (!deps.accepting()) return;
            deps.jobs.defer(job.id, deps.leaseOwner, 'Upload queue is full', deps.now() + 1_000);
            continue;
          }
          continue;
        }
        let item: RecoveryUploadItem;
        try {
          item = parseRecoveryUploadItem({
            ...job.payload,
            ...(job.bvid ? { bvid: job.bvid } : {}),
            ...(job.userId ? { userId: job.userId } : {}),
            ...(job.mediaId !== undefined ? { mediaId: job.mediaId } : {}),
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : '持久上传任务载荷无效';
          deps.jobs.parkManualRecovery(job.id, deps.leaseOwner, reason, {
            awaitingManualRecovery: true,
            uploadPayloadInvalid: true,
          });
          logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: 'upload', level: 'error',
            summary: `持久上传任务证据无效，已转人工恢复 ${job.bvid || job.id}`,
            raw: `[Upload] job=${job.id}: ${reason}`, bvid: job.bvid, simpleVisible: true, debugVisible: true });
          continue;
        }
        if (!item.historyOnly && !item.conflictCandidateId) {
          item.conflictCandidateId = `upload-${job.id}`;
          item.conflictCandidateRemotePath = joinRemotePath(item.remotePath, '_conflicts', item.conflictCandidateId);
          deps.jobs.updatePayload(job.id, { ...job.payload, conflictCandidateId: item.conflictCandidateId, conflictCandidateRemotePath: item.conflictCandidateRemotePath });
        }
        const task = deps.buildUploadTask(item);
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!deps.uploadQueue.addTask(task)) {
          if (!deps.accepting()) return;
          deps.jobs.defer(job.id, deps.leaseOwner, 'Upload queue is full', deps.now() + 1_000);
          continue;
        }
      }
    }

    const verificationCapacity = Math.max(0, deps.queueHighWater(config.remoteVerifyConcurrency, config.queuePrefetchLimit) - deps.verificationQueue.getSize());
    if (verificationCapacity > 0) {
      const jobs = deps.jobs.claimDue(['verify_upload'], verificationCapacity, deps.leaseOwner, 5 * 60_000);
      const factory = createVerificationTaskFactory({
        config: () => config, sessions: deps.sessions, jobs: deps.jobs, leaseOwner: deps.leaseOwner,
        rejected: (job, reason) => logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: 'upload', level: 'error',
          summary: `上传核验证据无效，任务已暂停 ${job.bvid || ''}`, raw: `[Verification] job=${job.id}: ${reason}`, bvid: job.bvid, simpleVisible: true, debugVisible: true }),
      });
      for (const job of jobs) {
        if (!deps.accepting()) return;
        if (deps.verificationQueue.hasPersistentJob(job.id)) continue;
        const task = factory(job);
        if (!task) continue;
        if (!deps.verificationQueue.addTask(task)) {
          if (!deps.accepting()) return;
          deps.jobs.defer(job.id, deps.leaseOwner, 'Verification queue is full', deps.now() + 1_000);
          continue;
        }
      }
    }
    deps.scheduleWake();
  };
  return { dispatch, renewLeases };
}
