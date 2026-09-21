import type { EnqueuePersistentJob } from '../repositories/jobs.js';
import type { FavoriteRelation, StateManager } from '../state.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { createUploadTaskFactory } from './upload-task-factory.js';
import { createUploadAdmission } from './upload-admission.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import {
  QualityUpgradeCleanupTask,
  QualityUpgradeReplaceTask,
  QualityUpgradeUploadReplaceTask,
  UploadTask,
} from '../tasks.js';
import { taskUploadFailure } from './task-failure.js';
import {
  REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE,
  type UploadFailureInfo,
} from '../upload-health.js';

type TaskDependencies = Parameters<typeof createUploadTaskFactory>[0];
type AdmissionDependencies = Parameters<typeof createUploadAdmission>[0];
interface Dependencies extends Omit<TaskDependencies, 'legacyConflictSideEffectsStarted' | 'restoreConflictCandidateExistingArchive' | 'stateManager'> {
  stateManager: TaskDependencies['stateManager'] & Pick<StateManager, 'restoreExistingArchiveProof' | 'markUploadFailed'>;
  jobStore: TaskDependencies['jobStore'] & AdmissionDependencies['jobs'];
  blocked: AdmissionDependencies['blocked'];
  transferRuntime: {
    recordFailure(key: string, failure: UploadFailureInfo): UploadFailureInfo;
    clearProbeTimer(): void;
    scheduleProbe(): void;
  };
  downloadQueue: { poke(): void };
  wake(): void;
}

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type UploadPhaseTask = UploadTask | QualityUploadPhaseTask;

function uploadTaskKey(task: { id?: string; bvid?: string; userId?: string; mediaId?: number; historyOnly?: boolean; remotePath?: string }) {
  return `${task.userId || 'quality'}:${task.mediaId || 0}:${task.bvid || task.id || 'upload'}:${task.historyOnly ? task.remotePath || 'history' : 'main'}`;
}

function restoreExistingArchiveProof(
  task: UploadTask,
  state: Pick<Dependencies['stateManager'], 'restoreExistingArchiveProof'>,
) {
  const proof = task.result?.conflictCandidate?.existingArchiveProof || task.existingArchiveProof;
  if (!proof) return false;
  return state.restoreExistingArchiveProof(task.bvid, task.userId, task.mediaId, proof);
}

function supersedeSession(task: UploadTask, sessions: TransferSessionRepository) {
  if (!task.sessionId) return;
  const session = sessions.get(task.sessionId);
  if (!session) return;
  const generation = Number.isInteger(task.sessionGeneration) ? Number(task.sessionGeneration) : session.generation;
  if (session.generation === generation && !['completed', 'superseded'].includes(session.phase)) {
    sessions.supersede(session.id, generation);
  }
}

/** One entry for upload construction, durable intent and admission; runtime owns execution. */
export function createTransferWorkflow(deps: Dependencies) {
  function recoveryUploadKey(item: RecoveryUploadItem) {
    const retrySuffix = item.encodingRetry
      ? `:encoding-retry:${item.encodingRetry.parentJobId}:g${item.encodingRetry.generation}`
      : "";
    return `${item.userId || "video"}:${item.mediaId || 0}:${item.bvid}:${item.remotePath}:${item.historySnapshotAt || "main"}${retrySuffix}`;
  }

  function legacyConflictSideEffectsStarted(item: RecoveryUploadItem, relation: FavoriteRelation | null) {
    if ((item.conflictArchiveVerifiedPaths || []).length > 0) return true;
    if (!item.conflictArchiveSegment || !relation?.remoteConflictArchives?.length) return false;
    const segment = String(item.conflictArchiveSegment)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return relation.remoteConflictArchives.some((archive) => archive.archivePath.split("/").filter(Boolean).pop() === segment);
  }

  function buildPersistentUploadJob(item: RecoveryUploadItem): EnqueuePersistentJob {
    const relationProof = item.userId && Number.isInteger(item.mediaId)
      ? deps.stateManager.getRelationStatus(item.userId, Number(item.mediaId), item.bvid)
      : null;
    const persistedItem: RecoveryUploadItem = {
      ...item,
      uploadIntent: item.uploadIntent || (item.historyOnly ? "history_upload" : "normal_backup"),
      existingArchiveProof: item.encodingRetry
        ? item.existingArchiveProof
        : (item.existingArchiveProof || deps.captureExistingArchiveProof(item.userId, item.mediaId, item.bvid)),
      legacyConflictSideEffectsStarted: Boolean(
        item.legacyConflictSideEffectsStarted
        || legacyConflictSideEffectsStarted(item, relationProof),
      ),
    };
    const key = recoveryUploadKey(persistedItem);
    return {
      kind: persistedItem.historyOnly ? "history_upload" : "upload",
      dedupeKey: `upload:${key}`,
      bvid: persistedItem.bvid,
      userId: persistedItem.userId,
      mediaId: persistedItem.mediaId,
      priority: persistedItem.priority === false ? 80 : 20,
      maxAttempts: deps.configStore.get().maxRetries + 1,
      notBefore: persistedItem.awaitingManualRecovery ? 0 : (persistedItem.notBefore || 0),
      initialStatus: persistedItem.awaitingManualRecovery ? "manual_wait" : undefined,
      payload: { ...persistedItem },
    };
  }

  const restoreConflictCandidateExistingArchive = (task: UploadTask) => restoreExistingArchiveProof(task, deps.stateManager);
  const tasks = createUploadTaskFactory({...deps, legacyConflictSideEffectsStarted, restoreConflictCandidateExistingArchive});
  const enqueue = createUploadAdmission({jobs: deps.jobStore, blocked: deps.blocked, build: buildPersistentUploadJob, wake: deps.wake});
  function markUploadTaskFailed(task: UploadTask, reason: string) {
    if (task.conflictCandidateAttempted && restoreConflictCandidateExistingArchive(task)) return;
    deps.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, reason);
  }
  function recordUploadFailure(task: UploadPhaseTask, error: unknown) {
    const failure = taskUploadFailure(error, task.remotePath || '<remote>');
    if (failure.code !== REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE && !failure.remoteWriteEvidence) {
      deps.transferRuntime.recordFailure(uploadTaskKey(task), failure);
    } else {
      deps.transferRuntime.scheduleProbe();
      deps.downloadQueue.poke();
    }
    return failure;
  }
  function formatUploadFailureLog(task: UploadPhaseTask, failure: UploadFailureInfo) {
    const nextRetryAt = task.retryAt ? new Date(task.retryAt).toISOString() : 'next-cycle';
    const evidence = [
      failure.remoteErrorCode ? `remoteCode=${failure.remoteErrorCode}` : '',
      failure.remoteWriteStatus ? `writeStatus=${failure.remoteWriteStatus}` : '',
      failure.remoteParentStatus ? `parent=${failure.remoteParentStatus}` : '',
      failure.responseSnippet ? `snippet=${failure.responseSnippet}` : '',
    ].filter(Boolean).join(' ');
    return `[Upload] status=${failure.status || 'unknown'} category=${failure.category} retryable=${failure.retryable} attempt=${task.retries}/${task.maxRetries} next=${nextRetryAt} remote=<redacted>${evidence ? ` ${evidence}` : ''}: ${failure.summary}`;
  }
  return {
    buildPersistentUploadJob,
    buildUploadTask: tasks.build,
    enqueue,
    uploadTaskKey,
    restoreConflictCandidateExistingArchive,
    supersedeUploadTaskSession: (task: UploadTask) => supersedeSession(task, deps.transferSessions),
    markUploadTaskFailed,
    recordUploadFailure,
    formatUploadFailureLog,
    clearUploadProbeTimer: () => deps.transferRuntime.clearProbeTimer(),
    scheduleUploadProbe: () => deps.transferRuntime.scheduleProbe(),
  };
}
