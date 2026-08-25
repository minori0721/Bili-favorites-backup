import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { onlineCoversDir, tempDir } from "./paths.js";
import { promoteOnlineCoverToArchive, runCoverFfmpeg, validateBilibiliCoverUrl } from "./cover-cache.js";
import { safeErrorSummary } from "./diagnostics.js";

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
  } catch (error: any) {
    if (! ["EXDEV", "EPERM", "EACCES"].includes(error?.code)) throw error;
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source).catch(() => undefined);
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
      await response.body?.cancel();
      if (!location || hop === 5) throw new Error("online cover redirect limit exceeded");
      current = await validateBilibiliCoverUrl(new URL(location, current).toString());
    }
    if (!response?.ok || !response.body) throw new Error(`online cover request failed: ${response?.status || 0}`);
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("online cover response is not an image");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) throw new Error("online cover exceeds size limit");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error("online cover exceeds size limit");
      }
      chunks.push(Buffer.from(part.value));
    }
    await fs.promises.writeFile(outputPath, Buffer.concat(chunks, total), { flag: "wx" });
  } finally {
    clearTimeout(timeout);
  }
}

export class OnlineCoverCache {
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

  constructor(limitMb = 256) {
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
      await fs.promises.mkdir(onlineCoversDir, { recursive: true });
      const files = await fs.promises.readdir(onlineCoversDir, { withFileTypes: true }).catch(() => []);
      this.entries.clear();
      this.totalBytes = 0;
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".webp")) continue;
        const fullPath = path.join(onlineCoversDir, file.name);
        const stat = await fs.promises.stat(fullPath).catch(() => null);
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
    return { digest, filePath: path.join(onlineCoversDir, `${digest}.webp`) };
  }

  async get(key: string) {
    await this.initialize();
    const { digest, filePath } = this.fileForKey(key);
    const entry = this.entries.get(digest);
    if (!entry) return null;
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size <= 0) {
      this.entries.delete(digest);
      this.totalBytes = Math.max(0, this.totalBytes - (entry.bytes || 0));
      return null;
    }
    const now = Date.now();
    entry.accessedAt = now;
    if (now - entry.lastAccessPersistAt >= 60 * 60_000) {
      entry.lastAccessPersistAt = now;
      void fs.promises.utimes(filePath, now / 1000, now / 1000).catch(() => undefined);
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
    return promoteOnlineCoverToArchive(bvid, cached.path);
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
      for (const entry of this.entries.values()) {
        await fs.promises.unlink(path.join(onlineCoversDir, entry.fileName)).catch(() => undefined);
      }
      this.entries.clear();
      this.totalBytes = 0;
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
      await fs.promises.mkdir(tempDir, { recursive: true });
      root = await fs.promises.mkdtemp(path.join(tempDir, "online-cover-"));
      const source = path.join(root, "source");
      const converted = path.join(root, "cover.webp");
      await downloadImage(url, source);
      await runCoverFfmpeg(source, converted, {
        videoFilter: "scale=320:180:force_original_aspect_ratio=increase,crop=320:180",
      });
      const stat = await fs.promises.stat(converted);
      if (!stat.size) throw new Error("online cover conversion produced an empty file");
      if (stat.size > MAX_OUTPUT_BYTES) throw new Error("online cover conversion exceeded size limit");
      if (generation !== this.generation) return null;
      await moveAtomic(converted, filePath).catch(async (error: any) => {
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
      if (root) await fs.promises.rm(root, { recursive: true, force: true });
      this.releaseFetchSlot();
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
        await fs.promises.unlink(path.join(onlineCoversDir, entry.fileName)).catch(() => undefined);
        this.entries.delete(digest);
        this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
      }
    })().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }
}
