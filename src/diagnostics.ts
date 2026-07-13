const sensitiveKey = /(authorization|cookie|set-cookie|token|session[_-]?key|sessdata|password|passwd|secret|bili_jct|csrf(?:_token)?|refresh[_-]?(?:token|key)|access[_-]?(?:token|key))/i;

export function sanitizeDiagnosticText(value: unknown, maxLength = 2_000) {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[redacted]@")
    .replace(/(^|\r?\n)([ \t]*(?:Authorization|Cookie|Set-Cookie)[ \t]*[:=])[^\r\n]*/gi, "$1$2 [redacted]")
    .replace(/([?&](?:access_key|access_token|refresh_key|refresh_token|token|sign|session_key|sessdata|bili_jct|csrf|csrf_token|password|secret)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\b(Authorization|Cookie|Set-Cookie|Token|session[_-]?key|SESSDATA|bili_jct|csrf(?:_token)?|access[_-]?(?:token|key)|refresh[_-]?(?:token|key)|password|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]"']+)/gi, "$1$2[redacted]")
    .replace(/"([^"\\]+)"\s*:\s*"([^"\\]*)"/g, (match, key) => sensitiveKey.test(key) ? `"${key}":"[redacted]"` : match)
    .replace(/\[redacted\]\]+/gi, "[redacted]");
  return text.slice(0, Math.max(100, maxLength));
}

export function safeErrorSummary(error: any, fallback = "操作失败") {
  const status = Number(error?.statusCode || error?.response?.status || error?.status || 0);
  const message = sanitizeDiagnosticText(error?.message || fallback, 500);
  return status ? `status=${status}: ${message}` : message;
}
