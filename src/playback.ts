import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type express from "express";
import type { AppConfig } from "./config.js";
import type { StateDatabase } from "./database.js";
import type { FavoriteRelation, RemoteFileRecord, VideoArchiveEntry } from "./state.js";
import { actualQualityLabel, normalizeActualCodec, normalizeBilibiliQualityLabel } from "./media-metadata.js";
import { buildDavClient } from "./uploader.js";
import { isRemotePathWithin, normalizeStoredRemoteFilePath } from "./remote-path.js";
import { parseStorageBaseUrl } from "./storage-url.js";
import {
  createRemoteFileResolver,
  isLikelyEncodedFilename,
  RemoteFileResolutionConflictError,
  remoteLookupBasename,
} from "./remote-file-resolver.js";

export type PlaybackUnavailableReason = "not_verified" | "awaiting_verification" | "no_playable_media";

export interface PlaybackAvailability {
  available: boolean;
  partCount: number;
  partial: boolean;
  reason?: PlaybackUnavailableReason;
}

export interface PlaybackPart {
  fileId: number;
  pageIndex: number;
  cid?: number;
  label: string;
  size?: number;
  requestedQuality?: string;
  requestedCodec?: string;
  bilibiliQuality?: string;
  actualQuality?: string;
  actualWidth?: number;
  actualHeight?: number;
  actualFps?: number;
  mediaMetadataSource?: "ffprobe" | "browser";
  quality?: string;
  codec?: string;
  fingerprint: string;
  streamUrl: string;
}

export interface PlaybackQueueItem {
  bvid: string;
  queuePosition: number;
  title: string;
  upperName: string;
  cover?: string;
  coverLocalPath?: string;
  favoriteOrder?: number;
  partial: boolean;
  activeInFavorite: boolean;
  source: {
    userId: string;
    mediaId: number;
    folderTitle: string;
  };
  parts: PlaybackPart[];
}

export interface PlaybackQueuePage {
  mode: "favorite" | "single" | "library";
  page: number;
  pageSize: number;
  total: number;
  focusIndex: number;
  hasPrevious?: boolean;
  hasMore: boolean;
  previousCursor?: string | null;
  nextCursor?: string | null;
  items: PlaybackQueueItem[];
}

export interface PlaybackSearchPage {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  items: PlaybackQueueItem[];
}

interface PlaybackFileRow {
  id: number;
  bvid: string;
  name: string;
  remotePath: string;
  expectedSize?: number;
  qualityProfile?: Record<string, unknown>;
  actualWidth?: number;
  actualHeight?: number;
  actualFps?: number;
  actualDuration?: number;
  actualCodec?: string;
  actualMetadataSource?: "ffprobe" | "browser";
  updatedAt: number;
}

export type PlaybackDeliveryStatus = "pending" | "direct" | "proxy" | "failed";

interface PlaybackDeliveryRecord {
  ownerHash: string;
  userId: string;
  mediaId: number;
  fileId: number;
  attemptId: string;
  status: PlaybackDeliveryStatus;
  updatedAt: number;
}

const playbackDeliveryTtlMs = 5 * 60 * 1000;
const playbackDeliveryMaxEntries = 1_000;
const playbackDeliveries = new Map<string, PlaybackDeliveryRecord>();

function playbackOwnerHash(ownerKey: string) {
  return crypto.createHash("sha256").update(ownerKey).digest("hex");
}

function playbackDeliveryKey(ownerKey: string, userId: string, mediaId: number, attemptId: string) {
  return `${playbackOwnerHash(ownerKey)}:${userId}:${mediaId}:${attemptId}`;
}

function prunePlaybackDeliveries(now = Date.now()) {
  for (const [key, record] of playbackDeliveries) {
    if (now - record.updatedAt >= playbackDeliveryTtlMs) playbackDeliveries.delete(key);
  }
  if (playbackDeliveries.size <= playbackDeliveryMaxEntries) return;
  const oldest = [...playbackDeliveries.entries()]
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    .slice(0, playbackDeliveries.size - playbackDeliveryMaxEntries);
  for (const [key] of oldest) playbackDeliveries.delete(key);
}

const playbackDeliveryCleanupTimer = setInterval(prunePlaybackDeliveries, 60_000);
playbackDeliveryCleanupTimer.unref?.();

function markPlaybackDelivery(
  input: { ownerKey: string; userId: string; mediaId: number; fileId: number; attemptId?: string },
  status: PlaybackDeliveryStatus
) {
  if (!input.attemptId) return;
  const key = playbackDeliveryKey(input.ownerKey, input.userId, input.mediaId, input.attemptId);
  const previous = playbackDeliveries.get(key);
  if (previous && previous.fileId !== input.fileId) return;
  if (previous?.status === "proxy" && status !== "proxy") return;
  if (previous?.status === "direct" && status !== "proxy") return;
  playbackDeliveries.set(key, {
    ownerHash: playbackOwnerHash(input.ownerKey),
    userId: input.userId,
    mediaId: input.mediaId,
    fileId: input.fileId,
    attemptId: input.attemptId,
    status,
    updatedAt: Date.now(),
  });
  prunePlaybackDeliveries();
}

export function getPlaybackDeliveryStatus(
  ownerKey: string,
  userId: string,
  mediaId: number,
  attemptId: string
) {
  prunePlaybackDeliveries();
  const record = playbackDeliveries.get(playbackDeliveryKey(ownerKey, userId, mediaId, attemptId));
  return record ? { status: record.status, updatedAt: record.updatedAt } : { status: "pending" as const, updatedAt: Date.now() };
}

export function closePlaybackDeliveryTracker() {
  clearInterval(playbackDeliveryCleanupTimer);
  playbackDeliveries.clear();
}

const playableStatuses = new Set(["verified", "partial_verified"]);
const playableExtensions = new Set([".mp4", ".m4v", ".webm"]);
const naturalName = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const queueOrderSql = `
  CASE WHEN r.fav_order IS NULL THEN 1 ELSE 0 END,
  r.fav_order ASC,
  r.last_seen_at DESC,
  r.bvid ASC
`;
const playableRelationSql = `
  r.user_id=? AND r.media_id=?
  AND r.active_in_favorite=1
  AND r.backup_status IN ('verified','partial_verified')
  AND EXISTS (
    SELECT 1 FROM remote_files rf
    WHERE rf.user_id=r.user_id AND rf.media_id=r.media_id AND rf.bvid=r.bvid
      AND rf.status='verified'
      AND (
        lower(rf.name) LIKE '%.mp4'
        OR lower(rf.name) LIKE '%.m4v'
        OR lower(rf.name) LIKE '%.webm'
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM archive_deleted_sources ads
    WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
      AND ads.status IN ('preparing','pending','running','retry_wait','failed','completed')
  )
`;

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

function isVerifiedRemoteFile(file: RemoteFileRecord) {
  return !file.verificationStatus || file.verificationStatus === "verified";
}

export function isPlayableRemoteFile(file: RemoteFileRecord) {
  return isVerifiedRemoteFile(file) && playableExtensions.has(path.posix.extname(String(file.name || file.path || "")).toLowerCase());
}

export function playbackAvailability(
  backupStatus: string | undefined,
  remoteFiles: RemoteFileRecord[] | undefined
): PlaybackAvailability {
  const partial = backupStatus === "partial_verified";
  const partCount = playableStatuses.has(String(backupStatus || ""))
    ? (remoteFiles || []).filter(isPlayableRemoteFile).length
    : 0;
  if (partCount > 0) return { available: true, partCount, partial };
  if (backupStatus === "uploaded") {
    return { available: false, partCount: 0, partial: false, reason: "awaiting_verification" };
  }
  if (playableStatuses.has(String(backupStatus || ""))) {
    return { available: false, partCount: 0, partial, reason: "no_playable_media" };
  }
  return { available: false, partCount: 0, partial: false, reason: "not_verified" };
}

function displayTitle(video: VideoArchiveEntry) {
  return String(video.originalMeta?.title || video.title || video.bvid);
}

function displayUpperName(video: VideoArchiveEntry) {
  return String(video.originalMeta?.upperName || video.upperName || "Unknown");
}

function displayCover(video: VideoArchiveEntry) {
  return video.originalMeta?.cover || video.cover;
}

function displayCoverLocalPath(video: VideoArchiveEntry) {
  return video.originalMeta?.coverLocalPath;
}

function fallbackPageIndex(file: RemoteFileRecord, position: number) {
  const metadataIndex = Number(file.filenameMetadata?.pageIndex || 0);
  if (Number.isInteger(metadataIndex) && metadataIndex > 0) return metadataIndex;
  const suffix = /(?:^|[_\s-])P(\d+)(?=\D|$)/i.exec(String(file.name || file.path || ""));
  return suffix ? Math.max(1, Number(suffix[1])) : position + 1;
}

function rowsForBvid(database: StateDatabase, userId: string, mediaId: number, bvids: string[]) {
  if (bvids.length === 0) return new Map<string, PlaybackFileRow[]>();
  const placeholders = bvids.map(() => "?").join(",");
  const rows = database.db.prepare(`
    SELECT id, bvid, name, remote_path, expected_size, quality_json,
      actual_width, actual_height, actual_fps, actual_duration, actual_codec,
      actual_metadata_source, updated_at
    FROM remote_files
    WHERE user_id=? AND media_id=? AND status='verified' AND bvid IN (${placeholders})
      AND (
        lower(name) LIKE '%.mp4'
        OR lower(name) LIKE '%.m4v'
        OR lower(name) LIKE '%.webm'
      )
    ORDER BY bvid ASC, id ASC
  `).all(userId, mediaId, ...bvids) as any[];
  const result = new Map<string, PlaybackFileRow[]>();
  for (const row of rows) {
    const bvid = String(row.bvid);
    const group = result.get(bvid) || [];
    group.push({
      id: Number(row.id),
      bvid,
      name: String(row.name || ""),
      remotePath: String(row.remote_path || ""),
      expectedSize: row.expected_size == null ? undefined : Number(row.expected_size),
      qualityProfile: parseJson(row.quality_json, undefined as any),
      actualWidth: row.actual_width == null ? undefined : Number(row.actual_width),
      actualHeight: row.actual_height == null ? undefined : Number(row.actual_height),
      actualFps: row.actual_fps == null ? undefined : Number(row.actual_fps),
      actualDuration: row.actual_duration == null ? undefined : Number(row.actual_duration),
      actualCodec: row.actual_codec || undefined,
      actualMetadataSource: row.actual_metadata_source === "ffprobe" || row.actual_metadata_source === "browser"
        ? row.actual_metadata_source
        : undefined,
      updatedAt: Number(row.updated_at || 0),
    });
    result.set(bvid, group);
  }
  return result;
}

export interface PlaybackQueueSource {
  relation: FavoriteRelation;
  video: VideoArchiveEntry;
  queuePosition: number;
}

function playbackSourceKey(userId: string, mediaId: number, bvid: string) {
  return `${userId}:${mediaId}:${bvid}`;
}

function rowsForSources(database: StateDatabase, sources: PlaybackQueueSource[]) {
  const unique = new Map<string, PlaybackQueueSource>();
  for (const source of sources) {
    unique.set(playbackSourceKey(source.relation.userId, source.relation.mediaId, source.relation.bvid), source);
  }
  if (unique.size === 0) return new Map<string, PlaybackFileRow[]>();
  const values = [...unique.values()].map(() => "(?,?,?)").join(",");
  const params = [...unique.values()].flatMap((source) => [
    source.relation.userId,
    source.relation.mediaId,
    source.relation.bvid,
  ]);
  const rows = database.db.prepare(`
    WITH requested(user_id, media_id, bvid) AS (VALUES ${values})
    SELECT rf.id, rf.bvid, rf.user_id, rf.media_id, rf.name, rf.remote_path, rf.expected_size, rf.quality_json,
      rf.actual_width, rf.actual_height, rf.actual_fps, rf.actual_duration, rf.actual_codec,
      rf.actual_metadata_source, rf.updated_at
    FROM requested q
    JOIN remote_files rf ON rf.user_id=q.user_id AND rf.media_id=q.media_id AND rf.bvid=q.bvid
    WHERE rf.status='verified' AND (
      lower(rf.name) LIKE '%.mp4'
      OR lower(rf.name) LIKE '%.m4v'
      OR lower(rf.name) LIKE '%.webm'
    )
    AND NOT EXISTS (
      SELECT 1 FROM archive_deleted_sources ads
      WHERE ads.user_id=rf.user_id AND ads.media_id=rf.media_id AND ads.bvid=rf.bvid
        AND ads.status IN ('preparing','pending','running','retry_wait','failed','completed')
    )
    ORDER BY rf.user_id, rf.media_id, rf.bvid, rf.id
  `).all(...params) as any[];
  const result = new Map<string, PlaybackFileRow[]>();
  for (const row of rows) {
    const key = playbackSourceKey(String(row.user_id), Number(row.media_id), String(row.bvid));
    const group = result.get(key) || [];
    group.push({
      id: Number(row.id),
      bvid: String(row.bvid),
      name: String(row.name || ""),
      remotePath: String(row.remote_path || ""),
      expectedSize: row.expected_size == null ? undefined : Number(row.expected_size),
      qualityProfile: parseJson(row.quality_json, undefined as any),
      actualWidth: row.actual_width == null ? undefined : Number(row.actual_width),
      actualHeight: row.actual_height == null ? undefined : Number(row.actual_height),
      actualFps: row.actual_fps == null ? undefined : Number(row.actual_fps),
      actualDuration: row.actual_duration == null ? undefined : Number(row.actual_duration),
      actualCodec: row.actual_codec || undefined,
      actualMetadataSource: row.actual_metadata_source === "ffprobe" || row.actual_metadata_source === "browser"
        ? row.actual_metadata_source
        : undefined,
      updatedAt: Number(row.updated_at || 0),
    });
    result.set(key, group);
  }
  return result;
}

export function buildQueueItem(
  relation: FavoriteRelation,
  video: VideoArchiveEntry,
  rows: PlaybackFileRow[],
  queuePosition: number
): PlaybackQueueItem | null {
  const recordedByPath = new Map(
    (relation.remoteFiles || [])
      .filter(isPlayableRemoteFile)
      .map((file) => [String(file.path || ""), file] as const)
  );
  const paired = rows
    .map((row) => ({ row, file: recordedByPath.get(row.remotePath) }))
    .filter((item): item is { row: PlaybackFileRow; file: RemoteFileRecord } => Boolean(item.file))
    .map((item, index) => ({ ...item, pageIndex: fallbackPageIndex(item.file, index) }))
    .sort((left, right) => left.pageIndex - right.pageIndex
      || naturalName.compare(left.row.name, right.row.name)
      || left.row.id - right.row.id);
  if (paired.length === 0) return null;

  const duplicates = new Map<number, number>();
  const seen = new Map<number, number>();
  for (const item of paired) duplicates.set(item.pageIndex, (duplicates.get(item.pageIndex) || 0) + 1);
  const parts = paired.map(({ row, file, pageIndex }) => {
    const duplicateIndex = (seen.get(pageIndex) || 0) + 1;
    seen.set(pageIndex, duplicateIndex);
    const duplicateSuffix = (duplicates.get(pageIndex) || 0) > 1 ? ` · ${duplicateIndex}` : "";
    const qualityProfile = (file.qualityProfile || row.qualityProfile || {}) as Record<string, unknown>;
    const actualQuality = row.actualWidth && row.actualHeight
      ? actualQualityLabel({ width: row.actualWidth, height: row.actualHeight, fps: row.actualFps })
      : undefined;
    const actualCodec = normalizeActualCodec(row.actualCodec);
    return {
      fileId: row.id,
      pageIndex,
      cid: Number.isInteger(Number(file.filenameMetadata?.cid)) ? Number(file.filenameMetadata?.cid) : undefined,
      label: `${paired.length === 1 && !file.filenameMetadata?.pageIndex ? "正片" : `P${pageIndex}`}${duplicateSuffix}`,
      size: row.expectedSize,
      requestedQuality: String(qualityProfile.quality || "") || undefined,
      requestedCodec: String(qualityProfile.encoding || "") || undefined,
      bilibiliQuality: normalizeBilibiliQualityLabel(file.filenameMetadata?.bilibiliQuality),
      actualQuality,
      actualWidth: row.actualWidth,
      actualHeight: row.actualHeight,
      actualFps: row.actualFps,
      mediaMetadataSource: row.actualMetadataSource,
      quality: actualQuality,
      codec: actualCodec,
      fingerprint: `${row.id}:${row.expectedSize || 0}:${row.updatedAt}`,
      streamUrl: `/api/users/${encodeURIComponent(relation.userId)}/favorites/${relation.mediaId}/playback/files/${row.id}`,
    } satisfies PlaybackPart;
  });

  return {
    bvid: video.bvid,
    queuePosition,
    title: displayTitle(video),
    upperName: displayUpperName(video),
    cover: displayCover(video),
    coverLocalPath: displayCoverLocalPath(video),
    favoriteOrder: Number.isInteger(relation.favOrder) ? Number(relation.favOrder) : undefined,
    partial: relation.backupStatus === "partial_verified",
    activeInFavorite: relation.activeInFavorite,
    source: {
      userId: relation.userId,
      mediaId: relation.mediaId,
      folderTitle: relation.folderTitle,
    },
    parts,
  };
}

export function buildPlaybackQueueItems(database: StateDatabase, sources: PlaybackQueueSource[]) {
  const fileRows = rowsForSources(database, sources);
  return sources
    .map((source) => buildQueueItem(
      source.relation,
      source.video,
      fileRows.get(playbackSourceKey(
        source.relation.userId,
        source.relation.mediaId,
        source.relation.bvid
      )) || [],
      source.queuePosition
    ))
    .filter((item): item is PlaybackQueueItem => Boolean(item));
}

function exactRelation(database: StateDatabase, userId: string, mediaId: number, bvid: string) {
  const row = database.db.prepare(`
    SELECT r.payload_json AS relation_json, v.payload_json AS video_json
    FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
    WHERE r.user_id=? AND r.media_id=? AND r.bvid=?
      AND NOT EXISTS (
        SELECT 1 FROM archive_deleted_sources ads
        WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
          AND ads.status IN ('preparing','pending','running','retry_wait','failed','completed')
      )
  `).get(userId, mediaId, bvid) as any;
  if (!row) return null;
  return {
    relation: parseJson<FavoriteRelation>(row.relation_json, undefined as any),
    video: parseJson<VideoArchiveEntry>(row.video_json, undefined as any),
  };
}

export function getPlaybackQueue(
  database: StateDatabase,
  userId: string,
  mediaId: number,
  options: { focusBvid?: string; page?: number; pageSize?: number }
): PlaybackQueuePage | null {
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize || 30)));
  const focusBvid = String(options.focusBvid || "").trim();
  const focus = focusBvid ? exactRelation(database, userId, mediaId, focusBvid) : null;
  if (focusBvid && (!focus?.relation || !focus.video)) return null;

  if (focus && !focus.relation.activeInFavorite) {
    if (!playableStatuses.has(String(focus.relation.backupStatus || ""))) return null;
    const rows = rowsForBvid(database, userId, mediaId, [focusBvid]);
    const item = buildQueueItem(focus.relation, focus.video, rows.get(focusBvid) || [], 1);
    if (!item) return null;
    return { mode: "single", page: 1, pageSize: 1, total: 1, focusIndex: 0, hasMore: false, items: [item] };
  }

  const total = Number((database.db.prepare(`
    SELECT COUNT(*) AS count FROM favorite_relations r WHERE ${playableRelationSql}
  `).get(userId, mediaId) as any)?.count || 0);
  if (total === 0) return focusBvid ? null : { mode: "favorite", page: 1, pageSize, total: 0, focusIndex: -1, hasMore: false, items: [] };

  let focusIndex = -1;
  if (focusBvid) {
    const position = database.db.prepare(`
      WITH playable AS (
        SELECT r.bvid, ROW_NUMBER() OVER (ORDER BY ${queueOrderSql}) - 1 AS position
        FROM favorite_relations r WHERE ${playableRelationSql}
      )
      SELECT position FROM playable WHERE bvid=?
    `).get(userId, mediaId, focusBvid) as any;
    if (!position) return null;
    focusIndex = Number(position.position);
  }
  const requestedPage = options.page ? Math.max(1, Math.floor(options.page)) : 0;
  const page = requestedPage || (focusIndex >= 0 ? Math.floor(focusIndex / pageSize) + 1 : 1);
  const offset = (page - 1) * pageSize;
  const rows = database.db.prepare(`
    SELECT r.payload_json AS relation_json, v.payload_json AS video_json
    FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
    WHERE ${playableRelationSql}
    ORDER BY ${queueOrderSql}
    LIMIT ? OFFSET ?
  `).all(userId, mediaId, pageSize, offset) as any[];
  const records = rows.map((row) => ({
    relation: parseJson<FavoriteRelation>(row.relation_json, undefined as any),
    video: parseJson<VideoArchiveEntry>(row.video_json, undefined as any),
  })).filter((item) => item.relation && item.video);
  const fileRows = rowsForBvid(database, userId, mediaId, records.map((item) => item.relation.bvid));
  const items = records
    .map(({ relation, video }, index) => buildQueueItem(
      relation,
      video,
      fileRows.get(relation.bvid) || [],
      offset + index + 1
    ))
    .filter((item): item is PlaybackQueueItem => Boolean(item));
  return {
    mode: "favorite",
    page,
    pageSize,
    total,
    focusIndex,
    hasMore: offset + pageSize < total,
    items,
  };
}

function escapeSqlLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function getPlaybackSearch(
  database: StateDatabase,
  userId: string,
  mediaId: number,
  options: { query: string; page?: number; pageSize?: number }
): PlaybackSearchPage {
  const query = String(options.query || "").trim();
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize || 50)));
  const page = Math.max(1, Math.floor(options.page || 1));
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return { query, page, pageSize, total: 0, hasMore: false, items: [] };
  }

  const termClause = `(
    lower(COALESCE(p.bvid, '')) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(json_extract(p.video_json, '$.title'), '')) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(json_extract(p.video_json, '$.originalMeta.title'), '')) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(json_extract(p.video_json, '$.upperName'), '')) LIKE ? ESCAPE '\\'
    OR lower(COALESCE(json_extract(p.video_json, '$.originalMeta.upperName'), '')) LIKE ? ESCAPE '\\'
  )`;
  const matchSql = terms.map(() => termClause).join(" AND ");
  const matchParams = terms.flatMap((term) => {
    const pattern = `%${escapeSqlLike(term.toLowerCase())}%`;
    return [pattern, pattern, pattern, pattern, pattern];
  });
  const cteSql = `
    WITH playable AS (
      SELECT r.payload_json AS relation_json, v.payload_json AS video_json, r.bvid,
        ROW_NUMBER() OVER (ORDER BY ${queueOrderSql}) AS queue_position
      FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
      WHERE ${playableRelationSql}
    ), matched AS (
      SELECT * FROM playable p WHERE ${matchSql}
    )
  `;
  const total = Number((database.db.prepare(`${cteSql} SELECT COUNT(*) AS count FROM matched`)
    .get(userId, mediaId, ...matchParams) as any)?.count || 0);
  const offset = (page - 1) * pageSize;
  const rows = database.db.prepare(`
    ${cteSql}
    SELECT relation_json, video_json, bvid, queue_position
    FROM matched
    ORDER BY queue_position ASC
    LIMIT ? OFFSET ?
  `).all(userId, mediaId, ...matchParams, pageSize, offset) as any[];
  const records = rows.map((row) => ({
    relation: parseJson<FavoriteRelation>(row.relation_json, undefined as any),
    video: parseJson<VideoArchiveEntry>(row.video_json, undefined as any),
    queuePosition: Number(row.queue_position),
  })).filter((item) => item.relation && item.video && Number.isInteger(item.queuePosition));
  const fileRows = rowsForBvid(database, userId, mediaId, records.map((item) => item.relation.bvid));
  const items = records
    .map(({ relation, video, queuePosition }) => buildQueueItem(
      relation,
      video,
      fileRows.get(relation.bvid) || [],
      queuePosition
    ))
    .filter((item): item is PlaybackQueueItem => Boolean(item));
  return {
    query,
    page,
    pageSize,
    total,
    hasMore: offset + pageSize < total,
    items,
  };
}

function normalizeStoredPath(value: unknown) {
  return normalizeStoredRemoteFilePath(value);
}

function isWithinRoot(filePath: string, rootValue: unknown) {
  const root = String(rootValue || "");
  return !root || isRemotePathWithin(root, filePath, false);
}

function encodeDavPath(remotePath: string) {
  return remotePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function mimeTypeForName(name: string) {
  switch (path.posix.extname(name).toLowerCase()) {
    case ".webm": return "video/webm";
    case ".m4v": return "video/x-m4v";
    default: return "video/mp4";
  }
}

export class PlaybackHttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function resolvePlaybackFile(database: StateDatabase, userId: string, mediaId: number, fileId: number) {
  const row = database.db.prepare(`
    SELECT rf.id, rf.bvid, rf.name, rf.remote_path, rf.expected_size, r.payload_json AS relation_json
    FROM remote_files rf JOIN favorite_relations r
      ON r.user_id=rf.user_id AND r.media_id=rf.media_id AND r.bvid=rf.bvid
    WHERE rf.id=? AND rf.user_id=? AND rf.media_id=? AND rf.status='verified'
      AND r.backup_status IN ('verified','partial_verified')
      AND NOT EXISTS(
        SELECT 1 FROM archive_deleted_sources ads
        WHERE ads.user_id=rf.user_id AND ads.media_id=rf.media_id AND ads.bvid=rf.bvid
          AND ads.status IN ('preparing','pending','running','retry_wait','failed','completed')
      )
  `).get(fileId, userId, mediaId) as any;
  if (!row) throw new PlaybackHttpError(404, "PLAYBACK_FILE_NOT_FOUND", "播放文件不存在或尚未完成远端确认");
  const relation = parseJson<FavoriteRelation>(row.relation_json, undefined as any);
  const remotePath = normalizeStoredPath(row.remote_path);
  const exactFile = relation?.remoteFiles?.find((file) => String(file.path || "") === remotePath && isPlayableRemoteFile(file));
  if (!remotePath || !exactFile || !isWithinRoot(remotePath, relation.remotePath)) {
    throw new PlaybackHttpError(404, "PLAYBACK_FILE_NOT_FOUND", "播放文件记录已变化，请重新打开播放器");
  }
  return {
    id: Number(row.id),
    bvid: String(row.bvid),
    name: String(row.name || path.posix.basename(remotePath)),
    remotePath,
    size: row.expected_size == null ? undefined : Number(row.expected_size),
  };
}

export function playbackFileAlistLocation(
  database: StateDatabase,
  config: AppConfig,
  userId: string,
  mediaId: number,
  fileId: number
) {
  const file = resolvePlaybackFile(database, userId, mediaId, fileId);
  if (!config.alistBrowserUrl) {
    throw new PlaybackHttpError(404, "PLAYBACK_ALIST_BROWSER_NOT_CONFIGURED", "尚未配置远端存储网页访问地址");
  }
  let base: URL;
  try {
    base = new URL(config.alistBrowserUrl);
  } catch {
    throw new PlaybackHttpError(502, "PLAYBACK_ALIST_BROWSER_CONFIG", "远端存储网页访问地址无效");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || base.toString().length > 4_096) {
    throw new PlaybackHttpError(502, "PLAYBACK_ALIST_BROWSER_CONFIG", "远端存储网页访问地址无效");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${encodeDavPath(file.remotePath)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function copyPlaybackHeaders(upstream: Response, res: express.Response, fallbackType: string) {
  const allowed = ["accept-ranges", "content-length", "content-range", "etag", "last-modified"];
  for (const name of allowed) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader("Content-Type", fallbackType);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
  res.setHeader("Vary", "Range");
}

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && (octets[2] === 0 || octets[2] === 2))
    || (first === 192 && second === 88 && octets[2] === 99)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 224;
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

function isPrivatePlaybackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

export function safePlaybackRedirectLocation(location: string | null, alistBase: URL) {
  if (!location || location.length > 8_192 || !/^https:\/\//i.test(location)) return null;
  try {
    const target = new URL(location);
    if (target.protocol !== "https:" || target.username || target.password || target.hostname === alistBase.hostname) return null;
    if (target.port && target.port !== "443") return null;
    if (isPrivatePlaybackHost(target.hostname)) return null;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}

type PlaybackLookup = typeof dns.promises.lookup;
type PlaybackFetch = typeof fetch;

export interface PlaybackTransportOptions {
  lookup?: PlaybackLookup;
  fetch?: PlaybackFetch;
  resolveRemotePath?: (remotePath: string) => Promise<string | undefined>;
}

async function validatedExternalPlaybackLocation(
  value: string,
  alistBase: URL,
  lookup: PlaybackLookup
) {
  const normalized = safePlaybackRedirectLocation(value, alistBase);
  if (!normalized) return null;
  const target = new URL(normalized);
  if (net.isIP(target.hostname)) return normalized;
  let addresses: dns.LookupAddress[];
  try {
    addresses = await lookup(target.hostname, { all: true, verbatim: true }) as dns.LookupAddress[];
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivatePlaybackHost(entry.address))) return null;
  return normalized;
}

const PLAYBACK_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchPlaybackUpstream(
  target: URL,
  alistBase: URL,
  method: "GET" | "HEAD",
  authenticatedHeaders: Record<string, string>,
  signal: AbortSignal,
  preferDirect: boolean,
  options: PlaybackTransportOptions
) {
  const fetchImpl = options.fetch || fetch;
  const lookup = options.lookup || dns.promises.lookup;
  const seen = new Set<string>();
  let current = target;
  let crossedOrigin = target.origin !== alistBase.origin;

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const key = current.toString();
    if (seen.has(key)) {
      throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_LOOP", "远端存储播放地址出现循环跳转");
    }
    seen.add(key);
    const sameAlistOrigin = current.origin === alistBase.origin;
    const requestHeaders = sameAlistOrigin && !crossedOrigin
      ? authenticatedHeaders
      : Object.fromEntries(Object.entries(authenticatedHeaders).filter(([name]) => name.toLowerCase() !== "authorization"));
    const response = await fetchImpl(current, {
      method,
      headers: requestHeaders,
      signal,
      redirect: "manual",
    });
    if (!PLAYBACK_REDIRECT_STATUSES.has(response.status)) return { response };

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) {
      throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_INVALID", "远端存储返回了缺少目标的播放跳转");
    }
    if (redirects === 5) {
      throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_LIMIT", "远端存储播放地址跳转次数过多");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_INVALID", "远端存储返回了无效的播放跳转");
    }
    if (next.origin !== current.origin) crossedOrigin = true;
    if (next.origin === alistBase.origin) {
      current = next;
      continue;
    }
    const external = await validatedExternalPlaybackLocation(next.toString(), alistBase, lookup);
    if (!external) {
      throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_UNSAFE", "远端存储返回了不安全的外部播放地址");
    }
    if (preferDirect) return { directLocation: external };
    current = new URL(external);
  }
  throw new PlaybackHttpError(502, "PLAYBACK_REDIRECT_LIMIT", "远端存储播放地址跳转次数过多");
}

export async function streamPlaybackFile(
  database: StateDatabase,
  config: AppConfig,
  req: express.Request,
  res: express.Response,
  input: {
    userId: string;
    mediaId: number;
    fileId: number;
    ownerKey: string;
    attemptId?: string;
    forceProxy?: boolean;
    transport?: PlaybackTransportOptions;
  }
) {
  const file = resolvePlaybackFile(database, input.userId, input.mediaId, input.fileId);
  markPlaybackDelivery(input, "pending");
  const range = String(req.headers.range || "").trim();
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) {
    if (file.size) res.setHeader("Content-Range", `bytes */${file.size}`);
    markPlaybackDelivery(input, "failed");
    throw new PlaybackHttpError(416, "PLAYBACK_RANGE_INVALID", "仅支持单段字节范围请求");
  }

  let base: URL;
  try {
    base = parseStorageBaseUrl(config.alistUrl);
  } catch {
    markPlaybackDelivery(input, "failed");
    throw new PlaybackHttpError(502, "PLAYBACK_ALIST_CONFIG", "远端存储连接配置无效");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const buildTarget = (remotePath: string) => new URL(`${basePath}/dav${encodeDavPath(remotePath)}`, `${base.protocol}//${base.host}`);
  let target = buildTarget(file.remotePath);
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  const timeout = setTimeout(abort, 15_000);
  timeout.unref?.();
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${config.alistUsername}:${config.alistPassword}`).toString("base64")}`,
  };
  if (range) headers.Range = range;
  const ifRange = String(req.headers["if-range"] || "").trim();
  if (ifRange) headers["If-Range"] = ifRange;

  try {
    const preferRedirect = config.playbackDeliveryMode !== "proxy" && !input.forceProxy;
    let result = await fetchPlaybackUpstream(
      target,
      base,
      req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      controller.signal,
      preferRedirect,
      input.transport || {}
    );
    if (result.response?.status === 404 && isLikelyEncodedFilename(remoteLookupBasename(file.remotePath))) {
      await result.response.body?.cancel();
      const resolvePath = input.transport?.resolveRemotePath || (async (remotePath: string) => {
        const client = buildDavClient(config);
        const observed = await createRemoteFileResolver(client).inspect(remotePath, { fallback: "always" });
        return observed.status === "exists" && !observed.directory ? observed.path : undefined;
      });
      try {
        const resolvedPath = await resolvePath(file.remotePath);
        if (resolvedPath && resolvedPath !== file.remotePath) {
          target = buildTarget(resolvedPath);
          result = await fetchPlaybackUpstream(
            target,
            base,
            req.method === "HEAD" ? "HEAD" : "GET",
            headers,
            controller.signal,
            preferRedirect,
            input.transport || {}
          );
        }
      } catch (error) {
        if (error instanceof RemoteFileResolutionConflictError) {
          throw new PlaybackHttpError(502, "PLAYBACK_REMOTE_PATH_AMBIGUOUS", "远端播放文件无法唯一确认");
        }
      }
    }
    if (result.directLocation) {
      markPlaybackDelivery(input, "direct");
      clearTimeout(timeout);
      res.status(302);
      res.setHeader("Location", result.directLocation);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Length", "0");
      res.end();
      return;
    }
    const upstream = result.response!;
    clearTimeout(timeout);
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_AUTH", "远端存储拒绝了播放请求，请检查WebDAV账号");
    }
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(404, "PLAYBACK_UPSTREAM_MISSING", "远端播放文件暂时不可见");
    }
    if (upstream.status >= 500) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_ERROR", "远端存储或网盘暂时无法提供播放文件");
    }
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_RESPONSE", `远端存储返回了无法播放的状态 ${upstream.status}`);
    }

    res.status(upstream.status);
    if (upstream.status === 200 || upstream.status === 206) markPlaybackDelivery(input, "proxy");
    else if (upstream.status === 416) markPlaybackDelivery(input, "failed");
    copyPlaybackHeaders(upstream, res, mimeTypeForName(file.name));
    if (req.method === "HEAD" || upstream.status === 416 || !upstream.body) {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as any), res);
  } catch (error: any) {
    clearTimeout(timeout);
    markPlaybackDelivery(input, "failed");
    if (error instanceof PlaybackHttpError) throw error;
    if (controller.signal.aborted && (req.aborted || res.destroyed)) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const detail = error?.name === "AbortError" ? "播放连接超时或已中断" : "无法连接远端存储播放文件";
    const safeId = crypto.createHash("sha256").update(String(file.id)).digest("hex").slice(0, 8);
    throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_UNAVAILABLE", `${detail}（文件 ${safeId}）`);
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
