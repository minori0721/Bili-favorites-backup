export type AuthRefreshFailureCategory = "transient" | "permanent" | "unknown";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export const AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS = 3;

function errorChain(error: unknown) {
  const chain: any[] = [];
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    current = current.originalError || current.cause || current.error || current.response?.data;
  }
  return chain;
}

export function classifyAuthRefreshError(error: unknown): AuthRefreshFailureCategory {
  const chain = errorChain(error);
  const hasPermanentSignal = chain.some((item) => {
    const status = Number(item?.status || item?.statusCode || item?.response?.status || 0);
    const apiCode = Number(item?.data?.code || item?.response?.data?.code || 0);
    const code = String(item?.code || "").toUpperCase();
    const message = String(item?.message || item || "");
    return status === 401 || status === 403
      || [-101, -102, -111, -352, -403].includes(apiCode)
      || /refresh token|refresh_token|重新登录|登录会话.*失效|invalid.*token|token.*invalid|expired.*token/i.test(message)
      || code === "ERR_REFRESH_TOKEN_INVALID";
  });
  if (hasPermanentSignal) return "permanent";

  const hasTransientSignal = chain.some((item) => {
    const status = Number(item?.status || item?.statusCode || item?.response?.status || 0);
    const code = String(item?.code || "").toUpperCase();
    const message = String(item?.message || item || "");
    return TRANSIENT_CODES.has(code)
      || status === 408 || status === 425 || status === 429 || status >= 500
      || /timeout|timed out|socket hang up|network|temporarily unavailable|connection reset|connection refused/i.test(message);
  });
  return hasTransientSignal ? "transient" : "unknown";
}

export function computeAuthRefreshRetryDelayMs(attempts: number) {
  const count = Math.max(1, Math.floor(Number(attempts) || 1));
  const index = Math.max(0, Math.min(2, count - 1));
  return [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000][index];
}

export function nextAuthRefreshFailureState(
  previousCategory: AuthRefreshFailureCategory | undefined,
  previousAttempts: number | undefined,
  error: unknown,
  now = Date.now(),
) {
  const category = classifyAuthRefreshError(error);
  const attempts = previousCategory === category
    ? Math.max(0, Math.floor(Number(previousAttempts) || 0)) + 1
    : 1;
  const exhaustedUnknown = category === "unknown" && attempts >= AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS;
  const retryAt = category === "permanent" || exhaustedUnknown
    ? undefined
    : new Date(now + computeAuthRefreshRetryDelayMs(attempts)).toISOString();
  return { category, attempts, retryAt };
}

export function isAuthRefreshAttemptBlocked(
  category: AuthRefreshFailureCategory | undefined,
  attempts: number | undefined,
  retryAt: string | undefined,
  now = Date.now(),
) {
  if (category === "permanent") return true;
  if (category === "unknown" && Math.max(0, Math.floor(Number(attempts) || 0)) >= AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS) return true;
  const retryAtMs = retryAt ? Date.parse(retryAt) : NaN;
  return Number.isFinite(retryAtMs) && retryAtMs > now;
}
