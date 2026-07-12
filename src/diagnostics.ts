const sensitiveKey = /(authorization|cookie|set-cookie|token|sessionkey|sessdata|password|passwd|secret|bili_jct|refresh[_-]?token|access[_-]?token)/i;

export function sanitizeDiagnosticText(value: unknown, maxLength = 2_000) {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_key|access_token|refresh_token|token|sign|session_key|sessdata|password|secret)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(Authorization|Cookie|Set-Cookie|Token|sessionKey|SESSDATA|password|secret)\b\s*[:=]\s*([^\r\n,;}]+)/gi, "$1=[redacted]")
    .replace(/"([^"\\]+)"\s*:\s*"([^"\\]*)"/g, (match, key) => sensitiveKey.test(key) ? `"${key}":"[redacted]"` : match);
  return text.slice(0, Math.max(100, maxLength));
}

export function safeErrorSummary(error: any, fallback = "操作失败") {
  const status = Number(error?.statusCode || error?.response?.status || error?.status || 0);
  const message = sanitizeDiagnosticText(error?.message || fallback, 500);
  return status ? `status=${status}: ${message}` : message;
}
