import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig, ConfigStore } from "./config.js";
import type { StateDatabase } from "./database.js";
import { safeErrorSummary } from "./diagnostics.js";
import { PersistentJobStore } from "./job-store.js";
import type { StateManager } from "./state.js";
import type { BiliUser, UserStore } from "./users.js";
import { buildDavClient, isRemoteNotFoundError } from "./uploader.js";

export type ArchiveDeletionScope = "account" | "source";
export type ArchiveDeletionStatus = "preview" | "pending" | "running" | "retry_wait" | "failed" | "completed" | "expired" | "superseded";

export interface ArchiveDeletionDavClient {
  stat(remotePath: string): Promise<any>;
  deleteFile(remotePath: string): Promise<any>;
  getDirectoryContents(remotePath: string): Promise<any>;
}

export interface ArchiveDeletionOptions {
  clientFactory?: (config: AppConfig) => ArchiveDeletionDavClient;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  setMaintenance?: (locked: boolean, summary?: { id: string; status: string; scope: string }) => void;
  isSchedulerIdle?: () => boolean;
  onAccountDeletionCompleted?: (userId: string) => void;
}

const PREVIEW_TTL_MS = 30 * 60_000;
const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000];
const TERMINAL_ITEM_STATUSES = new Set(["deleted", "missing", "retained"]);

function normalizeRemotePath(value: string) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  const normalized = `/${raw.split("/").filter(Boolean).join("/")}`;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw archiveDeletionError("远端路径包含非法片段", 409, false);
  }
  return normalized || "/";
}

function isWithin(root: string, target: string) {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function remoteDirname(value: string) {
  const normalized = normalizeRemotePath(value);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function remoteBasename(value: string) {
  return path.posix.basename(normalizeRemotePath(value));
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
  private readonly setMaintenance: NonNullable<ArchiveDeletionOptions["setMaintenance"]>;
  private readonly isSchedulerIdle: () => boolean;
  private readonly onAccountDeletionCompleted: NonNullable<ArchiveDeletionOptions["onAccountDeletionCompleted"]>;
  private readonly leaseOwner = `archive-delete:${crypto.randomUUID()}`;
  private worker: Promise<void> | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
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
    this.setMaintenance = options.setMaintenance || (() => undefined);
    this.isSchedulerIdle = options.isSchedulerIdle || (() => true);
    this.onAccountDeletionCompleted = options.onAccountDeletionCompleted || (() => undefined);
    this.jobStore.recoverExpiredLeases(this.now());
    this.reconcileArchiveAccounts();
    this.syncMaintenanceState();
    this.schedule();
  }

  rebind(database: StateDatabase) {
    this.db = database;
    this.jobStore.rebind(database);
    this.jobStore.recoverExpiredLeases(this.now());
    this.reconcileArchiveAccounts();
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

  forgetPendingAccount(userId: string) {
    this.db.db.prepare("DELETE FROM archive_accounts WHERE user_id=? AND removed_at IS NULL").run(userId);
  }

  reconcileArchiveAccounts() {
    const liveIds = new Set(this.userStore.list().map((user) => user.id));
    const now = this.now();
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
      SELECT id, status, scope FROM archive_deletions
      WHERE status IN ('pending','running','retry_wait')
      ORDER BY updated_at DESC LIMIT 1
    `).get() as any;
    if (row) {
      this.setMaintenance(true, { id: String(row.id), status: String(row.status), scope: String(row.scope) });
    } else {
      this.setMaintenance(false);
    }
  }

  private pruneExpiredPreviews() {
    const now = this.now();
    this.db.db.prepare("UPDATE archive_deletions SET status='expired', updated_at=? WHERE status='preview' AND expires_at<=?").run(now, now);
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
    if (scope === "source" && !this.isSchedulerIdle()) {
      throw archiveDeletionError("当前仍有同步、下载或上传任务，请等待任务空闲后再开始清理", 409);
    }
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
    this.db.db.transaction(() => {
      this.db.db.prepare(`
        INSERT INTO archive_deletions(
          id, scope, user_id, media_id, bvid, status, alist_identity_hash, archive_root,
          relation_count, source_count, expires_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,'preview',?,?,?,?,?,?,?)
      `).run(
        id, scope, userId, mediaId ?? null, bvid || null, alistIdentityHash(config), archiveRoot,
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
    })();
    return this.get(id)!;
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
    const activeTasks = Number((this.db.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs j
      WHERE j.kind<>'archive_delete' AND j.status IN ('pending','retry_wait','leased','running')
        AND (j.user_id=? OR (? IS NOT NULL AND j.user_id=? AND j.media_id=? AND j.bvid=?))
    `).get(row.user_id, row.media_id, row.user_id, row.media_id, row.bvid) as any)?.count || 0);
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

  start(id: string, confirmation: string) {
    const operation = this.validateStart(id, confirmation);
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
      this.markSourcesDeleting(id, now);
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
    })();
    this.stateManager.reload();
    this.syncMaintenanceState();
    this.schedule();
    return this.get(id)!;
  }

  validateStart(id: string, confirmation: string) {
    const operation = this.get(id);
    if (!operation) throw archiveDeletionError("归档清理预览不存在", 404);
    if (operation.status !== "preview") throw archiveDeletionError("归档清理已开始或预览已失效", 409);
    if (Number(operation.expiresAt || 0) <= this.now()) throw archiveDeletionError("归档清理预览已过期，请重新预览", 409);
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
    if (!this.isSchedulerIdle()) throw archiveDeletionError("当前仍有同步、下载或上传任务，请等待任务空闲后再开始清理", 409);
    if (operation.conflictCount > 0) throw archiveDeletionError("本地归档证明存在冲突，请重新同步或修复证明后再预览", 409);
    this.assertPreviewStillCurrent(id);
    if (operation.scope === "source") {
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
      if (operation.activeTasks > 0) throw archiveDeletionError("该归档来源仍有关联任务，请等待任务结束后再删除", 409);
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
    if (!this.isSchedulerIdle()) throw archiveDeletionError("当前仍有同步、下载或上传任务，请等待任务空闲后再重试", 409);
    this.assertPreviewStillCurrent(id);
    const config = this.configStore.get();
    const row = this.db.db.prepare("SELECT alist_identity_hash, archive_root FROM archive_deletions WHERE id=?").get(id) as any;
    if (row.alist_identity_hash !== alistIdentityHash(config)
      || normalizeRemotePath(row.archive_root) !== normalizeRemotePath(config.alistDest)) {
      throw archiveDeletionError("AList连接或归档路径已变化，请重新预览", 409);
    }
    if (operation.scope === "source") {
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
      if (operation.activeTasks > 0) throw archiveDeletionError("该归档来源仍有关联任务，请等待任务结束后再重试", 409);
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
    const expected = new Map((this.db.db.prepare(`
      SELECT remote_path, expected_size FROM archive_deletion_items WHERE deletion_id=? ORDER BY remote_path
    `).all(id) as any[]).map((row) => [normalizeRemotePath(row.remote_path), finiteSize(row.expected_size)]));
    const current = this.currentProofs(id);
    if (expected.size !== current.size) throw archiveDeletionError("本地归档证明已变化，请重新预览", 409);
    for (const [remotePath, expectedSize] of expected) {
      if (expectedSize === undefined || current.get(remotePath) !== expectedSize) {
        throw archiveDeletionError("本地归档证明已变化，请重新预览", 409);
      }
    }
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
    this.setMaintenance(true, { id: deletionId, status: "running", scope: operation.scope });
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
    this.db.db.transaction(() => {
      this.db.db.prepare(`
        UPDATE archive_deletions SET status=?, last_error=?, conflict_count=?, failed_count=?, updated_at=? WHERE id=?
      `).run(status, error.slice(0, 1000), counts.conflict, counts.failed, now, id);
      this.db.db.prepare("UPDATE archive_deleted_sources SET status=? WHERE deletion_id=? AND status<>'completed'").run(status, id);
    })();
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
    this.assertPreviewStillCurrent(id);
    if (operation.scope === "source") {
      this.assertSourceStillDeletable(operation.userId, operation.mediaId!, operation.bvid!);
      if (operation.activeTasks > 0) throw archiveDeletionError("该归档来源仍有关联任务，未开始删除", 409, false);
    }
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
    const items = this.db.db.prepare("SELECT * FROM archive_deletion_items WHERE deletion_id=? ORDER BY remote_path").all(id) as any[];
    let preflightConflict = false;
    for (const item of items) {
      if (TERMINAL_ITEM_STATUSES.has(String(item.status))) continue;
      const remotePath = normalizeRemotePath(item.remote_path);
      if (!isWithin(root, remotePath) || remotePath === root) {
        this.updateItem(id, remotePath, "conflict", "归档文件超出允许的远端路径边界");
        preflightConflict = true;
        continue;
      }
      const shared = this.hasExternalReference(id, remotePath);
      const expectedSize = finiteSize(item.expected_size);
      if (expectedSize === undefined) {
        this.updateItem(id, remotePath, "conflict", "缺少可验证的文件大小证明");
        preflightConflict = true;
        continue;
      }
      try {
        const stat = await client.stat(remotePath);
        const remoteSize = finiteSize(stat?.size);
        const type = String(stat?.type || "").toLowerCase();
        if (type !== "file" || remoteSize !== expectedSize) {
          this.updateItem(id, remotePath, "conflict", "远端文件类型或大小与归档证明不一致");
          preflightConflict = true;
        } else {
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
    this.db.db.prepare("UPDATE archive_deletion_items SET status='retained', updated_at=? WHERE deletion_id=? AND status='shared_verified'")
      .run(this.now(), id);
    const verified = this.db.db.prepare("SELECT * FROM archive_deletion_items WHERE deletion_id=? AND status='verified' ORDER BY remote_path").all(id) as any[];
    for (const item of verified) {
      const remotePath = normalizeRemotePath(item.remote_path);
      this.updateItem(id, remotePath, "deleting", undefined, true);
      try {
        await client.deleteFile(remotePath);
      } catch (error: any) {
        if (!isRemoteNotFoundError(error)) {
          this.updateItem(id, remotePath, "failed", safeDeletionError(error), true);
          throw archiveDeletionError("远端文件删除暂时失败", statusCode(error) || 503, isTransientError(error));
        }
      }
      const missing = await this.confirmMissing(client, remotePath);
      if (!missing) {
        this.updateItem(id, remotePath, "failed", "删除后远端文件仍然可见", true);
        throw archiveDeletionError("删除后远端文件仍然可见", 503, true);
      }
      this.updateItem(id, remotePath, "deleted", undefined);
      const counts = this.itemCounts(id);
      this.db.db.prepare(`
        UPDATE archive_deletions SET completed_count=?, retained_count=?, conflict_count=?, failed_count=?, updated_at=? WHERE id=?
      `).run(counts.completed, counts.retained, counts.conflict, counts.failed, this.now(), id);
    }
    await this.cleanupEmptyDirectories(client, root, id);
    this.finalizeOperation(id);
  }

  private hasExternalReference(deletionId: string, remotePath: string) {
    const row = this.db.db.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM remote_files rf
        WHERE rf.remote_path=? AND rf.user_id<>'' AND NOT EXISTS(
          SELECT 1 FROM archive_deleted_sources s
          WHERE s.deletion_id=? AND s.user_id=rf.user_id AND s.media_id=rf.media_id AND s.bvid=rf.bvid
        )
      ) AS shared
    `).get(remotePath, deletionId) as any;
    return Boolean(row?.shared);
  }

  private updateItem(id: string, remotePath: string, status: string, error?: string, incrementAttempt = false) {
    this.db.db.prepare(`
      UPDATE archive_deletion_items SET status=?, attempts=attempts+?, last_error=?, updated_at=?
      WHERE deletion_id=? AND remote_path=?
    `).run(status, incrementAttempt ? 1 : 0, error ? safeDeletionError(error) : null, this.now(), id, remotePath);
  }

  private async confirmMissing(client: ArchiveDeletionDavClient, remotePath: string) {
    for (const delay of [0, 250, 750, 1500]) {
      if (delay) await this.sleep(delay);
      try {
        await client.stat(remotePath);
      } catch (error) {
        if (isRemoteNotFoundError(error)) return true;
        if (!isTransientError(error)) throw error;
      }
    }
    return false;
  }

  private async cleanupEmptyDirectories(client: ArchiveDeletionDavClient, root: string, deletionId: string) {
    const rows = this.db.db.prepare(`
      SELECT remote_path FROM archive_deletion_items
      WHERE deletion_id=? AND status IN ('deleted','missing')
    `).all(deletionId) as any[];
    const directories = new Set<string>();
    for (const row of rows) {
      let current = remoteDirname(row.remote_path);
      while (current !== root && current !== "/" && isWithin(root, current)) {
        directories.add(current);
        current = remoteDirname(current);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a))) {
      try {
        const contents = await client.getDirectoryContents(directory);
        if (Array.isArray(contents) && contents.length === 0) await client.deleteFile(directory);
      } catch {
        // Empty-directory cleanup is best effort and never widens the deletion scope.
      }
    }
  }

  private finalizeOperation(id: string) {
    const now = this.now();
    const iso = new Date(now).toISOString();
    const sourceRows = this.db.db.prepare("SELECT * FROM archive_deleted_sources WHERE deletion_id=?").all(id) as any[];
    const bvids = new Set<string>();
    let restoredLiveAccount: string | undefined;
    this.db.db.transaction(() => {
      for (const source of sourceRows) {
        const relationRow = this.db.db.prepare("SELECT payload_json FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?")
          .get(source.user_id, source.media_id, source.bvid) as any;
        if (!relationRow) continue;
        const relation = parseJson<any>(relationRow.payload_json, {});
        const fileRows = this.db.db.prepare("SELECT remote_path, expected_size FROM remote_files WHERE user_id=? AND media_id=? AND bvid=?")
          .all(source.user_id, source.media_id, source.bvid) as any[];
        const paths = fileRows.map((file) => String(file.remote_path));
        const totalBytes = fileRows.reduce((sum, file) => sum + Number(file.expected_size || 0), 0);
        const retainedCount = paths.filter((remotePath) => {
          const item = this.db.db.prepare("SELECT status FROM archive_deletion_items WHERE deletion_id=? AND remote_path=?").get(id, remotePath) as any;
          return item?.status === "retained";
        }).length;
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
        this.db.db.prepare(`
          UPDATE favorite_relations SET backup_status='lost', active_in_favorite=0,
            last_remote_check_at=NULL, next_remote_check_at=NULL, payload_json=?, updated_at=?
          WHERE user_id=? AND media_id=? AND bvid=?
        `).run(JSON.stringify(relation), now, source.user_id, source.media_id, source.bvid);
        this.db.db.prepare("DELETE FROM remote_files WHERE user_id=? AND media_id=? AND bvid=?")
          .run(source.user_id, source.media_id, source.bvid);
        this.db.db.prepare(`
          UPDATE archive_deleted_sources SET status='completed', deleted_at=?, file_count=?, total_bytes=?, retained_count=?
          WHERE deletion_id=? AND user_id=? AND media_id=? AND bvid=?
        `).run(now, fileRows.length, totalBytes, retainedCount, id, source.user_id, source.media_id, source.bvid);
        bvids.add(String(source.bvid));
      }
      const itemPaths = this.db.db.prepare("SELECT remote_path FROM archive_deletion_items WHERE deletion_id=?").all(id) as any[];
      for (const item of itemPaths) {
        const remaining = Number((this.db.db.prepare("SELECT COUNT(*) AS count FROM remote_files WHERE remote_path=? AND user_id<>''").get(item.remote_path) as any)?.count || 0);
        if (remaining === 0) this.db.db.prepare("DELETE FROM remote_files WHERE remote_path=? AND user_id='' AND media_id=0").run(item.remote_path);
      }
      for (const bvid of bvids) this.recomputeVideoAggregate(bvid, now);
      const counts = this.itemCounts(id);
      this.db.db.prepare(`
        UPDATE archive_deletions SET status='completed', completed_count=?, retained_count=?,
          conflict_count=0, failed_count=0, last_error=NULL, updated_at=?, completed_at=? WHERE id=?
      `).run(counts.completed, counts.retained, now, now, id);
      const operation = this.db.db.prepare("SELECT scope, user_id FROM archive_deletions WHERE id=?").get(id) as any;
      if (operation?.scope === "account" && this.userStore.getById(String(operation.user_id))) {
        this.db.db.prepare("DELETE FROM archive_accounts WHERE user_id=?").run(operation.user_id);
        restoredLiveAccount = String(operation.user_id);
      }
    })();
    this.stateManager.reload();
    if (restoredLiveAccount) this.onAccountDeletionCompleted(restoredLiveAccount);
  }

  private recomputeVideoAggregate(bvid: string, now: number) {
    const videoRow = this.db.db.prepare("SELECT payload_json FROM videos WHERE bvid=?").get(bvid) as any;
    if (!videoRow) return;
    const video = parseJson<any>(videoRow.payload_json, {});
    const relations = (this.db.db.prepare("SELECT backup_status, payload_json FROM favorite_relations WHERE bvid=? ORDER BY updated_at DESC").all(bvid) as any[])
      .map((row) => ({ status: String(row.backup_status), relation: parseJson<any>(row.payload_json, {}) }));
    const verified = relations.find((item) => ["verified", "partial_verified"].includes(item.status) && Array.isArray(item.relation.remoteFiles) && item.relation.remoteFiles.length > 0);
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
    this.db.db.prepare("UPDATE videos SET backup_status=?, payload_json=?, updated_at=? WHERE bvid=?")
      .run(video.backupStatus, JSON.stringify(video), now, bvid);
  }

  async stop(timeoutMs = 20_000) {
    this.stopped = true;
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
