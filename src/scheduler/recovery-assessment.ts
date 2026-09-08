import path from 'node:path';
import type { PersistentJobRecord } from '../database.js';
import type { PersistentJobStore } from '../job-store.js';
import type { TransferSessionStore } from '../transfer-session.js';
import type { ConfigStore } from '../config.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { inspectRemoteFileSize } from '../uploader.js';
import { classifyRemoteFailure, type RemoteFailureCategory, type RemoteFailureInfo } from '../remote-file-resolver.js';
import { sanitizeUploadText } from '../upload-health.js';
import { recordRemoteVisibilityObservation } from '../recovery-policy.js';
import { AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT } from './retry-policy.js';
import { RECOVERY_AUTOMATION_INTERVAL_MS } from './recovery-automation.js';
import { readTaskFailure } from './task-failure.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { RecoveryLockAccess } from './recovery-work.js';
type Session = NonNullable<ReturnType<TransferSessionStore['get']>>;
type Files = ReturnType<TransferSessionStore['listFiles']>;
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'findById' | 'complete'>;
  transferSessions: Pick<TransferSessionStore, 'get' | 'listFiles' | 'supersede'>;
  configStore: Pick<ConfigStore, 'get'>;
  recoveryJobLocks: RecoveryLockAccess;
  remoteFileInspector: typeof inspectRemoteFileSize;
  now(): number;
  atomic<T>(work: () => T): T;
  recoveryAssessment(payload: unknown): RecoveryAssessment | null;
  captureExistingArchiveProof(userId: string, mediaId: number, bvid: string): ExistingArchiveProof | undefined;
  isVerifiedArchiveProofForRecovery(job: Pick<PersistentJobRecord, 'payload'>, proof: ExistingArchiveProof): boolean;
  updateRecoveryAssessment(jobId: string, assessment: RecoveryAssessment): unknown;
  inspectRecoveryLocalFiles(job: PersistentJobRecord): { status: RecoveryAssessment['localStatus']; session: Session | null; files: Files };
  persistedExistingArchiveProof(payload: unknown): ExistingArchiveProof | null;
  finalizeRetainedArchiveRecovery(job: PersistentJobRecord, proof: ExistingArchiveProof): boolean;
  finalizeVerifiedRecovery(job: PersistentJobRecord, session: Session, files: Files): boolean;
  startConflictCandidate(jobId: string, automatic: boolean): { ok: boolean };
  queueFreshDownloadForRecovery(job: PersistentJobRecord, status: RecoveryAssessment['localStatus'], initiated: boolean): boolean;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
/** Evaluates evidence without issuing uploads; actions go through explicit recovery admission. */
export function createRecoveryAssessmentService(deps: Dependencies) {
  function buildRemoteRecoveryAssessment(
    localStatus: RecoveryAssessment["localStatus"],
    error: unknown,
    subject: string,
  ): RecoveryAssessment {
    const failure = classifyRemoteFailure(error);
    const kindByCategory: Record<RemoteFailureCategory, RecoveryAssessment["kind"]> = {
      transient: "remote_connection",
      permission: "remote_permission",
      unsupported: "remote_unsupported",
      not_found: "remote_unknown",
      conflict: "remote_unknown",
      unknown: "remote_unknown",
    };
    const statusByCategory: Record<RemoteFailureCategory, RecoveryAssessment["remoteStatus"]> = {
      transient: "transient",
      permission: "permission",
      unsupported: "unsupported",
      not_found: "unknown",
      conflict: "unknown",
      unknown: "unknown",
    };
    const detail = sanitizeUploadText(readTaskFailure(error).message || error, 180);
    const summary = failure.category === "transient"
      ? `暂时无法连接 AList / OpenList 复核${subject}；系统会在后台自动重试，不会重复上传或删除文件。${detail ? `（${detail}）` : ""}`
      : failure.category === "permission"
        ? `AList / OpenList 拒绝了${subject}的只读复核，请检查存储认证；系统不会继续上传或删除文件。${detail ? `（${detail}）` : ""}`
        : failure.category === "unsupported"
          ? `AList / OpenList 不支持当前${subject}复核方法，需要人工确认后再处理。${detail ? `（${detail}）` : ""}`
          : `AList / OpenList 返回了无法安全分类的${subject}错误，需要人工复核；系统不会猜测远端状态。${detail ? `（${detail}）` : ""}`;
    return {
      kind: kindByCategory[failure.category],
      checkedAt: deps.now(),
      nextCheckAt: failure.category === "transient" ? deps.now() + RECOVERY_AUTOMATION_INTERVAL_MS : undefined,
      localStatus,
      remoteStatus: statusByCategory[failure.category],
      failureCategory: failure.category,
      operation: "inspect",
      summary,
    };
  }

  async function assess(jobId: string, options: { force?: boolean; allowAutomatic?: boolean } = {}) {
    if (deps.recoveryJobLocks.has(jobId)) return { changed: false, busy: true };
    deps.recoveryJobLocks.add(jobId);
    try {
      const job = deps.jobStore.findById(jobId);
      if (!job || !job.payload.awaitingManualRecovery) return { changed: false, stale: true };
      const previous = deps.recoveryAssessment(job.payload);
      const retryState = record(job.payload.encodingRetry);
      if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))) {
        return { changed: false, busy: true };
      }
      if (!options.force && previous) {
        if (!previous.nextCheckAt || previous.nextCheckAt > deps.now()) return { changed: false };
      }
      const payload = job.payload;
      if (payload.userDisposition === "abandoned" || payload.lifecycleState === "abandoned") return { changed: false, stale: true };
      if (payload.emptyAttempt) {
        const session = deps.transferSessions.get(String(payload.sessionId || ""));
        if (!session || session.generation !== payload.sessionGeneration || deps.transferSessions.listFiles(session.id, session.generation).length > 0) {
          return { changed: false, stale: true };
        }
        let proof: ExistingArchiveProof | undefined;
        try {
          if (session.userId && Number.isInteger(session.mediaId) && !session.historyOnly) {
            proof = deps.captureExistingArchiveProof(session.userId, session.mediaId!, session.bvid);
          }
          const priorFiles = session.generation > 1 ? deps.transferSessions.listFiles(session.id, session.generation - 1) : [];
          const matching = proof && priorFiles.length > 0 && priorFiles.every((file) => file.status === "verified" && file.putAcceptedAt)
            && priorFiles.length === proof.files.length
            && priorFiles.every((file) => proof!.files.some((item) => item.path === file.finalPath && Number(item.size) === file.expectedSize))
            && deps.isVerifiedArchiveProofForRecovery({ payload: { ...payload, files: priorFiles.map((file) => file.relativePath) } }, proof);
          if (matching && proof) {
            const observations = [];
            for (const file of proof.files) observations.push(await deps.remoteFileInspector(deps.configStore.get(), file.path, Number(file.size)));
            if (observations.every((result) => result.status === "verified")) {
              const changed = deps.atomic(() => {
                const latest = deps.jobStore.findById(job.id);
                if (!latest || latest.payload.userDisposition === "abandoned") return false;
                const active = deps.transferSessions.get(session.id);
                if (!active || active.generation !== session.generation || deps.transferSessions.listFiles(active.id, active.generation).length > 0) return false;
                if (!deps.transferSessions.supersede(active.id, active.generation)) return false;
                deps.jobStore.complete(job.id);
                return true;
              });
              return { changed, resolved: changed };
            }
          }
        } catch {
          // Incomplete historical evidence must never become a successful new attempt.
        }
        const assessment: RecoveryAssessment = {
          kind: "manual_review", checkedAt: deps.now(), localStatus: "unknown", remoteStatus: "unknown",
          summary: "当前传输代次缺少分P清单，已有归档证据尚不能确认；文件不会被上传或清理。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }
      if (payload.legacyConflictSideEffectsStarted || (Array.isArray(payload.conflictArchiveVerifiedPaths) && payload.conflictArchiveVerifiedPaths.length > 0)) {
        const assessment: RecoveryAssessment = {
          kind: "legacy_conflict_interrupted",
          checkedAt: deps.now(),
          localStatus: "unknown",
          remoteStatus: "unknown",
          summary: "旧式冲突归档已经移动或复制过远端文件，需要人工核对；系统不会继续覆盖、回移或删除。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }
      const candidate = record(payload.conflictCandidate);
      if (Array.isArray(candidate.files)) {
        try {
          const candidateResults = [];
          for (const fileValue of candidate.files) {
            const file = record(fileValue);
            if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0 || !file.path) break;
            candidateResults.push(await deps.remoteFileInspector(deps.configStore.get(), String(file.path), Number(file.size)));
          }
          const ready = candidateResults.length === candidate.files.length
            && candidateResults.every((result) => result.status === "verified");
          const candidateHasUnknown = candidateResults.some((result) => result.status === "unknown");
          const assessment: RecoveryAssessment = ready
            ? {
              kind: "conflict_candidate_ready",
              checkedAt: deps.now(),
              localStatus: deps.inspectRecoveryLocalFiles(job).status,
              remoteStatus: "verified",
              summary: "正式旧路径保持不变，新文件候选已完整验证；请选择保留现有归档或采用候选。",
            }
            : {
              kind: "manual_review",
              checkedAt: deps.now(),
              localStatus: deps.inspectRecoveryLocalFiles(job).status,
              remoteStatus: candidateHasUnknown
                ? "unknown"
                : (candidateResults.some((result) => result.status === "mismatch") ? "mismatch" : "missing"),
              summary: candidateHasUnknown
                ? "暂时无法确认冲突候选的远端状态，系统没有切换当前归档；稍后会自动复核。"
                : "冲突候选的远端状态已经变化，系统没有切换当前归档，请重新检查存储后端。",
            };
          deps.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        } catch (error) {
          const assessment = buildRemoteRecoveryAssessment("unknown", error, "冲突候选");
          deps.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
      }
      const existingProof = deps.persistedExistingArchiveProof(payload);
      if (existingProof?.status === "verified") {
        try {
          const oldResults = [];
          for (const file of existingProof.files) {
            if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0) break;
            oldResults.push(await deps.remoteFileInspector(deps.configStore.get(), file.path, Number(file.size)));
          }
          if (oldResults.length === existingProof.files.length && oldResults.every((result) => result.status === "verified")) {
            return { changed: deps.finalizeRetainedArchiveRecovery(job, existingProof), resolved: true };
          }
          if (oldResults.some((result) => result.status === "unknown")) {
            const assessment: RecoveryAssessment = {
              kind: "manual_review",
              checkedAt: deps.now(),
              localStatus: deps.inspectRecoveryLocalFiles(job).status,
              remoteStatus: "unknown",
              summary: "暂时无法确认现有归档的远端状态，系统没有恢复证明或重新上传。",
            };
            deps.updateRecoveryAssessment(job.id, assessment);
            return { changed: true, assessment };
          }
        } catch (error) {
          const assessment = buildRemoteRecoveryAssessment("unknown", error, "旧归档");
          deps.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
      }
      const local = deps.inspectRecoveryLocalFiles(job);
      if (!local.session || local.files.length === 0) {
        const kind = local.status === "missing" ? "local_file_missing" : (local.status === "changed" ? "local_file_changed" : "manual_review");
        const assessment: RecoveryAssessment = {
          kind,
          checkedAt: deps.now(),
          localStatus: local.status,
          remoteStatus: "unknown",
          summary: local.status === "available"
            ? "旧任务缺少可安全复核的远端文件证明，需要人工确认。"
            : "本地补传文件已失效，且旧任务缺少可安全复核的远端文件证明。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      const results: Array<{
        file: typeof local.files[number];
        status: "verified" | "missing" | "mismatch" | "unknown";
        remoteSize?: number;
        parentStatus?: "visible" | "missing" | "unknown";
        failure?: RemoteFailureInfo;
      }> = [];
      try {
        for (const file of local.files) {
          const result = await deps.remoteFileInspector(deps.configStore.get(), file.finalPath, file.expectedSize);
          results.push({ file, ...result });
        }
      } catch (error) {
        const assessment = buildRemoteRecoveryAssessment(local.status, error, "远端文件");
        deps.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      if (results.every((item) => item.status === "verified")) {
        if (local.files.every((file) => Boolean(file.putAcceptedAt))) {
          return { changed: deps.finalizeVerifiedRecovery(job, local.session, local.files), resolved: true };
        }
        const assessment: RecoveryAssessment = {
          kind: "unknown_same_size",
          checkedAt: deps.now(),
          localStatus: local.status,
          remoteStatus: "verified",
          summary: "远端文件与本地文件同大小，但缺少本次Session的PUT证明，系统没有把它标记为本次上传成功。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.candidateEligible !== false) {
          const candidate = deps.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      const unknownCount = results.filter((item) => item.status === "unknown").length;
      if (unknownCount > 0) {
        const firstFailure = results.find((item) => item.status === "unknown" && item.failure)?.failure;
        const failureCategory = firstFailure?.category || "unknown";
        const kindByFailure: Partial<Record<RemoteFailureCategory, RecoveryAssessment["kind"]>> = {
          transient: "remote_connection",
          permission: "remote_permission",
          unsupported: "remote_unsupported",
          conflict: "remote_unknown",
          not_found: "remote_unknown",
          unknown: "remote_unknown",
        };
        const candidateSafe = local.status === "available"
          && results.every((item) => item.parentStatus === "visible")
          && !["transient", "permission"].includes(failureCategory);
        const assessment: RecoveryAssessment = {
          kind: kindByFailure[failureCategory] || "remote_unknown",
          checkedAt: deps.now(),
          nextCheckAt: failureCategory === "transient" ? deps.now() + RECOVERY_AUTOMATION_INTERVAL_MS : undefined,
          localStatus: local.status,
          remoteStatus: "unknown",
          fileName: path.basename(results.find((item) => item.status === "unknown")?.file.name || ""),
          candidateSafe,
          failureCategory,
          operation: "inspect",
          summary: "暂时无法确认部分远端文件状态，系统没有重复上传、覆盖或删除；恢复检查会稍后重试。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        return { changed: true, assessment };
      }

      const mismatch = results.find((item) => item.status === "mismatch");
      const verifiedCount = results.filter((item) => item.status === "verified").length;
      const missingCount = results.filter((item) => item.status === "missing").length;
      if (mismatch || (verifiedCount > 0 && missingCount > 0)) {
        const assessment: RecoveryAssessment = {
          kind: mismatch ? "remote_size_conflict" : "partial_remote_state",
          checkedAt: deps.now(),
          localStatus: local.status,
          remoteStatus: mismatch ? "mismatch" : "mixed",
          fileName: path.basename(mismatch?.file.name || results.find((item) => item.status !== "verified")?.file.name || ""),
          expectedSize: mismatch?.file.expectedSize,
          observedSize: mismatch?.remoteSize,
          summary: mismatch
            ? "远端存在同名但大小不同的文件，系统没有覆盖或删除它。"
            : "多分P远端状态不一致，系统没有重复上传或删除任何文件。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.candidateEligible !== false) {
          const candidate = deps.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      if (results.every((item) => item.status === "missing")) {
        if (["missing", "changed"].includes(local.status)) {
          if (options.allowAutomatic && deps.queueFreshDownloadForRecovery(job, local.status, false)) {
            return { changed: true, resolved: true, redownloaded: true };
          }
          const assessment: RecoveryAssessment = {
            kind: local.status === "missing" ? "local_file_missing" : "local_file_changed",
            checkedAt: deps.now(),
            localStatus: local.status,
            remoteStatus: "missing",
            summary: Number(job.payload.automaticRecoveryAttempts || 0) >= AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT
              ? `系统已自动重新下载 ${AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT} 次，但补传文件再次失效，需要确认后再重试。`
              : "远端文件不存在，本地补传文件也已失效；可重新下载，不会删除远端内容。",
          };
          deps.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
        const parentVisible = results.length > 0
          && results.every((item) => item.status === "missing" && item.parentStatus === "visible");
        const uploadAttempts = Math.max(...local.files.map((file) => Number(file.attempts || 0)), 0);
        const priorWriteEvidence = previous?.kind === "remote_write_rejected"
          || (payload.remoteWriteEvidence === "target_missing_parent_visible");
        if (local.status === "available" && parentVisible && (priorWriteEvidence || uploadAttempts >= 2)) {
          const writeEvidence = priorWriteEvidence
            ? "target_missing_parent_visible" as const
            : "repeated_missing_parent_visible" as const;
          const assessment: RecoveryAssessment = {
            kind: "remote_write_rejected",
            checkedAt: deps.now(),
            localStatus: local.status,
            remoteStatus: "missing",
            writeStatus: previous?.writeStatus || Number(payload.remoteWriteStatus) || (priorWriteEvidence ? 405 : undefined),
            writeEvidence,
            uploadAttempts,
            summary: priorWriteEvidence
              ? "远端拒绝了写入，但目标文件仍不可见、父目录可见；WebDAV没有返回足够信息确定具体原因。可以尝试一次换编码，不代表已确认是大小限制。"
              : "多次上传后远端目标仍不可见，但父目录可见；WebDAV返回的信息不足以确定是大小限制、驱动限制还是最终一致性问题。可以尝试一次换编码。",
          };
          deps.updateRecoveryAssessment(job.id, assessment);
          return { changed: true, assessment };
        }
        const observation = recordRemoteVisibilityObservation(previous, deps.now());
        const assessment: RecoveryAssessment = {
          kind: observation.actionRequired ? "remote_visibility_stalled" : "remote_visibility_timeout",
          checkedAt: deps.now(),
          nextCheckAt: observation.nextCheckAt,
          localStatus: local.status,
          remoteStatus: "missing",
          firstObservedAt: observation.firstObservedAt,
          lastObservedAt: observation.lastObservedAt,
          consecutiveObservations: observation.consecutiveObservations,
          candidateSafe: parentVisible,
          operation: "inspect",
          summary: observation.actionRequired
            ? `远端文件已连续 ${observation.consecutiveObservations} 次不可见；系统仍会低频只读复核，也可以把完整本地文件组生成隔离候选。`
            : "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
        };
        deps.updateRecoveryAssessment(job.id, assessment);
        if (options.allowAutomatic && payload.conflictCandidateOnly !== true && assessment.kind === "remote_visibility_stalled" && assessment.candidateEligible !== false) {
          const candidate = deps.startConflictCandidate(job.id, true);
          if (candidate.ok) return { changed: true, candidateStarted: true };
        }
        return { changed: true, assessment };
      }

      return { changed: false };
    } finally {
      deps.recoveryJobLocks.delete(jobId);
    }
  }
  return { assess };
}
