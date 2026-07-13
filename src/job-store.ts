import crypto from "node:crypto";
import type { StateDatabase, PersistentJobRecord } from "./database.js";

export type PersistentJobKind =
  | "download"
  | "access_probe"
  | "upload"
  | "verify_upload"
  | "history_upload"
  | "quality_download"
  | "quality_upload"
  | "quality_replace"
  | "quality_cleanup";

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
}

function qualityTargetKey(target: any) {
  const userId = String(target?.userId || "");
  const mediaId = Number(target?.mediaId);
  return userId && Number.isInteger(mediaId) ? `${userId}:${mediaId}` : "";
}

function qualityTargetsFromPayload(payload: Record<string, any>) {
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const candidates = payload.target ? [payload.target, ...targets] : targets;
  const unique = new Map<string, any>();
  for (const target of candidates) {
    const key = qualityTargetKey(target);
    if (key) unique.set(key, target);
  }
  return [...unique.values()];
}

function rowToJob(row: any): PersistentJobRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    dedupeKey: String(row.dedupe_key),
    bvid: row.bvid || undefined,
    userId: row.user_id || undefined,
    mediaId: typeof row.media_id === "number" ? row.media_id : undefined,
    status: row.status,
    priority: Number(row.priority || 100),
    payload: JSON.parse(row.payload_json || "{}"),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 3),
    notBefore: Number(row.not_before || 0),
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: row.lease_expires_at || undefined,
    lastError: row.last_error || undefined,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export class PersistentJobStore {
  constructor(private stateDatabase: StateDatabase) {}

  rebind(stateDatabase: StateDatabase) {
    this.stateDatabase = stateDatabase;
  }

  enqueue(input: EnqueuePersistentJob) {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.stateDatabase.db.prepare(`
      INSERT INTO jobs(
        id, kind, dedupe_key, bvid, user_id, media_id, status, priority, payload_json,
        attempts, max_attempts, not_before, created_at, updated_at
      ) VALUES(@id,@kind,@dedupeKey,@bvid,@userId,@mediaId,'pending',@priority,@payload,0,@maxAttempts,@notBefore,@now,@now)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        status=CASE WHEN jobs.status='failed' THEN 'pending' ELSE jobs.status END,
        priority=MIN(jobs.priority, excluded.priority),
        not_before=CASE WHEN jobs.status='failed' THEN excluded.not_before ELSE MIN(jobs.not_before, excluded.not_before) END,
        payload_json=CASE WHEN jobs.status IN ('pending','retry_wait','failed') THEN excluded.payload_json ELSE jobs.payload_json END,
        attempts=CASE WHEN jobs.status='failed' THEN 0 ELSE jobs.attempts END,
        lease_owner=CASE WHEN jobs.status='failed' THEN NULL ELSE jobs.lease_owner END,
        lease_expires_at=CASE WHEN jobs.status='failed' THEN NULL ELSE jobs.lease_expires_at END,
        last_error=CASE WHEN jobs.status='failed' THEN NULL ELSE jobs.last_error END,
        max_attempts=MAX(jobs.max_attempts, excluded.max_attempts),
        updated_at=excluded.updated_at
    `).run({
      id,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      bvid: input.bvid || null,
      userId: input.userId || null,
      mediaId: input.mediaId ?? null,
      priority: Math.floor(input.priority ?? 100),
      payload: JSON.stringify(input.payload || {}),
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 3)),
      notBefore: Math.max(0, Math.floor(input.notBefore ?? 0)),
      now,
    });
    return this.findByDedupeKey(input.dedupeKey)!;
  }

  mergeQualityDownload(input: EnqueuePersistentJob) {
    if (input.kind !== "quality_download") throw new Error("mergeQualityDownload requires a quality_download job");
    const transaction = this.stateDatabase.db.transaction(() => {
      const row = this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(input.dedupeKey) as any;
      if (!row) {
        return { job: this.enqueue(input), created: true, targetAdded: true };
      }
      const existing = rowToJob(row);
      const existingPayload = existing.payload as Record<string, any>;
      const incomingPayload = (input.payload || {}) as Record<string, any>;
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
      const now = Date.now();
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

  replaceQualityDownloadJobs(jobs: PersistentJobRecord[], input: EnqueuePersistentJob) {
    if (input.kind !== "quality_download" || jobs.length === 0) {
      throw new Error("replaceQualityDownloadJobs requires existing quality_download jobs");
    }
    const transaction = this.stateDatabase.db.transaction(() => {
      const ids = [...new Set(jobs.map((job) => job.id))];
      const placeholders = ids.map(() => "?").join(",");
      this.stateDatabase.db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids);
      const replacement = this.enqueue(input);
      const attempts = Math.max(...jobs.map((job) => Number(job.attempts || 0)), 0);
      const notBefore = Math.max(...jobs.map((job) => Number(job.notBefore || 0)), Number(input.notBefore || 0));
      const maxAttempts = Math.max(...jobs.map((job) => Number(job.maxAttempts || 1)), Number(input.maxAttempts || 1));
      const createdAt = Math.min(...jobs.map((job) => Number(job.createdAt || Date.now())));
      const lastError = [...jobs].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.lastError || null;
      const status = notBefore > Date.now() || jobs.some((job) => job.status === "retry_wait") ? "retry_wait" : "pending";
      this.stateDatabase.db.prepare(`
        UPDATE jobs SET status=?, attempts=?, max_attempts=?, not_before=?, lease_owner=NULL,
          lease_expires_at=NULL, last_error=?, created_at=?, updated_at=? WHERE id=?
      `).run(status, attempts, maxAttempts, notBefore, lastError, createdAt, Date.now(), replacement.id);
      return this.findById(replacement.id)!;
    });
    return transaction();
  }

  findByDedupeKey(dedupeKey: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(dedupeKey);
    return row ? rowToJob(row) : null;
  }

  findById(id: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return row ? rowToJob(row) : null;
  }

  claimDue(kinds: PersistentJobKind[], limit: number, leaseOwner: string, leaseMs = 5 * 60_000, now = Date.now()) {
    if (kinds.length === 0 || limit <= 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const transaction = this.stateDatabase.db.transaction(() => {
      this.recoverExpiredLeases(now);
      const rows = this.stateDatabase.db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('pending','retry_wait') AND not_before <= ? AND kind IN (${placeholders})
        ORDER BY priority ASC, not_before ASC, created_at ASC
        LIMIT ?
      `).all(now, ...kinds, Math.max(0, Math.floor(limit))) as any[];
      const leaseExpiresAt = now + Math.max(10_000, leaseMs);
      const update = this.stateDatabase.db.prepare(`
        UPDATE jobs SET status='leased', lease_owner=?, lease_expires_at=?, updated_at=?
        WHERE id=? AND status IN ('pending','retry_wait')
      `);
      const claimed: PersistentJobRecord[] = [];
      for (const row of rows) {
        if (update.run(leaseOwner, leaseExpiresAt, now, row.id).changes === 1) {
          claimed.push(rowToJob({ ...row, status: "leased", lease_owner: leaseOwner, lease_expires_at: leaseExpiresAt, updated_at: now }));
        }
      }
      return claimed;
    });
    return transaction();
  }

  markRunning(id: string, leaseOwner: string, leaseMs = 30 * 60_000) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='running', lease_expires_at=?, updated_at=?
      WHERE id=? AND lease_owner=? AND status='leased'
    `).run(now + leaseMs, now, id, leaseOwner).changes === 1;
  }

  extendLease(id: string, leaseOwner: string, leaseMs = 30 * 60_000) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET lease_expires_at=?, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('leased','running')
    `).run(now + leaseMs, now, id, leaseOwner).changes === 1;
  }

  complete(id: string, leaseOwner?: string) {
    if (leaseOwner) {
      return this.stateDatabase.db.prepare("DELETE FROM jobs WHERE id=? AND lease_owner=?").run(id, leaseOwner).changes === 1;
    }
    return this.stateDatabase.db.prepare("DELETE FROM jobs WHERE id=?").run(id).changes === 1;
  }

  retry(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = Date.now();
    const row = this.stateDatabase.db.prepare("SELECT kind, attempts, max_attempts FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner) as any;
    if (!row) return { updated: false, exhausted: false };
    const attempts = Number(row.attempts || 0) + 1;
    const exhausted = attempts >= Number(row.max_attempts || 1);
    if (exhausted) {
      if (String(row.kind) === "upload" || ["quality_upload", "quality_replace", "quality_cleanup"].includes(String(row.kind))) {
        this.stateDatabase.db.prepare(`
          UPDATE jobs SET status='failed', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
            last_error=?, updated_at=? WHERE id=? AND lease_owner=?
        `).run(attempts, Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner);
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

  retryIndefinitely(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = Date.now();
    const row = this.stateDatabase.db.prepare("SELECT attempts FROM jobs WHERE id=? AND lease_owner=?").get(id, leaseOwner) as any;
    if (!row) return { updated: false, attempts: 0 };
    const attempts = Number(row.attempts || 0) + 1;
    const updated = this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='retry_wait', attempts=?, not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, updated_at=? WHERE id=? AND lease_owner=?
    `).run(attempts, Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner).changes === 1;
    return { updated, attempts };
  }

  defer(id: string, leaseOwner: string, error: string, notBefore: number) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='retry_wait', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=?, updated_at=? WHERE id=? AND lease_owner=?
    `).run(Math.max(now, Math.floor(notBefore)), error.slice(0, 1000), now, id, leaseOwner).changes === 1;
  }

  recoverExpiredLeases(now = Date.now()) {
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(now, now).changes;
  }

  releaseOwner(leaseOwner: string) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE lease_owner=? AND status IN ('leased','running')
    `).run(now, leaseOwner).changes;
  }

  updatePayload(id: string, payload: Record<string, unknown>) {
    return this.stateDatabase.db.prepare("UPDATE jobs SET payload_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(payload || {}), Date.now(), id).changes === 1;
  }

  counts() {
    const rows = this.stateDatabase.db.prepare(`
      SELECT kind, status, COUNT(*) AS count FROM jobs GROUP BY kind, status
    `).all() as any[];
    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      result[row.kind] ||= {};
      result[row.kind][row.status] = Number(row.count || 0);
    }
    return result;
  }

  listForBoard(kinds: PersistentJobKind[], limit = 100) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return (this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN (${placeholders})
      ORDER BY priority ASC, not_before ASC, created_at ASC LIMIT ?
    `).all(...kinds, Math.max(1, limit)) as any[]).map(rowToJob);
  }

  list(kinds: PersistentJobKind[], limit = 1000) {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    return (this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN (${placeholders})
      ORDER BY priority ASC, not_before ASC, created_at ASC LIMIT ?
    `).all(...kinds, Math.max(1, limit)) as any[]).map(rowToJob);
  }

  countOutstanding(kinds: PersistentJobKind[]) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE kind IN (${placeholders})
    `).get(...kinds) as any;
    return Number(row?.count || 0);
  }

  countDue(kinds: PersistentJobKind[], maxPriority = 100, now = Date.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN (${placeholders}) AND status IN ('pending','retry_wait')
        AND not_before <= ? AND priority <= ?
    `).get(...kinds, now, maxPriority) as any;
    return Number(row?.count || 0);
  }

  nextDueAt() {
    const row = this.stateDatabase.db.prepare(`
      SELECT MIN(not_before) AS next_at FROM jobs WHERE status IN ('pending','retry_wait')
    `).get() as any;
    return typeof row?.next_at === "number" ? row.next_at : undefined;
  }

  scheduleSummary(kind: PersistentJobKind) {
    const row = this.stateDatabase.db.prepare(`
      SELECT COUNT(*) AS count, MIN(not_before) AS next_at
      FROM jobs WHERE kind=? AND status IN ('pending','retry_wait','leased','running')
    `).get(kind) as any;
    return {
      count: Number(row?.count || 0),
      nextAt: typeof row?.next_at === "number" ? row.next_at : undefined,
    };
  }

  hasJobsForBvid(bvid: string, kinds?: PersistentJobKind[]) {
    if (!kinds?.length) {
      return Number((this.stateDatabase.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE bvid=?").get(bvid) as any).count || 0) > 0;
    }
    const placeholders = kinds.map(() => "?").join(",");
    return Number((this.stateDatabase.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE bvid=? AND kind IN (${placeholders})`).get(bvid, ...kinds) as any).count || 0) > 0;
  }

  countJobsForBvid(bvid: string, kinds: PersistentJobKind[]) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.stateDatabase.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE bvid=? AND kind IN (${placeholders})`).get(bvid, ...kinds) as any;
    return Number(row?.count || 0);
  }

  countQualityJobsForArtifact(artifactKey: string) {
    if (!artifactKey) return 0;
    const row = this.stateDatabase.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE kind IN ('quality_download','quality_upload','quality_replace','quality_cleanup')
        AND json_extract(payload_json, '$.artifactKey')=?
    `).get(artifactKey) as any;
    return Number(row?.count || 0);
  }

  hasQualityTarget(userId: string, mediaId: number, bvid: string) {
    const row = this.stateDatabase.db.prepare(`
      SELECT 1 FROM jobs
      WHERE bvid=? AND (
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

  hasDedupePrefix(prefix: string) {
    return Number((this.stateDatabase.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE dedupe_key LIKE ?").get(`${prefix}%`) as any).count || 0) > 0;
  }

  wakeByBvid(bvid: string, kinds: PersistentJobKind[], now = Date.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE bvid=? AND kind IN (${placeholders}) AND status IN ('pending','retry_wait')
    `).run(now, now, bvid, ...kinds).changes;
  }

  wakeAll(kinds: PersistentJobKind[], now = Date.now()) {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE kind IN (${placeholders}) AND status IN ('pending','retry_wait')
    `).run(now, now, ...kinds).changes;
  }

  listUserDependentJobs(userId: string) {
    const id = String(userId || "");
    return (this.stateDatabase.db.prepare(`
      SELECT * FROM jobs
      WHERE (kind='download' AND (
          user_id=? OR json_extract(payload_json, '$.primaryUserId')=?
          OR json_extract(payload_json, '$.downloadUserId')=?
        )) OR (kind='quality_download' AND (
          user_id=? OR json_extract(payload_json, '$.downloadUserId')=?
          OR json_extract(payload_json, '$.pausedForUserId')=?
        ))
      ORDER BY created_at ASC
    `).all(id, id, id, id, id, id) as any[]).map(rowToJob);
  }

  reassignDownloadJob(id: string, downloadUserId: string, payload: Record<string, unknown>) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET user_id=CASE WHEN kind='quality_download' THEN ? ELSE user_id END,
        payload_json=?, status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=NULL, updated_at=? WHERE id=? AND kind IN ('download','quality_download')
    `).run(downloadUserId, JSON.stringify({ ...payload, downloadUserId, pausedForUserId: undefined }), now, now, id).changes === 1;
  }

  pauseDetachedUserJob(id: string, userId: string, payload: Record<string, unknown>) {
    const now = Date.now();
    return this.stateDatabase.db.prepare(`
      UPDATE jobs SET payload_json=?, status='retry_wait', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error='等待原账号重新登录', updated_at=? WHERE id=? AND kind IN ('download','quality_download')
    `).run(JSON.stringify({ ...payload, pausedForUserId: userId }), Number.MAX_SAFE_INTEGER, now, id).changes === 1;
  }

  resumeDetachedUserJobs(userId: string, now = Date.now()) {
    const jobs = (this.stateDatabase.db.prepare(`
      SELECT * FROM jobs WHERE kind IN ('download','quality_download')
        AND json_extract(payload_json, '$.pausedForUserId')=?
    `).all(userId) as any[]).map(rowToJob);
    const update = this.stateDatabase.db.prepare(`
      UPDATE jobs SET user_id=CASE WHEN kind='quality_download' THEN ? ELSE user_id END,
        payload_json=?, status='pending', not_before=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error=NULL, updated_at=? WHERE id=?
    `);
    const transaction = this.stateDatabase.db.transaction(() => {
      for (const job of jobs) {
        const payload = { ...job.payload, downloadUserId: userId };
        delete (payload as any).pausedForUserId;
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
