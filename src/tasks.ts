import path from "node:path";
import { Task } from "./queue.js";
import { downloadWithBBDown } from "./downloader.js";
import { uploadWithAList, UploadResult, deleteRemoteFiles, inspectRemoteFileSize, moveRemoteFile, resumeUploadSession, verifyRemoteFiles } from "./uploader.js";
import type { ExistingArchiveProof, UploadIntent } from "./upload-preflight.js";
import { AppConfig, type BBDownApiMode } from "./config.js";
import { BiliCookie } from "./users.js";
import type { RemoteFileRecord, UploadFileMetadata } from "./state.js";
import { tempDir } from "./paths.js";
import { joinRemotePath } from "./utils.js";
import {
  buildUploadFileMetadataFromSession,
  cleanupUploadedSessionFiles,
  type DownloadSessionManifest,
} from "./download-session.js";
import { sanitizeUploadText } from "./upload-health.js";
import { TransferSessionStore } from "./transfer-session.js";
import { createRemoteReplacementRunner, type RemoteReplacementRunner } from "./remote-operations.js";
import {
  applyQualityArtifactProfile,
  buildQualityArtifactKey,
  normalizeQualityArtifactProfile,
  qualityArtifactProfileFromConfig,
  type QualityArtifactProfile,
} from "./quality-artifact.js";

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
  downloadUserId?: string;
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

export function qualityUpgradeTargetKey(target: Pick<QualityUpgradeTarget, "userId" | "mediaId">) {
  return `${target.userId}:${target.mediaId}`;
}

function uniqueQualityUpgradeTargets(targets: QualityUpgradeTarget[]) {
  const unique = new Map<string, QualityUpgradeTarget>();
  for (const target of targets) unique.set(qualityUpgradeTargetKey(target), target);
  return [...unique.values()];
}

export class QualityUpgradeTask extends Task {
  bvid: string;
  cookie: BiliCookie;
  config: AppConfig;
  target: QualityUpgradeTarget;
  targets: QualityUpgradeTarget[];
  artifactKey: string;
  qualityProfile: QualityArtifactProfile;
  downloadUserId?: string;
  downloadRunner = downloadWithBBDown;
  uploadRunner = uploadWithAList;
  verifyRunner = verifyRemoteFiles;
  moveRunner = moveRemoteFile;
  replacementRunner?: RemoteReplacementRunner;
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
  shouldCleanupLocal?: () => boolean;
  onLocalCleanupFinished?: (task: QualityUpgradeTask) => void;
  apiModeOverride?: BBDownApiMode;
  apiProbe = false;
  onApiReady?: (task: QualityUpgradeTask, mode: BBDownApiMode) => void;

  constructor(
    bvid: string,
    cookie: BiliCookie,
    config: AppConfig,
    target: QualityUpgradeTarget,
    shared: {
      targets?: QualityUpgradeTarget[];
      artifactKey?: string;
      qualityProfile?: QualityArtifactProfile;
    } = {}
  ) {
    super(`Quality upgrade ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.cookie = cookie;
    this.qualityProfile = normalizeQualityArtifactProfile(shared.qualityProfile || qualityArtifactProfileFromConfig(config));
    this.config = applyQualityArtifactProfile(config, this.qualityProfile);
    this.targets = uniqueQualityUpgradeTargets([target, ...(shared.targets || [])]);
    this.target = this.targets[0];
    this.artifactKey = shared.artifactKey || buildQualityArtifactKey(bvid, this.qualityProfile);
  }

  setTargets(targets: QualityUpgradeTarget[]) {
    this.targets = uniqueQualityUpgradeTargets(targets);
    if (this.targets.length > 0) this.target = this.targets[0];
  }

  async run() {
    this.runId = `${Date.now()}-${this.id}`;
    await this.runDownloadPhase(this.runId);
    await this.runUploadReplacePhase(this.runId);
  }

  async runDownloadPhase(runId: string) {
    console.log(`[Task] Starting quality-upgrade download for ${this.bvid}`);
    this.qualityStage = "download";
    this.qualityStageLabel = this.targets.length > 1 ? `下载新版 · ${this.targets.length}个目标` : "下载新版";
    this.onStartUpgrade?.(this);
    this.config = applyQualityArtifactProfile(this.config, this.qualityProfile);
    const result = await this.downloadRunner(this.bvid, this.cookie, this.config, {
      downloadDir: this.downloadDir || path.join(tempDir, `quality-upgrade-${this.bvid}-${this.artifactKey.slice(0, 16)}`),
      kind: "quality_upgrade",
      qualityUpgrade: {
        userId: this.target.userId,
        mediaId: this.target.mediaId,
        folderTitle: this.target.folderTitle,
        remotePath: this.target.remotePath,
        oldFiles: this.target.oldFiles,
        artifactKey: this.artifactKey,
        qualityProfile: this.qualityProfile,
        downloadUserId: this.downloadUserId,
        targets: this.targets,
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
    const filenameMetadataByPath = buildUploadFileMetadataFromSession(this.downloadDir, this.outputFiles, {
      requireVerifiedMediaMetadata: true,
    });
    const targetRemotePath = this.target.remotePath;
    const stageRemotePath = this.stageRemotePath || joinRemotePath(targetRemotePath, `.quality-upgrade-${runId}`);
    this.stageRemotePath = stageRemotePath;
    this.uploadResult = await this.uploadRunner(this.downloadDir, stageRemotePath, this.config, {
      cleanupLocal: false,
      files: this.outputFiles,
      filenameMetadataByPath,
      uploadIntent: "quality_upgrade",
    });
    this.qualityStageLabel = "验证临时新版文件";
    const stagedVerifyResult = await this.verifyRunner(this.config, this.uploadResult.files);
    if (!stagedVerifyResult.ok) {
      throw new Error(`New upgraded files missing after staged upload: ${stagedVerifyResult.missing.join(", ")}`);
    }
  }

  async runReplacePhase(runId: string) {
    const stagedFiles = this.uploadResult?.files || [];
    if (!stagedFiles.length && !this.finalFiles?.length) {
      throw new Error("Quality upgrade staged upload result is missing");
    }
    console.log(`[Task] Starting quality-upgrade remote replacement for ${this.bvid}`);
    const targetRemotePath = this.target.remotePath;
    const plannedFinalFiles = (stagedFiles.length ? stagedFiles : (this.finalFiles || [])).map((file) => ({
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
    const stageRemotePath = this.stageRemotePath || joinRemotePath(targetRemotePath, `.quality-upgrade-${runId}`);
    const backupRemotePath = this.backupRemotePath || joinRemotePath(targetRemotePath, `.quality-upgrade-backup-${runId}`);
    this.stageRemotePath = stageRemotePath;
    this.backupRemotePath = backupRemotePath;
    const backupFiles = this.backupFiles ||= [];
    const finalFiles = this.finalFiles ||= [];
    this.onReplacing?.(this, stageRemotePath, backupRemotePath);
    const replace = this.replacementRunner || (this.moveRunner === moveRemoteFile
      ? await createRemoteReplacementRunner(this.config)
      : this.moveRunner);
    try {
      this.qualityStageLabel = "备份旧远端文件";
      for (const oldFile of this.target.oldFiles) {
        const backupFile = {
          ...oldFile,
          path: joinRemotePath(backupRemotePath, oldFile.name),
        };
        const alreadyVerified = backupFiles.some((file) => file.path === backupFile.path);
        const recordBackupProof = () => {
          if (!backupFiles.some((file) => file.path === backupFile.path)) {
            backupFiles.push(backupFile);
            this.onBackupFileMoved?.(this, backupFile);
          }
        };
        await replace(this.config, oldFile.path, backupFile.path, oldFile.size, {
          targetPreviouslyVerified: alreadyVerified,
          onTargetVerified: recordBackupProof,
        });
        recordBackupProof();
      }
      this.qualityStageLabel = "移动新版到正式目录";
      for (let i = 0; i < plannedFinalFiles.length; i += 1) {
        const stagedFile = stagedFiles[i];
        const finalFile = plannedFinalFiles[i];
        if (!finalFile) continue;
        const recordFinalProof = () => {
          if (!finalFiles.some((file) => file.path === finalFile.path)) {
            finalFiles.push(finalFile);
            this.onFinalFileMoved?.(this, finalFile);
          }
        };
        const alreadyVerified = finalFiles.some((file) => file.path === finalFile.path);
        const sourceFile = stagedFile || {
          ...finalFile,
          path: joinRemotePath(stageRemotePath, finalFile.name),
        };
        if (!stagedFile && !alreadyVerified) {
          throw new Error(`Quality upgrade staged file is missing: ${finalFile.name}`);
        }
        await replace(this.config, sourceFile.path, finalFile.path, sourceFile.size, {
          targetPreviouslyVerified: alreadyVerified,
          onTargetVerified: recordFinalProof,
        });
        recordFinalProof();
      }
      this.qualityStageLabel = "验证正式目录新版文件";
      const finalVerifyResult = await this.verifyRunner(this.config, this.finalFiles);
      if (!finalVerifyResult.ok) {
        throw new Error(`Moved upgraded files missing after final rename: ${finalVerifyResult.missing.join(", ")}`);
      }
    } catch (error) {
      for (const finalFile of [...this.finalFiles].reverse()) {
        const stagedFile = stagedFiles.find((file) => file.name === finalFile.name);
        if (stagedFile) {
          try {
            await replace(this.config, finalFile.path, stagedFile.path, finalFile.size);
          } catch (rollbackError) {
            console.warn(`[Task] Failed to roll back upgraded file ${finalFile.path}: ${sanitizeUploadText((rollbackError as any)?.message || rollbackError)}`);
          }
        }
      }
      for (let i = this.backupFiles.length - 1; i >= 0; i -= 1) {
        const backupFile = this.backupFiles[i];
        const oldFile = this.target.oldFiles.find((file) => file.name === backupFile.name);
        if (oldFile) {
          try {
            await replace(this.config, backupFile.path, oldFile.path, backupFile.size);
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
    if (this.deleteResult.failed > 0) {
      const failedItems = this.deleteResult.results.filter((item) => !item.ok);
      const failedPaths = failedItems
        .map((item) => item.path)
        .slice(0, 5);
      this.qualityStageLabel = "旧文件清理重试中";
      const first = failedItems[0];
      const error: any = new Error(
        `Failed to delete ${this.deleteResult.failed} old quality backup file(s): ${failedPaths.join(", ")}${first?.error ? `; ${first.error}` : ""}`
      );
      if (first?.status) error.status = first.status;
      if (first?.code) error.code = first.code;
      throw error;
    }
    this.qualityStageLabel = "画质重调完成";
    this.onCompletedUpgrade?.(this);
    if (this.downloadDir && (this.shouldCleanupLocal?.() ?? true)) {
      try {
        await cleanupUploadedSessionFiles(this.downloadDir);
      } finally {
        this.onLocalCleanupFinished?.(this);
      }
    }
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
    this.folderTitle = control.targets.length > 1 ? `${control.targets.length}个目标` : (control.folderTitle || control.target.folderTitle);
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
  filenameMetadataByPath?: Record<string, UploadFileMetadata>;
  partialBackup = false;
  historyOnly = false;
  historySnapshotAt?: string;
  uploadIntent: UploadIntent;
  existingArchiveProof?: ExistingArchiveProof;
  legacyConflictSideEffectsStarted = false;
  conflictCandidateId?: string;
  conflictCandidateRemotePath?: string;
  transferSessionStore?: TransferSessionStore;
  sessionId?: string;
  sessionGeneration?: number;
  sessionDedupeKey?: string;
  conflictArchiveSegment?: string;
  conflictArchiveRoot?: string;
  conflictArchiveOldFiles?: RemoteFileRecord[];
  conflictArchiveVerifiedPaths?: string[];
  onConflictArchived?: (archive: {
    archivePath: string;
    files: Array<{ name: string; oldPath: string; archivedPath: string; size?: number }>;
  }) => void | Promise<void>;
  onConflictArchiveTargetVerified?: (file: { name: string; oldPath: string; archivedPath: string; size?: number }) => void | Promise<void>;
  allowReupload = false;
  reuploadAuthorizedFiles: string[] = [];
  consumeReuploadPermission?: (relativePath: string) => boolean;
  reuploadPermissionUsed = false;
  resumeOnly = false;
  onTransferSession?: (task: UploadTask, sessionId: string, sessionGeneration: number) => void;

  constructor(
    bvid: string,
    downloadDir: string,
    remotePath: string,
    config: AppConfig,
    options: {
      cleanupLocal?: boolean;
      files?: string[];
      filenameMetadataByPath?: Record<string, UploadFileMetadata>;
      partialBackup?: boolean;
      historyOnly?: boolean;
      historySnapshotAt?: string;
      uploadIntent?: UploadIntent;
      existingArchiveProof?: ExistingArchiveProof;
      legacyConflictSideEffectsStarted?: boolean;
      conflictCandidateId?: string;
      conflictCandidateRemotePath?: string;
      transferSessionStore?: TransferSessionStore;
      sessionId?: string;
      sessionGeneration?: number;
      sessionDedupeKey?: string;
      conflictArchiveSegment?: string;
      conflictArchiveRoot?: string;
      conflictArchiveOldFiles?: RemoteFileRecord[];
      conflictArchiveVerifiedPaths?: string[];
      onConflictArchived?: UploadTask["onConflictArchived"];
      onConflictArchiveTargetVerified?: UploadTask["onConflictArchiveTargetVerified"];
      allowReupload?: boolean;
      reuploadAuthorizedFiles?: string[];
      consumeReuploadPermission?: (relativePath: string) => boolean;
      resumeOnly?: boolean;
      onTransferSession?: (task: UploadTask, sessionId: string, sessionGeneration: number) => void;
    } = {}
  ) {
    super(`Upload ${bvid}`, { maxRetries: config.maxRetries, retryDelaySeconds: config.retryDelaySeconds });
    this.bvid = bvid;
    this.downloadDir = downloadDir;
    this.remotePath = remotePath;
    this.config = config;
    this.cleanupLocal = options.cleanupLocal !== false;
    this.files = options.files;
    this.filenameMetadataByPath = options.filenameMetadataByPath;
    this.partialBackup = Boolean(options.partialBackup);
    this.historyOnly = Boolean(options.historyOnly);
    this.historySnapshotAt = options.historySnapshotAt;
    this.uploadIntent = options.uploadIntent || (this.historyOnly ? "history_upload" : "normal_backup");
    this.existingArchiveProof = options.existingArchiveProof;
    this.legacyConflictSideEffectsStarted = Boolean(options.legacyConflictSideEffectsStarted);
    this.conflictCandidateId = options.conflictCandidateId;
    this.conflictCandidateRemotePath = options.conflictCandidateRemotePath;
    this.transferSessionStore = options.transferSessionStore;
    this.sessionId = options.sessionId;
    this.sessionGeneration = options.sessionGeneration;
    this.sessionDedupeKey = options.sessionDedupeKey;
    this.conflictArchiveSegment = options.conflictArchiveSegment;
    this.conflictArchiveRoot = options.conflictArchiveRoot;
    this.conflictArchiveOldFiles = options.conflictArchiveOldFiles;
    this.conflictArchiveVerifiedPaths = options.conflictArchiveVerifiedPaths;
    this.onConflictArchived = options.onConflictArchived;
    this.onConflictArchiveTargetVerified = options.onConflictArchiveTargetVerified;
    this.allowReupload = Boolean(options.allowReupload);
    this.reuploadAuthorizedFiles = [...new Set((options.reuploadAuthorizedFiles || []).map((value) => String(value || "").replace(/\\/g, "/")).filter(Boolean))];
    this.consumeReuploadPermission = options.consumeReuploadPermission;
    this.resumeOnly = Boolean(options.resumeOnly);
    this.onTransferSession = options.onTransferSession;
  }

  async run() {
    console.log(`[Task] Starting upload for ${this.bvid} to ${this.remotePath}`);
    if (!this.files || this.files.length === 0) {
      throw new Error("Upload file whitelist is missing; local cache must be adopted before upload");
    }
    this.onUploading?.(this);
    this.allowReupload = false;
    try {
      this.result = await uploadWithAList(this.downloadDir, this.remotePath, this.config, {
        cleanupLocal: this.cleanupLocal,
        files: this.files,
        filenameMetadataByPath: this.filenameMetadataByPath,
        transferSessionStore: this.transferSessionStore,
        sessionId: this.sessionId,
        sessionGeneration: this.sessionGeneration,
        sessionDedupeKey: this.sessionDedupeKey,
        allowReupload: false,
        reuploadAuthorizedFiles: this.reuploadAuthorizedFiles,
        consumeReuploadPermission: (relativePath) => {
          const consumed = this.consumeReuploadPermission?.(relativePath) ?? false;
          if (consumed) this.reuploadPermissionUsed = true;
          return consumed;
        },
        resumeOnly: this.resumeOnly,
        bvid: this.bvid,
        userId: this.userId,
        mediaId: this.mediaId,
        historyOnly: this.historyOnly,
        historySnapshotAt: this.historySnapshotAt,
        uploadIntent: this.uploadIntent,
        existingArchiveProof: this.existingArchiveProof,
        legacyConflictSideEffectsStarted: this.legacyConflictSideEffectsStarted,
        conflictArchiveSegment: this.conflictArchiveSegment,
        conflictArchiveRoot: this.conflictArchiveRoot,
        conflictArchiveOldFiles: this.conflictArchiveOldFiles,
        conflictArchiveVerifiedPaths: this.conflictArchiveVerifiedPaths,
        onConflictArchiveTargetVerified: this.onConflictArchiveTargetVerified,
        onConflictArchived: this.onConflictArchived,
      });
    } catch (error: any) {
      const status = Number(error?.uploadFailure?.status || error?.status || 0);
      const reasonCode = String(error?.uploadFailure?.code || error?.code || "UPLOAD_REMOTE_CONFLICT");
      const reasonSummary = sanitizeUploadText(error?.uploadFailure?.summary || error?.message || error, 500);
      const candidateEligible = this.uploadIntent === "normal_backup"
        && status === 409
        && !this.legacyConflictSideEffectsStarted
        && reasonCode !== "UPLOAD_LEGACY_CONFLICT_ARCHIVE_INTERRUPTED"
        && Boolean(this.conflictCandidateId && this.conflictCandidateRemotePath);
      if (!candidateEligible) throw error;
      const candidateResult = await uploadWithAList(
        this.downloadDir,
        this.conflictCandidateRemotePath!,
        this.config,
        {
          cleanupLocal: false,
          files: this.files,
          filenameMetadataByPath: this.filenameMetadataByPath,
          uploadIntent: "conflict_candidate",
          bvid: this.bvid,
          userId: this.userId,
          mediaId: this.mediaId,
        },
      );
      if (!candidateResult.allVerified) {
        const pendingError: any = new Error("冲突候选已上传，正在等待远端完整可见");
        pendingError.status = 503;
        pendingError.code = "UPLOAD_CONFLICT_CANDIDATE_AWAITING_REMOTE";
        throw pendingError;
      }
      this.result = {
        ...candidateResult,
        disposition: "conflict_candidate",
        conflictCandidate: {
          id: this.conflictCandidateId!,
          originalRemotePath: this.remotePath,
          candidateRemotePath: this.conflictCandidateRemotePath!,
          reasonCode,
          reasonSummary,
          existingArchiveProof: this.existingArchiveProof,
        },
      };
    }
    if (this.result.sessionId && this.result.sessionId !== this.sessionId) {
      this.sessionId = this.result.sessionId;
      this.sessionGeneration = this.result.sessionGeneration;
      this.onTransferSession?.(this, this.result.sessionId, this.result.sessionGeneration || 1);
    }
    console.log(`[Task] Completed upload for ${this.bvid}`);
  }
}

export class UploadVerificationTask extends Task {
  result?: Awaited<ReturnType<typeof inspectRemoteFileSize>>;
  transferResult?: UploadResult;
  transferSessionStore?: TransferSessionStore;
  sessionId?: string;
  sessionGeneration?: number;
  allowReupload = false;
  sessionVerification = false;
  filenameMetadataByPath?: Record<string, UploadFileMetadata>;

  constructor(
    public readonly bvid: string,
    public readonly userId: string,
    public readonly mediaId: number,
    public readonly remoteFile: string,
    public readonly expectedSize: number,
    public readonly config: AppConfig,
    options: { transferSessionStore?: TransferSessionStore; sessionId?: string; sessionGeneration?: number; allowReupload?: boolean; sessionVerification?: boolean; filenameMetadataByPath?: Record<string, UploadFileMetadata> } = {}
  ) {
    super(`Verify upload ${bvid}`, { maxRetries: 0, retryDelaySeconds: 1 });
    this.transferSessionStore = options.transferSessionStore;
    this.sessionId = options.sessionId;
    this.sessionGeneration = options.sessionGeneration;
    this.allowReupload = Boolean(options.allowReupload);
    this.sessionVerification = Boolean(options.sessionVerification || options.sessionId);
    this.filenameMetadataByPath = options.filenameMetadataByPath;
  }

  async run() {
    if (this.transferSessionStore && this.sessionId) {
      this.transferResult = await resumeUploadSession(this.config, this.transferSessionStore, this.sessionId, {
        // Verification is always read-only. A manual recovery upload carries
        // its one-time permission in the upload job, never in this task.
        allowReupload: this.sessionVerification ? false : this.allowReupload,
        sessionGeneration: this.sessionGeneration,
        filenameMetadataByPath: this.filenameMetadataByPath,
        cleanupLocal: false,
        verificationDelaysMs: [0],
      });
      this.result = this.transferResult.allVerified
        ? { status: "verified", remoteSize: this.transferResult.files.reduce((sum, file) => sum + Number(file.size || 0), 0) }
        : { status: "missing" };
      return;
    }
    this.result = await inspectRemoteFileSize(this.config, this.remoteFile, this.expectedSize);
  }
}
