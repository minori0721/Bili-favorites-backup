import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config.js";
import { FavoriteRelation, StateManager, VideoArchiveEntry } from "./state.js";
import { BiliUser, UserStore } from "./users.js";
import { BiliRiskOrLoginError, listFavoriteItemsPage, refreshUserAuth, resolveSelfVisibleFavoriteItem } from "./bili.js";
import { logManager } from "./logger.js";
import { tempDir } from "./paths.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { mapQueueBoardTask, type QueueBoardItem, TaskQueue } from "./queue.js";
import { queueCoverCache } from "./cover-cache.js";
import {
  cleanupUploadedSessionFiles,
  DOWNLOAD_RETAINED_FILE,
  historySessionGroups,
  inspectDownloadRecoverySync,
  markHistoryGroupUploaded,
  readDownloadSession,
} from "./download-session.js";
import {
  classifyUploadError,
  sanitizeUploadText,
  UploadCircuitBreaker,
  type UploadFailureInfo,
} from "./upload-health.js";
import {
  DownloadTask,
  QualityUpgradeDownloadTask,
  QualityUpgradeTask,
  QualityUpgradeUploadReplaceTask,
  UploadTarget,
  UploadTask,
} from "./tasks.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cooldownMs() {
  return (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
}

const ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS = 6 * 60 * 60_000;

async function pathSize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path.join(targetPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;
  private configStore: ConfigStore;
  private userStore: UserStore;
  private stateManager: StateManager;

  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  private queuedBackupKeys = new Set<string>();
  private activeDownloadTargets = new Map<string, UploadTarget[]>();
  private readonly hotScanMinPages = 3;
  private readonly hotScanMaxPages = 12;
  private readonly hotScanBurstBudget = 3;
  private readonly historyPagesPerTick = 2;
  private readonly initialHistoryPagesPerTick = 12;
  private readonly manualHistoryPagesPerTick = 20;
  private readonly remoteVerifyPerTick = 25;
  private readonly remoteVerifyPerTickNoNew = 120;
  private readonly remoteVerifyPerTickManual = 200;
  private readonly staleActiveBackupMs = 20 * 60_000;
  private remoteVerifyNextAllowedAt = 0;
  private remoteDirListingCache = new Map<string, { expiresAt: number; names: string[] }>();
  private readonly remoteDirListingCacheTtlMs = 30_000;
  private remoteVerifyPathQueue = new Map<string, number>();
  private pendingTickOptions: TickOptions | null = null;
  private cleanupLocked = false;
  private sharedUploadDirs = new Map<string, SharedUploadDirTracker>();
  private recoveryUploadBacklog: RecoveryUploadItem[] = [];
  private recoveryDownloadBacklog: RecoveryDownloadItem[] = [];
  private recoveryUploadKeys = new Set<string>();
  private recoveryDownloadKeys = new Set<string>();
  private priorityUploadKeys = new Set<string>();
  private qualityUpgradeUploadBacklog: DeferredQualityUpload[] = [];
  private recoveryRefillTimer: NodeJS.Timeout | null = null;
  private recoveryRefillAt = 0;
  private uploadProbeTimer: NodeJS.Timeout | null = null;
  private readonly uploadCircuit = new UploadCircuitBreaker();
  private selfVisibleProbeCache = new Map<string, { expiresAt: number; item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number] }>();
  private schedulerProgress: SchedulerSnapshot | null = null;
  private nextAutoRunAt?: number;
  private lastSchedulerError = "";
  private localCacheSnapshot: LocalCacheSnapshot | null = null;
  private localCacheRefresh: Promise<LocalCacheSnapshot> | null = null;
  private readonly localCacheSnapshotTtlMs = 10_000;

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;

    const config = this.configStore.get();
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1, this.queueHighWater(config.concurrentDownloads, config.startupRecoveryBatchSize));
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2, this.queueHighWater(config.concurrentUploads, config.startupRecoveryBatchSize));
    this.downloadQueue.setStartGate(() => this.canStartDownloadTask());
    this.uploadQueue.setStartGate((task) => this.uploadCircuit.allowUploadStart(this.uploadTaskKey(task)));
    void this.refreshLocalCacheSnapshot(true);

    const logTaskError = (task: any, error: any) => {
      const label = error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed";
      console.error(`[Queue] Task ${task.name} ${label}: ${sanitizeUploadText(error?.message || error)}`);
    };
    const logTaskRetry = (task: any, error: any) => console.warn(
      `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${sanitizeUploadText(error?.message || error)}`
    );

    this.downloadQueue.on("taskStart", (task: DownloadTask | QualityUpgradeDownloadTask) => {
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.qualityStage = "download";
        task.control.qualityStageLabel = "下载新版";
        this.syncQualityUpgradeControl(task, "running");
      }
    });
    this.uploadQueue.on("taskStart", (task: UploadTask | QualityUpgradeUploadReplaceTask) => {
      if (task instanceof QualityUpgradeUploadReplaceTask) {
        task.control.error = undefined;
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "上传新版到临时目录";
        this.syncQualityUpgradeControl(task, "running");
      }
    });

    this.downloadQueue.on("taskError", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      logTaskError(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        this.syncQualityUpgradeControl(task, "error");
        task.control.error = error;
        task.control.onFailed?.(task.control, error);
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "error",
        summary: `下载失败 ${task.bvid}: ${error?.message || error}${error?.permanent ? "（已停止自动重试）" : (error?.deferToNextCycle ? "（下一轮再试）" : "")}`,
        raw: `[Queue] Task ${task.name} ${error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed"}: ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
      const targets = task.targets || this.activeDownloadTargets.get(task.bvid) || this.makeSingleTarget(task);
      const session = task.downloadDir ? readDownloadSession(task.downloadDir) : null;
      if (task.downloadDir && session && !error?.permanent) {
        this.stateManager.markDownloadInterrupted(task.bvid, task.downloadDir, error.message || "Download failure", targets);
        for (const target of targets) {
          this.queuedBackupKeys.delete(this.backupKey(target.userId, target.mediaId, task.bvid));
          const user = this.userStore.getById(target.userId);
          const key = this.backupKey(target.userId, target.mediaId, task.bvid);
          if (user && !this.recoveryDownloadKeys.has(key)) {
            this.recoveryDownloadKeys.add(key);
            this.recoveryDownloadBacklog.push({ user, mediaId: target.mediaId, folderTitle: target.folderTitle, bvid: task.bvid });
          }
        }
      } else {
        for (const target of targets) {
          this.queuedBackupKeys.delete(this.backupKey(target.userId, target.mediaId, task.bvid));
          this.stateManager.markRelationRetryPending(task.bvid, target.userId, target.mediaId, error.message || "Download failure");
          this.stateManager.markFailed(target.userId, task.bvid, target.mediaId, error.message || "Download failure", Boolean(error?.permanent));
        }
      }
      this.activeDownloadTargets.delete(task.bvid);
      this.scheduleRecoveryRefill();
    });
    this.downloadQueue.on("taskRetry", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      logTaskRetry(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        this.syncQualityUpgradeControl(task, "retry_wait");
        task.control.qualityStage = "download";
        task.control.qualityStageLabel = "等待重试下载新版";
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `${task instanceof QualityUpgradeDownloadTask ? "画质重调下载失败" : "下载失败"}，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        raw: `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
    });
    this.uploadQueue.on("taskError", (task: UploadTask | QualityUpgradeUploadReplaceTask, error: any) => {
      logTaskError(task, error);
      const failure = this.recordUploadFailure(task, error);
      if (task instanceof QualityUpgradeUploadReplaceTask) {
        if (this.uploadCircuit.getSnapshot().state !== "closed") {
          task.control.qualityStage = "upload";
          task.control.qualityStageLabel = "等待上传后端恢复";
          task.control.error = error;
          this.syncQualityUpgradeControl(task, "retry_wait");
          this.qualityUpgradeUploadBacklog.push({
            task: new QualityUpgradeUploadReplaceTask(task.control),
            notBefore: this.uploadCircuit.getRetryAt(),
          });
        } else {
          this.syncQualityUpgradeControl(task, "error");
          task.control.error = error;
          task.control.onFailed?.(task.control, error);
        }
        this.scheduleRecoveryRefill();
        return;
      }
      const uploadHealth = this.uploadCircuit.getSnapshot();
      const isolatedDeterministicFailure = failure.category === "deterministic" && uploadHealth.state === "closed";
      if (task.historyOnly) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `历史分P上传失败 ${task.bvid}: ${failure.summary}（最新版状态不受影响）`,
          raw: this.formatUploadFailureLog(task, failure),
          bvid: task.bvid,
          simpleVisible: true,
        });
        const retryItem: RecoveryUploadItem = {
          bvid: task.bvid,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          userId: task.userId,
          mediaId: task.mediaId,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
          files: task.files,
          historyOnly: true,
          historySnapshotAt: task.historySnapshotAt,
          notBefore: uploadHealth.retryAt || Date.now() + 60_000,
          priority: false,
        };
        const retryKey = this.recoveryUploadKey(retryItem);
        if (!this.recoveryUploadKeys.has(retryKey)) {
          this.recoveryUploadKeys.add(retryKey);
          this.recoveryUploadBacklog.push(retryItem);
          this.createSharedUploadDirTracker(task.downloadDir, 1, task.bvid);
        }
        void this.completeSharedUploadTask(task, false);
        this.scheduleRecoveryRefill(Math.max(0, (retryItem.notBefore || Date.now()) - Date.now()));
        return;
      }
      if (task.recoveryKey) {
        this.priorityUploadKeys.delete(task.recoveryKey);
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: isolatedDeterministicFailure
          ? `上传失败 ${task.bvid}: ${failure.summary}（本地文件已保留，已隔离补传，其他任务继续）`
          : `上传失败 ${task.bvid}: ${failure.summary}（本地文件已保留，等待补传）`,
        raw: this.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
      if (task.userId && task.mediaId) {
        this.queuedBackupKeys.delete(this.backupKey(task.userId, task.mediaId, task.bvid));
      }
      this.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, failure.summary);
      const retryItem: RecoveryUploadItem = {
        bvid: task.bvid,
        localDir: task.downloadDir,
        remotePath: task.remotePath,
        userId: task.userId,
        mediaId: task.mediaId,
        folderTitle: task.folderTitle,
        videoTitle: task.videoTitle,
        upperName: task.upperName,
        cover: task.cover,
        files: task.files,
        partialBackup: task.partialBackup,
        notBefore: uploadHealth.retryAt || Date.now() + (
          isolatedDeterministicFailure ? ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS : 60_000
        ),
        priority: !isolatedDeterministicFailure,
      };
      const retryKey = this.recoveryUploadKey(retryItem);
      this.priorityUploadKeys.delete(retryKey);
      if (!this.recoveryUploadKeys.has(retryKey)) {
        this.recoveryUploadKeys.add(retryKey);
        if (retryItem.priority) {
          this.priorityUploadKeys.add(retryKey);
        }
        this.recoveryUploadBacklog.push(retryItem);
        this.createSharedUploadDirTracker(task.downloadDir, 1, task.bvid);
      }
      void this.completeSharedUploadTask(task, false);
      this.downloadQueue.poke();
      this.scheduleRecoveryRefill(Math.max(0, (retryItem.notBefore || Date.now()) - Date.now()));
    });
    this.uploadQueue.on("taskRetry", (task: UploadTask | QualityUpgradeUploadReplaceTask, error: any) => {
      logTaskRetry(task, error);
      const failure = this.recordUploadFailure(task, error);
      if (task instanceof QualityUpgradeUploadReplaceTask) {
        this.syncQualityUpgradeControl(task, "retry_wait");
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待重试上传替换";
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "warn",
        summary: `${task instanceof QualityUpgradeUploadReplaceTask ? "画质重调上传替换失败" : "上传失败"}，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${failure.summary}`,
        raw: this.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
    });

    this.downloadQueue.on("taskCompleted", (task: DownloadTask | QualityUpgradeDownloadTask) => {
      this.refreshLocalCacheState();
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待上传替换";
        const uploadTask = new QualityUpgradeUploadReplaceTask(task.control);
        if (!this.uploadQueue.addTask(uploadTask)) {
          this.qualityUpgradeUploadBacklog.push({ task: uploadTask });
        }
        this.syncQualityUpgradeControl(uploadTask, uploadTask.status);
        return;
      }
      if (!task.downloadDir) return;
      const targets = task.targets || this.activeDownloadTargets.get(task.bvid) || this.makeSingleTarget(task);
      this.activeDownloadTargets.delete(task.bvid);
      const historyGroups = historySessionGroups(task.downloadDir);
      const tracker = this.createSharedUploadDirTracker(task.downloadDir, targets.length * (1 + historyGroups.length), task.bvid);
      targets.forEach((target) => {
        this.queueUploadWork({
          bvid: task.bvid,
          localDir: task.downloadDir!,
          remotePath: target.remotePath,
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: task.videoTitle || "",
          upperName: task.upperName || "",
          cover: task.cover || "",
          files: task.outputFiles,
          partialBackup: task.partialBackup,
        });
        for (const history of historyGroups) {
          this.queueUploadWork({
            bvid: task.bvid,
            localDir: task.downloadDir!,
            remotePath: joinRemotePath(target.remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
            userId: target.userId,
            mediaId: target.mediaId,
            folderTitle: target.folderTitle,
            videoTitle: task.videoTitle || "",
            upperName: task.upperName || "",
            cover: task.cover || "",
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
          });
        }
      });
      if (tracker.remaining === 0) {
        void this.cleanupSharedUploadDir(task.downloadDir, new Set([task.bvid]));
      }
      this.scheduleRecoveryRefill();
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask | QualityUpgradeUploadReplaceTask) => {
      const taskKey = this.uploadTaskKey(task);
      if (this.uploadCircuit.recordSuccess(taskKey)) {
        this.clearUploadProbeTimer();
      }
      if (task instanceof QualityUpgradeUploadReplaceTask) {
        this.syncQualityUpgradeControl(task, "completed");
        this.refreshLocalCacheState();
        this.scheduleRecoveryRefill();
        return;
      }
      if (task.recoveryKey) {
        this.priorityUploadKeys.delete(task.recoveryKey);
      }
      if (task.historyOnly) {
        if (task.result?.files.length && task.historySnapshotAt) {
          markHistoryGroupUploaded(task.downloadDir, task.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        }
        void this.completeSharedUploadTask(task, Boolean(task.result?.files.length));
        this.scheduleRecoveryRefill();
        return;
      }
      if (task.userId && task.mediaId) {
        this.queuedBackupKeys.delete(this.backupKey(task.userId, task.mediaId, task.bvid));
      }
      if (task.result?.files.length) {
        this.stateManager.markVerifiedUpload(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId,
          task.partialBackup
        );
      } else {
        this.stateManager.markUploadFailed(
          task.bvid,
          task.downloadDir,
          task.userId,
          task.mediaId,
          "Upload finished without verified remote metadata."
        );
      }
      void this.completeSharedUploadTask(task, Boolean(task.result?.files.length));
      this.downloadQueue.poke();
      this.scheduleRecoveryRefill();
    });

    this.uploadQueue.on("taskSettled", () => {
      this.drainQualityUpgradeUploadBacklog();
      this.drainRecoveryBacklog();
      this.downloadQueue.poke();
    });

  }

  private queueHighWater(concurrency = 1, batchSize = 25) {
    return Math.max(Math.max(1, concurrency) * 2, Math.max(5, batchSize));
  }

  private queueLowWater(concurrency = 1, batchSize = 25) {
    return Math.max(concurrency, Math.floor(this.queueHighWater(concurrency, batchSize) / 2));
  }

  private uploadTaskKey(task: any) {
    return `${task?.userId || "quality"}:${task?.mediaId || 0}:${task?.bvid || task?.id || "upload"}:${task?.historyOnly ? task?.remotePath || "history" : "main"}`;
  }

  private recordUploadFailure(task: UploadTask | QualityUpgradeUploadReplaceTask, error: any) {
    const failure: UploadFailureInfo = error?.uploadFailure || classifyUploadError(error, task.remotePath || "<remote>");
    this.uploadCircuit.recordFailure(this.uploadTaskKey(task), failure);
    this.scheduleUploadProbe();
    this.downloadQueue.poke();
    return failure;
  }

  private formatUploadFailureLog(task: UploadTask | QualityUpgradeUploadReplaceTask, failure: UploadFailureInfo) {
    const nextRetryAt = task.retryAt ? new Date(task.retryAt).toISOString() : "next-cycle";
    return `[Upload] status=${failure.status || "unknown"} category=${failure.category} retryable=${failure.retryable} attempt=${task.retries}/${task.maxRetries} next=${nextRetryAt} path=${failure.remotePath}: ${failure.summary}`;
  }

  private clearUploadProbeTimer() {
    if (this.uploadProbeTimer) {
      clearTimeout(this.uploadProbeTimer);
      this.uploadProbeTimer = null;
    }
  }

  private scheduleUploadProbe() {
    this.clearUploadProbeTimer();
    const retryAt = this.uploadCircuit.getRetryAt();
    if (!retryAt) return;
    this.uploadProbeTimer = setTimeout(() => {
      this.uploadProbeTimer = null;
      this.drainQualityUpgradeUploadBacklog(true);
      this.drainRecoveryBacklog(true);
      this.uploadQueue.poke();
    }, Math.max(0, retryAt - Date.now()));
    this.uploadProbeTimer.unref?.();
  }

  private scheduleRecoveryRefill(delayMs = 0) {
    const targetAt = Date.now() + Math.max(0, delayMs);
    if (this.recoveryRefillTimer && this.recoveryRefillAt <= targetAt) return;
    if (this.recoveryRefillTimer) clearTimeout(this.recoveryRefillTimer);
    this.recoveryRefillAt = targetAt;
    this.recoveryRefillTimer = setTimeout(() => {
      this.recoveryRefillTimer = null;
      this.recoveryRefillAt = 0;
      this.drainRecoveryBacklog();
    }, Math.max(0, targetAt - Date.now()));
    this.recoveryRefillTimer.unref?.();
  }

  private recoveryUploadKey(item: RecoveryUploadItem) {
    return `${item.userId || "video"}:${item.mediaId || 0}:${item.bvid}:${item.remotePath}:${item.historySnapshotAt || "main"}`;
  }

  private historySnapshotSegment(value: string) {
    return String(value || new Date().toISOString()).replace(/[-:.]/g, "").replace(/Z$/, "Z");
  }

  private buildUploadTask(item: RecoveryUploadItem) {
    const uploadTask = new UploadTask(item.bvid, item.localDir, item.remotePath, this.configStore.get(), {
      cleanupLocal: false,
      files: item.files,
      partialBackup: item.partialBackup,
      historyOnly: item.historyOnly,
      historySnapshotAt: item.historySnapshotAt,
    });
    uploadTask.sharedDownloadDir = item.localDir;
    uploadTask.userId = item.userId;
    uploadTask.mediaId = item.mediaId;
    uploadTask.folderTitle = item.folderTitle;
    uploadTask.videoTitle = item.videoTitle || "";
    uploadTask.upperName = item.upperName || "";
    uploadTask.cover = item.cover || "";
    if (!item.historyOnly) {
      uploadTask.onUploading = () => this.stateManager.markUploading(item.bvid, item.userId, item.mediaId);
    }
    return uploadTask;
  }

  private tryQueueUploadWork(item: RecoveryUploadItem) {
    if (!this.uploadQueue.canAccept()) return false;
    const uploadTask = this.buildUploadTask(item);
    const key = this.recoveryUploadKey(item);
    if (item.priority) {
      uploadTask.recoveryKey = key;
      this.priorityUploadKeys.add(key);
    }
    if (!this.uploadQueue.addTask(uploadTask)) return false;
    if (item.userId && item.mediaId) {
      this.queuedBackupKeys.add(this.backupKey(item.userId, item.mediaId, item.bvid));
    }
    return true;
  }

  private queueUploadWork(item: RecoveryUploadItem) {
    const key = this.recoveryUploadKey(item);
    if (item.priority) {
      this.priorityUploadKeys.add(key);
    }
    if (this.tryQueueUploadWork(item)) return true;
    if (!this.recoveryUploadKeys.has(key)) {
      this.recoveryUploadKeys.add(key);
      this.recoveryUploadBacklog.push(item);
    }
    return false;
  }

  private drainQualityUpgradeUploadBacklog(allowProbe = false) {
    const health = this.uploadCircuit.getSnapshot();
    if (health.state !== "closed" && !allowProbe) return;
    let budget = health.state === "closed" ? Number.POSITIVE_INFINITY : 1;
    while (budget > 0 && this.qualityUpgradeUploadBacklog.length > 0 && this.uploadQueue.canAccept()) {
      const itemIndex = this.qualityUpgradeUploadBacklog.findIndex((item) => !item.notBefore || item.notBefore <= Date.now());
      if (itemIndex < 0) break;
      const [item] = this.qualityUpgradeUploadBacklog.splice(itemIndex, 1);
      const task = item.task;
      if (!this.uploadQueue.addTask(task)) {
        this.qualityUpgradeUploadBacklog.unshift(item);
        break;
      }
      this.syncQualityUpgradeControl(task, task.status);
      budget -= 1;
    }
  }

  private drainRecoveryBacklog(force = false) {
    const config = this.configStore.get();
    const batchSize = Math.max(5, config.startupRecoveryBatchSize || 25);
    const uploadLowWater = this.queueLowWater(config.concurrentUploads, batchSize);
    const health = this.uploadCircuit.getSnapshot();
    if ((force || this.uploadQueue.getSize() <= uploadLowWater) && (health.state === "closed" || force)) {
      let budget = health.state === "closed" ? batchSize : 1;
      while (budget > 0 && this.recoveryUploadBacklog.length > 0 && this.uploadQueue.canAccept()) {
        const itemIndex = this.recoveryUploadBacklog.findIndex((item) => !item.notBefore || item.notBefore <= Date.now());
        if (itemIndex < 0) break;
        const [item] = this.recoveryUploadBacklog.splice(itemIndex, 1);
        const key = this.recoveryUploadKey(item);
        this.recoveryUploadKeys.delete(key);
        if (!this.tryQueueUploadWork(item)) {
          this.recoveryUploadKeys.add(key);
          this.recoveryUploadBacklog.unshift(item);
          break;
        }
        budget -= 1;
      }
    }

    const downloadLowWater = this.queueLowWater(config.concurrentDownloads, batchSize);
    if (force || this.downloadQueue.getSize() <= downloadLowWater) {
      let budget = batchSize;
      while (budget > 0 && this.recoveryDownloadBacklog.length > 0 && this.canCreateDownloadTask()) {
        const item = this.recoveryDownloadBacklog.shift()!;
        const key = this.backupKey(item.user.id, item.mediaId, item.bvid);
        this.recoveryDownloadKeys.delete(key);
        const queued = this.enqueueIfNeeded(item.user, item.mediaId, item.folderTitle, item.bvid, { persisted: true });
        if (!queued) {
          if (!this.canCreateDownloadTask()) {
            this.recoveryDownloadKeys.add(key);
            this.recoveryDownloadBacklog.unshift(item);
            break;
          }
        }
        budget -= 1;
      }
    }

    const nextDeferredUploadAt = this.recoveryUploadBacklog.reduce((next, item) => {
      if (!item.notBefore || item.notBefore <= Date.now()) return next;
      return Math.min(next, item.notBefore);
    }, Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDeferredUploadAt)) {
      this.scheduleRecoveryRefill(nextDeferredUploadAt - Date.now());
    }
  }

  resumePersistedWorkOnStartup() {
    this.resumePersistedWork();
  }

  start() {
    const { pollIntervalMinutes } = this.configStore.get();
    this.stop();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    const startupJitter = 30_000 + Math.floor(Math.random() * 90_000);
    this.nextAutoRunAt = Date.now() + startupJitter;
    this.timer = setInterval(() => {
      this.nextAutoRunAt = Date.now() + intervalMs;
      void this.tick();
    }, intervalMs);
    this.startupTimer = setTimeout(() => {
      this.nextAutoRunAt = Date.now() + intervalMs;
      void this.tick();
    }, startupJitter);
  }

  updateInterval() {
    const config = this.configStore.get();
    this.downloadQueue.setConcurrency(config.concurrentDownloads || 1);
    this.uploadQueue.setConcurrency(config.concurrentUploads || 2);
    this.downloadQueue.setMaxSize(this.queueHighWater(config.concurrentDownloads, config.startupRecoveryBatchSize));
    this.uploadQueue.setMaxSize(this.queueHighWater(config.concurrentUploads, config.startupRecoveryBatchSize));
    this.drainQualityUpgradeUploadBacklog();
    void this.refreshLocalCacheSnapshot(true).then(() => this.downloadQueue.poke());
    this.scheduleRecoveryRefill();
    if (process.env.NODE_ENV !== "test") {
      this.start();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  runNow() {
    console.log("[Scheduler] Manual sync triggered");
    return this.triggerOrQueueTick({ trigger: "manual", skipFavoriteScan: false });
  }

  runReconcileNow() {
    console.log("[Scheduler] Manual reconcile triggered");
    return this.triggerOrQueueTick({
      trigger: "reconcile",
      forceFullRemoteVerify: true,
      forceFullFavoriteScan: true,
      skipFavoriteScan: false,
    });
  }

  runRemoteReconcileNow() {
    console.log("[Scheduler] Manual remote-only reconcile triggered");
    return this.triggerOrQueueTick({
      trigger: "remote_reconcile",
      forceFullRemoteVerify: true,
      skipFavoriteScan: true,
    });
  }

  hasRunningTransferTasks() {
    return this.downloadQueue.isBusy() || this.uploadQueue.isBusy() || this.qualityUpgradeUploadBacklog.length > 0;
  }

  hasActiveOrQueuedSchedulerWork() {
    return this.running || Boolean(this.pendingTickOptions) || this.cleanupLocked;
  }

  refreshLocalCacheState() {
    const limitBytes = this.getLocalCacheLimitBytes();
    const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
    const previousUsedBytes = this.localCacheSnapshot?.usedBytes ?? 0;
    if (limitBytes > 0) {
      this.localCacheSnapshot = {
        limitBytes,
        usedBytes: previousUsedBytes,
        reserveBytes,
        paused: true,
        checkedAt: this.localCacheSnapshot?.checkedAt ?? 0,
      };
    }
    void this.refreshLocalCacheSnapshot(true).then(() => this.downloadQueue.poke());
  }

  withCleanupLock<T>(fn: () => Promise<T>) {
    if (this.cleanupLocked || this.running || this.pendingTickOptions || this.hasRunningTransferTasks()) {
      throw new Error("当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再清理重要数据。");
    }
    this.cleanupLocked = true;
    return fn().finally(() => {
      this.cleanupLocked = false;
    });
  }

  enqueueQualityUpgrade(task: QualityUpgradeTask) {
    task.status = "pending";
    task.error = undefined;
    task.qualityStage = "download";
    task.qualityStageLabel = "等待下载新版";
    const downloadTask = new QualityUpgradeDownloadTask(task);
    if (!this.downloadQueue.addTask(downloadTask)) {
      return false;
    }
    this.syncQualityUpgradeControl(downloadTask, downloadTask.status);
    return true;
  }

  private syncQualityUpgradeControl(
    phaseTask: QualityUpgradeDownloadTask | QualityUpgradeUploadReplaceTask,
    status: QualityUpgradeTask["status"]
  ) {
    const control = phaseTask.control;
    control.status = status;
    control.retries = phaseTask.retries;
    control.queuedAt = phaseTask.queuedAt;
    control.startedAt = phaseTask.startedAt;
    control.retryAt = phaseTask.retryAt;
    control.sequence = phaseTask.sequence;
  }

  private triggerLabel(trigger?: SyncTrigger) {
    switch (trigger) {
      case "manual":
        return "立即同步";
      case "reconcile":
        return "全量扫描并对账";
      case "remote_reconcile":
        return "状态对账（仅AList）";
      case "auto":
      default:
        return "自动同步";
    }
  }

  private getLocalCacheLimitBytes() {
    const limitGB = Number(this.configStore.get().localCacheLimitGB || 0);
    return limitGB > 0 ? limitGB * 1024 * 1024 * 1024 : 0;
  }

  private async refreshLocalCacheSnapshot(force = false) {
    if (this.localCacheRefresh) {
      return this.localCacheRefresh;
    }
    const now = Date.now();
    const limitBytes = this.getLocalCacheLimitBytes();
    if (!force && this.localCacheSnapshot && now - this.localCacheSnapshot.checkedAt < this.localCacheSnapshotTtlMs && this.localCacheSnapshot.limitBytes === limitBytes) {
      return this.localCacheSnapshot;
    }
    this.localCacheRefresh = (async () => {
      const usedBytes = await pathSize(tempDir);
      const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
      const snapshot: LocalCacheSnapshot = {
        limitBytes,
        usedBytes,
        reserveBytes,
        paused: limitBytes > 0 && usedBytes >= Math.max(0, limitBytes - reserveBytes),
        checkedAt: Date.now(),
      };
      this.localCacheSnapshot = snapshot;
      this.localCacheRefresh = null;
      return snapshot;
    })().catch((error) => {
      this.localCacheRefresh = null;
      throw error;
    });
    return this.localCacheRefresh;
  }

  private getLocalCacheSnapshot() {
    const limitBytes = this.getLocalCacheLimitBytes();
    if (!this.localCacheSnapshot || this.localCacheSnapshot.limitBytes !== limitBytes) {
      void this.refreshLocalCacheSnapshot(true).then(() => this.downloadQueue.poke());
      const usedBytes = this.localCacheSnapshot?.usedBytes ?? 0;
      const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
      return {
        limitBytes,
        usedBytes,
        reserveBytes,
        paused: limitBytes > 0 && (!this.localCacheSnapshot || usedBytes >= Math.max(0, limitBytes - reserveBytes)),
        checkedAt: this.localCacheSnapshot?.checkedAt ?? 0,
      };
    }
    if (Date.now() - this.localCacheSnapshot.checkedAt >= this.localCacheSnapshotTtlMs) {
      void this.refreshLocalCacheSnapshot().then(() => this.downloadQueue.poke());
    }
    return this.localCacheSnapshot;
  }

  private canStartDownloadTask() {
    const snapshot = this.getLocalCacheSnapshot();
    return !snapshot.paused
      && !this.uploadCircuit.isDownloadPaused()
      && this.priorityUploadKeys.size === 0
      && this.uploadQueue.canAccept();
  }

  private canCreateDownloadTask() {
    return this.canStartDownloadTask() && this.downloadQueue.canAccept();
  }

  private buildSchedulerSnapshot() {
    const queuedActions = this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [];
    if (this.schedulerProgress) {
      return {
        ...this.schedulerProgress,
        queuedActions,
        lastError: this.lastSchedulerError,
        nextRunAt: this.nextAutoRunAt,
      };
    }

    const cooldowns = this.stateManager.getAllCooldowns();
    const cooldown = Object.values(cooldowns)[0];
    if (cooldown) {
      const user = this.userStore.getById(cooldown.userId);
      return {
        status: "cooldown" as const,
        mode: "cooldown",
        title: "账号冷却中",
        detail: cooldown.reason,
        userName: user?.name || cooldown.userId,
        queuedActions,
        lastError: cooldown.reason,
        updatedAt: Date.now(),
        nextRunAt: cooldown.until,
      };
    }

    return {
      status: queuedActions.length ? "queued" as const : "idle" as const,
      mode: queuedActions.length ? "queued" : "idle",
      title: queuedActions.length ? "调度任务已排队" : "当前调度空闲",
      detail: queuedActions.length ? "已有同步/扫描/对账任务在等待当前任务结束后执行。" : "当前没有正在运行的同步、扫描或对账任务。",
      queuedActions,
      lastError: this.lastSchedulerError,
      updatedAt: Date.now(),
      nextRunAt: this.nextAutoRunAt,
    };
  }

  private updateSchedulerProgress(patch: Partial<SchedulerSnapshot>) {
    const previous = this.schedulerProgress;
    const snapshot: SchedulerSnapshot = {
      status: "running",
      mode: patch.mode ?? previous?.mode ?? this.cycleContext?.trigger ?? "auto",
      title: patch.title ?? previous?.title ?? this.triggerLabel(this.cycleContext?.trigger || "auto"),
      detail: patch.detail ?? previous?.detail ?? "正在运行调度任务。",
      startedAt: previous?.startedAt || Date.now(),
      updatedAt: Date.now(),
      queuedActions: this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [],
    };
    if ("userName" in patch) snapshot.userName = patch.userName;
    if ("folderTitle" in patch) snapshot.folderTitle = patch.folderTitle;
    if ("mediaId" in patch) snapshot.mediaId = patch.mediaId;
    if ("page" in patch) snapshot.page = patch.page;
    if ("pageSize" in patch) snapshot.pageSize = patch.pageSize;
    if ("indexed" in patch) snapshot.indexed = patch.indexed;
    if ("biliTotal" in patch) snapshot.biliTotal = patch.biliTotal;
    if ("checked" in patch) snapshot.checked = patch.checked;
    if ("total" in patch) snapshot.total = patch.total;
    if ("lastError" in patch) snapshot.lastError = patch.lastError;
    if ("nextRunAt" in patch) snapshot.nextRunAt = patch.nextRunAt;
    this.schedulerProgress = snapshot;
  }

  getQueueSnapshot() {
    const downloadPending: QueueBoardItem[] = [];
    const downloadRunning: QueueBoardItem[] = [];
    const uploadPending: QueueBoardItem[] = [];
    const uploadRunning: QueueBoardItem[] = [];

    for (const task of this.downloadQueue.getTasks()) {
      if (task.status === "running") {
        downloadRunning.push(mapQueueBoardTask(task, "download_running"));
      } else if (task.status === "pending" || task.status === "retry_wait") {
        downloadPending.push(mapQueueBoardTask(task, "download_pending"));
      }
    }
    for (const task of this.uploadQueue.getTasks()) {
      if (task.status === "running") {
        uploadRunning.push(mapQueueBoardTask(task, "upload_running"));
      } else if (task.status === "pending" || task.status === "retry_wait") {
        uploadPending.push(mapQueueBoardTask(task, "upload_pending"));
      }
    }

    const bySequence = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.sequence || 0) - Number(b.sequence || 0);
    const byStartedAt = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.startedAt || 0) - Number(b.startedAt || 0);
    downloadPending.sort(bySequence);
    uploadPending.sort(bySequence);
    downloadRunning.sort(byStartedAt);
    uploadRunning.sort(byStartedAt);

    return {
      generatedAt: Date.now(),
      downloadPending,
      downloadRunning,
      uploadPending,
      uploadRunning,
      scheduler: this.buildSchedulerSnapshot(),
      localCache: this.getLocalCacheSnapshot(),
      uploadHealth: this.uploadCircuit.getSnapshot(),
      downloadRecovery: inspectDownloadRecoverySync(tempDir),
      recovery: {
        pendingUploads: this.recoveryUploadBacklog.length,
        pendingDownloads: this.recoveryDownloadBacklog.length,
        batchSize: this.configStore.get().startupRecoveryBatchSize || 25,
      },
    };
  }

  async tick(manual = false, options: TickOptions = {}) {
    if (this.cleanupLocked || this.running) {
      return false;
    }
    const trigger: SyncTrigger = options.trigger || (manual ? "manual" : "auto");
    this.running = true;
    this.cycleContext = this.createCycleStats(trigger);
    this.schedulerProgress = {
      status: "running",
      mode: trigger,
      title: this.triggerLabel(trigger),
      detail: "正在准备调度任务。",
      queuedActions: this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.lastSchedulerError = "";
    try {
      this.remoteDirListingCache.clear();
      if (!options.skipFavoriteScan) {
        this.recoverStaleActiveBackups();
        this.requeueRetryPendingBeforeScan();
        await this.runOnce(manual, options.forceFullFavoriteScan === true);
      }
      await this.verifyRemoteSamples(manual, options.forceFullRemoteVerify === true);
      this.logCycleSummary(this.cycleContext);
    } catch (error: any) {
      const message = error?.message || String(error);
      console.error("[Scheduler] Tick failed:", message);
      this.cycleContext.error = message;
      this.lastSchedulerError = message;
      this.logCycleSummary(this.cycleContext);
    } finally {
      this.cycleContext = null;
      this.running = false;
      this.schedulerProgress = null;
      const queued = this.pendingTickOptions;
      this.pendingTickOptions = null;
      if (queued) {
        setTimeout(() => {
          const queuedManual = (queued.trigger || "auto") !== "auto";
          void this.tick(queuedManual, queued);
        }, 0);
      }
    }
    return true;
  }

  private async runOnce(manual: boolean, forceFullFavoriteScan: boolean) {
    const users = this.userStore.list().filter((user) => user.enabled);
    this.updateSchedulerProgress({ detail: `正在检查 ${users.length} 个启用账号。` });
    for (const user of users) {
      const cooldown = this.stateManager.getUserCooldown(user.id);
      if (cooldown) {
        console.warn(`[Scheduler] User ${user.name} is cooling down until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
        continue;
      }

      for (const folder of user.favorites) {
        try {
          this.updateSchedulerProgress({
            userName: user.name,
            folderTitle: folder.title,
            mediaId: folder.mediaId,
            detail: forceFullFavoriteScan ? "准备全量扫描收藏夹。" : "准备同步收藏夹。",
          });
          if (forceFullFavoriteScan) {
            await this.scanAllPages(user, folder.mediaId, folder.title);
          } else {
            const hotLastPage = await this.scanHotPages(user, folder.mediaId, folder.title, manual);
            await this.scanHistoryPages(user, folder.mediaId, folder.title, manual, hotLastPage);
          }
        } catch (error: any) {
          if (error instanceof BiliRiskOrLoginError) {
            this.stateManager.setUserCooldown(user.id, error.message, cooldownMs());
            console.warn(`[Scheduler] Risk control for user ${user.name}; cooling down.`);
            break;
          }
          console.error("Failed to scan favorite", error);
        }

        const jitter = 2000 + Math.floor(Math.random() * 3000);
        await delay(jitter);
      }
    }
  }

  private async listFavoriteItemsPageWithAuthRetry(
    user: BiliUser,
    mediaId: number,
    page: number,
    pageSize: number
  ) {
    try {
      return await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
    } catch (error: any) {
      if (!(error instanceof BiliRiskOrLoginError)) {
        throw error;
      }
      if (!user.accessToken || !user.refreshToken) {
        throw error;
      }
      try {
        const refreshed = await refreshUserAuth(user.accessToken, user.refreshToken);
        if (!refreshed) {
          throw error;
        }
        const updated = this.userStore.updatePartial(user.id, {
          cookie: refreshed.cookie,
          rawAuth: refreshed.rawAuth,
          accessToken: refreshed.accessToken || user.accessToken,
          refreshToken: refreshed.refreshToken || user.refreshToken,
          expires: refreshed.expires || user.expires,
          lastAuthRefreshAt: new Date().toISOString(),
          lastAuthRefreshError: "",
        });
        if (!updated) {
          throw error;
        }
        user.cookie = updated.cookie;
        user.accessToken = updated.accessToken;
        user.refreshToken = updated.refreshToken;
        user.expires = updated.expires;
        console.warn(`[Scheduler] Refreshed auth for ${user.name} after login/risk error; retrying page ${page}.`);
        return await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
      } catch (refreshError: any) {
        this.userStore.updatePartial(user.id, {
          lastAuthRefreshError: refreshError?.message || String(refreshError),
        });
        throw error;
      }
    }
  }

  private backupKey(userId: string, mediaId: number, bvid: string) {
    return `${userId}:${mediaId}:${bvid}`;
  }

  private getLocalCacheReserveBytes(limitBytes = this.getLocalCacheLimitBytes()) {
    if (limitBytes <= 0) return 0;
    return Math.min(limitBytes, Math.max(512 * 1024 * 1024, Math.floor(limitBytes * 0.1)));
  }

  private selfVisibleProbeKey(userId: string, bvid: string) {
    return `${userId}:${bvid}`;
  }

  private async resolveSelfVisibleItemForSync(
    user: BiliUser,
    item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]
  ) {
    if (!item.unavailable || !user.uid || Number(item.upperMid || 0) !== Number(user.uid)) {
      return item;
    }
    const key = this.selfVisibleProbeKey(user.id, item.bvid);
    const cached = this.selfVisibleProbeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.item;
    }
    const resolved = await resolveSelfVisibleFavoriteItem(user.cookie, user.uid, item);
    this.selfVisibleProbeCache.set(key, {
      expiresAt: Date.now() + 10 * 60_000,
      item: resolved,
    });
    if (resolved.selfVisible) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `自稿件失效项已恢复详情 ${item.bvid}`,
        raw: `[SelfVisible] ${user.name}/${item.bvid} resolved from favorite-unavailable to self-visible`,
        bvid: item.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    return resolved;
  }

  private makeSingleTarget(task: DownloadTask): UploadTarget[] {
    if (!task.userId || !task.mediaId || !task.remotePath) {
      return [];
    }
    return [{
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: task.folderTitle || "favorites",
      remotePath: task.remotePath,
    }];
  }

  private createSharedUploadDirTracker(downloadDir: string, uploadCount: number, bvid?: string) {
    const normalizedCount = Math.max(0, uploadCount);
    const existing = this.sharedUploadDirs.get(downloadDir);
    if (existing) {
      existing.remaining += normalizedCount;
      if (bvid) existing.bvids.add(bvid);
      return existing;
    }
    const tracker: SharedUploadDirTracker = {
      remaining: normalizedCount,
      cleanupStarted: false,
      failedTargets: new Set(),
      bvids: new Set(bvid ? [bvid] : []),
    };
    this.sharedUploadDirs.set(downloadDir, tracker);
    return tracker;
  }

  private async completeSharedUploadTask(task: UploadTask, succeeded: boolean) {
    const downloadDir = task.sharedDownloadDir || "";
    if (!downloadDir) return;
    const tracker = this.sharedUploadDirs.get(downloadDir);
    if (!tracker) return;
    const targetKey = this.uploadTaskKey(task);
    if (succeeded) {
      tracker.failedTargets.delete(targetKey);
    } else {
      tracker.failedTargets.add(targetKey);
    }
    tracker.remaining = Math.max(0, tracker.remaining - 1);
    if (tracker.remaining > 0 || tracker.cleanupStarted) return;
    tracker.cleanupStarted = true;
    this.sharedUploadDirs.delete(downloadDir);
    if (tracker.failedTargets.size > 0) {
      void this.refreshLocalCacheSnapshot(true).then(() => this.downloadQueue.poke());
      return;
    }
    await this.cleanupSharedUploadDir(downloadDir, tracker.bvids);
  }

  private async cleanupSharedUploadDir(downloadDir: string, bvids: Set<string> = new Set()) {
    try {
      const result = await cleanupUploadedSessionFiles(downloadDir);
      for (const bvid of bvids) {
        this.stateManager.markLocalUploadGroupComplete(bvid, downloadDir);
      }
      if (!result.removedDirectory) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: "warn",
          summary: `已保留无法确认的下载残片，等待手动清理`,
          raw: `[DownloadRecovery] retained ${result.retainedBytes} bytes in ${downloadDir}`,
          simpleVisible: true,
          debugVisible: true,
        });
      }
    } catch (error: any) {
      console.warn(`[Scheduler] Failed to cleanup ${downloadDir}:`, error?.message || error);
    } finally {
      void this.refreshLocalCacheSnapshot(true).then(() => this.downloadQueue.poke());
    }
  }

  private async scanAllPages(user: BiliUser, mediaId: number, folderTitle: string) {
    this.updateSchedulerProgress({
      mode: "reconcile",
      title: "全量扫描并对账",
      userName: user.name,
      folderTitle,
      mediaId,
      page: 1,
      detail: "正在全量扫描 B 站收藏夹。",
    });
    let page = 1;
    const scanStartedAt = new Date().toISOString();
    const seenBvids = new Set<string>();
    let lastTotal: number | undefined;
    this.stateManager.updateFolderScan(user.id, mediaId, {
      folderTitle,
      initStatus: "initializing",
      lastHotScanAt: scanStartedAt,
      lastHistoryScanAt: scanStartedAt,
    });
    while (true) {
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      lastTotal = result.total;
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        indexed: seenBvids.size + result.items.length,
        biliTotal: result.total,
        detail: `正在全量扫描第 ${page} 页。`,
      });
      await this.recordPage(user, mediaId, folderTitle, result.items, page, 20, scanStartedAt, seenBvids);
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: "initializing",
        nextHistoryPage: page + 1,
        catchupPage: 1,
        lastHotScanAt: scanStartedAt,
        lastHistoryScanAt: scanStartedAt,
        total: result.total,
      });
      if (!result.hasMore || result.items.length === 0) {
        break;
      }
      page += 1;
      await delay(1000 + Math.floor(Math.random() * 2000));
    }
    this.stateManager.updateFolderScan(user.id, mediaId, {
      folderTitle,
      initStatus: "complete",
      nextHistoryPage: 1,
      catchupPage: 1,
      lastHotScanAt: scanStartedAt,
      lastHistoryScanAt: scanStartedAt,
      total: lastTotal,
    });
    this.stateManager.markMissingFavoritesInactive(user.id, mediaId, seenBvids);
  }

  private async scanHotPages(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean) {
    this.updateSchedulerProgress({
      mode: manual ? "manual" : "auto",
      title: this.triggerLabel(manual ? "manual" : "auto"),
      userName: user.name,
      folderTitle,
      mediaId,
      detail: "正在扫描收藏夹近期页面。",
    });
    let consecutiveKnownPages = 0;
    let burstBudget = 0;
    const minPages = manual ? 10 : this.hotScanMinPages;
    const maxPages = manual ? 40 : this.hotScanMaxPages;
    let lastPage = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        biliTotal: result.total,
        detail: `正在扫描近期第 ${page} 页。`,
      });
      const pageStats = await this.recordPage(user, mediaId, folderTitle, result.items, page, 20);
      lastPage = page;
      const previousScan = this.stateManager.getFolderScan(user.id, mediaId, folderTitle);
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: previousScan.initStatus === "complete" ? "complete" : "initializing",
        lastHotScanAt: new Date().toISOString(),
        total: result.total,
      });

      if (pageStats.newItems === 0) {
        consecutiveKnownPages += 1;
        if (burstBudget > 0) {
          burstBudget -= 1;
        }
      } else {
        consecutiveKnownPages = 0;
        burstBudget = this.hotScanBurstBudget;
      }

      const canStopForKnownPages = page >= minPages && consecutiveKnownPages >= 2 && burstBudget === 0;
      if (!result.hasMore || canStopForKnownPages) {
        break;
      }
      await delay(1000 + Math.floor(Math.random() * 2000));
    }
    return lastPage;
  }

  private async scanHistoryPages(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    manual: boolean,
    startAfterPage = 0
  ) {
    this.updateSchedulerProgress({
      userName: user.name,
      folderTitle,
      mediaId,
      detail: "正在补扫收藏夹历史页面。",
    });
    const scan = this.stateManager.getFolderScan(user.id, mediaId, folderTitle);
    const hasKnownTotal = typeof scan.total === "number" && scan.total > 0;
    const totalPages = hasKnownTotal ? Math.max(1, Math.ceil((scan.total || 0) / 20)) : null;
    const historyLoopPage = totalPages ? Math.max(startAfterPage + 1, totalPages) : Math.max(startAfterPage + 1, 1);
    const inCatchupMode = scan.initStatus === "complete" && !manual && totalPages !== null && totalPages > startAfterPage;
    let page = inCatchupMode
      ? Math.max(scan.catchupPage || 1, 1)
      : Math.max(scan.nextHistoryPage || 1, startAfterPage + 1, 1);
    const pagesThisRun = inCatchupMode
      ? this.historyPagesPerTick
      : (manual ? this.manualHistoryPagesPerTick : this.initialHistoryPagesPerTick);

    for (let i = 0; i < pagesThisRun; i += 1) {
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        biliTotal: result.total,
        detail: `正在补扫历史第 ${page} 页。`,
      });
      await this.recordPage(user, mediaId, folderTitle, result.items, page, 20);

      if (!result.hasMore || result.items.length === 0) {
        const completeWithoutTotal = !manual && !totalPages && page > Math.max(startAfterPage + 1, 1);
        this.stateManager.updateFolderScan(user.id, mediaId, {
          folderTitle,
          initStatus: totalPages || completeWithoutTotal ? "complete" : "initializing",
          nextHistoryPage: totalPages ? 1 : page + 1,
          catchupPage: 1,
          lastHistoryScanAt: new Date().toISOString(),
          total: result.total,
        });
        break;
      }

      page += 1;
      let nextCatchupPage = inCatchupMode ? page : (scan.catchupPage || 1);
      if (inCatchupMode && totalPages) {
        nextCatchupPage = page > historyLoopPage ? 1 : page;
      }
      const hasCompletedInitialScan = Boolean(totalPages && page > totalPages);
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: totalPages ? (inCatchupMode || hasCompletedInitialScan ? "complete" : "initializing") : "initializing",
        nextHistoryPage: inCatchupMode ? (scan.nextHistoryPage || 1) : (hasCompletedInitialScan ? 1 : page),
        catchupPage: nextCatchupPage,
        lastHistoryScanAt: new Date().toISOString(),
        total: result.total,
      });
      await delay(1000 + Math.floor(Math.random() * 2000));
    }
  }

  private async recordPage(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    items: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"],
    page: number,
    pageSize = 20,
    seenAt = new Date().toISOString(),
    seenBvids?: Set<string>
  ) {
    let newItems = 0;
    for (const [indexInPage, rawItem] of items.entries()) {
      const item = await this.resolveSelfVisibleItemForSync(user, rawItem);
      seenBvids?.add(item.bvid);
      const favOrder = (Math.max(1, page) - 1) * Math.max(1, pageSize) + indexInPage + 1;
      const result = this.stateManager.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
        favOrder,
        favPage: page,
        favIndexInPage: indexInPage,
      }, seenAt);
      if (!item.unavailable && item.cover) {
        queueCoverCache(item.bvid, item.cover, (coverLocalPath) => {
          this.stateManager.recordCoverCache(item.bvid, coverLocalPath);
        });
      }
      if (!result.wasKnown) {
        newItems += 1;
        this.cycleContext!.newItems += 1;
      }
      const queued = this.enqueueIfNeeded(user, mediaId, folderTitle, item.bvid);
      if (queued) {
        this.cycleContext!.queuedItems += 1;
      }
    }
    return { newItems };
  }

  private enqueueIfNeeded(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    bvid: string,
    options: { persisted?: boolean } = {}
  ) {
    if (!user.enabled) {
      return false;
    }
    const key = this.backupKey(user.id, mediaId, bvid);
    if (this.queuedBackupKeys.has(key) || (!options.persisted && !this.stateManager.shouldEnqueueBackup(bvid, user.id, mediaId, this.cycleContext?.startedAt))) {
      return false;
    }
    const config = this.configStore.get();
    const remotePath = resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName: folderTitle,
    });
    const target: UploadTarget = {
      userId: user.id,
      mediaId,
      folderTitle,
      remotePath,
    };

    const activeTargets = this.activeDownloadTargets.get(bvid);
    if (activeTargets) {
      activeTargets.push(target);
      if (!options.persisted) {
        this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
      }
      this.queuedBackupKeys.add(key);
      return true;
    }

    if (!this.canCreateDownloadTask()) {
      return false;
    }

    const task = new DownloadTask(bvid, user.cookie, config);
    task.userId = user.id;
    task.mediaId = mediaId;
    task.folderTitle = folderTitle;
    task.remotePath = remotePath;
    const meta = this.stateManager.getVideoMeta(bvid);
    task.videoTitle = meta?.title || "";
    task.upperName = meta?.upperName || "";
    task.cover = meta?.cover || "";
    task.targets = [target];
    task.onDownloading = () => this.stateManager.markDownloading(bvid, task.targets);
    task.onPrepared = (_task, downloadDir, manifest) => this.stateManager.markDownloadPrepared(
      bvid,
      downloadDir,
      {
        id: manifest.sessionId,
        localDir: downloadDir,
        kind: manifest.kind,
        status: manifest.status,
        completedPages: manifest.outputs.length,
        totalPages: manifest.pages.length,
        updatedAt: manifest.updatedAt,
      },
      task.targets
    );
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir, task.targets);

    if (!options.persisted) {
      this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
    }
    this.queuedBackupKeys.add(key);
    this.activeDownloadTargets.set(bvid, task.targets);
    if (!this.downloadQueue.addTask(task)) {
      this.activeDownloadTargets.delete(bvid);
      this.queuedBackupKeys.delete(key);
      return false;
    }
    return true;
  }

  private requeueRetryPendingBeforeScan() {
    const users = this.userStore.list().filter((user) => user.enabled);
    let remaining = Math.max(1, this.configStore.get().remoteRequeueLimitPerCycle || 20);
    this.stateManager.runBatch(() => {
      for (const user of users) {
        for (const folder of user.favorites) {
          if (remaining <= 0 || !this.canCreateDownloadTask()) return;
          const bvids = this.stateManager.listRetryCandidatesForFolder(user.id, folder.mediaId, remaining);
          for (const bvid of bvids) {
            if (remaining <= 0 || !this.canCreateDownloadTask()) return;
            const queued = this.enqueueIfNeeded(user, folder.mediaId, folder.title, bvid);
            if (queued) {
              this.cycleContext!.queuedItems += 1;
              remaining -= 1;
            }
          }
        }
      }
    });
  }

  private triggerOrQueueTick(options: TickOptions) {
    if (this.cleanupLocked) {
      return { started: false, queued: false };
    }
    if (this.running) {
      this.pendingTickOptions = this.mergeTickOptions(this.pendingTickOptions, options);
      return { started: false, queued: true };
    }
    const manual = (options.trigger || "auto") !== "auto";
    void this.tick(manual, options);
    return { started: true, queued: false };
  }

  private mergeTickOptions(current: TickOptions | null, incoming: TickOptions): TickOptions {
    if (!current) {
      return { ...incoming };
    }
    const triggerPriority: Record<SyncTrigger, number> = {
      auto: 0,
      remote_reconcile: 1,
      manual: 2,
      reconcile: 3,
    };
    const currentTrigger = (current.trigger || "auto") as SyncTrigger;
    const incomingTrigger = (incoming.trigger || "auto") as SyncTrigger;
    const trigger = triggerPriority[incomingTrigger] >= triggerPriority[currentTrigger] ? incomingTrigger : currentTrigger;

    const forceFullFavoriteScan = Boolean(current.forceFullFavoriteScan || incoming.forceFullFavoriteScan);
    const skipFavoriteScan = forceFullFavoriteScan
      ? false
      : Boolean(current.skipFavoriteScan && incoming.skipFavoriteScan);

    return {
      trigger,
      forceFullRemoteVerify: Boolean(current.forceFullRemoteVerify || incoming.forceFullRemoteVerify),
      forceFullFavoriteScan,
      skipFavoriteScan,
    };
  }

  private async verifyRemoteSamples(manual: boolean, forceFullRemoteVerify: boolean) {
    if (!this.cycleContext) return;

    const config = this.configStore.get();
    this.updateSchedulerProgress({
      mode: forceFullRemoteVerify ? (manual ? "remote_reconcile" : this.cycleContext.trigger) : this.cycleContext.trigger,
      title: forceFullRemoteVerify ? "状态对账" : this.triggerLabel(this.cycleContext.trigger),
      detail: forceFullRemoteVerify ? "正在准备 AList 远端状态对账。" : "正在抽样验证 AList 远端文件。",
      userName: undefined,
      folderTitle: undefined,
      mediaId: undefined,
      page: undefined,
      pageSize: undefined,
      indexed: undefined,
      biliTotal: undefined,
      checked: undefined,
      total: undefined,
    });
    this.remoteVerifyPathQueue.clear();
    const verifyLimit = forceFullRemoteVerify ? undefined : this.getRemoteVerifyLimit(manual, this.cycleContext.newItems);
    const includeDeferred = forceFullRemoteVerify;
    const candidates = this.stateManager.listVideosForRemoteVerify(verifyLimit, includeDeferred);
    this.cycleContext.remoteChecked = candidates.length;
    this.cycleContext.remoteEligible = this.stateManager.countVideosForRemoteVerify(includeDeferred);
    const concurrency = Math.max(1, Math.min(100, Math.floor(config.remoteVerifyConcurrency || 3)));
    const requeueLimit = Math.max(1, Math.min(1000, Math.floor(config.remoteRequeueLimitPerCycle || 20)));
    const rateLimit = Math.max(0.5, Math.min(100, Number(config.remoteVerifyRateLimitPerSecond || 2)));
    let requeueCount = 0;

    const executeOne = async (entry: RemoteVerifyCandidate) => {
      try {
        const relation = entry.relation;
        const resolvedRemotePath = relation.remotePath || entry.remotePath || this.deriveRemotePathFromRelation(entry, relation);
        await this.applyRemoteVerifyRateLimit(rateLimit, resolvedRemotePath || "<remote-unknown>");
        const jitter = 100 + Math.floor(Math.random() * 201);
        await delay(jitter);
        const remoteFiles = await this.resolveRemoteFilesForVerify(entry, relation, resolvedRemotePath);
        if (!remoteFiles?.length) {
          const confirmed = await this.confirmRemoteStillMissing(entry, relation, undefined, resolvedRemotePath);
          if (confirmed.status === "ok") {
            this.stateManager.markRemoteCheckOk(entry.bvid, resolvedRemotePath || entry.remotePath, confirmed.remoteFiles, relation.userId, relation.mediaId);
            this.cycleContext!.remoteOk += 1;
            return;
          }
          if (confirmed.status === "unknown") {
            const delayMs = this.computeRemoteVerifyBackoffMs(entry);
            this.stateManager.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
            this.cycleContext!.remoteErrors += 1;
            return;
          }
          const missing = confirmed.missing?.length
            ? confirmed.missing
            : [resolvedRemotePath || entry.remotePath || "<remote-path-unknown>"];
          this.stateManager.markRemoteCheckMissing(entry.bvid, missing, relation.userId, relation.mediaId);
          this.cycleContext!.remoteMissingDetected += 1;
          if (entry.biliStatus === "unavailable") {
            this.cycleContext!.remoteMissingUnavailable += 1;
          }
          if (requeueCount < requeueLimit) {
            const requeued = this.enqueueMissingIfPossible(entry, relation);
            if (requeued) {
              requeueCount += 1;
              this.cycleContext!.requeuedFromRemoteMissing += 1;
            }
          }
          return;
        }

        const result = await verifyRemoteFiles(config, remoteFiles);
        if (result.ok) {
          this.stateManager.markRemoteCheckOk(entry.bvid, resolvedRemotePath || entry.remotePath, remoteFiles, relation.userId, relation.mediaId);
          this.cycleContext!.remoteOk += 1;
          return;
        }

        const confirmed = await this.confirmRemoteStillMissing(entry, relation, remoteFiles, resolvedRemotePath);
        if (confirmed.status === "ok") {
          this.stateManager.markRemoteCheckOk(
            entry.bvid,
            resolvedRemotePath || entry.remotePath,
            confirmed.remoteFiles || remoteFiles,
            relation.userId,
            relation.mediaId
          );
          this.cycleContext!.remoteOk += 1;
          return;
        }
        if (confirmed.status === "unknown") {
          const delayMs = this.computeRemoteVerifyBackoffMs(entry);
          this.stateManager.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
          this.cycleContext!.remoteErrors += 1;
          return;
        }

        const missing = confirmed.missing?.length ? confirmed.missing : result.missing;
        this.stateManager.markRemoteCheckMissing(entry.bvid, missing, relation.userId, relation.mediaId);
        this.cycleContext!.remoteMissingDetected += 1;
        if (entry.biliStatus === "unavailable") {
          this.cycleContext!.remoteMissingUnavailable += 1;
        }
        if (requeueCount < requeueLimit) {
          const requeued = this.enqueueMissingIfPossible(entry, relation);
          if (requeued) {
            requeueCount += 1;
            this.cycleContext!.requeuedFromRemoteMissing += 1;
          }
        }
      } catch (error: any) {
        const delayMs = this.computeRemoteVerifyBackoffMs(entry);
        const relation = entry.relation;
        this.stateManager.markRemoteCheckDeferred(entry.bvid, delayMs, error?.message || "Remote verify failed", relation.userId, relation.mediaId);
        this.cycleContext!.remoteErrors += 1;
        console.warn(`[Scheduler] Remote verify failed for ${entry.bvid}:`, error?.message || error);
      }
    };

    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (index < candidates.length) {
        const current = candidates[index];
        index += 1;
        this.updateSchedulerProgress({
          checked: index,
          total: candidates.length,
          detail: `正在对账 AList 远端文件 ${index}/${candidates.length}。`,
        });
        await executeOne(current);
      }
    });
    await Promise.all(workers);
  }

  private async resolveRemoteFilesForVerify(
    entry: VideoArchiveEntry,
    relation?: FavoriteRelation,
    resolvedRemotePath?: string | null
  ) {
    const recordedFiles = relation?.remoteFiles?.length ? relation.remoteFiles : entry.remoteFiles;
    if (recordedFiles?.length) {
      return recordedFiles;
    }
    const pathToUse = resolvedRemotePath || relation?.remotePath || entry.remotePath || this.deriveRemotePathFromRelation(entry, relation);
    if (!pathToUse) {
      return [];
    }
    const names = await this.getRemoteDirListing(pathToUse);
    if (!names.length) {
      return [];
    }
    const matchedNames = names.filter((name) => name.includes(entry.bvid));
    if (!matchedNames.length) {
      return [];
    }
    return matchedNames.map((name) => ({
      name,
      path: pathToUse.replace(/\/$/, "") + "/" + name,
    }));
  }

  private deriveRemotePathFromRelation(entry: VideoArchiveEntry, relation?: FavoriteRelation) {
    const resolvedRelation = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
    if (!resolvedRelation) {
      return null;
    }
    const config = this.configStore.get();
    const userSegment = sanitizeSegment(resolvedRelation.user.name) || "user";
    const folderSegment = sanitizeSegment(resolvedRelation.folderTitle) || "favorites";
    switch (config.uploadLayout) {
      case "user-folder-video":
        return joinRemotePath(config.alistDest, userSegment, folderSegment);
      case "folder-video":
        return joinRemotePath(config.alistDest, folderSegment);
      case "video-only":
      default:
        return joinRemotePath(config.alistDest);
    }
  }

  private async getRemoteDirListing(pathToUse: string) {
    const now = Date.now();
    const cached = this.remoteDirListingCache.get(pathToUse);
    if (cached && cached.expiresAt > now) {
      return cached.names;
    }
    const config = this.configStore.get();
    const names = await listRemoteDir(config, pathToUse);
    this.remoteDirListingCache.set(pathToUse, {
      expiresAt: now + this.remoteDirListingCacheTtlMs,
      names,
    });
    return names;
  }

  private enqueueMissingIfPossible(entry: VideoArchiveEntry, targetRelation?: FavoriteRelation) {
    if (entry.biliStatus === "unavailable") return false;
    const relations = targetRelation ? [targetRelation] : this.stateManager.listRelationsForBvid(entry.bvid);
    for (const relation of relations) {
      const resolved = this.resolveRelation(relation);
      if (!resolved) continue;
      return this.enqueueIfNeeded(
        resolved.user,
        resolved.mediaId,
        resolved.folderTitle,
        entry.bvid
      );
    }
    return false;
  }

  private recoverStaleActiveBackups() {
    const items = this.stateManager.listStaleActiveBackups(this.staleActiveBackupMs);
    this.stateManager.runBatch(() => {
      for (const item of items) {
        const relation = item.relation;
        const key = this.backupKey(relation.userId, relation.mediaId, relation.bvid);
        if (this.queuedBackupKeys.has(key)) continue;
        const resolved = this.resolveRelation(relation);
        if (!resolved) continue;

        const localDir = item.video.localDir;
        if (localDir && fs.existsSync(localDir)) {
          const manifest = readDownloadSession(localDir);
          const uploadReady = Boolean(manifest && (manifest.status === "complete" || manifest.status === "partial"));
          if (!uploadReady) {
            this.stateManager.markDownloadInterrupted(relation.bvid, localDir, "Stale download session queued for resume.", [{ userId: relation.userId, mediaId: relation.mediaId }]);
            if (!this.recoveryDownloadKeys.has(key)) {
              this.recoveryDownloadKeys.add(key);
              this.recoveryDownloadBacklog.push({
                user: resolved.user,
                mediaId: resolved.mediaId,
                folderTitle: resolved.folderTitle,
                bvid: relation.bvid,
              });
            }
            continue;
          }
          const remotePath = relation.remotePath || item.video.remotePath || resolveRemotePath({
            destination: this.configStore.get().alistDest,
            layout: this.configStore.get().uploadLayout,
            userName: resolved.user.name,
            folderName: resolved.folderTitle,
          });
          this.stateManager.markUploadFailed(relation.bvid, localDir, relation.userId, relation.mediaId, "Stale upload retained locally and queued for upload retry.");
          const historyTargetKey = `${relation.userId}:${relation.mediaId}`;
          const historyGroups = historySessionGroups(localDir)
            .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
            .filter((group) => group.files.length > 0);
          this.createSharedUploadDirTracker(localDir, 1 + historyGroups.length, relation.bvid);
          const baseUpload: RecoveryUploadItem = {
            bvid: relation.bvid,
            localDir,
            remotePath,
            userId: relation.userId,
            mediaId: relation.mediaId,
            folderTitle: resolved.folderTitle,
            videoTitle: item.video.title,
            upperName: item.video.upperName,
            cover: item.video.cover,
            files: manifest?.outputs.map((output) => output.relativePath),
            partialBackup: manifest?.status === "partial",
            priority: true,
          };
          this.queueUploadWork(baseUpload);
          for (const history of historyGroups) {
            this.queueUploadWork({
              ...baseUpload,
              remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
          continue;
        }

        this.stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Active backup state became stale and was re-queued.");
        const queued = this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid);
        if (queued && this.cycleContext) this.cycleContext.queuedItems += 1;
      }
    });
  }

  private async confirmRemoteStillMissing(
    entry: VideoArchiveEntry,
    relation?: FavoriteRelation,
    knownFiles?: VideoArchiveEntry["remoteFiles"],
    resolvedRemotePath?: string | null
  ): Promise<
    | { status: "ok"; remoteFiles: NonNullable<VideoArchiveEntry["remoteFiles"]> }
    | { status: "missing"; missing: string[] }
    | { status: "unknown" }
  > {
    try {
      const remoteFiles = knownFiles?.length ? knownFiles : await this.resolveRemoteFilesForVerify(entry, relation, resolvedRemotePath);
      if (!remoteFiles?.length) {
        return { status: "missing", missing: [resolvedRemotePath || entry.remotePath || "<remote-path-unknown>"] };
      }
      const config = this.configStore.get();
      const result = await verifyRemoteFiles(config, remoteFiles);
      if (result.ok) {
        return { status: "ok", remoteFiles };
      }
      return { status: "missing", missing: result.missing };
    } catch {
      // Treat transient errors as inconclusive to avoid false-positive "missing".
      return { status: "unknown" };
    }
  }

  private async applyRemoteVerifyRateLimit(rateLimitPerSecond: number, remotePath: string) {
    const intervalMs = Math.max(50, Math.floor(1000 / rateLimitPerSecond));
    const now = Date.now();
    const pathNextAllowed = this.remoteVerifyPathQueue.get(remotePath) || 0;
    const nextAllowed = Math.max(this.remoteVerifyNextAllowedAt, pathNextAllowed);
    if (nextAllowed <= now) {
      const next = now + intervalMs;
      this.remoteVerifyNextAllowedAt = next;
      this.remoteVerifyPathQueue.set(remotePath, next + Math.floor(intervalMs / 2));
      return;
    }
    const waitMs = nextAllowed - now;
    const next = nextAllowed + intervalMs;
    this.remoteVerifyNextAllowedAt = next;
    this.remoteVerifyPathQueue.set(remotePath, next + Math.floor(intervalMs / 2));
    await delay(waitMs);
  }

  private computeRemoteVerifyBackoffMs(entry: VideoArchiveEntry) {
    const missingCount = Math.max(0, entry.remoteMissingCount || 0);
    const base = 30_000;
    const max = 30 * 60_000;
    const exp = Math.min(6, missingCount);
    const backoff = Math.min(max, base * Math.pow(2, exp));
    const jitter = Math.floor(Math.random() * 3_000);
    return backoff + jitter;
  }

  private queueLegacyDownloadDirsForRecovery() {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(tempDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
      const localDir = path.join(tempDir, entry.name);
      if (fs.existsSync(path.join(localDir, DOWNLOAD_RETAINED_FILE))) continue;
      if (readDownloadSession(localDir)) continue;
      const resolved = this.findBestRelationForBvid(entry.name);
      if (!resolved) continue;
      const key = this.backupKey(resolved.user.id, resolved.mediaId, entry.name);
      if (this.recoveryDownloadKeys.has(key)) continue;
      this.stateManager.markDownloadInterrupted(
        entry.name,
        localDir,
        "Legacy local cache queued for safe recovery.",
        [{ userId: resolved.user.id, mediaId: resolved.mediaId }]
      );
      this.recoveryDownloadKeys.add(key);
      this.recoveryDownloadBacklog.push({
        user: resolved.user,
        mediaId: resolved.mediaId,
        folderTitle: resolved.folderTitle,
        bvid: entry.name,
      });
    }
  }

  private resumePersistedWork() {
    this.queueLegacyDownloadDirsForRecovery();
    this.stateManager.normalizePersistedWorkForRecovery();
    const statusPriority: Record<string, number> = {
      upload_failed: 0,
      uploading: 1,
      downloaded: 2,
      queued: 3,
      downloading: 4,
      missing: 5,
    };
    const items = this.stateManager.listBackupsToResume().sort((left, right) => {
      const leftStatus = left.relation?.backupStatus || left.video.backupStatus;
      const rightStatus = right.relation?.backupStatus || right.video.backupStatus;
      return (statusPriority[leftStatus] ?? 99) - (statusPriority[rightStatus] ?? 99);
    });
    for (const item of items) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
      const status = relation?.backupStatus || entry.backupStatus;
      const localDir = entry.localDir;
      const hasLocalDir = Boolean(localDir && fs.existsSync(localDir));
      if (!resolved) continue;
      const config = this.configStore.get();
      const remotePath = relation?.remotePath || entry.remotePath || resolveRemotePath({
        destination: config.alistDest,
        layout: config.uploadLayout,
        userName: resolved.user.name,
        folderName: resolved.folderTitle,
      });
      if (["verified", "partial_verified"].includes(status) && hasLocalDir && localDir && relation) {
        const targetKey = `${relation.userId}:${relation.mediaId}`;
        const pendingHistory = historySessionGroups(localDir)
          .map((group) => ({
            ...group,
            files: group.files.filter((file) => !(file.uploadedTargets || []).includes(targetKey)),
          }))
          .filter((group) => group.files.length > 0);
        if (pendingHistory.length > 0) {
          this.createSharedUploadDirTracker(localDir, pendingHistory.length, entry.bvid);
          for (const history of pendingHistory) {
            this.queueUploadWork({
              bvid: entry.bvid,
              localDir,
              remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
              userId: relation.userId,
              mediaId: relation.mediaId,
              folderTitle: resolved.folderTitle,
              videoTitle: entry.title,
              upperName: entry.upperName,
              cover: entry.cover,
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
        }
        continue;
      }
      if (["downloaded", "uploading", "upload_failed"].includes(status) && hasLocalDir && localDir) {
        const manifest = readDownloadSession(localDir);
        if (!manifest || !["complete", "partial"].includes(manifest.status)) {
          const downloadKey = this.backupKey(resolved.user.id, resolved.mediaId, entry.bvid);
          if (!this.recoveryDownloadKeys.has(downloadKey)) {
            this.recoveryDownloadKeys.add(downloadKey);
            this.recoveryDownloadBacklog.push({
              user: resolved.user,
              mediaId: resolved.mediaId,
              folderTitle: resolved.folderTitle,
              bvid: entry.bvid,
            });
          }
          continue;
        }
        const uploadItem: RecoveryUploadItem = {
          bvid: entry.bvid,
          localDir,
          remotePath,
          userId: resolved.user.id,
          mediaId: resolved.mediaId,
          folderTitle: resolved.folderTitle,
          videoTitle: entry.title,
          upperName: entry.upperName,
          cover: entry.cover,
          files: manifest.outputs.map((output) => output.relativePath),
          partialBackup: manifest.status === "partial",
          priority: true,
        };
        const key = this.recoveryUploadKey(uploadItem);
        if (!this.recoveryUploadKeys.has(key)) {
          this.recoveryUploadKeys.add(key);
          this.priorityUploadKeys.add(key);
          this.recoveryUploadBacklog.push(uploadItem);
          const historyTargetKey = `${resolved.user.id}:${resolved.mediaId}`;
          const historyGroups = historySessionGroups(localDir)
            .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
            .filter((group) => group.files.length > 0);
          this.createSharedUploadDirTracker(localDir, 1 + historyGroups.length, entry.bvid);
          for (const history of historyGroups) {
            const historyItem: RecoveryUploadItem = {
              ...uploadItem,
              remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            };
            const historyKey = this.recoveryUploadKey(historyItem);
            if (!this.recoveryUploadKeys.has(historyKey)) {
              this.recoveryUploadKeys.add(historyKey);
              this.recoveryUploadBacklog.push(historyItem);
            }
          }
        }
        continue;
      }
      const downloadKey = this.backupKey(resolved.user.id, resolved.mediaId, entry.bvid);
      if (!this.recoveryDownloadKeys.has(downloadKey)) {
        this.recoveryDownloadKeys.add(downloadKey);
        this.recoveryDownloadBacklog.push({
          user: resolved.user,
          mediaId: resolved.mediaId,
          folderTitle: resolved.folderTitle,
          bvid: entry.bvid,
        });
      }
    }
    this.drainRecoveryBacklog(true);
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "info",
      summary: `启动恢复已分批装载：待补传 ${this.recoveryUploadBacklog.length + this.uploadQueue.getSize()}，待下载 ${this.recoveryDownloadBacklog.length + this.downloadQueue.getSize()}`,
      raw: `[Recovery] bounded startup recovery uploads=${this.recoveryUploadBacklog.length} downloads=${this.recoveryDownloadBacklog.length}`,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  private resolveRelation(relation: FavoriteRelation) {
    const user = this.userStore.getById(relation.userId);
    if (!user || !user.enabled) return null;
    const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
    return {
      user,
      mediaId: folder?.mediaId ?? relation.mediaId,
      folderTitle: folder?.title ?? relation.folderTitle,
    };
  }

  private findBestRelationForBvid(bvid: string) {
    const relations = this.stateManager.listRelationsForBvid(bvid);
    for (const relation of relations) {
      const user = this.userStore.getById(relation.userId);
      if (!user || !user.enabled) continue;
      const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
      return {
        user,
        mediaId: folder?.mediaId ?? relation.mediaId,
        folderTitle: folder?.title ?? relation.folderTitle,
      };
    }
    return null;
  }

  private createCycleStats(trigger: SyncTrigger): SyncCycleStats {
    return {
      startedAt: new Date().toISOString(),
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

  private getRemoteVerifyLimit(manual: boolean, newItems: number) {
    if (manual) {
      return this.remoteVerifyPerTickManual;
    }
    if (newItems === 0) {
      return this.remoteVerifyPerTickNoNew;
    }
    return this.remoteVerifyPerTick;
  }

  private logCycleSummary(stats: SyncCycleStats | null) {
    if (!stats) return;
    const isNoNew = stats.newItems === 0 && !stats.error;
    const modeLabel = stats.trigger === "reconcile"
      ? "reconcile"
      : (stats.trigger === "remote_reconcile" ? "remote_reconcile" : (stats.trigger === "manual" ? "manual" : "auto"));
    const durationMs = Math.max(0, Date.now() - Date.parse(stats.startedAt));
    const durationSec = (durationMs / 1000).toFixed(1);

    if (stats.trigger === "reconcile" || stats.trigger === "remote_reconcile") {
      const level = stats.error ? "error" : "info";
      const summary = stats.error
        ? `${modeLabel} failed: ${stats.error}`
        : `${modeLabel} done: new ${stats.newItems}, queued ${stats.queuedItems}, remote ${stats.remoteChecked}/${stats.remoteEligible}, missing ${stats.remoteMissingDetected}, requeued ${stats.requeuedFromRemoteMissing}, ${durationSec}s`;
      const raw = `[Scheduler] ${modeLabel} done. remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, remoteOk=${stats.remoteOk}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}${stats.error ? `, error=${stats.error}` : ""}`;
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level,
        summary,
        raw,
        simpleVisible: true,
      });
      return;
    }

    if (isNoNew) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `${modeLabel} done: no new videos, remote ${stats.remoteChecked}/${stats.remoteEligible}, missing ${stats.remoteMissingDetected}, ${durationSec}s`,
        raw: `[Scheduler] no new videos this cycle. mode=${modeLabel}, remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}`,
        simpleVisible: true,
      });
      return;
    }

    const level = stats.error ? "error" : "info";
    const summary = stats.error
      ? `${modeLabel} failed: ${stats.error}`
      : `${modeLabel} done: new ${stats.newItems}, queued ${stats.queuedItems}, requeued ${stats.requeuedFromRemoteMissing}, ${durationSec}s`;
    const raw = `[Scheduler] cycle done. mode=${modeLabel}, new=${stats.newItems}, queued=${stats.queuedItems}, remoteChecked=${stats.remoteChecked}/${stats.remoteEligible}, remoteOk=${stats.remoteOk}, missing=${stats.remoteMissingDetected}, missingUnavailable=${stats.remoteMissingUnavailable}, requeued=${stats.requeuedFromRemoteMissing}, remoteErrors=${stats.remoteErrors}, durationSec=${durationSec}${stats.error ? `, error=${stats.error}` : ""}`;
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level,
      summary,
      raw,
      simpleVisible: true,
    });
  }

}

interface SchedulerSnapshot {
  status: "idle" | "queued" | "running" | "cooldown";
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

interface SyncCycleStats {
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

type RemoteVerifyCandidate = VideoArchiveEntry & { relation: FavoriteRelation };

interface SharedUploadDirTracker {
  remaining: number;
  cleanupStarted: boolean;
  failedTargets: Set<string>;
  bvids: Set<string>;
}

interface RecoveryUploadItem {
  bvid: string;
  localDir: string;
  remotePath: string;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  videoTitle?: string;
  upperName?: string;
  cover?: string;
  files?: string[];
  partialBackup?: boolean;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  notBefore?: number;
  priority?: boolean;
}

interface RecoveryDownloadItem {
  user: BiliUser;
  mediaId: number;
  folderTitle: string;
  bvid: string;
}

interface DeferredQualityUpload {
  task: QualityUpgradeUploadReplaceTask;
  notBefore?: number;
}

interface LocalCacheSnapshot {
  limitBytes: number;
  usedBytes: number;
  reserveBytes: number;
  paused: boolean;
  checkedAt: number;
}

type SyncTrigger = "auto" | "manual" | "reconcile" | "remote_reconcile";

interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}
