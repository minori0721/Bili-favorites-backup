import type { FavoriteFolderInfo } from "./bili.js";
import type { BiliUser } from "./users.js";

const DEFAULT_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 128;

export type FavoriteFolderListLoader = (user: BiliUser) => Promise<FavoriteFolderInfo[]>;
export type FavoriteFolderListObserver = (user: BiliUser, folders: FavoriteFolderInfo[]) => void;

interface CacheEntry {
  expiresAt: number;
  data: FavoriteFolderInfo[];
}

/** Short-lived metadata cache; selection state is always merged by the caller. */
export class FavoriteFolderListCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly active = new Map<string, Promise<FavoriteFolderInfo[]>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly load: FavoriteFolderListLoader,
    private readonly onLoaded: FavoriteFolderListObserver = () => undefined,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  async get(user: BiliUser) {
    this.prune();
    const cached = this.entries.get(user.id);
    if (cached && cached.expiresAt > Date.now()) {
      this.touch(user.id, cached);
      return cached.data;
    }
    if (cached) this.entries.delete(user.id);

    const active = this.active.get(user.id);
    if (active) return active;

    const generation = this.generations.get(user.id) || 0;
    const request = (async () => {
      const folders = await this.load(user);
      if ((this.generations.get(user.id) || 0) === generation) {
        this.store(user, folders);
      }
      return folders;
    })();
    this.active.set(user.id, request);
    try {
      return await request;
    } finally {
      if (this.active.get(user.id) === request) this.active.delete(user.id);
    }
  }

  /** Store a fresh list after a deliberate settings update. */
  set(user: BiliUser, folders: FavoriteFolderInfo[]) {
    this.bumpGeneration(user.id);
    this.store(user, folders);
  }

  invalidate(userId: string) {
    this.bumpGeneration(userId);
    this.entries.delete(userId);
  }

  peek(userId: string, mediaId: number) {
    const entry = this.entries.get(userId);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.entries.delete(userId);
      return undefined;
    }
    this.touch(userId, entry);
    return entry.data.find((folder) => folder.mediaId === mediaId);
  }

  clear() {
    for (const userId of new Set([...this.entries.keys(), ...this.active.keys()])) {
      this.bumpGeneration(userId);
    }
    this.entries.clear();
  }

  private store(user: BiliUser, folders: FavoriteFolderInfo[]) {
    const data = folders.map((folder) => ({ ...folder }));
    this.entries.delete(user.id);
    this.entries.set(user.id, { expiresAt: Date.now() + this.ttlMs, data });
    this.onLoaded(user, data);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  private touch(userId: string, entry: CacheEntry) {
    this.entries.delete(userId);
    this.entries.set(userId, entry);
  }

  private prune(now = Date.now()) {
    for (const [userId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(userId);
    }
  }

  private bumpGeneration(userId: string) {
    this.generations.set(userId, (this.generations.get(userId) || 0) + 1);
  }
}
