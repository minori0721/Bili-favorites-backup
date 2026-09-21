import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { LocalCleanupPlan, RemoteFileRecord, StateManager } from '../state.js';
import { UploadTask, type EncodingRetryContext, type UploadVerificationTask } from '../tasks.js';
import { commitVerifiedTransfer as commitVerifiedTransferTransaction } from './verified-transfer.js';

interface VerifiedTransferCommitDependencies {
  state: Pick<StateManager, 'runAtomic' | 'markVerifiedUpload' | 'recordLocalCleanupPlan'>;
  sessions: Pick<TransferSessionRepository, 'assertGeneration' | 'listFiles' | 'updateSession'>;
  jobs: Pick<JobRepository, 'complete' | 'completeEncodingRetryCommit'>;
  leaseOwner: string;
  now(): number;
  buildCleanupPlan(
    bvid: string,
    localDir: string,
    remoteFiles: RemoteFileRecord[],
    reason: LocalCleanupPlan['reason'],
    options: { id?: string; transferSessionId?: string; transferGeneration?: number },
  ): LocalCleanupPlan | null;
}

/** Owns validation and the single atomic commit for a verified upload group. */
export function createVerifiedTransferCommit(deps: VerifiedTransferCommitDependencies) {
  return function commitVerifiedTransfer(
    task: UploadTask | UploadVerificationTask,
    result: NonNullable<UploadTask['result']>,
    partialBackup = false,
    historyOnly = false,
    encodingRetry?: EncodingRetryContext,
  ) {
    if (!result.allVerified || result.files.length === 0
      || result.files.some(file => file.verificationStatus !== 'verified')) {
      throw new Error('Cannot commit an unverified upload group');
    }
    if (encodingRetry && !task.persistentJobId) {
      throw new Error('Encoding retry commit requires a persistent child job');
    }
    const localDir = task instanceof UploadTask
      ? task.downloadDir
      : String(task.persistentJob?.payload.localDir || '');
    const cleanupPlan = deps.buildCleanupPlan(task.bvid, localDir, result.files, 'upload_verified', {
      id: `upload:${result.sessionId || localDir}:${result.sessionGeneration || 0}:${result.remotePath}`,
      transferSessionId: result.sessionId,
      transferGeneration: result.sessionGeneration,
    });
    commitVerifiedTransferTransaction({
      state: deps.state,
      sessions: deps.sessions,
      jobs: deps.jobs,
      now: deps.now,
      leaseOwner: deps.leaseOwner,
    }, {
      bvid: task.bvid,
      userId: task.userId,
      mediaId: task.mediaId,
      jobId: task.persistentJobId,
      result,
      partialBackup,
      historyOnly,
      encodingRetry,
      cleanupPlan,
    });
  };
}
