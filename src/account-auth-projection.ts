import { AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS, classifyAuthRefreshError } from './auth-refresh.js';
import { sanitizeDiagnosticText } from './diagnostics.js';
import type { BiliUser } from './users.js';

export function formatExpiresText(expires?: number, now = Date.now()) {
  if (!expires || expires <= 0) {
    return "未知过期时间";
  }
  const diff = expires - now;
  if (diff <= 0) {
    return "已过期";
  }
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  return `${days}天后过期`;
}
export function buildAuthHealth(user: BiliUser, now = Date.now()) {
  const autoRefreshEnabled = Boolean(user.accessToken && user.refreshToken);
  const lastError = sanitizeDiagnosticText(user.lastAuthRefreshError || "", 500);
  const failureCategory = user.authRefreshFailureCategory
    || (lastError ? classifyAuthRefreshError(lastError) : undefined);
  const failureAttempts = Math.max(0, Math.floor(Number(user.authRefreshFailureAttempts) || 0));
  const retryAtMs = user.authRefreshRetryAt ? Date.parse(user.authRefreshRetryAt) : NaN;
  const expired = Boolean(user.expires && user.expires <= now);
  const expiringSoon = Boolean(user.expires && user.expires > now && user.expires - now < 10 * 24 * 60 * 60 * 1000);
  const unknownExhausted = failureCategory === "unknown" && failureAttempts >= AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS;
  const needsManualLogin = !autoRefreshEnabled || failureCategory === "permanent" || unknownExhausted;
  let level: "ok" | "warn" | "error" = "ok";
  let summary = "自动刷新已启用";
  let detail = "普通登录过期会自动刷新，无需人工处理。";

  if (!autoRefreshEnabled) {
    level = "error";
    summary = "需要重新扫码登录";
    detail = "当前账号缺少自动刷新凭据，无法无人值守续期。";
  } else if (failureCategory === "permanent") {
    level = "error";
    summary = "登录授权已失效，需要重新登录";
    detail = lastError || "refreshToken 已失效，后台不会继续重复尝试。请重新扫码登录。";
  } else if (unknownExhausted) {
    level = "error";
    summary = "授权刷新连续异常，需要检查";
    detail = lastError || "后台已完成有限次数重试，仍无法判断授权状态，请检查网络或重新登录。";
  } else if (failureCategory === "transient" || failureCategory === "unknown") {
    level = "warn";
    summary = "授权刷新后台重试中";
    const retryText = Number.isFinite(retryAtMs) && retryAtMs > now
      ? `预计 ${new Date(retryAtMs).toLocaleString("zh-CN", { hour12: false })} 后重试。`
      : "将在后台继续重试。";
    detail = `${lastError || "上次刷新暂未成功。"} ${retryText}不会立即要求重新扫码。`;
  } else if (expired) {
    level = "warn";
    summary = "登录态已过期，等待自动刷新";
    detail = "账号保留了 refreshToken，后台会自动尝试恢复。";
  } else if (expiringSoon) {
    level = "warn";
    summary = "登录态临近过期，将自动刷新";
    detail = "后台会在任务空闲时刷新授权。";
  }

  return {
    level,
    summary,
    detail,
    autoRefreshEnabled,
    needsManualLogin,
    lastSuccessAt: user.lastAuthRefreshAt || "",
    lastError,
    failureCategory: failureCategory || "",
    failureAttempts,
    retryAt: user.authRefreshRetryAt || "",
  };
}
