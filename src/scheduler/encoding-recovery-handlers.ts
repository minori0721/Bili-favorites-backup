import type { ConfigStore, BBDownEncoding } from '../config.js';
import type { StateManager } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { DownloadTask, UploadTask, EncodingRetryContext } from '../tasks.js';
import { strictEncodingDiagnosticPatch, strictQualityDiagnosticPatch } from '../download-session.js';
import { computeTaskRetryDelayMs } from '../queue.js';
import { sanitizeUploadText, REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE, type UploadFailureInfo, type UploadCircuitBreaker } from '../upload-health.js';
import { logManager } from '../logger.js';
import { inspectLocalArchiveDirectory } from './local-archive-evidence.js';
import { readTaskFailure } from './task-failure.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
interface Dependencies {
  configStore: Pick<ConfigStore, 'get'>;
  stateManager: Pick<StateManager, 'runAtomic' | 'markUploadFailed' | 'markDownloadInterrupted'>;
  jobStore: Pick<JobRepository, 'findById' | 'finishEncodingRetry' | 'complete' | 'cancelEncodingRetryChildren' | 'defer' | 'retry'>;
  leaseOwner: string;
  now(): number;
  cleanup(bvid: string, directory: string): unknown;
  uploadHealth(): ReturnType<UploadCircuitBreaker['getSnapshot']>;
  handleDownloadApiFailure(task: DownloadTask, error: unknown): number | undefined;
  recordUploadFailure(task: UploadTask, error: unknown): UploadFailureInfo;
  dispatchPersistentJobs(): void;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createEncodingRecoveryHandlers(deps: Dependencies) {
  function encodingRetryTargets(context: EncodingRetryContext) {
    return context.target ? [{ userId: context.target.userId, mediaId: context.target.mediaId }] : [];
  }

  function isEncodingRetryParentActive(context: EncodingRetryContext) {
    const parent = deps.jobStore.findById(context.parentJobId);
    const retry = record(parent?.payload.encodingRetry);
    return Boolean(retry
      && Number(retry.generation) === Number(context.generation)
      && ["running", "uploading", "verifying"].includes(String(retry.state || "")));
  }

  function restoreEncodingRetryOriginal(bvid: string, context: EncodingRetryContext, reason: string) {
    const target = context.target;
    if (target) {
      deps.stateManager.markUploadFailed(bvid, context.originalLocalDir, target.userId, target.mediaId, reason);
      return;
    }
    deps.stateManager.markUploadFailed(bvid, context.originalLocalDir, undefined, undefined, reason);
  }

  function finishEncodingRetryFailure(
    bvid: string,
    context: EncodingRetryContext,
    reason: string,
    remoteStatus: RecoveryAssessment["remoteStatus"] = "error",
    childJobId?: string,
    assessmentKind: RecoveryAssessment["kind"] = "encoding_retry_failed",
    payloadPatch: Record<string, unknown> = {},
  ) {
    const summary = sanitizeUploadText(reason, 300);
    const encodingDiagnostic = payloadPatch.requestedEncoding
      ? {
        requestedEncoding: payloadPatch.requestedEncoding as BBDownEncoding,
        actualEncodings: Array.isArray(payloadPatch.actualEncodings)
          ? payloadPatch.actualEncodings.map(String).filter(Boolean)
          : [],
        encodingMismatch: payloadPatch.encodingMismatch !== false,
        verifiedPages: Math.max(0, Number(payloadPatch.verifiedPages || 0)),
      }
      : {};
    const qualityDiagnostic = payloadPatch.requestedQuality
      ? {
        requestedQuality: String(payloadPatch.requestedQuality),
        actualQualities: Array.isArray(payloadPatch.actualQualities)
          ? payloadPatch.actualQualities.map(String).filter(Boolean)
          : [],
        qualityMismatch: payloadPatch.qualityMismatch !== false,
        verifiedPages: Math.max(0, Number(payloadPatch.verifiedPages || 0)),
      }
      : {};
    const originalLocal = inspectLocalArchiveDirectory(context.originalLocalDir);
    const assessment: RecoveryAssessment = {
      kind: assessmentKind,
      checkedAt: deps.now(),
      localStatus: originalLocal.status,
      remoteStatus,
      summary,
      ...encodingDiagnostic,
      ...qualityDiagnostic,
    };
    const updated = deps.stateManager.runAtomic(() => {
      const finished = deps.jobStore.finishEncodingRetry(context.parentJobId, context.generation, {
        recoveryAssessment: assessment, manualRecoveryReason: summary, ...payloadPatch,
      });
      if (childJobId) deps.jobStore.complete(childJobId, deps.leaseOwner);
      if (!finished) return false;
      restoreEncodingRetryOriginal(bvid, context, summary);
      deps.jobStore.cancelEncodingRetryChildren(context.parentJobId, context.generation);
      return true;
    });
    if (!updated) { deps.dispatchPersistentJobs(); return false; }
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "upload",
      level: "error",
      summary: originalLocal.status === "available"
        ? `编码替换未完成，已验证本地原文件仍完整 ${bvid}`
        : originalLocal.retainedBytes > 0
          ? `编码替换未完成，已确认仍有 ${originalLocal.retainedBytes} 字节本地文件；完整性尚未确认 ${bvid}`
          : `编码替换未完成，本地原文件完整性尚未确认 ${bvid}`,
      raw: `[EncodingRetry] failed bvid=${bvid} reason=${summary}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
    return true;
  }

  function afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext) {
    if (isEncodingRetryParentActive(context)) {
      deps.dispatchPersistentJobs();
      return;
    }
    void deps.cleanup(bvid, context.candidateLocalDir);
    logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: "upload", level: "info",
      summary: `编码替换已完成并通过远端确认 ${bvid}`, raw: `[EncodingRetry] completed bvid=${bvid}`,
      bvid, simpleVisible: true, debugVisible: true });
    deps.dispatchPersistentJobs();
  }
  function handleEncodingRetryDownloadError(task: DownloadTask, rawError: unknown) {
    const error = readTaskFailure(rawError);
    const context = task.encodingRetry;
    if (!context || !task.persistentJobId) return;
    if (!isEncodingRetryParentActive(context)) {
      deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      deps.dispatchPersistentJobs();
      return;
    }
    const summary = sanitizeUploadText(error?.message || rawError || "编码替换下载失败", 500);
    if (error?.encodingValidation) {
      const assessment = error.encodingAssessment;
      finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || summary,
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictEncodingDiagnosticPatch(assessment) : {},
      );
      return;
    }
    if (error?.qualityValidation) {
      const assessment = error.qualityAssessment;
      finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || summary,
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictQualityDiagnosticPatch(assessment) : {},
      );
      return;
    }
    const apiRetryAt = deps.handleDownloadApiFailure(task, rawError);
    const job = task.persistentJob;
    if (!error?.permanent && apiRetryAt) {
      deps.stateManager.markDownloadInterrupted(task.bvid, context.candidateLocalDir, summary, encodingRetryTargets(context));
      deps.jobStore.defer(task.persistentJobId, deps.leaseOwner, summary, apiRetryAt);
      deps.dispatchPersistentJobs();
      return;
    }
    if (!error?.permanent) {
      const retryAt = deps.now() + computeTaskRetryDelayMs(
        deps.configStore.get().retryDelaySeconds,
        Number(job?.attempts || 0),
        error?.retryAfterMs,
      );
      const result = deps.jobStore.retry(task.persistentJobId, deps.leaseOwner, summary, retryAt);
      if (!result.exhausted) {
        deps.stateManager.markDownloadInterrupted(task.bvid, context.candidateLocalDir, summary, encodingRetryTargets(context));
        deps.dispatchPersistentJobs();
        return;
      }
    }
    finishEncodingRetryFailure(
      task.bvid,
      context,
      `按 ${[context.quality, context.priority[0]].filter(Boolean).join(" / ")} 重新下载失败：${summary}`,
      "error",
      task.persistentJobId,
    );
  }

  function handleEncodingRetryUploadError(task: UploadTask, rawError: unknown) {
    const error = readTaskFailure(rawError);
    const context = task.encodingRetry;
    if (!context || !task.persistentJobId) return;
    if (!isEncodingRetryParentActive(context)) {
      deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      deps.dispatchPersistentJobs();
      return;
    }
    if (error?.encodingValidation) {
      const assessment = error.encodingAssessment;
      finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || sanitizeUploadText(error?.message || rawError, 500),
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictEncodingDiagnosticPatch(assessment) : {},
      );
      return;
    }
    if (error?.qualityValidation) {
      const assessment = error.qualityAssessment;
      finishEncodingRetryFailure(
        task.bvid,
        context,
        assessment?.summary || sanitizeUploadText(error?.message || rawError, 500),
        assessment?.status === "mismatch" ? "mismatch" : "unknown",
        task.persistentJobId,
        "encoding_retry_failed",
        assessment ? strictQualityDiagnosticPatch(assessment) : {},
      );
      return;
    }
    const failure = deps.recordUploadFailure(task, rawError);
    const job = task.persistentJob;
    const deterministic = failure.category === "deterministic" || failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE;
    if (!deterministic && !error?.uploadSessionStale) {
      const uploadHealth = deps.uploadHealth();
      const retryAt = uploadHealth.retryAt || deps.now() + Math.max(60_000, failure.retryAfterMs || 0);
      const retry = deps.jobStore.retry(task.persistentJobId, deps.leaseOwner, failure.summary, retryAt);
      if (!retry.exhausted) {
        deps.dispatchPersistentJobs();
        return;
      }
    }
    const status = failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE ? "size_limit" : (failure.status === 409 ? "mismatch" : "error");
    finishEncodingRetryFailure(
      task.bvid,
      context,
      `按 ${[context.quality, context.priority[0]].filter(Boolean).join(" / ")} 重新上传失败：${failure.summary}`,
      status,
      task.persistentJobId,
    );
  }

  return { encodingRetryTargets, isEncodingRetryParentActive, restoreEncodingRetryOriginal, finishEncodingRetryFailure, afterEncodingRetryCommitted, handleEncodingRetryDownloadError, handleEncodingRetryUploadError };
}
