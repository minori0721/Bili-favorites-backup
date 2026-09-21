import { isRecord } from '../shared/api/value.js';
import type { RemoteFileRecord, RemoteFileFilenameMetadata } from '../state.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { EncodingRetryContext, StrictMediaTarget } from '../tasks.js';

export function invalid(field: string): never { throw new Error(`持久上传任务字段 ${field} 类型无效`); }
export function object(value: unknown, field: string) {
  if (!isRecord(value)) return invalid(field);
  return value;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string') return invalid(field);
  return value;
}
export function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(field);
  return value;
}
export function integer(value: unknown, field: string): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result)) return invalid(field);
  return result;
}
export function positive(value: unknown, field: string): number {
  const result = integer(value, field);
  return result >= 1 ? result : invalid(field);
}
export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return invalid(field);
  return value;
}
export function optional<T>(value: unknown, field: string, decode: (value: unknown, field: string) => T): T | undefined {
  return value === undefined ? undefined : decode(value, field);
}
export function oneOf<const T extends readonly string[]>(values: T) {
  return (value: unknown, field: string): T[number] => {
    const match = values.find(candidate => candidate === value);
    return match === undefined ? invalid(field) : match;
  };
}
export function list<T>(decode: (value: unknown, field: string) => T) {
  return (value: unknown, field: string): T[] => {
    if (!Array.isArray(value)) return invalid(field);
    return value.map((entry, index) => decode(entry, `${field}[${index}]`));
  };
}
export function filenameMetadata(value: unknown, field: string): RemoteFileFilenameMetadata {
  const v = object(value, field);
  return {
    publishDate: optional(v.publishDate, `${field}.publishDate`, number),
    videoDate: optional(v.videoDate, `${field}.videoDate`, number),
    cid: optional(v.cid, `${field}.cid`, integer),
    pageIndex: optional(v.pageIndex, `${field}.pageIndex`, integer),
    bilibiliQuality: optional(v.bilibiliQuality, `${field}.bilibiliQuality`, text),
    dfn: optional(v.dfn, `${field}.dfn`, text),
    videoCodecs: optional(v.videoCodecs, `${field}.videoCodecs`, text),
  };
}
export function metadataMap(value: unknown, field: string): Record<string, RemoteFileFilenameMetadata> {
  return Object.fromEntries(Object.entries(object(value, field)).map(([key, entry]) => [key, filenameMetadata(entry, `${field}.${key}`)]));
}
export function remoteFile(value: unknown, field: string): RemoteFileRecord {
  const v = object(value, field);
  return {
    name: text(v.name, `${field}.name`), path: text(v.path, `${field}.path`),
    size: optional(v.size, `${field}.size`, number),
    localRelativePath: optional(v.localRelativePath, `${field}.localRelativePath`, text),
    verificationStatus: optional(v.verificationStatus, `${field}.verificationStatus`, oneOf(['awaiting_verification', 'verified', 'failed'])),
    putCompletedAt: optional(v.putCompletedAt, `${field}.putCompletedAt`, text),
    verifyAttempts: optional(v.verifyAttempts, `${field}.verifyAttempts`, integer),
    nextVerifyAt: optional(v.nextVerifyAt, `${field}.nextVerifyAt`, text),
    lastError: optional(v.lastError, `${field}.lastError`, text),
    filenameMetadata: optional(v.filenameMetadata, `${field}.filenameMetadata`, filenameMetadata),
    qualityProfile: optional(v.qualityProfile, `${field}.qualityProfile`, (value, field) => {
      const q = object(value, field);
      return { quality: text(q.quality, `${field}.quality`), encoding: text(q.encoding, `${field}.encoding`),
        hiRes: bool(q.hiRes, `${field}.hiRes`), dolby: bool(q.dolby, `${field}.dolby`) };
    }),
    mediaMetadata: optional(v.mediaMetadata, `${field}.mediaMetadata`, (value, field) => {
      const m = object(value, field);
      return { width: number(m.width, `${field}.width`), height: number(m.height, `${field}.height`),
        duration: optional(m.duration, `${field}.duration`, number), fps: optional(m.fps, `${field}.fps`, number),
        codec: optional(m.codec, `${field}.codec`, text), source: oneOf(['ffprobe', 'browser'])(m.source, `${field}.source`),
        observedAt: text(m.observedAt, `${field}.observedAt`) };
    }),
  };
}
export function archiveProof(value: unknown, field: string): ExistingArchiveProof {
  const v = object(value, field);
  return { remotePath: text(v.remotePath, `${field}.remotePath`), files: list(remoteFile)(v.files, `${field}.files`),
    status: oneOf(['verified', 'partial_verified'])(v.status, `${field}.status`),
    uploadedAt: optional(v.uploadedAt, `${field}.uploadedAt`, text), verifiedAt: optional(v.verifiedAt, `${field}.verifiedAt`, text) };
}
const encoding = oneOf(['HEVC', 'AVC', 'AV1']);
export function strictTarget(value: unknown, field: string): StrictMediaTarget {
  const v = object(value, field);
  const result = { quality: optional(v.quality, `${field}.quality`, text), encoding: optional(v.encoding, `${field}.encoding`, encoding) };
  if (!result.quality && !result.encoding) return invalid(field);
  return result;
}
export function encodingRetry(value: unknown, field: string): EncodingRetryContext {
  const v = object(value, field);
  const priority = list(encoding)(v.priority, `${field}.priority`);
  if (!priority.length || new Set(priority).size !== priority.length) return invalid(`${field}.priority`);
  return {
    parentJobId: text(v.parentJobId, `${field}.parentJobId`), generation: positive(v.generation, `${field}.generation`), priority,
    strict: bool(v.strict, `${field}.strict`), quality: optional(v.quality, `${field}.quality`, text),
    candidateLocalDir: text(v.candidateLocalDir, `${field}.candidateLocalDir`), originalLocalDir: text(v.originalLocalDir, `${field}.originalLocalDir`),
    originalFiles: optional(v.originalFiles, `${field}.originalFiles`, list(text)),
    state: optional(v.state, `${field}.state`, oneOf(['running', 'uploading', 'verifying', 'failed', 'completed'])),
    lastError: optional(v.lastError, `${field}.lastError`, text),
    target: optional(v.target, `${field}.target`, (value, field) => {
      const t = object(value, field);
      return {userId: text(t.userId, `${field}.userId`), mediaId: integer(t.mediaId, `${field}.mediaId`),
        folderTitle: text(t.folderTitle, `${field}.folderTitle`), remotePath: text(t.remotePath, `${field}.remotePath`)};
    }),
  };
}
