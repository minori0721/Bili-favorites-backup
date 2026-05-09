import { Client, Auth, TvQrcodeLogin } from "@renmu/bili-api";
import { BiliCookie } from "./users.js";
import { delay } from "./utils.js";

export interface BiliUserInfo {
  uid: number;
  name: string;
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
  cover?: string;
  unavailable?: boolean;
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
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...cookieOnly } = cookie as BiliCookie & {
    refreshToken?: string;
  };
  auth.setAuth(cookieOnly, uid, accessToken || undefined);
  return new Client(auth);
}

// ---------- core API ----------

export async function getUserInfo(cookie: BiliCookie): Promise<BiliUserInfo> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), cookie.accessToken);
  const res = await client.user.getMyInfo();
  return {
    uid: res.profile?.mid || Number(cookie.DedeUserID),
    name: res.profile?.name || "Unknown",
  };
}

export async function listFavoriteFolders(cookie: BiliCookie): Promise<FavoriteFolderInfo[]> {
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), cookie.accessToken);
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
  const client = createBiliClient(cookie, Number(cookie.DedeUserID), cookie.accessToken);

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
    if (statusCode === 412 || statusCode === 406 || statusCode === 509 || statusCode === 403) {
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
    if (apiCode === -101 || apiCode === -111 || /cookie|登录|鉴权/i.test(msg)) {
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

// ---------- token refresh (biliLive-tools pattern) ----------

/**
 * Refresh accessToken + cookie using refreshToken.
 * Returns updated cookie object, or null if refresh failed.
 */
export async function refreshUserAuth(
  accessToken: string,
  refreshToken: string
): Promise<BiliCookie | null> {
  try {
    const tv = new TvQrcodeLogin();
    const result: any = await tv.refresh(accessToken, refreshToken);
    const data = { ...result, ...result?.token_info };

    const cookieObj: BiliCookie = {
      SESSDATA: "",
      bili_jct: "",
      DedeUserID: "",
    };
    const cookieArray = data?.cookie_info?.cookies || [];
    for (const c of cookieArray) {
      cookieObj[c.name] = c.value;
    }
    cookieObj.accessToken = data.access_token || "";

    console.log("[Bili] Token refreshed successfully");
    return cookieObj;
  } catch (error: any) {
    console.error("[Bili] Token refresh failed:", error.message || error);
    return null;
  }
}
