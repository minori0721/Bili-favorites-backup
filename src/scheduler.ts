import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BiliRiskOrLoginError,
  getVideoPageSnapshot,
  listFavoriteItemsPage,
  refreshUserAuth,
  resolveSelfVisibleFavoriteItem,
  type VideoPageSnapshotResult,
} from "./bili.js";
import {
  applyBBDownEncodingPreference,
  ConfigStore,
  type AppConfig,
  type BBDownApiMode,
  type BBDownEncoding
} from "./config.js";
import { queueCoverCache } from "./cover-cache.js";
import {
  LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER,
  LEGACY_TEMP_CACHE_MARKER,
} from "./database.js";
import { safeErrorSummary, sanitizeDiagnosticText } from "./diagnostics.js";
import { DownloadApiHealth } from "./download-api-health.js";
import {
  inspectDownloadCache,
  type DownloadCacheInspection
} from "./download-session.js";
import { cancelActiveDownloadsForAccount } from "./downloader.js";
import {
  PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES,
  PersistentJobStore,
  type EnqueuePersistentJob,
  type PersistentJobKind
} from "./job-store.js";
import { logManager } from "./logger.js";
import { tempDir } from "./paths.js";
import {
  applyQualityArtifactProfile,
  buildQualityArtifactKey,
  normalizeQualityArtifactProfile,
  type QualityArtifactProfile
} from "./quality-artifact.js";
import {
  TaskQueue,
  type QueueBoardItem
} from "./queue.js";
import {
  recoveryIssueDisposition,
  type RecoveryIssueAction,
  type RecoveryIssueActionId,
  type RecoveryIssueKind
} from "./recovery-policy.js";
import { createAccessFailureHandlers } from './scheduler/access-failure-handlers.js';
import { createAccessProbes } from './scheduler/access-probes.js';
import { normalizeAccessProbeIntents, type AccessProbeIntent } from './scheduler/access-rules.js';
import { createAccountRetirement } from './scheduler/account-retirement.js';
import { createArchiveProofRecovery } from './scheduler/archive-proof-recovery.js';
import { createBackupEnqueue, type BackupEnqueueOptions } from './scheduler/backup-enqueue.js';
import { inspectConflictCandidateEligibility } from './scheduler/conflict-candidate-eligibility.js';
import { createConflictCandidateRecovery } from './scheduler/conflict-candidate-recovery.js';
import { createConflictResolution } from './scheduler/conflict-resolution.js';
import { createDownloadCompletionHandler } from './scheduler/download-completion.js';
import { createDownloadFailureHandler } from './scheduler/download-failure.js';
import { createDownloadRecoveryActions } from './scheduler/download-recovery-actions.js';
import { createDownloadTaskFactory } from './scheduler/download-task-factory.js';
import { createEncodingRecoveryHandlers } from './scheduler/encoding-recovery-handlers.js';
import { createEncodingRecovery } from './scheduler/encoding-recovery.js';
import { createFavoriteScan } from './scheduler/favorite-scan.js';
import { createLegacyCacheRecovery } from './scheduler/legacy-cache-recovery.js';
import { createLegacyDownloadRecovery } from './scheduler/legacy-download-recovery.js';
import { createLegacyQualityMigration } from './scheduler/legacy-quality-migration.js';
import { createLegacyRecoveryProjection } from './scheduler/legacy-recovery-projection.js';
import { createLocalCapacity } from './scheduler/local-capacity.js';
import { buildLocalCleanupPlan as buildCleanupPlan } from './scheduler/local-cleanup-plan.js';
import { createLocalCleanupStorage } from './scheduler/local-cleanup-storage.js';
import { createLocalCleanup } from './scheduler/local-cleanup.js';
import { createPollingSchedule } from "./scheduler/polling.js";
import { projectQualityUpgradeState } from './scheduler/quality-projection.js';
import { createQualityRecovery } from './scheduler/quality-recovery.js';
import {
  filterArchiveDeletionTargets as filterQualityArchiveDeletionTargets,
  qualityDownloadStageLabel,
  qualityTargetsFromPayload,
  serializeQualityUpgrade
} from './scheduler/quality-rules.js';
import { buildQualityUpgradeTask as buildQualityUpgradeTaskFactory } from './scheduler/quality-task-factory.js';
import { createQueueBoardProjection } from './scheduler/queue-board-projection.js';
import { createQueueEventBindings } from "./scheduler/queue-events.js";
import { projectQueueSnapshot } from "./scheduler/queue-projection.js";
import { waitForQuiescence } from "./scheduler/quiescence.js";
import { createRecoveryAbandonment } from './scheduler/recovery-abandonment.js';
import { createRecoveryActions } from './scheduler/recovery-actions.js';
import { createRecoveryAssessmentService } from './scheduler/recovery-assessment.js';
import { createRecoveryAutomation } from './scheduler/recovery-automation.js';
import { parseEncodingRetryContext } from './scheduler/recovery-context.js';
import type { RecoveryAssessment } from './scheduler/recovery-contracts.js';
import { createRecoveryFinalization } from './scheduler/recovery-finalization.js';
import { downloadRecoveryTargets } from './scheduler/recovery-identifiers.js';
import { createRecoveryIssueProjection } from './scheduler/recovery-issue-projection.js';
import { inspectRecoveryLocalFiles } from './scheduler/recovery-local-files.js';
import {
  isVerifiedArchiveProofForRecovery,
  observedSameSizeProof,
  parseExistingArchiveProof,
  parseRecoveryAssessment,
  verifiedFilesFromRecovery,
} from './scheduler/recovery-projection.js';
import { createRecoveryWork } from './scheduler/recovery-work.js';
import { createRemoteScan } from './scheduler/remote-scan.js';
import { createRemoteVerificationIO } from './scheduler/remote-verification-io.js';
import { createRetirementTransfers } from './scheduler/retirement-transfers.js';
import {
  AUTOMATIC_QUALITY_RECOVERY_LIMIT,
  computeAutomaticQualityRecoveryDelayMs,
  computeDownloadStartDelayMs
} from "./scheduler/retry-policy.js";
import { createSourceDeletion } from './scheduler/source-deletion.js';
import { createStartupProbes } from './scheduler/startup-probes.js';
import { createStartupRecovery } from './scheduler/startup-recovery.js';
import { bindTaskLifecycleEvents } from './scheduler/task-event-bindings.js';
import { createTaskProgressHandlers } from './scheduler/task-progress.js';
import { createTransferRecoveryProjection } from './scheduler/transfer-recovery-projection.js';
import { createUploadCompletionHandler } from './scheduler/upload-completion.js';
import { createUploadFailureHandler } from './scheduler/upload-failure.js';
import { createUploadResumeService } from './scheduler/upload-resume.js';
import { createUploadTaskFactory } from './scheduler/upload-task-factory.js';
import type { RecoveryUploadItem } from './scheduler/upload-work.js';
import { createVerificationHandlers } from './scheduler/verification-handlers.js';
import { buildUploadVerificationJobs } from './scheduler/verification-jobs.js';
import { commitVerifiedTransfer as commitVerifiedTransferTransaction } from "./scheduler/verified-transfer.js";
import { FavoriteRelation, MANUAL_ARCHIVE_FOLDER_TITLE, MANUAL_ARCHIVE_MEDIA_ID, StateManager, type LocalCleanupPlan, type RemoteFileRecord, type SourceAvailabilityReason } from "./state.js";
import {
  DownloadTask,
  QualityUpgradeCleanupTask,
  QualityUpgradeDownloadTask,
  QualityUpgradeReplaceTask,
  QualityUpgradeTask,
  QualityUpgradeUploadReplaceTask,
  UploadTarget,
  UploadTask,
  UploadVerificationTask,
  type EncodingRetryContext,
  type QualityEncodingOverride,
  type QualityUpgradeTarget
} from "./tasks.js";
import { TransferSessionStore } from "./transfer-session.js";
import {
  classifyUploadError,
  REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE,
  sanitizeUploadText,
  UploadCircuitBreaker,
  type UploadFailureInfo
} from "./upload-health.js";
import type { ExistingArchiveProof } from "./upload-preflight.js";
import { inspectRemoteFileSize, listRemoteDir, resolveRemotePath, verifyRemoteFiles } from "./uploader.js";
import { BiliUser, UserStore } from "./users.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
export type { AccessProbeIntent } from './scheduler/access-rules.js';
export type { RecoveryIssue } from './scheduler/recovery-contracts.js';
export {
computeAutomaticQualityRecoveryDelayMs, computeAvailabilityUnavailableDelayMs, computeAvailabilityUnknownDelayMs, computeChargingRecheckDelayMs,
computeChargingTransientDelayMs, computeDownloadStartDelayMs, computeLocalCleanupRetryDelayMs, computeQualityCleanupRetryDelayMs, computeUploadSessionRetryDelayMs, computeUploadVerificationTiming
} from "./scheduler/retry-policy.js";

export { recoveryIssueDisposition };
export type { RecoveryIssueAction, RecoveryIssueActionId, RecoveryIssueKind };

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function cooldownMs() {
  return (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
}

interface SchedulerDependencies {
  /** Application bootstrap owns recovery ordering and opens admission only in start(). */
  deferAdmissionUntilStart?: boolean;
  videoAccessProbe?: (cookie: BiliUser["cookie"], bvid: string) => Promise<VideoPageSnapshotResult>;
  cacheInspector?: (rootDir: string, concurrency?: number) => Promise<DownloadCacheInspection>;
  remoteFileInspector?: typeof inspectRemoteFileSize;
  legacyTempDir?: string;
  now?: () => number;
  random?: () => number;
}

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;

function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask
    || task instanceof QualityUpgradeReplaceTask
    || task instanceof QualityUpgradeCleanupTask;
}

export class SyncScheduler {
  private readonly queueEvents = createQueueEventBindings();
  private readonly polling: ReturnType<typeof createPollingSchedule>;
  private running = false;
  private readonly activeSyncUsers = new Set<string>();
  private acceptingJobs = true;
  private configStore: Pick<ConfigStore, 'get'>;
  private userStore: Pick<UserStore, 'list' | 'getById' | 'updatePartial'>;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownStarted = false;
  private shutdownCompleted = false;
  private runtimeInitialized = false;
  private storageRebindResumeAdmission: boolean | null = null;
  private runtimeGeneration = 0;
  private projectionRefreshTimer: NodeJS.Timeout | null = null;
  private stateManager: StateManager;

  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  private verificationQueue: TaskQueue;
  private readonly jobStore: PersistentJobStore;
  private readonly transferSessions: TransferSessionStore;
  private readonly leaseOwner = crypto.randomUUID();
  private jobDispatchTimer: NodeJS.Timeout | null = null;
  private leaseHeartbeatTimer: NodeJS.Timeout | null = null;
  private accessProbePromise: Promise<void> | null = null;
  private accessProbeJobId: string | null = null;
  private readonly legacyCacheRecovery: ReturnType<typeof createLegacyCacheRecovery>;
  private readonly staleActiveBackupMs = 20 * 60_000;
  private readonly remoteVerificationIO = createRemoteVerificationIO({
    list:remotePath=>listRemoteDir(this.configStore.get(),remotePath),
    now:()=>this.now(),sleep:delay,
  });
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
  private schedulerProgress: SchedulerSnapshot | null = null;
  private lastSchedulerError = "";
  private readonly favoriteScan: ReturnType<typeof createFavoriteScan>;
  private readonly localCleanup: ReturnType<typeof createLocalCleanup>;
  private readonly projectionRefreshIntervalMs = 10_000;
  private readonly remoteScan: ReturnType<typeof createRemoteScan>;
  private readonly accessProbes: ReturnType<typeof createAccessProbes>;
  private readonly localCapacity: ReturnType<typeof createLocalCapacity>;
  private readonly persistentJobWakeMinMs = 1_000;
  private readonly videoAccessProbe: NonNullable<SchedulerDependencies["videoAccessProbe"]>;
  private readonly cacheInspector: NonNullable<SchedulerDependencies["cacheInspector"]>;
  private readonly remoteFileInspector: NonNullable<SchedulerDependencies["remoteFileInspector"]>;
  private readonly legacyTempDir: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly accountRetirement: ReturnType<typeof createAccountRetirement>;
  private readonly qualityArtifactCleanupLocks = new Set<string>();
  private readonly recoveryAutomation: ReturnType<typeof createRecoveryAutomation>;
  private readonly transferRecoveryProjection: ReturnType<typeof createTransferRecoveryProjection>;
  private readonly recoveryWork = createRecoveryWork<Awaited<ReturnType<ReturnType<typeof createRecoveryAssessmentService>['assess']>>>();

  private cycleContext: SyncCycleStats | null = null;

  constructor(configStore: Pick<ConfigStore, 'get'>, userStore: Pick<UserStore, 'list' | 'getById' | 'updatePartial'>, stateManager: StateManager, dependencies: SchedulerDependencies = {}) {
    this.acceptingJobs = !dependencies.deferAdmissionUntilStart;
    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;
    this.videoAccessProbe = dependencies.videoAccessProbe || getVideoPageSnapshot;
    this.cacheInspector = dependencies.cacheInspector || inspectDownloadCache;
    this.remoteFileInspector = dependencies.remoteFileInspector || inspectRemoteFileSize;
    this.legacyTempDir = dependencies.legacyTempDir || tempDir;
    this.now = dependencies.now || Date.now;
    this.random = dependencies.random || Math.random;
    this.polling = createPollingSchedule({ now: this.now, random: this.random, run: () => { void this.tick(); } });
    this.jobStore = new PersistentJobStore(this.stateManager.getDatabase(), {normalizeRecovery:false, now:this.now});
    this.transferSessions = new TransferSessionStore(this.stateManager.getDatabase());
    this.legacyCacheRecovery = createLegacyCacheRecovery({
      stateManager: this.stateManager, legacyTempDir: this.legacyTempDir,
      canRun: () => this.acceptingJobs, generation: () => this.runtimeGeneration,
      getMeta: key => this.stateManager.getDatabase().getMeta(key),
      setMeta: (key, value) => this.stateManager.getDatabase().setMeta(key, value),
      findBestRelationForBvid: this.findBestRelationForBvid.bind(this),
      enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      wake: () => { this.downloadQueue.poke(); this.dispatchPersistentJobs(); },
    });
    this.transferRecoveryProjection = createTransferRecoveryProjection({
      jobStore: this.jobStore, transferSessions: this.transferSessions, stateManager: this.stateManager,
      configStore: this.configStore, now: () => this.now(),
      captureExistingArchiveProof: (userId, mediaId, bvid) => this.captureExistingArchiveProof(userId, mediaId, bvid),
    });

    this.remoteScan = createRemoteScan({
      config: this.configStore, state: this.stateManager, io: this.remoteVerificationIO,
      random: this.random, sleep: delay, generation: () => this.runtimeGeneration,
      canContinue: () => !this.shutdownStarted && !this.cleanupLocked && !this.pathMigrationLocked && !this.archiveDeletionLocked,
      verify: verifyRemoteFiles, resolve: relation => this.resolveRelation(relation),
      bestRelation: bvid => this.findBestRelationForBvid(bvid),
      remotePath: (user, mediaId, title, config) => this.resolveRelationRemotePath(user, mediaId, title, config),
      enqueue: (user, mediaId, title, bvid) => this.enqueueIfNeeded(user, mediaId, title, bvid),
      progress: patch => this.updateSchedulerProgress(patch),
    });
    this.accessProbes = createAccessProbes({
      users: this.userStore, state: this.stateManager, jobs: this.jobStore, owner: this.leaseOwner,
      now: this.now, random: this.random, generation: () => this.runtimeGeneration,
      canContinue: () => !this.shutdownStarted && !this.cleanupLocked && !this.pathMigrationLocked && !this.archiveDeletionLocked,
      eligible: user => this.isUserSyncEligible(user), inspect: this.videoAccessProbe,
      resolve: relation => this.resolveRelation(relation),
      enqueue: (user, mediaId, title, bvid, options) => this.enqueueIfNeeded(user, mediaId, title, bvid, options),
      prepareCharging: (user, mediaId, title, bvid, options) => this.backupEnqueue().prepareAfterAccessCheck(user, mediaId, title, bvid, options),
    });
    this.localCapacity = createLocalCapacity({
      limitGB: () => this.configStore.get().localCacheLimitGB,
      inspect: () => this.cacheInspector(tempDir, 4), now: this.now,
      generation: () => this.runtimeGeneration, canRun: () => this.acceptingJobs,
      wake: () => { this.downloadQueue.poke(); this.dispatchPersistentJobs(); },
      failed: error => console.warn(`[Scheduler] Failed to refresh local cache state: ${safeErrorSummary(error)}`),
    });
    this.favoriteScan = createFavoriteScan({
      deletions: { folder: (u,m) => this.stateManager.getDatabase().isArchiveFolderDeletionActive(u,m), source: (u,m,b) => this.stateManager.getDatabase().isArchiveSourceDeletionActive(u,m,b) },
      state: this.stateManager, users: this.userStore, now: this.now, random: this.random, sleep: delay,
      generation: () => this.runtimeGeneration,
      canRun: () => this.acceptingJobs && !this.cleanupLocked && !this.pathMigrationLocked && !this.archiveDeletionLocked,
      listPage: listFavoriteItemsPage, refreshAuth: refreshUserAuth, resolveSelfVisible: resolveSelfVisibleFavoriteItem, cacheCover: queueCoverCache,
      progress: patch => this.updateSchedulerProgress(patch),
      recordCount: (fresh, queued) => { if (this.cycleContext) { this.cycleContext.newItems += fresh; this.cycleContext.queuedItems += queued; } },
      probe: (bvid, options) => this.enqueueAvailabilityProbe(bvid, options),
      enqueue: (user, mediaId, title, bvid) => this.enqueueIfNeeded(user, mediaId, title, bvid),
    });
    this.localCleanup = createLocalCleanup({
      storage: createLocalCleanupStorage(this.stateManager),
      canRun: () => this.acceptingJobs && !this.cleanupLocked && !this.pathMigrationLocked && !this.archiveDeletionLocked,
      generation: () => this.runtimeGeneration, now: () => this.now(),
      config: this.configStore, state: this.stateManager, jobs: this.jobStore, transfers: this.transferSessions,
      tempRoot: this.legacyTempDir, inspectRemote: this.remoteFileInspector,
      safeCandidate: dir => this.isSafeEncodingRetryDirectory(dir),
      refreshCapacity: force => { this.localCapacity.refreshAndWake(force); },
    });
    this.recoveryAutomation = createRecoveryAutomation({
      jobs: this.jobStore, now: () => this.now(),
      canRun: () => this.acceptingJobs && !this.cleanupLocked && !this.pathMigrationLocked && !this.archiveDeletionLocked,
      generation: () => this.runtimeGeneration,
      refreshProjection: () => this.refreshRecoveryProjection(),
      assess: id => this.assessManualRecoveryJob(id, { allowAutomatic: true }),
      reportError: error => console.error('[Recovery] Automatic review failed: ' + sanitizeUploadText(error)),
    });
    const config = this.configStore.get();
    this.uploadCircuit.restore(this.stateManager.getUploadCooldown() as any);
    this.downloadApiHealth.configure(config.bbdownApiMode || "web");
    const persistedApiCooldown = typeof (this.stateManager as any).getDownloadApiCooldown === "function"
      ? this.stateManager.getDownloadApiCooldown()
      : null;
    this.downloadApiHealth.restore(persistedApiCooldown);
    this.downloadQueue = new TaskQueue(config.concurrentDownloads || 1, this.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit));
    this.uploadQueue = new TaskQueue(config.concurrentUploads || 2, this.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit));
    this.verificationQueue = new TaskQueue(
      Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)),
      this.queueHighWater(config.remoteVerifyConcurrency || 3, config.queuePrefetchLimit)
    );
    this.accountRetirement = createAccountRetirement({
      jobStore: this.jobStore, stateManager: this.stateManager, userStore: this.userStore, downloadQueue: this.downloadQueue,
      listRelationsForUser: userId => this.stateManager.getDatabase().listRelationsForUser(userId),
      cancelDownloads: cancelActiveDownloadsForAccount,
      snapshotRetirementTargets: this.snapshotRetirementTargets.bind(this),
      queueCompletedRetirementUpload: this.queueCompletedRetirementUpload.bind(this),
      findCompletedQualitySession: this.findCompletedQualitySession.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this), enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      wakeChargingAccessProbes: this.wakeChargingAccessProbes.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(), generation: () => this.runtimeGeneration, now: () => this.now(),
    });
    this.downloadQueue.setStartGate((task) => {
      if (!(task instanceof DownloadTask) && !(task instanceof QualityUpgradeDownloadTask)) return false;
      return this.canStartDownloadTask(task);
    });
    this.uploadQueue.setStartGate((task) => this.acceptingJobs && !this.cleanupLocked && !this.pathMigrationLocked
      && !this.isArchiveDeletionTargetBlocked(task)
      && this.uploadCircuit.allowUploadStart(this.uploadTaskKey(task)));
    this.verificationQueue.setStartGate((task) => this.acceptingJobs && !this.cleanupLocked && !this.pathMigrationLocked
      && !this.isArchiveDeletionTargetBlocked(task)
      && this.uploadCircuit.allowUploadStart(`verify:${(task as any).bvid || task.id}`));
    const progress = this.bindTaskLifecycleEvents();

    this.queueEvents.on(this.downloadQueue, "taskError", createDownloadFailureHandler({
      jobStore: this.jobStore, stateManager: this.stateManager, configStore: this.configStore,
      retirementAbortedJobIds: this.accountRetirement.abortedJobs, leaseOwner: this.leaseOwner, now: () => this.now(),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      handleSourceUnavailableTask: this.handleSourceUnavailableTask.bind(this),
      handleEncodingRetryDownloadError: this.handleEncodingRetryDownloadError.bind(this),
      handleChargingRestrictedTask: this.handleChargingRestrictedTask.bind(this),
      handleDownloadApiFailure: this.handleDownloadApiFailure.bind(this),
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      queueAutomaticQualityRecovery: this.queueAutomaticQualityRecovery.bind(this),
      collectUploadTargets: this.collectUploadTargets.bind(this),
      makeSingleTarget: this.makeSingleTarget.bind(this),
    }));
    this.queueEvents.on(this.downloadQueue, "taskRetry", progress.downloadRetry);
    this.queueEvents.on(this.uploadQueue, "taskError", createUploadFailureHandler({
      jobStore: this.jobStore, uploadCircuit: this.uploadCircuit, downloadQueue: this.downloadQueue,
      leaseOwner: this.leaseOwner, now: () => this.now(), random: () => this.random(),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      handleEncodingRetryUploadError: this.handleEncodingRetryUploadError.bind(this),
      recordUploadFailure: this.recordUploadFailure.bind(this),
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      queueAutomaticQualityRecovery: this.queueAutomaticQualityRecovery.bind(this),
      markUploadTaskFailed: this.markUploadTaskFailed.bind(this),
      formatUploadFailureLog: this.formatUploadFailureLog.bind(this),
      startConflictCandidate: this.startConflictCandidate.bind(this),
    }));
    this.queueEvents.on(this.uploadQueue, "taskRetry", progress.uploadRetry);

    this.queueEvents.on(this.downloadQueue, "taskCompleted", createDownloadCompletionHandler({
      jobStore: this.jobStore, configStore: this.configStore, leaseOwner: this.leaseOwner,
      now: () => this.now(),
      handleSourceUnavailableTask: (task, error) => this.handleSourceUnavailableTask(task, error),
      isEncodingRetryParentActive: context => this.isEncodingRetryParentActive(context),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      refreshLocalCacheState: () => { this.refreshLocalCacheState(); },
      syncQualityUpgradeControl: (task, status) => this.syncQualityUpgradeControl(task, status),
      filterArchiveDeletionTargets: (bvid, targets) => this.filterArchiveDeletionTargets(bvid, targets),
      collectUploadTargets: (bvid, targets) => this.collectUploadTargets(bvid, targets),
      makeSingleTarget: task => this.makeSingleTarget(task),
      finishEncodingRetryFailure: (bvid, context, reason, status, childId, kind, patch) => this.finishEncodingRetryFailure(bvid, context, reason, status, childId, kind, patch),
      buildPersistentUploadJob: item => this.buildPersistentUploadJob(item),
      queueUploadWork: (item, dispatch) => this.queueUploadWork(item, dispatch),
      historySnapshotSegment: value => this.historySnapshotSegment(value),
      localCleanup: this.localCleanup,
    }));

    this.queueEvents.on(this.uploadQueue, "taskCompleted", createUploadCompletionHandler({
      jobStore: this.jobStore, stateManager: this.stateManager, configStore: this.configStore,
      uploadCircuit: this.uploadCircuit, downloadQueue: this.downloadQueue, localCleanup: this.localCleanup,
      leaseOwner: this.leaseOwner, now: () => this.now(),
      isEncodingRetryParentActive: this.isEncodingRetryParentActive.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      uploadTaskKey: this.uploadTaskKey.bind(this),
      clearUploadProbeTimer: this.clearUploadProbeTimer.bind(this),
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      refreshLocalCacheState: this.refreshLocalCacheState.bind(this),
      finishEncodingRetryFailure: this.finishEncodingRetryFailure.bind(this),
      supersedeUploadTaskSession: this.supersedeUploadTaskSession.bind(this),
      afterEncodingRetryCommitted: this.afterEncodingRetryCommitted.bind(this),
      restoreConflictCandidateExistingArchive: this.restoreConflictCandidateExistingArchive.bind(this),
      commitVerifiedTransfer: this.commitVerifiedTransfer.bind(this),
      buildUploadVerificationJobs: this.buildUploadVerificationJobs.bind(this),
      enqueueUploadVerificationJobs: this.enqueueUploadVerificationJobs.bind(this),
    }));

  }

  private bindTaskLifecycleEvents() {
    const progress = createTaskProgressHandlers({
      jobs: this.jobStore, leaseOwner: this.leaseOwner,
      markDownloadStarted: () => this.markDownloadTaskStarted(),
      syncQuality: (task, status) => this.syncQualityUpgradeControl(task, status),
      downloadFailure: (task, error) => this.handleDownloadApiFailure(task, error),
      uploadFailure: (task, error) => this.recordUploadFailure(task, error),
      formatUploadFailure: (task, failure) => this.formatUploadFailureLog(task, failure),
    });
    bindTaskLifecycleEvents(
      this.queueEvents.on.bind(this.queueEvents),
      { download: this.downloadQueue, upload: this.uploadQueue, verification: this.verificationQueue },
      {
        downloadStart: progress.downloadStart,
        uploadStart: progress.uploadStart,
        uploadSettled: () => { this.dispatchPersistentJobs(); this.downloadQueue.poke(); },
        downloadSettled: () => { this.dispatchPersistentJobs(); },
        verificationStart: progress.verificationStart,
        verificationCompleted: task => this.handleUploadVerificationCompleted(task),
        verificationError: (task, error) => this.handleUploadVerificationError(task, error),
        verificationSettled: () => { this.dispatchPersistentJobs(); },
      },
    );
    return progress;
  }


  private initializeRuntime() {
    if (this.shutdownStarted) return;
    if (!this.runtimeInitialized) {
      this.runtimeInitialized = true;
      if (this.configStore.get().bbdownApiMode === "app") this.stateManager.clearDownloadApiCooldown();
      this.localCapacity.refreshAndWake(true);
      this.refreshRecoveryProjection(true);
      if (this.uploadCircuit.getSnapshot().state !== "closed") this.scheduleUploadProbe();
    }
    if (!this.projectionRefreshTimer) {
      this.projectionRefreshTimer = setInterval(() => {
        if (!this.acceptingJobs || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked) return;
        this.refreshRecoveryProjection();
        this.localCapacity.refreshAndWake();
      }, this.projectionRefreshIntervalMs);
      this.projectionRefreshTimer.unref?.();
    }
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
    if (this.shutdownCompleted) return;
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
    return buildUploadVerificationJobs(task, files, pendingChecks);
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
  private buildDownloadTask(job: import('./database.js').PersistentJobRecord) {
    return createDownloadTaskFactory({
      configStore: this.configStore, userStore: this.userStore, stateManager: this.stateManager,
      generation: () => this.runtimeGeneration,
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      resolveRelation: this.resolveRelation.bind(this), resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this),
      handleDownloadApiReady: this.handleDownloadApiReady.bind(this),
    }).build(job);
  }

  private qualityTargetsFromPayload(payload: any, fallback: QualityUpgradeTarget[] = []) {
    return qualityTargetsFromPayload(payload, fallback);
  }

  private filterArchiveDeletionTargets<T extends { userId?: unknown; mediaId?: unknown }>(
    bvid: string,
    targets: T[],
  ) {
    return filterQualityArchiveDeletionTargets(this.stateManager, bvid, targets);
  }

  private qualityDownloadStageLabel(task: QualityUpgradeTask, label: string) {
    return qualityDownloadStageLabel(task, label);
  }

  private serializeQualityUpgrade(
    task: QualityUpgradeTask,
    target: QualityUpgradeTarget = task.target,
    targets: QualityUpgradeTarget[] = task.targets
  ) {
    return serializeQualityUpgrade(task, target, targets);
  }

  private buildQualityUpgradeTask(job: any) {
    return buildQualityUpgradeTaskFactory(job, {
      config: this.configStore,
      users: this.userStore,
      state: this.stateManager,
      jobs: this.jobStore,
      isUserSyncEligible: user => this.isUserSyncEligible(user),
      leaseOwner: this.leaseOwner,
      now: this.now,
      qualityArtifactCleanupLocks: this.qualityArtifactCleanupLocks,
      refreshLocalCacheState: () => this.refreshLocalCacheState(),
      pokeDownloadQueue: () => this.downloadQueue.poke(),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      reconcileObsoleteVerifiedArchiveRecoveries: (limit, filter, concurrency) => this.reconcileObsoleteVerifiedArchiveRecoveries(limit, filter, concurrency),
    });
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
      availabilityReason?: SourceAvailabilityReason;
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
    if (this.accessProbes.users(bvid, "", new Set(), charging).length === 0) {
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

  private accessFailureHandlers() {
    return createAccessFailureHandlers({
      stateManager: this.stateManager, jobStore: this.jobStore, leaseOwner: this.leaseOwner,
      now: () => this.now(), random: this.random, syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      serializeQualityUpgrade: this.serializeQualityUpgrade.bind(this),
      enqueueAvailabilityProbe: this.enqueueAvailabilityProbe.bind(this),
      enqueueChargingAccessProbe: this.enqueueChargingAccessProbe.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
  }

  private handleSourceUnavailableTask(task: DownloadTask | QualityUpgradeDownloadTask, error: { availabilityReason?: unknown } = {}) {
    return this.accessFailureHandlers().handleSourceUnavailableTask(task, error);
  }

  private handleChargingRestrictedTask(task: DownloadTask | QualityUpgradeDownloadTask, error: unknown) {
    return this.accessFailureHandlers().handleChargingRestrictedTask(task, error);
  }
  private runChargingAccessProbe(job: import('./database.js').PersistentJobRecord) { return this.accessProbes.charging(job); }

  private dispatchChargingAccessProbe() {
    if (this.accessProbePromise || !this.acceptingJobs) return;
    const [job] = this.jobStore.claimDue(["access_probe"], 1, this.leaseOwner, 5 * 60_000, this.now());
    if (!job) return;
    if (!this.jobStore.markRunning(job.id, this.leaseOwner, 5 * 60_000)) return;
    this.accessProbeJobId = job.id;
    const generation = this.runtimeGeneration;
    this.accessProbePromise = this.runChargingAccessProbe(job).catch((error: unknown) => {
      if (generation !== this.runtimeGeneration || this.shutdownStarted) return;
      const current = this.jobStore.findById(job.id);
      if (!current || current.leaseOwner !== this.leaseOwner || current.attempts !== job.attempts) return;
      this.accessProbes.failed(job, error);
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
    return buildCleanupPlan(bvid, localDir, remoteFiles, reason, this.now, options);
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
    commitVerifiedTransferTransaction({
      state:this.stateManager, sessions:this.transferSessions, jobs:this.jobStore,
      now:this.now, leaseOwner:this.leaseOwner,
    }, {
      bvid:task.bvid, userId:task.userId, mediaId:task.mediaId, jobId:task.persistentJobId,
      result, partialBackup, historyOnly, encodingRetry, cleanupPlan,
    });
  }

  private verificationHandlers() {
    return createVerificationHandlers({
      jobStore: this.jobStore, stateManager: this.stateManager, transferSessions: this.transferSessions,
      uploadCircuit: this.uploadCircuit, localCleanup: this.localCleanup, leaseOwner: this.leaseOwner,
      isEncodingRetryParentActive: this.isEncodingRetryParentActive.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      commitVerifiedTransfer: this.commitVerifiedTransfer.bind(this),
      afterEncodingRetryCommitted: this.afterEncodingRetryCommitted.bind(this),
      finishEncodingRetryFailure: this.finishEncodingRetryFailure.bind(this),
      schedulePersistentJobWake: this.schedulePersistentJobWake.bind(this),
      scheduleUploadProbe: this.scheduleUploadProbe.bind(this),
      queueUploadWork: this.queueUploadWork.bind(this),
    });
  }

  private handleUploadVerificationCompleted(task: UploadVerificationTask) {
    this.verificationHandlers().completed(task);
  }

  private handleUploadVerificationError(task: UploadVerificationTask, error: unknown) {
    this.verificationHandlers().failed(task, error);
  }

  previewLocalArchiveRelease(bvid: string) { return this.localCleanup.preview(bvid); }
  requestLocalArchiveRelease(bvid: string, releaseId: string, confirmation: string) {
    return this.localCleanup.release(bvid, releaseId, confirmation);
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

  private encodingRecoveryHandlers() {
    return createEncodingRecoveryHandlers({
      configStore: this.configStore, stateManager: this.stateManager, jobStore: this.jobStore,
      leaseOwner: this.leaseOwner, now: () => this.now(), cleanup: (bvid, dir) => this.localCleanup.request(bvid, dir),
      uploadHealth: () => this.uploadCircuit.getSnapshot(),
      handleDownloadApiFailure: this.handleDownloadApiFailure.bind(this), recordUploadFailure: this.recordUploadFailure.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
  }

  private isEncodingRetryParentActive(context: EncodingRetryContext) {
    return this.encodingRecoveryHandlers().isEncodingRetryParentActive(context);
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
    return this.encodingRecoveryHandlers().finishEncodingRetryFailure(bvid, context, reason, remoteStatus, childJobId, assessmentKind, payloadPatch);
  }

  private afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext) {
    return this.encodingRecoveryHandlers().afterEncodingRetryCommitted(bvid, context);
  }

  private handleEncodingRetryDownloadError(task: DownloadTask, error: unknown) {
    return this.encodingRecoveryHandlers().handleEncodingRetryDownloadError(task, error);
  }

  private handleEncodingRetryUploadError(task: UploadTask, error: unknown) {
    return this.encodingRecoveryHandlers().handleEncodingRetryUploadError(task, error);
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

  private archiveProofRecovery() {
    return createArchiveProofRecovery({
      stateManager: this.stateManager, jobStore: this.jobStore, transferSessions: this.transferSessions,
      configStore: this.configStore, recoveryWork: this.recoveryWork, remoteFileInspector: this.remoteFileInspector,
      canRun: () => this.acceptingJobs, generation: () => this.runtimeGeneration, now: () => this.now(),
      cleanup: (bvid, dir) => this.localCleanup.request(bvid, dir),
    });
  }

  private captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    return this.archiveProofRecovery().captureExistingArchiveProof(userId, mediaId, bvid);
  }

  private isPlainObsoleteArchiveRecovery(job: import('./database.js').PersistentJobRecord) {
    return this.archiveProofRecovery().isPlainObsoleteArchiveRecovery(job);
  }

  private async confirmVerifiedArchiveProofForRecovery(job: import('./database.js').PersistentJobRecord, proof: ExistingArchiveProof) {
    return this.archiveProofRecovery().confirmVerifiedArchiveProofForRecovery(job, proof);
  }

  private async reconcileObsoleteVerifiedArchiveRecoveries(limit = 1000, scope?: { bvid?: string; userId?: string; mediaId?: number }, concurrency = 2) {
    return this.archiveProofRecovery().reconcileObsoleteVerifiedArchiveRecoveries(limit, scope, concurrency);
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
    return createUploadTaskFactory({
      stateManager: this.stateManager, configStore: this.configStore, jobStore: this.jobStore,
      transferSessions: this.transferSessions, leaseOwner: this.leaseOwner, generation: () => this.runtimeGeneration,
      captureExistingArchiveProof: this.captureExistingArchiveProof.bind(this),
      legacyConflictSideEffectsStarted: this.legacyConflictSideEffectsStarted.bind(this),
      restoreConflictCandidateExistingArchive: this.restoreConflictCandidateExistingArchive.bind(this),
    }).build(item);
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

  private legacyRecoveryProjection() {
    return createLegacyRecoveryProjection({
      jobStore: this.jobStore, userStore: this.userStore, configStore: this.configStore,
      database: () => this.stateManager.getDatabase(), resolveRelation: this.resolveRelation.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this),
    });
  }

  private reconcileLegacyDownloadRecoveryJobs() {
    return this.legacyRecoveryProjection().reconcileLegacyDownloadRecoveryJobs();
  }

  private recoveryAssessment(payload: any): RecoveryAssessment | null {
    return parseRecoveryAssessment(payload);
  }

  private inspectRecoveryLocalFiles(job: import('./database.js').PersistentJobRecord) {
    return inspectRecoveryLocalFiles(this.transferSessions, job);
  }

  private inspectConflictCandidateEligibility(job: import('./database.js').PersistentJobRecord, assessment: RecoveryAssessment | null) {
    return inspectConflictCandidateEligibility(this.transferSessions, job, assessment);
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
    return verifiedFilesFromRecovery(job.payload, files);
  }

  private persistedExistingArchiveProof(payload: any): ExistingArchiveProof | null {
    return parseExistingArchiveProof(payload);
  }

  private observedSameSizeProof(job: any, assessment: RecoveryAssessment | null): ExistingArchiveProof | undefined {
    return observedSameSizeProof(job.payload, assessment, this.transferSessions, this.now);
  }

  private isVerifiedArchiveProofForRecovery(job: any, proof: ExistingArchiveProof) {
    return isVerifiedArchiveProofForRecovery(job?.payload, proof);
  }

  private recoveryFinalization() {
    return createRecoveryFinalization({
      stateManager: this.stateManager, jobStore: this.jobStore, transferSessions: this.transferSessions,
      resolveRelation: this.resolveRelation.bind(this), prepareDownload: this.backupEnqueue().prepareRecoveryDownload,
      verifiedFilesFromRecovery: this.verifiedFilesFromRecovery.bind(this), buildLocalCleanupPlan: this.buildLocalCleanupPlan.bind(this),
      cleanup: (bvid, dir) => this.localCleanup.request(bvid, dir), now: () => this.now(),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
  }

  private finalizeRetainedArchiveRecovery(job: import('./database.js').PersistentJobRecord, proof: ExistingArchiveProof, options: { allowResumeOnly?: boolean } = {}) {
    return this.recoveryFinalization().finalizeRetainedArchiveRecovery(job, proof, options);
  }

  private finalizeVerifiedRecovery(job: import('./database.js').PersistentJobRecord, session: NonNullable<ReturnType<TransferSessionStore["get"]>>, files: ReturnType<TransferSessionStore["listFiles"]>) {
    return this.recoveryFinalization().finalizeVerifiedRecovery(job, session, files);
  }

  private queueFreshDownloadForRecovery(job: import('./database.js').PersistentJobRecord, localStatus: RecoveryAssessment["localStatus"], userInitiated = false) {
    return this.recoveryFinalization().queueFreshDownloadForRecovery(job, localStatus, userInitiated);
  }

  private assessManualRecoveryJob(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    return this.recoveryWork.run(jobId, () => this.assessManualRecoveryJobOnce(jobId, options));
  }

  private assessManualRecoveryJobOnce(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    return createRecoveryAssessmentService({
      jobStore: this.jobStore, transferSessions: this.transferSessions, configStore: this.configStore,
      recoveryJobLocks: this.recoveryWork.locks, remoteFileInspector: this.remoteFileInspector,
      now: () => this.now(),
      atomic: work => this.stateManager.getDatabase().db.transaction(work)(),
      recoveryAssessment: this.recoveryAssessment.bind(this),
      captureExistingArchiveProof: this.captureExistingArchiveProof.bind(this),
      isVerifiedArchiveProofForRecovery: this.isVerifiedArchiveProofForRecovery.bind(this),
      updateRecoveryAssessment: this.updateRecoveryAssessment.bind(this),
      inspectRecoveryLocalFiles: this.inspectRecoveryLocalFiles.bind(this),
      persistedExistingArchiveProof: this.persistedExistingArchiveProof.bind(this),
      finalizeRetainedArchiveRecovery: this.finalizeRetainedArchiveRecovery.bind(this),
      finalizeVerifiedRecovery: this.finalizeVerifiedRecovery.bind(this),
      startConflictCandidate: this.startConflictCandidate.bind(this),
      queueFreshDownloadForRecovery: this.queueFreshDownloadForRecovery.bind(this),
    }).assess(jobId, options);
  }

  runRecoveryAutomationNow() {
    return this.recoveryAutomation.run();
  }

  private recoveryIssueProjection() {
    return createRecoveryIssueProjection({
      jobs: this.jobStore,
      users: this.userStore,
      state: this.stateManager,
      uploadCircuit: this.uploadCircuit,
      now: this.now,
      isUserSyncEligible: user => this.isUserSyncEligible(user),
      manualRecoveryJobs: () => this.manualRecoveryJobs(),
      manualDownloadRecoveryJobs: () => this.manualDownloadRecoveryJobs(),
      recoveryAssessment: payload => this.recoveryAssessment(payload),
      inspectConflictCandidateEligibility: (job, assessment) => this.inspectConflictCandidateEligibility(job, assessment),
      persistedExistingArchiveProof: payload => this.persistedExistingArchiveProof(payload),
    });
  }

  private qualityEncodingRetryEligibility(job: import('./database.js').PersistentJobRecord) {
    return this.recoveryIssueProjection().qualityEncodingRetryEligibility(job);
  }

  private qualityQualityRetryEligibility(job: import('./database.js').PersistentJobRecord) {
    return this.recoveryIssueProjection().qualityQualityRetryEligibility(job);
  }

  getRecoveryIssues() {
    return this.recoveryIssueProjection().getRecoveryIssues();
  }

  getRecoveryIssueSnapshot() {
    return this.recoveryIssueProjection().getRecoveryIssueSnapshot();
  }

  private async resolveConflictCandidate(jobId: string, resolution: "keep_existing" | "use_candidate") {
    return createConflictResolution({
      jobs: this.jobStore, state: this.stateManager, sessions: this.transferSessions,
      config: this.configStore, locks: this.recoveryWork.locks, inspect: this.remoteFileInspector,
      proof: this.persistedExistingArchiveProof.bind(this), generation: () => this.runtimeGeneration,
      now: () => this.now(), cleanup: (bvid, localDir) => this.localCleanup.request(bvid, localDir),
      dispatch: () => this.dispatchPersistentJobs(), snapshot: this.getRecoveryIssueSnapshot.bind(this),
    }).resolve(jobId, resolution);
  }

  private abandonRecoveryJob(jobId: string, expectedKinds: string[]) {
    return createRecoveryAbandonment({
      jobStore: this.jobStore, transferSessions: this.transferSessions, stateManager: this.stateManager,
      recoveryWork: this.recoveryWork, now: () => this.now(),
      getRecoveryIssueSnapshot: this.getRecoveryIssueSnapshot.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    }).abandon(jobId, expectedKinds);
  }

  private async startEncodingRetry(jobId: string, priority: BBDownEncoding[], strict: boolean, requestedQuality?: string) {
    return createEncodingRecovery({
      jobStore: this.jobStore, configStore: this.configStore, userStore: this.userStore,
      stateManager: this.stateManager, locks: this.recoveryWork.locks, legacyTempDir: this.legacyTempDir,
      recoveryAssessment: this.recoveryAssessment.bind(this),
      inspectRecoveryLocalFiles: this.inspectRecoveryLocalFiles.bind(this),
      isSafeEncodingRetryDirectory: this.isSafeEncodingRetryDirectory.bind(this),
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    }).start(jobId, priority, strict, requestedQuality);
  }

  private startConflictCandidate(jobId: string, automatic = false) {
    return createConflictCandidateRecovery({
      jobStore: this.jobStore, recoveryWork: this.recoveryWork,
      recoveryAssessment: this.recoveryAssessment.bind(this),
      inspectConflictCandidateEligibility: this.inspectConflictCandidateEligibility.bind(this),
      observedSameSizeProof: this.observedSameSizeProof.bind(this),
      now: () => this.now(), dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    }).start(jobId, automatic);
  }

  private downloadRecoveryTargets(job: any) {
    return downloadRecoveryTargets(job);
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

  private async resolveLegacyDownloadFailureIssue(issueKey: string, action: RecoveryIssueActionId, options: { userId?: unknown }) {
    return createLegacyDownloadRecovery({
      database: () => this.stateManager.getDatabase(), stateManager: this.stateManager,
      jobStore: this.jobStore, userStore: this.userStore, recoveryWork: this.recoveryWork,
      videoAccessProbe: this.videoAccessProbe, generation: () => this.runtimeGeneration, now: () => this.now(),
      resolveRelation: this.resolveRelation.bind(this), isUserSyncEligible: this.isUserSyncEligible.bind(this),
      prepareBackup: this.backupEnqueue().prepareRecoveryDownload, dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      getRecoveryIssueSnapshot: this.getRecoveryIssueSnapshot.bind(this),
    }).resolve(issueKey, action, options);
  }

  private async resolveDownloadRecoveryIssue(
    jobId: string, action: RecoveryIssueActionId,
    options: { userId?: unknown; encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    return createDownloadRecoveryActions({
      jobStore: this.jobStore, configStore: this.configStore, userStore: this.userStore,
      generation: () => this.runtimeGeneration,
      recoveryWork: this.recoveryWork, videoAccessProbe: this.videoAccessProbe, now: () => this.now(),
      isUserSyncEligible: this.isUserSyncEligible.bind(this),
      resumeDownloadRecoveryRelations: this.resumeDownloadRecoveryRelations.bind(this),
      abandonRecoveryJob: this.abandonRecoveryJob.bind(this),
      resolveLegacyDownloadFailureIssue: this.resolveLegacyDownloadFailureIssue.bind(this),
      getRecoveryIssueSnapshot: this.getRecoveryIssueSnapshot.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    }).resolve(jobId, action, options);
  }

  private restartQualityRecovery(jobId: string, options: { priority?: BBDownEncoding[]; strictEncoding?: boolean; quality?: string }) {
    return createQualityRecovery({
      jobStore: this.jobStore, configStore: this.configStore, userStore: this.userStore, now: () => this.now(),
      qualityQualityRetryEligibility: this.qualityQualityRetryEligibility.bind(this),
      qualityEncodingRetryEligibility: this.qualityEncodingRetryEligibility.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      getRecoveryIssueSnapshot: this.getRecoveryIssueSnapshot.bind(this),
    }).restart(jobId, options);
  }

  async resolveRecoveryIssue(issueId: string, action: RecoveryIssueActionId, options: { encodingPriority?: unknown; strict?: unknown; userId?: unknown; quality?: unknown } = {}) {
    return createRecoveryActions({
      jobStore: this.jobStore, configStore: this.configStore, recoveryWork: this.recoveryWork,
      getRecoveryIssueSnapshot: this.getRecoveryIssueSnapshot.bind(this),
      resolveLegacyDownloadFailureIssue: this.resolveLegacyDownloadFailureIssue.bind(this),
      resolveDownloadRecoveryIssue: this.resolveDownloadRecoveryIssue.bind(this),
      abandonRecoveryJob: this.abandonRecoveryJob.bind(this),
      assessManualRecoveryJob: this.assessManualRecoveryJob.bind(this),
      recoverUploadJob: this.recoverUploadJob.bind(this),
      startConflictCandidate: this.startConflictCandidate.bind(this),
      recoveryAssessment: this.recoveryAssessment.bind(this),
      queueFreshDownloadForRecovery: this.queueFreshDownloadForRecovery.bind(this),
      startEncodingRetry: this.startEncodingRetry.bind(this),
      resolveConflictCandidate: this.resolveConflictCandidate.bind(this),
      restartQualityRecovery: this.restartQualityRecovery.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
    }).resolve(issueId, action, options);
  }

  async recoverUploadJob(jobId: string, allowReupload = false) {
    return createUploadResumeService({
      jobStore: this.jobStore, transferSessions: this.transferSessions, recoveryWork: this.recoveryWork,
      generation: () => this.runtimeGeneration,
      isPlainObsoleteArchiveRecovery: this.isPlainObsoleteArchiveRecovery.bind(this),
      captureExistingArchiveProof: this.captureExistingArchiveProof.bind(this),
      confirmVerifiedArchiveProofForRecovery: this.confirmVerifiedArchiveProofForRecovery.bind(this),
      finalizeRetainedArchiveRecovery: this.finalizeRetainedArchiveRecovery.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
    }).recover(jobId, allowReupload);
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

  refreshRecoveryProjection(force = false) {
    if (!this.acceptingJobs || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked) return;
    this.reconcileLegacyDownloadRecoveryJobs();
    this.reconcileTransferSessionRecoveryJobs(force);
  }

  private reconcileTransferSessionRecoveryJobs(force = false) {
    return this.transferRecoveryProjection.reconcile(force);
  }

  resumePersistedWorkOnStartup() {
    if (this.shutdownStarted) return;
    this.initializeRuntime();
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
    this.migrateLegacyQualityDownloadJobs();
    this.bootstrapLegacyFailureClassification();
    this.resumePersistedWork();
    this.startLegacyTempCacheRecovery();
    this.dispatchPersistentJobs();
  }

  private migrateLegacyQualityDownloadJobs() {
    return createLegacyQualityMigration({
      configStore: this.configStore, userStore: this.userStore, jobStore: this.jobStore,
      database: () => this.stateManager.getDatabase(),
    }).migrate();
  }

  private startupProbes() {
    return createStartupProbes({
      stateManager: this.stateManager, database: () => this.stateManager.getDatabase(), jobStore: this.jobStore,
      now: () => this.now(), enqueueChargingAccessProbe: this.enqueueChargingAccessProbe.bind(this),
      enqueueAvailabilityProbe: this.enqueueAvailabilityProbe.bind(this),
    });
  }

  private bootstrapLegacyFailureClassification() {
    return this.startupProbes().bootstrapLegacyFailureClassification();
  }

  private retirementTransfers() {
    return createRetirementTransfers({
      configStore: this.configStore, userStore: this.userStore, stateManager: this.stateManager,
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this), historySnapshotSegment: this.historySnapshotSegment.bind(this),
      queueUploadWork: this.queueUploadWork.bind(this), dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
  }

  private snapshotRetirementTargets(bvid: string) {
    return this.retirementTransfers().snapshotRetirementTargets(bvid);
  }

  private persistCompletedRetirementUploadJobs(bvid: string, local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>, targets: UploadTarget[]) {
    return this.retirementTransfers().persistCompletedRetirementUploadJobs(bvid, local, targets);
  }

  private queueCompletedRetirementUpload(bvid: string, local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>, targets: UploadTarget[]) {
    return this.retirementTransfers().queueCompletedRetirementUpload(bvid, local, targets);
  }

  private findCompletedQualitySession(job: import('./database.js').PersistentJobRecord) {
    return this.retirementTransfers().findCompletedQualitySession(job);
  }

  async retireUser(user: BiliUser) {
    return this.accountRetirement.retireUser(user);
  }

  private sourceDeletion() {
    return createSourceDeletion({
      stateManager: this.stateManager, jobStore: this.jobStore, userStore: this.userStore,
      database: () => this.stateManager.getDatabase(),
      downloadQueue: this.downloadQueue, uploadQueue: this.uploadQueue, verificationQueue: this.verificationQueue,
      cancelDownloads: cancelActiveDownloadsForAccount, isDeletionLocked: () => this.archiveDeletionLocked,
      isSyncing: userId => this.activeSyncUsers.has(userId), markAborted: jobId => this.accountRetirement.abortedJobs.add(jobId),
      archiveDeletionTargetMatches: this.archiveDeletionTargetMatches.bind(this),
      snapshotRetirementTargets: this.snapshotRetirementTargets.bind(this),
      persistCompletedRetirementUploadJobs: this.persistCompletedRetirementUploadJobs.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this), dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      sleep: delay, now: () => this.now(), deadlineNow: Date.now,
    });
  }

  async prepareSourceDeletion(userId: string, mediaId: number, bvid: string, timeoutMs = 30_000) {
    return this.sourceDeletion().prepareSourceDeletion(userId, mediaId, bvid, timeoutMs);
  }

  async quiesceUserRemoteDeletion(user: BiliUser, timeoutMs = 30_000) {
    return this.sourceDeletion().quiesceUserRemoteDeletion(user, timeoutMs);
  }

  finalizeUserRemoteDeletion(userId: string, commit: () => void = () => undefined) {
    return this.sourceDeletion().finalizeUserRemoteDeletion(userId, commit);
  }

  restoreUserAfterLogin(userId: string) {
    return this.accountRetirement.restoreUserAfterLogin(userId);
  }

  start() {
    if (this.shutdownStarted || this.storageRebindResumeAdmission !== null) return false;
    this.initializeRuntime();
    this.acceptingJobs = true;
    const { pollIntervalMinutes } = this.configStore.get();
    const intervalMs = pollIntervalMinutes * 60 * 1000;
    if (!this.polling.start(intervalMs)) return false;
    this.startRecoveryAutomation();
    this.localCleanup.startSweep();

    this.dispatchPersistentJobs();
    return true;
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
    if (this.shutdownStarted) return;
    if (previous.alistUrl !== next.alistUrl || previous.alistUsername !== next.alistUsername
      || previous.alistPassword !== next.alistPassword) this.remoteVerificationIO.clearListings();
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
    if (this.shutdownStarted) return;
    const config = this.configStore.get();
    this.downloadQueue.setConcurrency(config.concurrentDownloads || 1);
    this.uploadQueue.setConcurrency(config.concurrentUploads || 2);
    this.verificationQueue.setConcurrency(Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)));
    this.downloadQueue.setMaxSize(this.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit));
    this.uploadQueue.setMaxSize(this.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit));
    this.verificationQueue.setMaxSize(this.queueHighWater(config.remoteVerifyConcurrency, config.queuePrefetchLimit));
    this.localCapacity.refreshAndWake(true);
    this.dispatchPersistentJobs();
    if (process.env.NODE_ENV !== "test") {
      this.start();
    }
  }

  stop() {
    this.acceptingJobs = false;
    if (this.projectionRefreshTimer) clearInterval(this.projectionRefreshTimer);
    this.projectionRefreshTimer = null;
    this.clearUploadProbeTimer();
    this.polling.stop();
    this.recoveryAutomation.stop();
    if (this.jobDispatchTimer) {
      clearTimeout(this.jobDispatchTimer);
      this.jobDispatchTimer = null;
    }
    if (this.downloadStartTimer) {
      clearTimeout(this.downloadStartTimer);
      this.downloadStartTimer = null;
    }
    this.localCleanup.stop();
  }

  beginShutdown() {
    if (this.shutdownCompleted) return;
    if (!this.shutdownStarted) this.runtimeGeneration += 1;
    this.shutdownStarted = true;
    this.acceptingJobs = false;
    this.pendingTickOptions = null;
    this.localCapacity.stop();
    this.stop();
    this.ensureLeaseHeartbeat();
  }

  async shutdown(timeoutMs = 20_000, options: {closeDatabase?:boolean} = {}) {
    if (this.shutdownCompleted) return;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.finishShutdown(timeoutMs, options);
    try { await this.shutdownPromise; this.shutdownCompleted = true; }
    finally { this.shutdownPromise = null; }
  }

  private async finishShutdown(timeoutMs: number, options: {closeDatabase?:boolean}) {
    this.beginShutdown();
    const idle = await waitForQuiescence(() => this.running || this.activeSyncUsers.size > 0
      || [this.downloadQueue,this.uploadQueue,this.verificationQueue].some(queue => queue.getActiveCount() > 0)
      || Boolean(this.accessProbePromise || this.legacyCacheRecovery.busy || this.recoveryAutomation.busy
        || this.localCapacity.pending || this.localCleanup.sweeping)
      || this.recoveryWork.busy || this.accountRetirement.busy || this.localCleanup.busy,
    timeoutMs);
    if (!idle) throw new Error("Scheduler work did not stop before the shutdown deadline; database and leases retained");
    for (const queue of [this.downloadQueue,this.uploadQueue,this.verificationQueue]) queue.removePendingTasks(() => true);
    this.jobStore.releaseOwner(this.leaseOwner);
    this.queueEvents.dispose();
    this.remoteVerificationIO.reset();
    if (this.leaseHeartbeatTimer) clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = null;
    if (options.closeDatabase !== false) this.stateManager.close();
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
      || Boolean(this.recoveryAutomation.busy)
      || Boolean(this.accessProbePromise)
      || this.accountRetirement.busy
      || this.recoveryWork.busy;
  }

  private startRecoveryAutomation() {
    this.recoveryAutomation.start();
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
    return this.running || Boolean(this.pendingTickOptions) || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked || Boolean(this.legacyCacheRecovery.busy) || Boolean(this.localCleanup.sweeping);
  }
  refreshLocalCacheState() { this.localCapacity.reconfigure(); }


  withCleanupLock<T>(fn: () => Promise<T>) {
    if (this.cleanupLocked || this.localCleanup.sweeping || this.running || this.pendingTickOptions || this.hasRunningTransferTasks()) {
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
    const snapshot = await this.localCapacity.refresh();
    return {
      limitBytes: snapshot.limitBytes,
      usedBytes: snapshot.usedBytes,
      reserveBytes: snapshot.reserveBytes,
    };
  }

  reloadStateDatabase() {
    if (!this.cleanupLocked || this.running || this.activeSyncUsers.size > 0 || this.hasRunningTransferTasks()
      || this.legacyCacheRecovery.busy || this.localCleanup.sweeping || this.localCleanup.busy) {
      throw new Error("State database rebind requires an idle maintenance barrier");
    }
    if (this.storageRebindResumeAdmission === null) this.storageRebindResumeAdmission = this.acceptingJobs;
    this.acceptingJobs = false;
    this.runtimeGeneration += 1;
    this.jobStore.rebind(this.stateManager.getDatabase(), {normalizeRecovery:false});
    this.transferSessions.rebind(this.stateManager.getDatabase());
    this.remoteVerificationIO.reset();
    this.favoriteScan.reset();
    this.transferRecoveryProjection.reset();
    this.localCleanup.reset();
    this.localCapacity.reset();
  }

  /** Called only after every application storage adapter has rebound successfully. */
  resumeAfterStateRebind() {
    if (!this.cleanupLocked || this.storageRebindResumeAdmission === null) {
      throw new Error("State database rebind completion requires its maintenance barrier");
    }
    this.acceptingJobs = this.storageRebindResumeAdmission && !this.shutdownStarted;
    this.storageRebindResumeAdmission = null;
    if (!this.acceptingJobs) return;
    this.reconcileTransferSessionRecoveryJobs(true);
    this.ensurePersistedAvailabilityProbes();
    this.localCleanup.startSweep();
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
    return projectQualityUpgradeState(
      this.jobStore.list(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"], 100),
      payload => this.qualityTargetsFromPayload(payload).length,
    );
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

  private canStartDownloadTask(task?: DownloadTask | QualityUpgradeDownloadTask) {
    if (!this.acceptingJobs || this.cleanupLocked || this.legacyCacheRecovery.busy || this.pathMigrationLocked || this.archiveDeletionLocked) return false;
    if (task && this.isArchiveDeletionTargetBlocked(task)) return false;
    if (task instanceof QualityUpgradeDownloadTask && this.qualityArtifactCleanupLocks.has(task.control.artifactKey)) {
      return false;
    }
    this.localCapacity.ensureFresh();
    const snapshot = this.localCapacity.view();
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
    if (!this.acceptingJobs || this.cleanupLocked) return false;
    this.localCapacity.ensureFresh();
    const snapshot = this.localCapacity.view();
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
        nextRunAt: this.polling.getNextRunAt(),
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
      nextRunAt: this.polling.getNextRunAt(),
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

  private queueBoardProjection() {
    return createQueueBoardProjection({ metadata: bvids => this.stateManager.getVideoMetaBatch(bvids) });
  }

  private mapQueueTaskForBoard(task: import('./queue.js').Task, stage: QueueBoardItem["stage"]) {
    return this.queueBoardProjection().mapQueueTaskForBoard(task, stage);
  }

  private mapPersistentJobForBoard(job: import('./database.js').PersistentJobRecord) {
    return this.queueBoardProjection().mapPersistentJobForBoard(job);
  }

  private enrichQueueBoardMetadata(items: QueueBoardItem[]) {
    this.queueBoardProjection().enrichQueueBoardMetadata(items);
  }

  getQueueSnapshot() {
    return projectQueueSnapshot({
      downloadQueue:this.downloadQueue,uploadQueue:this.uploadQueue,verificationQueue:this.verificationQueue,
      config:{queuePrefetchLimit:this.configStore.get().queuePrefetchLimit},jobs:this.jobStore,
      chargingRestrictions:this.stateManager.getChargingRestrictionSummary(),
      mapTask:(task,stage) => this.mapQueueTaskForBoard(task,stage),
      mapJob:job => this.mapPersistentJobForBoard(job),
      enrich:items => this.enrichQueueBoardMetadata(items),
    }, {
      generatedAt:Date.now(),scheduler:this.buildSchedulerSnapshot(),localCache:this.localCapacity.view(),
      uploadHealth:this.uploadCircuit.getSnapshot(),downloadApiHealth:this.downloadApiHealth.getSnapshot(),
      downloadRecovery:this.localCapacity.recovery,...this.getRecoveryIssueSnapshot(),
      maintenance:this.archiveDeletionMaintenance ? {kind:'archive_delete',...this.archiveDeletionMaintenance}
        : this.pathMigrationMaintenance ? {kind:'path_migration',...this.pathMigrationMaintenance} : undefined,
    });
  }

  async tick(manual = false, options: TickOptions = {}) {
    if (!this.acceptingJobs || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked || this.running) {
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
      this.remoteVerificationIO.clearListings();
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
      if (queued && this.acceptingJobs) {
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
              await this.favoriteScan.all(user, folder.mediaId, folder.title);
            } else {
              const hotLastPage = await this.favoriteScan.hot(user, folder.mediaId, folder.title, manual);
              await this.favoriteScan.history(user, folder.mediaId, folder.title, manual, hotLastPage);
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

  private backupEnqueue() {
    return createBackupEnqueue({
      config: this.configStore, state: this.stateManager, jobs: this.jobStore,
      eligible: this.isUserSyncEligible.bind(this),
      blocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      remotePath: this.resolveRelationRemotePath.bind(this), proof: this.captureExistingArchiveProof.bind(this),
      uploadJob: this.buildPersistentUploadJob.bind(this), historySegment: this.historySnapshotSegment.bind(this),
      probe: this.enqueueChargingAccessProbe.bind(this), cycleStartedAt: () => this.cycleContext?.startedAt,
      generation: () => this.runtimeGeneration, now: () => this.now(), dispatch: () => this.dispatchPersistentJobs(),
    });
  }

  private enqueueIfNeeded(user: BiliUser, mediaId: number, folderTitle: string, bvid: string, options: BackupEnqueueOptions = {}) {
    return this.backupEnqueue().enqueue(user, mediaId, folderTitle, bvid, options);
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
    if (!this.acceptingJobs || this.cleanupLocked || this.pathMigrationLocked || this.archiveDeletionLocked) {
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

  private async verifyRemoteSamples(manual: boolean, force: boolean) {
    const cycle = this.cycleContext;
    if (!cycle) return;
    const stats = await this.remoteScan.run(manual, force, {trigger: cycle.trigger, title: this.triggerLabel(cycle.trigger), newItems: cycle.newItems});
    Object.assign(cycle, stats);
  }

  private startupRecovery() {
    return createStartupRecovery({
      stateManager: this.stateManager, jobStore: this.jobStore, transferSessions: this.transferSessions,
      configStore: this.configStore, staleActiveBackupMs: this.staleActiveBackupMs,
      resolveRelation: this.resolveRelation.bind(this), findBestRelationForBvid: this.findBestRelationForBvid.bind(this),
      resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this), enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      queueUploadWork: this.queueUploadWork.bind(this), buildPersistentUploadJob: this.buildPersistentUploadJob.bind(this),
      historySnapshotSegment: this.historySnapshotSegment.bind(this),
      ensurePersistedAvailabilityProbes: this.ensurePersistedAvailabilityProbes.bind(this),
      ensurePersistedChargingAccessProbes: this.ensurePersistedChargingAccessProbes.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      recordQueued: () => { if (this.cycleContext) this.cycleContext.queuedItems += 1; },
    });
  }

  private recoverStaleActiveBackups() {
    return this.startupRecovery().recoverStaleActiveBackups();
  }

  private startLegacyTempCacheRecovery() {
    this.legacyCacheRecovery.start();
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

  private resumePersistedWork() {
    return this.startupRecovery().resumePersistedWork();
  }

  private ensurePersistedChargingAccessProbes() {
    return this.startupProbes().ensurePersistedChargingAccessProbes();
  }

  private ensurePersistedAvailabilityProbes() {
    return this.startupProbes().ensurePersistedAvailabilityProbes();
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


type SyncTrigger = "auto" | "manual" | "reconcile" | "remote_reconcile";

interface TickOptions {
  trigger?: SyncTrigger;
  forceFullRemoteVerify?: boolean;
  forceFullFavoriteScan?: boolean;
  skipFavoriteScan?: boolean;
}
