import type { PersistentJobRecord } from '../database.js';
export type PersistentJobKind =
  | "download"
  | "access_probe"
  | "upload"
  | "verify_upload"
  | "history_upload"
  | "quality_download"
  | "quality_upload"
  | "quality_replace"
  | "quality_cleanup"
  | "path_migration"
  | "archive_delete";

export interface EnqueuePersistentJob {
  kind: PersistentJobKind;
  dedupeKey: string;
  bvid?: string;
  userId?: string;
  mediaId?: number;
  priority?: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  notBefore?: number;
  initialStatus?: PersistentJobRecord["status"];
}

export interface QualityDownloadMigrationPlan {
  jobs: PersistentJobRecord[];
  replacement: EnqueuePersistentJob;
}

/** Domain persistence contract. Connection replacement belongs to the application lifecycle. */
export interface JobRepository {
  normalizeStoppedRecovery(): number;
  enqueue(input: EnqueuePersistentJob): PersistentJobRecord;
  enqueueBatch(inputs: EnqueuePersistentJob[]): PersistentJobRecord[];
  mergeQualityDownload(input: EnqueuePersistentJob): {
    job: PersistentJobRecord;
    created: boolean;
    targetAdded: boolean;
  };
  replaceQualityDownloadJobs(jobs: PersistentJobRecord[], input: EnqueuePersistentJob): PersistentJobRecord;
  restartFailedQualityAsDownload(id: string, input: EnqueuePersistentJob): {
    ok: false;
    reason: "missing";
    job?: undefined;
  } | {
    ok: false;
    reason: "state_changed";
    job?: undefined;
  } | {
    ok: false;
    reason: "replacement_started";
    job?: undefined;
  } | {
    ok: true;
    job: PersistentJobRecord;
    reason?: undefined;
  };
  countLegacyQualityDownloadJobs(): number;
  listLegacyQualityDownloadJobs(limit?: number): PersistentJobRecord[];
  applyQualityDownloadMigration(plans: QualityDownloadMigrationPlan[], markerKey: string, blocked?: Array<{ job: PersistentJobRecord; reason: string }>): number;
  findByDedupeKey(dedupeKey: string): PersistentJobRecord | null;
  claimByDedupeKey(dedupeKey: string, leaseOwner: string, leaseMs?: number, now?: number): PersistentJobRecord | null;
  findById(id: string): PersistentJobRecord | null;
  claimDue(kinds: PersistentJobKind[], limit: number, leaseOwner: string, leaseMs?: number, now?: number): PersistentJobRecord[];
  markRunning(id: string, leaseOwner: string, leaseMs?: number): boolean;
  extendLease(id: string, leaseOwner: string, leaseMs?: number): boolean;
  complete(id: string, leaseOwner?: string): boolean;
  completeAndEnqueue(id: string, leaseOwner: string, inputs: EnqueuePersistentJob[]): PersistentJobRecord[] | null;
  retry(id: string, leaseOwner: string, error: string, notBefore: number): {
    updated: boolean;
    exhausted: boolean;
    attempts?: undefined;
  } | {
    updated: boolean;
    exhausted: boolean;
    attempts: number;
  };
  retryDownloadWithManualFallback(id: string, leaseOwner: string, error: string, notBefore: number, payloadPatch: Record<string, unknown>): {
    updated: boolean;
    exhausted: boolean;
    attempts: number;
  };
  normalizeTerminalUploadRecovery(): number;
  retryIndefinitely(id: string, leaseOwner: string, error: string, notBefore: number): {
    updated: boolean;
    attempts: number;
  };
  defer(id: string, leaseOwner: string, error: string, notBefore: number): boolean;
  consumeUploadReuploadPermission(id: string, leaseOwner: string, relativePath: string): boolean;
  parkManualRecovery(id: string, leaseOwner: string, error: string, payloadPatch?: Record<string, unknown>): boolean;
  recoverExpiredLeases(now?: number): number;
  releaseOwner(leaseOwner: string): number;
  updatePayload(id: string, payload: Record<string, unknown>): boolean;
  startEncodingRetry(parentId: string, child: EnqueuePersistentJob, retryState: Record<string, unknown>): {
    parent: PersistentJobRecord;
    child: PersistentJobRecord;
    idempotent: boolean;
  } | null;
  finishEncodingRetry(parentId: string, generation: number, payloadPatch?: Record<string, unknown>): boolean;
  updateEncodingRetry(parentId: string, generation: number, patch: Record<string, unknown>): boolean;
  transitionEncodingRetryChildren(parentId: string, generation: number, currentChildId: string, leaseOwner: string, nextState: "uploading" | "verifying", inputs: EnqueuePersistentJob[]): PersistentJobRecord[] | null;
  countEncodingRetryJobs(parentId: string, generation: number): number;
  cancelEncodingRetryChildren(parentId: string, generation: number): number;
  completeEncodingRetryParent(parentId: string, generation: number): boolean;
  completeEncodingRetryCommit(parentId: string, generation: number, childId?: string, leaseOwner?: string): boolean;
  wakeManualJob(id: string, payloadPatch?: Record<string, unknown>, notBefore?: number): PersistentJobRecord | null;
  abandonRecovery(id: string, reason?: string, payloadPatch?: Record<string, unknown>): boolean;
  counts(): Record<string, Record<string, number>>;
  listForBoard(kinds: PersistentJobKind[], limit?: number, statuses?: PersistentJobRecord["status"][]): PersistentJobRecord[];
  list(kinds: PersistentJobKind[], limit?: number): PersistentJobRecord[];
  listLegacyDownloadRecovery(limit?: number): PersistentJobRecord[];
  findLegacyDownloadRecovery(issueKey: string): PersistentJobRecord | null;
  listBvids(kinds: PersistentJobKind[], limit?: number): string[];
  listActiveTransferSessionKeys(kinds?: PersistentJobKind[]): Set<string>;
  listManualRecovery(kinds: PersistentJobKind[], limit?: number): PersistentJobRecord[];
  listDueManualRecovery(kinds: PersistentJobKind[], now?: number, limit?: number): PersistentJobRecord[];
  listFailed(kinds: PersistentJobKind[], limit?: number): PersistentJobRecord[];
  listObsoleteArchiveRecoveryCandidates(limit?: number, scope?: {
    bvid?: string;
    userId?: string;
    mediaId?: number;
  }): PersistentJobRecord[];
  removeObsoleteArchiveRecoveryCandidate(id: string): boolean;
  countOutstanding(kinds: PersistentJobKind[]): number;
  countDue(kinds: PersistentJobKind[], maxPriority?: number, now?: number): number;
  nextDueAt(): number | undefined;
  scheduleSummary(kind: PersistentJobKind): {
    count: number;
    nextAt: number | undefined;
  };
  accessProbeScheduleSummary(intent: "charging" | "availability" | "legacy_classification"): {
    count: number;
    nextAt: number | undefined;
  };
  hasJobsForBvid(bvid: string, kinds?: PersistentJobKind[]): boolean;
  hasActiveJobsForBvid(bvid: string, kinds?: PersistentJobKind[]): boolean;
  countJobsForBvid(bvid: string, kinds: PersistentJobKind[]): number;
  countQualityJobsForArtifact(artifactKey: string): number;
  hasQualityTarget(userId: string, mediaId: number, bvid: string): boolean;
  listQualityTargetKeys(): Set<string>;
  hasDedupePrefix(prefix: string): boolean;
  wakeByBvid(bvid: string, kinds: PersistentJobKind[], now?: number): number;
  rescheduleByBvid(bvid: string, kinds: PersistentJobKind[], notBefore: number, now?: number): number;
  wakeAll(kinds: PersistentJobKind[], now?: number): number;
  listUserDependentJobs(userId: string): PersistentJobRecord[];
  reassignDownloadJob(id: string, downloadUserId: string, payload: Record<string, unknown>): boolean;
  pauseDetachedUserJob(id: string, userId: string, payload: Record<string, unknown>): boolean;
  resumeDetachedUserJobs(userId: string, now?: number): number;
  cancelUserDependentJobs(userId: string): number;
}
