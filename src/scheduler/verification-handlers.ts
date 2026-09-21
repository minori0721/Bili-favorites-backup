import type { UploadTask, UploadVerificationTask, EncodingRetryContext } from '../tasks.js';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { StateManager } from '../state.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { UploadCircuitBreaker, UploadFailureInfo } from '../upload-health.js';
import { markHistoryGroupUploaded } from '../download-session.js';
import { logManager } from '../logger.js';
import { redactRemotePathForDisplay } from '../diagnostics.js';
import { parseEncodingRetryContext } from './recovery-context.js';
import { parseVerificationPayload } from './verification-payload.js';
import { readTaskFailure, taskUploadFailure } from './task-failure.js';
import { UPLOAD_VERIFY_SCHEDULE_MS, computeUploadVerificationTiming } from './retry-policy.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { RecoveryUploadItem } from './upload-work.js';

interface Dependencies {
  jobStore: Pick<JobRepository, 'complete' | 'countEncodingRetryJobs' | 'completeEncodingRetryParent' | 'hasDedupePrefix' | 'defer' | 'retry' | 'findByDedupeKey' | 'updatePayload'>;
  stateManager: Pick<StateManager, 'clearUploadCooldown' | 'deferUploadFileVerification' | 'runAtomic' | 'markUploadFileVerified' | 'failUploadFileVerification' | 'setUploadCooldown'>;
  transferSessions: Pick<TransferSessionRepository, 'get' | 'listFiles'>;
  uploadCircuit: Pick<UploadCircuitBreaker, 'recordSuccess' | 'recordFailure' | 'getSnapshot'>;
  localCleanup: { request(bvid: string, dir: string): unknown };
  leaseOwner: string;
  now(): number;
  isEncodingRetryParentActive(context: EncodingRetryContext): boolean;
  dispatchPersistentJobs(): void;
  commitVerifiedTransfer(task: UploadVerificationTask, result: NonNullable<UploadTask['result']>, partial?: boolean, history?: boolean, retry?: EncodingRetryContext): void;
  afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext): void;
  finishEncodingRetryFailure(bvid: string, context: EncodingRetryContext, reason: string, remoteStatus?: RecoveryAssessment['remoteStatus'], childJobId?: string): void;
  schedulePersistentJobWake(): void;
  scheduleUploadProbe(): void;
  queueUploadWork(item: RecoveryUploadItem): unknown;
}

/** Verification outcomes and recovery handoffs share the existing atomic commit boundary. */
export function createVerificationHandlers(deps: Dependencies) {
  function handleUploadVerificationCompleted(task: UploadVerificationTask) {
    const job: PersistentJobRecord | undefined = task.persistentJob;
    if (!job || !task.persistentJobId || !task.result) return;
    const payload = parseVerificationPayload(job.payload);
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (encodingRetry && !deps.isEncodingRetryParentActive(encodingRetry)) {
      deps.jobStore.complete(job.id, deps.leaseOwner);
      deps.dispatchPersistentJobs();
      return;
    }
    if (task.transferResult) {
      const transfer = task.transferResult;
      if (transfer.allVerified) {
        if (encodingRetry) {
          deps.commitVerifiedTransfer(task, transfer, Boolean(payload.partialBackup), false, encodingRetry);
          deps.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          return;
        }
        deps.commitVerifiedTransfer(task, transfer, Boolean(payload.partialBackup), Boolean(payload.historyOnly));
        if (payload.historyOnly && payload.historySnapshotAt) markHistoryGroupUploaded(String(payload.localDir || ""), payload.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        void deps.localCleanup.request(task.bvid, String(payload.localDir || ""));
        if (deps.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) deps.stateManager.clearUploadCooldown();
        deps.dispatchPersistentJobs();
        return;
      }
      const nextAt = deps.now() + Math.max(2_000, UPLOAD_VERIFY_SCHEDULE_MS[Math.min(UPLOAD_VERIFY_SCHEDULE_MS.length - 1, Number(job.attempts || 0))] || 10 * 60_000);
      const reason = "正式文件等待远端确认，未重复上传";
      if (!payload.historyOnly) {
        for (const pending of transfer.pendingChecks || []) {
          deps.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, pending.finalFile, nextAt, reason);
        }
      }
      // Keep the same timeout and manual recovery state machine as legacy
      // verification jobs. The transfer session only changes how a check is
      // performed; it must not make an invisible upload wait forever.
      deferMissingUploadVerification(task, job, payload);
      return;
    }
    if (task.result.status === "verified") {
      if (encodingRetry) {
        let retryCommitted = false;
        deps.stateManager.runAtomic(() => {
          const relationVerified = deps.stateManager.markUploadFileVerified(task.bvid, task.userId, task.mediaId, task.remoteFile);
          if (!deps.jobStore.complete(job.id, deps.leaseOwner)) throw new Error("Encoding retry verification ownership changed before commit");
          if (relationVerified && deps.jobStore.countEncodingRetryJobs(encodingRetry.parentJobId, encodingRetry.generation) === 0) {
            if (!deps.jobStore.completeEncodingRetryParent(encodingRetry.parentJobId, encodingRetry.generation)) throw new Error("Encoding retry parent changed before final file verification commit");
            retryCommitted = true;
          }
        });
        if (deps.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) deps.stateManager.clearUploadCooldown();
        if (retryCommitted) deps.afterEncodingRetryCommitted(task.bvid, encodingRetry);
        return;
      }
      deps.jobStore.complete(job.id, deps.leaseOwner);
      if (deps.uploadCircuit.recordSuccess(`verify:${task.bvid}`)) deps.stateManager.clearUploadCooldown();
      if (payload.historyOnly) {
        const prefix = `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:history:${payload.historySnapshotAt || "unknown"}:`;
        if (!deps.jobStore.hasDedupePrefix(prefix) && payload.historySnapshotAt) {
          markHistoryGroupUploaded(String(payload.localDir || ""), payload.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
          void deps.localCleanup.request(task.bvid, String(payload.localDir || ""));
        }
      } else {
        const relationVerified = deps.stateManager.markUploadFileVerified(task.bvid, task.userId, task.mediaId, task.remoteFile);
        if (relationVerified) void deps.localCleanup.request(task.bvid, String(payload.localDir || ""));
      }
      return;
    }
    if (task.result.status === "mismatch") {
      const reason = `远端文件大小冲突：预期 ${task.expectedSize}，实际 ${task.result.remoteSize ?? "未知"}`;
      if (encodingRetry) {
        deps.finishEncodingRetryFailure(task.bvid, encodingRetry, reason, "mismatch", task.persistentJobId);
        return;
      }
      deps.jobStore.complete(job.id, deps.leaseOwner);
      if (!payload.historyOnly) {
        deps.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
      }
      logManager.push({ timestamp: new Date().toISOString(), type: "upload", level: "error", summary: reason, raw: `[UploadVerify] mismatch ${redactRemotePathForDisplay(task.remoteFile)}`, bvid: task.bvid, simpleVisible: true });
      return;
    }

    deferMissingUploadVerification(task, job, payload);
  }

  function deferMissingUploadVerification(task: UploadVerificationTask, job: PersistentJobRecord, payload: ReturnType<typeof parseVerificationPayload>) {
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (payload.sessionId) {
      const session = deps.transferSessions.get(String(payload.sessionId));
      const generation = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session?.generation;
      const fallbackPutAt = Date.parse(String(payload.putCompletedAt || ""));
      const pendingFiles = session && generation === session.generation
        ? deps.transferSessions.listFiles(session.id, generation).filter((file) => file.status === "awaiting_remote")
        : [];
      const timing = computeUploadVerificationTiming(
        pendingFiles.map((file) => file.putAcceptedAt || fallbackPutAt).filter((value) => Number.isFinite(value)),
        deps.now(),
      );
      if (!timing.timedOut && timing.nextAt !== undefined) {
        const nextAt = Math.max(deps.now() + 1_000, timing.nextAt);
        const reason = "远端暂不可见，按各文件PUT时间继续确认";
        deps.jobStore.defer(job.id, deps.leaseOwner, reason, nextAt);
        if (!payload.historyOnly) {
          for (const file of pendingFiles) {
            deps.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, file.finalPath, nextAt, reason);
          }
        }
        deps.schedulePersistentJobWake();
        return;
      }
    }
    const putAt = Date.parse(String(payload.putCompletedAt || "")) || deps.now();
    const elapsed = Math.max(0, deps.now() - putAt);
    const nextDelay = UPLOAD_VERIFY_SCHEDULE_MS.find((delayMs) => delayMs > elapsed + 250);
    if (nextDelay !== undefined) {
      const nextAt = Math.max(deps.now() + 1_000, putAt + nextDelay);
      const reason = "远端暂不可见，等待下一次确认";
      deps.jobStore.retry(job.id, deps.leaseOwner, reason, nextAt);
      if (!payload.historyOnly) {
        deps.stateManager.deferUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, nextAt, reason);
      }
      deps.schedulePersistentJobWake();
      return;
    }

    const reason = "PUT 已成功，但远端在 10 分钟内仍不可见；已暂停自动重传，请在队列中手动继续";
    if (encodingRetry) {
      deps.finishEncodingRetryFailure(
        task.bvid,
        encodingRetry,
        `编码替换上传后远端在 10 分钟内仍不可见，${reason}`,
        "missing",
        task.persistentJobId,
      );
      return;
    }
    deps.jobStore.complete(job.id, deps.leaseOwner);
    if (!payload.historyOnly) {
      deps.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, reason);
    }
    const manualRecovery = deps.queueUploadWork({
      bvid: task.bvid,
      localDir: String(payload.localDir || ""),
      remotePath: String(payload.remotePath || ""),
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: String(payload.folderTitle || ""),
      videoTitle: String(payload.videoTitle || ""),
      upperName: String(payload.upperName || ""),
      cover: String(payload.cover || ""),
      files: Array.isArray(payload.files) ? payload.files : [],
      filenameMetadataByPath: payload.filenameMetadataByPath,
      partialBackup: Boolean(payload.partialBackup),
      historyOnly: Boolean(payload.historyOnly),
      historySnapshotAt: payload.historySnapshotAt,
      sessionId: payload.sessionId,
      sessionGeneration: payload.sessionGeneration,
      allowReupload: false,
      notBefore: 0,
      priority: false,
      awaitingManualRecovery: true,
      resumeOnly: true,
      lifecycleState: "manual_required",
      attemptKey: payload.sessionId && payload.sessionGeneration
        ? `${payload.sessionId}:g${payload.sessionGeneration}`
        : undefined,
      strictMediaTarget: payload.strictMediaTarget,
    });
    if (manualRecovery) {
      const recovery = deps.jobStore.findByDedupeKey(`upload:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${payload.remotePath || ""}:${payload.historyOnly ? payload.historySnapshotAt || "history" : "main"}`);
      if (recovery) deps.jobStore.updatePayload(recovery.id, { ...recovery.payload, awaitingManualRecovery: true, allowReupload: false, resumeOnly: true });
    }
  }

  function queueUploadVerificationConflictRecovery(task: UploadVerificationTask, job: PersistentJobRecord, payload: ReturnType<typeof parseVerificationPayload>, failure: UploadFailureInfo) {
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(payload.encodingRetry);
    if (encodingRetry) {
      deps.finishEncodingRetryFailure(task.bvid, encodingRetry, failure.summary, "mismatch", task.persistentJobId);
      return;
    }
    deps.jobStore.complete(task.persistentJobId!, deps.leaseOwner);
    const conflictRemotePath = failure.remotePath || task.remoteFile;
    if (!payload.historyOnly) {
      deps.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, conflictRemotePath, failure.summary);
    }

    const session = payload.sessionId ? deps.transferSessions.get(String(payload.sessionId)) : null;
    const sessionGeneration = Number.isInteger(payload.sessionGeneration)
      ? Number(payload.sessionGeneration)
      : session?.generation;
    const sessionFiles = session && sessionGeneration !== undefined
      ? deps.transferSessions.listFiles(session.id, sessionGeneration)
      : [];
    const files = Array.isArray(payload.files) && payload.files.length > 0
      ? payload.files
      : sessionFiles.map((file) => file.relativePath);
    const conflictFile = sessionFiles.find((file) => file.finalPath === conflictRemotePath);
    const manualRecovery = deps.queueUploadWork({
      bvid: task.bvid,
      localDir: String(payload.localDir || session?.localDir || ""),
      remotePath: String(payload.remotePath || session?.remotePath || ""),
      userId: task.userId,
      mediaId: task.mediaId,
      folderTitle: String(payload.folderTitle || ""),
      videoTitle: String(payload.videoTitle || ""),
      upperName: String(payload.upperName || ""),
      cover: String(payload.cover || ""),
      files,
      filenameMetadataByPath: payload.filenameMetadataByPath,
      partialBackup: Boolean(payload.partialBackup),
      historyOnly: Boolean(payload.historyOnly),
      historySnapshotAt: payload.historySnapshotAt,
      sessionId: payload.sessionId,
      sessionGeneration,
      allowReupload: false,
      notBefore: 0,
      priority: false,
      awaitingManualRecovery: true,
      resumeOnly: true,
      lifecycleState: "manual_required",
      attemptKey: session?.id && sessionGeneration !== undefined
        ? `${session.id}:g${sessionGeneration}`
        : undefined,
      strictMediaTarget: payload.strictMediaTarget,
    });
    if (manualRecovery) {
      const recoveryKey = `upload:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${payload.remotePath || session?.remotePath || ""}:${payload.historyOnly ? payload.historySnapshotAt || "history" : "main"}`;
      const recovery = deps.jobStore.findByDedupeKey(recoveryKey);
      if (recovery) {
        deps.jobStore.updatePayload(recovery.id, {
          ...recovery.payload,
          awaitingManualRecovery: true,
          allowReupload: false,
          resumeOnly: true,
          sessionGeneration,
          conflictRemotePath,
          conflictRelativePath: conflictFile?.relativePath,
          manualRecoveryReason: failure.summary,
        });
      }
    }
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "upload",
      level: "error",
      summary: `${payload.historyOnly ? "历史分P" : "上传"}确认发现远端文件冲突，已暂停 ${task.bvid}：请处理后重新确认或继续上传`,
      raw: `[UploadVerify] conflict parked path=${redactRemotePathForDisplay(conflictRemotePath)}`,
      bvid: task.bvid,
      simpleVisible: true,
    });
  }

  function handleUploadVerificationError(task: UploadVerificationTask, rawError: unknown) {
    const error = readTaskFailure(rawError);
    const job: PersistentJobRecord | undefined = task.persistentJob;
    if (!job || !task.persistentJobId) return;
    const encodingRetry = task.encodingRetry || parseEncodingRetryContext(job.payload.encodingRetry);
    if (encodingRetry && !deps.isEncodingRetryParentActive(encodingRetry)) {
      deps.jobStore.complete(job.id, deps.leaseOwner);
      deps.dispatchPersistentJobs();
      return;
    }
    if (error?.uploadSessionStale) {
      if (encodingRetry) {
        deps.finishEncodingRetryFailure(task.bvid, encodingRetry, "上传确认会话已失效；未执行归档替换。", "error", task.persistentJobId);
        return;
      }
      deps.jobStore.complete(job.id, deps.leaseOwner);
      deps.dispatchPersistentJobs();
      return;
    }
    const failure: UploadFailureInfo = taskUploadFailure(rawError, task.remoteFile);
    deps.uploadCircuit.recordFailure(`verify:${task.bvid}`, failure);
    if (deps.uploadCircuit.getSnapshot().state !== "closed") {
      deps.stateManager.setUploadCooldown({ ...deps.uploadCircuit.getSnapshot() });
    }
    if (failure.category === "deterministic" && failure.status === 409) {
      queueUploadVerificationConflictRecovery(task, job, parseVerificationPayload(job.payload), failure);
      deps.schedulePersistentJobWake();
      return;
    }
    const delayMs = failure.retryAfterMs || 60_000;
    const result = deps.jobStore.retry(job.id, deps.leaseOwner, failure.summary, deps.now() + delayMs);
    if (result.exhausted) {
      if (encodingRetry) {
        deps.finishEncodingRetryFailure(task.bvid, encodingRetry, `编码替换远端确认失败：${failure.summary}`, "error", task.persistentJobId);
        return;
      }
      deps.stateManager.failUploadFileVerification(task.bvid, task.userId, task.mediaId, task.remoteFile, failure.summary);
    }
    deps.scheduleUploadProbe();
    deps.schedulePersistentJobWake();
  }
  return { completed: handleUploadVerificationCompleted, failed: handleUploadVerificationError };
}
