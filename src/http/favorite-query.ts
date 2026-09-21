import type { FolderDetailFilter } from '../state.js';
export function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}
export function normalizePageSize(value: unknown) {
  return Math.min(parsePositiveInteger(value, 20), 50);
}
export function parseFolderDetailFilter(value: unknown): FolderDetailFilter {
  const raw = String(value || "all");
  if (
    raw === "all" ||
    raw === "uploaded" ||
    raw === "pending" ||
    raw === "pending_unavailable" ||
    raw === "uploaded_unavailable"
  ) {
    return raw;
  }
  return "all";
}
