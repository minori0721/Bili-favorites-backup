import path from 'node:path';
import type { BBDownEncoding } from '../config.js';
import type { PersistentJobRecord } from '../database.js';
import type { StateManager, RemoteFileRecord, RemoteFileMediaMetadata, RemoteFileFilenameMetadata } from '../state.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { normalizeRemotePath, remoteDirname } from '../remote-path.js';
import { sanitizeUploadText, type RemoteWriteEvidence } from '../upload-health.js';
import type { RemoteFailureCategory } from '../remote-file-resolver.js';
import type { RecoveryAssessment } from './recovery-contracts.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveNumber(value: unknown) {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

export function parseRecoveryAssessment(payload: unknown): RecoveryAssessment | null {
  const value = record(record(payload).recoveryAssessment);
  const checkedAt = finiteNumber(value.checkedAt);
  if (!checkedAt || checkedAt <= 0 || Object.keys(value).length === 0) return null;
  const kind = String(value.kind || 'manual_review');
  const localStatus = String(value.localStatus || 'unknown');
  const remoteStatus = String(value.remoteStatus || 'unknown');
  const allowedKinds = new Set([
    'remote_visibility_timeout', 'remote_visibility_stalled', 'remote_write_rejected', 'remote_size_conflict',
    'remote_size_limit', 'partial_remote_state', 'local_file_missing', 'local_file_changed', 'remote_connection',
    'remote_permission', 'remote_unsupported', 'remote_unknown', 'unknown_same_size', 'legacy_conflict_interrupted',
    'conflict_candidate_ready', 'encoding_retry_failed', 'manual_review', 'download_retry_exhausted',
    'download_account_required', 'download_tool_failure',
  ]);
  const responseHeaders = record(value.responseHeaders);
  const headerNames = new Set(['allow', 'retry-after', 'content-type', 'content-length', 'dav', 'x-openlist-error-code', 'x-alist-error-code', 'x-error-code']);
  const safeHeaders = Object.fromEntries(Object.entries(responseHeaders)
    .filter(([key, item]) => headerNames.has(key) && typeof item === 'string')
    .map(([key, item]) => [key, sanitizeUploadText(item, 180)]));
  const writeEvidence = String(value.writeEvidence || '');
  const failureCategory = String(value.failureCategory || '');
  const operation = String(value.operation || '');
  const requestedEncoding = String(value.requestedEncoding || '').toUpperCase();
  const assessment: RecoveryAssessment = {
    kind: (allowedKinds.has(kind) ? kind : 'manual_review') as RecoveryAssessment['kind'],
    checkedAt,
    nextCheckAt: finiteNumber(value.nextCheckAt),
    localStatus: (['available', 'missing', 'changed', 'unknown'].includes(localStatus) ? localStatus : 'unknown') as RecoveryAssessment['localStatus'],
    remoteStatus: (['verified', 'missing', 'mismatch', 'mixed', 'error', 'unknown', 'transient', 'permission', 'unsupported', 'size_limit'].includes(remoteStatus) ? remoteStatus : 'unknown') as RecoveryAssessment['remoteStatus'],
    fileName: value.fileName ? path.basename(String(value.fileName)) : undefined,
    expectedSize: finiteNumber(value.expectedSize),
    observedSize: finiteNumber(value.observedSize),
    writeStatus: Number.isInteger(Number(value.writeStatus)) && Number(value.writeStatus) >= 100 && Number(value.writeStatus) <= 599 ? Number(value.writeStatus) : undefined,
    remoteErrorCode: typeof value.remoteErrorCode === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,80}$/.test(value.remoteErrorCode) ? value.remoteErrorCode : undefined,
    responseHeaders: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
    responseSnippet: typeof value.responseSnippet === 'string' ? sanitizeUploadText(value.responseSnippet, 240) : undefined,
    writeEvidence: ['target_missing_parent_visible', 'repeated_missing_parent_visible'].includes(writeEvidence) ? writeEvidence as RemoteWriteEvidence | 'repeated_missing_parent_visible' : undefined,
    uploadAttempts: finiteNumber(value.uploadAttempts) !== undefined && Number(value.uploadAttempts) >= 0 ? Number(value.uploadAttempts) : undefined,
    firstObservedAt: positiveNumber(value.firstObservedAt),
    lastObservedAt: positiveNumber(value.lastObservedAt),
    consecutiveObservations: positiveNumber(value.consecutiveObservations) !== undefined ? Math.floor(Number(value.consecutiveObservations)) : undefined,
    candidateSafe: value.candidateSafe === true,
    candidateEligible: typeof value.candidateEligible === 'boolean' ? value.candidateEligible : undefined,
    failureCategory: ['transient', 'permission', 'unsupported', 'not_found', 'conflict', 'unknown'].includes(failureCategory) ? failureCategory as RemoteFailureCategory : undefined,
    operation: ['inspect', 'put'].includes(operation) ? operation as RecoveryAssessment['operation'] : undefined,
    requestedEncoding: ['HEVC', 'AVC', 'AV1'].includes(requestedEncoding) ? requestedEncoding as BBDownEncoding : undefined,
    actualEncodings: Array.isArray(value.actualEncodings) ? value.actualEncodings.map(String) : undefined,
    encodingMismatch: typeof value.encodingMismatch === 'boolean' ? value.encodingMismatch : undefined,
    requestedQuality: typeof value.requestedQuality === 'string' ? value.requestedQuality : undefined,
    actualQualities: Array.isArray(value.actualQualities) ? value.actualQualities.map(String) : undefined,
    qualityMismatch: typeof value.qualityMismatch === 'boolean' ? value.qualityMismatch : undefined,
    verifiedPages: finiteNumber(value.verifiedPages),
    summary: sanitizeUploadText(value.summary || '等待人工检查', 300),
  };
  return assessment;
}

export function parseExistingArchiveProof(payload: unknown): ExistingArchiveProof | null {
  const value = record(record(payload).existingArchiveProof);
  if (!Array.isArray(value.files) || value.files.length === 0 || !['verified', 'partial_verified'].includes(String(value.status))) return null;
  const files = value.files.filter(item => item && typeof item === 'object').map(item => ({ ...(item as RemoteFileRecord) }));
  if (files.length === 0) return null;
  return {
    remotePath: String(value.remotePath || ''),
    files,
    status: String(value.status) as ExistingArchiveProof['status'],
    uploadedAt: value.uploadedAt ? String(value.uploadedAt) : undefined,
    verifiedAt: value.verifiedAt ? String(value.verifiedAt) : undefined,
  };
}

export function verifiedFilesFromRecovery(payload: unknown, files: ReturnType<TransferSessionRepository['listFiles']>): RemoteFileRecord[] {
  const metadata = record(record(payload).filenameMetadataByPath);
  return files.map(file => {
    const fileMetadata = record(metadata[file.relativePath.replace(/\\/g, '/')]);
    const mediaMetadata = fileMetadata.mediaMetadata as RemoteFileMediaMetadata | undefined;
    const { mediaMetadata: _ignored, ...filenameMetadataRecord } = fileMetadata;
    return {
      name: file.name, path: file.finalPath, size: file.expectedSize, mediaMetadata,
      localRelativePath: file.relativePath,
      filenameMetadata: Object.keys(filenameMetadataRecord).length > 0 ? filenameMetadataRecord as unknown as RemoteFileFilenameMetadata : undefined,
      verificationStatus: 'verified' as const,
      putCompletedAt: file.putAcceptedAt ? new Date(file.putAcceptedAt).toISOString() : undefined,
      verifyAttempts: Math.max(1, file.attempts),
    };
  });
}

export function isVerifiedArchiveProofForRecovery(payload: unknown, proof: ExistingArchiveProof) {
  const item = record(payload);
  if (proof.status !== 'verified' || !proof.verifiedAt || proof.files.length === 0) return false;
  const requestedRemotePath = String(item.remotePath || '').trim();
  if (!requestedRemotePath) return false;
  try {
    const expectedDirectory = normalizeRemotePath(requestedRemotePath, { allowTrailingSlash: true });
    const proofDirectory = normalizeRemotePath(String(proof.remotePath || remoteDirname(String(proof.files[0]?.path || ''))), { allowTrailingSlash: true });
    if (expectedDirectory !== proofDirectory) return false;
    const proofNames = proof.files.map(file => String(file.localRelativePath || path.posix.basename(String(file.path || ''))).replace(/\\/g, '/'));
    const requestedFiles = Array.isArray(item.files) ? Array.from(new Set(item.files.map(value => String(value || '').replace(/\\/g, '/')).filter(Boolean))) : [];
    if (proofNames.some(name => !name) || new Set(proofNames).size !== proofNames.length || requestedFiles.length === 0
      || requestedFiles.length !== proofNames.length || requestedFiles.some(name => !proofNames.includes(name))) return false;
    const pathMatches = (filePath: string) => {
      try {
        return remoteDirname(normalizeRemotePath(filePath, { allowRoot: false })) === proofDirectory;
      // boundary-critical: malformed persisted paths cannot authorize a recovery.
      } catch {
        return false;
      }
    };
    return proof.files.every(file => file.verificationStatus === 'verified' && Number.isFinite(Number(file.size)) && Number(file.size) > 0
      && pathMatches(String(file.path || '')));
  // boundary-critical: invalid persisted proof data is rejected and never
  // projected as an actionable recovery item.
  } catch { /* boundary-critical: invalid proof is not actionable. */ return false; }
}

export function observedSameSizeProof(
  payload: unknown,
  assessment: RecoveryAssessment | null,
  sessions: Pick<TransferSessionRepository, 'get' | 'listFiles'>,
  now: () => number,
): ExistingArchiveProof | undefined {
  const item = record(payload);
  if (assessment?.kind !== 'unknown_same_size' || assessment.remoteStatus !== 'verified' || !item.sessionId) return undefined;
  const session = sessions.get(String(item.sessionId));
  if (!session) return undefined;
  const generation = Number.isInteger(item.sessionGeneration) ? Number(item.sessionGeneration) : session.generation;
  const files = session.generation === generation ? sessions.listFiles(session.id, generation) : [];
  if (files.length === 0 || files.some(file => !file.finalPath || !Number.isFinite(file.expectedSize) || file.expectedSize <= 0)) return undefined;
  return {
    remotePath: String(item.remotePath || session.remotePath || ''), status: 'verified', verifiedAt: new Date(now()).toISOString(),
    files: files.map(file => ({ name: file.name, path: file.finalPath, size: file.expectedSize, localRelativePath: file.relativePath, verificationStatus: 'verified' as const, verifyAttempts: Math.max(1, file.attempts) })),
  };
}
