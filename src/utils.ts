export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeSegment(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export function joinRemotePath(base: string, ...segments: string[]) {
  const normalizedBase = base.replace(/\/+$/, "");
  const cleaned = segments
    .filter((segment) => Boolean(segment))
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""));

  if (cleaned.length === 0) {
    return normalizedBase;
  }

  return `${normalizedBase}/${cleaned.join("/")}`;
}
