import { ConfigStore } from "./config.js";
import { StateManager } from "./state.js";
import { UserStore, buildCookieString } from "./users.js";
import { listFavoriteItems } from "./bili.js";
import { resolveRemotePath } from "./uploader.js";
import { delay } from "./utils.js";
import { TaskQueue } from "./queue.js";
import { DownloadTask, UploadTask } from "./tasks.js";

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private configStore: ConfigStore;
  private userStore: UserStore;
  private stateManager: StateManager;
  
  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;

    const config = this.configStore.get();
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1);
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2);

    const logTaskError = (task: any, error: any) => console.error(`[Queue] Task ${task.name} permanently failed:`, error);
    const logTaskRetry = (task: any, error: any) => console.warn(`[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}):`, error.message || error);
    
    this.downloadQueue.on("taskError", logTaskError);
    this.downloadQueue.on("taskRetry", logTaskRetry);
    this.uploadQueue.on("taskError", logTaskError);
    this.uploadQueue.on("taskRetry", logTaskRetry);

    this.downloadQueue.on("taskCompleted", (task: DownloadTask) => {
      if (!task.downloadDir) return;
      const t = task as any;
      const uploadTask = new UploadTask(task.bvid, task.downloadDir, t.remotePath, this.configStore.get());
      (uploadTask as any).userId = t.userId;
      (uploadTask as any).mediaId = t.mediaId;
      this.uploadQueue.addTask(uploadTask);
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask) => {
      const t = task as any;
      this.stateManager.markProcessed(t.userId, task.bvid, t.mediaId);
    });
  }

  start() {
    const { pollIntervalMinutes } = this.configStore.get();
    this.stop();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    void this.tick();
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
  }

  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  private async runOnce() {
    const config = this.configStore.get();
    const users = this.userStore.list().filter((user) => user.enabled);
    const existingDownloadTaskBvids = new Set(this.downloadQueue.getTasks().map(t => (t as DownloadTask).bvid));
    const existingUploadTaskBvids = new Set(this.uploadQueue.getTasks().map(t => (t as UploadTask).bvid));

    for (const user of users) {
      const cookieString = buildCookieString(user.cookie);
      for (const folder of user.favorites) {
        let items = [];
        try {
          // 获取最多 100 页（每页 20 个，约 2000 个视频），确保能同步完所有的收藏
          items = await listFavoriteItems(cookieString, folder.mediaId, 100);
        } catch (error) {
          console.error("Failed to list favorites", error);
          continue;
        }

        const pending = items.filter((item) => !this.stateManager.isProcessed(user.id, item.bvid) && !item.unavailable);
        for (const item of pending) {
          if (existingDownloadTaskBvids.has(item.bvid) || existingUploadTaskBvids.has(item.bvid)) {
            continue; // Already in queue
          }

          const remotePath = resolveRemotePath({
            destination: config.alistDest,
            layout: config.uploadLayout,
            userName: user.name,
            folderName: folder.title,
          });

          const task = new DownloadTask(item.bvid, user.cookie, config);
          (task as any).userId = user.id;
          (task as any).mediaId = folder.mediaId;
          (task as any).remotePath = remotePath;
          
          this.downloadQueue.addTask(task);
        }
      }
    }
  }
}
