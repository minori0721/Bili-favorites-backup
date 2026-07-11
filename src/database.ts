import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type { StateFile, VideoArchiveEntry, FavoriteRelation, FolderScanState, FailedEntry, UserCooldown } from "./state.js";

export const DATABASE_SCHEMA_VERSION = 1;

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
  status: "pending" | "leased" | "running" | "retry_wait";
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
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(backup_status);

CREATE TABLE IF NOT EXISTS favorite_relations (
  user_id TEXT NOT NULL,
  media_id INTEGER NOT NULL,
  bvid TEXT NOT NULL REFERENCES videos(bvid) ON DELETE CASCADE,
  backup_status TEXT NOT NULL,
  active_in_favorite INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, media_id, bvid)
);
CREATE INDEX IF NOT EXISTS idx_relations_bvid ON favorite_relations(bvid);
CREATE INDEX IF NOT EXISTS idx_relations_status ON favorite_relations(backup_status);

CREATE VIEW IF NOT EXISTS video_backup_summary AS
SELECT v.bvid,
  COALESCE((
    SELECT r.backup_status FROM favorite_relations r
    WHERE r.bvid=v.bvid
    ORDER BY CASE r.backup_status
      WHEN 'uploading' THEN 1 WHEN 'upload_failed' THEN 2 WHEN 'downloading' THEN 3
      WHEN 'downloaded' THEN 4 WHEN 'queued' THEN 5 WHEN 'missing' THEN 6
      WHEN 'failed' THEN 7 WHEN 'discovered' THEN 8 WHEN 'lost' THEN 9
      WHEN 'uploaded' THEN 10 WHEN 'partial_verified' THEN 11 WHEN 'verified' THEN 12
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
      this.db.transaction(() => {
        this.db.exec(SCHEMA_SQL);
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
      schemaVersion: 11,
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
      schemaVersion: 11,
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
      INSERT INTO videos(bvid, backup_status, bili_status, local_dir, payload_json, updated_at)
      VALUES(@bvid, @backupStatus, @biliStatus, @localDir, @payload, @updatedAt)
      ON CONFLICT(bvid) DO UPDATE SET backup_status=excluded.backup_status, bili_status=excluded.bili_status,
        local_dir=excluded.local_dir, payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `);
    const deleteVideo = this.db.prepare("DELETE FROM videos WHERE bvid=?");
    const upsertRelation = this.db.prepare(`
      INSERT INTO favorite_relations(user_id, media_id, bvid, backup_status, active_in_favorite, payload_json, updated_at)
      VALUES(@userId, @mediaId, @bvid, @backupStatus, @active, @payload, @updatedAt)
      ON CONFLICT(user_id, media_id, bvid) DO UPDATE SET backup_status=excluded.backup_status,
        active_in_favorite=excluded.active_in_favorite, payload_json=excluded.payload_json, updated_at=excluded.updated_at
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
          .run(String(state.schemaVersion || 11));
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
