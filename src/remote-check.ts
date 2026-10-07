import { isDeepStrictEqual } from 'node:util';
import type { FavoriteRelation, RemoteFileRecord, VideoArchiveEntry } from './state.js';

function fileProof(files: RemoteFileRecord[] | undefined) {
  return (files ?? []).map(file => ({ name: file.name, path: file.path, size: file.size,
    verificationStatus: file.verificationStatus, putCompletedAt: file.putCompletedAt,
    qualityProfile: file.qualityProfile && { ...file.qualityProfile },
  })).sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

/** Copy validated DTO fields without attempting to structured-clone tracked state proxies. */
export function copyRemoteFiles(files: RemoteFileRecord[] | undefined) {
  return files?.map(file => ({...file,
    ...(file.qualityProfile ? {qualityProfile: {...file.qualityProfile}} : {}),
    ...(file.mediaMetadata ? {mediaMetadata: {...file.mediaMetadata}} : {}),
    ...(file.filenameMetadata ? {filenameMetadata: {...file.filenameMetadata}} : {}),
  }));
}

export function captureRemoteCheckEvidence(relation: FavoriteRelation) {
  return { userId: relation.userId, mediaId: relation.mediaId, bvid: relation.bvid,
    remotePath: relation.remotePath, files: fileProof(relation.remoteFiles),
    backupStatus: relation.backupStatus, uploadedAt: relation.uploadedAt,
    accountDetachedAt: relation.accountDetachedAt, pendingPartialBackup: relation.pendingPartialBackup,
    qualityUpgrade: relation.qualityUpgrade && {
      ...relation.qualityUpgrade,
      oldFiles: fileProof(relation.qualityUpgrade.oldFiles),
      backupFiles: fileProof(relation.qualityUpgrade.backupFiles),
      newFiles: fileProof(relation.qualityUpgrade.newFiles),
    },
    lastRemoteCheckAt: relation.lastRemoteCheckAt, nextRemoteCheckAt: relation.nextRemoteCheckAt,
    remoteMissingCount: relation.remoteMissingCount,
  };
}

export type RemoteCheckEvidence = ReturnType<typeof captureRemoteCheckEvidence>;
export type RemoteCheckOutcome =
  | { kind: 'ok'; remotePath?: string; files: RemoteFileRecord[] }
  | { kind: 'missing'; files: string[] }
  | { kind: 'deferred'; delayMs: number; reason: string };

export function matchesRemoteCheckEvidence(expected: RemoteCheckEvidence, relation: FavoriteRelation) {
  return isDeepStrictEqual(expected, captureRemoteCheckEvidence(relation));
}

/** A relation check must not replace the canonical evidence of another upload. */
export function sharesRemoteUpload(video: VideoArchiveEntry, relation: FavoriteRelation) {
  return video.remotePath === relation.remotePath && video.uploadedAt === relation.uploadedAt
    && isDeepStrictEqual(fileProof(video.remoteFiles), fileProof(relation.remoteFiles));
}
