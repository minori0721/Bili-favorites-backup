import { Client, Auth } from "@renmu/bili-api";
import { BiliCookie } from "./users.js";
import { readJsonFile, writeJsonFile } from "./storage.js";
import { delay } from "./utils.js";
import { dataDir } from "./paths.js";
import path from "node:path";

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

/** build a biliAPI Client from stored cookies WITHOUT leaking accessToken into the Cookie header */
function createBiliClient(cookie: BiliCookie) {
  const { accessToken, ...cookieOnly } = cookie;
  const auth = new Auth();
  auth.setAuth(cookieOnly, Number(cookie.DedeUserID), accessToken || undefined);
  return new Client(auth);
}

/** cached WBI keys — re-fetched once per process */
let _wbiKeys: { img_key: string; sub_key: string } | null = null;
const wbiKeyCachePath = path.join(dataDir, ".wbi-keys.json");

async function getCachedWbiKeys(): Promise<{ img_key: string; sub_key: string }> {
  if (_wbiKeys) return _wbiKeys;
  const cached = readJsonFile<{ img_key?: string; sub_key?: string } | null>(wbiKeyCachePath, null);
  if (cached?.img_key && cached?.sub_key) {
    _wbiKeys = cached as { img_key: string; sub_key: string };
    return _wbiKeys;
  }
  const resp = await fetch(
    "https://api.bilibili.com/x/web-interface/nav"
  );
  const json = (await resp.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };
  const imgUrl = json?.data?.wbi_img?.img_url || "";
  const subUrl = json?.data?.wbi_img?.sub_url || "";
  const img_key = (imgUrl.split("/").pop() || "").split(".")[0];
  const sub_key = (subUrl.split("/").pop() || "").split(".")[0];
  const keys = { img_key, sub_key };
  _wbiKeys = keys;
  writeJsonFile(wbiKeyCachePath, keys);
  return keys;
}

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function mixinKey(orig: string): string {
  let temp = "";
  for (const n of mixinKeyEncTab) {
    temp += orig[n] ?? "";
  }
  return temp.slice(0, 32);
}

function encWbi(params: Record<string, string | number>, img_key: string, sub_key: string): string {
  const mixin = mixinKey(img_key + sub_key);
  const wts = Math.floor(Date.now() / 1000).toString();
  const merged: Record<string, string | number> = { ...params, wts };
  const chr_filter = /[!'()*]/g;
  const sorted = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]).replace(chr_filter, ""))}`)
    .join("&");
  const w_rid = md5(sorted + mixin);
  return `${sorted}&w_rid=${w_rid}`;
}

import { createHash } from "node:crypto";

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** whether an axios-like error looks like a definitive risk‑control / login‑expired */
function isBiliRiskStatus(statusCode: unknown, errMsg: string): boolean {
  const code = Number(statusCode);
  return (
    code === 406 ||
    code === 412 ||
    code === 509 ||
    code === 403 ||
    /request was banned|访问被拒绝|风控|安全验证/i.test(errMsg)
  );
}

function normalizeHasMore(value: number | string | boolean | undefined, page: number, pageSize: number, total?: number) {
  if (value === 1 || value === true || value === "1") return true;
  if (value === 0 || value === false || value === "0") return false;
  return typeof total === "number" ? page * pageSize < total : false;
}

// ---------- core API ----------

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

export async function listFavoriteItemsPage(
  cookie: BiliCookie,
  mediaId: number,
  page = 1,
  pageSize = 20
): Promise<FavoriteItemsPage> {
  const client = createBiliClient(cookie);
  const wbiKeys = await getCachedWbiKeys();

  const baseParams: Record<string, string | number> = {
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
    dm_cover_img_str: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0XX)), SwiftShader driver)Google Inc. (Google)",
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  };

  const queryString = encWbi(baseParams, wbiKeys.img_key, wbiKeys.sub_key);
  const url = `https://api.bilibili.com/x/v3/fav/resource/list?${queryString}`;

  let responseBody: unknown;
  try {
    responseBody = await client.video.request.get(url, {
      headers: { referer: "https://www.bilibili.com/" },
      extra: { rawResponse: true },
    });
  } catch (error: any) {
    const statusCode = error?.statusCode || error?.response?.status;
    const errMsg = error?.message || String(error);
    if (isBiliRiskStatus(statusCode, errMsg)) {
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
        // 412/risk-control: exponential backoff retry instead of giving up
        if (error instanceof BiliRiskOrLoginError) {
          if (attempt < maxPageRetries) {
            const cooldownMs = Math.min(10000 * Math.pow(2, attempt), 120000);
            console.warn(
              `[Bili] Page ${page} of favorite ${mediaId} hit risk control, cooling down ${cooldownMs / 1000}s before retry ${attempt + 1}/${maxPageRetries + 1}`
            );
            await delay(cooldownMs);
            continue;
          }
          // All retries exhausted — return what we have
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

    // Random delay 1-3s between pages to avoid pattern detection
    if (page < maxPages) {
      const jitter = 1000 + Math.floor(Math.random() * 2000);
      await delay(jitter);
    }
  }

  return items;
}
