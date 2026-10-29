import { setTimeout as sleep } from 'node:timers/promises';

export type PlaybackUpstreamResult =
  | { directLocation: string; response?: undefined; cachedDirect?: boolean }
  | { response: Response; directLocation?: undefined; cachedDirect?: false };

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Only the absolute expiry format observed on signed storage URLs is cached. */
export function playbackLinkExpiresAt(location: string): number | null {
  const fields = [...new URL(location).searchParams].filter(([key]) => key.toLowerCase() === 'expires');
  if (fields.length !== 1 || !/^\d{1,12}$/.test(fields[0][1])) return null;
  const seconds = Number(fields[0][1]);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export class PlaybackDirectLinks {
  private readonly entries = new Map<string, { location: string; expiresAt: number }>();
  private readonly pending = new Map<string, { promise: Promise<string | null> }>();
  constructor(private readonly now: () => number = Date.now, private readonly limit = 256) {}

  clear() { this.entries.clear(); this.pending.clear(); }
  forget(key: string) { this.entries.delete(key); this.pending.delete(key); }

  async resolve(
    key: string,
    load: () => Promise<PlaybackUpstreamResult>,
    signal: AbortSignal,
    refresh = false,
  ): Promise<PlaybackUpstreamResult> {
    signal.throwIfAborted();
    const previousLocation = refresh ? this.entries.get(key)?.location : undefined;
    if (refresh) this.forget(key);
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt - this.now() > 60_000) {
      this.entries.delete(key); this.entries.set(key, entry);
      return { directLocation: entry.location, cachedDirect: true };
    }
    this.entries.delete(key);
    // A streamed response body belongs to its original request. Waiters share
    // only redirect locations and make their own request for proxy responses.
    while (this.pending.has(key)) {
      const location = await waitFor(this.pending.get(key)!.promise, signal);
      if (location) return { directLocation: location, cachedDirect: true };
    }
    let finish!: (location: string | null) => void;
    const pending = { promise: new Promise<string | null>(resolve => { finish = resolve; }) };
    this.pending.set(key, pending);
    try {
      const result = await load();
      if (signal.aborted) await result.response?.body?.cancel();
      signal.throwIfAborted();
      if (result.directLocation && result.directLocation !== previousLocation && this.pending.get(key) === pending) {
        const expiresAt = playbackLinkExpiresAt(result.directLocation);
        if (expiresAt !== null && expiresAt - this.now() > 60_000) {
          for (const [id, cached] of this.entries) if (cached.expiresAt - this.now() <= 60_000) this.entries.delete(id);
          this.entries.set(key, { location: result.directLocation, expiresAt });
          while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
        }
      }
      finish(result.directLocation ?? null);
      return result;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      finish(null);
    }
  }
}

interface DirectoryRequest {
  controller: AbortController;
  promise: Promise<void>;
  subscribers: number;
}

/** One background directory read at a time, shared by callers, without a TTL mirror. */
export class PlaybackDirectoryPreparation {
  private readonly pending = new Map<string, DirectoryRequest>();
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  constructor(private readonly now: () => number = Date.now, private readonly intervalMs = 2_000) {}

  clear() {
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
    this.nextAt = 0;
  }

  async prepare(key: string, read: (signal: AbortSignal) => Promise<void>, signal: AbortSignal,
    pauseOnError: (error: unknown) => boolean = () => true) {
    signal.throwIfAborted();
    let request = this.pending.get(key);
    if (!request || request.controller.signal.aborted) {
      if (this.pending.size >= 32) throw new Error('Playback directory preparation queue full');
      const controller = new AbortController();
      const previous = this.tail;
      request = { controller, promise: Promise.resolve(), subscribers: 0 };
      const own = request;
      own.promise = previous.then(async () => {
        controller.signal.throwIfAborted();
        // A failed storage request pauses the whole background lane. New
        // visitors must not start another retry loop during that pause.
        const wait = this.nextAt - this.now();
        if (wait > this.intervalMs) throw new Error('Playback directory preparation paused');
        if (wait > 0) await sleep(wait, undefined, { signal: controller.signal });
        try {
          await read(controller.signal);
          this.nextAt = this.now() + this.intervalMs;
        } catch (error) {
          if (!controller.signal.aborted && pauseOnError(error)) this.nextAt = this.now() + 60_000;
          throw error;
        }
      }).finally(() => { if (this.pending.get(key) === own) this.pending.delete(key); });
      this.tail = own.promise.catch(() => {
        if (!controller.signal.aborted) console.debug('[Playback] background directory preparation failed');
      });
      this.pending.set(key, own);
    }
    request.subscribers++;
    try { await waitFor(request.promise, signal); }
    finally {
      if (--request.subscribers === 0 && this.pending.get(key) === request) request.controller.abort();
    }
  }
}
