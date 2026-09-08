import { mapQueueBoardTask, type Task, type QueueBoardItem, type QueueBoardPhase, type QueueBoardAction } from '../queue.js';
import { UploadVerificationTask } from '../tasks.js';
import type { StateManager } from '../state.js';
import type { PersistentJobRecord } from '../database.js';
import { recoveryIssueDisposition } from '../recovery-policy.js';
import { isRecoveryStopped } from '../job-store.js';
import { parseEncodingRetryContext } from './recovery-context.js';
import { parseRecoveryAssessment } from './recovery-projection.js';
import { uploadRecoverySummary } from './recovery-issue-projection.js';
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createQueueBoardProjection(deps: { metadata: StateManager['getVideoMetaBatch'] }) {
  function mapQueueTaskForBoard(task: Task, stage: QueueBoardItem["stage"]): QueueBoardItem {
    const job = record(task.persistentJob);
    const payload = record(job.payload);
    const isVerification = job?.kind === "verify_upload" || task instanceof UploadVerificationTask;
    const firstString = (...values: unknown[]) => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value;
      }
      return "";
    };
    const item = mapQueueBoardTask(task, stage, {
      title: firstString(task.videoTitle, payload.videoTitle, task.bvid),
      upperName: firstString(task.upperName, payload.upperName),
      cover: firstString(task.cover, payload.cover),
      coverLocalPath: firstString(task.coverLocalPath, payload.coverLocalPath) || undefined,
      folderTitle: firstString(task.folderTitle, payload.folderTitle),
      detail: firstString(task.detail) || (isVerification
        ? (task.status === "running" ? "正在确认远端文件" : "已上传，等待远端确认")
        : ""),
      persistentJobId: task.persistentJobId ? String(task.persistentJobId) : undefined,
      lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
      verifiedPages: Number.isInteger(Number(payload.verifiedPages)) ? Number(payload.verifiedPages) : undefined,
      totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
    });
    if (isVerification) {
      item.phase = task.status === "running" ? "remote_verifying" : task.status === "retry_wait" ? "retry_wait" : "queued";
      item.nextAction = task.status === "retry_wait" ? "verify" : undefined;
      item.nextActionAt = task.status === "retry_wait" && typeof task.retryAt === "number" ? task.retryAt : undefined;
    }
    return item;
  }

  function mapPersistentJobForBoard(job: PersistentJobRecord): QueueBoardItem | null {
    if (isRecoveryStopped(job.payload)) return null;
    const payload = job.payload;
    const encodingRetry = record(payload.encodingRetry);
    const kind = String(job.kind || "");
    const isDownload = ["download", "quality_download"].includes(kind);
    const isUpload = ["upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup", "verify_upload"].includes(kind);
    if (!isDownload && !isUpload) return null;
    if (job.status === "failed" && !payload.awaitingManualRecovery) return null;

    const assessment = payload.awaitingManualRecovery ? parseRecoveryAssessment(payload) : null;
    const retryBusy = Boolean(payload.encodingRetry && ["running", "uploading", "verifying"].includes(String(encodingRetry.state || "")));
    const retryParentId = encodingRetry.parentJobId ? String(encodingRetry.parentJobId) : "";
    if (retryBusy && !payload.awaitingManualRecovery && retryParentId === String(job.id)) return null;
    const disposition = assessment ? recoveryIssueDisposition(assessment.kind) : undefined;
    const isVerification = kind === "verify_upload";
    const stage: QueueBoardItem["stage"] = isDownload
      ? (job.status === "running" ? "download_running" : "download_pending")
      : "upload_pending";
    let phase: QueueBoardPhase = job.status === "running"
      ? (isVerification ? "remote_verifying" : "running")
      : job.status === "leased"
        ? "leased"
        : job.status === "retry_wait"
          ? "retry_wait"
          : "queued";
    if (payload.awaitingManualRecovery) {
      phase = disposition === "background" ? "background_wait" : "manual_action";
    }

    const recoveryKind = String(assessment?.kind || "manual_review");
    const retry = parseEncodingRetryContext(payload.encodingRetry);
    const lifecycleDetail = payload.lifecycleState === "conflict_candidate"
      ? `正在生成隔离候选${Number.isInteger(Number(payload.verifiedPages)) && Number.isInteger(Number(payload.totalPages)) ? ` · 已确认 ${Number(payload.verifiedPages)}/${Number(payload.totalPages)} 个分P` : ""}`
      : payload.lifecycleState === "remote_visibility_wait"
        ? `等待远端确认${Number.isInteger(Number(payload.verifiedPages)) && Number.isInteger(Number(payload.totalPages)) ? ` · 已确认 ${Number(payload.verifiedPages)}/${Number(payload.totalPages)} 个分P` : ""}`
        : payload.lifecycleState === "partial_upload"
          ? `部分分P已完成 · ${Number(payload.verifiedPages || 0)}/${Number(payload.totalPages || 0)}`
          : undefined;
    const detail = payload.awaitingManualRecovery
      ? uploadRecoverySummary(
        recoveryKind,
        assessment,
        retry,
        assessment?.summary || "等待安全复核：系统会先自动检查远端状态",
      )
      : lifecycleDetail || (isVerification
        ? (job.status === "running" || job.status === "leased" ? "正在确认远端文件" : "已上传，等待远端确认")
        : String(payload.qualityStageLabel || payload.detail || job.lastError || "等待处理"));
    const nextAction: QueueBoardAction | undefined = payload.awaitingManualRecovery
      ? "recheck"
      : job.status === "retry_wait"
        ? (isVerification ? "verify" : "retry")
        : undefined;
    const nextActionAt = payload.awaitingManualRecovery
      ? assessment?.nextCheckAt
      : job.status === "retry_wait" && Number(job.notBefore) > 0
        ? Number(job.notBefore)
        : undefined;
    const recoveryActions = payload.awaitingManualRecovery
      && !payload.historyOnly
      && !retryBusy
      && ["remote_size_limit", "remote_write_rejected", "encoding_retry_failed"].includes(String(assessment?.kind || ""))
      ? [{ id: "redownload_with_encoding" as const, label: "重新选择画质与编码" }]
      : undefined;

    return mapQueueBoardTask({
      id: job.id,
      bvid: job.bvid,
      userId: job.userId,
      mediaId: job.mediaId,
      videoTitle: payload.videoTitle || job.bvid,
      upperName: payload.upperName || "",
      cover: payload.cover || "",
      coverLocalPath: payload.coverLocalPath,
      folderTitle: payload.folderTitle || payload.primaryFolderTitle || "",
      remotePath: payload.remotePath || payload.remoteFile || "",
      detail,
      status: job.status,
      retries: job.attempts,
      maxRetries: job.maxAttempts,
      retryAt: job.status === "retry_wait" ? job.notBefore : undefined,
      queuedAt: job.createdAt,
      persistentJobId: job.id,
    }, stage, {
      status: String(job.status || "pending"),
      phase,
      nextAction,
      nextActionAt,
      actionRequired: Boolean(payload.awaitingManualRecovery && disposition !== "background"),
      lastError: job.lastError ? String(job.lastError) : undefined,
      awaitingManualRecovery: Boolean(payload.awaitingManualRecovery),
      recoveryJobId: payload.awaitingManualRecovery ? String(job.id) : undefined,
      recoveryDisposition: disposition,
      recoveryIssueId: payload.awaitingManualRecovery ? `${isDownload ? (kind === "quality_download" ? "quality" : "download") : kind.startsWith("quality_") ? "quality" : "upload"}.${job.id}` : undefined,
      recoveryKind: payload.awaitingManualRecovery ? recoveryKind : undefined,
      recoveryActions,
      lifecycleState: payload.lifecycleState ? String(payload.lifecycleState) : undefined,
      verifiedPages: Number.isInteger(Number(payload.verifiedPages)) ? Number(payload.verifiedPages) : undefined,
      totalPages: Number.isInteger(Number(payload.totalPages)) ? Number(payload.totalPages) : undefined,
    });
  }

  function enrichQueueBoardMetadata(items: QueueBoardItem[]) {
    const metadata = deps.metadata(items.map((item) => item.bvid));
    for (const item of items) {
      const fallback = metadata.get(item.bvid);
      if (!fallback) continue;
      if (!item.title || item.title === item.bvid) item.title = fallback.title || item.title;
      if (!item.upperName) item.upperName = fallback.upperName || "";
      if (!item.cover) item.cover = fallback.cover || "";
      if (!item.coverLocalPath) item.coverLocalPath = fallback.coverLocalPath || undefined;
    }
  }

  return { mapQueueTaskForBoard, mapPersistentJobForBoard, enrichQueueBoardMetadata };
}
