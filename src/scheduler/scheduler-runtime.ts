import {queueAutomaticQualityRecovery} from './automatic-quality-recovery.js';
import {createAccessProbeWakeup} from './access-probe-wakeup.js';
import { createAccessAdmission } from './access-admission.js';
import { createRetryPendingRecovery } from './retry-pending-recovery.js';
import { createLegacyImportRecovery, type LegacyRecoveryMarkers } from './legacy-import-recovery.js';
import type { ScheduleTimer } from '../ports/timer.js';
import { createRuntimeTimers, scheduleSystemTimer } from './runtime-timers.js';
import type { SchedulerControl } from '../ports/scheduler-control.js';
import { createArchiveTargets } from './archive-targets.js';
import crypto from "node:crypto";
import {
getVideoPageSnapshot,
listFavoriteItemsPage,
refreshUserAuth,
resolveSelfVisibleFavoriteItem,
type VideoPageSnapshotResult
} from "../bili.js";
import { ConfigStore, type AppConfig } from "../config.js";
import { queueCoverCache } from "../cover-cache.js";
import {
LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER,
LEGACY_TEMP_CACHE_MARKER,
} from "../database.js";
import { safeErrorSummary,sanitizeDiagnosticText } from "../diagnostics.js";
import {
inspectDownloadCache,
type DownloadCacheInspection
} from "../download-session.js";
import { cancelActiveDownloadsForAccount } from "../downloader.js";
import {
PersistentJobStore,
type EnqueuePersistentJob,
} from "../job-store.js";
import { logManager } from "../logger.js";
import { tempDir } from "../paths.js";
import { type QualityArtifactProfile } from "../quality-artifact.js";
import { TaskQueue } from "../queue.js";
import {
recoveryIssueDisposition,
type RecoveryIssueAction,
type RecoveryIssueActionId,
type RecoveryIssueKind
} from "../recovery-policy.js";
import { createAccessFailureHandlers } from './access-failure-handlers.js';
import { createAccessProbes } from './access-probes.js';
import { createAccessProbeWorkflow } from './access-probe-workflow.js';
import { normalizeAccessProbeIntents,type AccessProbeIntent } from './access-rules.js';
import { createAccountRetirement } from './account-retirement.js';
import { createBackupEnqueue,type BackupEnqueueOptions } from './backup-enqueue.js';
import { createDownloadCompletionHandler } from './download-completion.js';
import { createDownloadFailureHandler } from './download-failure.js';
import { createDownloadTaskFactory } from './download-task-factory.js';
import { createEncodingRecoveryHandlers } from './encoding-recovery-handlers.js';
import { createFavoriteScan } from './favorite-scan.js';
import { createLegacyCacheRecovery } from './legacy-cache-recovery.js';
import { createLegacyQualityMigration } from './legacy-quality-migration.js';
import { createLocalCapacity } from './local-capacity.js';
import { buildLocalCleanupPlan as buildCleanupPlan } from './local-cleanup-plan.js';
import { createLocalCleanupStorage } from './local-cleanup-storage.js';
import { createLocalCleanup } from './local-cleanup.js';
import { createManualArchive } from './manual-archive.js';
import { createPollingSchedule } from "./polling.js";
import { createQualityUpgradeProjection } from './quality-projection.js';
import {
filterArchiveDeletionTargets as filterQualityArchiveDeletionTargets,
} from './quality-rules.js';
import { buildQualityUpgradeTask as buildQualityUpgradeTaskFactory } from './quality-task-factory.js';
import { createQueueEventBindings } from "./queue-events.js";
import { createRecoveryAutomation } from './recovery-automation.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import { createRecoveryWorkflow } from './recovery-workflow.js';
import { createRemoteScan } from './remote-scan.js';
import { createRemoteVerificationIO } from './remote-verification-io.js';
import { createRetirementTransfers } from './retirement-transfers.js';
import {
AUTOMATIC_QUALITY_RECOVERY_LIMIT,
computeAutomaticQualityRecoveryDelayMs
} from "./retry-policy.js";
import { createSchedulingRuntime,type ShutdownOptions } from './scheduling-runtime.js';
import { createSourceDeletion } from './source-deletion.js';
import { createStartupProbes } from './startup-probes.js';
import { createStartupRecovery } from './startup-recovery.js';
import { createSyncRuntime, type SchedulerSnapshot, type SyncCycleStats, type SyncTrigger, type TickOptions } from './sync-runtime.js';
import { createDownloadAdmission } from './download-admission.js';
import { createDownloadAdmissionPolicy, type DownloadAdmissionPolicyDependencies } from './download-admission-policy.js';
import { createTransferRuntime } from './transfer-runtime.js';
import { createQualityWorkflow } from './quality-workflow.js';
import { bindTaskLifecycleEvents } from './task-event-bindings.js';
import { createTaskProgressHandlers } from './task-progress.js';
import { createTransferRecoveryProjection } from './transfer-recovery-projection.js';
import { createUploadCompletionHandler } from './upload-completion.js';
import { createUploadFailureHandler } from './upload-failure.js';
import { createTransferWorkflow } from './transfer-workflow.js';
import { isSafeEncodingRetryDirectory } from './safe-retry-directory.js';
import { createPersistentJobDispatcher } from './persistent-job-dispatcher.js';
import { createMaintenanceCoordinator } from './maintenance-coordinator.js';
import { createWorkStateProjection } from './work-state-projection.js';
import { createRuntimeConfigController } from './runtime-config.js';
import { createSchedulerStatusProjection, schedulerTriggerLabel } from './scheduler-status-projection.js';
import { createStartupResumeWorkflow } from './startup-resume-workflow.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { createVerificationHandlers } from './verification-handlers.js';
import { buildUploadVerificationJobs } from './verification-jobs.js';
import { createVerifiedTransferCommit } from './verified-transfer-commit.js';
import { createCycleLogger } from './cycle-logger.js';
import { FavoriteRelation,MANUAL_ARCHIVE_MEDIA_ID,StateManager,type LocalCleanupPlan,type RemoteFileRecord,type SourceAvailabilityReason } from "../state.js";
import {
DownloadTask,
type QualityUpgradeCleanupTask,
QualityUpgradeDownloadTask,
type QualityUpgradeReplaceTask,
QualityUpgradeTask,
type QualityUpgradeUploadReplaceTask,
UploadTarget,
UploadTask,
UploadVerificationTask,
type EncodingRetryContext,
type QualityEncodingOverride,
type QualityUpgradeTarget
} from "../tasks.js";
import { TransferSessionStore } from "../transfer-session.js";
import { sanitizeUploadText,type UploadFailureInfo } from "../upload-health.js";
import type { BiliContentPort, ClockPort, RemoteStoragePort } from '../ports/external.js';
import { inspectRemoteFileSize,listRemoteDir,resolveRemotePath,verifyRemoteFiles } from "../uploader.js";
import { BiliUser,UserStore } from "../users.js";
export type { AccessProbeIntent } from './access-rules.js';
export type { RecoveryIssue } from './recovery-contracts.js';
export {
computeAutomaticQualityRecoveryDelayMs,computeAvailabilityUnavailableDelayMs,computeAvailabilityUnknownDelayMs,computeChargingRecheckDelayMs,
computeChargingTransientDelayMs,computeDownloadStartDelayMs,computeLocalCleanupRetryDelayMs,computeQualityCleanupRetryDelayMs,computeUploadSessionRetryDelayMs,computeUploadVerificationTiming
} from "./retry-policy.js";

export { recoveryIssueDisposition };
export type { RecoveryIssueAction,RecoveryIssueActionId,RecoveryIssueKind };

export type { SchedulerControl } from '../ports/scheduler-control.js';

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface SchedulerDependencies {
  scheduleTimer?: ScheduleTimer;
  leaseOwner?: string;
  createQueue?: (stage: 'download' | 'upload' | 'verification', concurrency: number, maxSize: number) => TaskQueue;
  /** Application bootstrap owns recovery ordering and opens admission only in start(). */
  deferAdmissionUntilStart?: boolean;
  videoAccessProbe?: (cookie: BiliUser["cookie"], bvid: string) => Promise<VideoPageSnapshotResult>;
  cacheInspector?: (rootDir: string, concurrency?: number) => Promise<DownloadCacheInspection>;
  remoteFileInspector?: typeof inspectRemoteFileSize;
  biliContent?: Pick<BiliContentPort, 'listPage' | 'refreshAuth' | 'selfVisible'>;
  remoteStorage?: Pick<RemoteStoragePort, 'list' | 'verify' | 'inspect'>;
  legacyTempDir?: string;
  clock?: ClockPort;
  now?: () => number;
  random?: () => number;
}

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type SchedulerStatusProjection = ReturnType<typeof createSchedulerStatusProjection<
  ReturnType<ReturnType<typeof createLocalCapacity>['view']>,
  ReturnType<ReturnType<typeof createTransferRuntime>['circuit']['getSnapshot']>,
  ReturnType<ReturnType<typeof createDownloadAdmission>['getSnapshot']>,
  ReturnType<typeof createLocalCapacity>['recovery'],
  ReturnType<ReturnType<typeof createRecoveryWorkflow>['getRecoveryIssueSnapshot']>,
  ReturnType<ReturnType<typeof createMaintenanceCoordinator>['snapshot']>
>>;

/**
 * Internal scheduler runtime.  The public compatibility facade lives in
 * `src/scheduler.ts`; keeping the runtime implementation behind this class
 * prevents route and service callers from depending on its stateful fields.
 */
export class SchedulerRuntime implements SchedulerControl {
  private readonly timers: ReturnType<typeof createRuntimeTimers>;
  private readonly queueEvents = createQueueEventBindings();
  private readonly polling: ReturnType<typeof createPollingSchedule>;
  private readonly syncWorkflow!: ReturnType<typeof createSyncRuntime>;
  private configStore: Pick<ConfigStore, 'get'>;
  private userStore: Pick<UserStore, 'list' | 'getById' | 'updatePartial'>;
  private stateManager: StateManager;

  private downloadQueue: TaskQueue;
  private uploadQueue: TaskQueue;
  private verificationQueue: TaskQueue;
  private readonly jobStore: PersistentJobStore;
  private readonly transferSessions: TransferSessionStore;
  private readonly leaseOwner: string;
  private readonly accessProbeWorkflow!: ReturnType<typeof createAccessProbeWorkflow>;
  private readonly accessAdmissionWorkflow!: ReturnType<typeof createAccessAdmission>;
  private readonly accessFailureWorkflow!: ReturnType<typeof createAccessFailureHandlers>;
  private readonly legacyCacheRecovery: ReturnType<typeof createLegacyCacheRecovery>;
  private readonly staleActiveBackupMs = 20 * 60_000;
  private remoteStorage?: Pick<RemoteStoragePort, 'list' | 'verify' | 'inspect'>;
  private readonly biliContent?: Pick<BiliContentPort, 'listPage' | 'refreshAuth' | 'selfVisible'>;
  private readonly remoteVerificationIO = createRemoteVerificationIO({
    list: remotePath => this.remoteStorage?.list(remotePath) || listRemoteDir(this.configStore.get(), remotePath),
    now:()=>this.now(),sleep:ms => this.sleep(ms),
  });
  private readonly transferRuntime!: ReturnType<typeof createTransferRuntime>;
  private readonly downloadAdmission!: ReturnType<typeof createDownloadAdmission>;
  private readonly downloadAdmissionPolicy!: ReturnType<typeof createDownloadAdmissionPolicy>;
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
  private readonly deadlineNow: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly accountRetirement: ReturnType<typeof createAccountRetirement>;
  /**
   * These workflows are assembled once with the runtime's narrow ports.  The
   * runtime keeps only their handles so a request cannot create a fresh
   * workflow (and accidentally lose workflow-local state) on every call.
   */
  private readonly retirementTransferWorkflow!: ReturnType<typeof createRetirementTransfers>;
  private readonly sourceDeletionWorkflow!: ReturnType<typeof createSourceDeletion>;
  private readonly legacyImportRecoveryWorkflow!: ReturnType<typeof createLegacyImportRecovery>;
  private readonly qualityWorkflow = createQualityWorkflow();
  private readonly recoveryAutomation: ReturnType<typeof createRecoveryAutomation>;
  private readonly transferRecoveryProjection: ReturnType<typeof createTransferRecoveryProjection>;
  private readonly runtime: ReturnType<typeof createSchedulingRuntime>;
  private readonly archiveTargets: ReturnType<typeof createArchiveTargets>;
  private readonly transferWorkflow: ReturnType<typeof createTransferWorkflow>;
  private readonly backupEnqueueWorkflow!: ReturnType<typeof createBackupEnqueue>;
  private readonly manualArchiveWorkflow!: ReturnType<typeof createManualArchive>;
  private readonly retryPendingRecovery!: ReturnType<typeof createRetryPendingRecovery>;
  private readonly accessProbeWakeup!: ReturnType<typeof createAccessProbeWakeup>;
  private readonly qualityUpgradeProjection!: ReturnType<typeof createQualityUpgradeProjection>;
  private readonly cycleLogger!: ReturnType<typeof createCycleLogger>;
  private readonly encodingRecoveryWorkflow!: ReturnType<typeof createEncodingRecoveryHandlers>;
  private readonly recoveryWorkflow: ReturnType<typeof createRecoveryWorkflow>;
  private readonly persistentJobDispatcher: ReturnType<typeof createPersistentJobDispatcher>;
  private readonly maintenance = createMaintenanceCoordinator({
    canEnterCleanup: () => this.workState?.canEnterCleanup() ?? false,
    wakeBlockedWork: () => {
      this.downloadQueue.poke();
      this.uploadQueue.poke();
      this.verificationQueue.poke();
      this.dispatchPersistentJobs();
    },
  });
  private readonly workState!: ReturnType<typeof createWorkStateProjection>;
  private readonly runtimeConfig!: ReturnType<typeof createRuntimeConfigController>;
  private readonly statusProjection!: SchedulerStatusProjection;
  private readonly startupWorkflow!: ReturnType<typeof createStartupResumeWorkflow>;
  private readonly verifiedTransferCommit!: ReturnType<typeof createVerifiedTransferCommit>;
  private readonly triggerLabel = schedulerTriggerLabel;

  constructor(configStore: Pick<ConfigStore, 'get'>, userStore: Pick<UserStore, 'list' | 'getById' | 'updatePartial'>, stateManager: StateManager, dependencies: SchedulerDependencies = {}) {

    this.configStore = configStore;
    this.userStore = userStore;
    this.stateManager = stateManager;
    this.archiveTargets = createArchiveTargets({
      config: configStore, state: stateManager, users: userStore,
      eligible: (user): user is BiliUser => this.isUserSyncEligible(user),
      sourceBlocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
    });
    this.videoAccessProbe = dependencies.videoAccessProbe || getVideoPageSnapshot;
    this.cacheInspector = dependencies.cacheInspector || inspectDownloadCache;
    this.remoteStorage = dependencies.remoteStorage;
    this.biliContent = dependencies.biliContent;
    this.remoteFileInspector = dependencies.remoteFileInspector || dependencies.remoteStorage?.inspect || inspectRemoteFileSize;
    this.legacyTempDir = dependencies.legacyTempDir || tempDir;
    this.leaseOwner = dependencies.leaseOwner ?? crypto.randomUUID();
    this.timers = createRuntimeTimers(dependencies.scheduleTimer);
    const clock = dependencies.clock;
    this.now = dependencies.now ?? (clock ? () => clock.now() : Date.now);
    this.random = dependencies.random ?? (clock ? () => clock.random() : Math.random);
    this.sleep = clock ? ms => clock.sleep(ms) : delay;
    this.deadlineNow = clock ? () => clock.now() : Date.now;
    this.cycleLogger = createCycleLogger({ now: this.now, push: entry => logManager.push(entry) });
    this.runtime = createSchedulingRuntime({
      initiallyAccepting: !dependencies.deferAdmissionUntilStart,
      clock: clock ? {now: () => clock.now(), sleep: ms => clock.sleep(ms)} : undefined,
      stopProducers: () => this.stopWorkProducers(),
      beginDrain: () => {
        this.syncWorkflow?.stop();
        this.accessProbeWorkflow?.stop();
        this.downloadAdmission?.stop();
        this.transferRuntime?.stop();
        this.qualityWorkflow.stop();
        this.localCapacity.stop();
        this.ensureLeaseHeartbeat();
      },
      busy: () => this.workState?.isBusy() ?? true,
      releaseWork: () => {
        for (const queue of [this.downloadQueue, this.uploadQueue, this.verificationQueue]) queue.removePendingTasks(() => true);
        this.jobStore.releaseOwner(this.leaseOwner);
        this.queueEvents.dispose();
        this.remoteVerificationIO.reset();
        this.timers.dispose();
      },
      closeDatabase: () => this.stateManager.close(),
      canRebind: () => this.maintenance.isLocked('cleanup') && this.workState?.canRebind() === true,
      rebindAdapters: () => {
        this.jobStore.rebind(this.stateManager.getDatabase(), { normalizeRecovery: false });
        this.transferSessions.rebind(this.stateManager.getDatabase());
        this.remoteVerificationIO.reset(); this.favoriteScan.reset(); this.transferRecoveryProjection.reset();
        this.syncWorkflow.resetAfterRebind();
        this.accessProbeWorkflow.resetAfterRebind();
        this.downloadAdmission.resetAfterRebind();
        this.transferRuntime.resetAfterRebind();
        this.qualityWorkflow.resetAfterRebind();
        this.localCleanup.reset(); this.localCapacity.reset();
      },
      resumeAfterRebind: () => {
        this.syncWorkflow.start();
        this.accessProbeWorkflow.start();
        this.downloadAdmission.start();
        this.transferRuntime.start();
        this.qualityWorkflow.start();
        this.reconcileTransferSessionRecoveryJobs(true); this.ensurePersistedAvailabilityProbes();
        this.localCleanup.startSweep(); this.dispatchPersistentJobs();
      },
    });
    this.polling = createPollingSchedule({ schedule: dependencies.scheduleTimer ?? scheduleSystemTimer, now: this.now, random: this.random, run: () => { void this.tick(); } });
    this.jobStore = new PersistentJobStore(this.stateManager.getDatabase(), {normalizeRecovery:false, now:this.now});
    this.transferSessions = new TransferSessionStore(this.stateManager.getDatabase());
    // Recovery workflows consume the upload circuit during construction. Keep
    // the circuit's owner ahead of those workflows so construction never
    // observes an uninitialised dependency.
    this.transferRuntime = createTransferRuntime({
      state: this.stateManager,
      now: this.now,
      cancelTimer: name => this.timers.cancel(name),
      startTimer: (name, callback, delayMs) => this.timers.start(name, callback, delayMs),
      dispatch: () => this.dispatchPersistentJobs(),
      pokeDownloads: () => this.downloadQueue?.poke(),
    });
    this.recoveryWorkflow = createRecoveryWorkflow({
      database: () => this.stateManager.getDatabase(),
      atomic: work => this.stateManager.runAtomic(work),
      stateManager: this.stateManager, jobStore: this.jobStore, transferSessions: this.transferSessions,
      configStore: this.configStore, userStore: this.userStore, uploadCircuit: this.transferRuntime.circuit,
      remoteFileInspector: this.remoteFileInspector, videoAccessProbe: this.videoAccessProbe,
      legacyTempDir: this.legacyTempDir, canRun: () => this.runtime.accepting,
      generation: () => this.runtime.generation, now: this.now,
      cleanup: (bvid, dir) => this.localCleanup.request(bvid, dir),
      resolveRelation: relation => this.resolveRelation(relation),
      isUserSyncEligible: (user): user is BiliUser => this.isUserSyncEligible(user),
      prepareDownload: (...args) => this.backupEnqueueWorkflow.prepareRecoveryDownload(...args),
      buildLocalCleanupPlan: (...args) => this.buildLocalCleanupPlan(...args),
      isSafeEncodingRetryDirectory: dir => isSafeEncodingRetryDirectory(this.legacyTempDir, dir),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
    this.transferWorkflow = createTransferWorkflow({
      stateManager, configStore, jobStore: this.jobStore, transferSessions: this.transferSessions,
      leaseOwner: this.leaseOwner, generation: () => this.runtime.generation,
      captureExistingArchiveProof: (...args) => this.recoveryWorkflow.captureExistingArchiveProof(...args),
      transferRuntime: this.transferRuntime,
      downloadQueue: { poke: () => this.downloadQueue.poke() },
      blocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      wake: () => this.dispatchPersistentJobs(),
    });
    this.legacyCacheRecovery = createLegacyCacheRecovery({
      stateManager: this.stateManager, legacyTempDir: this.legacyTempDir,
      canRun: () => this.runtime.accepting, generation: () => this.runtime.generation,
      getMeta: key => this.stateManager.getDatabase().getMeta(key),
      setMeta: (key, value) => this.stateManager.getDatabase().setMeta(key, value),
      findBestRelationForBvid: this.findBestRelationForBvid.bind(this),
      enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      wake: () => { this.downloadQueue.poke(); this.dispatchPersistentJobs(); },
    });
    this.transferRecoveryProjection = createTransferRecoveryProjection({
      jobStore: this.jobStore, transferSessions: this.transferSessions, stateManager: this.stateManager,
      configStore: this.configStore, now: () => this.now(),
      captureExistingArchiveProof: (userId, mediaId, bvid) => this.recoveryWorkflow.captureExistingArchiveProof(userId, mediaId, bvid),
    });

    this.remoteScan = createRemoteScan({
      config: this.configStore, state: this.stateManager, io: this.remoteVerificationIO,
      random: this.random, sleep: this.sleep, generation: () => this.runtime.generation,
      canContinue: () => !this.runtime.shuttingDown && !this.maintenance.isAnyLocked(),
      verify: this.remoteStorage?.verify || verifyRemoteFiles, resolve: relation => this.resolveRelation(relation),
      bestRelation: bvid => this.findBestRelationForBvid(bvid),
      remotePath: (user, mediaId, title, config) => this.resolveRelationRemotePath(user, mediaId, title, config),
      enqueue: (user, mediaId, title, bvid) => this.enqueueIfNeeded(user, mediaId, title, bvid),
      progress: patch => this.updateSchedulerProgress(patch),
    });
    this.accessProbes = createAccessProbes({
      users: this.userStore, state: this.stateManager, jobs: this.jobStore, owner: this.leaseOwner,
      now: this.now, random: this.random, generation: () => this.runtime.generation,
      canContinue: () => !this.runtime.shuttingDown && !this.maintenance.isAnyLocked(),
      eligible: user => this.isUserSyncEligible(user), inspect: this.videoAccessProbe,
      resolve: relation => this.resolveRelation(relation),
      enqueue: (user, mediaId, title, bvid, options) => this.enqueueIfNeeded(user, mediaId, title, bvid, options),
      prepareCharging: (user, mediaId, title, bvid, options) => this.backupEnqueueWorkflow.prepareAfterAccessCheck(user, mediaId, title, bvid, options),
    });
    this.accessProbeWorkflow = createAccessProbeWorkflow({
      jobs: this.jobStore,
      owner: this.leaseOwner,
      now: this.now,
      generation: () => this.runtime.generation,
      accepting: () => this.runtime.accepting,
      shuttingDown: () => this.runtime.shuttingDown,
      run: job => this.runChargingAccessProbe(job),
      failed: (job, error) => this.accessProbes.failed(job, error),
      wake: () => this.dispatchPersistentJobs(),
      sleep: this.sleep,
    });
    this.localCapacity = createLocalCapacity({
      limitGB: () => this.configStore.get().localCacheLimitGB,
      inspect: () => this.cacheInspector(tempDir, 4), now: this.now,
      generation: () => this.runtime.generation, canRun: () => this.runtime.accepting,
      wake: () => { this.downloadQueue.poke(); this.dispatchPersistentJobs(); },
      failed: error => console.warn(`[Scheduler] Failed to refresh local cache state: ${safeErrorSummary(error)}`),
    });
    this.favoriteScan = createFavoriteScan({
      deletions: { folder: (u,m) => this.stateManager.getDatabase().isArchiveFolderDeletionActive(u,m), source: (u,m,b) => this.stateManager.getDatabase().isArchiveSourceDeletionActive(u,m,b) },
      state: this.stateManager, users: this.userStore, now: this.now, random: this.random, sleep: this.sleep,
      generation: () => this.runtime.generation,
      canRun: () => this.runtime.accepting && !this.maintenance.isAnyLocked(),
      listPage: this.biliContent?.listPage || listFavoriteItemsPage,
      refreshAuth: this.biliContent?.refreshAuth || refreshUserAuth,
      resolveSelfVisible: this.biliContent?.selfVisible || resolveSelfVisibleFavoriteItem,
      cacheCover: queueCoverCache,
      progress: patch => this.updateSchedulerProgress(patch),
      recordCount: (fresh, queued) => {
        const cycle = this.syncWorkflow?.getCycle();
        if (cycle) { cycle.newItems += fresh; cycle.queuedItems += queued; }
      },
      probe: (bvid, options) => this.enqueueAvailabilityProbe(bvid, options),
      enqueue: (user, mediaId, title, bvid) => this.enqueueIfNeeded(user, mediaId, title, bvid),
    });
    this.syncWorkflow = createSyncRuntime({
      users: () => this.userStore.list(),
      eligible: user => this.isUserSyncEligible(user),
      state: this.stateManager,
      scan: this.favoriteScan,
      accepting: () => this.runtime.accepting,
      blocked: () => this.maintenance.isAnyLocked(),
      now: this.now,
      random: this.random,
      sleep: this.sleep,
      triggerLabel: this.triggerLabel,
      clearRemoteListings: () => this.remoteVerificationIO.clearListings(),
      recoverStaleActiveBackups: () => this.recoverStaleActiveBackups(),
      requeueRetryPendingBeforeScan: () => this.retryPendingRecovery.run(),
      verifyRemoteSamples: (manual, force, cycle) => this.verifyRemoteSamples(manual, force, cycle),
      logCycleSummary: this.cycleLogger.log,
      scheduleQueued: options => {
        this.timers.start('queuedSync', () => {
          if (!this.runtime.accepting) return;
          void this.syncWorkflow.run((options.trigger || 'auto') !== 'auto', options);
        }, 0);
      },
    });
    this.localCleanup = createLocalCleanup({
      storage: createLocalCleanupStorage(this.stateManager),
      canRun: () => this.runtime.accepting && !this.maintenance.isAnyLocked(),
      generation: () => this.runtime.generation, now: () => this.now(), schedule: dependencies.scheduleTimer,
      config: this.configStore, state: this.stateManager, jobs: this.jobStore, transfers: this.transferSessions,
      tempRoot: this.legacyTempDir, inspectRemote: this.remoteFileInspector,
      safeCandidate: dir => isSafeEncodingRetryDirectory(this.legacyTempDir, dir),
      refreshCapacity: force => { this.localCapacity.refreshAndWake(force); },
    });
    this.recoveryAutomation = createRecoveryAutomation({
      jobs: this.jobStore, now: () => this.now(),
      canRun: () => this.runtime.accepting && !this.maintenance.isAnyLocked(),
      generation: () => this.runtime.generation,
      refreshProjection: () => this.refreshRecoveryProjection(),
      assess: id => this.recoveryWorkflow.assessManualRecoveryJob(id, { allowAutomatic: true }),
      reportError: error => console.error('[Recovery] Automatic review failed: ' + sanitizeUploadText(error)),
    });
    const config = this.configStore.get();
    this.transferRuntime.restore(this.stateManager.getUploadCooldown());
    const persistedApiCooldown = this.stateManager.getDownloadApiCooldown();
    const createQueue = dependencies.createQueue ?? ((_stage, concurrency, maxSize) => new TaskQueue(concurrency, maxSize));
    this.downloadQueue = createQueue('download', config.concurrentDownloads || 1, this.queueHighWater(config.concurrentDownloads, config.queuePrefetchLimit));
    this.uploadQueue = createQueue('upload', config.concurrentUploads || 2, this.queueHighWater(config.concurrentUploads, config.queuePrefetchLimit));
    this.verificationQueue = createQueue('verification',
      Math.max(1, Math.min(10, config.remoteVerifyConcurrency || 3)),
      this.queueHighWater(config.remoteVerifyConcurrency || 3, config.queuePrefetchLimit)
    );
    this.downloadAdmission = createDownloadAdmission({
      state: this.stateManager,
      now: this.now,
      random: this.random,
      hasTimer: name => this.timers.has(name),
      cancelTimer: name => this.timers.cancel(name),
      startTimer: (name, callback, delayMs) => this.timers.start(name, callback, delayMs),
      poke: () => this.downloadQueue.poke(),
    });
    this.qualityWorkflow.configure({
      jobs: this.jobStore,
      configStore: this.configStore,
      downloadQueue: this.downloadQueue,
      onApiReady: task => { if (this.downloadAdmission.handleTaskReady(task)) this.dispatchPersistentJobs(); },
      dispatch: () => this.dispatchPersistentJobs(),
      now: () => this.now(),
      sleep: ms => this.sleep(ms),
    });
    this.accessFailureWorkflow = createAccessFailureHandlers({
      stateManager: this.stateManager, jobStore: this.jobStore, leaseOwner: this.leaseOwner,
      now: () => this.now(), random: this.random, syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      serializeQualityUpgrade: this.serializeQualityUpgrade.bind(this),
      enqueueAvailabilityProbe: this.enqueueAvailabilityProbe.bind(this),
      enqueueChargingAccessProbe: this.enqueueChargingAccessProbe.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
    this.encodingRecoveryWorkflow = createEncodingRecoveryHandlers({
      configStore: this.configStore, stateManager: this.stateManager, jobStore: this.jobStore,
      leaseOwner: this.leaseOwner, now: () => this.now(), cleanup: (bvid, dir) => this.localCleanup.request(bvid, dir),
      uploadHealth: () => this.transferRuntime.circuit.getSnapshot(),
      handleDownloadApiFailure: this.downloadAdmission.handleTaskFailure,
      recordUploadFailure: this.transferWorkflow.recordUploadFailure,
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
    this.verifiedTransferCommit = createVerifiedTransferCommit({
      state: this.stateManager,
      sessions: this.transferSessions,
      jobs: this.jobStore,
      leaseOwner: this.leaseOwner,
      now: () => this.now(),
      buildCleanupPlan: (bvid, localDir, remoteFiles, reason, options) =>
        this.buildLocalCleanupPlan(bvid, localDir, remoteFiles, reason, options),
    });
    this.downloadAdmission.configure(config.bbdownApiMode || "web");
    this.downloadAdmission.restore(persistedApiCooldown);
    this.downloadAdmissionPolicy = createDownloadAdmissionPolicy({
      isAccepting: () => this.runtime.accepting,
      isMaintenanceLocked: scope => scope ? this.maintenance.isLocked(scope) : this.maintenance.isAnyLocked(),
      legacyCacheBusy: () => this.legacyCacheRecovery.busy,
      isArchiveDeletionTargetBlocked: task => this.maintenance.archiveTaskBlocked(task),
      isQualityCleanupLocked: artifactKey => this.qualityWorkflow.isCleanupLocked(artifactKey),
      capacity: this.localCapacity,
      transferPaused: () => this.transferRuntime.circuit.isDownloadPaused(),
      uploadQueueSize: () => this.uploadQueue.getSize(),
      dueUploadCount: () => this.jobStore.countDue(["upload", "history_upload"], 20),
      uploadQueueCanAccept: () => this.uploadQueue.canAccept(),
      downloadQueueCanAccept: () => this.downloadQueue.canAccept(),
      admission: this.downloadAdmission,
    } satisfies DownloadAdmissionPolicyDependencies);
    this.accountRetirement = createAccountRetirement({
      jobStore: this.jobStore, stateManager: this.stateManager, userStore: this.userStore, downloadQueue: this.downloadQueue,
      listRelationsForUser: userId => this.stateManager.getDatabase().listRelationsForUser(userId),
      cancelDownloads: cancelActiveDownloadsForAccount,
      snapshotRetirementTargets: this.snapshotRetirementTargets.bind(this),
      queueCompletedRetirementUpload: this.queueCompletedRetirementUpload.bind(this),
      findCompletedQualitySession: this.findCompletedQualitySession.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this), enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      wakeChargingAccessProbes: this.wakeChargingAccessProbes.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(), generation: () => this.runtime.generation, now: () => this.now(),
    });
    this.downloadQueue.setStartGate((task) => {
      if (!(task instanceof DownloadTask) && !(task instanceof QualityUpgradeDownloadTask)) return false;
      return this.canStartDownloadTask(task);
    });
    this.uploadQueue.setStartGate((task) => this.runtime.accepting && !this.maintenance.isLocked('cleanup') && !this.maintenance.isLocked('path_migration')
      && !this.maintenance.archiveTaskBlocked(task)
      && this.transferRuntime.circuit.allowUploadStart(this.transferWorkflow.uploadTaskKey(task)));
    this.verificationQueue.setStartGate((task) => this.runtime.accepting && !this.maintenance.isLocked('cleanup') && !this.maintenance.isLocked('path_migration')
      && !this.maintenance.archiveTaskBlocked(task)
      && this.transferRuntime.circuit.allowUploadStart(`verify:${task.bvid || task.id}`));
    this.persistentJobDispatcher = createPersistentJobDispatcher({
      configStore: this.configStore, jobs: this.jobStore, downloadQueue: this.downloadQueue,
      uploadQueue: this.uploadQueue, verificationQueue: this.verificationQueue, sessions: this.transferSessions,
      leaseOwner: this.leaseOwner, now: this.now, accepting: () => this.runtime.accepting,
      maintenanceLocked: () => this.maintenance.isAnyLocked(),
      queueHighWater: (concurrency, prefetch) => this.queueHighWater(concurrency, prefetch),
      canCreateDownloadTask: () => this.canCreateDownloadTask(),
      dispatchChargingAccessProbe: () => this.dispatchChargingAccessProbe(),
      buildDownloadTask: job => this.buildDownloadTask(job),
      buildUploadTask: item => this.buildUploadTask(item),
      buildQualityUpgradeTask: job => this.buildQualityUpgradeTaskSafely(job),
      scheduleWake: () => this.schedulePersistentJobWake(),
    });
    const progress = this.bindTaskLifecycleEvents();

    this.queueEvents.on(this.downloadQueue, "taskError", createDownloadFailureHandler({
      jobStore: this.jobStore, stateManager: this.stateManager, configStore: this.configStore,
      retirementAbortedJobIds: this.accountRetirement.abortedJobs, leaseOwner: this.leaseOwner, now: () => this.now(),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      handleSourceUnavailableTask: this.handleSourceUnavailableTask.bind(this),
      handleEncodingRetryDownloadError: this.handleEncodingRetryDownloadError.bind(this),
      handleChargingRestrictedTask: this.handleChargingRestrictedTask.bind(this),
      handleDownloadApiFailure: this.downloadAdmission.handleTaskFailure,
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      queueAutomaticQualityRecovery: this.queueAutomaticQualityRecovery.bind(this),
      collectUploadTargets: this.collectUploadTargets.bind(this),
      makeSingleTarget: this.makeSingleTarget.bind(this),
    }));
    this.queueEvents.on(this.downloadQueue, "taskRetry", progress.downloadRetry);
    this.queueEvents.on(this.uploadQueue, "taskError", createUploadFailureHandler({
      jobStore: this.jobStore, uploadCircuit: this.transferRuntime.circuit, downloadQueue: this.downloadQueue,
      leaseOwner: this.leaseOwner, now: () => this.now(), random: () => this.random(),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      handleEncodingRetryUploadError: this.handleEncodingRetryUploadError.bind(this),
      recordUploadFailure: this.transferWorkflow.recordUploadFailure,
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      queueAutomaticQualityRecovery: this.queueAutomaticQualityRecovery.bind(this),
      markUploadTaskFailed: this.transferWorkflow.markUploadTaskFailed,
      formatUploadFailureLog: this.transferWorkflow.formatUploadFailureLog,
      startConflictCandidate: this.recoveryWorkflow.startConflictCandidate.bind(this),
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
      uploadCircuit: this.transferRuntime.circuit, downloadQueue: this.downloadQueue, localCleanup: this.localCleanup,
      leaseOwner: this.leaseOwner, now: () => this.now(),
      isEncodingRetryParentActive: this.isEncodingRetryParentActive.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      uploadTaskKey: this.transferWorkflow.uploadTaskKey,
      clearUploadProbeTimer: this.transferWorkflow.clearUploadProbeTimer,
      syncQualityUpgradeControl: this.syncQualityUpgradeControl.bind(this),
      refreshLocalCacheState: this.refreshLocalCacheState.bind(this),
      finishEncodingRetryFailure: this.finishEncodingRetryFailure.bind(this),
      supersedeUploadTaskSession: this.transferWorkflow.supersedeUploadTaskSession,
      afterEncodingRetryCommitted: this.afterEncodingRetryCommitted.bind(this),
      restoreConflictCandidateExistingArchive: this.transferWorkflow.restoreConflictCandidateExistingArchive,
      commitVerifiedTransfer: this.commitVerifiedTransfer.bind(this),
      buildUploadVerificationJobs: this.buildUploadVerificationJobs.bind(this),
      enqueueUploadVerificationJobs: this.enqueueUploadVerificationJobs.bind(this),
    }));

    this.retirementTransferWorkflow = createRetirementTransfers({
      configStore: this.configStore,
      userStore: this.userStore,
      stateManager: this.stateManager,
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) =>
        this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this),
      historySnapshotSegment: this.historySnapshotSegment.bind(this),
      queueUploadWork: this.queueUploadWork.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
    this.sourceDeletionWorkflow = createSourceDeletion({
      stateManager: this.stateManager,
      jobStore: this.jobStore,
      userStore: this.userStore,
      downloadQueue: this.downloadQueue,
      uploadQueue: this.uploadQueue,
      verificationQueue: this.verificationQueue,
      cancelDownloads: cancelActiveDownloadsForAccount,
      isDeletionLocked: () => this.maintenance.isLocked('archive_deletion'),
      isSyncing: userId => this.syncWorkflow.isSyncing(userId),
      markAborted: jobId => this.accountRetirement.abortedJobs.add(jobId),
      archiveDeletionTargetMatches: this.maintenance.archiveTargetMatches,
      snapshotRetirementTargets: this.snapshotRetirementTargets.bind(this),
      persistCompletedRetirementUploadJobs: this.persistCompletedRetirementUploadJobs.bind(this),
      isUserSyncEligible: this.isUserSyncEligible.bind(this),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      sleep: this.sleep,
      now: () => this.now(),
      deadlineNow: this.deadlineNow,
    });
    this.legacyImportRecoveryWorkflow = createLegacyImportRecovery({
      database: () => this.stateManager.getDatabase(),
      recoverState: () => this.resumePersistedWorkOnStartup(),
      recoverTemp: () => this.startLegacyTempCacheRecovery(),
      wake: () => this.dispatchPersistentJobs(),
    });
    this.accessAdmissionWorkflow = createAccessAdmission({
      state: this.stateManager, jobs: this.jobStore, now: this.now,
      users: (bvid, charging) => this.accessProbes.users(bvid, '', new Set(), charging),
      wake: () => this.dispatchPersistentJobs(),
    });
    this.backupEnqueueWorkflow = createBackupEnqueue({
      config: this.configStore, state: this.stateManager, jobs: this.jobStore,
      eligible: this.isUserSyncEligible.bind(this),
      blocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      remotePath: this.resolveRelationRemotePath.bind(this), proof: this.recoveryWorkflow.captureExistingArchiveProof.bind(this),
      uploadJob: this.buildPersistentUploadJob.bind(this), historySegment: this.historySnapshotSegment.bind(this),
      probe: this.enqueueChargingAccessProbe.bind(this), cycleStartedAt: () => this.syncWorkflow.getCycle()?.startedAt,
      generation: () => this.runtime.generation, now: () => this.now(), dispatch: () => this.dispatchPersistentJobs(),
    });
    this.manualArchiveWorkflow = createManualArchive({
      users: this.userStore,
      state: this.stateManager,
      jobs: this.jobStore,
      isEligible: user => this.isUserSyncEligible(user),
      enqueue: (user, mediaId, title, bvid, options) => this.enqueueIfNeeded(user, mediaId, title, bvid, options),
    });
    this.retryPendingRecovery = createRetryPendingRecovery({
      users: () => this.userStore.list(),
      eligible: user => this.isUserSyncEligible(user),
      limit: () => this.configStore.get().remoteRequeueLimitPerCycle,
      state: this.stateManager,
      enqueue: this.enqueueIfNeeded.bind(this),
    });
    this.accessProbeWakeup = createAccessProbeWakeup({
      now: this.now,
      userStore: this.userStore,
      jobStore: this.jobStore,
      stateManager: this.stateManager,
      isUserSyncEligible: user => this.isUserSyncEligible(user),
      enqueueAvailabilityProbe: (bvid, options) => this.enqueueAvailabilityProbe(bvid, options),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
    });
    this.qualityUpgradeProjection = createQualityUpgradeProjection({
      jobs: () => this.jobStore.list(['quality_download', 'quality_upload', 'quality_replace', 'quality_cleanup'], 100),
      targetCount: payload => this.qualityTargetsFromPayload(payload).length,
    });
    const startupProbes = createStartupProbes({
      stateManager: this.stateManager,
      database: () => this.stateManager.getDatabase(),
      jobStore: this.jobStore,
      now: () => this.now(),
      enqueueChargingAccessProbe: this.enqueueChargingAccessProbe.bind(this),
      enqueueAvailabilityProbe: this.enqueueAvailabilityProbe.bind(this),
    });
    const startupRecovery = createStartupRecovery({
      stateManager: this.stateManager,
      jobStore: this.jobStore,
      transferSessions: this.transferSessions,
      configStore: this.configStore,
      staleActiveBackupMs: this.staleActiveBackupMs,
      resolveRelation: this.resolveRelation.bind(this),
      findBestRelationForBvid: this.findBestRelationForBvid.bind(this),
      resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this),
      enqueueIfNeeded: this.enqueueIfNeeded.bind(this),
      queueUploadWork: this.queueUploadWork.bind(this),
      buildPersistentUploadJob: this.buildPersistentUploadJob.bind(this),
      historySnapshotSegment: this.historySnapshotSegment.bind(this),
      ensurePersistedAvailabilityProbes: startupProbes.ensurePersistedAvailabilityProbes,
      ensurePersistedChargingAccessProbes: startupProbes.ensurePersistedChargingAccessProbes,
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      recordQueued: () => this.syncWorkflow.addQueuedItems(1),
    });
    const legacyQualityMigration = createLegacyQualityMigration({
      configStore: this.configStore,
      userStore: this.userStore,
      jobStore: this.jobStore,
      database: () => this.stateManager.getDatabase(),
    });
    this.startupWorkflow = createStartupResumeWorkflow({
      shuttingDown: () => this.runtime.shuttingDown,
      initializeRuntime: () => this.initializeRuntime(),
      jobs: this.jobStore,
      reconcileTransferSessions: force => { this.transferRecoveryProjection.reconcile(force); },
      reconcileObsoleteVerifiedArchives: () => this.recoveryWorkflow.reconcileObsoleteVerifiedArchiveRecoveries(),
      migrateLegacyQualityDownloads: () => { legacyQualityMigration.migrate(); },
      bootstrapLegacyFailureClassification: startupProbes.bootstrapLegacyFailureClassification,
      resumePersistedWork: startupRecovery.resumePersistedWork,
      startLegacyCacheRecovery: () => this.legacyCacheRecovery.start(),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      now: () => this.now(),
      recoverStaleActiveBackups: startupRecovery.recoverStaleActiveBackups,
      ensurePersistedChargingAccessProbes: startupProbes.ensurePersistedChargingAccessProbes,
      ensurePersistedAvailabilityProbes: startupProbes.ensurePersistedAvailabilityProbes,
    });

    this.workState = createWorkStateProjection({
      sync: this.syncWorkflow,
      queues: [this.downloadQueue, this.uploadQueue, this.verificationQueue],
      accessProbe: this.accessProbeWorkflow,
      recoveryAutomation: this.recoveryAutomation,
      legacyCacheRecovery: this.legacyCacheRecovery,
      localCapacity: this.localCapacity,
      localCleanup: this.localCleanup,
      recovery: this.recoveryWorkflow,
      accountRetirement: this.accountRetirement,
      quality: this.qualityWorkflow,
      anyMaintenanceLocked: () => this.maintenance.isAnyLocked(),
      jobs: this.jobStore,
    });
    this.runtimeConfig = createRuntimeConfigController({
      isShuttingDown: () => this.runtime.shuttingDown,
      config: () => this.configStore.get(),
      clearRemoteListings: () => this.remoteVerificationIO.clearListings(),
      clearDownloadApiCooldown: () => this.stateManager.clearDownloadApiCooldown(),
      downloadAdmission: this.downloadAdmission,
      downloadQueue: this.downloadQueue,
      uploadQueue: this.uploadQueue,
      verificationQueue: this.verificationQueue,
      localCapacity: this.localCapacity,
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      queueHighWater: (concurrency, prefetch) => this.queueHighWater(concurrency, prefetch),
      start: () => this.start(),
    });
    this.statusProjection = createSchedulerStatusProjection({
      sync: this.syncWorkflow,
      nextRunAt: () => this.polling.getNextRunAt(),
      state: this.stateManager,
      users: this.userStore,
      queues: {
        download: this.downloadQueue,
        upload: this.uploadQueue,
        verification: this.verificationQueue,
      },
      queuePrefetchLimit: () => this.configStore.get().queuePrefetchLimit,
      jobs: this.jobStore,
      now: () => this.now(),
      localCache: () => this.localCapacity.view(),
      uploadHealth: () => this.transferRuntime.circuit.getSnapshot(),
      downloadApiHealth: () => this.downloadAdmission.getSnapshot(),
      downloadRecovery: () => this.localCapacity.recovery,
      recoverySnapshot: () => this.recoveryWorkflow.getRecoveryIssueSnapshot(),
      maintenanceSnapshot: () => this.maintenance.snapshot(),
    });

  }

  private bindTaskLifecycleEvents() {
    const progress = createTaskProgressHandlers({
      jobs: this.jobStore, leaseOwner: this.leaseOwner,
      markDownloadStarted: () => this.downloadAdmission.markStarted(),
      syncQuality: (task, status) => this.syncQualityUpgradeControl(task, status),
      downloadFailure: (task, error) => this.downloadAdmission.handleTaskFailure(task, error),
      uploadFailure: (task, error) => this.transferWorkflow.recordUploadFailure(task, error),
      formatUploadFailure: (task, failure) => this.transferWorkflow.formatUploadFailureLog(task, failure),
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
    if (this.runtime.shuttingDown) return;
    this.runtime.initialize(() => {
      if (this.configStore.get().bbdownApiMode === "app") this.stateManager.clearDownloadApiCooldown();
      this.localCapacity.refreshAndWake(true);
      this.refreshRecoveryProjection(true);
      if (this.transferRuntime.circuit.getSnapshot().state !== "closed") this.transferWorkflow.scheduleUploadProbe();
    });
    if (!this.timers.has('projection')) {
      this.timers.start('projection', () => {
        if (!this.runtime.accepting || this.maintenance.isAnyLocked()) return;
        this.refreshRecoveryProjection();
        this.localCapacity.refreshAndWake();
      }, this.projectionRefreshIntervalMs, true);
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
    this.accessProbeWorkflow.renewLease();
  }

  private ensureLeaseHeartbeat() {
    if (this.runtime.closed) return;
    if (this.timers.has('heartbeat')) return;
    this.timers.start('heartbeat', () => this.renewActiveLeases(), 60_000, true);
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
  private buildDownloadTask(job: import('../database.js').PersistentJobRecord) {
    return createDownloadTaskFactory({
      configStore: this.configStore, userStore: this.userStore, stateManager: this.stateManager,
      generation: () => this.runtime.generation,
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) => this.stateManager.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      resolveRelation: this.resolveRelation.bind(this), resolveRelationRemotePath: this.resolveRelationRemotePath.bind(this),
      handleDownloadApiReady: task => { if (this.downloadAdmission.handleTaskReady(task)) this.dispatchPersistentJobs(); },
    }).build(job);
  }

  private qualityTargetsFromPayload(payload: unknown, fallback: QualityUpgradeTarget[] = []) {
    return this.qualityWorkflow.targetsFromPayload(payload, fallback);
  }

  private filterArchiveDeletionTargets<T extends { userId?: unknown; mediaId?: unknown }>(
    bvid: string,
    targets: T[],
  ) {
    return filterQualityArchiveDeletionTargets(this.stateManager, bvid, targets);
  }

  private qualityDownloadStageLabel(task: QualityUpgradeTask, label: string) {
    return this.qualityWorkflow.stageLabel(task, label);
  }

  private serializeQualityUpgrade(
    task: QualityUpgradeTask,
    target: QualityUpgradeTarget = task.target,
    targets: QualityUpgradeTarget[] = task.targets
  ) {
    return this.qualityWorkflow.serialize(task, target, targets);
  }

  buildQualityUpgradeTask(job: import('../database.js').PersistentJobRecord) {
    return buildQualityUpgradeTaskFactory(job, {
      config: this.configStore,
      users: this.userStore,
      state: this.stateManager,
      jobs: this.jobStore,
      isUserSyncEligible: user => this.isUserSyncEligible(user),
      leaseOwner: this.leaseOwner,
      now: this.now,
      qualityArtifactCleanupLocks: {
        acquire: artifactKey => this.qualityWorkflow.acquireCleanupLock(artifactKey),
        release: artifactKey => this.qualityWorkflow.releaseCleanupLock(artifactKey),
      },
      refreshLocalCacheState: () => this.refreshLocalCacheState(),
      pokeDownloadQueue: () => this.downloadQueue.poke(),
      dispatchPersistentJobs: () => this.dispatchPersistentJobs(),
      reconcileObsoleteVerifiedArchiveRecoveries: (limit, filter, concurrency) => this.recoveryWorkflow.reconcileObsoleteVerifiedArchiveRecoveries(limit, filter, concurrency),
    });
  }

  /** Read-only admission state used by quality maintenance and contract tests. */
  isQualityArtifactCleanupLocked(artifactKey: string) {
    return this.qualityWorkflow.isCleanupLocked(artifactKey);
  }

  private enqueueChargingAccessProbe(...args: Parameters<ReturnType<typeof createAccessAdmission>['enqueueChargingAccessProbe']>) {
    return this.accessAdmissionWorkflow.enqueueChargingAccessProbe(...args);
  }
  private enqueueAvailabilityProbe(...args: Parameters<ReturnType<typeof createAccessAdmission>['enqueueAvailabilityProbe']>) {
    return this.accessAdmissionWorkflow.enqueueAvailabilityProbe(...args);
  }
  requestAvailabilityRecheck(bvid: string) { return this.accessAdmissionWorkflow.requestAvailabilityRecheck(bvid); }

  private handleSourceUnavailableTask(task: DownloadTask | QualityUpgradeDownloadTask, error: { availabilityReason?: unknown } = {}) {
    return this.accessFailureWorkflow.handleSourceUnavailableTask(task, error);
  }

  private handleChargingRestrictedTask(task: DownloadTask | QualityUpgradeDownloadTask, error: unknown) {
    return this.accessFailureWorkflow.handleChargingRestrictedTask(task, error);
  }
  private runChargingAccessProbe(job: import('../database.js').PersistentJobRecord) { return this.accessProbes.charging(job); }

  private dispatchChargingAccessProbe() {
    this.accessProbeWorkflow.dispatch();
  }

  private buildQualityUpgradeTaskSafely(job: import('../database.js').PersistentJobRecord) {
    try {
      return this.buildQualityUpgradeTask(job);
    } catch (error) {
      const summary = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error || "画质升级任务无法恢复"), 500);
      this.jobStore.parkManualRecovery(job.id, this.leaseOwner, summary, {
        awaitingManualRecovery: true,
        qualityTargetResolution: "ambiguous",
      });
      logManager.push({
        timestamp: new Date(this.now()).toISOString(),
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

  private dispatchPersistentJobs() { this.persistentJobDispatcher.dispatch(); }

  private schedulePersistentJobWake() {
    this.timers.cancel('dispatch');
    const nextAt = this.jobStore.nextDueAt();
    if (nextAt === undefined) return;
    this.timers.start('dispatch', () => {
      this.dispatchPersistentJobs();
    }, Math.max(this.persistentJobWakeMinMs, nextAt - this.now()));
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

  private commitVerifiedTransfer(
    task: UploadTask | UploadVerificationTask,
    result: NonNullable<UploadTask["result"]>,
    partialBackup = false,
    historyOnly = false,
    encodingRetry?: EncodingRetryContext,
  ) {
    this.verifiedTransferCommit(task, result, partialBackup, historyOnly, encodingRetry);
  }

  private verificationHandlers() {
    return createVerificationHandlers({
      jobStore: this.jobStore, stateManager: this.stateManager, transferSessions: this.transferSessions,
      uploadCircuit: this.transferRuntime.circuit, localCleanup: this.localCleanup, leaseOwner: this.leaseOwner, now: this.now,
      isEncodingRetryParentActive: this.isEncodingRetryParentActive.bind(this),
      dispatchPersistentJobs: this.dispatchPersistentJobs.bind(this),
      commitVerifiedTransfer: this.commitVerifiedTransfer.bind(this),
      afterEncodingRetryCommitted: this.afterEncodingRetryCommitted.bind(this),
      finishEncodingRetryFailure: this.finishEncodingRetryFailure.bind(this),
      schedulePersistentJobWake: this.schedulePersistentJobWake.bind(this),
      scheduleUploadProbe: this.transferWorkflow.scheduleUploadProbe,
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

  private isEncodingRetryParentActive(context: EncodingRetryContext) {
    return this.encodingRecoveryWorkflow.isEncodingRetryParentActive(context);
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
    return this.encodingRecoveryWorkflow.finishEncodingRetryFailure(bvid, context, reason, remoteStatus, childJobId, assessmentKind, payloadPatch);
  }

  private afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext) {
    return this.encodingRecoveryWorkflow.afterEncodingRetryCommitted(bvid, context);
  }

  private handleEncodingRetryDownloadError(task: DownloadTask, error: unknown) {
    return this.encodingRecoveryWorkflow.handleEncodingRetryDownloadError(task, error);
  }

  private handleEncodingRetryUploadError(task: UploadTask, error: unknown) {
    return this.encodingRecoveryWorkflow.handleEncodingRetryUploadError(task, error);
  }

  private queueAutomaticQualityRecovery(jobId: string, failure: UploadFailureInfo) { return queueAutomaticQualityRecovery({jobStore: this.jobStore, now: this.now}, jobId, failure); }

  private historySnapshotSegment(value: string) {
    return String(value || new Date(this.now()).toISOString()).replace(/[-:.]/g, "").replace(/Z$/, "Z");
  }

  private buildUploadTask(item: RecoveryUploadItem) { return this.transferWorkflow.buildUploadTask(item); }
  private queueUploadWork(item: RecoveryUploadItem, dispatch = true) { return this.transferWorkflow.enqueue(item, dispatch); }

  getRecoveryIssues() { return this.recoveryWorkflow.getRecoveryIssues(); }
  getRecoveryIssueSnapshot() { return this.recoveryWorkflow.getRecoveryIssueSnapshot(); }
  resolveRecoveryIssue(...args: Parameters<ReturnType<typeof createRecoveryWorkflow>['resolveRecoveryIssue']>) { return this.recoveryWorkflow.resolveRecoveryIssue(...args); }
  recoverUploadJob(...args: Parameters<ReturnType<typeof createRecoveryWorkflow>['recoverUploadJob']>) { return this.recoveryWorkflow.recoverUploadJob(...args); }

  runRecoveryAutomationNow() {
    return this.recoveryAutomation.run();
  }

  private buildPersistentUploadJob(item: RecoveryUploadItem): EnqueuePersistentJob {
    return this.transferWorkflow.buildPersistentUploadJob(item);
  }

  refreshRecoveryProjection(force = false) {
    if (!this.runtime.accepting || this.maintenance.isAnyLocked()) return;
    this.recoveryWorkflow.reconcileLegacyDownloadRecoveryJobs();
    this.reconcileTransferSessionRecoveryJobs(force);
  }

  private reconcileTransferSessionRecoveryJobs(force = false) {
    return this.transferRecoveryProjection.reconcile(force);
  }

  resumePersistedWorkOnStartup() {
    return this.startupWorkflow.resumePersistedWorkOnStartup();
  }

  private snapshotRetirementTargets(bvid: string) {
    return this.retirementTransferWorkflow.snapshotRetirementTargets(bvid);
  }

  private persistCompletedRetirementUploadJobs(bvid: string, local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>, targets: UploadTarget[]) {
    return this.retirementTransferWorkflow.persistCompletedRetirementUploadJobs(bvid, local, targets);
  }

  private queueCompletedRetirementUpload(bvid: string, local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>, targets: UploadTarget[]) {
    return this.retirementTransferWorkflow.queueCompletedRetirementUpload(bvid, local, targets);
  }

  private findCompletedQualitySession(job: import('../database.js').PersistentJobRecord) {
    return this.retirementTransferWorkflow.findCompletedQualitySession(job);
  }

  async retireUser(user: BiliUser) {
    return this.accountRetirement.retireUser(user);
  }

  async prepareSourceDeletion(userId: string, mediaId: number, bvid: string, timeoutMs = 30_000) {
    return this.sourceDeletionWorkflow.prepareSourceDeletion(userId, mediaId, bvid, timeoutMs);
  }

  async quiesceUserRemoteDeletion(user: BiliUser, timeoutMs = 30_000) {
    return this.sourceDeletionWorkflow.quiesceUserRemoteDeletion(user, timeoutMs);
  }

  finalizeUserRemoteDeletion(userId: string, commit: () => void = () => undefined) {
    return this.sourceDeletionWorkflow.finalizeUserRemoteDeletion(userId, commit);
  }

  restoreUserAfterLogin(userId: string) {
    return this.accountRetirement.restoreUserAfterLogin(userId);
  }

  start() {
    if (this.runtime.shuttingDown || this.runtime.rebinding) return false;
    this.initializeRuntime();
    if (!this.runtime.admit()) return false;
    this.syncWorkflow.start();
    this.accessProbeWorkflow.start();
    this.downloadAdmission.start();
    this.transferRuntime.start();
    this.qualityWorkflow.start();
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
    summary?: { id: string; status: string; sourceRoot: string; destinationRoot: string } | { id: string }
  ) {
    this.maintenance.setPath(locked, summary);
  }

  isPathMigrationLocked() {
    return this.maintenance.pathLocked();
  }

  setArchiveDeletionMaintenance(locked: boolean, summary?: {
    id: string;
    status?: string;
    scope?: string;
    userId?: string;
    mediaId?: number;
    bvid?: string;
  }) {
    this.maintenance.setArchive(locked, summary);
  }

  isArchiveDeletionLocked() {
    return this.maintenance.archiveLocked();
  }

  private isUserSyncEligible(user: BiliUser | null | undefined): user is BiliUser {
    return Boolean(user?.enabled && !this.stateManager.getDatabase().hasUnfinishedArchiveAccountDeletion(user.id));
  }

  applyConfigUpdate(previous: AppConfig, next: AppConfig) {
    this.runtimeConfig.applyConfigUpdate(previous, next);
  }

  updateInterval() {
    this.runtimeConfig.updateInterval();
  }

  private stopWorkProducers() {
    this.syncWorkflow?.stop();
    this.accessProbeWorkflow?.stop();
    this.downloadAdmission?.stop();
    this.transferRuntime?.stop();
    this.qualityWorkflow.stop();
    this.timers.stopProducers();
    this.polling.stop();
    this.recoveryAutomation.stop();
    this.localCleanup.stop();
  }

  stop() { this.runtime.stop(); }
  beginShutdown() { this.runtime.beginShutdown(); }
  isIdle() { return this.runtime.isIdle(); }
  waitForIdle(timeoutMs = 20_000) { return this.runtime.waitForIdle(timeoutMs); }
  wake() {
    if (this.runtime.shuttingDown || !this.runtime.accepting) return false;
    this.downloadQueue.poke();
    this.uploadQueue.poke();
    this.verificationQueue.poke();
    this.dispatchPersistentJobs();
    return true;
  }
  shutdown(timeoutMs = 20_000, options: ShutdownOptions = {}) {
    return this.runtime.shutdown(timeoutMs, options);
  }
  reloadStateDatabase() { this.runtime.rebind(); }
  resumeAfterStateRebind() {
    this.runtime.resume();
    this.legacyImportRecoveryWorkflow.afterAdmissionResumed();
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
    return this.workState.hasRunningTransferTasks();
  }

  private startRecoveryAutomation() {
    this.recoveryAutomation.start();
  }

  hasPersistentTransferWork() {
    return this.workState.hasPersistentTransferWork();
  }

  hasActiveOrQueuedSchedulerWork() {
    return this.workState.hasActiveOrQueuedSchedulerWork();
  }
  refreshLocalCacheState() { this.localCapacity.reconfigure(); }


  withCleanupLock<T>(fn: () => Promise<T>) {
    return this.maintenance.withCleanupLease(fn);
  }

  enqueueQualityUpgrade(task: QualityUpgradeTask) {
    return this.qualityWorkflow.enqueue(task);
  }

  wakeChargingAccessProbes(userId?: string) { return this.accessProbeWakeup.wake(userId); }

  captureLegacyRecoveryMarkers() { return this.legacyImportRecoveryWorkflow.capture(); }

  async getLocalCacheCapacity() {
    const snapshot = await this.localCapacity.refresh();
    return {
      limitBytes: snapshot.limitBytes,
      usedBytes: snapshot.usedBytes,
      reserveBytes: snapshot.reserveBytes,
    };
  }

  recheckLegacyRecoveryAfterImport(restored: string[], previousMarkers: LegacyRecoveryMarkers) {
    return this.legacyImportRecoveryWorkflow.resume(restored, previousMarkers);
  }

  hasQualityUpgrade(userId: string, mediaId: number, bvid: string) {
    return this.jobStore.hasQualityTarget(userId, mediaId, bvid);
  }

  getQualityUpgradeTargetKeys() {
    return this.jobStore.listQualityTargetKeys();
  }

  getQualityUpgradeState() {
    return this.qualityUpgradeProjection.getState();
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

  private canStartDownloadTask(task?: DownloadTask | QualityUpgradeDownloadTask) {
    return this.downloadAdmissionPolicy.canStart(task);
  }

  private canCreateDownloadTask() {
    return this.downloadAdmissionPolicy.canCreate();
  }

  private updateSchedulerProgress(patch: Partial<SchedulerSnapshot>) {
    this.syncWorkflow.updateProgress(patch);
  }

  getQueueSnapshot() {
    return this.statusProjection.getQueueSnapshot();
  }

  async tick(manual = false, options: TickOptions = {}) {
    return this.syncWorkflow.run(manual, options);
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
    return this.archiveTargets.collectUploadTargets(bvid, fallback);
  }

  private enqueueIfNeeded(user: BiliUser, mediaId: number, folderTitle: string, bvid: string, options: BackupEnqueueOptions = {}) {
    return this.backupEnqueueWorkflow.enqueue(user, mediaId, folderTitle, bvid, options);
  }

  private triggerOrQueueTick(options: TickOptions) {
    if (!this.runtime.accepting || this.maintenance.isAnyLocked()) {
      return { started: false, queued: false };
    }
    return this.syncWorkflow.triggerOrQueue(options);
  }

  private async verifyRemoteSamples(manual: boolean, force: boolean, cycle: SyncCycleStats) {
    const stats = await this.remoteScan.run(manual, force, {trigger: cycle.trigger, title: this.triggerLabel(cycle.trigger), newItems: cycle.newItems});
    return stats;
  }

  private recoverStaleActiveBackups() {
    return this.startupWorkflow.recoverStaleActiveBackups();
  }

  private startLegacyTempCacheRecovery() {
    this.startupWorkflow.startLegacyCacheRecovery();
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
    return this.manualArchiveWorkflow.enqueue(userId, item);
  }

  private ensurePersistedChargingAccessProbes() {
    return this.startupWorkflow.ensurePersistedChargingAccessProbes();
  }

  private ensurePersistedAvailabilityProbes() {
    return this.startupWorkflow.ensurePersistedAvailabilityProbes();
  }

  private resolveRelation(relation: FavoriteRelation) { return this.archiveTargets.resolveRelation(relation); }
  private resolveRelationRemotePath(user: BiliUser, mediaId: number, folderTitle: string, config = this.configStore.get()) {
    return this.archiveTargets.resolveRelationRemotePath(user, mediaId, folderTitle, config);
  }
  private findBestRelationForBvid(bvid: string) { return this.archiveTargets.findBestRelationForBvid(bvid); }

}
