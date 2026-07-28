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
export type ArchiveLibraryFilter = "all" | "playable" | "pending" | "issue";
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
}

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
    .replace(/\/(?:[^\s/]+\/){2,}[^\s]*/g, "[remote path]")
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
  if (!(["all", "playable", "pending", "issue"] as string[]).includes(rawFilter)) {
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
      WHERE ${scope} AND ${search}
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
  const values = bvids.map((bvid, index) => {
    params[`pageBvid${index}`] = bvid;
    return `(${index},@pageBvid${index})`;
  }).join(",");
  const rows = database.db.prepare(`
    WITH page(ord,bvid) AS (VALUES ${values})
    SELECT page.ord, r.payload_json AS relation_json, v.payload_json AS video_json
    FROM page
    JOIN favorite_relations r ON r.bvid=page.bvid
    JOIN videos v ON v.bvid=page.bvid
    WHERE ${scope}
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
    group.push({ relation, video });
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

function membershipFromRecord(record: HydratedRecord, users: Map<string, BiliUser>, selected: Set<string>, includeError: boolean): ArchiveLibraryMembership {
  const { relation, video } = record;
  const user = users.get(relation.userId);
  return {
    userId: relation.userId,
    userName: user?.name || "未知账号",
    mediaId: relation.mediaId,
    folderTitle: relation.folderTitle || `收藏夹 ${relation.mediaId}`,
    activeInFavorite: relation.activeInFavorite,
    selectedFolder: selected.has(`${relation.userId}:${relation.mediaId}`),
    backupStatus: (relation.backupStatus || video.backupStatus) as BackupStatus,
    lastSeenAt: relation.lastSeenAt,
    unavailable: relationUnavailable(relation, video),
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
  users: Map<string, BiliUser>,
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
  const statusGroup = best ? "playable" : hasPending ? "pending" : "issue";
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
  const context = normalizeQuery(users, input);
  const page = queryCandidatePage(database, context, input.cursor, options.extraQuery || "", options.includeSummary !== false);
  const records = hydrateRecords(database, context, page.rows.map((row) => row.bvid));
  const userMap = new Map(users.map((user) => [user.id, user]));
  const selected = selectionSet(users);
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
  const context = normalizeQuery(users, input);
  const params: Record<string, unknown> = {};
  const cte = candidateCte(context, params);
  params.detailBvid = bvid;
  const included = database.db.prepare(`${cte} SELECT 1 FROM filtered WHERE bvid=@detailBvid`).get(params);
  if (!included) return null;
  const records = hydrateRecords(database, context, [bvid]).get(bvid) || [];
  if (records.length === 0) return null;
  return itemFromRecords(database, records, new Map(users.map((user) => [user.id, user])), selectionSet(users), 1, true);
}

function playbackPageFromItems(
  database: StateDatabase,
  users: BiliUser[],
  input: Partial<ArchiveLibraryQuery>,
  options: { focusBvid?: string; page?: number; pageSize?: number; extraQuery?: string }
): PlaybackQueuePage | null {
  const context = normalizeQuery(users, { ...input, filter: "playable", pageSize: options.pageSize || 50 });
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
        MAX(CASE WHEN ${playableFileSql("r")} THEN 1 ELSE 0 END) AS playable,
        MAX(CASE WHEN r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END) AS pending
      FROM favorite_relations r
      WHERE ${where}
      GROUP BY r.bvid
    )
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN playable=1 THEN 1 ELSE 0 END),0) AS playable,
      COALESCE(SUM(CASE WHEN playable=0 AND pending=1 THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN playable=0 AND pending=0 THEN 1 ELSE 0 END),0) AS issue
    FROM classified
  `, params };
}

function readNavigationSummary(database: StateDatabase, userIds: string[], userId?: string) {
  const statement = navigationSummarySql(userIds, userId);
  if (!statement) return { total: 0, playable: 0, pending: 0, issue: 0 };
  const row = database.db.prepare(statement.sql).get(...statement.params) as any;
  return {
    total: Number(row?.total || 0),
    playable: Number(row?.playable || 0),
    pending: Number(row?.pending || 0),
    issue: Number(row?.issue || 0),
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
  const userIds = users.map((user) => user.id);
  const selected = selectionSet(users);
  const folderRows = userIds.length ? database.db.prepare(`
    SELECT r.user_id, r.media_id,
      MAX(r.last_seen_at) AS last_seen_at,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN ${playableFileSql("r")} THEN 1 ELSE 0 END),0) AS playable,
      COALESCE(SUM(CASE WHEN NOT (${playableFileSql("r")}) AND r.backup_status IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN NOT (${playableFileSql("r")}) AND r.backup_status NOT IN ('discovered','queued','downloading','downloaded','uploading','uploaded') THEN 1 ELSE 0 END),0) AS issue,
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
  const accountData = users.map((user) => {
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
