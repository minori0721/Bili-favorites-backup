import { ConfigStore } from "./config.js";
import { StateManager } from "./state.js";
import { UserStore, buildCookieString } from "./users.js";
import { listFavoriteItems } from "./bili.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithRclone, resolveRemotePath } from "./uploader.js";
import { delay } from "./utils.js";

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private configStore: ConfigStore;
  private userStore: UserStore;
  private stateManager: StateManager;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;
  }

  start() {
    const { pollIntervalMinutes } = this.configStore.get();
    this.stop();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    void this.tick();
  }

  updateInterval() {
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

    for (const user of users) {
      const cookieString = buildCookieString(user.cookie);
      for (const folder of user.favorites) {
        let items = [];
        try {
          items = await listFavoriteItems(cookieString, folder.mediaId, 1);
        } catch (error) {
          console.error("Failed to list favorites", error);
          continue;
        }

        const pending = items.filter((item) => !this.stateManager.isProcessed(user.id, item.bvid));
        for (const item of pending) {
          try {
            const download = await downloadWithBBDown(item.bvid, user.cookie);
            const remotePath = resolveRemotePath({
              destination: config.rcloneDestination,
              layout: config.uploadLayout,
              userName: user.name,
              folderName: folder.title,
            });
            await uploadWithRclone(download.downloadDir, remotePath);
            this.stateManager.markProcessed(user.id, item.bvid, folder.mediaId);
          } catch (error) {
            console.error(`Failed to process ${item.bvid}`, error);
          }

          if (config.perVideoDelaySeconds > 0) {
            await delay(config.perVideoDelaySeconds * 1000);
          }
        }
      }
    }
  }
}
