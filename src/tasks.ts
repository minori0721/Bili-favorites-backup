import { Task } from "./queue.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithAList, UploadResult } from "./uploader.js";
import { AppConfig } from "./config.js";
import { BiliCookie } from "./users.js";

export interface UploadTarget {
  userId: string;
  mediaId: number;
  folderTitle: string;
  remotePath: string;
}

export class DownloadTask extends Task {
  bvid: string;
  cookie: BiliCookie;
  config: AppConfig;
  downloadDir?: string;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  remotePath?: string;
  targets?: UploadTarget[];
  onDownloading?: (task: DownloadTask) => void;
  onDownloaded?: (task: DownloadTask, downloadDir: string) => void;

  constructor(bvid: string, cookie: BiliCookie, config: AppConfig) {
    super(`Download ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.cookie = cookie;
    this.config = config;
  }

  async run() {
    console.log(`[Task] Starting download for ${this.bvid}`);
    this.onDownloading?.(this);
    const result = await downloadWithBBDown(this.bvid, this.cookie, this.config);
    this.downloadDir = result.downloadDir;
    this.onDownloaded?.(this, result.downloadDir);
    console.log(`[Task] Completed download for ${this.bvid}`);
  }
}

export class UploadTask extends Task {
  bvid: string;
  downloadDir: string;
  remotePath: string;
  config: AppConfig;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  result?: UploadResult;
  onUploading?: (task: UploadTask) => void;
  cleanupLocal: boolean;

  constructor(
    bvid: string,
    downloadDir: string,
    remotePath: string,
    config: AppConfig,
    options: { cleanupLocal?: boolean } = {}
  ) {
    super(`Upload ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.downloadDir = downloadDir;
    this.remotePath = remotePath;
    this.config = config;
    this.cleanupLocal = options.cleanupLocal !== false;
  }

  async run() {
    console.log(`[Task] Starting upload for ${this.bvid} to ${this.remotePath}`);
    this.onUploading?.(this);
    this.result = await uploadWithAList(this.downloadDir, this.remotePath, this.config, {
      cleanupLocal: this.cleanupLocal,
    });
    console.log(`[Task] Completed upload for ${this.bvid}`);
  }
}
