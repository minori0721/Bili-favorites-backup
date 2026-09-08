import { DownloadTask, QualityUpgradeDownloadTask, UploadTask, QualityUpgradeUploadReplaceTask, QualityUpgradeReplaceTask, QualityUpgradeCleanupTask, type UploadVerificationTask, type QualityUpgradeTask } from '../tasks.js';
import type { PersistentJobStore } from '../job-store.js';
import { logManager } from '../logger.js';
import { sanitizeUploadText, type UploadFailureInfo } from '../upload-health.js';
import { qualityDownloadStageLabel } from './quality-rules.js';
import { readTaskFailure } from './task-failure.js';

type Download = DownloadTask | QualityUpgradeDownloadTask;
type QualityUpload = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type Upload = UploadTask | QualityUpload;
function isQualityUpload(task: unknown): task is QualityUpload {
  return task instanceof QualityUpgradeUploadReplaceTask || task instanceof QualityUpgradeReplaceTask || task instanceof QualityUpgradeCleanupTask;
}
interface Dependencies {
  jobs: Pick<PersistentJobStore, 'markRunning'>;
  leaseOwner: string;
  markDownloadStarted(): void;
  syncQuality(task: QualityUpgradeDownloadTask | QualityUpload, status: QualityUpgradeTask['status']): void;
  downloadFailure(task: Download, error: unknown): unknown;
  uploadFailure(task: Upload, error: unknown): UploadFailureInfo;
  formatUploadFailure(task: Upload, failure: UploadFailureInfo): string;
}
export function createTaskProgressHandlers(deps: Dependencies) {
  function retryLog(task: Download | Upload, error: unknown) {
    console.warn('[Queue] Task ' + task.name + ' failed (retrying ' + task.retries + '/' + task.maxRetries + '): ' + sanitizeUploadText(readTaskFailure(error).message || error));
  }
  return {
    downloadStart(task: Download) {
      deps.markDownloadStarted();
      if (task.persistentJobId) deps.jobs.markRunning(task.persistentJobId, deps.leaseOwner, 30 * 60_000);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.qualityStage = 'download';
        task.control.qualityStageLabel = qualityDownloadStageLabel(task.control, '下载新版');
        deps.syncQuality(task, 'running');
      }
    },
    uploadStart(task: Upload) {
      if (task.persistentJobId) deps.jobs.markRunning(task.persistentJobId, deps.leaseOwner, 30 * 60_000);
      if (!isQualityUpload(task)) return;
      task.control.error = undefined;
      task.control.qualityStage = 'upload';
      task.control.qualityStageLabel = task instanceof QualityUpgradeCleanupTask ? '清理旧文件备份'
        : task instanceof QualityUpgradeReplaceTask ? '替换远端文件' : '上传新版到临时目录';
      deps.syncQuality(task, 'running');
    },
    verificationStart(task: UploadVerificationTask) {
      if (task.persistentJobId) deps.jobs.markRunning(task.persistentJobId, deps.leaseOwner, 5 * 60_000);
    },
    downloadRetry(task: Download, error: unknown) {
      retryLog(task, error);
      deps.downloadFailure(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        deps.syncQuality(task, 'retry_wait');
        task.control.qualityStage = 'download';
        task.control.qualityStageLabel = '等待重试下载新版';
      }
      const detail = readTaskFailure(error).message || error;
      logManager.push({ timestamp: new Date().toISOString(), type: 'download', level: 'warn',
        summary: (task instanceof QualityUpgradeDownloadTask ? '画质重调下载失败' : '下载失败') + '，等待重试 ' + task.bvid + ' (' + task.retries + '/' + task.maxRetries + '): ' + detail,
        raw: '[Queue] Task ' + task.name + ' failed (retrying ' + task.retries + '/' + task.maxRetries + '): ' + detail,
        bvid: task.bvid, simpleVisible: true });
    },
    uploadRetry(task: Upload, error: unknown) {
      retryLog(task, error);
      const failure = deps.uploadFailure(task, error);
      if (isQualityUpload(task)) {
        deps.syncQuality(task, 'retry_wait');
        task.control.qualityStage = 'upload';
        task.control.qualityStageLabel = '等待重试上传替换';
      }
      logManager.push({ timestamp: new Date().toISOString(), type: 'upload', level: 'warn',
        summary: (isQualityUpload(task) ? '画质重调阶段失败' : '上传失败') + '，等待重试 ' + task.bvid + ' (' + task.retries + '/' + task.maxRetries + '): ' + failure.summary,
        raw: deps.formatUploadFailure(task, failure), bvid: task.bvid, simpleVisible: true });
    },
  };
}
