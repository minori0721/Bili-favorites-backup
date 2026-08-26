import crypto from "node:crypto";
import path from "node:path";
import type { Response } from "express";
import {
  listFavoriteFolders,
  listOnlineContentPage,
  type OnlineContentItem,
  type OnlineContentKind,
  type OnlineContentPage,
} from "./bili.js";
import type { BiliUser } from "./users.js";
import { coversDir } from "./paths.js";
import { hasArchiveCover } from "./cover-cache.js";
import { OnlineCoverCache } from "./online-cover-cache.js";
import { safeErrorSummary } from "./diagnostics.js";

export interface OnlineContentQuery {
  kind: OnlineContentKind;
  mediaId?: number;
  page?: number;
  pageSize?: number;
  cursor?: string;
  query?: string;
}

export interface PublicOnlineContentItem extends Omit<OnlineContentItem, "cover"> {
  coverUrl?: string;
  coverToken?: string;
  archiveState: "archived" | "processing" | "unarchived" | "unavailable";
}

interface CachedPage {
  expiresAt: number;
  value: { page: OnlineContentPage; items: PublicOnlineContentItem[] };
}

interface CoverReference {
  userId: string;
  item: OnlineContentItem;
  key: string;
  expiresAt: number;
}

interface OnlineContentLoaders {
  listFolders?: typeof listFavoriteFolders;
  listPage?: typeof listOnlineContentPage;
}

export type OnlineArchiveStateResolver = (
  items: OnlineContentItem[],
) => Map<string, PublicOnlineContentItem["archiveState"]>;

const PAGE_TTL_MS = 60_000;
const NAVIGATION_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 10_000;
const MAX_PAGES = 128;
const MAX_NAVIGATION_ENTRIES = 128;
const MAX_FAILURE_ENTRIES = 128;
const MAX_COVER_REFS = MAX_PAGES * 50;
const TOKEN_TTL_MS = 15 * 60_000;

function pageKey(userId: string, query: OnlineContentQuery) {
  return JSON.stringify([
    userId,
    query.kind,
    Number(query.mediaId || 0),
    Number(query.page || 1),
    Number(query.pageSize || 50),
    String(query.cursor || ""),
    String(query.query || "").trim(),
  ]);
}

function coverKey(item: OnlineContentItem) {
  if (item.bvid) return `bvid:${item.bvid}`;
  return `online:${item.kind}:${item.id}:${item.cover || ""}`;
}

export class OnlineContentService {
  private readonly pages = new Map<string, CachedPage>();
  private readonly failures = new Map<string, { expiresAt: number; message: string }>();
  private readonly activeByUser = new Map<string, number>();
  private readonly coverRefs = new Map<string, CoverReference>();
  private readonly navigation = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(
    private readonly coverCache: OnlineCoverCache,
    private readonly loaders: OnlineContentLoaders = {},
  ) {}

  async getNavigation(users: BiliUser[]) {
    const result = [] as any[];
    for (const user of users) {
      const cached = this.navigation.get(user.id);
      let folders: unknown[] = [];
      if (cached && cached.expiresAt > Date.now()) {
        this.navigation.delete(user.id);
        this.navigation.set(user.id, cached);
        folders = (cached.value as any)?.folders || [];
      } else {
        try {
          folders = await (this.loaders.listFolders || listFavoriteFolders)(user.cookie);
          this.navigation.set(user.id, { expiresAt: Date.now() + NAVIGATION_TTL_MS, value: { folders } });
          this.trimNavigation();
        } catch (error) {
          this.navigation.set(user.id, { expiresAt: Date.now() + FAILURE_TTL_MS, value: { folders: [] } });
          this.trimNavigation();
          folders = [];
          console.warn(`[OnlineContent] navigation failed user=${user.id}: ${safeErrorSummary(error)}`);
        }
      }
      result.push({
        userId: user.id,
        uid: user.uid,
        name: user.name,
        avatar: user.avatar,
        sources: [
          ...folders.map((folder: any) => {
            const count = Number(folder.mediaCount);
            return {
              kind: "favorite",
              mediaId: Number(folder.mediaId),
              title: String(folder.title || "收藏夹"),
              count: Number.isInteger(count) && count >= 0 ? count : undefined,
              countLabel: "个视频",
            };
          }),
          { kind: "collected", title: "订阅合集" },
          { kind: "bangumi", title: "追番" },
          { kind: "drama", title: "追剧" },
          { kind: "watch_later", title: "稍后再看" },
          { kind: "history", title: "历史记录" },
        ],
      });
    }
    return { accounts: result };
  }

  async list(user: BiliUser, query: OnlineContentQuery, archiveStates: OnlineArchiveStateResolver) {
    const normalized: OnlineContentQuery = {
      ...query,
      page: Math.max(1, Math.floor(Number(query.page || 1))),
      pageSize: Math.min(50, Math.max(1, Math.floor(Number(query.pageSize || 50)))),
      query: String(query.query || "").trim().slice(0, 80),
    };
    const key = pageKey(user.id, normalized);
    const now = Date.now();
    const cached = this.pages.get(key);
    if (cached && cached.expiresAt > now) {
      this.pages.delete(key);
      this.pages.set(key, cached);
      return cached.value;
    }
    const failure = this.failures.get(key);
    if (failure && failure.expiresAt > now) {
      this.failures.delete(key);
      this.failures.set(key, failure);
      throw new Error(failure.message);
    }
    const active = this.activeByUser.get(user.id) || 0;
    if (active >= 2) throw new Error("该账号在线内容请求正在进行，请稍后再试");
    this.activeByUser.set(user.id, active + 1);
    try {
      const page = await (this.loaders.listPage || listOnlineContentPage)(user.cookie, normalized.kind, normalized);
      const states = archiveStates(page.items);
      this.pruneTokens();
      const items = page.items.map((item) => {
        const token = this.createCoverToken(user.id, item);
        const openUrl = item.openUrl || (item.bvid
          ? `https://www.bilibili.com/video/${encodeURIComponent(item.bvid)}`
          : undefined);
        return {
          ...item,
          cover: undefined,
          openUrl,
          coverToken: token || undefined,
          // Keep the local endpoint for every BVID, even after Bilibili stops
          // returning a cover URL. It can still serve the bounded online
          // cache or the permanent archive cover without a network request.
          coverUrl: token && (item.cover || item.bvid || hasArchiveCover(item.bvid || ""))
            ? `/api/online-content/covers/${token}`
            : undefined,
          archiveState: item.bvid
            ? (states.get(item.bvid) || "unarchived")
            : "unavailable",
        };
      });
      const value = {
        page: { ...page, items },
        items,
      };
      this.pages.set(key, { expiresAt: now + PAGE_TTL_MS, value });
      this.trimPages();
      this.failures.delete(key);
      return value;
    } catch (error) {
      const message = safeErrorSummary(error, "在线内容读取失败");
      this.failures.set(key, { expiresAt: now + FAILURE_TTL_MS, message });
      this.trimFailures();
      throw new Error(message);
    } finally {
      const remaining = (this.activeByUser.get(user.id) || 1) - 1;
      if (remaining > 0) this.activeByUser.set(user.id, remaining);
      else this.activeByUser.delete(user.id);
    }
  }

  getItem(token: string) {
    this.pruneTokens();
    const ref = this.coverRefs.get(String(token || ""));
    if (!ref || ref.expiresAt <= Date.now()) return null;
    return ref;
  }

  async resolveCover(token: string) {
    const ref = this.getItem(token);
    if (!ref) return null;
    if (ref.item.bvid && hasArchiveCover(ref.item.bvid)) {
      return path.join(coversDir, `${ref.item.bvid.replace(/[^0-9A-Za-z]/g, "")}.webp`);
    }
    const cached = await this.coverCache.get(ref.key);
    if (cached) return cached.path;
    if (!ref.item.cover) return null;
    const fetched = await this.coverCache.getOrFetch(ref.key, ref.item.cover);
    return fetched?.path || null;
  }

  async promoteCover(token: string) {
    const ref = this.getItem(token);
    if (!ref?.item.bvid) return null;
    return this.coverCache.promoteBvid(ref.item.bvid, ref.key);
  }

  private createCoverToken(userId: string, item: OnlineContentItem) {
    // A BVID without a current cover can still be manually archived. Keep a
    // short-lived reference for that action, while non-video rows do not need
    // a token at all.
    if (!item.cover && !item.bvid) return "";
    const token = crypto.randomBytes(18).toString("base64url");
    this.coverRefs.set(token, { userId, item, key: coverKey(item), expiresAt: Date.now() + TOKEN_TTL_MS });
    while (this.coverRefs.size > MAX_COVER_REFS) {
      const oldest = this.coverRefs.keys().next().value;
      if (!oldest) break;
      this.coverRefs.delete(oldest);
    }
    return token;
  }

  private trimNavigation() {
    while (this.navigation.size > MAX_NAVIGATION_ENTRIES) {
      const oldest = this.navigation.keys().next().value;
      if (!oldest) break;
      this.navigation.delete(oldest);
    }
  }

  private trimFailures() {
    while (this.failures.size > MAX_FAILURE_ENTRIES) {
      const oldest = this.failures.keys().next().value;
      if (!oldest) break;
      this.failures.delete(oldest);
    }
  }

  private trimPages() {
    while (this.pages.size > MAX_PAGES) {
      const first = this.pages.keys().next().value;
      if (!first) break;
      this.pages.delete(first);
    }
  }

  private pruneTokens() {
    const now = Date.now();
    for (const [token, ref] of this.coverRefs) if (ref.expiresAt <= now) this.coverRefs.delete(token);
  }
}

export function sendOnlineCover(res: Response, filePath: string | null) {
  if (!filePath) {
    res.status(404).json({ success: false, message: "在线缩略图不可用" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(filePath);
}
