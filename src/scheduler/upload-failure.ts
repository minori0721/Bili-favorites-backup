import { UploadTask, QualityUpgradeUploadReplaceTask, QualityUpgradeReplaceTask, QualityUpgradeCleanupTask, type QualityUpgradeTask } from '../tasks.js';
import type { JobRepository } from '../repositories/jobs.js';
import { logManager } from '../logger.js';
import { sanitizeUploadText, REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE, type UploadFailureInfo, type UploadCircuitBreaker } from '../upload-health.js';
import { strictEncodingDiagnosticPatch, strictQualityDiagnosticPatch } from '../download-session.js';
import { serializeQualityUpgrade } from './quality-rules.js';
import { computeQualityCleanupRetryDelayMs, computeUploadSessionRetryDelayMs, ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS } from './retry-policy.js';
import { readTaskFailure } from './task-failure.js';
type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type Upload = UploadTask | QualityUploadPhaseTask;
function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask || task instanceof QualityUpgradeReplaceTask || task instanceof QualityUpgradeCleanupTask;
}
interface Dependencies {
  jobStore: Pick<JobRepository, 'complete' | 'findById' | 'updatePayload' | 'parkManualRecovery' | 'retryIndefinitely' | 'retry'>;
  uploadCircuit: Pick<UploadCircuitBreaker, 'getRetryAt' | 'getSnapshot'>;
  downloadQueue: { poke(): void };
  leaseOwner: string;
  now(): number;
  random(): number;
  dispatchPersistentJobs(): void;
  handleEncodingRetryUploadError(task: UploadTask, error: unknown): void;
  recordUploadFailure(task: Upload, error: unknown): UploadFailureInfo;
  syncQualityUpgradeControl(task: QualityUploadPhaseTask, status: QualityUpgradeTask['status']): void;
  queueAutomaticQualityRecovery(id: string, failure: UploadFailureInfo): boolean;
  markUploadTaskFailed(task: UploadTask, reason: string): void;
  formatUploadFailureLog(task: Upload, failure: UploadFailureInfo): string;
  startConflictCandidate(id: string, automatic: boolean): unknown;
}
export function createUploadFailureHandler(dependencies: Dependencies) {
  const deps = { ...dependencies, serializeQualityUpgrade };
  const logTaskError = (task: Upload, error: ReturnType<typeof readTaskFailure>) =>
    console.error('[Queue] Task ' + task.name + ' ' + (error.deferToNextCycle ? 'deferred to next cycle' : 'permanently failed') + ': ' + sanitizeUploadText(error.message || error));
  return (task: UploadTask | QualityUploadPhaseTask, rawError: unknown) => {
      const error = readTaskFailure(rawError);
      if (task instanceof UploadTask && task.encodingRetry) {
        deps.handleEncodingRetryUploadError(task, rawError);
        return;
      }
      if (error?.uploadSessionStale) {
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        deps.dispatchPersistentJobs();
        return;
      }
      const failure = deps.recordUploadFailure(task, rawError);
      if (task.persistentJobId && (failure.remoteErrorCode || failure.responseHeaders || failure.responseSnippet || failure.remoteWriteStatus || failure.remoteParentStatus)) {
        const current = deps.jobStore.findById(task.persistentJobId);
        if (current) {
          deps.jobStore.updatePayload(task.persistentJobId, {
            ...current.payload,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            ...(failure.remoteWriteStatus ? { remoteWriteStatus: failure.remoteWriteStatus } : {}),
            ...(failure.remoteParentStatus ? { remoteParentStatus: failure.remoteParentStatus } : {}),
          });
        }
      }
      const strictEncodingFailure = Boolean(error?.encodingValidation);
      const strictQualityFailure = Boolean(error?.qualityValidation);
      const manualConflict = !isQualityUploadPhaseTask(task)
        && failure.category === "deterministic"
        && failure.status === 409;
      const remoteSizeLimit = !isQualityUploadPhaseTask(task)
        && failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE;
      const remoteWriteRejected = !isQualityUploadPhaseTask(task)
        && failure.remoteWriteEvidence === "target_missing_parent_visible";
      const authorizedRecovery = task instanceof UploadTask && task.reuploadPermissionUsed;
      if (!manualConflict && !remoteSizeLimit && !remoteWriteRejected) logTaskError(task, error);
      if (isQualityUploadPhaseTask(task)) {
        task.control.error = rawError instanceof Error ? rawError : new Error(String(rawError));
        if (task.persistentJobId) {
          const qualityFailure = {
            stage: task instanceof QualityUpgradeUploadReplaceTask
              ? "upload"
              : (task instanceof QualityUpgradeReplaceTask ? "replace" : "cleanup"),
            category: failure.category,
            code: failure.code,
            status: failure.status,
            summary: failure.summary,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            encodingEligible: task instanceof QualityUpgradeUploadReplaceTask
              && (failure.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE
                || failure.remoteWriteEvidence === "target_missing_parent_visible"
                || /(?:codec|encoding|编码|hevc|av1|avc)/i.test(failure.summary)),
            qualityEligible: strictQualityFailure || (task instanceof QualityUpgradeUploadReplaceTask
              && /(?:quality|画质|分辨率|清晰度)/i.test(failure.summary)),
            occurredAt: deps.now(),
            ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
            ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
          };
          const qualityPayload = {
            ...deps.serializeQualityUpgrade(task.control),
            qualityFailure,
          };
          if (strictEncodingFailure || strictQualityFailure) {
            deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, failure.summary, {
              ...qualityPayload,
              awaitingManualRecovery: true,
            });
            task.control.qualityStageLabel = strictQualityFailure ? "画质不可用，等待选择" : "编码不可用，等待选择";
            deps.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, rawError);
            deps.dispatchPersistentJobs();
            return;
          }
          deps.jobStore.updatePayload(task.persistentJobId, qualityPayload);
          if (task instanceof QualityUpgradeCleanupTask) {
            const attempts = Number(task.persistentJob?.attempts || 0);
            const circuitRetryAt = deps.uploadCircuit.getRetryAt();
            const retryAt = circuitRetryAt && circuitRetryAt > deps.now()
              ? circuitRetryAt
              : deps.now() + computeQualityCleanupRetryDelayMs(attempts, deps.random);
            deps.jobStore.retryIndefinitely(task.persistentJobId, deps.leaseOwner, failure.summary, retryAt);
            task.control.qualityStageLabel = "旧文件清理重试中";
            deps.syncQualityUpgradeControl(task, "retry_wait");
            deps.dispatchPersistentJobs();
            return;
          }
           const retryAt = deps.uploadCircuit.getRetryAt() || deps.now() + Math.max(60_000, failure.retryAfterMs || 0);
           const result = deps.jobStore.retry(task.persistentJobId, deps.leaseOwner, failure.summary, retryAt);
           const automaticRecovery = result.exhausted
             ? deps.queueAutomaticQualityRecovery(task.persistentJobId, failure)
             : false;
           deps.syncQualityUpgradeControl(task, result.exhausted && !automaticRecovery ? "error" : "retry_wait");
           task.control.qualityStageLabel = result.exhausted && !automaticRecovery ? "画质重调失败" : "等待上传后端恢复";
           if (result.exhausted && !automaticRecovery) task.control.onFailed?.(task.control, rawError);
          deps.dispatchPersistentJobs();
          return;
        }
        deps.syncQualityUpgradeControl(task, "error");
        task.control.onFailed?.(task.control, rawError);
        return;
      }
      const uploadHealth = deps.uploadCircuit.getSnapshot();
      const isolatedDeterministicFailure = failure.category === "deterministic" && uploadHealth.state === "closed";
      if (task.persistentJobId) {
        if (manualConflict || authorizedRecovery || remoteSizeLimit || remoteWriteRejected) {
          const assessment = remoteSizeLimit
            ? {
              kind: "remote_size_limit" as const,
              checkedAt: deps.now(),
              localStatus: "available" as const,
              remoteStatus: "size_limit" as const,
              remoteErrorCode: failure.remoteErrorCode,
              responseHeaders: failure.responseHeaders,
              responseSnippet: failure.responseSnippet,
              summary: failure.summary,
            }
            : remoteWriteRejected
              ? {
                kind: "remote_write_rejected" as const,
                checkedAt: deps.now(),
                localStatus: "available" as const,
                remoteStatus: "missing" as const,
                writeStatus: failure.remoteWriteStatus || failure.status,
                writeEvidence: failure.remoteWriteEvidence,
                remoteErrorCode: failure.remoteErrorCode,
                responseHeaders: failure.responseHeaders,
                responseSnippet: failure.responseSnippet,
                summary: `远端拒绝了写入，但目标文件仍不可见、父目录可见；WebDAV没有返回足够信息确定是大小限制、驱动限制还是最终一致性问题${failure.remoteErrorCode ? `（远端错误码 ${failure.remoteErrorCode}）` : ""}。可尝试一次换编码，不代表已确认是大小限制。`,
              }
            : manualConflict
              ? {
                kind: "remote_size_conflict" as const,
                checkedAt: deps.now(),
                localStatus: "available" as const,
                remoteStatus: "mismatch" as const,
                summary: "正式远端路径存在冲突文件；系统会把当前完整候选放入隔离目录，不覆盖原文件。",
              }
              : undefined;
          const parked = deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, failure.summary, {
            awaitingManualRecovery: true,
            allowReupload: false,
            resumeOnly: true,
            manualRecoveryReason: failure.summary,
            ...(failure.remoteErrorCode ? { remoteErrorCode: failure.remoteErrorCode } : {}),
            ...(failure.responseHeaders ? { responseHeaders: failure.responseHeaders } : {}),
            ...(failure.responseSnippet ? { responseSnippet: failure.responseSnippet } : {}),
            ...(failure.remoteWriteStatus ? { remoteWriteStatus: failure.remoteWriteStatus } : {}),
            ...(failure.remoteParentStatus ? { remoteParentStatus: failure.remoteParentStatus } : {}),
            ...(assessment ? { recoveryAssessment: assessment } : {}),
          });
            if (parked) {
            if (!task.historyOnly) {
              deps.markUploadTaskFailed(task, failure.summary);
            }
            logManager.push({
              timestamp: new Date().toISOString(),
              type: "upload",
              level: "error",
              summary: remoteSizeLimit
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端单文件限制暂停 ${task.bvid}：请检查存储设置后再继续`
                : remoteWriteRejected
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端写入结果未确认而暂停 ${task.bvid}：可尝试一次换编码；未执行归档替换`
                : manualConflict
                ? `${task.historyOnly ? "历史分P" : "上传"}因远端文件冲突暂停 ${task.bvid}：请处理冲突后重新确认或继续上传`
                : `${task.historyOnly ? "历史分P" : "上传"}授权重传失败，已暂停 ${task.bvid}：请手动重新确认`,
              raw: deps.formatUploadFailureLog(task, failure),
              bvid: task.bvid,
              simpleVisible: true,
            });
            if (manualConflict && !task.conflictCandidateAttempted && !task.persistentJob?.payload?.conflictCandidateOnly && task.persistentJobId) {
              deps.startConflictCandidate(task.persistentJobId, true);
            }
            deps.dispatchPersistentJobs();
            return;
          }
        }
        const retryDelayMs = error?.uploadSessionTransient
          ? computeUploadSessionRetryDelayMs(Number(task.persistentJob?.attempts || 0))
          : (isolatedDeterministicFailure ? ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS : Math.max(60_000, failure.retryAfterMs || 0));
        const retryAt = uploadHealth.retryAt || deps.now() + retryDelayMs;
        if (!task.historyOnly) {
          deps.markUploadTaskFailed(task, failure.summary);
        }
        const retry = deps.jobStore.retry(task.persistentJobId, deps.leaseOwner, failure.summary, retryAt);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "error",
          summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}${retry.exhausted ? "（已达到重试上限）" : "（未执行本地清理）"}`,
          raw: deps.formatUploadFailureLog(task, failure),
          bvid: task.bvid,
          simpleVisible: true,
        });
        deps.dispatchPersistentJobs();
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "error",
        summary: `${task.historyOnly ? "历史分P" : "上传"}失败 ${task.bvid}: ${failure.summary}（未执行本地清理）`,
        raw: deps.formatUploadFailureLog(task, failure),
        bvid: task.bvid,
        simpleVisible: true,
      });
      if (!task.historyOnly) deps.markUploadTaskFailed(task, failure.summary);
      deps.downloadQueue.poke();
      deps.dispatchPersistentJobs();
    };
}
