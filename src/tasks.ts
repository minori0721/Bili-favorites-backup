import path from "node:path";
import { Task } from "./queue.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithAList, UploadResult, deleteRemoteFiles, moveRemoteFile, verifyRemoteFiles } from "./uploader.js";
import { AppConfig } from "./config.js";
import { BiliCookie } from "./users.js";
import { RemoteFileRecord } from "./state.js";
import { tempDir } from "./paths.js";
import { joinRemotePath } from "./utils.js";

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
  videoTitle?: string;
  upperName?: string;
  cover?: string;
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

export interface QualityUpgradeTarget {
  userId: string;
  mediaId: number;
  folderTitle: string;
  remotePath: string;
  oldFiles: RemoteFileRecord[];
}

export class QualityUpgradeTask extends Task {
  bvid: string;
  cookie: BiliCookie;
  config: AppConfig;
  target: QualityUpgradeTarget;
  downloadDir?: string;
  uploadResult?: UploadResult;
  deleteResult?: Awaited<ReturnType<typeof deleteRemoteFiles>>;
  finalFiles?: RemoteFileRecord[];
  backupFiles?: RemoteFileRecord[];
  qualityStage?: "download" | "upload";
  qualityStageLabel?: string;
  onStartUpgrade?: (task: QualityUpgradeTask) => void;
  onReplacing?: (task: QualityUpgradeTask, stageRemotePath: string, backupRemotePath: string) => void;
  onBackupFileMoved?: (task: QualityUpgradeTask, file: RemoteFileRecord) => void;
  onFinalFileMoved?: (task: QualityUpgradeTask, file: RemoteFileRecord) => void;
  onUploaded?: (task: QualityUpgradeTask, result: UploadResult) => void;
  onCompletedUpgrade?: (task: QualityUpgradeTask) => void;

  constructor(bvid: string, cookie: BiliCookie, config: AppConfig, target: QualityUpgradeTarget) {
    super(`Quality upgrade ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.cookie = cookie;
    this.config = config;
    this.target = target;
  }

  async run() {
    console.log(`[Task] Starting quality upgrade for ${this.bvid}`);
    this.qualityStage = "download";
    this.qualityStageLabel = "下载新版";
    this.onStartUpgrade?.(this);
    const runId = `${Date.now()}-${this.id}`;
    const result = await downloadWithBBDown(this.bvid, this.cookie, this.config, {
      downloadDir: path.join(tempDir, `quality-upgrade-${runId}-${this.bvid}`),
    });
    this.downloadDir = result.downloadDir;
    this.qualityStage = "upload";
    this.qualityStageLabel = "上传新版到临时目录";
    const targetRemotePath = this.target.remotePath;
    const stageRemotePath = joinRemotePath(targetRemotePath, `.quality-upgrade-${runId}`);
    this.uploadResult = await uploadWithAList(result.downloadDir, stageRemotePath, this.config, {
      cleanupLocal: true,
    });
    this.qualityStageLabel = "验证临时新版文件";
    const stagedVerifyResult = await verifyRemoteFiles(this.config, this.uploadResult.files);
    if (!stagedVerifyResult.ok) {
      throw new Error(`New upgraded files missing after staged upload: ${stagedVerifyResult.missing.join(", ")}`);
    }
    const plannedFinalFiles = this.uploadResult.files.map((file) => ({
      ...file,
      path: joinRemotePath(targetRemotePath, file.name),
    }));
    const plannedFinalPaths = new Set<string>();
    for (const file of plannedFinalFiles) {
      if (plannedFinalPaths.has(file.path)) {
        throw new Error(`Duplicate upgraded file target: ${file.path}`);
      }
      plannedFinalPaths.add(file.path);
    }
    const backupRemotePath = joinRemotePath(targetRemotePath, `.quality-upgrade-backup-${runId}`);
    this.backupFiles = [];
    this.finalFiles = [];
    this.onReplacing?.(this, stageRemotePath, backupRemotePath);
    try {
      this.qualityStageLabel = "备份旧远端文件";
      for (const oldFile of this.target.oldFiles) {
        const backupFile = {
          ...oldFile,
          path: joinRemotePath(backupRemotePath, oldFile.name),
        };
        await moveRemoteFile(this.config, oldFile.path, backupFile.path);
        this.backupFiles.push(backupFile);
        this.onBackupFileMoved?.(this, backupFile);
      }
      this.qualityStageLabel = "移动新版到正式目录";
      for (let i = 0; i < this.uploadResult.files.length; i += 1) {
        const stagedFile = this.uploadResult.files[i];
        const finalFile = plannedFinalFiles[i];
        await moveRemoteFile(this.config, stagedFile.path, finalFile.path);
        this.finalFiles.push(finalFile);
        this.onFinalFileMoved?.(this, finalFile);
      }
      this.qualityStageLabel = "验证正式目录新版文件";
      const finalVerifyResult = await verifyRemoteFiles(this.config, this.finalFiles);
      if (!finalVerifyResult.ok) {
        throw new Error(`Moved upgraded files missing after final rename: ${finalVerifyResult.missing.join(", ")}`);
      }
    } catch (error) {
      for (const finalFile of this.finalFiles.reverse()) {
        const stagedFile = this.uploadResult.files.find((file) => file.name === finalFile.name);
        if (stagedFile) {
          try {
            await moveRemoteFile(this.config, finalFile.path, stagedFile.path);
          } catch (rollbackError) {
            console.warn(`[Task] Failed to roll back upgraded file ${finalFile.path}`, rollbackError);
          }
        }
      }
      for (let i = this.backupFiles.length - 1; i >= 0; i -= 1) {
        const backupFile = this.backupFiles[i];
        const oldFile = this.target.oldFiles[i];
        if (oldFile) {
          try {
            await moveRemoteFile(this.config, backupFile.path, oldFile.path);
          } catch (rollbackError) {
            console.warn(`[Task] Failed to restore backup file ${backupFile.path}`, rollbackError);
          }
        }
      }
      throw error;
    }
    const finalResult = { remotePath: targetRemotePath, files: this.finalFiles };
    this.uploadResult = finalResult;
    this.qualityStageLabel = "写入新版远端状态";
    this.onUploaded?.(this, finalResult);
    this.qualityStageLabel = "清理旧文件备份";
    this.deleteResult = await deleteRemoteFiles(this.config, this.backupFiles);
    this.qualityStageLabel = "画质重调完成";
    this.onCompletedUpgrade?.(this);
    console.log(`[Task] Completed quality upgrade for ${this.bvid}`);
  }
}

export class UploadTask extends Task {
  bvid: string;
  downloadDir: string;
  remotePath: string;
  config: AppConfig;
  videoTitle?: string;
  upperName?: string;
  cover?: string;
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
