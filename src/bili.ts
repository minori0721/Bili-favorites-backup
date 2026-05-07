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
}

export interface FavoriteItem {
  bvid: string;
  title: string;
  upperName: string;
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
      data?: { medias?: Array<{ bvid?: string; title?: string; upper?: { name?: string } }> };
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
      }));

    items.push(...mapped);
    if (medias.length < 20) {
      break;
    }
  }

  return items;
}
