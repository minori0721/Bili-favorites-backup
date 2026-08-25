import crypto from "node:crypto";
import type { StateDatabase } from "./database.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import {
  buildPlaybackQueueItems,
  type PlaybackQueueItem,
  type PlaybackQueuePage,
  type PlaybackQueueSource,
} from "./playback.js";
import { MANUAL_ARCHIVE_FOLDER_TITLE, MANUAL_ARCHIVE_MEDIA_ID, type BackupStatus, type FavoriteRelation, type VideoArchiveEntry } from "./state.js";
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
  sourceKind: "favorite" | "manual";
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
  order_known_key: number;
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
    AND ads.status='completed'
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
  readonly code: string;

  constructor(message: string, code = "ARCHIVE_QUERY_INVALID") {
    super(message);
    this.name = "ArchiveLibraryQueryError";
    this.code = code;
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
  if (hasMediaId && (!Number.isInteger(parsedMediaId) || (parsedMediaId < 1 && parsedMediaId !== MANUAL_ARCHIVE_MEDIA_ID))) {
    throw new ArchiveLibraryQueryError("Invalid archive folder");
  }
  const mediaId = hasMediaId ? parsedMediaId : undefined;
  if (scope !== "global" && (!userId || !allowedUserIds.includes(userId))) {
    throw new ArchiveLibraryQueryError("Unknown archive account");
  }
  if (scope === "folder" && (!Number.isInteger(mediaId) || (Number(mediaId) < 1 && Number(mediaId) !== MANUAL_ARCHIVE_MEDIA_ID))) {
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

function projectionSearchSql(context: NormalizedContext, params: Record<string, unknown>, extraQuery = "") {
  const query = [context.query, extraQuery].filter(Boolean).join(" ").trim();
  if (!query) return "1=1";
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.map((term, index) => {
    params[`term${index}`] = `%${term.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    return `(
      lower(p.bvid) LIKE @term${index} ESCAPE '\\'
      OR p.title_key LIKE @term${index} ESCAPE '\\'
      OR p.upper_key LIKE @term${index} ESCAPE '\\'
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
    v: 2,
    h: contextHash(context, extraQuery),
    b: row.bvid,
    r: Number(row.recent_key || 0),
    t: String(row.title_key || ""),
    a: Number(row.active_key || 0),
    k: Number(row.order_known_key || 0),
    o: Number(row.order_key || 0),
  })).toString("base64url");
}

function decodeCursor(context: NormalizedContext, cursor: string | undefined, extraQuery = "") {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (![1, 2].includes(Number(parsed?.v)) || parsed?.h !== contextHash(context, extraQuery) || !parsed?.b) {
      throw new Error("mismatch");
    }
    const order = Number(parsed.o || 0);
    if (Number(parsed.v) === 1 && context.effectiveScope === "folder"
      && (!Number.isSafeInteger(order) || order < 0)) {
      throw new ArchiveLibraryQueryError("Archive cursor is stale", "ARCHIVE_CURSOR_STALE");
    }
    return {
      b: String(parsed.b),
      r: Number(parsed.r || 0),
      t: String(parsed.t || ""),
      a: Number(parsed.a || 0),
      k: Number(parsed.v) === 2 ? Number(parsed.k || 0) : 0,
      o: order,
    };
  } catch (error) {
    if (error instanceof ArchiveLibraryQueryError) throw error;
    throw new ArchiveLibraryQueryError("Invalid or stale archive cursor");
  }
}

function archiveOrderSql(context: NormalizedContext, reverse = false) {
  if (context.sort === "title_asc") return reverse ? "title_key DESC, bvid DESC" : "title_key ASC, bvid ASC";
  if (context.sort === "title_desc") return reverse ? "title_key ASC, bvid DESC" : "title_key DESC, bvid ASC";
  if (context.effectiveScope === "folder") {
    return reverse
      ? "active_key ASC, order_known_key DESC, order_key DESC, recent_key ASC, bvid DESC"
      : "active_key DESC, order_known_key ASC, order_key ASC, recent_key DESC, bvid ASC";
  }
  return reverse ? "recent_key ASC, bvid DESC" : "recent_key DESC, bvid ASC";
}

function rowCursor(row: CandidateKeyRow) {
  return {
    b: String(row.bvid),
    r: Number(row.recent_key || 0),
    t: String(row.title_key || ""),
    a: Number(row.active_key || 0),
    k: Number(row.order_known_key || 0),
    o: Number(row.order_key || 0),
  };
}

function orderAndCursorSql(
  context: NormalizedContext,
  cursor: ReturnType<typeof decodeCursor>,
  params: Record<string, unknown>,
  direction: "after" | "before" = "after"
) {
  if (!cursor) return { cursorSql: "1=1", orderSql: archiveOrderSql(context) };
  params.cursorBvid = cursor.b;
  params.cursorRecent = Number(cursor.r || 0);
  params.cursorTitle = String(cursor.t || "");
  params.cursorActive = Number(cursor.a || 0);
  params.cursorOrderKnown = Number(cursor.k || 0);
  params.cursorOrder = Number(cursor.o || 0);
  const before = direction === "before";
  if (context.sort === "title_asc") {
    return {
      cursorSql: before
        ? "(title_key<@cursorTitle OR (title_key=@cursorTitle AND bvid<@cursorBvid))"
        : "(title_key>@cursorTitle OR (title_key=@cursorTitle AND bvid>@cursorBvid))",
      orderSql: archiveOrderSql(context, before),
    };
  }
  if (context.sort === "title_desc") {
    return {
      cursorSql: before
        ? "(title_key>@cursorTitle OR (title_key=@cursorTitle AND bvid<@cursorBvid))"
        : "(title_key<@cursorTitle OR (title_key=@cursorTitle AND bvid>@cursorBvid))",
      orderSql: archiveOrderSql(context, before),
    };
  }
  if (context.effectiveScope === "folder") {
    return {
      cursorSql: before ? `(
          active_key>@cursorActive
          OR (active_key=@cursorActive AND order_known_key<@cursorOrderKnown)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key<@cursorOrder)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key=@cursorOrder AND recent_key>@cursorRecent)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key=@cursorOrder AND recent_key=@cursorRecent AND bvid<@cursorBvid)
        )` : `(
          active_key<@cursorActive
          OR (active_key=@cursorActive AND order_known_key>@cursorOrderKnown)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key>@cursorOrder)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key=@cursorOrder AND recent_key<@cursorRecent)
          OR (active_key=@cursorActive AND order_known_key=@cursorOrderKnown AND order_key=@cursorOrder AND recent_key=@cursorRecent AND bvid>@cursorBvid)
        )`,
      orderSql: archiveOrderSql(context, before),
    };
  }
  return {
    cursorSql: before
      ? "(recent_key>@cursorRecent OR (recent_key=@cursorRecent AND bvid<@cursorBvid))"
      : "(recent_key<@cursorRecent OR (recent_key=@cursorRecent AND bvid>@cursorBvid))",
    orderSql: archiveOrderSql(context, before),
  };
}

function candidateCte(context: NormalizedContext, params: Record<string, unknown>, extraQuery = "") {
  if (context.effectiveScope === "folder") {
    const scope = addScopeSql(context, "r", params);
    const search = searchSql(context, params, extraQuery);
    const deletion = context.filter === "deleted" ? deletionExistsSql("r") : `NOT (${deletionExistsSql("r")})`;
    return `
      WITH candidates AS (
        SELECT r.bvid,
          r.last_seen_at AS recent_key,
          ${displayTitleSql} AS title_key,
          r.active_in_favorite AS active_key,
          CASE WHEN r.active_in_favorite=1 AND typeof(r.fav_order)='integer'
            AND r.fav_order BETWEEN 0 AND 9007199254740991 THEN 0 ELSE 1 END AS order_known_key,
          CASE WHEN r.active_in_favorite=1 AND typeof(r.fav_order)='integer'
            AND r.fav_order BETWEEN 0 AND 9007199254740991 THEN r.fav_order ELSE 0 END AS order_key,
          CASE WHEN ${playableFileSql("r")} THEN 1 ELSE 0 END AS playable,
          CASE WHEN r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END AS pending
        FROM favorite_relations r
        JOIN videos v ON v.bvid=r.bvid
        WHERE ${scope} AND ${search} AND ${deletion}
      ), filtered AS (
        SELECT * FROM candidates WHERE ${filterSql(context.filter)}
      )
    `;
  }
  const projectionSearch = projectionSearchSql(context, params, extraQuery);
  params.projectionScopeType = context.effectiveScope === "account" ? "account" : "global";
  params.projectionScopeId = context.effectiveScope === "account" ? context.effectiveUserId : "";
  params.projectionVisibility = context.filter === "deleted" ? "deleted" : "normal";
  return `
    WITH candidates AS (
      SELECT p.bvid, p.recent_key, p.title_key,
        0 AS active_key, 0 AS order_known_key, 0 AS order_key,
        CASE WHEN p.status_group='playable' THEN 1 ELSE 0 END AS playable,
        CASE WHEN p.status_group='pending' THEN 1 ELSE 0 END AS pending
      FROM archive_library_projection p
      WHERE p.scope_type=@projectionScopeType AND p.scope_id=@projectionScopeId
        AND p.visibility=@projectionVisibility AND ${projectionSearch}
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
  let rows: CandidateKeyRow[];
  let summary: any = null;
  if (includeSummary && !cursor) {
    const combined = database.db.prepare(`
      ${cte}, page_rows AS (
        SELECT * FROM filtered WHERE ${cursorSql}
        ORDER BY ${orderSql}
        LIMIT @limit
      ), summary AS (
        SELECT COUNT(*) AS summary_total,
          COALESCE(SUM(CASE WHEN playable=1 THEN 1 ELSE 0 END),0) AS summary_playable,
          COALESCE(SUM(CASE WHEN playable=0 AND pending=1 THEN 1 ELSE 0 END),0) AS summary_pending,
          COALESCE(SUM(CASE WHEN playable=0 AND pending=0 THEN 1 ELSE 0 END),0) AS summary_issue
        FROM filtered
      )
      SELECT page_rows.*, summary.* FROM page_rows CROSS JOIN summary
    `).all(params) as Array<CandidateKeyRow & Record<string, number>>;
    rows = combined;
    const first = combined[0];
    summary = first ? {
      total: Number(first.summary_total || 0),
      playable: Number(first.summary_playable || 0),
      pending: Number(first.summary_pending || 0),
      issue: Number(first.summary_issue || 0),
    } : { total: 0, playable: 0, pending: 0, issue: 0 };
  } else {
    rows = database.db.prepare(`
      ${cte}
      SELECT * FROM filtered WHERE ${cursorSql}
      ORDER BY ${orderSql}
      LIMIT @limit
    `).all(params) as CandidateKeyRow[];
  }
  const hasMore = rows.length > context.pageSize;
  const pageRows = rows.slice(0, context.pageSize);
  return {
    rows: pageRows,
    hasMore,
    nextCursor: hasMore && pageRows.length ? encodeCursor(context, pageRows[pageRows.length - 1], extraQuery) : null,
    summary,
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
    WITH page(ord,bvid) AS (VALUES ${values}),
    page_sources AS (
      SELECT page.ord, r.user_id, r.media_id, r.bvid,
        r.active_in_favorite, r.fav_order, r.last_seen_at,
        r.payload_json AS relation_json, v.payload_json AS video_json
      FROM page
      JOIN favorite_relations r ON r.bvid=page.bvid
      JOIN videos v ON v.bvid=page.bvid
      WHERE ${scope} AND ${deletion}
    ), source_keys AS (
      SELECT DISTINCT user_id, media_id, bvid FROM page_sources
    ), ranked_deletions AS (
      SELECT ads.deletion_id, ads.user_id, ads.media_id, ads.bvid, ads.status,
        ads.file_count, ads.total_bytes,
        ROW_NUMBER() OVER (
          PARTITION BY ads.user_id, ads.media_id, ads.bvid
          ORDER BY COALESCE(ads.deleted_at,0) DESC, ads.rowid DESC
        ) AS rank
      FROM archive_deleted_sources ads
      JOIN source_keys keys
        ON keys.user_id=ads.user_id AND keys.media_id=ads.media_id AND keys.bvid=ads.bvid
      WHERE ads.status IN ('preparing','config_removing','pending','running','retry_wait','failed','completed')
    ), latest_deletion AS (
      SELECT * FROM ranked_deletions WHERE rank=1
    ), completed_deletions AS (
      SELECT ads.user_id, ads.media_id, ads.bvid, MAX(ads.deleted_at) AS deleted_at
      FROM archive_deleted_sources ads
      JOIN source_keys keys
        ON keys.user_id=ads.user_id AND keys.media_id=ads.media_id AND keys.bvid=ads.bvid
      WHERE ads.status='completed'
      GROUP BY ads.user_id, ads.media_id, ads.bvid
    ), remote_stats AS (
      SELECT rf.user_id, rf.media_id, rf.bvid, COUNT(*) AS file_count,
        COALESCE(SUM(rf.expected_size),0) AS total_bytes
      FROM remote_files rf
      JOIN source_keys keys
        ON keys.user_id=rf.user_id AND keys.media_id=rf.media_id AND keys.bvid=rf.bvid
      WHERE rf.status='verified'
      GROUP BY rf.user_id, rf.media_id, rf.bvid
    )
    SELECT source.ord, source.relation_json, source.video_json,
      deletion.deletion_id, deletion.status AS deletion_status, completed.deleted_at,
      CASE WHEN deletion.deletion_id IS NOT NULL THEN COALESCE(deletion.file_count,0)
        ELSE COALESCE(remote.file_count,0) END AS file_count,
      CASE WHEN deletion.deletion_id IS NOT NULL THEN COALESCE(deletion.total_bytes,0)
        ELSE COALESCE(remote.total_bytes,0) END AS total_bytes
    FROM page_sources source
    LEFT JOIN latest_deletion deletion
      ON deletion.user_id=source.user_id AND deletion.media_id=source.media_id AND deletion.bvid=source.bvid
    LEFT JOIN completed_deletions completed
      ON completed.user_id=source.user_id AND completed.media_id=source.media_id AND completed.bvid=source.bvid
    LEFT JOIN remote_stats remote
      ON remote.user_id=source.user_id AND remote.media_id=source.media_id AND remote.bvid=source.bvid
    ORDER BY source.ord,
      source.active_in_favorite DESC,
      CASE WHEN source.fav_order IS NULL THEN 1 ELSE 0 END,
      source.fav_order ASC,
      source.last_seen_at DESC,
      source.user_id,
      source.media_id
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
  const sourceKind = relation.sourceKind === "manual" ? "manual" : "favorite";
  const selectedFolder = sourceKind === "favorite" && selected.has(`${relation.userId}:${relation.mediaId}`);
  const ownerRemoved = Boolean(user?.archiveRemoved);
  const deletionInProgress = Boolean(record.deletionStatus && record.deletionStatus !== "completed");
  const alreadyDeleted = record.deletionStatus === "completed";
  const eligibleRelationship = sourceKind === "manual" || ownerRemoved || !selectedFolder || !relation.activeInFavorite;
  const deletable = !record.deletionStatus && record.fileCount > 0 && eligibleRelationship;
  const deletionReason = alreadyDeleted
    ? "该来源的远端归档已删除"
    : deletionInProgress
      ? "该来源正在清理或等待重试"
      : record.fileCount <= 0
        ? "该来源没有可删除的已验证归档文件"
      : deletable
        ? undefined
        : sourceKind === "manual"
          ? "手动归档来源"
          : "仍在同步，删除后会被重新归档";
  return {
    userId: relation.userId,
    userName: user?.name || "未知账号",
    mediaId: relation.mediaId,
    sourceKind,
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
  const hasCompletedDeletion = records.some((record) => record.deletionStatus === "completed");
  const statusGroup = hasCompletedDeletion ? "deleted" : best ? "playable" : hasPending ? "pending" : "issue";
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
    activeInFavorite: records.some(({ relation }) => relation.sourceKind !== "manual" && relation.activeInFavorite),
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
  options: {
    focusBvid?: string;
    page?: number;
    pageSize?: number;
    extraQuery?: string;
    cursor?: string;
    direction?: "after" | "before";
  }
): PlaybackQueuePage | null {
  const libraryUsers = archiveLibraryUsers(database, users);
  const context = normalizeQuery(libraryUsers, { ...input, filter: "playable", pageSize: options.pageSize || 50 });
  const focusBvid = String(options.focusBvid || "").trim();
  const extraQuery = options.extraQuery || "";
  const pageSize = context.pageSize;
  const baseParams: Record<string, unknown> = {};
  const cte = candidateCte(context, baseParams, extraQuery);
  const total = Number((database.db.prepare(`${cte} SELECT COUNT(*) AS count FROM filtered`).get(baseParams) as any)?.count || 0);
  if (total === 0) {
    return {
      mode: "library", page: 1, pageSize, total: 0, focusIndex: -1,
      hasPrevious: false, hasMore: false, previousCursor: null, nextCursor: null, items: [],
    };
  }

  const relativeRows = (
    cursor: ReturnType<typeof decodeCursor>,
    direction: "after" | "before",
    limit: number
  ) => {
    const queryParams = { ...baseParams, relativeLimit: limit };
    const relative = orderAndCursorSql(context, cursor, queryParams, direction);
    return database.db.prepare(`
      ${cte}
      SELECT * FROM filtered WHERE ${relative.cursorSql}
      ORDER BY ${relative.orderSql} LIMIT @relativeLimit
    `).all(queryParams) as CandidateKeyRow[];
  };

  let focusIndex = -1;
  let page = Math.max(1, Math.floor(Number(options.page || 1)));
  let keys: CandidateKeyRow[] = [];
  let hasPrevious = false;
  let hasMore = false;

  if (focusBvid) {
    const focus = database.db.prepare(`${cte} SELECT * FROM filtered WHERE bvid=@focusBvid`)
      .get({ ...baseParams, focusBvid }) as CandidateKeyRow | undefined;
    if (!focus) return null;
    const focusCursor = rowCursor(focus);
    const countParams = { ...baseParams };
    const before = orderAndCursorSql(context, focusCursor, countParams, "before");
    focusIndex = Number((database.db.prepare(`
      ${cte} SELECT COUNT(*) AS count FROM filtered WHERE ${before.cursorSql}
    `).get(countParams) as any)?.count || 0);
    page = Math.floor(focusIndex / pageSize) + 1;
    const beforeInPage = focusIndex % pageSize;
    const previousRows = beforeInPage > 0
      ? relativeRows(focusCursor, "before", beforeInPage).reverse()
      : [];
    const followingRows = relativeRows(focusCursor, "after", pageSize - previousRows.length - 1);
    keys = [...previousRows, focus, ...followingRows];
    hasPrevious = focusIndex - previousRows.length > 0;
    hasMore = page * pageSize < total;
  } else if (options.cursor) {
    const direction = options.direction === "before" ? "before" : "after";
    const cursor = decodeCursor(context, options.cursor, extraQuery);
    const rows = relativeRows(cursor, direction, pageSize + 1);
    if (direction === "before") {
      hasPrevious = rows.length > pageSize;
      keys = rows.slice(0, pageSize).reverse();
      hasMore = keys.length > 0;
    } else {
      hasMore = rows.length > pageSize;
      keys = rows.slice(0, pageSize);
      hasPrevious = page > 1;
    }
  } else if (page > 1) {
    const queryParams = { ...baseParams, limit: pageSize, offset: (page - 1) * pageSize };
    keys = database.db.prepare(`
      ${cte}
      SELECT * FROM filtered ORDER BY ${archiveOrderSql(context)} LIMIT @limit OFFSET @offset
    `).all(queryParams) as CandidateKeyRow[];
    hasPrevious = keys.length > 0;
    hasMore = page * pageSize < total;
  } else {
    const firstRows = relativeRows(null, "after", pageSize + 1);
    keys = firstRows.slice(0, pageSize);
    hasMore = firstRows.length > pageSize;
  }

  const offset = (page - 1) * pageSize;
  const records = hydrateRecords(database, context, keys.map((row) => row.bvid));
  const selected = choosePagePlaybackSources(database, records, keys.map((row) => row.bvid), offset);
  const items = keys.map((row) => selected.get(row.bvid) || null)
    .filter((item): item is PlaybackQueueItem => Boolean(item));
  return {
    mode: "library",
    page,
    pageSize,
    total,
    focusIndex,
    hasPrevious,
    hasMore,
    previousCursor: hasPrevious && keys.length ? encodeCursor(context, keys[0], extraQuery) : null,
    nextCursor: hasMore && keys.length ? encodeCursor(context, keys[keys.length - 1], extraQuery) : null,
    items,
  };
}

export function getArchiveLibraryPlaybackQueue(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: {
    focusBvid?: string;
    page?: number;
    pageSize?: number;
    cursor?: string;
    direction?: "after" | "before";
  }
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

const emptyNavigationSummary = () => ({ total: 0, playable: 0, pending: 0, issue: 0, deleted: 0 });

function readNavigationRows(database: StateDatabase, userIds: string[]) {
  if (userIds.length === 0) return [] as any[];
  const placeholders = userIds.map(() => "?").join(",");
  return database.db.prepare(`
    WITH relation_base AS MATERIALIZED (
      SELECT r.user_id, r.media_id, r.bvid, r.last_seen_at,
        CASE WHEN ${deletionExistsSql("r")} THEN 1 ELSE 0 END AS deleted,
        CASE WHEN ${playableFileSql("r")} THEN 1 ELSE 0 END AS raw_playable,
        CASE WHEN r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END AS raw_pending
      FROM favorite_relations r
      WHERE r.user_id IN (${placeholders})
    ), relation_flags AS MATERIALIZED (
      SELECT *,
        CASE WHEN deleted=0 THEN 1 ELSE 0 END AS visible,
        CASE WHEN deleted=0 AND raw_playable=1 THEN 1 ELSE 0 END AS playable,
        CASE WHEN deleted=0 AND raw_pending=1 THEN 1 ELSE 0 END AS pending
      FROM relation_base
    ), folder_summary AS (
      SELECT user_id, media_id, MAX(last_seen_at) AS last_seen_at,
        SUM(visible) AS total,
        SUM(playable) AS playable,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=1 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=0 THEN 1 ELSE 0 END) AS issue,
        SUM(deleted) AS deleted
      FROM relation_flags GROUP BY user_id, media_id
    ), account_bvid AS (
      SELECT user_id, bvid, MAX(visible) AS visible, MAX(playable) AS playable,
        MAX(pending) AS pending, MAX(deleted) AS deleted
      FROM relation_flags GROUP BY user_id, bvid
    ), account_summary AS (
      SELECT user_id, SUM(visible) AS total, SUM(playable) AS playable,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=1 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=0 THEN 1 ELSE 0 END) AS issue,
        SUM(deleted) AS deleted
      FROM account_bvid GROUP BY user_id
    ), global_bvid AS (
      SELECT bvid, MAX(visible) AS visible, MAX(playable) AS playable,
        MAX(pending) AS pending, MAX(deleted) AS deleted
      FROM account_bvid GROUP BY bvid
    ), global_summary AS (
      SELECT SUM(visible) AS total, SUM(playable) AS playable,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=1 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN visible=1 AND playable=0 AND pending=0 THEN 1 ELSE 0 END) AS issue,
        SUM(deleted) AS deleted
      FROM global_bvid
    )
    SELECT 'folder' AS row_kind, fs.user_id, fs.media_id, fs.last_seen_at,
      fs.total, fs.playable, fs.pending, fs.issue, fs.deleted,
      (SELECT rr.folder_title FROM favorite_relations rr
       WHERE rr.user_id=fs.user_id AND rr.media_id=fs.media_id
       ORDER BY rr.last_seen_at DESC, rr.bvid LIMIT 1) AS folder_title,
      (SELECT scans.updated_at FROM folder_scans scans
       WHERE scans.user_id=fs.user_id AND scans.media_id=fs.media_id) AS last_synced_at,
      (SELECT json_extract(vv.payload_json, '$.originalMeta.coverLocalPath')
       FROM favorite_relations rc JOIN videos vv ON vv.bvid=rc.bvid
       WHERE rc.user_id=fs.user_id AND rc.media_id=fs.media_id
         AND json_extract(vv.payload_json, '$.originalMeta.coverLocalPath') IS NOT NULL
       ORDER BY rc.last_seen_at DESC LIMIT 1) AS cover_local_path,
      (SELECT COALESCE(json_extract(vv.payload_json, '$.originalMeta.cover'), json_extract(vv.payload_json, '$.cover'))
       FROM favorite_relations rc JOIN videos vv ON vv.bvid=rc.bvid
       WHERE rc.user_id=fs.user_id AND rc.media_id=fs.media_id
       ORDER BY rc.last_seen_at DESC LIMIT 1) AS cover
    FROM folder_summary fs
    UNION ALL
    SELECT 'account', user_id, NULL, NULL, total, playable, pending, issue, deleted,
      NULL, NULL, NULL, NULL FROM account_summary
    UNION ALL
    SELECT 'global', NULL, NULL, NULL, total, playable, pending, issue, deleted,
      NULL, NULL, NULL, NULL FROM global_summary
  `).all(...userIds) as any[];
}

function navigationSummaryFromRow(row: any) {
  return row ? {
    total: Number(row.total || 0),
    playable: Number(row.playable || 0),
    pending: Number(row.pending || 0),
    issue: Number(row.issue || 0),
    deleted: Number(row.deleted || 0),
  } : emptyNavigationSummary();
}

function decorateNavigationSummary(summary: ReturnType<typeof navigationSummaryFromRow>, rows: any[]) {
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
  const navigationRows = readNavigationRows(database, userIds);
  const folderRows = navigationRows
    .filter((row) => row.row_kind === "folder")
    .sort((left, right) => String(left.user_id).localeCompare(String(right.user_id))
      || Number(right.last_seen_at || 0) - Number(left.last_seen_at || 0)
      || Number(left.media_id || 0) - Number(right.media_id || 0));
  const accountSummaries = new Map(navigationRows
    .filter((row) => row.row_kind === "account")
    .map((row) => [String(row.user_id), navigationSummaryFromRow(row)]));
  const globalSummary = navigationSummaryFromRow(navigationRows.find((row) => row.row_kind === "global"));
  const indexedFolders = new Map(folderRows.map((row) => [`${row.user_id}:${row.media_id}`, row]));
  const accountDeletionRows = userIds.length ? database.db.prepare(`
    SELECT id, user_id, status, file_count, total_bytes, completed_count, retained_count,
      conflict_count, failed_count, last_error, updated_at, completed_at
    FROM archive_deletions
    WHERE scope='account' AND user_id IN (${userIds.map(() => "?").join(",")})
      AND status IN ('preparing','config_removing','pending','running','retry_wait','failed','completed')
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
    const activeFolders: any[] = user.favorites.map((folder) => {
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
        sourceKind: "favorite" as const,
      };
    });
    const manualRow = indexedFolders.get(`${user.id}:${MANUAL_ARCHIVE_MEDIA_ID}`) as any;
    if (manualRow) {
      activeFolders.push({
        mediaId: MANUAL_ARCHIVE_MEDIA_ID,
        title: MANUAL_ARCHIVE_FOLDER_TITLE,
        selected: false,
        inactive: false,
        total: Number(manualRow.total || 0),
        playable: Number(manualRow.playable || 0),
        pending: Number(manualRow.pending || 0),
        issue: Number(manualRow.issue || 0),
        deleted: Number(manualRow.deleted || 0),
        lastSyncedAt: isoFromMs(manualRow.last_synced_at || manualRow.last_seen_at),
        coverLocalPath: manualRow.cover_local_path || undefined,
        cover: manualRow.cover || undefined,
        sourceKind: "manual" as const,
      });
    }
    const inactiveFolders = folderRows
      .filter((row) => row.user_id === user.id && Number(row.media_id) !== MANUAL_ARCHIVE_MEDIA_ID && !selected.has(`${user.id}:${row.media_id}`))
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
        sourceKind: "favorite" as const,
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
      summary: decorateNavigationSummary(accountSummaries.get(user.id) || emptyNavigationSummary(), accountRows),
      folders: activeFolders,
      inactiveFolders,
    };
  });
  return {
    summary: decorateNavigationSummary(globalSummary, folderRows),
    accounts: accountData,
  };
}
