import { Client, Auth, utils } from "@renmu/bili-api";
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

function createBiliClient(cookie: BiliCookie) {
  const auth = new Auth();
  auth.setAuth(cookie, Number(cookie.DedeUserID));
  return new Client(auth);
}

export async function getUserInfo(cookie: BiliCookie): Promise<BiliUserInfo> {
  const client = createBiliClient(cookie);
  const res = await client.user.getMyInfo();
  return {
    uid: res.profile?.mid || Number(cookie.DedeUserID),
    name: res.profile?.name || "Unknown",
  };
}

export async function listFavoriteFolders(cookie: BiliCookie): Promise<FavoriteFolderInfo[]> {
  const client = createBiliClient(cookie);
  const res = await client.video.listFavoriteBox({ aid: 0, type: 2 });
  const list = res.list || [];
  return list.map((item) => ({
    mediaId: item.id,
    title: item.title,
    mediaCount: item.media_count,
    cover: (item as any).cover || undefined,
  }));
}

function normalizeHasMore(value: number | string | boolean | undefined, page: number, pageSize: number, total?: number) {
  if (value === 1 || value === true || value === "1") return true;
  if (value === 0 || value === false || value === "0") return false;
  return typeof total === "number" ? page * pageSize < total : false;
}

export async function listFavoriteItemsPage(
  cookie: BiliCookie,
  mediaId: number,
  page = 1,
  pageSize = 20
): Promise<FavoriteItemsPage> {
  const client = createBiliClient(cookie);

  const params: Record<string, string | number> = {
    media_id: mediaId,
    pn: page,
    ps: pageSize,
    order: "fav_time",
    order_type: "0",
    type: "2",
    tid: "0",
    platform: "web",
    web_location: "1550101",
    dm_img_list: "[]",
    dm_img_str: "V2ViR0wgMS",
    dm_cover_img_str: utils.fakeDmCoverImgStr(
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0XX)), SwiftShader driver)Google Inc. (Google)"
    ),
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  };

  const signedParams = await utils.WbiSign(params);
  const url = `https://api.bilibili.com/x/v3/fav/resource/list?${signedParams}`;

  let data: {
    medias?: Array<{ bvid?: string; title?: string; upper?: { name?: string }; cover?: string; attr?: number }>;
    has_more?: number | string | boolean;
    info?: { media_count?: number };
  };

  try {
    data = await client.video.request.get(url, {
      headers: {
        referer: "https://www.bilibili.com/",
      },
    });
  } catch (error: any) {
    const statusCode = error?.statusCode || error?.response?.status;
    const errMsg = error?.message || String(error);
    if (statusCode === 406 || errMsg.includes("request was banned") || errMsg.includes("访问被拒绝")) {
      throw new BiliRiskOrLoginError(
        `Bili API error (status ${statusCode || "unknown"}): ${errMsg}`
      );
    }
    throw new BiliRiskOrLoginError(
      `Bili API error (status ${statusCode || "unknown"}): ${errMsg}`
    );
  }

  const medias = data?.medias || [];
  const items = medias
    .filter((media) => Boolean(media.bvid))
    .map((media) => ({
      bvid: media.bvid as string,
      title: media.title || "Untitled",
      upperName: media.upper?.name || "Unknown",
      cover: media.cover || undefined,
      unavailable: media.attr !== undefined && media.attr !== 0,
    }));
  const total = data?.info?.media_count;

  return {
    items,
    page,
    pageSize,
    hasMore: normalizeHasMore(data?.has_more, page, pageSize, total),
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
        if (!result.hasMore || result.items.length === 0) {
          return items;
        }
        lastError = null;
        break;
      } catch (error: any) {
        lastError = error;
        if (error instanceof BiliRiskOrLoginError) {
          throw error;
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

    if (page < maxPages) {
      await delay(300);
    }
  }

  return items;
}
