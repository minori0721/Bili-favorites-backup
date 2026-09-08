import { isRecord } from '../shared/api/value.js';
import type { RemoteFileFilenameMetadata } from '../state.js';
import { parseStrictMediaTarget } from './recovery-context.js';

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
export function parseVerificationPayload(value: unknown) {
  const raw = isRecord(value) ? value : {};
  const filenameMetadataByPath: Record<string, RemoteFileFilenameMetadata> = {};
  if (isRecord(raw.filenameMetadataByPath)) {
    for (const [path, entry] of Object.entries(raw.filenameMetadataByPath)) {
      if (!isRecord(entry)) continue;
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
    files: Array.isArray(raw.files) ? raw.files.filter((item): item is string => typeof item === 'string') : [],
    filenameMetadataByPath: raw.filenameMetadataByPath === undefined ? undefined : filenameMetadataByPath,
    strictMediaTarget: parseStrictMediaTarget(raw.strictMediaTarget),
  };
}
