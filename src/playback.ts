import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type express from "express";
import type { AppConfig } from "./config.js";
import type { StateDatabase } from "./database.js";
import type { FavoriteRelation, RemoteFileRecord, VideoArchiveEntry } from "./state.js";

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
  parts: PlaybackPart[];
}

export interface PlaybackQueuePage {
  mode: "favorite" | "single";
  page: number;
  pageSize: number;
  total: number;
  focusIndex: number;
  hasMore: boolean;
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
  updatedAt: number;
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
    SELECT id, bvid, name, remote_path, expected_size, quality_json, updated_at
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
      updatedAt: Number(row.updated_at || 0),
    });
    result.set(bvid, group);
  }
  return result;
}

function buildQueueItem(
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
    return {
      fileId: row.id,
      pageIndex,
      cid: Number.isInteger(Number(file.filenameMetadata?.cid)) ? Number(file.filenameMetadata?.cid) : undefined,
      label: `${paired.length === 1 && !file.filenameMetadata?.pageIndex ? "正片" : `P${pageIndex}`}${duplicateSuffix}`,
      size: row.expectedSize,
      quality: String(file.filenameMetadata?.dfn || qualityProfile.quality || "") || undefined,
      codec: String(file.filenameMetadata?.videoCodecs || qualityProfile.encoding || "") || undefined,
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
    parts,
  };
}

function exactRelation(database: StateDatabase, userId: string, mediaId: number, bvid: string) {
  const row = database.db.prepare(`
    SELECT r.payload_json AS relation_json, v.payload_json AS video_json
    FROM favorite_relations r JOIN videos v ON v.bvid=r.bvid
    WHERE r.user_id=? AND r.media_id=? AND r.bvid=?
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
  const raw = String(value || "");
  if (!raw.startsWith("/") || raw.includes("\\") || raw.includes("\0") || raw.endsWith("/")) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

function isWithinRoot(filePath: string, rootValue: unknown) {
  const root = String(rootValue || "").replace(/\/+$/, "");
  return !root || filePath.startsWith(`${root}/`);
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

function resolvePlaybackFile(database: StateDatabase, userId: string, mediaId: number, fileId: number) {
  const row = database.db.prepare(`
    SELECT rf.id, rf.bvid, rf.name, rf.remote_path, rf.expected_size, r.payload_json AS relation_json
    FROM remote_files rf JOIN favorite_relations r
      ON r.user_id=rf.user_id AND r.media_id=rf.media_id AND r.bvid=rf.bvid
    WHERE rf.id=? AND rf.user_id=? AND rf.media_id=? AND rf.status='verified'
      AND r.backup_status IN ('verified','partial_verified')
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
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
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
    if (isPrivatePlaybackHost(target.hostname)) return null;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}

export async function streamPlaybackFile(
  database: StateDatabase,
  config: AppConfig,
  req: express.Request,
  res: express.Response,
  input: { userId: string; mediaId: number; fileId: number; forceProxy?: boolean }
) {
  const file = resolvePlaybackFile(database, input.userId, input.mediaId, input.fileId);
  const range = String(req.headers.range || "").trim();
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) {
    if (file.size) res.setHeader("Content-Range", `bytes */${file.size}`);
    throw new PlaybackHttpError(416, "PLAYBACK_RANGE_INVALID", "仅支持单段字节范围请求");
  }

  let base: URL;
  try {
    base = new URL(String(config.alistUrl || ""));
  } catch {
    throw new PlaybackHttpError(502, "PLAYBACK_ALIST_CONFIG", "AList连接配置无效");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = new URL(`${basePath}/dav${encodeDavPath(file.remotePath)}`, `${base.protocol}//${base.host}`);
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
    let upstream = await fetch(target, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      signal: controller.signal,
      redirect: preferRedirect ? "manual" : "follow",
    });
    if (preferRedirect && upstream.status === 302) {
      const directLocation = safePlaybackRedirectLocation(upstream.headers.get("location"), base);
      if (directLocation) {
        await upstream.body?.cancel();
        clearTimeout(timeout);
        res.status(302);
        res.setHeader("Location", directLocation);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
    }
    if (preferRedirect && upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      upstream = await fetch(target, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    }
    clearTimeout(timeout);
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_AUTH", "AList拒绝了播放请求，请检查WebDAV账号");
    }
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(404, "PLAYBACK_UPSTREAM_MISSING", "远端播放文件暂时不可见");
    }
    if (upstream.status >= 500) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_ERROR", "AList或网盘暂时无法提供播放文件");
    }
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_RESPONSE", `AList返回了无法播放的状态 ${upstream.status}`);
    }

    res.status(upstream.status);
    copyPlaybackHeaders(upstream, res, mimeTypeForName(file.name));
    if (req.method === "HEAD" || upstream.status === 416 || !upstream.body) {
      await upstream.body?.cancel();
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as any), res);
  } catch (error: any) {
    clearTimeout(timeout);
    if (error instanceof PlaybackHttpError) throw error;
    if (controller.signal.aborted && (req.aborted || res.destroyed)) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const detail = error?.name === "AbortError" ? "播放连接超时或已中断" : "无法连接AList播放文件";
    const safeId = crypto.createHash("sha256").update(String(file.id)).digest("hex").slice(0, 8);
    throw new PlaybackHttpError(502, "PLAYBACK_UPSTREAM_UNAVAILABLE", `${detail}（文件 ${safeId}）`);
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
