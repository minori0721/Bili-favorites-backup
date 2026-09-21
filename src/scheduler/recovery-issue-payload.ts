import type { BBDownEncoding } from '../config.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : {};
}
function parseExistingArchiveProof(value: unknown) {
  const proof = record(record(value).existingArchiveProof);
  if (!Array.isArray(proof.files) || proof.files.length === 0) return undefined;
  if (proof.status !== 'verified' && proof.status !== 'partial_verified') return undefined;
  const files = proof.files.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
  ).map(item => ({
    name: text(item.name) || '', path: text(item.path) || '',
    size: number(item.size), verificationStatus: item.verificationStatus === 'verified' ? 'verified' as const : undefined,
  })).filter(item => item.name && item.path && item.verificationStatus);
  if (files.length === 0) return undefined;
  const uploadedAt = text(proof.uploadedAt);
  const verifiedAt = text(proof.verifiedAt);
  return {
    remotePath: text(proof.remotePath) || '', files,
    status: proof.status,
    ...(uploadedAt ? { uploadedAt } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
  };
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value.filter((item): item is string => typeof item === 'string') : undefined;
function encoding(value: unknown): BBDownEncoding | undefined {
  return value === 'AVC' || value === 'HEVC' || value === 'AV1' ? value : undefined;
}

/** Read display evidence without trusting arbitrary persisted JSON as typed data. */
export function parseRecoveryIssuePayload(value: unknown) {
  const raw = record(value);
  const failure = record(raw.qualityFailure);
  const profile = record(raw.qualityProfile);
  const override = record(raw.qualityEncodingOverride);
  const download = record(raw.downloadRecovery);
  const retry = record(raw.encodingRetry);
  const target = record(raw.target);
  const candidate = record(raw.conflictCandidate);
  const existingArchiveProof = parseExistingArchiveProof(raw);
  const headers = record(raw.responseHeaders);
  return {
    ...raw,
    historyOnly: raw.historyOnly, recoveryProjection: raw.recoveryProjection,
    conflictRelativePath: text(raw.conflictRelativePath), manualRecoveryReason: text(raw.manualRecoveryReason),
    automaticRecoveryAttempts: number(raw.automaticRecoveryAttempts), totalPages: number(raw.totalPages),
    lifecycleState: text(raw.lifecycleState), attemptKey: text(raw.attemptKey),
    downloadUserId: text(raw.downloadUserId), primaryUserId: text(raw.primaryUserId),
    qualityStrict: boolean(raw.qualityStrict), backupFiles: raw.backupFiles, finalFiles: raw.finalFiles,
    error: text(raw.error),
    bvid: text(raw.bvid), userId: text(raw.userId), mediaId: number(raw.mediaId),
    videoTitle: text(raw.videoTitle), upperName: text(raw.upperName), folderTitle: text(raw.folderTitle),
    remoteErrorCode: text(raw.remoteErrorCode), responseSnippet: text(raw.responseSnippet),
    responseHeaders: raw.responseHeaders && Object.values(headers).every(value => typeof value === 'string')
      ? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined,
    conflictCandidate: { existingArchiveProof: candidate.existingArchiveProof },
    existingArchiveProof: existingArchiveProof || undefined,
    encodingRetry: raw.encodingRetry == null ? undefined : { ...retry, state: text(retry.state) },
    downloadRecovery: {
      category: text(download.category), kind: text(download.kind), downloadUserId: text(download.downloadUserId),
      summary: text(download.summary), occurredAt: number(download.occurredAt),
    },
    qualityFailure: raw.qualityFailure == null ? undefined : {
      category: text(failure.category), encodingEligible: boolean(failure.encodingEligible),
      qualityEligible: boolean(failure.qualityEligible), requestedQuality: text(failure.requestedQuality),
      requestedEncoding: encoding(failure.requestedEncoding), actualQualities: strings(failure.actualQualities),
      actualEncodings: strings(failure.actualEncodings), qualityMismatch: boolean(failure.qualityMismatch),
      encodingMismatch: boolean(failure.encodingMismatch), verifiedPages: number(failure.verifiedPages),
    },
    qualityProfile: { ...profile, quality: text(profile.quality), encoding: encoding(profile.encoding) },
    qualityEncodingOverride: {
      ...override, strict: boolean(override.strict),
      priority: Array.isArray(override.priority) ? override.priority.map(encoding).filter((item): item is BBDownEncoding => item !== undefined) : undefined,
    },
    target: { ...target, folderTitle: text(target.folderTitle) },
  };
}
