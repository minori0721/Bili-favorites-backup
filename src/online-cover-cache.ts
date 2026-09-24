import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { onlineCoversDir, tempDir } from "./paths.js";
import { promoteOnlineCoverToArchive, runCoverFfmpeg, validateBilibiliCoverUrl } from "./cover-cache.js";
import { safeErrorSummary } from "./diagnostics.js";
import { cancelUnreadCoverResponse, readCoverImageResponse } from "./cover-response.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const EVICT_WATERMARK = 0.9;
const MAX_CONCURRENT_FETCHES = 4;

interface OnlineCoverEntry {
  fileName: string;
  bytes: number;
  accessedAt: number;
  lastAccessPersistAt: number;
}

function cacheKey(value: string) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

async function moveAtomic(source: string, target: string) {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (! ["EXDEV", "EPERM", "EACCES"].includes(code)) throw error;
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source).catch((cleanupError) => {
      console.warn(`[OnlineCoverCache] source cleanup deferred: ${String(cleanupError)}`);
    });
  }
}

async function downloadImage(urlValue: string, outputPath: string) {
  let current = await validateBilibiliCoverUrl(urlValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    let response: Response | null = null;
    for (let hop = 0; hop <= 5; hop += 1) {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await cancelUnreadCoverResponse(response);
      response = null;
      if (!location || hop === 5) throw new Error("online cover redirect limit exceeded");
      current = await validateBilibiliCoverUrl(new URL(location, current).toString());
    }
    const bytes = await readCoverImageResponse(response, MAX_SOURCE_BYTES, {
      http: status => new Error(`online cover request failed: ${status}`),
      contentType: () => new Error("online cover response is not an image"),
      tooLarge: () => new Error("online cover exceeds size limit"),
    });
    await fs.promises.writeFile(outputPath, bytes, { flag: "wx" });
  } finally {
    clearTimeout(timeout);
  }
}

export interface OnlineCoverAdapters {
  directory?: string;
  temporaryDirectory?: string;
  download?: typeof downloadImage;
  transcode?: typeof runCoverFfmpeg;
  promote?: typeof promoteOnlineCoverToArchive;
  unlink?: typeof fs.promises.unlink;
  removeTemporary?: typeof fs.promises.rm;
}

export class OnlineCoverCache {
  private readonly directory: string;
  private readonly temporaryDirectory: string;
  private readonly entries = new Map<string, OnlineCoverEntry>();
  private readonly active = new Map<string, Promise<string | null>>();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private totalBytes = 0;
  private limitBytes: number;
  private cleanupPromise: Promise<void> | null = null;
  private clearPromise: Promise<void> | null = null;
  private readonly activePromotions = new Set<Promise<string | null>>();
  private runningFetches = 0;
  private readonly fetchWaiters: Array<() => void> = [];
  private generation = 0;

  constructor(limitMb = 256, private readonly adapters: OnlineCoverAdapters = {}) {
    this.directory = adapters.directory ?? onlineCoversDir;
    this.temporaryDirectory = adapters.temporaryDirectory ?? tempDir;
    this.limitBytes = Math.max(64, Math.min(2048, Math.trunc(limitMb))) * 1024 * 1024;
  }

  setLimitMb(limitMb: number) {
    this.limitBytes = Math.max(64, Math.min(2048, Math.trunc(limitMb))) * 1024 * 1024;
    void this.evictIfNeeded();
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const files = await fs.promises.readdir(this.directory, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      this.entries.clear();
      this.totalBytes = 0;
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".webp")) continue;
        const fullPath = path.join(this.directory, file.name);
        const stat = await fs.promises.stat(fullPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (!stat || stat.size <= 0) continue;
        const accessedAt = stat.atimeMs || stat.mtimeMs;
        const entry = { fileName: file.name, bytes: stat.size, accessedAt, lastAccessPersistAt: accessedAt };
        this.entries.set(file.name.slice(0, -5), entry);
        this.totalBytes += stat.size;
      }
      await this.evictIfNeeded();
      this.initialized = true;
    })().finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  private fileForKey(key: string) {
    const digest = cacheKey(key);
    return { digest, filePath: path.join(this.directory, `${digest}.webp`) };
  }

  async get(key: string) {
    await this.initialize();
    const { digest, filePath } = this.fileForKey(key);
    const entry = this.entries.get(digest);
    if (!entry) return null;
    let stat;
    try { stat = await fs.promises.stat(filePath); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") return null; // Unknown is not proof that disk space was freed.
      stat = null;
    }
    if (!stat || stat.size <= 0) {
      this.entries.delete(digest);
      this.totalBytes = Math.max(0, this.totalBytes - (entry.bytes || 0));
      return null;
    }
    const now = Date.now();
    entry.accessedAt = now;
    if (now - entry.lastAccessPersistAt >= 60 * 60_000) {
      entry.lastAccessPersistAt = now;
      void fs.promises.utimes(filePath, now / 1000, now / 1000).catch((error) => {
        console.debug(`[OnlineCoverCache] access timestamp deferred: ${String(error)}`);
      });
    }
    return { path: filePath, relativePath: `online-covers/${entry.fileName}`, bytes: stat.size };
  }

  async getOrFetch(key: string, url: string): Promise<{ path: string; relativePath: string; bytes: number } | null> {
    const digest = cacheKey(key);
    if (this.clearPromise) return this.clearPromise.then(() => this.getOrFetch(key, url));
    const active = this.active.get(digest);
    if (active) {
      const relative = await active;
      return relative ? this.get(key) : null;
    }
    // Register the promise before the first await. A concurrent clear() can
    // then wait for this operation instead of deleting its output midway.
    const work = this.fetchOrReuse(key, url);
    this.active.set(digest, work);
    try {
      const relative = await work;
      return relative ? this.get(key) : null;
    } finally {
      if (this.active.get(digest) === work) this.active.delete(digest);
    }
  }

  private async fetchOrReuse(key: string, url: string) {
    const existing = await this.get(key);
    if (existing) return existing.relativePath;
    return this.fetchAndStore(key, url);
  }

  promoteBvid(bvid: string, key: string): Promise<string | null> {
    if (this.clearPromise) return this.clearPromise.then(() => this.promoteBvid(bvid, key));
    const work = this.promoteBvidNow(bvid, key);
    this.activePromotions.add(work);
    void work.then(() => this.activePromotions.delete(work), () => this.activePromotions.delete(work));
    return work;
  }

  private async promoteBvidNow(bvid: string, key: string) {
    const cached = await this.get(key);
    if (!cached) return null;
    return (this.adapters.promote ?? promoteOnlineCoverToArchive)(bvid, cached.path);
  }

  async clear() {
    if (this.clearPromise) {
      await this.clearPromise;
      return;
    }
    await this.initialize();
    if (this.clearPromise) {
      await this.clearPromise;
      return;
    }
    const work = (async () => {
      // Invalidate before waiting so an in-flight conversion cannot publish
      // a file after this clear finishes. New fetches wait on clearPromise.
      this.generation += 1;
      await Promise.allSettled([...this.active.values(), ...this.activePromotions]);
      if (this.cleanupPromise) await this.cleanupPromise;
      for (const [digest, entry] of this.entries) {
        if (await this.removeEntryFile(entry)) {
          this.entries.delete(digest);
          this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
        }
      }
      if (this.entries.size > 0) throw new Error("部分在线封面未能删除，已保留占用统计，请稍后重试");
    })();
    this.clearPromise = work;
    try {
      await work;
    } finally {
      if (this.clearPromise === work) this.clearPromise = null;
    }
  }

  async inspect() {
    await this.initialize();
    return { bytes: this.totalBytes, files: this.entries.size, limitBytes: this.limitBytes };
  }

  private async fetchAndStore(key: string, url: string) {
    await this.initialize();
    await this.acquireFetchSlot();
    const generation = this.generation;
    const { digest, filePath } = this.fileForKey(key);
    let root = "";
    try {
      await fs.promises.mkdir(this.temporaryDirectory, { recursive: true });
      root = await fs.promises.mkdtemp(path.join(this.temporaryDirectory, "online-cover-"));
      const source = path.join(root, "source");
      const converted = path.join(root, "cover.webp");
      await (this.adapters.download ?? downloadImage)(url, source);
      await (this.adapters.transcode ?? runCoverFfmpeg)(source, converted, {
        videoFilter: "scale=320:180:force_original_aspect_ratio=increase,crop=320:180",
      });
      const stat = await fs.promises.stat(converted);
      if (!stat.size) throw new Error("online cover conversion produced an empty file");
      if (stat.size > MAX_OUTPUT_BYTES) throw new Error("online cover conversion exceeded size limit");
      if (generation !== this.generation) return null;
      await moveAtomic(converted, filePath).catch(async (error) => {
        if (error?.code === "EEXIST") return;
        throw error;
      });
      const finalStat = await fs.promises.stat(filePath);
      const previous = this.entries.get(digest);
      if (previous) this.totalBytes -= previous.bytes;
      const now = Date.now();
      this.entries.set(digest, { fileName: `${digest}.webp`, bytes: finalStat.size, accessedAt: now, lastAccessPersistAt: now });
      this.totalBytes += finalStat.size;
      await this.evictIfNeeded();
      return `online-covers/${digest}.webp`;
    } catch (error) {
      console.warn(`[OnlineCoverCache] failed: ${safeErrorSummary(error)}`);
      return null;
    } finally {
      try {
        if (root) await (this.adapters.removeTemporary ?? fs.promises.rm)(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch (error) {
        console.warn(`[OnlineCoverCache] temporary cleanup deferred: ${safeErrorSummary(error)}`);
      } finally { this.releaseFetchSlot(); }
    }
  }

  private acquireFetchSlot() {
    if (this.runningFetches < MAX_CONCURRENT_FETCHES) {
      this.runningFetches += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // The finishing request hands its occupied slot directly to this
      // waiter. Incrementing here would leak one slot per hand-off and
      // eventually leave every later cover request waiting forever.
      this.fetchWaiters.push(resolve);
    });
  }

  private releaseFetchSlot() {
    const next = this.fetchWaiters.shift();
    if (next) next();
    else this.runningFetches = Math.max(0, this.runningFetches - 1);
  }

  private async removeEntryFile(entry: OnlineCoverEntry) {
    try { await (this.adapters.unlink ?? fs.promises.unlink)(path.join(this.directory, entry.fileName)); return true; }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return true;
      console.warn(`[OnlineCoverCache] eviction deferred: ${safeErrorSummary(error)}`);
      return false;
    }
  }

  private async evictIfNeeded() {
    // clear() waits for active writes and then removes all entries. Waiting
    // here would make clear() wait for the same fetch that is waiting for
    // clear(), so skip this non-essential cleanup pass instead.
    if (this.clearPromise) return;
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      if (this.totalBytes <= this.limitBytes) return;
      const target = Math.floor(this.limitBytes * EVICT_WATERMARK);
      const candidates = [...this.entries.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
      for (const [digest, entry] of candidates) {
        if (this.totalBytes <= target) break;
        if (this.active.has(digest)) continue;
        if (!await this.removeEntryFile(entry)) continue;
        this.entries.delete(digest);
        this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      }
    })().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }
}
