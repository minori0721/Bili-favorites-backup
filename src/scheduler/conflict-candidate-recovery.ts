import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { joinRemotePath } from '../utils.js';
import { sanitizeUploadText } from '../upload-health.js';
import { logManager } from '../logger.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { RecoveryLockAccess } from './recovery-work.js';
interface Dependencies {
  jobStore: Pick<JobRepository, 'findById' | 'wakeManualJob'>;
  recoveryWork: { locks: RecoveryLockAccess };
  recoveryAssessment(payload: unknown): RecoveryAssessment | null;
  inspectConflictCandidateEligibility(job: PersistentJobRecord, assessment: RecoveryAssessment | null): { eligible: boolean; reason?: string; fileCount?: number; totalBytes?: number };
  observedSameSizeProof(job: PersistentJobRecord, assessment: RecoveryAssessment | null): ExistingArchiveProof | undefined;
  now(): number;
  dispatchPersistentJobs(): void;
}
export function createConflictCandidateRecovery(deps: Dependencies) {
  function start(jobId: string, automatic = false) {
    const ownsLock = !deps.recoveryWork.locks.has(jobId);
    if (!ownsLock && !automatic) {
      return { ok: false as const, status: 409, message: "该待处理任务正在被其他操作处理，请稍后刷新" };
    }
    if (ownsLock) deps.recoveryWork.locks.add(jobId);
    try {
      const job = deps.jobStore.findById(jobId);
      if (!job || job.kind !== "upload" || !job.payload.awaitingManualRecovery) {
        return { ok: false as const, status: 404, message: "待处理任务不存在或已经恢复" };
      }
      if (job.payload.conflictCandidateOnly === true) {
        return { ok: false as const, status: 409, message: "当前任务已经是隔离候选，请先处理现有候选" };
      }
      const assessment = deps.recoveryAssessment(job.payload);
      const eligibility = deps.inspectConflictCandidateEligibility(job, assessment);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能生成隔离候选：${eligibility.reason}` };
      }
      const payload = job.payload;
      const observedExistingArchiveProof = deps.observedSameSizeProof(job, assessment);
      const candidateId = String(payload.conflictCandidateId || `upload-${job.id}`);
      const candidateRemotePath = String(
        payload.conflictCandidateRemotePath
        || joinRemotePath(String(payload.remotePath || ""), "_conflicts", candidateId),
      );
      if (!payload.remotePath || !candidateRemotePath) {
        return { ok: false as const, status: 409, message: "任务缺少稳定远端路径，不能生成候选" };
      }
      const woken = deps.jobStore.wakeManualJob(job.id, {
        awaitingManualRecovery: false,
        allowReupload: false,
        resumeOnly: false,
        conflictCandidateId: candidateId,
        conflictCandidateRemotePath: candidateRemotePath,
        conflictCandidateOnly: true,
        conflictCandidateReasonCode: `RECOVERY_${String(assessment?.kind || "MANUAL_REVIEW").toUpperCase()}`,
        conflictCandidateReasonSummary: sanitizeUploadText(assessment?.summary || "用户确认生成隔离候选", 300),
        candidateStartedAt: deps.now(),
        lifecycleState: "conflict_candidate",
        userDisposition: automatic ? "automatic_candidate" : "create_candidate",
        ...(observedExistingArchiveProof ? { existingArchiveProof: observedExistingArchiveProof } : {}),
      });
      if (!woken) {
        return { ok: false as const, status: 409, message: "任务状态已经变化，请刷新后重试" };
      }
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
        type: "upload",
        level: "warn",
        summary: `开始生成隔离冲突候选 ${job.bvid || ""}`,
        raw: `[Recovery] conflict candidate requested; files=${eligibility.fileCount}; bytes=${eligibility.totalBytes}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      deps.dispatchPersistentJobs();
      return { ok: true as const, jobId: job.id };
    } finally {
      if (ownsLock) deps.recoveryWork.locks.delete(jobId);
    }
  }

  return { start };
}
