import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  applyBBDownEncodingPreference,
  ConfigStore,
  isValidBBDownEncodingPriority,
  normalizeBBDownEncodingPriority,
  type AppConfig,
  type BBDownApiMode,
  type BBDownEncoding,
} from "./config.js";
import { FavoriteRelation, MANUAL_ARCHIVE_FOLDER_TITLE, MANUAL_ARCHIVE_MEDIA_ID, StateManager, VideoArchiveEntry, type LocalCleanupPlan, type RemoteFileRecord, type SourceAvailabilityReason } from "./state.js";
import { BiliUser, downloadCredentialsForUser, UserStore } from "./users.js";
import {
  BiliRiskOrLoginError,
  getVideoPageSnapshot,
  listFavoriteItemsPage,
  refreshUserAuth,
  resolveSelfVisibleFavoriteItem,
  type VideoPageSnapshotResult,
} from "./bili.js";
import { logManager } from "./logger.js";
import { tempDir } from "./paths.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { inspectRemoteFileSize, listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import type { ExistingArchiveProof, UploadIntent } from "./upload-preflight.js";
import {
  computeTaskRetryDelayMs,
  mapQueueBoardTask,
  type QueueBoardAction,
  type QueueBoardItem,
  type QueueBoardPhase,
  TaskQueue,
} from "./queue.js";
import { queueCoverCache } from "./cover-cache.js";
import {
  assessStrictEncoding,
  assessStrictQuality,
  buildUploadFileMetadataFromSession,
  cleanupUploadedSessionFiles,
  createStrictEncodingValidationError,
  StrictQualityValidationError,
  DOWNLOAD_RETAINED_FILE,
  historySessionGroups,
  inspectDownloadCache,
  markDownloadSessionStatus,
  markHistoryGroupUploaded,
  readDownloadSession,
  readDownloadSessionAsync,
  strictEncodingDiagnosticPatch,
  strictQualityDiagnosticPatch,
  type DownloadCacheInspection,
  type DownloadRecoverySummary,
  writeDownloadSession,
  type DownloadCleanupAuthorization,
  type DownloadCleanupOptions,
} from "./download-session.js";
import {
  LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER,
  LEGACY_TEMP_CACHE_MARKER,
} from "./database.js";
import {
  classifyUploadError,
  REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE,
  sanitizeUploadText,
  UploadCircuitBreaker,
  type UploadFailureInfo,
  type RemoteWriteEvidence,
} from "./upload-health.js";
import { DownloadApiHealth } from "./download-api-health.js";
import { classifyDownloadRecoveryFailure } from "./download-recovery.js";
import { cancelActiveDownloadsForAccount } from "./downloader.js";
import { redactRemotePathForDisplay, safeErrorSummary, sanitizeDiagnosticText } from "./diagnostics.js";
import { isSelectableBilibiliQuality } from "./media-metadata.js";
import {
  isAuthRefreshAttemptBlocked,
  nextAuthRefreshFailureState,
} from "./auth-refresh.js";
import { TransferSessionStore } from "./transfer-session.js";
import { classifyRemoteFailure, type RemoteFailureCategory, type RemoteFailureInfo } from "./remote-file-resolver.js";
import { normalizeRemotePath, remoteDirname } from "./remote-path.js";
import {
  PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES,
  PersistentJobStore,
  isRecoveryStopped,
  type EnqueuePersistentJob,
  type PersistentJobKind,
  type QualityDownloadMigrationPlan,
} from "./job-store.js";
import {
  DownloadTask,
  QualityUpgradeCleanupTask,
  QualityUpgradeDownloadTask,
  QualityUpgradeReplaceTask,
  QualityUpgradeTask,
  QualityUpgradeUploadReplaceTask,
  qualityUpgradeTargetKey,
  type QualityUpgradeTarget,
  UploadTarget,
  UploadTask,
  UploadVerificationTask,
  type EncodingRetryContext,
  type QualityEncodingOverride,
  type StrictMediaTarget,
} from "./tasks.js";
import {
  applyQualityArtifactProfile,
  buildQualityArtifactKey,
  normalizeQualityArtifactProfile,
  qualityArtifactProfileFromConfig,
  type QualityArtifactProfile,
} from "./quality-artifact.js";
import {
  planRecoveryActions,
  recordRemoteVisibilityObservation,
  recoveryIssueDisposition,
  recoveryIssueSeverity,
  type DownloadRecoveryCategory,
  type RecoveryIssueAction,
  type RecoveryIssueActionId,
  type RecoveryIssueDisposition,
  type RecoveryIssueKind,
} from "./recovery-policy.js";

export { recoveryIssueDisposition };
export type { RecoveryIssueAction, RecoveryIssueActionId, RecoveryIssueKind };

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cooldownMs() {
  return (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
}

export function computeDownloadStartDelayMs(random: () => number = Math.random) {
  return 3_000 + Math.min(3_000, Math.floor(Math.max(0, random()) * 3_001));
}

const ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS = 6 * 60 * 60_000;
const UPLOAD_SESSION_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000];
const UPLOAD_VERIFY_SCHEDULE_MS = [2_000, 10_000, 30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const UPLOAD_VERIFY_REUPLOAD_DELAY_MS = 30 * 60_000;
const CHARGING_RECHECK_BASE_MS = 7 * 24 * 60 * 60_000;
const CHARGING_RECHECK_JITTER_MS = 12 * 60 * 60_000;
const CHARGING_TRANSIENT_BASE_MS = 6 * 60 * 60_000;
const CHARGING_TRANSIENT_JITTER_MS = 30 * 60_000;
const CHARGING_NO_ACCOUNT_DELAY_MS = 24 * 60 * 60_000;
const AVAILABILITY_UNKNOWN_DELAYS_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;
const AVAILABILITY_UNAVAILABLE_DELAYS_MS = [24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000] as const;
const LOCAL_CLEANUP_RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;
const AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT = 3;
const AUTOMATIC_QUALITY_RECOVERY_LIMIT = 2;
const AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS = [15 * 60_000, 60 * 60_000] as const;

export function computeUploadVerificationTiming(putAcceptedAtValues: number[], now = Date.now()) {
  const acceptedAt = putAcceptedAtValues.filter((value) => Number.isFinite(value) && value > 0);
  if (acceptedAt.length === 0) return { timedOut: false, nextAt: undefined };
  const timeoutMs = UPLOAD_VERIFY_SCHEDULE_MS[UPLOAD_VERIFY_SCHEDULE_MS.length - 1];
  const timedOut = acceptedAt.every((value) => value + timeoutMs <= now);
  if (timedOut) return { timedOut: true, nextAt: undefined };
  const candidates = acceptedAt.flatMap((value) => UPLOAD_VERIFY_SCHEDULE_MS
    .map((delayMs) => value + delayMs)
    .filter((at) => at > now + 250));
  const nextAt = candidates.length > 0
    ? Math.min(...candidates)
    : Math.min(...acceptedAt.map((value) => value + timeoutMs).filter((at) => at > now));
  return { timedOut: false, nextAt: Number.isFinite(nextAt) ? nextAt : now + 1_000 };
}

function jitteredDelay(baseMs: number, jitterMs: number, random: () => number) {
  const normalized = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(1_000, Math.round(baseMs - jitterMs + normalized * jitterMs * 2));
}

export function computeChargingRecheckDelayMs(random: () => number = Math.random) {
  return jitteredDelay(CHARGING_RECHECK_BASE_MS, CHARGING_RECHECK_JITTER_MS, random);
}

export function computeChargingTransientDelayMs(random: () => number = Math.random) {
  return jitteredDelay(CHARGING_TRANSIENT_BASE_MS, CHARGING_TRANSIENT_JITTER_MS, random);
}

export function computeAvailabilityUnknownDelayMs(round: number, bvid = "") {
  const index = Math.max(0, Math.min(AVAILABILITY_UNKNOWN_DELAYS_MS.length - 1, Math.floor(Number(round) || 0)));
  return AVAILABILITY_UNKNOWN_DELAYS_MS[index] + availabilityJitter(bvid);
}

export function computeAvailabilityUnavailableDelayMs(round: number, bvid = "") {
  const index = Math.max(0, Math.min(AVAILABILITY_UNAVAILABLE_DELAYS_MS.length - 1, Math.floor(Number(round) || 0)));
  return AVAILABILITY_UNAVAILABLE_DELAYS_MS[index] + availabilityJitter(bvid);
}

function availabilityJitter(bvid: string) {
  let hash = 0;
  for (const char of String(bvid || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return bvid ? hash % (15 * 60_000) : 0;
}

interface SchedulerDependencies {
  videoAccessProbe?: (cookie: BiliUser["cookie"], bvid: string) => Promise<VideoPageSnapshotResult>;
  cacheInspector?: (rootDir: string, concurrency?: number) => Promise<DownloadCacheInspection>;
  remoteFileInspector?: typeof inspectRemoteFileSize;
  legacyTempDir?: string;
  now?: () => number;
  random?: () => number;
}

export type AccessProbeIntent = "charging" | "availability" | "legacy_classification";

function normalizeAccessProbeIntents(payload: Record<string, any> | undefined): AccessProbeIntent[] {
  const explicit = Array.isArray(payload?.intents)
    ? payload.intents.map(String).filter((value): value is AccessProbeIntent =>
      value === "charging" || value === "availability" || value === "legacy_classification")
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];
  if (payload?.purpose === "legacy_failure_classification") return ["legacy_classification", "availability"];
  if (payload?.purpose === "availability_recheck") return ["availability"];
  return ["charging"];
}

function snapshotAvailability(snapshot: VideoPageSnapshotResult): "available" | "unavailable" | "unknown" {
  if (snapshot.availability === "available" || snapshot.availability === "unavailable" || snapshot.availability === "unknown") {
    return snapshot.availability;
  }
  return snapshot.available ? "available" : "unavailable";
}

function isSourceUnavailableFailure(error: any) {
  return error?.code === "BILI_VIDEO_UNAVAILABLE"
    || error?.downloadFailureCategory === "source_unavailable";
}

function normalizeSourceAvailabilityReason(value: unknown): SourceAvailabilityReason {
  if (value === "submission_invisible") return "submission_invisible";
  if (value === "temporary_error" || value === "empty_response") return "temporary_error";
  if (value === "favorite_unavailable") return "favorite_flag";
  return "api_not_found";
}

export function computeUploadSessionRetryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(UPLOAD_SESSION_RETRY_DELAYS_MS.length - 1, Math.floor(attempts || 0)));
  return UPLOAD_SESSION_RETRY_DELAYS_MS[index];
}

export function computeQualityCleanupRetryDelayMs(attempts: number, random: () => number = Math.random) {
  const minimum = 60_000;
  const maximum = 6 * 60 * 60_000;
  const base = Math.min(maximum, minimum * (2 ** Math.max(0, Math.min(20, Math.floor(attempts || 0)))));
  const normalized = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(minimum, Math.min(maximum, Math.round(base * (0.8 + normalized * 0.4))));
}

export function computeLocalCleanupRetryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(LOCAL_CLEANUP_RETRY_DELAYS_MS.length - 1, Math.floor(Number(attempts) || 0)));
  return LOCAL_CLEANUP_RETRY_DELAYS_MS[index];
}

export interface RecoveryIssue {
  id: string;
  kind: RecoveryIssueKind;
  severity: "info" | "warning" | "danger";
  title: string;
  summary: string;
  protectedFacts: string[];
  recommendedAction?: RecoveryIssueAction;
  availableActions: RecoveryIssueAction[];
  bvid?: string;
  videoTitle?: string;
  upperName?: string;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  fileName?: string;
  expectedSize?: number;
  observedSize?: number;
  remoteErrorCode?: string;
  responseHeaders?: Record<string, string>;
  responseSnippet?: string;
  requestedEncoding?: BBDownEncoding;
  actualEncodings?: string[];
  encodingMismatch?: boolean;
  requestedQuality?: string;
  actualQualities?: string[];
  qualityMismatch?: boolean;
  verifiedPages?: number;
  totalPages?: number;
  lifecycleState?: string;
  attemptKey?: string;
  occurredAt: number;
  checkedAt?: number;
  nextAutomaticCheckAt?: number;
  busy?: boolean;
  safeDiagnostic: string;
  disposition: RecoveryIssueDisposition;
}

interface RecoveryAssessment {
  kind: Exclude<RecoveryIssueKind, "quality_failed" | "storage_backend">;
  checkedAt: number;
  nextCheckAt?: number;
  localStatus: "available" | "missing" | "changed" | "unknown";
  remoteStatus: "verified" | "missing" | "mismatch" | "mixed" | "error" | "unknown" | "transient" | "permission" | "unsupported" | "size_limit";
  fileName?: string;
  expectedSize?: number;
  observedSize?: number;
  writeStatus?: number;
  remoteErrorCode?: string;
  responseHeaders?: Record<string, string>;
  responseSnippet?: string;
  writeEvidence?: RemoteWriteEvidence | "repeated_missing_parent_visible";
  uploadAttempts?: number;
  firstObservedAt?: number;
  lastObservedAt?: number;
  consecutiveObservations?: number;
  candidateSafe?: boolean;
  candidateEligible?: boolean;
  failureCategory?: RemoteFailureCategory;
  operation?: "inspect" | "put";
  requestedEncoding?: BBDownEncoding;
  actualEncodings?: string[];
  encodingMismatch?: boolean;
  requestedQuality?: string;
  actualQualities?: string[];
  qualityMismatch?: boolean;
  verifiedPages?: number;
  summary: string;
}

export function computeAutomaticQualityRecoveryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS.length - 1, Math.floor(Number(attempts) || 0)));
  return AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS[index];
}

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;

function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask
    || task instanceof QualityUpgradeReplaceTask
    || task instanceof QualityUpgradeCleanupTask;
}

function parseEncodingRetryContext(value: unknown): EncodingRetryContext | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, any>;
  const parentJobId = String(item.parentJobId || "");
  const generation = Number(item.generation);
  const candidateLocalDir = String(item.candidateLocalDir || "");
  const originalLocalDir = String(item.originalLocalDir || "");
  if (!parentJobId || !Number.isInteger(generation) || generation < 1 || !candidateLocalDir || !originalLocalDir) return null;
  if (!isValidBBDownEncodingPriority(item.priority)) return null;
  const target = item.target && typeof item.target === "object"
    && typeof item.target.userId === "string"
    && Number.isInteger(Number(item.target.mediaId))
    && typeof item.target.folderTitle === "string"
    && typeof item.target.remotePath === "string"
    ? {
      userId: item.target.userId,
      mediaId: Number(item.target.mediaId),
      folderTitle: item.target.folderTitle,
      remotePath: item.target.remotePath,
    }
    : undefined;
  return {
    parentJobId,
    generation,
    priority: [...item.priority] as BBDownEncoding[],
    strict: item.strict !== false,
    quality: isSelectableBilibiliQuality(item.quality) ? String(item.quality).trim().toUpperCase() : undefined,
    candidateLocalDir,
    originalLocalDir,
    originalFiles: Array.isArray(item.originalFiles) ? item.originalFiles.map(String).filter(Boolean) : undefined,
    target,
    state: ["running", "uploading", "verifying", "failed", "completed"].includes(String(item.state)) ? item.state : "running",
    lastError: item.lastError ? sanitizeUploadText(item.lastError, 500) : undefined,
  };
}

function parseQualityEncodingOverride(value: unknown): QualityEncodingOverride | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const generation = Number(item.generation);
  if (!Number.isInteger(generation) || generation < 1 || !isValidBBDownEncodingPriority(item.priority)) return null;
  return {
    generation,
    priority: normalizeBBDownEncodingPriority(item.priority),
    strict: item.strict !== false,
  };
}

function parseStrictMediaTarget(value: unknown): StrictMediaTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const quality = typeof item.quality === "string" ? item.quality.trim().slice(0, 64) : "";
  const normalizedEncoding = typeof item.encoding === "string" ? item.encoding.trim().toUpperCase() : "";
  const encoding = (["HEVC", "AVC", "AV1"] as const).find((candidate) => candidate === normalizedEncoding);
  return quality || encoding ? { quality: quality || undefined, encoding } : undefined;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly activeSyncUsers = new Set<string>();
  private acceptingJobs = true;
  private configStore: ConfigStore;
  private userStore: UserStore;
  private stateManager: StateManager;

  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  private verificationQueue: TaskQueue;
  private readonly jobStore: PersistentJobStore;
  private readonly transferSessions: TransferSessionStore;
  private readonly leaseOwner = crypto.randomUUID();
  private jobDispatchTimer: NodeJS.Timeout | null = null;
  private leaseHeartbeatTimer: NodeJS.Timeout | null = null;
  private localCleanupRetryTimer: NodeJS.Timeout | null = null;
  private localCleanupSweepPromise: Promise<void> | null = null;
  private readonly localCleanupInFlight = new Map<string, Promise<void>>();
  private readonly localCleanupRetries = new Map<string, { attempts: number; nextAt: number; localDir: string }>();
  private accessProbePromise: Promise<void> | null = null;
  private accessProbeJobId: string | null = null;
  private legacyTempRecoveryPromise: Promise<void> | null = null;
  private legacyTempRecoveryPending = false;
  private readonly hotScanMinPages = 3;
  private readonly hotScanMaxPages = 12;
  private readonly hotScanBurstBudget = 3;
  private readonly historyPagesPerTick = 2;
  private readonly initialHistoryPagesPerTick = 12;
  private readonly manualHistoryPagesPerTick = 20;
  private readonly remoteVerifyPerTick = 25;
  private readonly remoteVerifyPerTickNoNew = 120;
  private readonly remoteVerifyPerTickManual = 200;
  private readonly staleActiveBackupMs = 20 * 60_000;
  private remoteVerifyNextAllowedAt = 0;
  private remoteDirListingCache = new Map<string, { expiresAt: number; names: string[] }>();
  private readonly remoteDirListingCacheTtlMs = 30_000;
  private remoteVerifyPathQueue = new Map<string, number>();
  private pendingTickOptions: TickOptions | null = null;
  private cleanupLocked = false;
  private pathMigrationLocked = false;
  private pathMigrationMaintenance: { id: string; status: string; sourceRoot: string; destinationRoot: string } | null = null;
  private archiveDeletionLocked = false;
  private archiveDeletionMaintenance: {
    id: string;
    status: string;
    scope: string;
    userId?: string;
    mediaId?: number;
    bvid?: string;
  } | null = null;
  private uploadProbeTimer: NodeJS.Timeout | null = null;
  private readonly uploadCircuit = new UploadCircuitBreaker();
  private readonly downloadApiHealth = new DownloadApiHealth();
  private nextDownloadStartAt = 0;
  private downloadStartTimer: NodeJS.Timeout | null = null;
  private selfVisibleProbeCache = new Map<string, { expiresAt: number; item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number] }>();
  private schedulerProgress: SchedulerSnapshot | null = null;
  private nextAutoRunAt?: number;
  private lastSchedulerError = "";
  private localCacheSnapshot: LocalCacheSnapshot | null = null;
  private localCacheRefresh: Promise<LocalCacheSnapshot> | null = null;
  private localCacheRefreshQueued = false;
  private downloadRecoverySnapshot: DownloadRecoverySummary = {
    resumableSessions: 0,
    completedPages: 0,
    totalPages: 0,
    retainedBytes: 0,
    legacyDirectories: 0,
    legacyBytes: 0,
    cleanupEligibleBytes: 0,
  };
  private readonly localCacheSnapshotTtlMs = 10_000;
  private readonly persistentJobWakeMinMs = 1_000;
  private readonly videoAccessProbe: NonNullable<SchedulerDependencies["videoAccessProbe"]>;
  private readonly cacheInspector: NonNullable<SchedulerDependencies["cacheInspector"]>;
  private readonly remoteFileInspector: NonNullable<SchedulerDependencies["remoteFileInspector"]>;
  private readonly legacyTempDir: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly retirementAbortedJobIds = new Set<string>();
  private readonly qualityArtifactCleanupLocks = new Set<string>();
  private recoveryAutomationTimer: NodeJS.Timeout | null = null;
  private recoveryAutomationStartupTimer: NodeJS.Timeout | null = null;
  private recoveryAutomationPromise: Promise<void> | null = null;
  private transferSessionRecoveryReconciledAt = 0;
  private readonly recoveryJobLocks = new Set<string>();
  private readonly recoveryJobPromises = new Map<string, Promise<any>>();
  private readonly recoveryAutomationIntervalMs = 5 * 60_000;

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: ConfigStore, userStore: UserStore, stateManager: StateManager, dependencies: SchedulerDependencies = {}) {
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;
    this.videoAccessProbe = dependencies.videoAccessProbe || getVideoPageSnapshot;
    this.cacheInspector = dependencies.cacheInspector || inspectDownloadCache;
    this.remoteFileInspector = dependencies.remoteFileInspector || inspectRemoteFileSize;
    this.legacyTempDir = dependencies.legacyTempDir || tempDir;
    this.now = dependencies.now || Date.now;
    this.random = dependencies.random || Math.random;
    this.jobStore = new PersistentJobStore(this.stateManager.getDatabase());
    this.transferSessions = new TransferSessionStore(this.stateManager.getDatabase());

    const config = this.configStore.get();
    this.uploadCircuit.restore(this.stateManager.getUploadCooldown() as any);
    this.downloadApiHealth.configure(config.bbdownApiMode || "web");
    const persistedApiCooldown = typeof (this.stateManager as any).getDownloadApiCooldown === "function"
      ? this.stateManager.getDownloadApiCooldown()
      : null;
    this.downloadApiHealth.restore(persistedApiCooldown);
    if (config.bbdownApiMode === "app" && typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1, this.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit));
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2, this.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit));
    this.verificationQueue = new TaskQueue(
      Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)),
      this.queueHighWater(config.remoteVerifyConcurrency || 3, config.queuePrefetchLimit)
    );
    this.downloadQueue.setStartGate((task) => {
      if (!(task instanceof DownloadTask) && !(task instanceof QualityUpgradeDownloadTask)) return false;
      return this.canStartDownloadTask(task);
    });
    this.uploadQueue.setStartGate((task) => !this.pathMigrationLocked
      && !this.isArchiveDeletionTargetBlocked(task)
      && this.uploadCircuit.allowUploadStart(this.uploadTaskKey(task)));
    this.verificationQueue.setStartGate((task) => !this.pathMigrationLocked
      && !this.isArchiveDeletionTargetBlocked(task)
      && this.uploadCircuit.allowUploadStart(`verify:${(task as any).bvid || task.id}`));
    this.refreshLocalCacheAndWake(true);

    const logTaskError = (task: any, error: any) => {
      const label = error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed";
      console.error(`[Queue] Task ${task.name} ${label}: ${sanitizeUploadText(error?.message || error)}`);
    };
    const logTaskRetry = (task: any, error: any) => console.warn(
      `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${sanitizeUploadText(error?.message || error)}`
    );

    this.downloadQueue.on("taskStart", (task: DownloadTask | QualityUpgradeDownloadTask) => {
      this.markDownloadTaskStarted();
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 30 * 60_000);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.qualityStage = "download";
        task.control.qualityStageLabel = this.qualityDownloadStageLabel(task.control, "下载新版");
        this.syncQualityUpgradeControl(task, "running");
      }
    });
    this.uploadQueue.on("taskStart", (task: UploadTask | QualityUploadPhaseTask) => {
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 30 * 60_000);
      if (isQualityUploadPhaseTask(task)) {
        task.control.error = undefined;
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = task instanceof QualityUpgradeCleanupTask
          ? "清理旧文件备份"
          : (task instanceof QualityUpgradeReplaceTask ? "替换远端文件" : "上传新版到临时目录");
        this.syncQualityUpgradeControl(task, "running");
      }
    });

    this.downloadQueue.on("taskError", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      if (isSourceUnavailableFailure(error)) {
        this.handleSourceUnavailableTask(task, error);
        return;
      }
      if (task instanceof DownloadTask && task.encodingRetry) {
        this.handleEncodingRetryDownloadError(task, error);
        return;
      }
      if (error?.chargingRestricted) {
        this.handleChargingRestrictedTask(task, error);
        return;
      }
      if (task.persistentJobId && this.retirementAbortedJobIds.delete(task.persistentJobId)) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: "info",
          summary: `账号已退役，下载会话未执行自动清理 ${task.bvid}`,
          raw: `[Account] credential-dependent task stopped without recording a download failure: ${task.bvid}`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        this.dispatchPersistentJobs();
        return;
      }
      const safeTaskError = sanitizeUploadText(error?.message || error, 1_000);
      logTaskError(task, error);
      const apiRetryAt = this.handleDownloadApiFailure(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.error = error;
        if (task.persistentJobId) {
          const downloadFailure = classifyDownloadRecoveryFailure(error);
          const qualityFailure = {
            stage: "download",
            category: downloadFailure.category,
            summary: downloadFailure.summary,
            encodingEligible: downloadFailure.recoverable
              && /(?:codec|encoding|编码|hevc|av1|avc|视频流|video\s*stream|no available video)/i.test(downloadFailure.summary),
            qualityEligible: Boolean(error?.qualityValidation),
            occurredAt: this.now(),
            ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
            ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
          };
          const qualityPayload = { ...this.serializeQualityUpgrade(task.control), qualityFailure };
          this.jobStore.updatePayload(task.persistentJobId, qualityPayload);
          if (error?.permanent && !downloadFailure.recoverable) {
            this.jobStore.complete(task.persistentJobId, this.leaseOwner);
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
          } else if (error?.permanent) {
            this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, downloadFailure.summary, {
              ...qualityPayload,
              awaitingManualRecovery: true,
            });
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
          } else if (apiRetryAt) {
            task.control.qualityStageLabel = "B站风控冷却后重试下载新版";
            this.syncQualityUpgradeControl(task, "retry_wait");
            this.jobStore.defer(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), apiRetryAt);
          } else {
            const job = task.persistentJob as any;
            const retryAt = Date.now() + computeTaskRetryDelayMs(this.configStore.get().retryDelaySeconds, Number(job?.attempts || 0), error?.retryAfterMs);
            const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), retryAt);
            const automaticRecovery = result.exhausted
              ? this.queueAutomaticQualityRecovery(task.persistentJobId, error?.uploadFailure || classifyUploadError(error, task.bvid))
              : false;
            this.syncQualityUpgradeControl(task, result.exhausted && !automaticRecovery ? "error" : "retry_wait");
            if (result.exhausted && !automaticRecovery) task.control.onFailed?.(task.control, error);
          }
          this.dispatchPersistentJobs();
          return;
        }
        this.syncQualityUpgradeControl(task, "error");
        task.control.error = error;
        task.control.onFailed?.(task.control, error);
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "error",
        summary: `下载失败 ${task.bvid}: ${safeTaskError}${error?.permanent ? "（已停止自动重试）" : (error?.deferToNextCycle ? "（下一轮再试）" : "")}`,
        raw: `[Queue] Task ${task.name} ${error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed"}: ${safeTaskError}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
      const downloadFailure = classifyDownloadRecoveryFailure(error);
      const targets = this.collectUploadTargets(task.bvid, task.targets || this.makeSingleTarget(task));
      const session = task.downloadDir ? readDownloadSession(task.downloadDir) : null;
      if (task.downloadDir && session && (!error?.permanent || downloadFailure.recoverable)) {
        this.stateManager.markDownloadInterrupted(task.bvid, task.downloadDir, safeTaskError || "Download failure", targets);
      } else {
        for (const target of targets) {
          this.stateManager.markRelationRetryPending(task.bvid, target.userId, target.mediaId, safeTaskError || "Download failure");
          this.stateManager.markFailed(
            target.userId,
            task.bvid,
            target.mediaId,
            safeTaskError || "Download failure",
            Boolean(error?.permanent && !downloadFailure.recoverable),
          );
        }
      }
      if (task.persistentJobId) {
        const recoveryPayload = {
          awaitingManualRecovery: true,
          downloadRecovery: {
            category: downloadFailure.category,
            kind: downloadFailure.kind,
            summary: downloadFailure.summary,
            occurredAt: this.now(),
            downloadUserId: task.downloadUserId || task.userId,
            targets: targets.map((target) => ({ ...target })),
          },
          ...(task.qualityStrict || task.qualityEncodingOverride?.strict
            ? {
              qualityFailure: {
                stage: "download",
                category: downloadFailure.category,
                summary: downloadFailure.summary,
                qualityEligible: Boolean(task.qualityStrict && error?.qualityValidation),
                encodingEligible: Boolean(task.qualityEncodingOverride?.strict && error?.encodingValidation),
                ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
                ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
                occurredAt: this.now(),
              },
            }
            : {}),
        };
        if (error?.permanent && !downloadFailure.recoverable) {
          this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        } else if (apiRetryAt) {
          this.jobStore.defer(task.persistentJobId, this.leaseOwner, sanitizeUploadText(error?.message || error), apiRetryAt);
        } else if (error?.permanent) {
          this.jobStore.parkManualRecovery(
            task.persistentJobId,
            this.leaseOwner,
            sanitizeUploadText(error?.message || error),
            recoveryPayload,
          );
        } else {
          const job = task.persistentJob as any;
          const retryIndex = Number(job?.attempts || 0);
          const retryAt = Date.now() + computeTaskRetryDelayMs(
            this.configStore.get().retryDelaySeconds,
            retryIndex,
            error?.retryAfterMs
          );
          const result = this.jobStore.retryDownloadWithManualFallback(
            task.persistentJobId,
            this.leaseOwner,
            sanitizeUploadText(error?.message || error),
            retryAt,
            recoveryPayload,
          );
          if (result.exhausted) {
            for (const target of targets) {
              this.stateManager.markFailed(target.userId, task.bvid, target.mediaId, safeTaskError || "Download failure", false);
            }
          }
        }
      }
      this.dispatchPersistentJobs();
    });
    this.downloadQueue.on("taskRetry", (task: DownloadTask | QualityUpgradeDownloadTask, error: any) => {
      logTaskRetry(task, error);
      this.handleDownloadApiFailure(task, error);
      if (task instanceof QualityUpgradeDownloadTask) {
        this.syncQualityUpgradeControl(task, "retry_wait");
        task.control.qualityStage = "download";
        task.control.qualityStageLabel = "等待重试下载新版";
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `${task instanceof QualityUpgradeDownloadTask ? "画质重调下载失败" : "下载失败"}，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        raw: `[Queue] Task ${task.name} failed (retrying ${task.retries}/${task.maxRetries}): ${error?.message || error}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
    });
    this.uploadQueue.on("taskError", (task: UploadTask | QualityUploadPhaseTask, error: any) => {
      if (task instanceof UploadTask && task.encodingRetry) {
        this.handleEncodingRetryUploadError(task, error);
        return;
      }
      if (error?.uploadSessionStale) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        this.dispatchPersistentJobs();
        return;
      }
      const failure = this.recordUploadFailure(task, error);
      if (task.persistentJobId && (failure.remoteErrorCode || failure.responseHeaders || failure.responseSnippet || failure.remoteWriteStatus || failure.remoteParentStatus)) {
        const current = this.jobStore.findById(task.persistentJobId);
        if (current) {
          this.jobStore.updatePayload(task.persistentJobId, {
            ...current.payload,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            ...(failure.remoteWriteStatus ? { remoteWriteStatus: failure.remoteWriteStatus } : {}),
            ...(failure.remoteParentStatus ? { remoteParentStatus: failure.remoteParentStatus } : {}),
          });
        }
      }
      const strictEncodingFailure = Boolean(error?.encodingValidation);
      const strictQualityFailure = Boolean(error?.qualityValidation);
      const manualConflict = !isQualityUploadPhaseTask(task)
        && failure.category === "deterministic"
        && failure.status === 409;
      const remoteSizeLimit = !isQualityUploadPhaseTask(task)
        && failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE;
      const remoteWriteRejected = !isQualityUploadPhaseTask(task)
        && failure.remoteWriteEvidence === "target_missing_parent_visible";
      const authorizedRecovery = task instanceof UploadTask && task.reuploadPermissionUsed;
      if (!manualConflict && !remoteSizeLimit && !remoteWriteRejected) logTaskError(task, error);
      if (isQualityUploadPhaseTask(task)) {
        task.control.error = error;
        if (task.persistentJobId) {
          const qualityFailure = {
            stage: task instanceof QualityUpgradeUploadReplaceTask
              ? "upload"
              : (task instanceof QualityUpgradeReplaceTask ? "replace" : "cleanup"),
            category: failure.category,
            code: failure.code,
            status: failure.status,
            summary: failure.summary,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            encodingEligible: task instanceof QualityUpgradeUploadReplaceTask
              && (failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE
                || failure.remoteWriteEvidence === "target_missing_parent_visible"
                || /(?:codec|encoding|编码|hevc|av1|avc)/i.test(failure.summary)),
            qualityEligible: strictQualityFailure || (task instanceof QualityUpgradeUploadReplaceTask
              && /(?:quality|画质|分辨率|清晰度)/i.test(failure.summary)),
            occurredAt: this.now(),
            ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
            ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
          };
          const qualityPayload = {
            ...this.serializeQualityUpgrade(task.control),
            qualityFailure,
          };
          if (strictEncodingFailure || strictQualityFailure) {
            this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, failure.summary, {
              ...qualityPayload,
              awaitingManualRecovery: true,
            });
            task.control.qualityStageLabel = strictQualityFailure ? "画质不可用，等待选择" : "编码不可用，等待选择";
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
            this.dispatchPersistentJobs();
            return;
          }
          this.jobStore.updatePayload(task.persistentJobId, qualityPayload);
          if (task instanceof QualityUpgradeCleanupTask) {
            const attempts = Number((task.persistentJob as any)?.attempts || 0);
            const circuitRetryAt = this.uploadCircuit.getRetryAt();
            const retryAt = circuitRetryAt && circuitRetryAt > Date.now()
              ? circuitRetryAt
              : Date.now() + computeQualityCleanupRetryDelayMs(attempts, this.random);
            this.jobStore.retryIndefinitely(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
            task.control.qualityStageLabel = "旧文件清理重试中";
            this.syncQualityUpgradeControl(task, "retry_wait");
            this.dispatchPersistentJobs();
            return;
          }
           const retryAt = this.uploadCircuit.getRetryAt() || Date.now() + Math.max(60_000, failure.retryAfterMs || 0);
           const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
           const automaticRecovery = result.exhausted
             ? this.queueAutomaticQualityRecovery(task.persistentJobId, failure)
             : false;
           this.syncQualityUpgradeControl(task, result.exhausted && !automaticRecovery ? "error" : "retry_wait");
           task.control.qualityStageLabel = result.exhausted && !automaticRecovery ? "画质重调失败" : "等待上传后端恢复";
           if (result.exhausted && !automaticRecovery) task.control.onFailed?.(task.control, error);
          this.dispatchPersistentJobs();
          return;
        }
        this.syncQualityUpgradeControl(task, "error");
        task.control.onFailed?.(task.control, error);
        return;
      }
      const uploadHealth = this.uploadCircuit.getSnapshot();
      const isolatedDeterministicFailure = failure.category === "deterministic" && uploadHealth.state === "closed";
      if (task.persistentJobId) {
        if (manualConflict || authorizedRecovery || remoteSizeLimit || remoteWriteRejected) {
          const assessment = remoteSizeLimit
            ? {
              kind: "remote_size_limit" as const,
              checkedAt: Date.now(),
              localStatus: "available" as const,
              remoteStatus: "size_limit" as const,
              remoteErrorCode: failure.remoteErrorCode,
              responseHeaders: failure.responseHeaders,
              responseSnippet: failure.responseSnippet,
              summary: failure.summary,
            }
            : remoteWriteRejected
              ? {
                kind: "remote_write_rejected" as const,
                checkedAt: Date.now(),
                localStatus: "available" as const,
                remoteStatus: "missing" as const,
                writeStatus: failure.remoteWriteStatus || failure.status,
                writeEvidence: failure.remoteWriteEvidence,
                remoteErrorCode: failure.remoteErrorCode,
                responseHeaders: failure.responseHeaders,
                responseSnippet: failure.responseSnippet,
                summary: `远端拒绝了写入，但目标文件仍不可见、父目录可见；WebDAV没有返回足够信息确定是大小限制、驱动限制还是最终一致性问题${failure.remoteErrorCode ? `（远端错误码 ${failure.remoteErrorCode}）` : ""}。可尝试一次换编码，不代表已确认是大小限制。`,
              }
            : manualConflict
              ? {
                kind: "remote_size_conflict" as const,
                checkedAt: Date.now(),
                localStatus: "available" as const,
                remoteStatus: "mismatch" as const,
                summary: "正式远端路径存在冲突文件；系统会把当前完整候选放入隔离目录，不覆盖原文件。",
              }
              : undefined;
          const parked = this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, failure.summary, {
            awaitingManualRecovery: true,
            allowReupload: false,
            resumeOnly: true,
            manualRecoveryReason: failure.summary,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            ...(failure.remoteWriteStatus ? { remoteWriteStatus: failure.remoteWriteStatus } : {}),
            ...(failure.remoteParentStatus ? { remoteParentStatus: failure.remoteParentStatus } : {}),
            ...(assessment ? { recoveryAssessment: assessment } : {}),
          });
            if (parked) {
            if (!task.historyOnly) {
              this.markUploadTaskFailed(task, failure.summary);
            }
            logManager.push({
              timestamp: new Date().toISOString(),
              type: "upload",
              level: "error",
              summary: remoteSizeLimit
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端单文件限制暂停 ${task.bvid}：请检查存储设置后再继续`
                : remoteWriteRejected
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端写入结果未确认而暂停 ${task.bvid}：可尝试一次换编码；未执行归档替换`
                : manualConflict
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端文件冲突暂停 ${task.bvid}：请处理冲突后重新确认或继续上传`
                : `${task.historyOnly ? "历史分P" : "上传"}授权重传失败，已暂停 ${task.bvid}：请手动重新确认`,
              raw: this.formatUploadFailureLog(task, failure),
              bvid: task.bvid,
              simpleVisible: true,
            });
            if (manualConflict && !task.conflictCandidateAttempted && !task.persistentJob?.payload?.conflictCandidateOnly && task.persistentJobId) {
              this.startConflictCandidate(task.persistentJobId, true);
            }
            this.dispatchPersistentJobs();
            return;
          }
        }
        const retryDelayMs = error?.uploadSessionTransient
          ? computeUploadSessionRetryDelayMs(Number(task.persistentJob?.attempts || 0))
          : (isolatedDeterministicFailure ? ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS : Math.max(60_000, failure.retryAfterMs || 0));
        const retryAt = uploadHealth.retryAt || Date.now() + retryDelayMs;
        if (!task.historyOnly) {
          this.markUploadTaskFailed(task, failure.summary);
        }
        const retry = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "error",
          summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}${retry.exhausted ? "（已达到重试上限）" : "（未执行本地清理）"}`,
          raw: this.formatUploadFailureLog(task, failure),
          bvid: task.bvid,
          simpleVisible: true,
        });
        this.dispatchPersistentJobs();
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}（未执行本地清理）`,
        raw: this.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
      if (!task.historyOnly) this.markUploadTaskFailed(task, failure.summary);
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    });
    this.uploadQueue.on("taskRetry", (task: UploadTask | QualityUploadPhaseTask, error: any) => {
      logTaskRetry(task, error);
      const failure = this.recordUploadFailure(task, error);
      if (isQualityUploadPhaseTask(task)) {
        this.syncQualityUpgradeControl(task, "retry_wait");
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待重试上传替换";
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "warn",
        summary: `${isQualityUploadPhaseTask(task) ? "画质重调阶段失败" : "上传失败"}，等待重试 ${task.bvid} (${task.retries}/${task.maxRetries}): ${failure.summary}`,
        raw: this.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
    });

    this.downloadQueue.on("taskCompleted", (task: DownloadTask | QualityUpgradeDownloadTask) => {
      if ((task instanceof DownloadTask && task.sourceUnavailable)
        || (task instanceof QualityUpgradeDownloadTask && task.control.sourceUnavailable)) {
        this.handleSourceUnavailableTask(
          task,
          { availabilityReason: task instanceof DownloadTask
            ? task.availabilityReason
            : task.control.availabilityReason },
        );
        return;
      }
      if (task instanceof DownloadTask && task.encodingRetry && !this.isEncodingRetryParentActive(task.encodingRetry)) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        this.dispatchPersistentJobs();
        return;
      }
      this.refreshLocalCacheState();
      if (task instanceof QualityUpgradeDownloadTask) {
        const strictEncoding = task.control.qualityEncodingOverride?.strict
          ? task.control.qualityEncodingOverride.priority[0]
          : undefined;
        if (strictEncoding && task.control.downloadDir) {
          const assessment = assessStrictEncoding(task.control.downloadDir, strictEncoding, task.control.outputFiles);
          if (assessment.status !== "matched") {
            const error = createStrictEncodingValidationError(assessment, "upload_preflight");
            markDownloadSessionStatus(task.control.downloadDir, "failed", error.message);
            task.control.error = error;
            const qualityPayload = {
              ...this.serializeQualityUpgrade(task.control),
              awaitingManualRecovery: true,
              qualityFailure: {
                stage: "download",
                category: "tool",
                code: error.code,
                summary: assessment.summary,
                encodingEligible: true,
                occurredAt: this.now(),
                ...strictEncodingDiagnosticPatch(assessment),
              },
            };
            if (task.persistentJobId) {
              this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, assessment.summary, qualityPayload);
            }
            task.control.qualityStageLabel = "编码不可用，等待选择";
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
            this.dispatchPersistentJobs();
            return;
          }
        }
        const strictQuality = task.control.qualityStrict ? task.control.qualityProfile.quality : undefined;
        if (strictQuality && task.control.downloadDir) {
          const assessment = assessStrictQuality(task.control.downloadDir, strictQuality, task.control.outputFiles);
          if (assessment.status !== "matched") {
            const error = new StrictQualityValidationError(assessment, "upload_preflight");
            markDownloadSessionStatus(task.control.downloadDir, "failed", error.message);
            task.control.error = error;
            const qualityPayload = {
              ...this.serializeQualityUpgrade(task.control),
              awaitingManualRecovery: true,
              qualityFailure: {
                stage: "download",
                category: "tool",
                code: error.code,
                summary: assessment.summary,
                qualityEligible: true,
                occurredAt: this.now(),
                ...strictQualityDiagnosticPatch(assessment),
              },
            };
            if (task.persistentJobId) {
              this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, assessment.summary, qualityPayload);
            }
            task.control.qualityStageLabel = "画质不可用，等待选择";
            this.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
            this.dispatchPersistentJobs();
            return;
          }
        }
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待上传替换";
        const persisted = task.persistentJobId ? this.jobStore.findById(task.persistentJobId) : null;
        const targets = this.filterArchiveDeletionTargets(
          task.bvid,
          this.qualityTargetsFromPayload(persisted?.payload as any, task.control.targets),
        );
        task.control.setTargets(targets);
        if (task.control.downloadDir) {
          const manifest = readDownloadSession(task.control.downloadDir);
          if (manifest?.qualityUpgrade && manifest.bvid === task.bvid) {
            manifest.qualityUpgrade = {
              ...manifest.qualityUpgrade,
              ...targets[0],
              artifactKey: task.control.artifactKey,
              qualityProfile: task.control.qualityProfile,
              downloadUserId: task.control.downloadUserId,
              targets,
            };
            writeDownloadSession(task.control.downloadDir, manifest);
          }
        }
        const nextJobs: EnqueuePersistentJob[] = targets.map((target) => ({
          kind: "quality_upload",
          dedupeKey: `quality-upload:${target.userId}:${target.mediaId}:${task.bvid}`,
          bvid: task.bvid, userId: target.userId, mediaId: target.mediaId, priority: 30,
          maxAttempts: this.configStore.get().maxRetries + 1,
          payload: this.serializeQualityUpgrade(task.control, target, task.control.targets),
        }));
        if (task.persistentJobId) {
          const transitioned = this.jobStore.completeAndEnqueue(task.persistentJobId, this.leaseOwner, nextJobs);
          if (!transitioned) throw new Error("Quality download execution ownership changed before transition");
        } else this.jobStore.enqueueBatch(nextJobs);
        this.dispatchPersistentJobs();
        return;
      }
      if (!task.downloadDir) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        return;
      }
      const targets = this.collectUploadTargets(task.bvid, task.targets || this.makeSingleTarget(task));
      const encodingRetry = task.encodingRetry;
      if (encodingRetry?.strict) {
        const assessment = assessStrictEncoding(task.downloadDir, encodingRetry.priority[0], task.outputFiles);
        if (assessment.status !== "matched") {
          const error = createStrictEncodingValidationError(assessment, "upload_preflight");
          markDownloadSessionStatus(task.downloadDir, "failed", error.message);
          this.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            assessment.summary,
            assessment.status === "mismatch" ? "mismatch" : "unknown",
            task.persistentJobId,
            "encoding_retry_failed",
            strictEncodingDiagnosticPatch(assessment),
          );
          return;
        }
      }
      if (encodingRetry?.quality) {
        const assessment = assessStrictQuality(task.downloadDir, encodingRetry.quality, task.outputFiles);
        if (assessment.status !== "matched") {
          const error = new StrictQualityValidationError(assessment, "upload_preflight");
          markDownloadSessionStatus(task.downloadDir, "failed", error.message);
          this.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            assessment.summary,
            assessment.status === "mismatch" ? "mismatch" : "unknown",
            task.persistentJobId,
            "encoding_retry_failed",
            strictQualityDiagnosticPatch(assessment),
          );
          return;
        }
      }
      const historyGroups = encodingRetry ? [] : historySessionGroups(task.downloadDir);
      const strictMediaTarget: StrictMediaTarget = {
        quality: task.qualityStrict ? task.qualityProfile?.quality : undefined,
        encoding: task.qualityEncodingOverride?.strict ? task.qualityEncodingOverride.priority[0] : undefined,
      };
      const persistedStrictMediaTarget = strictMediaTarget.quality || strictMediaTarget.encoding
        ? strictMediaTarget
        : undefined;
      if (encodingRetry) {
        if (!task.persistentJobId) throw new Error("Encoding retry download transition requires a persistent child job");
        const uploadInputs = targets.map((target) => this.buildPersistentUploadJob({
          bvid: task.bvid,
          localDir: task.downloadDir!,
          remotePath: target.remotePath,
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: task.videoTitle || "",
          upperName: task.upperName || "",
          cover: task.cover || "",
          files: task.outputFiles,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(task.downloadDir!, task.outputFiles),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          encodingRetry,
          strictMediaTarget: persistedStrictMediaTarget,
        }));
        if (uploadInputs.length === 0) {
          this.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "候选下载已完成，但当前收藏来源无法建立替换上传任务；未执行归档替换。",
            "unknown", task.persistentJobId);
          return;
        }
        const transitioned = this.jobStore.transitionEncodingRetryChildren(
          encodingRetry.parentJobId,
          encodingRetry.generation,
          task.persistentJobId,
          this.leaseOwner,
          "uploading",
          uploadInputs,
        );
        if (!transitioned) {
          this.dispatchPersistentJobs();
          return;
        }
        this.dispatchPersistentJobs();
        return;
      }
      for (const target of targets) {
        this.queueUploadWork({
          bvid: task.bvid,
          localDir: task.downloadDir!,
          remotePath: target.remotePath,
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: task.videoTitle || "",
          upperName: task.upperName || "",
          cover: task.cover || "",
          files: task.outputFiles,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(task.downloadDir!, task.outputFiles),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          strictMediaTarget: persistedStrictMediaTarget,
        }, false);
        for (const history of historyGroups) {
          this.queueUploadWork({
            bvid: task.bvid,
            localDir: task.downloadDir!,
            remotePath: joinRemotePath(target.remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
            userId: target.userId,
            mediaId: target.mediaId,
            folderTitle: target.folderTitle,
            videoTitle: task.videoTitle || "",
            upperName: task.upperName || "",
            cover: task.cover || "",
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
            automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          }, false);
        }
      }
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (targets.length === 0) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
      this.dispatchPersistentJobs();
    });

    this.uploadQueue.on("taskCompleted", (task: UploadTask | QualityUploadPhaseTask) => {
      const encodingRetry = task instanceof UploadTask ? task.encodingRetry : undefined;
      if (encodingRetry && !this.isEncodingRetryParentActive(encodingRetry)) {
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        this.dispatchPersistentJobs();
        return;
      }
      const taskKey = this.uploadTaskKey(task);
      if (this.uploadCircuit.recordSuccess(taskKey)) {
        this.stateManager.clearUploadCooldown();
        this.clearUploadProbeTimer();
      }
      if (isQualityUploadPhaseTask(task)) {
        if (task instanceof QualityUpgradeUploadReplaceTask || task instanceof QualityUpgradeReplaceTask) {
          const nextJob: EnqueuePersistentJob = task instanceof QualityUpgradeUploadReplaceTask
            ? { kind: "quality_replace", dedupeKey: `quality-replace:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 30, maxAttempts: this.configStore.get().maxRetries + 1, payload: this.serializeQualityUpgrade(task.control, task.control.target, task.control.targets) }
            : { kind: "quality_cleanup", dedupeKey: `quality-cleanup:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 60, maxAttempts: this.configStore.get().maxRetries + 1, payload: this.serializeQualityUpgrade(task.control, task.control.target, task.control.targets) };
          if (task.persistentJobId) {
            const transitioned = this.jobStore.completeAndEnqueue(task.persistentJobId, this.leaseOwner, [nextJob]);
            if (!transitioned) throw new Error("Quality phase execution ownership changed before transition");
          } else this.jobStore.enqueue(nextJob);
          this.syncQualityUpgradeControl(task, "pending");
        } else {
          // Cleanup commits archive proof, cleanup authorization and its job in
          // onCompletedUpgrade; do not complete the same job a second time.
          this.syncQualityUpgradeControl(task, "completed");
          if (task.control.downloadDir) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.control.downloadDir);
          this.refreshLocalCacheState();
        }
        this.dispatchPersistentJobs();
        return;
      }
      if (task.result?.disposition === "retained_existing_archive" && task.result.retainedProof) {
        if (encodingRetry) {
          this.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            "替换上传发现仍有可用的旧归档，未把未确认候选标记为成功。",
            "verified",
            task.persistentJobId,
          );
          return;
        }
        const restored = this.stateManager.restoreExistingArchiveProof(
          task.bvid,
          task.userId,
          task.mediaId,
          task.result.retainedProof,
        );
        if (!restored) {
          this.stateManager.markUploadFailed(
            task.bvid,
            task.downloadDir,
            task.userId,
            task.mediaId,
            "Existing archive proof was verified remotely but could not be restored to the relation.",
          );
        } else {
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `已保留旧归档，未上传或替换新版 ${task.bvid}`,
            raw: `[Upload] retained existing archive; local candidate superseded; files=${task.result.retainedProof.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
        }
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        if (restored) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
        this.dispatchPersistentJobs();
        return;
      }
      if (task.result?.disposition === "conflict_candidate" && task.result.conflictCandidate) {
        const candidate = {
          ...task.result.conflictCandidate,
          files: task.result.files.map((file) => ({ ...file })),
          verifiedAt: new Date().toISOString(),
        };
        const summary = `检测到远端冲突，新文件已安全上传到独立候选目录；正式旧路径未移动、覆盖或删除`;
        this.stateManager.recordRemoteConflictCandidate(task.bvid, task.userId, task.mediaId, {
          id: candidate.id,
          originalRemotePath: candidate.originalRemotePath,
          candidateRemotePath: candidate.candidateRemotePath,
          reasonCode: candidate.reasonCode,
          reasonSummary: candidate.reasonSummary,
          files: candidate.files,
          existingArchiveProof: candidate.existingArchiveProof,
        });
        const completeExisting = candidate.existingArchiveProof?.status === "verified";
        const completeCandidate = !task.partialBackup;
        if (!completeExisting) {
          this.stateManager.runAtomic(() => {
            this.stateManager.markVerifiedUpload(
              task.bvid,
              candidate.candidateRemotePath,
              candidate.files,
              task.userId,
              task.mediaId,
              task.partialBackup,
            );
            this.stateManager.resolveRemoteConflictCandidate(
              task.bvid,
              task.userId,
              task.mediaId,
              candidate.id,
              "selected_candidate",
            );
            this.supersedeUploadTaskSession(task);
            if (encodingRetry) {
              if (!task.persistentJobId || !this.jobStore.completeEncodingRetryCommit(
                encodingRetry.parentJobId,
                encodingRetry.generation,
                task.persistentJobId,
                this.leaseOwner,
              )) throw new Error("Encoding retry conflict candidate changed before commit");
            } else if (task.persistentJobId && !this.jobStore.complete(task.persistentJobId, this.leaseOwner)) {
              throw new Error("Conflict candidate upload execution changed before commit");
            }
          });
          if (encodingRetry) this.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          else {
            void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
            this.dispatchPersistentJobs();
          }
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `冲突候选已验证并自动采用 ${task.bvid}，未删除其他远端文件`,
            raw: `[Upload] conflict candidate automatically selected; files=${candidate.files.length}; reason=${candidate.reasonCode}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }        const retainedExisting = this.restoreConflictCandidateExistingArchive(task);
        if (!completeCandidate) {
          this.stateManager.resolveRemoteConflictCandidate(
            task.bvid,
            task.userId,
            task.mediaId,
            candidate.id,
            "kept_existing",
          );
          this.supersedeUploadTaskSession(task);
          const retainedSummary = "新候选仅包含部分可用内容，系统已继续保留完整旧归档；两份远端文件均未删除。";
          if (encodingRetry) {
            this.finishEncodingRetryFailure(
              task.bvid,
              encodingRetry,
              retainedSummary,
              "verified",
              task.persistentJobId,
            );
          } else {
            if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
            void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
            this.dispatchPersistentJobs();
          }
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `新候选不完整，已自动保留旧归档 ${task.bvid}`,
            raw: `[Upload] partial conflict candidate retained existing archive; files=${candidate.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }
        if (encodingRetry) {
          this.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            "替换文件已安全放入冲突候选目录，正式归档未被覆盖；请选择现有归档或新候选。",
            "verified",
            task.persistentJobId,
            "conflict_candidate_ready",
            { conflictCandidate: candidate },
          );
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "warn",
            summary: `编码替换产生冲突候选 ${task.bvid}：请在待处理中心选择` ,
            raw: `[EncodingRetry] conflict candidate ready; files=${candidate.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }
        if (task.persistentJobId) {
          this.jobStore.parkManualRecovery(task.persistentJobId, this.leaseOwner, summary, {
            awaitingManualRecovery: true,
            allowReupload: false,
            resumeOnly: true,
            conflictCandidate: candidate,
            recoveryAssessment: {
              kind: "conflict_candidate_ready",
              checkedAt: this.now(),
              localStatus: "available",
              remoteStatus: "verified",
              summary,
            },
          });
        }
        if (!retainedExisting) {
          this.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, summary);
        }
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `远端冲突候选已就绪 ${task.bvid}：请选择保留现有归档或采用候选`,
          raw: `[Upload] conflict candidate ready; files=${candidate.files.length}; reason=${candidate.reasonCode}`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        this.dispatchPersistentJobs();
        return;
      }
      if (encodingRetry) {
        if (!task.result?.files.length) {
          this.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "替换下载文件未产生可验证的上传结果；未执行归档替换。", "error", task.persistentJobId);
          return;
        }
        if (task.result.allVerified) {
          this.commitVerifiedTransfer(task, task.result, task.partialBackup, false, encodingRetry);
          this.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          return;
        }
        if (!task.persistentJobId) throw new Error("Encoding retry verification transition requires a persistent child job");
        const verificationInputs = this.buildUploadVerificationJobs(task, task.result.files, task.result.pendingChecks);
        if (verificationInputs.length === 0) {
          this.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "替换上传完成，但没有建立远端确认任务；未将候选提交为正式归档。", "unknown", task.persistentJobId);
          return;
        }
        this.stateManager.runAtomic(() => {
          this.stateManager.markUploadedPendingVerification(task.bvid, task.result!.remotePath, task.result!.files,
            task.userId, task.mediaId, task.partialBackup);
          const transitioned = this.jobStore.transitionEncodingRetryChildren(
            encodingRetry.parentJobId,
            encodingRetry.generation,
            task.persistentJobId!,
            this.leaseOwner,
            "verifying",
            verificationInputs,
          );
          if (!transitioned) throw new Error("Encoding retry upload changed before verification transition");
        });
        this.dispatchPersistentJobs();
        return;
      }
      if (task.historyOnly) {
        if (task.result?.files.length && task.historySnapshotAt && task.result.allVerified) {
          this.commitVerifiedTransfer(task, task.result, task.partialBackup, true);
          markHistoryGroupUploaded(task.downloadDir, task.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        } else if (task.result?.files.length) {
          this.enqueueUploadVerificationJobs(task, task.result.files, task.result.pendingChecks);
        }
        if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
        if (task.result?.allVerified) void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
        this.dispatchPersistentJobs();
        return;
      }
      if (task.result?.files.length && task.result.allVerified) {
        this.commitVerifiedTransfer(task, task.result, task.partialBackup);
      } else if (task.result?.files.length) {
        this.stateManager.markUploadedPendingVerification(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId,
          task.partialBackup
        );
        this.enqueueUploadVerificationJobs(task, task.result.files);
      } else {
        this.stateManager.markUploadFailed(
          task.bvid,
          task.downloadDir,
          task.userId,
          task.mediaId,
          "Upload finished without verified remote metadata."
        );
      }
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (task.result?.files.length && task.result.allVerified) {
        void this.maybeCleanupVerifiedLocalDir(task.bvid, task.downloadDir);
      }
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    });

    this.uploadQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
      this.downloadQueue.poke();
    });

    this.downloadQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
    });

    this.verificationQueue.on("taskStart", (task: UploadVerificationTask) => {
      if (task.persistentJobId) this.jobStore.markRunning(task.persistentJobId, this.leaseOwner, 5 * 60_000);
    });
    this.verificationQueue.on("taskCompleted", (task: UploadVerificationTask) => {
      this.handleUploadVerificationCompleted(task);
    });
    this.verificationQueue.on("taskError", (task: UploadVerificationTask, error: any) => {
      this.handleUploadVerificationError(task, error);
    });
    this.verificationQueue.on("taskSettled", () => {
      this.dispatchPersistentJobs();
    });

    if (this.uploadCircuit.getSnapshot().state !== "closed") this.scheduleUploadProbe();
    this.ensureLeaseHeartbeat();

  }

  private renewActiveLeases() {
    for (const queue of [this.downloadQueue, this.uploadQueue, this.verificationQueue]) {
      for (const task of queue.getTasks()) {
        if (task.status === "running" && task.persistentJobId) {
          this.jobStore.extendLease(task.persistentJobId, this.leaseOwner, 30 * 60_000);
        }
      }
    }
    if (this.accessProbeJobId) {
      this.jobStore.extendLease(this.accessProbeJobId, this.leaseOwner, 5 * 60_000);
    }
  }

  private ensureLeaseHeartbeat() {
    if (this.leaseHeartbeatTimer) return;
    this.leaseHeartbeatTimer = setInterval(() => this.renewActiveLeases(), 60_000);
    this.leaseHeartbeatTimer.unref?.();
  }

  private queueHighWater(concurrency = 1, batchSize = 25) {
    return Math.max(Math.max(1, concurrency) * 2, Math.max(5, batchSize));
  }

  private buildUploadVerificationJobs(task: UploadTask, files: Array<{
    path: string;
    size?: number;
    verificationStatus?: string;
    putCompletedAt?: string;
    localRelativePath?: string;
    nextVerifyAt?: string;
  }>, pendingChecks?: Array<{ remoteFile: string; expectedSize: number; finalFile: string; localRelativePath: string }>): EnqueuePersistentJob[] {
    const pendingFiles = files.filter((file) => file.verificationStatus === "awaiting_verification" && typeof file.size === "number");
    const historySegment = task.historyOnly ? `history:${task.historySnapshotAt || "unknown"}` : "main";
    const sessionGeneration = task.result?.sessionGeneration ?? task.sessionGeneration;
    const totalPages = Math.max(1, task.files?.length || files.length);
    const verifiedPages = files.filter((file) => file.verificationStatus === "verified").length;
    const recoveryLifecycleState = verifiedPages > 0 && verifiedPages < totalPages ? "partial_upload" : "remote_visibility_wait";
    const attemptKey = task.sessionId ? `${task.sessionId}:g${sessionGeneration || 1}` : undefined;
    if (task.sessionId && pendingFiles.length > 0) {
      const first = pendingFiles[0];
      const pending = pendingChecks?.find((item) => item.finalFile === first.path || item.localRelativePath === first.localRelativePath);
      const initialNextAt = Math.min(...pendingFiles.map((file) => {
        const parsed = file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : Date.now() + UPLOAD_VERIFY_SCHEDULE_MS[0];
      }));
      return [{
        kind: "verify_upload",
        dedupeKey: `verify-session:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${historySegment}:${task.sessionId}:g${sessionGeneration || 1}`,
        bvid: task.bvid,
        userId: task.userId,
        mediaId: task.mediaId,
        priority: task.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: initialNextAt,
        payload: {
          remoteFile: pending?.remoteFile || first.path,
          finalFile: first.path,
          expectedSize: first.size,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          files: task.files || [],
          filenameMetadataByPath: task.filenameMetadataByPath,
          localRelativePath: first.localRelativePath,
          putCompletedAt: first.putCompletedAt || new Date().toISOString(),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          historyOnly: task.historyOnly,
          historySnapshotAt: task.historySnapshotAt,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
          sessionId: task.sessionId,
          sessionGeneration,
          sessionVerification: true,
          encodingRetry: task.encodingRetry,
          strictMediaTarget: task.strictMediaTarget,
          lifecycleState: recoveryLifecycleState,
          verifiedPages,
          totalPages,
          attemptKey,
        },
      }];
    }
    const inputs: EnqueuePersistentJob[] = [];
    for (const file of pendingFiles) {
      const pending = pendingChecks?.find((item) => item.finalFile === file.path || item.localRelativePath === file.localRelativePath);
      const verificationPath = pending?.remoteFile || file.path;
      inputs.push({
        kind: "verify_upload",
        dedupeKey: `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${historySegment}:${verificationPath}`,
        bvid: task.bvid,
        userId: task.userId,
        mediaId: task.mediaId,
        priority: task.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now() + UPLOAD_VERIFY_SCHEDULE_MS[0],
        payload: {
          remoteFile: verificationPath,
          finalFile: file.path,
          expectedSize: file.size,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          files: task.files || [],
          filenameMetadataByPath: task.filenameMetadataByPath,
          localRelativePath: file.localRelativePath,
          putCompletedAt: file.putCompletedAt || new Date().toISOString(),
          partialBackup: task.partialBackup,
          historyOnly: task.historyOnly,
          historySnapshotAt: task.historySnapshotAt,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
          sessionId: task.sessionId,
          sessionGeneration,
          encodingRetry: task.encodingRetry,
          strictMediaTarget: task.strictMediaTarget,
          lifecycleState: recoveryLifecycleState,
          verifiedPages,
          totalPages,
          attemptKey,
        },
      });
    }
    return inputs;
  }

  private enqueueUploadVerificationJobs(task: UploadTask, files: Array<{
    path: string;
    size?: number;
    verificationStatus?: string;
    putCompletedAt?: string;
    localRelativePath?: string;
    nextVerifyAt?: string;
  }>, pendingChecks?: Array<{ remoteFile: string; expectedSize: number; finalFile: string; localRelativePath: string }>) {
    const created = this.jobStore.enqueueBatch(this.buildUploadVerificationJobs(task, files, pendingChecks));
    if (created.length > 0) this.dispatchPersistentJobs();
    return created.map((job) => job.id);
  }
  private buildDownloadTask(job: any) {
    const bvid = String(job.bvid || "");
    const payload = job.payload || {};
    const baseConfig = this.configStore.get();
    const encodingRetry = parseEncodingRetryContext(payload.encodingRetry);
    const retryTargetKeys = new Set<string>([
      ...(Array.isArray(payload.detachedTargets) ? payload.detachedTargets : []),
      ...(encodingRetry?.target ? [encodingRetry.target] : []),
    ].map((item: any) => `${String(item?.userId || "")}:${Number(item?.mediaId || 0)}`));
    const relations = this.stateManager.listRelationsForBvid(bvid)
      .filter((relation) => encodingRetry
        ? retryTargetKeys.has(`${relation.userId}:${relation.mediaId}`)
        : !["uploaded", "verified", "partial_verified", "downloaded", "uploading", "upload_failed"].includes(relation.backupStatus || ""))
      .filter((relation) => !this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, relation.bvid))
      .map((relation) => ({ relation, resolved: this.resolveRelation(relation) }))
      .filter((item): item is { relation: FavoriteRelation; resolved: NonNullable<ReturnType<SyncScheduler["resolveRelation"]>> } => Boolean(item.resolved));
    const preservedTargets: UploadTarget[] = Array.isArray(payload.detachedTargets)
      ? payload.detachedTargets.filter((item: any) =>
        item && typeof item.userId === "string" && Number.isInteger(Number(item.mediaId))
          && typeof item.folderTitle === "string" && typeof item.remotePath === "string"
          && !this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(String(item.userId), Number(item.mediaId), bvid)
      ).map((item: any) => ({
        userId: item.userId,
        mediaId: Number(item.mediaId),
        folderTitle: item.folderTitle,
        remotePath: item.remotePath,
      }))
      : [];
    if (encodingRetry?.target && !preservedTargets.some((target) => target.userId === encodingRetry.target!.userId && target.mediaId === encodingRetry.target!.mediaId)) {
      preservedTargets.push(encodingRetry.target);
    }
    if (relations.length === 0 && preservedTargets.length === 0) return null;

    const primary = relations.find((item) => item.relation.userId === payload.primaryUserId) || relations[0];
    const requestedDownloadUser = payload.downloadUserId
      ? this.userStore.getById(String(payload.downloadUserId))
      : null;
    const retryDownloadUser = encodingRetry?.target?.userId
      ? this.userStore.getById(encodingRetry.target.userId)
      : null;
    const downloadUser = requestedDownloadUser?.enabled
      ? requestedDownloadUser
      : (retryDownloadUser?.enabled ? retryDownloadUser : primary?.resolved.user);
    if (!downloadUser?.enabled) return null;
    const targetsByRelation = new Map<string, UploadTarget>();
    for (const target of preservedTargets) targetsByRelation.set(`${target.userId}:${target.mediaId}`, target);
    for (const { relation, resolved } of relations) {
      targetsByRelation.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: resolved.folderTitle,
        remotePath: relation.remotePath || this.resolveRelationRemotePath(resolved.user, relation.mediaId, resolved.folderTitle, baseConfig),
      });
    }
    const targets = [...targetsByRelation.values()];
    if (targets.length === 0) return null;
    const payloadQualityProfile = payload.qualityProfile && typeof payload.qualityProfile === "object"
      ? normalizeQualityArtifactProfile(payload.qualityProfile)
      : undefined;
    const qualityStrict = Boolean(payload.qualityStrict && payloadQualityProfile);
    const qualityEncodingOverride = parseQualityEncodingOverride(payload.qualityEncodingOverride);
    let taskConfig = payloadQualityProfile
      ? applyQualityArtifactProfile(baseConfig, payloadQualityProfile)
      : baseConfig;
    if (encodingRetry) {
      taskConfig = applyBBDownEncodingPreference(taskConfig, encodingRetry.priority, encodingRetry.strict);
    } else if (qualityEncodingOverride) {
      taskConfig = applyBBDownEncodingPreference(
        taskConfig,
        qualityEncodingOverride.priority,
        qualityEncodingOverride.strict,
      );
    }
    const task = new DownloadTask(bvid, downloadCredentialsForUser(downloadUser), taskConfig);
    task.maxRetries = 0;
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.userId = downloadUser.id;
    task.downloadUserId = downloadUser.id;
    task.mediaId = primary?.relation.mediaId || Number(payload.primaryMediaId || targets[0].mediaId);
    task.folderTitle = primary?.resolved.folderTitle || String(payload.primaryFolderTitle || targets[0].folderTitle);
    task.remotePath = targets[0]?.remotePath;
    task.targets = targets;
    task.encodingRetry = encodingRetry || undefined;
    task.qualityProfile = payloadQualityProfile;
    task.qualityStrict = qualityStrict;
    task.qualityEncodingOverride = qualityEncodingOverride || undefined;
    const exactArtifact = payloadQualityProfile && (qualityStrict || qualityEncodingOverride?.strict)
      ? String(payload.qualityArtifactKey || buildQualityArtifactKey(bvid, payloadQualityProfile))
      : "";
    task.downloadDirOverride = encodingRetry?.candidateLocalDir
      || (exactArtifact ? path.join(tempDir, `manual-${bvid}-${exactArtifact.slice(0, 16)}`) : undefined);
    task.automaticRecoveryAttempts = Math.max(0, Number(payload.automaticRecoveryAttempts || 0));
    const meta = this.stateManager.getVideoMeta(bvid);
    task.videoTitle = meta?.title || bvid;
    task.upperName = meta?.upperName || "";
    task.cover = meta?.cover || "";
    task.onApiReady = (readyTask, mode) => this.handleDownloadApiReady(readyTask, mode);
    task.onDownloading = () => this.stateManager.markDownloading(bvid, targets);
    task.onPrepared = (_task, downloadDir, manifest) => this.stateManager.markDownloadPrepared(
      bvid,
      downloadDir,
      {
        id: manifest.sessionId,
        localDir: downloadDir,
        kind: manifest.kind,
        status: manifest.status,
        completedPages: manifest.outputs.length,
        totalPages: manifest.pages.length,
        updatedAt: manifest.updatedAt,
      },
      targets
    );
    task.onDownloaded = (_task, downloadDir) => this.stateManager.markDownloaded(bvid, downloadDir, targets);
    return task;
  }

  private qualityTargetsFromPayload(payload: any, fallback: QualityUpgradeTarget[] = []) {
    const candidates = [
      ...(Array.isArray(payload?.targets) ? payload.targets : []),
      ...(payload?.target ? [payload.target] : []),
      ...fallback,
    ];
    const unique = new Map<string, QualityUpgradeTarget>();
    for (const candidate of candidates) {
      const userId = String(candidate?.userId || "");
      const mediaId = Number(candidate?.mediaId);
      const remotePath = String(candidate?.remotePath || "");
      if (!userId || !Number.isInteger(mediaId) || !remotePath) continue;
      const target: QualityUpgradeTarget = {
        userId,
        mediaId,
        folderTitle: String(candidate?.folderTitle || ""),
        remotePath,
        oldFiles: Array.isArray(candidate?.oldFiles) ? candidate.oldFiles : [],
      };
      unique.set(qualityUpgradeTargetKey(target), target);
    }
    return [...unique.values()];
  }

  private filterArchiveDeletionTargets<T extends { userId?: unknown; mediaId?: unknown }>(
    bvid: string,
    targets: T[],
  ) {
    return targets.filter((target) => !this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(
      String(target.userId || ""),
      Number(target.mediaId || 0),
      bvid,
    ));
  }

  private resolveQualityUpgradeTarget(job: any, payload: any, targets: QualityUpgradeTarget[]) {
    if (targets.length === 0) return null;
    const payloadTarget = payload?.target && typeof payload.target === "object"
      ? targets.find((candidate) => qualityUpgradeTargetKey(candidate) === qualityUpgradeTargetKey({
        userId: String(payload.target.userId || ""),
        mediaId: Number(payload.target.mediaId),
      }))
      : undefined;
    if (job.kind === "quality_download") {
      return payloadTarget || targets[0];
    }
    const jobUserId = String(job.userId || "");
    const jobMediaId = Number(job.mediaId);
    const exact = targets.find((candidate) => candidate.userId === jobUserId && candidate.mediaId === jobMediaId);
    if (exact) return exact;
    if (!jobUserId && !Number.isInteger(jobMediaId) && payloadTarget) return payloadTarget;
    if (targets.length === 1) return targets[0];
    return null;
  }

  private qualityDownloadStageLabel(task: QualityUpgradeTask, label: string) {
    return task.targets.length > 1 ? `${label} · ${task.targets.length}个目标` : label;
  }

  private qualityUpgradeProof(bvid: string, target: QualityUpgradeTarget, artifactKey?: string) {
    const proof = this.stateManager.getQualityUpgradeOperation(target.userId, target.mediaId, bvid);
    if (!proof) return null;
    if (artifactKey && proof.artifactKey && proof.artifactKey !== artifactKey) return null;
    return proof;
  }

  private mergeQualityProofFiles(
    payloadFiles: unknown,
    relationFiles: RemoteFileRecord[] | undefined,
  ) {
    if (relationFiles && relationFiles.length > 0) return relationFiles.map((file) => ({ ...file }));
    const merged = new Map<string, RemoteFileRecord>();
    const add = (value: unknown) => {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const file = item as RemoteFileRecord;
        const key = String(file.name || file.path || "");
        if (key) merged.set(key, { ...file });
      }
    };
    add(payloadFiles);
    return [...merged.values()];
  }

  private serializeQualityUpgrade(
    task: QualityUpgradeTask,
    target: QualityUpgradeTarget = task.target,
    targets: QualityUpgradeTarget[] = task.targets
  ) {
    const normalizedTargets = this.qualityTargetsFromPayload({ target, targets }, [target]);
    return {
      bvid: task.bvid,
      userId: target.userId,
      mediaId: target.mediaId,
      videoTitle: task.videoTitle || task.bvid,
      folderTitle: task.folderTitle || target.folderTitle,
      downloadUserId: task.downloadUserId || task.userId || target.userId,
      target,
      targets: normalizedTargets,
      targetCount: normalizedTargets.length,
      artifactKey: task.artifactKey,
      qualityProfile: task.qualityProfile,
      qualityStrict: task.qualityStrict,
      qualityEncodingOverride: task.qualityEncodingOverride,
      qualityStageLabel: task.qualityStageLabel,
      runId: task.runId,
      downloadDir: task.downloadDir,
      outputFiles: task.outputFiles || [],
      uploadResult: task.uploadResult,
      backupFiles: task.backupFiles || [],
      finalFiles: task.finalFiles || [],
      stageRemotePath: task.stageRemotePath,
      backupRemotePath: task.backupRemotePath,
    };
  }

  private buildQualityUpgradeTask(job: any) {
    const payload = job.payload || {};
    const bvid = String(payload.bvid || job.bvid || "");
    const artifactKey = String(payload.artifactKey || "");
    const fallbackProof = job.userId && Number.isInteger(Number(job.mediaId))
      ? this.stateManager.getQualityUpgradeOperation(String(job.userId), Number(job.mediaId), bvid)
      : null;
    const fallbackTarget = fallbackProof ? [{
      userId: String(job.userId),
      mediaId: Number(job.mediaId),
      folderTitle: String(payload.folderTitle || ""),
      remotePath: fallbackProof.oldRemotePath,
      oldFiles: fallbackProof.oldFiles,
    }] : [];
    const rawTargets = this.qualityTargetsFromPayload(payload, fallbackTarget);
    const targets = this.filterArchiveDeletionTargets(bvid, rawTargets).map((candidate) => {
      const proof = this.qualityUpgradeProof(bvid, candidate, artifactKey || undefined);
      if (!proof) return candidate;
      return {
        ...candidate,
        remotePath: proof.oldRemotePath || candidate.remotePath,
        oldFiles: proof.oldFiles.length > 0 ? proof.oldFiles : candidate.oldFiles,
      };
    });
    if (targets.length === 0) return null;
    const target = this.resolveQualityUpgradeTarget(job, payload, targets);
    const user = this.userStore.getById(String(payload.downloadUserId || payload.userId || job.userId || target?.userId || ""));
    const needsDownloadCredentials = job.kind === "quality_download";
    if (!target) {
      if (needsDownloadCredentials) return null;
      throw Object.assign(new Error("画质升级任务缺少唯一的归档来源目标，已暂停等待人工复核"), {
        code: "QUALITY_TARGET_AMBIGUOUS",
        statusCode: 409,
      });
    }
    if (needsDownloadCredentials && !this.isUserSyncEligible(user)) return null;
    const qualityProfile = normalizeQualityArtifactProfile(payload.qualityProfile || qualityArtifactProfileFromConfig(this.configStore.get()));
    const resolvedArtifactKey = artifactKey || buildQualityArtifactKey(bvid, qualityProfile);
    const taskConfig = applyQualityArtifactProfile(this.configStore.get(), qualityProfile);
    const qualityEncodingOverride = parseQualityEncodingOverride(payload.qualityEncodingOverride);
    const primaryProof = this.qualityUpgradeProof(bvid, target, resolvedArtifactKey);
    const stageRemotePath = primaryProof?.stageRemotePath || payload.stageRemotePath;
    const backupRemotePath = primaryProof?.backupRemotePath || payload.backupRemotePath;
    const persistedBackupFiles = this.mergeQualityProofFiles(payload.backupFiles, primaryProof?.backupFiles);
    const persistedFinalFiles = this.mergeQualityProofFiles(payload.finalFiles, primaryProof?.newFiles);
    const persistedUploadResult = payload.uploadResult && typeof payload.uploadResult === "object"
      ? {
          ...payload.uploadResult,
          files: this.mergeQualityProofFiles((payload.uploadResult as any).files, undefined),
        }
      : undefined;
    const task = new QualityUpgradeTask(bvid, user ? downloadCredentialsForUser(user) : {
      SESSDATA: "",
      bili_jct: "",
      DedeUserID: "",
    }, taskConfig, target, {
      targets,
      artifactKey: resolvedArtifactKey,
      qualityProfile,
      qualityStrict: Boolean(payload.qualityStrict),
      qualityEncodingOverride: qualityEncodingOverride || undefined,
    });
    task.runId = payload.runId;
    task.downloadDir = payload.downloadDir;
    task.outputFiles = Array.isArray(payload.outputFiles) ? payload.outputFiles : [];
    task.uploadResult = persistedUploadResult as any;
    task.backupFiles = persistedBackupFiles;
    task.finalFiles = persistedFinalFiles;
    task.stageRemotePath = stageRemotePath;
    task.backupRemotePath = backupRemotePath;
    if (!task.runId && (stageRemotePath || backupRemotePath)) task.runId = `resume-${resolvedArtifactKey.slice(0, 24)}`;
    task.videoTitle = String(payload.videoTitle || task.bvid);
    task.folderTitle = targets.length > 1 ? `${targets.length}个目标` : String(payload.folderTitle || target.folderTitle || "");
    task.downloadUserId = user?.id || String(payload.downloadUserId || payload.userId || "");
    task.userId = needsDownloadCredentials ? task.downloadUserId : target.userId;
    task.mediaId = target.mediaId;
    task.qualityStageLabel = job.kind === "quality_download"
      ? this.qualityDownloadStageLabel(task, String(payload.qualityStageLabel || "等待下载新版").split(" · ")[0])
      : String(payload.qualityStageLabel || "");
    task.onStartUpgrade = () => {
      logManager.push({ timestamp: new Date().toISOString(), type: "download", level: "info", summary: `开始重调画质 ${task.bvid}: ${task.videoTitle}（${task.targets.length}个目标）`, raw: `[QualityUpgrade] start artifact=${task.artifactKey} targets=${task.targets.length} bvid=${task.bvid}`, bvid: task.bvid, simpleVisible: true });
    };
    task.onReplacing = (_task, stageRemotePath, backupRemotePath) => {
      const accepted = this.stateManager.markQualityUpgradeReplacing(task.bvid, target.userId, target.mediaId, {
        artifactKey: task.artifactKey,
        stageRemotePath,
        backupRemotePath,
        oldRemotePath: target.remotePath,
        oldFiles: target.oldFiles,
      });
      if (!accepted) {
        throw Object.assign(new Error("画质升级存在另一份未完成的远端替换证明"), {
          code: "QUALITY_UPGRADE_OPERATION_CONFLICT",
          statusCode: 409,
        });
      }
    };
    task.onBackupFileMoved = (_task, file) => {
      this.stateManager.recordQualityUpgradeBackupFile(task.bvid, target.userId, target.mediaId, file);
      if (task.persistentJobId) this.jobStore.updatePayload(task.persistentJobId, this.serializeQualityUpgrade(task, target, task.targets));
    };
    task.onFinalFileMoved = (_task, file) => {
      this.stateManager.recordQualityUpgradeFinalFile(task.bvid, target.userId, target.mediaId, file);
      if (task.persistentJobId) this.jobStore.updatePayload(task.persistentJobId, this.serializeQualityUpgrade(task, target, task.targets));
    };
    task.onUploaded = (_task, result) => this.stateManager.finalizeQualityUpgradeRemoteFiles(task.bvid, target.userId, target.mediaId, result.remotePath, result.files);
    task.onCompletedUpgrade = async () => {
      const cleanupPlan = this.buildLocalCleanupPlan(
        task.bvid,
        String(task.downloadDir || ""),
        task.finalFiles || [],
        "quality_upgrade",
        { id: `quality:${task.artifactKey}:${target.userId}:${target.mediaId}` },
      );
      const completed = this.stateManager.runAtomic(() => {
        const current = this.jobStore.findById(job.id);
        if (!current || current.leaseOwner !== this.leaseOwner || !["leased", "running"].includes(current.status)
          || String(current.payload.runId || "") !== String(job.payload?.runId || "")) {
          throw new Error("Quality cleanup execution ownership changed before commit");
        }
        const result = this.stateManager.completeQualityUpgrade(task.bvid, target.userId, target.mediaId, target.remotePath, task.finalFiles || []);
        if (!result) throw new Error("Quality upgrade proof is unavailable before commit");
        if (cleanupPlan) this.stateManager.recordLocalCleanupPlan(task.bvid, cleanupPlan, job.id);
        if (!this.jobStore.complete(job.id, this.leaseOwner)) throw new Error("Quality cleanup task changed before commit");
        return result;
      });
      if (completed) {
        void this.reconcileObsoleteVerifiedArchiveRecoveries(1, {
          bvid: task.bvid,
          userId: target.userId,
          mediaId: target.mediaId,
        }, 1);
      }
      logManager.push({ timestamp: new Date().toISOString(), type: "upload", level: "info", summary: `重调画质完成 ${task.bvid}`, raw: `[QualityUpgrade] completed ${target.userId}:${target.mediaId}:${task.bvid}`, bvid: task.bvid, simpleVisible: true });
    };
    task.onFailed = (_task, error) => {
      const safeError = sanitizeUploadText(error?.message || error);
      logManager.push({ timestamp: new Date().toISOString(), type: task.qualityStage === "upload" ? "upload" : "download", level: "error", summary: `重调画质失败 ${task.bvid}: ${safeError}`, raw: `[QualityUpgrade] failed ${target.userId}:${target.mediaId}:${task.bvid}: ${safeError}`, bvid: task.bvid, simpleVisible: true, debugVisible: true });
    };
    task.shouldCleanupLocal = () => {
      const canCleanup = task.artifactKey
        ? this.jobStore.countQualityJobsForArtifact(task.artifactKey) <= 1
        : this.jobStore.countJobsForBvid(task.bvid, ["quality_download", "quality_upload", "quality_replace", "quality_cleanup"]) <= 1;
      if (canCleanup && task.artifactKey) this.qualityArtifactCleanupLocks.add(task.artifactKey);
      return canCleanup;
    };
    task.onLocalCleanupFinished = () => {
      if (task.artifactKey) this.qualityArtifactCleanupLocks.delete(task.artifactKey);
      this.refreshLocalCacheState();
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    };
    return task;
  }

  private enqueueChargingAccessProbe(
    bvid: string,
    input: {
      preferredUserId?: string;
      skipUserIds?: string[];
      checkedAccountUids?: string[];
      previewAvailable?: boolean;
      notBefore?: number;
      purpose?: "charging_recheck" | "availability_recheck" | "legacy_failure_classification";
      intents?: AccessProbeIntent[];
      availabilityRound?: number;
      availabilityUnknownRound?: number;
      availabilityReason?: SourceAvailabilityReason;
      manual?: boolean;
    } = {}
  ) {
    const existing = this.stateManager.getChargingRestriction(bvid);
    const existingJob = this.jobStore.findByDedupeKey(`access_probe:${bvid}`);
    const existingPayload = (existingJob?.payload || {}) as Record<string, any>;
    const incomingIntents = input.intents || (input.purpose === "legacy_failure_classification"
      ? ["legacy_classification", "availability"]
      : input.purpose === "availability_recheck"
        ? ["availability"]
        : ["charging"]);
    const intents = [...new Set([
      ...(existingJob ? normalizeAccessProbeIntents(existingPayload) : []),
      ...incomingIntents,
    ])] as AccessProbeIntent[];
    const checkedAccountUids = [...new Set([
      ...(Array.isArray(existing?.checkedAccountUids) ? existing.checkedAccountUids : []),
      ...(Array.isArray(existingPayload.checkedAccountUids) ? existingPayload.checkedAccountUids : []),
      ...(input.checkedAccountUids || []),
    ].map(String))];
    const existingAvailabilityRound = Math.max(0, Number(existingPayload.availabilityRound || 0));
    const incomingAvailabilityRound = Math.max(0, Number(input.availabilityRound ?? 0));
    const existingUnknownRound = Math.max(0, Number(existingPayload.availabilityUnknownRound || 0));
    const incomingUnknownRound = Math.max(0, Number(input.availabilityUnknownRound ?? 0));
    const purpose = input.purpose
      || existingPayload.purpose
      || (intents.includes("availability") && !intents.includes("charging") ? "availability_recheck" : "charging_recheck");
    const notBefore = Math.min(
      Number.isFinite(Number(existingJob?.notBefore)) && Number(existingJob?.notBefore) > 0 ? Number(existingJob!.notBefore) : Number.MAX_SAFE_INTEGER,
      input.notBefore ?? this.now(),
    );
    const payload = {
      ...existingPayload,
      preferredUserId: input.preferredUserId || existingPayload.preferredUserId || "",
      skipUserIds: input.skipUserIds || existingPayload.skipUserIds || [],
      checkedAccountUids: checkedAccountUids.map(String),
      previewAvailable: input.previewAvailable ?? existing?.previewAvailable ?? existingPayload.previewAvailable,
      purpose,
      intents,
      availabilityRound: Math.max(existingAvailabilityRound, incomingAvailabilityRound),
      availabilityUnknownRound: Math.max(existingUnknownRound, incomingUnknownRound),
      availabilityReason: input.availabilityReason || existingPayload.availabilityReason,
      manual: input.manual === true || existingPayload.manual === true,
    };
    const job = this.jobStore.enqueue({
      kind: "access_probe",
      dedupeKey: `access_probe:${bvid}`,
      bvid,
      priority: 90,
      maxAttempts: 1,
      notBefore: Math.max(0, Number.isFinite(notBefore) ? notBefore : this.now()),
      payload,
    });
    // enqueue intentionally preserves a leased/running payload. Merge a newly
    // discovered intent into that active job without touching its lease.
    if (existingJob && ["leased", "running"].includes(existingJob.status)) {
      this.jobStore.updatePayload(existingJob.id, payload);
      return this.jobStore.findById(existingJob.id) || job;
    }
    return job;
  }

  private enqueueAvailabilityProbe(
    bvid: string,
    input: {
      preferredUserId?: string;
      notBefore?: number;
      availabilityRound?: number;
      availabilityUnknownRound?: number;
      availabilityReason?: "favorite_flag" | "api_not_found" | "submission_invisible" | "temporary_error";
      manual?: boolean;
    } = {}
  ) {
    return this.enqueueChargingAccessProbe(bvid, {
      preferredUserId: input.preferredUserId,
      notBefore: input.notBefore,
      availabilityRound: input.availabilityRound,
      availabilityUnknownRound: input.availabilityUnknownRound,
      availabilityReason: input.availabilityReason,
      manual: input.manual,
      intents: ["availability"],
    });
  }

  requestAvailabilityRecheck(bvidValue: string) {
    const bvid = String(bvidValue || "").trim();
    if (!bvid || !this.stateManager.getVideoMeta(bvid)) {
      return { ok: false as const, status: 404 as const, message: "本地没有该视频记录" };
    }
    const existing = this.jobStore.findByDedupeKey(`access_probe:${bvid}`);
    const charging = Boolean(this.stateManager.getChargingRestriction(bvid))
      || Boolean(existing && normalizeAccessProbeIntents(existing.payload).includes("charging"));
    if (this.availabilityProbeUsers(bvid, "", new Set(), charging).length === 0) {
      return { ok: false as const, status: 409 as const, message: "当前没有可用的相关账号，请登录并启用收藏所属账号或UP主账号" };
    }
    const current = this.stateManager.getSourceAvailability(bvid);
    const job = this.enqueueChargingAccessProbe(bvid, {
      intents: charging ? ["availability", "charging"] : ["availability"],
      notBefore: this.now(),
      availabilityRound: current?.state === "confirmed_unavailable" ? current.checkRound : 0,
      availabilityUnknownRound: current?.state === "unknown" ? current.checkRound : 0,
      availabilityReason: current?.reason || "temporary_error",
      manual: true,
    });
    this.dispatchPersistentJobs();
    return { ok: true as const, status: 202 as const, jobId: job.id, bvid };
  }

  private handleSourceUnavailableTask(
    task: DownloadTask | QualityUpgradeDownloadTask,
    error: { availabilityReason?: unknown } = {},
  ) {
    const checkedAtMs = this.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const reason = normalizeSourceAvailabilityReason(error.availabilityReason
      || (task instanceof DownloadTask ? task.availabilityReason : task.control.availabilityReason));

    if (task instanceof DownloadTask && task.encodingRetry) {
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      const completed = this.jobStore.completeEncodingRetryParent(
        task.encodingRetry.parentJobId,
        task.encodingRetry.generation,
      );
      this.jobStore.cancelEncodingRetryChildren(task.encodingRetry.parentJobId, task.encodingRetry.generation);
      if (completed) {
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站源当前不可用，已结束本次规格替换 ${task.bvid}`,
          raw: `[Availability] strict_candidate_ended bvid=${task.bvid} archiveReplacement=not_started`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
      }
      this.dispatchPersistentJobs();
      return;
    }

    if (task instanceof QualityUpgradeDownloadTask) {
      if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      task.control.qualityStage = "download";
      task.control.qualityStageLabel = "B站源当前不可用，本次画质重调已停止；未执行归档替换";
      task.control.error = undefined;
      this.syncQualityUpgradeControl(task, "completed");
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "info",
        summary: `B站源当前不可用，已结束本次画质重调 ${task.bvid}`,
        raw: `[Availability] quality_candidate_ended bvid=${task.bvid} archiveReplacement=not_started`,
        bvid: task.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      this.dispatchPersistentJobs();
      return;
    }

    if (task.downloadDir) {
      const manifest = readDownloadSession(task.downloadDir);
      if (manifest && manifest.outputs.length === 0) {
        markDownloadSessionStatus(task.downloadDir, "failed", "B站源当前不可用，已停止重复下载。");
      }
    }
    if (task.persistentJobId) this.jobStore.complete(task.persistentJobId, this.leaseOwner);
    const relations = this.stateManager.listRelationsForBvid(task.bvid);
    const shouldProbe = relations.some((relation) => relation.activeInFavorite
      && relation.sourceKind !== "manual"
      && !relation.selfVisible
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const previous = this.stateManager.getSourceAvailability(task.bvid);
    const nextAt = checkedAtMs + computeAvailabilityUnavailableDelayMs(0, task.bvid);
    this.stateManager.markAvailabilityConfirmedUnavailable(
      task.bvid,
      reason,
      checkedAt,
      shouldProbe ? new Date(nextAt).toISOString() : undefined,
      shouldProbe ? 1 : 0,
    );
    if (shouldProbe) {
      this.enqueueAvailabilityProbe(task.bvid, {
        preferredUserId: task.userId,
        notBefore: nextAt,
        availabilityRound: 1,
        availabilityReason: reason,
      });
    }
    if (previous?.state !== "confirmed_unavailable" && previous?.state !== "dormant") {
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "warn",
        summary: `B站视频当前不可用，已停止重复下载 ${task.bvid}`,
        raw: `[Availability] download_stopped bvid=${task.bvid} automaticProbe=${shouldProbe}`,
        bvid: task.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    this.dispatchPersistentJobs();
  }

  private handleChargingRestrictedTask(task: DownloadTask | QualityUpgradeDownloadTask, error: any) {
    const checkedAtMs = this.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const checkedUid = String(error?.accountUid || task.cookie?.DedeUserID || "");
    const previewAvailable = error?.access?.previewAvailable ?? error?.access?.isUgcPayPreview;
    this.stateManager.markChargingRestricted(task.bvid, {
      checkedAt,
      nextCheckAt: checkedAt,
      previewAvailable,
      checkedAccountUids: checkedUid ? [checkedUid] : [],
    });

    if (task instanceof QualityUpgradeDownloadTask) {
      task.control.qualityStageLabel = "充电视频，等待权限检查";
      this.syncQualityUpgradeControl(task, "retry_wait");
      if (task.persistentJobId) {
        this.jobStore.updatePayload(task.persistentJobId, this.serializeQualityUpgrade(task.control));
        this.jobStore.defer(
          task.persistentJobId,
          this.leaseOwner,
          "Charging-exclusive video requires access",
          checkedAtMs + computeChargingRecheckDelayMs(this.random)
        );
      }
    } else if (task.persistentJobId) {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
    }

    const preferredUserId = String((task.persistentJob as any)?.payload?.primaryUserId || task.userId || "");
    this.enqueueChargingAccessProbe(task.bvid, {
      preferredUserId,
      skipUserIds: task.userId ? [task.userId] : [],
      checkedAccountUids: checkedUid ? [checkedUid] : [],
      previewAvailable,
      notBefore: checkedAtMs,
    });
    logManager.push({
      timestamp: checkedAt,
      type: "download",
      level: "info",
      summary: `识别为充电视频 ${task.bvid}，已停止无效下载`,
      raw: `[ChargingAccess] restricted bvid=${task.bvid} checkedAccounts=${checkedUid ? 1 : 0} next=immediate-account-sweep`,
      bvid: task.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
  }

  private orderedEnabledUsers(preferredUserId: string, skipped: Set<string>) {
    return this.userStore.list()
      .filter((user) => this.isUserSyncEligible(user) && !skipped.has(user.id))
      .sort((left, right) => {
        if (left.id === preferredUserId) return -1;
        if (right.id === preferredUserId) return 1;
        return left.id.localeCompare(right.id);
      });
  }

  private availabilityProbeUsers(bvid: string, preferredUserId: string, skipped: Set<string>, charging: boolean) {
    const related = new Set(this.stateManager.listRelationsForBvid(bvid)
      .filter((relation) => relation.activeInFavorite && relation.sourceKind !== "manual")
      .map((relation) => relation.userId));
    const ownerUid = Number(this.stateManager.getVideoMeta(bvid)?.upperMid || 0);
    return this.orderedEnabledUsers(preferredUserId, skipped).filter((user) => charging
      || related.has(user.id)
      || (ownerUid > 0 && Number(user.uid || user.cookie.DedeUserID || 0) === ownerUid));
  }

  private deferChargingAccessProbe(
    job: any,
    value: {
      nextAt: number;
      checkedAccountUids: string[];
      previewAvailable?: boolean;
      reason?: string;
    }
  ) {
    const checkedAt = new Date(this.now()).toISOString();
    const nextCheckAt = new Date(value.nextAt).toISOString();
    this.stateManager.markChargingRestricted(String(job.bvid || ""), {
      checkedAt,
      nextCheckAt,
      previewAvailable: value.previewAvailable,
      checkedAccountUids: value.checkedAccountUids,
      lastError: value.reason,
    });
    this.jobStore.updatePayload(job.id, {
      ...(job.payload || {}),
      skipUserIds: [],
      checkedAccountUids: value.checkedAccountUids,
      previewAvailable: value.previewAvailable,
    });
    this.jobStore.defer(job.id, this.leaseOwner, value.reason || "Charging access is not available", value.nextAt);
  }

  private deferAvailabilityProbe(
    job: any,
    value: {
      nextAt: number;
      state: "pending_confirmation" | "unknown" | "confirmed_unavailable";
      reason: "favorite_flag" | "api_not_found" | "submission_invisible" | "temporary_error";
      checkRound?: number;
      unknownRound?: number;
      message: string;
    }
  ) {
    const checkedAt = new Date(this.now()).toISOString();
    const nextCheckAt = new Date(value.nextAt).toISOString();
    if (value.state === "pending_confirmation") {
      this.stateManager.markAvailabilityPending(String(job.bvid || ""), value.reason, checkedAt, nextCheckAt);
    } else if (value.state === "unknown") {
      this.stateManager.markAvailabilityUnknown(
        String(job.bvid || ""),
        value.reason,
        checkedAt,
        nextCheckAt,
        value.unknownRound,
      );
    } else {
      this.stateManager.markAvailabilityConfirmedUnavailable(
        String(job.bvid || ""),
        value.reason,
        checkedAt,
        nextCheckAt,
        value.checkRound,
      );
    }
    const current = this.jobStore.findById(job.id);
    this.jobStore.updatePayload(job.id, {
      ...((current?.payload || job.payload || {}) as Record<string, unknown>),
      intents: normalizeAccessProbeIntents((current?.payload || job.payload || {}) as Record<string, any>),
      manual: false,
      availabilityRound: value.checkRound ?? Number((current?.payload as any)?.availabilityRound || 0),
      availabilityUnknownRound: value.unknownRound ?? Number((current?.payload as any)?.availabilityUnknownRound || 0),
      availabilityReason: value.reason,
    });
    this.jobStore.defer(job.id, this.leaseOwner, value.message, value.nextAt);
  }

  private async runAvailabilityProbe(job: any) {
    const bvid = String(job.bvid || "");
    if (!bvid) {
      this.jobStore.complete(job.id, this.leaseOwner);
      return;
    }
    const payload = (job.payload || {}) as Record<string, any>;
    const intents = normalizeAccessProbeIntents(payload);
    const wantsCharging = intents.includes("charging");
    const wantsLegacyClassification = intents.includes("legacy_classification");
    const manualProbe = payload.manual === true;
    const relations = this.stateManager.listRelationsForBvid(bvid);
    const hasUnbackedRelation = relations.some((relation) => relation.activeInFavorite
      && relation.sourceKind !== "manual"
      && !relation.selfVisible
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const previousAvailability = this.stateManager.getSourceAvailability(bvid);
    if (!manualProbe && !hasUnbackedRelation
      && !this.jobStore.hasJobsForBvid(bvid, ["quality_download"])) {
      this.jobStore.complete(job.id, this.leaseOwner);
      return;
    }

    const preferredUserId = String(payload.preferredUserId || "");
    const relatedUsers = new Set(relations
      .filter((relation) => relation.activeInFavorite && relation.sourceKind !== "manual")
      .map((relation) => relation.userId));
    const skipped = new Set<string>(Array.isArray(payload.skipUserIds) ? payload.skipUserIds.map(String) : []);
    const ownerUid = Number(this.stateManager.getVideoMeta(bvid)?.upperMid || 0);
    const seenAccountUids = new Set<string>();
    const users = this.availabilityProbeUsers(bvid, preferredUserId, skipped, wantsCharging)
      .sort((left, right) => {
        const leftOwner = ownerUid > 0 && Number(left.uid || left.cookie.DedeUserID || 0) === ownerUid;
        const rightOwner = ownerUid > 0 && Number(right.uid || right.cookie.DedeUserID || 0) === ownerUid;
        if (leftOwner !== rightOwner) return leftOwner ? -1 : 1;
        const leftPreferred = left.id === preferredUserId;
        const rightPreferred = right.id === preferredUserId;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        const leftRelated = relatedUsers.has(left.id);
        const rightRelated = relatedUsers.has(right.id);
        if (leftRelated !== rightRelated) return leftRelated ? -1 : 1;
        return 0;
      })
      .filter((user) => {
        const uid = String(user.uid || user.cookie.DedeUserID || user.id);
        if (seenAccountUids.has(uid)) return false;
        seenAccountUids.add(uid);
        return true;
      });
    const checkedUids = new Set<string>(Array.isArray(payload.checkedAccountUids) ? payload.checkedAccountUids.map(String) : []);
    let unavailableCount = 0;
    let unknownCount = 0;
    let accountBlockedCount = 0;
    let chargingRestrictedCount = 0;
    let recoveredUser: BiliUser | null = null;
    let chargingUser: BiliUser | null = null;
    let availabilityReason: "api_not_found" | "submission_invisible" | "temporary_error" =
      payload.availabilityReason === "submission_invisible" ? "submission_invisible" : "api_not_found";
    let transientReason = "";
    let previewAvailable = typeof payload.previewAvailable === "boolean" ? payload.previewAvailable : undefined;

    const preserveManualSchedule = (message: string) => {
      if (!manualProbe || !previousAvailability) return false;
      const checkedAt = new Date(this.now()).toISOString();
      if (previousAvailability.state === "dormant") {
        this.stateManager.markAvailabilityDormant(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.checkRound,
        );
        this.jobStore.complete(job.id, this.leaseOwner);
        return true;
      }
      const scheduledAt = Date.parse(previousAvailability.nextCheckAt || "");
      if (!Number.isFinite(scheduledAt) || scheduledAt <= this.now() + 1_000) return false;
      if (previousAvailability.state === "confirmed_unavailable") {
        this.stateManager.markAvailabilityConfirmedUnavailable(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
          previousAvailability.checkRound,
        );
      } else if (previousAvailability.state === "unknown") {
        this.stateManager.markAvailabilityUnknown(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
          previousAvailability.checkRound,
        );
      } else {
        this.stateManager.markAvailabilityPending(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
        );
      }
      this.jobStore.updatePayload(job.id, { ...payload, intents, manual: false });
      this.jobStore.defer(job.id, this.leaseOwner, message, scheduledAt);
      return true;
    };

    if (users.length === 0) {
      if (preserveManualSchedule("手动复核未发现可用账号，保留原复核计划")) return;
      const nextAt = this.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      this.jobStore.updatePayload(job.id, { ...payload, intents, manual: false });
      this.jobStore.defer(job.id, this.leaseOwner, "没有已启用的B站账号，等待账号恢复", nextAt);
      return;
    }

    for (const user of users) {
      checkedUids.add(String(user.uid || user.cookie.DedeUserID || user.id));
      try {
        const snapshot = await this.videoAccessProbe({
          ...user.cookie,
          accessToken: user.accessToken || "",
        }, bvid);
        const availability = snapshotAvailability(snapshot);
        if (availability === "available") {
          recoveredUser ||= user;
          previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
          if (wantsCharging && snapshot.access.classification === "charging_restricted") {
            chargingRestrictedCount += 1;
            previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
          } else if (!wantsCharging || ["normal", "charging_allowed"].includes(snapshot.access.classification)) {
            chargingUser ||= user;
          }
          if (!wantsCharging || chargingUser) break;
          continue;
        }
        if (availability === "unavailable") {
          unavailableCount += 1;
          if (snapshot.availabilityReason === "submission_invisible") availabilityReason = "submission_invisible";
          continue;
        }
        unknownCount += 1;
        availabilityReason = "temporary_error";
        transientReason = snapshot.availabilityReason === "empty_response"
          ? "B站详情返回空响应"
          : "B站详情暂时无法确认";
      } catch (error: any) {
        if (error instanceof BiliRiskOrLoginError || error?.biliRiskControl || error?.biliLoginRequired) {
          accountBlockedCount += 1;
        } else {
          unknownCount += 1;
        }
        availabilityReason = "temporary_error";
        transientReason = sanitizeUploadText(error?.message || error).slice(0, 300);
      }
    }

    const checkedAt = new Date(this.now()).toISOString();
    if (recoveredUser) {
      const recovered = this.stateManager.markAvailabilityRecovered(bvid, checkedAt);
      if (wantsLegacyClassification) {
        this.stateManager.markLegacyAccessClassification(bvid, { result: "available", classifiedAt: checkedAt });
      }
      if (!wantsCharging || chargingUser) {
        this.jobStore.complete(job.id, this.leaseOwner);
        for (const relation of relations.filter((item) => item.activeInFavorite
          && item.sourceKind !== "manual"
          && !["uploaded", "verified", "partial_verified"].includes(item.backupStatus || ""))) {
          const resolved = this.resolveRelation(relation);
          if (!resolved || !this.stateManager.shouldEnqueueBackup(bvid, relation.userId, relation.mediaId, undefined)) continue;
          this.enqueueIfNeeded(resolved.user, relation.mediaId, resolved.folderTitle, bvid, {
            persisted: true,
            downloadUserId: chargingUser?.id || recoveredUser.id,
          });
        }
        if (recovered || previousAvailability) logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站视频已恢复可用 ${bvid}`,
          raw: `[Availability] recovered bvid=${bvid} checkedAccounts=${checkedUids.size}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return;
      }
      this.stateManager.markChargingRestricted(bvid, {
        checkedAt,
        nextCheckAt: new Date(this.now() + computeChargingRecheckDelayMs(this.random)).toISOString(),
        previewAvailable,
        checkedAccountUids: [...checkedUids],
      });
      this.jobStore.updatePayload(job.id, {
        ...payload,
        intents: ["charging"],
        manual: false,
        checkedAccountUids: [...checkedUids],
        previewAvailable,
      });
      this.jobStore.defer(job.id, this.leaseOwner, "视频已恢复，但仍需要充电权限", this.now() + computeChargingRecheckDelayMs(this.random));
      return;
    }

    if (accountBlockedCount > 0) {
      if (preserveManualSchedule("手动复核遇到账号登录或风控限制，保留原复核计划")) return;
      const nextAt = this.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      this.stateManager.markAvailabilityUnknown(
        bvid,
        "temporary_error",
        checkedAt,
        new Date(nextAt).toISOString(),
        Number(payload.availabilityUnknownRound || 0),
      );
      this.jobStore.updatePayload(job.id, { ...payload, intents, manual: false });
      this.jobStore.defer(job.id, this.leaseOwner, transientReason || "账号登录或风控限制，等待账号恢复", nextAt);
      return;
    }

    if (unknownCount > 0) {
      if (preserveManualSchedule("手动复核暂时无法确认，保留原复核计划")) return;
      const unknownRound = Number(payload.availabilityUnknownRound || 0);
      if (unknownRound >= AVAILABILITY_UNKNOWN_DELAYS_MS.length) {
        this.stateManager.markAvailabilityDormant(bvid, "temporary_error", checkedAt, unknownRound);
        this.jobStore.complete(job.id, this.leaseOwner);
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站视频状态长期无法确认，已转入休眠 ${bvid}`,
          raw: `[Availability] dormant_unknown bvid=${bvid} round=${unknownRound}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return;
      }
      const nextAt = this.now() + computeAvailabilityUnknownDelayMs(unknownRound, bvid);
      this.deferAvailabilityProbe(job, {
        nextAt,
        state: "unknown",
        reason: availabilityReason,
        unknownRound: unknownRound + 1,
        message: transientReason || "B站视频状态暂时无法确认，稍后复核",
      });
      return;
    }

    if (unavailableCount > 0) {
      if (preserveManualSchedule("手动复核仍不可用，保留原复核计划")) return;
      const unavailableRound = Number(payload.availabilityRound || 0);
      if (unavailableRound >= AVAILABILITY_UNAVAILABLE_DELAYS_MS.length) {
        this.stateManager.markAvailabilityDormant(bvid, availabilityReason, checkedAt, unavailableRound);
        this.jobStore.complete(job.id, this.leaseOwner);
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站视频长期不可用，已转入休眠 ${bvid}`,
          raw: `[Availability] dormant bvid=${bvid} round=${unavailableRound}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return;
      }
      const nextAt = this.now() + computeAvailabilityUnavailableDelayMs(unavailableRound, bvid);
      const previous = this.stateManager.getSourceAvailability(bvid);
      this.deferAvailabilityProbe(job, {
        nextAt,
        state: "confirmed_unavailable",
        reason: availabilityReason,
        checkRound: unavailableRound + 1,
        message: "B站视频当前不可用，系统将在低频复核，不再重复下载",
      });
      if (previous?.state !== "confirmed_unavailable") {
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "warn",
          summary: `B站视频当前不可用，已停止重复下载 ${bvid}`,
          raw: `[Availability] confirmed_unavailable bvid=${bvid} round=${unavailableRound + 1}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
      }
      if (wantsLegacyClassification) {
        this.stateManager.markLegacyAccessClassification(bvid, { result: "unavailable", classifiedAt: checkedAt });
      }
      return;
    }

    if (wantsCharging && chargingRestrictedCount > 0) {
      const nextAt = this.now() + computeChargingRecheckDelayMs(this.random);
      this.stateManager.markChargingRestricted(bvid, {
        checkedAt,
        nextCheckAt: new Date(nextAt).toISOString(),
        previewAvailable,
        checkedAccountUids: [...checkedUids],
      });
      this.jobStore.updatePayload(job.id, { ...payload, intents, manual: false, checkedAccountUids: [...checkedUids], previewAvailable });
      this.jobStore.defer(job.id, this.leaseOwner, "视频仍受充电权限限制", nextAt);
      return;
    }

    this.deferAvailabilityProbe(job, {
      nextAt: this.now() + computeAvailabilityUnknownDelayMs(Number(payload.availabilityUnknownRound || 0), bvid),
      state: "unknown",
      reason: "temporary_error",
      unknownRound: Number(payload.availabilityUnknownRound || 0) + 1,
      message: "B站视频状态暂时无法确认，稍后复核",
    });
  }

  private async runChargingAccessProbe(job: any) {
    const intents = normalizeAccessProbeIntents(job.payload || {});
    if (intents.includes("availability")) {
      await this.runAvailabilityProbe(job);
      return;
    }
    const bvid = String(job.bvid || "");
    if (!bvid) {
      this.jobStore.complete(job.id, this.leaseOwner);
      return;
    }
    const relations = this.stateManager.listRelationsForBvid(bvid);
    const hasUnbackedRelation = relations.some((relation) => relation.activeInFavorite
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const hasQualityDownload = this.jobStore.hasJobsForBvid(bvid, ["quality_download"]);
    if (!hasUnbackedRelation && !hasQualityDownload) {
      this.jobStore.complete(job.id, this.leaseOwner);
      return;
    }

    const payload = job.payload || {};
    const skipped = new Set<string>(Array.isArray(payload.skipUserIds) ? payload.skipUserIds.map(String) : []);
    const users = this.orderedEnabledUsers(String(payload.preferredUserId || ""), skipped);
    const checkedUids = new Set<string>(Array.isArray(payload.checkedAccountUids) ? payload.checkedAccountUids.map(String) : []);
    let previewAvailable = typeof payload.previewAvailable === "boolean" ? payload.previewAvailable : undefined;
    let allowedUser: BiliUser | null = null;
    let restrictedCount = skipped.size > 0 ? 1 : 0;
    let unavailableCount = 0;
    let unknownCount = 0;
    let lastTransientError = "";

    if (users.length === 0 && skipped.size === 0) {
      const nextAt = this.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      this.deferChargingAccessProbe(job, {
        nextAt,
        checkedAccountUids: [...checkedUids],
        previewAvailable,
        reason: "没有已启用的B站账号，等待账号恢复",
      });
      return;
    }

    for (const user of users) {
      checkedUids.add(String(user.uid || user.cookie.DedeUserID || user.id));
      try {
        const snapshot = await this.videoAccessProbe({
          ...user.cookie,
          accessToken: user.accessToken || "",
        }, bvid);
        const availability = snapshotAvailability(snapshot);
        if (availability === "unavailable") {
          unavailableCount += 1;
          continue;
        }
        if (availability === "unknown") {
          unknownCount += 1;
          lastTransientError = "B站详情暂时无法确认视频状态";
          continue;
        }
        if (["normal", "charging_allowed"].includes(snapshot.access.classification)) {
          allowedUser = user;
          break;
        }
        if (snapshot.access.classification === "charging_restricted") {
          restrictedCount += 1;
          previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
        } else {
          unknownCount += 1;
          lastTransientError = "B站未返回可确认的充电权限字段";
        }
      } catch (error: any) {
        unknownCount += 1;
        lastTransientError = sanitizeUploadText(error?.message || error).slice(0, 300);
      }
    }

    if (allowedUser) {
      const checkedAt = new Date(this.now()).toISOString();
      if (payload.purpose === "legacy_failure_classification") {
        this.stateManager.markLegacyAccessClassification(bvid, { result: "available", classifiedAt: checkedAt });
      }
      this.stateManager.clearChargingRestriction(bvid, checkedAt);
      this.jobStore.complete(job.id, this.leaseOwner);
      for (const qualityJob of this.jobStore.list(["quality_download"], 10_000)) {
        if (qualityJob.bvid !== bvid) continue;
        this.jobStore.updatePayload(qualityJob.id, {
          ...qualityJob.payload,
          downloadUserId: allowedUser.id,
        });
      }
      this.jobStore.wakeByBvid(bvid, ["quality_download"], this.now());
      const relation = relations.find((item) => item.activeInFavorite
        && !["uploaded", "verified", "partial_verified"].includes(item.backupStatus || ""));
      const resolved = relation ? this.resolveRelation(relation) : null;
      if (relation && resolved) {
        this.enqueueIfNeeded(resolved.user, relation.mediaId, resolved.folderTitle, bvid, {
          persisted: true,
          downloadUserId: allowedUser.id,
        });
      }
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "info",
        summary: `充电视频权限已恢复 ${bvid}，已重新加入下载`,
        raw: `[ChargingAccess] allowed bvid=${bvid} checkedAccounts=${checkedUids.size}`,
        bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      return;
    }

    if (restrictedCount === 0 && unavailableCount > 0 && unknownCount === 0) {
      const checkedAt = new Date(this.now()).toISOString();
      const nextAt = this.now() + computeAvailabilityUnavailableDelayMs(0, bvid);
      this.stateManager.markAvailabilityConfirmedUnavailable(
        bvid,
        "api_not_found",
        checkedAt,
        new Date(nextAt).toISOString(),
        1,
      );
      this.jobStore.updatePayload(job.id, {
        ...payload,
        purpose: "availability_recheck",
        intents: ["availability"],
        manual: false,
        availabilityRound: 1,
        availabilityReason: "api_not_found",
      });
      this.jobStore.defer(job.id, this.leaseOwner, "充电视频源当前不可用，转为低频可用性复核", nextAt);
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "warn",
        summary: `充电视频源当前不可用，已停止重复下载 ${bvid}`,
        raw: `[ChargingAccess] unavailable bvid=${bvid} checkedAccounts=${checkedUids.size} next=availability_probe`,
        bvid,
        simpleVisible: true,
      });
      return;
    }

    const transient = unknownCount > 0;
    const nextAt = this.now() + (transient
      ? computeChargingTransientDelayMs(this.random)
      : computeChargingRecheckDelayMs(this.random));
    if (payload.purpose === "legacy_failure_classification" && transient) {
      this.stateManager.markLegacyAccessClassification(bvid, {
        nextCheckAt: new Date(nextAt).toISOString(),
      });
    }
    this.deferChargingAccessProbe(job, {
      nextAt,
      checkedAccountUids: [...checkedUids],
      previewAvailable,
      reason: transient ? (lastTransientError || "充电权限检查暂时失败") : undefined,
    });
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "download",
      level: transient ? "warn" : "info",
      summary: `${transient ? "充电权限检查暂时失败" : "充电视频仍无观看权限"} ${bvid}，下次检查 ${new Date(nextAt).toISOString()}`,
      raw: `[ChargingAccess] ${transient ? "transient" : "restricted"} bvid=${bvid} checkedAccounts=${checkedUids.size} next=${new Date(nextAt).toISOString()}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  private dispatchChargingAccessProbe() {
    if (this.accessProbePromise || !this.acceptingJobs) return;
    const [job] = this.jobStore.claimDue(["access_probe"], 1, this.leaseOwner, 5 * 60_000, this.now());
    if (!job) return;
    this.jobStore.markRunning(job.id, this.leaseOwner, 5 * 60_000);
    this.accessProbeJobId = job.id;
    this.accessProbePromise = this.runChargingAccessProbe(job).catch((error: any) => {
      const reason = sanitizeUploadText(error?.message || error).slice(0, 300);
      const intents = normalizeAccessProbeIntents(job.payload || {});
      if (intents.includes("availability")) {
        const source = this.stateManager.getSourceAvailability(String(job.bvid || ""));
        const scheduledAt = Date.parse(source?.nextCheckAt || "");
        if (job.payload?.manual === true && source?.state === "dormant") {
          this.jobStore.complete(job.id, this.leaseOwner);
          return;
        }
        if (job.payload?.manual === true && Number.isFinite(scheduledAt) && scheduledAt > this.now() + 1_000) {
          this.jobStore.updatePayload(job.id, { ...job.payload, intents, manual: false });
          this.jobStore.defer(job.id, this.leaseOwner, reason, scheduledAt);
          return;
        }
        const unknownRound = Number(job.payload?.availabilityUnknownRound || 0);
        const nextAt = this.now() + computeAvailabilityUnknownDelayMs(unknownRound, String(job.bvid || ""));
        this.deferAvailabilityProbe(job, {
          nextAt,
          state: "unknown",
          reason: "temporary_error",
          unknownRound: unknownRound + 1,
          message: reason,
        });
      } else {
        const nextAt = this.now() + computeChargingTransientDelayMs(this.random);
        this.deferChargingAccessProbe(job, {
          nextAt,
          checkedAccountUids: Array.isArray(job.payload?.checkedAccountUids) ? job.payload.checkedAccountUids.map(String) : [],
          previewAvailable: typeof job.payload?.previewAvailable === "boolean" ? job.payload.previewAvailable : undefined,
          reason,
        });
      }
    }).finally(() => {
      this.accessProbePromise = null;
      this.accessProbeJobId = null;
      this.dispatchPersistentJobs();
    });
  }

  private buildQualityUpgradeTaskSafely(job: any) {
    try {
      return this.buildQualityUpgradeTask(job);
    } catch (error: any) {
      const summary = sanitizeDiagnosticText(error?.message || error || "画质升级任务无法恢复", 500);
      this.jobStore.parkManualRecovery(job.id, this.leaseOwner, summary, {
        awaitingManualRecovery: true,
        qualityTargetResolution: "ambiguous",
      });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: `画质升级任务已暂停：${summary}`,
        raw: `[QualityUpgrade] paused job=${job.id} bvid=${job.bvid || ""} reason=${summary}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      return null;
    }
  }

  private dispatchPersistentJobs() {
    if (!this.acceptingJobs || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked) return;
    this.dispatchChargingAccessProbe();
    const config = this.configStore.get();
    const downloadCapacity = Math.max(0, this.queueHighWater(
      config.concurrentDownloads,
      config.queuePrefetchLimit
    ) - this.downloadQueue.getSize());
    if (downloadCapacity > 0 && this.canCreateDownloadTask()) {
      const jobs = this.jobStore.claimDue(["quality_download", "download"], downloadCapacity, this.leaseOwner, 30 * 60_000);
      const activeQualityArtifacts = new Set(this.downloadQueue.getTasks()
        .filter((task) => task instanceof QualityUpgradeDownloadTask)
        .map((task: any) => String(task.control?.artifactKey || task.bvid || "")));
      for (const job of jobs) {
        const qualityArtifact = String((job.payload as any)?.artifactKey || job.bvid || "");
        if (job.kind === "quality_download" && activeQualityArtifacts.has(qualityArtifact)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Shared quality download is active", Date.now() + 1_000);
          continue;
        }
        const control = job.kind === "quality_download" ? this.buildQualityUpgradeTaskSafely(job) : null;
        const task = control ? new QualityUpgradeDownloadTask(control) : this.buildDownloadTask(job);
        if (!task) {
          this.jobStore.complete(job.id, this.leaseOwner);
          continue;
        }
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.downloadQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Download queue is full", Date.now() + 1_000);
          break;
        }
        if (job.kind === "quality_download") activeQualityArtifacts.add(qualityArtifact);
      }
    }

    const uploadCapacity = Math.max(0, this.queueHighWater(
      config.concurrentUploads,
      config.queuePrefetchLimit
    ) - this.uploadQueue.getSize());
    if (uploadCapacity > 0) {
      const jobs = this.jobStore.claimDue(["upload", "quality_upload", "quality_replace", "quality_cleanup", "history_upload"], uploadCapacity, this.leaseOwner, 30 * 60_000);
      for (const job of jobs) {
        if (["quality_upload", "quality_replace", "quality_cleanup"].includes(job.kind)) {
          const control = this.buildQualityUpgradeTaskSafely(job);
          if (!control) {
            this.jobStore.complete(job.id, this.leaseOwner);
            continue;
          }
          const task = job.kind === "quality_replace"
            ? new QualityUpgradeReplaceTask(control)
            : (job.kind === "quality_cleanup" ? new QualityUpgradeCleanupTask(control) : new QualityUpgradeUploadReplaceTask(control));
          task.maxRetries = 0;
          task.persistentJobId = job.id;
          task.persistentJob = job;
          if (!this.uploadQueue.addTask(task)) {
            this.jobStore.defer(job.id, this.leaseOwner, "Upload queue is full", Date.now() + 1_000);
            break;
          }
          continue;
        }
        const item = { ...(job.payload as unknown as RecoveryUploadItem) };
        if (!item.historyOnly && !item.conflictCandidateId) {
          item.conflictCandidateId = `upload-${job.id}`;
          item.conflictCandidateRemotePath = joinRemotePath(item.remotePath, "_conflicts", item.conflictCandidateId);
          this.jobStore.updatePayload(job.id, {
            ...job.payload,
            conflictCandidateId: item.conflictCandidateId,
            conflictCandidateRemotePath: item.conflictCandidateRemotePath,
          });
        }
        const task = this.buildUploadTask(item);
        task.maxRetries = 0;
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.uploadQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Upload queue is full", Date.now() + 1_000);
          break;
        }
      }
    }

    const capacity = Math.max(0, this.queueHighWater(
      config.remoteVerifyConcurrency,
      config.queuePrefetchLimit
    ) - this.verificationQueue.getSize());
    if (capacity > 0) {
      const jobs = this.jobStore.claimDue(["verify_upload"], capacity, this.leaseOwner, 5 * 60_000);
      for (const job of jobs) {
        const payload = job.payload as any;
        const task = new UploadVerificationTask(
          String(job.bvid || ""),
          String(job.userId || ""),
          Number(job.mediaId || 0),
          String(payload.remoteFile || ""),
          Number(payload.expectedSize || 0),
          config,
            {
              transferSessionStore: this.transferSessions,
              sessionId: payload.sessionId,
              sessionGeneration: Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : undefined,
              allowReupload: false,
              sessionVerification: Boolean(payload.sessionVerification || payload.sessionId),
              filenameMetadataByPath: payload.filenameMetadataByPath,
              encodingRetry: parseEncodingRetryContext(payload.encodingRetry) || undefined,
            }
        );
        task.persistentJobId = job.id;
        task.persistentJob = job;
        if (!this.verificationQueue.addTask(task)) {
          this.jobStore.defer(job.id, this.leaseOwner, "Verification queue is full", Date.now() + 1_000);
          break;
        }
      }
    }
    this.schedulePersistentJobWake();
  }

  private schedulePersistentJobWake() {
    if (this.jobDispatchTimer) {
      clearTimeout(this.jobDispatchTimer);
      this.jobDispatchTimer = null;
    }
    const nextAt = this.jobStore.nextDueAt();
    if (nextAt === undefined) return;
    this.jobDispatchTimer = setTimeout(() => {
      this.jobDispatchTimer = null;
      this.dispatchPersistentJobs();
    }, Math.max(this.persistentJobWakeMinMs, nextAt - Date.now()));
    this.jobDispatchTimer.unref?.();
  }

  private buildLocalCleanupPlan(
    bvid: string,
    localDir: string,
    remoteFiles: RemoteFileRecord[],
    reason: LocalCleanupPlan["reason"],
    options: {
      id?: string;
      transferSessionId?: string;
      transferGeneration?: number;
    } = {},
  ): LocalCleanupPlan | null {
    if (!localDir || !Array.isArray(remoteFiles) || remoteFiles.length === 0) return null;
    const manifest = readDownloadSession(localDir);
    if (!manifest || manifest.bvid !== bvid || !manifest.sessionId) return null;
    const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
    const files: LocalCleanupPlan["files"] = [];
    for (const remoteFile of remoteFiles) {
      const relativePath = String(remoteFile.localRelativePath || "").replace(/\\/g, "/");
      if (!relativePath || !remoteFile.path) return null;
      const manifestFile = manifestFiles.find((file) => file.relativePath.replace(/\\/g, "/") === relativePath);
      if (!manifestFile || !Number.isFinite(Number(manifestFile.size)) || Number(manifestFile.size) < 0) return null;
      if (remoteFile.size === undefined || Number(remoteFile.size) !== Number(manifestFile.size)) return null;
      let identity: fs.Stats;
      try {
        const root = fs.realpathSync(localDir);
        const target = path.resolve(localDir, relativePath);
        if (!fs.realpathSync(target).startsWith(`${root}${path.sep}`)) return null;
        identity = fs.lstatSync(target);
        const verifiedAt = Date.parse(manifestFile.verifiedAt);
        if (!identity.isFile() || identity.size !== manifestFile.size || !Number.isFinite(verifiedAt)
          || identity.mtimeMs > verifiedAt + 1 || identity.ctimeMs > verifiedAt + 1) return null;
      } catch { return null; }
      const previous = files.find((file) => file.relativePath === relativePath);
      if (previous) {
        previous.remotePaths = [...new Set([...previous.remotePaths, String(remoteFile.path)])];
        continue;
      }
      files.push({
        relativePath,
        expectedSize: Number(manifestFile.size),
        expectedIdentity: { dev: identity.dev, ino: identity.ino, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs },
        remotePaths: [String(remoteFile.path)],
      });
    }
    if (files.length === 0) return null;
    const derivedId = crypto.createHash("sha256")
      .update(JSON.stringify({
        reason,
        sessionId: manifest.sessionId,
        transferSessionId: options.transferSessionId || "",
        transferGeneration: options.transferGeneration || 0,
        files: files.map((file) => ({ relativePath: file.relativePath, expectedSize: file.expectedSize, remotePaths: file.remotePaths })),
      }))
      .digest("hex")
      .slice(0, 32);
    return {
      id: String(options.id || `${reason}:${derivedId}`),
      localDir,
      manifestSessionId: manifest.sessionId,
      transferSessionId: options.transferSessionId,
      transferGeneration: options.transferGeneration,
      reason,
      files,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  private taskLocalDir(task: UploadTask | UploadVerificationTask, fallback = "") {
    if (task instanceof UploadTask) return task.downloadDir;
    return fallback;
  }

  private commitVerifiedTransfer(
    task: UploadTask | UploadVerificationTask,
    result: NonNullable<UploadTask["result"]>,
    partialBackup = false,
    historyOnly = false,
    encodingRetry?: EncodingRetryContext,
  ) {
    if (!result.allVerified || result.files.length === 0 || result.files.some((file) => file.verificationStatus !== "verified")) throw new Error("Cannot commit an unverified upload group");
    if (encodingRetry && !task.persistentJobId) throw new Error("Encoding retry commit requires a persistent child job");
    const localDir = this.taskLocalDir(task, String((task.persistentJob as any)?.payload?.localDir || ""));
    const cleanupPlan = this.buildLocalCleanupPlan(task.bvid, localDir, result.files, "upload_verified", {
      id: `upload:${result.sessionId || localDir}:${result.sessionGeneration || 0}:${result.remotePath}`,
      transferSessionId: result.sessionId, transferGeneration: result.sessionGeneration,
    });
    this.stateManager.runAtomic(() => {
      if (result.sessionId) {
        const session = this.transferSessions.assertGeneration(result.sessionId, result.sessionGeneration);
        const files = this.transferSessions.listFiles(session.id, session.generation);
        if (files.length !== result.files.length || files.some((file) => file.status !== "verified" || !result.files.some((item) => item.path === file.finalPath && Number(item.size) === file.expectedSize))) throw new Error("Upload proof set changed before commit");
        this.transferSessions.updateSession(session.id, { phase: "completed", completedAt: this.now(), lastError: null }, session.generation);
      }
      if (!historyOnly) this.stateManager.markVerifiedUpload(task.bvid, result.remotePath, result.files, task.userId, task.mediaId, partialBackup);
      if (cleanupPlan) this.stateManager.recordLocalCleanupPlan(task.bvid, cleanupPlan, task.persistentJobId);
      if (encodingRetry) {
        if (!this.jobStore.completeEncodingRetryCommit(encodingRetry.parentJobId, encodingRetry.generation, task.persistentJobId, this.leaseOwner)) throw new Error("Encoding retry execution changed before verified commit");
      } else if (task.persistentJobId && !this.jobStore.complete(task.persistentJobId, this.leaseOwner)) throw new Error("Upload task execution ownership changed before commit");
    });
  }
  private handleUploadVerificationCompleted(task: UploadVerificationTask) {
    const job = task.persistentJob as any;
    if (!job || !task.persistentJobId || !task.result) return;
    const payload = job.payload as any;
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (encodingRetry && !this.isEncodingRetryParentActive(encodingRetry)) {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      this.dispatchPersistentJobs();
      return;
    }
    if (task.transferResult) {
      const transfer = task.transferResult;
      if (transfer.allVerified) {
        if (encodingRetry) {
          this.commitVerifiedTransfer(task, transfer, Boolean(payload.partialBackup), false, encodingRetry);
          this.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          return;
        }
        this.commitVerifiedTransfer(task, transfer, Boolean(payload.partialBackup), Boolean(payload.historyOnly));
        if (payload.historyOnly && payload.historySnapshotAt) markHistoryGroupUploaded(String(payload.localDir || ""), payload.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        void this.maybeCleanupVerifiedLocalDir(task.bvid, String(payload.localDir || ""));
        if (this.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) this.stateManager.clearUploadCooldown();
        this.dispatchPersistentJobs();
        return;
      }
      const nextAt = Date.now() + Math.max(2_000, UPLOAD_VERIFY_SCHEDULE_MS[Math.min(UPLOAD_VERIFY_SCHEDULE_MS.length - 1, Number(job.attempts || 0))] || 10 * 60_000);
      const reason = "正式文件等待远端确认，未重复上传";
      if (!payload.historyOnly) {
        for (const pending of transfer.pendingChecks || []) {
          this.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, pending.finalFile, nextAt, reason);
        }
      }
      // Keep the same timeout and manual recovery state machine as legacy
      // verification jobs. The transfer session only changes how a check is
      // performed; it must not make an invisible upload wait forever.
      this.deferMissingUploadVerification(task, job, payload);
      return;
    }
    if (task.result.status === "verified") {
      if (encodingRetry) {
        let retryCommitted = false;
        this.stateManager.runAtomic(() => {
          const relationVerified = this.stateManager.markUploadFileVerified(task.bvid, task.userId, task.mediaId, task.remoteFile);
          if (!this.jobStore.complete(task.persistentJobId, this.leaseOwner)) throw new Error("Encoding retry verification ownership changed before commit");
          if (relationVerified && this.jobStore.countEncodingRetryJobs(encodingRetry.parentJobId, encodingRetry.generation) === 0) {
            if (!this.jobStore.completeEncodingRetryParent(encodingRetry.parentJobId, encodingRetry.generation)) throw new Error("Encoding retry parent changed before final file verification commit");
            retryCommitted = true;
          }
        });
        if (this.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) this.stateManager.clearUploadCooldown();
        if (retryCommitted) this.afterEncodingRetryCommitted(task.bvid, encodingRetry);
        return;
      }
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (this.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) this.stateManager.clearUploadCooldown();
      if (payload.historyOnly) {
        const prefix = `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:history:${payload.historySnapshotAt || "unknown"}:`;
        if (!this.jobStore.hasDedupePrefix(prefix) && payload.historySnapshotAt) {
          markHistoryGroupUploaded(String(payload.localDir || ""), payload.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
          void this.maybeCleanupVerifiedLocalDir(task.bvid, String(payload.localDir || ""));
        }
      } else {
        const relationVerified = this.stateManager.markUploadFileVerified(task.bvid, task.userId, task.mediaId, task.remoteFile);
        if (relationVerified) void this.maybeCleanupVerifiedLocalDir(task.bvid, String(payload.localDir || ""));
      }
      return;
    }
    if (task.result.status === "mismatch") {
      const reason = `远端文件大小冲突：预期 ${task.expectedSize}，实际 ${task.result.remoteSize ?? "未知"}`;
      if (encodingRetry) {
        this.finishEncodingRetryFailure(task.bvid, encodingRetry, reason, "mismatch", task.persistentJobId);
        return;
      }
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      if (!payload.historyOnly) {
        this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
      }
      logManager.push({ timestamp: new Date().toISOString(), type: "upload", level: "error", summary: reason, raw: `[UploadVerify] mismatch ${redactRemotePathForDisplay(task.remoteFile)}`, bvid: task.bvid, simpleVisible: true });
      return;
    }

    this.deferMissingUploadVerification(task, job, payload);
  }

  private deferMissingUploadVerification(task: UploadVerificationTask, job: any, payload: any) {
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (payload.sessionId) {
      const session = this.transferSessions.get(String(payload.sessionId));
      const generation = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session?.generation;
      const fallbackPutAt = Date.parse(String(payload.putCompletedAt || ""));
      const pendingFiles = session && generation === session.generation
        ? this.transferSessions.listFiles(session.id, generation).filter((file) => file.status === "awaiting_remote")
        : [];
      const timing = computeUploadVerificationTiming(
        pendingFiles.map((file) => file.putAcceptedAt || fallbackPutAt).filter((value) => Number.isFinite(value)),
        Date.now(),
      );
      if (!timing.timedOut && timing.nextAt !== undefined) {
        const nextAt = Math.max(Date.now() + 1_000, timing.nextAt);
        const reason = "远端暂不可见，按各文件PUT时间继续确认";
        this.jobStore.defer(task.persistentJobId, this.leaseOwner, reason, nextAt);
        if (!payload.historyOnly) {
          for (const file of pendingFiles) {
            this.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, file.finalPath, nextAt, reason);
          }
        }
        this.schedulePersistentJobWake();
        return;
      }
    }
    const putAt = Date.parse(String(payload.putCompletedAt || "")) || Date.now();
    const elapsed = Math.max(0, Date.now() - putAt);
    const nextDelay = UPLOAD_VERIFY_SCHEDULE_MS.find((delayMs) => delayMs > elapsed + 250);
    if (nextDelay !== undefined) {
      const nextAt = Math.max(Date.now() + 1_000, putAt + nextDelay);
      const reason = "远端暂不可见，等待下一次确认";
      this.jobStore.retry(task.persistentJobId, this.leaseOwner, reason, nextAt);
      if (!payload.historyOnly) {
        this.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, nextAt, reason);
      }
      this.schedulePersistentJobWake();
      return;
    }

    const reason = "PUT 已成功，但远端在 10 分钟内仍不可见；已暂停自动重传，请在队列中手动继续";
    if (encodingRetry) {
      this.finishEncodingRetryFailure(
        task.bvid,
        encodingRetry,
        `编码替换上传后远端在 10 分钟内仍不可见，${reason}`,
        "missing",
        task.persistentJobId,
      );
      return;
    }
    this.jobStore.complete(task.persistentJobId, this.leaseOwner);
    if (!payload.historyOnly) {
      this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
    }
    const manualRecovery = this.queueUploadWork({
      bvid: task.bvid,
      localDir: String(payload.localDir || ""),
      remotePath: String(payload.remotePath || ""),
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: String(payload.folderTitle || ""),
      videoTitle: String(payload.videoTitle || ""),
      upperName: String(payload.upperName || ""),
      cover: String(payload.cover || ""),
      files: Array.isArray(payload.files) ? payload.files : [],
      filenameMetadataByPath: payload.filenameMetadataByPath,
      partialBackup: Boolean(payload.partialBackup),
      historyOnly: Boolean(payload.historyOnly),
      historySnapshotAt: payload.historySnapshotAt,
      sessionId: payload.sessionId,
      sessionGeneration: payload.sessionGeneration,
      allowReupload: false,
      notBefore: 0,
      priority: false,
      awaitingManualRecovery: true,
      resumeOnly: true,
      lifecycleState: "manual_required",
      attemptKey: payload.sessionId && payload.sessionGeneration
        ? `${payload.sessionId}:g${payload.sessionGeneration}`
        : undefined,
      strictMediaTarget: payload.strictMediaTarget,
    });
    if (manualRecovery) {
      const recovery = this.jobStore.findByDedupeKey(`upload:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${payload.remotePath || ""}:${payload.historyOnly ? payload.historySnapshotAt || "history" : "main"}`);
      if (recovery) this.jobStore.updatePayload(recovery.id, { ...recovery.payload, awaitingManualRecovery: true, allowReupload: false, resumeOnly: true });
    }
  }

  private queueUploadVerificationConflictRecovery(task: UploadVerificationTask, job: any, payload: any, failure: UploadFailureInfo) {
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (encodingRetry) {
      this.finishEncodingRetryFailure(task.bvid, encodingRetry, failure.summary, "mismatch", task.persistentJobId);
      return;
    }
    this.jobStore.complete(task.persistentJobId!, this.leaseOwner);
    const conflictRemotePath = failure.remotePath || task.remoteFile;
    if (!payload.historyOnly) {
      this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, conflictRemotePath, failure.summary);
    }

    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    const sessionGeneration = Number.isInteger(payload.sessionGeneration)
      ? Number(payload.sessionGeneration)
      : session?.generation;
    const sessionFiles = session && sessionGeneration !== undefined
      ? this.transferSessions.listFiles(session.id, sessionGeneration)
      : [];
    const files = Array.isArray(payload.files) && payload.files.length > 0
      ? payload.files
      : sessionFiles.map((file) => file.relativePath);
    const conflictFile = sessionFiles.find((file) => file.finalPath === conflictRemotePath);
    const manualRecovery = this.queueUploadWork({
      bvid: task.bvid,
      localDir: String(payload.localDir || session?.localDir || ""),
      remotePath: String(payload.remotePath || session?.remotePath || ""),
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: String(payload.folderTitle || ""),
      videoTitle: String(payload.videoTitle || ""),
      upperName: String(payload.upperName || ""),
      cover: String(payload.cover || ""),
      files,
      filenameMetadataByPath: payload.filenameMetadataByPath,
      partialBackup: Boolean(payload.partialBackup),
      historyOnly: Boolean(payload.historyOnly),
      historySnapshotAt: payload.historySnapshotAt,
      sessionId: payload.sessionId,
      sessionGeneration,
      allowReupload: false,
      notBefore: 0,
      priority: false,
      awaitingManualRecovery: true,
      resumeOnly: true,
      lifecycleState: "manual_required",
      attemptKey: session?.id && sessionGeneration !== undefined
        ? `${session.id}:g${sessionGeneration}`
        : undefined,
      strictMediaTarget: payload.strictMediaTarget,
    });
    if (manualRecovery) {
      const recoveryKey = `upload:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${payload.remotePath || session?.remotePath || ""}:${payload.historyOnly ? payload.historySnapshotAt || "history" : "main"}`;
      const recovery = this.jobStore.findByDedupeKey(recoveryKey);
      if (recovery) {
        this.jobStore.updatePayload(recovery.id, {
          ...recovery.payload,
          awaitingManualRecovery: true,
          allowReupload: false,
          resumeOnly: true,
          sessionGeneration,
          conflictRemotePath,
          conflictRelativePath: conflictFile?.relativePath,
          manualRecoveryReason: failure.summary,
        });
      }
    }
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "upload",
      level: "error",
      summary: `${task.historyOnly ? "历史分P" : "上传"}确认发现远端文件冲突，已暂停 ${task.bvid}：请处理后重新确认或继续上传`,
      raw: `[UploadVerify] conflict parked path=${redactRemotePathForDisplay(conflictRemotePath)}`,
      bvid: task.bvid,
      simpleVisible: true,
    });
  }

  private handleUploadVerificationError(task: UploadVerificationTask, error: any) {
    const job = task.persistentJob as any;
    if (!job || !task.persistentJobId) return;
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext((job.payload as any)?.encodingRetry);
    if (encodingRetry && !this.isEncodingRetryParentActive(encodingRetry)) {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      this.dispatchPersistentJobs();
      return;
    }
    if (error?.uploadSessionStale) {
      if (encodingRetry) {
        this.finishEncodingRetryFailure(task.bvid, encodingRetry, "上传确认会话已失效；未执行归档替换。", "error", task.persistentJobId);
        return;
      }
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      this.dispatchPersistentJobs();
      return;
    }
    const failure: UploadFailureInfo = error?.uploadFailure || classifyUploadError(error, task.remoteFile);
    this.uploadCircuit.recordFailure(`verify:${task.bvid}`, failure);
    if (this.uploadCircuit.getSnapshot().state !== "closed") {
      this.stateManager.setUploadCooldown(this.uploadCircuit.getSnapshot() as any);
    }
    if (failure.category === "deterministic" && failure.status === 409) {
      this.queueUploadVerificationConflictRecovery(task, job, job.payload as any, failure);
      this.schedulePersistentJobWake();
      return;
    }
    const delayMs = failure.retryAfterMs || 60_000;
    const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, Date.now() + delayMs);
    if (result.exhausted) {
      if (encodingRetry) {
        this.finishEncodingRetryFailure(task.bvid, encodingRetry, `编码替换远端确认失败：${failure.summary}`, "error", task.persistentJobId);
        return;
      }
      this.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, failure.summary);
    }
    this.scheduleUploadProbe();
    this.schedulePersistentJobWake();
  }

  private scheduleLocalCleanupRetryTimer() {
    if (this.localCleanupRetryTimer) {
      clearTimeout(this.localCleanupRetryTimer);
      this.localCleanupRetryTimer = null;
    }
    if (!this.acceptingJobs || this.localCleanupRetries.size === 0) return;
    const next = [...this.localCleanupRetries.values()]
      .map((item) => item.nextAt)
      .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) return;
    this.localCleanupRetryTimer = setTimeout(() => {
      this.localCleanupRetryTimer = null;
      const now = this.now();
      for (const [bvid, item] of this.localCleanupRetries) {
        if (item.nextAt <= now) this.requestLocalCleanup(bvid, item.localDir);
      }
      this.scheduleLocalCleanupRetryTimer();
    }, Math.max(1_000, next - this.now()));
    this.localCleanupRetryTimer.unref?.();
  }

  private scheduleLocalCleanupRetry(bvid: string, localDir: string) {
    const previous = this.localCleanupRetries.get(bvid);
    const attempts = (previous?.attempts || 0) + 1;
    this.localCleanupRetries.set(bvid, {
      attempts,
      nextAt: this.now() + computeLocalCleanupRetryDelayMs(attempts - 1),
      localDir,
    });
    this.scheduleLocalCleanupRetryTimer();
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "system",
      level: "warn",
      summary: `已验证归档暂未完成本地清理，将在稍后自动重试 ${bvid}`,
      raw: `[DownloadRecovery] remote proof was not ready for local cleanup; attempt=${attempts}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  private startLocalCleanupSweep() {
    if (this.localCleanupSweepPromise || !this.acceptingJobs) return;
    this.localCleanupSweepPromise = (async () => {
      let cursor: import("./database.js").VerifiedLocalCleanupCursor | null = null;
      while (this.acceptingJobs) {
        const page = this.stateManager.listVerifiedLocalCleanupPage(cursor, 25);
        if (page.items.length === 0) break;
        for (const video of page.items) {
          if (!this.acceptingJobs) break;
          const directories = new Set(this.stateManager.getLocalCleanupPlans(video.bvid).map((plan) => plan.localDir));
          for (const localDir of directories) {
            const work = this.requestLocalCleanup(video.bvid, localDir);
            if (work) await work;
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
    })().catch((error) => {
      console.warn(`[Scheduler] Verified local cleanup sweep stopped: ${safeErrorSummary(error)}`);
    }).finally(() => {
      this.localCleanupSweepPromise = null;
    });
  }

  private localCleanupRetryableError() {
    const error: any = new Error("Remote archive proof is not ready for local cleanup");
    error.localCleanupRetryable = true;
    return error;
  }

  private async inspectCleanupRemoteFile(config: AppConfig, file: RemoteFileRecord) {
    if (!file.path || !Number.isFinite(Number(file.size))) return "structural" as const;
    try {
      const result = await this.remoteFileInspector(config, file.path, Number(file.size));
      return result.status === "verified" ? "verified" as const : "remote_retry" as const;
    } catch {
      return "remote_retry" as const;
    }
  }

  private async inspectCleanupHistoryFile(config: AppConfig, remotePath: string, expectedSize: number) {
    if (!remotePath || !Number.isFinite(expectedSize)) return "structural" as const;
    try {
      const result = await this.remoteFileInspector(config, remotePath, expectedSize);
      return result.status === "verified" ? "verified" as const : "remote_retry" as const;
    } catch {
      return "remote_retry" as const;
    }
  }

  private cleanupGenerationIsCurrent(plan: LocalCleanupPlan) {
    if (!plan.transferSessionId) return plan.reason === "quality_upgrade";
    const session = this.transferSessions.get(plan.transferSessionId);
    return Boolean(session && session.generation === plan.transferGeneration && session.phase === "completed");
  }

  private async performVerifiedLocalCleanup(bvid: string, localDir: string) {
    if (!this.acceptingJobs || !localDir) return;
    if (this.jobStore.hasActiveJobsForBvid(bvid) || this.transferSessions.hasActiveForBvid(bvid)) return;
    const cleanupPlans = this.stateManager.getLocalCleanupPlans(bvid, localDir);
    if (cleanupPlans.length === 0) return;
    if (path.basename(path.resolve(localDir)) !== bvid) {
      return this.performPlannedLocalCleanup(bvid, localDir, cleanupPlans);
    }

    const video = this.stateManager.getDatabase().getVideo(bvid);
    if (!video) return;
    video.localDir = localDir;
    if (!["verified", "partial_verified"].includes(video.backupStatus || "")) return;
    const relations = this.stateManager.listRelationsForBvid(bvid);
    if (relations.length === 0 || relations.some((relation) => !["verified", "partial_verified"].includes(relation.backupStatus || ""))) return;

    const tempRoot = path.resolve(this.legacyTempDir);
    const candidateDir = path.resolve(localDir);
    if (candidateDir === tempRoot || !candidateDir.startsWith(`${tempRoot}${path.sep}`) || path.basename(candidateDir) !== bvid) return;
    let localStat: fs.Stats;
    try {
      localStat = await fs.promises.lstat(candidateDir);
      if (!localStat.isDirectory() || localStat.isSymbolicLink()) return;
      const [realRoot, realCandidate] = await Promise.all([
        fs.promises.realpath(tempRoot),
        fs.promises.realpath(candidateDir),
      ]);
      if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${path.sep}`)) return;
    } catch {
      return;
    }

    const manifest = readDownloadSession(localDir);
    if (!manifest || manifest.bvid !== bvid || !["complete", "partial"].includes(manifest.status)) return;

    const normalizeRelative = (value: string) => value.replace(/\\/g, "/");
    const localFileIsValid = async (relativePath: string, expectedSize: number) => {
      const normalized = normalizeRelative(relativePath);
      const localFile = path.resolve(localDir, normalized);
      const localRoot = path.resolve(localDir);
      if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) return false;
      try {
        const stat = await fs.promises.lstat(localFile);
        return stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedSize ? stat : false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" as const : false;
      }
    };

    const proofByRelativePath = new Map<string, RemoteFileRecord[]>();
    const addProof = (file: RemoteFileRecord) => {
      if (["awaiting_verification", "failed"].includes(file.verificationStatus || "")) return;
      const relative = file.localRelativePath ? normalizeRelative(file.localRelativePath) : "";
      if (!relative || !Number.isFinite(Number(file.size)) || !file.path) return;
      const list = proofByRelativePath.get(relative) || [];
      if (!list.some((candidate) => candidate.path === file.path && candidate.size === file.size)) list.push(file);
      proofByRelativePath.set(relative, list);
    };
    for (const file of video.remoteFiles || []) addProof(file);
    for (const relation of relations) {
      for (const file of relation.remoteFiles || []) addProof(file);
    }

    const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
    const authorizedFiles: DownloadCleanupAuthorization[] = [];
    for (const plan of cleanupPlans) {
      if (plan.manifestSessionId !== manifest.sessionId || !this.cleanupGenerationIsCurrent(plan)) return;
      for (const planned of plan.files) {
        const relativePath = normalizeRelative(planned.relativePath);
        const output = manifestFiles.find((file) => normalizeRelative(file.relativePath) === relativePath);
        if (!output) continue;
        if (Number(output.size) !== Number(planned.expectedSize)) return;
        const localIdentity = await localFileIsValid(relativePath, Number(planned.expectedSize));
        if (!localIdentity) return;
        const proofs = (proofByRelativePath.get(relativePath) || [])
          .filter((file) => Number(file.size) === Number(planned.expectedSize) && planned.remotePaths.includes(file.path));
        if (proofs.length === 0) return;
        let verified = false;
        for (const proof of proofs) {
          if (await this.inspectCleanupRemoteFile(this.configStore.get(), proof) === "verified") {
            verified = true;
            break;
          }
        }
        if (!verified) throw this.localCleanupRetryableError();
        authorizedFiles.push({
          relativePath,
          expectedSize: Number(planned.expectedSize),
          manifestSessionId: manifest.sessionId,
          expectedIdentity: planned.expectedIdentity,
        });
      }
    }
    const authorizedPaths = new Set(authorizedFiles.map((file) => normalizeRelative(file.relativePath)));
    if (authorizedPaths.size === 0 && manifestFiles.length > 0) return;
    if (!this.acceptingJobs) return;
    const cleanupOptions: DownloadCleanupOptions = {
      authorizedFiles,
      canDelete: () => this.acceptingJobs && cleanupPlans.every((plan) => this.cleanupGenerationIsCurrent(plan))
        && !this.jobStore.hasActiveJobsForBvid(bvid) && !this.transferSessions.hasActiveForBvid(bvid),
      preserveManifest: manifestFiles.some((file) => !authorizedPaths.has(normalizeRelative(file.relativePath))),
    };
    await this.cleanupSharedUploadDir(localDir, new Set([bvid]), cleanupOptions);
  }

  private async performPlannedLocalCleanup(
    bvid: string,
    localDir: string,
    cleanupPlans = this.stateManager.getLocalCleanupPlans(bvid, localDir),
  ) {
    if (!this.acceptingJobs || !localDir || cleanupPlans.length === 0) return;
    if (this.jobStore.hasActiveJobsForBvid(bvid) || this.transferSessions.hasActiveForBvid(bvid)) return;
    if (!this.isSafeEncodingRetryDirectory(localDir)) return;

    const manifest = readDownloadSession(localDir);
    if (!manifest || manifest.bvid !== bvid || !["complete", "partial"].includes(manifest.status)) return;
    const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
    const proofByRelativePath = new Map<string, RemoteFileRecord[]>();
    const addProof = (file: RemoteFileRecord) => {
      const relativePath = String(file.localRelativePath || "").replace(/\\/g, "/");
      if (!relativePath || !file.path || !Number.isFinite(Number(file.size)) || ["awaiting_verification", "failed"].includes(file.verificationStatus || "")) return;
      const list = proofByRelativePath.get(relativePath) || [];
      if (!list.some((candidate) => candidate.path === file.path && Number(candidate.size) === Number(file.size))) list.push(file);
      proofByRelativePath.set(relativePath, list);
    };
    const video = this.stateManager.getDatabase().getVideo(bvid);
    for (const file of video?.remoteFiles || []) addProof(file);
    for (const relation of this.stateManager.listRelationsForBvid(bvid)) {
      for (const file of relation.remoteFiles || []) addProof(file);
    }

    const authorizedFiles: DownloadCleanupAuthorization[] = [];
    for (const plan of cleanupPlans) {
      if (plan.manifestSessionId !== manifest.sessionId || !this.cleanupGenerationIsCurrent(plan)) return;
      for (const planned of plan.files) {
        const relativePath = String(planned.relativePath || "").replace(/\\/g, "/");
        const manifestFile = manifestFiles.find((file) => file.relativePath.replace(/\\/g, "/") === relativePath);
        if (!manifestFile) continue;
        if (Number(manifestFile.size) !== Number(planned.expectedSize)) return;
        const localFile = path.resolve(localDir, relativePath);
        const localRoot = path.resolve(localDir);
        if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) return;
        try {
          const localIdentity = await fs.promises.lstat(localFile);
          if (!localIdentity.isFile() || localIdentity.isSymbolicLink() || localIdentity.size !== Number(planned.expectedSize)) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
        }
        const proofs = (proofByRelativePath.get(relativePath) || [])
          .filter((file) => Number(file.size) === Number(planned.expectedSize) && planned.remotePaths.includes(file.path));
        if (proofs.length === 0) return;
        let verified = false;
        for (const proof of proofs) {
          if (await this.inspectCleanupRemoteFile(this.configStore.get(), proof) === "verified") {
            verified = true;
            break;
          }
        }
        if (!verified) throw this.localCleanupRetryableError();
        authorizedFiles.push({ relativePath, expectedSize: Number(planned.expectedSize), manifestSessionId: manifest.sessionId,
          expectedIdentity: planned.expectedIdentity });
      }
    }
    const authorizedPaths = new Set(authorizedFiles.map((file) => file.relativePath));
    if (authorizedPaths.size === 0 && manifestFiles.length > 0) return;
    await this.cleanupSharedUploadDir(localDir, new Set([bvid]), {
      authorizedFiles,
      canDelete: () => this.acceptingJobs && cleanupPlans.every((plan) => this.cleanupGenerationIsCurrent(plan))
        && !this.jobStore.hasActiveJobsForBvid(bvid) && !this.transferSessions.hasActiveForBvid(bvid),
      preserveManifest: manifestFiles.some((file) => !authorizedPaths.has(file.relativePath.replace(/\\/g, "/"))),
    });
  }

  private localArchiveReleaseCandidates(bvid: string) {
    const groups = new Map<string, LocalCleanupPlan[]>();
    for (const plan of this.stateManager.getLocalCleanupPlans(bvid)) {
      const key = `${plan.localDir}\u0000${plan.manifestSessionId}`;
      const list = groups.get(key) || [];
      list.push(plan);
      groups.set(key, list);
    }
    const candidates: Array<{ releaseId: string; localDir: string; manifestSessionId: string; fileCount: number; totalBytes: number;
      manualFiles?: DownloadCleanupAuthorization[]; sessionStamp?: string; hasVerifiedArchive?: boolean }> = [];
    for (const plans of groups.values()) {
      if (plans.length === 0 || !plans.every((plan) => this.cleanupGenerationIsCurrent(plan))) continue;
      const localDir = plans[0].localDir;
      const manifest = readDownloadSession(localDir);
      if (!manifest || manifest.bvid !== bvid || manifest.sessionId !== plans[0].manifestSessionId) continue;
      const manifestFiles = new Map([...manifest.outputs, ...(manifest.history || [])]
        .map((file) => [String(file.relativePath).replace(/\\/g, "/"), file] as const));
      const files = new Map<string, LocalCleanupPlan["files"][number]>();
      let stale = false;
      for (const plan of plans) {
        if (plan.localDir !== localDir || plan.manifestSessionId !== manifest.sessionId) { stale = true; break; }
        for (const file of plan.files) {
          const relativePath = String(file.relativePath).replace(/\\/g, "/");
          const manifestFile = manifestFiles.get(relativePath);
          if (!manifestFile || Number(manifestFile.size) !== Number(file.expectedSize)) { stale = true; break; }
          const target = path.resolve(localDir, relativePath);
          const root = path.resolve(localDir);
          if (target === root || !target.startsWith(`${root}${path.sep}`)) { stale = true; break; }
          try {
            const stat = fs.lstatSync(target);
            const identity = file.expectedIdentity;
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(file.expectedSize)
              || stat.dev !== identity.dev || stat.ino !== identity.ino
              || stat.mtimeMs !== identity.mtimeMs || stat.ctimeMs !== identity.ctimeMs) {
              stale = true;
              break;
            }
            const previous = files.get(relativePath);
            if (previous && (previous.expectedSize !== file.expectedSize
              || JSON.stringify(previous.expectedIdentity) !== JSON.stringify(file.expectedIdentity))) {
              stale = true;
              break;
            }
            files.set(relativePath, file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            stale = true;
            break;
          }
        }
        if (stale) break;
      }
      if (stale || files.size === 0) continue;
      const orderedFiles = [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const releaseId = crypto.createHash("sha256").update(JSON.stringify({
        bvid,
        localDir,
        manifestSessionId: manifest.sessionId,
        planIds: plans.map((plan) => plan.id).sort(),
        files: orderedFiles.map((file) => ({
          relativePath: file.relativePath,
          expectedSize: file.expectedSize,
          expectedIdentity: file.expectedIdentity,
        })),
      })).digest("hex").slice(0, 32);
      candidates.push({
        releaseId,
        localDir,
        manifestSessionId: manifest.sessionId,
        fileCount: orderedFiles.length,
        totalBytes: orderedFiles.reduce((sum, file) => sum + Number(file.expectedSize || 0), 0),
      });
    }
    // Failed/stopped attempts have no success cleanup plan. User authorization
    // is resolved separately from automatic cleanup, using only tracked files.
    const database = this.stateManager.getDatabase().db;
    const directories = new Set<string>([this.stateManager.getDatabase().getVideo(bvid)?.localDir || ""]);
    for (const row of database.prepare("SELECT local_dir FROM transfer_sessions WHERE bvid=?").all(bvid) as any[]) {
      if (row.local_dir) directories.add(row.local_dir);
    }
    for (const row of database.prepare("SELECT payload_json FROM jobs WHERE bvid=?").all(bvid) as any[]) {
      const payload = JSON.parse(row.payload_json);
      for (const dir of [payload.localDir, payload.downloadDir, payload.encodingRetry?.candidateLocalDir, payload.encodingRetry?.originalLocalDir]) {
        if (typeof dir === "string") directories.add(dir);
      }
    }
    for (const localDir of directories) {
      if (!localDir || candidates.some((item) => path.resolve(item.localDir) === path.resolve(localDir))) continue;
      try {
        const root = fs.realpathSync(this.legacyTempDir);
        const realDir = fs.realpathSync(localDir);
        if (!realDir.startsWith(`${root}${path.sep}`) || fs.lstatSync(localDir).isSymbolicLink()) continue;
        const manifest = readDownloadSession(localDir);
        if (!manifest || manifest.bvid !== bvid) continue;
        const files = new Map<string, DownloadCleanupAuthorization>();
        for (const file of [...manifest.outputs, ...(manifest.history || [])]) {
          const target = path.resolve(localDir, file.relativePath);
          if (!target.startsWith(`${path.resolve(localDir)}${path.sep}`)) continue;
          try {
            if (!fs.realpathSync(target).startsWith(`${realDir}${path.sep}`)) continue;
            const stat = fs.lstatSync(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) continue;
            files.set(file.relativePath, { relativePath: file.relativePath, expectedSize: stat.size,
              manifestSessionId: manifest.sessionId,
              expectedIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } });
          } catch { /* Missing or changed files are not deletion candidates. */ }
        }
        if (!files.size) continue;
        const manualFiles = [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        const sessionStamp = this.localReleaseSessionStamp(bvid);
        const hasVerifiedArchive = this.stateManager.listRelationsForBvid(bvid).some((relation) =>
          relation.remoteFiles?.some((file) => file.verificationStatus === "verified"));
        const releaseId = crypto.createHash("sha256").update(JSON.stringify({ bvid, localDir, manifest, manualFiles, sessionStamp })).digest("hex").slice(0, 32);
        candidates.push({ releaseId, localDir, manifestSessionId: manifest.sessionId,
          fileCount: manualFiles.length, totalBytes: manualFiles.reduce((sum, file) => sum + file.expectedSize, 0),
          manualFiles, sessionStamp, hasVerifiedArchive });
      } catch { /* Only existing, bounded, manifest-backed directories qualify. */ }
    }
    return candidates;
  }

  private localReleaseSessionStamp(bvid: string) {
    return JSON.stringify(this.stateManager.getDatabase().db.prepare(
      "SELECT id, generation, phase FROM transfer_sessions WHERE bvid=? ORDER BY id"
    ).all(bvid));
  }

  previewLocalArchiveRelease(bvidValue: string) {
    const bvid = String(bvidValue || "").trim();
    if (!bvid || !this.stateManager.getVideoMeta(bvid)) {
      return { ok: false as const, status: 404 as const, message: "本地没有该视频记录" };
    }
    const candidates = this.localArchiveReleaseCandidates(bvid);
    return {
      ok: true as const,
      bvid,
      fileCount: candidates.reduce((sum, item) => sum + item.fileCount, 0),
      totalBytes: candidates.reduce((sum, item) => sum + item.totalBytes, 0),
      candidates: candidates.map(({ localDir: _localDir, manualFiles, sessionStamp: _stamp, ...item }) => ({
        ...item, requiresExplicitDeletion: Boolean(manualFiles),
      })),
    };
  }

  requestLocalArchiveRelease(bvidValue: string, releaseIdValue: string, confirmation: string) {
    const bvid = String(bvidValue || "").trim();
    const releaseId = String(releaseIdValue || "").trim();
    if (confirmation !== "DELETE LOCAL") {
      return { ok: false as const, status: 400 as const, message: "请输入 DELETE LOCAL 确认释放本地文件" };
    }
    const candidate = this.localArchiveReleaseCandidates(bvid).find((item) => item.releaseId === releaseId);
    if (!candidate) {
      return { ok: false as const, status: 409 as const, message: "本地文件或归档授权已变化，请重新预览后再操作" };
    }
    if (this.jobStore.hasActiveJobsForBvid(bvid) || this.transferSessions.hasActiveForBvid(bvid)) {
      return { ok: false as const, status: 409 as const, message: "该视频仍有传输任务，请先停止本次尝试，再删除本地文件" };
    }
    if (candidate.manualFiles) {
      if (!this.acceptingJobs || this.localCleanupInFlight.has(bvid)) {
        return { ok: false as const, status: 409 as const, message: "本地清理正在进行，请稍后重试" };
      }
      const work = this.cleanupSharedUploadDir(candidate.localDir, new Set([bvid]), {
        authorizedFiles: candidate.manualFiles,
        canDelete: () => this.acceptingJobs && this.localReleaseSessionStamp(bvid) === candidate.sessionStamp
          && !this.jobStore.hasActiveJobsForBvid(bvid) && !this.transferSessions.hasActiveForBvid(bvid),
      }).finally(() => this.localCleanupInFlight.delete(bvid));
      this.localCleanupInFlight.set(bvid, work);
      return { ok: true as const, status: 202 as const, bvid, releaseId, fileCount: candidate.fileCount, totalBytes: candidate.totalBytes };
    }
    const work = this.requestLocalCleanup(bvid, candidate.localDir);
    if (!work) {
      return { ok: false as const, status: 409 as const, message: "本地清理正在进行或等待安全复核，请稍后重试" };
    }
    void work;
    return { ok: true as const, status: 202 as const, bvid, releaseId, fileCount: candidate.fileCount, totalBytes: candidate.totalBytes };
  }
  private requestLocalCleanup(bvid: string, localDir: string) {
    if (!this.acceptingJobs || !localDir) return null;
    const active = this.localCleanupInFlight.get(bvid);
    if (active) return active;
    const retry = this.localCleanupRetries.get(bvid);
    if (retry && retry.nextAt > this.now()) return null;
    const work = this.performVerifiedLocalCleanup(bvid, localDir)
      .then(() => {
        this.localCleanupRetries.delete(bvid);
        this.scheduleLocalCleanupRetryTimer();
      })
      .catch((error: any) => {
        if (error?.localCleanupRetryable) {
          this.scheduleLocalCleanupRetry(bvid, localDir);
        } else {
          console.warn(`[Scheduler] Verified local cleanup skipped for ${bvid}: ${safeErrorSummary(error)}`);
        }
      })
      .finally(() => {
        this.localCleanupInFlight.delete(bvid);
      });
    this.localCleanupInFlight.set(bvid, work);
    return work;
  }

  private async maybeCleanupVerifiedLocalDir(bvid: string, localDir: string) {
    const work = this.requestLocalCleanup(bvid, localDir);
    if (work) await work;
  }

  private uploadTaskKey(task: any) {
    return `${task?.userId || "quality"}:${task?.mediaId || 0}:${task?.bvid || task?.id || "upload"}:${task?.historyOnly ? task?.remotePath || "history" : "main"}`;
  }

  private isSafeEncodingRetryDirectory(value: string, expectedPrefix?: string) {
    const root = path.resolve(this.legacyTempDir);
    const candidate = path.resolve(String(value || ""));
    if (!candidate || candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return false;
    if (expectedPrefix && !path.basename(candidate).startsWith(expectedPrefix)) return false;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) return false;
    } catch {
      // A not-yet-created candidate is safe to create below the validated root.
    }
    return true;
  }

  private encodingRetryTargets(context: EncodingRetryContext) {
    return context.target ? [{ userId: context.target.userId, mediaId: context.target.mediaId }] : [];
  }

  private isEncodingRetryParentActive(context: EncodingRetryContext) {
    const parent = this.jobStore.findById(context.parentJobId);
    const retry = (parent?.payload as any)?.encodingRetry;
    return Boolean(retry
      && Number(retry.generation) === Number(context.generation)
      && ["running", "uploading", "verifying"].includes(String(retry.state || "")));
  }

  private restoreEncodingRetryOriginal(bvid: string, context: EncodingRetryContext, reason: string) {
    const target = context.target;
    if (target) {
      this.stateManager.markUploadFailed(bvid, context.originalLocalDir, target.userId, target.mediaId, reason);
      return;
    }
    this.stateManager.markUploadFailed(bvid, context.originalLocalDir, undefined, undefined, reason);
  }

  private finishEncodingRetryFailure(
    bvid: string,
    context: EncodingRetryContext,
    reason: string,
    remoteStatus: RecoveryAssessment["remoteStatus"] = "error",
    childJobId?: string,
    assessmentKind: RecoveryAssessment["kind"] = "encoding_retry_failed",
    payloadPatch: Record<string, unknown> = {},
  ) {
    const summary = sanitizeUploadText(reason, 300);
    const encodingDiagnostic = payloadPatch.requestedEncoding
      ? {
        requestedEncoding: payloadPatch.requestedEncoding as BBDownEncoding,
        actualEncodings: Array.isArray(payloadPatch.actualEncodings)
          ? payloadPatch.actualEncodings.map(String).filter(Boolean)
          : [],
        encodingMismatch: payloadPatch.encodingMismatch !== false,
        verifiedPages: Math.max(0, Number(payloadPatch.verifiedPages || 0)),
      }
      : {};
    const qualityDiagnostic = payloadPatch.requestedQuality
      ? {
        requestedQuality: String(payloadPatch.requestedQuality),
        actualQualities: Array.isArray(payloadPatch.actualQualities)
          ? payloadPatch.actualQualities.map(String).filter(Boolean)
          : [],
        qualityMismatch: payloadPatch.qualityMismatch !== false,
        verifiedPages: Math.max(0, Number(payloadPatch.verifiedPages || 0)),
      }
      : {};
    const originalLocal = this.inspectLocalArchiveDirectory(context.originalLocalDir);
    const assessment: RecoveryAssessment = {
      kind: assessmentKind,
      checkedAt: this.now(),
      localStatus: originalLocal.status,
      remoteStatus,
      summary,
      ...encodingDiagnostic,
      ...qualityDiagnostic,
    };
    const updated = this.jobStore.finishEncodingRetry(context.parentJobId, context.generation, {
      recoveryAssessment: assessment,
      manualRecoveryReason: summary,
      ...payloadPatch,
    });
    if (childJobId) this.jobStore.complete(childJobId, this.leaseOwner);
    if (!updated) {
      this.dispatchPersistentJobs();
      return false;
    }
    this.restoreEncodingRetryOriginal(bvid, context, summary);
    this.jobStore.cancelEncodingRetryChildren(context.parentJobId, context.generation);
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "upload",
      level: "error",
      summary: originalLocal.status === "available"
        ? `编码替换未完成，已验证本地原文件仍完整 ${bvid}`
        : originalLocal.retainedBytes > 0
          ? `编码替换未完成，已确认仍有 ${originalLocal.retainedBytes} 字节本地文件；完整性尚未确认 ${bvid}`
          : `编码替换未完成，本地原文件完整性尚未确认 ${bvid}`,
      raw: `[EncodingRetry] failed bvid=${bvid} reason=${summary}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return true;
  }

  private afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext) {
    if (this.isEncodingRetryParentActive(context)) {
      this.dispatchPersistentJobs();
      return;
    }
    void this.maybeCleanupVerifiedLocalDir(bvid, context.candidateLocalDir);
    logManager.push({ timestamp: new Date(this.now()).toISOString(), type: "upload", level: "info",
      summary: `编码替换已完成并通过远端确认 ${bvid}`, raw: `[EncodingRetry] completed bvid=${bvid}`,
      bvid, simpleVisible: true, debugVisible: true });
    this.dispatchPersistentJobs();
  }
  private handleEncodingRetryDownloadError(task: DownloadTask, error: any) {
    const context = task.encodingRetry;
    if (!context || !task.persistentJobId) return;
    if (!this.isEncodingRetryParentActive(context)) {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      this.dispatchPersistentJobs();
      return;
    }
    const summary = sanitizeUploadText(error?.message || error || "编码替换下载失败", 500);
    if (error?.encodingValidation) {
      const assessment = error.encodingAssessment;
      this.finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || summary,
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictEncodingDiagnosticPatch(assessment) : {},
      );
      return;
    }
    if (error?.qualityValidation) {
      const assessment = error.qualityAssessment;
      this.finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || summary,
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictQualityDiagnosticPatch(assessment) : {},
      );
      return;
    }
    const apiRetryAt = this.handleDownloadApiFailure(task, error);
    const job = task.persistentJob as any;
    if (!error?.permanent && apiRetryAt) {
      this.stateManager.markDownloadInterrupted(task.bvid, context.candidateLocalDir, summary, this.encodingRetryTargets(context));
      this.jobStore.defer(task.persistentJobId, this.leaseOwner, summary, apiRetryAt);
      this.dispatchPersistentJobs();
      return;
    }
    if (!error?.permanent) {
      const retryAt = this.now() + computeTaskRetryDelayMs(
        this.configStore.get().retryDelaySeconds,
        Number(job?.attempts || 0),
        error?.retryAfterMs,
      );
      const result = this.jobStore.retry(task.persistentJobId, this.leaseOwner, summary, retryAt);
      if (!result.exhausted) {
        this.stateManager.markDownloadInterrupted(task.bvid, context.candidateLocalDir, summary, this.encodingRetryTargets(context));
        this.dispatchPersistentJobs();
        return;
      }
    }
    this.finishEncodingRetryFailure(
      task.bvid,
      context,
      `按 ${[context.quality, context.priority[0]].filter(Boolean).join(" / ")} 重新下载失败：${summary}`,
      "error",
      task.persistentJobId,
    );
  }

  private handleEncodingRetryUploadError(task: UploadTask, error: any) {
    const context = task.encodingRetry;
    if (!context || !task.persistentJobId) return;
    if (!this.isEncodingRetryParentActive(context)) {
      this.jobStore.complete(task.persistentJobId, this.leaseOwner);
      this.dispatchPersistentJobs();
      return;
    }
    if (error?.encodingValidation) {
      const assessment = error.encodingAssessment;
      this.finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || sanitizeUploadText(error?.message || error, 500),
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictEncodingDiagnosticPatch(assessment) : {},
      );
      return;
    }
    if (error?.qualityValidation) {
      const assessment = error.qualityAssessment;
      this.finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || sanitizeUploadText(error?.message || error, 500),
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictQualityDiagnosticPatch(assessment) : {},
      );
      return;
    }
    const failure = this.recordUploadFailure(task, error);
    const job = task.persistentJob as any;
    const deterministic = failure.category === "deterministic" || failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE;
    if (!deterministic && !error?.uploadSessionStale) {
      const uploadHealth = this.uploadCircuit.getSnapshot();
      const retryAt = uploadHealth.retryAt || this.now() + Math.max(60_000, failure.retryAfterMs || 0);
      const retry = this.jobStore.retry(task.persistentJobId, this.leaseOwner, failure.summary, retryAt);
      if (!retry.exhausted) {
        this.dispatchPersistentJobs();
        return;
      }
    }
    const status = failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE ? "size_limit" : (failure.status === 409 ? "mismatch" : "error");
    this.finishEncodingRetryFailure(
      task.bvid,
      context,
      `按 ${[context.quality, context.priority[0]].filter(Boolean).join(" / ")} 重新上传失败：${failure.summary}`,
      status,
      task.persistentJobId,
    );
  }

  private restoreConflictCandidateExistingArchive(task: UploadTask) {
    const proof = task.result?.conflictCandidate?.existingArchiveProof || task.existingArchiveProof;
    if (!proof) return false;
    return this.stateManager.restoreExistingArchiveProof(
      task.bvid,
      task.userId,
      task.mediaId,
      proof,
    );
  }

  private supersedeUploadTaskSession(task: UploadTask) {
    if (!task.sessionId) return;
    const session = this.transferSessions.get(task.sessionId);
    if (!session) return;
    const generation = Number.isInteger(task.sessionGeneration) ? Number(task.sessionGeneration) : session.generation;
    if (session.generation === generation && !["completed", "superseded"].includes(session.phase)) {
      this.transferSessions.supersede(session.id, generation);
    }
  }

  private markUploadTaskFailed(task: UploadTask, reason: string) {
    if (task.conflictCandidateAttempted && this.restoreConflictCandidateExistingArchive(task)) return;
    this.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, reason);
  }

  private recordUploadFailure(task: UploadTask | QualityUploadPhaseTask, error: any) {
    const failure: UploadFailureInfo = error?.uploadFailure || classifyUploadError(error, task.remotePath || "<remote>");
    // A provider's per-file quota is a deterministic item-level condition,
    // not evidence that the whole WebDAV backend is unhealthy. Park the item
    // without opening the global upload circuit for unrelated videos.
    if (failure.code !== REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE && !failure.remoteWriteEvidence) {
      this.uploadCircuit.recordFailure(this.uploadTaskKey(task), failure);
      if (this.uploadCircuit.getSnapshot().state !== "closed") {
        this.stateManager.setUploadCooldown(this.uploadCircuit.getSnapshot() as any);
      }
    }
    this.scheduleUploadProbe();
    this.downloadQueue.poke();
    return failure;
  }

  private queueAutomaticQualityRecovery(jobId: string, failure: UploadFailureInfo) {
    if (!["transient", "rate_limit", "server", "unknown"].includes(failure.category)) return false;
    const current = this.jobStore.findById(jobId);
    if (!current || current.status !== "failed") return false;
    const payload = current.payload as any;
    const attempts = Math.max(0, Number(payload.automaticQualityRecoveryAttempts || 0));
    if (attempts >= AUTOMATIC_QUALITY_RECOVERY_LIMIT) return false;
    const nextAt = this.now() + computeAutomaticQualityRecoveryDelayMs(attempts);
    const woken = this.jobStore.wakeManualJob(jobId, {
      automaticQualityRecoveryAttempts: attempts + 1,
      automaticQualityRecoveryCategory: failure.category,
      automaticQualityRecoveryError: failure.summary,
      awaitingManualRecovery: false,
    }, nextAt);
    if (!woken) return false;
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "system",
      level: "warn",
      summary: `画质重调遇到临时${failure.category === "rate_limit" ? "限流" : "存储"}错误，已安排后台重试 ${current.bvid || ""}`,
      raw: `[QualityRecovery] automatic retry=${attempts + 1}/${AUTOMATIC_QUALITY_RECOVERY_LIMIT} category=${failure.category} next=${new Date(nextAt).toISOString()}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    return true;
  }

  private formatUploadFailureLog(task: UploadTask | QualityUploadPhaseTask, failure: UploadFailureInfo) {
    const nextRetryAt = task.retryAt ? new Date(task.retryAt).toISOString() : "next-cycle";
    const evidence = [
      failure.remoteErrorCode ? `remoteCode=${failure.remoteErrorCode}` : "",
      failure.remoteWriteStatus ? `writeStatus=${failure.remoteWriteStatus}` : "",
      failure.remoteParentStatus ? `parent=${failure.remoteParentStatus}` : "",
      failure.responseSnippet ? `snippet=${failure.responseSnippet}` : "",
    ].filter(Boolean).join(" ");
    return `[Upload] status=${failure.status || "unknown"} category=${failure.category} retryable=${failure.retryable} attempt=${task.retries}/${task.maxRetries} next=${nextRetryAt} remote=<redacted>${evidence ? ` ${evidence}` : ""}: ${failure.summary}`;
  }

  private clearUploadProbeTimer() {
    if (this.uploadProbeTimer) {
      clearTimeout(this.uploadProbeTimer);
      this.uploadProbeTimer = null;
    }
  }

  private scheduleUploadProbe() {
    this.clearUploadProbeTimer();
    const retryAt = this.uploadCircuit.getRetryAt();
    if (!retryAt) return;
    this.uploadProbeTimer = setTimeout(() => {
      this.uploadProbeTimer = null;
      this.dispatchPersistentJobs();
      this.uploadQueue.poke();
    }, Math.max(0, retryAt - Date.now()));
    this.uploadProbeTimer.unref?.();
  }

  private downloadTaskIdentity(task: DownloadTask | QualityUpgradeDownloadTask) {
    const cookie = task instanceof QualityUpgradeDownloadTask ? task.control.cookie : task.cookie;
    return {
      bvid: task.bvid,
      userId: String(task.userId || ""),
      hasAppToken: Boolean(cookie?.accessToken),
    };
  }

  private persistDownloadApiHealth(value: ReturnType<DownloadApiHealth["open"]>) {
    if (value && typeof (this.stateManager as any).setDownloadApiCooldown === "function") {
      this.stateManager.setDownloadApiCooldown(value);
    } else if (!value && typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
  }

  private handleDownloadApiFailure(task: DownloadTask | QualityUpgradeDownloadTask, error: any) {
    const identity = this.downloadTaskIdentity(task);
    let persisted = null;
    if (error?.biliRiskControl && error?.apiMode === "web") {
      persisted = this.downloadApiHealth.open(identity);
    } else if (task.apiProbe || (task instanceof QualityUpgradeDownloadTask && task.control.apiProbe)) {
      persisted = this.downloadApiHealth.probeFailed(identity, error?.message || "风控探测失败", Boolean(error?.permanent));
    } else {
      return undefined;
    }
    this.persistDownloadApiHealth(persisted);
    const retryAt = this.downloadApiHealth.getRetryAt();
    this.downloadQueue.poke();
    return retryAt;
  }

  private handleDownloadApiReady(task: DownloadTask | QualityUpgradeTask, _mode: BBDownApiMode) {
    const identity = {
      bvid: task.bvid,
      userId: String(task.userId || task.target?.userId || ""),
    };
    if (!this.downloadApiHealth.ready(identity)) return;
    if (typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
      this.stateManager.clearDownloadApiCooldown();
    }
    this.dispatchPersistentJobs();
    this.downloadQueue.poke();
  }

  private markDownloadTaskStarted() {
    this.nextDownloadStartAt = Date.now() + computeDownloadStartDelayMs();
  }

  private scheduleDownloadStartPoke() {
    if (this.downloadStartTimer) return;
    const delayMs = Math.max(0, this.nextDownloadStartAt - Date.now());
    this.downloadStartTimer = setTimeout(() => {
      this.downloadStartTimer = null;
      this.downloadQueue.poke();
    }, delayMs);
    this.downloadStartTimer.unref?.();
  }

  private recoveryUploadKey(item: RecoveryUploadItem) {
    const retrySuffix = item.encodingRetry
      ? `:encoding-retry:${item.encodingRetry.parentJobId}:g${item.encodingRetry.generation}`
      : "";
    return `${item.userId || "video"}:${item.mediaId || 0}:${item.bvid}:${item.remotePath}:${item.historySnapshotAt || "main"}${retrySuffix}`;
  }

  private historySnapshotSegment(value: string) {
    return String(value || new Date().toISOString()).replace(/[-:.]/g, "").replace(/Z$/, "Z");
  }

  private captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    if (!userId || !Number.isInteger(mediaId)) return undefined;
    const relation = this.stateManager.getRelationStatus(userId, Number(mediaId), bvid);
    if (!relation?.remoteFiles?.length || !relation.verifiedAt) return undefined;
    return {
      remotePath: relation.remotePath || path.posix.dirname(relation.remoteFiles[0].path),
      files: relation.remoteFiles.map((file) => ({
        ...file,
        qualityProfile: file.qualityProfile ? { ...file.qualityProfile } : undefined,
        mediaMetadata: file.mediaMetadata ? { ...file.mediaMetadata } : undefined,
        filenameMetadata: file.filenameMetadata ? { ...file.filenameMetadata } : undefined,
      })),
      status: relation.backupStatus === "partial_verified" ? "partial_verified" as const : "verified" as const,
      uploadedAt: relation.uploadedAt,
      verifiedAt: relation.verifiedAt,
    } satisfies ExistingArchiveProof;
  }

  private isPlainObsoleteArchiveRecovery(job: any) {
    const payload = job?.payload as any;
    if (job?.kind !== "upload" || !["pending", "retry_wait", "manual_wait", "failed"].includes(String(job?.status || ""))) return false;
    if (payload?.resumeOnly !== true || payload?.allowReupload === true || payload?.sessionId || payload?.encodingRetry || payload?.historyOnly) return false;
    if (payload?.conflictCandidate || payload?.conflictCandidateOnly === true || payload?.legacyConflictSideEffectsStarted === true) return false;
    if (Array.isArray(payload?.conflictArchiveVerifiedPaths) && payload.conflictArchiveVerifiedPaths.length > 0) return false;
    const files = Array.isArray(payload?.files)
      ? payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/").trim()).filter(Boolean)
      : [];
    return files.length > 0 && new Set(files).size === files.length;
  }

  private async confirmVerifiedArchiveProofForRecovery(job: any, proof: ExistingArchiveProof) {
    if (!this.isVerifiedArchiveProofForRecovery(job, proof)) return "mismatch" as const;
    for (const file of proof.files) {
      try {
        const result = await this.remoteFileInspector(this.configStore.get(), String(file.path), Number(file.size));
        if (result.status !== "verified") return result.status;
      } catch {
        return "unknown" as const;
      }
    }
    return "verified" as const;
  }

  private async reconcileObsoleteVerifiedArchiveRecoveries(
    limit = 1000,
    scope?: { bvid?: string; userId?: string; mediaId?: number },
    concurrency = 2,
  ) {
    let removed = 0;
    const jobs = this.jobStore.listObsoleteArchiveRecoveryCandidates(limit, scope);
    let nextIndex = 0;
    const worker = async () => {
      while (this.acceptingJobs) {
        const job = jobs[nextIndex++];
        if (!job) return;
        if (this.recoveryJobLocks.has(job.id) || !this.isPlainObsoleteArchiveRecovery(job)) continue;
        this.recoveryJobLocks.add(job.id);
        try {
          const bvid = String(job.bvid || job.payload?.bvid || "");
          if (!bvid || !job.userId || !Number.isInteger(job.mediaId)) continue;
          // A recoverable transfer session is authoritative. Do not remove the
          // legacy job while the session projection may still recreate work.
          if (this.transferSessions.findForTarget(job.userId, job.mediaId, bvid)) continue;
          const proof = this.captureExistingArchiveProof(job.userId, job.mediaId, bvid);
          if (!proof || await this.confirmVerifiedArchiveProofForRecovery(job, proof) !== "verified") continue;
          if (!this.stateManager.restoreExistingArchiveProof(bvid, job.userId, job.mediaId, proof)) continue;
          if (!this.jobStore.removeObsoleteArchiveRecoveryCandidate(job.id)) continue;
          removed += 1;
          await this.maybeCleanupVerifiedLocalDir(bvid, String((job.payload as any)?.localDir || ""));
        } finally {
          this.recoveryJobLocks.delete(job.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Math.floor(concurrency) || 1, jobs.length || 1)) }, worker));
    if (removed > 0) {
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "system",
        level: "info",
        summary: `已自动收敛 ${removed} 个过期上传恢复任务，保留已验证归档`,
        raw: `[Recovery] obsolete verified archive recoveries removed=${removed}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    return removed;
  }

  private legacyConflictSideEffectsStarted(item: RecoveryUploadItem, relation: FavoriteRelation | null) {
    if ((item.conflictArchiveVerifiedPaths || []).length > 0) return true;
    if (!item.conflictArchiveSegment || !relation?.remoteConflictArchives?.length) return false;
    const segment = String(item.conflictArchiveSegment)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return relation.remoteConflictArchives.some((archive) => archive.archivePath.split("/").filter(Boolean).pop() === segment);
  }

  private buildUploadTask(item: RecoveryUploadItem) {
    const relationProof = item.userId && Number.isInteger(item.mediaId)
      ? this.stateManager.getRelationStatus(item.userId, Number(item.mediaId), item.bvid)
      : null;
    const conflictArchiveOldFiles = item.conflictArchiveOldFiles || relationProof?.remoteFiles;
    const existingArchiveProof = item.encodingRetry
      ? item.existingArchiveProof
      : (item.existingArchiveProof || this.captureExistingArchiveProof(item.userId, item.mediaId, item.bvid));
    const reuploadAuthorizedFiles = [...new Set((item.reuploadAuthorizedFiles
      || (item.allowReupload ? item.files || [] : []))
      .map((value) => String(value || "").replace(/\\/g, "/"))
      .filter(Boolean))];
    const uploadTask = new UploadTask(item.bvid, item.localDir, item.remotePath, this.configStore.get(), {
      cleanupLocal: false,
      files: item.files,
      filenameMetadataByPath: item.filenameMetadataByPath,
      partialBackup: item.partialBackup,
      historyOnly: item.historyOnly,
      historySnapshotAt: item.historySnapshotAt,
      uploadIntent: item.uploadIntent || (item.historyOnly ? "history_upload" : "normal_backup"),
      existingArchiveProof,
      legacyConflictSideEffectsStarted: Boolean(
        item.legacyConflictSideEffectsStarted
        || this.legacyConflictSideEffectsStarted(item, relationProof),
      ),
      conflictCandidateId: item.conflictCandidateId,
      conflictCandidateRemotePath: item.conflictCandidateRemotePath,
      conflictCandidateOnly: item.conflictCandidateOnly,
      conflictCandidateReasonCode: item.conflictCandidateReasonCode,
      conflictCandidateReasonSummary: item.conflictCandidateReasonSummary,
      transferSessionStore: this.transferSessions,
      sessionId: item.sessionId,
      sessionGeneration: item.sessionGeneration,
      sessionDedupeKey: item.sessionDedupeKey,
      conflictArchiveSegment: item.conflictArchiveSegment,
      conflictArchiveRoot: item.remotePath,
      conflictArchiveOldFiles,
      conflictArchiveVerifiedPaths: item.conflictArchiveVerifiedPaths,
      allowReupload: item.allowReupload,
      reuploadAuthorizedFiles,
      resumeOnly: Boolean(item.resumeOnly || item.allowReupload || reuploadAuthorizedFiles.length > 0),
      encodingRetry: item.encodingRetry,
      strictMediaTarget: parseStrictMediaTarget(item.strictMediaTarget),
    });
    uploadTask.consumeReuploadPermission = (relativePath) => {
      if (uploadTask.persistentJobId) {
        return this.jobStore.consumeUploadReuploadPermission(uploadTask.persistentJobId, this.leaseOwner, relativePath);
      }
      const normalized = String(relativePath || "").replace(/\\/g, "/");
      const index = uploadTask.reuploadAuthorizedFiles.indexOf(normalized);
      if (index < 0) return false;
      uploadTask.reuploadAuthorizedFiles.splice(index, 1);
      return true;
    };
    uploadTask.sharedDownloadDir = item.localDir;
    uploadTask.encodingRetry = item.encodingRetry;
    uploadTask.userId = item.userId;
    uploadTask.mediaId = item.mediaId;
    uploadTask.folderTitle = item.folderTitle;
    uploadTask.videoTitle = item.videoTitle || "";
    uploadTask.upperName = item.upperName || "";
    uploadTask.cover = item.cover || "";
    if (!item.historyOnly && item.userId && Number.isInteger(item.mediaId)) {
      uploadTask.onConflictArchiveTargetVerified = (file) => {
        if (!uploadTask.conflictArchiveVerifiedPaths?.includes(file.archivedPath)) {
          uploadTask.conflictArchiveVerifiedPaths = [...(uploadTask.conflictArchiveVerifiedPaths || []), file.archivedPath];
        }
        if (!uploadTask.persistentJobId) return;
        const current = this.jobStore.findById(uploadTask.persistentJobId);
        if (!current) return;
        this.jobStore.updatePayload(uploadTask.persistentJobId, {
          ...current.payload,
          conflictArchiveVerifiedPaths: uploadTask.conflictArchiveVerifiedPaths,
        });
      };
      uploadTask.onConflictArchived = (archive) => {
        this.stateManager.markRemoteConflictArchived(item.bvid, item.userId, item.mediaId, archive);
      };
    }
    if (!item.historyOnly) {
      uploadTask.onUploading = () => {
        this.stateManager.markUploading(item.bvid, item.userId, item.mediaId);
        if (!uploadTask.persistentJobId) return;
        const current = this.jobStore.findById(uploadTask.persistentJobId);
        if (!current) return;
        this.jobStore.updatePayload(uploadTask.persistentJobId, {
          ...current.payload,
          lifecycleState: "uploading",
          userDisposition: undefined,
        });
      };
    }
    uploadTask.onTransferSession = (task, sessionId, sessionGeneration) => {
      if (!task.persistentJobId) return;
      const live = this.jobStore.findById(task.persistentJobId);
      if (!live || live.leaseOwner !== this.leaseOwner || !["leased", "running"].includes(live.status)) {
        throw new Error("Upload task execution ownership changed before session binding");
      }
      const current = live.payload;
      if (!this.jobStore.updatePayload(task.persistentJobId, {
        ...current,
        sessionId,
        sessionGeneration,
        attemptKey: `${sessionId}:g${sessionGeneration}`,
        lifecycleState: current.conflictCandidateOnly ? "conflict_candidate" : "uploading",
      })) throw new Error("Upload task disappeared before session binding");
    };
    uploadTask.onConflictCandidateUploading = (task) => {
      this.restoreConflictCandidateExistingArchive(task);
      if (!task.persistentJobId) return;
      const current = this.jobStore.findById(task.persistentJobId);
      if (!current) return;
      this.jobStore.updatePayload(task.persistentJobId, {
        ...current.payload,
        lifecycleState: "conflict_candidate",
      });
    };
    return uploadTask;
  }

  private queueUploadWork(item: RecoveryUploadItem, dispatch = true) {
    const mediaId = Number(item.mediaId);
    if (item.userId && Number.isInteger(mediaId)
      && this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(item.userId, mediaId, item.bvid)) {
      return false;
    }
    const result = this.jobStore.enqueue(this.buildPersistentUploadJob(item));
    if (dispatch) this.dispatchPersistentJobs();
    return result.id;
  }

  private manualRecoveryJobs() {
    return this.jobStore.listManualRecovery(["upload", "history_upload"], 1_000);
  }

  private manualDownloadRecoveryJobs() {
    return this.jobStore.listManualRecovery(["download"], 1_000);
  }

  private legacyDownloadFailureIssueKey(userId: string, mediaId: number, bvid: string) {
    return `${userId}:${mediaId}:${bvid}`;
  }

  private eligibleLegacyDownloadFailures(limit = 1_000) {
    const jobsByBvid = new Set(
      this.jobStore.list(["download"], 100_000)
        .filter((job) => !(job.payload as any)?.legacyFailureKey)
        .map((job) => String(job.bvid || ""))
        .filter(Boolean),
    );
    const legacyClassificationBvids = new Set(
      this.jobStore.list(["access_probe"], 10_000)
        .filter((job) => (job.payload as any)?.purpose === "legacy_failure_classification")
        .map((job) => String(job.bvid || ""))
        .filter(Boolean),
    );
    const seen = new Set<string>();
    const eligible: Array<{
      record: any;
      relation: any;
      bvid: string;
      issueKey: string;
      category: DownloadRecoveryCategory;
      kind: Extract<RecoveryIssueKind, "download_retry_exhausted" | "download_account_required" | "download_tool_failure">;
      alternateAccounts: Array<{ value: string; label: string }>;
    }> = [];
    for (const record of this.stateManager.getDatabase().listPermanentFailureRecoveryRelations(limit)) {
      const relation = record.relation;
      const bvid = String(relation.bvid || record.failure.bvid || "");
      if (!bvid || jobsByBvid.has(bvid) || legacyClassificationBvids.has(bvid)) continue;
      if (seen.has(this.legacyDownloadFailureIssueKey(relation.userId, relation.mediaId, bvid))) continue;
      if (!relation.activeInFavorite || relation.accountDetachedAt) continue;
      if (relation.favoriteUnavailable && !relation.selfVisible) continue;
      if (["uploaded", "verified", "partial_verified", "uploading", "downloaded", "queued", "downloading"].includes(String(relation.backupStatus || ""))) continue;
      if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, bvid)) continue;
      const resolved = this.resolveRelation(relation);
      if (!resolved) continue;

      const failure = classifyDownloadRecoveryFailure({ message: record.failure.reason || "" });
      if (record.failure.userDisposition === "abandoned") continue;
      if (failure.category === "source_unavailable") continue;
      const category: DownloadRecoveryCategory = failure.category;
      const alternateAccounts = this.userStore.list()
        .filter((user) => user.id !== relation.userId && this.isUserSyncEligible(user))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id))
        .map((user) => ({ value: user.id, label: `${user.name}（UID ${user.uid}）` }));
      const issueKey = this.legacyDownloadFailureIssueKey(relation.userId, relation.mediaId, bvid);
      seen.add(issueKey);
      eligible.push({
        record,
        relation,
        bvid,
        issueKey,
        category,
        kind: failure.kind || "download_retry_exhausted",
        alternateAccounts,
      });
    }
    return eligible;
  }

  private reconcileLegacyDownloadRecoveryJobs() {
    const eligible = this.eligibleLegacyDownloadFailures();
    const eligibleByKey = new Map(eligible.map((item) => [item.issueKey, item]));
    let changed = 0;
    for (const job of this.jobStore.listLegacyDownloadRecovery()) {
      const key = String((job.payload as any)?.legacyFailureKey || "");
      if (key && !eligibleByKey.has(key) && (job.payload as any)?.userDisposition !== "abandoned") {
        if (this.jobStore.complete(job.id)) changed += 1;
      }
    }
    for (const item of eligible) {
      const existing = this.jobStore.findLegacyDownloadRecovery(item.issueKey);
      const record = item.record;
      const payload = {
        legacyFailureKey: item.issueKey,
        legacyFailureAt: record.failure.failedAt,
        primaryUserId: item.relation.userId,
        primaryMediaId: item.relation.mediaId,
        downloadUserId: item.relation.userId,
        detachedTargets: [{
          userId: item.relation.userId,
          mediaId: item.relation.mediaId,
          folderTitle: item.relation.folderTitle,
          remotePath: item.relation.remotePath || "",
        }],
        downloadRecovery: {
          category: item.category,
          kind: item.kind,
          summary: `这是旧版下载失败记录，系统不会自动重复下载。${sanitizeUploadText(record.failure.reason || "可手动重新尝试一次。", 220)}`,
        },
      };
      if (existing) {
        if ((existing.payload as any)?.userDisposition !== "abandoned"
          && (existing.payload as any)?.legacyFailureAt !== record.failure.failedAt) {
          this.jobStore.updatePayload(existing.id, { ...existing.payload, ...payload, awaitingManualRecovery: true });
          changed += 1;
        }
        continue;
      }
      this.jobStore.enqueue({
        kind: "download",
        dedupeKey: `download-recovery:${item.issueKey}`,
        bvid: item.bvid,
        userId: item.relation.userId,
        mediaId: item.relation.mediaId,
        priority: 30,
        maxAttempts: this.configStore.get().maxRetries + 1,
        initialStatus: "manual_wait",
        payload: {
          bvid: item.bvid,
          ...payload,
          awaitingManualRecovery: true,
          manualRecoveryReason: record.failure.reason || "旧版下载失败记录待处理",
        },
      });
      changed += 1;
    }
    return changed;
  }

  private recoveryAssessment(payload: any): RecoveryAssessment | null {
    const value = payload?.recoveryAssessment;
    if (!value || typeof value !== "object") return null;
    const checkedAt = Number(value.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0) return null;
    return {
      kind: String(value.kind || "manual_review") as RecoveryAssessment["kind"],
      checkedAt,
      nextCheckAt: Number.isFinite(Number(value.nextCheckAt)) ? Number(value.nextCheckAt) : undefined,
      localStatus: String(value.localStatus || "unknown") as RecoveryAssessment["localStatus"],
      remoteStatus: String(value.remoteStatus || "unknown") as RecoveryAssessment["remoteStatus"],
      fileName: value.fileName ? path.basename(String(value.fileName)) : undefined,
      expectedSize: Number.isFinite(Number(value.expectedSize)) ? Number(value.expectedSize) : undefined,
      observedSize: Number.isFinite(Number(value.observedSize)) ? Number(value.observedSize) : undefined,
      writeStatus: Number.isInteger(Number(value.writeStatus)) && Number(value.writeStatus) >= 100 && Number(value.writeStatus) <= 599
        ? Number(value.writeStatus)
        : undefined,
      remoteErrorCode: typeof value.remoteErrorCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{1,80}$/.test(value.remoteErrorCode)
        ? value.remoteErrorCode
        : undefined,
      responseHeaders: value.responseHeaders && typeof value.responseHeaders === "object"
        ? Object.fromEntries(Object.entries(value.responseHeaders).filter(([key, item]) =>
          ["allow", "retry-after", "content-type", "content-length", "dav", "x-openlist-error-code", "x-alist-error-code", "x-error-code"].includes(key)
          && typeof item === "string",
        ).map(([key, item]) => [key, sanitizeUploadText(item, 180)]))
        : undefined,
      responseSnippet: typeof value.responseSnippet === "string"
        ? sanitizeUploadText(value.responseSnippet, 240)
        : undefined,
      writeEvidence: ["target_missing_parent_visible", "repeated_missing_parent_visible"].includes(String(value.writeEvidence || ""))
        ? String(value.writeEvidence) as RecoveryAssessment["writeEvidence"]
        : undefined,
      uploadAttempts: Number.isFinite(Number(value.uploadAttempts)) && Number(value.uploadAttempts) >= 0
        ? Number(value.uploadAttempts)
        : undefined,
      firstObservedAt: Number.isFinite(Number(value.firstObservedAt)) && Number(value.firstObservedAt) > 0
        ? Number(value.firstObservedAt)
        : undefined,
      lastObservedAt: Number.isFinite(Number(value.lastObservedAt)) && Number(value.lastObservedAt) > 0
        ? Number(value.lastObservedAt)
        : undefined,
      consecutiveObservations: Number.isFinite(Number(value.consecutiveObservations)) && Number(value.consecutiveObservations) > 0
        ? Math.floor(Number(value.consecutiveObservations))
        : undefined,
      candidateSafe: value.candidateSafe === true,
      candidateEligible: typeof value.candidateEligible === "boolean" ? value.candidateEligible : undefined,
      failureCategory: ["transient", "permission", "unsupported", "not_found", "conflict", "unknown"].includes(String(value.failureCategory || ""))
        ? String(value.failureCategory) as RemoteFailureCategory
        : undefined,
      operation: ["inspect", "put"].includes(String(value.operation || ""))
        ? String(value.operation) as RecoveryAssessment["operation"]
        : undefined,
      summary: sanitizeUploadText(value.summary || "等待人工检查", 300),
    };
  }

  private inspectLocalArchiveDirectory(localDirValue: string) {
    const localDir = String(localDirValue || "");
    if (!localDir) return { status: "missing" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
    try {
      const rootStat = fs.lstatSync(localDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { status: "changed" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
      }
    } catch {
      return { status: "missing" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
    }
    const manifest = readDownloadSession(localDir);
    const files = manifest?.outputs || [];
    if (!manifest || manifest.bvid.length === 0 || files.length === 0) {
      return { status: "unknown" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: files.length };
    }
    const root = path.resolve(localDir);
    let retainedBytes = 0;
    let expectedBytes = 0;
    let verifiedFiles = 0;
    let missingFiles = 0;
    for (const file of files) {
      const expectedSize = Number(file.size);
      if (!Number.isFinite(expectedSize) || expectedSize < 0) {
        return { status: "changed" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
      }
      expectedBytes += expectedSize;
      const target = path.resolve(root, file.relativePath);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        return { status: "changed" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
      }
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedSize) {
          return { status: "changed" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
        }
        retainedBytes += stat.size;
        verifiedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          missingFiles += 1;
          continue;
        }
        return { status: "unknown" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
      }
    }
    if (verifiedFiles === files.length) return { status: "available" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
    if (missingFiles === files.length) return { status: "missing" as const, retainedBytes: 0, expectedBytes, verifiedFiles: 0, totalFiles: files.length };
    return { status: "unknown" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
  }
  private inspectRecoveryLocalFiles(job: any) {
    const payload = job.payload as any;
    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    if (payload.sessionId && !session) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    if (session) {
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration) {
        return { status: "changed" as const, session, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
      }
      const files = this.transferSessions.listFiles(session.id, expectedGeneration);
      if (files.length === 0) return { status: "missing" as const, session, files };
      const localRoot = path.resolve(session.localDir);
      for (const file of files) {
        const localFile = path.resolve(session.localDir, file.relativePath);
        if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
          return { status: "changed" as const, session, files };
        }
        try {
          const stat = fs.statSync(localFile);
          if (!stat.isFile() || stat.size !== file.expectedSize) {
            return { status: "changed" as const, session, files };
          }
        } catch {
          return { status: "missing" as const, session, files };
        }
      }
      return { status: "available" as const, session, files };
    }

    const localDir = String(payload.localDir || "");
    const requestedFiles = Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : [];
    if (requestedFiles.length === 0) {
      const local = this.inspectLocalArchiveDirectory(localDir);
      return { ...local, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    if (!localDir || !fs.existsSync(localDir)) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    for (const relativePath of requestedFiles) {
      const localRoot = path.resolve(localDir);
      const localFile = path.resolve(localDir, relativePath);
      if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
        return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
      }
      try {
        const stat = fs.statSync(localFile);
        if (!stat.isFile() || stat.size <= 0) {
          return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
        }
      } catch {
        return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
      }
    }
    return { status: "available" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
  }

  private inspectConflictCandidateEligibility(job: any, assessment: RecoveryAssessment | null) {
    const payload = job?.payload as any;
    if (!job || !payload || job.kind !== "upload" || payload.historyOnly) {
      return { eligible: false, reason: "只有普通归档上传可以生成冲突候选", fileCount: 0, totalBytes: 0 };
    }
    const allowedKinds = new Set<RecoveryIssueKind>([
      "remote_size_conflict",
      "partial_remote_state",
      "unknown_same_size",
      "legacy_conflict_interrupted",
      "remote_visibility_stalled",
      "remote_unsupported",
      "remote_unknown",
      "manual_review",
    ]);
    if (!assessment || !allowedKinds.has(assessment.kind)) {
      return { eligible: false, reason: "当前远端状态不适合生成候选", fileCount: 0, totalBytes: 0 };
    }
    if (["remote_visibility_stalled", "remote_unsupported", "remote_unknown", "manual_review"].includes(assessment.kind)
      && assessment.candidateSafe !== true) {
      return { eligible: false, reason: "尚未确认候选父目录可见，不能安全写入", fileCount: 0, totalBytes: 0 };
    }
    const localDir = String(payload.localDir || "");
    const requestedFiles: string[] = Array.isArray(payload.files)
      ? [...new Set<string>(payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/")).filter(Boolean))]
      : [];
    if (!localDir || requestedFiles.length === 0) {
      return { eligible: false, reason: "本地文件组清单不完整", fileCount: 0, totalBytes: 0 };
    }
    const localRoot = path.resolve(localDir);
    let totalBytes = 0;
    for (const relativePath of requestedFiles) {
      const localFile = path.resolve(localRoot, relativePath);
      if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) {
        return { eligible: false, reason: "本地文件路径超出任务目录", fileCount: 0, totalBytes: 0 };
      }
      try {
        const stat = fs.lstatSync(localFile);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
          return { eligible: false, reason: "本地文件组包含无效文件", fileCount: 0, totalBytes: 0 };
        }
        totalBytes += stat.size;
      } catch {
        return { eligible: false, reason: "本地文件组已有文件缺失", fileCount: 0, totalBytes: 0 };
      }
    }
    if (payload.sessionId) {
      const session = this.transferSessions.get(String(payload.sessionId));
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session?.generation;
      if (!session || session.generation !== expectedGeneration) {
        return { eligible: false, reason: "上传Session已经变化", fileCount: 0, totalBytes: 0 };
      }
      const sessionFiles = this.transferSessions.listFiles(session.id, session.generation);
      const requestedSet = new Set(requestedFiles);
      if (sessionFiles.length !== requestedSet.size
        || sessionFiles.some((file) => !requestedSet.has(file.relativePath.replace(/\\/g, "/")))) {
        return { eligible: false, reason: "本地文件组与上传Session不一致", fileCount: 0, totalBytes: 0 };
      }
      for (const file of sessionFiles) {
        try {
          if (fs.lstatSync(path.resolve(localRoot, file.relativePath)).size !== file.expectedSize) {
            return { eligible: false, reason: "本地文件大小与上传Session不一致", fileCount: 0, totalBytes: 0 };
          }
        } catch {
          return { eligible: false, reason: "上传Session文件已不可用", fileCount: 0, totalBytes: 0 };
        }
      }
    }
    return { eligible: true, reason: "本地完整文件组可写入隔离候选", fileCount: requestedFiles.length, totalBytes };
  }

  private updateRecoveryAssessment(jobId: string, assessment: RecoveryAssessment) {
    const current = this.jobStore.findById(jobId);
    if (!current || !(current.payload as any)?.awaitingManualRecovery) return false;
    const persistedAssessment: RecoveryAssessment = {
      ...assessment,
      candidateEligible: this.inspectConflictCandidateEligibility(current, assessment).eligible,
    };
    const previous = this.recoveryAssessment(current.payload);
    if (previous && JSON.stringify(previous) === JSON.stringify(persistedAssessment)) return true;
    return this.jobStore.updatePayload(jobId, {
      ...current.payload,
      recoveryAssessment: persistedAssessment,
    });
  }

  private verifiedFilesFromRecovery(job: any, files: ReturnType<TransferSessionStore["listFiles"]>): RemoteFileRecord[] {
    const payload = job.payload as any;
    const metadataByPath = payload.filenameMetadataByPath || {};
    return files.map((file) => {
      const metadata = metadataByPath[file.relativePath.replace(/\\/g, "/")];
      const { mediaMetadata, ...filenameMetadata } = metadata || {};
      return {
        name: file.name,
        path: file.finalPath,
        size: file.expectedSize,
        mediaMetadata,
        localRelativePath: file.relativePath,
        filenameMetadata: metadata ? filenameMetadata : undefined,
        verificationStatus: "verified" as const,
        putCompletedAt: file.putAcceptedAt ? new Date(file.putAcceptedAt).toISOString() : undefined,
        verifyAttempts: Math.max(1, file.attempts),
      };
    });
  }

  private persistedExistingArchiveProof(payload: any): ExistingArchiveProof | null {
    const proof = payload?.existingArchiveProof;
    if (!proof || typeof proof !== "object" || !Array.isArray(proof.files) || proof.files.length === 0) return null;
    if (!["verified", "partial_verified"].includes(String(proof.status))) return null;
    return {
      remotePath: String(proof.remotePath || ""),
      files: proof.files.map((file: any) => ({ ...file })),
      status: String(proof.status) as ExistingArchiveProof["status"],
      uploadedAt: proof.uploadedAt ? String(proof.uploadedAt) : undefined,
      verifiedAt: proof.verifiedAt ? String(proof.verifiedAt) : undefined,
    };
  }

  private observedSameSizeProof(job: any, assessment: RecoveryAssessment | null): ExistingArchiveProof | undefined {
    if (assessment?.kind !== "unknown_same_size" || assessment.remoteStatus !== "verified") return undefined;
    const payload = job.payload as any;
    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    if (!session) return undefined;
    const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
    if (session.generation !== generation) return undefined;
    const files = this.transferSessions.listFiles(session.id, generation);
    if (files.length === 0 || files.some((file) => !file.finalPath || !Number.isFinite(file.expectedSize) || file.expectedSize <= 0)) {
      return undefined;
    }
    return {
      remotePath: String(payload.remotePath || session.remotePath || ""),
      status: "verified",
      verifiedAt: new Date(this.now()).toISOString(),
      files: files.map((file) => ({
        name: file.name,
        path: file.finalPath,
        size: file.expectedSize,
        localRelativePath: file.relativePath,
        verificationStatus: "verified" as const,
        verifyAttempts: Math.max(1, file.attempts),
      })),
    };
  }

  private isVerifiedArchiveProofForRecovery(job: any, proof: ExistingArchiveProof) {
    const payload = job?.payload as any;
    if (proof.status !== "verified" || !proof.verifiedAt || proof.files.length === 0) return false;
    const requestedRemotePath = String(payload?.remotePath || "").trim();
    if (!requestedRemotePath) return false;
    try {
      const expectedDirectory = normalizeRemotePath(requestedRemotePath, { allowTrailingSlash: true });
      const proofDirectory = normalizeRemotePath(
        String(proof.remotePath || remoteDirname(String(proof.files[0]?.path || ""))),
        { allowTrailingSlash: true },
      );
      if (expectedDirectory !== proofDirectory) return false;

      const proofNames = proof.files.map((file) => String(
        file.localRelativePath || path.posix.basename(String(file.path || "")),
      ).replace(/\\/g, "/"));
      if (proofNames.some((name) => !name) || new Set(proofNames).size !== proofNames.length) return false;
      const requestedFiles: string[] = Array.isArray(payload?.files)
        ? Array.from(new Set<string>(payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/")).filter((value: string) => Boolean(value))))
        : [];
      if (requestedFiles.length === 0
        || requestedFiles.length !== proofNames.length
        || requestedFiles.some((name) => !proofNames.includes(name))) {
        return false;
      }

      return proof.files.every((file) => {
        if (file.verificationStatus !== "verified" || !Number.isFinite(Number(file.size)) || Number(file.size) <= 0) return false;
        try {
          return remoteDirname(normalizeRemotePath(String(file.path || ""), { allowRoot: false })) === proofDirectory;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private finalizeRetainedArchiveRecovery(
    job: any,
    proof: ExistingArchiveProof,
    options: { allowResumeOnly?: boolean } = {},
  ) {
    const current = this.jobStore.findById(job.id);
    if (!current) return false;
    const payload = current.payload as any;
    const manualRecovery = payload?.awaitingManualRecovery === true;
    const staleResumeOnlyRecovery = options.allowResumeOnly === true
      && ["manual_wait", "retry_wait", "failed"].includes(String(current.status))
      && payload?.resumeOnly === true
      && payload?.allowReupload !== true
      && !payload?.sessionId
      && !payload?.encodingRetry
      && !payload?.historyOnly
      && !payload?.conflictCandidate
      && payload?.conflictCandidateOnly !== true
      && payload?.legacyConflictSideEffectsStarted !== true
      && (!Array.isArray(payload?.conflictArchiveVerifiedPaths) || payload.conflictArchiveVerifiedPaths.length === 0);
    if (!manualRecovery && !staleResumeOnlyRecovery) return false;
    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    if (session) {
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration || !this.transferSessions.supersede(session.id, expectedGeneration)) return false;
    }
    const restored = this.stateManager.restoreExistingArchiveProof(
      String(current.bvid || ""),
      current.userId,
      current.mediaId,
      proof,
    );
    if (!restored) return false;
    this.jobStore.complete(current.id);
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "upload",
      level: "info",
      summary: `已确认并保留旧归档 ${current.bvid || ""}`,
      raw: `[Recovery] retained existing archive proof; files=${proof.files.length}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    void this.maybeCleanupVerifiedLocalDir(String(current.bvid || ""), String(payload.localDir || session?.localDir || ""));
    this.dispatchPersistentJobs();
    return true;
  }

  private finalizeVerifiedRecovery(job: any, session: NonNullable<ReturnType<TransferSessionStore["get"]>>, files: ReturnType<TransferSessionStore["listFiles"]>) {
    const current = this.jobStore.findById(job.id);
    if (!current || !(current.payload as any)?.awaitingManualRecovery) return false;
    const payload = current.payload as any;
    const expectedGeneration = Number.isInteger(payload.sessionGeneration)
      ? Number(payload.sessionGeneration)
      : session.generation;
    if (session.generation !== expectedGeneration) return false;
    if (files.length === 0 || !files.every((file) => Boolean(file.putAcceptedAt))) return false;
    const now = this.now();
    const verifiedFiles = this.verifiedFilesFromRecovery(current, files);
    const cleanupPlan = payload.historyOnly
      ? this.buildLocalCleanupPlan(
          String(current.bvid || session.bvid || ""),
          String(payload.localDir || session.localDir || ""),
          verifiedFiles,
          "upload_verified",
          { id: `upload:${session.id}:${expectedGeneration}:${session.remotePath}`, transferSessionId: session.id, transferGeneration: expectedGeneration },
        )
      : this.buildLocalCleanupPlan(
          String(current.bvid || session.bvid || ""),
          String(payload.localDir || session.localDir || ""),
          verifiedFiles,
          "upload_verified",
          { id: `upload:${session.id}:${expectedGeneration}:${session.remotePath}`, transferSessionId: session.id, transferGeneration: expectedGeneration },
        );
    this.stateManager.runAtomic(() => {
    const active = this.transferSessions.get(session.id);
    if (!active || active.generation !== expectedGeneration) throw new Error("Recovery attempt changed before commit");
    for (const file of files) {
      this.transferSessions.updateFile(session.id, file.relativePath, {
        status: "verified",
        verifiedAt: now,
        nextCheckAt: null,
        lastError: null,
      }, expectedGeneration);
    }
      this.transferSessions.updateSession(session.id, {
      phase: "completed",
      completedAt: now,
      lastError: null,
      allowReupload: false,
      }, expectedGeneration);
      if (!payload.historyOnly) {
        this.stateManager.markVerifiedUpload(
          String(current.bvid || session.bvid || ""),
          String(payload.remotePath || session.remotePath || ""),
          verifiedFiles,
          current.userId,
          current.mediaId,
          Boolean(payload.partialBackup),
        );
      }
      if (cleanupPlan) this.stateManager.recordLocalCleanupPlan(String(current.bvid || session.bvid || ""), cleanupPlan, current.id);
      this.jobStore.complete(current.id);
    });
    if (payload.historyOnly && payload.historySnapshotAt) {
      markHistoryGroupUploaded(String(payload.localDir || session.localDir || ""), payload.historySnapshotAt, `${current.userId || "video"}:${current.mediaId || 0}`);
    }
    logManager.push({
      timestamp: new Date(now).toISOString(),
      type: "upload",
      level: "info",
      summary: `自动确认远端文件已就绪 ${current.bvid || ""}`,
      raw: `[Recovery] remote files verified without another PUT; files=${files.length}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return true;
  }

  private queueFreshDownloadForRecovery(job: any, localStatus: RecoveryAssessment["localStatus"], userInitiated = false) {
    const current = this.jobStore.findById(job.id);
    if (!current || !(current.payload as any)?.awaitingManualRecovery || (current.payload as any)?.historyOnly) return false;
    const userId = String(current.userId || "");
    const mediaId = Number(current.mediaId);
    const bvid = String(current.bvid || "");
    const relation = userId && Number.isInteger(mediaId)
      ? this.stateManager.getRelationStatus(userId, mediaId, bvid)
      : null;
    const resolved = relation ? this.resolveRelation(relation) : null;
    if (!relation?.activeInFavorite || relation.favoriteUnavailable || !resolved) return false;
    const payload = current.payload as any;
    const previousAttempts = Math.max(0, Number(payload.automaticRecoveryAttempts || 0));
    if (!userInitiated && previousAttempts >= AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT) return false;
    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    if (session) {
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration || !this.transferSessions.supersede(session.id, expectedGeneration)) return false;
    }
    this.stateManager.resetRelationForRetry(bvid, userId, mediaId, `Local upload files were ${localStatus}; queued a fresh download.`);
    const queued = this.enqueueIfNeeded(resolved.user, mediaId, resolved.folderTitle, bvid, {
      persisted: true,
      downloadUserId: resolved.user.id,
      recoveryAttempt: previousAttempts + 1,
    });
    if (!queued) return false;
    this.jobStore.complete(current.id);
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "download",
      level: "warn",
      summary: `本地补传文件失效，已自动重新下载 ${bvid}`,
      raw: `[Recovery] stale upload replaced with fresh download; local=${localStatus}; attempt=${previousAttempts + 1}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return true;
  }

  private assessManualRecoveryJob(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    const existing = this.recoveryJobPromises.get(jobId);
    if (existing) return existing;
    const promise = this.assessManualRecoveryJobOnce(jobId, options).finally(() => {
      if (this.recoveryJobPromises.get(jobId) === promise) this.recoveryJobPromises.delete(jobId);
    });
    this.recoveryJobPromises.set(jobId, promise);
    return promise;
  }

  private buildRemoteRecoveryAssessment(
    localStatus: RecoveryAssessment["localStatus"],
    error: unknown,
    subject: string,
  ): RecoveryAssessment {
    const failure = classifyRemoteFailure(error);
    const kindByCategory: Record<RemoteFailureCategory, RecoveryAssessment["kind"]> = {
      transient: "remote_connection",
      permission: "remote_permission",
      unsupported: "remote_unsupported",
      not_found: "remote_unknown",
      conflict: "remote_unknown",
      unknown: "remote_unknown",
    };
    const statusByCategory: Record<RemoteFailureCategory, RecoveryAssessment["remoteStatus"]> = {
      transient: "transient",
      permission: "permission",
      unsupported: "unsupported",
      not_found: "unknown",
      conflict: "unknown",
      unknown: "unknown",
    };
    const detail = sanitizeUploadText((error as any)?.message || error, 180);
    const summary = failure.category === "transient"
      ? `暂时无法连接 AList / OpenList 复核${subject}；系统会在后台自动重试，不会重复上传或删除文件。${detail ? `（${detail}）` : ""}`
      : failure.category === "permission"
        ? `AList / OpenList 拒绝了${subject}的只读复核，请检查存储认证；系统不会继续上传或删除文件。${detail ? `（${detail}）` : ""}`
        : failure.category === "unsupported"
          ? `AList / OpenList 不支持当前${subject}复核方法，需要人工确认后再处理。${detail ? `（${detail}）` : ""}`
          : `AList / OpenList 返回了无法安全分类的${subject}错误，需要人工复核；系统不会猜测远端状态。${detail ? `（${detail}）` : ""}`;
    return {
      kind: kindByCategory[failure.category],
      checkedAt: this.now(),
      nextCheckAt: failure.category === "transient" ? this.now() + this.recoveryAutomationIntervalMs : undefined,
      localStatus,
      remoteStatus: statusByCategory[failure.category],
      failureCategory: failure.category,
      operation: "inspect",
      summary,
    };
  }

  private async assessManualRecoveryJobOnce(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    if (this.recoveryJobLocks.has(jobId)) return { changed: false, busy: true };
    this.recoveryJobLocks.add(jobId);
    try {
      const job = this.jobStore.findById(jobId);
      if (!job || !(job.payload as any)?.awaitingManualRecovery) return { changed: false, stale: true };
      const previous = this.recoveryAssessment(job.payload);
      const retryState = (job.payload as any)?.encodingRetry;
      if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))) {
        return { changed: false, busy: true };
      }
      if (!options.force && previous) {
        if (!previous.nextCheckAt || previous.nextCheckAt > this.now()) return { changed: false };
      }
      const payload = job.payload as any;
      if (payload.userDisposition === "abandoned" || payload.lifecycleState === "abandoned") return { changed: false, stale: true };
      if (payload.emptyAttempt) {
        const session = this.transferSessions.get(String(payload.sessionId || ""));
        if (!session || session.generation !== payload.sessionGeneration || this.transferSessions.listFiles(session.id, session.generation).length > 0) {
          return { changed: false, stale: true };
        }
        let proof: ExistingArchiveProof | undefined;
        try {
          if (session.userId && Number.isInteger(session.mediaId) && !session.historyOnly) {
            proof = this.captureExistingArchiveProof(session.userId, session.mediaId!, session.bvid);
          }
          const priorFiles = session.generation > 1 ? this.transferSessions.listFiles(session.id, session.generation - 1) : [];
          const matching = proof && priorFiles.length > 0 && priorFiles.every((file) => file.status === "verified" && file.putAcceptedAt)
            && priorFiles.length === proof.files.length
            && priorFiles.every((file) => proof!.files.some((item) => item.path === file.finalPath && Number(item.size) === file.expectedSize))
            && this.isVerifiedArchiveProofForRecovery({ payload: { ...payload, files: priorFiles.map((file) => file.relativePath) } }, proof);
          if (matching && proof) {
            const observations = [];
            for (const file of proof.files) observations.push(await this.remoteFileInspector(this.configStore.get(), file.path, Number(file.size)));
            if (observations.every((result) => result.status === "verified")) {
              const changed = this.stateManager.getDatabase().db.transaction(() => {
                const latest = this.jobStore.findById(job.id);
                if (!latest || (latest.payload as any).userDisposition === "abandoned") return false;
                const active = this.transferSessions.get(session.id);
                if (!active || active.generation !== session.generation || this.transferSessions.listFiles(active.id, active.generation).length > 0) return false;
                if (!this.transferSessions.supersede(active.id, active.generation)) return false;
                this.jobStore.complete(job.id);
                return true;
              })();
              return { changed, resolved: changed };
            }
          }
        } catch {
          // Incomplete historical evidence must never become a successful new attempt.
        }
        const assessment: RecoveryAssessment = {
          kind: "manual_review", checkedAt: this.now(), localStatus: "unknown", remoteStatus: "unknown",
          summary: "当前传输代次缺少分P清单，已有归档证据尚不能确认；文件不会被上传或清理。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }
      if (payload.legacyConflictSideEffectsStarted || (Array.isArray(payload.conflictArchiveVerifiedPaths) && payload.conflictArchiveVerifiedPaths.length > 0)) {
        const assessment: RecoveryAssessment = {
          kind: "legacy_conflict_interrupted",
          checkedAt: this.now(),
          localStatus: "unknown",
          remoteStatus: "unknown",
          summary: "旧式冲突归档已经移动或复制过远端文件，需要人工核对；系统不会继续覆盖、回移或删除。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }
      if (payload.conflictCandidate && Array.isArray(payload.conflictCandidate.files)) {
        try {
          const candidateResults = [];
          for (const file of payload.conflictCandidate.files) {
            if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0 || !file.path) break;
            candidateResults.push(await this.remoteFileInspector(this.configStore.get(), String(file.path), Number(file.size)));
          }
          const ready = candidateResults.length === payload.conflictCandidate.files.length
            && candidateResults.every((result) => result.status === "verified");
          const candidateHasUnknown = candidateResults.some((result) => result.status === "unknown");
          const assessment: RecoveryAssessment = ready
            ? {
              kind: "conflict_candidate_ready",
              checkedAt: this.now(),
              localStatus: this.inspectRecoveryLocalFiles(job).status,
              remoteStatus: "verified",
              summary: "正式旧路径保持不变，新文件候选已完整验证；请选择保留现有归档或采用候选。",
            }
            : {
              kind: "manual_review",
              checkedAt: this.now(),
              localStatus: this.inspectRecoveryLocalFiles(job).status,
              remoteStatus: candidateHasUnknown
                ? "unknown"
                : (candidateResults.some((result) => result.status === "mismatch") ? "mismatch" : "missing"),
              summary: candidateHasUnknown
                ? "暂时无法确认冲突候选的远端状态，系统没有切换当前归档；稍后会自动复核。"
                : "冲突候选的远端状态已经变化，系统没有切换当前归档，请重新检查存储后端。",
            };
          this.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        } catch (error) {
          const assessment = this.buildRemoteRecoveryAssessment("unknown", error, "冲突候选");
          this.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
      }
      const existingProof = this.persistedExistingArchiveProof(payload);
      if (existingProof?.status === "verified") {
        try {
          const oldResults = [];
          for (const file of existingProof.files) {
            if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0) break;
            oldResults.push(await this.remoteFileInspector(this.configStore.get(), file.path, Number(file.size)));
          }
          if (oldResults.length === existingProof.files.length && oldResults.every((result) => result.status === "verified")) {
            return { changed: this.finalizeRetainedArchiveRecovery(job, existingProof), resolved: true };
          }
          if (oldResults.some((result) => result.status === "unknown")) {
            const assessment: RecoveryAssessment = {
              kind: "manual_review",
              checkedAt: this.now(),
              localStatus: this.inspectRecoveryLocalFiles(job).status,
              remoteStatus: "unknown",
              summary: "暂时无法确认现有归档的远端状态，系统没有恢复证明或重新上传。",
            };
            this.updateRecoveryAssessment(job.id, assessment);
            return { changed: true, assessment };
          }
        } catch (error) {
          const assessment = this.buildRemoteRecoveryAssessment("unknown", error, "旧归档");
          this.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
      }
      const local = this.inspectRecoveryLocalFiles(job);
      if (!local.session || local.files.length === 0) {
        const kind = local.status === "missing" ? "local_file_missing" : (local.status === "changed" ? "local_file_changed" : "manual_review");
        const assessment: RecoveryAssessment = {
          kind,
          checkedAt: this.now(),
          localStatus: local.status,
          remoteStatus: "unknown",
          summary: local.status === "available"
            ? "旧任务缺少可安全复核的远端文件证明，需要人工确认。"
            : "本地补传文件已失效，且旧任务缺少可安全复核的远端文件证明。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      const results: Array<{
        file: typeof local.files[number];
        status: "verified" | "missing" | "mismatch" | "unknown";
        remoteSize?: number;
        parentStatus?: "visible" | "missing" | "unknown";
        failure?: RemoteFailureInfo;
      }> = [];
      try {
        for (const file of local.files) {
          const result = await this.remoteFileInspector(this.configStore.get(), file.finalPath, file.expectedSize);
          results.push({ file, ...result });
        }
      } catch (error) {
        const assessment = this.buildRemoteRecoveryAssessment(local.status, error, "远端文件");
        this.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      if (results.every((item) => item.status === "verified")) {
        if (local.files.every((file) => Boolean(file.putAcceptedAt))) {
          return { changed: this.finalizeVerifiedRecovery(job, local.session, local.files), resolved: true };
        }
        const assessment: RecoveryAssessment = {
          kind: "unknown_same_size",
          checkedAt: this.now(),
          localStatus: local.status,
          remoteStatus: "verified",
          summary: "远端文件与本地文件同大小，但缺少本次Session的PUT证明，系统没有把它标记为本次上传成功。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.candidateEligible !== false) {
          const candidate = this.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      const unknownCount = results.filter((item) => item.status === "unknown").length;
      if (unknownCount > 0) {
        const firstFailure = results.find((item) => item.status === "unknown" && item.failure)?.failure;
        const failureCategory = firstFailure?.category || "unknown";
        const kindByFailure: Partial<Record<RemoteFailureCategory, RecoveryAssessment["kind"]>> = {
          transient: "remote_connection",
          permission: "remote_permission",
          unsupported: "remote_unsupported",
          conflict: "remote_unknown",
          not_found: "remote_unknown",
          unknown: "remote_unknown",
        };
        const candidateSafe = local.status === "available"
          && results.every((item) => item.parentStatus === "visible")
          && !["transient", "permission"].includes(failureCategory);
        const assessment: RecoveryAssessment = {
          kind: kindByFailure[failureCategory] || "remote_unknown",
          checkedAt: this.now(),
          nextCheckAt: failureCategory === "transient" ? this.now() + this.recoveryAutomationIntervalMs : undefined,
          localStatus: local.status,
          remoteStatus: "unknown",
          fileName: path.basename(results.find((item) => item.status === "unknown")?.file.name || ""),
          candidateSafe,
          failureCategory,
          operation: "inspect",
          summary: "暂时无法确认部分远端文件状态，系统没有重复上传、覆盖或删除；恢复检查会稍后重试。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      const mismatch = results.find((item) => item.status === "mismatch");
      const verifiedCount = results.filter((item) => item.status === "verified").length;
      const missingCount = results.filter((item) => item.status === "missing").length;
      if (mismatch || (verifiedCount > 0 && missingCount > 0)) {
        const assessment: RecoveryAssessment = {
          kind: mismatch ? "remote_size_conflict" : "partial_remote_state",
          checkedAt: this.now(),
          localStatus: local.status,
          remoteStatus: mismatch ? "mismatch" : "mixed",
          fileName: path.basename(mismatch?.file.name || results.find((item) => item.status !== "verified")?.file.name || ""),
          expectedSize: mismatch?.file.expectedSize,
          observedSize: mismatch?.remoteSize,
          summary: mismatch
            ? "远端存在同名但大小不同的文件，系统没有覆盖或删除它。"
            : "多分P远端状态不一致，系统没有重复上传或删除任何文件。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.candidateEligible !== false) {
          const candidate = this.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      if (results.every((item) => item.status === "missing")) {
        if (["missing", "changed"].includes(local.status)) {
          if (options.allowAutomatic && this.queueFreshDownloadForRecovery(job, local.status, false)) {
            return { changed: true, resolved: true, redownloaded: true };
          }
          const assessment: RecoveryAssessment = {
            kind: local.status === "missing" ? "local_file_missing" : "local_file_changed",
            checkedAt: this.now(),
            localStatus: local.status,
            remoteStatus: "missing",
            summary: Number((job.payload as any)?.automaticRecoveryAttempts || 0) >= AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT
              ? `系统已自动重新下载 ${AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT} 次，但补传文件再次失效，需要确认后再重试。`
              : "远端文件不存在，本地补传文件也已失效；可重新下载，不会删除远端内容。",
          };
          this.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
        const parentVisible = results.length > 0
          && results.every((item) => item.status === "missing" && item.parentStatus === "visible");
        const uploadAttempts = Math.max(...local.files.map((file) => Number(file.attempts || 0)), 0);
        const priorWriteEvidence = previous?.kind === "remote_write_rejected"
          || (payload.remoteWriteEvidence === "target_missing_parent_visible");
        if (local.status === "available" && parentVisible && (priorWriteEvidence || uploadAttempts >= 2)) {
          const writeEvidence = priorWriteEvidence
            ? "target_missing_parent_visible" as const
            : "repeated_missing_parent_visible" as const;
          const assessment: RecoveryAssessment = {
            kind: "remote_write_rejected",
            checkedAt: this.now(),
            localStatus: local.status,
            remoteStatus: "missing",
            writeStatus: previous?.writeStatus || Number(payload.remoteWriteStatus) || (priorWriteEvidence ? 405 : undefined),
            writeEvidence,
            uploadAttempts,
            summary: priorWriteEvidence
              ? "远端拒绝了写入，但目标文件仍不可见、父目录可见；WebDAV没有返回足够信息确定具体原因。可以尝试一次换编码，不代表已确认是大小限制。"
              : "多次上传后远端目标仍不可见，但父目录可见；WebDAV返回的信息不足以确定是大小限制、驱动限制还是最终一致性问题。可以尝试一次换编码。",
          };
          this.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
        const observation = recordRemoteVisibilityObservation(previous, this.now());
        const assessment: RecoveryAssessment = {
          kind: observation.actionRequired ? "remote_visibility_stalled" : "remote_visibility_timeout",
          checkedAt: this.now(),
          nextCheckAt: observation.nextCheckAt,
          localStatus: local.status,
          remoteStatus: "missing",
          firstObservedAt: observation.firstObservedAt,
          lastObservedAt: observation.lastObservedAt,
          consecutiveObservations: observation.consecutiveObservations,
          candidateSafe: parentVisible,
          operation: "inspect",
          summary: observation.actionRequired
            ? `远端文件已连续 ${observation.consecutiveObservations} 次不可见；系统仍会低频只读复核，也可以把完整本地文件组生成隔离候选。`
            : "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
        };
        this.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.kind === "remote_visibility_stalled" && assessment.candidateEligible !== false) {
          const candidate = this.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      return { changed: false };
    } finally {
      this.recoveryJobLocks.delete(jobId);
    }
  }

  runRecoveryAutomationNow() {
    if (this.recoveryAutomationPromise) return this.recoveryAutomationPromise;
    this.recoveryAutomationPromise = (async () => {
      this.reconcileTransferSessionRecoveryJobs();
      const jobs = this.jobStore.listDueManualRecovery(["upload", "history_upload"], this.now(), 25);
      for (const job of jobs) {
        if (!this.acceptingJobs) break;
        await this.assessManualRecoveryJob(job.id, { allowAutomatic: true });
      }
    })().finally(() => {
      this.recoveryAutomationPromise = null;
    });
    return this.recoveryAutomationPromise;
  }

  private uploadRecoveryActions(assessment: RecoveryAssessment | null, job?: any, candidateEligible?: boolean): RecoveryIssueAction[] {
    const eligible = typeof candidateEligible === "boolean"
      ? candidateEligible
      : (job ? this.inspectConflictCandidateEligibility(job, assessment).eligible : false);
    const planned = planRecoveryActions({
      domain: "upload",
      kind: assessment?.kind || "manual_review",
      jobKind: job?.kind,
      historyOnly: Boolean((job?.payload as any)?.historyOnly),
      localStatus: assessment?.localStatus,
      remoteStatus: assessment?.remoteStatus,
      candidateEligible: eligible,
    });
    if (assessment?.kind !== "conflict_candidate_ready") return planned;
    const payload = job?.payload as any;
    const candidateRecord = payload?.conflictCandidate;
    const existingProof = this.persistedExistingArchiveProof(payload)
      || this.persistedExistingArchiveProof({ existingArchiveProof: candidateRecord?.existingArchiveProof });
    return existingProof ? planned : planned.filter((action) => action.id !== "keep_existing");
  }

  private uploadRecoverySummary(
    kind: string,
    assessment: RecoveryAssessment | null,
    retry: EncodingRetryContext | null,
    fallback: string,
  ) {
    if (kind !== "encoding_retry_failed") return fallback;
    if (assessment?.qualityMismatch) {
      return `请求 ${assessment.requestedQuality || retry?.quality || "指定画质"}，但实际文件未满足；错误候选没有上传或采用，未执行归档替换。`;
    }
    if (assessment?.encodingMismatch) {
      return `请求 ${assessment.requestedEncoding || retry?.priority?.[0] || "指定编码"}，但实际文件未满足；错误候选没有上传或采用，未执行归档替换。`;
    }
    if (assessment?.remoteStatus === "mismatch") {
      return "新候选上传后遇到远端同名大小冲突；系统未采用候选，也未执行归档替换。";
    }
    return "新候选未通过远端确认；系统已停止替换，未改变正式归档状态。";
  }

  private buildUploadRecoveryIssue(job: any): RecoveryIssue {
    const payload = job.payload as any;
    const storedMeta = (!payload.videoTitle || !payload.upperName) && job.bvid
      ? this.stateManager.getVideoMeta(String(job.bvid))
      : null;
    const assessment = this.recoveryAssessment(payload);
    const remoteErrorCode = assessment?.remoteErrorCode || payload.remoteErrorCode;
    const responseHeaders = assessment?.responseHeaders || payload.responseHeaders;
    const responseSnippet = assessment?.responseSnippet || payload.responseSnippet;
    const retry = parseEncodingRetryContext(payload.encodingRetry);
    const retryBusy = Boolean(payload.encodingRetry && ["running", "uploading", "verifying"].includes(String(payload.encodingRetry.state || "")));
    const kind = assessment?.kind || (payload.conflictRelativePath ? "remote_size_conflict" : "manual_review");
    const candidateEligible = typeof assessment?.candidateEligible === "boolean"
      ? assessment.candidateEligible
      : payload.recoveryProjection === true
        ? false
        : this.inspectConflictCandidateEligibility(job, assessment).eligible;
    const actions = retryBusy ? [] : this.uploadRecoveryActions(assessment, job, candidateEligible);
    const disposition = recoveryIssueDisposition(kind);
    const severity = recoveryIssueSeverity(kind);
    const titleByKind: Record<string, string> = {
      remote_visibility_timeout: "远端文件仍在等待可见",
      remote_visibility_stalled: "远端文件长时间不可见",
      remote_write_rejected: "远端写入结果未确认",
      remote_size_conflict: "远端存在同名冲突文件",
      remote_size_limit: "远端单文件超过存储限制",
      partial_remote_state: "多分P远端状态不一致",
      local_file_missing: "本地补传文件已丢失",
      local_file_changed: "本地补传文件已变化",
      remote_connection: "暂时无法连接存储后端",
      remote_permission: "存储后端拒绝了复核",
      remote_unsupported: "存储后端不支持复核方法",
      remote_unknown: "存储后端返回未知错误",
      unknown_same_size: "远端同大小文件缺少上传证明",
      legacy_conflict_interrupted: "旧式冲突归档需要人工复核",
      conflict_candidate_ready: "远端冲突候选等待选择",
      encoding_retry_failed: "编码替换未完成",
      manual_review: "上传任务需要复核",
    };
    const rawSummary = assessment?.summary || sanitizeUploadText(payload.manualRecoveryReason || job.lastError || "上传任务已安全暂停，等待复核。", 300);
    const retryFailureSummary = this.uploadRecoverySummary(kind, assessment, retry, rawSummary);
    const protectedFacts = [
      "没有自动覆盖或删除远端文件",
      "没有把未确认文件标记为归档成功",
      assessment?.localStatus === "available" ? "本地文件仍保留" : "其他已验证归档不受影响",
    ];
    const diagnostic = {
      issue: kind,
      task: job.kind,
      bvid: job.bvid || undefined,
      videoTitle: payload.videoTitle || storedMeta?.title || undefined,
      upperName: payload.upperName || storedMeta?.upperName || undefined,
      userId: job.userId || undefined,
      mediaId: job.mediaId ?? undefined,
      localStatus: assessment?.localStatus || "unknown",
      remoteStatus: assessment?.remoteStatus || "unknown",
      writeStatus: assessment?.writeStatus,
      remoteErrorCode,
      responseHeaders,
      responseSnippet,
      writeEvidence: assessment?.writeEvidence,
      uploadAttempts: assessment?.uploadAttempts,
      requestedEncoding: assessment?.requestedEncoding,
      actualEncodings: assessment?.actualEncodings,
      encodingMismatch: assessment?.encodingMismatch,
      requestedQuality: assessment?.requestedQuality,
      actualQualities: assessment?.actualQualities,
      qualityMismatch: assessment?.qualityMismatch,
      verifiedPages: assessment?.verifiedPages,
      firstObservedAt: assessment?.firstObservedAt,
      consecutiveObservations: assessment?.consecutiveObservations,
      candidateEligible,
      checkedAt: assessment?.checkedAt || undefined,
      attempts: job.attempts,
      automaticRecoveryAttempts: Number(payload.automaticRecoveryAttempts || 0),
    };
    return {
      id: `upload.${job.id}`,
      kind,
      severity,
      title: kind === "encoding_retry_failed" && (assessment?.requestedQuality || retry?.quality)
        ? "媒体替换未完成"
        : (titleByKind[kind] || titleByKind.manual_review),
      summary: retryBusy
        ? `正在按 ${[retry?.quality, retry?.priority?.[0]].filter(Boolean).join(" / ") || "指定媒体规格"} 重新下载并上传；替换流程不会主动清理旧文件，完成后会自动确认。`
        : retryFailureSummary,
      protectedFacts,
      recommendedAction: actions[0],
      availableActions: actions,
      bvid: job.bvid || undefined,
      userId: job.userId || undefined,
      mediaId: job.mediaId ?? undefined,
      folderTitle: payload.folderTitle || undefined,
      fileName: assessment?.fileName || (payload.conflictRelativePath ? path.basename(String(payload.conflictRelativePath)) : undefined),
      expectedSize: assessment?.expectedSize,
      observedSize: assessment?.observedSize,
      remoteErrorCode,
      responseHeaders,
      responseSnippet,
      requestedEncoding: assessment?.requestedEncoding,
      actualEncodings: assessment?.actualEncodings,
      encodingMismatch: assessment?.encodingMismatch,
      requestedQuality: assessment?.requestedQuality,
      actualQualities: assessment?.actualQualities,
      qualityMismatch: assessment?.qualityMismatch,
      verifiedPages: assessment?.verifiedPages,
      totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
      lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
      attemptKey: payload.attemptKey ? String(payload.attemptKey) : undefined,
      occurredAt: job.updatedAt || job.createdAt || this.now(),
      checkedAt: assessment?.checkedAt,
      nextAutomaticCheckAt: assessment?.nextCheckAt,
      busy: retryBusy,
      safeDiagnostic: JSON.stringify(diagnostic, null, 2),
      disposition,
    };
  }

  private buildDownloadRecoveryIssue(job: any): RecoveryIssue {
    const payload = job.payload as any;
    const stored = payload?.downloadRecovery && typeof payload.downloadRecovery === "object"
      ? payload.downloadRecovery
      : {};
    const category = ["transient", "account", "tool", "unknown"].includes(String(stored.category || ""))
      ? String(stored.category) as DownloadRecoveryCategory
      : "unknown";
    const kindByCategory: Record<DownloadRecoveryCategory, Extract<RecoveryIssueKind,
      "download_retry_exhausted" | "download_account_required" | "download_tool_failure">> = {
      transient: "download_retry_exhausted",
      account: "download_account_required",
      tool: "download_tool_failure",
      unknown: "download_retry_exhausted",
    };
    const kind = ["download_retry_exhausted", "download_account_required", "download_tool_failure"].includes(String(stored.kind || ""))
      ? String(stored.kind) as RecoveryIssueKind
      : kindByCategory[category];
    const currentDownloadUserId = String(stored.downloadUserId || payload.downloadUserId || payload.primaryUserId || job.userId || "");
    const alternateAccounts = this.userStore.list()
      .filter((user) => user.id !== currentDownloadUserId && this.isUserSyncEligible(user))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id))
      .map((user) => ({ value: user.id, label: `${user.name}（UID ${user.uid}）` }));
    const actions = planRecoveryActions({
      domain: "download",
      kind,
      jobKind: job.kind,
      downloadCategory: category,
      alternateAccounts,
      downloadEncodingEligible: payload.qualityFailure?.encodingEligible === true,
      downloadQualityEligible: payload.qualityFailure?.qualityEligible === true,
      downloadQualityChoices: this.qualityRetryChoices(payload.qualityProfile?.quality),
    });
    const meta = job.bvid ? this.stateManager.getVideoMeta(String(job.bvid)) : null;
    const titleByKind: Record<string, string> = {
      download_retry_exhausted: "下载重试次数已用完",
      download_account_required: "当前账号无法继续下载",
      download_tool_failure: "本地下载工具需要处理",
    };
    const local = job.bvid ? this.stateManager.getCompletedLocalDownload(String(job.bvid)) : null;
    const strictMediaTarget = payload.qualityStrict === true || payload.qualityEncodingOverride?.strict === true;
    return {
      id: `download.${job.id}`,
      kind,
      severity: recoveryIssueSeverity(kind),
      title: strictMediaTarget && payload.qualityFailure
        ? "严格媒体目标未满足"
        : (titleByKind[kind] || titleByKind.download_retry_exhausted),
      summary: sanitizeUploadText(stored.summary || job.lastError || "下载任务已安全暂停，等待选择恢复方式。", 300),
      protectedFacts: [
        "收藏来源和远端目标保持不变",
        local ? "已完成的本地文件和下载清单仍保留" : "已有下载进度不会因打开待处理面板而删除",
        "暂缓或换账号不会把视频标记为永久不可用",
      ],
      recommendedAction: actions[0],
      availableActions: actions,
      bvid: job.bvid || undefined,
      videoTitle: meta?.title || undefined,
      upperName: meta?.upperName || undefined,
      userId: currentDownloadUserId || undefined,
      requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality || undefined,
      actualQualities: payload.qualityFailure?.actualQualities,
      qualityMismatch: payload.qualityFailure?.qualityMismatch,
      requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0],
      actualEncodings: payload.qualityFailure?.actualEncodings,
      encodingMismatch: payload.qualityFailure?.encodingMismatch,
      verifiedPages: payload.qualityFailure?.verifiedPages,
      occurredAt: Number(stored.occurredAt || job.updatedAt || job.createdAt || this.now()),
      safeDiagnostic: JSON.stringify({
        issue: kind,
        category,
        task: job.kind,
        bvid: job.bvid || undefined,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        downloadUserId: currentDownloadUserId || undefined,
        alternateAccountCount: alternateAccounts.length,
        localDownloadRetained: Boolean(local),
        strictMediaTarget,
        requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
        actualQualities: payload.qualityFailure?.actualQualities,
        requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0],
        actualEncodings: payload.qualityFailure?.actualEncodings,
      }, null, 2),
      disposition: "action_required",
    };
  }

  private qualityArtifactRetryEligibility(job: any, evidenceField: "encodingEligible" | "qualityEligible", label: string) {
    if (!job || !["quality_download", "quality_upload"].includes(job.kind)) {
      return { eligible: false, reason: `当前阶段不能安全地更换${label}` };
    }
    const payload = job.payload as any;
    if (payload?.qualityFailure?.[evidenceField] !== true) {
      return { eligible: false, reason: `失败证据不能明确指向${label}` };
    }
    if ((Array.isArray(payload.backupFiles) && payload.backupFiles.length > 0)
      || (Array.isArray(payload.finalFiles) && payload.finalFiles.length > 0)) {
      return { eligible: false, reason: "远端正式替换已经开始，只能恢复原阶段" };
    }
    const bvid = String(job.bvid || payload.bvid || "");
    const allTargets = this.qualityTargetsFromPayload(payload);
    const selectedTarget = this.resolveQualityUpgradeTarget(job, payload, allTargets);
    const targets = job.kind === "quality_upload" && selectedTarget ? [selectedTarget] : allTargets;
    if (!bvid || targets.length === 0) return { eligible: false, reason: "画质重调目标不完整" };
    for (const target of targets) {
      const proof = this.stateManager.getQualityUpgradeOperation(target.userId, target.mediaId, bvid);
      if (proof) return { eligible: false, reason: "远端替换证明已经建立，只能恢复原阶段" };
    }
    return { eligible: true, reason: "旧归档尚未进入替换阶段" };
  }

  private qualityEncodingRetryEligibility(job: any) {
    return this.qualityArtifactRetryEligibility(job, "encodingEligible", "编码或单文件限制");
  }

  private qualityQualityRetryEligibility(job: any) {
    return this.qualityArtifactRetryEligibility(job, "qualityEligible", "画质档位");
  }

  private qualityRetryChoices(currentQuality: unknown) {
    const current = String(currentQuality || "").trim().toUpperCase();
    const values = ["8K", "4K", "1080P60", "1080P", "720P"];
    return values
      .filter((value) => value !== current)
      .map((value) => ({ value, label: value }));
  }

  getRecoveryIssues() {
    this.reconcileLegacyDownloadRecoveryJobs();
    const issues: RecoveryIssue[] = [
      ...this.manualRecoveryJobs().map((job) => this.buildUploadRecoveryIssue(job)),
      ...this.manualDownloadRecoveryJobs().map((job) => this.buildDownloadRecoveryIssue(job)),
    ];
    const qualityJobs = new Map<string, any>();
    for (const job of this.jobStore.listFailed(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"], 1_000)) {
      qualityJobs.set(job.id, job);
    }
    for (const job of this.jobStore.listManualRecovery(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"], 1_000)) {
      qualityJobs.set(job.id, job);
    }
    for (const job of qualityJobs.values()) {
      const payload = job.payload as any;
      const storedMeta = (!payload.videoTitle || !payload.upperName) && job.bvid
        ? this.stateManager.getVideoMeta(String(job.bvid))
        : null;
      const encodingEligibility = this.qualityEncodingRetryEligibility(job);
      const qualityEligibility = this.qualityQualityRetryEligibility(job);
      const actions = planRecoveryActions({
        domain: "quality",
        kind: "quality_failed",
        jobKind: job.kind,
        qualityEncodingEligible: encodingEligibility.eligible,
        qualityQualityEligible: qualityEligibility.eligible,
        qualityChoices: this.qualityRetryChoices(payload.qualityProfile?.quality),
      });
      issues.push({
        id: `quality.${job.id}`,
        kind: "quality_failed",
        severity: "warning",
        title: "画质重调已暂停",
        summary: sanitizeUploadText(job.lastError || payload.error || "画质重调任务失败。", 300),
        protectedFacts: ["失败流程不会自动删除正式旧路径", "失败任务不会进入普通播放来源", "重试会重新校验当前阶段"],
        recommendedAction: actions[0],
        availableActions: actions,
        bvid: job.bvid || payload.bvid,
        videoTitle: payload.videoTitle || storedMeta?.title || undefined,
        upperName: payload.upperName || storedMeta?.upperName || undefined,
        userId: job.userId || payload.userId,
        mediaId: job.mediaId ?? payload.mediaId,
        folderTitle: payload.folderTitle || payload.target?.folderTitle,
        requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
        actualQualities: payload.qualityFailure?.actualQualities,
        qualityMismatch: payload.qualityFailure?.qualityMismatch,
        requestedEncoding: payload.qualityFailure?.requestedEncoding || payload.qualityEncodingOverride?.priority?.[0] || payload.qualityProfile?.encoding,
        actualEncodings: payload.qualityFailure?.actualEncodings,
        encodingMismatch: payload.qualityFailure?.encodingMismatch,
        verifiedPages: payload.qualityFailure?.verifiedPages,
         occurredAt: job.updatedAt || job.createdAt || this.now(),
         safeDiagnostic: JSON.stringify({
           issue: "quality_failed",
           stage: job.kind,
           bvid: job.bvid,
           attempts: job.attempts,
           failureCategory: payload.qualityFailure?.category,
           encodingRetryEligible: encodingEligibility.eligible,
           encodingRetryReason: encodingEligibility.reason,
           qualityRetryEligible: qualityEligibility.eligible,
           qualityRetryReason: qualityEligibility.reason,
           requestedQuality: payload.qualityFailure?.requestedQuality || payload.qualityProfile?.quality,
           actualQualities: payload.qualityFailure?.actualQualities,
         }, null, 2),
         disposition: "action_required",
       });
    }
    const uploadHealth = this.uploadCircuit.getSnapshot();
    if (uploadHealth.state !== "closed" && ["auth", "deterministic"].includes(String(uploadHealth.category || ""))) {
      const action: RecoveryIssueAction = { id: "open_settings", label: "检查存储设置", description: "打开设置页核对 AList / OpenList 地址和认证信息。" };
      issues.unshift({
        id: "storage-backend",
        kind: "storage_backend",
        severity: "danger",
        title: uploadHealth.category === "auth" ? "存储认证失败" : "存储配置需要检查",
        summary: sanitizeUploadText(uploadHealth.reason || "AList / OpenList 暂不可用。", 300),
        protectedFacts: ["下载队列已暂停，避免继续占用本地空间", "认证失败不会自动清理待补传本地文件", "系统不会在认证失败时重复写入远端"],
        recommendedAction: action,
        availableActions: [action],
        occurredAt: uploadHealth.openedAt || this.now(),
         nextAutomaticCheckAt: uploadHealth.retryAt,
         safeDiagnostic: JSON.stringify({ issue: "storage_backend", category: uploadHealth.category, state: uploadHealth.state, retryAt: uploadHealth.retryAt }, null, 2),
         disposition: "action_required",
       });
    }
    issues.sort((left, right) => {
      const weight = { danger: 0, warning: 1, info: 2 };
      return weight[left.severity] - weight[right.severity] || right.occurredAt - left.occurredAt || left.id.localeCompare(right.id);
    });
    return issues;
  }

  getRecoveryIssueSnapshot() {
    this.reconcileTransferSessionRecoveryJobs();
    const allIssues = this.getRecoveryIssues();
    const backgroundRecoveries = allIssues.filter((issue) => issue.disposition === "background");
    const actionRequiredIssues = allIssues.filter((issue) => issue.disposition === "action_required");
    const intentionalConfirmations = allIssues.filter((issue) => issue.disposition === "intentional_confirmation");
    const issues = [...actionRequiredIssues, ...intentionalConfirmations];
    return {
      issues,
      backgroundRecoveries,
      actionRequiredIssues,
      intentionalConfirmations,
      issueSummary: {
        total: actionRequiredIssues.length,
        danger: actionRequiredIssues.filter((issue) => issue.severity === "danger").length,
        warning: actionRequiredIssues.filter((issue) => issue.severity === "warning").length,
        info: actionRequiredIssues.filter((issue) => issue.severity === "info").length,
        actionRequired: actionRequiredIssues.length,
        intentional: intentionalConfirmations.length,
        background: backgroundRecoveries.length,
      },
    };
  }

  private async resolveConflictCandidate(jobId: string, resolution: "keep_existing" | "use_candidate") {
    if (this.recoveryJobLocks.has(jobId)) {
      return { ok: false as const, status: 409, message: "该冲突候选正在被处理，请稍后刷新" };
    }
    this.recoveryJobLocks.add(jobId);
    try {
      return await this.resolveConflictCandidateLocked(jobId, resolution);
    } finally {
      this.recoveryJobLocks.delete(jobId);
    }
  }

  private async resolveConflictCandidateLocked(jobId: string, resolution: "keep_existing" | "use_candidate") {
    const job = this.jobStore.findById(jobId);
    if (!job || job.kind !== "upload" || !(job.payload as any)?.awaitingManualRecovery) {
      return { ok: false as const, status: 404, message: "冲突候选不存在或已处理" };
    }
    const payload = job.payload as any;
    const candidate = payload.conflictCandidate;
    if (!candidate || !Array.isArray(candidate.files) || candidate.files.length === 0) {
      return { ok: false as const, status: 409, message: "当前任务没有可选择的已验证候选" };
    }
    const relation = this.stateManager.getRelationStatus(String(job.userId || ""), Number(job.mediaId), String(job.bvid || ""));
    const recordedCandidate = relation?.remoteConflictCandidates?.find((item) => item.id === String(candidate.id) && !item.resolution);
    if (!recordedCandidate) {
      return { ok: false as const, status: 409, message: "收藏来源中的候选记录缺失或已经处理，请刷新待处理列表" };
    }
    const payloadFiles = candidate.files
      .map((file: RemoteFileRecord) => `${String(file.path || "").replace(/\\/g, "/")}:${Number(file.size)}`)
      .sort();
    const recordedFiles = recordedCandidate.files
      .map((file) => `${String(file.path || "").replace(/\\/g, "/")}:${Number(file.size)}`)
      .sort();
    if (String(candidate.candidateRemotePath || "") !== recordedCandidate.candidateRemotePath
      || JSON.stringify(payloadFiles) !== JSON.stringify(recordedFiles)) {
      return { ok: false as const, status: 409, message: "任务候选与收藏来源记录不一致，请重新检查" };
    }
    const candidateFiles = recordedCandidate.files;
    try {
      for (const file of candidateFiles) {
        if (!file.path || !Number.isFinite(Number(file.size)) || Number(file.size) <= 0) {
          return { ok: false as const, status: 409, message: "候选文件证明不完整，请重新检查" };
        }
        const result = await this.remoteFileInspector(this.configStore.get(), String(file.path), Number(file.size));
        if (result.status !== "verified") {
          return { ok: false as const, status: 409, message: "候选文件状态已经变化，请重新检查" };
        }
      }
      if (resolution === "keep_existing") {
        const proof = this.persistedExistingArchiveProof(payload)
          || this.persistedExistingArchiveProof({ existingArchiveProof: recordedCandidate.existingArchiveProof })
          || this.persistedExistingArchiveProof({ existingArchiveProof: candidate.existingArchiveProof });
        if (!proof) return { ok: false as const, status: 409, message: "现有归档缺少可恢复证明，不能将未知文件设为当前归档" };
        for (const file of proof.files) {
          if (!file.path || !Number.isFinite(Number(file.size)) || Number(file.size) <= 0) {
            return { ok: false as const, status: 409, message: "现有归档证明不完整，请采用候选或人工检查" };
          }
          const result = await this.remoteFileInspector(this.configStore.get(), file.path, Number(file.size));
          if (result.status !== "verified") {
            return { ok: false as const, status: 409, message: "现有归档已经变化，不能安全保留为当前来源" };
          }
        }
        if (!this.stateManager.restoreExistingArchiveProof(String(job.bvid || ""), job.userId, job.mediaId, proof)) {
          return { ok: false as const, status: 409, message: "现有归档证明无法恢复到当前收藏来源" };
        }
      } else {
        this.stateManager.markVerifiedUpload(
          String(job.bvid || ""),
          String(recordedCandidate.candidateRemotePath || path.posix.dirname(String(candidateFiles[0].path))),
          candidateFiles.map((file: RemoteFileRecord) => ({
            ...file,
            verificationStatus: "verified" as const,
            nextVerifyAt: undefined,
            lastError: undefined,
          })),
          job.userId,
          job.mediaId,
          false,
        );
      }
    } catch (error) {
      return {
        ok: false as const,
        status: 503,
        message: `暂时无法连接 AList / OpenList 复核候选：${sanitizeUploadText((error as any)?.message || error, 180)}`,
      };
    }
    const session = payload.sessionId ? this.transferSessions.get(String(payload.sessionId)) : null;
    if (session) {
      const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
      if (session.generation === generation && !["completed", "superseded"].includes(session.phase)) {
        this.transferSessions.supersede(session.id, generation);
      }
    }
    const resolved = this.stateManager.resolveRemoteConflictCandidate(
      String(job.bvid || ""),
      job.userId,
      job.mediaId,
      String(candidate.id),
      resolution === "keep_existing" ? "kept_existing" : "selected_candidate",
    );
    if (!resolved) {
      return { ok: false as const, status: 409, message: "候选状态已变化，请刷新待处理列表" };
    }
    this.jobStore.complete(job.id);
    void this.maybeCleanupVerifiedLocalDir(String(job.bvid || ""), String(payload.localDir || ""));
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "upload",
      level: "info",
      summary: resolution === "keep_existing"
        ? `已保留现有归档 ${job.bvid || ""}，冲突候选仍在独立目录`
        : `已采用冲突候选 ${job.bvid || ""}，正式旧路径仍未删除`,
      raw: `[Recovery] conflict candidate resolved action=${resolution}; files=${candidateFiles.length}`,
      bvid: job.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
  }

  private abandonRecoveryJob(jobId: string, expectedKinds: string[]) {
    const lockKey = `abandon:${jobId}`;
    if (this.recoveryJobLocks.has(lockKey)) {
      return { ok: false as const, status: 409, message: "该待处理项正在被其他操作处理，请稍后刷新" };
    }
    this.recoveryJobLocks.add(lockKey);
    try {
      const job = this.jobStore.findById(jobId);
      if (!job || !expectedKinds.includes(String(job.kind))) {
        return { ok: false as const, status: 404, message: "待处理项不存在或已自动解决" };
      }
      const payload = job.payload as any;
      if (payload.userDisposition === "abandoned" || payload.lifecycleState === "abandoned") {
        return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (payload.awaitingManualRecovery !== true) {
        return { ok: false as const, status: 409, message: "该待处理项已经不再等待人工处理" };
      }
      if (payload.encodingRetry && ["running", "uploading", "verifying"].includes(String(payload.encodingRetry?.state || ""))) {
        return { ok: false as const, status: 409, message: "编码替换仍在运行，请等待当前候选结束" };
      }
      if (payload.sessionId) {
        const session = this.transferSessions.get(String(payload.sessionId));
        if (session) {
          const generation = Number.isInteger(payload.sessionGeneration)
            ? Number(payload.sessionGeneration)
            : session.generation;
          if (session.generation !== generation) {
            return { ok: false as const, status: 409, message: "当前候选已经产生新的代次，请刷新待处理项" };
          }
          if (!["completed", "superseded"].includes(session.phase)) {
            this.transferSessions.supersede(session.id, generation);
          }
        }
      }
      const candidate = payload.conflictCandidate;
      if (candidate?.id && job.userId && Number.isInteger(job.mediaId)) {
        const relation = this.stateManager.getRelationStatus(job.userId, Number(job.mediaId), String(job.bvid || ""));
        if (relation?.remoteConflictCandidates?.some((item) => item.id === String(candidate.id) && !item.resolution)) {
          this.stateManager.resolveRemoteConflictCandidate(
            String(job.bvid || ""),
            job.userId,
            job.mediaId,
            String(candidate.id),
            "abandoned",
          );
        }
      }
      const abandoned = this.jobStore.abandonRecovery(job.id, "用户已放弃本次候选，原归档保持不变。", {
        attemptKey: payload.attemptKey || (payload.sessionId && payload.sessionGeneration
          ? `${payload.sessionId}:g${payload.sessionGeneration}`
          : undefined),
        recoveryReason: "user_abandoned",
      });
      if (!abandoned) {
        const current = this.jobStore.findById(job.id);
        return current?.payload && (current.payload as any).userDisposition === "abandoned"
          ? { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues }
          : { ok: false as const, status: 409, message: "待处理项状态已经变化，请刷新后重试" };
      }
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "system",
        level: "info",
        summary: `用户已放弃本次恢复候选 ${job.bvid || ""}`,
        raw: `[Recovery] attempt abandoned kind=${job.kind}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      this.dispatchPersistentJobs();
      return { ok: true as const, idempotent: false, issues: this.getRecoveryIssueSnapshot().issues };
    } finally {
      this.recoveryJobLocks.delete(lockKey);
    }
  }

  private async startEncodingRetry(jobId: string, priority: BBDownEncoding[], strict: boolean, requestedQuality?: string) {
    const job = this.jobStore.findById(jobId);
    if (!job || job.kind !== "upload" || (job.payload as any)?.historyOnly) {
      return { ok: false as const, status: 404, message: "该任务不支持编码替换" };
    }
    const payload = job.payload as any;
    const retryState = payload.encodingRetry;
    if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))) {
      const activeChild = retryState.replacementJobId ? this.jobStore.findById(String(retryState.replacementJobId)) : null;
      if (activeChild) return { ok: true as const, idempotent: true as const, childJobId: activeChild.id };
      return { ok: false as const, status: 409, message: "编码替换任务正在恢复，请刷新待处理项" };
    }
    if (payload.awaitingManualRecovery !== true) {
      return { ok: false as const, status: 404, message: "该任务不支持编码替换" };
    }
    const quality = String(requestedQuality || "").trim().toUpperCase();
    if (quality && !isSelectableBilibiliQuality(quality)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    const currentRetry = parseEncodingRetryContext(payload.encodingRetry);
    const assessment = this.recoveryAssessment(payload);
    if (!assessment || !["remote_size_limit", "remote_write_rejected", "encoding_retry_failed"].includes(assessment.kind)) {
      return { ok: false as const, status: 409, message: "当前任务不是可更换编码的远端写入错误，请先重新检查" };
    }
    const local = this.inspectRecoveryLocalFiles(job);
    if (local.status !== "available") {
      return { ok: false as const, status: 409, message: "原始下载文件已不可用，不能安全进行编码替换" };
    }
    const originalLocalDir = String(local.session?.localDir || payload.localDir || "");
    if (!this.isSafeEncodingRetryDirectory(originalLocalDir)) {
      return { ok: false as const, status: 409, message: "原始下载目录不在受保护的临时目录内" };
    }
    const userId = String(job.userId || payload.userId || "");
    const mediaId = Number(job.mediaId ?? payload.mediaId);
    const bvid = String(job.bvid || payload.bvid || "");
    const relation = userId && Number.isInteger(mediaId)
      ? this.stateManager.getRelationStatus(userId, mediaId, bvid)
      : null;
    const user = userId ? this.userStore.getById(userId) : null;
    if (!user?.enabled || !relation) {
      return { ok: false as const, status: 409, message: "原收藏账号或来源已不可用于重新下载" };
    }
    if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid)) {
      return { ok: false as const, status: 409, message: "该收藏来源正在删除或清理，请稍后再试" };
    }
    const remotePath = String(payload.remotePath || relation.remotePath || "");
    if (!remotePath) return { ok: false as const, status: 409, message: "原归档路径缺失，不能建立安全替换任务" };
    const originalFiles: string[] = local.files.length > 0
      ? local.files.map((file) => file.relativePath)
      : (Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : []);
    if (originalFiles.length === 0) {
      const manifest = readDownloadSession(originalLocalDir);
      if (manifest) originalFiles.push(...manifest.outputs.map((output) => output.relativePath));
    }
    if (originalFiles.length === 0) return { ok: false as const, status: 409, message: "原始下载清单缺少文件列表" };
    const folderTitle = String(payload.folderTitle || relation.folderTitle || "favorites");
    const target: UploadTarget = { userId, mediaId, folderTitle, remotePath };
    const generation = Math.max(0, Number(currentRetry?.generation || retryState?.generation || 0)) + 1;
    const safeBvid = sanitizeSegment(bvid).slice(0, 80) || "video";
    const candidateLocalDir = path.join(
      path.resolve(this.legacyTempDir),
      `${safeBvid}-encoding-retry-${job.id.slice(0, 12)}-g${generation}`,
    );
    if (!this.isSafeEncodingRetryDirectory(candidateLocalDir) || fs.existsSync(candidateLocalDir)) {
      return { ok: false as const, status: 409, message: "替换任务目录已存在，请刷新待处理项后重试" };
    }
    const context: EncodingRetryContext = {
      parentJobId: job.id,
      generation,
      priority: [...priority],
      strict,
      quality: quality || undefined,
      candidateLocalDir,
      originalLocalDir,
      originalFiles: [...new Set(originalFiles.map((file: string) => String(file).split(String.fromCharCode(92)).join("/").replace(/^\/+/, "")))],
      target,
      state: "running",
    };
    const child: EnqueuePersistentJob = {
      kind: "download",
      dedupeKey: `encoding-retry-download:${job.id}:g${generation}`,
      bvid,
      userId,
      mediaId,
      priority: 5,
      maxAttempts: this.configStore.get().maxRetries + 1,
      payload: {
        primaryUserId: userId,
        primaryMediaId: mediaId,
        primaryFolderTitle: folderTitle,
        downloadUserId: userId,
        detachedTargets: [target],
        encodingRetry: context,
        ...(quality ? (() => {
          const profile = normalizeQualityArtifactProfile({
            ...qualityArtifactProfileFromConfig(this.configStore.get()),
            quality,
            encoding: priority[0],
          });
          return {
            qualityProfile: profile,
            qualityStrict: true,
            qualityArtifactKey: buildQualityArtifactKey(bvid, profile),
          };
        })() : {}),
      },
    };
    const started = this.jobStore.startEncodingRetry(job.id, child, context as unknown as Record<string, unknown>);
    if (!started) return { ok: false as const, status: 409, message: "该待处理任务正在被其他操作处理，请刷新后重试" };
    if (!started.idempotent) this.dispatchPersistentJobs();
    return { ok: true as const, idempotent: Boolean(started.idempotent), childJobId: started.child.id };
  }

  private startConflictCandidate(jobId: string, automatic = false) {
    const ownsLock = !this.recoveryJobLocks.has(jobId);
    if (!ownsLock && !automatic) {
      return { ok: false as const, status: 409, message: "该待处理任务正在被其他操作处理，请稍后刷新" };
    }
    if (ownsLock) this.recoveryJobLocks.add(jobId);
    try {
      const job = this.jobStore.findById(jobId);
      if (!job || job.kind !== "upload" || !(job.payload as any)?.awaitingManualRecovery) {
        return { ok: false as const, status: 404, message: "待处理任务不存在或已经恢复" };
      }
      if ((job.payload as any)?.conflictCandidateOnly === true) {
        return { ok: false as const, status: 409, message: "当前任务已经是隔离候选，请先处理现有候选" };
      }
      const assessment = this.recoveryAssessment(job.payload);
      const eligibility = this.inspectConflictCandidateEligibility(job, assessment);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能生成隔离候选：${eligibility.reason}` };
      }
      const payload = job.payload as any;
      const observedExistingArchiveProof = this.observedSameSizeProof(job, assessment);
      const candidateId = String(payload.conflictCandidateId || `upload-${job.id}`);
      const candidateRemotePath = String(
        payload.conflictCandidateRemotePath
        || joinRemotePath(String(payload.remotePath || ""), "_conflicts", candidateId),
      );
      if (!payload.remotePath || !candidateRemotePath) {
        return { ok: false as const, status: 409, message: "任务缺少稳定远端路径，不能生成候选" };
      }
      const woken = this.jobStore.wakeManualJob(job.id, {
        awaitingManualRecovery: false,
        allowReupload: false,
        resumeOnly: false,
        conflictCandidateId: candidateId,
        conflictCandidateRemotePath: candidateRemotePath,
        conflictCandidateOnly: true,
        conflictCandidateReasonCode: `RECOVERY_${String(assessment?.kind || "MANUAL_REVIEW").toUpperCase()}`,
        conflictCandidateReasonSummary: sanitizeUploadText(assessment?.summary || "用户确认生成隔离候选", 300),
        candidateStartedAt: this.now(),
        lifecycleState: "conflict_candidate",
        userDisposition: automatic ? "automatic_candidate" : "create_candidate",
        ...(observedExistingArchiveProof ? { existingArchiveProof: observedExistingArchiveProof } : {}),
      });
      if (!woken) {
        return { ok: false as const, status: 409, message: "任务状态已经变化，请刷新后重试" };
      }
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "upload",
        level: "warn",
        summary: `开始生成隔离冲突候选 ${job.bvid || ""}`,
        raw: `[Recovery] conflict candidate requested; files=${eligibility.fileCount}; bytes=${eligibility.totalBytes}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      this.dispatchPersistentJobs();
      return { ok: true as const, jobId: job.id };
    } finally {
      if (ownsLock) this.recoveryJobLocks.delete(jobId);
    }
  }

  private downloadRecoveryTargets(job: any) {
    const payload = job?.payload as any;
    const candidates = [
      ...(Array.isArray(payload?.downloadRecovery?.targets) ? payload.downloadRecovery.targets : []),
      ...(Array.isArray(payload?.detachedTargets) ? payload.detachedTargets : []),
      ...(payload?.primaryUserId && Number.isInteger(Number(payload.primaryMediaId))
        ? [{ userId: payload.primaryUserId, mediaId: Number(payload.primaryMediaId) }]
        : []),
      ...(job?.userId && Number.isInteger(Number(job.mediaId))
        ? [{ userId: job.userId, mediaId: Number(job.mediaId) }]
        : []),
    ];
    const targets = new Map<string, { userId: string; mediaId: number }>();
    for (const candidate of candidates) {
      const userId = String(candidate?.userId || "");
      const mediaId = Number(candidate?.mediaId);
      if (!userId || !Number.isInteger(mediaId)) continue;
      targets.set(`${userId}:${mediaId}`, { userId, mediaId });
    }
    return [...targets.values()];
  }

  private resumeDownloadRecoveryRelations(job: any, reason: string) {
    const bvid = String(job?.bvid || "");
    if (!bvid) return;
    this.stateManager.runBatch(() => {
      for (const target of this.downloadRecoveryTargets(job)) {
        const relation = this.stateManager.getRelationStatus(target.userId, target.mediaId, bvid);
        if (!relation?.activeInFavorite || relation.accountDetachedAt) continue;
        if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(target.userId, target.mediaId, bvid)) continue;
        this.stateManager.markRelationRetryPending(bvid, target.userId, target.mediaId, reason);
      }
    });
  }

  private parseLegacyDownloadFailureKey(value: string) {
    const parts = String(value || "").split(":");
    if (parts.length < 3) return null;
    const userId = String(parts.shift() || "");
    const mediaId = Number(parts.shift());
    const bvid = parts.join(":");
    if (!userId || !Number.isInteger(mediaId) || mediaId <= 0 || !bvid) return null;
    return { userId, mediaId, bvid };
  }

  private async resolveLegacyDownloadFailureIssue(
    issueKey: string,
    action: RecoveryIssueActionId,
    options: { userId?: unknown },
  ) {
    if (!["retry_download", "retry_download_with_account", "defer_download", "abandon_attempt"].includes(action)) {
      return { ok: false as const, status: 400, message: "该下载待处理项不支持此操作" };
    }
    const lockKey = `legacy-download.${issueKey}`;
    if (this.recoveryJobLocks.has(lockKey)) {
      return { ok: false as const, status: 409, message: "该旧版下载记录正在被处理，请稍后刷新" };
    }
    this.recoveryJobLocks.add(lockKey);
    try {
      const target = this.parseLegacyDownloadFailureKey(issueKey);
      if (!target) return { ok: false as const, status: 404, message: "旧版下载记录不存在或已自动解决" };
      const database = this.stateManager.getDatabase();
      const failure = database.getFailure(target.userId, target.bvid, target.mediaId);
      const relation = this.stateManager.getRelationStatus(target.userId, target.mediaId, target.bvid);
      if (!failure?.permanent || !relation?.activeInFavorite || relation.accountDetachedAt) {
        return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (failure.userDisposition === "abandoned") {
        return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (action === "abandon_attempt") {
        database.upsertFailure(target.userId, {
          ...failure,
          userDisposition: "abandoned",
          abandonedAt: new Date(this.now()).toISOString(),
        });
        logManager.push({
          timestamp: new Date(this.now()).toISOString(),
          type: "download",
          level: "info",
          summary: `用户已放弃旧版失败下载 ${target.bvid}`,
          raw: "[Recovery] legacy download abandoned",
          bvid: target.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (relation.favoriteUnavailable && !relation.selfVisible) {
        return { ok: false as const, status: 409, message: "当前视频仍被确认不可用，暂不能重新下载" };
      }
      if (["uploaded", "verified", "partial_verified", "uploading", "downloaded", "queued", "downloading"].includes(String(relation.backupStatus || ""))) {
        return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (database.isArchiveSourceDeletionBlocked(target.userId, target.mediaId, target.bvid)) {
        return { ok: false as const, status: 409, message: "该收藏来源正在清理，请等待清理结束后再重试" };
      }
      const existingJob = this.jobStore.findByDedupeKey(`download:${target.bvid}`);
      if (existingJob) {
        return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
      }
      const resolved = this.resolveRelation(relation);
      if (!resolved) {
        return { ok: false as const, status: 409, message: "原下载账号当前不可用，请先恢复账号或换一个可用账号" };
      }

      let selectedUserId = resolved.user.id;
      if (action === "retry_download_with_account") {
        const requestedUserId = String(options.userId || "");
        const user = requestedUserId ? this.userStore.getById(requestedUserId) : null;
        if (!this.isUserSyncEligible(user) || user.id === resolved.user.id) {
          return { ok: false as const, status: 400, message: "请选择另一个当前可用的登录账号" };
        }
        try {
          const snapshot = await this.videoAccessProbe(downloadCredentialsForUser(user), target.bvid);
          if (!snapshot.available || snapshot.access.classification === "charging_restricted") {
            return { ok: false as const, status: 409, message: "所选账号当前无法访问这个视频，请换一个账号或稍后再试" };
          }
        } catch (error: any) {
          return {
            ok: false as const,
            status: 409,
            message: `所选账号访问检查失败：${sanitizeUploadText(error?.message || error || "未知错误", 180)}`,
          };
        }
        selectedUserId = user.id;
      }

      const deferred = action === "defer_download";
      const notBefore = deferred ? this.now() + 24 * 60 * 60_000 : this.now();
      let queued = false;
      this.stateManager.runBatch(() => {
        this.stateManager.resetRelationForRetry(
          target.bvid,
          target.userId,
          target.mediaId,
          deferred ? "用户已将旧版失败下载暂缓24小时。" : "用户已从待处理中心重新启动旧版失败下载。",
          { clearFailure: true },
        );
        queued = this.enqueueIfNeeded(resolved.user, target.mediaId, resolved.folderTitle, target.bvid, {
          persisted: true,
          notBefore,
          downloadUserId: selectedUserId,
        });
      });
      if (!queued && !this.stateManager.getChargingRestriction(target.bvid)) {
        return { ok: false as const, status: 409, message: "下载任务未能重新排队，请刷新待处理列表后重试" };
      }
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "download",
        level: "info",
        summary: deferred
          ? `旧版下载失败已暂缓24小时 ${target.bvid}`
          : `已从旧版失败记录重新启动下载 ${target.bvid}`,
        raw: `[Recovery] legacy download action=${action} accountChanged=${selectedUserId !== resolved.user.id}`,
        bvid: target.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      this.dispatchPersistentJobs();
      return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
    } finally {
      this.recoveryJobLocks.delete(lockKey);
    }
  }

  private restartStrictDownloadRecovery(
    jobId: string,
    action: RecoveryIssueActionId,
    options: { encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    const job = this.jobStore.findById(jobId);
    if (!job || job.kind !== "download") {
      return { ok: false as const, status: 404, message: "下载待处理项不存在或已恢复" };
    }
    const payload = job.payload as any;
    if (!payload.awaitingManualRecovery) {
      return ["pending", "retry_wait", "leased", "running"].includes(job.status)
        ? { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues }
        : { ok: false as const, status: 409, message: "下载任务状态已经变化，请刷新后重试" };
    }
    const quality = String(options.quality || "").trim().toUpperCase();
    const priority = isValidBBDownEncodingPriority(options.encodingPriority)
      ? normalizeBBDownEncodingPriority(options.encodingPriority)
      : undefined;
    const qualityEligible = payload.qualityFailure?.qualityEligible === true;
    const encodingEligible = payload.qualityFailure?.encodingEligible === true;
    if (quality && !isSelectableBilibiliQuality(quality)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    if (!quality && !priority) {
      return { ok: false as const, status: 400, message: "请选择画质或编码" };
    }
    const bvid = String(job.bvid || payload.bvid || "");
    const currentProfile = normalizeQualityArtifactProfile(
      payload.qualityProfile || qualityArtifactProfileFromConfig(this.configStore.get()),
    );
    const currentEncoding = String(payload.qualityEncodingOverride?.priority?.[0] || currentProfile.encoding || "").toUpperCase();
    if (quality && quality !== currentProfile.quality && !qualityEligible) {
      return { ok: false as const, status: 409, message: "当前失败证据不能安全更换画质档位" };
    }
    if (priority && priority[0] !== currentEncoding && !encodingEligible) {
      return { ok: false as const, status: 409, message: "当前失败证据不能安全更换编码" };
    }
    const nextProfile = {
      ...currentProfile,
      ...(quality ? { quality } : {}),
      ...(priority ? { encoding: priority[0] } : {}),
    };
    const generation = Math.max(0, Number(payload.qualityRetryGeneration || 0), Number(payload.qualityEncodingOverride?.generation || 0)) + 1;
    const artifactKey = crypto.createHash("sha256").update(JSON.stringify({
      sourceArtifactKey: String(payload.qualityArtifactKey || buildQualityArtifactKey(bvid, currentProfile)),
      generation,
      quality: quality || undefined,
      priority,
    })).digest("hex");
    const nextPayload: Record<string, any> = {
      ...payload,
      bvid,
      qualityProfile: nextProfile,
      qualityStrict: Boolean(quality) || payload.qualityStrict === true,
      qualityEncodingOverride: priority
        ? { generation, priority, strict: options.strict !== false }
        : payload.qualityEncodingOverride,
      qualityArtifactKey: artifactKey,
      qualityRetryGeneration: generation,
      awaitingManualRecovery: false,
      downloadRecovery: undefined,
      qualityFailure: undefined,
      manualRecoveryReason: undefined,
      lastRecoveryAction: action,
    };
    for (const key of ["downloadDir", "outputFiles", "error"]) delete nextPayload[key];
    const woken = this.jobStore.wakeManualJob(job.id, nextPayload);
    if (!woken) return { ok: false as const, status: 409, message: "下载任务正在被其他操作处理，请刷新后重试" };
    const targetLabel = [quality, priority?.[0]].filter(Boolean).join(" / ");
    this.resumeDownloadRecoveryRelations(job, `已按 ${targetLabel} 严格重新下载。`);
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "download",
      level: "info",
      summary: `已按 ${targetLabel} 严格重新下载 ${bvid}`,
      raw: `[Recovery] strict-download action=${action} generation=${generation}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
  }

  private async resolveDownloadRecoveryIssue(
    jobId: string,
    action: RecoveryIssueActionId,
    options: { userId?: unknown; encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    if (action === "abandon_attempt") {
      return this.abandonRecoveryJob(jobId, ["download"]);
    }
    if (["redownload_with_encoding", "redownload_with_quality"].includes(action)) {
      return this.restartStrictDownloadRecovery(jobId, action, options);
    }
    if (!["retry_download", "retry_download_with_account", "defer_download"].includes(action)) {
      return { ok: false as const, status: 400, message: "该下载待处理项不支持此操作" };
    }
    if (this.recoveryJobLocks.has(jobId)) {
      return { ok: false as const, status: 409, message: "该下载任务正在被处理，请稍后刷新" };
    }
    this.recoveryJobLocks.add(jobId);
    try {
      const job = this.jobStore.findById(jobId);
      if (!job || job.kind !== "download") {
        return { ok: false as const, status: 404, message: "下载待处理项不存在或已恢复" };
      }
      if (!(job.payload as any)?.awaitingManualRecovery) {
        return ["pending", "retry_wait", "leased", "running"].includes(job.status)
          ? { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues }
          : { ok: false as const, status: 409, message: "下载任务状态已经变化，请刷新后重试" };
      }

      const payload = job.payload as any;
      const legacyFailureKey = String(payload.legacyFailureKey || "");
      if (legacyFailureKey && ["retry_download", "retry_download_with_account", "defer_download"].includes(action)) {
        const migrated = await this.resolveLegacyDownloadFailureIssue(legacyFailureKey, action, options);
        if (!migrated.ok) return migrated;
        this.jobStore.complete(job.id);
        return { ...migrated, issues: this.getRecoveryIssueSnapshot().issues };
      }
      let selectedUserId = String(payload.downloadUserId || payload.primaryUserId || job.userId || "");
      if (action === "retry_download_with_account") {
        const requestedUserId = String(options.userId || "");
        const user = requestedUserId ? this.userStore.getById(requestedUserId) : null;
        if (!this.isUserSyncEligible(user) || user.id === selectedUserId) {
          return { ok: false as const, status: 400, message: "请选择另一个当前可用的登录账号" };
        }
        try {
          const snapshot = await this.videoAccessProbe(downloadCredentialsForUser(user), String(job.bvid || ""));
          if (!snapshot.available || snapshot.access.classification === "charging_restricted") {
            return { ok: false as const, status: 409, message: "所选账号当前无法访问这个视频，请换一个账号或稍后再试" };
          }
        } catch (error: any) {
          return {
            ok: false as const,
            status: 409,
            message: `所选账号访问检查失败：${sanitizeUploadText(error?.message || error || "未知错误", 180)}`,
          };
        }
        selectedUserId = user.id;
      }

      const deferred = action === "defer_download";
      const notBefore = deferred ? this.now() + 24 * 60 * 60_000 : this.now();
      const woken = this.jobStore.wakeManualJob(job.id, {
        awaitingManualRecovery: false,
        downloadRecovery: undefined,
        downloadUserId: selectedUserId || undefined,
        manualRecoveryDeferredAt: deferred ? this.now() : undefined,
        manualRecoveryDeferredUntil: deferred ? notBefore : undefined,
      }, notBefore);
      if (!woken) {
        return { ok: false as const, status: 409, message: "下载任务正在被其他操作处理，请刷新后重试" };
      }
      if (!deferred) {
        this.resumeDownloadRecoveryRelations(job, "用户已从待处理中心重新启动下载。");
      }
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "download",
        level: "info",
        summary: deferred
          ? `下载任务已暂缓24小时 ${job.bvid || ""}`
          : `${action === "retry_download_with_account" ? "已换账号重新下载" : "已重新启动下载"} ${job.bvid || ""}`,
        raw: `[Recovery] download action=${action} deferred=${deferred} accountChanged=${action === "retry_download_with_account"}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      this.dispatchPersistentJobs();
      return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
    } finally {
      this.recoveryJobLocks.delete(jobId);
    }
  }

  private restartQualityRecovery(
    jobId: string,
    options: { priority?: BBDownEncoding[]; strictEncoding?: boolean; quality?: string },
  ) {
    const job = this.jobStore.findById(jobId);
    if (!job) return { ok: false as const, status: 404, message: "画质重调任务不存在或已恢复" };
    const qualityRetry = String(options.quality || "").trim().toUpperCase();
    const priority = options.priority && isValidBBDownEncodingPriority(options.priority)
      ? normalizeBBDownEncodingPriority(options.priority)
      : undefined;
    if (qualityRetry && !isSelectableBilibiliQuality(qualityRetry)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    if (!qualityRetry && !priority) {
      return { ok: false as const, status: 400, message: "请选择画质或编码" };
    }
    const payload = job.payload as any;
    const bvid = String(job.bvid || payload.bvid || "");
    const allTargets = this.qualityTargetsFromPayload(payload);
    const selectedTarget = this.resolveQualityUpgradeTarget(job, payload, allTargets);
    const targets = job.kind === "quality_upload" && selectedTarget ? [selectedTarget] : allTargets;
    if (!bvid || targets.length === 0) {
      return { ok: false as const, status: 409, message: "画质重调目标已经变化，请刷新后重试" };
    }
    const generation = Math.max(
      0,
      Number(payload.qualityEncodingOverride?.generation || 0),
      Number(payload.qualityRetryGeneration || 0),
    ) + 1;
    const currentProfile = normalizeQualityArtifactProfile(payload.qualityProfile || qualityArtifactProfileFromConfig(this.configStore.get()));
    const currentEncoding = String(payload.qualityEncodingOverride?.priority?.[0] || currentProfile.encoding || "").toUpperCase();
    if (qualityRetry && qualityRetry !== currentProfile.quality) {
      const eligibility = this.qualityQualityRetryEligibility(job);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能换分辨率重调：${eligibility.reason}` };
      }
    }
    if (priority && priority[0] !== currentEncoding) {
      const eligibility = this.qualityEncodingRetryEligibility(job);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能换编码重调：${eligibility.reason}` };
      }
    }
    const qualityProfile = {
      ...currentProfile,
      ...(qualityRetry ? { quality: qualityRetry } : {}),
      ...(priority ? { encoding: priority[0] } : {}),
    };
    const strictEncoding = Boolean(priority && options.strictEncoding);
    const artifactKey = crypto.createHash("sha256").update(JSON.stringify({
      sourceArtifactKey: String(payload.artifactKey || buildQualityArtifactKey(bvid, qualityProfile)),
      generation,
      priority,
      strictEncoding,
      quality: qualityRetry || undefined,
      jobId,
    })).digest("hex");
    const target = targets[0];
    const nextPayload: Record<string, any> = {
      ...payload,
      bvid,
      userId: target.userId,
      mediaId: target.mediaId,
      folderTitle: target.folderTitle,
      target,
      targets,
      targetCount: targets.length,
      artifactKey,
      qualityProfile,
      qualityStrict: Boolean(qualityRetry) || Boolean(payload.qualityStrict),
      qualityEncodingOverride: priority
        ? { generation, priority, strict: strictEncoding }
        : payload.qualityEncodingOverride,
      qualityRetryGeneration: generation,
      qualityStageLabel: `等待按 ${[qualityRetry, priority?.[0]].filter(Boolean).join(" / ")}${qualityRetry && priority ? "（仅此组合）" : qualityRetry ? "（仅此画质）" : "（仅此编码）"}下载新版`,
      awaitingManualRecovery: false,
      automaticQualityRecoveryAttempts: 0,
      supersededQualityArtifactKey: payload.artifactKey,
      supersededQualityLocalDir: payload.downloadDir,
    };
    for (const key of [
      "runId",
      "downloadDir",
      "outputFiles",
      "uploadResult",
      "backupFiles",
      "finalFiles",
      "stageRemotePath",
      "backupRemotePath",
      "qualityFailure",
      "error",
      "qualityTargetResolution",
    ]) {
      delete nextPayload[key];
    }
    const downloadUserId = String(payload.downloadUserId || target.userId || "");
    const downloadUser = this.userStore.getById(downloadUserId);
    if (!this.isUserSyncEligible(downloadUser)) {
      return { ok: false as const, status: 409, message: "原下载账号当前不可用，请先恢复账号后再重调" };
    }
    nextPayload.downloadUserId = downloadUser.id;
    const replacement = this.jobStore.restartFailedQualityAsDownload(job.id, {
      kind: "quality_download",
      dedupeKey: `quality-download:${bvid}:${artifactKey}`,
      bvid,
      userId: downloadUser.id,
      mediaId: target.mediaId,
      priority: 35,
      maxAttempts: this.configStore.get().maxRetries + 1,
      payload: nextPayload,
    });
    if (!replacement.ok) {
      return { ok: false as const, status: 409, message: "画质重调任务状态已经变化，请刷新后重试" };
    }
    logManager.push({
      timestamp: new Date(this.now()).toISOString(),
      type: "download",
      level: "info",
      summary: `已按 ${[qualityRetry, priority?.[0]].filter(Boolean).join(" / ")} 重新建立画质重调 ${bvid}`,
      raw: `[QualityRecovery] restart mode=profile generation=${generation} strictQuality=${Boolean(qualityRetry)} strictEncoding=${strictEncoding} targets=${targets.length}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    this.dispatchPersistentJobs();
    return { ok: true as const, jobId: replacement.job.id, issues: this.getRecoveryIssueSnapshot().issues };
  }

  async resolveRecoveryIssue(
    issueId: string,
    action: RecoveryIssueActionId,
    options: { encodingPriority?: unknown; strict?: unknown; userId?: unknown; quality?: unknown } = {},
  ) {
    if (issueId === "storage-backend") {
      return { ok: false as const, status: 409, message: "请在设置中检查 AList / OpenList 配置" };
    }
    const separator = issueId.indexOf(".");
    const scope = separator > 0 ? issueId.slice(0, separator) : "";
    const jobId = separator > 0 ? issueId.slice(separator + 1) : "";
    if (!jobId) return { ok: false as const, status: 404, message: "待处理项不存在或已自动解决" };
    if (scope === "legacy-download") {
      return this.resolveLegacyDownloadFailureIssue(jobId, action, options);
    }
    if (scope === "download") {
      return this.resolveDownloadRecoveryIssue(jobId, action, options);
    }
    if (scope === "upload") {
      const currentJob = this.jobStore.findById(jobId);
      const retryState = (currentJob?.payload as any)?.encodingRetry;
      if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))
        && action !== "redownload_with_encoding") {
        return { ok: false as const, status: 409, message: "编码替换正在进行，请等待替换下载、上传和远端确认完成" };
      }
      if (action === "abandon_attempt") {
        return this.abandonRecoveryJob(jobId, ["upload", "history_upload"]);
      }
      if (action === "recheck") {
        await this.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (action === "reupload") {
        const result = await this.recoverUploadJob(jobId, true);
        return result.ok
          ? { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues }
          : result;
      }
      if (action === "create_candidate") {
        await this.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        const current = this.jobStore.findById(jobId);
        if (!current) return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
        const result = this.startConflictCandidate(jobId);
        return result.ok
          ? { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues }
          : result;
      }
      if (action === "redownload") {
        await this.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        const current = this.jobStore.findById(jobId);
        const assessment = current ? this.recoveryAssessment(current.payload) : null;
        if (!current) return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
        if (!assessment || assessment.remoteStatus !== "missing" || !["missing", "changed"].includes(assessment.localStatus)) {
          return { ok: false as const, status: 409, message: "最新复核不允许重新下载，请刷新待处理项" };
        }
        if (!this.queueFreshDownloadForRecovery(current, assessment.localStatus, true)) {
          return { ok: false as const, status: 409, message: "当前来源无法安全重新下载，请确认账号与收藏关系仍有效" };
        }
        return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
      }
      if (action === "redownload_with_encoding") {
        if (this.recoveryJobLocks.has(jobId)) {
          return { ok: false as const, status: 409, message: "该编码替换任务正在被处理，请稍后刷新" };
        }
        const quality = String(options.quality || "").trim().toUpperCase();
        const hasEncoding = options.encodingPriority !== undefined;
        if (quality && !isSelectableBilibiliQuality(quality)) {
          return { ok: false as const, status: 400, message: "不支持的画质档位" };
        }
        if (hasEncoding && !isValidBBDownEncodingPriority(options.encodingPriority)) {
          return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
        }
        if (!quality && !hasEncoding) {
          return { ok: false as const, status: 400, message: "请选择画质或编码" };
        }
        const requestedPriority = hasEncoding
          ? normalizeBBDownEncodingPriority(options.encodingPriority)
          : normalizeBBDownEncodingPriority(this.configStore.get().bbdownEncodingPriority, this.configStore.get().bbdownEncoding);
        this.recoveryJobLocks.add(jobId);
        try {
          const started = await this.startEncodingRetry(
            jobId,
            requestedPriority,
            hasEncoding && options.strict !== false,
            quality || undefined,
          );
          if (!started.ok) return started;
          return {
            ok: true as const,
            idempotent: Boolean(started.idempotent),
            childJobId: started.childJobId,
            issues: this.getRecoveryIssueSnapshot().issues,
          };
        } finally {
          this.recoveryJobLocks.delete(jobId);
        }
      }
      if (action === "keep_existing" || action === "use_candidate") {
        return this.resolveConflictCandidate(jobId, action);
      }
    }
    if (scope === "quality" && action === "abandon_attempt") {
      return this.abandonRecoveryJob(jobId, ["quality_download", "quality_upload", "quality_replace", "quality_cleanup"]);
    }
    if (scope === "quality" && action === "retry_quality") {
      if (this.recoveryJobLocks.has(jobId)) {
        return { ok: false as const, status: 409, message: "画质重调任务正在被其他操作处理" };
      }
      this.recoveryJobLocks.add(jobId);
      try {
        const job = this.jobStore.findById(jobId);
        if (!job || !["quality_download", "quality_upload", "quality_replace", "quality_cleanup"].includes(job.kind)) {
          return { ok: false as const, status: 404, message: "画质重调任务不存在或已恢复" };
        }
        const awaitingManualRecovery = (job.payload as any)?.awaitingManualRecovery === true;
        if (["pending", "retry_wait", "leased", "running"].includes(job.status) && !awaitingManualRecovery) {
          return { ok: true as const, idempotent: true, issues: this.getRecoveryIssueSnapshot().issues };
        }
        if (!["failed", "manual_wait", "retry_wait", "pending"].includes(job.status)) {
          return { ok: false as const, status: 409, message: "画质重调任务状态已经变化，请刷新后重试" };
        }
        if (!this.jobStore.wakeManualJob(job.id, {
          awaitingManualRecovery: false,
          qualityFailure: undefined,
          error: undefined,
          automaticQualityRecoveryAttempts: 0,
          automaticQualityRecoveryCategory: undefined,
          automaticQualityRecoveryError: undefined,
        })) {
          return { ok: false as const, status: 409, message: "画质重调任务正在被其他操作处理" };
        }
        this.dispatchPersistentJobs();
        return { ok: true as const, issues: this.getRecoveryIssueSnapshot().issues };
      } finally {
        this.recoveryJobLocks.delete(jobId);
      }
    }
    if (scope === "quality" && action === "retry_quality_with_encoding") {
      const quality = String(options.quality || "").trim().toUpperCase();
      const hasEncoding = options.encodingPriority !== undefined;
      if (quality && !isSelectableBilibiliQuality(quality)) {
        return { ok: false as const, status: 400, message: "不支持的画质档位" };
      }
      if (hasEncoding && !isValidBBDownEncodingPriority(options.encodingPriority)) {
        return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
      }
      if (!quality && !hasEncoding) {
        return { ok: false as const, status: 400, message: "请选择画质或编码" };
      }
      if (this.recoveryJobLocks.has(jobId)) {
        return { ok: false as const, status: 409, message: "该画质重调任务正在被处理，请稍后刷新" };
      }
      this.recoveryJobLocks.add(jobId);
      try {
        return this.restartQualityRecovery(jobId, {
          priority: hasEncoding ? normalizeBBDownEncodingPriority(options.encodingPriority) : undefined,
          strictEncoding: hasEncoding && options.strict !== false,
          quality: quality || undefined,
        });
      } finally {
        this.recoveryJobLocks.delete(jobId);
      }
    }
    if (scope === "quality" && action === "retry_quality_with_quality") {
      const quality = String(options.quality || "").trim().toUpperCase();
      if (!quality) return { ok: false as const, status: 400, message: "请选择新的画质档位" };
      if (options.encodingPriority !== undefined && !isValidBBDownEncodingPriority(options.encodingPriority)) {
        return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
      }
      if (this.recoveryJobLocks.has(jobId)) {
        return { ok: false as const, status: 409, message: "该画质重调任务正在被处理，请稍后刷新" };
      }
      this.recoveryJobLocks.add(jobId);
      try {
        return this.restartQualityRecovery(jobId, {
          quality,
          priority: isValidBBDownEncodingPriority(options.encodingPriority)
            ? normalizeBBDownEncodingPriority(options.encodingPriority)
            : undefined,
          strictEncoding: options.strict !== false,
        });
      } finally {
        this.recoveryJobLocks.delete(jobId);
      }
    }
    return { ok: false as const, status: 400, message: "该待处理项不支持此操作" };
  }

  async recoverUploadJob(jobId: string, allowReupload = false) {
    const job = this.jobStore.findById(String(jobId || ""));
    if (!job || !["upload", "history_upload"].includes(job.kind)) {
      return { ok: false as const, status: 404, message: "Upload recovery job not found" };
    }
    const payload = job.payload as any;

    // A legacy resume-only job can outlive its local candidate. If the
    // relation already contains a complete verified proof for the same
    // remote directory and file set, finish from that proof instead of
    // waking an upload that can only fail on a missing local file.
    if (!allowReupload && this.isPlainObsoleteArchiveRecovery(job)) {
      if (this.recoveryJobLocks.has(job.id)) {
        return { ok: false as const, status: 409, message: "正在复核现有归档，请稍候" };
      }
      this.recoveryJobLocks.add(job.id);
      try {
      const bvid = String(job.bvid || payload.bvid || "");
      const proof = this.captureExistingArchiveProof(job.userId, job.mediaId, bvid);
      if (proof && await this.confirmVerifiedArchiveProofForRecovery(job, proof) === "verified") {
        const resolved = this.finalizeRetainedArchiveRecovery(job, proof, { allowResumeOnly: true });
        if (resolved) {
          return { ok: true as const, job, idempotent: true as const, resolved: "verified_archive" as const };
        }
      }
      } finally {
        this.recoveryJobLocks.delete(job.id);
      }
    }

    if (!payload.awaitingManualRecovery) {
      if (["pending", "leased", "running", "retry_wait"].includes(job.status)) {
        return { ok: true as const, job, idempotent: true as const };
      }
      return { ok: false as const, status: 409, message: "This upload is not waiting for manual recovery" };
    }
    let recoveryFiles = Array.isArray(payload.files)
      ? payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/")).filter(Boolean)
      : [];
    if (payload.sessionId) {
      const session = this.transferSessions.get(String(payload.sessionId));
      if (!session) return { ok: false as const, status: 409, message: "Upload session is no longer available" };
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration) {
        return { ok: false as const, status: 409, message: "Upload attempt is no longer current; please refresh the recovery item" };
      }
      const sessionFiles = this.transferSessions.listFiles(session.id, expectedGeneration);
      if (recoveryFiles.length === 0) recoveryFiles = sessionFiles.map((file) => file.relativePath);
      const selectedFiles = new Set(recoveryFiles);
      for (const file of sessionFiles.filter((candidate) => selectedFiles.has(candidate.relativePath))) {
        const localFile = path.resolve(session.localDir, file.relativePath);
        if (localFile !== path.resolve(session.localDir) && !localFile.startsWith(`${path.resolve(session.localDir)}${path.sep}`)) {
          return { ok: false as const, status: 409, message: "Upload file path is invalid" };
        }
        try {
          const stat = fs.statSync(localFile);
          if (!stat.isFile() || stat.size !== file.expectedSize) {
            return { ok: false as const, status: 409, message: "Local upload files changed; a new upload is required" };
          }
        } catch {
          return { ok: false as const, status: 409, message: "Local upload files are no longer available" };
        }
      }
    } else {
      const localDirectory = String(payload.localDir || "").trim();
      if (!localDirectory) {
        return { ok: false as const, status: 409, message: "本地补传目录缺失，请重新下载后再上传" };
      }
      const localRoot = path.resolve(localDirectory);
      try {
        const rootInfo = fs.lstatSync(localRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          return { ok: false as const, status: 409, message: "本地补传目录已不可用，请重新下载后再上传" };
        }
      } catch {
        return { ok: false as const, status: 409, message: "本地补传目录已不存在，请重新下载后再上传" };
      }
      for (const relativePath of recoveryFiles) {
        const localFile = path.resolve(localRoot, relativePath);
        if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) {
          return { ok: false as const, status: 409, message: "本地补传文件路径无效" };
        }
        try {
          const fileInfo = fs.lstatSync(localFile);
          if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size <= 0) {
            return { ok: false as const, status: 409, message: "本地补传文件已不存在，请重新下载后再上传" };
          }
        } catch {
          return { ok: false as const, status: 409, message: "本地补传文件已不存在，请重新下载后再上传" };
        }
      }
    }

    const woken = this.jobStore.wakeManualJob(job.id, {
      awaitingManualRecovery: false,
      allowReupload: false,
      reuploadAuthorizedFiles: allowReupload ? [...new Set(recoveryFiles)] : [],
      resumeOnly: true,
      ...(payload.sessionId && !Number.isInteger(payload.sessionGeneration)
        ? { sessionGeneration: this.transferSessions.get(String(payload.sessionId))?.generation }
        : {}),
    });
    if (!woken) {
      const current = this.jobStore.findById(job.id);
      return current
        ? { ok: true as const, job: current, idempotent: true as const }
        : { ok: false as const, status: 409, message: "Upload recovery is already being handled" };
    }
    // Per-file permissions remain on the leased job until the corresponding
    // PUT is about to start. Preflight and queue delays do not consume them.
    this.dispatchPersistentJobs();
    return { ok: true as const, job: woken, idempotent: false as const };
  }

  private buildPersistentUploadJob(item: RecoveryUploadItem): EnqueuePersistentJob {
    const relationProof = item.userId && Number.isInteger(item.mediaId)
      ? this.stateManager.getRelationStatus(item.userId, Number(item.mediaId), item.bvid)
      : null;
    const persistedItem: RecoveryUploadItem = {
      ...item,
      uploadIntent: item.uploadIntent || (item.historyOnly ? "history_upload" : "normal_backup"),
      existingArchiveProof: item.encodingRetry
        ? item.existingArchiveProof
        : (item.existingArchiveProof || this.captureExistingArchiveProof(item.userId, item.mediaId, item.bvid)),
      legacyConflictSideEffectsStarted: Boolean(
        item.legacyConflictSideEffectsStarted
        || this.legacyConflictSideEffectsStarted(item, relationProof),
      ),
    };
    const key = this.recoveryUploadKey(persistedItem);
    return {
      kind: persistedItem.historyOnly ? "history_upload" : "upload",
      dedupeKey: `upload:${key}`,
      bvid: persistedItem.bvid,
      userId: persistedItem.userId,
      mediaId: persistedItem.mediaId,
      priority: persistedItem.priority === false ? 80 : 20,
      maxAttempts: this.configStore.get().maxRetries + 1,
      notBefore: persistedItem.awaitingManualRecovery ? 0 : (persistedItem.notBefore || 0),
      initialStatus: persistedItem.awaitingManualRecovery ? "manual_wait" : undefined,
      payload: { ...persistedItem },
    };
  }

  private reconcileTransferSessionRecoveryJobs(force = false) {
    const now = this.now();
    if (!force && now - this.transferSessionRecoveryReconciledAt < 30_000) return 0;
    this.transferSessionRecoveryReconciledAt = now;
    this.jobStore.normalizeStoppedRecovery();

    const activeKeys = this.jobStore.listActiveTransferSessionKeys();
    const inputs: EnqueuePersistentJob[] = [];
    const pageSize = 100;
    const maxProjected = 100;
    let offset = 0;
    for (;;) {
      const page = this.transferSessions.listRecoverablePage(pageSize, offset);
      if (page.length === 0) break;
      offset += page.length;
      for (const session of page) {
        const generation = Math.max(1, Number(session.generation || 1));
        const attemptKey = `${session.id}:g${generation}`;
        if (activeKeys.has(attemptKey)) continue;

        const files = this.transferSessions.listFiles(session.id, generation);
        const emptyAttempt = files.length === 0;
        const verifiedPages = files.filter((file) => file.status === "verified").length;
        // Do not stat every output while serving the recovery HTTP endpoint.
        // The worker performs the authoritative local-file check before any
        // upload or candidate operation.
        const localStatus = "unknown" as const;
        const allVerified = files.length > 0 && verifiedPages === files.length;
        const waitingRemote = allVerified || session.phase === "awaiting_remote"
          || files.some((file) => file.status === "awaiting_remote");
        const partialUpload = verifiedPages > 0 && verifiedPages < files.length;
        const failed = (session.phase === "failed" && !allVerified) || emptyAttempt;
        const classified = session.lastError
          ? classifyUploadError({ message: session.lastError }, "<remote>")
          : null;
        const errorText = String(session.lastError || "");
        const kind: RecoveryIssueKind = classified?.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE
          ? "remote_size_limit"
          : /编码|画质|BFB_ENCODING/i.test(errorText)
            ? "encoding_retry_failed"
            : /远端拒绝|写入结果|WebDAV|\b405\b/i.test(errorText)
              ? "remote_write_rejected"
            : "manual_review";
        const lifecycleState = failed
          ? "manual_required"
          : partialUpload
            ? "partial_upload"
            : waitingRemote
              ? "remote_visibility_wait"
              : "uploading";
        const assessment: RecoveryAssessment = {
          kind,
          checkedAt: now,
          localStatus,
          remoteStatus: waitingRemote ? "unknown" : "error",
          verifiedPages,
          summary: failed
            ? sanitizeUploadText(emptyAttempt ? "当前传输代次缺少分P清单，等待核对已有归档；不会重新上传。" : session.lastError || "上传候选没有对应的恢复任务，已安全暂停。", 300)
            : `上传候选已恢复到${verifiedPages}/${files.length}个分P；本地文件将在实际恢复前检查。`,
          ...(waitingRemote || emptyAttempt || verifiedPages === files.length ? { nextCheckAt: now + 2_000 } : {}),
        };
        let filenameMetadataByPath: Record<string, NonNullable<RemoteFileRecord["filenameMetadata"]>> | undefined;
        try {
          filenameMetadataByPath = buildUploadFileMetadataFromSession(session.localDir, files.map((file) => file.relativePath));
        } catch {
          filenameMetadataByPath = undefined;
        }
        const meta = this.stateManager.getVideoMeta(session.bvid);
        const relation = session.userId && session.mediaId !== undefined && Number.isInteger(session.mediaId)
          ? this.stateManager.getRelationStatus(session.userId, session.mediaId, session.bvid)
          : null;
        let existingArchiveProof: ExistingArchiveProof | undefined;
        if (!session.historyOnly && session.userId && Number.isInteger(session.mediaId)) {
          try {
            existingArchiveProof = this.captureExistingArchiveProof(session.userId, session.mediaId, session.bvid);
          } catch {
            existingArchiveProof = undefined;
          }
        }
        inputs.push({
          kind: session.historyOnly ? "history_upload" : "upload",
          dedupeKey: `upload-session:${attemptKey}`,
          bvid: session.bvid,
          userId: session.userId,
          mediaId: session.mediaId,
          priority: failed ? 20 : 25,
          maxAttempts: this.configStore.get().maxRetries + 1,
          initialStatus: failed ? "manual_wait" : "pending",
          payload: {
            bvid: session.bvid,
            localDir: session.localDir,
            remotePath: session.remotePath,
            userId: session.userId,
            mediaId: session.mediaId,
            files: files.map((file) => file.relativePath),
            filenameMetadataByPath,
            folderTitle: relation?.folderTitle || "",
            videoTitle: meta?.title || session.bvid,
            upperName: meta?.upperName || "",
            cover: meta?.cover || "",
            historyOnly: session.historyOnly,
            historySnapshotAt: session.historySnapshotAt,
            uploadIntent: session.historyOnly ? "history_upload" : "normal_backup",
            existingArchiveProof,
            sessionId: session.id,
            sessionGeneration: generation,
            sessionDedupeKey: session.dedupeKey,
            attemptKey,
            recoveryProjection: true,
            emptyAttempt,
            lifecycleState,
            recoveryReason: session.lastError || undefined,
            recoveryAssessment: assessment,
            awaitingManualRecovery: failed,
            resumeOnly: waitingRemote,
            partialBackup: partialUpload,
            verifiedPages,
            totalPages: files.length,
          },
        });
        activeKeys.add(attemptKey);
        if (inputs.length >= maxProjected) break;
      }
      if (inputs.length >= maxProjected || page.length < pageSize) break;
    }
    if (inputs.length === 0) return 0;
    try {
      this.jobStore.enqueueBatch(inputs);
      logManager.push({
        timestamp: new Date(now).toISOString(),
        type: "system",
        level: "info",
        summary: `已补齐 ${inputs.length} 个上传候选恢复入口`,
        raw: `[Recovery] transfer session projection repaired count=${inputs.length}`,
        simpleVisible: true,
        debugVisible: true,
      });
      return inputs.length;
    } catch (error) {
      console.warn(`[Recovery] Failed to project transfer sessions: ${safeErrorSummary(error)}`);
      return 0;
    }
  }

  resumePersistedWorkOnStartup() {
    this.jobStore.recoverExpiredLeases();
    this.reconcileTransferSessionRecoveryJobs(true);
    const normalizedUploadRecoveries = this.jobStore.normalizeTerminalUploadRecovery();
    if (normalizedUploadRecoveries > 0) {
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
        type: "system",
        level: "info",
        summary: `已将 ${normalizedUploadRecoveries} 个耗尽的上传任务恢复到待处理中心`,
        raw: `[Recovery] normalized terminal upload jobs=${normalizedUploadRecoveries}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    void this.reconcileObsoleteVerifiedArchiveRecoveries();
    try {
      this.migrateLegacyQualityDownloadJobs();
    } catch (error) {
      console.warn(`[Recovery] Failed to migrate legacy quality downloads: ${safeErrorSummary(error)}`);
    }
    this.bootstrapLegacyFailureClassification();
    this.resumePersistedWork();
    this.startLegacyTempCacheRecovery();
    this.dispatchPersistentJobs();
  }

  private migrateLegacyQualityDownloadJobs() {
    const database = this.stateManager.getDatabase();
    if (database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER) === "complete") return 0;
    const candidateCount = this.jobStore.countLegacyQualityDownloadJobs();
    if (candidateCount > 100_000) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "warn",
        summary: `旧画质下载任务超过安全上限，已保留待下次处理`,
        raw: `[QualityUpgrade] legacy migration candidate limit exceeded count=${candidateCount}`,
        simpleVisible: true,
        debugVisible: true,
      });
      return 0;
    }
    const jobs = this.jobStore.listLegacyQualityDownloadJobs(100_001);
    if (jobs.length !== candidateCount) {
      throw new Error(`Legacy quality migration changed while preparing: expected=${candidateCount}; actual=${jobs.length}`);
    }
    if (jobs.length === 0) {
      this.jobStore.applyQualityDownloadMigration([], LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
      return 0;
    }
    const currentProfile = qualityArtifactProfileFromConfig(this.configStore.get());
    const groups = new Map<string, { artifactKey: string; profile: QualityArtifactProfile; jobs: typeof jobs }>();
    for (const job of jobs) {
      const payload = job.payload as any;
      const manifest = typeof payload.downloadDir === "string" ? readDownloadSession(payload.downloadDir) : null;
      const profile = normalizeQualityArtifactProfile(
        payload.qualityProfile
        || manifest?.qualityUpgrade?.qualityProfile
        || manifest?.configSnapshot
        || currentProfile
      );
      const bvid = String(job.bvid || payload.bvid || manifest?.bvid || "");
      if (!bvid) throw new Error(`Legacy quality download ${job.id} is missing its BVID`);
      const artifactKey = String(payload.artifactKey || manifest?.qualityUpgrade?.artifactKey || buildQualityArtifactKey(bvid, profile));
      const groupKey = `${bvid}:${artifactKey}`;
      const group = groups.get(groupKey) || { artifactKey, profile, jobs: [] };
      group.jobs.push(job);
      groups.set(groupKey, group);
    }

    const plans: QualityDownloadMigrationPlan[] = [];
    for (const group of groups.values()) {
      const bvid = String(group.jobs[0].bvid || (group.jobs[0].payload as any).bvid || "");
      if (!bvid) throw new Error("Legacy quality download is missing its BVID");
      const dedupeKey = `quality-download:${bvid}:${group.artifactKey}`;
      const existingShared = this.jobStore.findByDedupeKey(dedupeKey);
      if (existingShared && !group.jobs.some((job) => job.id === existingShared.id)) {
        group.jobs.push(existingShared);
      }
      const targets = new Map<string, QualityUpgradeTarget>();
      for (const job of group.jobs) {
        for (const target of this.qualityTargetsFromPayload(job.payload as any)) {
          targets.set(qualityUpgradeTargetKey(target), target);
        }
      }
      const mergedTargets = [...targets.values()];
      if (mergedTargets.length === 0) throw new Error(`Legacy quality download ${bvid} has no recoverable target`);
      const base = [...group.jobs].sort((left, right) => {
        const leftPayload = left.payload as any;
        const rightPayload = right.payload as any;
        const leftScore = (leftPayload.downloadDir ? 2 : 0) + (Array.isArray(leftPayload.outputFiles) && leftPayload.outputFiles.length > 0 ? 1 : 0);
        const rightScore = (rightPayload.downloadDir ? 2 : 0) + (Array.isArray(rightPayload.outputFiles) && rightPayload.outputFiles.length > 0 ? 1 : 0);
        return rightScore - leftScore || right.updatedAt - left.updatedAt;
      })[0];
      const enabledDownloadUser = group.jobs
        .map((job) => String((job.payload as any).downloadUserId || job.userId || ""))
        .find((id) => Boolean(this.userStore.getById(id)?.enabled));
      const payload = {
        ...(base.payload as any),
        bvid,
        userId: mergedTargets[0].userId,
        mediaId: mergedTargets[0].mediaId,
        folderTitle: mergedTargets.length > 1 ? `${mergedTargets.length}个目标` : mergedTargets[0].folderTitle,
        downloadUserId: enabledDownloadUser || (base.payload as any).downloadUserId || base.userId || mergedTargets[0].userId,
        target: mergedTargets[0],
        targets: mergedTargets,
        targetCount: mergedTargets.length,
        artifactKey: group.artifactKey,
        qualityProfile: group.profile,
        qualityStageLabel: `等待下载新版${mergedTargets.length > 1 ? ` · ${mergedTargets.length}个目标` : ""}`,
      };
      plans.push({
        jobs: group.jobs,
        replacement: {
          kind: "quality_download",
          dedupeKey,
          bvid,
          userId: payload.downloadUserId,
          mediaId: mergedTargets[0].mediaId,
          priority: Math.min(...group.jobs.map((job) => job.priority)),
          maxAttempts: Math.max(...group.jobs.map((job) => job.maxAttempts)),
          notBefore: Math.max(...group.jobs.map((job) => job.notBefore)),
          payload,
        },
      });
    }
    this.jobStore.applyQualityDownloadMigration(plans, LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
    if (candidateCount > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `已合并 ${candidateCount} 个旧画质下载任务`,
        raw: `[QualityUpgrade] consolidated legacy download jobs=${candidateCount}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    return candidateCount;
  }

  private bootstrapLegacyFailureClassification() {
    const database = this.stateManager.getDatabase();
    if (database.getMeta("legacy_failure_classification_v1") === "complete") return;
    const candidates = this.stateManager.listLegacyFailureClassificationCandidates(100_000);
    for (const item of candidates) {
      this.enqueueChargingAccessProbe(item.relation.bvid, {
        preferredUserId: item.relation.userId,
        purpose: "legacy_failure_classification",
      });
    }
    database.setMeta("legacy_failure_classification_v1", "complete");
    if (candidates.length > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `已安排 ${candidates.length} 个旧永久失败视频重新分类`,
        raw: `[Recovery] legacy permanent failures queued for access classification count=${candidates.length}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }

  private snapshotRetirementTargets(bvid: string) {
    const config = this.configStore.get();
    const targets = new Map<string, UploadTarget>();
    for (const relation of this.stateManager.listRelationsForBvid(bvid)) {
      if (["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
      if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, relation.bvid)) continue;
      const relationUser = this.userStore.getById(relation.userId);
      if (!relationUser) continue;
      const folder = relationUser.favorites.find((item) => item.mediaId === relation.mediaId);
      const folderTitle = folder?.title || relation.folderTitle;
      targets.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle,
        remotePath: relation.remotePath || this.resolveRelationRemotePath(relationUser, relation.mediaId, folderTitle, config),
      });
    }
    return [...targets.values()];
  }

  private buildCompletedRetirementUploads(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ): RecoveryUploadItem[] {
    if (targets.length === 0) return [];
    const meta = this.stateManager.getVideoMeta(bvid);
    const items: RecoveryUploadItem[] = [];
    for (const target of targets) {
      items.push({
        bvid,
        localDir: local.localDir,
        remotePath: target.remotePath,
        userId: target.userId,
        mediaId: target.mediaId,
        folderTitle: target.folderTitle,
        videoTitle: meta?.title || bvid,
        upperName: meta?.upperName || "",
        cover: meta?.cover || "",
        files: local.files,
        filenameMetadataByPath: buildUploadFileMetadataFromSession(local.localDir, local.files),
        partialBackup: local.partialBackup,
        priority: true,
      });
      for (const history of historySessionGroups(local.localDir)) {
        items.push({
          bvid,
          localDir: local.localDir,
          remotePath: joinRemotePath(target.remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: meta?.title || bvid,
          upperName: meta?.upperName || "",
          cover: meta?.cover || "",
          files: history.files.map((file) => file.relativePath),
          historyOnly: true,
          historySnapshotAt: history.snapshotAt,
          priority: false,
        });
      }
    }
    return items;
  }

  private persistCompletedRetirementUploadJobs(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ) {
    let queued = 0;
    for (const item of this.buildCompletedRetirementUploads(bvid, local, targets)) {
      if (this.queueUploadWork(item, false)) queued += 1;
    }
    return queued;
  }

  private queueCompletedRetirementUpload(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ) {
    if (targets.length === 0) return 0;
    this.stateManager.markDownloaded(bvid, local.localDir, targets);
    const queued = this.persistCompletedRetirementUploadJobs(bvid, local, targets);
    this.dispatchPersistentJobs();
    return queued;
  }

  private findCompletedQualitySession(job: any) {
    const payload = job.payload || {};
    const expectedArtifactKey = String(payload.artifactKey || "");
    const candidates = new Set<string>();
    if (typeof payload.downloadDir === "string" && payload.downloadDir) candidates.add(payload.downloadDir);
    try {
      for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(`quality-upgrade-${job.bvid}-`)) {
          candidates.add(path.join(tempDir, entry.name));
        }
      }
    } catch {
      // The cache directory may not exist yet.
    }
    for (const downloadDir of candidates) {
      const manifest = readDownloadSession(downloadDir);
      if (!manifest || manifest.kind !== "quality_upgrade" || manifest.status !== "complete" || manifest.outputs.length === 0) continue;
      const manifestProfile = normalizeQualityArtifactProfile(
        manifest.qualityUpgrade?.qualityProfile || manifest.configSnapshot || qualityArtifactProfileFromConfig(this.configStore.get())
      );
      const manifestArtifactKey = String(
        manifest.qualityUpgrade?.artifactKey || buildQualityArtifactKey(manifest.bvid, manifestProfile)
      );
      if (expectedArtifactKey && manifestArtifactKey !== expectedArtifactKey) continue;
      const outputFiles = manifest.outputs.map((output) => output.relativePath);
      if (!outputFiles.every((relative) => fs.existsSync(path.join(downloadDir, relative)))) continue;
      return { downloadDir, outputFiles, runId: payload.runId || `resume-${manifest.sessionId}` };
    }
    return null;
  }

  async retireUser(user: BiliUser) {
    const dependentJobs = this.jobStore.listUserDependentJobs(user.id);
    const jobIds = new Set(dependentJobs.map((job) => job.id));
    const targetsByBvid = new Map<string, UploadTarget[]>();
    for (const relation of this.stateManager.getDatabase().listRelationsForUser(user.id)) {
      if (!targetsByBvid.has(relation.bvid)) targetsByBvid.set(relation.bvid, this.snapshotRetirementTargets(relation.bvid));
    }
    for (const job of dependentJobs) {
      const bvid = String(job.bvid || "");
      if (bvid && !targetsByBvid.has(bvid)) targetsByBvid.set(bvid, this.snapshotRetirementTargets(bvid));
    }
    for (const [bvid, detachedTargets] of targetsByBvid) {
      const existing = this.jobStore.findByDedupeKey(`download:${bvid}`);
      if (!existing || jobIds.has(existing.id)) continue;
      const merged = new Map<string, UploadTarget>();
      for (const target of Array.isArray((existing.payload as any).detachedTargets) ? (existing.payload as any).detachedTargets : []) {
        if (target?.userId && Number.isInteger(Number(target.mediaId))) merged.set(`${target.userId}:${target.mediaId}`, target);
      }
      for (const target of detachedTargets) merged.set(`${target.userId}:${target.mediaId}`, target);
      this.jobStore.updatePayload(existing.id, { ...existing.payload, detachedTargets: [...merged.values()] });
    }
    for (const task of this.downloadQueue.getTasks()) {
      if (task.persistentJobId && jobIds.has(task.persistentJobId) && task.status === "running") {
        this.retirementAbortedJobIds.add(task.persistentJobId);
      }
    }
    const removedQueuedTasks = this.downloadQueue.removePendingTasks((task) =>
      Boolean(task.persistentJobId && jobIds.has(task.persistentJobId))
    ).length;
    const canceledProcesses = await cancelActiveDownloadsForAccount(String(user.uid || user.cookie.DedeUserID || ""));
    const alternateUser = this.userStore.list().find((candidate) => candidate.id !== user.id && this.isUserSyncEligible(candidate));
    let reassignedJobs = 0;
    let pausedJobs = 0;
    let directUploadTargets = 0;

    for (const job of dependentJobs) {
      const bvid = String(job.bvid || "");
      if (job.kind === "download") {
        const local = bvid ? this.stateManager.getCompletedLocalDownload(bvid) : null;
        if (local) {
          this.jobStore.complete(job.id);
          directUploadTargets += this.queueCompletedRetirementUpload(bvid, local, targetsByBvid.get(bvid) || []);
          continue;
        }
      } else if (job.kind === "quality_download") {
        const completed = this.findCompletedQualitySession(job);
        if (completed) {
          job.payload = {
            ...job.payload,
            downloadDir: completed.downloadDir,
            outputFiles: completed.outputFiles,
            runId: completed.runId,
          };
        }
      }

      const payload = {
        ...job.payload,
        detachedTargets: job.kind === "download" ? (targetsByBvid.get(bvid) || []) : (job.payload as any).detachedTargets,
      };
      if (alternateUser) {
        if (this.jobStore.reassignDownloadJob(job.id, alternateUser.id, payload)) reassignedJobs += 1;
      } else if (this.jobStore.pauseDetachedUserJob(job.id, user.id, payload)) {
        pausedJobs += 1;
      }
    }

    const detachedRelations = this.stateManager.detachUserRelations(user.id);
    for (const job of this.jobStore.list(["access_probe"], 100_000)) {
      const preferredUserId = String((job.payload as any)?.preferredUserId || "");
      if (preferredUserId !== user.id) continue;
      this.jobStore.updatePayload(job.id, { ...job.payload, preferredUserId: "" });
      this.jobStore.wakeByBvid(String(job.bvid || ""), ["access_probe"], this.now());
    }
    this.dispatchPersistentJobs();
    return {
      canceledJobs: dependentJobs.length,
      canceledProcesses,
      removedQueuedTasks,
      reassignedJobs,
      pausedJobs,
      directUploadTargets,
      detachedRelations,
    };
  }

  private archiveTaskReferencesUser(task: any, userId: string) {
    if (String(task?.userId || "") === userId || String(task?.downloadUserId || "") === userId) return true;
    const control = task?.control;
    if (String(control?.userId || "") === userId || String(control?.downloadUserId || "") === userId) return true;
    const payload = task?.persistentJob?.payload || {};
    if ([payload.primaryUserId, payload.downloadUserId, payload.pausedForUserId].some((value) => String(value || "") === userId)) {
      return true;
    }
    const targets = [
      ...(Array.isArray(task?.targets) ? task.targets : []),
      ...(Array.isArray(control?.targets) ? control.targets : []),
      ...(Array.isArray(payload.targets) ? payload.targets : []),
      ...(Array.isArray(payload.detachedTargets) ? payload.detachedTargets : []),
      ...(payload.target ? [payload.target] : []),
    ];
    return targets.some((target) => String(target?.userId || "") === userId);
  }

  async prepareSourceDeletion(userId: string, mediaId: number, bvid: string, timeoutMs = 30_000) {
    if (this.archiveDeletionLocked) {
      throw Object.assign(new Error("账号归档清理期间不能执行来源级准备"), { statusCode: 409 });
    }
    const matches = (value: any) => this.archiveDeletionTargetMatches(value?.userId, value?.mediaId, bvid)
      && String(value?.userId || "") === userId
      && Number(value?.mediaId || 0) === mediaId;
    const filterTargets = <T extends { userId?: unknown; mediaId?: unknown }>(targets: T[]) =>
      targets.filter((target) => !matches(target));
    let removedQueuedTasks = 0;

    for (const task of this.downloadQueue.getTasks()) {
      if (String(task.bvid || "") !== bvid) continue;
      const running = task.status === "running";
      const taskTargets = Array.isArray((task as any).targets) ? (task as any).targets : [];
      if (taskTargets.length > 0) {
        const remaining = filterTargets(taskTargets);
        (task as any).targets = remaining;
        if (remaining.length > 0 && matches((task as any).target)) {
          (task as any).target = remaining[0];
          (task as any).userId = remaining[0].userId;
          (task as any).mediaId = remaining[0].mediaId;
          (task as any).remotePath = (remaining[0] as any).remotePath;
        }
        if (remaining.length === 0 && !running) {
          (task as any).target = undefined;
          (task as any).userId = undefined;
          (task as any).mediaId = undefined;
        }
      } else if (matches(task) && !running) {
        (task as any).userId = undefined;
        (task as any).mediaId = undefined;
        (task as any).remotePath = undefined;
      }
      const control = (task as any).control;
      if (control && Array.isArray(control.targets)) {
        const remaining = filterTargets(control.targets);
        if (typeof control.setTargets === "function") control.setTargets(remaining);
        else control.targets = remaining;
      }
    }
    removedQueuedTasks += this.downloadQueue.removePendingTasks((task) => {
      if (String((task as any).bvid || "") !== bvid) return false;
      const targets = Array.isArray((task as any).targets) ? (task as any).targets : [];
      return targets.length === 0 && !((task as any).userId && (task as any).mediaId);
    }).length;
    removedQueuedTasks += this.uploadQueue.removePendingTasks((task) => matches(task)).length;
    removedQueuedTasks += this.verificationQueue.removePendingTasks((task) => matches(task)).length;

    const downloadJobs = this.jobStore.list(["download", "quality_download"], 100_000);
    for (const job of downloadJobs) {
      if (String(job.bvid || "") !== bvid) continue;
      const payload = { ...(job.payload as any) };
      if (job.kind === "quality_download") {
        const targets = filterTargets(this.qualityTargetsFromPayload(payload));
        const nextPayload = { ...payload, targets, targetCount: targets.length };
        if (targets.length > 0) {
          nextPayload.target = targets[0];
          nextPayload.userId = targets[0].userId;
          nextPayload.mediaId = targets[0].mediaId;
          nextPayload.folderTitle = targets[0].folderTitle;
        } else {
          delete nextPayload.target;
          delete nextPayload.userId;
          delete nextPayload.mediaId;
          delete nextPayload.folderTitle;
        }
        if (targets.length === 0) {
          if (["running", "leased"].includes(String(job.status))) {
            this.jobStore.updatePayload(job.id, nextPayload);
          }
          if (!["running", "leased"].includes(String(job.status))) this.jobStore.complete(job.id);
          continue;
        }
        const downloadUser = this.isUserSyncEligible(this.userStore.getById(String(payload.downloadUserId || "")))
          && String(payload.downloadUserId) !== userId
          ? String(payload.downloadUserId)
          : targets[0].userId;
        this.jobStore.updatePayload(job.id, {
          ...nextPayload,
          userId: targets[0].userId,
          mediaId: targets[0].mediaId,
          folderTitle: targets[0].folderTitle,
          target: targets[0],
          targets,
          targetCount: targets.length,
          downloadUserId: downloadUser,
        });
        continue;
      }

      const payloadTargets = Array.isArray(payload.detachedTargets)
        ? payload.detachedTargets.filter((target: any) => target && typeof target.userId === "string")
        : [];
      const candidates = new Map<string, UploadTarget>();
      for (const target of payloadTargets) {
        if (!matches(target)) candidates.set(`${target.userId}:${Number(target.mediaId)}`, target);
      }
      for (const target of this.snapshotRetirementTargets(bvid)) {
        candidates.set(`${target.userId}:${target.mediaId}`, target);
      }
      const targets = [...candidates.values()];
      if (targets.length === 0) {
        if (["running", "leased"].includes(String(job.status))) {
          this.jobStore.updatePayload(job.id, { ...payload, detachedTargets: [] });
        }
        if (!["running", "leased"].includes(String(job.status))) this.jobStore.complete(job.id);
        continue;
      }
      this.jobStore.updatePayload(job.id, {
        ...payload,
        primaryUserId: targets[0].userId,
        primaryMediaId: targets[0].mediaId,
        primaryFolderTitle: targets[0].folderTitle,
        downloadUserId: this.isUserSyncEligible(this.userStore.getById(String(payload.downloadUserId || "")))
          ? String(payload.downloadUserId)
          : targets[0].userId,
        detachedTargets: targets,
      });
    }

    const transferKinds: PersistentJobKind[] = [
      "upload", "verify_upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup",
    ];
    for (const job of this.jobStore.list(transferKinds, 100_000)) {
      if (String(job.bvid || "") !== bvid
        || String(job.userId || "") !== userId
        || Number(job.mediaId || 0) !== mediaId) continue;
      if (!["running", "leased"].includes(String(job.status))) this.jobStore.complete(job.id);
    }

    this.downloadQueue.poke();
    this.uploadQueue.poke();
    this.verificationQueue.poke();
    this.dispatchPersistentJobs();

    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (true) {
      const runningQueueTask = [this.downloadQueue, this.uploadQueue, this.verificationQueue]
        .some((queue) => queue.getTasks().some((task) => task.status === "running"
          && String((task as any).bvid || "") === bvid
          && (matches(task) || (Array.isArray((task as any).targets)
            && (task as any).targets.some((target: any) => matches(target))))));
      const runningJob = this.jobStore.list(transferKinds, 100_000).some((job) =>
        String(job.bvid || "") === bvid
        && String(job.userId || "") === userId
        && Number(job.mediaId || 0) === mediaId
        && ["leased", "running"].includes(String(job.status)));
      if (!runningQueueTask && !runningJob) return { removedQueuedTasks };
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("该归档来源仍有正在执行的传输任务，请稍后重试"), { statusCode: 409 });
      }
      await delay(50);
    }
  }

  async quiesceUserRemoteDeletion(user: BiliUser, timeoutMs = 30_000) {
    if (!this.archiveDeletionLocked) {
      throw Object.assign(new Error("账号归档清理尚未取得维护锁"), { statusCode: 409 });
    }
    for (const task of this.downloadQueue.getTasks()) {
      if (task.status !== "running") continue;
      const downloadUserId = String((task as any).downloadUserId || task.userId || (task as any).control?.downloadUserId || "");
      if (downloadUserId === user.id && task.persistentJobId) this.retirementAbortedJobIds.add(task.persistentJobId);
    }
    const canceledProcesses = await cancelActiveDownloadsForAccount(String(user.uid || user.cookie.DedeUserID || ""));
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (true) {
      const runningTransfer = [this.downloadQueue, this.uploadQueue, this.verificationQueue]
        .some((queue) => queue.getTasks().some((task) => task.status === "running" && this.archiveTaskReferencesUser(task, user.id)));
      if (!this.activeSyncUsers.has(user.id) && !runningTransfer) break;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("账号仍有正在执行的同步或传输任务，请稍后重新确认清理"), { statusCode: 409 });
      }
      await delay(50);
    }
    return { canceledProcesses };
  }

  finalizeUserRemoteDeletion(userId: string, commit: () => void = () => undefined) {
    if (!this.archiveDeletionLocked) {
      throw Object.assign(new Error("账号归档清理尚未取得维护锁"), { statusCode: 409 });
    }
    const runningTransfer = [this.downloadQueue, this.uploadQueue, this.verificationQueue]
      .some((queue) => queue.getTasks().some((task) => task.status === "running" && this.archiveTaskReferencesUser(task, userId)));
    if (this.activeSyncUsers.has(userId) || runningTransfer) {
      throw Object.assign(new Error("账号仍有正在执行的同步或传输任务"), { statusCode: 409 });
    }

    const database = this.stateManager.getDatabase();
    const postCommitRetirements: Array<{
      bvid: string;
      local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>;
      targets: UploadTarget[];
    }> = [];
    try {
      let removedQueuedTasks = 0;
      const result = database.db.transaction(() => {
        const relationBvids = new Set(database.listRelationsForUser(userId).map((relation) => relation.bvid));
        const downloadJobs = this.jobStore.list(["download", "quality_download"], 100_000);
        let reassignedJobs = 0;
        let canceledJobs = 0;
        let directUploadTargets = 0;

        for (const job of downloadJobs) {
          const payload = { ...(job.payload as any) };
          const payloadTargets = [
            ...(Array.isArray(payload.targets) ? payload.targets : []),
            ...(payload.target ? [payload.target] : []),
          ];
          const affected = relationBvids.has(String(job.bvid || ""))
            || [job.userId, payload.primaryUserId, payload.downloadUserId, payload.pausedForUserId]
              .some((value) => String(value || "") === userId)
            || payloadTargets.some((target) => String(target?.userId || "") === userId);
          if (!affected) continue;

          if (job.kind === "quality_download") {
            const targets = this.qualityTargetsFromPayload(payload).filter((target) => target.userId !== userId);
            if (targets.length === 0) {
              if (this.jobStore.complete(job.id)) canceledJobs += 1;
              continue;
            }
            const alternateUser = targets
              .map((target) => this.userStore.getById(target.userId))
              .find((candidate) => this.isUserSyncEligible(candidate))
              || this.userStore.list().find((candidate) => candidate.id !== userId && this.isUserSyncEligible(candidate));
            if (!alternateUser) {
              if (this.jobStore.complete(job.id)) canceledJobs += 1;
              continue;
            }
            const target = targets[0];
            const nextPayload = {
              ...payload,
              userId: target.userId,
              mediaId: target.mediaId,
              folderTitle: target.folderTitle,
              downloadUserId: alternateUser.id,
              target,
              targets,
              targetCount: targets.length,
            };
            delete nextPayload.pausedForUserId;
            if (this.jobStore.reassignDownloadJob(job.id, alternateUser.id, nextPayload)) reassignedJobs += 1;
            continue;
          }

          const targetMap = new Map<string, UploadTarget>();
          for (const target of Array.isArray(payload.detachedTargets) ? payload.detachedTargets : []) {
            if (String(target?.userId || "") === userId || !target?.userId || !Number.isInteger(Number(target.mediaId))) continue;
            targetMap.set(`${target.userId}:${Number(target.mediaId)}`, {
              userId: String(target.userId),
              mediaId: Number(target.mediaId),
              folderTitle: String(target.folderTitle || ""),
              remotePath: String(target.remotePath || ""),
            });
          }
          for (const target of this.snapshotRetirementTargets(String(job.bvid || ""))) {
            if (target.userId !== userId) targetMap.set(`${target.userId}:${target.mediaId}`, target);
          }
          const targets = [...targetMap.values()].filter((target) => target.remotePath);
          const local = job.bvid ? this.stateManager.getCompletedLocalDownload(job.bvid) : null;
          if (local) {
            this.jobStore.complete(job.id);
            canceledJobs += 1;
            directUploadTargets += this.persistCompletedRetirementUploadJobs(String(job.bvid), local, targets);
            if (targets.length > 0) postCommitRetirements.push({ bvid: String(job.bvid), local, targets });
            continue;
          }
          if (targets.length === 0) {
            if (this.jobStore.complete(job.id)) canceledJobs += 1;
            continue;
          }
          const alternateUser = targets
            .map((target) => this.userStore.getById(target.userId))
            .find((candidate) => this.isUserSyncEligible(candidate))
            || this.userStore.list().find((candidate) => candidate.id !== userId && this.isUserSyncEligible(candidate));
          if (!alternateUser) {
            if (this.jobStore.complete(job.id)) canceledJobs += 1;
            continue;
          }
          const primary = targets[0];
          const nextPayload = {
            ...payload,
            primaryUserId: primary.userId,
            primaryMediaId: primary.mediaId,
            primaryFolderTitle: primary.folderTitle,
            downloadUserId: alternateUser.id,
            detachedTargets: targets,
          };
          delete nextPayload.pausedForUserId;
          if (this.jobStore.reassignDownloadJob(job.id, alternateUser.id, nextPayload)) reassignedJobs += 1;
        }

        const targetKinds: PersistentJobKind[] = [
          "upload", "verify_upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup",
        ];
        for (const job of this.jobStore.list(targetKinds, 100_000)) {
          if (String(job.userId || "") === userId && this.jobStore.complete(job.id)) canceledJobs += 1;
        }
        for (const job of this.jobStore.list(["access_probe"], 100_000)) {
          if (String((job.payload as any)?.preferredUserId || "") !== userId) continue;
          this.jobStore.updatePayload(job.id, { ...job.payload, preferredUserId: "" });
          this.jobStore.wakeByBvid(String(job.bvid || ""), ["access_probe"], this.now());
        }
        const detachedRelations = this.stateManager.detachUserRelations(userId);
        commit();
        return { canceledJobs, reassignedJobs, directUploadTargets, detachedRelations };
      })();
      // The maintenance lock prevents these pending in-memory tasks from
      // starting while the SQLite transaction is being committed. Removing
      // them afterwards keeps a failed transaction fully reversible.
      removedQueuedTasks = [this.downloadQueue, this.uploadQueue, this.verificationQueue]
        .reduce((count, queue) => count + queue.removePendingTasks((task) => this.archiveTaskReferencesUser(task, userId)).length, 0);
      for (const retirement of postCommitRetirements) {
        try {
          this.stateManager.markDownloaded(retirement.bvid, retirement.local.localDir, retirement.targets);
        } catch (error) {
          console.warn(`[Scheduler] Failed to refresh local retirement state for ${retirement.bvid}: ${sanitizeUploadText((error as any)?.message || error)}`);
        }
      }
      this.dispatchPersistentJobs();
      return { ...result, removedQueuedTasks };
    } catch (error) {
      this.stateManager.reload();
      throw error;
    }
  }

  restoreUserAfterLogin(userId: string) {
    const user = this.userStore.getById(userId);
    if (!user?.enabled) return { reattachedRelations: 0, resumedJobs: 0, queuedRelations: 0 };
    const reattachedRelations = this.stateManager.reattachUserRelations(userId);
    const resumedJobs = this.jobStore.resumeDetachedUserJobs(userId, this.now());
    let queuedRelations = 0;
    const relations = this.stateManager.getDatabase().listRelationsForUser(userId);
    for (const relation of relations) {
      if (!relation.activeInFavorite || ["uploaded", "verified", "partial_verified", "uploading", "downloaded"].includes(relation.backupStatus || "")) continue;
      if (this.jobStore.findByDedupeKey(`download:${relation.bvid}`)) continue;
      if (this.enqueueIfNeeded(user, relation.mediaId, relation.folderTitle, relation.bvid, { persisted: true, downloadUserId: user.id })) {
        queuedRelations += 1;
      }
    }
    this.wakeChargingAccessProbes(userId);
    this.dispatchPersistentJobs();
    return { reattachedRelations, resumedJobs, queuedRelations };
  }

  start() {
    this.stopPollingTimers();
    this.acceptingJobs = true;
    const { pollIntervalMinutes } = this.configStore.get();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    const startupJitter = 30_000 + Math.floor(Math.random() * 90_000);
    this.nextAutoRunAt = Date.now() + startupJitter;
    this.timer = setInterval(() => {
      this.nextAutoRunAt = Date.now() + intervalMs;
      void this.tick();
    }, intervalMs);
    this.startupTimer = setTimeout(() => {
      this.nextAutoRunAt = Date.now() + intervalMs;
      void this.tick();
    }, startupJitter);
    this.startRecoveryAutomation();
    this.startLocalCleanupSweep();
    this.scheduleLocalCleanupRetryTimer();
    this.dispatchPersistentJobs();
  }

  setPathMigrationMaintenance(
    locked: boolean,
    summary?: { id: string; status: string; sourceRoot: string; destinationRoot: string }
  ) {
    this.pathMigrationLocked = locked;
    this.pathMigrationMaintenance = locked && summary ? { ...summary } : null;
    if (!locked) {
      this.downloadQueue.poke();
      this.uploadQueue.poke();
      this.verificationQueue.poke();
      this.dispatchPersistentJobs();
    }
  }

  isPathMigrationLocked() {
    return this.pathMigrationLocked;
  }

  private archiveDeletionTargetMatches(userId: unknown, mediaId: unknown, bvid: unknown) {
    const target = this.archiveDeletionMaintenance;
    return Boolean(target?.scope === "source"
      && String(target.userId || "") === String(userId || "")
      && Number(target.mediaId || 0) === Number(mediaId || 0)
      && String(target.bvid || "") === String(bvid || ""));
  }

  private isArchiveDeletionTargetBlocked(task: any) {
    if (this.archiveDeletionLocked) return true;
    const target = this.archiveDeletionMaintenance;
    if (!target || target.scope !== "source") return false;
    const bvid = String(task?.bvid || task?.control?.bvid || "");
    if (!bvid || bvid !== String(target.bvid || "")) return false;
    const candidates = [
      ...(Array.isArray(task?.targets) ? task.targets : []),
      ...(Array.isArray(task?.control?.targets) ? task.control.targets : []),
    ];
    if (candidates.some((candidate) => this.archiveDeletionTargetMatches(candidate?.userId, candidate?.mediaId, bvid))) {
      return true;
    }
    const direct = candidates[0] || task?.target || task?.control?.target || task;
    return this.archiveDeletionTargetMatches(direct?.userId, direct?.mediaId, bvid);
  }

  setArchiveDeletionMaintenance(locked: boolean, summary?: {
    id: string;
    status: string;
    scope: string;
    userId?: string;
    mediaId?: number;
    bvid?: string;
  }) {
    this.archiveDeletionLocked = Boolean(locked && (!summary || summary.scope === "account"));
    this.archiveDeletionMaintenance = locked && summary ? { ...summary } : null;
    if (!locked) {
      this.downloadQueue.poke();
      this.uploadQueue.poke();
      this.verificationQueue.poke();
      this.dispatchPersistentJobs();
    }
  }

  isArchiveDeletionLocked() {
    return this.archiveDeletionLocked;
  }

  private isUserSyncEligible(user: BiliUser | null | undefined): user is BiliUser {
    return Boolean(user?.enabled && !this.stateManager.getDatabase().hasUnfinishedArchiveAccountDeletion(user.id));
  }

  applyConfigUpdate(previous: AppConfig, next: AppConfig) {
    this.downloadApiHealth.configure(next.bbdownApiMode || "web");
    if (next.bbdownApiMode === "app") {
      if (typeof (this.stateManager as any).clearDownloadApiCooldown === "function") {
        this.stateManager.clearDownloadApiCooldown();
      }
    }
    for (const task of this.downloadQueue.getTasks()) {
      if (task.status === "running") continue;
      if (task instanceof DownloadTask) {
        task.config = task.encodingRetry
          ? applyBBDownEncodingPreference(next, task.encodingRetry.priority, task.encodingRetry.strict)
          : { ...next };
      } else if (task instanceof QualityUpgradeDownloadTask) {
        task.control.config = applyQualityArtifactProfile(next, task.control.qualityProfile);
      }
      task.apiModeOverride = undefined;
      task.apiProbe = false;
    }
    if (previous.bbdownApiMode !== next.bbdownApiMode) this.downloadQueue.poke();
    this.updateInterval();
  }

  updateInterval() {
    const config = this.configStore.get();
    this.downloadQueue.setConcurrency(config.concurrentDownloads || 1);
    this.uploadQueue.setConcurrency(config.concurrentUploads || 2);
    this.verificationQueue.setConcurrency(Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)));
    this.downloadQueue.setMaxSize(this.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit));
    this.uploadQueue.setMaxSize(this.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit));
    this.verificationQueue.setMaxSize(this.queueHighWater(config.remoteVerifyConcurrency, config.queuePrefetchLimit));
    this.refreshLocalCacheAndWake(true);
    this.dispatchPersistentJobs();
    if (process.env.NODE_ENV !== "test") {
      this.start();
    }
  }

  stop() {
    this.acceptingJobs = false;
    this.stopPollingTimers();
    if (this.recoveryAutomationTimer) {
      clearInterval(this.recoveryAutomationTimer);
      this.recoveryAutomationTimer = null;
    }
    if (this.recoveryAutomationStartupTimer) {
      clearTimeout(this.recoveryAutomationStartupTimer);
      this.recoveryAutomationStartupTimer = null;
    }
    if (this.jobDispatchTimer) {
      clearTimeout(this.jobDispatchTimer);
      this.jobDispatchTimer = null;
    }
    if (this.downloadStartTimer) {
      clearTimeout(this.downloadStartTimer);
      this.downloadStartTimer = null;
    }
    if (this.localCleanupRetryTimer) {
      clearTimeout(this.localCleanupRetryTimer);
      this.localCleanupRetryTimer = null;
    }
  }

  private stopPollingTimers() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  beginShutdown() {
    this.acceptingJobs = false;
    this.localCacheRefreshQueued = false;
    this.stop();
    this.ensureLeaseHeartbeat();
  }

  async shutdown(timeoutMs = 20_000) {
    this.beginShutdown();
    const startedAt = Date.now();
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
    await this.downloadQueue.waitForIdle(remaining());
    await this.uploadQueue.waitForIdle(remaining());
    await this.verificationQueue.waitForIdle(remaining());
    if (this.accessProbePromise && remaining() > 0) {
      await Promise.race([
        this.accessProbePromise,
        delay(remaining()),
      ]);
    }
    if (this.legacyTempRecoveryPromise && remaining() > 0) {
      await Promise.race([
        this.legacyTempRecoveryPromise.catch(() => undefined),
        delay(remaining()),
      ]);
    }
    if (this.recoveryAutomationPromise && remaining() > 0) {
      await Promise.race([
        this.recoveryAutomationPromise.catch(() => undefined),
        delay(remaining()),
      ]);
    }
    if (this.recoveryJobPromises.size > 0 && remaining() > 0) {
      await Promise.race([
        Promise.allSettled([...this.recoveryJobPromises.values()]),
        delay(remaining()),
      ]);
    }
    while (this.localCacheRefresh && remaining() > 0) {
      const activeRefresh = this.localCacheRefresh;
      await Promise.race([activeRefresh.catch(() => undefined), delay(remaining())]);
      if (this.localCacheRefresh === activeRefresh) break;
    }
    if (this.localCleanupSweepPromise && remaining() > 0) {
      await Promise.race([
        this.localCleanupSweepPromise.catch(() => undefined),
        delay(remaining()),
      ]);
    }
    while (this.localCleanupInFlight.size > 0 && remaining() > 0) {
      const activeCleanup = Promise.allSettled([...this.localCleanupInFlight.values()]);
      await Promise.race([activeCleanup, delay(remaining())]);
      if (this.localCleanupInFlight.size > 0) break;
    }
    this.jobStore.releaseOwner(this.leaseOwner);
    this.stateManager.close();
  }

  runNow() {
    console.log("[Scheduler] Manual sync triggered");
    return this.triggerOrQueueTick({ trigger: "manual", skipFavoriteScan: false });
  }

  runReconcileNow() {
    console.log("[Scheduler] Manual reconcile triggered");
    return this.triggerOrQueueTick({
      trigger: "reconcile",
      forceFullRemoteVerify: true,
      forceFullFavoriteScan: true,
      skipFavoriteScan: false,
    });
  }

  runRemoteReconcileNow() {
    console.log("[Scheduler] Manual remote-only reconcile triggered");
    return this.triggerOrQueueTick({
      trigger: "remote_reconcile",
      forceFullRemoteVerify: true,
      skipFavoriteScan: true,
    });
  }

  hasRunningTransferTasks() {
    return this.downloadQueue.isBusy()
      || this.uploadQueue.isBusy()
      || this.verificationQueue.isBusy()
      || Boolean(this.recoveryAutomationPromise)
      || this.recoveryJobPromises.size > 0;
  }

  private startRecoveryAutomation() {
    if (this.recoveryAutomationTimer) clearInterval(this.recoveryAutomationTimer);
    if (this.recoveryAutomationStartupTimer) clearTimeout(this.recoveryAutomationStartupTimer);
    this.recoveryAutomationStartupTimer = setTimeout(() => {
      this.recoveryAutomationStartupTimer = null;
      void this.runRecoveryAutomationNow();
    }, 30_000);
    this.recoveryAutomationStartupTimer.unref?.();
    this.recoveryAutomationTimer = setInterval(() => {
      void this.runRecoveryAutomationNow();
    }, this.recoveryAutomationIntervalMs);
    this.recoveryAutomationTimer.unref?.();
  }

  hasPersistentTransferWork() {
    const transferKinds: PersistentJobKind[] = [
      "download",
      "upload",
      "history_upload",
      "verify_upload",
      "quality_download",
      "quality_upload",
      "quality_replace",
      "quality_cleanup",
    ];
    const counts = this.jobStore.counts();
    return transferKinds.some((kind) => {
      const statuses = counts[kind] || {};
      return PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES.some((status) => Number(statuses[status] || 0) > 0);
    });
  }

  hasActiveOrQueuedSchedulerWork() {
    return this.running || Boolean(this.pendingTickOptions) || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked || Boolean(this.legacyTempRecoveryPromise);
  }

  refreshLocalCacheState() {
    const limitBytes = this.getLocalCacheLimitBytes();
    const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
    const previousUsedBytes = this.localCacheSnapshot?.usedBytes ?? 0;
    if (limitBytes > 0) {
      this.localCacheSnapshot = {
        limitBytes,
        usedBytes: previousUsedBytes,
        reserveBytes,
        paused: true,
        checkedAt: this.localCacheSnapshot?.checkedAt ?? 0,
      };
    }
    this.refreshLocalCacheAndWake(true);
  }

  withCleanupLock<T>(fn: () => Promise<T>) {
    if (this.cleanupLocked || this.running || this.pendingTickOptions || this.hasRunningTransferTasks()) {
      throw new Error("当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再清理重要数据。");
    }
    this.cleanupLocked = true;
    return fn().finally(() => {
      this.cleanupLocked = false;
    });
  }

  enqueueQualityUpgrade(task: QualityUpgradeTask) {
    task.status = "pending";
    task.error = undefined;
    task.qualityStage = "download";
    task.qualityStageLabel = this.qualityDownloadStageLabel(task, "等待下载新版");
    task.onApiReady = (control, mode) => this.handleDownloadApiReady(control, mode);
    const pendingTargets = task.targets.filter((target) => !this.jobStore.hasQualityTarget(target.userId, target.mediaId, task.bvid));
    if (pendingTargets.length === 0) return false;
    task.setTargets(pendingTargets);
    task.qualityStageLabel = this.qualityDownloadStageLabel(task, "等待下载新版");
    const target = task.target;
    const dedupeKey = `quality-download:${task.bvid}:${task.artifactKey}`;
    const merged = this.jobStore.mergeQualityDownload({
      kind: "quality_download",
      dedupeKey,
      bvid: task.bvid,
      userId: task.downloadUserId || task.userId || target.userId,
      mediaId: target.mediaId,
      priority: 35,
      maxAttempts: this.configStore.get().maxRetries + 1,
      payload: this.serializeQualityUpgrade(task),
    });
    if (!merged.created && merged.targetAdded) {
      const mergedTargets = this.qualityTargetsFromPayload(merged.job.payload as any);
      for (const phase of this.downloadQueue.getTasks()) {
        if (!(phase instanceof QualityUpgradeDownloadTask) || phase.control.artifactKey !== task.artifactKey) continue;
        phase.control.setTargets(mergedTargets);
        phase.control.qualityStageLabel = this.qualityDownloadStageLabel(
          phase.control,
          phase.control.status === "running" ? "下载新版" : "等待下载新版"
        );
        phase.folderTitle = mergedTargets.length > 1 ? `${mergedTargets.length}个目标` : mergedTargets[0]?.folderTitle;
      }
    }
    this.dispatchPersistentJobs();
    return merged.created || merged.targetAdded;
  }

  wakeChargingAccessProbes(userId?: string) {
    const now = this.now();
    const candidateUser = userId ? this.userStore.getById(userId) : null;
    const user = candidateUser && this.isUserSyncEligible(candidateUser) ? candidateUser : null;
    const uid = user ? Number(user.uid || user.cookie.DedeUserID || 0) : 0;
    let changed = 0;
    for (const job of this.jobStore.list(["access_probe"], 100_000)) {
      if (!["pending", "retry_wait"].includes(job.status)) continue;
      const bvid = String(job.bvid || "");
      if (!bvid) continue;
      const intents = normalizeAccessProbeIntents((job.payload || {}) as Record<string, any>);
      let shouldWake = intents.includes("charging");
      if (!shouldWake && user && userId && intents.includes("availability")) {
        const related = this.stateManager.listRelationsForBvid(bvid).some((relation) =>
          relation.activeInFavorite && relation.sourceKind !== "manual" && relation.userId === userId);
        const owner = uid > 0 && Number(this.stateManager.getVideoMeta(bvid)?.upperMid || 0) === uid;
        shouldWake = related || owner;
      }
      if (shouldWake) changed += this.jobStore.wakeByBvid(bvid, ["access_probe"], now);
    }

    let dormantAwakened = 0;
    if (user && userId) {
      for (const video of this.stateManager.listDormantAvailabilityVideos()) {
        const related = this.stateManager.listRelationsForBvid(video.bvid).some((relation) =>
          relation.activeInFavorite && relation.sourceKind !== "manual" && relation.userId === userId);
        if (!related && !(uid > 0 && Number(video.upperMid || 0) === uid)) continue;
        const existing = this.jobStore.findByDedupeKey(`access_probe:${video.bvid}`);
        this.enqueueAvailabilityProbe(video.bvid, {
          preferredUserId: userId,
          notBefore: now,
          availabilityReason: video.sourceAvailability?.reason || "temporary_error",
          manual: true,
        });
        if (!existing) dormantAwakened += 1;
      }
    }
    if (changed > 0 || dormantAwakened > 0) this.dispatchPersistentJobs();
    return changed + dormantAwakened;
  }

  captureLegacyRecoveryMarkers() {
    const database = this.stateManager.getDatabase();
    return {
      quality: database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER),
      temp: database.getMeta(LEGACY_TEMP_CACHE_MARKER),
    };
  }

  async getLocalCacheCapacity() {
    const snapshot = await this.refreshLocalCacheSnapshot();
    return {
      limitBytes: snapshot.limitBytes,
      usedBytes: snapshot.usedBytes,
      reserveBytes: snapshot.reserveBytes,
    };
  }

  reloadStateDatabase() {
    this.jobStore.rebind(this.stateManager.getDatabase());
    this.transferSessions.rebind(this.stateManager.getDatabase());
    this.reconcileTransferSessionRecoveryJobs(true);
    this.ensurePersistedAvailabilityProbes();
    this.startLocalCleanupSweep();
    this.dispatchPersistentJobs();
  }

  recheckLegacyRecoveryAfterImport(
    restored: string[],
    previousMarkers: ReturnType<SyncScheduler["captureLegacyRecoveryMarkers"]>
  ) {
    const database = this.stateManager.getDatabase();
    const restoredSet = new Set(restored);
    if (restoredSet.has("state")) {
      database.deleteMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
      if (!restoredSet.has("temp")) {
        if (previousMarkers.temp === "complete") database.setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
        else database.deleteMeta(LEGACY_TEMP_CACHE_MARKER);
      }
    }
    if (restoredSet.has("temp")) {
      database.deleteMeta(LEGACY_TEMP_CACHE_MARKER);
    }
    if (restoredSet.has("state")) this.resumePersistedWorkOnStartup();
    else {
      if (restoredSet.has("temp")) this.startLegacyTempCacheRecovery();
      this.dispatchPersistentJobs();
    }
  }

  hasQualityUpgrade(userId: string, mediaId: number, bvid: string) {
    return this.jobStore.hasQualityTarget(userId, mediaId, bvid);
  }

  getQualityUpgradeTargetKeys() {
    return this.jobStore.listQualityTargetKeys();
  }

  getQualityUpgradeState() {
    const running = this.jobStore.list(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"], 100).map((job) => {
      const payload = job.payload as any;
      const targets = this.qualityTargetsFromPayload(payload);
      const targetCount = job.kind === "quality_download" ? Math.max(1, targets.length) : 1;
      return {
        key: job.kind === "quality_download"
          ? `artifact:${payload.artifactKey || job.id}`
          : `${job.userId || payload.userId}:${job.mediaId || payload.mediaId}:${job.bvid || payload.bvid}`,
        id: job.id,
        bvid: job.bvid || payload.bvid,
        artifactKey: payload.artifactKey,
        targetCount,
        title: payload.videoTitle || job.bvid,
        folderTitle: job.kind === "quality_download" && targetCount > 1
          ? `${targetCount}个目标`
          : (payload.folderTitle || payload.target?.folderTitle || ""),
        userId: job.userId || payload.userId || "",
        mediaId: job.mediaId || payload.mediaId || 0,
        status: job.status === "failed" ? "error" : (job.status === "retry_wait" ? "retry_wait" : (["leased", "running"].includes(job.status) ? "running" : "pending")),
        error: job.lastError ? sanitizeDiagnosticText(job.lastError, 500) : undefined,
        stageLabel: job.kind === "quality_cleanup" && job.status === "retry_wait"
          ? "旧文件清理重试中"
          : (job.kind === "quality_download"
              ? `${String(payload.qualityStageLabel || "下载新版").split(" · ")[0]}${targetCount > 1 ? ` · ${targetCount}个目标` : ""}`
              : String(payload.qualityStageLabel || "")),
        queuedAt: job.createdAt,
        startedAt: ["leased", "running"].includes(job.status) ? job.updatedAt : undefined,
      };
    });
    return { running, completed: [] as any[] };
  }

  private syncQualityUpgradeControl(
    phaseTask: QualityUpgradeDownloadTask | QualityUploadPhaseTask,
    status: QualityUpgradeTask["status"]
  ) {
    const control = phaseTask.control;
    control.status = status;
    control.retries = phaseTask.retries;
    control.queuedAt = phaseTask.queuedAt;
    control.startedAt = phaseTask.startedAt;
    control.retryAt = phaseTask.retryAt;
    control.sequence = phaseTask.sequence;
  }

  private triggerLabel(trigger?: SyncTrigger) {
    switch (trigger) {
      case "manual":
        return "立即同步";
      case "reconcile":
        return "全量扫描并对账";
      case "remote_reconcile":
        return "状态对账（仅远端存储）";
      case "auto":
      default:
        return "自动同步";
    }
  }

  private getLocalCacheLimitBytes() {
    const limitGB = Number(this.configStore.get().localCacheLimitGB || 0);
    return limitGB > 0 ? limitGB * 1024 * 1024 * 1024 : 0;
  }

  private async refreshLocalCacheSnapshot(force = false) {
    if (this.localCacheRefresh) {
      if (force) this.localCacheRefreshQueued = true;
      return this.localCacheRefresh;
    }
    const now = Date.now();
    const limitBytes = this.getLocalCacheLimitBytes();
    if (!force && this.localCacheSnapshot && now - this.localCacheSnapshot.checkedAt < this.localCacheSnapshotTtlMs && this.localCacheSnapshot.limitBytes === limitBytes) {
      return this.localCacheSnapshot;
    }
    this.localCacheRefresh = (async () => {
      const inspection = await this.cacheInspector(tempDir, 4);
      const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
      const snapshot: LocalCacheSnapshot = {
        limitBytes,
        usedBytes: inspection.usedBytes,
        reserveBytes,
        paused: limitBytes > 0 && inspection.usedBytes >= Math.max(0, limitBytes - reserveBytes),
        checkedAt: Date.now(),
      };
      this.localCacheSnapshot = snapshot;
      this.downloadRecoverySnapshot = inspection.recovery;
      return snapshot;
    })().then((snapshot) => {
      this.localCacheRefresh = null;
      if (this.localCacheRefreshQueued) {
        this.localCacheRefreshQueued = false;
        if (this.acceptingJobs) this.refreshLocalCacheAndWake(true);
      }
      return snapshot;
    }, (error) => {
      this.localCacheRefresh = null;
      if (this.localCacheRefreshQueued) {
        this.localCacheRefreshQueued = false;
        if (this.acceptingJobs) this.refreshLocalCacheAndWake(true);
      }
      throw error;
    });
    return this.localCacheRefresh;
  }

  private refreshLocalCacheAndWake(force = false) {
    void this.refreshLocalCacheSnapshot(force).then(() => {
      if (!this.acceptingJobs) return;
      this.downloadQueue.poke();
      this.dispatchPersistentJobs();
    }).catch((error: any) => {
      console.warn(`[Scheduler] Failed to refresh local cache state: ${safeErrorSummary(error)}`);
    });
  }

  private getLocalCacheSnapshot() {
    const limitBytes = this.getLocalCacheLimitBytes();
    if (!this.localCacheSnapshot || this.localCacheSnapshot.limitBytes !== limitBytes) {
      this.refreshLocalCacheAndWake(true);
      const usedBytes = this.localCacheSnapshot?.usedBytes ?? 0;
      const reserveBytes = this.getLocalCacheReserveBytes(limitBytes);
      return {
        limitBytes,
        usedBytes,
        reserveBytes,
        paused: limitBytes > 0 && (!this.localCacheSnapshot || usedBytes >= Math.max(0, limitBytes - reserveBytes)),
        checkedAt: this.localCacheSnapshot?.checkedAt ?? 0,
      };
    }
    if (Date.now() - this.localCacheSnapshot.checkedAt >= this.localCacheSnapshotTtlMs) {
      this.refreshLocalCacheAndWake();
    }
    return this.localCacheSnapshot;
  }

  private canStartDownloadTask(task?: DownloadTask | QualityUpgradeDownloadTask) {
    if (this.legacyTempRecoveryPending || this.pathMigrationLocked || this.archiveDeletionLocked) return false;
    if (task && this.isArchiveDeletionTargetBlocked(task)) return false;
    if (task instanceof QualityUpgradeDownloadTask && this.qualityArtifactCleanupLocks.has(task.control.artifactKey)) {
      return false;
    }
    const snapshot = this.getLocalCacheSnapshot();
    const baseAllowed = !snapshot.paused
      && !this.uploadCircuit.isDownloadPaused()
      && this.uploadQueue.getSize() === 0
      && this.jobStore.countDue(["upload", "history_upload"], 20) === 0
      && this.uploadQueue.canAccept();
    if (!baseAllowed) return false;
    if (!task) return this.downloadApiHealth.getSnapshot().state === "healthy";
    if (Date.now() < this.nextDownloadStartAt) {
      this.scheduleDownloadStartPoke();
      return false;
    }
    const decision = this.downloadApiHealth.claimStart(this.downloadTaskIdentity(task));
    if (!decision.allowed) {
      const retryAt = this.downloadApiHealth.getRetryAt();
      return false;
    }
    task.apiModeOverride = decision.apiModeOverride;
    task.apiProbe = decision.probe;
    if (task instanceof QualityUpgradeDownloadTask) {
      task.control.apiModeOverride = decision.apiModeOverride;
      task.control.apiProbe = decision.probe;
    }
    return true;
  }

  private canCreateDownloadTask() {
    const snapshot = this.getLocalCacheSnapshot();
    return !this.pathMigrationLocked
      && !this.archiveDeletionLocked
      && !snapshot.paused
      && !this.uploadCircuit.isDownloadPaused()
      && this.uploadQueue.getSize() === 0
      && this.jobStore.countDue(["upload", "history_upload"], 20) === 0
      && this.uploadQueue.canAccept()
      && this.downloadQueue.canAccept();
  }

  private buildSchedulerSnapshot() {
    const queuedActions = this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [];
    if (this.schedulerProgress) {
      return {
        ...this.schedulerProgress,
        queuedActions,
        lastError: sanitizeDiagnosticText(this.lastSchedulerError, 500),
        nextRunAt: this.nextAutoRunAt,
      };
    }

    const cooldowns = this.stateManager.getAllCooldowns();
    const cooldown = Object.values(cooldowns)[0];
    if (cooldown) {
      const user = this.userStore.getById(cooldown.userId);
      return {
        status: "cooldown" as const,
        mode: "cooldown",
        title: "账号冷却中",
        detail: sanitizeDiagnosticText(cooldown.reason, 500),
        userName: user?.name || cooldown.userId,
        queuedActions,
        lastError: sanitizeDiagnosticText(cooldown.reason, 500),
        updatedAt: Date.now(),
        nextRunAt: cooldown.until,
      };
    }

    return {
      status: queuedActions.length ? "queued" as const : "idle" as const,
      mode: queuedActions.length ? "queued" : "idle",
      title: queuedActions.length ? "调度任务已排队" : "当前调度空闲",
      detail: queuedActions.length ? "已有同步/扫描/对账任务在等待当前任务结束后执行。" : "当前没有正在运行的同步、扫描或对账任务。",
      queuedActions,
      lastError: sanitizeDiagnosticText(this.lastSchedulerError, 500),
      updatedAt: Date.now(),
      nextRunAt: this.nextAutoRunAt,
    };
  }

  private updateSchedulerProgress(patch: Partial<SchedulerSnapshot>) {
    const previous = this.schedulerProgress;
    const snapshot: SchedulerSnapshot = {
      status: "running",
      mode: patch.mode ?? previous?.mode ?? this.cycleContext?.trigger ?? "auto",
      title: patch.title ?? previous?.title ?? this.triggerLabel(this.cycleContext?.trigger || "auto"),
      detail: patch.detail ?? previous?.detail ?? "正在运行调度任务。",
      startedAt: previous?.startedAt || Date.now(),
      updatedAt: Date.now(),
      queuedActions: this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [],
    };
    if ("userName" in patch) snapshot.userName = patch.userName;
    if ("folderTitle" in patch) snapshot.folderTitle = patch.folderTitle;
    if ("mediaId" in patch) snapshot.mediaId = patch.mediaId;
    if ("page" in patch) snapshot.page = patch.page;
    if ("pageSize" in patch) snapshot.pageSize = patch.pageSize;
    if ("indexed" in patch) snapshot.indexed = patch.indexed;
    if ("biliTotal" in patch) snapshot.biliTotal = patch.biliTotal;
    if ("checked" in patch) snapshot.checked = patch.checked;
    if ("total" in patch) snapshot.total = patch.total;
    if ("lastError" in patch) snapshot.lastError = patch.lastError;
    if ("nextRunAt" in patch) snapshot.nextRunAt = patch.nextRunAt;
    this.schedulerProgress = snapshot;
  }

  private mapQueueTaskForBoard(task: any, stage: QueueBoardItem["stage"]): QueueBoardItem {
    const job = task.persistentJob as any;
    const payload = job?.payload || {};
    const isVerification = job?.kind === "verify_upload" || task instanceof UploadVerificationTask;
    const firstString = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value;
      }
      return "";
    };
    const item = mapQueueBoardTask(task, stage, {
      title: firstString(task.videoTitle, payload.videoTitle, task.bvid),
      upperName: firstString(task.upperName, payload.upperName),
      cover: firstString(task.cover, payload.cover),
      coverLocalPath: firstString(task.coverLocalPath, payload.coverLocalPath) || undefined,
      folderTitle: firstString(task.folderTitle, payload.folderTitle),
      detail: firstString(task.detail) || (isVerification
        ? (task.status === "running" ? "正在确认远端文件" : "已上传，等待远端确认")
        : ""),
      persistentJobId: task.persistentJobId ? String(task.persistentJobId) : undefined,
      lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
      verifiedPages: Number.isInteger(Number(payload.verifiedPages)) ? Number(payload.verifiedPages) : undefined,
      totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
    });
    if (isVerification) {
      item.phase = task.status === "running" ? "remote_verifying" : task.status === "retry_wait" ? "retry_wait" : "queued";
      item.nextAction = task.status === "retry_wait" ? "verify" : undefined;
      item.nextActionAt = task.status === "retry_wait" && typeof task.retryAt === "number" ? task.retryAt : undefined;
    }
    return item;
  }

  private mapPersistentJobForBoard(job: any): QueueBoardItem | null {
    if (isRecoveryStopped(job.payload)) return null;
    const payload = (job.payload || {}) as any;
    const kind = String(job.kind || "");
    const isDownload = ["download", "quality_download"].includes(kind);
    const isUpload = ["upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup", "verify_upload"].includes(kind);
    if (!isDownload && !isUpload) return null;
    if (job.status === "failed" && !payload.awaitingManualRecovery) return null;

    const assessment = payload.awaitingManualRecovery ? this.recoveryAssessment(payload) : null;
    const retryBusy = Boolean(payload.encodingRetry && ["running", "uploading", "verifying"].includes(String(payload.encodingRetry.state || "")));
    const retryParentId = payload.encodingRetry?.parentJobId ? String(payload.encodingRetry.parentJobId) : "";
    if (retryBusy && !payload.awaitingManualRecovery && retryParentId === String(job.id)) return null;
    const disposition = assessment ? recoveryIssueDisposition(assessment.kind) : undefined;
    const isVerification = kind === "verify_upload";
    const stage: QueueBoardItem["stage"] = isDownload
      ? (job.status === "running" ? "download_running" : "download_pending")
      : "upload_pending";
    let phase: QueueBoardPhase = job.status === "running"
      ? (isVerification ? "remote_verifying" : "running")
      : job.status === "leased"
        ? "leased"
        : job.status === "retry_wait"
          ? "retry_wait"
          : "queued";
    if (payload.awaitingManualRecovery) {
      phase = disposition === "background" ? "background_wait" : "manual_action";
    }

    const recoveryKind = String(assessment?.kind || "manual_review");
    const retry = parseEncodingRetryContext(payload.encodingRetry);
    const lifecycleDetail = payload.lifecycleState === "conflict_candidate"
      ? `正在生成隔离候选${Number.isInteger(Number(payload.verifiedPages)) && Number.isInteger(Number(payload.totalPages)) ? ` · 已确认 ${Number(payload.verifiedPages)}/${Number(payload.totalPages)} 个分P` : ""}`
      : payload.lifecycleState === "remote_visibility_wait"
        ? `等待远端确认${Number.isInteger(Number(payload.verifiedPages)) && Number.isInteger(Number(payload.totalPages)) ? ` · 已确认 ${Number(payload.verifiedPages)}/${Number(payload.totalPages)} 个分P` : ""}`
        : payload.lifecycleState === "partial_upload"
          ? `部分分P已完成 · ${Number(payload.verifiedPages || 0)}/${Number(payload.totalPages || 0)}`
          : undefined;
    const detail = payload.awaitingManualRecovery
      ? this.uploadRecoverySummary(
        recoveryKind,
        assessment,
        retry,
        assessment?.summary || "等待安全复核：系统会先自动检查远端状态",
      )
      : lifecycleDetail || (isVerification
        ? (job.status === "running" || job.status === "leased" ? "正在确认远端文件" : "已上传，等待远端确认")
        : String(payload.qualityStageLabel || payload.detail || job.lastError || "等待处理"));
    const nextAction: QueueBoardAction | undefined = payload.awaitingManualRecovery
      ? "recheck"
      : job.status === "retry_wait"
        ? (isVerification ? "verify" : "retry")
        : undefined;
    const nextActionAt = payload.awaitingManualRecovery
      ? assessment?.nextCheckAt
      : job.status === "retry_wait" && Number(job.notBefore) > 0
        ? Number(job.notBefore)
        : undefined;
    const recoveryActions = payload.awaitingManualRecovery
      && !payload.historyOnly
      && !retryBusy
      && ["remote_size_limit", "remote_write_rejected", "encoding_retry_failed"].includes(String(assessment?.kind || ""))
      ? [{ id: "redownload_with_encoding" as const, label: "重新选择画质与编码" }]
      : undefined;

    return mapQueueBoardTask({
      id: job.id,
      bvid: job.bvid,
      userId: job.userId,
      mediaId: job.mediaId,
      videoTitle: payload.videoTitle || job.bvid,
      upperName: payload.upperName || "",
      cover: payload.cover || "",
      coverLocalPath: payload.coverLocalPath,
      folderTitle: payload.folderTitle || payload.primaryFolderTitle || "",
      remotePath: payload.remotePath || payload.remoteFile || "",
      detail,
      status: job.status,
      retries: job.attempts,
      maxRetries: job.maxAttempts,
      retryAt: job.status === "retry_wait" ? job.notBefore : undefined,
      queuedAt: job.createdAt,
      persistentJobId: job.id,
    }, stage, {
      status: String(job.status || "pending"),
      phase,
      nextAction,
      nextActionAt,
      actionRequired: Boolean(payload.awaitingManualRecovery && disposition !== "background"),
      lastError: job.lastError ? String(job.lastError) : undefined,
      awaitingManualRecovery: Boolean(payload.awaitingManualRecovery),
      recoveryJobId: payload.awaitingManualRecovery ? String(job.id) : undefined,
      recoveryDisposition: disposition,
      recoveryIssueId: payload.awaitingManualRecovery ? `upload.${job.id}` : undefined,
      recoveryKind: payload.awaitingManualRecovery ? recoveryKind : undefined,
      recoveryActions,
      lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
      verifiedPages: Number.isInteger(Number(payload.verifiedPages)) ? Number(payload.verifiedPages) : undefined,
      totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
    });
  }

  private enrichQueueBoardMetadata(items: QueueBoardItem[]) {
    const metadata = this.stateManager.getVideoMetaBatch(items.map((item) => item.bvid));
    for (const item of items) {
      const fallback = metadata.get(item.bvid);
      if (!fallback) continue;
      if (!item.title || item.title === item.bvid) item.title = fallback.title || item.title;
      if (!item.upperName) item.upperName = fallback.upperName || "";
      if (!item.cover) item.cover = fallback.cover || "";
      if (!item.coverLocalPath) item.coverLocalPath = fallback.coverLocalPath || undefined;
    }
  }

  getQueueSnapshot() {
    this.reconcileTransferSessionRecoveryJobs();
    const downloadPending: QueueBoardItem[] = [];
    const downloadRunning: QueueBoardItem[] = [];
    const uploadPending: QueueBoardItem[] = [];
    const uploadRunning: QueueBoardItem[] = [];
    const seenPersistentJobIds = new Set<string>();

    const addTask = (task: any, stage: QueueBoardItem["stage"]) => {
      const item = this.mapQueueTaskForBoard(task, stage);
      if (item.persistentJobId) seenPersistentJobIds.add(item.persistentJobId);
      const target = stage === "download_pending"
        ? downloadPending
        : stage === "download_running"
          ? downloadRunning
          : stage === "upload_running"
            ? uploadRunning
            : uploadPending;
      target.push(item);
    };

    for (const task of this.downloadQueue.getTasks()) {
      if (task.status === "running") {
        addTask(task, "download_running");
      } else if (task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "download_pending");
      }
    }
    for (const task of this.uploadQueue.getTasks()) {
      if (task.status === "running") {
        addTask(task, "upload_running");
      } else if (task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "upload_pending");
      }
    }
    for (const task of this.verificationQueue.getTasks()) {
      if (task.status === "running" || task.status === "pending" || task.status === "retry_wait") {
        addTask(task, "upload_pending");
      }
    }

    // Download jobs remain represented by the bounded in-memory prefetch queue.
    // Upload/verification jobs also need a persisted view so manual waits and
    // confirmation work remain visible after a restart or before prefetch.
    const boardKinds: PersistentJobKind[] = [
      "upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup", "verify_upload",
    ];
    const boardLimit = Math.max(1, Number(this.configStore.get().queuePrefetchLimit || 25));
    const persistentJobs = this.jobStore.listForBoard(boardKinds, boardLimit);
    for (const job of persistentJobs) {
      if (seenPersistentJobIds.has(String(job.id))) continue;
      const item = this.mapPersistentJobForBoard(job);
      if (!item) continue;
      seenPersistentJobIds.add(String(job.id));
      if (item.stage === "download_running" || item.stage === "download_pending") {
        (item.stage === "download_running" ? downloadRunning : downloadPending).push(item);
      } else {
        uploadPending.push(item);
      }
    }

    this.enrichQueueBoardMetadata([...downloadPending, ...downloadRunning, ...uploadPending, ...uploadRunning]);

    const bySequence = (a: QueueBoardItem, b: QueueBoardItem) => {
      if (a.sequence !== undefined || b.sequence !== undefined) return Number(a.sequence || 0) - Number(b.sequence || 0);
      return Number(a.nextActionAt || a.retryAt || a.queuedAt || 0) - Number(b.nextActionAt || b.retryAt || b.queuedAt || 0);
    };
    const byStartedAt = (a: QueueBoardItem, b: QueueBoardItem) => Number(a.startedAt || 0) - Number(b.startedAt || 0);
    downloadPending.sort(bySequence);
    uploadPending.sort(bySequence);
    downloadRunning.sort(byStartedAt);
    uploadRunning.sort(byStartedAt);

    const persistentCounts = this.jobStore.counts();
    const sumKinds = (kinds: PersistentJobKind[]) => kinds.reduce((total, kind) =>
      total + Object.values(persistentCounts[kind] || {}).reduce((sum, count) => sum + Number(count || 0), 0), 0);
    const leasedJobs = Object.values(persistentCounts).reduce((total, statuses) =>
      total + Number(statuses.leased || 0) + Number(statuses.running || 0), 0);
    const retryJobs = Object.entries(persistentCounts).reduce((total, [kind, statuses]) =>
      kind === "access_probe" ? total : total + Number(statuses.retry_wait || 0), 0);
    const chargingSchedule = this.jobStore.accessProbeScheduleSummary("charging");
    const availabilitySchedule = this.jobStore.accessProbeScheduleSummary("availability");
    const chargingRestrictions = this.stateManager.getChargingRestrictionSummary();
    const lastChargingCheckAt = Date.parse(chargingRestrictions.lastCheckedAt || "");
    const recoveryIssues = this.getRecoveryIssueSnapshot();

    return {
      generatedAt: Date.now(),
      downloadPending,
      downloadRunning,
      uploadPending,
      uploadRunning,
      scheduler: this.buildSchedulerSnapshot(),
      localCache: this.getLocalCacheSnapshot(),
      uploadHealth: this.uploadCircuit.getSnapshot(),
      downloadApiHealth: this.downloadApiHealth.getSnapshot(),
      downloadRecovery: this.downloadRecoverySnapshot,
      chargingAccess: {
        pending: chargingSchedule.count,
        nextCheckAt: chargingSchedule.nextAt,
        lastCheckedAt: Number.isFinite(lastChargingCheckAt) ? lastChargingCheckAt : undefined,
      },
      issues: recoveryIssues.issues,
      backgroundRecoveries: recoveryIssues.backgroundRecoveries,
      actionRequiredIssues: recoveryIssues.actionRequiredIssues,
      intentionalConfirmations: recoveryIssues.intentionalConfirmations,
      issueSummary: recoveryIssues.issueSummary,
      recovery: {
        pendingUploads: sumKinds(["upload", "history_upload"]),
        pendingDownloads: sumKinds(["download", "quality_download"]),
        pendingVerifications: sumKinds(["verify_upload"]),
        chargingRestricted: chargingSchedule.count,
        availabilityChecks: availabilitySchedule.count,
        leasedJobs,
        retryJobs,
        prefetchLimit: this.configStore.get().queuePrefetchLimit || 25,
      },
      maintenance: this.archiveDeletionMaintenance
        ? { kind: "archive_delete", ...this.archiveDeletionMaintenance }
        : this.pathMigrationMaintenance
          ? { kind: "path_migration", ...this.pathMigrationMaintenance }
          : undefined,
    };
  }

  async tick(manual = false, options: TickOptions = {}) {
    if (this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked || this.running) {
      return false;
    }
    const trigger: SyncTrigger = options.trigger || (manual ? "manual" : "auto");
    this.running = true;
    this.cycleContext = this.createCycleStats(trigger);
    this.schedulerProgress = {
      status: "running",
      mode: trigger,
      title: this.triggerLabel(trigger),
      detail: "正在准备调度任务。",
      queuedActions: this.pendingTickOptions ? [this.triggerLabel(this.pendingTickOptions.trigger || "auto")] : [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.lastSchedulerError = "";
    try {
      this.remoteDirListingCache.clear();
      if (!options.skipFavoriteScan) {
        this.recoverStaleActiveBackups();
        this.requeueRetryPendingBeforeScan();
        await this.runOnce(manual, options.forceFullFavoriteScan === true);
      }
      await this.verifyRemoteSamples(manual, options.forceFullRemoteVerify === true);
      this.logCycleSummary(this.cycleContext);
    } catch (error: any) {
      const message = sanitizeDiagnosticText(error?.message || String(error), 1_000);
      console.error("[Scheduler] Tick failed:", message);
      this.cycleContext.error = message;
      this.lastSchedulerError = message;
      this.logCycleSummary(this.cycleContext);
    } finally {
      this.cycleContext = null;
      this.running = false;
      this.schedulerProgress = null;
      const queued = this.pendingTickOptions;
      this.pendingTickOptions = null;
      if (queued) {
        setTimeout(() => {
          const queuedManual = (queued.trigger || "auto") !== "auto";
          void this.tick(queuedManual, queued);
        }, 0);
      }
    }
    return true;
  }

  private async runOnce(manual: boolean, forceFullFavoriteScan: boolean) {
    const users = this.userStore.list().filter((user) => this.isUserSyncEligible(user));
    this.updateSchedulerProgress({ detail: `正在检查 ${users.length} 个启用账号。` });
    for (const user of users) {
      this.activeSyncUsers.add(user.id);
      try {
        const cooldown = this.stateManager.getUserCooldown(user.id);
        if (cooldown) {
          console.warn(`[Scheduler] User ${user.name} is cooling down until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`);
          continue;
        }

        for (const folder of user.favorites) {
          try {
            this.updateSchedulerProgress({
              userName: user.name,
              folderTitle: folder.title,
              mediaId: folder.mediaId,
              detail: forceFullFavoriteScan ? "准备全量扫描收藏夹。" : "准备同步收藏夹。",
            });
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
            console.error(`[Scheduler] Failed to scan favorite: ${safeErrorSummary(error)}`);
          }

          const jitter = 2000 + Math.floor(Math.random() * 3000);
          await delay(jitter);
        }
      } finally {
        this.activeSyncUsers.delete(user.id);
      }
    }
  }

  private async listFavoriteItemsPageWithAuthRetry(
    user: BiliUser,
    mediaId: number,
    page: number,
    pageSize: number
  ) {
    try {
      return await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
    } catch (error: any) {
      if (!(error instanceof BiliRiskOrLoginError)) {
        throw error;
      }
      if (!user.accessToken || !user.refreshToken) {
        throw error;
      }
      if (isAuthRefreshAttemptBlocked(
        user.authRefreshFailureCategory,
        user.authRefreshFailureAttempts,
        user.authRefreshRetryAt,
      )) {
        throw error;
      }
      let refreshed;
      try {
        refreshed = await refreshUserAuth(user.accessToken, user.refreshToken);
      } catch (refreshError: any) {
        const current = this.userStore.getById(user.id) || user;
        const failure = nextAuthRefreshFailureState(
          current.authRefreshFailureCategory,
          current.authRefreshFailureAttempts,
          refreshError,
        );
        this.userStore.updatePartial(user.id, {
          lastAuthRefreshError: safeErrorSummary(refreshError),
          authRefreshFailureCategory: failure.category,
          authRefreshFailureAttempts: failure.attempts,
          authRefreshRetryAt: failure.retryAt,
        });
        throw error;
      }

      try {
        const updated = this.userStore.updatePartial(user.id, {
          cookie: refreshed.cookie,
          rawAuth: refreshed.rawAuth,
          accessToken: refreshed.accessToken || user.accessToken,
          refreshToken: refreshed.refreshToken || user.refreshToken,
          expires: refreshed.expires || user.expires,
          lastAuthRefreshAt: new Date().toISOString(),
          lastAuthRefreshError: "",
          authRefreshFailureCategory: undefined,
          authRefreshFailureAttempts: undefined,
          authRefreshRetryAt: undefined,
        });
        if (!updated) {
          throw error;
        }
        user.cookie = updated.cookie;
        user.accessToken = updated.accessToken;
        user.refreshToken = updated.refreshToken;
        user.expires = updated.expires;
        console.warn(`[Scheduler] Refreshed auth for ${user.name} after login/risk error; retrying page ${page}.`);
        return await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
      } catch (retryError: any) {
        // A refreshed token can still be rejected by the specific page request;
        // let the normal Bilibili risk/login cooldown handle that without
        // falsely recording a token-refresh failure.
        if (retryError instanceof BiliRiskOrLoginError) throw retryError;
        throw error;
      }
    }
  }

  private backupKey(userId: string, mediaId: number, bvid: string) {
    return `${userId}:${mediaId}:${bvid}`;
  }

  private getLocalCacheReserveBytes(limitBytes = this.getLocalCacheLimitBytes()) {
    if (limitBytes <= 0) return 0;
    return Math.min(limitBytes, Math.max(512 * 1024 * 1024, Math.floor(limitBytes * 0.1)));
  }

  private selfVisibleProbeKey(userId: string, bvid: string) {
    return `${userId}:${bvid}`;
  }

  private async resolveSelfVisibleItemForSync(
    user: BiliUser,
    mediaId: number,
    item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]
  ) {
    if (!item.unavailable || !user.uid || Number(item.upperMid || 0) !== Number(user.uid)) {
      return item;
    }
    const key = this.selfVisibleProbeKey(user.id, item.bvid);
    if (this.selfVisibleProbeCache.size > 500) {
      const now = Date.now();
      for (const [cacheKey, value] of this.selfVisibleProbeCache) {
        if (value.expiresAt <= now) this.selfVisibleProbeCache.delete(cacheKey);
      }
    }
    const cached = this.selfVisibleProbeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.item;
    }
    const previousRelation = this.stateManager.getRelationStatus(user.id, mediaId, item.bvid);
    const wasSelfVisible = previousRelation?.selfVisible === true;
    const resolved = await resolveSelfVisibleFavoriteItem(user.cookie, user.uid, item);
    this.selfVisibleProbeCache.set(key, {
      expiresAt: Date.now() + 10 * 60_000,
      item: resolved,
    });
    if (resolved.selfVisible && !wasSelfVisible) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `自稿件失效项已恢复详情 ${item.bvid}`,
        raw: `[SelfVisible] ${user.name}/${item.bvid} resolved from favorite-unavailable to self-visible`,
        bvid: item.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    return resolved;
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

  private async cleanupSharedUploadDir(
    downloadDir: string,
    bvids: Set<string> = new Set(),
    options: DownloadCleanupOptions = {},
  ) {
    try {
      const result = await cleanupUploadedSessionFiles(downloadDir, options);
      if (!this.acceptingJobs) return;
      const remainingManifest = readDownloadSession(downloadDir);
      const remainingPaths = remainingManifest
        ? [...remainingManifest.outputs, ...(remainingManifest.history || [])].map((file) => file.relativePath)
        : [];
      if (remainingManifest || result.removedDirectory) {
        for (const bvid of bvids) {
          this.stateManager.reconcileLocalCleanupPlans(bvid, downloadDir, remainingPaths, result.removedDirectory);
        }
      }
      if (result.removedDirectory || (remainingManifest
        && remainingManifest.outputs.length === 0
        && (remainingManifest.history || []).length === 0)) {
        for (const bvid of bvids) {
          this.stateManager.markLocalUploadGroupComplete(bvid, downloadDir);
        }
      }
      if (!result.removedDirectory) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: "warn",
          summary: `本地文件已保留，未授权清理的文件不会自动删除`,
          raw: `[DownloadRecovery] retained ${result.retainedBytes} bytes in ${downloadDir}`,
          simpleVisible: true,
          debugVisible: true,
        });
      }
    } catch (error: any) {
      console.warn(`[Scheduler] Failed to cleanup ${downloadDir}: ${safeErrorSummary(error)}`);
    } finally {
      this.refreshLocalCacheAndWake(true);
    }
  }

  private async scanAllPages(user: BiliUser, mediaId: number, folderTitle: string) {
    this.updateSchedulerProgress({
      mode: "reconcile",
      title: "全量扫描并对账",
      userName: user.name,
      folderTitle,
      mediaId,
      page: 1,
      detail: "正在全量扫描 B 站收藏夹。",
    });
    let page = 1;
    const scanStartedAt = new Date().toISOString();
    const seenBvids = new Set<string>();
    let lastTotal: number | undefined;
    this.stateManager.updateFolderScan(user.id, mediaId, {
      folderTitle,
      initStatus: "initializing",
      lastHotScanAt: scanStartedAt,
      lastHistoryScanAt: scanStartedAt,
    });
    while (true) {
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      lastTotal = result.total;
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        indexed: seenBvids.size + result.items.length,
        biliTotal: result.total,
        detail: `正在全量扫描第 ${page} 页。`,
      });
      await this.recordPage(user, mediaId, folderTitle, result.items, page, 20, scanStartedAt, seenBvids);
      this.stateManager.updateFolderScan(user.id, mediaId, {
        folderTitle,
        initStatus: "initializing",
        nextHistoryPage: page + 1,
        catchupPage: 1,
        lastHotScanAt: scanStartedAt,
        lastHistoryScanAt: scanStartedAt,
        total: result.total,
      });
      if (!result.hasMore || result.items.length === 0) {
        break;
      }
      page += 1;
      await delay(1000 + Math.floor(Math.random() * 2000));
    }
    this.stateManager.updateFolderScan(user.id, mediaId, {
      folderTitle,
      initStatus: "complete",
      nextHistoryPage: 1,
      catchupPage: 1,
      lastHotScanAt: scanStartedAt,
      lastHistoryScanAt: scanStartedAt,
      total: lastTotal,
    });
    if (!this.stateManager.getDatabase().isArchiveFolderDeletionActive(user.id, mediaId)) {
      this.stateManager.markMissingFavoritesInactive(user.id, mediaId, seenBvids);
    }
  }

  private async scanHotPages(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean) {
    this.updateSchedulerProgress({
      mode: manual ? "manual" : "auto",
      title: this.triggerLabel(manual ? "manual" : "auto"),
      userName: user.name,
      folderTitle,
      mediaId,
      detail: "正在扫描收藏夹近期页面。",
    });
    let consecutiveKnownPages = 0;
    let burstBudget = 0;
    const minPages = manual ? 10 : this.hotScanMinPages;
    const maxPages = manual ? 40 : this.hotScanMaxPages;
    let lastPage = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        biliTotal: result.total,
        detail: `正在扫描近期第 ${page} 页。`,
      });
      const pageStats = await this.recordPage(user, mediaId, folderTitle, result.items, page, 20);
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
    this.updateSchedulerProgress({
      userName: user.name,
      folderTitle,
      mediaId,
      detail: "正在补扫收藏夹历史页面。",
    });
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
      const result = await this.listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
      this.updateSchedulerProgress({
        userName: user.name,
        folderTitle,
        mediaId,
        page,
        pageSize: 20,
        biliTotal: result.total,
        detail: `正在补扫历史第 ${page} 页。`,
      });
      await this.recordPage(user, mediaId, folderTitle, result.items, page, 20);

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

  private async recordPage(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    items: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"],
    page: number,
    pageSize = 20,
    seenAt = new Date().toISOString(),
    seenBvids?: Set<string>
  ) {
    let newItems = 0;
    for (const [indexInPage, rawItem] of items.entries()) {
      if (this.stateManager.getDatabase().isArchiveSourceDeletionActive(user.id, mediaId, rawItem.bvid)) {
        continue;
      }
      const item = await this.resolveSelfVisibleItemForSync(user, mediaId, rawItem);
      seenBvids?.add(item.bvid);
      const favOrder = (Math.max(1, page) - 1) * Math.max(1, pageSize) + indexInPage + 1;
      const result = this.stateManager.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
        favOrder,
        favPage: page,
        favIndexInPage: indexInPage,
      }, seenAt);
      if (!item.unavailable && item.cover) {
        queueCoverCache(item.bvid, item.cover, (coverLocalPath) => {
          this.stateManager.recordCoverCache(item.bvid, coverLocalPath);
        });
      }
      if (item.unavailable && !item.selfVisible) {
        const availability = this.stateManager.getSourceAvailability(item.bvid);
        const shouldAutoProbe = this.stateManager.listRelationsForBvid(item.bvid).some((relation) =>
          relation.activeInFavorite
          && relation.sourceKind !== "manual"
          && !relation.selfVisible
          && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
        if (shouldAutoProbe && availability && !["confirmed_unavailable", "dormant"].includes(availability.state)) {
          const persistedNextAt = Date.parse(availability.nextCheckAt || "");
          const nextAt = Number.isFinite(persistedNextAt) && persistedNextAt > this.now()
            ? persistedNextAt
            : this.now() + availabilityJitter(item.bvid);
          if (!availability.nextCheckAt || !Number.isFinite(persistedNextAt) || persistedNextAt <= this.now()) {
            this.stateManager.markAvailabilityPending(
              item.bvid,
              "favorite_flag",
              seenAt,
              new Date(nextAt).toISOString(),
            );
          }
          this.enqueueAvailabilityProbe(item.bvid, {
            preferredUserId: user.id,
            notBefore: nextAt,
            availabilityRound: availability.checkRound,
            availabilityReason: availability.reason,
          });
        }
      }
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

  private collectUploadTargets(bvid: string, fallback: UploadTarget[] = []) {
    const config = this.configStore.get();
    const targets = new Map<string, UploadTarget>();
    for (const target of fallback) {
      if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(target.userId, target.mediaId, bvid)) continue;
      targets.set(`${target.userId}:${target.mediaId}`, target);
    }
    for (const relation of this.stateManager.listRelationsForBvid(bvid)) {
      if (["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
      if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, bvid)) continue;
      const resolved = this.resolveRelation(relation);
      if (!resolved) continue;
      targets.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: resolved.folderTitle,
        remotePath: relation.remotePath || resolveRemotePath({
          destination: config.alistDest,
          layout: config.uploadLayout,
          userName: resolved.user.name,
          folderName: resolved.folderTitle,
        }),
      });
    }
    return [...targets.values()];
  }

  private enqueueIfNeeded(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    bvid: string,
    options: {
      persisted?: boolean;
      notBefore?: number;
      downloadUserId?: string;
      recoveryAttempt?: number;
      dedupeKey?: string;
      qualityProfile?: QualityArtifactProfile;
      qualityStrict?: boolean;
      qualityEncodingOverride?: QualityEncodingOverride;
    } = {}
  ) {
    if (!this.isUserSyncEligible(user)) {
      return false;
    }
    if (this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(user.id, mediaId, bvid)) {
      return false;
    }
    const exactTarget = Boolean(options.qualityProfile && (options.qualityStrict || options.qualityEncodingOverride?.strict));
    // A strict request must never silently reuse a completed artifact produced
    // for another profile. It gets its own manifest directory and is checked
    // again before the upload task is created.
    const local = exactTarget ? null : this.stateManager.getCompletedLocalDownload(bvid);
    const chargingRestriction = this.stateManager.getChargingRestriction(bvid);
    if (chargingRestriction && !local) {
      const nextCheckAt = Date.parse(chargingRestriction.nextCheckAt || "");
      this.enqueueChargingAccessProbe(bvid, {
        preferredUserId: user.id,
        checkedAccountUids: chargingRestriction.checkedAccountUids,
        previewAvailable: chargingRestriction.previewAvailable,
        notBefore: Number.isFinite(nextCheckAt) ? Math.max(this.now(), nextCheckAt) : this.now(),
      });
      this.dispatchPersistentJobs();
      return false;
    }
    const chargingLocalReady = Boolean(chargingRestriction && local);
    if (chargingLocalReady) {
      this.stateManager.clearChargingRestriction(bvid);
      const probeJob = this.jobStore.findByDedupeKey(`access_probe:${bvid}`);
      if (probeJob) this.jobStore.complete(probeJob.id);
    }
    if (!options.persisted
      && !chargingLocalReady
      && !this.stateManager.shouldEnqueueBackup(bvid, user.id, mediaId, this.cycleContext?.startedAt)) {
      return false;
    }
    const config = this.configStore.get();
    const existingRelation = this.stateManager.getRelationStatus(user.id, mediaId, bvid);
    const remotePath = existingRelation?.remotePath || this.resolveRelationRemotePath(user, mediaId, folderTitle, config);
    const existingArchiveProof = this.captureExistingArchiveProof(user.id, mediaId, bvid);
    this.stateManager.markQueued(bvid, remotePath, user.id, mediaId);
    if (local) {
      const meta = this.stateManager.getVideoMeta(bvid);
      this.queueUploadWork({
        bvid,
        localDir: local.localDir,
        remotePath,
        userId: user.id,
        mediaId,
        folderTitle,
        videoTitle: meta?.title || bvid,
        upperName: meta?.upperName || "",
        cover: meta?.cover || "",
        files: local.files,
        filenameMetadataByPath: buildUploadFileMetadataFromSession(local.localDir, local.files),
        partialBackup: local.partialBackup,
        existingArchiveProof,
        priority: true,
      });
      for (const history of historySessionGroups(local.localDir)) {
        this.queueUploadWork({
          bvid,
          localDir: local.localDir,
          remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
          userId: user.id,
          mediaId,
          folderTitle,
          videoTitle: meta?.title || bvid,
          upperName: meta?.upperName || "",
          cover: meta?.cover || "",
          files: history.files.map((file) => file.relativePath),
          historyOnly: true,
          historySnapshotAt: history.snapshotAt,
          priority: false,
        });
      }
      return true;
    }
    this.jobStore.enqueue({
      kind: "download",
      dedupeKey: options.dedupeKey || `download:${bvid}`,
      bvid,
      priority: 40,
      maxAttempts: config.maxRetries + 1,
      notBefore: options.notBefore || 0,
      payload: {
        primaryUserId: user.id,
        primaryMediaId: mediaId,
        primaryFolderTitle: folderTitle,
        downloadUserId: options.downloadUserId || user.id,
        automaticRecoveryAttempts: Math.max(0, Number(options.recoveryAttempt || 0)),
        qualityProfile: options.qualityProfile,
        qualityStrict: options.qualityStrict === true,
        qualityEncodingOverride: options.qualityEncodingOverride,
        qualityArtifactKey: exactTarget
          ? buildQualityArtifactKey(bvid, normalizeQualityArtifactProfile(options.qualityProfile!))
          : undefined,
      },
    });
    this.dispatchPersistentJobs();
    return true;
  }

  private requeueRetryPendingBeforeScan() {
    const users = this.userStore.list().filter((user) => this.isUserSyncEligible(user));
    let remaining = Math.max(1, this.configStore.get().remoteRequeueLimitPerCycle || 20);
    this.stateManager.runBatch(() => {
      for (const user of users) {
        for (const folder of user.favorites) {
          if (remaining <= 0) return;
          const bvids = this.stateManager.listRetryCandidatesForFolder(user.id, folder.mediaId, remaining);
          for (const bvid of bvids) {
            if (remaining <= 0) return;
            const queued = this.enqueueIfNeeded(user, folder.mediaId, folder.title, bvid);
            if (queued) {
              this.cycleContext!.queuedItems += 1;
              remaining -= 1;
            }
          }
        }
      }
    });
  }

  private triggerOrQueueTick(options: TickOptions) {
    if (this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked) {
      return { started: false, queued: false };
    }
    if (this.running) {
      this.pendingTickOptions = this.mergeTickOptions(this.pendingTickOptions, options);
      return { started: false, queued: true };
    }
    const manual = (options.trigger || "auto") !== "auto";
    void this.tick(manual, options);
    return { started: true, queued: false };
  }

  private mergeTickOptions(current: TickOptions | null, incoming: TickOptions): TickOptions {
    if (!current) {
      return { ...incoming };
    }
    const triggerPriority: Record<SyncTrigger, number> = {
      auto: 0,
      remote_reconcile: 1,
      manual: 2,
      reconcile: 3,
    };
    const currentTrigger = (current.trigger || "auto") as SyncTrigger;
    const incomingTrigger = (incoming.trigger || "auto") as SyncTrigger;
    const trigger = triggerPriority[incomingTrigger] >= triggerPriority[currentTrigger] ? incomingTrigger : currentTrigger;

    const forceFullFavoriteScan = Boolean(current.forceFullFavoriteScan || incoming.forceFullFavoriteScan);
    const skipFavoriteScan = forceFullFavoriteScan
      ? false
      : Boolean(current.skipFavoriteScan && incoming.skipFavoriteScan);

    return {
      trigger,
      forceFullRemoteVerify: Boolean(current.forceFullRemoteVerify || incoming.forceFullRemoteVerify),
      forceFullFavoriteScan,
      skipFavoriteScan,
    };
  }

  private async verifyRemoteSamples(manual: boolean, forceFullRemoteVerify: boolean) {
    if (!this.cycleContext) return;

    const config = this.configStore.get();
    this.updateSchedulerProgress({
      mode: forceFullRemoteVerify ? (manual ? "remote_reconcile" : this.cycleContext.trigger) : this.cycleContext.trigger,
      title: forceFullRemoteVerify ? "状态对账" : this.triggerLabel(this.cycleContext.trigger),
      detail: forceFullRemoteVerify ? "正在准备远端存储状态对账。" : "正在抽样验证远端存储文件。",
      userName: undefined,
      folderTitle: undefined,
      mediaId: undefined,
      page: undefined,
      pageSize: undefined,
      indexed: undefined,
      biliTotal: undefined,
      checked: undefined,
      total: undefined,
    });
    this.remoteVerifyPathQueue.clear();
    const verifyLimit = forceFullRemoteVerify ? undefined : this.getRemoteVerifyLimit(manual, this.cycleContext.newItems);
    const includeDeferred = forceFullRemoteVerify;
    const candidates = this.stateManager.listVideosForRemoteVerify(verifyLimit, includeDeferred);
    this.cycleContext.remoteChecked = candidates.length;
    this.cycleContext.remoteEligible = this.stateManager.countVideosForRemoteVerify(includeDeferred);
    const concurrency = Math.max(1, Math.min(100, Math.floor(config.remoteVerifyConcurrency || 3)));
    const requeueLimit = Math.max(1, Math.min(1000, Math.floor(config.remoteRequeueLimitPerCycle || 20)));
    const rateLimit = Math.max(0.5, Math.min(100, Number(config.remoteVerifyRateLimitPerSecond || 2)));
    let requeueCount = 0;

    const executeOne = async (entry: RemoteVerifyCandidate) => {
      try {
        const relation = entry.relation;
        const resolvedRemotePath = relation.remotePath || entry.remotePath || this.deriveRemotePathFromRelation(entry, relation);
        await this.applyRemoteVerifyRateLimit(rateLimit, resolvedRemotePath || "<remote-unknown>");
        const jitter = 100 + Math.floor(Math.random() * 201);
        await delay(jitter);
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
        if (result.unknown.length > 0) {
          const delayMs = this.computeRemoteVerifyBackoffMs(entry, result.retryAfterMs);
          this.stateManager.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
          this.cycleContext!.remoteErrors += 1;
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
          const delayMs = this.computeRemoteVerifyBackoffMs(entry, confirmed.retryAfterMs);
          this.stateManager.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
          this.cycleContext!.remoteErrors += 1;
          return;
        }

        const missing = confirmed.missing?.length ? confirmed.missing : result.missing;
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
        console.warn(`[Scheduler] Remote verify failed for ${entry.bvid}: ${safeErrorSummary(error)}`);
      }
    };

    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (index < candidates.length) {
        const current = candidates[index];
        index += 1;
        this.updateSchedulerProgress({
          checked: index,
          total: candidates.length,
          detail: `正在对账远端存储文件 ${index}/${candidates.length}。`,
        });
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
    const names = await this.getRemoteDirListing(pathToUse);
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
    return this.resolveRelationRemotePath(
      resolvedRelation.user,
      resolvedRelation.mediaId,
      resolvedRelation.folderTitle,
      config,
    );
  }

  private async getRemoteDirListing(pathToUse: string) {
    const now = Date.now();
    const cached = this.remoteDirListingCache.get(pathToUse);
    if (cached && cached.expiresAt > now) {
      return cached.names;
    }
    const config = this.configStore.get();
    const names = await listRemoteDir(config, pathToUse);
    this.remoteDirListingCache.set(pathToUse, {
      expiresAt: now + this.remoteDirListingCacheTtlMs,
      names,
    });
    return names;
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

  private recoverStaleActiveBackups() {
    const items = this.stateManager.listStaleActiveBackups(this.staleActiveBackupMs);
    this.stateManager.runBatch(() => {
      for (const item of items) {
        const relation = item.relation;
        if (this.jobStore.hasJobsForBvid(relation.bvid)) continue;
        const resolved = this.resolveRelation(relation);
        if (!resolved) continue;

        const localDir = item.video.localDir;
        if (localDir && fs.existsSync(localDir)) {
          const manifest = readDownloadSession(localDir);
          const uploadReady = Boolean(manifest && (manifest.status === "complete" || manifest.status === "partial"));
          if (!uploadReady) {
            this.stateManager.markDownloadInterrupted(relation.bvid, localDir, "Stale download session queued for resume.", [{ userId: relation.userId, mediaId: relation.mediaId }]);
            this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid, { persisted: true });
            continue;
          }
          const remotePath = relation.remotePath || item.video.remotePath || this.resolveRelationRemotePath(resolved.user, relation.mediaId, resolved.folderTitle);
          this.stateManager.markUploadFailed(relation.bvid, localDir, relation.userId, relation.mediaId, "Stale upload retained locally and queued for upload retry.");
          const historyTargetKey = `${relation.userId}:${relation.mediaId}`;
          const historyGroups = historySessionGroups(localDir)
            .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
            .filter((group) => group.files.length > 0);
          const baseUpload: RecoveryUploadItem = {
            bvid: relation.bvid,
            localDir,
            remotePath,
            userId: relation.userId,
            mediaId: relation.mediaId,
            folderTitle: resolved.folderTitle,
            videoTitle: item.video.title,
            upperName: item.video.upperName,
            cover: item.video.cover,
            files: manifest?.outputs.map((output) => output.relativePath),
            filenameMetadataByPath: manifest ? buildUploadFileMetadataFromSession(localDir, manifest.outputs.map((output) => output.relativePath)) : undefined,
            partialBackup: manifest?.status === "partial",
            priority: true,
          };
          this.queueUploadWork(baseUpload);
          for (const history of historyGroups) {
            this.queueUploadWork({
              ...baseUpload,
              remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
          continue;
        }

        this.stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Active backup state became stale and was re-queued.");
        const queued = this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid);
        if (queued && this.cycleContext) this.cycleContext.queuedItems += 1;
      }
    });
  }

  private async confirmRemoteStillMissing(
    entry: VideoArchiveEntry,
    relation?: FavoriteRelation,
    knownFiles?: VideoArchiveEntry["remoteFiles"],
    resolvedRemotePath?: string | null
  ): Promise<
    | { status: "ok"; remoteFiles: NonNullable<VideoArchiveEntry["remoteFiles"]> }
    | { status: "missing"; missing: string[] }
    | { status: "unknown"; retryAfterMs?: number }
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
      if (result.unknown.length > 0) {
        return { status: "unknown", retryAfterMs: result.retryAfterMs };
      }
      return { status: "missing", missing: result.missing };
    } catch {
      // Treat transient errors as inconclusive to avoid false-positive "missing".
      return { status: "unknown" };
    }
  }

  private async applyRemoteVerifyRateLimit(rateLimitPerSecond: number, remotePath: string) {
    const intervalMs = Math.max(50, Math.floor(1000 / rateLimitPerSecond));
    const now = Date.now();
    const pathNextAllowed = this.remoteVerifyPathQueue.get(remotePath) || 0;
    const nextAllowed = Math.max(this.remoteVerifyNextAllowedAt, pathNextAllowed);
    if (nextAllowed <= now) {
      const next = now + intervalMs;
      this.remoteVerifyNextAllowedAt = next;
      this.remoteVerifyPathQueue.set(remotePath, next + Math.floor(intervalMs / 2));
      return;
    }
    const waitMs = nextAllowed - now;
    const next = nextAllowed + intervalMs;
    this.remoteVerifyNextAllowedAt = next;
    this.remoteVerifyPathQueue.set(remotePath, next + Math.floor(intervalMs / 2));
    await delay(waitMs);
  }

  private computeRemoteVerifyBackoffMs(entry: VideoArchiveEntry, retryAfterMs?: number) {
    const missingCount = Math.max(0, entry.remoteMissingCount || 0);
    const base = 30_000;
    const max = 30 * 60_000;
    const exp = Math.min(6, missingCount);
    const backoff = Math.min(max, base * Math.pow(2, exp));
    const jitter = Math.floor(Math.random() * 3_000);
    const serverDelay = Number.isFinite(retryAfterMs) ? Math.max(0, Number(retryAfterMs)) : 0;
    return Math.max(backoff, Math.min(max, serverDelay)) + jitter;
  }

  private startLegacyTempCacheRecovery() {
    if (this.stateManager.getDatabase().getMeta(LEGACY_TEMP_CACHE_MARKER) === "complete") return;
    if (this.legacyTempRecoveryPromise) return;
    this.legacyTempRecoveryPending = true;
    this.legacyTempRecoveryPromise = this.recoverLegacyDownloadDirs()
      .catch((error) => {
        console.warn(`[Recovery] Failed to inspect legacy local cache: ${safeErrorSummary(error)}`);
      })
      .finally(() => {
        this.legacyTempRecoveryPending = false;
        this.legacyTempRecoveryPromise = null;
        if (!this.acceptingJobs) return;
        this.downloadQueue.poke();
        this.dispatchPersistentJobs();
      });
  }

  enqueueManualArchive(userId: string, item: {
    bvid: string;
    title: string;
    upperName: string;
    upperMid?: number;
    cover?: string;
    description?: string;
    qualityProfile?: QualityArtifactProfile;
    qualityStrict?: boolean;
    qualityEncodingOverride?: QualityEncodingOverride;
  }) {
    const user = this.userStore.getById(userId);
    const bvid = String(item.bvid || "").trim();
    if (!user || !this.isUserSyncEligible(user)) {
      return { ok: false as const, status: 409, message: "该账号当前不可用于手动归档" };
    }
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
      return { ok: false as const, status: 400, message: "在线条目缺少有效BVID" };
    }
    const existing = this.stateManager.listRelationsForBvid(bvid)
      .find((relation) => ["verified", "partial_verified", "uploaded"].includes(String(relation.backupStatus || ""))
        && (relation.remoteFiles || []).some((file) => file.verificationStatus === "verified" || file.verificationStatus === undefined));
    if (existing) {
      return { ok: true as const, status: "already_archived" as const, bvid, relation: existing };
    }
    const exactTarget = Boolean(item.qualityProfile && (item.qualityStrict || item.qualityEncodingOverride?.strict));
    const artifactKey = exactTarget
      ? buildQualityArtifactKey(bvid, normalizeQualityArtifactProfile(item.qualityProfile!))
      : "";
    const dedupeKey = exactTarget ? `download:${bvid}:manual:${artifactKey}` : `download:${bvid}`;
    const existingJob = this.jobStore.findByDedupeKey(dedupeKey);
    if (existingJob && ["pending", "leased", "running", "retry_wait", "manual_wait"].includes(existingJob.status)) {
      return {
        ok: true as const,
        status: "already_pending" as const,
        bvid,
        userId,
        mediaId: MANUAL_ARCHIVE_MEDIA_ID,
        jobId: existingJob.id,
      };
    }
    const current = this.stateManager.getRelationStatus(userId, MANUAL_ARCHIVE_MEDIA_ID, bvid);
    if (!current) {
      this.stateManager.recordManualArchiveItem(userId, {
        bvid,
        title: String(item.title || bvid),
        upperName: String(item.upperName || "Unknown"),
        upperMid: item.upperMid,
        cover: item.cover,
        description: item.description,
      });
    }
    const queued = this.enqueueIfNeeded(user, MANUAL_ARCHIVE_MEDIA_ID, MANUAL_ARCHIVE_FOLDER_TITLE, bvid, {
      persisted: true,
      downloadUserId: user.id,
      dedupeKey,
      qualityProfile: item.qualityProfile,
      qualityStrict: item.qualityStrict,
      qualityEncodingOverride: item.qualityEncodingOverride,
    });
    return {
      ok: true as const,
      status: queued ? "queued" as const : "already_pending" as const,
      bvid,
      userId,
      mediaId: MANUAL_ARCHIVE_MEDIA_ID,
      qualityProfile: item.qualityProfile,
      qualityStrict: item.qualityStrict === true,
      qualityEncoding: item.qualityEncodingOverride?.priority?.[0],
    };
  }

  private async recoverLegacyDownloadDirs() {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.legacyTempDir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") entries = [];
      else throw error;
    }
    let recovered = 0;
    let unresolved = 0;
    for (const entry of entries) {
      if (!this.acceptingJobs) return;
      if (entry.isSymbolicLink() || !entry.isDirectory() || !/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
      const localDir = path.join(this.legacyTempDir, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(localDir);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      try {
        const retained = await fs.promises.lstat(path.join(localDir, DOWNLOAD_RETAINED_FILE));
        if (retained.isFile() && !retained.isSymbolicLink()) continue;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (await readDownloadSessionAsync(localDir)) continue;
      if (!this.acceptingJobs) return;
      const resolved = this.findBestRelationForBvid(entry.name);
      if (!resolved) {
        unresolved += 1;
        continue;
      }
      this.stateManager.markDownloadInterrupted(
        entry.name,
        localDir,
        "Legacy local cache queued for safe recovery.",
        [{ userId: resolved.user.id, mediaId: resolved.mediaId }]
      );
      this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.name, { persisted: true });
      recovered += 1;
    }
    if (!this.acceptingJobs) return;
    this.stateManager.getDatabase().setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
    if (recovered > 0 || unresolved > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: unresolved > 0 ? "warn" : "info",
        summary: unresolved > 0
          ? `旧缓存已恢复 ${recovered} 项，另有 ${unresolved} 项保留待识别`
          : `已恢复 ${recovered} 项旧缓存`,
        raw: `[Recovery] legacy local cache recovered=${recovered} unresolved=${unresolved}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }

  private resumePersistedWork() {
    this.ensurePersistedAvailabilityProbes();
    this.ensurePersistedChargingAccessProbes();
    if (this.stateManager.hasPersistentJobBootstrap()) {
      this.recoverOrphanedUploadFailures();
      return;
    }
    this.stateManager.normalizePersistedWorkForRecovery();
    const statusPriority: Record<string, number> = {
      upload_failed: 0,
      uploading: 1,
      downloaded: 2,
      queued: 3,
      downloading: 4,
      missing: 5,
    };
    const items = this.stateManager.listBackupsToResume().sort((left, right) => {
      const leftStatus = left.relation?.backupStatus || left.video.backupStatus;
      const rightStatus = right.relation?.backupStatus || right.video.backupStatus;
      return (statusPriority[leftStatus] ?? 99) - (statusPriority[rightStatus] ?? 99);
    });
    for (const item of items) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? this.resolveRelation(relation) : this.findBestRelationForBvid(entry.bvid);
      const status = relation?.backupStatus || entry.backupStatus;
      const localDir = entry.localDir;
      const hasLocalDir = Boolean(localDir && fs.existsSync(localDir));
      if (!resolved) continue;
      const config = this.configStore.get();
      const remotePath = relation?.remotePath || entry.remotePath || this.resolveRelationRemotePath(resolved.user, relation?.mediaId || 0, resolved.folderTitle, config);
      if (["verified", "partial_verified"].includes(status) && hasLocalDir && localDir && relation) {
        const targetKey = `${relation.userId}:${relation.mediaId}`;
        const pendingHistory = historySessionGroups(localDir)
          .map((group) => ({
            ...group,
            files: group.files.filter((file) => !(file.uploadedTargets || []).includes(targetKey)),
          }))
          .filter((group) => group.files.length > 0);
        if (pendingHistory.length > 0) {
          for (const history of pendingHistory) {
            this.queueUploadWork({
              bvid: entry.bvid,
              localDir,
              remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
              userId: relation.userId,
              mediaId: relation.mediaId,
              folderTitle: resolved.folderTitle,
              videoTitle: entry.title,
              upperName: entry.upperName,
              cover: entry.cover,
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
        }
        continue;
      }
      if (["downloaded", "uploading", "upload_failed"].includes(status) && hasLocalDir && localDir) {
        const manifest = readDownloadSession(localDir);
        if (!manifest || !["complete", "partial"].includes(manifest.status)) {
          this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
          continue;
        }
        const uploadItem: RecoveryUploadItem = {
          bvid: entry.bvid,
          localDir,
          remotePath,
          userId: resolved.user.id,
          mediaId: resolved.mediaId,
          folderTitle: resolved.folderTitle,
          videoTitle: entry.title,
          upperName: entry.upperName,
          cover: entry.cover,
          files: manifest.outputs.map((output) => output.relativePath),
          filenameMetadataByPath: buildUploadFileMetadataFromSession(localDir, manifest.outputs.map((output) => output.relativePath)),
          partialBackup: manifest.status === "partial",
          priority: true,
        };
        this.queueUploadWork(uploadItem);
        const historyTargetKey = `${resolved.user.id}:${resolved.mediaId}`;
        const historyGroups = historySessionGroups(localDir)
          .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
          .filter((group) => group.files.length > 0);
        for (const history of historyGroups) {
          this.queueUploadWork({
            ...uploadItem,
            remotePath: joinRemotePath(remotePath, "_history", this.historySnapshotSegment(history.snapshotAt)),
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
            priority: false,
          });
        }
        continue;
      }
      this.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
    }

    const sessionFilesCache = new Map<string, ReturnType<TransferSessionStore["listFiles"]>>();
    const sessionVerificationJobs = new Map<string, any>();
    for (const pending of this.stateManager.listPendingUploadVerifications(10_000)) {
      const relation = this.stateManager.getRelationStatus(pending.userId, pending.mediaId, pending.bvid);
      const resolved = relation ? this.resolveRelation(relation) : null;
      const manifest = pending.localDir ? readDownloadSession(pending.localDir) : null;
      for (const file of pending.files) {
        if (typeof file.size !== "number") continue;
        const transferSession = this.transferSessions.findForTarget(pending.userId, pending.mediaId, pending.bvid, file.path);
        const transferSessionKey = transferSession ? `${transferSession.id}:g${transferSession.generation}` : "";
        const transferFiles = transferSession
          ? (sessionFilesCache.get(transferSessionKey) || (() => {
            const listed = this.transferSessions.listFiles(transferSession.id, transferSession.generation);
            sessionFilesCache.set(transferSessionKey, listed);
            return listed;
          })())
          : [];
        const transferFile = transferSession
          ? transferFiles.find((candidate) => candidate.finalPath === file.path)
          : undefined;
        const verificationPath = transferFile?.finalPath || file.path;
        if (transferSession) {
          const historySegment = transferSession.historyOnly ? `history:${transferSession.historySnapshotAt || "unknown"}` : "main";
          const candidate = {
            sessionId: transferSession.id,
            sessionGeneration: transferSession.generation,
            bvid: pending.bvid,
            userId: pending.userId,
            mediaId: pending.mediaId,
            remoteFile: verificationPath,
            finalFile: file.path,
            expectedSize: file.size,
            localDir: pending.localDir || transferSession.localDir,
            remotePath: pending.remotePath || transferSession.remotePath,
            files: manifest?.outputs.map((output) => output.relativePath) || transferFiles.map((entry) => entry.relativePath),
            filenameMetadataByPath: manifest
              ? buildUploadFileMetadataFromSession(pending.localDir || transferSession.localDir, manifest.outputs.map((output) => output.relativePath))
              : undefined,
            partialBackup: Boolean(pending.partialBackup),
            localRelativePath: file.localRelativePath,
            putCompletedAt: file.putCompletedAt || (transferFile?.putAcceptedAt ? new Date(transferFile.putAcceptedAt).toISOString() : new Date().toISOString()),
            notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now(),
            folderTitle: resolved?.folderTitle || "",
            videoTitle: this.stateManager.getVideoMeta(pending.bvid)?.title || pending.bvid,
            historyOnly: transferSession.historyOnly,
            historySnapshotAt: transferSession.historySnapshotAt,
            historySegment,
          };
          const existing = sessionVerificationJobs.get(transferSessionKey);
          if (!existing || candidate.notBefore < existing.notBefore) sessionVerificationJobs.set(transferSessionKey, candidate);
          continue;
        }

        this.jobStore.enqueue({
          kind: "verify_upload",
          dedupeKey: `verify:${pending.userId}:${pending.mediaId}:${pending.bvid}:main:${verificationPath}`,
          bvid: pending.bvid,
          userId: pending.userId,
          mediaId: pending.mediaId,
          priority: 10,
          maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
          notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now(),
          payload: {
            remoteFile: verificationPath,
            finalFile: file.path,
            expectedSize: file.size,
            localDir: pending.localDir || "",
            remotePath: pending.remotePath,
            files: manifest?.outputs.map((output) => output.relativePath) || [],
            filenameMetadataByPath: manifest
              ? buildUploadFileMetadataFromSession(pending.localDir || "", manifest.outputs.map((output) => output.relativePath))
              : undefined,
            partialBackup: Boolean(pending.partialBackup),
            localRelativePath: file.localRelativePath,
            putCompletedAt: file.putCompletedAt || new Date().toISOString(),
            folderTitle: resolved?.folderTitle || "",
            videoTitle: this.stateManager.getVideoMeta(pending.bvid)?.title || pending.bvid,
          },
        });
      }
    }
    for (const candidate of sessionVerificationJobs.values()) {
      this.jobStore.enqueue({
        kind: "verify_upload",
        dedupeKey: `verify-session:${candidate.userId}:${candidate.mediaId}:${candidate.bvid}:${candidate.historySegment}:${candidate.sessionId}:g${candidate.sessionGeneration || 1}`,
        bvid: candidate.bvid,
        userId: candidate.userId,
        mediaId: candidate.mediaId,
        priority: candidate.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: candidate.notBefore,
        payload: {
          ...candidate,
          sessionVerification: true,
        },
      });
    }
    this.stateManager.markPersistentJobBootstrapComplete();
    const counts = this.jobStore.counts();
    const totalKind = (kind: PersistentJobKind) => Object.values(counts[kind] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "info",
      summary: `启动恢复已写入持久化队列：待补传 ${totalKind("upload") + totalKind("history_upload")}，待下载 ${totalKind("download")}，待确认 ${totalKind("verify_upload")}`,
      raw: `[Recovery] sqlite jobs uploads=${totalKind("upload") + totalKind("history_upload")} downloads=${totalKind("download")} verify=${totalKind("verify_upload")}`,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  private ensurePersistedChargingAccessProbes() {
    for (const video of this.stateManager.listChargingRestrictedVideos()) {
      const nextAt = Date.parse(video.accessRestriction?.nextCheckAt || "");
      this.enqueueChargingAccessProbe(video.bvid, {
        checkedAccountUids: video.accessRestriction?.checkedAccountUids || [],
        previewAvailable: video.accessRestriction?.previewAvailable,
        notBefore: Number.isFinite(nextAt) ? nextAt : this.now(),
      });
    }
  }

  private ensurePersistedAvailabilityProbes() {
    for (const video of this.stateManager.listAvailabilityCheckVideos()) {
      let source = video.sourceAvailability;
      if (!source) {
        const checkedAt = new Date(this.now()).toISOString();
        const nextAt = this.now() + computeAvailabilityUnavailableDelayMs(0, video.bvid);
        this.stateManager.markAvailabilityConfirmedUnavailable(
          video.bvid,
          "api_not_found",
          checkedAt,
          new Date(nextAt).toISOString(),
          1,
        );
        source = this.stateManager.getSourceAvailability(video.bvid);
      }
      if (!source || source.state === "dormant") continue;

      let nextAt = Date.parse(source.nextCheckAt || "");
      const existingJob = this.jobStore.findByDedupeKey(`access_probe:${video.bvid}`);
      const existingPayload = (existingJob?.payload || {}) as Record<string, any>;
      const existingIntents = existingJob ? normalizeAccessProbeIntents(existingPayload) : ["availability"];
      const existingScheduleLooksFixed = !existingJob || Math.abs(existingJob.notBefore - nextAt) <= 1_000;
      const canMigrateFixedSchedule = ["unknown", "confirmed_unavailable"].includes(source.state)
        && existingScheduleLooksFixed
        && (!existingJob || (
          ["pending", "retry_wait"].includes(existingJob.status)
          && existingPayload.manual !== true
          && existingIntents.length === 1
          && existingIntents[0] === "availability"
        ));
      const checkedAtMs = Date.parse(source.lastCheckedAt || "");
      if (canMigrateFixedSchedule && Number.isFinite(nextAt) && Number.isFinite(checkedAtMs)) {
        const round = Math.max(0, Number(source.checkRound || 0) - 1);
        const baseDelay = source.state === "unknown"
          ? computeAvailabilityUnknownDelayMs(round)
          : computeAvailabilityUnavailableDelayMs(round);
        const staggeredDelay = source.state === "unknown"
          ? computeAvailabilityUnknownDelayMs(round, video.bvid)
          : computeAvailabilityUnavailableDelayMs(round, video.bvid);
        const legacyFixedAt = checkedAtMs + baseDelay;
        if (Math.abs(nextAt - legacyFixedAt) <= 1_000 && staggeredDelay > baseDelay) {
          const staggeredAt = checkedAtMs + staggeredDelay;
          const catchUpDelay = Math.max(1_000, availabilityJitter(video.bvid));
          const migratedAt = staggeredAt > this.now() + 1_000 ? staggeredAt : this.now() + catchUpDelay;
          const migratedIso = new Date(migratedAt).toISOString();
          if (source.state === "unknown") {
            this.stateManager.markAvailabilityUnknown(video.bvid, source.reason, source.lastCheckedAt, migratedIso, source.checkRound);
          } else {
            this.stateManager.markAvailabilityConfirmedUnavailable(video.bvid, source.reason, source.lastCheckedAt, migratedIso, source.checkRound);
          }
          if (existingJob) this.jobStore.rescheduleByBvid(video.bvid, ["access_probe"], migratedAt, this.now());
          source = this.stateManager.getSourceAvailability(video.bvid) || source;
          nextAt = migratedAt;
        }
      }

      const relation = this.stateManager.listRelationsForBvid(video.bvid)
        .find((item) => item.activeInFavorite
          && item.sourceKind !== "manual"
          && !item.selfVisible
          && !["uploaded", "verified", "partial_verified"].includes(item.backupStatus || ""));
      if (!relation) continue;
      this.enqueueAvailabilityProbe(video.bvid, {
        preferredUserId: relation.userId,
        notBefore: Number.isFinite(nextAt) ? Math.max(this.now(), nextAt) : this.now() + availabilityJitter(video.bvid),
        availabilityRound: source.state === "confirmed_unavailable" ? source.checkRound : 0,
        availabilityUnknownRound: source.state === "unknown" ? source.checkRound : 0,
        availabilityReason: source.reason,
      });
    }
  }

  private recoverOrphanedUploadFailures() {
    const prefetchLimit = Math.max(5, Math.min(100, Math.floor(this.configStore.get().queuePrefetchLimit || 25)));
    const pageSize = Math.min(500, Math.max(100, prefetchLimit * 4));
    let cursor: { updatedAt: number; userId: string; mediaId: number; bvid: string } | null = null;
    let recovered = 0;
    const skipped = { local: 0, manifest: 0, account: 0 };
    do {
      const page = this.stateManager.listUploadFailuresForRecoveryPage(cursor, pageSize);
      const jobs: EnqueuePersistentJob[] = [];
      for (const item of page.items) {
        const localDir = item.video.localDir;
        if (!localDir || !fs.existsSync(localDir)) {
          skipped.local += 1;
          continue;
        }
        const manifest = readDownloadSession(localDir);
        if (!manifest || !["complete", "partial"].includes(manifest.status) || manifest.outputs.length === 0) {
          skipped.manifest += 1;
          continue;
        }
        const resolved = this.resolveRelation(item.relation);
        if (!resolved) {
          skipped.account += 1;
          continue;
        }
        const remotePath = item.relation.remotePath || item.video.remotePath || this.resolveRelationRemotePath(resolved.user, item.relation.mediaId, resolved.folderTitle);
        const files = manifest.outputs.map((output) => output.relativePath);
        jobs.push(this.buildPersistentUploadJob({
          bvid: item.video.bvid,
          localDir,
          remotePath,
          userId: item.relation.userId,
          mediaId: item.relation.mediaId,
          folderTitle: resolved.folderTitle,
          videoTitle: item.video.title,
          upperName: item.video.upperName,
          cover: item.video.cover,
          files,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(localDir, files),
          partialBackup: manifest.status === "partial",
          priority: true,
        }));
      }
      this.jobStore.enqueueBatch(jobs);
      recovered += jobs.length;
      cursor = page.nextCursor;
    } while (cursor);
    if (recovered > 0) this.dispatchPersistentJobs();
    if (recovered > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `启动时找回 ${recovered} 个缺少可运行任务的待补传记录`,
        raw: `[Recovery] restored orphaned upload jobs=${recovered}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    const skippedTotal = skipped.local + skipped.manifest + skipped.account;
    if (skippedTotal > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "warn",
        summary: `有 ${skippedTotal} 个待补传记录暂不能恢复，已保留原状态`,
        raw: `[Recovery] orphaned upload jobs skipped local=${skipped.local} manifest=${skipped.manifest} account=${skipped.account}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }

  private resolveRelation(relation: FavoriteRelation) {
    const user = this.userStore.getById(relation.userId);
    if (!this.isUserSyncEligible(user)) return null;
    const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
    return {
      user,
      mediaId: folder?.mediaId ?? relation.mediaId,
      folderTitle: folder?.title ?? relation.folderTitle,
    };
  }

  private resolveRelationRemotePath(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    config = this.configStore.get()
  ) {
    const folderName = mediaId === MANUAL_ARCHIVE_MEDIA_ID
      ? `__BFB_MANUAL_${sanitizeSegment(String(user.uid || user.cookie?.DedeUserID || user.id)).slice(0, 48) || "ACCOUNT"}`
      : folderTitle;
    return resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName,
    });
  }

  private findBestRelationForBvid(bvid: string) {
    const relations = this.stateManager.listRelationsForBvid(bvid);
    for (const relation of relations) {
      const user = this.userStore.getById(relation.userId);
      if (!this.isUserSyncEligible(user)) continue;
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

interface SchedulerSnapshot {
  status: "idle" | "queued" | "running" | "cooldown";
  mode: string | null;
  title: string;
  detail: string;
  userName?: string;
  folderTitle?: string;
  mediaId?: number;
  page?: number;
  pageSize?: number;
  indexed?: number;
  biliTotal?: number;
  checked?: number;
  total?: number;
  queuedActions: string[];
  lastError?: string;
  startedAt?: number;
  updatedAt?: number;
  nextRunAt?: number;
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

interface RecoveryUploadItem {
  bvid: string;
  localDir: string;
  remotePath: string;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  videoTitle?: string;
  upperName?: string;
  cover?: string;
  files?: string[];
  filenameMetadataByPath?: Record<string, NonNullable<RemoteFileRecord["filenameMetadata"]>>;
  partialBackup?: boolean;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  uploadIntent?: UploadIntent;
  existingArchiveProof?: ExistingArchiveProof;
  legacyConflictSideEffectsStarted?: boolean;
  conflictCandidateId?: string;
  conflictCandidateRemotePath?: string;
  conflictCandidateOnly?: boolean;
  conflictCandidateReasonCode?: string;
  conflictCandidateReasonSummary?: string;
  conflictArchiveSegment?: string;
  conflictArchiveOldFiles?: RemoteFileRecord[];
  conflictArchiveVerifiedPaths?: string[];
  sessionId?: string;
  sessionGeneration?: number;
  sessionDedupeKey?: string;
  allowReupload?: boolean;
  reuploadAuthorizedFiles?: string[];
  resumeOnly?: boolean;
  awaitingManualRecovery?: boolean;
  lifecycleState?: string;
  attemptKey?: string;
  userDisposition?: string;
  verifiedPages?: number;
  totalPages?: number;
  automaticRecoveryAttempts?: number;
  notBefore?: number;
  priority?: boolean;
  encodingRetry?: EncodingRetryContext;
  strictMediaTarget?: StrictMediaTarget;
}

interface LocalCacheSnapshot {
  limitBytes: number;
  usedBytes: number;
  reserveBytes: number;
  paused: boolean;
  checkedAt: number;
}

type SyncTrigger = "auto" | "manual" | "reconcile" | "remote_reconcile";

interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}
