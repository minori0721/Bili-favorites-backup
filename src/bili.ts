import { Client, Auth } from "@renmu/bili-api";
import { BiliCookie } from "./users.js";

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

export async function listFavoriteItems(cookieString: string, mediaId: number, maxPages = 1) {
  const items: FavoriteItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${page}&ps=20&order=fav_time&order_type=0`;
    const res = await fetch(url, {
      headers: {
        cookie: cookieString,
        referer: "https://www.bilibili.com/",
        "user-agent": "Mozilla/5.0",
      },
    });
    const data = (await res.json()) as {
      code: number;
      message: string;
      data?: {
        medias?: Array<{ bvid?: string; title?: string; upper?: { name?: string }; cover?: string; attr?: number }>;
        has_more?: number | string | boolean;
        info?: { media_count?: number };
      };
    };
    if (data.code !== 0) {
      throw new Error(data.message || "Failed to fetch favorites");
    }

    const medias = data.data?.medias || [];
    const mapped = medias
      .filter((media) => Boolean(media.bvid))
      .map((media) => ({
        bvid: media.bvid as string,
        title: media.title || "Untitled",
        upperName: media.upper?.name || "Unknown",
        cover: media.cover || undefined,
        // attr !== 0 means the video is deleted/unavailable on B站
        unavailable: (media.attr !== undefined && media.attr !== 0),
      }));

    items.push(...mapped);
    const hasMore = data.data?.has_more;
    if (hasMore === 1 || hasMore === true || hasMore === "1") {
      continue;
    }
    if (hasMore === 0 || hasMore === false || hasMore === "0") {
      break;
    }

    const total = data.data?.info?.media_count;
    if (typeof total === "number" && page * 20 < total) {
      continue;
    }

    if (medias.length === 0) {
      break;
    }
  }

  return items;
}
