import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ConfigStore, type AppConfig, type BBDownApiMode } from "./config.js";
import { FavoriteRelation, StateManager, VideoArchiveEntry } from "./state.js";
import { BiliUser, UserStore } from "./users.js";
import { BiliRiskOrLoginError, listFavoriteItemsPage, refreshUserAuth, resolveSelfVisibleFavoriteItem } from "./bili.js";
import { logManager } from "./logger.js";
import { tempDir } from "./paths.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { computeTaskRetryDelayMs, mapQueueBoardTask, type QueueBoardItem, TaskQueue } from "./queue.js";
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
import { DownloadApiHealth } from "./download-api-health.js";
import { PersistentJobStore, type PersistentJobKind } from "./job-store.js";
import {
  DownloadTask,
  QualityUpgradeCleanupTask,
  QualityUpgradeDownloadTask,
  QualityUpgradeReplaceTask,
  QualityUpgradeTask,
  QualityUpgradeUploadReplaceTask,
  UploadTarget,
  UploadTask,
  UploadVerificationTask,
} from "./tasks.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cooldownMs() {
  return (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
}

export function computeDownloadStartDelayMs(random: () => number = Math.random) {
  return 3_000 + Math.min(3_000, Math.floor(Math.max(0, random()) * 3_001));
}

const ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS = 6 * 60 * 60_000;
const UPLOAD_VERIFY_SCHEDULE_MS = [2_000, 10_000, 30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const UPLOAD_VERIFY_REUPLOAD_DELAY_MS = 30 * 60_000;

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;

function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask
    || task instanceof QualityUpgradeReplaceTask
    || task instanceof QualityUpgradeCleanupTask;
}

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
  private acceptingJobs = true;
  private configStore: ConfigStore;
  private userStore: UserStore;
  private stateManager: StateManager;

  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  private verificationQueue: TaskQueue;
  private readonly jobStore: PersistentJobStore;
  private readonly leaseOwner = crypto.randomUUID();
  private jobDispatchTimer: NodeJS.Timeout | null = null;
  private leaseHeartbeatTimer: NodeJS.Timeout | null = null;
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
  private uploadProbeTimer: NodeJS.Timeout | null = null;
  private readonly uploadCircuit = new UploadCircuitBreaker();
  private readonly downloadApiHealth = new DownloadApiHealth();
  private nextDownloadStartAt = 0;
  private downloadStartTimer: NodeJS.Timeout | null = null;
  private selfVisibleProbeCache = new Map<string, { expiresAt: number; item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number] }>();
  private schedulerProgress: SchedulerSnapshot | null = null;
  private nextAutoRunAt?: number;
  private lastSchedulerError = "";
  private localCacheSnapshot: LocalCacheSnapshot | null = null;
  private localCacheRefresh: Promise<LocalCacheSnapshot> | null = null;
  private readonly localCacheSnapshotTtlMs = 10_000;
  private readonly persistentJobWakeMinMs = 1_000;

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;
    this.jobStore = new PersistentJobStore(this.stateManager.getDatabase());

    const config = this.configStore.get();
    this.uploadCircuit.restore(this.stateManager.getUploadCooldown() as any);
    this.downloadApiHealth.configure(config.bbdownApiMode || "web");
    const persistedApiCooldown = typeof (this.stateManager as any).getDownloadApiCooldown === "function"
      ? this.stateManager.getDownloadApiCooldown()
      : null;
    this.downloadApiHealth.restore(persistedApiCooldown);
    if (config.bbdownApiMode === "app" && typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1, this.queueHighWater(config.concurrentDownloads, config.startupRecoveryBatchSize));
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2, this.queueHighWater(config.concurrentUploads, config.startupRecoveryBatchSize));
    this.verificationQueue = new TaskQueue(
      Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)),
      this.queueHighWater(config.remoteVerifyConcurrency || 3, config.startupRecoveryBatchSize)
    );
    this.downloadQueue.setStartGate((task) => {
      if (!(task instanceof DownloadTask) && !(task instanceof QualityUpgradeDownloadTask)) return false;
      return this.canStartDownloadTask(task);
    });
    this.uploadQueue.setStartGate((task) => this.uploadCircuit.allowUploadStart(this.uploadTaskKey(task)));
    this.verificationQueue.setStartGate((task) => this.uploadCircuit.allowUploadStart(`verify:${(task as any).bvid || task.id}`));
    this.refreshLocalCacheAndWake(true);

    const logTaskError = (task: any, error: any) => {
      const label = error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed";
      console.error(`[Queue] Task ${task.name} ${label}: ${sanitizeUploadText(error?.message || error)}`);
    };
    const logTaskRetry = (task: any, error: any) => console.warn(
      `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${sanitizeUploadText(error?.message || error)}`
    );

    this.downloadQueue.on("taskStart", (task: DownloadTask | QualityUpgradeDownloadTask) => {
      this.markDownloadTaskStarted();
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 30 * 60_000);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.qualityStage = "download";
        task.control.qualityStageLabel = "下载新版";
        this.syncQualityUpgradeControl(task, "running");
      }
    });
    this.uploadQueue.on("taskStart", (task: UploadTask | QualityUploadPhaseTask) => {
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 30 * 60_000);
      if (isQualityUploadPhaseTask(task)) {
        task.control.error = undefined;
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = task instanceof QualityUpgradeCleanupTask
          ? "清理旧文件备份"
          : (task instanceof QualityUpgradeReplaceTask ? "替换远端文件" : "上传新版到临时目录");
        this.syncQualityUpgradeControl(task, "running");
      }
    });

    this.downloadQueue.on("taskError", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      logTaskError(task, error);
      const apiRetryAt = this.handleDownloadApiFailure(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.error = error;
        if (task.persistentJobId) {
          this.jobStore.updatePayload(task.persistentJobId, this.serializeQualityUpgrade(task.control));
          if (error?.permanent) {
            this.jobStore.complete(task.persistentJobId, this.leaseOwner);
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
          } else if (apiRetryAt) {
            task.control.qualityStageLabel = "B站风控冷却后重试下载新版";
            this.syncQualityUpgradeControl(task, "retry_wait");
            this.jobStore.defer(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), apiRetryAt);
          } else {
            const job = task.persistentJob as any;
            const retryAt = Date.now() + computeTaskRetryDelayMs(this.configStore.get().retryDelaySeconds, Number(job?.attempts || 0), error?.retryAfterMs);
            const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), retryAt);
            this.syncQualityUpgradeControl(task, result.exhausted ? "error" : "retry_wait");
            if (result.exhausted) task.control.onFailed?.(task.control, error);
          }
          this.dispatchPersistentJobs();
          return;
        }
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
      const targets = this.collectUploadTargets(task.bvid, task.targets || this.makeSingleTarget(task));
      const session = task.downloadDir ? readDownloadSession(task.downloadDir) : null;
      if (task.downloadDir && session && !error?.permanent) {
        this.stateManager.markDownloadInterrupted(task.bvid, task.downloadDir, error.message || "Download failure", targets);
      } else {
        for (const target of targets) {
          this.stateManager.markRelationRetryPending(task.bvid, target.userId, target.mediaId, error.message || "Download failure");
          this.stateManager.markFailed(target.userId, task.bvid, target.mediaId, error.message || "Download failure", Boolean(error?.permanent));
        }
      }
      if (task.persistentJobId) {
        if (error?.permanent) {
          this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        } else if (apiRetryAt) {
          this.jobStore.defer(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), apiRetryAt);
        } else {
          const job = task.persistentJob as any;
          const retryIndex = Number(job?.attempts || 0);
          const retryAt = Date.now() + computeTaskRetryDelayMs(
            this.configStore.get().retryDelaySeconds,
            retryIndex,
            error?.retryAfterMs
          );
          const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), retryAt);
          if (result.exhausted) {
            for (const target of targets) {
              this.stateManager.markFailed(target.userId, task.bvid, target.mediaId, error.message || "Download failure", true);
            }
          }
        }
      }
      this.dispatchPersistentJobs();
    });
    this.downloadQueue.on("taskRetry", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      logTaskRetry(task, error);
      this.handleDownloadApiFailure(task, error);
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
    this.uploadQueue.on("taskError", (task: UploadTask | QualityUploadPhaseTask, error: any) => {
      logTaskError(task, error);
      const failure = this.recordUploadFailure(task, error);
      if (isQualityUploadPhaseTask(task)) {
        task.control.error = error;
        if (task.persistentJobId) {
          this.jobStore.updatePayload(task.persistentJobId, this.serializeQualityUpgrade(task.control));
          const retryAt = this.uploadCircuit.getRetryAt() || Date.now() + Math.max(60_000, failure.retryAfterMs || 0);
          const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
          this.syncQualityUpgradeControl(task, result.exhausted ? "error" : "retry_wait");
          task.control.qualityStageLabel = result.exhausted ? "画质重调失败" : "等待上传后端恢复";
          if (result.exhausted) task.control.onFailed?.(task.control, error);
          this.dispatchPersistentJobs();
          return;
        }
        this.syncQualityUpgradeControl(task, "error");
        task.control.onFailed?.(task.control, error);
        return;
      }
      const uploadHealth = this.uploadCircuit.getSnapshot();
      const isolatedDeterministicFailure = failure.category === "deterministic" && uploadHealth.state === "closed";
      if (task.persistentJobId) {
        const retryAt = uploadHealth.retryAt || Date.now() + (
          isolatedDeterministicFailure ? ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS : Math.max(60_000, failure.retryAfterMs || 0)
        );
        if (!task.historyOnly) {
          this.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, failure.summary);
        }
        const retry = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "error",
          summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}${retry.exhausted ? "（已达到重试上限）" : "（本地文件已保留）"}`,
          raw: this.formatUploadFailureLog(task, failure),
          bvid: task.bvid,
          simpleVisible: true,
        });
        this.dispatchPersistentJobs();
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}（本地文件已保留）`,
        raw: this.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
      if (!task.historyOnly) this.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, failure.summary);
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    });
    this.uploadQueue.on("taskRetry", (task: UploadTask | QualityUploadPhaseTask, error: any) => {
      logTaskRetry(task, error);
      const failure = this.recordUploadFailure(task, error);
      if (isQualityUploadPhaseTask(task)) {
        this.syncQualityUpgradeControl(task, "retry_wait");
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待重试上传替换";
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "warn",
        summary: `${isQualityUploadPhaseTask(task) ? "画质重调阶段失败" : "上传失败"}，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${failure.summary}`,
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
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        this.jobStore.enqueue({
          kind: "quality_upload",
          dedupeKey: `quality-upload:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`,
          bvid: task.bvid,
          userId: task.control.target.userId,
          mediaId: task.control.target.mediaId,
          priority: 30,
          maxAttempts: this.configStore.get().maxRetries + 1,
          payload: this.serializeQualityUpgrade(task.control),
        });
        this.dispatchPersistentJobs();
        return;
      }
      if (!task.downloadDir) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        return;
      }
      const targets = this.collectUploadTargets(task.bvid, task.targets || this.makeSingleTarget(task));
      const historyGroups = historySessionGroups(task.downloadDir);
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
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (targets.length === 0) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
      this.dispatchPersistentJobs();
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask | QualityUploadPhaseTask) => {
      const taskKey = this.uploadTaskKey(task);
      if (this.uploadCircuit.recordSuccess(taskKey)) {
        this.stateManager.clearUploadCooldown();
        this.clearUploadProbeTimer();
      }
      if (isQualityUploadPhaseTask(task)) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        if (task instanceof QualityUpgradeUploadReplaceTask) {
          this.jobStore.enqueue({ kind: "quality_replace", dedupeKey: `quality-replace:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 30, maxAttempts: this.configStore.get().maxRetries + 1, payload: this.serializeQualityUpgrade(task.control) });
          this.syncQualityUpgradeControl(task, "pending");
        } else if (task instanceof QualityUpgradeReplaceTask) {
          this.jobStore.enqueue({ kind: "quality_cleanup", dedupeKey: `quality-cleanup:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 60, maxAttempts: this.configStore.get().maxRetries + 1, payload: this.serializeQualityUpgrade(task.control) });
          this.syncQualityUpgradeControl(task, "pending");
        } else {
          this.syncQualityUpgradeControl(task, "completed");
          this.refreshLocalCacheState();
        }
        this.dispatchPersistentJobs();
        return;
      }
      if (task.historyOnly) {
        if (task.result?.files.length && task.historySnapshotAt && task.result.allVerified) {
          markHistoryGroupUploaded(task.downloadDir, task.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        } else if (task.result?.files.length) {
          this.enqueueUploadVerificationJobs(task, task.result.files);
        }
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        if (task.result?.allVerified) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
        this.dispatchPersistentJobs();
        return;
      }
      if (task.result?.files.length && task.result.allVerified) {
        this.stateManager.markVerifiedUpload(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId,
          task.partialBackup
        );
      } else if (task.result?.files.length) {
        this.stateManager.markUploadedPendingVerification(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId,
          task.partialBackup
        );
        this.enqueueUploadVerificationJobs(task, task.result.files);
      } else {
        this.stateManager.markUploadFailed(
          task.bvid,
          task.downloadDir,
          task.userId,
          task.mediaId,
          "Upload finished without verified remote metadata."
        );
      }
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (task.result?.files.length && task.result.allVerified) {
        void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
      }
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    });

    this.uploadQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
      this.downloadQueue.poke();
    });

    this.downloadQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
    });

    this.verificationQueue.on("taskStart", (task: UploadVerificationTask) => {
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 5 * 60_000);
    });
    this.verificationQueue.on("taskCompleted", (task: UploadVerificationTask) => {
      this.handleUploadVerificationCompleted(task);
    });
    this.verificationQueue.on("taskError", (task: UploadVerificationTask, error: any) => {
      this.handleUploadVerificationError(task, error);
    });
    this.verificationQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
    });

    if (this.uploadCircuit.getSnapshot().state !== "closed") this.scheduleUploadProbe();
    this.ensureLeaseHeartbeat();

  }

  private renewActiveLeases() {
    for (const queue of [this.downloadQueue, this.uploadQueue, this.verificationQueue]) {
      for (const task of queue.getTasks()) {
        if (task.status === "running" && task.persistentJobId) {
          this.jobStore.extendLease(task.persistentJobId, this.leaseOwner, 30 * 60_000);
        }
      }
    }
  }

  private ensureLeaseHeartbeat() {
    if (this.leaseHeartbeatTimer) return;
    this.leaseHeartbeatTimer = setInterval(() => this.renewActiveLeases(), 60_000);
    this.leaseHeartbeatTimer.unref?.();
  }

  private queueHighWater(concurrency = 1, batchSize = 25) {
    return Math.max(Math.max(1, concurrency) * 2, Math.max(5, batchSize));
  }

  private enqueueUploadVerificationJobs(task: UploadTask, files: Array<{
    path: string;
    size?: number;
    verificationStatus?: string;
    putCompletedAt?: string;
    localRelativePath?: string;
    nextVerifyAt?: string;
  }>) {
    for (const file of files) {
      if (file.verificationStatus !== "awaiting_verification" || typeof file.size !== "number") continue;
      const historySegment = task.historyOnly ? `history:${task.historySnapshotAt || "unknown"}` : "main";
      this.jobStore.enqueue({
        kind: "verify_upload",
        dedupeKey: `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${historySegment}:${file.path}`,
        bvid: task.bvid,
        userId: task.userId,
        mediaId: task.mediaId,
        priority: task.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now() + UPLOAD_VERIFY_SCHEDULE_MS[0],
        payload: {
          remoteFile: file.path,
          expectedSize: file.size,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          files: task.files || [],
          localRelativePath: file.localRelativePath,
          putCompletedAt: file.putCompletedAt || new Date().toISOString(),
          partialBackup: task.partialBackup,
          historyOnly: task.historyOnly,
          historySnapshotAt: task.historySnapshotAt,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
        },
      });
    }
    this.dispatchPersistentJobs();
  }

  private buildDownloadTask(job: any) {
    const bvid = String(job.bvid || "");
    const payload = job.payload || {};
    const config = this.configStore.get();
    const relations = this.stateManager.listRelationsForBvid(bvid)
      .filter((relation) => !["uploaded", "verified", "partial_verified", "downloaded", "uploading", "upload_failed"].includes(relation.backupStatus || ""))
      .map((relation) => ({ relation, resolved: this.resolveRelation(relation) }))
      .filter((item): item is { relation: FavoriteRelation; resolved: NonNullable<ReturnType<SyncScheduler["resolveRelation"]>> } => Boolean(item.resolved));
    if (relations.length === 0) return null;

    const primary = relations.find((item) => item.relation.userId === payload.primaryUserId) || relations[0];
    const targets: UploadTarget[] = relations.map(({ relation, resolved }) => ({
      userId: relation.userId,
      mediaId: relation.mediaId,
      folderTitle: resolved.folderTitle,
      remotePath: relation.remotePath || resolveRemotePath({
        destination: config.alistDest,
        layout: config.uploadLayout,
        userName: resolved.user.name,
        folderName: resolved.folderTitle,
      }),
    }));
    const task = new DownloadTask(bvid, {
      ...primary.resolved.user.cookie,
      accessToken: primary.resolved.user.accessToken || "",
    }, config);
    task.maxRetries = 0;
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.userId = primary.relation.userId;
    task.mediaId = primary.relation.mediaId;
    task.folderTitle = primary.resolved.folderTitle;
    task.remotePath = targets[0]?.remotePath;
    task.targets = targets;
    const meta = this.stateManager.getVideoMeta(bvid);
    task.videoTitle = meta?.title || bvid;
    task.upperName = meta?.upperName || "";
    task.cover = meta?.cover || "";
    task.onApiReady = (readyTask, mode) => this.handleDownloadApiReady(readyTask, mode);
    task.onDownloading = () => this.stateManager.markDownloading(bvid, targets);
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
      targets
    );
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir, targets);
    return task;
  }

  private serializeQualityUpgrade(task: QualityUpgradeTask) {
    return {
      bvid: task.bvid,
      userId: task.target.userId,
      mediaId: task.target.mediaId,
      videoTitle: task.videoTitle || task.bvid,
      folderTitle: task.folderTitle || task.target.folderTitle,
      target: task.target,
      runId: task.runId,
      downloadDir: task.downloadDir,
      outputFiles: task.outputFiles || [],
      uploadResult: task.uploadResult,
      backupFiles: task.backupFiles || [],
      finalFiles: task.finalFiles || [],
      stageRemotePath: task.stageRemotePath,
      backupRemotePath: task.backupRemotePath,
    };
  }

  private buildQualityUpgradeTask(job: any) {
    const payload = job.payload || {};
    const target = payload.target;
    const user = this.userStore.getById(String(payload.userId || job.userId || target?.userId || ""));
    if (!user || !user.enabled || !target) return null;
    const task = new QualityUpgradeTask(String(payload.bvid || job.bvid || ""), {
      ...user.cookie,
      accessToken: user.accessToken || "",
    }, this.configStore.get(), target);
    task.runId = payload.runId;
    task.downloadDir = payload.downloadDir;
    task.outputFiles = Array.isArray(payload.outputFiles) ? payload.outputFiles : [];
    task.uploadResult = payload.uploadResult;
    task.backupFiles = Array.isArray(payload.backupFiles) ? payload.backupFiles : [];
    task.finalFiles = Array.isArray(payload.finalFiles) ? payload.finalFiles : [];
    task.stageRemotePath = payload.stageRemotePath;
    task.backupRemotePath = payload.backupRemotePath;
    task.videoTitle = String(payload.videoTitle || task.bvid);
    task.folderTitle = String(payload.folderTitle || target.folderTitle || "");
    task.userId = target.userId;
    task.mediaId = target.mediaId;
    task.onStartUpgrade = () => {
      logManager.push({ timestamp: new Date().toISOString(), type: "download", level: "info", summary: `开始重调画质 ${task.bvid}: ${task.videoTitle}`, raw: `[QualityUpgrade] start ${target.userId}:${target.mediaId}:${task.bvid}`, bvid: task.bvid, simpleVisible: true });
    };
    task.onReplacing = (_task, stageRemotePath, backupRemotePath) => this.stateManager.markQualityUpgradeReplacing(task.bvid, target.userId, target.mediaId, {
      stageRemotePath,
      backupRemotePath,
      oldRemotePath: target.remotePath,
      oldFiles: target.oldFiles,
    });
    task.onBackupFileMoved = (_task, file) => this.stateManager.recordQualityUpgradeBackupFile(task.bvid, target.userId, target.mediaId, file);
    task.onFinalFileMoved = (_task, file) => this.stateManager.recordQualityUpgradeFinalFile(task.bvid, target.userId, target.mediaId, file);
    task.onUploaded = (_task, result) => this.stateManager.finalizeQualityUpgradeRemoteFiles(task.bvid, target.userId, target.mediaId, result.remotePath, result.files);
    task.onCompletedUpgrade = () => {
      this.stateManager.completeQualityUpgrade(task.bvid, target.userId, target.mediaId, target.remotePath, task.finalFiles || []);
      logManager.push({ timestamp: new Date().toISOString(), type: "upload", level: "info", summary: `重调画质完成 ${task.bvid}`, raw: `[QualityUpgrade] completed ${target.userId}:${target.mediaId}:${task.bvid}`, bvid: task.bvid, simpleVisible: true });
    };
    task.onFailed = (_task, error) => {
      const safeError = sanitizeUploadText(error?.message || error);
      logManager.push({ timestamp: new Date().toISOString(), type: task.qualityStage === "upload" ? "upload" : "download", level: "error", summary: `重调画质失败 ${task.bvid}: ${safeError}`, raw: `[QualityUpgrade] failed ${target.userId}:${target.mediaId}:${task.bvid}: ${safeError}`, bvid: task.bvid, simpleVisible: true, debugVisible: true });
    };
    return task;
  }

  private dispatchPersistentJobs() {
    if (!this.acceptingJobs) return;
    const config = this.configStore.get();
    const downloadCapacity = Math.max(0, this.queueHighWater(
      config.concurrentDownloads,
      config.startupRecoveryBatchSize
    ) - this.downloadQueue.getSize());
    if (downloadCapacity > 0 && this.canCreateDownloadTask()) {
      const jobs = this.jobStore.claimDue(["quality_download", "download"], downloadCapacity, this.leaseOwner, 30 * 60_000);
      for (const job of jobs) {
        const control = job.kind === "quality_download" ? this.buildQualityUpgradeTask(job) : null;
        const task = control ? new QualityUpgradeDownloadTask(control) : this.buildDownloadTask(job);
        if (!task) {
          this.jobStore.complete(job.id, this.leaseOwner);
          continue;
        }
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.downloadQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Download queue is full", Date.now() + 1_000);
          break;
        }
      }
    }

    const uploadCapacity = Math.max(0, this.queueHighWater(
      config.concurrentUploads,
      config.startupRecoveryBatchSize
    ) - this.uploadQueue.getSize());
    if (uploadCapacity > 0) {
      const jobs = this.jobStore.claimDue(["upload", "quality_upload", "quality_replace", "quality_cleanup", "history_upload"], uploadCapacity, this.leaseOwner, 30 * 60_000);
      for (const job of jobs) {
        if (["quality_upload", "quality_replace", "quality_cleanup"].includes(job.kind)) {
          const control = this.buildQualityUpgradeTask(job);
          if (!control) {
            this.jobStore.complete(job.id, this.leaseOwner);
            continue;
          }
          const task = job.kind === "quality_replace"
            ? new QualityUpgradeReplaceTask(control)
            : (job.kind === "quality_cleanup" ? new QualityUpgradeCleanupTask(control) : new QualityUpgradeUploadReplaceTask(control));
          task.maxRetries = 0;
          task.persistentJobId = job.id;
          task.persistentJob = job;
          if (!this.uploadQueue.addTask(task)) {
            this.jobStore.defer(job.id, this.leaseOwner, "Upload queue is full", Date.now() + 1_000);
            break;
          }
          continue;
        }
        const item = { ...(job.payload as unknown as RecoveryUploadItem) };
        if (job.kind === "upload" && !item.conflictArchiveSegment) {
          item.conflictArchiveSegment = this.historySnapshotSegment(new Date().toISOString());
          this.jobStore.updatePayload(job.id, item as unknown as Record<string, unknown>);
          job.payload = item as unknown as Record<string, unknown>;
        }
        const task = this.buildUploadTask(item);
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.uploadQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Upload queue is full", Date.now() + 1_000);
          break;
        }
      }
    }

    const capacity = Math.max(0, this.queueHighWater(
      config.remoteVerifyConcurrency,
      config.startupRecoveryBatchSize
    ) - this.verificationQueue.getSize());
    if (capacity > 0) {
      const jobs = this.jobStore.claimDue(["verify_upload"], capacity, this.leaseOwner, 5 * 60_000);
      for (const job of jobs) {
        const payload = job.payload as any;
        const task = new UploadVerificationTask(
          String(job.bvid || ""),
          String(job.userId || ""),
          Number(job.mediaId || 0),
          String(payload.remoteFile || ""),
          Number(payload.expectedSize || 0),
          config
        );
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.verificationQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Verification queue is full", Date.now() + 1_000);
          break;
        }
      }
    }
    this.schedulePersistentJobWake();
  }

  private schedulePersistentJobWake() {
    if (this.jobDispatchTimer) {
      clearTimeout(this.jobDispatchTimer);
      this.jobDispatchTimer = null;
    }
    const nextAt = this.jobStore.nextDueAt();
    if (nextAt === undefined) return;
    this.jobDispatchTimer = setTimeout(() => {
      this.jobDispatchTimer = null;
      this.dispatchPersistentJobs();
    }, Math.max(this.persistentJobWakeMinMs, nextAt - Date.now()));
    this.jobDispatchTimer.unref?.();
  }

  private handleUploadVerificationCompleted(task: UploadVerificationTask) {
    const job = task.persistentJob as any;
    if (!job || !task.persistentJobId || !task.result) return;
    const payload = job.payload as any;
    if (task.result.status === "verified") {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (this.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) this.stateManager.clearUploadCooldown();
      if (payload.historyOnly) {
        const prefix = `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:history:${payload.historySnapshotAt || "unknown"}:`;
        if (!this.jobStore.hasDedupePrefix(prefix) && payload.historySnapshotAt) {
          markHistoryGroupUploaded(String(payload.localDir || ""), payload.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
          void this.maybeCleanupVerifiedLocalDir(task.bvid, String(payload.localDir || ""));
        }
      } else {
        const relationVerified = this.stateManager.markUploadFileVerified(
          task.bvid,
          task.userId,
          task.mediaId,
          task.remoteFile
        );
        if (relationVerified) void this.maybeCleanupVerifiedLocalDir(task.bvid, String(payload.localDir || ""));
      }
      return;
    }

    if (task.result.status === "mismatch") {
      const reason = `远端文件大小冲突：预期 ${task.expectedSize}，实际 ${task.result.remoteSize ?? "未知"}`;
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (!payload.historyOnly) {
        this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
      }
      logManager.push({ timestamp: new Date().toISOString(), type: "upload", level: "error", summary: reason, raw: `[UploadVerify] mismatch ${task.remoteFile}`, bvid: task.bvid, simpleVisible: true });
      return;
    }

    this.deferMissingUploadVerification(task, job, payload);
  }

  private deferMissingUploadVerification(task: UploadVerificationTask, job: any, payload: any) {
    const putAt = Date.parse(String(payload.putCompletedAt || "")) || Date.now();
    const elapsed = Math.max(0, Date.now() - putAt);
    const nextDelay = UPLOAD_VERIFY_SCHEDULE_MS.find((delayMs) => delayMs > elapsed + 250);
    if (nextDelay !== undefined) {
      const nextAt = Math.max(Date.now() + 1_000, putAt + nextDelay);
      const reason = "远端暂不可见，等待下一次确认";
      this.jobStore.retry(task.persistentJobId, this.leaseOwner, reason, nextAt);
      if (!payload.historyOnly) {
        this.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, nextAt, reason);
      }
      this.schedulePersistentJobWake();
      return;
    }

    const reason = "PUT 已成功，但远端在 10 分钟内仍不可见";
    this.jobStore.complete(task.persistentJobId, this.leaseOwner);
    if (!payload.historyOnly) {
      this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
    }
    this.queueUploadWork({
      bvid: task.bvid,
      localDir: String(payload.localDir || ""),
      remotePath: String(payload.remotePath || ""),
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: String(payload.folderTitle || ""),
      videoTitle: String(payload.videoTitle || ""),
      upperName: String(payload.upperName || ""),
      cover: String(payload.cover || ""),
      files: Array.isArray(payload.files) ? payload.files : [],
      partialBackup: Boolean(payload.partialBackup),
      historyOnly: Boolean(payload.historyOnly),
      historySnapshotAt: payload.historySnapshotAt,
      notBefore: Date.now() + UPLOAD_VERIFY_REUPLOAD_DELAY_MS,
      priority: false,
    });
  }

  private handleUploadVerificationError(task: UploadVerificationTask, error: any) {
    const job = task.persistentJob as any;
    if (!job || !task.persistentJobId) return;
    const failure = classifyUploadError(error, task.remoteFile);
    this.uploadCircuit.recordFailure(`verify:${task.bvid}`, failure);
    if (this.uploadCircuit.getSnapshot().state !== "closed") {
      this.stateManager.setUploadCooldown(this.uploadCircuit.getSnapshot() as any);
    }
    const delayMs = failure.retryAfterMs || 60_000;
    const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, Date.now() + delayMs);
    if (result.exhausted) {
      this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, failure.summary);
    }
    this.scheduleUploadProbe();
    this.schedulePersistentJobWake();
  }

  private async maybeCleanupVerifiedLocalDir(bvid: string, localDir: string) {
    if (!localDir || this.jobStore.hasJobsForBvid(bvid, ["upload", "verify_upload", "history_upload"])) return;
    const relations = this.stateManager.listRelationsForBvid(bvid);
    if (relations.some((relation) => !["verified", "partial_verified"].includes(relation.backupStatus || ""))) return;
    const pendingHistory = historySessionGroups(localDir).some((group) =>
      group.files.some((file) => relations.some((relation) => !(file.uploadedTargets || []).includes(`${relation.userId}:${relation.mediaId}`)))
    );
    if (pendingHistory) return;
    await this.cleanupSharedUploadDir(localDir, new Set([bvid]));
  }

  private uploadTaskKey(task: any) {
    return `${task?.userId || "quality"}:${task?.mediaId || 0}:${task?.bvid || task?.id || "upload"}:${task?.historyOnly ? task?.remotePath || "history" : "main"}`;
  }

  private recordUploadFailure(task: UploadTask | QualityUploadPhaseTask, error: any) {
    const failure: UploadFailureInfo = error?.uploadFailure || classifyUploadError(error, task.remotePath || "<remote>");
    this.uploadCircuit.recordFailure(this.uploadTaskKey(task), failure);
    if (this.uploadCircuit.getSnapshot().state !== "closed") {
      this.stateManager.setUploadCooldown(this.uploadCircuit.getSnapshot() as any);
    }
    this.scheduleUploadProbe();
    this.downloadQueue.poke();
    return failure;
  }

  private formatUploadFailureLog(task: UploadTask | QualityUploadPhaseTask, failure: UploadFailureInfo) {
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
      this.dispatchPersistentJobs();
      this.uploadQueue.poke();
    }, Math.max(0, retryAt - Date.now()));
    this.uploadProbeTimer.unref?.();
  }

  private downloadTaskIdentity(task: DownloadTask | QualityUpgradeDownloadTask) {
    const cookie = task instanceof QualityUpgradeDownloadTask ? task.control.cookie : task.cookie;
    return {
      bvid: task.bvid,
      userId: String(task.userId || ""),
      hasAppToken: Boolean(cookie?.accessToken),
    };
  }

  private persistDownloadApiHealth(value: ReturnType<DownloadApiHealth["open"]>) {
    if (value && typeof (this.stateManager as any).setDownloadApiCooldown === "function") {
      this.stateManager.setDownloadApiCooldown(value);
    } else if (!value && typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
  }

  private handleDownloadApiFailure(task: DownloadTask | QualityUpgradeDownloadTask, error: any) {
    const identity = this.downloadTaskIdentity(task);
    let persisted = null;
    if (error?.biliRiskControl && error?.apiMode === "web") {
      persisted = this.downloadApiHealth.open(identity);
    } else if (task.apiProbe || (task instanceof QualityUpgradeDownloadTask && task.control.apiProbe)) {
      persisted = this.downloadApiHealth.probeFailed(identity, error?.message || "风控探测失败", Boolean(error?.permanent));
    } else {
      return undefined;
    }
    this.persistDownloadApiHealth(persisted);
    const retryAt = this.downloadApiHealth.getRetryAt();
    this.downloadQueue.poke();
    return retryAt;
  }

  private handleDownloadApiReady(task: DownloadTask | QualityUpgradeTask, _mode: BBDownApiMode) {
    const identity = {
      bvid: task.bvid,
      userId: String(task.userId || task.target?.userId || ""),
    };
    if (!this.downloadApiHealth.ready(identity)) return;
    if (typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
    this.dispatchPersistentJobs();
    this.downloadQueue.poke();
  }

  private markDownloadTaskStarted() {
    this.nextDownloadStartAt = Date.now() + computeDownloadStartDelayMs();
  }

  private scheduleDownloadStartPoke() {
    if (this.downloadStartTimer) return;
    const delayMs = Math.max(0, this.nextDownloadStartAt - Date.now());
    this.downloadStartTimer = setTimeout(() => {
      this.downloadStartTimer = null;
      this.downloadQueue.poke();
    }, delayMs);
    this.downloadStartTimer.unref?.();
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
      conflictArchiveSegment: item.conflictArchiveSegment,
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
      uploadTask.onRemoteConflictArchived = (_task, archive) => {
        this.stateManager.markRemoteConflictArchived(item.bvid, item.userId, item.mediaId, archive);
      };
    }
    return uploadTask;
  }

  private queueUploadWork(item: RecoveryUploadItem) {
    const persistedItem: RecoveryUploadItem = item.historyOnly || item.conflictArchiveSegment
      ? { ...item }
      : { ...item, conflictArchiveSegment: this.historySnapshotSegment(new Date().toISOString()) };
    const key = this.recoveryUploadKey(persistedItem);
    this.jobStore.enqueue({
      kind: persistedItem.historyOnly ? "history_upload" : "upload",
      dedupeKey: `upload:${key}`,
      bvid: persistedItem.bvid,
      userId: persistedItem.userId,
      mediaId: persistedItem.mediaId,
      priority: persistedItem.priority === false ? 80 : 20,
      maxAttempts: this.configStore.get().maxRetries + 1,
      notBefore: persistedItem.notBefore || 0,
      payload: { ...persistedItem },
    });
    this.dispatchPersistentJobs();
    return true;
  }

  resumePersistedWorkOnStartup() {
    this.jobStore.recoverExpiredLeases();
    this.resumePersistedWork();
    this.dispatchPersistentJobs();
  }

  start() {
    this.stopPollingTimers();
    this.acceptingJobs = true;
    const { pollIntervalMinutes } = this.configStore.get();
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
    this.dispatchPersistentJobs();
  }

  applyConfigUpdate(previous: AppConfig, next: AppConfig) {
    this.downloadApiHealth.configure(next.bbdownApiMode || "web");
    if (next.bbdownApiMode === "app") {
      if (typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
        this.stateManager.clearDownloadApiCooldown();
      }
    }
    for (const task of this.downloadQueue.getTasks()) {
      if (task.status === "running") continue;
      if (task instanceof DownloadTask) {
        task.config = { ...next };
      } else if (task instanceof QualityUpgradeDownloadTask) {
        task.control.config = { ...next };
      }
      task.apiModeOverride = undefined;
      task.apiProbe = false;
    }
    if (previous.bbdownApiMode !== next.bbdownApiMode) this.downloadQueue.poke();
    this.updateInterval();
  }

  updateInterval() {
    const config = this.configStore.get();
    this.downloadQueue.setConcurrency(config.concurrentDownloads || 1);
    this.uploadQueue.setConcurrency(config.concurrentUploads || 2);
    this.verificationQueue.setConcurrency(Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)));
    this.downloadQueue.setMaxSize(this.queueHighWater(config.concurrentDownloads, config.startupRecoveryBatchSize));
    this.uploadQueue.setMaxSize(this.queueHighWater(config.concurrentUploads, config.startupRecoveryBatchSize));
    this.verificationQueue.setMaxSize(this.queueHighWater(config.remoteVerifyConcurrency, config.startupRecoveryBatchSize));
    this.refreshLocalCacheAndWake(true);
    this.dispatchPersistentJobs();
    if (process.env.NODE_ENV !== "test") {
      this.start();
    }
  }

  stop() {
    this.acceptingJobs = false;
    this.stopPollingTimers();
    if (this.jobDispatchTimer) {
      clearTimeout(this.jobDispatchTimer);
      this.jobDispatchTimer = null;
    }
    if (this.downloadStartTimer) {
      clearTimeout(this.downloadStartTimer);
      this.downloadStartTimer = null;
    }
  }

  private stopPollingTimers() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  beginShutdown() {
    this.acceptingJobs = false;
    this.stop();
    this.ensureLeaseHeartbeat();
  }

  async shutdown(timeoutMs = 20_000) {
    this.beginShutdown();
    const startedAt = Date.now();
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
    await this.downloadQueue.waitForIdle(remaining());
    await this.uploadQueue.waitForIdle(remaining());
    await this.verificationQueue.waitForIdle(remaining());
    this.jobStore.releaseOwner(this.leaseOwner);
    this.stateManager.close();
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
    return this.downloadQueue.isBusy() || this.uploadQueue.isBusy() || this.verificationQueue.isBusy();
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
    this.refreshLocalCacheAndWake(true);
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
    task.onApiReady = (control, mode) => this.handleDownloadApiReady(control, mode);
    const dedupeKey = `quality-download:${task.target.userId}:${task.target.mediaId}:${task.bvid}`;
    if (this.jobStore.findByDedupeKey(dedupeKey)
      || this.jobStore.findByDedupeKey(`quality-upload:${task.target.userId}:${task.target.mediaId}:${task.bvid}`)) return false;
    this.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey,
      bvid: task.bvid,
      userId: task.target.userId,
      mediaId: task.target.mediaId,
      priority: 35,
      maxAttempts: this.configStore.get().maxRetries + 1,
      payload: this.serializeQualityUpgrade(task),
    });
    this.dispatchPersistentJobs();
    return true;
  }

  reloadStateDatabase() {
    this.jobStore.rebind(this.stateManager.getDatabase());
    this.resumePersistedWorkOnStartup();
  }

  hasQualityUpgrade(userId: string, mediaId: number, bvid: string) {
    return Boolean(
      this.jobStore.findByDedupeKey(`quality-download:${userId}:${mediaId}:${bvid}`)
      || this.jobStore.findByDedupeKey(`quality-upload:${userId}:${mediaId}:${bvid}`)
      || this.jobStore.findByDedupeKey(`quality-replace:${userId}:${mediaId}:${bvid}`)
      || this.jobStore.findByDedupeKey(`quality-cleanup:${userId}:${mediaId}:${bvid}`)
    );
  }

  getQualityUpgradeState() {
    const running = this.jobStore.list(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"], 100).map((job) => {
      const payload = job.payload as any;
      return {
        key: `${job.userId || payload.userId}:${job.mediaId || payload.mediaId}:${job.bvid || payload.bvid}`,
        id: job.id,
        bvid: job.bvid || payload.bvid,
        title: payload.videoTitle || job.bvid,
        folderTitle: payload.folderTitle || payload.target?.folderTitle || "",
        userId: job.userId || payload.userId || "",
        mediaId: job.mediaId || payload.mediaId || 0,
        status: job.status === "retry_wait" ? "retry_wait" : (["leased", "running"].includes(job.status) ? "running" : "pending"),
        error: job.lastError,
        queuedAt: job.createdAt,
        startedAt: ["leased", "running"].includes(job.status) ? job.updatedAt : undefined,
      };
    });
    return { running, completed: [] as any[] };
  }

  private syncQualityUpgradeControl(
    phaseTask: QualityUpgradeDownloadTask | QualityUploadPhaseTask,
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

  private refreshLocalCacheAndWake(force = false) {
    void this.refreshLocalCacheSnapshot(force).then(() => {
      if (!this.acceptingJobs) return;
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    }).catch((error: any) => {
      console.warn(`[Scheduler] Failed to refresh local cache state: ${error?.message || error}`);
    });
  }

  private getLocalCacheSnapshot() {
    const limitBytes = this.getLocalCacheLimitBytes();
    if (!this.localCacheSnapshot || this.localCacheSnapshot.limitBytes !== limitBytes) {
      this.refreshLocalCacheAndWake(true);
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
      this.refreshLocalCacheAndWake();
    }
    return this.localCacheSnapshot;
  }

  private canStartDownloadTask(task?: DownloadTask | QualityUpgradeDownloadTask) {
    const snapshot = this.getLocalCacheSnapshot();
    const baseAllowed = !snapshot.paused
      && !this.uploadCircuit.isDownloadPaused()
      && this.uploadQueue.getSize() === 0
      && this.jobStore.countDue(["upload", "history_upload"], 20) === 0
      && this.uploadQueue.canAccept();
    if (!baseAllowed) return false;
    if (!task) return this.downloadApiHealth.getSnapshot().state === "healthy";
    if (Date.now() < this.nextDownloadStartAt) {
      this.scheduleDownloadStartPoke();
      return false;
    }
    const decision = this.downloadApiHealth.claimStart(this.downloadTaskIdentity(task));
    if (!decision.allowed) {
      const retryAt = this.downloadApiHealth.getRetryAt();
      return false;
    }
    task.apiModeOverride = decision.apiModeOverride;
    task.apiProbe = decision.probe;
    if (task instanceof QualityUpgradeDownloadTask) {
      task.control.apiModeOverride = decision.apiModeOverride;
      task.control.apiProbe = decision.probe;
    }
    return true;
  }

  private canCreateDownloadTask() {
    const snapshot = this.getLocalCacheSnapshot();
    return !snapshot.paused
      && !this.uploadCircuit.isDownloadPaused()
      && this.uploadQueue.getSize() === 0
      && this.jobStore.countDue(["upload", "history_upload"], 20) === 0
      && this.uploadQueue.canAccept()
      && this.downloadQueue.canAccept();
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
    for (const job of this.jobStore.listForBoard(["verify_upload"], 100)) {
      if (["leased", "running"].includes(job.status)) continue;
      const payload = job.payload as any;
      uploadPending.push(mapQueueBoardTask({
        id: job.id,
        bvid: job.bvid,
        userId: job.userId,
        mediaId: job.mediaId,
        videoTitle: payload.videoTitle || job.bvid,
        folderTitle: payload.folderTitle || "",
        remotePath: payload.remotePath || payload.remoteFile || "",
        detail: "已上传，等待远端确认",
        retries: job.attempts,
        maxRetries: job.maxAttempts,
        retryAt: job.notBefore,
        queuedAt: job.createdAt,
      }, "upload_pending"));
    }

    const bySequence = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.sequence || 0) - Number(b.sequence || 0);
    const byStartedAt = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.startedAt || 0) - Number(b.startedAt || 0);
    downloadPending.sort(bySequence);
    uploadPending.sort(bySequence);
    downloadRunning.sort(byStartedAt);
    uploadRunning.sort(byStartedAt);

    const persistentCounts = this.jobStore.counts();
    const sumKinds = (kinds: PersistentJobKind[]) => kinds.reduce((total, kind) =>
      total + Object.values(persistentCounts[kind] || {}).reduce((sum, count) => sum + Number(count || 0), 0), 0);
    const leasedJobs = Object.values(persistentCounts).reduce((total, statuses) =>
      total + Number(statuses.leased || 0) + Number(statuses.running || 0), 0);
    const retryJobs = Object.values(persistentCounts).reduce((total, statuses) => total + Number(statuses.retry_wait || 0), 0);

    return {
      generatedAt: Date.now(),
      downloadPending,
      downloadRunning,
      uploadPending,
      uploadRunning,
      scheduler: this.buildSchedulerSnapshot(),
      localCache: this.getLocalCacheSnapshot(),
      uploadHealth: this.uploadCircuit.getSnapshot(),
      downloadApiHealth: this.downloadApiHealth.getSnapshot(),
      downloadRecovery: inspectDownloadRecoverySync(tempDir),
      recovery: {
        pendingUploads: sumKinds(["upload", "history_upload"]),
        pendingDownloads: sumKinds(["download"]),
        pendingVerifications: sumKinds(["verify_upload"]),
        leasedJobs,
        retryJobs,
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
      this.refreshLocalCacheAndWake(true);
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

  private collectUploadTargets(bvid: string, fallback: UploadTarget[] = []) {
    const config = this.configStore.get();
    const targets = new Map<string, UploadTarget>();
    for (const target of fallback) targets.set(`${target.userId}:${target.mediaId}`, target);
    for (const relation of this.stateManager.listRelationsForBvid(bvid)) {
      if (["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
      const resolved = this.resolveRelation(relation);
      if (!resolved) continue;
      targets.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: resolved.folderTitle,
        remotePath: relation.remotePath || resolveRemotePath({
          destination: config.alistDest,
          layout: config.uploadLayout,
          userName: resolved.user.name,
          folderName: resolved.folderTitle,
        }),
      });
    }
    return [...targets.values()];
  }

  private enqueueIfNeeded(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    bvid: string,
    options: { persisted?: boolean; notBefore?: number } = {}
  ) {
    if (!user.enabled) {
      return false;
    }
    if (!options.persisted && !this.stateManager.shouldEnqueueBackup(bvid, user.id, mediaId, this.cycleContext?.startedAt)) {
      return false;
    }
    const config = this.configStore.get();
    const remotePath = resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName: folderTitle,
    });
    this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
    const local = this.stateManager.getCompletedLocalDownload(bvid);
    if (local) {
      const meta = this.stateManager.getVideoMeta(bvid);
      this.queueUploadWork({
        bvid,
        localDir: local.localDir,
        remotePath,
        userId: user.id,
        mediaId,
        folderTitle,
        videoTitle: meta?.title || bvid,
        upperName: meta?.upperName || "",
        cover: meta?.cover || "",
        files: local.files,
        partialBackup: local.partialBackup,
        priority: true,
      });
      for (const history of historySessionGroups(local.localDir)) {
        this.queueUploadWork({
          bvid,
          localDir: local.localDir,
          remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
          userId: user.id,
          mediaId,
          folderTitle,
          videoTitle: meta?.title || bvid,
          upperName: meta?.upperName || "",
          cover: meta?.cover || "",
          files: history.files.map((file) => file.relativePath),
          historyOnly: true,
          historySnapshotAt: history.snapshotAt,
          priority: false,
        });
      }
      return true;
    }
    this.jobStore.enqueue({
      kind: "download",
      dedupeKey: `download:${bvid}`,
      bvid,
      priority: 40,
      maxAttempts: config.maxRetries + 1,
      notBefore: options.notBefore || 0,
      payload: { primaryUserId: user.id, primaryMediaId: mediaId, primaryFolderTitle: folderTitle },
    });
    this.dispatchPersistentJobs();
    return true;
  }

  private requeueRetryPendingBeforeScan() {
    const users = this.userStore.list().filter((user) => user.enabled);
    let remaining = Math.max(1, this.configStore.get().remoteRequeueLimitPerCycle || 20);
    this.stateManager.runBatch(() => {
      for (const user of users) {
        for (const folder of user.favorites) {
          if (remaining <= 0) return;
          const bvids = this.stateManager.listRetryCandidatesForFolder(user.id, folder.mediaId, remaining);
          for (const bvid of bvids) {
            if (remaining <= 0) return;
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
        if (this.jobStore.hasJobsForBvid(relation.bvid)) continue;
        const resolved = this.resolveRelation(relation);
        if (!resolved) continue;

        const localDir = item.video.localDir;
        if (localDir && fs.existsSync(localDir)) {
          const manifest = readDownloadSession(localDir);
          const uploadReady = Boolean(manifest && (manifest.status === "complete" || manifest.status === "partial"));
          if (!uploadReady) {
            this.stateManager.markDownloadInterrupted(relation.bvid, localDir, "Stale download session queued for resume.", [{ userId: relation.userId, mediaId: relation.mediaId }]);
            this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid, { persisted: true });
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
      this.stateManager.markDownloadInterrupted(
        entry.name,
        localDir,
        "Legacy local cache queued for safe recovery.",
        [{ userId: resolved.user.id, mediaId: resolved.mediaId }]
      );
      this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.name, { persisted: true });
    }
  }

  private resumePersistedWork() {
    this.queueLegacyDownloadDirsForRecovery();
    if (this.stateManager.hasPersistentJobBootstrap()) {
      this.recoverOrphanedUploadFailures();
      return;
    }
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
          this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
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
        this.queueUploadWork(uploadItem);
        const historyTargetKey = `${resolved.user.id}:${resolved.mediaId}`;
        const historyGroups = historySessionGroups(localDir)
          .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
          .filter((group) => group.files.length > 0);
        for (const history of historyGroups) {
          this.queueUploadWork({
            ...uploadItem,
            remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
            priority: false,
          });
        }
        continue;
      }
      this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
    }

    for (const pending of this.stateManager.listPendingUploadVerifications(10_000)) {
      const relation = this.stateManager.getRelationStatus(pending.userId, pending.mediaId, pending.bvid);
      const resolved = relation ? this.resolveRelation(relation) : null;
      const manifest = pending.localDir ? readDownloadSession(pending.localDir) : null;
      for (const file of pending.files) {
        if (typeof file.size !== "number") continue;
        this.jobStore.enqueue({
          kind: "verify_upload",
          dedupeKey: `verify:${pending.userId}:${pending.mediaId}:${pending.bvid}:main:${file.path}`,
          bvid: pending.bvid,
          userId: pending.userId,
          mediaId: pending.mediaId,
          priority: 10,
          maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
          notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now(),
          payload: {
            remoteFile: file.path,
            expectedSize: file.size,
            localDir: pending.localDir || "",
            remotePath: pending.remotePath,
            files: manifest?.outputs.map((output) => output.relativePath) || [],
            partialBackup: Boolean(pending.partialBackup),
            localRelativePath: file.localRelativePath,
            putCompletedAt: file.putCompletedAt || new Date().toISOString(),
            folderTitle: resolved?.folderTitle || "",
            videoTitle: this.stateManager.getVideoMeta(pending.bvid)?.title || pending.bvid,
          },
        });
      }
    }
    this.stateManager.markPersistentJobBootstrapComplete();
    const counts = this.jobStore.counts();
    const totalKind = (kind: PersistentJobKind) => Object.values(counts[kind] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "info",
      summary: `启动恢复已写入持久化队列：待补传 ${totalKind("upload") + totalKind("history_upload")}，待下载 ${totalKind("download")}，待确认 ${totalKind("verify_upload")}`,
      raw: `[Recovery] sqlite jobs uploads=${totalKind("upload") + totalKind("history_upload")} downloads=${totalKind("download")} verify=${totalKind("verify_upload")}`,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  private recoverOrphanedUploadFailures() {
    const limit = Math.max(5, Math.min(100, Math.floor(this.configStore.get().startupRecoveryBatchSize || 25)));
    let recovered = 0;
    for (const item of this.stateManager.listBackupsToResume()) {
      if (recovered >= limit) break;
      const status = item.relation?.backupStatus || item.video.backupStatus;
      if (status !== "upload_failed" || !item.relation) continue;
      const localDir = item.video.localDir;
      if (!localDir || !fs.existsSync(localDir)) continue;
      const manifest = readDownloadSession(localDir);
      if (!manifest || !["complete", "partial"].includes(manifest.status)) continue;
      const resolved = this.resolveRelation(item.relation);
      if (!resolved) continue;
      const remotePath = item.relation.remotePath || item.video.remotePath || resolveRemotePath({
        destination: this.configStore.get().alistDest,
        layout: this.configStore.get().uploadLayout,
        userName: resolved.user.name,
        folderName: resolved.folderTitle,
      });
      const uploadItem: RecoveryUploadItem = {
        bvid: item.video.bvid,
        localDir,
        remotePath,
        userId: item.relation.userId,
        mediaId: item.relation.mediaId,
        folderTitle: resolved.folderTitle,
        videoTitle: item.video.title,
        upperName: item.video.upperName,
        cover: item.video.cover,
        files: manifest.outputs.map((output) => output.relativePath),
        partialBackup: manifest.status === "partial",
        priority: true,
      };
      const existing = this.jobStore.findByDedupeKey(`upload:${this.recoveryUploadKey(uploadItem)}`);
      if (existing && ["pending", "retry_wait", "leased", "running"].includes(existing.status)) continue;
      this.queueUploadWork(uploadItem);
      recovered += 1;
    }
    if (recovered > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `启动时找回 ${recovered} 个缺少可运行任务的待补传记录`,
        raw: `[Recovery] restored orphaned upload jobs=${recovered}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
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
  conflictArchiveSegment?: string;
  notBefore?: number;
  priority?: boolean;
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
