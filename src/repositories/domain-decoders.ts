import type { PersistedDownloadApiCooldown } from '../download-api-health.js';
import type { PersistedUploadCooldown, UploadFailureCategory } from '../upload-health.js';
import type {
  FailedEntry,
  FavoriteRelation,
  FolderScanState,
  DownloadSessionReference,
  LocalCleanupPlan,
  RemoteConflictArchiveRecord,
  RemoteConflictCandidateRecord,
  RemoteFileFilenameMetadata,
  RemoteFileMediaMetadata,
  RemoteFileQualityProfile,
  RemoteFileRecord,
  SourceAvailability,
  UserCooldown,
  VideoArchiveEntry,
} from '../state.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';

export class PersistedDomainDecodeError extends Error {
  constructor(context: string, detail: string) {
    super(`Invalid persisted JSON (${context}): ${detail}`);
    this.name = 'PersistedDomainDecodeError';
  }
}

export function parsePersistedJsonValue(value: unknown, context: string, allowMissing = false): unknown {
  if (value == null || value === '') {
    if (allowMissing) return undefined;
    throw new PersistedDomainDecodeError(context, 'payload is missing');
  }
  if (typeof value !== 'string') throw new PersistedDomainDecodeError(context, 'payload must be JSON text');
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new PersistedDomainDecodeError(context, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersistedDomainDecodeError(context, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, context: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) throw new PersistedDomainDecodeError(context, `${key} must be a non-empty string`);
  return value;
}

function requiredNumber(source: Record<string, unknown>, key: string, context: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PersistedDomainDecodeError(context, `${key} must be a finite number`);
  return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string, context: string, fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new PersistedDomainDecodeError(context, `${key} must be a boolean`);
  return value;
}

function optionalString(source: Record<string, unknown>, key: string, context: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new PersistedDomainDecodeError(context, `${key} must be a string`);
  return value;
}

function optionalNumber(source: Record<string, unknown>, key: string, context: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PersistedDomainDecodeError(context, `${key} must be a finite number`);
  return value;
}

function optionalBooleanValue(source: Record<string, unknown>, key: string, context: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new PersistedDomainDecodeError(context, `${key} must be a boolean`);
  return value;
}

function optionalRecord<T>(source: Record<string, unknown>, key: string, context: string, decode: (value: unknown, context: string) => T): T | undefined {
  const value = source[key];
  return value === undefined ? undefined : decode(value, `${context}.${key}`);
}

function optionalArray<T>(source: Record<string, unknown>, key: string, context: string, decode: (value: unknown, context: string) => T): T[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PersistedDomainDecodeError(context, `${key} must be an array`);
  return value.map((item, index) => decode(item, `${context}.${key}[${index}]`));
}

const backupStatuses = new Set<VideoArchiveEntry['backupStatus']>([
  'discovered', 'queued', 'downloading', 'downloaded', 'uploading', 'upload_failed', 'uploaded',
  'verified', 'partial_verified', 'charging_restricted', 'missing', 'lost', 'failed',
]);
const biliStatuses = new Set<VideoArchiveEntry['biliStatus']>(['available', 'unavailable', 'unknown']);

function decodeBackupStatus(value: unknown, context: string): VideoArchiveEntry['backupStatus'] {
  if (typeof value !== 'string' || !backupStatuses.has(value as VideoArchiveEntry['backupStatus'])) {
    throw new PersistedDomainDecodeError(context, 'backupStatus is invalid');
  }
  return value as VideoArchiveEntry['backupStatus'];
}

function decodeBiliStatus(value: unknown, context: string): VideoArchiveEntry['biliStatus'] {
  if (typeof value !== 'string' || !biliStatuses.has(value as VideoArchiveEntry['biliStatus'])) {
    throw new PersistedDomainDecodeError(context, 'biliStatus is invalid');
  }
  return value as VideoArchiveEntry['biliStatus'];
}

function decodeFilenameMetadata(value: unknown, context: string): RemoteFileFilenameMetadata {
  const source = record(value, context);
  return {
    publishDate: optionalNumber(source, 'publishDate', context),
    videoDate: optionalNumber(source, 'videoDate', context),
    cid: optionalNumber(source, 'cid', context),
    pageIndex: optionalNumber(source, 'pageIndex', context),
    bilibiliQuality: optionalString(source, 'bilibiliQuality', context),
    dfn: optionalString(source, 'dfn', context),
    videoCodecs: optionalString(source, 'videoCodecs', context),
  };
}

function decodeMediaMetadata(value: unknown, context: string): RemoteFileMediaMetadata {
  const source = record(value, context);
  const metadataSource = source.source;
  if (metadataSource !== 'ffprobe' && metadataSource !== 'browser') {
    throw new PersistedDomainDecodeError(context, 'source is invalid');
  }
  return {
    width: requiredNumber(source, 'width', context),
    height: requiredNumber(source, 'height', context),
    duration: optionalNumber(source, 'duration', context),
    fps: optionalNumber(source, 'fps', context),
    codec: optionalString(source, 'codec', context),
    source: metadataSource,
    observedAt: requiredString(source, 'observedAt', context),
  };
}

function decodeRemoteFile(value: unknown, context: string): RemoteFileRecord {
  const source = record(value, context);
  const verificationStatus = source.verificationStatus;
  if (verificationStatus !== undefined && verificationStatus !== 'awaiting_verification'
    && verificationStatus !== 'verified' && verificationStatus !== 'failed') {
    throw new PersistedDomainDecodeError(context, 'verificationStatus is invalid');
  }
  const result: RemoteFileRecord = {
    name: requiredString(source, 'name', context),
    path: requiredString(source, 'path', context),
  };
  const size = optionalNumber(source, 'size', context);
  const qualityProfile = optionalRecord(source, 'qualityProfile', context, decodeQualityProfile);
  const mediaMetadata = optionalRecord(source, 'mediaMetadata', context, decodeMediaMetadata);
  const localRelativePath = optionalString(source, 'localRelativePath', context);
  const putCompletedAt = optionalString(source, 'putCompletedAt', context);
  const verifyAttempts = optionalNumber(source, 'verifyAttempts', context);
  const nextVerifyAt = optionalString(source, 'nextVerifyAt', context);
  const lastError = optionalString(source, 'lastError', context);
  const filenameMetadata = optionalRecord(source, 'filenameMetadata', context, decodeFilenameMetadata);
  if (size !== undefined) result.size = size;
  if (qualityProfile !== undefined) result.qualityProfile = qualityProfile;
  if (mediaMetadata !== undefined) result.mediaMetadata = mediaMetadata;
  if (localRelativePath !== undefined) result.localRelativePath = localRelativePath;
  if (verificationStatus !== undefined) result.verificationStatus = verificationStatus;
  if (putCompletedAt !== undefined) result.putCompletedAt = putCompletedAt;
  if (verifyAttempts !== undefined) result.verifyAttempts = verifyAttempts;
  if (nextVerifyAt !== undefined) result.nextVerifyAt = nextVerifyAt;
  if (lastError !== undefined) result.lastError = lastError;
  if (filenameMetadata !== undefined) result.filenameMetadata = filenameMetadata;
  return result;
}

function decodeMetadataSnapshot(value: unknown, context: string) {
  const source = record(value, context);
  return {
    title: requiredString(source, 'title', context),
    upperName: requiredString(source, 'upperName', context),
    cover: optionalString(source, 'cover', context),
    coverLocalPath: optionalString(source, 'coverLocalPath', context),
    description: optionalString(source, 'description', context),
    capturedAt: requiredString(source, 'capturedAt', context),
  };
}

function decodeDownloadSession(value: unknown, context: string): DownloadSessionReference {
  const source = record(value, context);
  const kind = source.kind;
  const status = source.status;
  if (kind !== 'backup' && kind !== 'main' && kind !== 'quality_upgrade') throw new PersistedDomainDecodeError(context, 'kind is invalid');
  if (status !== 'prepared' && status !== 'downloading' && status !== 'complete' && status !== 'partial' && status !== 'failed') {
    throw new PersistedDomainDecodeError(context, 'status is invalid');
  }
  return {
    id: requiredString(source, 'id', context),
    localDir: requiredString(source, 'localDir', context),
    kind: kind === 'main' ? 'backup' : kind,
    status,
    completedPages: requiredNumber(source, 'completedPages', context),
    totalPages: requiredNumber(source, 'totalPages', context),
    updatedAt: requiredString(source, 'updatedAt', context),
  };
}

function decodeAccessRestriction(value: unknown, context: string) {
  const source = record(value, context);
  if (source.type !== 'charging') throw new PersistedDomainDecodeError(context, 'type is invalid');
  const checkedAccountUids = source.checkedAccountUids;
  if (!Array.isArray(checkedAccountUids) || checkedAccountUids.some(item => typeof item !== 'string')) {
    throw new PersistedDomainDecodeError(context, 'checkedAccountUids must be an array of strings');
  }
  return {
    type: 'charging' as const,
    detectedAt: requiredString(source, 'detectedAt', context),
    lastCheckedAt: requiredString(source, 'lastCheckedAt', context),
    nextCheckAt: requiredString(source, 'nextCheckAt', context),
    previewAvailable: optionalBooleanValue(source, 'previewAvailable', context),
    checkedAccountUids: [...checkedAccountUids],
    lastError: optionalString(source, 'lastError', context),
  };
}

function decodeSourceAvailability(value: unknown, context: string): SourceAvailability {
  const source = record(value, context);
  const state = source.state;
  const reason = source.reason;
  if (state !== 'pending_confirmation' && state !== 'unknown' && state !== 'confirmed_unavailable' && state !== 'dormant') {
    throw new PersistedDomainDecodeError(context, 'state is invalid');
  }
  if (reason !== 'favorite_flag' && reason !== 'api_not_found' && reason !== 'submission_invisible'
    && reason !== 'under_review' && reason !== 'uploader_only' && reason !== 'temporary_error') {
    throw new PersistedDomainDecodeError(context, 'reason is invalid');
  }
  return {
    state,
    reason,
    firstSeenAt: requiredString(source, 'firstSeenAt', context),
    lastCheckedAt: optionalString(source, 'lastCheckedAt', context),
    nextCheckAt: optionalString(source, 'nextCheckAt', context),
    checkRound: requiredNumber(source, 'checkRound', context),
  };
}

function decodeAccessClassification(value: unknown, context: string): NonNullable<VideoArchiveEntry['accessClassification']> {
  const source = record(value, context);
  if (source.purpose !== 'legacy_failure_classification') throw new PersistedDomainDecodeError(context, 'purpose is invalid');
  const result = source.result;
  if (result !== undefined && result !== 'charging' && result !== 'available' && result !== 'unavailable' && result !== 'other_restricted') {
    throw new PersistedDomainDecodeError(context, 'result is invalid');
  }
  return {
    purpose: 'legacy_failure_classification' as const,
    classifiedAt: optionalString(source, 'classifiedAt', context),
    result,
    nextCheckAt: optionalString(source, 'nextCheckAt', context),
  };
}

export function decodeVideoPayload(value: unknown, context = 'video'): VideoArchiveEntry {
  const source = record(value, context);
  const backupStatus = decodeBackupStatus(source.backupStatus, context);
  const biliStatus = decodeBiliStatus(source.biliStatus, context);
  return {
    bvid: requiredString(source, 'bvid', context),
    title: requiredString(source, 'title', context),
    upperName: requiredString(source, 'upperName', context),
    upperMid: optionalNumber(source, 'upperMid', context),
    cover: optionalString(source, 'cover', context),
    originalMeta: optionalRecord(source, 'originalMeta', context, decodeMetadataSnapshot),
    description: optionalString(source, 'description', context),
    firstSeenAt: requiredString(source, 'firstSeenAt', context),
    lastSeenAt: requiredString(source, 'lastSeenAt', context),
    biliStatus,
    backupStatus,
    statusUpdatedAt: optionalString(source, 'statusUpdatedAt', context),
    remotePath: optionalString(source, 'remotePath', context),
    remoteFiles: optionalArray(source, 'remoteFiles', context, decodeRemoteFile),
    pendingPartialBackup: optionalBooleanValue(source, 'pendingPartialBackup', context),
    localDir: optionalString(source, 'localDir', context),
    downloadSession: optionalRecord(source, 'downloadSession', context, decodeDownloadSession),
    accessRestriction: optionalRecord(source, 'accessRestriction', context, decodeAccessRestriction),
    sourceAvailability: optionalRecord(source, 'sourceAvailability', context, decodeSourceAvailability),
    accessClassification: optionalRecord(source, 'accessClassification', context, decodeAccessClassification),
    uploadedAt: optionalString(source, 'uploadedAt', context),
    verifiedAt: optionalString(source, 'verifiedAt', context),
    lastRemoteCheckAt: optionalString(source, 'lastRemoteCheckAt', context),
    nextRemoteCheckAt: optionalString(source, 'nextRemoteCheckAt', context),
    remoteMissingCount: optionalNumber(source, 'remoteMissingCount', context),
    lastError: optionalString(source, 'lastError', context),
    favoriteUnavailable: optionalBooleanValue(source, 'favoriteUnavailable', context),
    selfVisible: optionalBooleanValue(source, 'selfVisible', context),
    legacyProcessed: optionalBooleanValue(source, 'legacyProcessed', context),
  };
}

function decodeConflictArchive(value: unknown, context: string): RemoteConflictArchiveRecord {
  const source = record(value, context);
  const files = source.files;
  if (!Array.isArray(files)) throw new PersistedDomainDecodeError(context, 'files must be an array');
  return {
    archivePath: requiredString(source, 'archivePath', context),
    archivedAt: requiredString(source, 'archivedAt', context),
    files: files.map((item, index) => {
      const file = record(item, `${context}.files[${index}]`);
      return {
        name: requiredString(file, 'name', `${context}.files[${index}]`),
        oldPath: requiredString(file, 'oldPath', `${context}.files[${index}]`),
        archivedPath: requiredString(file, 'archivedPath', `${context}.files[${index}]`),
        size: optionalNumber(file, 'size', `${context}.files[${index}]`),
      };
    }),
  };
}

function decodeExistingArchiveProof(value: unknown, context: string): ExistingArchiveProof {
  const source = record(value, context);
  const status = source.status;
  if (status !== 'verified' && status !== 'partial_verified') throw new PersistedDomainDecodeError(context, 'status is invalid');
  const files = source.files;
  if (!Array.isArray(files)) throw new PersistedDomainDecodeError(context, 'files must be an array');
  return {
    remotePath: requiredString(source, 'remotePath', context),
    files: files.map((item, index) => decodeRemoteFile(item, `${context}.files[${index}]`)),
    status,
    uploadedAt: optionalString(source, 'uploadedAt', context),
    verifiedAt: optionalString(source, 'verifiedAt', context),
  };
}

function decodeConflictCandidate(value: unknown, context: string): RemoteConflictCandidateRecord {
  const source = record(value, context);
  const resolution = source.resolution;
  if (resolution !== undefined && resolution !== 'kept_existing' && resolution !== 'selected_candidate' && resolution !== 'abandoned') {
    throw new PersistedDomainDecodeError(context, 'resolution is invalid');
  }
  const files = source.files;
  if (!Array.isArray(files)) throw new PersistedDomainDecodeError(context, 'files must be an array');
  return {
    id: requiredString(source, 'id', context),
    createdAt: requiredString(source, 'createdAt', context),
    resolvedAt: optionalString(source, 'resolvedAt', context),
    resolution,
    originalRemotePath: requiredString(source, 'originalRemotePath', context),
    candidateRemotePath: requiredString(source, 'candidateRemotePath', context),
    reasonCode: requiredString(source, 'reasonCode', context),
    reasonSummary: requiredString(source, 'reasonSummary', context),
    files: files.map((item, index) => decodeRemoteFile(item, `${context}.files[${index}]`)),
    existingArchiveProof: optionalRecord(source, 'existingArchiveProof', context, decodeExistingArchiveProof),
  };
}

function decodeQualityUpgrade(value: unknown, context: string) {
  const source = record(value, context);
  const oldFiles = source.oldFiles;
  if (!Array.isArray(oldFiles)) throw new PersistedDomainDecodeError(context, 'oldFiles must be an array');
  return {
    artifactKey: optionalString(source, 'artifactKey', context),
    stageRemotePath: requiredString(source, 'stageRemotePath', context),
    backupRemotePath: requiredString(source, 'backupRemotePath', context),
    oldRemotePath: requiredString(source, 'oldRemotePath', context),
    oldFiles: oldFiles.map((item, index) => decodeRemoteFile(item, `${context}.oldFiles[${index}]`)),
    backupFiles: optionalArray(source, 'backupFiles', context, decodeRemoteFile),
    newFiles: optionalArray(source, 'newFiles', context, decodeRemoteFile),
    finalizedAt: optionalString(source, 'finalizedAt', context),
    startedAt: requiredString(source, 'startedAt', context),
  };
}

export function decodeFavoriteRelation(value: unknown, context = 'favorite relation'): FavoriteRelation {
  const source = record(value, context);
  const sourceKind = source.sourceKind;
  if (sourceKind !== undefined && sourceKind !== 'favorite' && sourceKind !== 'manual') {
    throw new PersistedDomainDecodeError(context, 'sourceKind is invalid');
  }
  const backupStatus = source.backupStatus === undefined ? undefined : decodeBackupStatus(source.backupStatus, context);
  return {
    userId: requiredString(source, 'userId', context),
    mediaId: requiredNumber(source, 'mediaId', context),
    bvid: requiredString(source, 'bvid', context),
    sourceKind,
    folderTitle: requiredString(source, 'folderTitle', context),
    firstSeenAt: requiredString(source, 'firstSeenAt', context),
    lastSeenAt: requiredString(source, 'lastSeenAt', context),
    favOrder: optionalNumber(source, 'favOrder', context),
    favPage: optionalNumber(source, 'favPage', context),
    favIndexInPage: optionalNumber(source, 'favIndexInPage', context),
    favOrderUpdatedAt: optionalString(source, 'favOrderUpdatedAt', context),
    activeInFavorite: optionalBoolean(source, 'activeInFavorite', context, false),
    backupStatus,
    statusUpdatedAt: optionalString(source, 'statusUpdatedAt', context),
    remotePath: optionalString(source, 'remotePath', context),
    remoteFiles: optionalArray(source, 'remoteFiles', context, decodeRemoteFile),
    remoteConflictArchives: optionalArray(source, 'remoteConflictArchives', context, decodeConflictArchive),
    remoteConflictCandidates: optionalArray(source, 'remoteConflictCandidates', context, decodeConflictCandidate),
    pendingPartialBackup: optionalBooleanValue(source, 'pendingPartialBackup', context),
    qualityUpgrade: optionalRecord(source, 'qualityUpgrade', context, decodeQualityUpgrade),
    uploadedAt: optionalString(source, 'uploadedAt', context),
    verifiedAt: optionalString(source, 'verifiedAt', context),
    lastRemoteCheckAt: optionalString(source, 'lastRemoteCheckAt', context),
    nextRemoteCheckAt: optionalString(source, 'nextRemoteCheckAt', context),
    remoteMissingCount: optionalNumber(source, 'remoteMissingCount', context),
    lastError: optionalString(source, 'lastError', context),
    favoriteUnavailable: optionalBooleanValue(source, 'favoriteUnavailable', context),
    selfVisible: optionalBooleanValue(source, 'selfVisible', context),
    accountDetachedAt: optionalString(source, 'accountDetachedAt', context),
  };
}

export function decodeFolderScanState(value: unknown, context = 'folder scan'): FolderScanState {
  const source = record(value, context);
  const initStatus = source.initStatus;
  if (initStatus !== 'pending' && initStatus !== 'initializing' && initStatus !== 'complete') {
    throw new PersistedDomainDecodeError(context, 'initStatus is invalid');
  }
  return {
    userId: requiredString(source, 'userId', context),
    mediaId: requiredNumber(source, 'mediaId', context),
    folderTitle: requiredString(source, 'folderTitle', context),
    initStatus,
    nextHistoryPage: requiredNumber(source, 'nextHistoryPage', context),
    catchupPage: requiredNumber(source, 'catchupPage', context),
    lastHotScanAt: optionalString(source, 'lastHotScanAt', context),
    lastHistoryScanAt: optionalString(source, 'lastHistoryScanAt', context),
    lastScannedAt: optionalString(source, 'lastScannedAt', context),
    total: optionalNumber(source, 'total', context),
  };
}

export function decodeFailedEntry(value: unknown, context = 'failure'): FailedEntry {
  const source = record(value, context);
  const userDisposition = source.userDisposition;
  if (userDisposition !== undefined && userDisposition !== 'abandoned') {
    throw new PersistedDomainDecodeError(context, 'userDisposition is invalid');
  }
  return {
    bvid: requiredString(source, 'bvid', context),
    mediaId: requiredNumber(source, 'mediaId', context),
    failedAt: requiredString(source, 'failedAt', context),
    reason: requiredString(source, 'reason', context),
    permanent: optionalBoolean(source, 'permanent', context, false),
    userDisposition,
    abandonedAt: optionalString(source, 'abandonedAt', context),
  };
}

export function decodeUserCooldown(value: unknown, context = 'user cooldown'): UserCooldown {
  const source = record(value, context);
  return {
    userId: requiredString(source, 'userId', context),
    until: requiredNumber(source, 'until', context),
    reason: requiredString(source, 'reason', context),
    setAt: requiredString(source, 'setAt', context),
  };
}

export function decodeDownloadApiCooldown(value: unknown, context = 'download API cooldown'): PersistedDownloadApiCooldown {
  const source = record(value, context);
  const probeMode = source.probeMode;
  if (probeMode !== 'web' && probeMode !== 'app') {
    throw new PersistedDomainDecodeError(context, 'probeMode is invalid');
  }
  return {
    until: requiredNumber(source, 'until', context),
    reason: requiredString(source, 'reason', context),
    probeBvid: requiredString(source, 'probeBvid', context),
    probeUserId: requiredString(source, 'probeUserId', context),
    probeMode,
    setAt: requiredString(source, 'setAt', context),
  };
}

export function decodeUploadCooldown(value: unknown, context = 'upload cooldown'): PersistedUploadCooldown {
  const source = record(value, context);
  const state = source.state;
  if (state !== 'closed' && state !== 'open' && state !== 'half_open') {
    throw new PersistedDomainDecodeError(context, 'state is invalid');
  }
  const category = source.category;
  const validCategories: UploadFailureCategory[] = ['auth', 'deterministic', 'rate_limit', 'transient', 'server', 'unknown'];
  if (category !== undefined && (typeof category !== 'string' || !validCategories.includes(category as UploadFailureCategory))) {
    throw new PersistedDomainDecodeError(context, 'category is invalid');
  }
  for (const key of ['retryAt', 'openedAt', 'consecutiveFailures'] as const) {
    const numberValue = source[key];
    if (numberValue !== undefined && (typeof numberValue !== 'number' || !Number.isFinite(numberValue))) {
      throw new PersistedDomainDecodeError(context, `${key} must be a finite number`);
    }
  }
  for (const key of ['probeInFlight', 'pausedDownloads'] as const) {
    const flag = source[key];
    if (flag !== undefined && typeof flag !== 'boolean') {
      throw new PersistedDomainDecodeError(context, `${key} must be a boolean`);
    }
  }
  if (source.reason !== undefined && typeof source.reason !== 'string') {
    throw new PersistedDomainDecodeError(context, 'reason must be a string');
  }
  return {
    state,
    ...(typeof source.reason === 'string' ? { reason: source.reason } : {}),
    ...(typeof category === 'string' ? { category: category as UploadFailureCategory } : {}),
    ...(typeof source.consecutiveFailures === 'number' ? { consecutiveFailures: source.consecutiveFailures } : {}),
    ...(typeof source.openedAt === 'number' ? { openedAt: source.openedAt } : {}),
    ...(typeof source.retryAt === 'number' ? { retryAt: source.retryAt } : {}),
    ...(typeof source.probeInFlight === 'boolean' ? { probeInFlight: source.probeInFlight } : {}),
    ...(typeof source.pausedDownloads === 'boolean' ? { pausedDownloads: source.pausedDownloads } : {}),
  };
}

export function decodeLocalCleanupPlan(value: unknown, context = 'local cleanup plan'): LocalCleanupPlan {
  const source = record(value, context);
  const reason = source.reason;
  if (reason !== 'upload_verified' && reason !== 'quality_upgrade') {
    throw new PersistedDomainDecodeError(context, 'reason is invalid');
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new PersistedDomainDecodeError(context, 'files must be a non-empty array');
  }
  const files = source.files.map((value, index) => {
    const file = record(value, `${context}.files[${index}]`);
    const identity = record(file.expectedIdentity, `${context}.files[${index}].expectedIdentity`);
    const remotePaths = file.remotePaths;
    if (!Array.isArray(remotePaths) || remotePaths.length === 0 || remotePaths.some(path => typeof path !== 'string' || path.length === 0)) {
      throw new PersistedDomainDecodeError(`${context}.files[${index}]`, 'remotePaths must be non-empty strings');
    }
    return {
      relativePath: requiredString(file, 'relativePath', `${context}.files[${index}]`),
      expectedSize: requiredNumber(file, 'expectedSize', `${context}.files[${index}]`),
      expectedIdentity: {
        dev: requiredNumber(identity, 'dev', `${context}.files[${index}].expectedIdentity`),
        ino: requiredNumber(identity, 'ino', `${context}.files[${index}].expectedIdentity`),
        mtimeMs: requiredNumber(identity, 'mtimeMs', `${context}.files[${index}].expectedIdentity`),
        ctimeMs: requiredNumber(identity, 'ctimeMs', `${context}.files[${index}].expectedIdentity`),
      },
      remotePaths: [...new Set(remotePaths)],
    };
  });
  const transferGeneration = source.transferGeneration;
  if (transferGeneration !== undefined && (typeof transferGeneration !== 'number' || !Number.isFinite(transferGeneration))) {
    throw new PersistedDomainDecodeError(context, 'transferGeneration must be a finite number');
  }
  return {
    id: requiredString(source, 'id', context),
    localDir: requiredString(source, 'localDir', context),
    manifestSessionId: requiredString(source, 'manifestSessionId', context),
    transferSessionId: source.transferSessionId === undefined ? undefined : requiredString(source, 'transferSessionId', context),
    transferGeneration,
    reason,
    files,
    createdAt: requiredString(source, 'createdAt', context),
  };
}

export function decodeQualityProfile(value: unknown, context = 'quality profile'): RemoteFileQualityProfile | undefined {
  if (value === undefined || value === null) return undefined;
  const source = record(value, context);
  const quality = requiredString(source, 'quality', context);
  const encoding = requiredString(source, 'encoding', context);
  if ((source.hiRes !== undefined && typeof source.hiRes !== 'boolean')
    || (source.dolby !== undefined && typeof source.dolby !== 'boolean')) {
    throw new PersistedDomainDecodeError(context, 'hiRes and dolby must be booleans');
  }
  return { quality, encoding, hiRes: source.hiRes === true, dolby: source.dolby === true };
}
