import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import net from "node:net";
import { spawn } from "node:child_process";
import { coversDir, tempDir } from "./paths.js";
import { safeErrorSummary } from "./diagnostics.js";
import type { StateManager, VideoArchiveEntry } from "./state.js";
import {
  LEGACY_UNAVAILABLE_COVER_BACKFILL_MARKER,
  UNAVAILABLE_COVER_BACKFILL_MARKER,
} from "./database.js";

interface CoverJobResult {
  path: string | null;
  error?: unknown;
}
const activeCoverJobs = new Map<string, Promise<CoverJobResult>>();
interface PendingCoverJob {
  bvid: string;
  coverUrl: string;
  onCached?: (relativePath: string) => void;
  resolve: (result: CoverJobResult) => void;
  background: boolean;
}
const pendingCoverJobs: PendingCoverJob[] = [];
let runningCoverJobs = 0;
const maxCoverJobs = 1;
let lastBackgroundCoverStartedAt = 0;
let coverQueueTimer: NodeJS.Timeout | null = null;
let coverQueueIdleResolvers: Array<() => void> = [];

const maxCoverBytes = 8 * 1024 * 1024;
const allowedCoverHosts = [".hdslb.com", ".biliimg.com"];

class CoverDownloadError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

function safeBvid(value: string) {
  return String(value || "").replace(/[^0-9A-Za-z]/g, "");
}

function coverPathForBvid(bvid: string) {
  return path.join(coversDir, `${safeBvid(bvid)}.webp`);
}

export function coverRelativePathForBvid(bvid: string) {
  return `covers/${safeBvid(bvid)}.webp`;
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export function runCoverFfmpeg(
  inputPath: string,
  outputPath: string,
  options: { timeoutMs?: number; spawnImpl?: typeof spawn } = {}
) {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      "scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2",
      "-c:v",
      "libwebp",
      "-quality",
      "70",
      outputPath,
    ];
    const child = (options.spawnImpl || spawn)(ffmpegPath(), args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      reject(new Error("ffmpeg cover conversion timed out"));
    }, Math.max(1, options.timeoutMs ?? 15_000));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.toString().slice(0, 4_096 - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function isPrivateIp(address: string) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::" || normalized === "::1"
    || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("ff") || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("::ffff:");
}

export function normalizeBilibiliCoverUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoverDownloadError("cover URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowedHost = allowedCoverHosts.some((suffix) => hostname.endsWith(suffix));
  if (url.protocol === "http:" && allowedHost && !url.username && !url.password
    && (!url.port || url.port === "80")) {
    url.protocol = "https:";
    url.port = "";
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !allowedHost) {
    throw new CoverDownloadError("cover URL is outside allowed Bilibili image hosts");
  }
  url.hostname = hostname;
  url.hash = "";
  return url;
}

export async function validateBilibiliCoverUrl(value: string) {
  const url = normalizeBilibiliCoverUrl(value);
  const hostname = url.hostname;
  if (net.isIP(hostname) && isPrivateIp(hostname)) throw new CoverDownloadError("cover URL resolves to a private address");
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new CoverDownloadError("cover host lookup failed", true);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new CoverDownloadError("cover host resolved to a private address");
  }
  return url;
}

async function downloadCover(value: string, outputPath: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    let current = await validateBilibiliCoverUrl(value);
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      try {
        response = await fetch(current, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: "https://www.bilibili.com/",
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error: any) {
        throw new CoverDownloadError(error?.name === "AbortError" ? "cover download timed out" : "cover download failed", true);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new CoverDownloadError("cover redirect is invalid");
      current = await validateBilibiliCoverUrl(new URL(location, current).toString());
    }
    if (!response || !response.ok || !response.body) {
      const status = response?.status || 0;
      throw new CoverDownloadError(`cover download failed: HTTP ${status}`, status === 429 || status >= 500);
    }
    const type = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (!type.startsWith("image/")) throw new CoverDownloadError("cover response is not an image");
    if (declaredLength > maxCoverBytes) throw new CoverDownloadError("cover response exceeds 8 MB");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxCoverBytes) {
        await reader.cancel();
        throw new CoverDownloadError("cover response exceeds 8 MB");
      }
      chunks.push(Buffer.from(value));
    }
    await fs.promises.writeFile(outputPath, Buffer.concat(chunks, total), { flag: "wx" });
  } finally {
    clearTimeout(timeout);
  }
}

async function moveAcrossMounts(source: string, target: string) {
  try {
    await fs.promises.rename(source, target);
  } catch (error: any) {
    if (!["EXDEV", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source).catch(() => undefined);
  }
}

async function cacheCoverInternal(bvid: string, coverUrl: string) {
  const normalizedBvid = safeBvid(bvid);
  if (!normalizedBvid || !coverUrl) {
    return null;
  }
  await fs.promises.mkdir(coversDir, { recursive: true });
  const finalPath = coverPathForBvid(normalizedBvid);
  if (fs.existsSync(finalPath)) {
    return coverRelativePathForBvid(normalizedBvid);
  }

  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join(tempDir, `cover-${normalizedBvid}-`));
  const rawPath = path.join(tempRoot, "source");
  const tempWebp = path.join(tempRoot, "cover.webp");
  try {
    await downloadCover(coverUrl, rawPath);
    await runCoverFfmpeg(rawPath, tempWebp);
    await moveAcrossMounts(tempWebp, finalPath);
    return coverRelativePathForBvid(normalizedBvid);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function cacheLocalCover(bvid: string, sourcePath: string) {
  const normalizedBvid = safeBvid(bvid);
  if (!normalizedBvid || !sourcePath || !fs.existsSync(sourcePath)) return null;
  await fs.promises.mkdir(coversDir, { recursive: true });
  const finalPath = coverPathForBvid(normalizedBvid);
  if (fs.existsSync(finalPath)) return coverRelativePathForBvid(normalizedBvid);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join(tempDir, `cover-local-${normalizedBvid}-`));
  const tempWebp = path.join(tempRoot, "cover.webp");
  try {
    await runCoverFfmpeg(sourcePath, tempWebp);
    await moveAcrossMounts(tempWebp, finalPath);
    return coverRelativePathForBvid(normalizedBvid);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

function notifyCoverQueueIdle() {
  if (runningCoverJobs > 0 || pendingCoverJobs.length > 0 || coverQueueTimer) return;
  const resolvers = coverQueueIdleResolvers;
  coverQueueIdleResolvers = [];
  resolvers.forEach((resolve) => resolve());
}

function enqueueCoverCache(bvid: string, coverUrl: string, background: boolean): Promise<CoverJobResult> {
  const normalizedBvid = safeBvid(bvid);
  if (!normalizedBvid || !coverUrl) {
    return Promise.resolve({ path: null } satisfies CoverJobResult);
  }
  if (fs.existsSync(coverPathForBvid(normalizedBvid))) {
    return Promise.resolve({ path: coverRelativePathForBvid(normalizedBvid) } satisfies CoverJobResult);
  }
  const active = activeCoverJobs.get(normalizedBvid);
  if (active) return active;
  let resolveJob!: (result: CoverJobResult) => void;
  const promise = new Promise<CoverJobResult>((resolve) => {
    resolveJob = resolve;
  });
  activeCoverJobs.set(normalizedBvid, promise);
  pendingCoverJobs.push({ bvid: normalizedBvid, coverUrl, resolve: resolveJob, background });
  if (!background && coverQueueTimer) {
    clearTimeout(coverQueueTimer);
    coverQueueTimer = null;
  }
  runNextCoverJob();
  return promise;
}

export function queueCoverCache(bvid: string, coverUrl: string, onCached?: (relativePath: string) => void) {
  void enqueueCoverCache(bvid, coverUrl, false).then((result) => {
    if (result.path) onCached?.(result.path);
  });
}

function runNextCoverJob() {
  if (runningCoverJobs >= maxCoverJobs) {
    return;
  }
  const normalIndex = pendingCoverJobs.findIndex((job) => !job.background);
  const nextIndex = normalIndex >= 0 ? normalIndex : 0;
  const next = pendingCoverJobs[nextIndex];
  if (!next) {
    notifyCoverQueueIdle();
    return;
  }
  if (next.background) {
    const delay = Math.max(0, 2_000 - (Date.now() - lastBackgroundCoverStartedAt));
    if (delay > 0) {
      if (!coverQueueTimer) {
        coverQueueTimer = setTimeout(() => {
          coverQueueTimer = null;
          runNextCoverJob();
        }, delay);
        coverQueueTimer.unref?.();
      }
      return;
    }
    lastBackgroundCoverStartedAt = Date.now();
  }
  pendingCoverJobs.splice(nextIndex, 1);
  runningCoverJobs += 1;
  const job = cacheCoverInternal(next.bvid, next.coverUrl)
    .then((relativePath) => {
      const result = { path: relativePath } satisfies CoverJobResult;
      next.resolve(result);
      return result;
    })
    .catch((error) => {
      console.warn(`[CoverCache] Failed to cache ${next.bvid}: ${safeErrorSummary(error)}`);
      const result = { path: null, error } satisfies CoverJobResult;
      next.resolve(result);
      return result;
    })
    .finally(() => {
      activeCoverJobs.delete(next.bvid);
      runningCoverJobs -= 1;
      runNextCoverJob();
      notifyCoverQueueIdle();
    });
  activeCoverJobs.set(next.bvid, job);
}

export function waitForCoverCacheIdle(timeoutMs = 20_000) {
  if (runningCoverJobs === 0 && pendingCoverJobs.length === 0 && !coverQueueTimer) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    coverQueueIdleResolvers.push(() => finish(true));
    const timeout = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timeout.unref?.();
  });
}

function parseVideoPayload(value: unknown) {
  try {
    return JSON.parse(String(value || "")) as VideoArchiveEntry;
  } catch {
    return null;
  }
}

function sleepWithStop(ms: number, stopped: () => boolean) {
  return new Promise<boolean>((resolve) => {
    if (stopped()) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(!stopped()), ms);
    timer.unref?.();
    const poll = setInterval(() => {
      if (!stopped()) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(false);
    }, 250);
    poll.unref?.();
    setTimeout(() => clearInterval(poll), ms + 500).unref?.();
  });
}

export class UnavailableCoverBackfill {
  private stopped = false;
  private running: Promise<void> | null = null;
  private restartScheduled = false;

  constructor(
    private readonly stateManager: StateManager,
    private readonly options: {
      coverExists?: (bvid: string) => Promise<boolean>;
      enqueue?: (bvid: string, coverUrl: string) => Promise<{ path: string | null; retryable?: boolean }>;
      retryDelaysMs?: [number, number];
    } = {}
  ) {}

  start() {
    if (!this.running) {
      this.stopped = false;
      this.running = this.run().finally(() => { this.running = null; });
    }
    return this.running;
  }

  async stop(timeoutMs = 20_000) {
    this.stopped = true;
    if (!this.running) return true;
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    });
    const result = await Promise.race([this.running.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  restart() {
    if (!this.running) {
      void this.start();
      return;
    }
    if (this.restartScheduled) return;
    this.restartScheduled = true;
    void this.running.finally(() => {
      this.restartScheduled = false;
      if (this.stopped) void this.start();
    });
  }

  private async run() {
    const database = this.stateManager.getDatabase();
    if (database.getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER)) return;
    const summary = { linked: 0, downloaded: 0, skipped: 0, failed: 0 };
    let rows: any[];
    try {
      rows = database.db.prepare(`
        SELECT bvid, payload_json FROM videos
        WHERE bili_status='unavailable'
        ORDER BY bvid ASC
      `).all() as any[];
    } catch (error) {
      console.warn(`[CoverBackfill] Unable to enumerate unavailable videos: ${safeErrorSummary(error)}`);
      return;
    }

    for (const row of rows) {
      if (this.stopped) return;
      const video = parseVideoPayload(row.payload_json);
      const bvid = safeBvid(String(row.bvid || ""));
      if (!video || !bvid) {
        summary.skipped += 1;
        continue;
      }
      const relativePath = coverRelativePathForBvid(bvid);
      try {
        const exists = this.options.coverExists
          ? await this.options.coverExists(bvid)
          : await fs.promises.access(coverPathForBvid(bvid), fs.constants.R_OK).then(() => true);
        if (this.stopped) return;
        if (!exists) throw new Error("cover missing");
        if (video.originalMeta?.coverLocalPath !== relativePath) {
          if (this.stateManager.recordCoverCache(bvid, relativePath)) summary.linked += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      } catch {}

      const coverUrl = String(video.originalMeta?.cover || video.cover || "").trim();
      if (!coverUrl) {
        summary.skipped += 1;
        continue;
      }
      let completed = false;
      for (let attempt = 0; attempt < 3 && !this.stopped; attempt += 1) {
        if (attempt > 0) {
          const retryDelays = this.options.retryDelaysMs || [60_000, 10 * 60_000];
          const ready = await sleepWithStop(retryDelays[attempt - 1], () => this.stopped);
          if (!ready) return;
        }
        const result = this.options.enqueue
          ? await this.options.enqueue(bvid, coverUrl)
          : await enqueueCoverCache(bvid, coverUrl, true).then((job) => ({
              path: job.path,
              retryable: job.error instanceof CoverDownloadError && job.error.retryable,
            }));
        if (this.stopped) return;
        if (result.path) {
          this.stateManager.recordCoverCache(bvid, result.path);
          summary.downloaded += 1;
          completed = true;
          break;
        }
        if (!result.retryable) break;
      }
      if (!completed) summary.failed += 1;
    }
    if (this.stopped) return;
    database.deleteMeta(LEGACY_UNAVAILABLE_COVER_BACKFILL_MARKER);
    database.setMeta(UNAVAILABLE_COVER_BACKFILL_MARKER, JSON.stringify({ ...summary, completedAt: new Date().toISOString() }));
    console.log(`[CoverBackfill] Complete: linked=${summary.linked}, downloaded=${summary.downloaded}, skipped=${summary.skipped}, failed=${summary.failed}`);
  }
}
