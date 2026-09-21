import type { StrictEncodingAssessment, StrictQualityAssessment } from '../download-session.js';
import { classifyUploadError, type UploadFailureInfo } from '../upload-health.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function commonAssessment(value: unknown) {
  const item = record(value);
  const status = item.status === 'matched' || item.status === 'mismatch' ? item.status : 'unknown';
  return { status, verifiedPages: Number(item.verifiedPages) || 0, totalPages: Number(item.totalPages) || 0,
    mismatchedFiles: stringList(item.mismatchedFiles), unknownFiles: stringList(item.unknownFiles),
    summary: typeof item.summary === 'string' ? item.summary : '' } as const;
}
function encodingAssessment(value: unknown): StrictEncodingAssessment | undefined {
  const item = record(value);
  const requestedEncoding = item.requestedEncoding;
  if (requestedEncoding !== 'HEVC' && requestedEncoding !== 'AVC' && requestedEncoding !== 'AV1') return undefined;
  return { ...commonAssessment(value), requestedEncoding, actualEncodings: stringList(item.actualEncodings),
    encodingMismatch: item.encodingMismatch === true };
}
function qualityAssessment(value: unknown): StrictQualityAssessment | undefined {
  const item = record(value);
  if (typeof item.requestedQuality !== 'string') return undefined;
  return { ...commonAssessment(value), requestedQuality: item.requestedQuality,
    actualQualities: stringList(item.actualQualities), qualityMismatch: item.qualityMismatch === true };
}

/** Inspect flags without replacing the original error supplied to classifiers and callbacks. */
export function readTaskFailure(value: unknown) {
  const item = record(value);
  return {
    message: value instanceof Error ? value.message : typeof item.message === 'string' ? item.message : undefined,
    biliRiskControl: item.biliRiskControl === true, apiMode: item.apiMode === 'web' || item.apiMode === 'app' ? item.apiMode : undefined,
    permanent: item.permanent === true, deferToNextCycle: item.deferToNextCycle === true,
    chargingRestricted: item.chargingRestricted === true, encodingValidation: item.encodingValidation === true,
    qualityValidation: item.qualityValidation === true, uploadSessionStale: item.uploadSessionStale === true,
    uploadSessionTransient: item.uploadSessionTransient === true,
    retryAfterMs: typeof item.retryAfterMs === 'number' && Number.isFinite(item.retryAfterMs) ? item.retryAfterMs : undefined,
    encodingAssessment: encodingAssessment(item.encodingAssessment),
    qualityAssessment: qualityAssessment(item.qualityAssessment),
  };
}

export function taskUploadFailure(value: unknown, bvid: string): UploadFailureInfo {
  const stored = record(record(value).uploadFailure);
  if ((stored.category === 'auth' || stored.category === 'deterministic' || stored.category === 'rate_limit'
    || stored.category === 'transient' || stored.category === 'server' || stored.category === 'unknown')
    && typeof stored.summary === 'string' && typeof stored.remotePath === 'string'
    && typeof stored.retryable === 'boolean' && typeof stored.fingerprint === 'string') {
    return { ...classifyUploadError(value, bvid), category: stored.category, summary: stored.summary,
      remotePath: stored.remotePath, retryable: stored.retryable, fingerprint: stored.fingerprint,
      status: typeof stored.status === 'number' ? stored.status : undefined,
      code: typeof stored.code === 'string' ? stored.code : undefined,
      remoteErrorCode: typeof stored.remoteErrorCode === 'string' ? stored.remoteErrorCode : undefined,
      responseHeaders: stored.responseHeaders && typeof stored.responseHeaders === 'object'
        ? Object.fromEntries(Object.entries(stored.responseHeaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined,
      responseSnippet: typeof stored.responseSnippet === 'string' ? stored.responseSnippet : undefined,
      remoteWriteEvidence: stored.remoteWriteEvidence === 'target_missing_parent_visible' ? stored.remoteWriteEvidence : undefined,
      remoteWriteStatus: typeof stored.remoteWriteStatus === 'number' ? stored.remoteWriteStatus : undefined,
      remoteParentStatus: stored.remoteParentStatus === 'visible' || stored.remoteParentStatus === 'missing' || stored.remoteParentStatus === 'unknown' ? stored.remoteParentStatus : undefined,
      retryAfterMs: typeof stored.retryAfterMs === 'number' ? stored.retryAfterMs : undefined };
  }
  return classifyUploadError(value, bvid);
}
