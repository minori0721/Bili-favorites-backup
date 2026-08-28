import crypto from "node:crypto";

export type BackgroundPreviewStatus = "scanning" | "ready" | "failed" | "expired";

export interface BackgroundPreviewSnapshot<T> {
  id: string;
  key: string;
  status: BackgroundPreviewStatus;
  startedAt: number;
  completedAt?: number;
  expiresAt?: number;
  result?: T;
  error?: string;
}

interface PreviewEntry<T> extends BackgroundPreviewSnapshot<T> {
  promise?: Promise<void>;
}

export interface BackgroundPreviewCacheOptions {
  ttlMs?: number;
  failedTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function summarizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "后台预览失败");
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300) || "后台预览失败";
}

export class BackgroundPreviewCache<T> {
  private readonly ttlMs: number;
  private readonly failedTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly active = new Map<string, PreviewEntry<T>>();
  private readonly entries = new Map<string, PreviewEntry<T>>();
  private stopping = false;

  constructor(options: BackgroundPreviewCacheOptions = {}) {
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? 5 * 60_000));
    this.failedTtlMs = Math.max(1_000, Math.floor(options.failedTtlMs ?? 30_000));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 32));
    this.now = options.now || Date.now;
  }

  start(key: string, runner: () => Promise<T>, options: { force?: boolean } = {}) {
    if (this.stopping) throw new Error("后台预览服务正在关闭");
    const normalizedKey = String(key || "");
    const current = this.active.get(normalizedKey);
    if (current) return this.snapshot(current);

    const cached = this.entries.get(normalizedKey);
    if (!options.force && cached && cached.status === "ready" && (cached.expiresAt || 0) > this.now()) {
      return this.snapshot(cached);
    }

    const startedAt = this.now();
    const entry: PreviewEntry<T> = {
      id: crypto.randomUUID(),
      key: normalizedKey,
      status: "scanning",
      startedAt,
    };
    this.entries.set(normalizedKey, entry);
    this.active.set(normalizedKey, entry);
    entry.promise = Promise.resolve()
      .then(runner)
      .then((result) => {
        entry.status = "ready";
        entry.result = result;
        entry.completedAt = this.now();
        entry.expiresAt = entry.completedAt + this.ttlMs;
        if (this.active.get(normalizedKey) === entry) this.active.delete(normalizedKey);
        this.evictExpiredAndOverflow();
      })
      .catch((error) => {
        entry.status = "failed";
        entry.error = summarizeError(error);
        entry.completedAt = this.now();
        entry.expiresAt = entry.completedAt + this.failedTtlMs;
        if (this.active.get(normalizedKey) === entry) this.active.delete(normalizedKey);
        this.evictExpiredAndOverflow();
      });
    void entry.promise;
    this.evictExpiredAndOverflow();
    return this.snapshot(entry);
  }

  get(id: string) {
    const entry = [...this.entries.values()].find((candidate) => candidate.id === String(id || ""));
    if (!entry) return undefined;
    if (entry.status !== "scanning" && (entry.expiresAt || 0) <= this.now()) {
      entry.status = "expired";
      entry.result = undefined;
      entry.error = undefined;
    }
    return this.snapshot(entry);
  }

  async waitForIdle(timeoutMs = 5_000) {
    const promises = [...this.active.values()]
      .map((entry) => entry.promise)
      .filter((promise): promise is Promise<void> => Boolean(promise));
    if (promises.length === 0) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, Math.max(0, timeoutMs));
      timeout.unref?.();
    });
    await Promise.race([Promise.allSettled(promises).then(() => undefined), deadline]);
    if (timeout) clearTimeout(timeout);
    return this.active.size === 0;
  }

  async stop(timeoutMs = 5_000) {
    this.stopping = true;
    return this.waitForIdle(timeoutMs);
  }

  get activeCount() {
    return this.active.size;
  }

  private snapshot(entry: PreviewEntry<T>): BackgroundPreviewSnapshot<T> {
    return {
      id: entry.id,
      key: entry.key,
      status: entry.status,
      startedAt: entry.startedAt,
      ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private evictExpiredAndOverflow() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.status !== "scanning" && (entry.expiresAt || 0) <= now && this.active.get(key) !== entry) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size <= this.maxEntries) return;
    const removable = [...this.entries.entries()]
      .filter(([key, entry]) => this.active.get(key) !== entry)
      .sort(([, left], [, right]) => (left.completedAt || left.startedAt) - (right.completedAt || right.startedAt));
    while (this.entries.size > this.maxEntries && removable.length > 0) {
      const [key] = removable.shift()!;
      this.entries.delete(key);
    }
  }
}
