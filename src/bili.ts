import { normalizeTvAuthResult } from './bili-auth-response.js';
export { normalizeTvAuthResult } from './bili-auth-response.js';
import { Client, Auth, TvQrcodeLogin, utils } from "@renmu/bili-api";
import { BiliCookie, biliWebCookieValues } from "./users.js";
import { delay } from "./utils.js";
import { safeErrorSummary } from "./diagnostics.js";

export interface BiliUserInfo {
  uid: number;
  name: string;
  avatar?: string;
}

export interface FavoriteFolderInfo {
  mediaId: number;
  title: string;
  mediaCount: number;
  cover?: string;
}

export interface FavoriteItem {
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

export interface FavoriteItemsPage {
  items: FavoriteItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total?: number;
}

export type OnlineContentKind = "favorite" | "collected" | "bangumi" | "drama" | "watch_later" | "history";

export interface OnlineContentItem {
  id: string;
  kind: OnlineContentKind;
  bvid?: string;
  title: string;
  upperName?: string;
  upperMid?: number;
  cover?: string;
  duration?: number;
  publishedAt?: number;
  playable: boolean;
  openUrl?: string;
  rawType?: string;
}

export interface OnlineContentPage {
  items: OnlineContentItem[];
  kind: OnlineContentKind;
  page: number;
  pageSize: number;
  nextCursor?: string;
  hasMore: boolean;
  total?: number;
}

export class BiliRiskOrLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiliRiskOrLoginError";
  }
}

export class BiliFavoriteFolderResponseError extends Error {
  constructor() {
    super("B站收藏夹接口返回异常，请重试；如持续失败请重新登录。");
    this.name = "BiliFavoriteFolderResponseError";
  }
}

export class BiliResponseFormatError extends Error {
  constructor(field: string) {
    super(`Bili response field is invalid: ${field}`);
    this.name = "BiliResponseFormatError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstOptionalText(candidates: ReadonlyArray<readonly [unknown, string]>) {
  for (const [value, field] of candidates) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") throw new BiliResponseFormatError(field);
    return value.trim() || undefined;
  }
  return undefined;
}

function firstOptionalNumber(
  candidates: ReadonlyArray<readonly [unknown, string]>,
  options: { integer?: boolean; minimum?: number } = {},
) {
  for (const [value, field] of candidates) {
    if (value === undefined || value === null || value === 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value)
      || (options.integer && !Number.isSafeInteger(value))
      || (options.minimum !== undefined && value < options.minimum)) {
      throw new BiliResponseFormatError(field);
    }
    return value;
  }
  return undefined;
}

export function decodeBiliEnvelope(responseBody: unknown, scope = "response") {
  const response = record(responseBody);
  if (!isRecordValue(response.data)) throw new BiliResponseFormatError(`${scope}.envelope`);
  const envelope = response.data;
  if (typeof envelope.code !== "number" || !Number.isFinite(envelope.code)) throw new BiliResponseFormatError(`${scope}.code`);
  if (envelope.code !== 0) {
    const message = String(envelope.message || `Bili API returned code ${envelope.code}`);
    if (isRiskOrLoginApiError(envelope.code, message)) throw new BiliRiskOrLoginError(`Bili API code ${envelope.code}`);
    throw new Error(message);
  }
  if (!("data" in envelope)) throw new BiliResponseFormatError(`${scope}.data`);
  return envelope.data;
}

export function normalizeFavoriteFolderListResponse(value: unknown): Array<Record<string, unknown>> {
  const list = (value as { list?: unknown } | null | undefined)?.list;
  if (!Array.isArray(list)) throw new BiliFavoriteFolderResponseError();
  return list.map(record);
}

// ---------- helpers ----------

/** build a biliAPI Client from stored cookies — same pattern as biliLive-tools */
function createBiliClient(cookie: BiliCookie, uid: number, accessToken?: string) {
  const auth = new Auth();
  const cookieOnly = biliWebCookieValues(cookie);
  auth.setAuth(
    {
      ...cookieOnly,
      SESSDATA: String(cookieOnly.SESSDATA || ""),
      bili_jct: String(cookieOnly.bili_jct || ""),
    },
    uid,
    accessToken || undefined
  );
  return new Client(auth);
}

async function requestBiliJson(cookie: BiliCookie, url: string, referer = "https://www.bilibili.com/") {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  let responseBody: unknown;
  try {
    responseBody = await client.video.request.get(url, {
      headers: { referer },
      extra: { rawResponse: true },
    });
  } catch (error: unknown) {
    const value = record(error);
    const response = record(value.response);
    const statusCode = Number(value.statusCode || response.status || 0);
    const message = String(value.message || error);
    if (isRiskOrLoginStatus(statusCode) || isRiskOrLoginApiError(0, message)) {
      throw new BiliRiskOrLoginError(`Bili API error (status ${statusCode || "unknown"})`);
    }
    throw error;
  }
  return decodeBiliEnvelope(responseBody);
}

function onlineItemFromRaw(raw: unknown, kind: OnlineContentKind, index: number): OnlineContentItem {
  if (!isRecordValue(raw)) throw new BiliResponseFormatError(`${kind}.list[${index}]`);
  const source = record(raw);
  const consumedObjects = kind === "history"
    ? ["history", "season", "ogv_info", "owner", "upper"] as const
    : ["season", "ogv_info", "owner", "upper"] as const;
  for (const field of consumedObjects) {
    if (source[field] !== undefined && !isRecordValue(source[field])) throw new BiliResponseFormatError(`${kind}.list[${index}].${field}`);
  }
  const archive = kind === 'history' && source.history !== undefined ? record(source.history) : source;
  const season = record(source.season);
  const ogv = record(source.ogv_info);
  const upper = record(source.owner || archive.owner || source.upper);
  const rawBvid = source.bvid ?? archive.bvid;
  if (rawBvid !== undefined && typeof rawBvid !== "string") throw new BiliResponseFormatError(`${kind}.list[${index}].bvid`);
  const bvid = typeof rawBvid === "string" ? rawBvid.trim() || undefined : undefined;
  const itemPath = `${kind}.list[${index}]`;
  const positiveIdentity = (value: unknown, field: string): string => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
    throw new BiliResponseFormatError(`${itemPath}.${field}`);
  };
  let stableId: string | undefined;
  if (kind === 'watch_later') {
    // A legacy/unavailable video can retain AV identity without a playable BV.
    if (!bvid) stableId = positiveIdentity(archive.aid, 'aid');
  } else if (kind === 'collected') {
    stableId = positiveIdentity(source.id, 'id');
  } else if (kind === 'bangumi' || kind === 'drama') {
    stableId = positiveIdentity(source.season_id, 'season_id');
  } else if (kind === 'history') {
    const history = source.history === undefined ? source : record(source.history);
    if (!bvid) stableId = positiveIdentity(history.oid, 'history.oid');
    if (history.business !== undefined && typeof history.business !== 'string') throw new BiliResponseFormatError(`${itemPath}.history.business`);
  }
  const rawUrl = source.uri ?? source.url ?? source.link;
  if (rawUrl !== undefined && typeof rawUrl !== "string") throw new BiliResponseFormatError(`${kind}.list[${index}].url`);
  const identity = bvid || stableId;
  if (!identity) throw new BiliResponseFormatError(`${kind}.list[${index}].identity`);
  const id = bvid || `${kind}-${identity}`;
  const rawTitle = source.title ?? archive.title;
  if (typeof rawTitle !== "string") throw new BiliResponseFormatError(`${kind}.list[${index}].title`);
  const title = rawTitle.trim() || id;
  const cover = firstOptionalText([
    [source.pic, `${itemPath}.pic`], [source.cover, `${itemPath}.cover`],
    [archive.pic, `${itemPath}.archive.pic`], [archive.cover, `${itemPath}.archive.cover`],
    [season.cover, `${itemPath}.season.cover`], [ogv.cover, `${itemPath}.ogv_info.cover`],
  ]);
  const upperName = firstOptionalText([
    [upper.name, `${itemPath}.owner.name`], [source.author, `${itemPath}.author`], [source.up_name, `${itemPath}.up_name`], [source.author_name, `${itemPath}.author_name`],
  ]);
  const upperMid = firstOptionalNumber([
    [upper.mid, `${itemPath}.owner.mid`], [source.mid, `${itemPath}.mid`], [source.up_mid, `${itemPath}.up_mid`], [source.author_mid, `${itemPath}.author_mid`],
  ], { integer: true, minimum: 0 });
  const duration = firstOptionalNumber([
    [source.duration, `${itemPath}.duration`], [archive.duration, `${itemPath}.archive.duration`],
  ], { minimum: 0 });
  const publishedSeconds = firstOptionalNumber([
    [source.pubdate, `${itemPath}.pubdate`], [archive.pubdate, `${itemPath}.archive.pubdate`], [source.ctime, `${itemPath}.ctime`],
  ], { minimum: 0 });
  const publishedAt = publishedSeconds && publishedSeconds > 0 ? publishedSeconds * 1000 : undefined;
  const seasonId = kind === 'bangumi' || kind === 'drama' ? stableId : undefined;
  const episodeId = kind === 'bangumi' || kind === 'drama' ? firstOptionalNumber([
    [source.ep_id, `${itemPath}.ep_id`], [source.epid, `${itemPath}.epid`], [source.episode_id, `${itemPath}.episode_id`],
  ], {integer: true, minimum: 0}) : undefined;
  const collectionId = kind === 'collected' ? stableId : undefined;
  const collectionMid = kind === 'collected' ? upperMid : undefined;
  const safeRawUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
  let openUrl: string | undefined;
  if (bvid) {
    openUrl = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
  } else if (episodeId) {
    openUrl = `https://www.bilibili.com/bangumi/play/ep${episodeId}`;
  } else if (seasonId) {
    openUrl = `https://www.bilibili.com/bangumi/play/ss${seasonId}`;
  } else if (kind === "collected" && collectionId && collectionMid) {
    openUrl = `https://space.bilibili.com/${collectionMid}/lists/${collectionId}?type=season`;
  } else {
    try {
      const candidate = new URL(safeRawUrl);
      if (candidate.protocol === "https:" && ["bilibili.com", "www.bilibili.com", "space.bilibili.com", "m.bilibili.com"].includes(candidate.hostname)) {
        candidate.username = "";
        candidate.password = "";
        openUrl = candidate.toString();
      }
    } catch {
      openUrl = undefined;
    }
  }
  return {
    id,
    kind,
    bvid,
    title: title || id,
    upperName,
    upperMid,
    cover,
    duration,
    publishedAt,
    playable: Boolean(bvid),
    openUrl,
    rawType: typeof archive.business === 'string' ? archive.business : kind,
  };
}

async function signedQuery(params: URLSearchParams) {
  return utils.WbiSign(Object.fromEntries(params.entries()));
}

export function normalizeOnlineContentPageSize(
  kind: OnlineContentKind,
  requested: unknown,
  hasQuery = false,
) {
  const value = Math.max(1, Math.floor(Number(requested || 50)));
  const limit = kind === "favorite"
    ? 40
    : kind === "bangumi" || kind === "drama"
      ? 30
      : kind === "history"
        ? (hasQuery ? 20 : 30)
        : 50;
  return Math.min(limit, value);
}

export function encodeHistoryCursor(cursor: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({
    max: Number(cursor.max || 0) || 0,
    viewAt: Number(cursor.view_at ?? cursor.viewAt ?? 0) || 0,
    business: String(cursor.business ?? ""),
  }), "utf8").toString("base64url");
}

export function decodeHistoryCursor(value: string | undefined) {
  if (!value) return { max: 0, view_at: 0, business: "" };
  try {
    const parsedValue: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) throw new Error("invalid history cursor");
    const parsed = record(parsedValue);
    return {
      max: Number(parsed.max || 0) || 0,
      view_at: Number(parsed.viewAt ?? parsed.view_at ?? 0) || 0,
      business: String(parsed.business ?? "").slice(0, 32),
    };
  } catch {
    throw new Error("在线历史游标无效，请重新加载");
  }
}

function optionalNonNegativeInteger(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new BiliResponseFormatError(field);
  return value;
}

export function decodeOnlineContentPage(
  data: unknown,
  kind: Exclude<OnlineContentKind, "favorite">,
  page: number,
  pageSize: number,
): OnlineContentPage {
  if (!isRecordValue(data)) throw new BiliResponseFormatError(`${kind}.data`);
  // The collected-folder endpoint documents null specifically for zero folders.
  const list = kind === 'collected' && data.list === null && data.count === 0 ? [] : data.list;
  if (!Array.isArray(list)) throw new BiliResponseFormatError(`${kind}.list`);
  const items = list.map((raw, index) => onlineItemFromRaw(raw, kind, index));
  const totalField = kind === 'collected' || kind === 'watch_later' ? 'count' : 'total';
  let total = optionalNonNegativeInteger(data[totalField], `${kind}.${totalField}`);
  if (kind === 'history' && data.page !== undefined) {
    if (!isRecordValue(data.page)) throw new BiliResponseFormatError('history.page');
    total = optionalNonNegativeInteger(data.page.count, 'history.page.count');
    if (total === undefined) throw new BiliResponseFormatError('history.page.count');
  }
  const rawHasMore = data.has_more !== undefined ? data.has_more : data.hasMore;
  if (rawHasMore !== undefined && rawHasMore !== true && rawHasMore !== false && rawHasMore !== 0 && rawHasMore !== 1) {
    throw new BiliResponseFormatError(`${kind}.has_more`);
  }
  let nextCursor: string | undefined;
  if (kind === 'history' && data.cursor !== undefined) {
    if (!isRecordValue(data.cursor)) throw new BiliResponseFormatError(`${kind}.cursor`);
    const cursor = data.cursor;
    if (optionalNonNegativeInteger(cursor.max, `${kind}.cursor.max`) === undefined) throw new BiliResponseFormatError(`${kind}.cursor.max`);
    if (optionalNonNegativeInteger(cursor.view_at, `${kind}.cursor.view_at`) === undefined) throw new BiliResponseFormatError(`${kind}.cursor.view_at`);
    if (cursor.business !== undefined && typeof cursor.business !== "string") throw new BiliResponseFormatError(`${kind}.cursor.business`);
    nextCursor = items.length > 0 ? encodeHistoryCursor(cursor) : undefined;
  } else if (data.next_cursor !== undefined && data.next_cursor !== null) {
    if (typeof data.next_cursor !== "string" && typeof data.next_cursor !== "number") throw new BiliResponseFormatError(`${kind}.next_cursor`);
    nextCursor = String(data.next_cursor).trim() || undefined;
  }
  if (rawHasMore === undefined && nextCursor === undefined && total === undefined) {
    // An empty history cursor page is the terminal page. Other endpoints need
    // their documented count or explicit continuation flag, not a guessed end.
    if (!(kind === 'history' && data.cursor !== undefined && items.length === 0)) throw new BiliResponseFormatError(`${kind}.pagination`);
  }
  const hasMore = rawHasMore !== undefined
    ? Boolean(rawHasMore)
    : nextCursor !== undefined || (total !== undefined && page * pageSize < total);
  return { items, kind, page, pageSize, nextCursor, hasMore, total };
}

export async function listOnlineContentPage(
  cookie: BiliCookie,
  kind: OnlineContentKind,
  options: { mediaId?: number; page?: number; pageSize?: number; cursor?: string; query?: string } = {}
): Promise<OnlineContentPage> {
  const page = Math.max(1, Math.floor(Number(options.page || 1)));
  const query = String(options.query || "").trim();
  const pageSize = normalizeOnlineContentPageSize(kind, options.pageSize, Boolean(query));
  if (kind === "favorite") {
    if (!Number.isInteger(options.mediaId) || Number(options.mediaId) < 1) throw new Error("favorite mediaId is required");
    const result = await listFavoriteItemsPage(cookie, Number(options.mediaId), page, pageSize);
    return {
      items: result.items.map((item) => ({
        id: item.bvid,
        kind,
        bvid: item.bvid,
        title: item.title,
        upperName: item.upperName,
        upperMid: item.upperMid,
        cover: item.cover,
        playable: true,
      })),
      kind,
      page,
      pageSize,
      hasMore: result.hasMore,
      total: result.total,
    };
  }
  const uid = Number(cookie.DedeUserID || 0);
  const params = new URLSearchParams({ pn: String(page), ps: String(pageSize), web_location: "333.1387" });
  let url: string;
  if (kind === "collected") {
    params.set("up_mid", String(uid));
    params.set("platform", "web");
    url = `https://api.bilibili.com/x/v3/fav/folder/collected/list?${params}`;
  } else if (kind === "bangumi" || kind === "drama") {
    params.set("vmid", String(uid));
    params.set("type", kind === "bangumi" ? "1" : "2");
    params.set("follow_status", "0");
    url = `https://api.bilibili.com/x/space/bangumi/follow/list?${await signedQuery(params)}`;
  } else if (kind === "watch_later") {
    params.set("viewed", "0");
    params.set("asc", "0");
    params.set("need_split", "1");
    url = `https://api.bilibili.com/x/v2/history/toview/web?${await signedQuery(params)}`;
  } else {
    if (query) {
      params.set("keyword", query);
      params.set("business", "archive");
      params.set("add_time_start", "0");
      params.set("add_time_end", "0");
      params.set("arc_max_duration", "0");
      params.set("arc_min_duration", "0");
      params.set("device_type", "0");
      params.set("web_location", "333.1391");
      url = `https://api.bilibili.com/x/web-interface/history/search?${params}`;
    } else {
      const cursor = decodeHistoryCursor(options.cursor);
      params.set("max", String(cursor.max));
      params.set("view_at", String(cursor.view_at));
      params.set("business", cursor.business);
      url = `https://api.bilibili.com/x/web-interface/history/cursor?${params}`;
    }
  }
  const data = await requestBiliJson(cookie, url);
  return decodeOnlineContentPage(data, kind, page, pageSize);
}

export interface NormalizedTvAuth {
  rawAuth: string;
  cookie: BiliCookie;
  accessToken: string;
  refreshToken: string;
  expires: number;
  uid?: number;
}

export class BiliAuthRefreshError extends Error {
  readonly originalError: unknown;
  readonly status?: number;
  readonly code?: string;

  constructor(originalError: unknown) {
    super("B站授权刷新请求失败");
    this.name = "BiliAuthRefreshError";
    this.originalError = originalError;
    const source = record(originalError);
    const response = record(source.response);
    const status = Number(source.status || source.statusCode || response.status || 0);
    this.status = status > 0 ? status : undefined;
    this.code = typeof source.code === "string" ? source.code : undefined;
  }
}

// ---------- core API ----------

function isRiskOrLoginStatus(statusCode: number) {
  return [401, 403, 406, 412, 429, 509].includes(statusCode);
}

function isRiskOrLoginApiError(apiCode: number, message: string) {
  if ([-101, -102, -111, -352, -403, -412, -509, -653].includes(apiCode)) {
    return true;
  }
  return /cookie|登录|登陆|鉴权|csrf|sessdata|风控|验证|访问权限|账号异常|请求被拦截|risk/i.test(message);
}

export async function getUserInfo(cookie: BiliCookie): Promise<BiliUserInfo> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  const res = await client.user.getMyInfo();
  return {
    uid: res.profile?.mid || Number(cookie.DedeUserID),
    name: res.profile?.name || "Unknown",
    avatar: res.profile?.face || undefined,
  };
}

export async function listFavoriteFolders(cookie: BiliCookie): Promise<FavoriteFolderInfo[]> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  const res = await client.video.listFavoriteBox({ aid: 0, type: 2 });
  const list = normalizeFavoriteFolderListResponse(res);
  return list.map((item) => ({
    mediaId: Number(item.id || 0),
    title: String(item.title || ""),
    mediaCount: Number(item.media_count || 0),
    cover: typeof item.cover === "string" ? item.cover : undefined,
  }));
}

/**
 * The folder list endpoint does not consistently include a cover URL. Bilibili's
 * folder metadata endpoint is the authoritative, lightweight fallback used by
 * clients such as Bili23 for lazy cover loading.
 */
export async function getFavoriteFolderCover(cookie: BiliCookie, mediaId: number): Promise<string | undefined> {
  if (!Number.isInteger(mediaId) || mediaId < 1) {
    throw new Error("favorite mediaId is invalid");
  }
  const params = new URLSearchParams({ media_id: String(mediaId) });
  const data = await requestBiliJson(
    cookie,
    `https://api.bilibili.com/x/v3/fav/folder/info?${params.toString()}`,
  );
  const cover = typeof record(data).cover === "string" ? String(record(data).cover).trim() : "";
  return cover || undefined;
}

export function decodeFavoriteItemsPage(data: unknown, page: number, pageSize: number): FavoriteItemsPage {
  if (!isRecordValue(data)) throw new BiliResponseFormatError("favorite.data");
  if (!Array.isArray(data.medias)) throw new BiliResponseFormatError("favorite.medias");
  const items = data.medias.map((value, index) => {
    if (!isRecordValue(value) || typeof value.bvid !== "string" || !value.bvid.trim()) {
      throw new BiliResponseFormatError(`favorite.medias[${index}].bvid`);
    }
    if (value.title !== undefined && typeof value.title !== "string") throw new BiliResponseFormatError(`favorite.medias[${index}].title`);
    if (value.upper !== undefined && !isRecordValue(value.upper)) throw new BiliResponseFormatError(`favorite.medias[${index}].upper`);
    const upper = record(value.upper);
    if (upper.name !== undefined && typeof upper.name !== "string") throw new BiliResponseFormatError(`favorite.medias[${index}].upper.name`);
    if (upper.mid !== undefined && (typeof upper.mid !== "number" || !Number.isSafeInteger(upper.mid) || upper.mid < 0)) {
      throw new BiliResponseFormatError(`favorite.medias[${index}].upper.mid`);
    }
    if (value.cover !== undefined && typeof value.cover !== "string") throw new BiliResponseFormatError(`favorite.medias[${index}].cover`);
    if (value.attr !== undefined && (typeof value.attr !== "number" || !Number.isFinite(value.attr))) {
      throw new BiliResponseFormatError(`favorite.medias[${index}].attr`);
    }
    return {
      bvid: value.bvid.trim(),
      title: typeof value.title === "string" && value.title.trim() ? value.title : "Untitled",
      upperName: typeof upper.name === "string" && upper.name.trim() ? upper.name : "Unknown",
      upperMid: typeof upper.mid === "number" && upper.mid > 0 ? upper.mid : undefined,
      cover: typeof value.cover === "string" ? value.cover : undefined,
      unavailable: value.attr !== undefined && value.attr !== 0,
    };
  });
  if (data.info !== undefined && !isRecordValue(data.info)) throw new BiliResponseFormatError("favorite.info");
  const total = optionalNonNegativeInteger(record(data.info).media_count, "favorite.info.media_count");
  const rawHasMore = data.has_more;
  if (rawHasMore !== undefined && rawHasMore !== true && rawHasMore !== false && rawHasMore !== 0 && rawHasMore !== 1) {
    throw new BiliResponseFormatError("favorite.has_more");
  }
  if (rawHasMore === undefined && total === undefined) throw new BiliResponseFormatError('favorite.pagination');
  const hasMore = rawHasMore === 1 || rawHasMore === true
    ? true
    : rawHasMore === 0 || rawHasMore === false
      ? false
      : total !== undefined && page * pageSize < total;
  return { items, page, pageSize, hasMore, total };
}

export async function listFavoriteItemsPage(
  cookie: BiliCookie,
  mediaId: number,
  page = 1,
  pageSize = 20
): Promise<FavoriteItemsPage> {
  const clientAccess = String(cookie.accessToken || "");
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), clientAccess);

  // Build URL with params directly (biliAPI's axios doesn't support { params } well)
  const params = new URLSearchParams({
    media_id: String(mediaId),
    pn: String(page),
    ps: String(pageSize),
    order: "fav_time",
    order_type: "0",
    type: "2",
    tid: "0",
    platform: "web",
  });
  const url = `https://api.bilibili.com/x/v3/fav/resource/list?${params.toString()}`;

  let responseBody: unknown;
  try {
    responseBody = await client.video.request.get(url, {
      headers: { referer: "https://www.bilibili.com/" },
      extra: { rawResponse: true },
    });
  } catch (error: unknown) {
    const value = record(error);
    const response = record(value.response);
    const statusCode = value.statusCode || response.status;
    const errMsg = value.message || String(error);
    if (isRiskOrLoginStatus(Number(statusCode || 0)) || isRiskOrLoginApiError(0, String(errMsg))) {
      throw new BiliRiskOrLoginError(
        `Bili API error (status ${statusCode || "unknown"}): ${errMsg}`
      );
    }
    throw error;
  }

  return decodeFavoriteItemsPage(decodeBiliEnvelope(responseBody, "favorite"), page, pageSize);
}

export interface VideoPageSnapshotResult {
  interactive?: boolean;
  available: boolean;
  /** The API-level availability result. `available` remains for old callers. */
  availability?: "available" | "unavailable" | "unknown";
  availabilityReason?:
    | "api_not_found"
    | "submission_invisible"
    | "under_review"
    | "uploader_only"
    | "favorite_unavailable"
    | "empty_response"
    | "temporary_error";
  apiCodes?: number[];
  title?: string;
  upperName?: string;
  publishedAt?: number;
  access: VideoAccessSnapshot;
  pages: Array<{
    index: number;
    cid: number;
    title: string;
    duration: number;
    publishedAt?: number;
  }>;
}

export type VideoAccessClassification =
  | "normal"
  | "charging_allowed"
  | "charging_restricted"
  | "unknown";

export interface VideoAccessSnapshot {
  classification: VideoAccessClassification;
  isUPowerExclusive?: boolean;
  isUPowerPlay?: boolean;
  isUgcPayPreview?: boolean;
  previewAvailable?: boolean;
  exclusiveWithQa?: boolean;
  source: "view_detail" | "view" | "player" | "unknown";
}

export type VideoPageAvailability = "available" | "unavailable" | "unknown";
export type VideoPageAvailabilityReason = NonNullable<VideoPageSnapshotResult["availabilityReason"]>;

export interface VideoPageEndpointObservation {
  availability: VideoPageAvailability;
  reason: VideoPageAvailabilityReason;
  apiCode?: number;
}

const DEFINITIVE_UNAVAILABLE_API_CODES = new Set([-404, 62002]);

/**
 * Combine the two public detail endpoints without treating an arbitrary API
 * error as proof that a video was deleted. This is intentionally pure so the
 * recovery state machine can be tested without contacting Bilibili.
 */
export function classifyVideoPageAvailability(
  observations: VideoPageEndpointObservation[]
): { availability: VideoPageAvailability; reason?: VideoPageAvailabilityReason; apiCodes: number[] } {
  const apiCodes = [...new Set(observations
    .map((observation) => observation.apiCode)
    .filter((code): code is number => Number.isFinite(code)))];
  if (observations.some((observation) => observation.availability === "available")) {
    return { availability: "available", apiCodes };
  }
  if (observations.some((observation) => observation.availability === "unknown")) {
    const unknown = observations.filter((observation) => observation.availability === "unknown");
    const explicit = unknown[0]?.reason;
    const reason = (explicit === "under_review" || explicit === "uploader_only")
      && unknown.every((observation) => observation.reason === explicit)
      ? explicit
      : observations.some((observation) => observation.reason === "empty_response")
      ? "empty_response"
      : "temporary_error";
    return { availability: "unknown", reason, apiCodes };
  }
  if (observations.length > 0 && observations.every((observation) => observation.availability === "unavailable")) {
    const reason = observations.some((observation) => observation.reason === "submission_invisible")
      ? "submission_invisible"
      : "api_not_found";
    return { availability: "unavailable", reason, apiCodes };
  }
  return { availability: "unknown", reason: "temporary_error", apiCodes };
}

interface VideoAccessFields {
  is_upower_exclusive?: boolean;
  is_upower_play?: boolean;
  is_ugc_pay_preview?: boolean;
  is_upower_preview?: boolean;
  is_upower_exclusive_with_qa?: boolean;
}

function decodeVideoAccessFields(value: unknown): VideoAccessFields | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BiliResponseFormatError("video_access");
  }
  const input = record(value);
  const keys = [
    "is_upower_exclusive", "is_upower_play", "is_ugc_pay_preview",
    "is_upower_preview", "is_upower_exclusive_with_qa",
  ] as const;
  for (const key of keys) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new BiliResponseFormatError(key);
    }
  }
  return {
    ...(typeof input.is_upower_exclusive === "boolean" ? { is_upower_exclusive: input.is_upower_exclusive } : {}),
    ...(typeof input.is_upower_play === "boolean" ? { is_upower_play: input.is_upower_play } : {}),
    ...(typeof input.is_ugc_pay_preview === "boolean" ? { is_ugc_pay_preview: input.is_ugc_pay_preview } : {}),
    ...(typeof input.is_upower_preview === "boolean" ? { is_upower_preview: input.is_upower_preview } : {}),
    ...(typeof input.is_upower_exclusive_with_qa === "boolean" ? { is_upower_exclusive_with_qa: input.is_upower_exclusive_with_qa } : {}),
  };
}

function decodePlayerInfoResponse(value: unknown): VideoAccessFields {
  const decoded = decodeVideoAccessFields(value);
  if (!decoded) throw new BiliResponseFormatError("player_info");
  return decoded;
}

export function classifyVideoAccess(
  value: unknown,
  source: VideoAccessSnapshot["source"] = "unknown"
): VideoAccessSnapshot {
  const decoded = decodeVideoAccessFields(value);
  const isUPowerExclusive = decoded?.is_upower_exclusive;
  const isUPowerPlay = decoded?.is_upower_play;
  const previewAvailable = decoded?.is_upower_preview;
  const isUgcPayPreview = decoded?.is_ugc_pay_preview;
  const exclusiveWithQa = decoded?.is_upower_exclusive_with_qa;
  let classification: VideoAccessClassification = "unknown";
  if (isUPowerExclusive === false) classification = "normal";
  else if (isUPowerExclusive === true && isUPowerPlay === true) classification = "charging_allowed";
  else if (isUPowerExclusive === true && isUPowerPlay === false) classification = "charging_restricted";
  return {
    classification,
    isUPowerExclusive,
    isUPowerPlay,
    isUgcPayPreview,
    previewAvailable,
    exclusiveWithQa,
    source,
  };
}

async function resolveVideoAccessFallback(
  client: ReturnType<typeof createBiliClient>,
  bvid: string,
  cid: number,
  current: VideoAccessSnapshot
) {
  if (current.classification !== "unknown" || cid <= 0) return current;
  try {
    const player = decodePlayerInfoResponse(await client.video.playerInfo({ bvid, cid }) as unknown);
    const fallback = classifyVideoAccess(player, "player");
    return fallback.classification === "unknown" ? current : fallback;
  } catch (error: unknown) {
    if (error instanceof BiliResponseFormatError) throw error;
    const value = record(error);
    const response = record(value.response);
    const responseData = record(response.data);
    const statusCode = Number(value.statusCode || response.status || 0);
    const apiCode = Number(value.code || responseData.code || 0);
    const message = String(value.message || error);
    if (isRiskOrLoginStatus(statusCode) || isRiskOrLoginApiError(apiCode, message)) {
      throw new BiliRiskOrLoginError(`Bili player API error (status ${statusCode || "unknown"}): ${message}`);
    }
    return current;
  }
}

export async function resolveSelfVisibleFavoriteItem(
  cookie: BiliCookie,
  userUid: number,
  item: FavoriteItem
): Promise<FavoriteItem> {
  const expectedOwnerMid = Number(userUid || 0);
  if (!item.unavailable || !expectedOwnerMid || Number(item.upperMid || 0) !== expectedOwnerMid) {
    return item;
  }

  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  const bvid = encodeURIComponent(item.bvid);
  const detailUrls = [
    `https://api.bilibili.com/x/web-interface/view/detail?bvid=${bvid}`,
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
  ];

  for (const url of detailUrls) {
    let responseBody: unknown;
    try {
      responseBody = await client.video.request.get(url, {
        headers: { referer: `https://www.bilibili.com/video/${item.bvid}/` },
        extra: { rawResponse: true },
      });
    } catch (error: unknown) {
      const value = record(error);
      const response = record(value.response);
      const statusCode = value.statusCode || response.status;
      const errMsg = value.message || String(error);
      if (isRiskOrLoginStatus(Number(statusCode || 0)) || isRiskOrLoginApiError(0, String(errMsg))) {
        return item;
      }
      continue;
    }

    const body = record(record(responseBody).data);
    const apiCode = Number(body.code ?? 0);
    if (apiCode !== 0) {
      const msg = String(body.message || `Bili API returned code ${apiCode}`);
      if (isRiskOrLoginApiError(apiCode, msg)) {
        return item;
      }
      continue;
    }

    const data = record(body.data);
    const view = record(data.View || data);
    const ownerMid = Number(record(view.owner).mid || 0);
    if (!view || ownerMid !== expectedOwnerMid) {
      continue;
    }

    const title = typeof view.title === "string" && view.title.trim() ? view.title.trim() : item.title;
    const owner = record(view.owner);
    const upperName = typeof owner.name === "string" && owner.name.trim()
      ? owner.name.trim()
      : item.upperName;
    const cover = typeof view.pic === "string" && view.pic.trim() ? view.pic.trim() : item.cover;
    const description = typeof view.desc === "string" ? view.desc : item.description;

    return {
      ...item,
      title,
      upperName,
      upperMid: ownerMid,
      cover,
      description,
      unavailable: false,
      favoriteUnavailable: true,
      selfVisible: true,
    };
  }

  return item;
}

export async function getVideoPageSnapshot(
  cookie: BiliCookie,
  bvidValue: string
): Promise<VideoPageSnapshotResult> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  const bvid = encodeURIComponent(bvidValue);
  const urls = [
    `https://api.bilibili.com/x/web-interface/view/detail?bvid=${bvid}`,
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
  ];
  const observations: VideoPageEndpointObservation[] = [];
  for (const [urlIndex, url] of urls.entries()) {
    let responseBody: unknown;
    try {
      responseBody = await client.video.request.get(url, {
        headers: { referer: `https://www.bilibili.com/video/${bvidValue}/` },
        extra: { rawResponse: true },
      });
    } catch (error: unknown) {
      const value = record(error);
      const response = record(value.response);
      const statusCode = Number(value.statusCode || response.status || 0);
      const message = value.message || String(error);
      if (isRiskOrLoginStatus(statusCode) || isRiskOrLoginApiError(0, String(message))) {
        throw new BiliRiskOrLoginError(`Bili API error (status ${statusCode || "unknown"}): ${message}`);
      }
      observations.push({ availability: "unknown", reason: "temporary_error" });
      continue;
    }

    const body = record(record(responseBody).data);
    const apiCode = Number(body.code ?? 0);
    if (apiCode !== 0) {
      const message = String(body.message || `Bili API returned code ${apiCode}`);
      if (isRiskOrLoginApiError(apiCode, message)) {
        throw new BiliRiskOrLoginError(`Bili API code ${apiCode}: ${message}`);
      }
      observations.push({
        availability: DEFINITIVE_UNAVAILABLE_API_CODES.has(apiCode) ? "unavailable" : "unknown",
        reason: apiCode === 62002 ? "submission_invisible" : apiCode === -404 ? "api_not_found"
          : apiCode === 62004 ? "under_review" : apiCode === 62012 ? "uploader_only" : "temporary_error",
        apiCode,
      });
      continue;
    }
    const data = record(body.data);
    const view = record(data.View || data);
    if (!view) {
      observations.push({ availability: "unknown", reason: "empty_response", apiCode });
      continue;
    }
    const access = await resolveVideoAccessFallback(
      client,
      bvidValue,
      Number(view.cid || 0),
      classifyVideoAccess(view, urlIndex === 0 ? "view_detail" : "view")
    );
    const rawPages = Array.isArray(view.pages) ? view.pages : [];
    const pages = rawPages
      .map((rawPage, offset: number) => {
        const page = record(rawPage);
        return {
        index: Number(page.page || offset + 1),
        cid: Number(page.cid || 0),
        title: String(page.part || page.title || `P${offset + 1}`),
        duration: Number(page.duration || 0),
        publishedAt: Number(page.ctime || page.pubdate || view.pubdate || 0) > 0
          ? Number(page.ctime || page.pubdate || view.pubdate) * 1000
          : undefined,
        };
      })
      .filter((page: { index: number; cid: number }) => page.index > 0 && page.cid > 0);
    if (pages.length === 0 && Number(view.cid || 0) > 0) {
      pages.push({
        index: 1,
        cid: Number(view.cid),
        title: String(view.title || bvidValue),
        duration: Number(view.duration || 0),
        publishedAt: Number(view.pubdate || 0) > 0 ? Number(view.pubdate) * 1000 : undefined,
      });
    }
    if (pages.length > 0) {
      return {
        available: true,
        availability: "available",
        interactive: Number(record(view.rights).is_stein_gate || 0) === 1,
        apiCodes: [...new Set(observations
          .map((observation) => observation.apiCode)
          .filter((code): code is number => Number.isFinite(code)))],
        title: typeof view.title === "string" ? view.title : undefined,
        upperName: typeof record(view.owner).name === "string" ? String(record(view.owner).name) : undefined,
        publishedAt: Number(view.pubdate || 0) > 0 ? Number(view.pubdate) * 1000 : undefined,
        access,
        pages,
      };
    }
    observations.push({ availability: "unknown", reason: "empty_response", apiCode });
  }
  const classified = classifyVideoPageAvailability(observations);
  return {
    available: classified.availability === "available",
    availability: classified.availability,
    availabilityReason: classified.reason,
    apiCodes: classified.apiCodes,
    access: classifyVideoAccess(undefined),
    pages: [],
  };
}

// ---------- token refresh (biliLive-tools pattern) ----------

/**
 * Refresh accessToken + cookie using refreshToken.
 * Returns updated auth data; failures retain a classified original error for callers.
 */
export async function refreshUserAuth(
  accessToken: string,
  refreshToken: string
): Promise<NormalizedTvAuth> {
  try {
    const tv = new TvQrcodeLogin();
    const result: unknown = await tv.refresh(accessToken, refreshToken);
    const auth = normalizeTvAuthResult(result);
    if (!auth.accessToken) {
      throw new Error("刷新响应缺少 access token");
    }
    console.log("[Bili] Token refreshed successfully");
    return auth;
  } catch (error: unknown) {
    console.error(`[Bili] Token refresh failed: ${safeErrorSummary(error)}`);
    throw new BiliAuthRefreshError(error);
  }
}
