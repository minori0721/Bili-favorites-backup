import {
  applyBBDownEncodingPreference,
  type AppConfig,
} from '../config.js';
import { applyQualityArtifactProfile } from '../quality-artifact.js';
import type { TaskQueue } from '../queue.js';
import { DownloadTask, QualityUpgradeDownloadTask } from '../tasks.js';

interface DownloadAdmissionPort {
  configure(mode: AppConfig['bbdownApiMode']): void;
}

interface RuntimeConfigDependencies {
  isShuttingDown(): boolean;
  config(): AppConfig;
  clearRemoteListings(): void;
  clearDownloadApiCooldown(): void;
  downloadAdmission: DownloadAdmissionPort;
  downloadQueue: TaskQueue;
  uploadQueue: TaskQueue;
  verificationQueue: TaskQueue;
  localCapacity: { refreshAndWake(force?: boolean): void };
  dispatchPersistentJobs(): void;
  queueHighWater(concurrency?: number, batchSize?: number): number;
  start(): boolean;
}

/** Applies configuration changes without making the scheduling runtime own UI or task policy. */
export function createRuntimeConfigController(deps: RuntimeConfigDependencies) {
  function updateInterval() {
    if (deps.isShuttingDown()) return;
    const config = deps.config();
    const downloadConcurrency = config.concurrentDownloads || 1;
    const uploadConcurrency = config.concurrentUploads || 2;
    const verificationConcurrency = Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3));
    deps.downloadQueue.setConcurrency(downloadConcurrency);
    deps.uploadQueue.setConcurrency(uploadConcurrency);
    deps.verificationQueue.setConcurrency(verificationConcurrency);
    deps.downloadQueue.setMaxSize(deps.queueHighWater(downloadConcurrency, config.queuePrefetchLimit));
    deps.uploadQueue.setMaxSize(deps.queueHighWater(uploadConcurrency, config.queuePrefetchLimit));
    deps.verificationQueue.setMaxSize(deps.queueHighWater(verificationConcurrency, config.queuePrefetchLimit));
    deps.localCapacity.refreshAndWake(true);
    deps.dispatchPersistentJobs();
    if (process.env.NODE_ENV !== 'test') deps.start();
  }

  function applyConfigUpdate(previous: AppConfig, next: AppConfig) {
    if (deps.isShuttingDown()) return;
    if (previous.alistUrl !== next.alistUrl || previous.alistUsername !== next.alistUsername
      || previous.alistPassword !== next.alistPassword) deps.clearRemoteListings();
    deps.downloadAdmission.configure(next.bbdownApiMode || 'web');
    if (next.bbdownApiMode === 'app') deps.clearDownloadApiCooldown();
    for (const task of deps.downloadQueue.getTasks()) {
      if (task.status === 'running') continue;
      if (task instanceof DownloadTask) {
        task.config = task.encodingRetry
          ? applyBBDownEncodingPreference(next, task.encodingRetry.priority, task.encodingRetry.strict)
          : { ...next };
      } else if (task instanceof QualityUpgradeDownloadTask) {
        task.control.config = applyQualityArtifactProfile(next, task.control.qualityProfile);
      }
      const download = task instanceof QualityUpgradeDownloadTask
        ? task.control
        : task instanceof DownloadTask ? task : undefined;
      if (download) {
        download.apiModeOverride = undefined;
        download.apiProbe = false;
      }
    }
    if (previous.bbdownApiMode !== next.bbdownApiMode) deps.downloadQueue.poke();
    updateInterval();
  }

  return { applyConfigUpdate, updateInterval };
}
