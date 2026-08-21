import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig, ConfigStore } from "./config.js";
import type { StateDatabase } from "./database.js";
import { safeErrorSummary } from "./diagnostics.js";
import { PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES, PersistentJobStore } from "./job-store.js";
import type { StateManager } from "./state.js";
import type { BiliUser, UserStore } from "./users.js";
import { buildDavClient, isRemoteNotFoundError } from "./uploader.js";
import { createRemoteFileResolver } from "./remote-file-resolver.js";
import { normalizeLegacyRemotePath, remoteBasename } from "./remote-path.js";

export type ArchiveDeletionScope = "account" | "source";
export type ArchiveDeletionStatus = "preview" | "preparing" | "config_removing" | "pending" | "running" | "retry_wait" | "failed" | "completed" | "expired" | "superseded";

export interface ArchiveDeletionDavClient {
  stat(remotePath: string): Promise<any>;
  deleteFile(remotePath: string): Promise<any>;
  getDirectoryContents(remotePath: string): Promise<any>;
}

export interface ArchiveDeletionOptions {
  clientFactory?: (config: AppConfig) => ArchiveDeletionDavClient;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  previewCleanupIntervalMs?: number;
  setMaintenance?: (locked: boolean, summary?: {
    id: string;
    status: string;
    scope: string;
    userId?: string;
    mediaId?: number;
    bvid?: string;
  }) => void;
  isSchedulerIdle?: () => boolean;
  prepareSourceDeletion?: (userId: string, mediaId: number, bvid: string) => Promise<void>;
  onAccountDeletionCompleted?: (userId: string) => void;
  onAccountPreparationRecovery?: (userId: string, accountRemoved: boolean) => void;
}

const PREVIEW_TTL_MS = 30 * 60_000;
const EXPIRED_PREVIEW_RETENTION_MS = 24 * 60 * 60_000;
const PREVIEW_CLEANUP_INTERVAL_MS = 30 * 60_000;
const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000];
const TERMINAL_ITEM_STATUSES = new Set(["deleted", "missing", "retained"]);

function normalizeRemotePath(value: string) {
  try {
    return normalizeLegacyRemotePath(value);
  } catch {
    throw archiveDeletionError("远端路径包含非法片段", 409, false);
  }
}

function isWithin(root: string, target: string) {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function statusCode(error: any) {
  return Number(error?.statusCode || error?.response?.status || error?.status || 0);
}

function isTransientError(error: any) {
  const status = statusCode(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function archiveDeletionError(message: string, code = 400, transient = false) {
  return Object.assign(new Error(message), { statusCode: code, transient });
}

function safeDeletionError(error: unknown, fallback = "归档清理失败") {
  return safeErrorSummary(error, fallback)
    .replace(/https?:\/\/[^\s]+/gi, "[remote url]")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[local path]")
    .replace(/(^|[\s("'=:])\/(?:[^\s"'<>/]+\/)*[^\s"'<>]+/g, "$1[remote path]")
    .slice(0, 1000);
}

function alistIdentityHash(config: AppConfig) {
  return crypto.createHash("sha256").update(JSON.stringify({
    alistUrl: String(config.alistUrl || "").replace(/\/$/, ""),
    alistUsername: String(config.alistUsername || ""),
    alistPassword: String(config.alistPassword || ""),
  })).digest("hex");
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

function finiteSize(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export class ArchiveDeletionService {
  private db: StateDatabase;
  private readonly stateManager: StateManager;
  private readonly configStore: ConfigStore;
  private readonly userStore: UserStore;
  private readonly jobStore: PersistentJobStore;
  private readonly clientFactory: (config: AppConfig) => ArchiveDeletionDavClient;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly previewCleanupIntervalMs: number;
  private readonly setMaintenance: NonNullable<ArchiveDeletionOptions["setMaintenance"]>;
  private readonly isSchedulerIdle: () => boolean;
  private readonly prepareSourceDeletion?: ArchiveDeletionOptions["prepareSourceDeletion"];
  private readonly onAccountDeletionCompleted: NonNullable<ArchiveDeletionOptions["onAccountDeletionCompleted"]>;
  private readonly onAccountPreparationRecovery: NonNullable<ArchiveDeletionOptions["onAccountPreparationRecovery"]>;
  private readonly leaseOwner = `archive-delete:${crypto.randomUUID()}`;
  private worker: Promise<void> | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private previewCleanupTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    stateManager: StateManager,
    configStore: ConfigStore,
    userStore: UserStore,
    options: ArchiveDeletionOptions = {}
  ) {
    this.stateManager = stateManager;
    this.db = stateManager.getDatabase();
    this.configStore = configStore;
    this.userStore = userStore;
    this.jobStore = new PersistentJobStore(this.db);
    this.clientFactory = options.clientFactory || ((config) => buildDavClient(config) as unknown as ArchiveDeletionDavClient);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.previewCleanupIntervalMs = Math.max(1, options.previewCleanupIntervalMs ?? PREVIEW_CLEANUP_INTERVAL_MS);
    this.setMaintenance = options.setMaintenance || (() => undefined);
    this.isSchedulerIdle = options.isSchedulerIdle || (() => true);
    this.prepareSourceDeletion = options.prepareSourceDeletion;
    this.onAccountDeletionCompleted = options.onAccountDeletionCompleted || (() => undefined);
    this.onAccountPreparationRecovery = options.onAccountPreparationRecovery || (() => undefined);
    this.jobStore.recoverExpiredLeases(this.now());
    this.pruneExpiredPreviews();
    this.startPreviewCleanupTimer();
    this.reconcileArchiveAccounts();
    this.syncMaintenanceState();
    this.recoverAccountPreparations();
    this.syncMaintenanceState();
    this.schedule();
  }

  rebind(database: StateDatabase) {
    this.db = database;
    this.jobStore.rebind(database);
    this.jobStore.recoverExpiredLeases(this.now());
    this.pruneExpiredPreviews();
    this.reconcileArchiveAccounts();
    this.syncMaintenanceState();
    this.recoverAccountPreparations();
    this.restoreLiveAccountsAfterStartup();
    this.syncMaintenanceState();
    this.schedule();
  }

  rememberAccount(user: BiliUser) {
    const now = this.now();
    this.db.db.prepare(`
      INSERT INTO archive_accounts(user_id, uid, name, avatar, removed_at, updated_at)
      VALUES(?,?,?,?,NULL,?)
      ON CONFLICT(user_id) DO UPDATE SET uid=excluded.uid, name=excluded.name,
        avatar=excluded.avatar, removed_at=NULL, updated_at=excluded.updated_at
    `).run(user.id, Number(user.uid || user.cookie?.DedeUserID || 0) || null, user.name || `账号 ${user.id}`, user.avatar || null, now);
  }

  markAccountRemoved(userId: string) {
    const now = this.now();
    this.db.db.prepare("UPDATE archive_accounts SET removed_at=?, updated_at=? WHERE user_id=?").run(now, now, userId);
  }

  restoreAccount(userId: string) {
    if (this.db.hasUnfinishedArchiveAccountDeletion(userId)) return false;
    this.db.db.prepare("DELETE FROM archive_accounts WHERE user_id=?").run(userId);
    return true;
  }

  restoreLiveAccountsAfterStartup() {
    const restored: string[] = [];
    const hasEvidence = this.db.db.prepare(`
      SELECT EXISTS(SELECT 1 FROM archive_accounts WHERE user_id=@userId)
        OR EXISTS(SELECT 1 FROM favorite_relations WHERE user_id=@userId AND account_detached_at IS NOT NULL)
        OR EXISTS(
          SELECT 1 FROM jobs
          WHERE kind IN ('download','quality_download') AND json_valid(payload_json)=1
            AND json_extract(payload_json, '$.pausedForUserId')=@userId
        ) AS present
    `);
    for (const user of this.userStore.list()) {
      if (!user.enabled || this.db.hasUnfinishedArchiveAccountDeletion(user.id)) continue;
      if (!Boolean((hasEvidence.get({ userId: user.id }) as any)?.present)) continue;
      if (!this.restoreAccount(user.id)) continue;
      this.onAccountPreparationRecovery(user.id, false);
      restored.push(user.id);
    }
    return restored;
  }

  forgetPendingAccount(userId: string) {
    this.db.db.prepare("DELETE FROM archive_accounts WHERE user_id=? AND removed_at IS NULL").run(userId);
  }

  reconcileArchiveAccounts() {
    const liveIds = new Set(this.userStore.list().map((user) => user.id));
    const now = this.now();
    const detached = this.db.db.prepare(`
      SELECT user_id, MAX(account_detached_at) AS removed_at
      FROM favorite_relations
      WHERE account_detached_at IS NOT NULL
      GROUP BY user_id
    `).all() as Array<{ user_id: string; removed_at: number }>;
    const insertLegacy = this.db.db.prepare(`
      INSERT OR IGNORE INTO archive_accounts(user_id, uid, name, avatar, removed_at, updated_at)
      VALUES(?,?,?,?,?,?)
    `);
    for (const row of detached) {
      const userId = String(row.user_id || "");
      if (!userId || liveIds.has(userId)) continue;
      const numericUid = Number(userId);
      insertLegacy.run(
        userId,
        Number.isSafeInteger(numericUid) && numericUid > 0 ? numericUid : null,
        `已移除账号 ${userId}`,
        null,
        Number(row.removed_at || now),
        now
      );
    }
    const rows = this.db.db.prepare("SELECT user_id FROM archive_accounts WHERE removed_at IS NULL").all() as any[];
    const mark = this.db.db.prepare("UPDATE archive_accounts SET removed_at=?, updated_at=? WHERE user_id=? AND removed_at IS NULL");
    for (const row of rows) {
      if (!liveIds.has(String(row.user_id))) mark.run(now, now, row.user_id);
    }
  }

  isKnownOwner(userId: string) {
    return Boolean(this.userStore.getById(userId) || this.db.isArchiveAccount(userId));
  }

  hasActiveOperation() {
    return this.db.hasActiveArchiveDeletion();
  }

  hasUnfinishedOperation() {
    return this.db.hasUnfinishedArchiveDeletion();
  }

  private syncMaintenanceState() {
    const row = this.db.db.prepare(`
      SELECT id, status, scope, user_id, media_id, bvid FROM archive_deletions
      WHERE status IN ('preparing','config_removing','pending','running','retry_wait')
      ORDER BY updated_at DESC LIMIT 1
    `).get() as any;
    if (row) {
      this.setMaintenance(true, {
        id: String(row.id),
        status: String(row.status),
        scope: String(row.scope),
        userId: String(row.user_id || "") || undefined,
        mediaId: row.media_id == null ? undefined : Number(row.media_id),
        bvid: row.bvid ? String(row.bvid) : undefined,
      });
    } else {
      this.setMaintenance(false);
    }
  }

  private pruneExpiredPreviews() {
    const now = this.now();
    this.db.db.transaction(() => {
      this.db.db.prepare(`
        UPDATE archive_deletions SET status='expired', expires_at=COALESCE(expires_at,?), updated_at=?
        WHERE status='preview' AND (expires_at IS NULL OR expires_at<=?)
      `).run(now, now, now);
      this.db.db.prepare(`
        DELETE FROM archive_deletion_items
        WHERE deletion_id IN (SELECT id FROM archive_deletions WHERE status='expired')
      `).run();
      this.db.db.prepare(`
        DELETE FROM archive_deleted_sources
        WHERE deletion_id IN (SELECT id FROM archive_deletions WHERE status='expired')
      `).run();
      this.db.db.prepare(`
        DELETE FROM archive_deletions
        WHERE status='expired' AND expires_at IS NOT NULL AND expires_at<=?
      `).run(now - EXPIRED_PREVIEW_RETENTION_MS);
    })();
  }

  private startPreviewCleanupTimer() {
    if (this.previewCleanupTimer) clearInterval(this.previewCleanupTimer);
    this.previewCleanupTimer = setInterval(() => {
      if (this.stopped) return;
      try {
        this.pruneExpiredPreviews();
      } catch {
        // The next interval or an explicit preview request will retry cleanup.
      }
    }, this.previewCleanupIntervalMs);
    this.previewCleanupTimer.unref?.();
  }

  private expirePreview(id: string, now: number) {
    const expired = this.db.db.prepare(`
      UPDATE archive_deletions SET status='expired', expires_at=?, updated_at=?
      WHERE id=? AND status='preview'
    `).run(now, now, id).changes;
    if (expired === 0) return;
    this.db.db.prepare("DELETE FROM archive_deletion_items WHERE deletion_id=?").run(id);
    this.db.db.prepare("DELETE FROM archive_deleted_sources WHERE deletion_id=?").run(id);
  }

  previewAccount(user: BiliUser) {
    return this.createPreview("account", user.id);
  }

  previewSource(userId: string, mediaId: number, bvid: string) {
    if (!this.isKnownOwner(userId)) throw archiveDeletionError("归档账号不存在", 404);
    if (!Number.isInteger(mediaId) || mediaId < 1 || !/^BV[0-9A-Za-z]+$/.test(bvid)) {
      throw archiveDeletionError("归档来源参数无效", 400);
    }
    return this.createPreview("source", userId, mediaId, bvid);
  }

  repreview(id: string) {
    const operation = this.get(id);
    if (!operation) throw archiveDeletionError("归档清理任务不存在", 404);
    if (operation.status !== "failed") throw archiveDeletionError("只有失败的归档清理可以重新预览", 409);
    if (!this.isKnownOwner(operation.userId)) throw archiveDeletionError("归档账号不存在", 404);
    return operation.scope === "account"
      ? this.createPreview("account", operation.userId)
      : this.previewSource(operation.userId, operation.mediaId!, operation.bvid!);
  }

  private createPreview(scope: ArchiveDeletionScope, userId: string, mediaId?: number, bvid?: string) {
    this.pruneExpiredPreviews();
    if (this.db.getActivePathMigration()) throw archiveDeletionError("归档路径迁移期间不能创建删除任务", 409);
    if (this.db.hasActiveArchiveDeletion()) throw archiveDeletionError("已有归档清理任务正在执行", 409);
    const config = this.configStore.get();
    const archiveRoot = normalizeRemotePath(config.alistDest);
    const id = crypto.randomUUID();
    const now = this.now();
    const expiresAt = now + PREVIEW_TTL_MS;
    const relationRows = scope === "account"
      ? this.db.db.prepare(`
          SELECT DISTINCT r.user_id, r.media_id, r.bvid
          FROM favorite_relations r
          WHERE r.user_id=? AND EXISTS(
            SELECT 1 FROM remote_files rf
            WHERE rf.user_id=r.user_id AND rf.media_id=r.media_id AND rf.bvid=r.bvid AND rf.status='verified'
          )
          ORDER BY r.media_id, r.bvid
        `).all(userId) as any[]
      : this.db.db.prepare(`
          SELECT r.user_id, r.media_id, r.bvid, r.active_in_favorite
          FROM favorite_relations r
          WHERE r.user_id=? AND r.media_id=? AND r.bvid=? AND EXISTS(
            SELECT 1 FROM remote_files rf
            WHERE rf.user_id=r.user_id AND rf.media_id=r.media_id AND rf.bvid=r.bvid AND rf.status='verified'
          )
        `).all(userId, mediaId, bvid) as any[];
    if (scope === "source" && relationRows.length === 0) throw archiveDeletionError("该来源没有可删除的已验证归档", 409);
    if (scope === "source") {
      const live = this.userStore.getById(userId);
      const selected = Boolean(live?.favorites.some((folder) => folder.mediaId === mediaId));
      if (selected && Number(relationRows[0].active_in_favorite) === 1) {
        throw archiveDeletionError("该视频仍在当前同步收藏夹中，不能直接删除归档", 409);
      }
    }
    const relationCount = scope === "account"
      ? Number((this.db.db.prepare("SELECT COUNT(*) AS count FROM favorite_relations WHERE user_id=?").get(userId) as any)?.count || 0)
      : 1;
    const resolvedId = this.db.db.transaction(() => {
      const candidates = scope === "account"
        ? this.db.db.prepare(`
            SELECT * FROM archive_deletions
            WHERE scope='account' AND user_id=? AND media_id IS NULL AND bvid IS NULL
              AND status='preview'
            ORDER BY created_at DESC, id DESC
          `).all(userId) as any[]
        : this.db.db.prepare(`
            SELECT * FROM archive_deletions
            WHERE scope='source' AND user_id=? AND media_id=? AND bvid=?
              AND status='preview'
            ORDER BY created_at DESC, id DESC
          `).all(userId, mediaId, bvid) as any[];
      const identityHash = alistIdentityHash(config);
      let reusableId: string | undefined;
      for (const candidate of candidates) {
        if (!reusableId && Number(candidate.expires_at || 0) > now && this.previewMatchesCurrent(
          candidate,
          identityHash,
          archiveRoot,
          relationCount,
          relationRows
        )) {
          reusableId = String(candidate.id);
          continue;
        }
        this.expirePreview(String(candidate.id), now);
      }
      if (reusableId) return reusableId;

      this.db.db.prepare(`
        INSERT INTO archive_deletions(
          id, scope, user_id, media_id, bvid, status, alist_identity_hash, archive_root,
          relation_count, source_count, expires_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,'preview',?,?,?,?,?,?,?)
      `).run(
        id, scope, userId, mediaId ?? null, bvid || null, identityHash, archiveRoot,
        relationCount, relationRows.length, expiresAt, now, now
      );
      const insertSource = this.db.db.prepare(`
        INSERT INTO archive_deleted_sources(
          user_id, media_id, bvid, deletion_id, status, file_count, total_bytes, retained_count
        ) VALUES(?,?,?,?,'preview',0,0,0)
      `);
      for (const row of relationRows) insertSource.run(row.user_id, row.media_id, row.bvid, id);
      this.db.db.prepare(`
        INSERT INTO archive_deletion_items(
          deletion_id, remote_path, expected_size, status, attempts, next_attempt_at, created_at, updated_at
        )
        WITH selected AS (
          SELECT rf.remote_path, rf.bvid, rf.expected_size
          FROM remote_files rf
          JOIN archive_deleted_sources s
            ON s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
          WHERE rf.status='verified'
        ), proofs AS (
          SELECT remote_path, bvid, expected_size FROM selected
          UNION ALL
          SELECT rf.remote_path, rf.bvid, rf.expected_size
          FROM remote_files rf
          WHERE rf.status='verified' AND rf.user_id='' AND rf.media_id=0
            AND EXISTS(
              SELECT 1 FROM selected s WHERE s.remote_path=rf.remote_path AND s.bvid=rf.bvid
            )
        )
        SELECT ?, remote_path,
          CASE WHEN COUNT(DISTINCT bvid)=1
            AND SUM(CASE WHEN expected_size IS NULL OR expected_size<0 THEN 1 ELSE 0 END)=0
            AND MIN(expected_size)=MAX(expected_size)
          THEN MAX(expected_size) ELSE NULL END,
          CASE WHEN COUNT(DISTINCT bvid)=1
            AND SUM(CASE WHEN expected_size IS NULL OR expected_size<0 THEN 1 ELSE 0 END)=0
            AND MIN(expected_size)=MAX(expected_size)
          THEN 'pending' ELSE 'conflict' END,
          0, 0, ?, ?
        FROM proofs
        GROUP BY remote_path
      `).run(id, id, now, now);
      this.db.db.prepare(`
        UPDATE archive_deletion_items
        SET last_error='本地SQLite中的归档文件证明不一致'
        WHERE deletion_id=? AND status='conflict'
      `).run(id);
      this.db.db.prepare(`
        UPDATE archive_deleted_sources AS source
        SET file_count=(
          SELECT COUNT(DISTINCT rf.remote_path) FROM remote_files rf
          WHERE rf.user_id=source.user_id AND rf.media_id=source.media_id
            AND rf.bvid=source.bvid AND rf.status='verified'
        ), total_bytes=COALESCE((
          SELECT SUM(rf.expected_size) FROM remote_files rf
          WHERE rf.user_id=source.user_id AND rf.media_id=source.media_id
            AND rf.bvid=source.bvid AND rf.status='verified'
        ),0)
        WHERE deletion_id=?
      `).run(id);
      const totals = this.db.db.prepare(`
        SELECT COUNT(*) AS files, COALESCE(SUM(expected_size),0) AS bytes
        FROM archive_deletion_items WHERE deletion_id=?
      `).get(id) as any;
      const shared = this.db.db.prepare(`
        SELECT COUNT(*) AS count FROM archive_deletion_items i
        WHERE i.deletion_id=? AND EXISTS(
          SELECT 1 FROM remote_files rf
          WHERE rf.remote_path=i.remote_path AND rf.user_id<>'' AND NOT EXISTS(
            SELECT 1 FROM archive_deleted_sources s
            WHERE s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
          )
        )
      `).get(id, id) as any;
      const conflicts = Number((this.db.db.prepare(`
        SELECT COUNT(*) AS count FROM archive_deletion_items WHERE deletion_id=? AND status='conflict'
      `).get(id) as any)?.count || 0);
      this.db.db.prepare(`
        UPDATE archive_deletions SET file_count=?, total_bytes=?, shared_count=?, conflict_count=?, updated_at=? WHERE id=?
      `).run(Number(totals?.files || 0), Number(totals?.bytes || 0), Number(shared?.count || 0), conflicts, now, id);
      return id;
    })();
    return this.get(resolvedId)!;
  }

  private previewMatchesCurrent(
    candidate: any,
    identityHash: string,
    archiveRoot: string,
    relationCount: number,
    relationRows: any[]
  ) {
    let candidateRoot: string;
    try {
      candidateRoot = normalizeRemotePath(candidate.archive_root);
    } catch {
      return false;
    }
    if (String(candidate.alist_identity_hash) !== identityHash
      || candidateRoot !== archiveRoot
      || Number(candidate.relation_count) !== relationCount
      || Number(candidate.source_count) !== relationRows.length) {
      return false;
    }
    const expectedSources = new Set(relationRows.map((row) => `${row.user_id}\0${row.media_id}\0${row.bvid}`));
    const storedSources = this.db.db.prepare(`
      SELECT user_id, media_id, bvid FROM archive_deleted_sources
      WHERE deletion_id=? ORDER BY user_id, media_id, bvid
    `).all(candidate.id) as any[];
    if (storedSources.length !== expectedSources.size
      || storedSources.some((row) => !expectedSources.has(`${row.user_id}\0${row.media_id}\0${row.bvid}`))) {
      return false;
    }
    try {
      return this.previewProofsMatch(String(candidate.id));
    } catch (error) {
      if (Number((error as any)?.statusCode || 0) === 409) return false;
      throw error;
    }
  }

  get(id: string) {
    const row = this.db.db.prepare("SELECT * FROM archive_deletions WHERE id=?").get(id) as any;
    if (!row) return undefined;
    const conflicts = (this.db.db.prepare(`
      SELECT remote_path, status, last_error FROM archive_deletion_items
      WHERE deletion_id=? AND status IN ('conflict','failed')
      ORDER BY remote_path LIMIT 50
    `).all(id) as any[]).map((item) => ({
      name: remoteBasename(item.remote_path),
      status: String(item.status),
      error: item.last_error ? safeDeletionError(item.last_error) : undefined,
    }));
    let activeTasks = 0;
    if (["preview", "preparing", "config_removing"].includes(String(row.status))) {
      const statuses = PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES.map(() => "?").join(",");
      if (String(row.scope) === "source") {
        activeTasks = Number((this.db.db.prepare(`
          SELECT COUNT(*) AS count FROM jobs j
          WHERE j.kind<>'archive_delete' AND j.status IN (${statuses})
            AND j.bvid=? AND (
              (j.user_id=? AND j.media_id=?)
              OR json_extract(j.payload_json, '$.target.userId')=?
                 AND CAST(json_extract(j.payload_json, '$.target.mediaId') AS INTEGER)=?
              OR EXISTS(
                SELECT 1 FROM json_each(j.payload_json, '$.targets') target
                WHERE json_extract(target.value, '$.userId')=?
                  AND CAST(json_extract(target.value, '$.mediaId') AS INTEGER)=?
              )
            )
        `).get(
          ...PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES,
          row.bvid,
          row.user_id,
          row.media_id,
          row.user_id,
          row.media_id,
          row.user_id,
          row.media_id,
        ) as any)?.count || 0);
      } else {
        activeTasks = Number((this.db.db.prepare(`
          SELECT COUNT(*) AS count FROM jobs j
          WHERE j.kind<>'archive_delete' AND j.status IN (${statuses}) AND j.user_id=?
        `).get(...PERSISTENT_JOB_MAINTENANCE_BLOCKING_STATUSES, row.user_id) as any)?.count || 0);
      }
    }
    return {
      id: String(row.id),
      previewId: String(row.id),
      scope: String(row.scope) as ArchiveDeletionScope,
      userId: String(row.user_id),
      mediaId: row.media_id == null ? undefined : Number(row.media_id),
      bvid: row.bvid || undefined,
      status: String(row.status) as ArchiveDeletionStatus,
      relationCount: Number(row.relation_count || 0),
      sourceCount: Number(row.source_count || 0),
      fileCount: Number(row.file_count || 0),
      totalBytes: Number(row.total_bytes || 0),
      sharedCount: Number(row.shared_count || 0),
      completedCount: Number(row.completed_count || 0),
      retainedCount: Number(row.retained_count || 0),
      conflictCount: Number(row.conflict_count || 0),
      failedCount: Number(row.failed_count || 0),
      activeTasks,
      lastError: row.last_error ? safeDeletionError(row.last_error) : undefined,
      conflicts,
      expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      startedAt: row.started_at == null ? undefined : Number(row.started_at),
      completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    };
  }

  getAccountOperation(userId: string) {
    const row = this.db.db.prepare(`
      SELECT id FROM archive_deletions
      WHERE scope='account' AND user_id=?
        AND status IN ('preparing','config_removing','pending','running','retry_wait','failed','completed')
      ORDER BY CASE status
        WHEN 'preparing' THEN 0 WHEN 'config_removing' THEN 1 WHEN 'pending' THEN 2 WHEN 'running' THEN 3
        WHEN 'retry_wait' THEN 4 WHEN 'failed' THEN 5 ELSE 6 END,
        updated_at DESC, id DESC
      LIMIT 1
    `).get(userId) as any;
    return row ? this.get(String(row.id)) : undefined;
  }

  private refreshProjectionForDeletionIds(ids: string[]) {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.db.prepare(`
      SELECT DISTINCT bvid FROM archive_deleted_sources
      WHERE deletion_id IN (${placeholders})
    `).all(...ids) as Array<{ bvid: string }>;
    this.db.refreshArchiveLibraryProjection(rows.map((row) => row.bvid));
  }

  beginAccountPreparation(id: string, confirmation: string) {
    const operation = this.validateStart(id, confirmation);
    if (operation.scope !== "account") throw archiveDeletionError("该预览不是账号归档清理", 409);
    const now = this.now();
    const claimed = this.db.db.transaction(() => {
      const failedPredecessors = this.db.db.prepare(`
        SELECT id FROM archive_deletions
        WHERE id<>? AND scope='account' AND user_id=? AND status='failed'
      `).all(id, operation.userId) as Array<{ id: string }>;
      for (const predecessor of failedPredecessors) {
        this.db.db.prepare(`
          UPDATE archive_deletions
          SET status='superseded', last_error='已由重新预览后的清理任务替代', updated_at=?
          WHERE id=? AND status='failed'
        `).run(now, predecessor.id);
        this.db.db.prepare("UPDATE archive_deleted_sources SET status='superseded' WHERE deletion_id=? AND status='failed'")
          .run(predecessor.id);
      }
      const changed = this.db.db.prepare(`
        UPDATE archive_deletions
        SET status='preparing', started_at=?, updated_at=?, last_error=NULL
        WHERE id=? AND status='preview' AND expires_at>?
      `).run(now, now, id, now).changes;
      if (changed === 1) {
        this.db.db.prepare("UPDATE archive_deleted_sources SET status='preparing' WHERE deletion_id=? AND status='preview'").run(id);
        this.refreshProjectionForDeletionIds([id, ...failedPredecessors.map((item) => item.id)]);
      }
      return changed === 1;
    })();
    if (!claimed) {
      const existing = this.getAccountOperation(operation.userId);
      if (existing && ["preparing", "config_removing", "pending", "running", "retry_wait"].includes(existing.status)) {
        return { operation: existing, claimed: false };
      }
      throw archiveDeletionError("账号归档清理已由其他请求处理，请刷新状态", 409);
    }
    this.syncMaintenanceState();
    return { operation: this.get(id)!, claimed: true };
  }

  completeAccountPreparation(id: string) {
    const current = this.get(id);
    if (!current) throw archiveDeletionError("账号归档清理任务不存在", 404);
    if (["pending", "running", "retry_wait", "completed"].includes(current.status)) return current;
    if (current.scope !== "account" || !["preparing", "config_removing"].includes(current.status)) {
      throw archiveDeletionError("账号归档清理尚未取得准备权", 409);
    }
    if (current.status === "preparing") this.validateAccountPreparation(id);
    const now = this.now();
    this.db.db.transaction(() => {
      const changed = this.db.db.prepare(`
        UPDATE archive_deletions SET status='pending', updated_at=?, last_error=NULL
        WHERE id=? AND status IN ('preparing','config_removing')
      `).run(now, id).changes;
      if (changed !== 1) throw archiveDeletionError("账号归档清理准备状态已变化", 409);
      this.db.db.prepare("UPDATE archive_deleted_sources SET status='pending' WHERE deletion_id=? AND status IN ('preparing','config_removing')").run(id);
      this.jobStore.enqueue({
        kind: "archive_delete",
        dedupeKey: `archive-delete:${id}`,
        userId: current.userId,
        priority: 5,
        payload: { deletionId: id },
        maxAttempts: 4,
        notBefore: now,
      });
      this.refreshProjectionForDeletionIds([id]);
    })();
    this.stateManager.reload();
    this.syncMaintenanceState();
    this.schedule();
    return this.get(id)!;
  }

  validateAccountPreparation(id: string) {
    const operation = this.get(id);
    if (!operation || operation.scope !== "account" || !["preparing", "config_removing"].includes(operation.status)) {
      throw archiveDeletionError("账号归档清理准备状态已变化", 409);
    }
    const config = this.configStore.get();
    const row = this.db.db.prepare("SELECT alist_identity_hash, archive_root FROM archive_deletions WHERE id=?").get(id) as any;
    if (row.alist_identity_hash !== alistIdentityHash(config)
      || normalizeRemotePath(row.archive_root) !== normalizeRemotePath(config.alistDest)) {
      throw archiveDeletionError("AList连接或归档路径已变化，请重新预览", 409);
    }
    if (operation.conflictCount > 0) throw archiveDeletionError("本地归档证明存在冲突，请重新同步或修复证明后再预览", 409);
    this.assertRemainingProofsStillCurrent(id);
    return operation;
  }

  abortAccountPreparation(id: string, reason = "账号归档清理准备已中断，请重新确认") {
    const now = this.now();
    const changed = this.db.db.transaction(() => {
      const updated = this.db.db.prepare(`
        UPDATE archive_deletions
        SET status='preview', expires_at=?, started_at=NULL, updated_at=?, last_error=?
        WHERE id=? AND status IN ('preparing','config_removing')
      `).run(now + PREVIEW_TTL_MS, now, safeDeletionError(reason), id).changes;
      if (updated === 1) {
        this.db.db.prepare("UPDATE archive_deleted_sources SET status='preview' WHERE deletion_id=? AND status IN ('preparing','config_removing')").run(id);
        this.refreshProjectionForDeletionIds([id]);
      }
      return updated === 1;
    })();
    this.syncMaintenanceState();
    return changed;
  }

  beginAccountConfigRemoval(id: string) {
    const now = this.now();
    const changed = this.db.db.transaction(() => {
      const updated = this.db.db.prepare(`
        UPDATE archive_deletions
        SET status='config_removing', updated_at=?, last_error=NULL
        WHERE id=? AND scope='account' AND status='preparing'
      `).run(now, id).changes;
      if (updated === 1) {
        this.db.db.prepare(`
          UPDATE archive_deleted_sources SET status='config_removing'
          WHERE deletion_id=? AND status='preparing'
        `).run(id);
        this.refreshProjectionForDeletionIds([id]);
      }
      return updated === 1;
    })();
    if (!changed) throw archiveDeletionError("账号归档清理准备状态已变化", 409);
    this.syncMaintenanceState();
    return this.get(id)!;
  }

  recordAccountPreparationError(id: string, error: unknown) {
    this.db.db.prepare(`
      UPDATE archive_deletions SET last_error=?, updated_at=?
      WHERE id=? AND status IN ('preparing','config_removing')
    `).run(safeDeletionError(error, "账号归档清理准备失败"), this.now(), id);
  }

  private recoverAccountPreparations() {
    const rows = this.db.db.prepare(`
      SELECT id, user_id FROM archive_deletions
      WHERE scope='account' AND status IN ('preparing','config_removing')
      ORDER BY created_at, id
    `).all() as Array<{ id: string; user_id: string }>;
    for (const row of rows) {
      const userId = String(row.user_id);
      const accountRemoved = !this.userStore.getById(userId);
      try {
        if (accountRemoved) {
          this.onAccountPreparationRecovery(userId, true);
          this.markAccountRemoved(userId);
          this.completeAccountPreparation(String(row.id));
        } else {
          this.abortAccountPreparation(String(row.id), "上次账号归档清理准备被中断，请重新确认");
          this.restoreAccount(userId);
          this.onAccountPreparationRecovery(userId, false);
        }
      } catch (error) {
        this.db.db.prepare(`
          UPDATE archive_deletions SET last_error=?, updated_at=?
          WHERE id=? AND status IN ('preparing','config_removing')
        `).run(safeDeletionError(error, "账号归档清理恢复失败"), this.now(), row.id);
      }
    }
  }

  start(id: string, confirmation: string) {
    const operation = this.validateStart(id, confirmation);
    if (operation.scope === "account") {
      throw archiveDeletionError("账号归档清理必须通过删除账号操作启动", 409);
    }
    const now = this.now();
    this.db.db.transaction(() => {
      const failedPredecessors = operation.scope === "account"
        ? this.db.db.prepare(`
            SELECT id FROM archive_deletions
            WHERE id<>? AND scope='account' AND user_id=? AND status='failed'
          `).all(id, operation.userId) as Array<{ id: string }>
        : this.db.db.prepare(`
            SELECT id FROM archive_deletions
            WHERE id<>? AND scope='source' AND user_id=? AND media_id=? AND bvid=? AND status='failed'
          `).all(id, operation.userId, operation.mediaId, operation.bvid) as Array<{ id: string }>;
      for (const predecessor of failedPredecessors) {
        this.db.db.prepare(`
          UPDATE archive_deletions
          SET status='superseded', last_error='已由重新预览后的清理任务替代', updated_at=?
          WHERE id=? AND status='failed'
        `).run(now, predecessor.id);
        this.db.db.prepare("UPDATE archive_deleted_sources SET status='superseded' WHERE deletion_id=? AND status='failed'")
          .run(predecessor.id);
      }
      this.db.db.prepare(`UPDATE archive_deletions SET status='pending', started_at=?, updated_at=?, last_error=NULL WHERE id=? AND status='preview'`).run(now, now, id);
      this.db.db.prepare("UPDATE archive_deleted_sources SET status='pending' WHERE deletion_id=?").run(id);
      this.jobStore.enqueue({
        kind: "archive_delete",
        dedupeKey: `archive-delete:${id}`,
        userId: operation.userId,
        mediaId: operation.mediaId,
        bvid: operation.bvid,
        priority: 5,
        payload: { deletionId: id },
        maxAttempts: 4,
        notBefore: now,
      });
      this.refreshProjectionForDeletionIds([id, ...failedPredecessors.map((item) => item.id)]);
    })();
    this.stateManager.reload();
    this.syncMaintenanceState();
    this.schedule();
    return this.get(id)!;
  }

  validateStart(id: string, confirmation: string) {
    const operation = this.get(id);
    if (!operation) throw archiveDeletionError("归档清理预览不存在", 404);
    if (operation.status === "expired"
      || (operation.status === "preview" && Number(operation.expiresAt || 0) <= this.now())) {
      throw archiveDeletionError("预览已过期，请重新预览", 409);
    }
    if (operation.status !== "preview") throw archiveDeletionError("归档清理已开始或预览已失效", 409);
    const required = operation.scope === "account" ? "DELETE REMOTE ARCHIVE" : "DELETE ARCHIVE";
    if (confirmation !== required) throw archiveDeletionError(`请输入 ${required} 确认删除`, 400);
    if (this.db.getActivePathMigration()) throw archiveDeletionError("归档路径迁移期间不能开始删除", 409);
    const config = this.configStore.get();
    const row = this.db.db.prepare("SELECT alist_identity_hash, archive_root FROM archive_deletions WHERE id=?").get(id) as any;
    if (row.alist_identity_hash !== alistIdentityHash(config)
      || normalizeRemotePath(row.archive_root) !== normalizeRemotePath(config.alistDest)) {
      throw archiveDeletionError("AList连接或归档路径已变化，请重新预览", 409);
    }
    if (this.db.hasActiveArchiveDeletion()) throw archiveDeletionError("已有归档清理任务正在执行", 409);
    if (operation.conflictCount > 0) throw archiveDeletionError("本地归档证明存在冲突，请重新同步或修复证明后再预览", 409);
    this.assertRemainingProofsStillCurrent(id);
    if (operation.scope === "source") {
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
    }
    return operation;
  }

  retry(id: string) {
    const operation = this.get(id);
    if (!operation) throw archiveDeletionError("归档清理任务不存在", 404);
    if (operation.status !== "failed") throw archiveDeletionError("当前归档清理不需要重试", 409);
    if (this.db.getActivePathMigration() || this.db.hasActiveArchiveDeletion()) {
      throw archiveDeletionError("当前存在其他维护任务，暂时不能重试", 409);
    }
    this.assertRemainingProofsStillCurrent(id);
    const config = this.configStore.get();
    const row = this.db.db.prepare("SELECT alist_identity_hash, archive_root FROM archive_deletions WHERE id=?").get(id) as any;
    if (row.alist_identity_hash !== alistIdentityHash(config)
      || normalizeRemotePath(row.archive_root) !== normalizeRemotePath(config.alistDest)) {
      throw archiveDeletionError("AList连接或归档路径已变化，请重新预览", 409);
    }
    if (operation.scope === "source") {
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
    }
    const now = this.now();
    this.db.db.transaction(() => {
      this.db.db.prepare(`
        UPDATE archive_deletion_items SET status='pending', last_error=NULL, next_attempt_at=0, updated_at=?
        WHERE deletion_id=? AND status NOT IN ('deleted','missing','retained')
      `).run(now, id);
      this.db.db.prepare("UPDATE archive_deletions SET status='pending', last_error=NULL, conflict_count=0, failed_count=0, updated_at=? WHERE id=?").run(now, id);
      this.db.db.prepare("UPDATE archive_deleted_sources SET status='pending' WHERE deletion_id=? AND status<>'completed'").run(id);
      this.jobStore.enqueue({ kind: "archive_delete", dedupeKey: `archive-delete:${id}`, userId: operation.userId, mediaId: operation.mediaId, bvid: operation.bvid, priority: 5, payload: { deletionId: id }, maxAttempts: 4, notBefore: now });
      this.refreshProjectionForDeletionIds([id]);
    })();
    this.syncMaintenanceState();
    this.schedule();
    return this.get(id)!;
  }

  private assertSourceStillDeletable(userId: string, mediaId: number, bvid: string) {
    const row = this.db.db.prepare("SELECT active_in_favorite FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?").get(userId, mediaId, bvid) as any;
    if (!row) throw archiveDeletionError("归档来源已不存在", 409);
    const live = this.userStore.getById(userId);
    const selected = Boolean(live?.favorites.some((folder) => folder.mediaId === mediaId));
    if (selected && Number(row.active_in_favorite) === 1) throw archiveDeletionError("该视频已重新进入当前同步收藏夹，请刷新归档库", 409);
  }

  private currentProofs(id: string) {
    const rows = this.db.db.prepare(`
      WITH selected AS (
        SELECT rf.remote_path, rf.bvid, rf.expected_size
        FROM remote_files rf
        JOIN archive_deleted_sources s
          ON s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
        WHERE rf.status='verified'
      )
      SELECT remote_path, bvid, expected_size FROM selected
      UNION ALL
      SELECT rf.remote_path, rf.bvid, rf.expected_size
      FROM remote_files rf
      WHERE rf.status='verified' AND rf.user_id='' AND rf.media_id=0
        AND EXISTS(
          SELECT 1 FROM selected s WHERE s.remote_path=rf.remote_path AND s.bvid=rf.bvid
        )
      ORDER BY remote_path, bvid, expected_size
    `).all(id) as any[];
    const grouped = new Map<string, { bvids: Set<string>; sizes: Set<number>; invalidSize: boolean }>();
    for (const row of rows) {
      const remotePath = normalizeRemotePath(row.remote_path);
      const group = grouped.get(remotePath) || { bvids: new Set<string>(), sizes: new Set<number>(), invalidSize: false };
      group.bvids.add(String(row.bvid));
      const size = finiteSize(row.expected_size);
      if (size === undefined) group.invalidSize = true;
      else group.sizes.add(size);
      grouped.set(remotePath, group);
    }
    return new Map([...grouped].map(([remotePath, proof]) => [
      remotePath,
      proof.bvids.size === 1 && proof.sizes.size === 1 && !proof.invalidSize ? [...proof.sizes][0] : undefined,
    ]));
  }

  private assertPreviewStillCurrent(id: string) {
    if (!this.previewProofsMatch(id)) {
      throw archiveDeletionError("本地归档证明已变化，请重新预览", 409);
    }
  }

  private assertRemainingProofsStillCurrent(id: string) {
    if (!this.previewProofsMatch(id, true)) {
      throw archiveDeletionError("剩余归档证明已变化，请重新预览", 409);
    }
  }

  private previewProofsMatch(id: string, remainingOnly = false) {
    const expected = new Map((this.db.db.prepare(`
      SELECT remote_path, expected_size FROM archive_deletion_items
      WHERE deletion_id=? ${remainingOnly ? "AND status NOT IN ('deleted','missing','retained')" : ""}
      ORDER BY remote_path
    `).all(id) as any[]).map((row) => [normalizeRemotePath(row.remote_path), finiteSize(row.expected_size)]));
    const current = this.currentProofs(id);
    if (expected.size !== current.size) return false;
    for (const [remotePath, expectedSize] of expected) {
      if (expectedSize === undefined || current.get(remotePath) !== expectedSize) {
        return false;
      }
    }
    return true;
  }

  private markSourcesDeleting(deletionId: string, now: number) {
    const rows = this.db.db.prepare(`
      SELECT r.user_id, r.media_id, r.bvid, r.payload_json
      FROM favorite_relations r JOIN archive_deleted_sources s
        ON s.deletion_id=? AND s.user_id=r.user_id AND s.media_id=r.media_id AND s.bvid=r.bvid
    `).all(deletionId) as any[];
    const update = this.db.db.prepare(`
      UPDATE favorite_relations SET backup_status='lost', next_remote_check_at=NULL,
        payload_json=?, updated_at=? WHERE user_id=? AND media_id=? AND bvid=?
    `);
    for (const row of rows) {
      const relation = parseJson<any>(row.payload_json, {});
      relation.backupStatus = "lost";
      relation.statusUpdatedAt = new Date(now).toISOString();
      relation.nextRemoteCheckAt = undefined;
      relation.lastError = "归档正在由用户手动清理。";
      update.run(JSON.stringify(relation), now, row.user_id, row.media_id, row.bvid);
    }
  }

  private schedule() {
    if (this.stopped || this.worker) return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const due = this.db.db.prepare(`
      SELECT MIN(not_before) AS due FROM jobs
      WHERE kind='archive_delete' AND status IN ('pending','retry_wait')
    `).get() as any;
    if (due?.due == null) return;
    const delay = Math.max(0, Number(due.due) - this.now());
    if (delay > 0) {
      this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.schedule(); }, Math.min(delay, 60_000));
      this.wakeTimer.unref?.();
      return;
    }
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      this.syncMaintenanceState();
      this.schedule();
    });
  }

  private async runWorker() {
    const [job] = this.jobStore.claimDue(["archive_delete"], 1, this.leaseOwner, 30 * 60_000, this.now());
    if (!job) return;
    if (!this.jobStore.markRunning(job.id, this.leaseOwner, 30 * 60_000)) return;
    const deletionId = String(job.payload?.deletionId || "");
    const operation = this.get(deletionId);
    if (!operation) {
      this.jobStore.complete(job.id, this.leaseOwner);
      return;
    }
    this.setMaintenance(true, {
      id: deletionId,
      status: "running",
      scope: operation.scope,
      userId: operation.userId,
      mediaId: operation.mediaId,
      bvid: operation.bvid,
    });
    this.leaseTimer = setInterval(() => this.jobStore.extendLease(job.id, this.leaseOwner, 30 * 60_000), 60_000);
    this.leaseTimer.unref?.();
    try {
      await this.processOperation(deletionId);
      this.jobStore.complete(job.id, this.leaseOwner);
    } catch (error: any) {
      const summary = safeDeletionError(error, "归档清理失败");
      const transient = Boolean(error?.transient || isTransientError(error));
      const attempt = Number(job.attempts || 0);
      if (transient && attempt < RETRY_DELAYS_MS.length) {
        const nextAt = this.now() + RETRY_DELAYS_MS[attempt];
        const result = this.jobStore.retry(job.id, this.leaseOwner, summary, nextAt);
        this.setOperationFailure(deletionId, result.exhausted ? "failed" : "retry_wait", summary);
      } else {
        this.jobStore.complete(job.id, this.leaseOwner);
        this.setOperationFailure(deletionId, "failed", summary);
      }
    } finally {
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  private setOperationFailure(id: string, status: "retry_wait" | "failed", error: string) {
    const now = this.now();
    const counts = this.itemCounts(id);
    const bvids = (this.db.db.prepare("SELECT DISTINCT bvid FROM archive_deleted_sources WHERE deletion_id=?").all(id) as Array<{ bvid: string }>)
      .map((row) => String(row.bvid));
    this.db.db.transaction(() => {
      this.db.db.prepare(`
        UPDATE archive_deletions SET status=?, last_error=?, conflict_count=?, failed_count=?, updated_at=? WHERE id=?
      `).run(status, error.slice(0, 1000), counts.conflict, counts.failed, now, id);
      this.db.db.prepare("UPDATE archive_deleted_sources SET status=? WHERE deletion_id=? AND status<>'completed'").run(status, id);
      this.recomputeVideoAggregates(bvids, now);
    })();
    this.db.refreshArchiveLibraryProjection(bvids);
  }

  private itemCounts(id: string) {
    const rows = this.db.db.prepare("SELECT status, COUNT(*) AS count FROM archive_deletion_items WHERE deletion_id=? GROUP BY status").all(id) as any[];
    const counts = Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count || 0)]));
    return {
      completed: Number(counts.deleted || 0) + Number(counts.missing || 0) + Number(counts.retained || 0),
      retained: Number(counts.retained || 0),
      conflict: Number(counts.conflict || 0),
      failed: Number(counts.failed || 0),
    };
  }

  private async processOperation(id: string) {
    const operation = this.get(id);
    if (!operation) throw archiveDeletionError("归档清理任务不存在", 404);
    if (operation.scope === "source") {
      if (this.prepareSourceDeletion) {
        await this.prepareSourceDeletion(operation.userId, operation.mediaId!, operation.bvid!);
      }
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
    }
    this.assertRemainingProofsStillCurrent(id);
    const config = this.configStore.get();
    const row = this.db.db.prepare("SELECT alist_identity_hash, archive_root FROM archive_deletions WHERE id=?").get(id) as any;
    const root = normalizeRemotePath(row.archive_root);
    if (row.alist_identity_hash !== alistIdentityHash(config) || root !== normalizeRemotePath(config.alistDest)) {
      throw archiveDeletionError("AList连接或归档路径与预览不一致", 409, false);
    }
    const now = this.now();
    this.db.db.prepare("UPDATE archive_deletions SET status='running', updated_at=?, last_error=NULL WHERE id=?").run(now, id);
    this.db.db.prepare("UPDATE archive_deleted_sources SET status='running' WHERE deletion_id=? AND status<>'completed'").run(id);
    const client = this.clientFactory(config);
    const resolver = createRemoteFileResolver(client);
    const items = this.db.db.prepare("SELECT * FROM archive_deletion_items WHERE deletion_id=? ORDER BY remote_path").all(id) as any[];
    const sharedPaths = this.externalReferencePaths(id);
    const resolvedRemotePaths = new Map<string, string>();
    let preflightConflict = false;
    for (const item of items) {
      if (TERMINAL_ITEM_STATUSES.has(String(item.status))) continue;
      const remotePath = normalizeRemotePath(item.remote_path);
      if (!isWithin(root, remotePath) || remotePath === root) {
        this.updateItem(id, remotePath, "conflict", "归档文件超出允许的远端路径边界");
        preflightConflict = true;
        continue;
      }
      const shared = sharedPaths.has(remotePath);
      const expectedSize = finiteSize(item.expected_size);
      if (expectedSize === undefined) {
        this.updateItem(id, remotePath, "conflict", "缺少可验证的文件大小证明");
        preflightConflict = true;
        continue;
      }
      try {
        const observed = await resolver.inspect(remotePath, { fallback: "always" });
        const remoteSize = finiteSize(observed.size);
        if (observed.status === "missing") {
          this.markItemTerminal(id, remotePath, "missing");
        } else if (observed.directory || remoteSize !== expectedSize) {
          this.updateItem(id, remotePath, "conflict", "远端文件类型或大小与归档证明不一致");
          preflightConflict = true;
        } else {
          resolvedRemotePaths.set(remotePath, observed.path);
          this.updateItem(id, remotePath, shared ? "shared_verified" : "verified", undefined);
        }
      } catch (error: any) {
        if (isRemoteNotFoundError(error)) {
          this.updateItem(id, remotePath, "missing", undefined);
        } else if (isTransientError(error)) {
          this.updateItem(id, remotePath, "failed", safeDeletionError(error));
          throw archiveDeletionError("远端预检暂时失败", statusCode(error) || 503, true);
        } else {
          this.updateItem(id, remotePath, "conflict", "远端文件无法安全核验");
          preflightConflict = true;
        }
      }
    }
    if (preflightConflict) throw archiveDeletionError("远端文件与预览证明不一致，未开始删除", 409, false);
    const sharedVerified = this.db.db.prepare("SELECT remote_path FROM archive_deletion_items WHERE deletion_id=? AND status='shared_verified' ORDER BY remote_path")
      .all(id) as Array<{ remote_path: string }>;
    for (const item of sharedVerified) this.markItemTerminal(id, normalizeRemotePath(item.remote_path), "retained");
    this.syncOperationCounts(id);
    const verified = this.db.db.prepare("SELECT * FROM archive_deletion_items WHERE deletion_id=? AND status='verified' ORDER BY remote_path").all(id) as any[];
    for (const item of verified) {
      const remotePath = normalizeRemotePath(item.remote_path);
      const accessPath = resolvedRemotePaths.get(remotePath) || remotePath;
      this.updateItem(id, remotePath, "deleting", undefined, true);
      try {
        await client.deleteFile(accessPath);
      } catch (error: any) {
        if (!isRemoteNotFoundError(error)) {
          this.updateItem(id, remotePath, "failed", safeDeletionError(error), true);
          throw archiveDeletionError("远端文件删除暂时失败", statusCode(error) || 503, isTransientError(error));
        }
      }
      resolver.clear();
      const missing = await this.confirmMissing(client, remotePath, resolver);
      if (!missing) {
        this.updateItem(id, remotePath, "failed", "删除后远端文件仍然可见", true);
        throw archiveDeletionError("删除后远端文件仍然可见", 503, true);
      }
      this.markItemTerminal(id, remotePath, "deleted");
    }
    this.finalizeOperation(id);
  }

  private externalReferencePaths(deletionId: string) {
    const rows = this.db.db.prepare(`
      SELECT DISTINCT rf.remote_path
      FROM archive_deletion_items i
      JOIN remote_files rf ON rf.remote_path=i.remote_path AND rf.user_id<>''
      WHERE i.deletion_id=? AND NOT EXISTS(
        SELECT 1 FROM archive_deleted_sources s
        WHERE s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
      )
    `).all(deletionId, deletionId) as Array<{ remote_path: string }>;
    return new Set(rows.map((row) => normalizeRemotePath(row.remote_path)));
  }

  private syncOperationCounts(id: string) {
    const counts = this.itemCounts(id);
    this.db.db.prepare(`
      UPDATE archive_deletions SET completed_count=?, retained_count=?, conflict_count=?, failed_count=?, updated_at=? WHERE id=?
    `).run(counts.completed, counts.retained, counts.conflict, counts.failed, this.now(), id);
  }

  private reconcileSourceProofsForPath(id: string, remotePath: string, now: number) {
    const sourceRows = this.db.db.prepare(`
      SELECT s.user_id, s.media_id, s.bvid, r.payload_json AS relation_json
      FROM archive_deleted_sources s
      LEFT JOIN favorite_relations r
        ON r.user_id=s.user_id AND r.media_id=s.media_id AND r.bvid=s.bvid
      WHERE s.deletion_id=?
        AND EXISTS(
          SELECT 1 FROM remote_files rf
          WHERE rf.user_id=s.user_id AND rf.media_id=s.media_id AND rf.bvid=s.bvid
            AND rf.remote_path=?
        )
    `).all(id, remotePath) as any[];
    const deleteSourceProof = this.db.db.prepare(`
      DELETE FROM remote_files
      WHERE user_id=? AND media_id=? AND bvid=? AND remote_path=?
    `);
    const updateRelation = this.db.db.prepare(`
      UPDATE favorite_relations
      SET backup_status=?, payload_json=?, last_remote_check_at=?, next_remote_check_at=NULL, updated_at=?
      WHERE user_id=? AND media_id=? AND bvid=?
    `);
    const bvids = new Set<string>();
    const checkedAt = new Date(now).toISOString();
    for (const source of sourceRows) {
      deleteSourceProof.run(source.user_id, source.media_id, source.bvid, remotePath);
      if (!source.relation_json) continue;
      const relation = parseJson<any>(source.relation_json, {});
      const originalFiles = Array.isArray(relation.remoteFiles) ? relation.remoteFiles : [];
      const remainingFiles = originalFiles.filter((file: any) => {
        try {
          return normalizeRemotePath(String(file?.path || "")) !== remotePath;
        } catch {
          return String(file?.path || "") !== remotePath;
        }
      });
      if (remainingFiles.length > 0) {
        relation.remoteFiles = remainingFiles;
        relation.remotePath = relation.remotePath || path.posix.dirname(String(remainingFiles[0]?.path || remotePath));
        relation.backupStatus = originalFiles.length === remainingFiles.length ? relation.backupStatus : "partial_verified";
        relation.pendingPartialBackup = relation.backupStatus === "partial_verified" || undefined;
        relation.remoteMissingCount = 0;
        relation.lastError = "归档清理未完全完成，剩余文件仍可播放。";
      } else {
        delete relation.remotePath;
        delete relation.remoteFiles;
        delete relation.uploadedAt;
        delete relation.verifiedAt;
        delete relation.lastRemoteCheckAt;
        delete relation.nextRemoteCheckAt;
        relation.pendingPartialBackup = undefined;
        relation.remoteMissingCount = 0;
        relation.backupStatus = "lost";
        relation.lastError = "归档文件已删除或远端已不存在。";
      }
      relation.lastRemoteCheckAt = checkedAt;
      relation.nextRemoteCheckAt = undefined;
      relation.statusUpdatedAt = checkedAt;
      updateRelation.run(
        relation.backupStatus || "lost",
        JSON.stringify(relation),
        now,
        now,
        source.user_id,
        source.media_id,
        source.bvid,
      );
      bvids.add(String(source.bvid));
    }
    this.db.db.prepare(`
      DELETE FROM remote_files
      WHERE user_id='' AND media_id=0 AND remote_path=?
        AND NOT EXISTS(
          SELECT 1 FROM remote_files linked
          WHERE linked.remote_path=remote_files.remote_path AND linked.user_id<>''
        )
    `).run(remotePath);
    if (bvids.size > 0) this.recomputeVideoAggregates([...bvids], now);
  }

  private markItemTerminal(id: string, remotePath: string, status: "deleted" | "missing" | "retained") {
    const now = this.now();
    this.db.db.transaction(() => {
      const changed = this.db.db.prepare(`
        UPDATE archive_deletion_items SET status=?, last_error=NULL, updated_at=?
        WHERE deletion_id=? AND remote_path=? AND status IN ('pending','verified','shared_verified','deleting','failed')
      `).run(status, now, id, remotePath).changes;
      if (changed === 1) {
        this.reconcileSourceProofsForPath(id, remotePath, now);
        this.db.db.prepare(`
          UPDATE archive_deletions SET completed_count=completed_count+1,
            retained_count=retained_count+?, updated_at=? WHERE id=?
        `).run(status === "retained" ? 1 : 0, now, id);
      }
    })();
  }

  private updateItem(id: string, remotePath: string, status: string, error?: string, incrementAttempt = false) {
    this.db.db.prepare(`
      UPDATE archive_deletion_items SET status=?, attempts=attempts+?, last_error=?, updated_at=?
      WHERE deletion_id=? AND remote_path=?
    `).run(status, incrementAttempt ? 1 : 0, error ? safeDeletionError(error) : null, this.now(), id, remotePath);
  }

  private async confirmMissing(
    client: ArchiveDeletionDavClient,
    remotePath: string,
    resolver?: ReturnType<typeof createRemoteFileResolver>,
  ) {
    for (const delay of [0, 250, 750, 1500]) {
      if (delay) await this.sleep(delay);
      try {
        if (resolver) {
          resolver.clear();
          const observed = await resolver.inspect(remotePath, { fallback: "risk_only" });
          if (observed.status === "missing") return true;
        } else {
          await client.stat(remotePath);
        }
      } catch (error) {
        if (isRemoteNotFoundError(error)) return true;
        if (!isTransientError(error)) throw error;
      }
    }
    return false;
  }

  private finalizeOperation(id: string) {
    const now = this.now();
    const iso = new Date(now).toISOString();
    let restoredLiveAccount: string | undefined;
    this.db.db.transaction(() => {
      const sourceRows = this.db.db.prepare(`
        SELECT s.*, r.payload_json AS relation_json
        FROM archive_deleted_sources s
        LEFT JOIN favorite_relations r
          ON r.user_id=s.user_id AND r.media_id=s.media_id AND r.bvid=s.bvid
        WHERE s.deletion_id=?
        ORDER BY s.user_id, s.media_id, s.bvid
      `).all(id) as any[];
      const fileRows = this.db.db.prepare(`
        SELECT rf.user_id, rf.media_id, rf.bvid, rf.remote_path, rf.expected_size,
          i.status AS item_status
        FROM remote_files rf
        JOIN archive_deleted_sources s
          ON s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
        LEFT JOIN archive_deletion_items i
          ON i.deletion_id=s.deletion_id AND i.remote_path=rf.remote_path
        ORDER BY rf.user_id, rf.media_id, rf.bvid, rf.remote_path
      `).all(id) as any[];
      const filesBySource = new Map<string, any[]>();
      for (const file of fileRows) {
        const key = `${file.user_id}\0${file.media_id}\0${file.bvid}`;
        const group = filesBySource.get(key) || [];
        group.push(file);
        filesBySource.set(key, group);
      }
      const updateRelation = this.db.db.prepare(`
        UPDATE favorite_relations SET backup_status='lost', active_in_favorite=0,
          last_remote_check_at=NULL, next_remote_check_at=NULL, payload_json=?, updated_at=?
        WHERE user_id=? AND media_id=? AND bvid=?
      `);
      const deleteSourceFiles = this.db.db.prepare("DELETE FROM remote_files WHERE user_id=? AND media_id=? AND bvid=?");
      const completeSource = this.db.db.prepare(`
        UPDATE archive_deleted_sources SET status='completed', deleted_at=?, file_count=?, total_bytes=?, retained_count=?
        WHERE deletion_id=? AND user_id=? AND media_id=? AND bvid=?
      `);
      const bvids = new Set<string>();
      for (const source of sourceRows) {
        if (!source.relation_json) continue;
        const relation = parseJson<any>(source.relation_json, {});
        const sourceFiles = filesBySource.get(`${source.user_id}\0${source.media_id}\0${source.bvid}`) || [];
        const totalBytes = sourceFiles.reduce((sum, file) => sum + Number(file.expected_size || 0), 0);
        const retainedCount = sourceFiles.filter((file) => file.item_status === "retained").length;
        delete relation.remotePath;
        delete relation.remoteFiles;
        delete relation.uploadedAt;
        delete relation.verifiedAt;
        delete relation.lastRemoteCheckAt;
        delete relation.nextRemoteCheckAt;
        relation.remoteMissingCount = 0;
        relation.activeInFavorite = false;
        relation.backupStatus = "lost";
        relation.statusUpdatedAt = iso;
        relation.lastError = "归档已由用户手动删除。";
        updateRelation.run(JSON.stringify(relation), now, source.user_id, source.media_id, source.bvid);
        deleteSourceFiles.run(source.user_id, source.media_id, source.bvid);
        completeSource.run(now, sourceFiles.length, totalBytes, retainedCount, id, source.user_id, source.media_id, source.bvid);
        bvids.add(String(source.bvid));
      }
      this.db.db.prepare(`
        DELETE FROM remote_files
        WHERE user_id='' AND media_id=0
          AND EXISTS(
            SELECT 1 FROM archive_deletion_items i
            WHERE i.deletion_id=? AND i.remote_path=remote_files.remote_path
          )
          AND NOT EXISTS(
            SELECT 1 FROM remote_files linked
            WHERE linked.remote_path=remote_files.remote_path AND linked.user_id<>''
          )
      `).run(id);
      this.recomputeVideoAggregates([...bvids], now);
      const counts = this.itemCounts(id);
      this.db.db.prepare(`
        UPDATE archive_deletions SET status='completed', completed_count=?, retained_count=?,
          conflict_count=0, failed_count=0, last_error=NULL, updated_at=?, completed_at=? WHERE id=?
      `).run(counts.completed, counts.retained, now, now, id);
      this.db.refreshArchiveLibraryProjection(bvids);
      const operation = this.db.db.prepare("SELECT scope, user_id FROM archive_deletions WHERE id=?").get(id) as any;
      if (operation?.scope === "account" && this.userStore.getById(String(operation.user_id))) {
        this.db.db.prepare("DELETE FROM archive_accounts WHERE user_id=?").run(operation.user_id);
        restoredLiveAccount = String(operation.user_id);
      }
    })();
    this.stateManager.reload();
    if (restoredLiveAccount) this.onAccountDeletionCompleted(restoredLiveAccount);
  }

  private recomputeVideoAggregates(bvids: string[], now: number) {
    const update = this.db.db.prepare("UPDATE videos SET backup_status=?, payload_json=?, updated_at=? WHERE bvid=?");
    for (let offset = 0; offset < bvids.length; offset += 300) {
      const chunk = bvids.slice(offset, offset + 300);
      const placeholders = chunk.map(() => "?").join(",");
      const videos = this.db.db.prepare(`SELECT bvid, payload_json FROM videos WHERE bvid IN (${placeholders})`).all(...chunk) as any[];
      const relationRows = this.db.db.prepare(`
        SELECT bvid, backup_status, payload_json FROM favorite_relations
        WHERE bvid IN (${placeholders}) ORDER BY bvid, updated_at DESC
      `).all(...chunk) as any[];
      const relationsByBvid = new Map<string, Array<{ status: string; relation: any }>>();
      for (const row of relationRows) {
        const key = String(row.bvid);
        const group = relationsByBvid.get(key) || [];
        group.push({ status: String(row.backup_status), relation: parseJson<any>(row.payload_json, {}) });
        relationsByBvid.set(key, group);
      }
      for (const row of videos) {
        const bvid = String(row.bvid);
        const video = parseJson<any>(row.payload_json, {});
        const relations = relationsByBvid.get(bvid) || [];
        const verified = relations.find((item) => ["verified", "partial_verified"].includes(item.status)
          && Array.isArray(item.relation.remoteFiles) && item.relation.remoteFiles.length > 0);
        if (verified) {
          video.remotePath = verified.relation.remotePath;
          video.remoteFiles = verified.relation.remoteFiles;
          video.uploadedAt = verified.relation.uploadedAt;
          video.verifiedAt = verified.relation.verifiedAt;
          video.lastRemoteCheckAt = verified.relation.lastRemoteCheckAt;
          video.backupStatus = verified.status;
          video.lastError = undefined;
        } else {
          delete video.remotePath;
          delete video.remoteFiles;
          delete video.uploadedAt;
          delete video.verifiedAt;
          delete video.lastRemoteCheckAt;
          delete video.nextRemoteCheckAt;
          const priority = ["uploading", "upload_failed", "downloading", "downloaded", "queued", "missing", "failed", "charging_restricted", "discovered", "lost"];
          video.backupStatus = priority.find((status) => relations.some((item) => item.status === status)) || "lost";
          video.lastError = "归档已由用户手动删除。";
        }
        video.statusUpdatedAt = new Date(now).toISOString();
        update.run(video.backupStatus, JSON.stringify(video), now, bvid);
      }
    }
  }

  async stop(timeoutMs = 20_000) {
    this.stopped = true;
    if (this.previewCleanupTimer) clearInterval(this.previewCleanupTimer);
    this.previewCleanupTimer = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (!this.worker) {
      this.jobStore.releaseOwner(this.leaseOwner);
      return true;
    }
    const completed = await Promise.race([
      this.worker.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(1, timeoutMs))),
    ]);
    if (completed) this.jobStore.releaseOwner(this.leaseOwner);
    return completed;
  }
}
