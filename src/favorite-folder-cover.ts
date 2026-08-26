import { getFavoriteFolderCover } from "./bili.js";
import type { BiliCookie, BiliUser } from "./users.js";
import { OnlineCoverCache } from "./online-cover-cache.js";
import { safeErrorSummary } from "./diagnostics.js";

const URL_CACHE_TTL_MS = 5 * 60_000;
const FAILURE_CACHE_TTL_MS = 10_000;
const MAX_URL_CACHE_ENTRIES = 128;
const MAX_METADATA_REQUESTS_PER_USER = 2;

interface CachedCoverUrl {
  expiresAt: number;
  cover?: string;
}

export type FavoriteFolderCoverLoader = (
  cookie: BiliCookie,
  mediaId: number,
) => Promise<string | undefined>;

function cacheKey(user: BiliUser, mediaId: number) {
  return `favorite-folder:${user.uid}:${mediaId}`;
}

/** Resolves folder covers through the bounded, persistent online cover cache. */
export class FavoriteFolderCoverService {
  private readonly urls = new Map<string, CachedCoverUrl>();
  private readonly active = new Map<string, Promise<string | undefined>>();
  private readonly activeMetadataByUser = new Map<string, number>();
  private readonly metadataWaitersByUser = new Map<string, Array<() => void>>();

  constructor(
    private readonly coverCache: OnlineCoverCache,
    private readonly loadCover: FavoriteFolderCoverLoader = getFavoriteFolderCover,
  ) {}

  /** Seed the short-lived source URL cache from an already loaded folder list. */
  prime(user: BiliUser, mediaId: number, cover: string | undefined) {
    if (!Number.isInteger(mediaId) || mediaId < 1) return;
    const normalized = typeof cover === "string" ? cover.trim() : "";
    if (!normalized) return;
    this.setUrl(cacheKey(user, mediaId), {
      expiresAt: Date.now() + URL_CACHE_TTL_MS,
      cover: normalized,
    });
  }

  async resolve(user: BiliUser, mediaId: number, coverHint?: string) {
    if (!Number.isInteger(mediaId) || mediaId < 1) return null;
    const key = cacheKey(user, mediaId);
    if (coverHint) this.prime(user, mediaId, coverHint);
    const cachedFile = await this.coverCache.get(key);
    if (cachedFile) return cachedFile.path;

    const cover = await this.resolveUrl(user, mediaId, key);
    if (!cover) return null;
    const stored = await this.coverCache.getOrFetch(key, cover);
    return stored?.path || null;
  }

  private async resolveUrl(user: BiliUser, mediaId: number, key: string) {
    const now = Date.now();
    const cached = this.urls.get(key);
    if (cached && cached.expiresAt > now) {
      this.touch(key, cached);
      return cached.cover;
    }
    if (cached) this.urls.delete(key);

    const active = this.active.get(key);
    if (active) return active;

    const work = (async () => {
      let releaseMetadataSlot: (() => void) | null = null;
      try {
        await this.acquireMetadataSlot(user.id);
        releaseMetadataSlot = () => this.releaseMetadataSlot(user.id);
        const cover = (await this.loadCover(user.cookie, mediaId))?.trim() || undefined;
        this.setUrl(key, { expiresAt: Date.now() + (cover ? URL_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS), cover });
        return cover;
      } catch (error) {
        this.setUrl(key, { expiresAt: Date.now() + FAILURE_CACHE_TTL_MS });
        console.warn(`[FavoriteFolderCover] failed user=${user.id} media=${mediaId}: ${safeErrorSummary(error)}`);
        return undefined;
      } finally {
        releaseMetadataSlot?.();
      }
    })();
    this.active.set(key, work);
    try {
      return await work;
    } finally {
      if (this.active.get(key) === work) this.active.delete(key);
    }
  }

  private setUrl(key: string, value: CachedCoverUrl) {
    this.urls.delete(key);
    this.urls.set(key, value);
    while (this.urls.size > MAX_URL_CACHE_ENTRIES) {
      const oldest = this.urls.keys().next().value;
      if (!oldest) break;
      this.urls.delete(oldest);
    }
  }

  private touch(key: string, value: CachedCoverUrl) {
    this.urls.delete(key);
    this.urls.set(key, value);
  }

  private acquireMetadataSlot(userId: string) {
    const active = this.activeMetadataByUser.get(userId) || 0;
    if (active < MAX_METADATA_REQUESTS_PER_USER) {
      this.activeMetadataByUser.set(userId, active + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = this.metadataWaitersByUser.get(userId) || [];
      waiters.push(resolve);
      this.metadataWaitersByUser.set(userId, waiters);
    });
  }

  private releaseMetadataSlot(userId: string) {
    const active = this.activeMetadataByUser.get(userId) || 0;
    if (active <= 1) this.activeMetadataByUser.delete(userId);
    else this.activeMetadataByUser.set(userId, active - 1);

    const waiters = this.metadataWaitersByUser.get(userId) || [];
    const next = waiters.shift();
    if (!next) {
      if (waiters?.length === 0) this.metadataWaitersByUser.delete(userId);
      return;
    }
    this.activeMetadataByUser.set(userId, (this.activeMetadataByUser.get(userId) || 0) + 1);
    if (waiters.length === 0) this.metadataWaitersByUser.delete(userId);
    next();
  }
}
