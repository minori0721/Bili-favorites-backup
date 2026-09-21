import type { StateManager, LocalCleanupPlan } from '../state.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { UploadResult } from '../uploader.js';
import type { EncodingRetryContext } from '../tasks.js';

/** Dependencies are supplied per commit; this operation never retains a database connection. */
export interface VerifiedTransferDependencies {
  state: Pick<StateManager, 'runAtomic' | 'markVerifiedUpload' | 'recordLocalCleanupPlan'>;
  sessions: Pick<TransferSessionRepository, 'assertGeneration' | 'listFiles' | 'updateSession'>;
  jobs: Pick<JobRepository, 'complete' | 'completeEncodingRetryCommit'>;
  now(): number;
  leaseOwner: string;
}

export interface VerifiedTransferCommit {
  bvid: string;
  userId?: string;
  mediaId?: number;
  jobId?: string;
  result: UploadResult;
  partialBackup: boolean;
  historyOnly: boolean;
  encodingRetry?: EncodingRetryContext;
  cleanupPlan?: LocalCleanupPlan | null;
}

/** The proof, archive, cleanup permission and job completion are one synchronous transaction. */
export function commitVerifiedTransfer(dependencies: VerifiedTransferDependencies, command: VerifiedTransferCommit): void {
  const {state, sessions, jobs, now, leaseOwner} = dependencies;
  const {result, encodingRetry, jobId, bvid, cleanupPlan} = command;
  if (!result.allVerified || result.files.length === 0 || result.files.some(file => file.verificationStatus !== 'verified')) {
    throw new Error('Cannot commit an unverified upload group');
  }
  if (encodingRetry && !jobId) throw new Error('Encoding retry commit requires a persistent child job');
  state.runAtomic(() => {
    if (result.sessionId) {
      const session = sessions.assertGeneration(result.sessionId, result.sessionGeneration);
      const files = sessions.listFiles(session.id, session.generation);
      if (files.length !== result.files.length || files.some(file => file.status !== 'verified'
        || !result.files.some(item => item.path === file.finalPath && Number(item.size) === file.expectedSize))) {
        throw new Error('Upload proof set changed before commit');
      }
      sessions.updateSession(session.id, {phase:'completed', completedAt:now(), lastError:null}, session.generation);
    }
    if (!command.historyOnly) state.markVerifiedUpload(bvid, result.remotePath, result.files, command.userId, command.mediaId, command.partialBackup);
    if (cleanupPlan) state.recordLocalCleanupPlan(bvid, cleanupPlan, jobId);
    if (encodingRetry) {
      if (!jobs.completeEncodingRetryCommit(encodingRetry.parentJobId, encodingRetry.generation, jobId, leaseOwner)) {
        throw new Error('Encoding retry execution changed before verified commit');
      }
    } else if (jobId && !jobs.complete(jobId, leaseOwner)) {
      throw new Error('Upload task execution ownership changed before commit');
    }
  });
}
