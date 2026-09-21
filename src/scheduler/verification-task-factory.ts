import type { AppConfig } from '../config.js';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import { UploadVerificationTask } from '../tasks.js';
import { parseEncodingRetryContext } from './recovery-context.js';
import { parseVerificationPayload, VerificationPayloadError } from './verification-payload.js';

interface Dependencies {
  config(): AppConfig;
  sessions: TransferSessionRepository;
  jobs: Pick<JobRepository, 'parkManualRecovery'>;
  leaseOwner: string;
  rejected(job: PersistentJobRecord, reason: string): void;
}
/** Invalid persisted evidence is retained for recovery and never submitted as an empty check. */
export function createVerificationTaskFactory(deps: Dependencies) {
  return (job: PersistentJobRecord) => {
    try {
      const raw = job.payload;
      const payload = parseVerificationPayload(raw);
      if (typeof raw.remoteFile !== 'string' || !raw.remoteFile) throw new VerificationPayloadError('remoteFile');
      if (typeof raw.expectedSize !== 'number' || !Number.isFinite(raw.expectedSize) || raw.expectedSize < 0) throw new VerificationPayloadError('expectedSize');
      if (!job.bvid) throw new VerificationPayloadError('bvid');
      const task = new UploadVerificationTask(job.bvid, job.userId || '', job.mediaId || 0,
        raw.remoteFile, raw.expectedSize, deps.config(), {
          transferSessionStore: deps.sessions, sessionId: payload.sessionId, sessionGeneration: payload.sessionGeneration,
          allowReupload: false, sessionVerification: Boolean(raw.sessionVerification || payload.sessionId),
          filenameMetadataByPath: payload.filenameMetadataByPath,
          encodingRetry: parseEncodingRetryContext(payload.encodingRetry) || undefined,
        });
      task.persistentJobId = job.id;
      task.persistentJob = job;
      return task;
    } catch (error) {
      if (!(error instanceof VerificationPayloadError)) throw error;
      const parked = deps.jobs.parkManualRecovery(job.id, deps.leaseOwner, error.message, {
        awaitingManualRecovery: true, verificationPayloadInvalid: true,
      });
      if (!parked) throw Object.assign(new Error(`Verification job ownership changed while rejecting invalid evidence: ${job.id}`), {cause: error});
      deps.rejected(job, error.message);
      return null;
    }
  };
}
