import type { DownloadRecoveryCategory, RecoveryIssueKind } from "./recovery-policy.js";

export type DownloadFailureCategory = DownloadRecoveryCategory | "source_unavailable";

export interface DownloadFailureAssessment {
  category: DownloadFailureCategory;
  kind?: Extract<RecoveryIssueKind, "download_retry_exhausted" | "download_account_required" | "download_tool_failure">;
  recoverable: boolean;
  summary: string;
}

function record(error: unknown) {
  return error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
}
function safeMessage(error: unknown) {
  const value = record(error);
  return String(value.message || error || "下载失败").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
}

export function classifyDownloadRecoveryFailure(error: unknown): DownloadFailureAssessment {
  const value = record(error);
  const cause = record(value.cause);
  const explicit = String(value.downloadFailureCategory || "") as DownloadFailureCategory;
  const message = safeMessage(error);
  const code = String(value.code || cause.code || "").toUpperCase();

  if (Boolean(value.encodingValidation)
    || ["BFB_ENCODING_SELECTED_MISMATCH", "BFB_ENCODING_MISMATCH", "BFB_ENCODING_UNVERIFIED"].includes(code)) {
    return { category: "tool", kind: "download_tool_failure", recoverable: true, summary: message };
  }

  if (explicit === "source_unavailable"
    || code === "BILI_VIDEO_UNAVAILABLE"
    || /video is unavailable|视频不存在|稿件不可见|已失效|资源不可用|已删除|下架/i.test(message)) {
    return { category: "source_unavailable", recoverable: false, summary: message };
  }

  if (explicit === "account"
    || code === "BBDOWN_APP_TOKEN_MISSING"
    || Number(value.status || value.statusCode) === 401
    || Number(value.status || value.statusCode) === 403
    || /access token|登录失效|账号登录|cookie|sessdata|未登录|认证/i.test(message)) {
    return { category: "account", kind: "download_account_required", recoverable: true, summary: message };
  }

  if (explicit === "tool"
    || value.filenameTooLong
    || ["ENOENT", "EACCES", "EPERM"].includes(code)
    || /bbdown.*not found|ffmpeg.*not found|spawn .*enoent|文件名过长/i.test(message)) {
    return { category: "tool", kind: "download_tool_failure", recoverable: true, summary: message };
  }

  if (explicit === "transient"
    || value.deferToNextCycle
    || value.biliRiskControl
    || value.appNoVideoInfo
    || value.aria2RecoveryIssue
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return { category: "transient", kind: "download_retry_exhausted", recoverable: true, summary: message };
  }

  return { category: "unknown", kind: "download_retry_exhausted", recoverable: true, summary: message };
}
