import path from "node:path";
import fs from "node:fs";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import { historySessionGroups, readDownloadSession } from "./download-session.js";
import type { PersistedDownloadApiCooldown } from "./download-api-health.js";

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
}

export interface VideoMetadataSnapshot {
  title: string;
  upperName: string;
  cover?: string;
  coverLocalPath?: string;
  description?: string;
  capturedAt: string;
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
  localDir?: string;
  downloadSession?: DownloadSessionReference;
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
  qualityUpgrade?: QualityUpgradeOperation;
  uploadedAt?: string;
  verifiedAt?: string;
  lastRemoteCheckAt?: string;
  nextRemoteCheckAt?: string;
  remoteMissingCount?: number;
  lastError?: string;
  favoriteUnavailable?: boolean;
  selfVisible?: boolean;
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
}

export interface FolderDetailSummary {
  total: number;
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
  schemaVersion: 11,
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

export class StateManager {
  private state: StateFile;
  private readonly statePath: string;
  private readonly writeState: (filePath: string, value: StateFile) => void;
  private batchDepth = 0;
  private dirty = false;

  constructor(options: { statePath?: string; writeState?: (filePath: string, value: StateFile) => void } = {}) {
    this.statePath = options.statePath || defaultStatePath;
    this.writeState = options.writeState || writeJsonFile;
    this.state = this.loadState();
    this.migrateLegacyState();
  }

  private loadState() {
    this.state = readJsonFile<StateFile>(this.statePath, defaultState);
    this.state.processedByUser ||= {};
    this.state.failedByUser ||= {};
    this.state.videos ||= {};
    this.state.relations ||= {};
    this.state.folderScans ||= {};
    this.state.userCooldowns ||= {};
    return this.state;
  }

  reload() {
    this.state = this.loadState();
    this.migrateLegacyState();
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
    return structuredClone(this.state);
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
    if (["missing", "failed", "upload_failed"].includes(entry.backupStatus)) return entry.backupStatus;
    return "discovered";
  }

  private refreshVideoAggregateStatus(bvid: string) {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const relations = Object.values(this.state.relations || {}).filter((relation) => relation.bvid === bvid);
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
    for (const relation of Object.values(this.state.relations || {})) {
      if (relation.userId !== userId || relation.mediaId !== mediaId || !relation.activeInFavorite || seenBvids.has(relation.bvid)) {
        continue;
      }
      relation.activeInFavorite = false;
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
      relation.lastError = undefined;
      this.clearFailedEntry(relation.userId, relation.mediaId, relation.bvid);
      this.refreshVideoAggregateStatus(entry.bvid);
      if (entry.backupStatus === "verified" || entry.backupStatus === "partial_verified") {
        entry.verifiedAt = at;
        entry.lastError = undefined;
      } else {
        entry.verifiedAt = undefined;
        entry.lastError = Object.values(this.state.relations || {})
          .find((item) => item.bvid === entry.bvid && Boolean(item.lastError))
          ?.lastError;
      }
    } else {
      this.setVideoStatus(entry, partial ? "partial_verified" : "verified", at);
      entry.verifiedAt = at;
      entry.lastError = undefined;
    }
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

  markUploadFailed(bvid: string, localDir: string, userId?: string, mediaId?: number, reason = "Upload failure") {
    const entry = this.state.videos?.[bvid];
    if (!entry) return;
    const at = nowIso();
    if (localDir) {
      entry.localDir = localDir;
    }
    entry.lastError = reason;
    const relation = this.getRelation(userId, mediaId, bvid);
    if (relation) {
      this.setRelationStatus(relation, "upload_failed", at);
      relation.lastError = reason;
      relation.nextRemoteCheckAt = undefined;
      this.state.failedByUser ||= {};
      this.state.failedByUser[relation.userId] ||= {};
      this.state.failedByUser[relation.userId][failedKey(relation.mediaId, bvid)] = {
        bvid,
        mediaId: relation.mediaId,
        failedAt: at,
        reason,
        permanent: false,
      };
      this.refreshVideoAggregateStatus(bvid);
    } else {
      this.setVideoStatus(entry, "upload_failed", at);
    }
    this.save();
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
  }

  private clearFailedEntry(userId: string, mediaId: number, bvid: string) {
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
    if (this.clearFailedEntry(userId, mediaId, bvid)) {
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

  setDownloadApiCooldown(value: PersistedDownloadApiCooldown) {
    this.state.downloadApiCooldown = { ...value };
    this.save();
  }

  getDownloadApiCooldown() {
    return this.state.downloadApiCooldown ? { ...this.state.downloadApiCooldown } : null;
  }

  clearDownloadApiCooldown() {
    if (!this.state.downloadApiCooldown) return;
    this.state.downloadApiCooldown = undefined;
    this.save();
  }

  normalizePersistedWorkForRecovery() {
    let changed = false;
    const resumableStatuses = new Set<BackupStatus>(["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing", "failed"]);
    const at = nowIso();
    const relationsByBvid = new Map<string, FavoriteRelation[]>();
    for (const relation of Object.values(this.state.relations || {})) {
      const list = relationsByBvid.get(relation.bvid) || [];
      list.push(relation);
      relationsByBvid.set(relation.bvid, list);
    }

    this.runBatch(() => {
      for (const entry of Object.values(this.state.videos || {})) {
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
              changed = true;
            }
          }
          if (resumableStatuses.has(entry.backupStatus) && entry.backupStatus !== entryTarget) {
            this.setVideoStatus(entry, entryTarget, at);
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
              changed = true;
            }
          }
          continue;
        }

        if (entry.localDir) {
          entry.localDir = undefined;
          entry.downloadSession = undefined;
          changed = true;
        }
        if (resumableStatuses.has(entry.backupStatus)) {
          const target = entry.favoriteUnavailable && !entry.selfVisible ? "lost" : "queued";
          if (entry.backupStatus !== target) {
            this.setVideoStatus(entry, target, at);
            changed = true;
          }
        }
        for (const relation of relations) {
          const current = relation.backupStatus || entry.backupStatus;
          if (!resumableStatuses.has(current)) continue;
          const target = relationTreatsUnavailable(relation, entry) ? "lost" : "queued";
          if (relation.backupStatus !== target) {
            this.setRelationStatus(relation, target, at);
            changed = true;
          }
        }
      }
      if (changed) this.save();
    });

    return changed;
  }

  listBackupsToResume() {
    const relationWork = Object.values(this.state.relations || {})
      .map((relation) => ({ relation: { ...relation }, video: this.state.videos?.[relation.bvid] }))
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
    return Object.values(this.state.videos || {})
      .filter((entry) => ["queued", "downloading", "downloaded", "uploading", "upload_failed", "missing"].includes(entry.backupStatus))
      .map((video) => ({ video: { ...video }, relation: this.findRelationForBvid(video.bvid) }));
  }

  listStaleActiveBackups(maxAgeMs: number) {
    const relationItems = Object.values(this.state.relations || {})
      .filter((relation) => this.isStaleActiveStatus(relation.backupStatus, relation.statusUpdatedAt, maxAgeMs))
      .flatMap((relation) => {
        const video = this.state.videos?.[relation.bvid];
        return video ? [{ relation: { ...relation }, video }] : [];
      });
    const relationKeys = new Set(relationItems.map((item) => relationKey(item.relation.userId, item.relation.mediaId, item.relation.bvid)));
    const videoItems = Object.values(this.state.videos || {})
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

  getRemoteFilePreviewRecords() {
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
    return Object.values(this.state.relations || {})
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
    const entry = this.state.videos?.[bvid];
    if (!entry) return false;
    const at = nowIso();
    const oldName = path.posix.basename(oldPath);
    const newName = path.posix.basename(newPath);
    const oldDir = path.posix.dirname(oldPath);
    const newDir = path.posix.dirname(newPath);
    const updateFiles = (files?: RemoteFileRecord[]) => {
      if (!Array.isArray(files)) return false;
      let changed = false;
      for (const file of files) {
        if (file.path === oldPath) {
          file.path = newPath;
          file.name = newName;
          changed = true;
        } else if (file.name === oldName && path.posix.dirname(file.path) === oldDir) {
          file.path = newPath;
          file.name = newName;
          changed = true;
        }
      }
      return changed;
    };
    let changed = updateFiles(entry.remoteFiles);
    if (!changed) {
      entry.remoteFiles ||= [];
      if (!entry.remoteFiles.some((file) => file.path === newPath)) {
        entry.remoteFiles.push({ name: newName, path: newPath });
        changed = true;
      }
    }
    this.setVideoStatus(entry, "verified", at);
    entry.remotePath = newDir;
    entry.verifiedAt = at;
    entry.lastRemoteCheckAt = at;
    entry.nextRemoteCheckAt = undefined;
    entry.remoteMissingCount = 0;
    entry.lastError = undefined;
    for (const relation of Object.values(this.state.relations || {}).filter((item) => item.bvid === bvid)) {
      const relationChanged = updateFiles(relation.remoteFiles);
      const relationDir = relation.remotePath || path.posix.dirname(relation.remoteFiles?.[0]?.path || "");
      if (!relationChanged && (!relationDir || relationDir === oldDir || relationDir === newDir)) {
        relation.remoteFiles ||= [];
        if (!relation.remoteFiles.some((file) => file.path === newPath)) {
          relation.remoteFiles.push({ name: newName, path: newPath });
        }
      }
      if (relationChanged || relationDir === oldDir || relationDir === newDir || !relationDir) {
        this.setRelationStatus(relation, "verified", at);
        relation.remotePath = newDir;
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
      const unavailable = relationTreatsUnavailable(relation, video);
      const processed = this.isProcessed(userId, video.bvid, mediaId);
      const item: FolderDetailItem = {
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
        unavailable,
        processed,
        failed: this.isFailed(userId, video.bvid, mediaId),
        backupStatus: relation.backupStatus || video.backupStatus,
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

  getFolderIndexSummary(userId: string, mediaId: number, biliTotal?: number): FolderIndexSummary {
    const rows = Object.values(this.state.relations || {})
      .filter((relation) => relation.userId === userId && relation.mediaId === mediaId)
      .map((relation) => ({ relation, video: this.state.videos?.[relation.bvid] }))
      .filter((item): item is { relation: FavoriteRelation; video: VideoArchiveEntry } => Boolean(item.video));
    const scan = this.state.folderScans?.[folderKey(userId, mediaId)];
    const effectiveBiliTotal = typeof biliTotal === "number" ? biliTotal : scan?.total;
    const scanComplete = scan?.initStatus === "complete";
    const unreturnedCount = scanComplete && typeof effectiveBiliTotal === "number" ? Math.max(0, effectiveBiliTotal - rows.length) : 0;
    const summary: FolderIndexSummary = {
      total: rows.length,
      indexed: rows.length,
      biliTotal: effectiveBiliTotal,
      complete: scanComplete || (typeof effectiveBiliTotal === "number" ? rows.length >= effectiveBiliTotal : false),
      scanStatus: scan?.initStatus || "pending",
      scanComplete,
      scannedTotal: rows.length,
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

    if (Object.keys(this.state.processedByUser || {}).length > 0) {
      this.state.processedByUser = {};
      changed = true;
    }

    if (changed) {
      this.save();
    }
  }

  clear() {
    this.state = {
      schemaVersion: defaultState.schemaVersion,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
      downloadApiCooldown: undefined,
    };
  }

  private save() {
    this.dirty = true;
    if (this.batchDepth === 0) {
      this.flush();
    }
  }

  private flush() {
    if (!this.dirty) return;
    this.writeState(this.statePath, this.state);
    this.dirty = false;
  }
}
