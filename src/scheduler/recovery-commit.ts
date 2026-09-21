import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { StateManager, LocalCleanupPlan, RemoteFileRecord } from '../state.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';

interface RecoveryCommitDependencies {
  state: Pick<StateManager, 'runAtomic' | 'restoreExistingArchiveProof' | 'markVerifiedUpload' | 'recordLocalCleanupPlan'>;
  jobs: Pick<JobRepository, 'findById' | 'complete'>;
  sessions: Pick<TransferSessionRepository, 'get' | 'supersede' | 'listFiles' | 'updateFile' | 'updateSession'>;
}

class RecoveryCommitRejected extends Error {}

/** A rejected proof must roll back both the session and the in-memory archive projection. */
export function commitRetainedRecovery(deps: RecoveryCommitDependencies, jobId: string, proof: ExistingArchiveProof, allowResumeOnly = false) {
  try {
    return deps.state.runAtomic(() => {
      const current = deps.jobs.findById(jobId);
      if (!current) return null;
      const payload: Record<string, unknown> = current.payload;
      const resumeOnly = allowResumeOnly
        && ['manual_wait', 'retry_wait', 'failed'].includes(current.status)
        && payload.resumeOnly === true && payload.allowReupload !== true
        && !payload.sessionId && !payload.encodingRetry && !payload.historyOnly
        && !payload.conflictCandidate && payload.conflictCandidateOnly !== true
        && payload.legacyConflictSideEffectsStarted !== true
        && (!Array.isArray(payload.conflictArchiveVerifiedPaths) || payload.conflictArchiveVerifiedPaths.length === 0);
      if (payload.awaitingManualRecovery !== true && !resumeOnly) return null;
      const session = payload.sessionId ? deps.sessions.get(String(payload.sessionId)) : null;
      if (payload.sessionId && !session) return null;
      if (session) {
        const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
        if (session.generation !== generation || !deps.sessions.supersede(session.id, generation)) return null;
      }
      if (!deps.state.restoreExistingArchiveProof(String(current.bvid || ''), current.userId, current.mediaId, proof)) {
        throw new RecoveryCommitRejected('Archive relation or proof is no longer available');
      }
      if (!deps.jobs.complete(current.id)) throw new RecoveryCommitRejected('Recovery task changed before completion');
      return { job: current, localDir: String(payload.localDir || session?.localDir || '') };
    });
  } catch (error) {
    if (error instanceof RecoveryCommitRejected) return null;
    throw error;
  }
}

interface VerifiedRecoveryCommand {
  job: PersistentJobRecord;
  session: NonNullable<ReturnType<TransferSessionRepository['get']>>;
  files: ReturnType<TransferSessionRepository['listFiles']>;
  verifiedFiles: RemoteFileRecord[];
  cleanupPlan: LocalCleanupPlan | null;
  expectedGeneration: number;
  now: number;
}

/** No file or network operation belongs inside this synchronous commit boundary. */
export function commitVerifiedRecovery(deps: RecoveryCommitDependencies, command: VerifiedRecoveryCommand) {
  const { job, session, files, verifiedFiles, cleanupPlan, expectedGeneration, now } = command;
  deps.state.runAtomic(() => {
    const current = deps.jobs.findById(job.id);
    if (!current || current.payload.awaitingManualRecovery !== true
      || current.attempts !== job.attempts || current.leaseOwner !== job.leaseOwner
      || current.payload.sessionId !== job.payload.sessionId
      || current.payload.sessionGeneration !== job.payload.sessionGeneration) {
      throw new Error('Recovery task changed before commit');
    }
    const active = deps.sessions.get(session.id);
    if (!active || active.generation !== expectedGeneration) throw new Error('Recovery attempt changed before commit');
    const activeFiles = deps.sessions.listFiles(session.id, expectedGeneration);
    if (files.length === 0 || activeFiles.length !== files.length || activeFiles.some(file => !file.putAcceptedAt
      || !files.some(expected => expected.relativePath === file.relativePath
        && expected.finalPath === file.finalPath && expected.expectedSize === file.expectedSize
        && expected.putAcceptedAt === file.putAcceptedAt))) {
      throw new Error('Recovery file evidence changed before commit');
    }
    for (const file of files) {
      if (!deps.sessions.updateFile(session.id, file.relativePath, { status: 'verified', verifiedAt: now, nextCheckAt: null, lastError: null }, expectedGeneration)) {
        throw new Error('Recovery file disappeared before commit');
      }
    }
    deps.sessions.updateSession(session.id, { phase: 'completed', completedAt: now, lastError: null, allowReupload: false }, expectedGeneration);
    const payload: Record<string, unknown> = current.payload;
    const bvid = String(current.bvid || session.bvid || '');
    if (!payload.historyOnly) deps.state.markVerifiedUpload(bvid, String(payload.remotePath || session.remotePath || ''), verifiedFiles, current.userId, current.mediaId, Boolean(payload.partialBackup));
    if (cleanupPlan) deps.state.recordLocalCleanupPlan(bvid, cleanupPlan, current.id);
    if (!deps.jobs.complete(current.id)) throw new Error('Recovery task changed before completion');
  });
}
