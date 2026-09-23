import {
  decodeAttemptsRow,
  decodeBvidProjectionRows,
  decodeCountAndNextAtRow,
  decodeCountRow,
  decodeJobRow,
  decodeJobRows,
  decodeIdRow,
  decodeJobCountRows,
  decodeJobRetryRow,
  decodeNextAtRow,
  decodePayloadRow,
  decodeQualityTargetProjectionRows,
  decodeSessionIdentityRows,
  decodeStatusPayloadRow,
  readPersistedJobPayload,
} from './repositories/job-codec.js';
export { readPersistedJobPayload } from './repositories/job-codec.js';
import { isRecord } from './shared/api/value.js';
import type { JobRepository, PersistentJobKind, EnqueuePersistentJob, QualityDownloadMigrationPlan } from './repositories/jobs.js';
export type { PersistentJobKind, EnqueuePersistentJob, QualityDownloadMigrationPlan } from './repositories/jobs.js';
import crypto from "node:crypto";
import type { StateDatabase, PersistentJobRecord } from "./database.js";

export function isRecoveryStopped(payload: unknown): boolean {
  return isRecord(payload) && (payload.userDisposition === "abandoned" || payload.lifecycleState === "abandoned");
}
function retryRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('Invalid persisted encoding retry');
  return value;
}

const RECOVERY_NOT_STOPPED_SQL = `
  COALESCE(json_extract(payload_json, '$.userDisposition'), '')<>'abandoned'
  AND COALESCE(json_extract(payload_json, '$.lifecycleState'), '')<>'abandoned'`;
const RECOVERABLE_STATUS_SQL = `(
  status IN ('pending','retry_wait','leased','running','manual_wait')
  OR (status='failed' AND json_extract(payload_json, '$.awaitingManualRecovery')=1)
)`;
const BOARD_NOT_REPLACED_BY_RETRY_SQL = `NOT (
  COALESCE(json_extract(payload_json, '$.awaitingManualRecovery'), 0)=0
  AND COALESCE(json_extract(payload_json, '$.encodingRetry.state'), '') IN ('running','uploading','verifying')
  AND COALESCE(json_extract(payload_json, '$.encodingRetry.parentJobId'), '')=id
)`;

export const PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES = [
  "pending",
  "retry_wait",
  "leased",
  "running",
  "manual_wait",
] as const;

function qualityTargetKey(target: unknown) {
  if (!isRecord(target)) return "";
  const userId = String(target?.userId || "");
  const mediaId = Number(target?.mediaId);
  return userId && Number.isInteger(mediaId) ? `${userId}:${mediaId}` : "";
}

export function qualityTargetIdentityKey(userId: unknown, mediaId: unknown, bvid: unknown) {
  const normalizedUserId = String(userId || "");
  const normalizedMediaId = Number(mediaId);
  const normalizedBvid = String(bvid || "");
  return normalizedUserId && normalizedBvid && Number.isInteger(normalizedMediaId)
    ? `${normalizedUserId}:${normalizedMediaId}:${normalizedBvid}`
    : "";
}

function qualityTargetsFromPayload(payload: Record<string, unknown>) {
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const candidates = payload.target ? [payload.target, ...targets] : targets;
  const unique = new Map<string, Record<string, unknown>>();
  for (const target of candidates) {
    const key = qualityTargetKey(target);
    if (key && isRecord(target)) unique.set(key, target);
  }
  return [...unique.values()];
}


export class PersistentJobStore implements JobRepository {
  private readonly now: () => number;
  constructor(private stateDatabase: StateDatabase, options: {normalizeRecovery?: boolean; now?: () => number} = {}) {
    this.now = options.now ?? Date.now;
    if (options.normalizeRecovery !== false) this.normalizeStoppedRecovery();
  }

  rebind(stateDatabase: StateDatabase, options: {normalizeRecovery?: boolean} = {}) {
    this.stateDatabase = stateDatabase;
    if (options.normalizeRecovery !== false) this.normalizeStoppedRecovery();
  }

  normalizeStoppedRecovery() {
    return this.stateDatabase.db.transaction(() => this.stateDatabase.db.prepare(`
      UPDATE jobs SET status=CASE WHEN status='completed' THEN status ELSE 'failed' END,
        not_before=0, lease_owner=NULL, lease_expires_at=NULL,
        payload_json=json_set(json_remove(payload_json, '$.recoveryAssessment.nextCheckAt'),
          '$.awaitingManualRecovery', json('false'), '$.resumeOnly', json('false'),
          '$.allowReupload', json('false')), updated_at=?
      WHERE id IN (SELECT id FROM jobs WHERE NOT (${RECOVERY_NOT_STOPPED_SQL})
        AND (status NOT IN ('failed','completed') OR not_before<>0 OR lease_owner IS NOT NULL
          OR lease_expires_at IS NOT NULL
          OR json_extract(payload_json, '$.awaitingManualRecovery')=1
          OR json_extract(payload_json, '$.resumeOnly')=1
          OR json_extract(payload_json, '$.allowReupload')=1
          OR json_type(payload_json, '$.recoveryAssessment.nextCheckAt') IS NOT NULL)
        ORDER BY updated_at, id LIMIT 1000)
    `).run(this.now()).changes)();
  }

  enqueue(input: EnqueuePersistentJob) {
    const now = this.now();
    const id = crypto.randomUUID();
    const initialStatus = input.initialStatus || "pending";
    if (!["pending", "retry_wait", "manual_wait"].includes(initialStatus)) {
      throw new Error(`Unsupported initial persistent job status: ${initialStatus}`);
    }
    this.stateDatabase.db.prepare(`
      INSERT INTO jobs(
        id, kind, dedupe_key, bvid, user_id, media_id, status, priority, payload_json,
        attempts, max_attempts, not_before, created_at, updated_at
      ) VALUES(@id,@kind,@dedupeKey,@bvid,@userId,@mediaId,@status,@priority,@payload,0,@maxAttempts,@notBefore,@now,@now)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        status=CASE
          WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN excluded.status
          WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.status
          WHEN jobs.status='failed' THEN excluded.status
          ELSE jobs.status
        END,
        priority=MIN(jobs.priority, excluded.priority),
        not_before=CASE
          WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN excluded.not_before
          WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.not_before
          WHEN jobs.status='failed' THEN excluded.not_before
          ELSE MIN(jobs.not_before, excluded.not_before)
        END,
        -- Keep a manual-recovery payload authoritative until the administrator
        -- explicitly wakes it; a normal sync enqueue must not hide the action.
        payload_json=CASE
          WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN excluded.payload_json
          WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.payload_json
          WHEN jobs.status IN ('pending','retry_wait','failed') THEN excluded.payload_json
          ELSE jobs.payload_json
        END,
        attempts=CASE
          WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN 0
          WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.attempts
          WHEN jobs.status='failed' THEN 0
          ELSE jobs.attempts
        END,
        lease_owner=CASE WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN NULL WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.lease_owner WHEN jobs.status='failed' THEN NULL ELSE jobs.lease_owner END,
        lease_expires_at=CASE WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN NULL WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.lease_expires_at WHEN jobs.status='failed' THEN NULL ELSE jobs.lease_expires_at END,
        last_error=CASE WHEN jobs.dedupe_key LIKE 'upload-session:%' AND jobs.status IN ('completed','failed') THEN NULL WHEN jobs.status='failed' AND json_extract(jobs.payload_json, '$.awaitingManualRecovery')=1 THEN jobs.last_error WHEN jobs.status='failed' THEN NULL ELSE jobs.last_error END,
        max_attempts=MAX(jobs.max_attempts, excluded.max_attempts),
        updated_at=excluded.updated_at
    `).run({
      id,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      bvid: input.bvid || null,
      userId: input.userId || null,
      mediaId: input.mediaId ?? null,
      status: initialStatus,
      priority: Math.floor(input.priority ?? 100),
      payload: JSON.stringify(input.payload || {}),
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 3)),
      notBefore: Math.max(0, Math.floor(input.notBefore ?? 0)),
      now,
    });
    return this.findByDedupeKey(input.dedupeKey)!;
  }

  enqueueBatch(inputs: EnqueuePersistentJob[]) {
    if (inputs.length === 0) return [];
    return this.stateDatabase.db.transaction(() => inputs.map((input) => this.enqueue(input)))();
  }

  mergeQualityDownload(input: EnqueuePersistentJob) {
    if (input.kind !== "quality_download") throw new Error("mergeQualityDownload requires a quality_download job");
    const transaction = this.stateDatabase.db.transaction(() => {
      const existing = decodeJobRow(this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(input.dedupeKey), "jobs by dedupe_key");
      if (!existing) {
        return { job: this.enqueue(input), created: true, targetAdded: true };
      }
      const existingPayload = existing.payload;
      const incomingPayload = input.payload || {};
      const existingTargets = qualityTargetsFromPayload(existingPayload);
      const incomingTargets = qualityTargetsFromPayload(incomingPayload);
      const targets = new Map(existingTargets.map((target) => [qualityTargetKey(target), target]));
      let targetAdded = false;
      for (const target of incomingTargets) {
        const key = qualityTargetKey(target);
        if (!targets.has(key)) targetAdded = true;
        targets.set(key, target);
      }
      const mergedTargets = [...targets.values()];
      const mergedPayload = {
        ...incomingPayload,
        ...existingPayload,
        artifactKey: existingPayload.artifactKey || incomingPayload.artifactKey,
        qualityProfile: existingPayload.qualityProfile || incomingPayload.qualityProfile,
        target: existingPayload.target || incomingPayload.target || mergedTargets[0],
        targets: mergedTargets,
      };
      const now = this.now();
      this.stateDatabase.db.prepare(`
        UPDATE jobs SET
          status=CASE WHEN status='failed' THEN 'pending' ELSE status END,
          priority=MIN(priority, ?),
          payload_json=?,
          attempts=CASE WHEN status='failed' THEN 0 ELSE attempts END,
          not_before=CASE WHEN status='failed' THEN ? ELSE not_before END,
          lease_owner=CASE WHEN status='failed' THEN NULL ELSE lease_owner END,
          lease_expires_at=CASE WHEN status='failed' THEN NULL ELSE lease_expires_at END,
          last_error=CASE WHEN status='failed' THEN NULL ELSE last_error END,
          max_attempts=MAX(max_attempts, ?),
          updated_at=?
        WHERE id=?
      `).run(
        Math.floor(input.priority ?? 100),
        JSON.stringify(mergedPayload),
        Math.max(0, Math.floor(input.notBefore ?? now)),
        Math.max(1, Math.floor(input.maxAttempts ?? 3)),
        now,
        existing.id
      );
      return { job: this.findById(existing.id)!, created: false, targetAdded };
    });
    return transaction();
  }

  private replaceQualityDownloadJobsUnsafe(jobs: PersistentJobRecord[], input: EnqueuePersistentJob) {
    if (input.kind !== "quality_download" || jobs.length === 0) {
      throw new Error("replaceQualityDownloadJobs requires existing quality_download jobs");
    }
    const ids = [...new Set(jobs.map((job) => job.id))];
    const placeholders = ids.map(() => "?").join(",");
    this.stateDatabase.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids);
    const replacement = this.enqueue(input);
    const attempts = Math.max(...jobs.map((job) => job.attempts), 0);
    const notBefore = Math.max(...jobs.map((job) => job.notBefore), input.notBefore ?? 0);
    const maxAttempts = Math.max(...jobs.map((job) => job.maxAttempts), input.maxAttempts ?? 1);
    const createdAt = Math.min(...jobs.map((job) => job.createdAt));
    const lastError = [...jobs].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.lastError || null;
    const status = notBefore > this.now() || jobs.some((job) => job.status === "retry_wait") ? "retry_wait" : "pending";
    this.stateDatabase.db.prepare(`
      UPDATE jobs SET status=?, attempts=?, max_attempts=?, not_before=?, lease_owner=NULL,
        lease_expires_at=NULL, last_error=?, created_at=?, updated_at=? WHERE id=?
    `).run(status, attempts, maxAttempts, notBefore, lastError, createdAt, this.now(), replacement.id);
    return this.findById(replacement.id)!;
  }

  replaceQualityDownloadJobs(jobs: PersistentJobRecord[], input: EnqueuePersistentJob) {
    return this.stateDatabase.db.transaction(() => this.replaceQualityDownloadJobsUnsafe(jobs, input))();
  }

  restartFailedQualityAsDownload(id: string, input: EnqueuePersistentJob) {
    if (input.kind !== "quality_download") throw new Error("restartFailedQualityAsDownload requires a quality_download replacement");
    return this.stateDatabase.db.transaction(() => {
      const current = decodeJobRow(this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE id=?").get(id), "job by id");
      if (!current) return { ok: false as const, reason: "missing" as const };
      if (!["quality_download", "quality_upload"].includes(current.kind)
        || !["failed", "manual_wait"].includes(current.status)) {
        return { ok: false as const, reason: "state_changed" as const };
      }
      const payload = current.payload;
      if ((Array.isArray(payload.backupFiles) && payload.backupFiles.length > 0)
        || (Array.isArray(payload.finalFiles) && payload.finalFiles.length > 0)) {
        return { ok: false as const, reason: "replacement_started" as const };
      }
      const removed = this.stateDatabase.db.prepare(
        "DELETE FROM jobs WHERE id=? AND kind IN ('quality_download','quality_upload') AND status IN ('failed','manual_wait')"
      ).run(id).changes === 1;
      if (!removed) return { ok: false as const, reason: "state_changed" as const };
      return { ok: true as const, job: this.enqueue(input) };
    })();
  }

  countLegacyQualityDownloadJobs() {
    const row = this.stateDatabase.db.prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind='quality_download' AND status<>'completed' AND (
        json_type(payload_json, '$.artifactKey') IS NULL
        OR COALESCE(json_type(payload_json, '$.targets'), '') != 'array'
        OR bvid IS NULL
        OR dedupe_key NOT LIKE ('quality-download:' || bvid || ':%')
      )
    `).get();
    return decodeCountRow(row, "legacy quality job count").count;
  }

  listLegacyQualityDownloadJobs(limit = 100_001) {
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE kind='quality_download' AND status<>'completed' AND (
        json_type(payload_json, '$.artifactKey') IS NULL
        OR COALESCE(json_type(payload_json, '$.targets'), '') != 'array'
        OR bvid IS NULL
        OR dedupe_key NOT LIKE ('quality-download:' || bvid || ':%')
      )
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(Math.max(1, Math.floor(limit))), "legacy quality jobs");
  }

  applyQualityDownloadMigration(plans: QualityDownloadMigrationPlan[], markerKey: string, blocked: Array<{ job: PersistentJobRecord; reason: string }> = []) {
    return this.stateDatabase.db.transaction(() => {
      const migrated = plans.reduce((total, plan) => {
        this.replaceQualityDownloadJobsUnsafe(plan.jobs, plan.replacement);
        return total + plan.jobs.length;
      }, 0);
      for (const { job, reason } of blocked) {
        const result = this.stateDatabase.db.prepare(`
          UPDATE jobs SET status='manual_wait', last_error=?, updated_at=?,
            payload_json=json_set(payload_json, '$.awaitingManualRecovery', json('true'))
          WHERE id=? AND updated_at=? AND status IN ('pending','retry_wait','manual_wait','failed')
        `).run(reason, this.now(), job.id, job.updatedAt);
        if (result.changes !== 1) throw new Error(`Quality migration job ownership changed: ${job.id}`);
      }
      if (blocked.length === 0) this.stateDatabase.setMeta(markerKey, "complete");
      return migrated;
    })();
  }

  findByDedupeKey(dedupeKey: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(dedupeKey);
    return decodeJobRow(row, "job by dedupe key") || null;
  }

  claimByDedupeKey(dedupeKey: string, leaseOwner: string, leaseMs = 30 * 60_000, now = this.now()) {
    const transaction = this.stateDatabase.db.transaction(() => {
      this.recoverExpiredLeases(now);
      const row = this.stateDatabase.db.prepare(`
        SELECT * FROM jobs
        WHERE dedupe_key=? AND status IN ('pending','retry_wait') AND not_before<=?
          AND ${RECOVERY_NOT_STOPPED_SQL}
        LIMIT 1
      `).get(dedupeKey, now);
      const decoded = decodeJobRow(row, "job lease by dedupe key");
      if (!decoded) return null;
      const leaseExpiresAt = now + Math.max(10_000, leaseMs);
      const updated = this.stateDatabase.db.prepare(`
        UPDATE jobs SET status='running', lease_owner=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND status IN ('pending','retry_wait')
        `).run(leaseOwner, leaseExpiresAt, now, decoded.id);
      if (updated.changes !== 1) return null;
      return {
        ...decoded,
        status: "running",
        leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      } satisfies PersistentJobRecord;
    });
    return transaction();
  }

  findById(id: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return decodeJobRow(row, "job by id") || null;
  }

  claimDue(kinds: PersistentJobKind[], limit: number, leaseOwner: string, leaseMs = 5 * 60_000, now = this.now()) {
    if (kinds.length === 0 || limit <= 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const transaction = this.stateDatabase.db.transaction(() => {
      this.recoverExpiredLeases(now);
      const rows = this.stateDatabase.db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('pending','retry_wait') AND not_before <= ? AND kind IN (${placeholders})
          AND ${RECOVERY_NOT_STOPPED_SQL}
        ORDER BY priority ASC, not_before ASC, created_at ASC
        LIMIT ?
      `).all(now, ...kinds, Math.max(0, Math.floor(limit)));
      const decodedRows = decodeJobRows(rows, "due jobs");
      const leaseExpiresAt = now + Math.max(10_000, leaseMs);
      const update = this.stateDatabase.db.prepare(`
        UPDATE jobs SET status='leased', lease_owner=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND status IN ('pending','retry_wait')
      `);
      const claimed: PersistentJobRecord[] = [];
      for (const row of decodedRows) {
        if (update.run(leaseOwner, leaseExpiresAt, now, row.id).changes === 1) {
          claimed.push({ ...row, status: "leased", leaseOwner, leaseExpiresAt, updatedAt: now });
        }
      }
      return claimed;
    });
    return transaction();
  }

  markRunning(id: string, leaseOwner: string, leaseMs = 30 * 60_000) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='running', lease_expires_at=?, updated_at=?
      WHERE id=? AND lease_owner=? AND status='leased'
    `).run(now + leaseMs, now, id, leaseOwner).changes === 1;
  }

  extendLease(id: string, leaseOwner: string, leaseMs = 30 * 60_000) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET lease_expires_at=?, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('leased','running')
    `).run(now + leaseMs, now, id, leaseOwner).changes === 1;
  }

  private completeUnsafe(id: string, leaseOwner?: string) {
    const ownerClause = leaseOwner ? " AND lease_owner=?" : "";
    const args = leaseOwner ? [id, leaseOwner] : [id];
    const retained = this.stateDatabase.db.prepare(`UPDATE jobs SET status='completed', dedupe_key='cleanup-complete:' || id,
      lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE id=?${ownerClause} AND json_array_length(payload_json, '$.localCleanupPlans')>0`)
      .run(this.now(), ...args).changes;
    if (retained) return true;
    return this.stateDatabase.db.prepare(`DELETE FROM jobs WHERE id=?${ownerClause}`).run(...args).changes === 1;
  }

  complete(id: string, leaseOwner?: string) {
    return this.stateDatabase.db.transaction(() => this.completeUnsafe(id, leaseOwner))();
  }

  completeAndEnqueue(id: string, leaseOwner: string, inputs: EnqueuePersistentJob[]) {
    return this.stateDatabase.db.transaction(() => {
      const current = this.stateDatabase.db.prepare(`
        SELECT id FROM jobs WHERE id=? AND lease_owner=? AND status IN ('leased','running')
      `).get(id, leaseOwner);
      if (!current) return null;
      const next = inputs.map((input) => this.enqueue(input));
      if (!this.completeUnsafe(id, leaseOwner)) {
        throw new Error("Persistent job transition changed before commit");
      }
      return next;
    })();
  }
  retry(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = this.now();
    const value = this.stateDatabase.db.prepare("SELECT kind, attempts, max_attempts FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner);
    if (value === undefined) return { updated: false, exhausted: false };
    const row = decodeJobRetryRow(value, "job retry");
    const attempts = row.attempts + 1;
    const exhausted = attempts >= row.max_attempts;
    const kind = row.kind;
    if (exhausted) {
      if (["upload", "history_upload", "quality_download", "quality_upload", "quality_replace", "quality_cleanup"].includes(kind)) {
        let payloadPatch = "";
        if (["upload", "history_upload"].includes(kind)) {
          const payloadValue = this.stateDatabase.db.prepare("SELECT payload_json FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner);
          if (payloadValue === undefined) throw new Error("Persistent job disappeared during retry transaction");
          const payloadRow = decodePayloadRow(payloadValue, "upload retry payload");
          const payload = readPersistedJobPayload(payloadRow.payload_json, "upload retry payload");
          payloadPatch = JSON.stringify({ ...payload, awaitingManualRecovery: true, resumeOnly: true, allowReupload: false });
        }
        this.stateDatabase.db.prepare(`
          UPDATE jobs SET status='failed', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
            last_error=?, payload_json=CASE WHEN ?<>'' THEN ? ELSE payload_json END, updated_at=?
          WHERE id=? AND lease_owner=?
        `).run(
          attempts,
          Math.max(now, Math.floor(notBefore)),
          error.slice(0, 1000),
          payloadPatch,
          payloadPatch,
          now,
          id,
          leaseOwner,
        );
      } else {
        this.stateDatabase.db.prepare("DELETE FROM jobs WHERE id=? AND lease_owner=?").run(id, leaseOwner);
      }
      return { updated: true, exhausted: true, attempts };
    }
    this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='retry_wait', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, updated_at=? WHERE id=? AND lease_owner=?
    `).run(attempts, Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner);
    return { updated: true, exhausted: false, attempts };
  }

  retryDownloadWithManualFallback(
    id: string,
    leaseOwner: string,
    error: string,
    notBefore: number,
    payloadPatch: Record<string, unknown>,
  ) {
    return this.stateDatabase.db.transaction(() => {
      const rowResult = this.stateDatabase.db.prepare(
        "SELECT kind, attempts, max_attempts, payload_json FROM jobs WHERE id=? AND lease_owner=? AND status IN ('leased','running')"
      );
      const value = rowResult.get(id, leaseOwner);
      if (value === undefined) return { updated: false, exhausted: false, attempts: 0 };
      const row = decodeJobRetryRow(value, "download retry job", true);
      if (row.kind !== "download") return { updated: false, exhausted: false, attempts: 0 };
      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.max_attempts;
      const now = this.now();
      const payload = readPersistedJobPayload(row.payload_json, "download retry job");
      if (exhausted) {
        const mergedPayload = {
          ...payload,
          ...payloadPatch,
          awaitingManualRecovery: true,
        };
        const updated = this.stateDatabase.db.prepare(`
          UPDATE jobs SET status='manual_wait', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
            last_error=?, payload_json=?, updated_at=?
          WHERE id=? AND lease_owner=? AND status IN ('leased','running')
        `).run(
          attempts,
          Math.max(now, Math.floor(notBefore)),
          error.slice(0, 1000),
          JSON.stringify(mergedPayload),
          now,
          id,
          leaseOwner,
        ).changes === 1;
        return { updated, exhausted: true, attempts };
      }
      const updated = this.stateDatabase.db.prepare(`
        UPDATE jobs SET status='retry_wait', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
          last_error=?, updated_at=? WHERE id=? AND lease_owner=? AND status IN ('leased','running')
      `).run(
        attempts,
        Math.max(now, Math.floor(notBefore)),
        error.slice(0, 1000),
        now,
        id,
        leaseOwner,
      ).changes === 1;
      return { updated, exhausted: false, attempts };
    })();
  }

  normalizeTerminalUploadRecovery() {
    const now = this.now();
    return this.stateDatabase.db.transaction(() => {
      // Validate the original evidence before any normalization can alter it.
      const rows = this.stateDatabase.db.prepare<[], { payload_json: unknown }>(
        "SELECT payload_json FROM jobs WHERE kind IN ('upload','history_upload') AND status='failed'",
      ).all();
      for (const row of rows) readPersistedJobPayload(row.payload_json);
      const result = this.stateDatabase.db.prepare(`
        UPDATE jobs
        SET payload_json=json_set(
              payload_json,
              '$.awaitingManualRecovery', json('true'),
              '$.resumeOnly', json('true'),
              '$.allowReupload', json('false')
            ),
            updated_at=?
        WHERE kind IN ('upload','history_upload')
          AND status='failed'
          AND COALESCE(json_extract(payload_json, '$.userDisposition'), '')<>'abandoned'
          AND COALESCE(json_extract(payload_json, '$.lifecycleState'), '')<>'abandoned'
          AND COALESCE(json_extract(payload_json, '$.awaitingManualRecovery'), 0)<>1
      `).run(now);
      return result.changes;
    })();
  }

  retryIndefinitely(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = this.now();
    const value = this.stateDatabase.db.prepare("SELECT attempts FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner);
    if (value === undefined) return { updated: false, attempts: 0 };
    const attempts = decodeAttemptsRow(value, 'indefinite retry').attempts + 1;
    const updated = this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='retry_wait', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, updated_at=? WHERE id=? AND lease_owner=?
    `).run(attempts, Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner).changes === 1;
    return { updated, attempts };
  }

  defer(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='retry_wait', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, updated_at=? WHERE id=? AND lease_owner=?
    `).run(Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner).changes === 1;
  }

  consumeUploadReuploadPermission(id: string, leaseOwner: string, relativePath: string) {
    return this.stateDatabase.db.transaction(() => {
      const rowResult = this.stateDatabase.db.prepare(
        "SELECT payload_json FROM jobs WHERE id=? AND lease_owner=? AND status IN ('leased','running')"
      );
      const value = rowResult.get(id, leaseOwner);
      if (value === undefined) return false;
      const row = decodePayloadRow(value, "reupload permission job");
      const payload = readPersistedJobPayload(row.payload_json, "reupload permission job");
      const normalizedPath = String(relativePath || "").replace(/\\/g, "/");
      const persistedFiles = Array.isArray(payload.reuploadAuthorizedFiles)
        ? payload.reuploadAuthorizedFiles
        : (payload.allowReupload === true && Array.isArray(payload.files) ? payload.files : []);
      const authorizedFiles = [...new Set(persistedFiles.map((value) => String(value || "").replace(/\\/g, "/")).filter(Boolean))];
      const index = authorizedFiles.indexOf(normalizedPath);
      if (index < 0) return false;
      authorizedFiles.splice(index, 1);
      payload.reuploadAuthorizedFiles = authorizedFiles;
      // Keep the legacy boolean false once the per-file authorization has
      // been materialized so an old worker cannot consume the whole batch.
      payload.allowReupload = false;
      return this.stateDatabase.db.prepare(
        "UPDATE jobs SET payload_json=?, updated_at=? WHERE id=? AND lease_owner=? AND status IN ('leased','running')"
      ).run(JSON.stringify(payload), this.now(), id, leaseOwner).changes === 1;
    })();
  }

  parkManualRecovery(id: string, leaseOwner: string, error: string, payloadPatch: Record<string, unknown> = {}) {
    const value = this.stateDatabase.db.prepare("SELECT payload_json FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner);
    if (value === undefined) return false;
    const row = decodePayloadRow(value, "manual recovery payload");
    const payload = readPersistedJobPayload(row.payload_json, "manual recovery payload");
    const mergedPayload = { ...payload, ...payloadPatch };
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='manual_wait', lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, payload_json=?, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('leased','running')
    `).run(error.slice(0, 1000), JSON.stringify(mergedPayload), now, id, leaseOwner).changes === 1;
  }

  recoverExpiredLeases(now = this.now()) {
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(now, now).changes;
  }

  releaseOwner(leaseOwner: string) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE lease_owner=? AND status IN ('leased','running')
    `).run(now, leaseOwner).changes;
  }

  updatePayload(id: string, payload: Record<string, unknown>) {
    const preservesStop = isRecoveryStopped(payload) && payload.awaitingManualRecovery !== true
      && payload.allowReupload !== true && payload.resumeOnly !== true;
    return this.stateDatabase.db.prepare(`UPDATE jobs SET payload_json=?, updated_at=? WHERE id=?
      AND (? OR (${RECOVERY_NOT_STOPPED_SQL}))`)
      .run(JSON.stringify(payload || {}), this.now(), id, Number(preservesStop)).changes === 1;
  }

  startEncodingRetry(
    parentId: string,
    child: EnqueuePersistentJob,
    retryState: Record<string, unknown>,
  ) {
    return this.stateDatabase.db.transaction(() => {
      const parent = decodeJobRow(this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE id=?").get(parentId), "encoding retry parent");
      if (!parent) return null;
      if (!['manual_wait', 'failed', 'retry_wait', 'pending'].includes(String(parent.status))) {
        return null;
      }
      if (isRecoveryStopped(parent.payload)) return null;
      const currentRetry = retryRecord(parent.payload.encodingRetry);
      if (currentRetry && ['running', 'uploading', 'verifying'].includes(String(currentRetry.state || '')) && currentRetry.replacementJobId) {
        const existing = this.findById(String(currentRetry.replacementJobId));
        if (existing) return { parent, child: existing, idempotent: true };
        return null;
      }
      if (parent.payload.awaitingManualRecovery !== true) {
        return null;
      }

      const created = this.enqueue(child);
      const payload = {
        ...parent.payload,
        awaitingManualRecovery: false,
        lifecycleState: 'retrying',
        userDisposition: 'automatic_retry',
        encodingRetry: {
          ...retryState,
          replacementJobId: created.id,
          state: 'running',
        },
      };
      const updated = this.stateDatabase.db.prepare(`
        UPDATE jobs SET payload_json=?, updated_at=?
        WHERE id=? AND status IN ('manual_wait','failed','retry_wait','pending')
          AND json_extract(payload_json, '$.awaitingManualRecovery')=1
      `).run(JSON.stringify(payload), this.now(), parentId);
      if (updated.changes !== 1) {
        this.complete(created.id);
        return null;
      }
      return { parent: this.findById(parentId)!, child: created, idempotent: false };
    })();
  }

  finishEncodingRetry(
    parentId: string,
    generation: number,
    payloadPatch: Record<string, unknown> = {},
  ) {
    return this.stateDatabase.db.transaction(() => {
      const parent = decodeJobRow(this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE id=?").get(parentId), "encoding retry parent");
      if (!parent) return false;
      const payload = parent.payload;
      if (isRecoveryStopped(payload)) return false;
      const retry = retryRecord(payload.encodingRetry);
      if (!retry
        || Number(retry.generation) !== Number(generation)
        || !['running', 'uploading', 'verifying'].includes(String(retry.state || ''))) return false;
      const { replacementJobId: _replacementJobId, ...retryWithoutLease } = retry;
      const nextPayload = {
        ...payload,
        ...payloadPatch,
        awaitingManualRecovery: true,
        resumeOnly: true,
        allowReupload: false,
        lifecycleState: 'manual_required',
        encodingRetry: {
          ...retryWithoutLease,
          state: 'failed',
        },
      };
      return this.stateDatabase.db.prepare("UPDATE jobs SET payload_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(nextPayload), this.now(), parentId).changes === 1;
    })();
  }

  updateEncodingRetry(parentId: string, generation: number, patch: Record<string, unknown>) {
    return this.stateDatabase.db.transaction(() => {
      const value = this.stateDatabase.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(parentId);
      if (value === undefined) return false;
      const row = decodePayloadRow(value, "encoding retry update payload");
      const payload = readPersistedJobPayload(row.payload_json, "encoding retry update payload");
      if (isRecoveryStopped(payload)) return false;
      const retry = retryRecord(payload.encodingRetry);
      if (!retry
        || Number(retry.generation) !== Number(generation)
        || !['running', 'uploading', 'verifying'].includes(String(retry.state || ''))) return false;
      const nextPayload = {
        ...payload,
        encodingRetry: {
          ...retry,
          ...patch,
        },
      };
      return this.stateDatabase.db.prepare("UPDATE jobs SET payload_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(nextPayload), this.now(), parentId).changes === 1;
    })();
  }

  transitionEncodingRetryChildren(
    parentId: string,
    generation: number,
    currentChildId: string,
    leaseOwner: string,
    nextState: "uploading" | "verifying",
    inputs: EnqueuePersistentJob[],
  ) {
    return this.stateDatabase.db.transaction(() => {
      const parentValue = this.stateDatabase.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(parentId);
      if (parentValue === undefined || inputs.length === 0) return null;
      const parentRow = decodePayloadRow(parentValue, "encoding retry transition payload");
      const payload = readPersistedJobPayload(parentRow.payload_json, "encoding retry transition payload");
      if (isRecoveryStopped(payload)) return null;
      const retry = retryRecord(payload.encodingRetry);
      if (!retry
        || Number(retry.generation) !== Number(generation)
        || !['running', 'uploading', 'verifying'].includes(String(retry.state || ''))) return null;
      const current = this.stateDatabase.db.prepare(`
        SELECT id FROM jobs WHERE id=? AND lease_owner=? AND status IN ('leased','running')
      `).get(currentChildId, leaseOwner);
      if (!current) return null;
      const next = inputs.map((input) => this.enqueue(input));
      if (!this.completeUnsafe(currentChildId, leaseOwner)) {
        throw new Error("Encoding retry child changed before transition commit");
      }
      const activeChildren = this.stateDatabase.db.prepare<unknown[], unknown>(`
        SELECT id FROM jobs
        WHERE kind IN ('download','upload','history_upload','verify_upload')
          AND id<>?
          AND status<>'completed'
          AND COALESCE(json_extract(payload_json, '$.awaitingManualRecovery'), 0) <> 1
          AND json_extract(payload_json, '$.encodingRetry.parentJobId')=?
          AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
        ORDER BY created_at ASC, id ASC
      `).all(parentId, parentId, generation);
      const replacementJobIds = activeChildren.map((row, index) => decodeIdRow(row, `encoding retry children[${index}]`).id);
      if (replacementJobIds.length === 0) {
        throw new Error("Encoding retry transition produced no active children");
      }
      const nextPayload = {
        ...payload,
        encodingRetry: {
          ...retry,
          state: nextState,
          replacementJobId: replacementJobIds[0],
          replacementJobIds,
        },
      };
      const updated = this.stateDatabase.db.prepare(`
        UPDATE jobs SET payload_json=?, updated_at=?
        WHERE id=?
          AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
          AND json_extract(payload_json, '$.encodingRetry.state') IN ('running','uploading','verifying')
      `).run(JSON.stringify(nextPayload), this.now(), parentId, generation).changes;
      if (updated !== 1) throw new Error("Encoding retry parent changed before child transition");
      return next;
    })();
  }

  countEncodingRetryJobs(parentId: string, generation: number) {
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN ('download','upload','history_upload','verify_upload')
        AND id<>?
        AND status<>'completed'
        AND COALESCE(json_extract(payload_json, '$.awaitingManualRecovery'), 0) <> 1
        AND json_extract(payload_json, '$.encodingRetry.parentJobId')=?
        AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
    `).get(parentId, parentId, generation);
    return decodeCountRow(row, "encoding retry child count").count;
  }

  cancelEncodingRetryChildren(parentId: string, generation: number) {
    return this.stateDatabase.db.prepare(`
      DELETE FROM jobs
      WHERE kind IN ('download','upload','history_upload','verify_upload')
        AND id<>?
        AND status<>'completed'
        AND COALESCE(json_extract(payload_json, '$.awaitingManualRecovery'), 0) <> 1
        AND json_extract(payload_json, '$.encodingRetry.parentJobId')=?
        AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
    `).run(parentId, parentId, generation).changes;
  }

  private completeEncodingRetryParentUnsafe(parentId: string, generation: number) {
    const value = this.stateDatabase.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(parentId);
    if (value === undefined) return false;
    const row = decodePayloadRow(value, "encoding retry completion payload");
    const payload = readPersistedJobPayload(row.payload_json, "encoding retry completion payload");
    if (isRecoveryStopped(payload)) return false;
    const retry = retryRecord(payload.encodingRetry);
    if (!retry
      || Number(retry.generation) !== Number(generation)
      || !['running', 'uploading', 'verifying'].includes(String(retry.state || ''))) return false;
    return this.stateDatabase.db.prepare(`
      DELETE FROM jobs
      WHERE id=?
        AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
        AND json_extract(payload_json, '$.encodingRetry.state') IN ('running','uploading','verifying')
    `).run(parentId, generation).changes === 1;
  }

  completeEncodingRetryParent(parentId: string, generation: number) {
    return this.stateDatabase.db.transaction(() => this.completeEncodingRetryParentUnsafe(parentId, generation))();
  }

  completeEncodingRetryCommit(parentId: string, generation: number, childId?: string, leaseOwner?: string) {
    return this.stateDatabase.db.transaction(() => {
      const parent = this.findById(parentId);
      const retry = retryRecord(parent?.payload.encodingRetry);
      if (isRecoveryStopped(parent?.payload) || !retry || Number(retry.generation) !== generation
        || !['running', 'uploading', 'verifying'].includes(String(retry.state))) {
        throw new Error("Encoding retry parent changed before commit");
      }
      if (childId && !this.completeUnsafe(childId, leaseOwner)) return false;
      const unfinished = this.stateDatabase.db.prepare(`SELECT 1 FROM jobs
        WHERE id<>? AND status<>'completed'
          AND json_extract(payload_json, '$.encodingRetry.parentJobId')=?
          AND CAST(json_extract(payload_json, '$.encodingRetry.generation') AS INTEGER)=?
        LIMIT 1`).get(parentId, parentId, generation);
      if (unfinished) return true;
      if (!this.completeEncodingRetryParentUnsafe(parentId, generation)) {
        throw new Error("Encoding retry parent changed before commit");
      }
      return true;
    })();
  }
  wakeManualJob(id: string, payloadPatch: Record<string, unknown> = {}, notBefore = this.now()) {
    if (isRecoveryStopped(this.findById(id)?.payload)) return null;
    const value = this.stateDatabase.db.prepare("SELECT status, payload_json FROM jobs WHERE id=?").get(id);
    if (value === undefined) return null;
    const row = decodeStatusPayloadRow(value, "manual recovery job");
    if (!["manual_wait", "failed", "retry_wait", "pending"].includes(row.status)) return null;
    const payload = readPersistedJobPayload(row.payload_json, "manual recovery job");
    const mergedPayload = { ...payload, ...payloadPatch };
    const now = this.now();
    const updated = this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', not_before=?, attempts=0, lease_owner=NULL,
        lease_expires_at=NULL, last_error=NULL, payload_json=?, updated_at=?
      WHERE id=? AND status IN ('manual_wait','failed','retry_wait','pending')
        AND ${RECOVERY_NOT_STOPPED_SQL}
    `).run(Math.max(now, Math.floor(Number(notBefore) || now)), JSON.stringify(mergedPayload), now, id);
    if (updated.changes !== 1) return null;
    return this.findById(id);
  }

  /**
   * Finish a manual recovery attempt without deleting its audit row. The
   * failed technical status keeps the job out of normal queues while the
   * payload-level lifecycle state records the user's explicit disposition.
   */
  abandonRecovery(id: string, reason = "用户已放弃本次候选。", payloadPatch: Record<string, unknown> = {}) {
    const rowResult = this.stateDatabase.db.prepare(
      "SELECT status, payload_json FROM jobs WHERE id=? AND status IN ('manual_wait','failed','retry_wait','pending')"
    );
    const value = rowResult.get(id);
    if (value === undefined) return false;
    const row = decodeStatusPayloadRow(value, "abandoned recovery job");
    const payload = readPersistedJobPayload(row.payload_json, "abandoned recovery job");
    if (payload.awaitingManualRecovery !== true) return false;
    const nextPayload: Record<string, unknown> = {
      ...payload,
      ...payloadPatch,
      awaitingManualRecovery: false,
      resumeOnly: false,
      allowReupload: false,
      userDisposition: "abandoned",
      lifecycleState: "abandoned",
      abandonedAt: this.now(),
    };
    if (isRecord(nextPayload.recoveryAssessment)) {
      const assessment = { ...nextPayload.recoveryAssessment };
      delete assessment.nextCheckAt;
      nextPayload.recoveryAssessment = assessment;
    }
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='failed', not_before=0, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, payload_json=?, updated_at=?
      WHERE id=? AND status IN ('manual_wait','failed','retry_wait','pending')
        AND json_extract(payload_json, '$.awaitingManualRecovery')=1
    `).run(reason.slice(0, 1000), JSON.stringify(nextPayload), now, id).changes === 1;
  }

  counts() {
    const rows = this.stateDatabase.db.prepare(`
      SELECT kind, status, COUNT(*) AS count FROM jobs GROUP BY kind, status
    `).all();
    const decodedRows = decodeJobCountRows(rows, "job counts");
    const result: Record<string, Record<string, number>> = {};
    for (const row of decodedRows) {
      const kind = row.kind;
      const status = row.status;
      result[kind] ||= {};
      result[kind][status] = row.count;
    }
    return result;
  }

  countRecoverable(kinds: PersistentJobKind[]) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN (${placeholders})
        AND ${RECOVERY_NOT_STOPPED_SQL}
        AND ${RECOVERABLE_STATUS_SQL}
        AND ${BOARD_NOT_REPLACED_BY_RETRY_SQL}
    `).get(...kinds);
    return decodeCountRow(row, "recoverable job count").count;
  }

  listForBoard(
    kinds: PersistentJobKind[],
    limit = 100,
    statuses: PersistentJobRecord["status"][] = ["pending", "retry_wait", "leased", "running", "manual_wait", "failed"],
    excludeIds: readonly string[] = [],
  ) {
    if (kinds.length === 0) return [];
    if (statuses.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const statusPlaceholders = statuses.map(() => "?").join(",");
    const excludedPlaceholders = excludeIds.map(() => "?").join(",");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN (${placeholders}) AND status IN (${statusPlaceholders})
        AND ${RECOVERY_NOT_STOPPED_SQL}
        AND ${RECOVERABLE_STATUS_SQL}
        AND ${BOARD_NOT_REPLACED_BY_RETRY_SQL}
        ${excludeIds.length ? `AND id NOT IN (${excludedPlaceholders})` : ""}
      ORDER BY priority ASC, not_before ASC, created_at ASC, id ASC LIMIT ?
    `).all(...kinds, ...statuses, ...excludeIds, Math.max(1, limit)), "board jobs");
  }

  list(kinds: PersistentJobKind[], limit = 1000) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN (${placeholders}) AND status<>'completed'
      ORDER BY priority ASC, not_before ASC, created_at ASC LIMIT ?
    `).all(...kinds, Math.max(1, limit)), "jobs");
  }

  listLegacyDownloadRecovery(limit = 10_000) {
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE kind='download'
        AND json_type(payload_json, '$.legacyFailureKey')='text'
      ORDER BY updated_at ASC, created_at ASC
      LIMIT ?
    `).all(Math.max(1, Math.floor(limit))), "legacy download recoveries");
  }

  findLegacyDownloadRecovery(issueKey: string) {
    const row = this.stateDatabase.db.prepare<[string], unknown>(`
      SELECT * FROM jobs
      WHERE kind='download' AND json_extract(payload_json, '$.legacyFailureKey')=?
      ORDER BY updated_at DESC LIMIT 1
    `).get(String(issueKey || ""));
    return decodeJobRow(row, "legacy recovery lookup") || null;
  }

  listBvids(kinds: PersistentJobKind[], limit = 100_000) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return decodeBvidProjectionRows(this.stateDatabase.db.prepare(`
      SELECT DISTINCT bvid FROM jobs
      WHERE kind IN (${placeholders}) AND bvid IS NOT NULL AND bvid != ''
      LIMIT ?
    `).all(...kinds, Math.max(1, Math.floor(limit))), "job bvids").map(row => row.bvid);
  }

  listActiveTransferSessionKeys(
    kinds: PersistentJobKind[] = ["upload", "history_upload", "verify_upload", "quality_upload", "quality_replace"],
  ) {
    if (kinds.length === 0) return new Set<string>();
    const placeholders = kinds.map(() => "?").join(",");
    const statuses = ["pending", "retry_wait", "leased", "running", "manual_wait", "failed"];
    const statusPlaceholders = statuses.map(() => "?").join(",");
    const rows = this.stateDatabase.db.prepare(`
      SELECT
        json_extract(payload_json, '$.sessionId') AS session_id,
        COALESCE(
          json_extract(payload_json, '$.sessionGeneration'),
          json_extract(payload_json, '$.session_generation')
        ) AS session_generation,
        CASE WHEN json_type(payload_json, '$.sessionGeneration') IS NULL
          AND json_type(payload_json, '$.session_generation') IS NULL THEN 1 ELSE 0 END AS legacy_generation
      FROM jobs
      WHERE kind IN (${placeholders})
        AND status IN (${statusPlaceholders})
        AND (
          NOT (${RECOVERY_NOT_STOPPED_SQL})
          OR status != 'failed'
          OR json_extract(payload_json, '$.awaitingManualRecovery')=1
        )
        AND json_type(payload_json, '$.sessionId') IN ('text', 'integer')
    `).all(...kinds, ...statuses);
    const decodedRows = decodeSessionIdentityRows(rows, "active transfer sessions");
    return new Set(decodedRows.map(row => `${row.session_id}:g${row.session_generation}`));
  }

  listManualRecovery(kinds: PersistentJobKind[], limit = 1000) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE kind IN (${placeholders})
        AND status IN ('manual_wait','failed','retry_wait','pending')
        AND json_extract(payload_json, '$.awaitingManualRecovery')=1
        AND ${RECOVERY_NOT_STOPPED_SQL}
      ORDER BY priority ASC, updated_at ASC, created_at ASC
      LIMIT ?
    `).all(...kinds, Math.max(1, limit)), "manual recovery jobs");
  }

  listDueManualRecovery(kinds: PersistentJobKind[], now = this.now(), limit = 25) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE kind IN (${placeholders})
        AND status IN ('manual_wait','failed','retry_wait','pending')
        AND json_extract(payload_json, '$.awaitingManualRecovery')=1
        AND ${RECOVERY_NOT_STOPPED_SQL}
        AND (
          json_type(payload_json, '$.recoveryAssessment') IS NULL
          OR (
            json_type(payload_json, '$.recoveryAssessment.nextCheckAt') IN ('integer','real')
            AND json_extract(payload_json, '$.recoveryAssessment.nextCheckAt')<=?
          )
        )
      ORDER BY priority ASC, updated_at ASC, created_at ASC
      LIMIT ?
    `).all(...kinds, Math.max(0, Math.floor(now)), Math.max(1, limit)), "due manual recovery jobs");
  }

  listFailed(kinds: PersistentJobKind[], limit = 1000) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE kind IN (${placeholders}) AND status='failed'
        AND ${RECOVERY_NOT_STOPPED_SQL}
      ORDER BY updated_at DESC, created_at ASC
      LIMIT ?
    `).all(...kinds, Math.max(1, limit)), "failed jobs");
  }

  /**
   * Find legacy no-session upload recoveries that are only waiting to
   * re-confirm an archive. A fully verified relation makes such a job
   * obsolete, but real conflict candidates and active uploads must remain.
   */
  listObsoleteArchiveRecoveryCandidates(
    limit = 1000,
    scope?: { bvid?: string; userId?: string; mediaId?: number },
  ) {
    const conditions = [
      "kind='upload'",
      "status IN ('pending','retry_wait','manual_wait','failed')",
      "bvid IS NOT NULL AND bvid != ''",
      "user_id IS NOT NULL AND user_id != ''",
      "media_id IS NOT NULL",
      "json_extract(payload_json, '$.resumeOnly')=1",
      "COALESCE(json_extract(payload_json, '$.allowReupload'), 0)<>1",
      "COALESCE(NULLIF(json_extract(payload_json, '$.sessionId'), ''), '')=''",
      "json_type(payload_json, '$.encodingRetry') IS NULL",
      "COALESCE(json_extract(payload_json, '$.historyOnly'), 0)<>1",
      "json_type(payload_json, '$.conflictCandidate') IS NULL",
      "COALESCE(json_extract(payload_json, '$.conflictCandidateOnly'), 0)<>1",
      "COALESCE(json_extract(payload_json, '$.legacyConflictSideEffectsStarted'), 0)<>1",
      "(json_type(payload_json, '$.conflictArchiveVerifiedPaths') IS NULL OR json_array_length(payload_json, '$.conflictArchiveVerifiedPaths')=0)",
      "json_type(payload_json, '$.files')='array'",
      "json_array_length(payload_json, '$.files')>0",
    ];
    const params: Array<string | number> = [];
    if (scope?.bvid) {
      conditions.push("bvid=?");
      params.push(String(scope.bvid));
    }
    if (scope?.userId) {
      conditions.push("user_id=?");
      params.push(String(scope.userId));
    }
    const scopedMediaId = scope?.mediaId;
    if (Number.isInteger(scopedMediaId)) {
      conditions.push("media_id=?");
      params.push(Number(scopedMediaId));
    }
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY updated_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(...params, Math.max(1, Math.floor(limit))), "obsolete archive recovery jobs");
  }

  removeObsoleteArchiveRecoveryCandidate(id: string) {
    return this.stateDatabase.db.prepare(`
      DELETE FROM jobs
      WHERE id=?
        AND kind='upload'
        AND status IN ('pending','retry_wait','manual_wait','failed')
        AND json_extract(payload_json, '$.resumeOnly')=1
        AND COALESCE(json_extract(payload_json, '$.allowReupload'), 0)<>1
        AND COALESCE(NULLIF(json_extract(payload_json, '$.sessionId'), ''), '')=''
        AND json_type(payload_json, '$.encodingRetry') IS NULL
        AND COALESCE(json_extract(payload_json, '$.historyOnly'), 0)<>1
        AND json_type(payload_json, '$.conflictCandidate') IS NULL
        AND COALESCE(json_extract(payload_json, '$.conflictCandidateOnly'), 0)<>1
        AND COALESCE(json_extract(payload_json, '$.legacyConflictSideEffectsStarted'), 0)<>1
        AND (json_type(payload_json, '$.conflictArchiveVerifiedPaths') IS NULL OR json_array_length(payload_json, '$.conflictArchiveVerifiedPaths')=0)
        AND json_type(payload_json, '$.files')='array'
        AND json_array_length(payload_json, '$.files')>0
    `).run(String(id || "")).changes === 1;
  }

  countOutstanding(kinds: PersistentJobKind[]) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs WHERE kind IN (${placeholders})
    `).get(...kinds);
    return decodeCountRow(row, "outstanding job count").count;
  }

  countDue(kinds: PersistentJobKind[], maxPriority = 100, now = this.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN (${placeholders}) AND status IN ('pending','retry_wait')
        AND not_before <= ? AND priority <= ?
    `).get(...kinds, now, maxPriority);
    return decodeCountRow(row, "due job count").count;
  }

  nextDueAt() {
    const row = this.stateDatabase.db.prepare<[], unknown>(`
      SELECT MIN(not_before) AS next_at FROM jobs WHERE status IN ('pending','retry_wait')
    `).get();
    const decoded = decodeNextAtRow(row, "next due job schedule");
    return decoded.next_at === null ? undefined : decoded.next_at;
  }

  scheduleSummary(kind: PersistentJobKind) {
    const row = this.stateDatabase.db.prepare<[string], { count: number; next_at: number | null }>(`
      SELECT COUNT(*) AS count, MIN(not_before) AS next_at
      FROM jobs WHERE kind=? AND status IN ('pending','retry_wait','leased','running')
    `).get(kind);
    const decoded = decodeCountAndNextAtRow(row, `schedule summary:${kind}`);
    return { count: decoded.count, nextAt: decoded.next_at === null ? undefined : decoded.next_at };
  }

  accessProbeScheduleSummary(intent: "charging" | "availability" | "legacy_classification") {
    const row = this.stateDatabase.db.prepare<unknown[], { count: number; next_at: number | null }>(`
      SELECT COUNT(*) AS count, MIN(not_before) AS next_at
      FROM jobs
      WHERE kind='access_probe'
        AND status IN ('pending','retry_wait','leased','running')
        AND (
          EXISTS (
            SELECT 1 FROM json_each(jobs.payload_json, '$.intents')
            WHERE json_each.value=?
          )
          OR (
            json_type(jobs.payload_json, '$.intents') IS NULL
            AND CASE
              WHEN ?='availability' THEN json_extract(jobs.payload_json, '$.purpose')='availability_recheck'
              WHEN ?='legacy_classification' THEN json_extract(jobs.payload_json, '$.purpose')='legacy_failure_classification'
              ELSE COALESCE(json_extract(jobs.payload_json, '$.purpose'), 'charging_recheck') NOT IN ('availability_recheck','legacy_failure_classification')
            END
          )
        )
    `).get(intent, intent, intent);
    const decoded = decodeCountAndNextAtRow(row, "access probe schedule");
    return {
      count: decoded.count,
      nextAt: decoded.next_at === null ? undefined : decoded.next_at,
    };
  }

  hasJobsForBvid(bvid: string, kinds?: PersistentJobKind[]) {
    if (!kinds?.length) {
      const row = this.stateDatabase.db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE bvid=?").get(bvid);
      return decodeCountRow(row, "jobs for bvid").count > 0;
    }
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`SELECT COUNT(*) AS count FROM jobs WHERE bvid=? AND kind IN (${placeholders})`).get(bvid, ...kinds);
    return decodeCountRow(row, "jobs for bvid and kind").count > 0;
  }

  hasActiveJobsForBvid(bvid: string, kinds?: PersistentJobKind[]) {
    const statuses = PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES;
    const statusPlaceholders = statuses.map(() => "?").join(",");
    if (!kinds?.length) {
      return Boolean(this.stateDatabase.db.prepare(`
        SELECT 1 FROM jobs
        WHERE bvid=? AND status IN (${statusPlaceholders})
        LIMIT 1
      `).get(bvid, ...statuses));
    }
    const kindPlaceholders = kinds.map(() => "?").join(",");
    return Boolean(this.stateDatabase.db.prepare(`
      SELECT 1 FROM jobs
      WHERE bvid=? AND kind IN (${kindPlaceholders}) AND status IN (${statusPlaceholders})
      LIMIT 1
    `).get(bvid, ...kinds, ...statuses));
  }

  countJobsForBvid(bvid: string, kinds: PersistentJobKind[]) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare<unknown[], { count: number }>(`SELECT COUNT(*) AS count FROM jobs WHERE bvid=? AND kind IN (${placeholders})`).get(bvid, ...kinds);
    return decodeCountRow(row, "jobs for bvid and kind").count;
  }

  countQualityJobsForArtifact(artifactKey: string) {
    if (!artifactKey) return 0;
    const row = this.stateDatabase.db.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN ('quality_download','quality_upload','quality_replace','quality_cleanup')
        AND json_extract(payload_json, '$.artifactKey')=?
    `).get(artifactKey);
    return decodeCountRow(row, "quality jobs for artifact").count;
  }

  hasQualityTarget(userId: string, mediaId: number, bvid: string) {
    const row = this.stateDatabase.db.prepare(`
      SELECT 1 FROM jobs
      WHERE bvid=? AND status<>'completed' AND (
        (kind='quality_download' AND (
          (json_extract(payload_json, '$.target.userId')=? AND CAST(json_extract(payload_json, '$.target.mediaId') AS INTEGER)=?)
          OR EXISTS (
            SELECT 1 FROM json_each(jobs.payload_json, '$.targets') AS target
            WHERE json_extract(target.value, '$.userId')=?
              AND CAST(json_extract(target.value, '$.mediaId') AS INTEGER)=?
          )
        ))
        OR (kind IN ('quality_upload','quality_replace','quality_cleanup') AND user_id=? AND media_id=?)
      ) LIMIT 1
    `).get(bvid, userId, mediaId, userId, mediaId, userId, mediaId);
    return Boolean(row);
  }

  listQualityTargetKeys() {
    const rows = this.stateDatabase.db.prepare(`
      SELECT kind, bvid, user_id, media_id, payload_json FROM jobs
      WHERE kind IN ('quality_download','quality_upload','quality_replace','quality_cleanup')
        AND status<>'completed'
    `).all();
    const decodedRows = decodeQualityTargetProjectionRows(rows, "quality targets");
    const keys = new Set<string>();
    for (const row of decodedRows) {
      const bvid = row.bvid;
      if (!bvid) continue;
      if (row.kind === "quality_download") {
        const payload = readPersistedJobPayload(row.payload_json);
        for (const target of qualityTargetsFromPayload(payload)) {
          const key = qualityTargetIdentityKey(target?.userId, target?.mediaId, bvid);
          if (key) keys.add(key);
        }
        continue;
      }
      const key = qualityTargetIdentityKey(row.user_id, row.media_id, bvid);
      if (key) keys.add(key);
    }
    return keys;
  }

  hasDedupePrefix(prefix: string) {
    const row = this.stateDatabase.db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE dedupe_key LIKE ? AND status<>'completed'").get(`${prefix}%`);
    return decodeCountRow(row, "job dedupe prefix count").count > 0;
  }

  wakeByBvid(bvid: string, kinds: PersistentJobKind[], now = this.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE bvid=? AND kind IN (${placeholders}) AND status IN ('pending','retry_wait')
    `).run(now, now, bvid, ...kinds).changes;
  }

  rescheduleByBvid(bvid: string, kinds: PersistentJobKind[], notBefore: number, now = this.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET not_before=?, updated_at=?
      WHERE bvid=? AND kind IN (${placeholders}) AND status IN ('pending','retry_wait')
    `).run(Math.max(0, Math.floor(notBefore)), now, bvid, ...kinds).changes;
  }

  wakeAll(kinds: PersistentJobKind[], now = this.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE kind IN (${placeholders}) AND status IN ('pending','retry_wait')
    `).run(now, now, ...kinds).changes;
  }

  listUserDependentJobs(userId: string) {
    const id = String(userId || "");
    return decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE (kind='download' AND (
          user_id=? OR json_extract(payload_json, '$.primaryUserId')=?
          OR json_extract(payload_json, '$.downloadUserId')=?
        )) OR (kind='quality_download' AND (
          user_id=? OR json_extract(payload_json, '$.downloadUserId')=?
          OR json_extract(payload_json, '$.pausedForUserId')=?
        ))
      ORDER BY created_at ASC
    `).all(id, id, id, id, id, id), "user dependent jobs");
  }

  reassignDownloadJob(id: string, downloadUserId: string, payload: Record<string, unknown>) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET user_id=?,
        payload_json=?, status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=NULL, updated_at=? WHERE id=? AND kind IN ('download','quality_download')
    `).run(downloadUserId, JSON.stringify({ ...payload, downloadUserId, pausedForUserId: undefined }), now, now, id).changes === 1;
  }

  pauseDetachedUserJob(id: string, userId: string, payload: Record<string, unknown>) {
    const now = this.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET payload_json=?, status='retry_wait', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error='等待原账号重新登录', updated_at=? WHERE id=? AND kind IN ('download','quality_download')
    `).run(JSON.stringify({ ...payload, pausedForUserId: userId }), Number.MAX_SAFE_INTEGER, now, id).changes === 1;
  }

  resumeDetachedUserJobs(userId: string, now = this.now()) {
    const jobs = decodeJobRows(this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN ('download','quality_download')
        AND json_extract(payload_json, '$.pausedForUserId')=?
    `).all(userId), "detached user jobs");
    const update = this.stateDatabase.db.prepare(`
      UPDATE jobs SET user_id=CASE WHEN kind='quality_download' THEN ? ELSE user_id END,
        payload_json=?, status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=NULL, updated_at=? WHERE id=?
    `);
    const transaction = this.stateDatabase.db.transaction(() => {
      for (const job of jobs) {
        const payload: Record<string, unknown> = { ...job.payload, downloadUserId: userId };
        delete payload.pausedForUserId;
        update.run(userId, JSON.stringify(payload), now, now, job.id);
      }
    });
    transaction();
    return jobs.length;
  }

  cancelUserDependentJobs(userId: string) {
    const id = String(userId || "");
    return this.stateDatabase.db.prepare(`
      DELETE FROM jobs
      WHERE (kind='download' AND (
          user_id=? OR json_extract(payload_json, '$.primaryUserId')=?
          OR json_extract(payload_json, '$.downloadUserId')=?
        )) OR (kind='quality_download' AND (
          user_id=? OR json_extract(payload_json, '$.downloadUserId')=?
          OR json_extract(payload_json, '$.pausedForUserId')=?
        ))
    `).run(id, id, id, id, id, id).changes;
  }
}
