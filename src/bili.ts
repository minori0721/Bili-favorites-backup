import { Client, Auth, TvQrcodeLogin } from "@renmu/bili-api";
import { BiliCookie } from "./users.js";
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

export class BiliRiskOrLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiliRiskOrLoginError";
  }
}

// ---------- helpers ----------

/** build a biliAPI Client from stored cookies — same pattern as biliLive-tools */
function createBiliClient(cookie: BiliCookie, uid: number, accessToken?: string) {
  const auth = new Auth();
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...rawCookieOnly } = cookie as BiliCookie & {
    refreshToken?: string;
  };
  const cookieOnly = Object.fromEntries(
    Object.entries(rawCookieOnly).filter(([, value]) => value !== undefined && value !== null)
  ) as Record<string, string | number>;
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

export interface NormalizedTvAuth {
  rawAuth: string;
  cookie: BiliCookie;
  accessToken: string;
  refreshToken: string;
  expires: number;
  uid?: number;
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
  const list = res.list || [];
  return list.map((item) => ({
    mediaId: item.id,
    title: item.title,
    mediaCount: item.media_count,
    cover: (item as any).cover || undefined,
  }));
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
 * Returns updated cookie object, or null if refresh failed.
 */
export async function refreshUserAuth(
  accessToken: string,
  refreshToken: string
): Promise<NormalizedTvAuth | null> {
  try {
    const tv = new TvQrcodeLogin();
    const result: any = await tv.refresh(accessToken, refreshToken);
    const auth = normalizeTvAuthResult(result);
    console.log("[Bili] Token refreshed successfully");
    return auth;
  } catch (error: any) {
    console.error(`[Bili] Token refresh failed: ${safeErrorSummary(error)}`);
    return null;
  }
}
