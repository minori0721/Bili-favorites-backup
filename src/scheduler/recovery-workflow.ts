import type {
  BBDownEncoding,
  ConfigStore
} from "../config.js";
import {
  type RecoveryIssueActionId
} from "../recovery-policy.js";
import type {
  JobRepository
} from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { RemoteFileRecord, StateManager } from "../state.js";
import type { ExistingArchiveProof } from "../upload-preflight.js";
import type { UserStore } from "../users.js";
import { createArchiveProofRecovery } from './archive-proof-recovery.js';
import { inspectConflictCandidateEligibility as inspectConflictCandidateEligibilityRule } from './conflict-candidate-eligibility.js';
import { createConflictCandidateRecovery } from './conflict-candidate-recovery.js';
import { createConflictResolution } from './conflict-resolution.js';
import { createDownloadRecoveryActions } from './download-recovery-actions.js';
import { createEncodingRecovery } from './encoding-recovery.js';
import { createLegacyDownloadRecovery } from './legacy-download-recovery.js';
import { createLegacyRecoveryProjection } from './legacy-recovery-projection.js';
import { createQualityRecovery } from './quality-recovery.js';
import { createRecoveryAbandonment } from './recovery-abandonment.js';
import { createRecoveryActions } from './recovery-actions.js';
import { createRecoveryAssessmentService } from './recovery-assessment.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import { createRecoveryFinalization } from './recovery-finalization.js';
import { downloadRecoveryTargets as downloadRecoveryTargetsRule } from './recovery-identifiers.js';
import { createRecoveryIssueProjection } from './recovery-issue-projection.js';
import { inspectRecoveryLocalFiles as inspectRecoveryLocalFilesRule } from './recovery-local-files.js';
import {
  isVerifiedArchiveProofForRecovery as isVerifiedArchiveProofForRecoveryRule,
  observedSameSizeProof as observedSameSizeProofRule,
  parseExistingArchiveProof,
  parseRecoveryAssessment,
  verifiedFilesFromRecovery as verifiedFilesFromRecoveryRule,
} from './recovery-projection.js';
import { createRecoveryWork } from './recovery-work.js';
import { createUploadResumeService } from './upload-resume.js';

type ProofDeps = Parameters<typeof createArchiveProofRecovery>[0];
type FinalizationDeps = Parameters<typeof createRecoveryFinalization>[0];
type ConflictDeps = Parameters<typeof createConflictResolution>[0];
type LegacyDeps = Parameters<typeof createLegacyDownloadRecovery>[0];
type IssueDeps = Parameters<typeof createRecoveryIssueProjection>[0];
interface RecoveryWorkflowDependencies {
  stateManager: ProofDeps['stateManager'] & FinalizationDeps['stateManager'] & ConflictDeps['state'] & LegacyDeps['stateManager'] & IssueDeps['state'] & Pick<StateManager, 'runBatch' | 'markRelationRetryPending'>;
  jobStore: Pick<JobRepository, 'findById' | 'complete' | 'updatePayload' | 'listManualRecovery' | 'listFailed' | 'listObsoleteArchiveRecoveryCandidates' | 'removeObsoleteArchiveRecoveryCandidate' | 'findByDedupeKey' | 'startEncodingRetry' | 'abandonRecovery' | 'list' | 'enqueue' | 'listLegacyDownloadRecovery' | 'findLegacyDownloadRecovery' | 'wakeManualJob' | 'restartFailedQualityAsDownload'>;
  transferSessions: ProofDeps['transferSessions'] & FinalizationDeps['transferSessions'] & Pick<TransferSessionRepository, 'get' | 'listFiles' | 'supersede'>;
  database(): ReturnType<LegacyDeps['database']> & ReturnType<Parameters<typeof createLegacyRecoveryProjection>[0]['database']>;
  atomic<T>(work: () => T): T;
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById' | 'list'>;
  uploadCircuit: IssueDeps['uploadCircuit'];
  remoteFileInspector: ProofDeps['remoteFileInspector'];
  videoAccessProbe: LegacyDeps['videoAccessProbe'];
  legacyTempDir: string;
  canRun(): boolean;
  generation(): number;
  now(): number;
  cleanup: ProofDeps['cleanup'];
  resolveRelation: LegacyDeps['resolveRelation'];
  isUserSyncEligible: LegacyDeps['isUserSyncEligible'];
  prepareDownload: FinalizationDeps['prepareDownload'];
  buildLocalCleanupPlan: FinalizationDeps['buildLocalCleanupPlan'];
  isSafeEncodingRetryDirectory(directory: string): boolean;
  dispatchPersistentJobs(): void;
}
/** Owns recovery admission locks and in-flight assessments; runtime supplies scheduling and lifetime boundaries. */
export function createRecoveryWorkflow(deps: RecoveryWorkflowDependencies) {
  const work = createRecoveryWork<Awaited<ReturnType<ReturnType<typeof createRecoveryAssessmentService>['assess']>>>();
  const archiveProofRecovery = createArchiveProofRecovery({
    stateManager: deps.stateManager, jobStore: deps.jobStore, transferSessions: deps.transferSessions,
    configStore: deps.configStore, recoveryWork: work, remoteFileInspector: deps.remoteFileInspector,
    canRun: () => deps.canRun(), generation: () => deps.generation(), now: () => deps.now(),
    cleanup: (bvid, dir) => deps.cleanup(bvid, dir),
  });

  function captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    return archiveProofRecovery.captureExistingArchiveProof(userId, mediaId, bvid);
  }

  function isPlainObsoleteArchiveRecovery(job: import('../database.js').PersistentJobRecord) {
    return archiveProofRecovery.isPlainObsoleteArchiveRecovery(job);
  }

  async function confirmVerifiedArchiveProofForRecovery(job: import('../database.js').PersistentJobRecord, proof: ExistingArchiveProof) {
    return archiveProofRecovery.confirmVerifiedArchiveProofForRecovery(job, proof);
  }

  async function reconcileObsoleteVerifiedArchiveRecoveries(limit = 1000, scope?: { bvid?: string; userId?: string; mediaId?: number }, concurrency = 2) {
    return archiveProofRecovery.reconcileObsoleteVerifiedArchiveRecoveries(limit, scope, concurrency);
  }

  function manualRecoveryJobs() {
    return deps.jobStore.listManualRecovery(["upload", "history_upload"], 1_000);
  }

  function manualDownloadRecoveryJobs() {
    return deps.jobStore.listManualRecovery(["download"], 1_000);
  }

  const legacyRecoveryProjection = createLegacyRecoveryProjection({
    jobStore: deps.jobStore, userStore: deps.userStore, configStore: deps.configStore,
    database: () => deps.database(), resolveRelation: deps.resolveRelation,
    isUserSyncEligible: deps.isUserSyncEligible,
  });

  function reconcileLegacyDownloadRecoveryJobs() {
    return legacyRecoveryProjection.reconcileLegacyDownloadRecoveryJobs();
  }

  function recoveryAssessment(payload: unknown): RecoveryAssessment | null {
    return parseRecoveryAssessment(payload);
  }

  function inspectRecoveryLocalFiles(job: import('../database.js').PersistentJobRecord) {
    return inspectRecoveryLocalFilesRule(deps.transferSessions, job);
  }

  function inspectConflictCandidateEligibility(job: import('../database.js').PersistentJobRecord, assessment: RecoveryAssessment | null) {
    return inspectConflictCandidateEligibilityRule(deps.transferSessions, job, assessment);
  }

  function updateRecoveryAssessment(jobId: string, assessment: RecoveryAssessment) {
    const current = deps.jobStore.findById(jobId);
    if (!current || !current.payload.awaitingManualRecovery) return false;
    const persistedAssessment: RecoveryAssessment = {
      ...assessment,
      candidateEligible: inspectConflictCandidateEligibility(current, assessment).eligible,
    };
    const previous = recoveryAssessment(current.payload);
    if (previous && JSON.stringify(previous) === JSON.stringify(persistedAssessment)) return true;
    return deps.jobStore.updatePayload(jobId, {
      ...current.payload,
      recoveryAssessment: persistedAssessment,
    });
  }

  function verifiedFilesFromRecovery(job: import('../database.js').PersistentJobRecord, files: ReturnType<TransferSessionRepository["listFiles"]>): RemoteFileRecord[] {
    return verifiedFilesFromRecoveryRule(job.payload, files);
  }

  function persistedExistingArchiveProof(payload: unknown): ExistingArchiveProof | null {
    return parseExistingArchiveProof(payload);
  }

  function observedSameSizeProof(job: import('../database.js').PersistentJobRecord, assessment: RecoveryAssessment | null): ExistingArchiveProof | undefined {
    return observedSameSizeProofRule(job.payload, assessment, deps.transferSessions, deps.now);
  }

  function isVerifiedArchiveProofForRecovery(job: import('../database.js').PersistentJobRecord, proof: ExistingArchiveProof) {
    return isVerifiedArchiveProofForRecoveryRule(job?.payload, proof);
  }

  const recoveryFinalization = createRecoveryFinalization({
    stateManager: deps.stateManager, jobStore: deps.jobStore, transferSessions: deps.transferSessions,
    resolveRelation: deps.resolveRelation, prepareDownload: deps.prepareDownload,
    verifiedFilesFromRecovery, buildLocalCleanupPlan: deps.buildLocalCleanupPlan,
    cleanup: (bvid, dir) => deps.cleanup(bvid, dir), now: () => deps.now(),
    dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
  });

  function finalizeRetainedArchiveRecovery(job: import('../database.js').PersistentJobRecord, proof: ExistingArchiveProof, options: { allowResumeOnly?: boolean } = {}) {
    return recoveryFinalization.finalizeRetainedArchiveRecovery(job, proof, options);
  }

  function finalizeVerifiedRecovery(job: import('../database.js').PersistentJobRecord, session: NonNullable<ReturnType<TransferSessionRepository["get"]>>, files: ReturnType<TransferSessionRepository["listFiles"]>) {
    return recoveryFinalization.finalizeVerifiedRecovery(job, session, files);
  }

  function queueFreshDownloadForRecovery(job: import('../database.js').PersistentJobRecord, localStatus: RecoveryAssessment["localStatus"], userInitiated = false) {
    return recoveryFinalization.queueFreshDownloadForRecovery(job, localStatus, userInitiated);
  }

  function assessManualRecoveryJob(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    return work.run(jobId, () => assessManualRecoveryJobOnce(jobId, options));
  }

  function assessManualRecoveryJobOnce(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    return createRecoveryAssessmentService({
      jobStore: deps.jobStore, transferSessions: deps.transferSessions, configStore: deps.configStore,
      recoveryJobLocks: work.locks, remoteFileInspector: deps.remoteFileInspector,
      now: () => deps.now(),
      atomic: deps.atomic,
      recoveryAssessment,
      captureExistingArchiveProof,
      isVerifiedArchiveProofForRecovery,
      updateRecoveryAssessment,
      inspectRecoveryLocalFiles,
      persistedExistingArchiveProof,
      finalizeRetainedArchiveRecovery,
      finalizeVerifiedRecovery,
      startConflictCandidate,
      queueFreshDownloadForRecovery,
    }).assess(jobId, options);
  }

  const recoveryIssueProjection = createRecoveryIssueProjection({
    jobs: deps.jobStore,
    users: deps.userStore,
    state: deps.stateManager,
    uploadCircuit: deps.uploadCircuit,
    now: deps.now,
    isUserSyncEligible: user => deps.isUserSyncEligible(user),
    manualRecoveryJobs: () => manualRecoveryJobs(),
    manualDownloadRecoveryJobs: () => manualDownloadRecoveryJobs(),
    recoveryAssessment: payload => recoveryAssessment(payload),
    inspectConflictCandidateEligibility: (job, assessment) => inspectConflictCandidateEligibility(job, assessment),
    persistedExistingArchiveProof: payload => persistedExistingArchiveProof(payload),
  });

  function qualityEncodingRetryEligibility(job: import('../database.js').PersistentJobRecord) {
    return recoveryIssueProjection.qualityEncodingRetryEligibility(job);
  }

  function qualityQualityRetryEligibility(job: import('../database.js').PersistentJobRecord) {
    return recoveryIssueProjection.qualityQualityRetryEligibility(job);
  }

  function getRecoveryIssues() {
    return recoveryIssueProjection.getRecoveryIssues();
  }

  function getRecoveryIssueSnapshot() {
    return recoveryIssueProjection.getRecoveryIssueSnapshot();
  }

  async function resolveConflictCandidate(jobId: string, resolution: "keep_existing" | "use_candidate") {
    return createConflictResolution({
      jobs: deps.jobStore, state: deps.stateManager, sessions: deps.transferSessions,
      config: deps.configStore, locks: work.locks, inspect: deps.remoteFileInspector,
      proof: persistedExistingArchiveProof, generation: () => deps.generation(),
      now: () => deps.now(), cleanup: (bvid, localDir) => deps.cleanup(bvid, localDir),
      dispatch: () => deps.dispatchPersistentJobs(), snapshot: getRecoveryIssueSnapshot,
    }).resolve(jobId, resolution);
  }

  function abandonRecoveryJob(jobId: string, expectedKinds: string[]) {
    return createRecoveryAbandonment({
      jobStore: deps.jobStore, transferSessions: deps.transferSessions, stateManager: deps.stateManager,
      recoveryWork: work, now: () => deps.now(),
      getRecoveryIssueSnapshot,
      dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
    }).abandon(jobId, expectedKinds);
  }

  async function startEncodingRetry(jobId: string, priority: BBDownEncoding[], strict: boolean, requestedQuality?: string) {
    return createEncodingRecovery({
      jobStore: deps.jobStore, configStore: deps.configStore, userStore: deps.userStore,
      stateManager: deps.stateManager, locks: work.locks, legacyTempDir: deps.legacyTempDir,
      recoveryAssessment,
      inspectRecoveryLocalFiles,
      isSafeEncodingRetryDirectory: deps.isSafeEncodingRetryDirectory,
      isArchiveSourceDeletionBlocked: (userId, mediaId, bvid) => deps.database().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
      dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
    }).start(jobId, priority, strict, requestedQuality);
  }

  function startConflictCandidate(jobId: string, automatic = false) {
    return createConflictCandidateRecovery({
      jobStore: deps.jobStore, recoveryWork: work,
      recoveryAssessment,
      inspectConflictCandidateEligibility,
      observedSameSizeProof,
      now: () => deps.now(), dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
    }).start(jobId, automatic);
  }

  function downloadRecoveryTargets(job: import('../database.js').PersistentJobRecord) {
    return downloadRecoveryTargetsRule(job);
  }

  function resumeDownloadRecoveryRelations(job: import('../database.js').PersistentJobRecord, reason: string) {
    const bvid = String(job?.bvid || "");
    if (!bvid) return;
    deps.stateManager.runBatch(() => {
      for (const target of downloadRecoveryTargets(job)) {
        const relation = deps.stateManager.getRelationStatus(target.userId, target.mediaId, bvid);
        if (!relation?.activeInFavorite || relation.accountDetachedAt) continue;
        if (deps.database().isArchiveSourceDeletionBlocked(target.userId, target.mediaId, bvid)) continue;
        deps.stateManager.markRelationRetryPending(bvid, target.userId, target.mediaId, reason);
      }
    });
  }

  async function resolveLegacyDownloadFailureIssue(issueKey: string, action: RecoveryIssueActionId, options: { userId?: unknown }) {
    return createLegacyDownloadRecovery({
      database: () => deps.database(), stateManager: deps.stateManager,
      jobStore: deps.jobStore, userStore: deps.userStore, recoveryWork: work,
      videoAccessProbe: deps.videoAccessProbe, generation: () => deps.generation(), now: () => deps.now(),
      resolveRelation: deps.resolveRelation, isUserSyncEligible: deps.isUserSyncEligible,
      prepareBackup: deps.prepareDownload, dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
      getRecoveryIssueSnapshot,
    }).resolve(issueKey, action, options);
  }

  async function resolveDownloadRecoveryIssue(
    jobId: string, action: RecoveryIssueActionId,
    options: { userId?: unknown; encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    return createDownloadRecoveryActions({
      jobStore: deps.jobStore, configStore: deps.configStore, userStore: deps.userStore,
      generation: () => deps.generation(),
      recoveryWork: work, videoAccessProbe: deps.videoAccessProbe, now: () => deps.now(),
      isUserSyncEligible: deps.isUserSyncEligible,
      resumeDownloadRecoveryRelations,
      abandonRecoveryJob,
      resolveLegacyDownloadFailureIssue,
      getRecoveryIssueSnapshot,
      dispatchPersistentJobs: () => deps.dispatchPersistentJobs(),
    }).resolve(jobId, action, options);
  }

  function restartQualityRecovery(jobId: string, options: { priority?: BBDownEncoding[]; strictEncoding?: boolean; quality?: string }) {
    return createQualityRecovery({
      jobStore: deps.jobStore, configStore: deps.configStore, userStore: deps.userStore, now: () => deps.now(),
      qualityQualityRetryEligibility,
      qualityEncodingRetryEligibility,
      isUserSyncEligible: deps.isUserSyncEligible,
      dispatchPersistentJobs: deps.dispatchPersistentJobs,
      getRecoveryIssueSnapshot,
    }).restart(jobId, options);
  }

  async function resolveRecoveryIssue(issueId: string, action: RecoveryIssueActionId, options: { encodingPriority?: unknown; strict?: unknown; userId?: unknown; quality?: unknown } = {}) {
    return createRecoveryActions({
      jobStore: deps.jobStore, configStore: deps.configStore, recoveryWork: work,
      getRecoveryIssueSnapshot,
      resolveLegacyDownloadFailureIssue,
      resolveDownloadRecoveryIssue,
      abandonRecoveryJob,
      assessManualRecoveryJob,
      recoverUploadJob,
      startConflictCandidate,
      recoveryAssessment,
      queueFreshDownloadForRecovery,
      startEncodingRetry,
      resolveConflictCandidate,
      restartQualityRecovery,
      dispatchPersistentJobs: deps.dispatchPersistentJobs,
    }).resolve(issueId, action, options);
  }

  async function recoverUploadJob(jobId: string, allowReupload = false) {
    return createUploadResumeService({
      jobStore: deps.jobStore, transferSessions: deps.transferSessions, recoveryWork: work,
      generation: () => deps.generation(),
      isPlainObsoleteArchiveRecovery,
      captureExistingArchiveProof,
      confirmVerifiedArchiveProofForRecovery,
      finalizeRetainedArchiveRecovery,
      dispatchPersistentJobs: deps.dispatchPersistentJobs,
    }).recover(jobId, allowReupload);
  }
  return { startConflictCandidate, captureExistingArchiveProof, reconcileObsoleteVerifiedArchiveRecoveries, reconcileLegacyDownloadRecoveryJobs, assessManualRecoveryJob, getRecoveryIssues, getRecoveryIssueSnapshot, resolveRecoveryIssue, recoverUploadJob, get busy() { return work.busy; } };
}
