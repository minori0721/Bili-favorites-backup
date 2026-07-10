export type UploadFailureCategory =
  | "auth"
  | "deterministic"
  | "rate_limit"
  | "transient"
  | "server"
  | "unknown";

export interface UploadFailureInfo {
  category: UploadFailureCategory;
  status?: number;
  code?: string;
  summary: string;
  remotePath: string;
  retryable: boolean;
  fingerprint: string;
  retryAfterMs?: number;
}

export interface UploadHealthSnapshot {
  state: "closed" | "open" | "half_open";
  reason?: string;
  category?: UploadFailureCategory;
  consecutiveFailures: number;
  openedAt?: number;
  retryAt?: number;
  probeInFlight: boolean;
  pausedDownloads: boolean;
}

const NETWORK_CODES = new Set([
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

const SENSITIVE_KEY = "authorization|cookie|token|session(?:key)?|password|passwd|secret|sign(?:ature)?|access[_-]?key|refresh[_-]?token";

function stringifyErrorDetail(value: unknown) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return value == null ? "" : String(value);
}

export function sanitizeUploadText(value: unknown, maxLength = 500) {
  let text = stringifyErrorDetail(value).replace(/[\r\n\t]+/g, " ").trim();
  text = text.replace(/(https?:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi, "$1[REDACTED]@");
  text = text.replace(/(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^,;\s]+/gi, "$1[REDACTED]");
  text = text.replace(new RegExp(`([?&](?:${SENSITIVE_KEY})=)[^&\\s]+`, "gi"), "$1[REDACTED]");
  text = text.replace(new RegExp(`(\"(?:${SENSITIVE_KEY})\"\\s*:\\s*\")[^\"]*`, "gi"), "$1[REDACTED]");
  text = text.replace(new RegExp(`((?:${SENSITIVE_KEY})\\s*[:=]\\s*)[^,;\\s\"'&}\\]]+`, "gi"), "$1[REDACTED]");
  return text.slice(0, maxLength) || "Unknown upload error";
}

export async function captureUploadResponseBody(error: any, maxBytes = 4096) {
  if (typeof error?.responseBody === "string" || Buffer.isBuffer(error?.responseBody)) {
    return error;
  }
  const body = error?.response?.body;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") return error;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      chunks.push(buffer.subarray(0, remaining));
      total += Math.min(buffer.length, remaining);
      if (total >= maxBytes) break;
    }
    if (chunks.length > 0) {
      error.responseBody = Buffer.concat(chunks).toString("utf-8");
    }
  } catch {
    // Keep the original error when the response stream is already consumed.
  }
  return error;
}

function extractStatus(error: any) {
  const value = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function extractRetryAfterMs(error: any) {
  const headers = error?.response?.headers || error?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function buildFingerprint(category: UploadFailureCategory, status: number | undefined, code: string | undefined, summary: string, remotePath: string) {
  const normalized = summary
    .replace(remotePath, "<remote>")
    .replace(/BV[0-9A-Za-z]+/g, "<bvid>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\/[\w.%-]+(?:\/[\w.%-]+)+/g, "<path>")
    .toLowerCase();
  return `${category}|${status || 0}|${code || ""}|${normalized}`.slice(0, 600);
}

export function classifyUploadError(error: any, remotePath: string): UploadFailureInfo {
  const status = extractStatus(error);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase() || undefined;
  const responseDetail = error?.responseBody ?? error?.body ?? error?.response?.body;
  const usableResponseDetail = typeof responseDetail === "string" || Buffer.isBuffer(responseDetail)
    ? responseDetail
    : undefined;
  const detail = usableResponseDetail ?? error?.data ?? error?.message ?? error;
  const summary = sanitizeUploadText(detail);
  const networkLike = Boolean(code && NETWORK_CODES.has(code)) || /ECONNRESET|ETIMEDOUT|timeout|socket hang up|network/i.test(summary);
  let category: UploadFailureCategory = "unknown";
  let retryable = true;

  if (status === 401 || status === 403) {
    category = "auth";
    retryable = false;
  } else if (status === 429) {
    category = "rate_limit";
  } else if (networkLike || status === 408) {
    category = "transient";
  } else if (status !== undefined && status >= 500) {
    category = "server";
  } else if (status !== undefined && [400, 404, 405, 409, 422].includes(status)) {
    category = "deterministic";
    retryable = false;
  }

  return {
    category,
    status,
    code,
    summary,
    remotePath,
    retryable,
    fingerprint: buildFingerprint(category, status, code, summary, remotePath),
    retryAfterMs: extractRetryAfterMs(error),
  };
}

export class UploadOperationError extends Error {
  uploadFailure: UploadFailureInfo;
  permanent: boolean;
  deferToNextCycle: boolean;
  retryAfterMs?: number;

  constructor(info: UploadFailureInfo) {
    super(info.summary);
    this.name = "UploadOperationError";
    this.uploadFailure = info;
    this.permanent = info.category === "auth";
    this.deferToNextCycle = !info.retryable && info.category !== "auth";
    this.retryAfterMs = info.retryAfterMs;
  }
}

interface FailureEvent {
  at: number;
  taskKey: string;
  info: UploadFailureInfo;
}

export class UploadCircuitBreaker {
  private state: UploadHealthSnapshot["state"] = "closed";
  private events: FailureEvent[] = [];
  private consecutiveTransient = 0;
  private openedAt?: number;
  private retryAt?: number;
  private reason?: string;
  private category?: UploadFailureCategory;
  private probeInFlight = false;
  private probeTaskKey?: string;
  private cooldownMs = 60_000;

  allowUploadStart(taskKey: string, now = Date.now()) {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (!this.retryAt || now < this.retryAt) return false;
      this.state = "half_open";
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    this.probeTaskKey = taskKey;
    return true;
  }

  recordSuccess(taskKey?: string) {
    if (this.state === "open") return false;
    if (this.state === "half_open" && taskKey && taskKey !== this.probeTaskKey) return false;
    this.state = "closed";
    this.events = [];
    this.consecutiveTransient = 0;
    this.openedAt = undefined;
    this.retryAt = undefined;
    this.reason = undefined;
    this.category = undefined;
    this.probeInFlight = false;
    this.probeTaskKey = undefined;
    this.cooldownMs = 60_000;
    return true;
  }

  recordFailure(taskKey: string, info: UploadFailureInfo, now = Date.now()) {
    if (this.state === "half_open") {
      if (!this.probeTaskKey || taskKey === this.probeTaskKey) {
        this.open(info, now, true);
        return true;
      }
      return false;
    }

    this.events.push({ at: now, taskKey, info });
    this.events = this.events.filter((event) => now - event.at <= 120_000);

    if (info.category === "auth") {
      this.open(info, now, false);
      return true;
    }

    if (info.category === "deterministic") {
      const matching = this.events.filter((event) => event.info.fingerprint === info.fingerprint);
      const tasks = new Set(matching.map((event) => event.taskKey));
      if (matching.length >= 3 && tasks.size >= 2) {
        this.open(info, now, false);
        return true;
      }
      this.consecutiveTransient = 0;
      return false;
    }

    if (["transient", "rate_limit", "server", "unknown"].includes(info.category)) {
      this.consecutiveTransient += 1;
      if (this.consecutiveTransient >= 5) {
        this.open(info, now, false);
        return true;
      }
    } else {
      this.consecutiveTransient = 0;
    }
    return false;
  }

  private open(info: UploadFailureInfo, now: number, increaseCooldown: boolean) {
    if (increaseCooldown) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, 15 * 60_000);
    }
    this.state = "open";
    this.openedAt = now;
    this.retryAt = now + this.cooldownMs;
    this.reason = info.summary;
    this.category = info.category;
    this.probeInFlight = false;
    this.probeTaskKey = undefined;
  }

  isDownloadPaused() {
    return this.state !== "closed";
  }

  getRetryAt() {
    return this.retryAt;
  }

  getSnapshot(): UploadHealthSnapshot {
    return {
      state: this.state,
      reason: this.reason,
      category: this.category,
      consecutiveFailures: this.consecutiveTransient || this.events.length,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      probeInFlight: this.probeInFlight,
      pausedDownloads: this.isDownloadPaused(),
    };
  }
}
