import { isRecord } from '../shared/api/value.js';
import type { RemoteFileFilenameMetadata } from '../state.js';
import { parseStrictMediaTarget, parseEncodingRetryContext } from './recovery-context.js';

export class VerificationPayloadError extends Error {
  constructor(field: string) { super(`Invalid persisted verification field: ${field}`); this.name = 'VerificationPayloadError'; }
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export function parseVerificationPayload(value: unknown) {
  if (!isRecord(value)) throw new VerificationPayloadError('payload');
  const raw = value;
  for (const key of ['historySnapshotAt', 'localDir', 'remotePath', 'sessionId', 'putCompletedAt', 'folderTitle', 'videoTitle', 'upperName', 'cover']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new VerificationPayloadError(key);
  }
  for (const key of ['partialBackup', 'historyOnly', 'sessionVerification']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new VerificationPayloadError(key);
  }
  if (raw.sessionGeneration !== undefined && (typeof raw.sessionGeneration !== 'number' || !Number.isInteger(raw.sessionGeneration) || raw.sessionGeneration < 1)) throw new VerificationPayloadError('sessionGeneration');
  const rawFiles = raw.files;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) throw new VerificationPayloadError('files');
  const files = rawFiles === undefined ? [] : rawFiles.map(item => {
    if (typeof item !== 'string' || item.length === 0) throw new VerificationPayloadError('files');
    return item;
  });
  if (raw.filenameMetadataByPath !== undefined && !isRecord(raw.filenameMetadataByPath)) throw new VerificationPayloadError('filenameMetadataByPath');
  if (raw.encodingRetry !== undefined && !parseEncodingRetryContext(raw.encodingRetry)) throw new VerificationPayloadError('encodingRetry');
  if (raw.strictMediaTarget !== undefined && !parseStrictMediaTarget(raw.strictMediaTarget)) throw new VerificationPayloadError('strictMediaTarget');
  const filenameMetadataByPath: Record<string, RemoteFileFilenameMetadata> = {};
  if (isRecord(raw.filenameMetadataByPath)) {
    for (const [path, entry] of Object.entries(raw.filenameMetadataByPath)) {
      if (!isRecord(entry)) throw new VerificationPayloadError(`filenameMetadataByPath.${path}`);
      for (const key of ['publishDate', 'videoDate', 'cid', 'pageIndex']) {
        if (entry[key] !== undefined && finite(entry[key]) === undefined) throw new VerificationPayloadError(`filenameMetadataByPath.${path}.${key}`);
      }
      for (const key of ['bilibiliQuality', 'dfn', 'videoCodecs']) {
        if (entry[key] !== undefined && typeof entry[key] !== 'string') throw new VerificationPayloadError(`filenameMetadataByPath.${path}.${key}`);
      }
      filenameMetadataByPath[path] = {
        publishDate: finite(entry.publishDate), videoDate: finite(entry.videoDate),
        cid: finite(entry.cid), pageIndex: finite(entry.pageIndex),
        bilibiliQuality: text(entry.bilibiliQuality), dfn: text(entry.dfn), videoCodecs: text(entry.videoCodecs),
      };
    }
  }
  return {
    encodingRetry: raw.encodingRetry,
    partialBackup: raw.partialBackup === true, historyOnly: raw.historyOnly === true,
    historySnapshotAt: text(raw.historySnapshotAt),
    localDir: text(raw.localDir), remotePath: text(raw.remotePath),
    sessionId: text(raw.sessionId), sessionGeneration: finite(raw.sessionGeneration),
    putCompletedAt: text(raw.putCompletedAt), folderTitle: text(raw.folderTitle),
    videoTitle: text(raw.videoTitle), upperName: text(raw.upperName), cover: text(raw.cover),
    files,
    filenameMetadataByPath: raw.filenameMetadataByPath === undefined ? undefined : filenameMetadataByPath,
    strictMediaTarget: parseStrictMediaTarget(raw.strictMediaTarget),
  };
}
