import { ConfigStore } from "./config.js";
import { StateManager } from "./state.js";
import { UserStore } from "./users.js";
import { listFavoriteItems } from "./bili.js";
import { resolveRemotePath } from "./uploader.js";
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
    
    this.downloadQueue.on("taskError", (task: DownloadTask, error: any) => {
      logTaskError(task, error);
      if (error?.permanent && task.userId && task.mediaId) {
        this.stateManager.markFailed(task.userId, task.bvid, task.mediaId, error.message || "Permanent download failure", true);
      }
    });
    this.downloadQueue.on("taskRetry", logTaskRetry);
    this.uploadQueue.on("taskError", logTaskError);
    this.uploadQueue.on("taskRetry", logTaskRetry);

    this.downloadQueue.on("taskCompleted", (task: DownloadTask) => {
      if (!task.downloadDir || !task.remotePath) return;
      const uploadTask = new UploadTask(task.bvid, task.downloadDir, task.remotePath, this.configStore.get());
      uploadTask.userId = task.userId;
      uploadTask.mediaId = task.mediaId;
      this.uploadQueue.addTask(uploadTask);
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask) => {
      if (task.userId && task.mediaId) {
        this.stateManager.markProcessed(task.userId, task.bvid, task.mediaId);
      }
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

  runNow() {
    console.log("[Scheduler] Manual sync triggered");
    void this.tick();
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
      for (const folder of user.favorites) {
        let items: Awaited<ReturnType<typeof listFavoriteItems>> = [];
        try {
          items = await listFavoriteItems(user.cookie, folder.mediaId);
        } catch (error) {
          console.error("Failed to list favorites", error);
          continue;
        }

        const pending = items.filter((item) =>
          !this.stateManager.isProcessed(user.id, item.bvid) &&
          !this.stateManager.isFailed(user.id, item.bvid) &&
          !item.unavailable
        );
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
          task.userId = user.id;
          task.mediaId = folder.mediaId;
          task.remotePath = remotePath;
          
          this.downloadQueue.addTask(task);
          existingDownloadTaskBvids.add(item.bvid);
        }
      }
    }
  }
}
