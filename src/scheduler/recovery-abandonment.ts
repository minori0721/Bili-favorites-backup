import type { PersistentJobStore } from '../job-store.js';
import type { TransferSessionStore } from '../transfer-session.js';
import type { StateManager } from '../state.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import type { RecoveryIssue } from './recovery-contracts.js';
import { logManager } from '../logger.js';
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'findById' | 'abandonRecovery'>;
  transferSessions: Pick<TransferSessionStore, 'get' | 'supersede'>;
  stateManager: Pick<StateManager, 'runAtomic' | 'getRelationStatus' | 'resolveRemoteConflictCandidate'>;
  recoveryWork: { locks: RecoveryLockAccess };
  getRecoveryIssueSnapshot(): { issues: RecoveryIssue[] };
  dispatchPersistentJobs(): void;
  now(): number;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
class AbandonRejected extends Error {}
export function createRecoveryAbandonment(deps: Dependencies) {
  function abandon(jobId: string, expectedKinds: string[]) {
    const lockKey = jobId;
    if (deps.recoveryWork.locks.has(lockKey)) {
      return { ok: false as const, status: 409, message: "该待处理项正在被其他操作处理，请稍后刷新" };
    }
    deps.recoveryWork.locks.add(lockKey);
    try {
      const job = deps.jobStore.findById(jobId);
      if (!job || !expectedKinds.includes(String(job.kind))) {
        return { ok: false as const, status: 404, message: "待处理项不存在或已自动解决" };
      }
      const payload = job.payload;
      if (payload.userDisposition === "abandoned" || payload.lifecycleState === "abandoned") {
        return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (payload.awaitingManualRecovery !== true) {
        return { ok: false as const, status: 409, message: "该待处理项已经不再等待人工处理" };
      }
      if (payload.encodingRetry && ["running", "uploading", "verifying"].includes(String(record(payload.encodingRetry).state || ""))) {
        return { ok: false as const, status: 409, message: "编码替换仍在运行，请等待当前候选结束" };
      }
      try {
        deps.stateManager.runAtomic(() => {
          if (!deps.jobStore.abandonRecovery(job.id, "用户已放弃本次候选，原归档保持不变。", {
            attemptKey: payload.attemptKey || (payload.sessionId && payload.sessionGeneration
              ? `${payload.sessionId}:g${payload.sessionGeneration}` : undefined),
            recoveryReason: "user_abandoned",
          })) throw new AbandonRejected("待处理项状态已经变化，请刷新后重试");
          if (payload.sessionId) {
            const session = deps.transferSessions.get(String(payload.sessionId));
            if (!session) throw new AbandonRejected("传输会话缺失，请重新检查");
            const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
            if (session.generation !== generation) throw new AbandonRejected("当前候选已经产生新的代次，请刷新待处理项");
            if (!["completed", "superseded"].includes(session.phase) && !deps.transferSessions.supersede(session.id, generation)) {
              throw new AbandonRejected("传输会话状态已经变化，请重新检查");
            }
          }
          const candidate = record(payload.conflictCandidate);
          if (candidate.id && job.userId && Number.isInteger(job.mediaId)) {
            const relation = deps.stateManager.getRelationStatus(job.userId, Number(job.mediaId), String(job.bvid || ""));
            if (relation?.remoteConflictCandidates?.some(item => item.id === String(candidate.id) && !item.resolution)
              && !deps.stateManager.resolveRemoteConflictCandidate(String(job.bvid || ""), job.userId, job.mediaId, String(candidate.id), "abandoned")) {
              throw new AbandonRejected("候选状态已经变化，请刷新待处理项");
            }
          }
        });
      } catch (error) {
        if (error instanceof AbandonRejected) return { ok: false as const, status: 409, message: error.message };
        throw error;
      }
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
        type: "system",
        level: "info",
        summary: `用户已放弃本次恢复候选 ${job.bvid || ""}`,
        raw: `[Recovery] attempt abandoned kind=${job.kind}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      deps.dispatchPersistentJobs();
      return { ok: true as const, idempotent: false, issues: deps.getRecoveryIssueSnapshot().issues };
    } finally {
      deps.recoveryWork.locks.delete(lockKey);
    }
  }

  return { abandon };
}
