import { ConfigStore } from "./config.js";
import { StateManager, VideoArchiveEntry } from "./state.js";
import { BiliUser, UserStore } from "./users.js";
import { BiliRiskOrLoginError, listFavoriteItemsPage } from "./bili.js";
import { resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { TaskQueue } from "./queue.js";
import { DownloadTask, UploadTask } from "./tasks.js";

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
  private queuedBackupBvids = new Set<string>();
  private readonly hotScanMinPages = 3;
  private readonly hotScanMaxPages = 12;
  private readonly hotScanBurstBudget = 3;
  private readonly historyPagesPerTick = 2;
  private readonly remoteVerifyPerTick = 25;

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
      this.queuedBackupBvids.delete(task.bvid);
      this.stateManager.markRetryPending(task.bvid);
      if (task.userId && task.mediaId) {
        this.stateManager.markFailed(task.userId, task.bvid, task.mediaId, error.message || "Download failure", Boolean(error?.permanent));
      }
    });
    this.downloadQueue.on("taskRetry", logTaskRetry);
    this.uploadQueue.on("taskError", (task: UploadTask, error: any) => {
      logTaskError(task, error);
      this.queuedBackupBvids.delete(task.bvid);
      this.stateManager.markRetryPending(task.bvid);
      if (task.userId && task.mediaId) {
        this.stateManager.markFailed(task.userId, task.bvid, task.mediaId, error.message || "Upload failure", false);
      }
    });
    this.uploadQueue.on("taskRetry", logTaskRetry);

    this.downloadQueue.on("taskCompleted", (task: DownloadTask) => {
      if (!task.downloadDir || !task.remotePath) return;
      const uploadTask = new UploadTask(task.bvid, task.downloadDir, task.remotePath, this.configStore.get());
      uploadTask.userId = task.userId;
      uploadTask.mediaId = task.mediaId;
      uploadTask.onUploading = () => this.stateManager.markUploading(task.bvid);
      this.uploadQueue.addTask(uploadTask);
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask) => {
      this.queuedBackupBvids.delete(task.bvid);
      if (task.result) {
        this.stateManager.markVerifiedUpload(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId
        );
      } else if (task.userId && task.mediaId) {
        this.stateManager.markProcessed(task.userId, task.bvid, task.mediaId);
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
    void this.tick(true);
  }

  async tick(manual = false) {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.verifyRemoteSamples();
      await this.runOnce(manual);
    } catch (error: any) {
      console.error("[Scheduler] Tick failed:", error?.message || error);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(manual: boolean) {
    const users = this.userStore.list().filter((user) => user.enabled);
    for (const user of users) {
      const cooldown = this.stateManager.getUserCooldown(user.id);
      if (cooldown) {
        console.warn(`[Scheduler] User ${user.name} is cooling down until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
        continue;
      }

      for (const folder of user.favorites) {
        try {
          const hotLastPage = await this.scanHotPages(user, folder.mediaId, folder.title, manual);
          await this.scanHistoryPages(user, folder.mediaId, folder.title, manual, hotLastPage);
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
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: "initializing",
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
    const pagesThisRun = inCatchupMode ? 1 : (manual ? this.historyPagesPerTick * 3 : this.historyPagesPerTick);

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
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: totalPages ? (inCatchupMode ? "complete" : "initializing") : "initializing",
        nextHistoryPage: inCatchupMode ? (scan.nextHistoryPage || 1) : page,
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
      }
      this.enqueueIfNeeded(user, mediaId, folderTitle, item.bvid);
    }
    return { newItems };
  }

  private enqueueIfNeeded(user: BiliUser, mediaId: number, folderTitle: string, bvid: string) {
    if (!user.enabled) {
      return;
    }
    if (this.queuedBackupBvids.has(bvid) || !this.stateManager.shouldEnqueueBackup(bvid)) {
      return;
    }
    const config = this.configStore.get();
    const remotePath = resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName: folderTitle,
    });

    const task = new DownloadTask(bvid, user.cookie, config);
    task.userId = user.id;
    task.mediaId = mediaId;
    task.remotePath = remotePath;
    task.onDownloading = () => this.stateManager.markDownloading(bvid);
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir);

    this.stateManager.markQueued(bvid, remotePath);
    this.queuedBackupBvids.add(bvid);
    this.downloadQueue.addTask(task);
  }

  private async verifyRemoteSamples() {
    const config = this.configStore.get();
    const candidates = this.stateManager.listVideosForRemoteVerify(this.remoteVerifyPerTick);
    for (const entry of candidates) {
      if (!entry.remoteFiles?.length) continue;
      try {
        const result = await verifyRemoteFiles(config, entry.remoteFiles);
        if (result.ok) {
          this.stateManager.markRemoteCheckOk(entry.bvid);
        } else {
          this.stateManager.markRemoteCheckMissing(entry.bvid, result.missing);
          this.enqueueMissingIfPossible(entry);
        }
      } catch (error: any) {
        console.warn(`[Scheduler] Remote verify failed for ${entry.bvid}:`, error?.message || error);
      }
    }
  }

  private enqueueMissingIfPossible(entry: VideoArchiveEntry) {
    if (entry.biliStatus === "unavailable") return;
    const relations = this.stateManager.listRelationsForBvid(entry.bvid);
    for (const relation of relations) {
      const user = this.userStore.getById(relation.userId);
      if (!user || !user.enabled) continue;
      const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
      this.enqueueIfNeeded(
        user,
        folder?.mediaId ?? relation.mediaId,
        folder?.title ?? relation.folderTitle,
        entry.bvid
      );
      return;
    }
  }

  private resumePersistedWork() {
    for (const entry of this.stateManager.listBackupsToResume()) {
      const relation = this.findBestRelationForBvid(entry.bvid);
      if ((entry.backupStatus === "downloaded" || entry.backupStatus === "uploading") && entry.localDir && entry.remotePath) {
        if (relation?.user && !relation.user.enabled) {
          continue;
        }
        const uploadTask = new UploadTask(entry.bvid, entry.localDir, entry.remotePath, this.configStore.get());
        uploadTask.userId = relation?.user.id;
        uploadTask.mediaId = relation?.mediaId;
        uploadTask.onUploading = () => this.stateManager.markUploading(entry.bvid);
        this.queuedBackupBvids.add(entry.bvid);
        this.uploadQueue.addTask(uploadTask);
      } else {
        if (!relation) continue;
        this.enqueueIfNeeded(relation.user, relation.mediaId, relation.folderTitle, entry.bvid);
      }
    }
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
}
