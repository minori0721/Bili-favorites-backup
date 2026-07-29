import crypto from "node:crypto";
import type { StateDatabase } from "./database.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import {
  buildPlaybackQueueItems,
  type PlaybackQueueItem,
  type PlaybackQueuePage,
  type PlaybackQueueSource,
} from "./playback.js";
import type { BackupStatus, FavoriteRelation, VideoArchiveEntry } from "./state.js";
import type { BiliUser } from "./users.js";

export type ArchiveLibraryScope = "global" | "account" | "folder";
export type ArchiveLibraryFilter = "all" | "playable" | "pending" | "issue" | "deleted";
export type ArchiveLibrarySort = "context" | "title_asc" | "title_desc";
export type ArchiveLibrarySearchScope = "current" | "global";

export interface ArchiveLibraryQuery {
  scope: ArchiveLibraryScope;
  userId?: string;
  mediaId?: number;
  query: string;
  searchScope: ArchiveLibrarySearchScope;
  filter: ArchiveLibraryFilter;
  sort: ArchiveLibrarySort;
  cursor?: string;
  pageSize: number;
}

export interface ArchiveLibraryMembership {
  userId: string;
  userName: string;
  mediaId: number;
  folderTitle: string;
  activeInFavorite: boolean;
  selectedFolder: boolean;
  backupStatus: BackupStatus;
  lastSeenAt: string;
  unavailable: boolean;
  ownerRemoved?: boolean;
  deletionId?: string;
  deletionStatus?: string;
  deletedAt?: string;
  deletable: boolean;
  deletionReason?: string;
  fileCount: number;
  totalBytes: number;
  error?: string;
}

export interface ArchiveLibraryItem {
  bvid: string;
  title: string;
  upperName: string;
  cover?: string;
  coverLocalPath?: string;
  backupStatus: BackupStatus;
  statusGroup: Exclude<ArchiveLibraryFilter, "all">;
  unavailable: boolean;
  activeInFavorite: boolean;
  lastSeenAt: string;
  membershipCount: number;
  memberships: ArchiveLibraryMembership[];
  playback: {
    available: boolean;
    partCount: number;
    partial: boolean;
    actualQuality?: string;
    bilibiliQuality?: string;
    source?: PlaybackQueueItem["source"];
  };
}

interface NormalizedContext extends Omit<ArchiveLibraryQuery, "cursor"> {
  allowedUserIds: string[];
  effectiveScope: ArchiveLibraryScope;
  effectiveUserId?: string;
  effectiveMediaId?: number;
}

interface CandidateKeyRow {
  bvid: string;
  recent_key: number;
  title_key: string;
  active_key: number;
  order_key: number;
  playable: number;
  pending: number;
}

interface HydratedRecord {
  relation: FavoriteRelation;
  video: VideoArchiveEntry;
  deletionId?: string;
  deletionStatus?: string;
  deletedAt?: string;
  fileCount: number;
  totalBytes: number;
}

type LibraryUser = BiliUser & { archiveRemoved?: boolean; removedAt?: string };

const pendingStatuses = new Set<BackupStatus>([
  "discovered",
  "queued",
  "downloading",
  "downloaded",
  "uploading",
  "uploaded",
]);

const statusPriority: BackupStatus[] = [
  "verified",
  "partial_verified",
  "uploaded",
  "uploading",
  "downloaded",
  "downloading",
  "queued",
  "discovered",
  "upload_failed",
  "charging_restricted",
  "missing",
  "lost",
  "failed",
];

const playableFileSql = (alias: string) => `
  ${alias}.backup_status IN ('verified','partial_verified')
  AND EXISTS (
    SELECT 1 FROM remote_files rf
    WHERE rf.user_id=${alias}.user_id AND rf.media_id=${alias}.media_id AND rf.bvid=${alias}.bvid
      AND rf.status='verified'
      AND (lower(rf.name) LIKE '%.mp4' OR lower(rf.name) LIKE '%.m4v' OR lower(rf.name) LIKE '%.webm')
  )
`;

const deletionExistsSql = (alias: string) => `EXISTS(
  SELECT 1 FROM archive_deleted_sources ads
  WHERE ads.user_id=${alias}.user_id AND ads.media_id=${alias}.media_id AND ads.bvid=${alias}.bvid
    AND ads.status IN ('pending','running','retry_wait','failed','completed')
)`;

function archiveLibraryUsers(database: StateDatabase, users: BiliUser[]) {
  const liveIds = new Set(users.map((user) => user.id));
  const removedRows = database.db.prepare(`
    SELECT user_id, uid, name, avatar, removed_at FROM archive_accounts
    WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, user_id
  `).all() as any[];
  const removedById = new Map(removedRows.map((row) => [String(row.user_id), row]));
  const current = users.map((user) => {
    const removed = removedById.get(user.id);
    return removed
      ? { ...user, archiveRemoved: true, removedAt: isoFromMs(removed.removed_at) } as LibraryUser
      : user as LibraryUser;
  });
  const archived = removedRows
    .filter((row) => !liveIds.has(String(row.user_id)))
    .map((row) => ({
      id: String(row.user_id),
      uid: Number(row.uid || 0),
      name: String(row.name || `已移除账号 ${row.user_id}`),
      avatar: row.avatar || "",
      cookie: { SESSDATA: "", bili_jct: "", DedeUserID: String(row.uid || "") },
      favorites: [],
      enabled: false,
      lastLoginAt: "",
      archiveRemoved: true,
      removedAt: isoFromMs(row.removed_at),
    } as LibraryUser));
  return [...current, ...archived];
}

const displayTitleSql = `lower(trim(COALESCE(
  NULLIF(json_extract(v.payload_json, '$.originalMeta.title'), ''),
  NULLIF(json_extract(v.payload_json, '$.title'), ''),
  r.bvid
)))`;

const displayUpperSql = `lower(trim(COALESCE(
  NULLIF(json_extract(v.payload_json, '$.originalMeta.upperName'), ''),
  NULLIF(json_extract(v.payload_json, '$.upperName'), ''),
  ''
)))`;

export class ArchiveLibraryQueryError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ArchiveLibraryQueryError";
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

function isoFromMs(value: unknown) {
  const timestamp = Number(value || 0);
  return timestamp > 0 ? new Date(timestamp).toISOString() : "";
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

function relationUnavailable(relation: FavoriteRelation, video: VideoArchiveEntry) {
  const favoriteUnavailable = Boolean(relation.favoriteUnavailable || video.favoriteUnavailable);
  const selfVisible = Boolean(relation.selfVisible || video.selfVisible);
  return (favoriteUnavailable && !selfVisible) || video.biliStatus === "unavailable";
}

function safeLibraryError(value: unknown) {
  const sanitized = sanitizeDiagnosticText(value, 300)
    .replace(/https?:\/\/[^\s]+/gi, "[remote url]")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[local path]")
    .replace(/(^|[\s("'=:])\/(?:[^\s"'<>/]+\/)*[^\s"'<>]+/g, "$1[remote path]")
    .trim();
  return sanitized || undefined;
}

function normalizeQuery(users: BiliUser[], input: Partial<ArchiveLibraryQuery>): NormalizedContext {
  const allowedUserIds = users.map((user) => user.id);
  const rawScope = String(input.scope || "global");
  if (!(["global", "account", "folder"] as string[]).includes(rawScope)) {
    throw new ArchiveLibraryQueryError("Invalid archive scope");
  }
  const scope = rawScope as ArchiveLibraryScope;
  const userId = String(input.userId || "").trim() || undefined;
  if (userId && (userId.length > 160 || userId.includes("\0"))) {
    throw new ArchiveLibraryQueryError("Invalid archive account");
  }
  const hasMediaId = input.mediaId !== undefined && input.mediaId !== null;
  const parsedMediaId = Number(input.mediaId);
  if (hasMediaId && (!Number.isInteger(parsedMediaId) || parsedMediaId < 1)) {
    throw new ArchiveLibraryQueryError("Invalid archive folder");
  }
  const mediaId = hasMediaId ? parsedMediaId : undefined;
  if (scope !== "global" && (!userId || !allowedUserIds.includes(userId))) {
    throw new ArchiveLibraryQueryError("Unknown archive account");
  }
  if (scope === "folder" && (!Number.isInteger(mediaId) || Number(mediaId) < 1)) {
    throw new ArchiveLibraryQueryError("Invalid archive folder");
  }
  const query = String(input.query || "").trim();
  if (query.length > 80 || query.includes("\0")) throw new ArchiveLibraryQueryError("Invalid archive search query");
  const rawSearchScope = String(input.searchScope || "current");
  if (!(["current", "global"] as string[]).includes(rawSearchScope)) {
    throw new ArchiveLibraryQueryError("Invalid archive search scope");
  }
  const searchScope = rawSearchScope as ArchiveLibrarySearchScope;
  const rawFilter = String(input.filter || "all");
  if (!(["all", "playable", "pending", "issue", "deleted"] as string[]).includes(rawFilter)) {
    throw new ArchiveLibraryQueryError("Invalid archive filter");
  }
  const filter = rawFilter as ArchiveLibraryFilter;
  const rawSort = String(input.sort || "context");
  if (!(["context", "title_asc", "title_desc"] as string[]).includes(rawSort)) {
    throw new ArchiveLibraryQueryError("Invalid archive sort");
  }
  const sort = rawSort as ArchiveLibrarySort;
  const pageSize = Number(input.pageSize ?? 50);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new ArchiveLibraryQueryError("Invalid archive page size");
  }
  const globalSearch = Boolean(query) && searchScope === "global";
  return {
    scope,
    userId,
    mediaId,
    query,
    searchScope,
    filter,
    sort,
    pageSize,
    allowedUserIds,
    effectiveScope: globalSearch ? "global" : scope,
    effectiveUserId: globalSearch ? undefined : userId,
    effectiveMediaId: globalSearch ? undefined : mediaId,
  };
}

function addScopeSql(context: NormalizedContext, alias: string, params: Record<string, unknown>) {
  if (context.allowedUserIds.length === 0) return "0=1";
  const allowed = context.allowedUserIds.map((userId, index) => {
    params[`allowed${index}`] = userId;
    return `@allowed${index}`;
  }).join(",");
  const conditions = [`${alias}.user_id IN (${allowed})`];
  if (context.effectiveScope === "account" || context.effectiveScope === "folder") {
    params.scopeUserId = context.effectiveUserId;
    conditions.push(`${alias}.user_id=@scopeUserId`);
  }
  if (context.effectiveScope === "folder") {
    params.scopeMediaId = context.effectiveMediaId;
    conditions.push(`${alias}.media_id=@scopeMediaId`);
  }
  return conditions.join(" AND ");
}

function searchSql(context: NormalizedContext, params: Record<string, unknown>, extraQuery = "") {
  const query = [context.query, extraQuery].filter(Boolean).join(" ").trim();
  if (!query) return "1=1";
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.map((term, index) => {
    params[`term${index}`] = `%${term.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    return `(
      lower(r.bvid) LIKE @term${index} ESCAPE '\\'
      OR ${displayTitleSql} LIKE @term${index} ESCAPE '\\'
      OR ${displayUpperSql} LIKE @term${index} ESCAPE '\\'
    )`;
  }).join(" AND ");
}

function filterSql(filter: ArchiveLibraryFilter) {
  if (filter === "playable") return "playable=1";
  if (filter === "pending") return "playable=0 AND pending=1";
  if (filter === "issue") return "playable=0 AND pending=0";
  return "1=1";
}

function contextHash(context: NormalizedContext, extraQuery = "") {
  return crypto.createHash("sha256").update(JSON.stringify({
    scope: context.effectiveScope,
    userId: context.effectiveUserId || "",
    mediaId: context.effectiveMediaId || 0,
    query: context.query,
    extraQuery,
    filter: context.filter,
    sort: context.sort,
    users: context.allowedUserIds,
  })).digest("base64url").slice(0, 20);
}

function encodeCursor(context: NormalizedContext, row: CandidateKeyRow, extraQuery = "") {
  return Buffer.from(JSON.stringify({
    v: 1,
    h: contextHash(context, extraQuery),
    b: row.bvid,
    r: Number(row.recent_key || 0),
    t: String(row.title_key || ""),
    a: Number(row.active_key || 0),
    o: Number(row.order_key || 0),
  })).toString("base64url");
}

function decodeCursor(context: NormalizedContext, cursor: string | undefined, extraQuery = "") {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.h !== contextHash(context, extraQuery) || !parsed?.b) throw new Error("mismatch");
    return parsed as { b: string; r: number; t: string; a: number; o: number };
  } catch {
    throw new ArchiveLibraryQueryError("Invalid or stale archive cursor");
  }
}

function orderAndCursorSql(context: NormalizedContext, cursor: ReturnType<typeof decodeCursor>, params: Record<string, unknown>) {
  if (!cursor) {
    if (context.sort === "title_asc") return { cursorSql: "1=1", orderSql: "title_key ASC, bvid ASC" };
    if (context.sort === "title_desc") return { cursorSql: "1=1", orderSql: "title_key DESC, bvid ASC" };
    if (context.effectiveScope === "folder") {
      return { cursorSql: "1=1", orderSql: "active_key DESC, order_key ASC, recent_key DESC, bvid ASC" };
    }
    return { cursorSql: "1=1", orderSql: "recent_key DESC, bvid ASC" };
  }
  params.cursorBvid = cursor.b;
  params.cursorRecent = Number(cursor.r || 0);
  params.cursorTitle = String(cursor.t || "");
  params.cursorActive = Number(cursor.a || 0);
  params.cursorOrder = Number(cursor.o || 0);
  if (context.sort === "title_asc") {
    return {
      cursorSql: "(title_key>@cursorTitle OR (title_key=@cursorTitle AND bvid>@cursorBvid))",
      orderSql: "title_key ASC, bvid ASC",
    };
  }
  if (context.sort === "title_desc") {
    return {
      cursorSql: "(title_key<@cursorTitle OR (title_key=@cursorTitle AND bvid>@cursorBvid))",
      orderSql: "title_key DESC, bvid ASC",
    };
  }
  if (context.effectiveScope === "folder") {
    return {
      cursorSql: `(
        active_key<@cursorActive
        OR (active_key=@cursorActive AND order_key>@cursorOrder)
        OR (active_key=@cursorActive AND order_key=@cursorOrder AND recent_key<@cursorRecent)
        OR (active_key=@cursorActive AND order_key=@cursorOrder AND recent_key=@cursorRecent AND bvid>@cursorBvid)
      )`,
      orderSql: "active_key DESC, order_key ASC, recent_key DESC, bvid ASC",
    };
  }
  return {
    cursorSql: "(recent_key<@cursorRecent OR (recent_key=@cursorRecent AND bvid>@cursorBvid))",
    orderSql: "recent_key DESC, bvid ASC",
  };
}

function candidateCte(context: NormalizedContext, params: Record<string, unknown>, extraQuery = "") {
  const scope = addScopeSql(context, "r", params);
  const search = searchSql(context, params, extraQuery);
  const deletion = context.filter === "deleted" ? deletionExistsSql("r") : `NOT (${deletionExistsSql("r")})`;
  return `
    WITH candidates AS (
      SELECT r.bvid,
        MAX(r.last_seen_at) AS recent_key,
        MIN(${displayTitleSql}) AS title_key,
        MAX(r.active_in_favorite) AS active_key,
        MIN(CASE WHEN r.active_in_favorite=1 THEN COALESCE(r.fav_order, 9223372036854775807) ELSE 9223372036854775807 END) AS order_key,
        MAX(CASE WHEN ${playableFileSql("r")} THEN 1 ELSE 0 END) AS playable,
        MAX(CASE WHEN r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END) AS pending
      FROM favorite_relations r
      JOIN videos v ON v.bvid=r.bvid
      WHERE ${scope} AND ${search} AND ${deletion}
      GROUP BY r.bvid
    ), filtered AS (
      SELECT * FROM candidates WHERE ${filterSql(context.filter)}
    )
  `;
}

function queryCandidatePage(
  database: StateDatabase,
  context: NormalizedContext,
  cursorValue: string | undefined,
  extraQuery = "",
  includeSummary = true
) {
  const params: Record<string, unknown> = {};
  const cte = candidateCte(context, params, extraQuery);
  const cursor = decodeCursor(context, cursorValue, extraQuery);
  const { cursorSql, orderSql } = orderAndCursorSql(context, cursor, params);
  params.limit = context.pageSize + 1;
  const rows = database.db.prepare(`
    ${cte}
    SELECT * FROM filtered WHERE ${cursorSql}
    ORDER BY ${orderSql}
    LIMIT @limit
  `).all(params) as CandidateKeyRow[];
  const hasMore = rows.length > context.pageSize;
  const pageRows = rows.slice(0, context.pageSize);
  const summary = includeSummary && !cursor ? database.db.prepare(`
    ${cte}
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN playable=1 THEN 1 ELSE 0 END),0) AS playable,
      COALESCE(SUM(CASE WHEN playable=0 AND pending=1 THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN playable=0 AND pending=0 THEN 1 ELSE 0 END),0) AS issue
    FROM filtered
  `).get(params) as any : null;
  return {
    rows: pageRows,
    hasMore,
    nextCursor: hasMore && pageRows.length ? encodeCursor(context, pageRows[pageRows.length - 1], extraQuery) : null,
    summary: summary ? {
      total: Number(summary.total || 0),
      playable: Number(summary.playable || 0),
      pending: Number(summary.pending || 0),
      issue: Number(summary.issue || 0),
    } : null,
  };
}

function hydrateRecords(database: StateDatabase, context: NormalizedContext, bvids: string[]) {
  if (bvids.length === 0) return new Map<string, HydratedRecord[]>();
  const params: Record<string, unknown> = {};
  const scope = addScopeSql(context, "r", params);
  const deletion = context.filter === "deleted" ? deletionExistsSql("r") : `NOT (${deletionExistsSql("r")})`;
  const values = bvids.map((bvid, index) => {
    params[`pageBvid${index}`] = bvid;
    return `(${index},@pageBvid${index})`;
  }).join(",");
  const rows = database.db.prepare(`
    WITH page(ord,bvid) AS (VALUES ${values})
    SELECT page.ord, r.payload_json AS relation_json, v.payload_json AS video_json,
      (SELECT ads.deletion_id FROM archive_deleted_sources ads
       WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
         AND ads.status IN ('pending','running','retry_wait','failed','completed')
       ORDER BY COALESCE(ads.deleted_at,0) DESC, ads.rowid DESC LIMIT 1) AS deletion_id,
      (SELECT ads.status FROM archive_deleted_sources ads
       WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
         AND ads.status IN ('pending','running','retry_wait','failed','completed')
       ORDER BY COALESCE(ads.deleted_at,0) DESC, ads.rowid DESC LIMIT 1) AS deletion_status,
      (SELECT ads.deleted_at FROM archive_deleted_sources ads
       WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
         AND ads.status='completed'
       ORDER BY ads.deleted_at DESC LIMIT 1) AS deleted_at,
      CASE WHEN ${deletionExistsSql("r")} THEN COALESCE((
        SELECT ads.file_count FROM archive_deleted_sources ads
        WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
          AND ads.status IN ('pending','running','retry_wait','failed','completed')
        ORDER BY COALESCE(ads.deleted_at,0) DESC, ads.rowid DESC LIMIT 1
      ),0) ELSE (SELECT COUNT(*) FROM remote_files rf WHERE rf.user_id=r.user_id AND rf.media_id=r.media_id AND rf.bvid=r.bvid AND rf.status='verified') END AS file_count,
      CASE WHEN ${deletionExistsSql("r")} THEN COALESCE((
        SELECT ads.total_bytes FROM archive_deleted_sources ads
        WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
          AND ads.status IN ('pending','running','retry_wait','failed','completed')
        ORDER BY COALESCE(ads.deleted_at,0) DESC, ads.rowid DESC LIMIT 1
      ),0) ELSE COALESCE((SELECT SUM(rf.expected_size) FROM remote_files rf WHERE rf.user_id=r.user_id AND rf.media_id=r.media_id AND rf.bvid=r.bvid AND rf.status='verified'),0) END AS total_bytes
    FROM page
    JOIN favorite_relations r ON r.bvid=page.bvid
    JOIN videos v ON v.bvid=page.bvid
    WHERE ${scope} AND ${deletion}
    ORDER BY page.ord,
      r.active_in_favorite DESC,
      CASE WHEN r.fav_order IS NULL THEN 1 ELSE 0 END,
      r.fav_order ASC,
      r.last_seen_at DESC,
      r.user_id,
      r.media_id
  `).all(params) as any[];
  const records = new Map<string, HydratedRecord[]>();
  for (const row of rows) {
    const relation = parseJson<FavoriteRelation>(row.relation_json, undefined as any);
    const video = parseJson<VideoArchiveEntry>(row.video_json, undefined as any);
    if (!relation || !video) continue;
    const group = records.get(relation.bvid) || [];
    group.push({
      relation,
      video,
      deletionId: row.deletion_id || undefined,
      deletionStatus: row.deletion_status || undefined,
      deletedAt: isoFromMs(row.deleted_at),
      fileCount: Number(row.file_count || 0),
      totalBytes: Number(row.total_bytes || 0),
    });
    records.set(relation.bvid, group);
  }
  return records;
}

function sourceKey(source: PlaybackQueueItem["source"], bvid: string) {
  return `${source.userId}:${source.mediaId}:${bvid}`;
}

function sourceScore(item: PlaybackQueueItem, relation: FavoriteRelation) {
  const measured = item.parts.length > 0 && item.parts.every((part) => Number(part.actualWidth) > 0 && Number(part.actualHeight) > 0);
  const minShortEdge = measured
    ? Math.min(...item.parts.map((part) => Math.min(Number(part.actualWidth), Number(part.actualHeight))))
    : -1;
  const measuredFps = measured && item.parts.every((part) => Number(part.actualFps) > 0);
  const minFps = measuredFps ? Math.min(...item.parts.map((part) => Number(part.actualFps))) : -1;
  const confirmedAt = Date.parse(relation.verifiedAt || relation.lastRemoteCheckAt || relation.lastSeenAt || "") || 0;
  return { measured, minShortEdge, minFps, complete: item.partial ? 0 : 1, parts: item.parts.length, confirmedAt };
}

function chooseBestPlaybackSource(database: StateDatabase, records: HydratedRecord[], queuePosition: number) {
  const sources: PlaybackQueueSource[] = records.map(({ relation, video }) => ({ relation, video, queuePosition }));
  return chooseBestBuiltPlaybackSource(records, buildPlaybackQueueItems(database, sources));
}

function chooseBestBuiltPlaybackSource(records: HydratedRecord[], built: PlaybackQueueItem[]) {
  const relationByKey = new Map(records.map(({ relation }) => [
    `${relation.userId}:${relation.mediaId}:${relation.bvid}`,
    relation,
  ]));
  return built.sort((left, right) => {
    const leftRelation = relationByKey.get(sourceKey(left.source, left.bvid))!;
    const rightRelation = relationByKey.get(sourceKey(right.source, right.bvid))!;
    const a = sourceScore(left, leftRelation);
    const b = sourceScore(right, rightRelation);
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    if (a.minShortEdge !== b.minShortEdge) return b.minShortEdge - a.minShortEdge;
    if (a.minFps !== b.minFps) return b.minFps - a.minFps;
    if (a.complete !== b.complete) return b.complete - a.complete;
    if (a.parts !== b.parts) return b.parts - a.parts;
    if (a.confirmedAt !== b.confirmedAt) return b.confirmedAt - a.confirmedAt;
    const leftKey = sourceKey(left.source, left.bvid);
    const rightKey = sourceKey(right.source, right.bvid);
    return leftKey.localeCompare(rightKey);
  })[0] || null;
}

function choosePagePlaybackSources(
  database: StateDatabase,
  recordsByBvid: Map<string, HydratedRecord[]>,
  bvids: string[],
  offset = 0
) {
  const sources = bvids.flatMap((bvid, index) => (recordsByBvid.get(bvid) || []).map(({ relation, video }) => ({
    relation,
    video,
    queuePosition: offset + index + 1,
  })));
  const builtByBvid = new Map<string, PlaybackQueueItem[]>();
  for (const item of buildPlaybackQueueItems(database, sources)) {
    const group = builtByBvid.get(item.bvid) || [];
    group.push(item);
    builtByBvid.set(item.bvid, group);
  }
  return new Map(bvids.map((bvid) => [
    bvid,
    chooseBestBuiltPlaybackSource(recordsByBvid.get(bvid) || [], builtByBvid.get(bvid) || []),
  ]));
}

function membershipFromRecord(record: HydratedRecord, users: Map<string, LibraryUser>, selected: Set<string>, includeError: boolean): ArchiveLibraryMembership {
  const { relation, video } = record;
  const user = users.get(relation.userId);
  const selectedFolder = selected.has(`${relation.userId}:${relation.mediaId}`);
  const ownerRemoved = Boolean(user?.archiveRemoved);
  const deletionInProgress = Boolean(record.deletionStatus && record.deletionStatus !== "completed");
  const alreadyDeleted = record.deletionStatus === "completed";
  const eligibleRelationship = ownerRemoved || !selectedFolder || !relation.activeInFavorite;
  const deletable = !record.deletionStatus && record.fileCount > 0 && eligibleRelationship;
  const deletionReason = alreadyDeleted
    ? "该来源的远端归档已删除"
    : deletionInProgress
      ? "该来源正在清理或等待重试"
      : record.fileCount <= 0
        ? "该来源没有可删除的已验证归档文件"
      : deletable
        ? undefined
        : "仍在同步，删除后会被重新归档";
  return {
    userId: relation.userId,
    userName: user?.name || "未知账号",
    mediaId: relation.mediaId,
    folderTitle: relation.folderTitle || `收藏夹 ${relation.mediaId}`,
    activeInFavorite: relation.activeInFavorite,
    selectedFolder,
    backupStatus: (relation.backupStatus || video.backupStatus) as BackupStatus,
    lastSeenAt: relation.lastSeenAt,
    unavailable: relationUnavailable(relation, video),
    ownerRemoved: ownerRemoved || undefined,
    deletionId: record.deletionId,
    deletionStatus: record.deletionStatus,
    deletedAt: record.deletedAt || undefined,
    deletable,
    deletionReason,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    ...(includeError && (relation.lastError || video.lastError)
      ? { error: safeLibraryError(relation.lastError || video.lastError) }
      : {}),
  };
}

function chooseStatus(records: HydratedRecord[], best: PlaybackQueueItem | null) {
  if (best) {
    const source = records.find(({ relation }) => relation.userId === best.source.userId && relation.mediaId === best.source.mediaId);
    return (source?.relation.backupStatus || source?.video.backupStatus || "verified") as BackupStatus;
  }
  const statuses = records.map(({ relation, video }) => (relation.backupStatus || video.backupStatus) as BackupStatus);
  const pending = statuses.find((status) => pendingStatuses.has(status));
  if (pending) return pending;
  return statusPriority.find((status) => statuses.includes(status)) || statuses[0] || "discovered";
}

function itemFromRecords(
  database: StateDatabase,
  records: HydratedRecord[],
  users: Map<string, LibraryUser>,
  selected: Set<string>,
  queuePosition: number,
  includeAllMemberships = false,
  selectedPlayback?: PlaybackQueueItem | null
): ArchiveLibraryItem | null {
  if (records.length === 0) return null;
  const video = records[0].video;
  const best = selectedPlayback === undefined
    ? chooseBestPlaybackSource(database, records, queuePosition)
    : selectedPlayback;
  const hasPending = records.some(({ relation, video: entry }) => pendingStatuses.has((relation.backupStatus || entry.backupStatus) as BackupStatus));
  const hasDeletionRecord = records.some((record) => Boolean(record.deletionStatus));
  const statusGroup = hasDeletionRecord ? "deleted" : best ? "playable" : hasPending ? "pending" : "issue";
  const memberships = records.map((record) => membershipFromRecord(record, users, selected, includeAllMemberships));
  const limitedMemberships = includeAllMemberships ? memberships : memberships.slice(0, 3);
  const weakestMeasuredPart = best?.parts.length && best.parts.every((part) => Number(part.actualWidth) > 0 && Number(part.actualHeight) > 0)
    ? [...best.parts].sort((left, right) => Math.min(Number(left.actualWidth), Number(left.actualHeight)) - Math.min(Number(right.actualWidth), Number(right.actualHeight)))[0]
    : undefined;
  return {
    bvid: video.bvid,
    title: displayTitle(video),
    upperName: displayUpperName(video),
    cover: displayCover(video),
    coverLocalPath: displayCoverLocalPath(video),
    backupStatus: chooseStatus(records, best),
    statusGroup,
    unavailable: records.some(({ relation, video: entry }) => relationUnavailable(relation, entry)),
    activeInFavorite: records.some(({ relation }) => relation.activeInFavorite),
    lastSeenAt: records.map(({ relation }) => relation.lastSeenAt).sort().reverse()[0] || video.lastSeenAt,
    membershipCount: memberships.length,
    memberships: limitedMemberships,
    playback: {
      available: Boolean(best),
      partCount: best?.parts.length || 0,
      partial: Boolean(best?.partial),
      actualQuality: weakestMeasuredPart?.actualQuality,
      bilibiliQuality: best?.parts.find((part) => part.bilibiliQuality)?.bilibiliQuality,
      source: best?.source,
    },
  };
}

function selectionSet(users: BiliUser[]) {
  return new Set(users.flatMap((user) => user.favorites.map((folder) => `${user.id}:${folder.mediaId}`)));
}

export function queryArchiveLibraryItems(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: { extraQuery?: string; includeSummary?: boolean } = {}
) {
  const libraryUsers = archiveLibraryUsers(database, users);
  const context = normalizeQuery(libraryUsers, input);
  const page = queryCandidatePage(database, context, input.cursor, options.extraQuery || "", options.includeSummary !== false);
  const records = hydrateRecords(database, context, page.rows.map((row) => row.bvid));
  const userMap = new Map(libraryUsers.map((user) => [user.id, user]));
  const selected = selectionSet(libraryUsers);
  const playback = choosePagePlaybackSources(database, records, page.rows.map((row) => row.bvid));
  const items = page.rows.map((row, index) => itemFromRecords(
    database,
    records.get(row.bvid) || [],
    userMap,
    selected,
    index + 1,
    false,
    playback.get(row.bvid) || null
  )).filter((item): item is ArchiveLibraryItem => Boolean(item));
  return {
    context: {
      scope: context.effectiveScope,
      userId: context.effectiveUserId,
      mediaId: context.effectiveMediaId,
      query: context.query,
      searchScope: context.searchScope,
      filter: context.filter,
      sort: context.sort,
    },
    items,
    summary: page.summary,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

export function getArchiveLibraryItemDetail(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  bvid: string
) {
  const libraryUsers = archiveLibraryUsers(database, users);
  const context = normalizeQuery(libraryUsers, input);
  const params: Record<string, unknown> = {};
  const cte = candidateCte(context, params);
  params.detailBvid = bvid;
  const included = database.db.prepare(`${cte} SELECT 1 FROM filtered WHERE bvid=@detailBvid`).get(params);
  if (!included) return null;
  const records = hydrateRecords(database, context, [bvid]).get(bvid) || [];
  if (records.length === 0) return null;
  return itemFromRecords(database, records, new Map(libraryUsers.map((user) => [user.id, user])), selectionSet(libraryUsers), 1, true);
}

function playbackPageFromItems(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: { focusBvid?: string; page?: number; pageSize?: number; extraQuery?: string }
): PlaybackQueuePage | null {
  const libraryUsers = archiveLibraryUsers(database, users);
  const context = normalizeQuery(libraryUsers, { ...input, filter: "playable", pageSize: options.pageSize || 50 });
  const focusBvid = String(options.focusBvid || "").trim();
  const pageSize = context.pageSize;
  const params: Record<string, unknown> = {};
  const cte = candidateCte(context, params, options.extraQuery || "");
  const order = orderAndCursorSql(context, null, params).orderSql;
  const total = Number((database.db.prepare(`${cte} SELECT COUNT(*) AS count FROM filtered`).get(params) as any)?.count || 0);
  if (total === 0) return { mode: "library", page: 1, pageSize, total: 0, focusIndex: -1, hasMore: false, items: [] };
  let focusIndex = -1;
  if (focusBvid) {
    params.focusBvid = focusBvid;
    const focus = database.db.prepare(`
      ${cte}, positioned AS (
        SELECT bvid, ROW_NUMBER() OVER (ORDER BY ${order}) - 1 AS position FROM filtered
      )
      SELECT position FROM positioned WHERE bvid=@focusBvid
    `).get(params) as any;
    if (!focus) return null;
    focusIndex = Number(focus.position);
  }
  const requestedPage = Math.max(0, Math.floor(Number(options.page || 0)));
  const page = requestedPage || (focusIndex >= 0 ? Math.floor(focusIndex / pageSize) + 1 : 1);
  params.limit = pageSize;
  params.offset = (page - 1) * pageSize;
  const keys = database.db.prepare(`
    ${cte}
    SELECT * FROM filtered ORDER BY ${order} LIMIT @limit OFFSET @offset
  `).all(params) as CandidateKeyRow[];
  const records = hydrateRecords(database, context, keys.map((row) => row.bvid));
  const selected = choosePagePlaybackSources(database, records, keys.map((row) => row.bvid), Number(params.offset));
  const items = keys.map((row) => selected.get(row.bvid) || null)
    .filter((item): item is PlaybackQueueItem => Boolean(item));
  return {
    mode: "library",
    page,
    pageSize,
    total,
    focusIndex,
    hasMore: Number(params.offset) + pageSize < total,
    items,
  };
}

export function getArchiveLibraryPlaybackQueue(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: { focusBvid?: string; page?: number; pageSize?: number }
) {
  return playbackPageFromItems(database, users, input, options);
}

export function getArchiveLibraryPlaybackSearch(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: { query: string; page?: number; pageSize?: number }
) {
  const query = String(options.query || "").trim();
  if (!query) return { query, page: 1, pageSize: Math.min(50, Math.max(1, Number(options.pageSize || 50))), total: 0, hasMore: false, items: [] };
  if (query.length > 80) throw new ArchiveLibraryQueryError("Search query is too long");
  const queue = playbackPageFromItems(database, users, input, {
    page: options.page,
    pageSize: options.pageSize,
    extraQuery: query,
  });
  return {
    query,
    page: queue?.page || 1,
    pageSize: queue?.pageSize || 50,
    total: queue?.total || 0,
    hasMore: queue?.hasMore || false,
    items: queue?.items || [],
  };
}

function navigationSummarySql(userIds: string[], userId?: string) {
  if (userIds.length === 0) return null;
  const placeholders = userIds.map(() => "?").join(",");
  const where = userId ? `r.user_id=? AND r.user_id IN (${placeholders})` : `r.user_id IN (${placeholders})`;
  const params = userId ? [userId, ...userIds] : userIds;
  return { sql: `
    WITH classified AS (
      SELECT r.bvid,
        MAX(CASE WHEN NOT (${deletionExistsSql("r")}) THEN 1 ELSE 0 END) AS visible,
        MAX(CASE WHEN NOT (${deletionExistsSql("r")}) AND ${playableFileSql("r")} THEN 1 ELSE 0 END) AS playable,
        MAX(CASE WHEN NOT (${deletionExistsSql("r")}) AND r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END) AS pending,
        MAX(CASE WHEN ${deletionExistsSql("r")} THEN 1 ELSE 0 END) AS deleted
      FROM favorite_relations r
      WHERE ${where}
      GROUP BY r.bvid
    )
    SELECT COALESCE(SUM(visible),0) AS total,
      COALESCE(SUM(CASE WHEN playable=1 THEN 1 ELSE 0 END),0) AS playable,
      COALESCE(SUM(CASE WHEN visible=1 AND playable=0 AND pending=1 THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN visible=1 AND playable=0 AND pending=0 THEN 1 ELSE 0 END),0) AS issue,
      COALESCE(SUM(deleted),0) AS deleted
    FROM classified
  `, params };
}

function readNavigationSummary(database: StateDatabase, userIds: string[], userId?: string) {
  const statement = navigationSummarySql(userIds, userId);
  if (!statement) return { total: 0, playable: 0, pending: 0, issue: 0, deleted: 0 };
  const row = database.db.prepare(statement.sql).get(...statement.params) as any;
  return {
    total: Number(row?.total || 0),
    playable: Number(row?.playable || 0),
    pending: Number(row?.pending || 0),
    issue: Number(row?.issue || 0),
    deleted: Number(row?.deleted || 0),
  };
}

function decorateNavigationSummary(summary: ReturnType<typeof readNavigationSummary>, rows: any[]) {
  const latestSync = Math.max(0, ...rows.map((row) => Number(row.last_synced_at || 0)));
  const coverRow = [...rows]
    .filter((row) => row.cover_local_path || row.cover)
    .sort((left, right) => Number(right.last_seen_at || 0) - Number(left.last_seen_at || 0))[0];
  return {
    ...summary,
    lastSyncedAt: isoFromMs(latestSync),
    coverLocalPath: coverRow?.cover_local_path || undefined,
    cover: coverRow?.cover || undefined,
  };
}

export function getArchiveLibraryNavigation(database: StateDatabase, users: BiliUser[]) {
  const libraryUsers = archiveLibraryUsers(database, users);
  const userIds = libraryUsers.map((user) => user.id);
  const selected = selectionSet(libraryUsers);
  const folderRows = userIds.length ? database.db.prepare(`
    SELECT r.user_id, r.media_id,
      MAX(r.last_seen_at) AS last_seen_at,
      COALESCE(SUM(CASE WHEN NOT (${deletionExistsSql("r")}) THEN 1 ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN NOT (${deletionExistsSql("r")}) AND ${playableFileSql("r")} THEN 1 ELSE 0 END),0) AS playable,
      COALESCE(SUM(CASE WHEN NOT (${deletionExistsSql("r")}) AND NOT (${playableFileSql("r")}) AND r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN NOT (${deletionExistsSql("r")}) AND NOT (${playableFileSql("r")}) AND r.backup_status NOT IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END),0) AS issue,
      COALESCE(SUM(CASE WHEN ${deletionExistsSql("r")} THEN 1 ELSE 0 END),0) AS deleted,
      (SELECT rr.folder_title FROM favorite_relations rr
       WHERE rr.user_id=r.user_id AND rr.media_id=r.media_id
       ORDER BY rr.last_seen_at DESC, rr.bvid LIMIT 1) AS folder_title,
      (SELECT fs.updated_at FROM folder_scans fs WHERE fs.user_id=r.user_id AND fs.media_id=r.media_id) AS last_synced_at,
      (SELECT json_extract(vv.payload_json, '$.originalMeta.coverLocalPath')
       FROM favorite_relations rc JOIN videos vv ON vv.bvid=rc.bvid
       WHERE rc.user_id=r.user_id AND rc.media_id=r.media_id
         AND json_extract(vv.payload_json, '$.originalMeta.coverLocalPath') IS NOT NULL
       ORDER BY rc.last_seen_at DESC LIMIT 1) AS cover_local_path,
      (SELECT COALESCE(json_extract(vv.payload_json, '$.originalMeta.cover'), json_extract(vv.payload_json, '$.cover'))
       FROM favorite_relations rc JOIN videos vv ON vv.bvid=rc.bvid
       WHERE rc.user_id=r.user_id AND rc.media_id=r.media_id
       ORDER BY rc.last_seen_at DESC LIMIT 1) AS cover
    FROM favorite_relations r
    WHERE r.user_id IN (${userIds.map(() => "?").join(",")})
    GROUP BY r.user_id, r.media_id
    ORDER BY r.user_id, MAX(r.last_seen_at) DESC, r.media_id
  `).all(...userIds) as any[] : [];
  const indexedFolders = new Map(folderRows.map((row) => [`${row.user_id}:${row.media_id}`, row]));
  const accountDeletionRows = userIds.length ? database.db.prepare(`
    SELECT id, user_id, status, file_count, total_bytes, completed_count, retained_count,
      conflict_count, failed_count, last_error, updated_at, completed_at
    FROM archive_deletions
    WHERE scope='account' AND user_id IN (${userIds.map(() => "?").join(",")})
      AND status IN ('pending','running','retry_wait','failed','completed')
    ORDER BY user_id, COALESCE(started_at, created_at) DESC, created_at DESC
  `).all(...userIds) as any[] : [];
  const accountDeletions = new Map<string, any>();
  for (const row of accountDeletionRows) {
    if (accountDeletions.has(String(row.user_id))) continue;
    accountDeletions.set(String(row.user_id), {
      id: String(row.id),
      status: String(row.status),
      fileCount: Number(row.file_count || 0),
      totalBytes: Number(row.total_bytes || 0),
      completedCount: Number(row.completed_count || 0),
      retainedCount: Number(row.retained_count || 0),
      conflictCount: Number(row.conflict_count || 0),
      failedCount: Number(row.failed_count || 0),
      lastError: row.last_error ? safeLibraryError(row.last_error) : undefined,
      updatedAt: isoFromMs(row.updated_at),
      completedAt: isoFromMs(row.completed_at),
    });
  }
  const accountData = libraryUsers.map((user) => {
    const accountRows = folderRows.filter((row) => row.user_id === user.id);
    const activeFolders = user.favorites.map((folder) => {
      const row = indexedFolders.get(`${user.id}:${folder.mediaId}`) as any;
      return {
        mediaId: folder.mediaId,
        title: folder.title,
        selected: true,
        inactive: false,
        total: Number(row?.total || 0),
        playable: Number(row?.playable || 0),
        pending: Number(row?.pending || 0),
        issue: Number(row?.issue || 0),
        deleted: Number(row?.deleted || 0),
        lastSyncedAt: isoFromMs(row?.last_synced_at),
        coverLocalPath: row?.cover_local_path || undefined,
        cover: row?.cover || undefined,
      };
    });
    const inactiveFolders = folderRows
      .filter((row) => row.user_id === user.id && !selected.has(`${user.id}:${row.media_id}`))
      .map((row) => ({
        mediaId: Number(row.media_id),
        title: String(row.folder_title || `收藏夹 ${row.media_id}`),
        selected: false,
        inactive: true,
        total: Number(row.total || 0),
        playable: Number(row.playable || 0),
        pending: Number(row.pending || 0),
        issue: Number(row.issue || 0),
        deleted: Number(row.deleted || 0),
        lastSyncedAt: isoFromMs(row.last_synced_at || row.last_seen_at),
        coverLocalPath: row.cover_local_path || undefined,
        cover: row.cover || undefined,
      }));
    return {
      id: user.id,
      uid: user.uid,
      name: user.name,
      avatar: user.avatar,
      enabled: user.enabled,
      removed: Boolean(user.archiveRemoved),
      removedAt: user.removedAt,
      deletion: accountDeletions.get(user.id),
      summary: decorateNavigationSummary(readNavigationSummary(database, userIds, user.id), accountRows),
      folders: activeFolders,
      inactiveFolders,
    };
  });
  return {
    summary: decorateNavigationSummary(readNavigationSummary(database, userIds), folderRows),
    accounts: accountData,
  };
}
