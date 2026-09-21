import path from 'node:path';
import type { StateManager } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { PersistentJobRecord } from '../database.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ConfigStore } from '../config.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { inspectRemoteFileSize } from '../uploader.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import { isVerifiedArchiveProofForRecovery } from './recovery-projection.js';
import { logManager } from '../logger.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'getRelationStatus' | 'restoreExistingArchiveProof' | 'runAtomic'>;
  jobStore: Pick<JobRepository, 'listObsoleteArchiveRecoveryCandidates' | 'removeObsoleteArchiveRecoveryCandidate' | 'findById'>;
  transferSessions: Pick<TransferSessionRepository, 'findForTarget'>;
  configStore: Pick<ConfigStore, 'get'>;
  recoveryWork: { locks: RecoveryLockAccess };
  remoteFileInspector: typeof inspectRemoteFileSize;
  canRun(): boolean;
  generation(): number;
  now(): number;
  cleanup(bvid: string, dir: string): Promise<unknown> | null;
}
class RecoveryChanged extends Error {}
export function createArchiveProofRecovery(deps: Dependencies) {
  function captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    if (!userId || !Number.isInteger(mediaId)) return undefined;
    const relation = deps.stateManager.getRelationStatus(userId, Number(mediaId), bvid);
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

  function isPlainObsoleteArchiveRecovery(job: PersistentJobRecord) {
    const payload = job.payload;
    if (job?.kind !== "upload" || !["pending", "retry_wait", "manual_wait", "failed"].includes(String(job?.status || ""))) return false;
    if (payload?.resumeOnly !== true || payload?.allowReupload === true || payload?.sessionId || payload?.encodingRetry || payload?.historyOnly) return false;
    if (payload?.conflictCandidate || payload?.conflictCandidateOnly === true || payload?.legacyConflictSideEffectsStarted === true) return false;
    if (Array.isArray(payload?.conflictArchiveVerifiedPaths) && payload.conflictArchiveVerifiedPaths.length > 0) return false;
    const files = Array.isArray(payload?.files)
      ? payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/").trim()).filter(Boolean)
      : [];
    return files.length > 0 && new Set(files).size === files.length;
  }

  async function confirmVerifiedArchiveProofForRecovery(job: PersistentJobRecord, proof: ExistingArchiveProof) {
    if (!isVerifiedArchiveProofForRecovery(job.payload, proof)) return "mismatch" as const;
    for (const file of proof.files) {
      try {
        const result = await deps.remoteFileInspector(deps.configStore.get(), String(file.path), Number(file.size));
        if (result.status !== "verified") return result.status;
      // boundary-critical: an inspection error is an unknown proof, never a
      // verified proof or an automatic deletion authorization.
      } catch {
        // boundary-critical: proof decoding failure is unknown, never verified.
        return "unknown" as const;
      }
    }
    return "verified" as const;
  }

  async function reconcileObsoleteVerifiedArchiveRecoveries(
    limit = 1000,
    scope?: { bvid?: string; userId?: string; mediaId?: number },
    concurrency = 2,
  ) {
    const epoch = deps.generation();
    let removed = 0;
    const jobs = deps.jobStore.listObsoleteArchiveRecoveryCandidates(limit, scope);
    let nextIndex = 0;
    const worker = async () => {
      while (deps.canRun() && epoch === deps.generation()) {
        const job = jobs[nextIndex++];
        if (!job) return;
        if (deps.recoveryWork.locks.has(job.id) || !isPlainObsoleteArchiveRecovery(job)) continue;
        deps.recoveryWork.locks.add(job.id);
        try {
          const bvid = String(job.bvid || job.payload?.bvid || "");
          if (!bvid || !job.userId || !Number.isInteger(job.mediaId)) continue;
          // A recoverable transfer session is authoritative. Do not remove the
          // legacy job while the session projection may still recreate work.
          if (deps.transferSessions.findForTarget(job.userId, job.mediaId, bvid)) continue;
          const proof = captureExistingArchiveProof(job.userId, job.mediaId, bvid);
          if (!proof || await confirmVerifiedArchiveProofForRecovery(job, proof) !== "verified") continue;
          if (!deps.canRun() || epoch !== deps.generation()) continue;
          try {
            deps.stateManager.runAtomic(() => {
              const current = deps.jobStore.findById(job.id);
              if (!current || current.status !== job.status || current.attempts !== job.attempts
                || current.leaseOwner !== job.leaseOwner || JSON.stringify(current.payload) !== JSON.stringify(job.payload)
                || deps.transferSessions.findForTarget(job.userId, job.mediaId, bvid)
                || !isPlainObsoleteArchiveRecovery(current)
                || !deps.stateManager.restoreExistingArchiveProof(bvid, job.userId, job.mediaId, proof)
                || !deps.jobStore.removeObsoleteArchiveRecoveryCandidate(job.id)) throw new RecoveryChanged();
            });
          } catch (error) {
            if (error instanceof RecoveryChanged) continue;
            throw error;
          }
          removed += 1;
          await deps.cleanup(bvid, String(job.payload.localDir || ""));
        } finally {
          deps.recoveryWork.locks.delete(job.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Math.floor(concurrency) || 1, jobs.length || 1)) }, worker));
    if (removed > 0) {
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
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

  return { captureExistingArchiveProof, isPlainObsoleteArchiveRecovery, confirmVerifiedArchiveProofForRecovery, reconcileObsoleteVerifiedArchiveRecoveries };
}
