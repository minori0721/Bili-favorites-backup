import { isRecord } from '../shared/api/value.js';
import { isValidBBDownEncodingPriority, normalizeBBDownEncodingPriority } from '../config.js';
import { isSelectableBilibiliQuality } from '../media-metadata.js';
import { sanitizeUploadText } from '../upload-health.js';
import type { EncodingRetryContext, QualityEncodingOverride, StrictMediaTarget } from '../tasks.js';

export function parseEncodingRetryContext(value: unknown): EncodingRetryContext | null {
  if (!isRecord(value)) return null;
  const item = value;
  const parentJobId = String(item.parentJobId || "");
  const generation = Number(item.generation);
  const candidateLocalDir = String(item.candidateLocalDir || "");
  const originalLocalDir = String(item.originalLocalDir || "");
  if (!parentJobId || !Number.isInteger(generation) || generation < 1 || !candidateLocalDir || !originalLocalDir) return null;
  if (!isValidBBDownEncodingPriority(item.priority)) return null;
  const target = isRecord(item.target)
    && typeof item.target.userId === "string"
    && Number.isInteger(Number(item.target.mediaId))
    && typeof item.target.folderTitle === "string"
    && typeof item.target.remotePath === "string"
    ? {
      userId: item.target.userId,
      mediaId: Number(item.target.mediaId),
      folderTitle: item.target.folderTitle,
      remotePath: item.target.remotePath,
    }
    : undefined;
  return {
    parentJobId,
    generation,
    priority: [...item.priority],
    strict: item.strict !== false,
    quality: isSelectableBilibiliQuality(item.quality) ? String(item.quality).trim().toUpperCase() : undefined,
    candidateLocalDir,
    originalLocalDir,
    originalFiles: Array.isArray(item.originalFiles) ? item.originalFiles.map(String).filter(Boolean) : undefined,
    target,
    state: (["running", "uploading", "verifying", "failed", "completed"] as const).find(state => state === item.state) ?? "running",
    lastError: item.lastError ? sanitizeUploadText(item.lastError, 500) : undefined,
  };
}

export function parseQualityEncodingOverride(value: unknown): QualityEncodingOverride | null {
  if (!isRecord(value)) return null;
  const item = value;
  const generation = Number(item.generation);
  if (!Number.isInteger(generation) || generation < 1 || !isValidBBDownEncodingPriority(item.priority)) return null;
  return {
    generation,
    priority: normalizeBBDownEncodingPriority(item.priority),
    strict: item.strict !== false,
  };
}

export function parseStrictMediaTarget(value: unknown): StrictMediaTarget | undefined {
  if (!isRecord(value)) return undefined;
  const item = value;
  const quality = typeof item.quality === "string" ? item.quality.trim().slice(0, 64) : "";
  const normalizedEncoding = typeof item.encoding === "string" ? item.encoding.trim().toUpperCase() : "";
  const encoding = (["HEVC", "AVC", "AV1"] as const).find((candidate) => candidate === normalizedEncoding);
  return quality || encoding ? { quality: quality || undefined, encoding } : undefined;
}
