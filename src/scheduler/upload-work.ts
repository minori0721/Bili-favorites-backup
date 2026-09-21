import type { RemoteFileRecord } from '../state.js';
import type { UploadIntent, ExistingArchiveProof } from '../upload-preflight.js';
import type { EncodingRetryContext, StrictMediaTarget } from '../tasks.js';
import { optional, text, bool, integer, positive, list, oneOf, archiveProof, remoteFile, metadataMap, encodingRetry, strictTarget } from './upload-payload-decoders.js';

export interface RecoveryUploadItem {
  bvid: string;
  localDir: string;
  remotePath: string;
  userId?: string;
  mediaId?: number;
  folderTitle?: string;
  videoTitle?: string;
  upperName?: string;
  cover?: string;
  files?: string[];
  filenameMetadataByPath?: Record<string, NonNullable<RemoteFileRecord["filenameMetadata"]>>;
  partialBackup?: boolean;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  uploadIntent?: UploadIntent;
  existingArchiveProof?: ExistingArchiveProof;
  legacyConflictSideEffectsStarted?: boolean;
  conflictCandidateId?: string;
  conflictCandidateRemotePath?: string;
  conflictCandidateOnly?: boolean;
  conflictCandidateReasonCode?: string;
  conflictCandidateReasonSummary?: string;
  conflictArchiveSegment?: string;
  conflictArchiveOldFiles?: RemoteFileRecord[];
  conflictArchiveVerifiedPaths?: string[];
  sessionId?: string;
  sessionGeneration?: number;
  sessionDedupeKey?: string;
  allowReupload?: boolean;
  reuploadAuthorizedFiles?: string[];
  resumeOnly?: boolean;
  awaitingManualRecovery?: boolean;
  lifecycleState?: string;
  attemptKey?: string;
  userDisposition?: string;
  verifiedPages?: number;
  totalPages?: number;
  automaticRecoveryAttempts?: number;
  notBefore?: number;
  priority?: boolean;
  encodingRetry?: EncodingRetryContext;
  strictMediaTarget?: StrictMediaTarget;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`持久上传任务缺少有效字段 ${key}`);
  return value;
}

/** Decode persisted upload metadata before it crosses into the transfer workflow. */
export function parseRecoveryUploadItem(value: unknown): RecoveryUploadItem {
  const source = record(value);
  if (!source) throw new Error('持久上传任务载荷不是对象');
  const bvid = requiredString(source, 'bvid');
  const localDir = requiredString(source, 'localDir');
  const remotePath = requiredString(source, 'remotePath');
  const decoded: RecoveryUploadItem = {
    bvid, localDir, remotePath,
    userId: optional(source.userId, 'userId', text),
    folderTitle: optional(source.folderTitle, 'folderTitle', text),
    videoTitle: optional(source.videoTitle, 'videoTitle', text),
    upperName: optional(source.upperName, 'upperName', text),
    cover: optional(source.cover, 'cover', text),
    historySnapshotAt: optional(source.historySnapshotAt, 'historySnapshotAt', text),
    conflictCandidateId: optional(source.conflictCandidateId, 'conflictCandidateId', text),
    conflictCandidateRemotePath: optional(source.conflictCandidateRemotePath, 'conflictCandidateRemotePath', text),
    conflictCandidateReasonCode: optional(source.conflictCandidateReasonCode, 'conflictCandidateReasonCode', text),
    conflictCandidateReasonSummary: optional(source.conflictCandidateReasonSummary, 'conflictCandidateReasonSummary', text),
    conflictArchiveSegment: optional(source.conflictArchiveSegment, 'conflictArchiveSegment', text),
    sessionId: optional(source.sessionId, 'sessionId', text),
    sessionDedupeKey: optional(source.sessionDedupeKey, 'sessionDedupeKey', text),
    lifecycleState: optional(source.lifecycleState, 'lifecycleState', text),
    attemptKey: optional(source.attemptKey, 'attemptKey', text),
    userDisposition: optional(source.userDisposition, 'userDisposition', text),
    partialBackup: optional(source.partialBackup, 'partialBackup', bool),
    historyOnly: optional(source.historyOnly, 'historyOnly', bool),
    legacyConflictSideEffectsStarted: optional(source.legacyConflictSideEffectsStarted, 'legacyConflictSideEffectsStarted', bool),
    conflictCandidateOnly: optional(source.conflictCandidateOnly, 'conflictCandidateOnly', bool),
    allowReupload: optional(source.allowReupload, 'allowReupload', bool),
    resumeOnly: optional(source.resumeOnly, 'resumeOnly', bool),
    awaitingManualRecovery: optional(source.awaitingManualRecovery, 'awaitingManualRecovery', bool),
    priority: optional(source.priority, 'priority', bool),
    mediaId: optional(source.mediaId, 'mediaId', integer),
    verifiedPages: optional(source.verifiedPages, 'verifiedPages', integer),
    totalPages: optional(source.totalPages, 'totalPages', integer),
    automaticRecoveryAttempts: optional(source.automaticRecoveryAttempts, 'automaticRecoveryAttempts', integer),
    notBefore: optional(source.notBefore, 'notBefore', integer),
    files: optional(source.files, 'files', list(text)),
    conflictArchiveVerifiedPaths: optional(source.conflictArchiveVerifiedPaths, 'conflictArchiveVerifiedPaths', list(text)),
    reuploadAuthorizedFiles: optional(source.reuploadAuthorizedFiles, 'reuploadAuthorizedFiles', list(text)),
    sessionGeneration: optional(source.sessionGeneration, 'sessionGeneration', positive),
    uploadIntent: optional(source.uploadIntent, 'uploadIntent', oneOf(['normal_backup', 'history_upload', 'quality_upgrade', 'conflict_candidate'])),
    existingArchiveProof: optional(source.existingArchiveProof, 'existingArchiveProof', archiveProof),
    conflictArchiveOldFiles: optional(source.conflictArchiveOldFiles, 'conflictArchiveOldFiles', list(remoteFile)),
    filenameMetadataByPath: optional(source.filenameMetadataByPath, 'filenameMetadataByPath', metadataMap),
    encodingRetry: optional(source.encodingRetry, 'encodingRetry', encodingRetry),
    strictMediaTarget: optional(source.strictMediaTarget, 'strictMediaTarget', strictTarget),
  };
  // Preserve absent optional properties without retaining unvalidated input.
  for (const key of Object.keys(decoded) as Array<keyof RecoveryUploadItem>) {
    if (decoded[key] === undefined) delete decoded[key];
  }
  return decoded;
}
