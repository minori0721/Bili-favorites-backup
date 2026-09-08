import { isValidBBDownEncodingPriority, normalizeBBDownEncodingPriority, type BBDownEncoding, type ConfigStore } from '../config.js';
import { isSelectableBilibiliQuality } from '../media-metadata.js';
import type { PersistentJobStore } from '../job-store.js';
import type { PersistentJobRecord } from '../database.js';
import type { RecoveryIssueActionId } from '../recovery-policy.js';
import type { RecoveryAssessment, RecoveryIssue } from './recovery-contracts.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import type { RecoveryActionOptions, RecoveryActionResult } from './recovery-action-contracts.js';
type Action = RecoveryActionResult | Promise<RecoveryActionResult>;
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'findById' | 'wakeManualJob'>;
  configStore: Pick<ConfigStore, 'get'>;
  recoveryWork: { locks: RecoveryLockAccess };
  getRecoveryIssueSnapshot(): { issues: RecoveryIssue[] };
  resolveLegacyDownloadFailureIssue(id: string, action: RecoveryIssueActionId, options: RecoveryActionOptions): Action;
  resolveDownloadRecoveryIssue(id: string, action: RecoveryIssueActionId, options: RecoveryActionOptions): Action;
  abandonRecoveryJob(id: string, kinds: string[]): RecoveryActionResult;
  assessManualRecoveryJob(id: string, options: { force: boolean; allowAutomatic: boolean }): Promise<unknown>;
  recoverUploadJob(id: string, reupload: boolean): Action;
  startConflictCandidate(id: string): RecoveryActionResult;
  recoveryAssessment(payload: unknown): RecoveryAssessment | null;
  queueFreshDownloadForRecovery(job: PersistentJobRecord, status: RecoveryAssessment['localStatus'], initiated: boolean): boolean;
  startEncodingRetry(id: string, priority: BBDownEncoding[], strict: boolean, quality?: string): Promise<RecoveryActionResult>;
  resolveConflictCandidate(id: string, resolution: 'keep_existing' | 'use_candidate'): Action;
  restartQualityRecovery(id: string, options: { priority?: BBDownEncoding[]; strictEncoding?: boolean; quality?: string }): RecoveryActionResult;
  dispatchPersistentJobs(): void;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createRecoveryActions(deps: Dependencies) {
  async function resolve(
    issueId: string,
    action: RecoveryIssueActionId,
    options: { encodingPriority?: unknown; strict?: unknown; userId?: unknown; quality?: unknown } = {},
  ) {
    if (issueId === "storage-backend") {
      return { ok: false as const, status: 409, message: "请在设置中检查 AList / OpenList 配置" };
    }
    const separator = issueId.indexOf(".");
    const scope = separator > 0 ? issueId.slice(0, separator) : "";
    const jobId = separator > 0 ? issueId.slice(separator + 1) : "";
    if (!jobId) return { ok: false as const, status: 404, message: "待处理项不存在或已自动解决" };
    if (scope === "legacy-download") {
      return deps.resolveLegacyDownloadFailureIssue(jobId, action, options);
    }
    if (scope === "download") {
      return deps.resolveDownloadRecoveryIssue(jobId, action, options);
    }
    if (scope === "upload") {
      const currentJob = deps.jobStore.findById(jobId);
      const retryState = record(currentJob?.payload.encodingRetry);
      if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))
        && action !== "redownload_with_encoding") {
        return { ok: false as const, status: 409, message: "编码替换正在进行，请等待替换下载、上传和远端确认完成" };
      }
      if (action === "abandon_attempt") {
        return deps.abandonRecoveryJob(jobId, ["upload", "history_upload"]);
      }
      if (action === "recheck") {
        await deps.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (action === "reupload") {
        const result = await deps.recoverUploadJob(jobId, true);
        return result.ok
          ? { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues }
          : result;
      }
      if (action === "create_candidate") {
        await deps.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        const current = deps.jobStore.findById(jobId);
        if (!current) return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
        const result = deps.startConflictCandidate(jobId);
        return result.ok
          ? { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues }
          : result;
      }
      if (action === "redownload") {
        await deps.assessManualRecoveryJob(jobId, { force: true, allowAutomatic: false });
        const current = deps.jobStore.findById(jobId);
        const assessment = current ? deps.recoveryAssessment(current.payload) : null;
        if (!current) return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
        if (!assessment || assessment.remoteStatus !== "missing" || !["missing", "changed"].includes(assessment.localStatus)) {
          return { ok: false as const, status: 409, message: "最新复核不允许重新下载，请刷新待处理项" };
        }
        if (!deps.queueFreshDownloadForRecovery(current, assessment.localStatus, true)) {
          return { ok: false as const, status: 409, message: "当前来源无法安全重新下载，请确认账号与收藏关系仍有效" };
        }
        return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (action === "redownload_with_encoding") {
        if (deps.recoveryWork.locks.has(jobId)) {
          return { ok: false as const, status: 409, message: "该编码替换任务正在被处理，请稍后刷新" };
        }
        const quality = String(options.quality || "").trim().toUpperCase();
        const hasEncoding = options.encodingPriority !== undefined;
        if (quality && !isSelectableBilibiliQuality(quality)) {
          return { ok: false as const, status: 400, message: "不支持的画质档位" };
        }
        if (hasEncoding && !isValidBBDownEncodingPriority(options.encodingPriority)) {
          return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
        }
        if (!quality && !hasEncoding) {
          return { ok: false as const, status: 400, message: "请选择画质或编码" };
        }
        const requestedPriority = hasEncoding
          ? normalizeBBDownEncodingPriority(options.encodingPriority)
          : normalizeBBDownEncodingPriority(deps.configStore.get().bbdownEncodingPriority, deps.configStore.get().bbdownEncoding);
          const started = await deps.startEncodingRetry(
            jobId,
            requestedPriority,
            hasEncoding && options.strict !== false,
            quality || undefined,
          );
          if (!started.ok) return started;
          return {
            ok: true as const,
            idempotent: Boolean(started.idempotent),
            childJobId: started.childJobId,
            issues: deps.getRecoveryIssueSnapshot().issues,
          };
      }
      if (action === "keep_existing" || action === "use_candidate") {
        return deps.resolveConflictCandidate(jobId, action);
      }
    }
    if (scope === "quality" && action === "abandon_attempt") {
      return deps.abandonRecoveryJob(jobId, ["quality_download", "quality_upload", "quality_replace", "quality_cleanup"]);
    }
    if (scope === "quality" && action === "retry_quality") {
      if (deps.recoveryWork.locks.has(jobId)) {
        return { ok: false as const, status: 409, message: "画质重调任务正在被其他操作处理" };
      }
      deps.recoveryWork.locks.add(jobId);
      try {
        const job = deps.jobStore.findById(jobId);
        if (!job || !["quality_download", "quality_upload", "quality_replace", "quality_cleanup"].includes(job.kind)) {
          return { ok: false as const, status: 404, message: "画质重调任务不存在或已恢复" };
        }
        const awaitingManualRecovery = job.payload.awaitingManualRecovery === true;
        if (["pending", "retry_wait", "leased", "running"].includes(job.status) && !awaitingManualRecovery) {
          return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
        }
        if (!["failed", "manual_wait", "retry_wait", "pending"].includes(job.status)) {
          return { ok: false as const, status: 409, message: "画质重调任务状态已经变化，请刷新后重试" };
        }
        if (!deps.jobStore.wakeManualJob(job.id, {
          awaitingManualRecovery: false,
          qualityFailure: undefined,
          error: undefined,
          automaticQualityRecoveryAttempts: 0,
          automaticQualityRecoveryCategory: undefined,
          automaticQualityRecoveryError: undefined,
        })) {
          return { ok: false as const, status: 409, message: "画质重调任务正在被其他操作处理" };
        }
        deps.dispatchPersistentJobs();
        return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
      } finally {
        deps.recoveryWork.locks.delete(jobId);
      }
    }
    if (scope === "quality" && action === "retry_quality_with_encoding") {
      const quality = String(options.quality || "").trim().toUpperCase();
      const hasEncoding = options.encodingPriority !== undefined;
      if (quality && !isSelectableBilibiliQuality(quality)) {
        return { ok: false as const, status: 400, message: "不支持的画质档位" };
      }
      if (hasEncoding && !isValidBBDownEncodingPriority(options.encodingPriority)) {
        return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
      }
      if (!quality && !hasEncoding) {
        return { ok: false as const, status: 400, message: "请选择画质或编码" };
      }
      if (deps.recoveryWork.locks.has(jobId)) {
        return { ok: false as const, status: 409, message: "该画质重调任务正在被处理，请稍后刷新" };
      }
      deps.recoveryWork.locks.add(jobId);
      try {
        return deps.restartQualityRecovery(jobId, {
          priority: hasEncoding ? normalizeBBDownEncodingPriority(options.encodingPriority) : undefined,
          strictEncoding: hasEncoding && options.strict !== false,
          quality: quality || undefined,
        });
      } finally {
        deps.recoveryWork.locks.delete(jobId);
      }
    }
    if (scope === "quality" && action === "retry_quality_with_quality") {
      const quality = String(options.quality || "").trim().toUpperCase();
      if (!quality) return { ok: false as const, status: 400, message: "请选择新的画质档位" };
      if (options.encodingPriority !== undefined && !isValidBBDownEncodingPriority(options.encodingPriority)) {
        return { ok: false as const, status: 400, message: "编码顺序必须包含 HEVC、AVC、AV1 且各出现一次" };
      }
      if (deps.recoveryWork.locks.has(jobId)) {
        return { ok: false as const, status: 409, message: "该画质重调任务正在被处理，请稍后刷新" };
      }
      deps.recoveryWork.locks.add(jobId);
      try {
        return deps.restartQualityRecovery(jobId, {
          quality,
          priority: isValidBBDownEncodingPriority(options.encodingPriority)
            ? normalizeBBDownEncodingPriority(options.encodingPriority)
            : undefined,
          strictEncoding: options.strict !== false,
        });
      } finally {
        deps.recoveryWork.locks.delete(jobId);
      }
    }
    return { ok: false as const, status: 400, message: "该待处理项不支持此操作" };
  }
  return { resolve };
}
