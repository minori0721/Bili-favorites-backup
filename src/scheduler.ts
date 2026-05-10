import { ConfigStore } from "./config.js";
import { FavoriteRelation, StateManager, VideoArchiveEntry } from "./state.js";
import { BiliUser, UserStore } from "./users.js";
import { BiliRiskOrLoginError, listFavoriteItemsPage } from "./bili.js";
import { logManager } from "./logger.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { TaskQueue } from "./queue.js";
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
  private remoteVerifyNextAllowedAt = 0;

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;

    const config = this.configStore.get();
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1);
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2);

    const logTaskError = (task: any, error: any) => console.error(`[Queue] Task ${task.name} permanently failed:`, error);
    const logTaskRetry = (task: any, error: any) => console.warn(`[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}):`, error.message || error);

    this.downloadQueue.on("taskError", (task: DownloadTask, error: any) => {
      logTaskError(task, error);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "error",
        summary: `下载失败 ${task.bvid}: ${error?.message || error}${error?.permanent ? "（已停止自动重试）" : ""}`,
        raw: `[Queue] Task ${task.name} permanently failed: ${error?.message || error}`,
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
      targets.forEach((target, index) => {
        const uploadTask = new UploadTask(task.bvid, task.downloadDir!, target.remotePath, this.configStore.get(), {
          cleanupLocal: index === targets.length - 1,
        });
        uploadTask.userId = target.userId;
        uploadTask.mediaId = target.mediaId;
        uploadTask.folderTitle = target.folderTitle;
        uploadTask.onUploading = () => this.stateManager.markUploading(task.bvid, target.userId, target.mediaId);
        this.uploadQueue.addTask(uploadTask);
      });
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask) => {
      if (task.userId && task.mediaId) {
        this.queuedBackupKeys.delete(this.backupKey(task.userId, task.mediaId, task.bvid));
      }
      if (task.result) {
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
    });

    this.resumePersistedWork();
  }

  start() {
    const { pollIntervalMinutes } = this.configStore.get();
    this.stop();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    const startupJitter = 30_000 + Math.floor(Math.random() * 90_000);
    this.startupTimer = setTimeout(() => void this.tick(), startupJitter);
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
    if (this.running) {
      return false;
    }
    void this.tick(true, { trigger: "manual" });
    return true;
  }

  runReconcileNow() {
    console.log("[Scheduler] Manual reconcile triggered");
    if (this.running) {
      return false;
    }
    void this.tick(true, { trigger: "reconcile", forceFullRemoteVerify: true, forceFullFavoriteScan: true });
    return true;
  }

  runRemoteReconcileNow() {
    console.log("[Scheduler] Manual remote-only reconcile triggered");
    if (this.running) {
      return false;
    }
    void this.tick(true, {
      trigger: "remote_reconcile",
      forceFullRemoteVerify: true,
      skipFavoriteScan: true,
    });
    return true;
  }

  async tick(manual = false, options: TickOptions = {}) {
    if (this.running) {
      return false;
    }
    const trigger: SyncTrigger = options.trigger || (manual ? "manual" : "auto");
    this.running = true;
    this.cycleContext = this.createCycleStats(trigger);
    try {
      if (!options.skipFavoriteScan) {
        await this.runOnce(manual, options.forceFullFavoriteScan === true);
      }
      await this.verifyRemoteSamples(manual, options.forceFullRemoteVerify === true);
      this.logCycleSummary(this.cycleContext);
    } catch (error: any) {
      console.error("[Scheduler] Tick failed:", error?.message || error);
      this.cycleContext.error = error?.message || String(error);
      this.logCycleSummary(this.cycleContext);
    } finally {
      this.cycleContext = null;
      this.running = false;
    }
    return true;
  }

  private async runOnce(manual: boolean, forceFullFavoriteScan: boolean) {
    const users = this.userStore.list().filter((user) => user.enabled);
    for (const user of users) {
      const cooldown = this.stateManager.getUserCooldown(user.id);
      if (cooldown) {
        console.warn(`[Scheduler] User ${user.name} is cooling down until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
        continue;
      }

      for (const folder of user.favorites) {
        try {
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

  private async scanAllPages(user: BiliUser, mediaId: number, folderTitle: string) {
    let page = 1;
    while (true) {
      const result = await listFavoriteItemsPage(user.cookie, mediaId, page, 20);
      this.recordPage(user, mediaId, folderTitle, result.items);
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: "complete",
        nextHistoryPage: 1,
        catchupPage: 1,
        lastHotScanAt: new Date().toISOString(),
        lastHistoryScanAt: new Date().toISOString(),
        total: result.total,
      });
      if (!result.hasMore || result.items.length === 0) {
        break;
      }
      page += 1;
      await delay(1000 + Math.floor(Math.random() * 2000));
    }
  }

  private async scanHotPages(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean) {
    let consecutiveKnownPages = 0;
    let burstBudget = 0;
    const minPages = manual ? 10 : this.hotScanMinPages;
    const maxPages = manual ? 40 : this.hotScanMaxPages;
    let lastPage = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await listFavoriteItemsPage(user.cookie, mediaId, page, 20);
      const pageStats = this.recordPage(user, mediaId, folderTitle, result.items);
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
      const result = await listFavoriteItemsPage(user.cookie, mediaId, page, 20);
      this.recordPage(user, mediaId, folderTitle, result.items);

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
    items: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"]
  ) {
    let newItems = 0;
    for (const item of items) {
      const result = this.stateManager.recordFavoriteItem(user.id, mediaId, folderTitle, item);
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

  private enqueueIfNeeded(user: BiliUser, mediaId: number, folderTitle: string, bvid: string) {
    if (!user.enabled) {
      return false;
    }
    const key = this.backupKey(user.id, mediaId, bvid);
    if (this.queuedBackupKeys.has(key) || !this.stateManager.shouldEnqueueBackup(bvid, user.id, mediaId)) {
      return false;
    }
    const config = this.configStore.get();
    const remotePath = resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName: folderTitle,
    });
    if (this.stateManager.canBootstrapRelationFromGlobalProof(bvid, user.id, mediaId)) {
      this.stateManager.bootstrapRelationFromGlobalProof(bvid, user.id, mediaId, remotePath);
      return false;
    }
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
    task.targets = [target];
    task.onDownloading = () => this.stateManager.markDownloading(bvid, task.targets);
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir, task.targets);

    this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
    this.queuedBackupKeys.add(key);
    this.activeDownloadTargets.set(bvid, task.targets);
    this.downloadQueue.addTask(task);
    return true;
  }

  private async verifyRemoteSamples(manual: boolean, forceFullRemoteVerify: boolean) {
    if (!this.cycleContext) return;

    const config = this.configStore.get();
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
        await this.applyRemoteVerifyRateLimit(rateLimit);
        const jitter = 100 + Math.floor(Math.random() * 201);
        await delay(jitter);

        const relation = entry.relation;
        const resolvedRemotePath = relation.remotePath || entry.remotePath || this.deriveRemotePathFromRelation(entry, relation);
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
    const config = this.configStore.get();
    const names = await listRemoteDir(config, pathToUse);
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

  private async applyRemoteVerifyRateLimit(rateLimitPerSecond: number) {
    const intervalMs = Math.max(50, Math.floor(1000 / rateLimitPerSecond));
    const now = Date.now();
    if (this.remoteVerifyNextAllowedAt <= now) {
      this.remoteVerifyNextAllowedAt = now + intervalMs;
      return;
    }
    const waitMs = this.remoteVerifyNextAllowedAt - now;
    this.remoteVerifyNextAllowedAt += intervalMs;
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
    for (const item of this.stateManager.listBackupsToResume()) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
      const remotePath = relation?.remotePath || entry.remotePath;
      if ((relation?.backupStatus === "downloaded" || relation?.backupStatus === "uploading" || entry.backupStatus === "downloaded" || entry.backupStatus === "uploading") && entry.localDir && remotePath) {
        if (resolved?.user && !resolved.user.enabled) {
          continue;
        }
        const uploadTask = new UploadTask(entry.bvid, entry.localDir, remotePath, this.configStore.get());
        uploadTask.userId = resolved?.user.id || relation?.userId;
        uploadTask.mediaId = resolved?.mediaId || relation?.mediaId;
        uploadTask.folderTitle = resolved?.folderTitle || relation?.folderTitle;
        uploadTask.onUploading = () => this.stateManager.markUploading(entry.bvid, uploadTask.userId, uploadTask.mediaId);
        if (uploadTask.userId && uploadTask.mediaId) {
          this.queuedBackupKeys.add(this.backupKey(uploadTask.userId, uploadTask.mediaId, entry.bvid));
        }
        this.uploadQueue.addTask(uploadTask);
      } else {
        if (!resolved) continue;
        this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid);
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

type SyncTrigger = "auto" | "manual" | "reconcile" | "remote_reconcile";

interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}
