import fs from "node:fs";
import { ConfigStore } from "./config.js";
import { FavoriteRelation, StateManager, VideoArchiveEntry } from "./state.js";
import { BiliUser, UserStore } from "./users.js";
import { BiliRiskOrLoginError, listFavoriteItemsPage, refreshUserAuth } from "./bili.js";
import { logManager } from "./logger.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { mapQueueBoardTask, type QueueBoardItem, TaskQueue } from "./queue.js";
import { DownloadTask, UploadTarget, UploadTask } from "./tasks.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cooldownMs() {
  return (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
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
  private sharedUploadDirs = new Map<string, SharedUploadDirTracker>();
  private schedulerProgress: SchedulerSnapshot | null = null;
  private nextAutoRunAt?: number;
  private lastSchedulerError = "";

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;

    const config = this.configStore.get();
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1);
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2);

    const logTaskError = (task: any, error: any) => {
      const label = error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed";
      console.error(`[Queue] Task ${task.name} ${label}:`, error);
    };
    const logTaskRetry = (task: any, error: any) => console.warn(`[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}):`, error.message || error);

    this.downloadQueue.on("taskError", (task: DownloadTask, error: any) => {
      logTaskError(task, error);
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
      for (const target of targets) {
        this.queuedBackupKeys.delete(this.backupKey(target.userId, target.mediaId, task.bvid));
        this.stateManager.markRelationRetryPending(task.bvid, target.userId, target.mediaId, error.message || "Download failure");
        this.stateManager.markFailed(target.userId, task.bvid, target.mediaId, error.message || "Download failure", Boolean(error?.permanent));
      }
      this.activeDownloadTargets.delete(task.bvid);
    });
    this.downloadQueue.on("taskRetry", (task: DownloadTask, error: any) => {
      logTaskRetry(task, error);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `下载失败，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        raw: `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
    });
    this.uploadQueue.on("taskError", (task: UploadTask, error: any) => {
      logTaskError(task, error);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: `上传失败 ${task.bvid}: ${error?.message || error}`,
        raw: `[Queue] Task ${task.name} permanently failed: ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
      if (task.userId && task.mediaId) {
        this.queuedBackupKeys.delete(this.backupKey(task.userId, task.mediaId, task.bvid));
        this.stateManager.markRelationRetryPending(task.bvid, task.userId, task.mediaId, error.message || "Upload failure");
      }
      if (task.userId && task.mediaId) {
        this.stateManager.markFailed(task.userId, task.bvid, task.mediaId, error.message || "Upload failure", false);
      }
      void this.completeSharedUploadTask(task);
    });
    this.uploadQueue.on("taskRetry", (task: UploadTask, error: any) => {
      logTaskRetry(task, error);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "warn",
        summary: `上传失败，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        raw: `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
    });

    this.downloadQueue.on("taskCompleted", (task: DownloadTask) => {
      if (!task.downloadDir) return;
      const targets = task.targets || this.activeDownloadTargets.get(task.bvid) || this.makeSingleTarget(task);
      this.activeDownloadTargets.delete(task.bvid);
      const tracker = this.createSharedUploadDirTracker(task.downloadDir, targets.length);
      targets.forEach((target) => {
        const uploadTask = new UploadTask(task.bvid, task.downloadDir!, target.remotePath, this.configStore.get(), {
          cleanupLocal: false,
        });
        uploadTask.sharedDownloadDir = task.downloadDir;
        uploadTask.userId = target.userId;
        uploadTask.mediaId = target.mediaId;
        uploadTask.folderTitle = target.folderTitle;
        uploadTask.videoTitle = task.videoTitle || "";
        uploadTask.upperName = task.upperName || "";
        uploadTask.cover = task.cover || "";
        uploadTask.onUploading = () => this.stateManager.markUploading(task.bvid, target.userId, target.mediaId);
        this.uploadQueue.addTask(uploadTask);
      });
      if (tracker.remaining === 0) {
        void this.cleanupSharedUploadDir(task.downloadDir);
      }
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask) => {
      if (task.userId && task.mediaId) {
        this.queuedBackupKeys.delete(this.backupKey(task.userId, task.mediaId, task.bvid));
      }
      if (task.result?.files.length) {
        this.stateManager.markVerifiedUpload(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId
        );
      } else {
        if (task.userId && task.mediaId) {
          this.stateManager.markRelationRetryPending(
            task.bvid,
            task.userId,
            task.mediaId,
            "Upload finished without remote metadata; task moved back to discovered for retry."
          );
          this.stateManager.markFailed(
            task.userId,
            task.bvid,
            task.mediaId,
            "Upload finished without remote metadata; task moved back to discovered for retry.",
            false
          );
        }
      }
      void this.completeSharedUploadTask(task);
    });

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
    this.start();
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
    return this.downloadQueue.isBusy() || this.uploadQueue.isBusy();
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
    };
  }

  async tick(manual = false, options: TickOptions = {}) {
    if (this.running) {
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

  private createSharedUploadDirTracker(downloadDir: string, uploadCount: number) {
    const normalizedCount = Math.max(0, uploadCount);
    const existing = this.sharedUploadDirs.get(downloadDir);
    if (existing) {
      existing.remaining += normalizedCount;
      return existing;
    }
    const tracker: SharedUploadDirTracker = {
      remaining: normalizedCount,
      cleanupStarted: false,
    };
    this.sharedUploadDirs.set(downloadDir, tracker);
    return tracker;
  }

  private async completeSharedUploadTask(task: UploadTask) {
    const downloadDir = task.sharedDownloadDir || "";
    if (!downloadDir) return;
    const tracker = this.sharedUploadDirs.get(downloadDir);
    if (!tracker) return;
    tracker.remaining = Math.max(0, tracker.remaining - 1);
    if (tracker.remaining > 0 || tracker.cleanupStarted) return;
    tracker.cleanupStarted = true;
    this.sharedUploadDirs.delete(downloadDir);
    await this.cleanupSharedUploadDir(downloadDir);
  }

  private async cleanupSharedUploadDir(downloadDir: string) {
    try {
      await fs.promises.rm(downloadDir, { recursive: true, force: true });
    } catch (error: any) {
      console.warn(`[Scheduler] Failed to cleanup ${downloadDir}:`, error?.message || error);
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
      this.recordPage(user, mediaId, folderTitle, result.items, page, 20, scanStartedAt, seenBvids);
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
      const pageStats = this.recordPage(user, mediaId, folderTitle, result.items, page, 20);
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
      this.recordPage(user, mediaId, folderTitle, result.items, page, 20);

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

  private recordPage(
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
    items.forEach((item, indexInPage) => {
      seenBvids?.add(item.bvid);
      const favOrder = (Math.max(1, page) - 1) * Math.max(1, pageSize) + indexInPage + 1;
      const result = this.stateManager.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
        favOrder,
        favPage: page,
        favIndexInPage: indexInPage,
      }, seenAt);
      if (!result.wasKnown) {
        newItems += 1;
        this.cycleContext!.newItems += 1;
      }
      const queued = this.enqueueIfNeeded(user, mediaId, folderTitle, item.bvid);
      if (queued) {
        this.cycleContext!.queuedItems += 1;
      }
    });
    return { newItems };
  }

  private enqueueIfNeeded(user: BiliUser, mediaId: number, folderTitle: string, bvid: string) {
    if (!user.enabled) {
      return false;
    }
    const key = this.backupKey(user.id, mediaId, bvid);
    if (this.queuedBackupKeys.has(key) || !this.stateManager.shouldEnqueueBackup(bvid, user.id, mediaId, this.cycleContext?.startedAt)) {
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
      this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
      this.queuedBackupKeys.add(key);
      return true;
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
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir, task.targets);

    this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
    this.queuedBackupKeys.add(key);
    this.activeDownloadTargets.set(bvid, task.targets);
    this.downloadQueue.addTask(task);
    return true;
  }

  private requeueRetryPendingBeforeScan() {
    const users = this.userStore.list().filter((user) => user.enabled);
    for (const user of users) {
      for (const folder of user.favorites) {
        const bvids = this.stateManager.listRetryCandidatesForFolder(user.id, folder.mediaId, 1000);
        for (const bvid of bvids) {
          const queued = this.enqueueIfNeeded(user, folder.mediaId, folder.title, bvid);
          if (queued) {
            this.cycleContext!.queuedItems += 1;
          }
        }
      }
    }
  }

  private triggerOrQueueTick(options: TickOptions) {
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
    const concurrency = Math.max(1, Math.min(10, Math.floor(config.remoteVerifyConcurrency || 3)));
    const requeueLimit = Math.max(1, Math.floor(config.remoteRequeueLimitPerCycle || 20));
    const rateLimit = Math.max(0.5, Number(config.remoteVerifyRateLimitPerSecond || 2));
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
    for (const item of items) {
      const relation = item.relation;
      const key = this.backupKey(relation.userId, relation.mediaId, relation.bvid);
      if (this.queuedBackupKeys.has(key)) {
        continue;
      }
      const resolved = this.resolveRelation(relation);
      if (!resolved) {
        continue;
      }
      this.stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Active backup state became stale and was re-queued.");
      const queued = this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid);
      if (queued && this.cycleContext) {
        this.cycleContext.queuedItems += 1;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: queued ? "warn" : "error",
        summary: queued ? `已恢复卡住的备份任务 ${relation.bvid}` : `备份任务恢复失败 ${relation.bvid}`,
        raw: `[Recovery] stale active backup ${relation.userId}/${relation.mediaId}/${relation.bvid} queued=${queued}`,
        bvid: relation.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
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

  private resumePersistedWork() {
    const uploadItems = this.stateManager.listBackupsToResume();
    const uploadCountsByDir = new Map<string, number>();
    for (const item of uploadItems) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
      const remotePath = relation?.remotePath || entry.remotePath;
      const status = relation?.backupStatus || entry.backupStatus;
      const hasLocalDir = Boolean(entry.localDir && fs.existsSync(entry.localDir));
      const shouldUpload = (status === "downloaded" || status === "uploading") && hasLocalDir && remotePath;
      if (shouldUpload && (!relation || resolved)) {
        uploadCountsByDir.set(entry.localDir!, (uploadCountsByDir.get(entry.localDir!) || 0) + 1);
      }
    }
    for (const [downloadDir, count] of uploadCountsByDir) {
      this.createSharedUploadDirTracker(downloadDir, count);
    }

    for (const item of uploadItems) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
      const remotePath = relation?.remotePath || entry.remotePath;
      const status = relation?.backupStatus || entry.backupStatus;
      const localDir = entry.localDir;
      const hasLocalDir = Boolean(localDir && fs.existsSync(localDir));
      if ((status === "downloaded" || status === "uploading") && hasLocalDir && localDir && remotePath) {
        if (relation && !resolved) {
          continue;
        }
        const uploadTask = new UploadTask(entry.bvid, localDir, remotePath, this.configStore.get(), {
          cleanupLocal: false,
        });
        uploadTask.sharedDownloadDir = localDir;
        uploadTask.userId = resolved?.user.id || relation?.userId;
        uploadTask.mediaId = resolved?.mediaId || relation?.mediaId;
        uploadTask.folderTitle = resolved?.folderTitle || relation?.folderTitle;
        uploadTask.onUploading = () => this.stateManager.markUploading(entry.bvid, uploadTask.userId, uploadTask.mediaId);
        if (uploadTask.userId && uploadTask.mediaId) {
          this.queuedBackupKeys.add(this.backupKey(uploadTask.userId, uploadTask.mediaId, entry.bvid));
        }
        this.uploadQueue.addTask(uploadTask);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: "info",
          summary: `恢复上传任务 ${entry.bvid}`,
          raw: `[Recovery] resume upload ${entry.bvid} from ${entry.localDir} to ${remotePath}`,
          bvid: entry.bvid,
          debugVisible: true,
        });
      } else {
        if (!resolved) continue;
        if (relation) {
          this.stateManager.resetRelationForRetry(entry.bvid, relation.userId, relation.mediaId, "Persisted active backup state was restored after restart.");
        } else {
          this.stateManager.markRetryPending(entry.bvid);
        }
        const queued = this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: queued ? "warn" : "error",
          summary: queued ? `恢复下载任务 ${entry.bvid}` : `下载任务恢复失败 ${entry.bvid}`,
          raw: `[Recovery] resume download ${entry.bvid} status=${status} queued=${queued}`,
          bvid: entry.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
      }
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

interface SharedUploadDirTracker {
  remaining: number;
  cleanupStarted: boolean;
}

type SyncTrigger = "auto" | "manual" | "reconcile" | "remote_reconcile";

interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}
