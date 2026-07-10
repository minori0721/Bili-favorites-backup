import { Client, Auth, TvQrcodeLogin } from "@renmu/bili-api";
import { BiliCookie } from "./users.js";
import { delay } from "./utils.js";

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

export async function listFavoriteItems(
  cookie: BiliCookie,
  mediaId: number,
  maxPages = Number.POSITIVE_INFINITY,
  maxPageRetries = 3
) {
  const items: FavoriteItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxPageRetries; attempt += 1) {
      try {
        const result = await listFavoriteItemsPage(cookie, mediaId, page, 20);
        items.push(...result.items);
        console.log(`[Bili] Favorite ${mediaId} page ${page}: got ${result.items.length} items, hasMore=${result.hasMore}, total=${result.total}`);
        if (!result.hasMore || result.items.length === 0) {
          return items;
        }
        lastError = null;
        break;
      } catch (error: any) {
        lastError = error;
        // 412/risk-control: exponential backoff retry
        if (error instanceof BiliRiskOrLoginError) {
          if (attempt < maxPageRetries) {
            const cooldownMs = Math.min(10000 * Math.pow(2, attempt), 120000);
            console.warn(
              `[Bili] Page ${page} of favorite ${mediaId} hit risk control, cooling down ${cooldownMs / 1000}s before retry ${attempt + 1}/${maxPageRetries + 1}`
            );
            await delay(cooldownMs);
            continue;
          }
          console.warn(
            `[Bili] Page ${page} of favorite ${mediaId} risk control retries exhausted, returning ${items.length} items`
          );
          return items;
        }
        if (attempt < maxPageRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.warn(
            `[Bili] Page ${page} of favorite ${mediaId} failed (attempt ${attempt + 1}/${maxPageRetries + 1}), retrying in ${backoffMs}ms:`,
            error.message || error
          );
          await delay(backoffMs);
        }
      }
    }

    if (lastError) {
      console.error(
        `[Bili] Page ${page} of favorite ${mediaId} exhausted all retries, skipping remaining pages:`,
        lastError.message || lastError
      );
      return items;
    }

    // Random 1-3s delay between pages (like v1.0.9)
    if (page < maxPages) {
      const jitter = 1000 + Math.floor(Math.random() * 2000);
      await delay(jitter);
    }
  }

  return items;
}

export interface VideoPageSnapshotResult {
  available: boolean;
  title?: string;
  upperName?: string;
  pages: Array<{
    index: number;
    cid: number;
    title: string;
    duration: number;
  }>;
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
  for (const url of urls) {
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
    const rawPages = Array.isArray(view.pages) ? view.pages : [];
    const pages = rawPages
      .map((page: any, offset: number) => ({
        index: Number(page?.page || offset + 1),
        cid: Number(page?.cid || 0),
        title: String(page?.part || page?.title || `P${offset + 1}`),
        duration: Number(page?.duration || 0),
      }))
      .filter((page: { index: number; cid: number }) => page.index > 0 && page.cid > 0);
    if (pages.length === 0 && Number(view.cid || 0) > 0) {
      pages.push({
        index: 1,
        cid: Number(view.cid),
        title: String(view.title || bvidValue),
        duration: Number(view.duration || 0),
      });
    }
    return {
      available: pages.length > 0,
      title: typeof view.title === "string" ? view.title : undefined,
      upperName: typeof view.owner?.name === "string" ? view.owner.name : undefined,
      pages,
    };
  }
  return { available: !lastUnavailable, pages: [] };
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
    console.error("[Bili] Token refresh failed:", error.message || error);
    return null;
  }
}
