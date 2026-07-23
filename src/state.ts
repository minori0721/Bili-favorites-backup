import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir } from "./paths.js";
import { historySessionGroups, readDownloadSession } from "./download-session.js";
import type { PersistedDownloadApiCooldown } from "./download-api-health.js";
import { databasePath } from "./paths.js";
import {
  archiveLegacyStateFile,
  StateDatabase,
  type StateDirtySet,
  type UploadFailureRecoveryCursor,
} from "./database.js";

// Legacy type kept only for backward-compatible state.json parsing.
export interface ProcessedEntry {
  bvid: string;
  mediaId: number;
  processedAt: string;
}

export interface FailedEntry {
  bvid: string;
  mediaId: number;
  failedAt: string;
  reason: string;
  permanent: boolean;
}

export type BackupStatus =
  | "discovered"
  | "queued"
  | "downloading"
  | "downloaded"
  | "uploading"
  | "upload_failed"
  | "uploaded"
  | "verified"
  | "partial_verified"
  | "charging_restricted"
  | "missing"
  | "lost"
  | "failed";

export type BiliStatus = "available" | "unavailable" | "unknown";

export interface RemoteFileQualityProfile {
  quality: string;
  encoding: string;
  hiRes: boolean;
  dolby: boolean;
}

export interface RemoteFileRecord {
  name: string;
  path: string;
  size?: number;
  qualityProfile?: RemoteFileQualityProfile;
  localRelativePath?: string;
  verificationStatus?: "awaiting_verification" | "verified" | "failed";
  putCompletedAt?: string;
  verifyAttempts?: number;
  nextVerifyAt?: string;
  lastError?: string;
  filenameMetadata?: {
    publishDate?: number;
    videoDate?: number;
    cid?: number;
    pageIndex?: number;
    dfn?: string;
    videoCodecs?: string;
  };
}

export interface RemoteConflictArchiveRecord {
  archivePath: string;
  archivedAt: string;
  files: Array<{ name: string; oldPath: string; archivedPath: string; size?: number }>;
}

export interface VideoMetadataSnapshot {
  title: string;
  upperName: string;
  cover?: string;
  coverLocalPath?: string;
  description?: string;
  capturedAt: string;
}

export interface ChargingAccessRestriction {
  type: "charging";
  detectedAt: string;
  lastCheckedAt: string;
  nextCheckAt: string;
  previewAvailable?: boolean;
  checkedAccountUids: string[];
  lastError?: string;
}

export interface DownloadSessionReference {
  id: string;
  localDir: string;
  kind: "backup" | "quality_upgrade";
  status: "prepared" | "downloading" | "complete" | "partial" | "failed";
  completedPages: number;
  totalPages: number;
  updatedAt: string;
}

export interface VideoArchiveEntry {
  bvid: string;
  title: string;
  upperName: string;
  cover?: string;
  originalMeta?: VideoMetadataSnapshot;
  description?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  biliStatus: BiliStatus;
  backupStatus: BackupStatus;
  statusUpdatedAt?: string;
  remotePath?: string;
  remoteFiles?: RemoteFileRecord[];
  pendingPartialBackup?: boolean;
  localDir?: string;
  downloadSession?: DownloadSessionReference;
  accessRestriction?: ChargingAccessRestriction;
  accessClassification?: {
    purpose: "legacy_failure_classification";
    classifiedAt?: string;
    result?: "charging" | "available" | "unavailable" | "other_restricted";
    nextCheckAt?: string;
  };
  uploadedAt?: string;
  verifiedAt?: string;
  lastRemoteCheckAt?: string;
  nextRemoteCheckAt?: string;
  remoteMissingCount?: number;
  lastError?: string;
  favoriteUnavailable?: boolean;
  selfVisible?: boolean;
  // Legacy marker kept for one-way migration cleanup.
  legacyProcessed?: boolean;
}

export interface QualityUpgradeOperation {
  artifactKey?: string;
  stageRemotePath: string;
  backupRemotePath: string;
  oldRemotePath: string;
  oldFiles: RemoteFileRecord[];
  backupFiles?: RemoteFileRecord[];
  newFiles?: RemoteFileRecord[];
  finalizedAt?: string;
  startedAt: string;
}

export interface FavoriteRelation {
  userId: string;
  mediaId: number;
  bvid: string;
  folderTitle: string;
  firstSeenAt: string;
  lastSeenAt: string;
  // Order in Bilibili favorite list (based on page + index in API response).
  favOrder?: number;
  favPage?: number;
  favIndexInPage?: number;
  favOrderUpdatedAt?: string;
  activeInFavorite: boolean;
  backupStatus?: BackupStatus;
  statusUpdatedAt?: string;
  remotePath?: string;
  remoteFiles?: RemoteFileRecord[];
  remoteConflictArchives?: RemoteConflictArchiveRecord[];
  pendingPartialBackup?: boolean;
  qualityUpgrade?: QualityUpgradeOperation;
  uploadedAt?: string;
  verifiedAt?: string;
  lastRemoteCheckAt?: string;
  nextRemoteCheckAt?: string;
  remoteMissingCount?: number;
  lastError?: string;
  favoriteUnavailable?: boolean;
  selfVisible?: boolean;
  accountDetachedAt?: string;
}

export interface FolderScanState {
  userId: string;
  mediaId: number;
  folderTitle: string;
  initStatus: "pending" | "initializing" | "complete";
  nextHistoryPage: number;
  catchupPage: number;
  lastHotScanAt?: string;
  lastHistoryScanAt?: string;
  lastScannedAt?: string;
  total?: number;
}

export interface UserCooldown {
  userId: string;
  until: number;
  reason: string;
  setAt: string;
}

export interface ObservedFavoriteItem {
  bvid: string;
  title: string;
  upperName: string;
  upperMid?: number;
  cover?: string;
  description?: string;
  unavailable?: boolean;
  favoriteUnavailable?: boolean;
  selfVisible?: boolean;
}

export type FolderDetailFilter =
  | "all"
  | "uploaded"
  | "pending"
  | "pending_unavailable"
  | "uploaded_unavailable";

export interface FolderDetailItem {
  bvid: string;
  title: string;
  upperName: string;
  cover?: string;
  coverLocalPath?: string;
  description?: string;
  favoriteUnavailable?: boolean;
  selfVisible?: boolean;
  favOrder?: number;
  favPage?: number;
  favIndexInPage?: number;
  unavailable: boolean;
  processed: boolean;
  failed: boolean;
  backupStatus: BackupStatus;
  mediaId: number;
  folderTitle: string;
  lastSeenAt: string;
  activeInFavorite: boolean;
  accessRestriction?: ChargingAccessRestriction;
}

export interface FolderDetailSummary {
  total: number;
  activeTotal: number;
  historicalTotal: number;
  uploaded: number;
  pending: number;
  pendingUnavailable: number;
  uploadedUnavailable: number;
}

export interface FolderIndexSummary extends FolderDetailSummary {
  indexed: number;
  biliTotal?: number;
  complete: boolean;
  scanStatus: FolderScanState["initStatus"];
  scanComplete: boolean;
  scannedTotal: number;
  unreturnedCount: number;
}

export interface RemoteFilePreviewVideoRecord {
  bvid: string;
  title: string;
  upperName: string;
  remotePath?: string;
  remoteFiles: RemoteFileRecord[];
  relations: Array<{
    userId: string;
    mediaId: number;
    folderTitle: string;
    backupStatus?: BackupStatus;
    hasInterruptedQualityUpgrade: boolean;
    remotePath?: string;
    remoteFiles: RemoteFileRecord[];
  }>;
}

export interface StateFile {
  schemaVersion?: number;
  processedByUser: Record<string, Record<string, ProcessedEntry>>;
  failedByUser?: Record<string, Record<string, FailedEntry>>;
  videos?: Record<string, VideoArchiveEntry>;
  relations?: Record<string, FavoriteRelation>;
  folderScans?: Record<string, FolderScanState>;
  userCooldowns?: Record<string, UserCooldown>;
  downloadApiCooldown?: PersistedDownloadApiCooldown;
}

const defaultStatePath = path.join(dataDir, "state.json");
const defaultState: StateFile = {
  schemaVersion: 13,
  processedByUser: {},
  failedByUser: {},
  videos: {},
  relations: {},
  folderScans: {},
  userCooldowns: {},
};

const BACKED_UP_STATUSES = new Set<BackupStatus>(["uploaded", "verified", "partial_verified"]);
const ACTIVE_BACKUP_STATUSES = new Set<BackupStatus>([
  "queued",
  "downloading",
  "downloaded",
  "uploading",
]);
const RELATION_BACKUP_PRIORITY: BackupStatus[] = [
  "uploading",
  "upload_failed",
  "downloading",
  "downloaded",
  "queued",
  "missing",
  "failed",
  "charging_restricted",
  "discovered",
  "lost",
  "uploaded",
  "partial_verified",
  "verified",
];

function nowIso() {
  return new Date().toISOString();
}

function isPlaceholderTitle(value: string | undefined) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(Untitled|Unknown|已失效视频|已删除视频|视频已失效|视频不存在)$/i.test(text);
}

function isPlaceholderUpperName(value: string | undefined) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(Unknown|未知UP|未知)$/i.test(text);
}

function hasUsableFavoriteMeta(item: ObservedFavoriteItem) {
  if (item.unavailable && !item.selfVisible) return false;
  return !isPlaceholderTitle(item.title) || !isPlaceholderUpperName(item.upperName) || Boolean(item.cover);
}

function displayTitle(entry: VideoArchiveEntry) {
  return entry.originalMeta?.title || entry.title || entry.bvid;
}

function displayUpperName(entry: VideoArchiveEntry) {
  return entry.originalMeta?.upperName || entry.upperName || "Unknown";
}

function displayCover(entry: VideoArchiveEntry) {
  return entry.originalMeta?.cover || entry.cover;
}

function displayCoverLocalPath(entry: VideoArchiveEntry) {
  return entry.originalMeta?.coverLocalPath;
}

function displayDescription(entry: VideoArchiveEntry) {
  return entry.originalMeta?.description || entry.description;
}

function relationTreatsUnavailable(relation: FavoriteRelation | undefined | null, entry: VideoArchiveEntry) {
  return entry.biliStatus === "unavailable" && !relation?.selfVisible;
}

export function relationKey(userId: string, mediaId: number, bvid: string) {
  return `${userId}:${mediaId}:${bvid}`;
}

function failedKey(mediaId: number, bvid: string) {
  return `${mediaId}:${bvid}`;
}

function folderKey(userId: string, mediaId: number) {
  return `${userId}:${mediaId}`;
}

export interface DatabaseReplacementHandle {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export class StateManager {
  private state: StateFile;
  private readonly statePath: string;
  private readonly dbPath: string;
  private readonly archiveDir: string;
  private database: StateDatabase;
  private dirtySet: StateDirtySet = this.newDirtySet();
  private batchDepth = 0;
  private dirty = false;
  private suppressFlush = false;
  private lazyState = false;
  private videoCache = new Map<string, VideoArchiveEntry>();
  private relationCache = new Map<string, FavoriteRelation>();
  private videoDeletes = new Set<string>();
  private relationDeletes = new Set<string>();
  private readonly onFlush?: (dirty: StateDirtySet) => void;
  private readonly onFullEnumeration?: (kind: "videos" | "relations") => void;

  constructor(options: {
    statePath?: string;
    dbPath?: string;
    archiveDir?: string;
    onFlush?: (dirty: StateDirtySet) => void;
    onFullEnumeration?: (kind: "videos" | "relations") => void;
  } = {}) {
    this.statePath = options.statePath || defaultStatePath;
    this.dbPath = options.dbPath || (options.statePath ? ":memory:" : databasePath);
    this.archiveDir = options.archiveDir || (this.dbPath === ":memory:" ? path.join(path.dirname(this.statePath), "backups") : path.join(path.dirname(this.dbPath), "backups"));
    this.onFlush = options.onFlush;
    this.onFullEnumeration = options.onFullEnumeration;
    this.database = this.initializeDatabase();
    this.state = this.trackDatabaseState(this.database.loadStateMetadata());
    this.lazyState = true;
    this.resetDirtySet();
  }

  private newDirtySet(): StateDirtySet {
    return {
      videos: new Set(),
      relations: new Set(),
      folderScans: new Set(),
      failures: false,
      cooldowns: false,
      metadata: false,
    };
  }

  private resetDirtySet() {
    this.dirtySet = this.newDirtySet();
    this.dirty = false;
  }

  private normalizeLoadedState(input: StateFile): StateFile {
    input.schemaVersion ||= 13;
    input.processedByUser ||= {};
    input.failedByUser ||= {};
    input.videos ||= {};
    input.relations ||= {};
    input.folderScans ||= {};
    input.userCooldowns ||= {};
    return input;
  }

  private trackValue<T extends object>(value: T, mark: () => void, cache = new WeakMap<object, any>()): T {
    if (!value || typeof value !== "object") return value;
    const cached = cache.get(value);
    if (cached) return cached;
    const proxy = new Proxy(value as any, {
      get: (target, property, receiver) => {
        const child = Reflect.get(target, property, receiver);
        return child && typeof child === "object" ? this.trackValue(child, mark, cache) : child;
      },
      set: (target, property, next, receiver) => {
        const changed = Reflect.get(target, property, receiver) !== next;
        const result = Reflect.set(target, property, next, receiver);
        if (changed) mark();
        return result;
      },
      deleteProperty: (target, property) => {
        const existed = Reflect.has(target, property);
        const result = Reflect.deleteProperty(target, property);
        if (existed) mark();
        return result;
      },
    });
    cache.set(value, proxy);
    return proxy;
  }

  private trackRecordMap<T extends object>(
    input: Record<string, T>,
    markKey: (key: string) => void
  ): Record<string, T> {
    const values = new Map<string, T>();
    for (const [key, value] of Object.entries(input || {})) {
      values.set(key, this.trackValue(value, () => markKey(key)));
    }
    return new Proxy(input || {}, {
      get: (target, property, receiver) => {
        if (typeof property === "string" && values.has(property)) return values.get(property);
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, next, receiver) => {
        if (typeof property === "string" && next && typeof next === "object") {
          const tracked = this.trackValue(next, () => markKey(property));
          values.set(property, tracked);
          Reflect.set(target, property, tracked, receiver);
          markKey(property);
          return true;
        }
        const result = Reflect.set(target, property, next, receiver);
        if (typeof property === "string") markKey(property);
        return result;
      },
      deleteProperty: (target, property) => {
        if (typeof property === "string") {
          values.delete(property);
          markKey(property);
        }
        return Reflect.deleteProperty(target, property);
      },
      ownKeys: (target) => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target, property) => Reflect.getOwnPropertyDescriptor(target, property),
    });
  }

  private trackLazyRecordMap<T extends object>(
    kind: "videos" | "relations",
    cache: Map<string, T>,
    deletes: Set<string>,
    listKeys: () => string[],
    load: (key: string) => T | undefined,
    markKey: (key: string) => void,
    isDirty: (key: string) => boolean
  ): Record<string, T> {
    const trim = () => {
      while (cache.size > 256) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest) return;
        if (isDirty(oldest)) {
          const value = cache.get(oldest)!;
          cache.delete(oldest);
          cache.set(oldest, value);
          if ([...cache.keys()].every(isDirty)) return;
          continue;
        }
        cache.delete(oldest);
      }
    };
    const tracked = (key: string, value: T) => {
      let proxy: T;
      proxy = this.trackValue(value, () => {
        deletes.delete(key);
        cache.set(key, proxy);
        markKey(key);
      });
      return proxy;
    };
    return new Proxy({} as Record<string, T>, {
      get: (_target, property) => {
        if (typeof property !== "string" || property === "__proto__") return undefined;
        if (deletes.has(property)) return undefined;
        const cached = cache.get(property);
        if (cached) {
          cache.delete(property);
          cache.set(property, cached);
          return cached;
        }
        const value = load(property);
        if (!value) return undefined;
        const valueProxy = tracked(property, value);
        cache.set(property, valueProxy);
        trim();
        return valueProxy;
      },
      set: (_target, property, value) => {
        if (typeof property !== "string" || !value || typeof value !== "object") return false;
        deletes.delete(property);
        cache.set(property, tracked(property, value));
        markKey(property);
        trim();
        return true;
      },
      deleteProperty: (_target, property) => {
        if (typeof property !== "string") return false;
        cache.delete(property);
        deletes.add(property);
        markKey(property);
        return true;
      },
      ownKeys: () => {
        this.onFullEnumeration?.(kind);
        return [...new Set([...listKeys().filter((key) => !deletes.has(key)), ...cache.keys()])];
      },
      getOwnPropertyDescriptor: (_target, property) => {
        if (typeof property !== "string" || deletes.has(property)) return undefined;
        return { enumerable: true, configurable: true };
      },
    });
  }

  private trackDatabaseState(input: StateFile): StateFile {
    const state = this.normalizeLoadedState(input);
    state.videos = this.trackLazyRecordMap(
      "videos",
      this.videoCache,
      this.videoDeletes,
      () => this.database.listVideoKeys(),
      (key) => this.database.getVideo(key),
      (key) => { this.dirtySet.videos.add(key); this.dirty = true; },
      (key) => this.dirtySet.videos.has(key)
    );
    state.relations = this.trackLazyRecordMap(
      "relations",
      this.relationCache,
      this.relationDeletes,
      () => this.database.listRelationKeys(),
      (key) => this.database.getRelation(key),
      (key) => { this.dirtySet.relations.add(key); this.dirty = true; },
      (key) => this.dirtySet.relations.has(key)
    );
    state.folderScans = this.trackRecordMap(state.folderScans || {}, (key) => { this.dirtySet.folderScans.add(key); this.dirty = true; });
    state.failedByUser = this.trackValue(state.failedByUser || {}, () => { this.dirtySet.failures = true; this.dirty = true; });
    state.userCooldowns = this.trackValue(state.userCooldowns || {}, () => { this.dirtySet.cooldowns = true; this.dirty = true; });
    state.processedByUser = {};
    return new Proxy(state, {
      set: (target, property, next, receiver) => {
        const result = Reflect.set(target, property, next, receiver);
        if (property === "downloadApiCooldown") this.dirtySet.cooldowns = true;
        else this.dirtySet.metadata = true;
        this.dirty = true;
        return result;
      },
      deleteProperty: (target, property) => {
        const result = Reflect.deleteProperty(target, property);
        if (property === "downloadApiCooldown") this.dirtySet.cooldowns = true;
        else this.dirtySet.metadata = true;
        this.dirty = true;
        return result;
      },
    });
  }

  private trackState(input: StateFile): StateFile {
    const state = this.normalizeLoadedState(input);
    state.videos = this.trackRecordMap(state.videos || {}, (key) => {
      this.dirtySet.videos.add(key);
      this.dirty = true;
    });
    state.relations = this.trackRecordMap(state.relations || {}, (key) => {
      this.dirtySet.relations.add(key);
      this.dirty = true;
    });
    state.folderScans = this.trackRecordMap(state.folderScans || {}, (key) => {
      this.dirtySet.folderScans.add(key);
      this.dirty = true;
    });
    state.failedByUser = this.trackValue(state.failedByUser || {}, () => {
      this.dirtySet.failures = true;
      this.dirty = true;
    });
    state.userCooldowns = this.trackValue(state.userCooldowns || {}, () => {
      this.dirtySet.cooldowns = true;
      this.dirty = true;
    });
    state.processedByUser = this.trackValue(state.processedByUser || {}, () => {
      this.dirtySet.metadata = true;
      this.dirty = true;
    });
    return new Proxy(state, {
      set: (target, property, next, receiver) => {
        const result = Reflect.set(target, property, next, receiver);
        if (property === "downloadApiCooldown") this.dirtySet.cooldowns = true;
        else this.dirtySet.metadata = true;
        this.dirty = true;
        return result;
      },
      deleteProperty: (target, property) => {
        const result = Reflect.deleteProperty(target, property);
        if (property === "downloadApiCooldown") this.dirtySet.cooldowns = true;
        else this.dirtySet.metadata = true;
        this.dirty = true;
        return result;
      },
    });
  }

  private snapshotState(): StateFile {
    if (this.lazyState) {
      this.flush();
      const snapshot = this.database.loadState();
      this.videoCache.clear();
      this.relationCache.clear();
      return snapshot;
    }
    return JSON.parse(JSON.stringify(this.state)) as StateFile;
  }

  private initializeDatabase() {
    const readLegacyStateStrict = () => {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Legacy state.json must contain a JSON object");
      }
      return parsed as StateFile;
    };
    if (this.dbPath === ":memory:") {
      const database = new StateDatabase(":memory:");
      if (fs.existsSync(this.statePath)) {
        this.database = database;
        this.state = this.trackState(this.normalizeLoadedState(readLegacyStateStrict()));
        this.suppressFlush = true;
        this.migrateLegacyState();
        this.suppressFlush = false;
        database.replaceState(this.snapshotState());
        this.resetDirtySet();
      }
      return database;
    }

    if (fs.existsSync(this.dbPath)) {
      const database = new StateDatabase(this.dbPath);
      try {
        database.integrityCheck();
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    }

    const tempPath = `${this.dbPath}.migrating`;
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${tempPath}${suffix}`, { force: true });
    }
    const database = new StateDatabase(tempPath);
    try {
      const legacyExists = fs.existsSync(this.statePath);
      const rawState = legacyExists
        ? readLegacyStateStrict()
        : this.normalizeLoadedState({ ...defaultState });
      this.database = database;
      this.state = this.trackState(this.normalizeLoadedState(rawState));
      this.suppressFlush = true;
      this.migrateLegacyState();
      this.suppressFlush = false;
      const migrated = this.snapshotState();
      database.replaceState(migrated);
      const dbCounts = database.db.prepare(`
        SELECT (SELECT COUNT(*) FROM videos) AS videos, (SELECT COUNT(*) FROM favorite_relations) AS relations
      `).get() as any;
      if (Number(dbCounts.videos) !== Object.keys(migrated.videos || {}).length
        || Number(dbCounts.relations) !== Object.keys(migrated.relations || {}).length) {
        throw new Error("SQLite migration count verification failed");
      }
      database.close();
      fs.renameSync(tempPath, this.dbPath);
      if (legacyExists) {
        archiveLegacyStateFile(this.statePath, this.archiveDir, {
          videos: Object.keys(migrated.videos || {}).length,
          relations: Object.keys(migrated.relations || {}).length,
          integrityCheck: "ok",
          foreignKeyErrors: 0,
        });
        fs.rmSync(this.statePath, { force: true });
      }
    } catch (error) {
      database.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${tempPath}${suffix}`, { force: true });
      throw error;
    }
    const reopened = new StateDatabase(this.dbPath);
    try {
      reopened.integrityCheck();
      return reopened;
    } catch (error) {
      reopened.close();
      throw error;
    }
  }

  reload() {
    this.videoCache.clear();
    this.relationCache.clear();
    this.videoDeletes.clear();
    this.relationDeletes.clear();
    this.state = this.trackDatabaseState(this.database.loadStateMetadata());
    this.lazyState = true;
    this.resetDirtySet();
  }

  runBatch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) {
        this.flush();
      }
    }
  }

  getStateSnapshot() {
    return this.snapshotState();
  }

  getLazyCacheStats() {
    return { videos: this.videoCache.size, relations: this.relationCache.size, limit: 256 };
  }

  private getRelation(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    if (!userId || !mediaId) return null;
    return this.state.relations?.[relationKey(userId, mediaId, bvid)] || null;
  }

  private getFailedEntry(userId: string, bvid: string, mediaId?: number) {
    if (this.lazyState) return this.database.getFailure(userId, bvid, mediaId);
    const userEntries = this.state.failedByUser?.[userId];
    if (!userEntries) return undefined;
    if (typeof mediaId === "number") {
      return userEntries[failedKey(mediaId, bvid)] || userEntries[bvid];
    }
    if (userEntries[bvid]) {
      return userEntries[bvid];
    }
    return Object.values(userEntries).find((entry) => entry?.bvid === bvid);
  }

  private updateTargetRelations(
    bvid: string,
    targets: Array<{ userId: string; mediaId: number }> | undefined,
    updater: (relation: FavoriteRelation) => void
  ) {
    const relations = targets?.length
      ? targets.map((target) => this.getRelation(target.userId, target.mediaId, bvid)).filter((item): item is FavoriteRelation => Boolean(item))
      : (this.lazyState ? this.database.listRelationsForBvid(bvid) : Object.values(this.state.relations || {}).filter((relation) => relation.bvid === bvid));
    for (const relation of relations) {
      updater(relation);
    }
  }

  private setVideoStatus(entry: VideoArchiveEntry, status: BackupStatus, at = nowIso()) {
    if (entry.backupStatus !== status || !entry.statusUpdatedAt) {
      entry.statusUpdatedAt = at;
    }
    entry.backupStatus = status;
  }

  private setRelationStatus(relation: FavoriteRelation, status: BackupStatus, at = nowIso()) {
    if (relation.backupStatus !== status || !relation.statusUpdatedAt) {
      relation.statusUpdatedAt = at;
    }
    relation.backupStatus = status;
  }

  private isStaleActiveStatus(status: BackupStatus | undefined, statusUpdatedAt: string | undefined, maxAgeMs: number) {
    if (!status || !ACTIVE_BACKUP_STATUSES.has(status)) return false;
    if (!statusUpdatedAt) return true;
    const updatedAt = Date.parse(statusUpdatedAt);
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= maxAgeMs;
  }

  private initialRelationStatus(bvid: string, relation?: FavoriteRelation | null): BackupStatus {
    const entry = this.state.videos?.[bvid];
    if (!entry) return "discovered";
    if (relationTreatsUnavailable(relation, entry)) return "lost";
    if (ACTIVE_BACKUP_STATUSES.has(entry.backupStatus)) return entry.backupStatus;
    if (["missing", "failed", "upload_failed", "charging_restricted"].includes(entry.backupStatus)) return entry.backupStatus;
    return "discovered";
  }

  private refreshVideoAggregateStatus(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const relations = this.lazyState
      ? (() => {
          const rows = new Map(this.database.listRelationsForBvid(bvid).map((relation) => [relationKey(relation.userId, relation.mediaId, relation.bvid), relation]));
          for (const [key, relation] of this.relationCache) {
            if (relation.bvid === bvid) rows.set(key, relation);
          }
          for (const key of this.relationDeletes) rows.delete(key);
          return [...rows.values()];
        })()
      : Object.values(this.state.relations || {}).filter((relation) => relation.bvid === bvid);
    if (relations.length === 0) return;
    const statuses = relations.map((relation) => relation.backupStatus || this.initialRelationStatus(bvid, relation));
    const active = statuses.find((status) => ACTIVE_BACKUP_STATUSES.has(status));
    if (active) {
      this.setVideoStatus(entry, active);
      return;
    }
    for (const status of RELATION_BACKUP_PRIORITY) {
      if (statuses.includes(status)) {
        this.setVideoStatus(entry, status);
        return;
      }
    }
  }

  isProcessed(userId: string, bvid: string, mediaId?: number) {
    const relation = mediaId ? this.state.relations?.[relationKey(userId, mediaId, bvid)] : undefined;
    if (relation?.backupStatus) {
      return BACKED_UP_STATUSES.has(relation.backupStatus);
    }
    const entry = this.state.videos?.[bvid];
    return Boolean(entry && BACKED_UP_STATUSES.has(entry.backupStatus));
  }

  isFailed(userId: string, bvid: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    const status = relation?.backupStatus || entry?.backupStatus;
    if (status === "failed" || status === "lost") {
      return true;
    }
    return Boolean(this.getFailedEntry(userId, bvid, mediaId));
  }

  recordFavoriteItem(
    userId: string,
    mediaId: number,
    folderTitle: string,
    item: ObservedFavoriteItem,
    orderInfo?: {
      favOrder?: number;
      favPage?: number;
      favIndexInPage?: number;
    },
    seenAt = nowIso()
  ) {
    const existing = this.state.videos![item.bvid];
    const wasKnown = Boolean(existing);
    const favoriteUnavailable = Boolean(item.favoriteUnavailable || item.unavailable);
    const biliStatus: BiliStatus = favoriteUnavailable ? "unavailable" : "available";
    const relationStatus: BackupStatus = favoriteUnavailable && !item.selfVisible ? "lost" : "discovered";

    if (!existing) {
      const originalMeta = hasUsableFavoriteMeta(item)
        ? {
            title: isPlaceholderTitle(item.title) ? item.bvid : item.title,
            upperName: isPlaceholderUpperName(item.upperName) ? "Unknown" : item.upperName,
            cover: item.cover,
            description: item.description,
            capturedAt: seenAt,
          }
        : undefined;
      this.state.videos![item.bvid] = {
        bvid: item.bvid,
        title: item.title || "Untitled",
        upperName: item.upperName || "Unknown",
        cover: item.cover,
        description: item.description,
        originalMeta,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        biliStatus,
        backupStatus: relationStatus,
        statusUpdatedAt: seenAt,
        favoriteUnavailable: favoriteUnavailable || undefined,
        selfVisible: item.selfVisible || undefined,
      };
    } else {
      if (!isPlaceholderTitle(item.title)) {
        existing.title = item.title || existing.title;
      }
      if (!isPlaceholderUpperName(item.upperName)) {
        existing.upperName = item.upperName || existing.upperName;
      }
      if (item.cover) {
        existing.cover = item.cover;
      }
      if (item.description !== undefined) {
        existing.description = item.description;
      }
      if (hasUsableFavoriteMeta(item)) {
        existing.originalMeta = {
          title: isPlaceholderTitle(item.title) ? existing.originalMeta?.title || existing.title || item.bvid : item.title,
          upperName: isPlaceholderUpperName(item.upperName) ? existing.originalMeta?.upperName || existing.upperName || "Unknown" : item.upperName,
          cover: item.cover || existing.originalMeta?.cover || existing.cover,
          coverLocalPath: existing.originalMeta?.coverLocalPath,
          description: item.description ?? existing.originalMeta?.description ?? existing.description,
          capturedAt: seenAt,
        };
      }
      existing.lastSeenAt = seenAt;
      existing.biliStatus = biliStatus;
      existing.favoriteUnavailable = favoriteUnavailable || undefined;
      existing.selfVisible = item.selfVisible || undefined;
      if (favoriteUnavailable && !item.selfVisible && !BACKED_UP_STATUSES.has(existing.backupStatus)) {
        this.setVideoStatus(existing, "lost", seenAt);
        existing.lastError = "Video became unavailable before a verified backup was found.";
      } else if (!favoriteUnavailable && existing.backupStatus === "lost") {
        this.setVideoStatus(existing, "discovered", seenAt);
        existing.lastError = undefined;
      } else if (item.selfVisible && existing.backupStatus === "lost") {
        this.setVideoStatus(existing, "discovered", seenAt);
        existing.lastError = undefined;
      }
    }

    const key = relationKey(userId, mediaId, item.bvid);
    const relation = this.state.relations![key];
    if (relation) {
      relation.folderTitle = folderTitle;
      relation.lastSeenAt = seenAt;
      relation.activeInFavorite = true;
      relation.accountDetachedAt = undefined;
      relation.favoriteUnavailable = favoriteUnavailable || undefined;
      relation.selfVisible = item.selfVisible || undefined;
      if (Number.isInteger(orderInfo?.favOrder) && Number(orderInfo!.favOrder) > 0) {
        relation.favOrder = Number(orderInfo!.favOrder);
        relation.favPage = Number.isInteger(orderInfo?.favPage) && Number(orderInfo!.favPage) > 0 ? Number(orderInfo!.favPage) : relation.favPage;
        relation.favIndexInPage = Number.isInteger(orderInfo?.favIndexInPage) && Number(orderInfo!.favIndexInPage) >= 0
          ? Number(orderInfo!.favIndexInPage)
          : relation.favIndexInPage;
        relation.favOrderUpdatedAt = seenAt;
      }
      if (!relation.backupStatus) {
        this.setRelationStatus(relation, this.initialRelationStatus(item.bvid, relation), seenAt);
      } else if (item.selfVisible && relation.backupStatus === "lost") {
        this.setRelationStatus(relation, "discovered", seenAt);
        relation.lastError = undefined;
      } else if (favoriteUnavailable && !item.selfVisible && !BACKED_UP_STATUSES.has(relation.backupStatus)) {
        this.setRelationStatus(relation, "lost", seenAt);
        relation.lastError = "Video became unavailable before a verified backup was found.";
      }
    } else {
      this.state.relations![key] = {
        userId,
        mediaId,
        bvid: item.bvid,
        folderTitle,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        favOrder: Number.isInteger(orderInfo?.favOrder) && Number(orderInfo!.favOrder) > 0 ? Number(orderInfo!.favOrder) : undefined,
        favPage: Number.isInteger(orderInfo?.favPage) && Number(orderInfo!.favPage) > 0 ? Number(orderInfo!.favPage) : undefined,
        favIndexInPage: Number.isInteger(orderInfo?.favIndexInPage) && Number(orderInfo!.favIndexInPage) >= 0
          ? Number(orderInfo!.favIndexInPage)
          : undefined,
        favOrderUpdatedAt: Number.isInteger(orderInfo?.favOrder) && Number(orderInfo!.favOrder) > 0 ? seenAt : undefined,
        activeInFavorite: true,
        backupStatus: relationStatus,
        statusUpdatedAt: seenAt,
        favoriteUnavailable: favoriteUnavailable || undefined,
        selfVisible: item.selfVisible || undefined,
      };
    }

    this.refreshVideoAggregateStatus(item.bvid);
    this.save();
    return { wasKnown, entry: this.state.videos![item.bvid] };
  }

  recordCoverCache(bvid: string, coverLocalPath: string, capturedAt = nowIso()) {
    const entry = this.state.videos?.[bvid];
    if (!entry || !coverLocalPath) {
      return false;
    }
    const snapshot: VideoMetadataSnapshot = {
      title: entry.originalMeta?.title || entry.title || bvid,
      upperName: entry.originalMeta?.upperName || entry.upperName || "Unknown",
      cover: entry.originalMeta?.cover || entry.cover,
      coverLocalPath,
      description: entry.originalMeta?.description || entry.description,
      capturedAt: entry.originalMeta?.capturedAt || capturedAt,
    };
    if (entry.originalMeta?.coverLocalPath === coverLocalPath) {
      return false;
    }
    entry.originalMeta = snapshot;
    this.save();
    return true;
  }

  markMissingFavoritesInactive(userId: string, mediaId: number, seenBvids: Set<string>) {
    let changed = false;
    const relations = this.lazyState ? this.database.listRelationsForFolder(userId, mediaId) : Object.values(this.state.relations || {});
    for (const relation of relations) {
      if (relation.userId !== userId || relation.mediaId !== mediaId || !relation.activeInFavorite || seenBvids.has(relation.bvid)) {
        continue;
      }
      const tracked = this.getRelation(relation.userId, relation.mediaId, relation.bvid);
      if (!tracked) continue;
      tracked.activeInFavorite = false;
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  canBootstrapRelationFromGlobalProof(_bvid: string, _userId: string, _mediaId: number) {
    // Disabled to avoid false-positive "uploaded" status caused by cross-folder global proof.
    return false;
  }

  bootstrapRelationFromGlobalProof(_bvid: string, _userId: string, _mediaId: number, _remotePath: string) {
    return false;
  }

  shouldEnqueueBackup(bvid: string, userId?: string, mediaId?: number, cycleStartedAt?: string) {
    const entry = this.state.videos?.[bvid];
    const relation = userId && mediaId ? this.state.relations?.[relationKey(userId, mediaId, bvid)] : undefined;
    if (!entry || relationTreatsUnavailable(relation, entry)) {
      return false;
    }
    const failed = userId ? this.getFailedEntry(userId, bvid, mediaId) : undefined;
    if (failed?.permanent) {
      return false;
    }
    if (failed && cycleStartedAt) {
      const failedAt = Date.parse(failed.failedAt);
      const cycleStarted = Date.parse(cycleStartedAt);
      if (Number.isFinite(failedAt) && Number.isFinite(cycleStarted) && failedAt >= cycleStarted) {
        return false;
      }
    }
    const status = relation?.backupStatus || entry.backupStatus;
    if (status === "upload_failed") {
      return false;
    }
    if (BACKED_UP_STATUSES.has(status)) {
      return false;
    }
    if (ACTIVE_BACKUP_STATUSES.has(status)) {
      return false;
    }
    return status === "discovered" || status === "missing" || status === "failed";
  }

  markQueued(bvid: string, remotePath: string, userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "queued", at);
    entry.remotePath = remotePath;
    entry.lastError = undefined;
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      this.setRelationStatus(relation, "queued", at);
      relation.remotePath = remotePath;
      relation.lastError = undefined;
    }
    this.save();
  }

  markDownloading(bvid: string, targets?: Array<{ userId: string; mediaId: number }>) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "downloading", at);
    this.updateTargetRelations(bvid, targets, (relation) => {
      this.setRelationStatus(relation, "downloading", at);
    });
    this.save();
  }

  markDownloadPrepared(
    bvid: string,
    localDir: string,
    session: DownloadSessionReference,
    targets?: Array<{ userId: string; mediaId: number }>
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "downloading", at);
    entry.localDir = localDir;
    entry.downloadSession = { ...session, localDir, updatedAt: at };
    this.updateTargetRelations(bvid, targets, (relation) => {
      this.setRelationStatus(relation, "downloading", at);
    });
    this.save();
  }

  markDownloadInterrupted(
    bvid: string,
    localDir: string,
    reason: string,
    targets?: Array<{ userId: string; mediaId: number }>
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "queued", at);
    entry.localDir = localDir;
    entry.lastError = reason;
    const manifest = readDownloadSession(localDir);
    if (manifest) {
      entry.downloadSession = {
        id: manifest.sessionId,
        localDir,
        kind: manifest.kind,
        status: manifest.status,
        completedPages: manifest.outputs.length,
        totalPages: manifest.pages.length,
        updatedAt: manifest.updatedAt,
      };
    }
    this.updateTargetRelations(bvid, targets, (relation) => {
      this.setRelationStatus(relation, "queued", at);
      relation.lastError = reason;
    });
    this.save();
  }

  markDownloaded(bvid: string, localDir: string, targets?: Array<{ userId: string; mediaId: number }>) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "downloaded", at);
    entry.localDir = localDir;
    const manifest = readDownloadSession(localDir);
    if (manifest) {
      entry.downloadSession = {
        id: manifest.sessionId,
        localDir,
        kind: manifest.kind,
        status: manifest.status,
        completedPages: manifest.outputs.length,
        totalPages: manifest.pages.length,
        updatedAt: manifest.updatedAt,
      };
    }
    this.updateTargetRelations(bvid, targets, (relation) => {
      this.setRelationStatus(relation, "downloaded", at);
    });
    this.save();
  }

  markUploading(bvid: string, userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    this.setVideoStatus(entry, "uploading", at);
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      this.setRelationStatus(relation, "uploading", at);
    }
    this.save();
  }

  markRetryPending(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    if (entry.favoriteUnavailable && !entry.selfVisible) {
      this.setVideoStatus(entry, "lost");
      entry.lastError ||= "Video unavailable while resuming backup.";
      this.save();
      return;
    }
    this.setVideoStatus(entry, "discovered");
    entry.localDir = undefined;
    entry.downloadSession = undefined;
    this.save();
  }

  markRelationRetryPending(bvid: string, userId?: string, mediaId?: number, reason?: string) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation) {
      this.markRetryPending(bvid);
      return;
    }
    this.setRelationStatus(relation, entry && relationTreatsUnavailable(relation, entry) ? "lost" : "discovered");
    relation.lastError = reason;
    relation.nextRemoteCheckAt = undefined;
    this.refreshVideoAggregateStatus(bvid);
    this.save();
  }

  private applyVerifiedRemoteFiles(
    entry: VideoArchiveEntry,
    relation: FavoriteRelation | null,
    remotePath: string,
    remoteFiles: RemoteFileRecord[],
    at: string,
    partial = false
  ) {
    entry.remotePath = remotePath;
    entry.remoteFiles = remoteFiles;
    entry.uploadedAt = at;
    entry.lastRemoteCheckAt = at;
    entry.nextRemoteCheckAt = undefined;
    entry.remoteMissingCount = 0;
    if (relation) {
      this.setRelationStatus(relation, partial ? "partial_verified" : "verified", at);
      relation.remotePath = remotePath;
      relation.remoteFiles = remoteFiles;
      relation.uploadedAt = at;
      relation.verifiedAt = at;
      relation.lastRemoteCheckAt = at;
      relation.nextRemoteCheckAt = undefined;
      relation.remoteMissingCount = 0;
      relation.pendingPartialBackup = undefined;
      relation.lastError = undefined;
      this.clearFailedEntry(relation.userId, relation.mediaId, relation.bvid);
      this.refreshVideoAggregateStatus(entry.bvid);
      if (entry.backupStatus === "verified" || entry.backupStatus === "partial_verified") {
        entry.verifiedAt = at;
        entry.lastError = undefined;
      } else {
        entry.verifiedAt = undefined;
        entry.lastError = (this.lazyState ? this.database.listRelationsForBvid(entry.bvid) : Object.values(this.state.relations || {}))
          .find((item) => item.bvid === entry.bvid && Boolean(item.lastError))
          ?.lastError;
      }
    } else {
      this.setVideoStatus(entry, partial ? "partial_verified" : "verified", at);
      entry.verifiedAt = at;
      entry.lastError = undefined;
    }
  }

  markChargingRestricted(
    bvid: string,
    value: {
      checkedAt: string;
      nextCheckAt: string;
      previewAvailable?: boolean;
      checkedAccountUids: string[];
      lastError?: string;
    }
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const current = entry.accessRestriction;
    entry.accessRestriction = {
      type: "charging",
      detectedAt: current?.detectedAt || value.checkedAt,
      lastCheckedAt: value.checkedAt,
      nextCheckAt: value.nextCheckAt,
      previewAvailable: value.previewAvailable ?? current?.previewAvailable,
      checkedAccountUids: [...new Set(value.checkedAccountUids.map(String))],
      lastError: value.lastError,
    };
    entry.accessClassification = {
      purpose: "legacy_failure_classification",
      classifiedAt: value.checkedAt,
      result: "charging",
      nextCheckAt: value.nextCheckAt,
    };
    entry.lastError = undefined;
    for (const relation of this.listRelationsForBvid(bvid)) {
      if (!relation.activeInFavorite || BACKED_UP_STATUSES.has(relation.backupStatus || "discovered")) continue;
      this.setRelationStatus(relation, "charging_restricted", value.checkedAt);
      relation.lastError = undefined;
      this.state.relations![relationKey(relation.userId, relation.mediaId, bvid)] = relation;
      this.clearFailedEntry(relation.userId, relation.mediaId, bvid);
    }
    this.refreshVideoAggregateStatus(bvid);
    if (entry.backupStatus !== "verified" && entry.backupStatus !== "partial_verified" && entry.backupStatus !== "uploaded") {
      this.setVideoStatus(entry, "charging_restricted", value.checkedAt);
    }
    this.save();
  }

  clearChargingRestriction(bvid: string, checkedAt = nowIso()) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    delete entry.accessRestriction;
    for (const relation of this.listRelationsForBvid(bvid)) {
      if (relation.backupStatus !== "charging_restricted") continue;
      this.setRelationStatus(relation, relationTreatsUnavailable(relation, entry) ? "lost" : "discovered", checkedAt);
      relation.lastError = undefined;
      this.state.relations![relationKey(relation.userId, relation.mediaId, bvid)] = relation;
      this.clearFailedEntry(relation.userId, relation.mediaId, bvid);
    }
    if (entry.backupStatus === "charging_restricted") this.setVideoStatus(entry, "discovered", checkedAt);
    entry.lastError = undefined;
    this.refreshVideoAggregateStatus(bvid);
    this.save();
  }

  markUnavailableFromAccessProbe(bvid: string, checkedAt = nowIso()) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    delete entry.accessRestriction;
    entry.biliStatus = "unavailable";
    entry.favoriteUnavailable = true;
    entry.lastError = "Video became unavailable before a verified backup was found.";
    for (const relation of this.listRelationsForBvid(bvid)) {
      if (BACKED_UP_STATUSES.has(relation.backupStatus || "discovered")) continue;
      relation.favoriteUnavailable = true;
      this.setRelationStatus(relation, "lost", checkedAt);
      relation.lastError = entry.lastError;
      this.state.relations![relationKey(relation.userId, relation.mediaId, bvid)] = relation;
    }
    this.refreshVideoAggregateStatus(bvid);
    this.save();
  }

  getChargingRestriction(bvid: string) {
    return this.state.videos?.[bvid]?.accessRestriction;
  }

  listChargingRestrictedVideos() {
    const videos = this.lazyState ? this.database.listChargingRestrictedVideos() : Object.values(this.state.videos || {});
    return videos.filter((video) => video.accessRestriction?.type === "charging" && this.listRelationsForBvid(video.bvid)
      .some((relation) => relation.activeInFavorite && !BACKED_UP_STATUSES.has(relation.backupStatus || "discovered")));
  }

  getChargingRestrictionSummary() {
    if (this.lazyState) return this.database.getChargingRestrictionSummary();
    const videos = this.listChargingRestrictedVideos();
    return {
      count: videos.length,
      lastCheckedAt: videos.map((video) => video.accessRestriction?.lastCheckedAt).filter(Boolean).sort().pop(),
    };
  }

  listLegacyFailureClassificationCandidates(limit = 10_000) {
    return this.database.listPermanentFailureRelations(limit);
  }

  markLegacyAccessClassification(
    bvid: string,
    value: {
      result?: "available" | "unavailable" | "other_restricted";
      classifiedAt?: string;
      nextCheckAt?: string;
    }
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.accessClassification = {
      purpose: "legacy_failure_classification",
      result: value.result,
      classifiedAt: value.classifiedAt,
      nextCheckAt: value.nextCheckAt,
    };
    if (value.result === "available") {
      entry.biliStatus = "available";
      entry.lastError = undefined;
      for (const relation of this.listRelationsForBvid(bvid)) {
        if (!relation.activeInFavorite || ["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
        const tracked = this.getRelation(relation.userId, relation.mediaId, bvid);
        if (!tracked) continue;
        this.clearFailedEntry(relation.userId, relation.mediaId, bvid);
        this.setRelationStatus(tracked, "discovered", value.classifiedAt || nowIso());
        tracked.lastError = undefined;
      }
      this.refreshVideoAggregateStatus(bvid);
    }
    this.save();
  }

  detachUserRelations(userId: string, detachedAt = nowIso()) {
    let changed = 0;
    const relations = this.database.listRelationsForUser(userId);
    this.runBatch(() => {
      for (const relation of relations) {
        const tracked = this.getRelation(userId, relation.mediaId, relation.bvid);
        if (!tracked) continue;
        tracked.activeInFavorite = false;
        tracked.accountDetachedAt = detachedAt;
        changed += 1;
      }
    });
    return changed;
  }

  reattachUserRelations(userId: string) {
    let changed = 0;
    const relations = this.database.listRelationsForUser(userId);
    this.runBatch(() => {
      for (const relation of relations) {
        const tracked = this.getRelation(userId, relation.mediaId, relation.bvid);
        if (!tracked || !tracked.accountDetachedAt) continue;
        tracked.accountDetachedAt = undefined;
        tracked.activeInFavorite = true;
        changed += 1;
      }
    });
    return changed;
  }

  markVerifiedUpload(
    bvid: string,
    remotePath: string,
    remoteFiles: RemoteFileRecord[],
    _userId?: string,
    _mediaId?: number,
    partial = false
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    if (remoteFiles.length === 0) {
      this.markUploadFailed(
        bvid,
        entry.localDir || "",
        _userId,
        _mediaId,
        "Upload finished without verified remote file records."
      );
      return;
    }
    this.applyVerifiedRemoteFiles(entry, this.getRelation(_userId, _mediaId, bvid), remotePath, remoteFiles, nowIso(), partial);
    this.save();
  }

  markUploadedPendingVerification(
    bvid: string,
    remotePath: string,
    remoteFiles: RemoteFileRecord[],
    userId?: string,
    mediaId?: number,
    partial = false
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry || remoteFiles.length === 0) return;
    const at = nowIso();
    entry.remotePath = remotePath;
    entry.remoteFiles = remoteFiles;
    entry.uploadedAt = at;
    entry.verifiedAt = undefined;
    entry.lastError = undefined;
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      this.setRelationStatus(relation, "uploaded", at);
      relation.remotePath = remotePath;
      relation.remoteFiles = remoteFiles;
      relation.pendingPartialBackup = partial || undefined;
      relation.uploadedAt = at;
      relation.verifiedAt = undefined;
      relation.lastError = undefined;
      relation.nextRemoteCheckAt = remoteFiles
        .map((file) => file.nextVerifyAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      this.clearFailedEntry(relation.userId, relation.mediaId, relation.bvid);
      this.refreshVideoAggregateStatus(bvid);
    } else {
      this.setVideoStatus(entry, "uploaded", at);
    }
    this.save();
  }

  listPendingUploadVerifications(limit = 100) {
    const rows: Array<{
      bvid: string;
      userId: string;
      mediaId: number;
      remotePath: string;
      localDir?: string;
      partialBackup?: boolean;
      files: RemoteFileRecord[];
    }> = [];
    const pending = this.lazyState
      ? this.database.listPendingUploadVerifications(limit)
      : Object.values(this.state.relations || {}).map((relation) => ({ relation, localDir: this.state.videos?.[relation.bvid]?.localDir }));
    for (const { relation, localDir } of pending) {
      if (relation.backupStatus !== "uploaded") continue;
      const files = (relation.remoteFiles || []).filter((file) => file.verificationStatus === "awaiting_verification");
      if (files.length === 0) continue;
      rows.push({
        bvid: relation.bvid,
        userId: relation.userId,
        mediaId: relation.mediaId,
        remotePath: relation.remotePath || path.posix.dirname(files[0].path),
        localDir,
        partialBackup: Boolean(relation.pendingPartialBackup),
        files: files.map((file) => ({ ...file })),
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  markUploadFileVerified(bvid: string, userId: string, mediaId: number, remoteFile: string) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!entry || !relation?.remoteFiles?.length) return false;
    const file = relation.remoteFiles.find((candidate) => candidate.path === remoteFile);
    if (!file) return false;
    file.verificationStatus = "verified";
    file.nextVerifyAt = undefined;
    file.lastError = undefined;
    file.verifyAttempts = Number(file.verifyAttempts || 0) + 1;
    const allVerified = relation.remoteFiles.every((candidate) => candidate.verificationStatus !== "awaiting_verification" && candidate.verificationStatus !== "failed");
    if (allVerified) {
      const verifiedFiles = relation.remoteFiles.map((candidate) => ({
        ...candidate,
        verificationStatus: "verified" as const,
        nextVerifyAt: undefined,
        lastError: undefined,
      }));
      const partial = Boolean(relation.pendingPartialBackup);
      this.applyVerifiedRemoteFiles(entry, relation, relation.remotePath || path.posix.dirname(remoteFile), verifiedFiles, nowIso(), partial);
    }
    this.save();
    return allVerified;
  }

  deferUploadFileVerification(
    bvid: string,
    userId: string,
    mediaId: number,
    remoteFile: string,
    nextVerifyAt: number,
    reason: string
  ) {
    const relation = this.getRelation(userId, mediaId, bvid);
    const file = relation?.remoteFiles?.find((candidate) => candidate.path === remoteFile);
    if (!relation || !file) return;
    file.verificationStatus = "awaiting_verification";
    file.verifyAttempts = Number(file.verifyAttempts || 0) + 1;
    file.nextVerifyAt = new Date(nextVerifyAt).toISOString();
    file.lastError = reason;
    relation.nextRemoteCheckAt = file.nextVerifyAt;
    relation.lastError = reason;
    this.save();
  }

  failUploadFileVerification(
    bvid: string,
    userId: string,
    mediaId: number,
    remoteFile: string,
    reason: string
  ) {
    const relation = this.getRelation(userId, mediaId, bvid);
    const file = relation?.remoteFiles?.find((candidate) => candidate.path === remoteFile);
    if (file) {
      file.verificationStatus = "failed";
      file.nextVerifyAt = undefined;
      file.lastError = reason;
    }
    this.markUploadFailed(bvid, this.state.videos?.[bvid]?.localDir || "", userId, mediaId, reason);
  }

  markUploadFailed(bvid: string, localDir: string, userId?: string, mediaId?: number, reason = "Upload failure") {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    if (localDir) {
      entry.localDir = localDir;
    }
    entry.lastError = reason;
    const relation = this.getRelation(userId, mediaId, bvid);
    let failure: FailedEntry | undefined;
    if (relation) {
      this.setRelationStatus(relation, "upload_failed", at);
      relation.lastError = reason;
      relation.nextRemoteCheckAt = undefined;
      failure = {
        bvid,
        mediaId: relation.mediaId,
        failedAt: at,
        reason,
        permanent: false,
      };
      if (!this.lazyState) {
        this.state.failedByUser ||= {};
        this.state.failedByUser[relation.userId] ||= {};
        this.state.failedByUser[relation.userId][failedKey(relation.mediaId, bvid)] = failure;
      }
      this.refreshVideoAggregateStatus(bvid);
    } else {
      this.setVideoStatus(entry, "upload_failed", at);
    }
    this.save();
    if (this.lazyState && relation && failure) this.database.upsertFailure(relation.userId, failure);
  }

  markRemoteConflictArchived(
    bvid: string,
    userId: string | undefined,
    mediaId: number | undefined,
    archive: { archivePath: string; files: Array<{ name: string; oldPath: string; archivedPath: string; size?: number }> }
  ) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!entry || !relation || archive.files.length === 0) return false;
    const at = nowIso();
    const previousPaths = new Set((relation.remoteFiles || []).map((file) => file.path));
    relation.remoteConflictArchives = [
      ...(relation.remoteConflictArchives || []),
      { archivePath: archive.archivePath, archivedAt: at, files: archive.files.map((file) => ({ ...file })) },
    ].slice(-20);
    relation.remoteFiles = undefined;
    relation.uploadedAt = undefined;
    relation.verifiedAt = undefined;
    relation.lastRemoteCheckAt = undefined;
    relation.nextRemoteCheckAt = undefined;
    relation.remoteMissingCount = 0;
    relation.lastError = `远端旧版已归档到 ${archive.archivePath}，正在上传当前版本。`;
    if (entry.remoteFiles?.some((file) => previousPaths.has(file.path))) {
      entry.remoteFiles = undefined;
      entry.uploadedAt = undefined;
      entry.verifiedAt = undefined;
      entry.lastRemoteCheckAt = undefined;
      entry.nextRemoteCheckAt = undefined;
    }
    entry.lastError = relation.lastError;
    this.save();
    return true;
  }

  markLocalUploadGroupComplete(bvid: string, localDir: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    if (entry.localDir === localDir) {
      entry.localDir = undefined;
      entry.downloadSession = undefined;
    }
    this.refreshVideoAggregateStatus(bvid);
    this.save();
  }

  markProcessed(_userId: string, bvid: string, _mediaId: number) {
    const at = nowIso();
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(_userId, _mediaId, bvid);
    if (entry) {
      this.setVideoStatus(entry, relationTreatsUnavailable(relation, entry) ? "lost" : "discovered", at);
      entry.uploadedAt = undefined;
      entry.verifiedAt = undefined;
      entry.lastRemoteCheckAt = undefined;
      entry.remoteMissingCount = 0;
      entry.lastError = "Upload metadata missing; reset to discovered for retry.";
      entry.lastSeenAt = at;
    }
    this.save();
  }

  markFailed(userId: string, bvid: string, mediaId: number, reason: string, permanent = true) {
    const at = nowIso();
    const failure: FailedEntry = {
      bvid,
      mediaId,
      reason,
      permanent,
      failedAt: at,
    };
    if (!this.lazyState) {
      this.state.failedByUser ||= {};
      if (!this.state.failedByUser[userId]) {
        this.state.failedByUser[userId] = {};
      }
      this.state.failedByUser[userId][failedKey(mediaId, bvid)] = failure;
    }
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (entry) {
      this.setVideoStatus(entry, permanent && relationTreatsUnavailable(relation, entry) ? "lost" : "failed", at);
      entry.lastError = reason;
    }
    if (relation) {
      this.setRelationStatus(relation, permanent && entry && relationTreatsUnavailable(relation, entry) ? "lost" : "failed", at);
      relation.lastError = reason;
    }
    this.save();
    if (this.lazyState) this.database.upsertFailure(userId, failure);
  }

  private clearFailedEntry(userId: string, mediaId: number, bvid: string) {
    if (this.lazyState) return this.database.deleteFailure(userId, mediaId, bvid);
    const entries = this.state.failedByUser?.[userId];
    if (!entries) return false;
    let changed = false;
    const scoped = failedKey(mediaId, bvid);
    if (entries[scoped]) {
      delete entries[scoped];
      changed = true;
    }
    if (entries[bvid]) {
      delete entries[bvid];
      changed = true;
    }
    if (Object.keys(entries).length === 0) {
      delete this.state.failedByUser?.[userId];
      changed = true;
    }
    return changed;
  }

  clearFailed(userId: string, mediaId: number, bvid: string) {
    const changed = this.clearFailedEntry(userId, mediaId, bvid);
    if (changed && !this.lazyState) {
      this.save();
    }
  }

  markRemoteCheckOk(bvid: string, remotePath?: string, remoteFiles?: RemoteFileRecord[], userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    const relation = this.getRelation(userId, mediaId, bvid);
    const partial = entry.backupStatus === "partial_verified" || relation?.backupStatus === "partial_verified";
    this.setVideoStatus(entry, partial ? "partial_verified" : "verified", at);
    if (remotePath) {
      entry.remotePath = remotePath;
    }
    if (Array.isArray(remoteFiles) && remoteFiles.length > 0) {
      entry.remoteFiles = remoteFiles;
    }
    entry.verifiedAt = at;
    entry.lastRemoteCheckAt = at;
    entry.nextRemoteCheckAt = undefined;
    entry.remoteMissingCount = 0;
    entry.lastError = undefined;
    if (relation) {
      this.setRelationStatus(relation, partial ? "partial_verified" : "verified", at);
      if (remotePath) relation.remotePath = remotePath;
      if (Array.isArray(remoteFiles) && remoteFiles.length > 0) relation.remoteFiles = remoteFiles;
      relation.verifiedAt = at;
      relation.lastRemoteCheckAt = at;
      relation.nextRemoteCheckAt = undefined;
      relation.remoteMissingCount = 0;
      relation.lastError = undefined;
    }
    if (userId && mediaId) {
      this.clearFailed(userId, mediaId, bvid);
    }
    this.save();
  }

  markRemoteCheckMissing(bvid: string, missingFiles: string[], userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.lastRemoteCheckAt = at;
      relation.remoteMissingCount = (relation.remoteMissingCount || 0) + 1;
      relation.lastError = `Remote files missing: ${missingFiles.join(", ")}`;
      if (relation.remoteMissingCount >= 2) {
        this.setRelationStatus(relation, relationTreatsUnavailable(relation, entry) ? "lost" : "missing", at);
      }
      this.refreshVideoAggregateStatus(bvid);
      this.save();
      return;
    }
    entry.lastRemoteCheckAt = at;
    entry.remoteMissingCount = (entry.remoteMissingCount || 0) + 1;
    entry.lastError = `Remote files missing: ${missingFiles.join(", ")}`;
    if (entry.remoteMissingCount >= 2) {
      this.setVideoStatus(entry, entry.biliStatus === "unavailable" ? "lost" : "missing", at);
    }
    this.save();
  }

  markRemoteCheckDeferred(bvid: string, delayMs: number, reason?: string, userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.lastRemoteCheckAt = at;
      relation.nextRemoteCheckAt = new Date(Date.now() + Math.max(1000, delayMs)).toISOString();
      if (reason) {
        relation.lastError = reason;
      }
      this.save();
      return;
    }
    entry.lastRemoteCheckAt = at;
    entry.nextRemoteCheckAt = new Date(Date.now() + Math.max(1000, delayMs)).toISOString();
    if (reason) {
      entry.lastError = reason;
    }
    this.save();
  }

  getFolderScan(userId: string, mediaId: number, folderTitle: string) {
    const key = folderKey(userId, mediaId);
    if (!this.state.folderScans![key]) {
      this.state.folderScans![key] = {
        userId,
        mediaId,
        folderTitle,
        initStatus: "pending",
        nextHistoryPage: 1,
        catchupPage: 1,
      };
      this.save();
    } else {
      this.state.folderScans![key].folderTitle = folderTitle;
      this.state.folderScans![key].catchupPage ||= 1;
    }
    return { ...this.state.folderScans![key] };
  }

  getExistingFolderScan(userId: string, mediaId: number) {
    const scan = this.state.folderScans?.[folderKey(userId, mediaId)];
    return scan ? { ...scan } : null;
  }

  updateFolderScan(userId: string, mediaId: number, patch: Partial<FolderScanState>) {
    const key = folderKey(userId, mediaId);
    if (!this.state.folderScans![key]) {
      this.state.folderScans![key] = {
        userId,
        mediaId,
        folderTitle: patch.folderTitle || "favorites",
        initStatus: "pending",
        nextHistoryPage: 1,
        catchupPage: 1,
      };
    }
    this.state.folderScans![key] = {
      ...this.state.folderScans![key],
      ...patch,
      lastScannedAt: nowIso(),
    };
    this.save();
  }

  setUserCooldown(userId: string, reason: string, cooldownMs: number) {
    const cooldown: UserCooldown = {
      userId,
      until: Date.now() + cooldownMs,
      reason,
      setAt: nowIso(),
    };
    if (this.lazyState) {
      this.database.setCooldown("user", userId, cooldown.until, reason, cooldown as unknown as Record<string, unknown>);
      return;
    }
    this.state.userCooldowns![userId] = cooldown;
    this.save();
  }

  getUserCooldown(userId: string) {
    const cooldown = this.lazyState
      ? this.database.getCooldown("user", userId) as unknown as UserCooldown | null
      : this.state.userCooldowns?.[userId];
    if (!cooldown) return null;
    if (cooldown.until <= Date.now()) {
      if (this.lazyState) this.database.clearCooldown("user", userId);
      else {
        delete this.state.userCooldowns?.[userId];
        this.save();
      }
      return null;
    }
    return { ...cooldown };
  }

  getAllCooldowns() {
    if (this.lazyState) {
      const active: Record<string, UserCooldown> = {};
      for (const row of this.database.listCooldowns("user", Date.now())) {
        active[row.scopeId] = { ...(row.payload as unknown as UserCooldown), userId: row.scopeId };
      }
      return active;
    }
    const active: Record<string, UserCooldown> = {};
    for (const [userId, cooldown] of Object.entries(this.state.userCooldowns || {})) {
      if (cooldown.until > Date.now()) {
        active[userId] = { ...cooldown, userId };
      }
    }
    return active;
  }

  setDownloadApiCooldown(value: PersistedDownloadApiCooldown) {
    if (this.lazyState) {
      this.database.setCooldown(
        "download_api",
        "global",
        Number(value.until || 0),
        value.reason || "",
        value as unknown as Record<string, unknown>
      );
      return;
    }
    this.state.downloadApiCooldown = { ...value };
    this.save();
  }

  getDownloadApiCooldown() {
    if (this.lazyState) {
      return this.database.getCooldown("download_api", "global") as unknown as PersistedDownloadApiCooldown | null;
    }
    return this.state.downloadApiCooldown ? { ...this.state.downloadApiCooldown } : null;
  }

  clearDownloadApiCooldown() {
    if (this.lazyState) {
      this.database.clearCooldown("download_api", "global");
      return;
    }
    if (!this.state.downloadApiCooldown) return;
    this.state.downloadApiCooldown = undefined;
    this.save();
  }

  getUploadCooldown() {
    return this.database.getCooldown("upload", "global");
  }

  setUploadCooldown(value: Record<string, unknown>) {
    this.database.setCooldown(
      "upload",
      "global",
      Number(value.retryAt || 0),
      String(value.reason || ""),
      value
    );
  }

  clearUploadCooldown() {
    this.database.clearCooldown("upload", "global");
  }

  hasPersistentJobBootstrap() {
    return this.database.getMeta("persistent_jobs_bootstrap_v1") === "complete";
  }

  markPersistentJobBootstrapComplete() {
    this.database.setMeta("persistent_jobs_bootstrap_v1", "complete");
  }

  normalizePersistedWorkForRecovery() {
    const marker = "runtime_recovery_normalization_v2";
    if (this.database.getMeta(marker) === "complete") return false;
    let changed = false;
    const resumableStatuses = new Set<BackupStatus>(["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing", "failed"]);
    const at = nowIso();
    const normalizeBatch = (videos: VideoArchiveEntry[], relationRows: FavoriteRelation[]) => this.runBatch(() => {
      let batchChanged = false;
      const relationsByBvid = new Map<string, FavoriteRelation[]>();
      for (const relation of relationRows) {
        const list = relationsByBvid.get(relation.bvid) || [];
        list.push(relation);
        relationsByBvid.set(relation.bvid, list);
      }
      for (const entry of videos) {
        let videoChanged = false;
        const hasLocalDir = Boolean(entry.localDir && fs.existsSync(entry.localDir));
        const relations = relationsByBvid.get(entry.bvid) || [];
        if (hasLocalDir && entry.localDir) {
          const manifest = readDownloadSession(entry.localDir);
          const sessionComplete = manifest?.status === "complete" || manifest?.status === "partial";
          const uploadReady = sessionComplete;
          const entryTarget: BackupStatus = uploadReady
            ? (["uploading", "upload_failed", "failed"].includes(entry.backupStatus) ? "upload_failed" : "downloaded")
            : "queued";
          if (manifest) {
            const nextReference: DownloadSessionReference = {
              id: manifest.sessionId,
              localDir: entry.localDir,
              kind: manifest.kind,
              status: manifest.status,
              completedPages: manifest.outputs.length,
              totalPages: manifest.pages.length,
              updatedAt: manifest.updatedAt,
            };
            if (JSON.stringify(entry.downloadSession) !== JSON.stringify(nextReference)) {
              entry.downloadSession = nextReference;
              videoChanged = true;
              batchChanged = true;
              changed = true;
            }
          }
          if (resumableStatuses.has(entry.backupStatus) && entry.backupStatus !== entryTarget) {
            this.setVideoStatus(entry, entryTarget, at);
            videoChanged = true;
            batchChanged = true;
            changed = true;
          }
          for (const relation of relations) {
            const current = relation.backupStatus || entry.backupStatus;
            if (!resumableStatuses.has(current)) continue;
            const target: BackupStatus = uploadReady
              ? (["uploading", "upload_failed", "failed"].includes(current) ? "upload_failed" : "downloaded")
              : "queued";
            if (relation.backupStatus !== target) {
              this.setRelationStatus(relation, target, at);
              this.state.relations![relationKey(relation.userId, relation.mediaId, relation.bvid)] = relation;
              batchChanged = true;
              changed = true;
            }
          }
          if (videoChanged) this.state.videos![entry.bvid] = entry;
          continue;
        }

        if (entry.localDir) {
          entry.localDir = undefined;
          entry.downloadSession = undefined;
          videoChanged = true;
          batchChanged = true;
          changed = true;
        }
        if (resumableStatuses.has(entry.backupStatus)) {
          const target = entry.favoriteUnavailable && !entry.selfVisible ? "lost" : "queued";
          if (entry.backupStatus !== target) {
            this.setVideoStatus(entry, target, at);
            videoChanged = true;
            batchChanged = true;
            changed = true;
          }
        }
        for (const relation of relations) {
          const current = relation.backupStatus || entry.backupStatus;
          if (!resumableStatuses.has(current)) continue;
          const target = relationTreatsUnavailable(relation, entry) ? "lost" : "queued";
          if (relation.backupStatus !== target) {
            this.setRelationStatus(relation, target, at);
            this.state.relations![relationKey(relation.userId, relation.mediaId, relation.bvid)] = relation;
            batchChanged = true;
            changed = true;
          }
        }
        if (videoChanged) this.state.videos![entry.bvid] = entry;
      }
      if (batchChanged) this.save();
    });

    if (this.lazyState) {
      let afterBvid = "";
      while (true) {
        const videos = this.database.listRecoveryNormalizationVideos(afterBvid, [...resumableStatuses], 500);
        if (videos.length === 0) break;
        const relations = this.database.listRelationsForBvids(videos.map((entry) => entry.bvid));
        normalizeBatch(videos, relations);
        afterBvid = videos[videos.length - 1].bvid;
      }
    } else {
      normalizeBatch(
        Object.values(this.state.videos || {}).map((entry) => ({ ...entry })),
        Object.values(this.state.relations || {}).map((relation) => ({ ...relation }))
      );
    }

    this.database.setMeta(marker, "complete");

    return changed;
  }

  listBackupsToResume() {
    const resumable = ["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing"];
    const videos = this.lazyState ? this.database.listVideosForResume(resumable) : Object.values(this.state.videos || {});
    const videoByBvid = new Map(videos.map((video) => [video.bvid, video]));
    const relations = this.lazyState ? this.database.listRelationsByStatuses([...resumable, "verified", "partial_verified"]) : Object.values(this.state.relations || {});
    const relationWork = relations
      .map((relation) => ({ relation: { ...relation }, video: videoByBvid.get(relation.bvid) }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => {
        if (!item.video) return false;
        if (["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing"].includes(item.relation.backupStatus || "")) return true;
        if (!["verified", "partial_verified"].includes(item.relation.backupStatus || "") || !item.video.localDir) return false;
        const targetKey = `${item.relation.userId}:${item.relation.mediaId}`;
        return historySessionGroups(item.video.localDir).some((group) =>
          group.files.some((file) => !(file.uploadedTargets || []).includes(targetKey))
        );
      });
    if (relationWork.length > 0) {
      return relationWork;
    }
    return videos
      .filter((entry) => ["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing"].includes(entry.backupStatus))
      .map((video) => ({ video: { ...video }, relation: this.findRelationForBvid(video.bvid) }));
  }

  listStaleActiveBackups(maxAgeMs: number) {
    const active = ["queued", "downloading", "downloaded", "uploading"];
    const relationSource = this.lazyState ? this.database.listStaleRelations(active, Date.now() - maxAgeMs) : Object.values(this.state.relations || {});
    const relationItems = relationSource
      .filter((relation) => this.isStaleActiveStatus(relation.backupStatus, relation.statusUpdatedAt, maxAgeMs))
      .flatMap((relation) => {
        const video = this.state.videos?.[relation.bvid];
        return video ? [{ relation: { ...relation }, video }] : [];
      });
    const relationKeys = new Set(relationItems.map((item) => relationKey(item.relation.userId, item.relation.mediaId, item.relation.bvid)));
    const videoSource = this.lazyState ? this.database.listStaleVideos(active, Date.now() - maxAgeMs) : Object.values(this.state.videos || {});
    const videoItems = videoSource
      .filter((entry) => this.isStaleActiveStatus(entry.backupStatus, entry.statusUpdatedAt, maxAgeMs))
      .flatMap((video) => {
        const relation = this.findRelationForBvid(video.bvid);
        if (!relation || relationKeys.has(relationKey(relation.userId, relation.mediaId, relation.bvid))) {
          return [];
        }
        return [{ video: { ...video }, relation }];
      });
    return [...relationItems, ...videoItems];
  }

  resetRelationForRetry(bvid: string, userId: string, mediaId: number, reason: string) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    const at = nowIso();
    if (relation) {
      this.setRelationStatus(relation, entry && relationTreatsUnavailable(relation, entry) ? "lost" : "discovered", at);
      relation.lastError = reason;
      relation.nextRemoteCheckAt = undefined;
      relation.qualityUpgrade = undefined;
    }
    if (entry) {
      entry.localDir = undefined;
      entry.lastError = reason;
      this.refreshVideoAggregateStatus(bvid);
      if (!relation) {
        this.setVideoStatus(entry, entry.biliStatus === "unavailable" ? "lost" : "discovered", at);
        entry.lastError = reason;
      }
    }
    this.save();
  }

  listVideosForRemoteVerify(limit?: number, includeDeferred = false) {
    const relations = this.lazyState
      ? this.database.listRelationsForRemoteVerify(limit, includeDeferred)
      : Object.values(this.state.relations || {}).filter((relation) =>
        ["verified", "partial_verified"].includes(relation.backupStatus || "")
        && (includeDeferred || !relation.nextRemoteCheckAt || Date.parse(relation.nextRemoteCheckAt) <= Date.now())
      ).slice(0, typeof limit === "number" ? limit : undefined);
    return relations.flatMap((relation) => {
      const video = this.state.videos?.[relation.bvid];
      if (!video) return [];
      const relationFiles = relation.remoteFiles || [];
      return [{
        ...video,
        remotePath: relation.remotePath,
        remoteFiles: [...relationFiles],
        lastRemoteCheckAt: relation.lastRemoteCheckAt || video.lastRemoteCheckAt,
        nextRemoteCheckAt: relation.nextRemoteCheckAt || video.nextRemoteCheckAt,
        remoteMissingCount: relation.remoteMissingCount || video.remoteMissingCount,
        relation: { ...relation, remoteFiles: [...relationFiles] },
      }];
    });
  }

  listUploadFailuresForRecoveryPage(cursor: UploadFailureRecoveryCursor | null, limit: number) {
    return this.database.listUploadFailuresForRecoveryPage(cursor, limit);
  }

  countVideosForRemoteVerify(includeDeferred = false) {
    if (this.lazyState) return this.database.countRelationsForRemoteVerify(includeDeferred);
    const now = Date.now();
    return Object.values(this.state.relations || {}).filter((relation) =>
      ["verified", "partial_verified"].includes(relation.backupStatus || "") &&
      (includeDeferred || !relation.nextRemoteCheckAt || Date.parse(relation.nextRemoteCheckAt) <= now)
    ).length;
  }

  findRelationForBvid(bvid: string) {
    const relation = this.lazyState
      ? this.database.listRelationsForBvid(bvid)[0]
      : Object.values(this.state.relations || {}).find((item) => item.bvid === bvid);
    return relation ? { ...relation } : null;
  }

  getRemoteFilePreviewRecords() {
    if (this.lazyState) return this.database.listRemoteFilePreviewRecords();
    const records = new Map<string, RemoteFilePreviewVideoRecord>();
    for (const entry of Object.values(this.state.videos || {})) {
      records.set(entry.bvid, {
        bvid: entry.bvid,
        title: entry.title,
        upperName: entry.upperName,
        remotePath: entry.remotePath,
        remoteFiles: [...(entry.remoteFiles || [])],
        relations: [],
      });
    }
    for (const relation of Object.values(this.state.relations || {})) {
      if (!relation.activeInFavorite) continue;
      const video = this.state.videos?.[relation.bvid];
      if (!video) continue;
      const record = records.get(relation.bvid) || {
        bvid: relation.bvid,
        title: video.title,
        upperName: video.upperName,
        remotePath: video.remotePath,
        remoteFiles: [...(video.remoteFiles || [])],
        relations: [],
      };
      record.relations.push({
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
        backupStatus: relation.backupStatus,
        hasInterruptedQualityUpgrade: Boolean(relation.qualityUpgrade),
        remotePath: relation.remotePath,
        remoteFiles: [...(relation.remoteFiles || [])],
      });
      records.set(relation.bvid, record);
    }
    return Array.from(records.values());
  }

  markQualityUpgradeReplacing(
    bvid: string,
    userId: string,
    mediaId: number,
    operation: Omit<QualityUpgradeOperation, "startedAt" | "finalizedAt">
  ) {
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation) return false;
    relation.qualityUpgrade = { ...operation, startedAt: nowIso() };
    relation.lastError = "Quality upgrade is replacing remote files.";
    this.save();
    return true;
  }

  listInterruptedQualityUpgrades() {
    return (this.lazyState ? this.database.listInterruptedQualityRelations() : Object.values(this.state.relations || {}))
      .filter((relation) => Boolean(relation.qualityUpgrade))
      .map((relation) => ({ ...relation, remoteFiles: [...(relation.remoteFiles || [])], qualityUpgrade: relation.qualityUpgrade! }));
  }

  recordQualityUpgradeBackupFile(bvid: string, userId: string, mediaId: number, backupFile: RemoteFileRecord) {
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation?.qualityUpgrade) return false;
    const files = relation.qualityUpgrade.backupFiles || [];
    relation.qualityUpgrade = {
      ...relation.qualityUpgrade,
      backupFiles: [...files.filter((file) => file.path !== backupFile.path), backupFile],
    };
    this.save();
    return true;
  }

  recordQualityUpgradeFinalFile(bvid: string, userId: string, mediaId: number, remoteFile: RemoteFileRecord) {
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation?.qualityUpgrade) return false;
    const files = relation.qualityUpgrade.newFiles || [];
    relation.qualityUpgrade = {
      ...relation.qualityUpgrade,
      newFiles: [...files.filter((file) => file.path !== remoteFile.path), remoteFile],
    };
    this.save();
    return true;
  }

  finalizeQualityUpgradeRemoteFiles(bvid: string, userId: string, mediaId: number, remotePath: string, remoteFiles: RemoteFileRecord[]) {
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation?.qualityUpgrade || remoteFiles.length === 0) return false;
    relation.qualityUpgrade = {
      ...relation.qualityUpgrade,
      newFiles: remoteFiles,
      finalizedAt: nowIso(),
    };
    this.save();
    return true;
  }

  completeQualityUpgrade(bvid: string, userId: string, mediaId: number, remotePath: string, remoteFiles: RemoteFileRecord[]) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!entry || !relation || remoteFiles.length === 0) return false;
    this.applyVerifiedRemoteFiles(entry, relation, remotePath, remoteFiles, nowIso());
    relation.qualityUpgrade = undefined;
    this.clearFailedEntry(userId, mediaId, bvid);
    this.save();
    return true;
  }

  renameRemoteFile(bvid: string, oldPath: string, newPath: string) {
    return this.renameRemoteFilesBatch(bvid, [{ oldPath, newPath }]);
  }

  renameRemoteFilesBatch(bvid: string, renames: Array<{ oldPath: string; newPath: string }>) {
    const entry = this.state.videos?.[bvid];
    if (!entry || renames.length === 0) return false;
    const at = nowIso();
    const normalized = renames.map((item) => ({
      oldPath: item.oldPath.replace(/\\/g, "/"),
      newPath: item.newPath.replace(/\\/g, "/"),
      oldName: path.posix.basename(item.oldPath.replace(/\\/g, "/")),
      newName: path.posix.basename(item.newPath.replace(/\\/g, "/")),
      oldDir: path.posix.dirname(item.oldPath.replace(/\\/g, "/")),
      newDir: path.posix.dirname(item.newPath.replace(/\\/g, "/")),
    }));
    const byOldPath = new Map(normalized.map((item) => [item.oldPath, item]));
    const byOldNameDir = new Map<string, typeof normalized[number] | null>();
    for (const item of normalized) {
      const key = `${item.oldDir}\0${item.oldName}`;
      byOldNameDir.set(key, byOldNameDir.has(key) ? null : item);
    }
    const updateFiles = (files?: RemoteFileRecord[]) => {
      if (!Array.isArray(files)) return new Set<string>();
      const matched = new Set<string>();
      const updates: Array<{ file: RemoteFileRecord; target: typeof normalized[number] }> = [];
      for (const file of files) {
        const filePath = file.path.replace(/\\/g, "/");
        const direct = byOldPath.get(filePath);
        const fallback = direct ? undefined : byOldNameDir.get(`${path.posix.dirname(filePath)}\0${file.name}`);
        const target = direct || fallback || undefined;
        if (target) updates.push({ file, target });
      }
      for (const { file, target } of updates) {
        file.path = target.newPath;
        file.name = target.newName;
        matched.add(target.oldPath);
      }
      return matched;
    };
    const entryMatches = updateFiles(entry.remoteFiles);
    let changed = entryMatches.size > 0;
    entry.remoteFiles ||= [];
    for (const item of normalized) {
      if (!entryMatches.has(item.oldPath) && !entry.remoteFiles.some((file) => file.path === item.newPath)) {
        entry.remoteFiles.push({ name: item.newName, path: item.newPath });
        changed = true;
      }
    }
    this.setVideoStatus(entry, "verified", at);
    const entryRename = normalized.find((item) => !entry.remotePath || entry.remotePath === item.oldDir || entry.remotePath === item.newDir);
    if (entryRename) entry.remotePath = entryRename.newDir;
    entry.verifiedAt = at;
    entry.lastRemoteCheckAt = at;
    entry.nextRemoteCheckAt = undefined;
    entry.remoteMissingCount = 0;
    entry.lastError = undefined;
    for (const relationSnapshot of this.listRelationsForBvid(bvid)) {
      const relation = this.getRelation(relationSnapshot.userId, relationSnapshot.mediaId, bvid);
      if (!relation) continue;
      const relationMatches = updateFiles(relation.remoteFiles);
      const relationDir = relation.remotePath || path.posix.dirname(relation.remoteFiles?.[0]?.path || "");
      const relevant = normalized.filter((item) => !relationDir || relationDir === item.oldDir || relationDir === item.newDir);
      if (relevant.length > 0) {
        relation.remoteFiles ||= [];
        for (const item of relevant) {
          if (!relationMatches.has(item.oldPath) && !relation.remoteFiles.some((file) => file.path === item.newPath)) {
            relation.remoteFiles.push({ name: item.newName, path: item.newPath });
          }
        }
      }
      if (relationMatches.size > 0 || relevant.length > 0) {
        this.setRelationStatus(relation, "verified", at);
        relation.remotePath = relevant[0]?.newDir || relation.remotePath;
        relation.verifiedAt = at;
        relation.lastRemoteCheckAt = at;
        relation.nextRemoteCheckAt = undefined;
        relation.remoteMissingCount = 0;
        relation.lastError = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
    return changed;
  }

  listRelationsForBvid(bvid: string) {
    const relations = this.lazyState ? this.database.listRelationsForBvid(bvid) : Object.values(this.state.relations || {});
    return relations
      .filter((item) => item.bvid === bvid)
      .map((item) => ({ ...item }));
  }

  listRetryCandidatesForFolder(userId: string, mediaId: number, limit = 500) {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (this.lazyState) return this.database.listRetryCandidateBvids(userId, mediaId, normalizedLimit);
    const rows: Array<{ relation: FavoriteRelation; video: VideoArchiveEntry; failed?: FailedEntry }> = [];
    const relations = this.lazyState ? this.database.listRelationsForFolder(userId, mediaId) : Object.values(this.state.relations || {});
    for (const relation of relations) {
      if (relation.userId !== userId || relation.mediaId !== mediaId) continue;
      const video = this.state.videos?.[relation.bvid];
      if (!video) {
        continue;
      }
      const failed = this.getFailedEntry(userId, relation.bvid, mediaId);
      rows.push({ relation, video, failed });
    }

    const candidates = rows
      .filter(({ relation, video, failed }) => {
        if (relationTreatsUnavailable(relation, video)) return false;
        const status = relation.backupStatus || video.backupStatus;
        if (BACKED_UP_STATUSES.has(status) || ACTIVE_BACKUP_STATUSES.has(status)) return false;
        if (status === "failed" || status === "missing") return true;
        if (status === "discovered" && (Boolean(failed) || Boolean(relation.lastError))) return true;
        return false;
      })
      .sort((a, b) => {
        const left = Date.parse(a.failed?.failedAt || a.relation.lastSeenAt || a.video.lastSeenAt || "");
        const right = Date.parse(b.failed?.failedAt || b.relation.lastSeenAt || b.video.lastSeenAt || "");
        return right - left;
      })
      .slice(0, normalizedLimit);
    return candidates.map((item) => item.relation.bvid);
  }

  listFolderItemsForUser(
    userId: string,
    mediaId: number,
    offset: number,
    limit: number,
    filter: FolderDetailFilter = "all"
  ) {
    const normalizedOffset = Math.max(0, Math.floor(offset));
    const normalizedLimit = Math.max(1, Math.floor(limit));
    if (this.lazyState) {
      const query = this.database.queryFolderPage(userId, mediaId, filter, normalizedOffset, normalizedLimit);
      const items = query.rows.map(({ relation, video }) => this.buildFolderDetailItem(userId, relation, video));
      const nextOffset = normalizedOffset + normalizedLimit < query.totalFiltered ? normalizedOffset + normalizedLimit : null;
      return { items, summary: query.summary, hasMore: nextOffset !== null, nextOffset, totalFiltered: query.totalFiltered };
    }
    const rows = (this.lazyState ? this.database.listRelationsForFolder(userId, mediaId) : Object.values(this.state.relations || {}))
      .filter((relation) => relation.userId === userId && relation.mediaId === mediaId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => Boolean(item.video))
      .sort((a, b) => {
        if (a.relation.activeInFavorite !== b.relation.activeInFavorite) {
          return a.relation.activeInFavorite ? -1 : 1;
        }
        if (!a.relation.activeInFavorite) {
          return Date.parse(b.relation.lastSeenAt) - Date.parse(a.relation.lastSeenAt);
        }
        const leftOrder = Number.isInteger(a.relation.favOrder) ? Number(a.relation.favOrder) : Number.POSITIVE_INFINITY;
        const rightOrder = Number.isInteger(b.relation.favOrder) ? Number(b.relation.favOrder) : Number.POSITIVE_INFINITY;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return Date.parse(b.relation.lastSeenAt) - Date.parse(a.relation.lastSeenAt);
      });

    const allItems = rows.map(({ relation, video }) => this.buildFolderDetailItem(userId, relation, video));

    const summary: FolderDetailSummary = {
      total: allItems.length,
      activeTotal: 0,
      historicalTotal: 0,
      uploaded: 0,
      pending: 0,
      pendingUnavailable: 0,
      uploadedUnavailable: 0,
    };
    for (const item of allItems) {
      if (item.activeInFavorite) {
        summary.activeTotal += 1;
      } else {
        summary.historicalTotal += 1;
      }
      if (item.processed) {
        summary.uploaded += 1;
      } else if (!item.unavailable) {
        summary.pending += 1;
      }
      if (item.unavailable && item.processed) {
        summary.uploadedUnavailable += 1;
      } else if (item.unavailable && !item.processed) {
        summary.pendingUnavailable += 1;
      }
    }

    const filtered = allItems.filter((item) => {
      if (filter === "all") return true;
      if (filter === "uploaded") return item.processed;
      if (filter === "pending") return !item.processed && !item.unavailable;
      if (filter === "pending_unavailable") return !item.processed && item.unavailable;
      if (filter === "uploaded_unavailable") return item.processed && item.unavailable;
      return true;
    });

    const page = filtered.slice(normalizedOffset, normalizedOffset + normalizedLimit);
    return {
      items: page,
      summary,
      hasMore: normalizedOffset + normalizedLimit < filtered.length,
      nextOffset: normalizedOffset + normalizedLimit < filtered.length ? normalizedOffset + normalizedLimit : null,
      totalFiltered: filtered.length,
    };
  }

  getFolderItemForUser(userId: string, mediaId: number, bvid: string) {
    const relation = this.getRelation(userId, mediaId, bvid);
    const video = this.state.videos?.[bvid];
    if (!relation || !video) return null;
    return this.buildFolderDetailItem(userId, relation, video);
  }

  private buildFolderDetailItem(userId: string, relation: FavoriteRelation, video: VideoArchiveEntry): FolderDetailItem {
    const backupStatus = relation.backupStatus || video.backupStatus;
    return {
      bvid: video.bvid,
      title: displayTitle(video),
      upperName: displayUpperName(video),
      cover: displayCover(video),
      coverLocalPath: displayCoverLocalPath(video),
      description: displayDescription(video),
      favoriteUnavailable: relation.favoriteUnavailable || video.favoriteUnavailable,
      selfVisible: relation.selfVisible || video.selfVisible,
      favOrder: relation.favOrder,
      favPage: relation.favPage,
      favIndexInPage: relation.favIndexInPage,
      unavailable: relationTreatsUnavailable(relation, video),
      processed: BACKED_UP_STATUSES.has(backupStatus),
      failed: this.isFailed(userId, video.bvid, relation.mediaId),
      backupStatus,
      mediaId: relation.mediaId,
      folderTitle: relation.folderTitle,
      lastSeenAt: relation.lastSeenAt,
      activeInFavorite: relation.activeInFavorite,
      accessRestriction: video.accessRestriction,
    };
  }

  listUnavailableForUser(userId: string, offset: number, limit: number) {
    if (this.lazyState) {
      const query = this.database.queryUnavailablePage(userId, offset, limit);
      const items = query.rows.map(({ relation, video }) => ({
        bvid: video.bvid,
        title: displayTitle(video),
        upperName: displayUpperName(video),
        cover: displayCover(video),
        coverLocalPath: displayCoverLocalPath(video),
        description: displayDescription(video),
        favoriteUnavailable: relation.favoriteUnavailable || video.favoriteUnavailable,
        selfVisible: relation.selfVisible || video.selfVisible,
        unavailable: true,
        processed: BACKED_UP_STATUSES.has(relation.backupStatus || video.backupStatus),
        failed: this.isFailed(userId, video.bvid, relation.mediaId),
        backupStatus: relation.backupStatus || video.backupStatus,
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
      }));
      const nextOffset = offset + limit < query.total ? offset + limit : null;
      return { items, hasMore: nextOffset !== null, nextOffset };
    }
    const dedup = new Map<string, { relation: FavoriteRelation; video: VideoArchiveEntry }>();
    const relations = (this.lazyState ? this.database.listRelationsForUser(userId) : Object.values(this.state.relations || {}))
      .filter((relation) => relation.userId === userId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } =>
        Boolean(item.video && relationTreatsUnavailable(item.relation, item.video))
      )
      .sort((a, b) => Date.parse(b.video.lastSeenAt) - Date.parse(a.video.lastSeenAt));

    for (const item of relations) {
      if (!dedup.has(item.video.bvid)) {
        dedup.set(item.video.bvid, item);
      }
    }

    const uniqueRelations = Array.from(dedup.values());

    const page = uniqueRelations.slice(offset, offset + limit).map(({ relation, video }) => ({
      bvid: video.bvid,
      title: displayTitle(video),
      upperName: displayUpperName(video),
      cover: displayCover(video),
      coverLocalPath: displayCoverLocalPath(video),
      description: displayDescription(video),
      favoriteUnavailable: relation.favoriteUnavailable || video.favoriteUnavailable,
      selfVisible: relation.selfVisible || video.selfVisible,
      unavailable: true,
      processed: this.isProcessed(userId, video.bvid, relation.mediaId),
      failed: this.isFailed(userId, video.bvid, relation.mediaId),
      backupStatus: relation.backupStatus || video.backupStatus,
      mediaId: relation.mediaId,
      folderTitle: relation.folderTitle,
    }));

    return {
      items: page,
      hasMore: offset + limit < uniqueRelations.length,
      nextOffset: offset + limit < uniqueRelations.length ? offset + limit : null,
    };
  }

  getRelationStatus(userId: string, mediaId: number, bvid: string) {
    const relation = this.state.relations?.[relationKey(userId, mediaId, bvid)];
    return relation ? { ...relation, remoteFiles: [...(relation.remoteFiles || [])] } : null;
  }

  getFolderIndexSummary(userId: string, mediaId: number, biliTotal?: number): FolderIndexSummary {
    if (this.lazyState) {
      const summary = this.database.queryFolderPage(userId, mediaId, "all", 0, 1).summary;
      const scan = this.state.folderScans?.[folderKey(userId, mediaId)];
      const effectiveBiliTotal = typeof biliTotal === "number" ? biliTotal : scan?.total;
      const scanComplete = scan?.initStatus === "complete";
      const unreturnedCount = scanComplete && typeof effectiveBiliTotal === "number" ? Math.max(0, effectiveBiliTotal - summary.activeTotal) : 0;
      return {
        ...summary,
        indexed: summary.activeTotal,
        biliTotal: effectiveBiliTotal,
        complete: scanComplete || (typeof effectiveBiliTotal === "number" ? summary.activeTotal >= effectiveBiliTotal : false),
        scanStatus: scan?.initStatus || "pending",
        scanComplete,
        scannedTotal: summary.activeTotal,
        unreturnedCount,
      };
    }
    const rows = (this.lazyState ? this.database.listRelationsForFolder(userId, mediaId) : Object.values(this.state.relations || {}))
      .filter((relation) => relation.userId === userId && relation.mediaId === mediaId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => Boolean(item.video));
    const scan = this.state.folderScans?.[folderKey(userId, mediaId)];
    const effectiveBiliTotal = typeof biliTotal === "number" ? biliTotal : scan?.total;
    const scanComplete = scan?.initStatus === "complete";
    const activeTotal = rows.filter(({ relation }) => relation.activeInFavorite).length;
    const unreturnedCount = scanComplete && typeof effectiveBiliTotal === "number" ? Math.max(0, effectiveBiliTotal - activeTotal) : 0;
    const summary: FolderIndexSummary = {
      total: rows.length,
      activeTotal,
      historicalTotal: rows.length - activeTotal,
      indexed: activeTotal,
      biliTotal: effectiveBiliTotal,
      complete: scanComplete || (typeof effectiveBiliTotal === "number" ? activeTotal >= effectiveBiliTotal : false),
      scanStatus: scan?.initStatus || "pending",
      scanComplete,
      scannedTotal: activeTotal,
      unreturnedCount,
      uploaded: 0,
      pending: 0,
      pendingUnavailable: 0,
      uploadedUnavailable: 0,
    };
    for (const { relation, video } of rows) {
      const unavailable = relationTreatsUnavailable(relation, video);
      const processed = this.isProcessed(userId, video.bvid, mediaId);
      if (processed) {
        summary.uploaded += 1;
      } else if (!unavailable) {
        summary.pending += 1;
      }
      if (unavailable && processed) {
        summary.uploadedUnavailable += 1;
      } else if (unavailable && !processed) {
        summary.pendingUnavailable += 1;
      }
    }
    return summary;
  }

  getVideoMeta(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return null;
    return {
      title: entry.title,
      upperName: entry.upperName,
      cover: entry.cover,
      description: entry.description,
      favoriteUnavailable: entry.favoriteUnavailable,
      selfVisible: entry.selfVisible,
      accessRestriction: entry.accessRestriction,
    };
  }

  getCompletedLocalDownload(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry?.localDir || !fs.existsSync(entry.localDir)) return null;
    const manifest = readDownloadSession(entry.localDir);
    if (!manifest || !["complete", "partial"].includes(manifest.status)) return null;
    return {
      localDir: entry.localDir,
      files: manifest.outputs.map((output) => output.relativePath),
      partialBackup: manifest.status === "partial",
    };
  }

  private migrateLegacyState() {
    let changed = false;
    if ((this.state.schemaVersion || 1) < 2) {
      for (const [userId, entries] of Object.entries(this.state.processedByUser || {})) {
        for (const entry of Object.values(entries)) {
          if (!this.state.videos![entry.bvid]) {
            this.state.videos![entry.bvid] = {
              bvid: entry.bvid,
              title: entry.bvid,
              upperName: "Unknown",
              firstSeenAt: entry.processedAt,
              lastSeenAt: entry.processedAt,
              biliStatus: "unknown",
              backupStatus: "discovered",
            };
          }
          const key = relationKey(userId, entry.mediaId, entry.bvid);
          if (!this.state.relations![key]) {
            this.state.relations![key] = {
              userId,
              mediaId: entry.mediaId,
              bvid: entry.bvid,
              folderTitle: "Legacy favorite",
              firstSeenAt: entry.processedAt,
              lastSeenAt: entry.processedAt,
              activeInFavorite: true,
            };
          }
        }
      }
      for (const [userId, entries] of Object.entries(this.state.failedByUser || {})) {
        for (const entry of Object.values(entries)) {
          if (!this.state.videos![entry.bvid]) {
            this.state.videos![entry.bvid] = {
              bvid: entry.bvid,
              title: entry.bvid,
              upperName: "Unknown",
              firstSeenAt: entry.failedAt,
              lastSeenAt: entry.failedAt,
              biliStatus: "unknown",
              backupStatus: "failed",
              lastError: entry.reason,
            };
          }
          const key = relationKey(userId, entry.mediaId, entry.bvid);
          if (!this.state.relations![key]) {
            this.state.relations![key] = {
              userId,
              mediaId: entry.mediaId,
              bvid: entry.bvid,
              folderTitle: "Legacy favorite",
              firstSeenAt: entry.failedAt,
              lastSeenAt: entry.failedAt,
              activeInFavorite: true,
            };
          }
        }
      }
      this.state.schemaVersion = 2;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 3) {
      for (const entry of Object.values(this.state.videos || {})) {
        const hasRemoteProof = Boolean(entry.remotePath) || Boolean(entry.remoteFiles?.length);
        if ((entry.backupStatus === "uploaded" || entry.backupStatus === "verified") && !hasRemoteProof) {
          entry.backupStatus = entry.biliStatus === "unavailable" ? "lost" : "discovered";
          entry.uploadedAt = undefined;
          entry.verifiedAt = undefined;
          entry.lastRemoteCheckAt = undefined;
          entry.remoteMissingCount = 0;
          entry.lastError = "Legacy uploaded state without remote proof has been reset and will be backed up again.";
          changed = true;
        }
        if (entry.legacyProcessed) {
          delete entry.legacyProcessed;
          changed = true;
        }
      }
      this.state.schemaVersion = 3;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 4) {
      for (const entry of Object.values(this.state.videos || {})) {
        if (entry.nextRemoteCheckAt) {
          delete entry.nextRemoteCheckAt;
          changed = true;
        }
      }
      this.state.schemaVersion = 4;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 5) {
      for (const relation of Object.values(this.state.relations || {})) {
        const video = this.state.videos?.[relation.bvid];
        if (!relation.backupStatus) {
          relation.backupStatus = video && relationTreatsUnavailable(relation, video) ? "lost" : "discovered";
        }
      }
      this.state.schemaVersion = 5;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 6) {
      for (const relation of Object.values(this.state.relations || {})) {
        const video = this.state.videos?.[relation.bvid];
        if (!video || relationTreatsUnavailable(relation, video)) continue;
        const hasGlobalProof = Boolean(video.remoteFiles?.length) ||
          Boolean(video.uploadedAt) ||
          Boolean(video.verifiedAt);
        if (!hasGlobalProof) continue;
        if (relation.backupStatus === "missing" || relation.backupStatus === "lost") continue;
        if (relation.backupStatus !== "uploaded" && relation.backupStatus !== "verified") {
          relation.backupStatus = "verified";
          relation.remoteFiles = undefined;
          relation.lastRemoteCheckAt = undefined;
          relation.nextRemoteCheckAt = undefined;
          relation.remoteMissingCount = 0;
          relation.lastError = "Imported legacy global backup state; waiting for AList verification.";
          changed = true;
        }
      }
      this.state.schemaVersion = 6;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 7) {
      for (const [userId, entries] of Object.entries(this.state.failedByUser || {})) {
        const migrated: Record<string, FailedEntry> = {};
        for (const [key, entry] of Object.entries(entries || {})) {
          if (!entry) continue;
          const normalizedBvid = entry.bvid || key;
          const normalizedMediaId = Number(entry.mediaId || 0);
          if (!Number.isFinite(normalizedMediaId) || normalizedMediaId <= 0) {
            continue;
          }
          const targetKey = failedKey(normalizedMediaId, normalizedBvid);
          const prev = migrated[targetKey];
          if (!prev) {
            migrated[targetKey] = { ...entry, bvid: normalizedBvid, mediaId: normalizedMediaId };
            continue;
          }
          const prevAt = Date.parse(prev.failedAt || "");
          const nextAt = Date.parse(entry.failedAt || "");
          if (!Number.isFinite(prevAt) || (Number.isFinite(nextAt) && nextAt > prevAt)) {
            migrated[targetKey] = { ...entry, bvid: normalizedBvid, mediaId: normalizedMediaId };
          }
        }
        this.state.failedByUser![userId] = migrated;
      }

      for (const relation of Object.values(this.state.relations || {})) {
        if (relation.lastError !== "Imported legacy global backup state; waiting for AList verification.") {
          continue;
        }
        const video = this.state.videos?.[relation.bvid];
        relation.backupStatus = video && relationTreatsUnavailable(relation, video) ? "lost" : "discovered";
        relation.remoteFiles = undefined;
        relation.uploadedAt = undefined;
        relation.verifiedAt = undefined;
        relation.lastRemoteCheckAt = undefined;
        relation.nextRemoteCheckAt = undefined;
        relation.remoteMissingCount = 0;
        relation.lastError = "Legacy relation status reset; waiting for real remote verification.";
        this.refreshVideoAggregateStatus(relation.bvid);
      }

      this.state.schemaVersion = 7;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 8) {
      for (const relation of Object.values(this.state.relations || {})) {
        const video = this.state.videos?.[relation.bvid];
        if (!video) {
          continue;
        }
        if (relation.selfVisible && relation.backupStatus === "lost") {
          relation.backupStatus = "discovered";
          relation.lastError = undefined;
          relation.statusUpdatedAt = nowIso();
          changed = true;
        } else if (!relation.selfVisible && video.biliStatus === "unavailable" && relation.backupStatus === "discovered") {
          relation.backupStatus = "lost";
          relation.statusUpdatedAt = nowIso();
          changed = true;
        }
        this.refreshVideoAggregateStatus(relation.bvid);
      }
      this.state.schemaVersion = 8;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 9) {
      const migratedBvids = new Set<string>();
      for (const entry of Object.values(this.state.videos || {})) {
        const hasLocalDir = Boolean(entry.localDir && fs.existsSync(entry.localDir));
        if (!hasLocalDir || entry.backupStatus !== "failed") {
          continue;
        }
        entry.backupStatus = "upload_failed";
        entry.statusUpdatedAt = nowIso();
        migratedBvids.add(entry.bvid);
        changed = true;
      }
      for (const relation of Object.values(this.state.relations || {})) {
        const entry = this.state.videos?.[relation.bvid];
        const hasLocalDir = Boolean(entry?.localDir && fs.existsSync(entry.localDir));
        if (!hasLocalDir || relation.backupStatus !== "failed") continue;
        relation.backupStatus = "upload_failed";
        relation.statusUpdatedAt = nowIso();
        migratedBvids.add(relation.bvid);
        changed = true;
      }
      for (const bvid of migratedBvids) {
        this.refreshVideoAggregateStatus(bvid);
      }
      this.state.schemaVersion = 9;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 10) {
      for (const entry of Object.values(this.state.videos || {})) {
        if (!entry.localDir || !fs.existsSync(entry.localDir)) continue;
        const manifest = readDownloadSession(entry.localDir);
        if (!manifest) continue;
        entry.downloadSession = {
          id: manifest.sessionId,
          localDir: entry.localDir,
          kind: manifest.kind,
          status: manifest.status,
          completedPages: manifest.outputs.length,
          totalPages: manifest.pages.length,
          updatedAt: manifest.updatedAt,
        };
        changed = true;
      }
      this.state.schemaVersion = 10;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 11) {
      this.state.schemaVersion = 11;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 12) {
      this.state.schemaVersion = 12;
      changed = true;
    }
    if ((this.state.schemaVersion || 1) < 13) {
      this.state.schemaVersion = 13;
      changed = true;
    }

    if (Object.keys(this.state.processedByUser || {}).length > 0) {
      this.state.processedByUser = {};
      changed = true;
    }

    if (changed) {
      this.save();
    }
  }

  clear() {
    this.database.clearStateAndJobs();
    this.videoCache.clear();
    this.relationCache.clear();
    this.videoDeletes.clear();
    this.relationDeletes.clear();
    this.state = this.trackDatabaseState({
      schemaVersion: defaultState.schemaVersion,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
      downloadApiCooldown: undefined,
    });
    this.lazyState = true;
    this.resetDirtySet();
  }

  close() {
    this.flush();
    this.database.close();
  }

  getDatabase() {
    return this.database;
  }

  getMigrationPendingUploadCount() {
    const row = this.database.db.prepare(`
      SELECT COUNT(DISTINCT bvid) AS count FROM favorite_relations
      WHERE backup_status IN ('downloaded','uploading','upload_failed')
    `).get() as any;
    return Number(row?.count || 0);
  }

  async backupDatabase(destination: string) {
    this.flush();
    await this.database.backupTo(destination);
  }

  private reloadDatabaseView() {
    this.videoCache.clear();
    this.relationCache.clear();
    this.videoDeletes.clear();
    this.relationDeletes.clear();
    this.state = this.trackDatabaseState(this.database.loadStateMetadata());
    this.lazyState = true;
    this.resetDirtySet();
  }

  async beginDatabaseReplacement(source: string): Promise<DatabaseReplacementHandle> {
    if (this.dbPath === ":memory:") {
      const imported = new StateDatabase(source);
      const previousState = this.snapshotState();
      try {
        imported.integrityCheck();
        this.replaceStateSnapshot(imported.loadState());
      } catch (error) {
        this.replaceStateSnapshot(previousState);
        throw error;
      } finally {
        imported.close();
      }
      let settled = false;
      return {
        commit: async () => { settled = true; },
        rollback: async () => {
          if (settled) return;
          this.replaceStateSnapshot(previousState);
          settled = true;
        },
      };
    }
    const validation = new StateDatabase(source);
    try {
      validation.integrityCheck();
    } finally {
      validation.close();
    }
    this.flush();
    const operationId = crypto.randomUUID().replace(/-/g, "");
    const replacement = `${this.dbPath}.importing-${operationId}`;
    const previous = `${this.dbPath}.before-import-${operationId}`;
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${replacement}${suffix}`, { force: true });
    fs.copyFileSync(source, replacement);
    this.database.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${previous}${suffix}`, { force: true });
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(`${this.dbPath}${suffix}`)) fs.renameSync(`${this.dbPath}${suffix}`, `${previous}${suffix}`);
      }
      fs.renameSync(replacement, this.dbPath);
      this.database = new StateDatabase(this.dbPath);
      this.database.integrityCheck();
      this.reloadDatabaseView();
    } catch (error) {
      try { if (this.database?.db?.open) this.database.close(); } catch {}
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(`${previous}${suffix}`)) fs.renameSync(`${previous}${suffix}`, `${this.dbPath}${suffix}`);
      }
      this.database = new StateDatabase(this.dbPath);
      this.reloadDatabaseView();
      throw error;
    }
    let settled = false;
    return {
      commit: async () => {
        if (settled) return;
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${previous}${suffix}`, { force: true });
        settled = true;
      },
      rollback: async () => {
        if (settled) return;
        this.database.close();
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
        for (const suffix of ["", "-wal", "-shm"]) {
          if (fs.existsSync(`${previous}${suffix}`)) fs.renameSync(`${previous}${suffix}`, `${this.dbPath}${suffix}`);
        }
        this.database = new StateDatabase(this.dbPath);
        this.database.integrityCheck();
        this.reloadDatabaseView();
        settled = true;
      },
    };
  }

  async replaceDatabaseFile(source: string) {
    const replacement = await this.beginDatabaseReplacement(source);
    await replacement.commit();
  }

  replaceStateSnapshot(state: StateFile) {
    const normalized = this.normalizeLoadedState(state);
    this.lazyState = false;
    this.state = this.trackState(normalized);
    this.suppressFlush = true;
    this.migrateLegacyState();
    this.suppressFlush = false;
    this.database.replaceState(this.snapshotState());
    this.videoCache.clear();
    this.relationCache.clear();
    this.videoDeletes.clear();
    this.relationDeletes.clear();
    this.state = this.trackDatabaseState(this.database.loadStateMetadata());
    this.lazyState = true;
    this.resetDirtySet();
  }

  private save() {
    this.dirty = true;
    if (this.batchDepth === 0) {
      this.flush();
    }
  }

  private flush() {
    if (!this.dirty || this.suppressFlush) return;
    this.onFlush?.(this.dirtySet);
    this.database.flushState(this.state, this.dirtySet);
    this.resetDirtySet();
    if (this.lazyState) {
      this.videoCache.clear();
      this.relationCache.clear();
      this.videoDeletes.clear();
      this.relationDeletes.clear();
    }
  }
}
