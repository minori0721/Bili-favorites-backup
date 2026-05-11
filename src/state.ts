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
  // Order in Bilibili favorite list (based on page + index in API response).
  favOrder?: number;
  favPage?: number;
  favIndexInPage?: number;
  favOrderUpdatedAt?: string;
  activeInFavorite: boolean;
  backupStatus?: BackupStatus;
  remotePath?: string;
  remoteFiles?: RemoteFileRecord[];
  uploadedAt?: string;
  verifiedAt?: string;
  lastRemoteCheckAt?: string;
  nextRemoteCheckAt?: string;
  remoteMissingCount?: number;
  lastError?: string;
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
  favOrder?: number;
  favPage?: number;
  favIndexInPage?: number;
  unavailable: boolean;
  processed: boolean;
  failed: boolean;
  mediaId: number;
  folderTitle: string;
  lastSeenAt: string;
  activeInFavorite: boolean;
}

export interface FolderDetailSummary {
  total: number;
  uploaded: number;
  pending: number;
  pendingUnavailable: number;
  uploadedUnavailable: number;
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
  schemaVersion: 7,
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
const RELATION_BACKUP_PRIORITY: BackupStatus[] = [
  "uploading",
  "downloading",
  "downloaded",
  "queued",
  "missing",
  "failed",
  "discovered",
  "lost",
  "uploaded",
  "verified",
];

function nowIso() {
  return new Date().toISOString();
}

function relationKey(userId: string, mediaId: number, bvid: string) {
  return `${userId}:${mediaId}:${bvid}`;
}

function failedKey(mediaId: number, bvid: string) {
  return `${mediaId}:${bvid}`;
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

  private getRelation(userId: string | undefined, mediaId: number | undefined, bvid: string) {
    if (!userId || !mediaId) return null;
    return this.state.relations?.[relationKey(userId, mediaId, bvid)] || null;
  }

  private getFailedEntry(userId: string, bvid: string, mediaId?: number) {
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
      : Object.values(this.state.relations || {}).filter((relation) => relation.bvid === bvid);
    for (const relation of relations) {
      updater(relation);
    }
  }

  private initialRelationStatus(bvid: string): BackupStatus {
    const entry = this.state.videos?.[bvid];
    if (!entry) return "discovered";
    if (entry.biliStatus === "unavailable") return "lost";
    if (ACTIVE_BACKUP_STATUSES.has(entry.backupStatus)) return entry.backupStatus;
    if (entry.backupStatus === "missing" || entry.backupStatus === "failed") return entry.backupStatus;
    return "discovered";
  }

  private refreshVideoAggregateStatus(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const relations = Object.values(this.state.relations || {}).filter((relation) => relation.bvid === bvid);
    if (relations.length === 0) return;
    const statuses = relations.map((relation) => relation.backupStatus || this.initialRelationStatus(bvid));
    const active = statuses.find((status) => ACTIVE_BACKUP_STATUSES.has(status));
    if (active) {
      entry.backupStatus = active;
      return;
    }
    for (const status of RELATION_BACKUP_PRIORITY) {
      if (statuses.includes(status)) {
        entry.backupStatus = status;
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
    if (entry?.backupStatus === "failed" || entry?.backupStatus === "lost") {
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
    }
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
      if (Number.isInteger(orderInfo?.favOrder) && Number(orderInfo!.favOrder) > 0) {
        relation.favOrder = Number(orderInfo!.favOrder);
        relation.favPage = Number.isInteger(orderInfo?.favPage) && Number(orderInfo!.favPage) > 0 ? Number(orderInfo!.favPage) : relation.favPage;
        relation.favIndexInPage = Number.isInteger(orderInfo?.favIndexInPage) && Number(orderInfo!.favIndexInPage) >= 0
          ? Number(orderInfo!.favIndexInPage)
          : relation.favIndexInPage;
        relation.favOrderUpdatedAt = seenAt;
      }
      if (!relation.backupStatus) {
        relation.backupStatus = this.initialRelationStatus(item.bvid);
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
        backupStatus: item.unavailable ? "lost" : "discovered",
      };
    }

    this.save();
    return { wasKnown, entry: this.state.videos![item.bvid] };
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
    if (!entry || entry.biliStatus === "unavailable") {
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
    const relation = userId && mediaId ? this.state.relations?.[relationKey(userId, mediaId, bvid)] : undefined;
    const status = relation?.backupStatus || entry.backupStatus;
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
    entry.backupStatus = "queued";
    entry.remotePath = remotePath;
    entry.lastError = undefined;
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.backupStatus = "queued";
      relation.remotePath = remotePath;
      relation.lastError = undefined;
    }
    this.save();
  }

  markDownloading(bvid: string, targets?: Array<{ userId: string; mediaId: number }>) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "downloading";
    this.updateTargetRelations(bvid, targets, (relation) => {
      relation.backupStatus = "downloading";
    });
    this.save();
  }

  markDownloaded(bvid: string, localDir: string, targets?: Array<{ userId: string; mediaId: number }>) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "downloaded";
    entry.localDir = localDir;
    this.updateTargetRelations(bvid, targets, (relation) => {
      relation.backupStatus = "downloaded";
    });
    this.save();
  }

  markUploading(bvid: string, userId?: string, mediaId?: number) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    entry.backupStatus = "uploading";
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.backupStatus = "uploading";
    }
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

  markRelationRetryPending(bvid: string, userId?: string, mediaId?: number, reason?: string) {
    const entry = this.state.videos?.[bvid];
    const relation = this.getRelation(userId, mediaId, bvid);
    if (!relation) {
      this.markRetryPending(bvid);
      return;
    }
    relation.backupStatus = entry?.biliStatus === "unavailable" ? "lost" : "discovered";
    relation.lastError = reason;
    relation.nextRemoteCheckAt = undefined;
    this.refreshVideoAggregateStatus(bvid);
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
    const relation = this.getRelation(_userId, _mediaId, bvid);
    if (relation) {
      relation.backupStatus = "verified";
      relation.remotePath = remotePath;
      relation.remoteFiles = remoteFiles;
      relation.uploadedAt = at;
      relation.verifiedAt = at;
      relation.lastRemoteCheckAt = at;
      relation.nextRemoteCheckAt = undefined;
      relation.remoteMissingCount = 0;
      relation.lastError = undefined;
    }
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
    this.state.failedByUser[userId][failedKey(mediaId, bvid)] = {
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
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.backupStatus = permanent && entry?.biliStatus === "unavailable" ? "lost" : "failed";
      relation.lastError = reason;
    }
    this.save();
  }

  clearFailed(userId: string, mediaId: number, bvid: string) {
    const entries = this.state.failedByUser?.[userId];
    if (!entries) return;
    const scoped = failedKey(mediaId, bvid);
    if (entries[scoped]) {
      delete entries[scoped];
    }
    if (entries[bvid]) {
      delete entries[bvid];
    }
    if (Object.keys(entries).length === 0) {
      delete this.state.failedByUser?.[userId];
    }
    this.save();
  }

  markRemoteCheckOk(bvid: string, remotePath?: string, remoteFiles?: RemoteFileRecord[], userId?: string, mediaId?: number) {
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
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.backupStatus = "verified";
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
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      relation.lastRemoteCheckAt = nowIso();
      relation.remoteMissingCount = (relation.remoteMissingCount || 0) + 1;
      relation.lastError = `Remote files missing: ${missingFiles.join(", ")}`;
      if (relation.remoteMissingCount >= 2) {
        relation.backupStatus = entry.biliStatus === "unavailable" ? "lost" : "missing";
      }
      this.refreshVideoAggregateStatus(bvid);
      this.save();
      return;
    }
    entry.lastRemoteCheckAt = nowIso();
    entry.remoteMissingCount = (entry.remoteMissingCount || 0) + 1;
    entry.lastError = `Remote files missing: ${missingFiles.join(", ")}`;
    if (entry.remoteMissingCount >= 2) {
      entry.backupStatus = entry.biliStatus === "unavailable" ? "lost" : "missing";
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
    const relationWork = Object.values(this.state.relations || {})
      .filter((relation) => ["queued", "downloading", "downloaded", "uploading", "missing"].includes(relation.backupStatus || ""))
      .map((relation) => ({ relation: { ...relation }, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => Boolean(item.video));
    if (relationWork.length > 0) {
      return relationWork;
    }
    return Object.values(this.state.videos || {})
      .filter((entry) => ["queued", "downloading", "downloaded", "uploading", "missing"].includes(entry.backupStatus))
      .map((video) => ({ video: { ...video }, relation: this.findRelationForBvid(video.bvid) }));
  }

  listVideosForRemoteVerify(limit?: number, includeDeferred = false) {
    const now = Date.now();
    const sorted = Object.values(this.state.relations || {})
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } =>
        Boolean(item.video) &&
        (item.relation.backupStatus === "uploaded" || item.relation.backupStatus === "verified") &&
        (includeDeferred || !item.relation.nextRemoteCheckAt || Date.parse(item.relation.nextRemoteCheckAt) <= now)
      )
      .sort((a, b) => {
        const left = a.relation.lastRemoteCheckAt ? Date.parse(a.relation.lastRemoteCheckAt) : 0;
        const right = b.relation.lastRemoteCheckAt ? Date.parse(b.relation.lastRemoteCheckAt) : 0;
        return left - right;
      });
    const picked = typeof limit === "number" ? sorted.slice(0, limit) : sorted;
    return picked.map(({ relation, video }) => {
      const relationFiles = relation.remoteFiles || [];
      return {
        ...video,
        remotePath: relation.remotePath,
        remoteFiles: [...relationFiles],
        lastRemoteCheckAt: relation.lastRemoteCheckAt || video.lastRemoteCheckAt,
        nextRemoteCheckAt: relation.nextRemoteCheckAt || video.nextRemoteCheckAt,
        remoteMissingCount: relation.remoteMissingCount || video.remoteMissingCount,
        relation: { ...relation, remoteFiles: [...relationFiles] },
      };
    });
  }

  countVideosForRemoteVerify(includeDeferred = false) {
    const now = Date.now();
    return Object.values(this.state.relations || {}).filter((relation) =>
      (relation.backupStatus === "uploaded" || relation.backupStatus === "verified") &&
      (includeDeferred || !relation.nextRemoteCheckAt || Date.parse(relation.nextRemoteCheckAt) <= now)
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

  listRetryCandidatesForFolder(userId: string, mediaId: number, limit = 500) {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const rows: Array<{ relation: FavoriteRelation; video: VideoArchiveEntry; failed?: FailedEntry }> = [];
    for (const relation of Object.values(this.state.relations || {})) {
      if (relation.userId !== userId || relation.mediaId !== mediaId) {
        continue;
      }
      const video = this.state.videos?.[relation.bvid];
      if (!video) {
        continue;
      }
      const failed = this.getFailedEntry(userId, relation.bvid, mediaId);
      rows.push({ relation, video, failed });
    }

    const candidates = rows
      .filter(({ relation, video, failed }) => {
        if (video.biliStatus === "unavailable") return false;
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
    const rows = Object.values(this.state.relations || {})
      .filter((relation) => relation.userId === userId && relation.mediaId === mediaId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => Boolean(item.video))
      .sort((a, b) => {
        const leftOrder = Number.isInteger(a.relation.favOrder) ? Number(a.relation.favOrder) : Number.POSITIVE_INFINITY;
        const rightOrder = Number.isInteger(b.relation.favOrder) ? Number(b.relation.favOrder) : Number.POSITIVE_INFINITY;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return Date.parse(b.relation.lastSeenAt) - Date.parse(a.relation.lastSeenAt);
      });

    const allItems = rows.map(({ relation, video }) => {
      const unavailable = video.biliStatus === "unavailable";
      const processed = this.isProcessed(userId, video.bvid, mediaId);
      const item: FolderDetailItem = {
        bvid: video.bvid,
        title: video.title,
        upperName: video.upperName,
        cover: video.cover,
        favOrder: relation.favOrder,
        favPage: relation.favPage,
        favIndexInPage: relation.favIndexInPage,
        unavailable,
        processed,
        failed: this.isFailed(userId, video.bvid, mediaId),
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
        lastSeenAt: relation.lastSeenAt,
        activeInFavorite: relation.activeInFavorite,
      };
      return item;
    });

    const summary: FolderDetailSummary = {
      total: allItems.length,
      uploaded: 0,
      pending: 0,
      pendingUnavailable: 0,
      uploadedUnavailable: 0,
    };
    for (const item of allItems) {
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
      processed: this.isProcessed(userId, video.bvid, relation.mediaId),
      failed: this.isFailed(userId, video.bvid, relation.mediaId),
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

  getRelationStatus(userId: string, mediaId: number, bvid: string) {
    const relation = this.state.relations?.[relationKey(userId, mediaId, bvid)];
    return relation ? { ...relation, remoteFiles: [...(relation.remoteFiles || [])] } : null;
  }

  getVideoMeta(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return null;
    return {
      title: entry.title,
      upperName: entry.upperName,
      cover: entry.cover,
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
          relation.backupStatus = video?.biliStatus === "unavailable" ? "lost" : "discovered";
        }
      }
      this.state.schemaVersion = 5;
      changed = true;
    }

    if ((this.state.schemaVersion || 1) < 6) {
      for (const relation of Object.values(this.state.relations || {})) {
        const video = this.state.videos?.[relation.bvid];
        if (!video || video.biliStatus === "unavailable") continue;
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
        relation.backupStatus = video?.biliStatus === "unavailable" ? "lost" : "discovered";
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
