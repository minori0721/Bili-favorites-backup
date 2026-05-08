import { Task } from "./queue.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithAList } from "./uploader.js";
import { AppConfig } from "./config.js";
import { BiliCookie } from "./users.js";

export class DownloadTask extends Task {
  bvid: string;
  cookie: BiliCookie;
  config: AppConfig;
  downloadDir?: string;

  constructor(bvid: string, cookie: BiliCookie, config: AppConfig) {
    super(`Download ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.cookie = cookie;
    this.config = config;
  }

  async run() {
    console.log(`[Task] Starting download for ${this.bvid}`);
    const result = await downloadWithBBDown(this.bvid, this.cookie, this.config);
    this.downloadDir = result.downloadDir;
    console.log(`[Task] Completed download for ${this.bvid}`);
  }
}

export class UploadTask extends Task {
  bvid: string;
  downloadDir: string;
  remotePath: string;
  config: AppConfig;

  constructor(bvid: string, downloadDir: string, remotePath: string, config: AppConfig) {
    super(`Upload ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.downloadDir = downloadDir;
    this.remotePath = remotePath;
    this.config = config;
  }

  async run() {
    console.log(`[Task] Starting upload for ${this.bvid} to ${this.remotePath}`);
    await uploadWithAList(this.downloadDir, this.remotePath, this.config);
    console.log(`[Task] Completed upload for ${this.bvid}`);
  }
}
