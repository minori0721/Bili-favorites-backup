import { Client, Auth } from "@renmu/bili-api";
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

export async function getUserInfo(cookie: BiliCookie): Promise<BiliUserInfo> {
  const auth = new Auth();
  await auth.setAuth(cookie, Number(cookie.DedeUserID));
  const client = new Client(auth);
  const res = await client.user.getMyInfo();
  return {
    uid: res.profile?.mid || Number(cookie.DedeUserID),
    name: res.profile?.name || "Unknown",
  };
}

export async function listFavoriteFolders(cookie: BiliCookie): Promise<FavoriteFolderInfo[]> {
  const auth = new Auth();
  await auth.setAuth(cookie, Number(cookie.DedeUserID));
  const client = new Client(auth);
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
  cookieString: string,
  mediaId: number,
  page = 1,
  pageSize = 20
): Promise<FavoriteItemsPage> {
  const url =
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}` +
    `&pn=${page}&ps=${pageSize}&order=fav_time&order_type=0&type=2&tid=0&platform=web`;
  const res = await fetch(url, {
    headers: {
      cookie: cookieString,
      accept: "application/json, text/plain, */*",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0",
    },
  });
  const contentType = res.headers.get("content-type") || "";
  const bodyText = await res.text();
  const trimmed = bodyText.trim();
  const looksLikeJson = contentType.includes("application/json") || trimmed.startsWith("{");
  if (!looksLikeJson) {
    const snippet = trimmed.slice(0, 120);
    throw new BiliRiskOrLoginError(
      `Bili API returned non-JSON for favorite ${mediaId} page ${page}. status=${res.status}. ` +
        `Login may be expired or risk control was triggered. ${snippet}`
    );
  }

  let data: {
    code: number;
    message: string;
    data?: {
      medias?: Array<{ bvid?: string; title?: string; upper?: { name?: string }; cover?: string; attr?: number }>;
      has_more?: number | string | boolean;
      info?: { media_count?: number };
    };
  };
  try {
    data = JSON.parse(bodyText);
  } catch (error: any) {
    throw new BiliRiskOrLoginError(
      `Bili API returned invalid JSON for favorite ${mediaId} page ${page}. ${error?.message || ""}`.trim()
    );
  }

  if (data.code !== 0) {
    throw new Error(data.message || "Failed to fetch favorites");
  }

  const medias = data.data?.medias || [];
  const items = medias
    .filter((media) => Boolean(media.bvid))
    .map((media) => ({
      bvid: media.bvid as string,
      title: media.title || "Untitled",
      upperName: media.upper?.name || "Unknown",
      cover: media.cover || undefined,
      // attr !== 0 means the video is deleted or unavailable on Bilibili.
      unavailable: media.attr !== undefined && media.attr !== 0,
    }));
  const total = data.data?.info?.media_count;

  return {
    items,
    page,
    pageSize,
    hasMore: normalizeHasMore(data.data?.has_more, page, pageSize, total),
    total,
  };
}

export async function listFavoriteItems(cookieString: string, mediaId: number, maxPages = Number.POSITIVE_INFINITY) {
  const items: FavoriteItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await listFavoriteItemsPage(cookieString, mediaId, page, 20);
    items.push(...result.items);
    if (!result.hasMore || result.items.length === 0) {
      break;
    }
    if (page < maxPages) {
      await delay(300);
    }
  }

  return items;
}
