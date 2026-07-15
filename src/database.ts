import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  StateFile,
  VideoArchiveEntry,
  FavoriteRelation,
  FolderScanState,
  FailedEntry,
  UserCooldown,
  RemoteFilePreviewVideoRecord,
} from "./state.js";

export const DATABASE_SCHEMA_VERSION = 4;
export const LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER = "legacy_quality_download_jobs_v1";
export const LEGACY_TEMP_CACHE_MARKER = "legacy_temp_cache_v1";

export interface StateDirtySet {
  videos: Set<string>;
  relations: Set<string>;
  folderScans: Set<string>;
  failures: boolean;
  cooldowns: boolean;
  metadata: boolean;
}

export interface PersistentJobRecord {
  id: string;
  kind: string;
  dedupeKey: string;
  bvid?: string;
  userId?: string;
  mediaId?: number;
  status: "pending" | "leased" | "running" | "retry_wait" | "failed";
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  notBefore: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadFailureRecoveryCursor {
  updatedAt: number;
  userId: string;
  mediaId: number;
  bvid: string;
}

export interface UploadFailureRecoveryPage {
  items: Array<{ video: VideoArchiveEntry; relation: FavoriteRelation }>;
  nextCursor: UploadFailureRecoveryCursor | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  bvid TEXT PRIMARY KEY,
  backup_status TEXT NOT NULL,
  bili_status TEXT NOT NULL,
  local_dir TEXT,
  access_restriction_type TEXT,
  access_last_checked_at INTEGER,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(backup_status);
CREATE INDEX IF NOT EXISTS idx_videos_bili_status ON videos(bili_status, bvid);

CREATE TABLE IF NOT EXISTS favorite_relations (
  user_id TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  bvid TEXT NOT NULL REFERENCES videos(bvid) ON DELETE CASCADE,
  backup_status TEXT NOT NULL,
  active_in_favorite INTEGER NOT NULL,
  folder_title TEXT NOT NULL DEFAULT '',
  fav_order INTEGER,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  favorite_unavailable INTEGER NOT NULL DEFAULT 0,
  self_visible INTEGER NOT NULL DEFAULT 0,
  last_remote_check_at INTEGER,
  next_remote_check_at INTEGER,
  account_detached_at INTEGER,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, media_id, bvid)
);
CREATE INDEX IF NOT EXISTS idx_relations_bvid ON favorite_relations(bvid);
CREATE INDEX IF NOT EXISTS idx_relations_status ON favorite_relations(backup_status);
CREATE INDEX IF NOT EXISTS idx_relations_folder_status ON favorite_relations(user_id, media_id, backup_status, last_seen_at DESC);

CREATE VIEW IF NOT EXISTS video_backup_summary AS
SELECT v.bvid,
  COALESCE((
    SELECT r.backup_status FROM favorite_relations r
    WHERE r.bvid=v.bvid
    ORDER BY CASE r.backup_status
      WHEN 'uploading' THEN 1 WHEN 'upload_failed' THEN 2 WHEN 'downloading' THEN 3
      WHEN 'downloaded' THEN 4 WHEN 'queued' THEN 5 WHEN 'missing' THEN 6
      WHEN 'failed' THEN 7 WHEN 'charging_restricted' THEN 8 WHEN 'discovered' THEN 9 WHEN 'lost' THEN 10
      WHEN 'uploaded' THEN 11 WHEN 'partial_verified' THEN 12 WHEN 'verified' THEN 13
      ELSE 99 END
    LIMIT 1
  ), v.backup_status) AS backup_status
FROM videos v;

CREATE TABLE IF NOT EXISTS download_sessions (
  bvid TEXT PRIMARY KEY REFERENCES videos(bvid) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  local_dir TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_pages INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bvid TEXT NOT NULL REFERENCES videos(bvid) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT '',
  media_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'main',
  local_relative_path TEXT,
  name TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  expected_size INTEGER,
  status TEXT NOT NULL DEFAULT 'verified',
  quality_json TEXT,
  put_completed_at INTEGER,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  next_verify_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, media_id, bvid, remote_path)
);
CREATE INDEX IF NOT EXISTS idx_remote_files_verify ON remote_files(status, next_verify_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  bvid TEXT,
  user_id TEXT,
  media_id INTEGER,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, not_before, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS folder_scans (
  user_id TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, media_id)
);

CREATE TABLE IF NOT EXISTS failures (
  user_id TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  bvid TEXT NOT NULL,
  failed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  permanent INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(user_id, media_id, bvid)
);
CREATE INDEX IF NOT EXISTS idx_failures_folder_time ON failures(user_id, media_id, failed_at DESC);

CREATE TABLE IF NOT EXISTS cooldowns (
  kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  until_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(kind, scope_id)
);

CREATE TABLE IF NOT EXISTS quality_upgrades (
  user_id TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  bvid TEXT NOT NULL REFERENCES videos(bvid) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, media_id, bvid)
);
`;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseVideoRow(row: any) {
  const video = parseJson<VideoArchiveEntry>(row.payload_json, undefined as any);
  if (video && row.aggregate_status) video.backupStatus = row.aggregate_status;
  return video;
}

function isoToMs(value: unknown, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalIsoToMs(value: unknown) {
  const parsed = isoToMs(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashFileSync(filePath: string) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function createSchemaUpgradeBackup(db: Database.Database, filePath: string, currentVersion: number) {
  if (filePath === ":memory:" || currentVersion <= 0 || currentVersion >= DATABASE_SCHEMA_VERSION) return null;
  const backupDir = path.join(path.dirname(filePath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  const baseName = `bfb-before-schema-${DATABASE_SCHEMA_VERSION}-v${currentVersion}-${stamp}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  const backupPath = path.join(backupDir, baseName);
  const checksumPath = `${backupPath}.sha256`;
  const checksumTempPath = `${checksumPath}.tmp`;
  try {
    db.prepare("VACUUM INTO ?").run(backupPath);
    const backup = new Database(backupPath, { readonly: true });
    try {
      const integrity = backup.pragma("integrity_check", { simple: true });
      const foreignKeys = backup.pragma("foreign_key_check") as unknown[];
      const version = Number(backup.pragma("user_version", { simple: true }) || 0);
      if (integrity !== "ok" || foreignKeys.length > 0 || version !== currentVersion) {
        throw new Error(`SQLite schema backup verification failed: integrity=${integrity}; foreignKeys=${foreignKeys.length}; version=${version}`);
      }
    } finally {
      backup.close();
    }
    const sha256 = hashFileSync(backupPath);
    fs.writeFileSync(checksumTempPath, `${sha256}  ${baseName}\n`, "utf8");
    fs.renameSync(checksumTempPath, checksumPath);
    return { backupPath, sha256 };
  } catch (error) {
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(checksumPath, { force: true });
    fs.rmSync(checksumTempPath, { force: true });
    throw error;
  }
}

function relationParts(key: string, relation: FavoriteRelation) {
  return {
    userId: String(relation.userId || key.split(":")[0] || ""),
    mediaId: Number(relation.mediaId || key.split(":")[1] || 0),
    bvid: String(relation.bvid || key.split(":").slice(2).join(":") || ""),
  };
}

export class StateDatabase {
  readonly db: Database.Database;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = NORMAL");
      if (filePath !== ":memory:") this.db.pragma("journal_mode = WAL");
      const currentVersion = Number(this.db.pragma("user_version", { simple: true }) || 0);
      if (currentVersion > DATABASE_SCHEMA_VERSION) {
        throw new Error(`SQLite schema ${currentVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`);
      }
      createSchemaUpgradeBackup(this.db, this.filePath, currentVersion);
      this.db.transaction(() => {
        if (currentVersion < 2) {
          this.db.exec("DROP VIEW IF EXISTS video_backup_summary");
        }
        this.db.exec(SCHEMA_SQL);
        if (currentVersion > 0 && currentVersion < 3) {
          const columns = new Set((this.db.pragma("table_info(favorite_relations)") as any[]).map((row) => String(row.name)));
          const additions = [
            ["folder_title", "TEXT NOT NULL DEFAULT ''"],
            ["fav_order", "INTEGER"],
            ["last_seen_at", "INTEGER NOT NULL DEFAULT 0"],
            ["favorite_unavailable", "INTEGER NOT NULL DEFAULT 0"],
            ["self_visible", "INTEGER NOT NULL DEFAULT 0"],
            ["next_remote_check_at", "INTEGER"],
            ["account_detached_at", "INTEGER"],
          ] as const;
          for (const [name, definition] of additions) {
            if (!columns.has(name)) this.db.exec(`ALTER TABLE favorite_relations ADD COLUMN ${name} ${definition}`);
          }
          const rows = this.db.prepare("SELECT user_id, media_id, bvid, payload_json FROM favorite_relations").all() as any[];
          const update = this.db.prepare(`
            UPDATE favorite_relations SET folder_title=?, fav_order=?, last_seen_at=?, favorite_unavailable=?,
              self_visible=?, next_remote_check_at=?, account_detached_at=?
            WHERE user_id=? AND media_id=? AND bvid=?
          `);
          for (const row of rows) {
            const relation = parseJson<FavoriteRelation>(row.payload_json, {} as FavoriteRelation);
            update.run(
              relation.folderTitle || "",
              Number.isInteger(relation.favOrder) ? relation.favOrder : null,
              isoToMs(relation.lastSeenAt, 0),
              relation.favoriteUnavailable ? 1 : 0,
              relation.selfVisible ? 1 : 0,
              optionalIsoToMs(relation.nextRemoteCheckAt),
              relation.accountDetachedAt ? isoToMs(relation.accountDetachedAt, 0) : null,
              row.user_id, row.media_id, row.bvid
            );
          }
        }
        if (currentVersion > 0 && currentVersion < 4) {
          const videoColumns = new Set((this.db.pragma("table_info(videos)") as any[]).map((row) => String(row.name)));
          if (!videoColumns.has("access_restriction_type")) this.db.exec("ALTER TABLE videos ADD COLUMN access_restriction_type TEXT");
          if (!videoColumns.has("access_last_checked_at")) this.db.exec("ALTER TABLE videos ADD COLUMN access_last_checked_at INTEGER");
          const relationColumns = new Set((this.db.pragma("table_info(favorite_relations)") as any[]).map((row) => String(row.name)));
          if (!relationColumns.has("last_remote_check_at")) this.db.exec("ALTER TABLE favorite_relations ADD COLUMN last_remote_check_at INTEGER");

          const updateVideo = this.db.prepare(`
            UPDATE videos SET access_restriction_type=?, access_last_checked_at=? WHERE bvid=?
          `);
          for (const row of this.db.prepare("SELECT bvid, payload_json FROM videos").all() as any[]) {
            const video = parseJson<VideoArchiveEntry>(row.payload_json, {} as VideoArchiveEntry);
            updateVideo.run(
              video.accessRestriction?.type || null,
              optionalIsoToMs(video.accessRestriction?.lastCheckedAt),
              row.bvid
            );
          }

          const updateRelation = this.db.prepare(`
            UPDATE favorite_relations SET last_remote_check_at=? WHERE user_id=? AND media_id=? AND bvid=?
          `);
          for (const row of this.db.prepare("SELECT user_id, media_id, bvid, payload_json FROM favorite_relations").all() as any[]) {
            const relation = parseJson<FavoriteRelation>(row.payload_json, {} as FavoriteRelation);
            updateRelation.run(optionalIsoToMs(relation.lastRemoteCheckAt), row.user_id, row.media_id, row.bvid);
          }
        }
        const remoteScheduleIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_relations_remote_schedule'").get() as any;
        if (remoteScheduleIndex && !/ON favorite_relations\s*\(backup_status,/i.test(String(remoteScheduleIndex.sql || ""))) {
          this.db.exec("DROP INDEX idx_relations_remote_schedule");
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_relations_folder_page ON favorite_relations(user_id, media_id, active_in_favorite, fav_order, last_seen_at DESC);
          CREATE INDEX IF NOT EXISTS idx_relations_remote_due ON favorite_relations(backup_status, next_remote_check_at);
          CREATE INDEX IF NOT EXISTS idx_relations_user_unavailable ON favorite_relations(user_id, favorite_unavailable, last_seen_at DESC);
          CREATE INDEX IF NOT EXISTS idx_videos_access_restriction ON videos(access_restriction_type, access_last_checked_at DESC, bvid);
          CREATE INDEX IF NOT EXISTS idx_relations_remote_schedule
            ON favorite_relations(backup_status, COALESCE(next_remote_check_at, last_remote_check_at, 0), bvid);
        `);
        this.db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
        this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('database_schema', ?)").run(String(DATABASE_SCHEMA_VERSION));
      })();
    } catch (error) {
      try { if (this.db.open) this.db.close(); } catch {}
      throw error;
    }
  }

  close() {
    if (!this.db.open) return;
    if (this.filePath !== ":memory:") this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  integrityCheck() {
    const integrity = this.db.pragma("integrity_check", { simple: true });
    const foreignKeys = this.db.pragma("foreign_key_check") as unknown[];
    if (integrity !== "ok" || foreignKeys.length > 0) {
      throw new Error(`SQLite integrity check failed: ${integrity}; foreign key errors=${foreignKeys.length}`);
    }
  }

  isEmpty() {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM videos").get() as any).count || 0) === 0;
  }

  getMeta(key: string) {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key=?").get(key) as any;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?,?)").run(key, value);
  }

  deleteMeta(key: string) {
    this.db.prepare("DELETE FROM schema_meta WHERE key=?").run(key);
  }

  loadState(): StateFile {
    const state: StateFile = {
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
    };
    for (const row of this.db.prepare(`
      SELECT v.bvid, v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
    `).all() as any[]) {
      state.videos![row.bvid] = parseVideoRow(row) || ({} as VideoArchiveEntry);
    }
    for (const row of this.db.prepare("SELECT user_id, media_id, bvid, payload_json FROM favorite_relations").all() as any[]) {
      state.relations![`${row.user_id}:${row.media_id}:${row.bvid}`] = parseJson<FavoriteRelation>(row.payload_json, {} as FavoriteRelation);
    }
    for (const row of this.db.prepare("SELECT user_id, media_id, payload_json FROM folder_scans").all() as any[]) {
      state.folderScans![`${row.user_id}:${row.media_id}`] = parseJson<FolderScanState>(row.payload_json, {} as FolderScanState);
    }
    for (const row of this.db.prepare("SELECT user_id, media_id, bvid, payload_json FROM failures").all() as any[]) {
      state.failedByUser![row.user_id] ||= {};
      state.failedByUser![row.user_id][`${row.media_id}:${row.bvid}`] = parseJson<FailedEntry>(row.payload_json, {} as FailedEntry);
    }
    for (const row of this.db.prepare("SELECT scope_id, payload_json FROM cooldowns WHERE kind='user'").all() as any[]) {
      state.userCooldowns![row.scope_id] = parseJson<UserCooldown>(row.payload_json, {} as UserCooldown);
    }
    const apiCooldown = this.db.prepare("SELECT payload_json FROM cooldowns WHERE kind='download_api' AND scope_id='global'").get() as any;
    if (apiCooldown) state.downloadApiCooldown = parseJson(apiCooldown.payload_json, undefined);
    return state;
  }

  loadStateMetadata(): StateFile {
    const state: StateFile = {
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
    };
    for (const row of this.db.prepare("SELECT user_id, media_id, payload_json FROM folder_scans").all() as any[]) {
      state.folderScans![`${row.user_id}:${row.media_id}`] = parseJson<FolderScanState>(row.payload_json, {} as FolderScanState);
    }
    return state;
  }

  getVideo(bvid: string) {
    const row = this.db.prepare(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE v.bvid=?
    `).get(bvid) as any;
    return row ? parseVideoRow(row) : undefined;
  }

  getRelation(key: string) {
    const parts = key.split(":");
    const userId = parts.shift() || "";
    const mediaId = Number(parts.shift() || 0);
    const bvid = parts.join(":");
    const row = this.db.prepare("SELECT payload_json FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?")
      .get(userId, mediaId, bvid) as any;
    return row ? parseJson<FavoriteRelation>(row.payload_json, undefined as any) : undefined;
  }

  listVideoKeys() {
    return (this.db.prepare("SELECT bvid FROM videos").all() as any[]).map((row) => String(row.bvid));
  }

  listRelationKeys() {
    return (this.db.prepare("SELECT user_id, media_id, bvid FROM favorite_relations").all() as any[])
      .map((row) => `${row.user_id}:${row.media_id}:${row.bvid}`);
  }

  listVideos() {
    return (this.db.prepare(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
    `).all() as any[])
      .map(parseVideoRow)
      .filter(Boolean);
  }

  listRecoveryNormalizationVideos(afterBvid: string, statuses: string[], limit = 500) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v
      LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE v.bvid>?
        AND (
          v.local_dir IS NOT NULL
          OR v.backup_status IN (${placeholders})
          OR EXISTS (
            SELECT 1 FROM favorite_relations r
            WHERE r.bvid=v.bvid AND r.backup_status IN (${placeholders})
          )
        )
      ORDER BY v.bvid ASC
      LIMIT ?
    `).all(afterBvid, ...statuses, ...statuses, Math.max(1, Math.floor(limit))) as any[])
      .map(parseVideoRow)
      .filter(Boolean);
  }

  listChargingRestrictedVideos() {
    return (this.db.prepare("SELECT payload_json FROM videos WHERE access_restriction_type='charging'").all() as any[])
      .map((row) => parseJson<VideoArchiveEntry>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  getChargingRestrictionSummary() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count,
        MAX(v.access_last_checked_at) AS last_checked_at
      FROM videos v
      WHERE v.access_restriction_type='charging'
        AND EXISTS (
          SELECT 1 FROM favorite_relations r
          WHERE r.bvid=v.bvid AND r.active_in_favorite=1
            AND r.backup_status NOT IN ('uploaded','verified','partial_verified')
        )
    `).get() as any;
    return {
      count: Number(row?.count || 0),
      lastCheckedAt: Number.isFinite(Number(row?.last_checked_at)) && Number(row.last_checked_at) > 0
        ? new Date(Number(row.last_checked_at)).toISOString()
        : undefined,
    };
  }

  listRelations() {
    return (this.db.prepare("SELECT payload_json FROM favorite_relations").all() as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  listRelationsForBvid(bvid: string) {
    return (this.db.prepare("SELECT payload_json FROM favorite_relations WHERE bvid=?").all(bvid) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  listRelationsForBvids(bvids: string[]) {
    if (bvids.length === 0) return [];
    const placeholders = bvids.map(() => "?").join(",");
    return (this.db.prepare(`SELECT payload_json FROM favorite_relations WHERE bvid IN (${placeholders})`).all(...bvids) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  listRemoteFilePreviewRecords(): RemoteFilePreviewVideoRecord[] {
    const records = new Map<string, RemoteFilePreviewVideoRecord>();
    for (const row of this.db.prepare(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
    `).all() as any[]) {
      const video = parseVideoRow(row);
      if (!video) continue;
      records.set(video.bvid, {
        bvid: video.bvid,
        title: video.title,
        upperName: video.upperName,
        remotePath: video.remotePath,
        remoteFiles: [...(video.remoteFiles || [])],
        relations: [],
      });
    }
    for (const row of this.db.prepare("SELECT payload_json FROM favorite_relations WHERE active_in_favorite=1").all() as any[]) {
      const relation = parseJson<FavoriteRelation>(row.payload_json, undefined as any);
      if (!relation) continue;
      const record = records.get(relation.bvid);
      if (!record) continue;
      record.relations.push({
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
        backupStatus: relation.backupStatus,
        hasInterruptedQualityUpgrade: Boolean(relation.qualityUpgrade),
        remotePath: relation.remotePath,
        remoteFiles: [...(relation.remoteFiles || [])],
      });
    }
    return [...records.values()];
  }

  listVideosByStatuses(statuses: string[]) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT payload_json FROM videos WHERE backup_status IN (${placeholders})`).all(...statuses) as any[])
      .map((row) => parseJson<VideoArchiveEntry>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listVideosForResume(statuses: string[]) {
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT DISTINCT v.payload_json FROM videos v
      LEFT JOIN favorite_relations r ON r.bvid=v.bvid
      WHERE v.backup_status IN (${placeholders})
        OR (v.local_dir IS NOT NULL AND r.backup_status IN ('verified','partial_verified'))
    `).all(...statuses) as any[]).map((row) => parseJson<VideoArchiveEntry>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listRelationsByStatuses(statuses: string[]) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT payload_json FROM favorite_relations WHERE backup_status IN (${placeholders})`).all(...statuses) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listUploadFailuresForRecoveryPage(cursor: UploadFailureRecoveryCursor | null, limit: number): UploadFailureRecoveryPage {
    const after = cursor || { updatedAt: -1, userId: "", mediaId: -1, bvid: "" };
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const rows = this.db.prepare(`
      SELECT v.payload_json AS video_payload, v.local_dir, r.payload_json AS relation_payload,
        r.updated_at, r.user_id, r.media_id, r.bvid
      FROM favorite_relations r
      JOIN videos v ON v.bvid=r.bvid
      WHERE r.backup_status='upload_failed'
        AND v.local_dir IS NOT NULL AND v.local_dir<>''
        AND (
          r.updated_at>@updatedAt
          OR (r.updated_at=@updatedAt AND r.user_id>@userId)
          OR (r.updated_at=@updatedAt AND r.user_id=@userId AND r.media_id>@mediaId)
          OR (r.updated_at=@updatedAt AND r.user_id=@userId AND r.media_id=@mediaId AND r.bvid>@bvid)
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.kind='upload' AND j.bvid=r.bvid AND j.user_id=r.user_id AND j.media_id=r.media_id
            AND j.status IN ('pending','retry_wait','leased','running')
        )
      ORDER BY r.updated_at ASC, r.user_id ASC, r.media_id ASC, r.bvid ASC
      LIMIT @limit
    `).all({ ...after, limit: normalizedLimit }) as any[];
    const last = rows[rows.length - 1];
    const items = rows.flatMap((row) => {
      const video = parseJson<VideoArchiveEntry>(row.video_payload, undefined as any);
      const relation = parseJson<FavoriteRelation>(row.relation_payload, undefined as any);
      if (video && row.local_dir) video.localDir = String(row.local_dir);
      return video && relation ? [{ video, relation }] : [];
    });
    return {
      items,
      nextCursor: rows.length === normalizedLimit && last ? {
        updatedAt: Number(last.updated_at || 0),
        userId: String(last.user_id || ""),
        mediaId: Number(last.media_id || 0),
        bvid: String(last.bvid || ""),
      } : null,
    };
  }

  listStaleRelations(statuses: string[], before: number) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT payload_json FROM favorite_relations WHERE backup_status IN (${placeholders}) AND updated_at <= ?`).all(...statuses, before) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listStaleVideos(statuses: string[], before: number) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT payload_json FROM videos WHERE backup_status IN (${placeholders}) AND updated_at <= ?`).all(...statuses, before) as any[])
      .map((row) => parseJson<VideoArchiveEntry>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listInterruptedQualityRelations() {
    return (this.db.prepare(`
      SELECT r.payload_json FROM favorite_relations r JOIN quality_upgrades q
      ON q.user_id=r.user_id AND q.media_id=r.media_id AND q.bvid=r.bvid
    `).all() as any[]).map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any)).filter(Boolean);
  }

  listRelationsForFolder(userId: string, mediaId: number) {
    return (this.db.prepare(`
      SELECT payload_json FROM favorite_relations
      WHERE user_id=? AND media_id=?
      ORDER BY CASE WHEN fav_order IS NULL THEN 1 ELSE 0 END, fav_order ASC, last_seen_at DESC
    `).all(userId, mediaId) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  queryFolderPage(userId: string, mediaId: number, filter: string, offset: number, limit: number) {
    const processed = "r.backup_status IN ('uploaded','verified','partial_verified')";
    const unavailable = "v.bili_status='unavailable' AND r.self_visible=0";
    const filterSql = filter === "uploaded" ? processed
      : filter === "pending" ? `NOT (${processed}) AND NOT (${unavailable})`
      : filter === "pending_unavailable" ? `NOT (${processed}) AND (${unavailable})`
      : filter === "uploaded_unavailable" ? `(${processed}) AND (${unavailable})`
      : "1=1";
    const base = "FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid WHERE r.user_id=? AND r.media_id=?";
    const rows = this.db.prepare(`
      SELECT r.payload_json AS relation_json, v.payload_json AS video_json
      ${base} AND (${filterSql})
      ORDER BY CASE WHEN r.fav_order IS NULL THEN 1 ELSE 0 END, r.fav_order ASC, r.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, mediaId, Math.max(1, limit), Math.max(0, offset)) as any[];
    const summary = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${processed} THEN 1 ELSE 0 END) AS uploaded,
        SUM(CASE WHEN NOT (${processed}) AND NOT (${unavailable}) THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN NOT (${processed}) AND (${unavailable}) THEN 1 ELSE 0 END) AS pending_unavailable,
        SUM(CASE WHEN (${processed}) AND (${unavailable}) THEN 1 ELSE 0 END) AS uploaded_unavailable,
        SUM(CASE WHEN (${filterSql}) THEN 1 ELSE 0 END) AS total_filtered
      ${base}
    `).get(userId, mediaId) as any;
    const totalFiltered = Number(summary.total_filtered || 0);
    return {
      rows: rows.map((row) => ({
        relation: parseJson<FavoriteRelation>(row.relation_json, {} as FavoriteRelation),
        video: parseJson<VideoArchiveEntry>(row.video_json, {} as VideoArchiveEntry),
      })),
      summary: {
        total: Number(summary?.total || 0), uploaded: Number(summary?.uploaded || 0), pending: Number(summary?.pending || 0),
        pendingUnavailable: Number(summary?.pending_unavailable || 0), uploadedUnavailable: Number(summary?.uploaded_unavailable || 0),
      },
      totalFiltered,
    };
  }

  queryUnavailablePage(userId: string, offset: number, limit: number) {
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT r.payload_json AS relation_json, v.payload_json AS video_json, r.bvid, r.last_seen_at,
          ROW_NUMBER() OVER (PARTITION BY r.bvid ORDER BY r.last_seen_at DESC) AS rank
        FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
        WHERE r.user_id=? AND v.bili_status='unavailable' AND r.self_visible=0
      )
      SELECT relation_json, video_json FROM ranked WHERE rank=1 ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
    `).all(userId, Math.max(1, limit), Math.max(0, offset)) as any[];
    const total = Number((this.db.prepare(`
      SELECT COUNT(DISTINCT r.bvid) AS count FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
      WHERE r.user_id=? AND v.bili_status='unavailable' AND r.self_visible=0
    `).get(userId) as any)?.count || 0);
    return {
      rows: rows.map((row) => ({ relation: parseJson<FavoriteRelation>(row.relation_json, {} as FavoriteRelation), video: parseJson<VideoArchiveEntry>(row.video_json, {} as VideoArchiveEntry) })),
      total,
    };
  }

  listRelationsForUser(userId: string, unavailableOnly = false) {
    const sql = unavailableOnly
      ? "SELECT payload_json FROM favorite_relations WHERE user_id=? AND favorite_unavailable=1 ORDER BY last_seen_at DESC"
      : "SELECT payload_json FROM favorite_relations WHERE user_id=? ORDER BY last_seen_at DESC";
    return (this.db.prepare(sql).all(userId) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  listRelationsForRemoteVerify(limit?: number, includeDeferred = false, now = Date.now()) {
    const conditions = ["backup_status IN ('verified','partial_verified')"];
    const params: any[] = [];
    if (!includeDeferred) {
      conditions.push("COALESCE(next_remote_check_at, last_remote_check_at, 0) <= ?");
      params.push(now);
    }
    const limitSql = typeof limit === "number" ? " LIMIT ?" : "";
    if (typeof limit === "number") params.push(Math.max(1, Math.floor(limit)));
    const orderSql = includeDeferred
      ? "COALESCE(last_remote_check_at, 0) ASC, bvid ASC"
      : "COALESCE(next_remote_check_at, last_remote_check_at, 0) ASC, bvid ASC";
    return (this.db.prepare(`
      SELECT payload_json FROM favorite_relations WHERE ${conditions.join(" AND ")}
      ORDER BY ${orderSql}${limitSql}
    `).all(...params) as any[])
      .map((row) => parseJson<FavoriteRelation>(row.payload_json, undefined as any))
      .filter(Boolean);
  }

  countRelationsForRemoteVerify(includeDeferred = false, now = Date.now()) {
    const row = includeDeferred
      ? this.db.prepare("SELECT COUNT(*) AS count FROM favorite_relations WHERE backup_status IN ('verified','partial_verified')").get()
      : this.db.prepare("SELECT COUNT(*) AS count FROM favorite_relations WHERE backup_status IN ('verified','partial_verified') AND COALESCE(next_remote_check_at, last_remote_check_at, 0) <= ?").get(now);
    return Number((row as any)?.count || 0);
  }

  listPendingUploadVerifications(limit = 100) {
    return (this.db.prepare(`
      WITH due AS (
        SELECT user_id, media_id, bvid,
          MIN(COALESCE(next_verify_at, 0)) AS next_at,
          MIN(updated_at) AS first_updated_at
        FROM remote_files
        WHERE status='awaiting_verification'
        GROUP BY user_id, media_id, bvid
        ORDER BY next_at ASC, first_updated_at ASC
        LIMIT ?
      )
      SELECT r.payload_json AS relation_json, v.local_dir
      FROM due
      JOIN favorite_relations r
        ON r.user_id=due.user_id AND r.media_id=due.media_id AND r.bvid=due.bvid
      JOIN videos v ON v.bvid=due.bvid
      WHERE r.backup_status='uploaded'
      ORDER BY due.next_at ASC, due.first_updated_at ASC
    `).all(Math.max(1, Math.floor(limit))) as any[]).map((row) => ({
      relation: parseJson<FavoriteRelation>(row.relation_json, {} as FavoriteRelation),
      localDir: row.local_dir ? String(row.local_dir) : undefined,
    }));
  }

  listRetryCandidateBvids(userId: string, mediaId: number, limit = 500) {
    return (this.db.prepare(`
      SELECT r.bvid
      FROM favorite_relations r
      JOIN videos v ON v.bvid=r.bvid
      LEFT JOIN failures f ON f.user_id=r.user_id AND f.media_id=r.media_id AND f.bvid=r.bvid
      WHERE r.user_id=? AND r.media_id=?
        AND NOT ((r.favorite_unavailable=1 OR v.bili_status='unavailable') AND r.self_visible=0)
        AND r.backup_status NOT IN ('uploaded','verified','partial_verified','queued','downloading','downloaded','uploading')
        AND (
          r.backup_status IN ('failed','missing')
          OR (r.backup_status='discovered' AND (f.bvid IS NOT NULL OR json_extract(r.payload_json, '$.lastError') IS NOT NULL))
        )
      ORDER BY COALESCE(f.failed_at, r.last_seen_at, r.updated_at) DESC
      LIMIT ?
    `).all(userId, mediaId, Math.max(1, Math.floor(limit))) as any[]).map((row) => String(row.bvid));
  }

  listPermanentFailureRelations(limit = 10_000) {
    return (this.db.prepare(`
      SELECT r.payload_json AS relation_json, v.payload_json AS video_json, f.payload_json AS failure_json
      FROM favorite_relations r
      JOIN videos v ON v.bvid=r.bvid
      JOIN failures f ON f.user_id=r.user_id AND f.media_id=r.media_id AND f.bvid=r.bvid
      WHERE r.active_in_favorite=1 AND f.permanent=1
        AND r.backup_status NOT IN ('uploaded','verified','partial_verified')
        AND json_extract(v.payload_json, '$.accessClassification') IS NULL
      ORDER BY f.failed_at ASC LIMIT ?
    `).all(Math.max(1, Math.floor(limit))) as any[]).map((row) => ({
      relation: parseJson<FavoriteRelation>(row.relation_json, {} as FavoriteRelation),
      video: parseJson<VideoArchiveEntry>(row.video_json, {} as VideoArchiveEntry),
      failure: parseJson<FailedEntry>(row.failure_json, {} as FailedEntry),
    }));
  }

  replaceState(state: StateFile) {
    const transaction = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM jobs;
        DELETE FROM quality_upgrades;
        DELETE FROM remote_files;
        DELETE FROM download_sessions;
        DELETE FROM failures;
        DELETE FROM cooldowns;
        DELETE FROM folder_scans;
        DELETE FROM favorite_relations;
        DELETE FROM videos;
      `);
      this.deleteMeta("persistent_jobs_bootstrap_v1");
      this.deleteMeta("legacy_failure_classification_v1");
      this.deleteMeta("runtime_recovery_normalization_v2");
      this.deleteMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
      const dirty: StateDirtySet = {
        videos: new Set(Object.keys(state.videos || {})),
        relations: new Set(Object.keys(state.relations || {})),
        folderScans: new Set(Object.keys(state.folderScans || {})),
        failures: true,
        cooldowns: true,
        metadata: true,
      };
      this.flushState(state, dirty);
    });
    transaction();
    this.integrityCheck();
  }

  flushState(state: StateFile, dirty: StateDirtySet) {
    const now = Date.now();
    const upsertVideo = this.db.prepare(`
      INSERT INTO videos(bvid, backup_status, bili_status, local_dir, access_restriction_type,
        access_last_checked_at, payload_json, updated_at)
      VALUES(@bvid, @backupStatus, @biliStatus, @localDir, @accessRestrictionType,
        @accessLastCheckedAt, @payload, @updatedAt)
      ON CONFLICT(bvid) DO UPDATE SET backup_status=excluded.backup_status, bili_status=excluded.bili_status,
        local_dir=excluded.local_dir, access_restriction_type=excluded.access_restriction_type,
        access_last_checked_at=excluded.access_last_checked_at, payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `);
    const deleteVideo = this.db.prepare("DELETE FROM videos WHERE bvid=?");
    const upsertRelation = this.db.prepare(`
      INSERT INTO favorite_relations(user_id, media_id, bvid, backup_status, active_in_favorite, folder_title,
        fav_order, last_seen_at, favorite_unavailable, self_visible, last_remote_check_at,
        next_remote_check_at, account_detached_at, payload_json, updated_at)
      VALUES(@userId, @mediaId, @bvid, @backupStatus, @active, @folderTitle, @favOrder, @lastSeenAt,
        @favoriteUnavailable, @selfVisible, @lastRemoteCheckAt, @nextRemoteCheckAt, @accountDetachedAt,
        @payload, @updatedAt)
      ON CONFLICT(user_id, media_id, bvid) DO UPDATE SET backup_status=excluded.backup_status,
        active_in_favorite=excluded.active_in_favorite, folder_title=excluded.folder_title,
        fav_order=excluded.fav_order, last_seen_at=excluded.last_seen_at,
        favorite_unavailable=excluded.favorite_unavailable, self_visible=excluded.self_visible,
        last_remote_check_at=excluded.last_remote_check_at, next_remote_check_at=excluded.next_remote_check_at,
        account_detached_at=excluded.account_detached_at, payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `);
    const deleteRelation = this.db.prepare("DELETE FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?");
    const upsertFolder = this.db.prepare(`
      INSERT INTO folder_scans(user_id, media_id, payload_json, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id, media_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `);
    const deleteFolder = this.db.prepare("DELETE FROM folder_scans WHERE user_id=? AND media_id=?");

    const transaction = this.db.transaction(() => {
      for (const bvid of dirty.videos) {
        const video = state.videos?.[bvid];
        if (!video) {
          deleteVideo.run(bvid);
          continue;
        }
        upsertVideo.run({
          bvid,
          backupStatus: video.backupStatus || "discovered",
          biliStatus: video.biliStatus || "unknown",
          localDir: video.localDir || null,
          accessRestrictionType: video.accessRestriction?.type || null,
          accessLastCheckedAt: optionalIsoToMs(video.accessRestriction?.lastCheckedAt),
          payload: JSON.stringify(video),
          updatedAt: isoToMs(video.statusUpdatedAt || video.lastSeenAt, now),
        });
        this.syncVideoAuxiliary(video, now);
      }

      for (const key of dirty.relations) {
        const relation = state.relations?.[key];
        const parts = relation ? relationParts(key, relation) : {
          userId: key.split(":")[0] || "",
          mediaId: Number(key.split(":")[1] || 0),
          bvid: key.split(":").slice(2).join(":"),
        };
        if (!relation) {
          deleteRelation.run(parts.userId, parts.mediaId, parts.bvid);
          continue;
        }
        upsertRelation.run({
          ...parts,
          backupStatus: relation.backupStatus || "discovered",
          active: relation.activeInFavorite ? 1 : 0,
          folderTitle: relation.folderTitle || "",
          favOrder: Number.isInteger(relation.favOrder) ? relation.favOrder : null,
          lastSeenAt: isoToMs(relation.lastSeenAt, now),
          favoriteUnavailable: relation.favoriteUnavailable ? 1 : 0,
          selfVisible: relation.selfVisible ? 1 : 0,
          lastRemoteCheckAt: optionalIsoToMs(relation.lastRemoteCheckAt),
          nextRemoteCheckAt: optionalIsoToMs(relation.nextRemoteCheckAt),
          accountDetachedAt: relation.accountDetachedAt ? isoToMs(relation.accountDetachedAt, now) : null,
          payload: JSON.stringify(relation),
          updatedAt: isoToMs(relation.statusUpdatedAt || relation.lastSeenAt, now),
        });
        this.syncRelationAuxiliary(relation, now);
      }

      for (const key of dirty.folderScans) {
        const folder = state.folderScans?.[key];
        const userId = folder?.userId || key.split(":")[0] || "";
        const mediaId = Number(folder?.mediaId || key.split(":")[1] || 0);
        if (!folder) deleteFolder.run(userId, mediaId);
        else upsertFolder.run(userId, mediaId, JSON.stringify(folder), now);
      }

      if (dirty.failures) this.replaceFailures(state.failedByUser || {});
      if (dirty.cooldowns) this.replaceCooldowns(state);
      if (dirty.metadata) {
        this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('legacy_state_schema', ?)")
          .run(String(state.schemaVersion || 13));
      }
    });
    transaction();
  }

  private syncVideoAuxiliary(video: VideoArchiveEntry, now: number) {
    this.db.prepare("DELETE FROM download_sessions WHERE bvid=?").run(video.bvid);
    if (video.downloadSession && video.localDir) {
      this.db.prepare(`
        INSERT INTO download_sessions(bvid, session_id, local_dir, kind, status, completed_pages, total_pages, updated_at, payload_json)
        VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        video.bvid,
        video.downloadSession.id,
        video.localDir,
        video.downloadSession.kind,
        video.downloadSession.status,
        video.downloadSession.completedPages,
        video.downloadSession.totalPages,
        isoToMs(video.downloadSession.updatedAt, now),
        JSON.stringify(video.downloadSession)
      );
    }
    this.replaceRemoteFiles(video.bvid, "", 0, video.remoteFiles || [], now);
  }

  private syncRelationAuxiliary(relation: FavoriteRelation, now: number) {
    this.replaceRemoteFiles(relation.bvid, relation.userId, relation.mediaId, relation.remoteFiles || [], now);
    this.db.prepare("DELETE FROM quality_upgrades WHERE user_id=? AND media_id=? AND bvid=?")
      .run(relation.userId, relation.mediaId, relation.bvid);
    if (relation.qualityUpgrade) {
      this.db.prepare(`
        INSERT INTO quality_upgrades(user_id, media_id, bvid, stage, status, payload_json, updated_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        relation.userId,
        relation.mediaId,
        relation.bvid,
        relation.qualityUpgrade.finalizedAt ? "finalized" : "replacing",
        relation.qualityUpgrade.finalizedAt ? "completed" : "active",
        JSON.stringify(relation.qualityUpgrade),
        now
      );
    }
  }

  private replaceRemoteFiles(bvid: string, userId: string, mediaId: number, files: any[], now: number) {
    this.db.prepare("DELETE FROM remote_files WHERE bvid=? AND user_id=? AND media_id=?").run(bvid, userId, mediaId);
    const insert = this.db.prepare(`
      INSERT INTO remote_files(
        bvid, user_id, media_id, kind, local_relative_path, name, remote_path, expected_size,
        status, quality_json, put_completed_at, verify_attempts, next_verify_at, last_error, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const file of files) {
      insert.run(
        bvid,
        userId,
        mediaId,
        "main",
        file.localRelativePath || null,
        String(file.name || path.posix.basename(file.path || "file")),
        String(file.path || ""),
        typeof file.size === "number" ? file.size : null,
        file.verificationStatus || "verified",
        file.qualityProfile ? JSON.stringify(file.qualityProfile) : null,
        file.putCompletedAt ? isoToMs(file.putCompletedAt, now) : null,
        Number(file.verifyAttempts || 0),
        file.nextVerifyAt ? isoToMs(file.nextVerifyAt, now) : null,
        file.lastError || null,
        now
      );
    }
  }

  private replaceFailures(failedByUser: Record<string, Record<string, FailedEntry>>) {
    this.db.exec("DELETE FROM failures");
    const insert = this.db.prepare(`
      INSERT INTO failures(user_id, media_id, bvid, failed_at, reason, permanent, payload_json)
      VALUES(?,?,?,?,?,?,?)
    `);
    for (const [userId, entries] of Object.entries(failedByUser)) {
      for (const entry of Object.values(entries || {})) {
        if (!entry?.bvid) continue;
        insert.run(userId, Number(entry.mediaId || 0), entry.bvid, isoToMs(entry.failedAt), entry.reason || "", entry.permanent ? 1 : 0, JSON.stringify(entry));
      }
    }
  }

  getFailure(userId: string, bvid: string, mediaId?: number) {
    const row = typeof mediaId === "number"
      ? this.db.prepare(`
          SELECT payload_json FROM failures
          WHERE user_id=? AND bvid=? AND media_id IN (?,0)
          ORDER BY CASE WHEN media_id=? THEN 0 ELSE 1 END, failed_at DESC LIMIT 1
        `).get(userId, bvid, mediaId, mediaId) as any
      : this.db.prepare(`
          SELECT payload_json FROM failures WHERE user_id=? AND bvid=? ORDER BY failed_at DESC LIMIT 1
        `).get(userId, bvid) as any;
    return row ? parseJson<FailedEntry>(row.payload_json, undefined as any) : undefined;
  }

  upsertFailure(userId: string, entry: FailedEntry) {
    this.db.prepare(`
      INSERT INTO failures(user_id,media_id,bvid,failed_at,reason,permanent,payload_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,media_id,bvid) DO UPDATE SET failed_at=excluded.failed_at,
        reason=excluded.reason, permanent=excluded.permanent, payload_json=excluded.payload_json
    `).run(
      userId,
      Number(entry.mediaId || 0),
      entry.bvid,
      isoToMs(entry.failedAt),
      entry.reason || "",
      entry.permanent ? 1 : 0,
      JSON.stringify(entry)
    );
  }

  deleteFailure(userId: string, mediaId: number, bvid: string) {
    return this.db.prepare("DELETE FROM failures WHERE user_id=? AND bvid=? AND media_id IN (?,0)")
      .run(userId, bvid, mediaId).changes > 0;
  }

  private replaceCooldowns(state: StateFile) {
    this.db.prepare("DELETE FROM cooldowns WHERE kind IN ('user','download_api')").run();
    const insert = this.db.prepare(`
      INSERT INTO cooldowns(kind, scope_id, until_at, reason, payload_json, updated_at) VALUES(?,?,?,?,?,?)
    `);
    for (const [userId, cooldown] of Object.entries(state.userCooldowns || {})) {
      insert.run("user", userId, Number(cooldown.until || 0), cooldown.reason || "", JSON.stringify(cooldown), Date.now());
    }
    if (state.downloadApiCooldown) {
      insert.run(
        "download_api",
        "global",
        Number(state.downloadApiCooldown.until || 0),
        state.downloadApiCooldown.reason || "",
        JSON.stringify(state.downloadApiCooldown),
        Date.now()
      );
    }
  }

  getCooldown(kind: string, scopeId = "global") {
    const row = this.db.prepare("SELECT payload_json FROM cooldowns WHERE kind=? AND scope_id=?").get(kind, scopeId) as any;
    return row ? parseJson<Record<string, unknown>>(row.payload_json, {}) : null;
  }

  listCooldowns(kind: string, activeAfter?: number) {
    const rows = typeof activeAfter === "number"
      ? this.db.prepare("SELECT scope_id,payload_json FROM cooldowns WHERE kind=? AND until_at>?").all(kind, activeAfter) as any[]
      : this.db.prepare("SELECT scope_id,payload_json FROM cooldowns WHERE kind=?").all(kind) as any[];
    return rows.map((row) => ({
      scopeId: String(row.scope_id || ""),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    }));
  }

  setCooldown(kind: string, scopeId: string, untilAt: number, reason: string, payload: Record<string, unknown>) {
    this.db.prepare(`
      INSERT INTO cooldowns(kind,scope_id,until_at,reason,payload_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,scope_id) DO UPDATE SET until_at=excluded.until_at, reason=excluded.reason,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(kind, scopeId, untilAt, reason, JSON.stringify(payload), Date.now());
  }

  clearCooldown(kind: string, scopeId = "global") {
    this.db.prepare("DELETE FROM cooldowns WHERE kind=? AND scope_id=?").run(kind, scopeId);
  }

  async backupTo(destination: string) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await this.db.backup(destination);
    const backup = new Database(destination, { readonly: true });
    try {
      const result = backup.pragma("integrity_check", { simple: true });
      if (result !== "ok") throw new Error(`SQLite backup integrity check failed: ${result}`);
    } finally {
      backup.close();
    }
    fs.rmSync(`${destination}-wal`, { force: true });
    fs.rmSync(`${destination}-shm`, { force: true });
  }

  clearStateAndJobs() {
    const transaction = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM jobs;
        DELETE FROM quality_upgrades;
        DELETE FROM remote_files;
        DELETE FROM download_sessions;
        DELETE FROM failures;
        DELETE FROM cooldowns;
        DELETE FROM folder_scans;
        DELETE FROM favorite_relations;
        DELETE FROM videos;
      `);
      this.deleteMeta("persistent_jobs_bootstrap_v1");
      this.deleteMeta("legacy_failure_classification_v1");
      this.deleteMeta("runtime_recovery_normalization_v2");
      this.deleteMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
      this.deleteMeta(LEGACY_TEMP_CACHE_MARKER);
    });
    transaction();
  }
}

export function archiveLegacyStateFile(statePath: string, archiveDir: string, summary?: Record<string, unknown>) {
  const raw = fs.readFileSync(statePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedPath = path.join(archiveDir, `state-json-${stamp}.json`);
  fs.writeFileSync(archivedPath, raw);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  fs.writeFileSync(`${archivedPath}.sha256`, `${sha256}  ${path.basename(archivedPath)}\n`, "utf8");
  fs.writeFileSync(`${archivedPath}.migration.json`, JSON.stringify({
    migratedAt: new Date().toISOString(),
    source: statePath,
    destination: "bfb.sqlite",
    sha256,
    summary,
  }, null, 2), "utf8");
  return { archivedPath, sha256 };
}

export function sqlitePaths(databasePath: string) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}
