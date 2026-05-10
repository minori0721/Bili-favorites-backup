import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

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
  | "uploaded"
  | "verified"
  | "missing"
  | "lost"
  | "failed";

export type BiliStatus = "available" | "unavailable" | "unknown";

export interface RemoteFileRecord {
  name: string;
  path: string;
  size?: number;
}

export interface VideoArchiveEntry {
  bvid: string;
  title: string;
  upperName: string;
  cover?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  biliStatus: BiliStatus;
  backupStatus: BackupStatus;
  remotePath?: string;
  remoteFiles?: RemoteFileRecord[];
  localDir?: string;
  uploadedAt?: string;
  verifiedAt?: string;
  lastRemoteCheckAt?: string;
  nextRemoteCheckAt?: string;
  remoteMissingCount?: number;
  lastError?: string;
  // Legacy marker kept for one-way migration cleanup.
  legacyProcessed?: boolean;
}

export interface FavoriteRelation {
  userId: string;
  mediaId: number;
  bvid: string;
  folderTitle: string;
  firstSeenAt: string;
  lastSeenAt: string;
  activeInFavorite: boolean;
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
  cover?: string;
  unavailable?: boolean;
}

export interface StateFile {
  schemaVersion?: number;
  processedByUser: Record<string, Record<string, ProcessedEntry>>;
  failedByUser?: Record<string, Record<string, FailedEntry>>;
  videos?: Record<string, VideoArchiveEntry>;
  relations?: Record<string, FavoriteRelation>;
  folderScans?: Record<string, FolderScanState>;
  userCooldowns?: Record<string, UserCooldown>;
}

const statePath = path.join(dataDir, "state.json");
const defaultState: StateFile = {
  schemaVersion: 4,
  processedByUser: {},
  failedByUser: {},
  videos: {},
  relations: {},
  folderScans: {},
  userCooldowns: {},
};

const BACKED_UP_STATUSES = new Set<BackupStatus>(["uploaded", "verified"]);
const ACTIVE_BACKUP_STATUSES = new Set<BackupStatus>([
  "queued",
  "downloading",
  "downloaded",
  "uploading",
]);

function nowIso() {
  return new Date().toISOString();
}

function relationKey(userId: string, mediaId: number, bvid: string) {
  return `${userId}:${mediaId}:${bvid}`;
}

function folderKey(userId: string, mediaId: number) {
  return `${userId}:${mediaId}`;
}

export class StateManager {
  private state: StateFile;

  constructor() {
    this.state = readJsonFile<StateFile>(statePath, defaultState);
    this.state.processedByUser ||= {};
    this.state.failedByUser ||= {};
    this.state.videos ||= {};
    this.state.relations ||= {};
    this.state.folderScans ||= {};
    this.state.userCooldowns ||= {};
    this.migrateLegacyState();
  }

  isProcessed(_userId: string, bvid: string) {
    const entry = this.state.videos?.[bvid];
    return Boolean(entry && BACKED_UP_STATUSES.has(entry.backupStatus));
  }

  isFailed(userId: string, bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (entry?.backupStatus === "failed" || entry?.backupStatus === "lost") {
      return true;
    }
    return Boolean(this.state.failedByUser?.[userId]?.[bvid]);
  }

  recordFavoriteItem(
    userId: string,
    mediaId: number,
    folderTitle: string,
    item: ObservedFavoriteItem
  ) {
    const seenAt = nowIso();
    const existing = this.state.videos![item.bvid];
    const wasKnown = Boolean(existing);
    const biliStatus: BiliStatus = item.unavailable ? "unavailable" : "available";

    if (!existing) {
      this.state.videos![item.bvid] = {
        bvid: item.bvid,
        title: item.title || "Untitled",
        upperName: item.upperName || "Unknown",
        cover: item.cover,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        biliStatus,
        backupStatus: item.unavailable ? "lost" : "discovered",
      };
    } else {
      existing.title = item.title || existing.title;
      existing.upperName = item.upperName || existing.upperName;
      existing.cover = item.cover || existing.cover;
      existing.lastSeenAt = seenAt;
      existing.biliStatus = biliStatus;
      if (item.unavailable && !BACKED_UP_STATUSES.has(existing.backupStatus)) {
        existing.backupStatus = "lost";
        existing.lastError = "Video became unavailable before a verified backup was found.";
      } else if (!item.unavailable && existing.backupStatus === "lost") {
        existing.backupStatus = "discovered";
        existing.lastError = undefined;
      }
    }

    const key = relationKey(userId, mediaId, item.bvid);
    const relation = this.state.relations![key];
    if (relation) {
      relation.folderTitle = folderTitle;
      relation.lastSeenAt = seenAt;
      relation.activeInFavorite = true;
    } else {
      this.state.relations![key] = {
        userId,
        mediaId,
        bvid: item.bvid,
        folderTitle,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        activeInFavorite: true,
      };
    }

    this.save();
    return { wasKnown, entry: this.state.videos![item.bvid] };
  }

  shouldEnqueueBackup(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry || entry.biliStatus === "unavailable") {
      return false;
    }
    if (BACKED_UP_STATUSES.has(entry.backupStatus)) {
      return false;
    }
    if (ACTIVE_BACKUP_STATUSES.has(entry.backupStatus)) {
      return false;
    }
    return entry.backupStatus === "discovered" || entry.backupStatus === "missing" || entry.backupStatus === "failed";
  }

  markQueued(bvid: string, remotePath: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "queued";
    entry.remotePath = remotePath;
    entry.lastError = undefined;
    this.save();
  }

  markDownloading(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "downloading";
    this.save();
  }

  markDownloaded(bvid: string, localDir: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "downloaded";
    entry.localDir = localDir;
    this.save();
  }

  markUploading(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "uploading";
    this.save();
  }

  markRetryPending(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    if (entry.biliStatus === "unavailable") {
      entry.backupStatus = "lost";
      entry.lastError ||= "Video unavailable while resuming backup.";
      this.save();
      return;
    }
    entry.backupStatus = "discovered";
    entry.localDir = undefined;
    this.save();
  }

  markVerifiedUpload(
    bvid: string,
    remotePath: string,
    remoteFiles: RemoteFileRecord[],
    _userId?: string,
    _mediaId?: number
  ) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    entry.backupStatus = "verified";
    entry.remotePath = remotePath;
    entry.remoteFiles = remoteFiles;
    entry.localDir = undefined;
    entry.uploadedAt = at;
    entry.verifiedAt = at;
    entry.lastRemoteCheckAt = at;
    entry.remoteMissingCount = 0;
    entry.lastError = undefined;
    this.save();
  }

  markProcessed(_userId: string, bvid: string, _mediaId: number) {
    const at = nowIso();
    const entry = this.state.videos?.[bvid];
    if (entry) {
      entry.backupStatus = entry.biliStatus === "unavailable" ? "lost" : "discovered";
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
    this.state.failedByUser ||= {};
    if (!this.state.failedByUser[userId]) {
      this.state.failedByUser[userId] = {};
    }
    this.state.failedByUser[userId][bvid] = {
      bvid,
      mediaId,
      reason,
      permanent,
      failedAt: at,
    };
    const entry = this.state.videos?.[bvid];
    if (entry) {
      entry.backupStatus = permanent && entry.biliStatus === "unavailable" ? "lost" : "failed";
      entry.lastError = reason;
    }
    this.save();
  }

  markRemoteCheckOk(bvid: string, remotePath?: string, remoteFiles?: RemoteFileRecord[]) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    entry.backupStatus = "verified";
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
    this.save();
  }

  markRemoteCheckMissing(bvid: string, missingFiles: string[]) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.lastRemoteCheckAt = nowIso();
    entry.remoteMissingCount = (entry.remoteMissingCount || 0) + 1;
    entry.lastError = `Remote files missing: ${missingFiles.join(", ")}`;
    if (entry.remoteMissingCount >= 2) {
      entry.backupStatus = entry.biliStatus === "unavailable" ? "lost" : "missing";
    }
    this.save();
  }

  markRemoteCheckDeferred(bvid: string, delayMs: number, reason?: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
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
    this.state.userCooldowns![userId] = {
      userId,
      until: Date.now() + cooldownMs,
      reason,
      setAt: nowIso(),
    };
    this.save();
  }

  getUserCooldown(userId: string) {
    const cooldown = this.state.userCooldowns?.[userId];
    if (!cooldown) return null;
    if (cooldown.until <= Date.now()) {
      delete this.state.userCooldowns?.[userId];
      this.save();
      return null;
    }
    return { ...cooldown };
  }

  getAllCooldowns() {
    const active: Record<string, UserCooldown> = {};
    for (const [userId, cooldown] of Object.entries(this.state.userCooldowns || {})) {
      if (cooldown.until > Date.now()) {
        active[userId] = { ...cooldown, userId };
      }
    }
    return active;
  }

  listBackupsToResume() {
    return Object.values(this.state.videos || {}).filter((entry) =>
      ["queued", "downloading", "downloaded", "uploading", "missing"].includes(entry.backupStatus)
    );
  }

  listVideosForRemoteVerify(limit?: number, includeDeferred = false) {
    const now = Date.now();
    const sorted = Object.values(this.state.videos || {})
      .filter((entry) =>
        (entry.backupStatus === "uploaded" || entry.backupStatus === "verified") &&
        (includeDeferred || !entry.nextRemoteCheckAt || Date.parse(entry.nextRemoteCheckAt) <= now)
      )
      .sort((a, b) => {
        const left = a.lastRemoteCheckAt ? Date.parse(a.lastRemoteCheckAt) : 0;
        const right = b.lastRemoteCheckAt ? Date.parse(b.lastRemoteCheckAt) : 0;
        return left - right;
      });
    const picked = typeof limit === "number" ? sorted.slice(0, limit) : sorted;
    return picked.map((entry) => ({ ...entry, remoteFiles: [...(entry.remoteFiles || [])] }));
  }

  countVideosForRemoteVerify(includeDeferred = false) {
    const now = Date.now();
    return Object.values(this.state.videos || {}).filter((entry) =>
      (entry.backupStatus === "uploaded" || entry.backupStatus === "verified") &&
      (includeDeferred || !entry.nextRemoteCheckAt || Date.parse(entry.nextRemoteCheckAt) <= now)
    ).length;
  }

  findRelationForBvid(bvid: string) {
    const relation = Object.values(this.state.relations || {}).find((item) => item.bvid === bvid);
    return relation ? { ...relation } : null;
  }

  listRelationsForBvid(bvid: string) {
    return Object.values(this.state.relations || {})
      .filter((item) => item.bvid === bvid)
      .map((item) => ({ ...item }));
  }

  listUnavailableForUser(userId: string, offset: number, limit: number) {
    const dedup = new Map<string, { relation: FavoriteRelation; video: VideoArchiveEntry }>();
    const relations = Object.values(this.state.relations || {})
      .filter((relation) => relation.userId === userId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } =>
        Boolean(item.video && item.video.biliStatus === "unavailable")
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
      title: video.title,
      upperName: video.upperName,
      cover: video.cover,
      unavailable: true,
      processed: this.isProcessed(userId, video.bvid),
      failed: this.isFailed(userId, video.bvid),
      mediaId: relation.mediaId,
      folderTitle: relation.folderTitle,
    }));

    return {
      items: page,
      hasMore: offset + limit < uniqueRelations.length,
      nextOffset: offset + limit < uniqueRelations.length ? offset + limit : null,
    };
  }

  // Kept for API compatibility; legacy processed map is no longer used.
  getAllProcessed() {
    return {};
  }

  getAllFailed() {
    return { ...(this.state.failedByUser || {}) };
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

    if (Object.keys(this.state.processedByUser || {}).length > 0) {
      this.state.processedByUser = {};
      changed = true;
    }

    if (changed) {
      this.save();
    }
  }

  private save() {
    writeJsonFile(statePath, this.state);
  }
}
