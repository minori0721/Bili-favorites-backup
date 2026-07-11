import path from "node:path";
import { Task } from "./queue.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithAList, UploadResult, deleteRemoteFiles, inspectRemoteFileSize, moveRemoteFile, verifyRemoteFiles } from "./uploader.js";
import { AppConfig, type BBDownApiMode } from "./config.js";
import { BiliCookie } from "./users.js";
import { RemoteFileRecord } from "./state.js";
import { tempDir } from "./paths.js";
import { joinRemotePath } from "./utils.js";
import { cleanupUploadedSessionFiles, type DownloadSessionManifest } from "./download-session.js";
import { sanitizeUploadText } from "./upload-health.js";

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
  outputFiles: string[] = [];
  partialBackup = false;
  recoveredPages = 0;
  totalPages = 0;
  apiModeOverride?: BBDownApiMode;
  apiProbe = false;
  onApiReady?: (task: DownloadTask, mode: BBDownApiMode) => void;
  onDownloading?: (task: DownloadTask) => void;
  onPrepared?: (task: DownloadTask, downloadDir: string, manifest: DownloadSessionManifest) => void;
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
    const result = await downloadWithBBDown(this.bvid, this.cookie, this.config, {
      onPrepared: (downloadDir, manifest) => {
        this.downloadDir = downloadDir;
        this.recoveredPages = manifest.outputs.length;
        this.totalPages = manifest.pages.length;
        this.detail = manifest.outputs.length > 0
          ? `续传：已完成 ${manifest.outputs.length}/${manifest.pages.length} 分P`
          : `准备下载 0/${manifest.pages.length} 分P`;
        this.onPrepared?.(this, downloadDir, manifest);
      },
      apiModeOverride: this.apiModeOverride,
      onApiReady: (mode) => this.onApiReady?.(this, mode),
    });
    this.downloadDir = result.downloadDir;
    this.outputFiles = result.files;
    this.partialBackup = result.partial;
    this.recoveredPages = result.recoveredPages;
    this.totalPages = result.totalPages;
    this.detail = `已完成 ${result.files.length}/${result.totalPages} 分P`;
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
  runId?: string;
  downloadDir?: string;
  outputFiles: string[] = [];
  uploadResult?: UploadResult;
  deleteResult?: Awaited<ReturnType<typeof deleteRemoteFiles>>;
  finalFiles?: RemoteFileRecord[];
  backupFiles?: RemoteFileRecord[];
  stageRemotePath?: string;
  backupRemotePath?: string;
  qualityStage?: "download" | "upload";
  qualityStageLabel?: string;
  videoTitle?: string;
  folderTitle?: string;
  userId?: string;
  mediaId?: number;
  status: "pending" | "running" | "retry_wait" | "completed" | "error" = "pending";
  error?: Error;
  queuedAt?: number;
  startedAt?: number;
  retryAt?: number;
  sequence?: number;
  retries: number = 0;
  onStartUpgrade?: (task: QualityUpgradeTask) => void;
  onReplacing?: (task: QualityUpgradeTask, stageRemotePath: string, backupRemotePath: string) => void;
  onBackupFileMoved?: (task: QualityUpgradeTask, file: RemoteFileRecord) => void;
  onFinalFileMoved?: (task: QualityUpgradeTask, file: RemoteFileRecord) => void;
  onUploaded?: (task: QualityUpgradeTask, result: UploadResult) => void;
  onCompletedUpgrade?: (task: QualityUpgradeTask) => void;
  onFailed?: (task: QualityUpgradeTask, error: any) => void;
  apiModeOverride?: BBDownApiMode;
  apiProbe = false;
  onApiReady?: (task: QualityUpgradeTask, mode: BBDownApiMode) => void;

  constructor(bvid: string, cookie: BiliCookie, config: AppConfig, target: QualityUpgradeTarget) {
    super(`Quality upgrade ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.cookie = cookie;
    this.config = config;
    this.target = target;
  }

  async run() {
    this.runId = `${Date.now()}-${this.id}`;
    await this.runDownloadPhase(this.runId);
    await this.runUploadReplacePhase(this.runId);
  }

  async runDownloadPhase(runId: string) {
    console.log(`[Task] Starting quality-upgrade download for ${this.bvid}`);
    this.qualityStage = "download";
    this.qualityStageLabel = "下载新版";
    this.onStartUpgrade?.(this);
    const result = await downloadWithBBDown(this.bvid, this.cookie, this.config, {
      downloadDir: this.downloadDir || path.join(tempDir, `quality-upgrade-${runId}-${this.bvid}`),
      kind: "quality_upgrade",
      qualityUpgrade: {
        userId: this.target.userId,
        mediaId: this.target.mediaId,
        folderTitle: this.target.folderTitle,
        remotePath: this.target.remotePath,
        oldFiles: this.target.oldFiles,
      },
      apiModeOverride: this.apiModeOverride,
      onApiReady: (mode) => this.onApiReady?.(this, mode),
    });
    this.downloadDir = result.downloadDir;
    this.outputFiles = result.files;
  }

  async runUploadReplacePhase(runId: string) {
    await this.runUploadStagePhase(runId);
    await this.runReplacePhase(runId);
    await this.runCleanupPhase();
  }

  async runUploadStagePhase(runId: string) {
    if (!this.downloadDir) {
      throw new Error("Quality upgrade download directory is missing");
    }
    console.log(`[Task] Starting quality-upgrade staged upload for ${this.bvid}`);
    this.qualityStage = "upload";
    this.qualityStageLabel = "上传新版到临时目录";
    const targetRemotePath = this.target.remotePath;
    const stageRemotePath = joinRemotePath(targetRemotePath, `.quality-upgrade-${runId}`);
    this.stageRemotePath = stageRemotePath;
    this.uploadResult = await uploadWithAList(this.downloadDir, stageRemotePath, this.config, {
      cleanupLocal: false,
      files: this.outputFiles,
    });
    this.qualityStageLabel = "验证临时新版文件";
    const stagedVerifyResult = await verifyRemoteFiles(this.config, this.uploadResult.files);
    if (!stagedVerifyResult.ok) {
      throw new Error(`New upgraded files missing after staged upload: ${stagedVerifyResult.missing.join(", ")}`);
    }
  }

  async runReplacePhase(runId: string) {
    if (!this.uploadResult?.files.length) {
      throw new Error("Quality upgrade staged upload result is missing");
    }
    console.log(`[Task] Starting quality-upgrade remote replacement for ${this.bvid}`);
    const targetRemotePath = this.target.remotePath;
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
    this.backupRemotePath = backupRemotePath;
    this.backupFiles = [];
    this.finalFiles = [];
    this.onReplacing?.(this, this.stageRemotePath || joinRemotePath(targetRemotePath, `.quality-upgrade-${runId}`), backupRemotePath);
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
            console.warn(`[Task] Failed to roll back upgraded file ${finalFile.path}: ${sanitizeUploadText((rollbackError as any)?.message || rollbackError)}`);
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
            console.warn(`[Task] Failed to restore backup file ${backupFile.path}: ${sanitizeUploadText((rollbackError as any)?.message || rollbackError)}`);
          }
        }
      }
      throw error;
    }
    const finalResult: UploadResult = { remotePath: targetRemotePath, files: this.finalFiles, allVerified: true };
    this.uploadResult = finalResult;
    this.qualityStageLabel = "写入新版远端状态";
    this.onUploaded?.(this, finalResult);
  }

  async runCleanupPhase() {
    this.qualityStageLabel = "清理旧文件备份";
    this.deleteResult = await deleteRemoteFiles(this.config, this.backupFiles || []);
    this.qualityStageLabel = "画质重调完成";
    this.onCompletedUpgrade?.(this);
    if (this.downloadDir) await cleanupUploadedSessionFiles(this.downloadDir);
    console.log(`[Task] Completed quality upgrade for ${this.bvid}`);
  }
}

abstract class QualityUpgradePhaseTask extends Task {
  control: QualityUpgradeTask;
  bvid: string;
  videoTitle?: string;
  upperName = "画质重调";
  folderTitle?: string;
  remotePath?: string;
  userId?: string;
  mediaId?: number;

  constructor(name: string, control: QualityUpgradeTask) {
    super(name, { maxRetries: control.maxRetries, retryDelaySeconds: control.retryDelaySeconds });
    this.control = control;
    this.bvid = control.bvid;
    this.videoTitle = control.videoTitle || control.bvid;
    this.folderTitle = control.folderTitle || control.target.folderTitle;
    this.remotePath = control.target.remotePath;
    this.userId = control.target.userId;
    this.mediaId = control.target.mediaId;
  }

  get detail() {
    return this.control.qualityStageLabel || "画质重调中";
  }
}

export class QualityUpgradeDownloadTask extends QualityUpgradePhaseTask {
  constructor(control: QualityUpgradeTask) {
    super(`Quality upgrade download ${control.bvid}`, control);
  }

  async run() {
    const runId = this.control.runId || `${Date.now()}-${this.control.id}`;
    this.control.runId = runId;
    await this.control.runDownloadPhase(runId);
  }
}

export class QualityUpgradeUploadReplaceTask extends QualityUpgradePhaseTask {
  constructor(control: QualityUpgradeTask) {
    super(`Quality upgrade upload ${control.bvid}`, control);
  }

  async run() {
    const runId = this.control.runId;
    if (!runId) {
      throw new Error("Quality upgrade run id is missing");
    }
    await this.control.runUploadStagePhase(runId);
  }
}

export class QualityUpgradeReplaceTask extends QualityUpgradePhaseTask {
  constructor(control: QualityUpgradeTask) {
    super(`Quality upgrade replace ${control.bvid}`, control);
  }

  async run() {
    const runId = this.control.runId;
    if (!runId) throw new Error("Quality upgrade run id is missing");
    await this.control.runReplacePhase(runId);
  }
}

export class QualityUpgradeCleanupTask extends QualityUpgradePhaseTask {
  constructor(control: QualityUpgradeTask) {
    super(`Quality upgrade cleanup ${control.bvid}`, control);
  }

  async run() {
    await this.control.runCleanupPhase();
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
  recoveryKey?: string;
  result?: UploadResult;
  onUploading?: (task: UploadTask) => void;
  cleanupLocal: boolean;
  files?: string[];
  partialBackup = false;
  historyOnly = false;
  historySnapshotAt?: string;

  constructor(
    bvid: string,
    downloadDir: string,
    remotePath: string,
    config: AppConfig,
    options: { cleanupLocal?: boolean; files?: string[]; partialBackup?: boolean; historyOnly?: boolean; historySnapshotAt?: string } = {}
  ) {
    super(`Upload ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.downloadDir = downloadDir;
    this.remotePath = remotePath;
    this.config = config;
    this.cleanupLocal = options.cleanupLocal !== false;
    this.files = options.files;
    this.partialBackup = Boolean(options.partialBackup);
    this.historyOnly = Boolean(options.historyOnly);
    this.historySnapshotAt = options.historySnapshotAt;
  }

  async run() {
    console.log(`[Task] Starting upload for ${this.bvid} to ${this.remotePath}`);
    if (!this.files || this.files.length === 0) {
      throw new Error("Upload file whitelist is missing; local cache must be adopted before upload");
    }
    this.onUploading?.(this);
    this.result = await uploadWithAList(this.downloadDir, this.remotePath, this.config, {
      cleanupLocal: this.cleanupLocal,
      files: this.files,
    });
    console.log(`[Task] Completed upload for ${this.bvid}`);
  }
}

export class UploadVerificationTask extends Task {
  result?: Awaited<ReturnType<typeof inspectRemoteFileSize>>;

  constructor(
    public readonly bvid: string,
    public readonly userId: string,
    public readonly mediaId: number,
    public readonly remoteFile: string,
    public readonly expectedSize: number,
    public readonly config: AppConfig
  ) {
    super(`Verify upload ${bvid}`, { maxRetries: 0, retryDelaySeconds: 1 });
  }

  async run() {
    this.result = await inspectRemoteFileSize(this.config, this.remoteFile, this.expectedSize);
  }
}
