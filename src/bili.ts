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

export function normalizeFavoriteFolderListResponse(value: unknown): Array<Record<string, any>> {
  const list = (value as { list?: unknown } | null | undefined)?.list;
  if (!Array.isArray(list)) throw new BiliFavoriteFolderResponseError();
  return list as Array<Record<string, any>>;
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
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || error?.response?.status || 0);
    const message = String(error?.message || error);
    if (isRiskOrLoginStatus(statusCode) || isRiskOrLoginApiError(0, message)) {
      throw new BiliRiskOrLoginError(`Bili API error (status ${statusCode || "unknown"})`);
    }
    throw error;
  }
  const envelope = (responseBody as Record<string, any>)?.data ?? {};
  const apiCode = Number(envelope?.code ?? 0);
  if (apiCode !== 0) {
    const message = String(envelope?.message || `Bili API returned code ${apiCode}`);
    if (isRiskOrLoginApiError(apiCode, message)) throw new BiliRiskOrLoginError(`Bili API code ${apiCode}`);
    throw new Error(message);
  }
  return envelope?.data ?? envelope;
}

function onlineItemFromRaw(raw: any, kind: OnlineContentKind, index: number): OnlineContentItem | null {
  const archive = raw?.arc || raw?.archive || raw?.history || raw?.video || raw;
  const bvid = String(raw?.bvid || archive?.bvid || "").trim() || undefined;
  const stableId = raw?.season_id || raw?.seasonId || raw?.ep_id || raw?.epid || raw?.id || raw?.aid;
  const id = String(bvid || stableId || `${kind}-${index}`).trim();
  const title = String(raw?.title || archive?.title || raw?.show_name || raw?.season_title || raw?.name || id).trim();
  const cover = String(raw?.pic || raw?.cover || archive?.pic || archive?.cover || raw?.season?.cover || raw?.ogv_info?.cover || "").trim() || undefined;
  const upper = raw?.owner || archive?.owner || raw?.upper || {};
  const upperName = String(upper?.name || raw?.author || raw?.up_name || "").trim() || undefined;
  const upperMid = Number(upper?.mid || raw?.mid || raw?.up_mid || 0) || undefined;
  const duration = Number(raw?.duration || archive?.duration || 0) || undefined;
  const publishedAt = Number(raw?.pubdate || archive?.pubdate || raw?.ctime || 0) > 0
    ? Number(raw?.pubdate || archive?.pubdate || raw?.ctime) * 1000
    : undefined;
  const seasonId = Number(raw?.season_id || raw?.seasonId || raw?.season?.season_id || 0);
  const episodeId = Number(raw?.ep_id || raw?.epid || raw?.episode_id || 0);
  const collectionId = Number(raw?.id || raw?.season_id || 0);
  const collectionMid = Number(raw?.mid || raw?.upper?.mid || raw?.owner?.mid || 0);
  const rawUrl = String(raw?.uri || raw?.url || raw?.link || "").trim();
  let openUrl: string | undefined;
  if (bvid) {
    openUrl = `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
  } else if ((kind === "bangumi" || kind === "drama") && episodeId > 0) {
    openUrl = `https://www.bilibili.com/bangumi/play/ep${episodeId}`;
  } else if ((kind === "bangumi" || kind === "drama") && seasonId > 0) {
    openUrl = `https://www.bilibili.com/bangumi/play/ss${seasonId}`;
  } else if (kind === "collected" && collectionId > 0 && collectionMid > 0) {
    openUrl = `https://space.bilibili.com/${collectionMid}/lists/${collectionId}?type=season`;
  } else {
    try {
      const candidate = new URL(rawUrl);
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
    rawType: String(raw?.business || raw?.type || kind),
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
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid history cursor");
    return {
      max: Number((parsed as any).max || 0) || 0,
      view_at: Number((parsed as any).viewAt ?? (parsed as any).view_at ?? 0) || 0,
      business: String((parsed as any).business ?? "").slice(0, 32),
    };
  } catch {
    throw new Error("在线历史游标无效，请重新加载");
  }
}

function onlineArray(data: any) {
  const candidates = [data?.medias, data?.list, data?.items, data?.archives, data?.result, data?.history, data?.data?.list];
  return candidates.find((value) => Array.isArray(value)) || [];
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
  const rawItems = onlineArray(data);
  const items = rawItems.map((raw: any, index: number) => onlineItemFromRaw(raw, kind, index)).filter((item): item is OnlineContentItem => Boolean(item));
  const total = Number(data?.total || data?.info?.media_count || data?.page?.count || 0) || undefined;
  const nextCursor = data?.cursor && typeof data.cursor === "object"
    ? encodeHistoryCursor(data.cursor)
    : String(data?.next_cursor ?? data?.cursor?.next ?? "").trim() || undefined;
  const explicitHasMore = data?.has_more ?? data?.hasMore;
  const hasMore = typeof explicitHasMore === "boolean" || typeof explicitHasMore === "number"
    ? Boolean(explicitHasMore)
    : Boolean(nextCursor) || (total ? page * pageSize < total : items.length >= pageSize);
  return { items, kind, page, pageSize, nextCursor, hasMore, total };
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
    const source = originalError as any;
    const status = Number(source?.status || source?.statusCode || source?.response?.status || 0);
    this.status = status > 0 ? status : undefined;
    this.code = typeof source?.code === "string" ? source.code : undefined;
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

export function normalizeTvAuthResult(result: any): NormalizedTvAuth {
  const rawData = result?.data || result || {};
  const tokenInfo = rawData?.token_info || {};
  const merged = { ...rawData, ...tokenInfo };
  const cookieArray = merged?.cookie_info?.cookies || [];
  const cookie: BiliCookie = {
    SESSDATA: "",
    bili_jct: "",
    DedeUserID: "",
  };

  for (const item of cookieArray) {
    if (!item?.name) {
      continue;
    }
    cookie[item.name] = item.value ?? "";
  }

  const accessToken = String(merged.access_token || "");
  const refreshToken = String(merged.refresh_token || "");
  if (accessToken) {
    cookie.accessToken = accessToken;
  }

  const uid = Number(merged.mid || cookie.DedeUserID || 0) || undefined;
  const sessdataExpires = cookieArray.find((item: any) => item?.name === "SESSDATA")?.expires;
  const expires = Number(sessdataExpires || 0) > 0 ? Number(sessdataExpires) * 1000 : 0;

  return {
    rawAuth: JSON.stringify(rawData),
    cookie,
    accessToken,
    refreshToken,
    expires,
    uid,
  };
}

export async function listFavoriteFolders(cookie: BiliCookie): Promise<FavoriteFolderInfo[]> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), String(cookie.accessToken || ""));
  const res = await client.video.listFavoriteBox({ aid: 0, type: 2 });
  const list = normalizeFavoriteFolderListResponse(res);
  return list.map((item) => ({
    mediaId: item.id,
    title: item.title,
    mediaCount: item.media_count,
    cover: (item as any).cover || undefined,
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
  const cover = typeof data?.cover === "string" ? data.cover.trim() : "";
  return cover || undefined;
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
  } catch (error: any) {
    const statusCode = error?.statusCode || error?.response?.status;
    const errMsg = error?.message || String(error);
    if (isRiskOrLoginStatus(Number(statusCode || 0)) || isRiskOrLoginApiError(0, errMsg)) {
      throw new BiliRiskOrLoginError(
        `Bili API error (status ${statusCode || "unknown"}): ${errMsg}`
      );
    }
    throw error;
  }

  const body = (responseBody as Record<string, any>)?.data ?? {};
  const apiCode = Number(body.code ?? 0);

  if (apiCode !== 0) {
    const msg = body.message || `Bili API returned code ${apiCode}`;
    if (isRiskOrLoginApiError(apiCode, msg)) {
      throw new BiliRiskOrLoginError(`Bili API code ${apiCode}: ${msg}`);
    }
    throw new Error(msg);
  }

  const data = body.data as Record<string, any> | undefined;
  const medias = Array.isArray(data?.medias) ? data.medias : [];
  const items = medias
    .filter((media: any) => Boolean(media.bvid))
    .map((media: any) => ({
      bvid: media.bvid as string,
      title: media.title || "Untitled",
      upperName: media.upper?.name || "Unknown",
      upperMid: Number(media.upper?.mid || 0) || undefined,
      cover: media.cover || undefined,
      unavailable: media.attr !== undefined && media.attr !== 0,
    }));
  const total = data?.info?.media_count as number | undefined;
  // has_more can be 1/0 (number), true/false (boolean), or missing
  const rawHasMore = data?.has_more;
  const hasMore = rawHasMore === 1 || rawHasMore === true
    ? true
    : rawHasMore === 0 || rawHasMore === false
      ? false
      : (page * pageSize < (total || 0));

  return {
    items,
    page,
    pageSize,
    hasMore,
    total,
  };
}

export interface VideoPageSnapshotResult {
  available: boolean;
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

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function classifyVideoAccess(
  value: Record<string, unknown> | undefined,
  source: VideoAccessSnapshot["source"] = "unknown"
): VideoAccessSnapshot {
  const isUPowerExclusive = optionalBoolean(value?.is_upower_exclusive);
  const isUPowerPlay = optionalBoolean(value?.is_upower_play);
  const previewAvailable = optionalBoolean(value?.is_upower_preview);
  const isUgcPayPreview = optionalBoolean(value?.is_ugc_pay_preview);
  const exclusiveWithQa = optionalBoolean(value?.is_upower_exclusive_with_qa);
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
    const player = await client.video.playerInfo({ bvid, cid }) as unknown as Record<string, unknown>;
    const fallback = classifyVideoAccess(player, "player");
    return fallback.classification === "unknown" ? current : fallback;
  } catch (error: any) {
    const statusCode = Number(error?.statusCode || error?.response?.status || 0);
    const apiCode = Number(error?.code || error?.response?.data?.code || 0);
    const message = String(error?.message || error);
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
    } catch (error: any) {
      const statusCode = error?.statusCode || error?.response?.status;
      const errMsg = error?.message || String(error);
      if (isRiskOrLoginStatus(Number(statusCode || 0)) || isRiskOrLoginApiError(0, errMsg)) {
        return item;
      }
      continue;
    }

    const body = (responseBody as Record<string, any>)?.data ?? {};
    const apiCode = Number(body.code ?? 0);
    if (apiCode !== 0) {
      const msg = String(body.message || `Bili API returned code ${apiCode}`);
      if (isRiskOrLoginApiError(apiCode, msg)) {
        return item;
      }
      continue;
    }

    const data = body.data as Record<string, any> | undefined;
    const view = data?.View || data;
    const ownerMid = Number(view?.owner?.mid || 0);
    if (!view || ownerMid !== expectedOwnerMid) {
      continue;
    }

    const title = typeof view.title === "string" && view.title.trim() ? view.title.trim() : item.title;
    const upperName = typeof view.owner?.name === "string" && view.owner.name.trim()
      ? view.owner.name.trim()
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
  let lastUnavailable = false;
  for (const [urlIndex, url] of urls.entries()) {
    let responseBody: unknown;
    try {
      responseBody = await client.video.request.get(url, {
        headers: { referer: `https://www.bilibili.com/video/${bvidValue}/` },
        extra: { rawResponse: true },
      });
    } catch (error: any) {
      const statusCode = Number(error?.statusCode || error?.response?.status || 0);
      const message = error?.message || String(error);
      if (isRiskOrLoginStatus(statusCode) || isRiskOrLoginApiError(0, message)) {
        throw new BiliRiskOrLoginError(`Bili API error (status ${statusCode || "unknown"}): ${message}`);
      }
      continue;
    }

    const body = (responseBody as Record<string, any>)?.data ?? {};
    const apiCode = Number(body.code ?? 0);
    if (apiCode !== 0) {
      const message = String(body.message || `Bili API returned code ${apiCode}`);
      if (isRiskOrLoginApiError(apiCode, message)) {
        throw new BiliRiskOrLoginError(`Bili API code ${apiCode}: ${message}`);
      }
      lastUnavailable = true;
      continue;
    }
    const data = body.data as Record<string, any> | undefined;
    const view = data?.View || data;
    if (!view) continue;
    const access = await resolveVideoAccessFallback(
      client,
      bvidValue,
      Number(view.cid || 0),
      classifyVideoAccess(view, urlIndex === 0 ? "view_detail" : "view")
    );
    const rawPages = Array.isArray(view.pages) ? view.pages : [];
    const pages = rawPages
      .map((page: any, offset: number) => ({
        index: Number(page?.page || offset + 1),
        cid: Number(page?.cid || 0),
        title: String(page?.part || page?.title || `P${offset + 1}`),
        duration: Number(page?.duration || 0),
        publishedAt: Number(page?.ctime || page?.pubdate || view?.pubdate || 0) > 0
          ? Number(page?.ctime || page?.pubdate || view?.pubdate) * 1000
          : undefined,
      }))
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
    return {
      available: pages.length > 0,
      title: typeof view.title === "string" ? view.title : undefined,
      upperName: typeof view.owner?.name === "string" ? view.owner.name : undefined,
      publishedAt: Number(view.pubdate || 0) > 0 ? Number(view.pubdate) * 1000 : undefined,
      access,
      pages,
    };
  }
  return { available: !lastUnavailable, access: classifyVideoAccess(undefined), pages: [] };
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
    const result: any = await tv.refresh(accessToken, refreshToken);
    const auth = normalizeTvAuthResult(result);
    if (!auth.accessToken) {
      throw new Error("刷新响应缺少 access token");
    }
    console.log("[Bili] Token refreshed successfully");
    return auth;
  } catch (error: any) {
    console.error(`[Bili] Token refresh failed: ${safeErrorSummary(error)}`);
    throw new BiliAuthRefreshError(error);
  }
}
