import { Readable, Transform } from 'node:stream';

interface WaitingRead {
  bytes: number;
  signal: AbortSignal;
  ready(bytes: number): void;
  failed(error: unknown): void;
  abort(): void;
}

/** One FIFO allowance shared by all upload streams; holds no file contents. */
export class ByteRateLimiter {
  private rate = 0;
  private credit = 0;
  private sampledAt = performance.now();
  private waiting: WaitingRead[] = [];
  private timer: NodeJS.Timeout | undefined;

  setBytesPerSecond(rate: number) {
    if (!Number.isSafeInteger(rate) || rate < 0) throw new Error('Invalid byte rate');
    this.refill();
    this.rate = rate;
    // Old unlimited time or a higher previous cap must not fund a new burst.
    this.credit = Math.min(this.credit, this.burst());
    this.pump();
  }

  private burst() { return Math.max(1, Math.ceil(this.rate / 10)); }

  private refill() {
    const now = performance.now();
    this.credit = Math.min(this.burst(), this.credit + (now - this.sampledAt) * this.rate / 1000);
    this.sampledAt = now;
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.refill();
    while (this.waiting.length) {
      const next = this.waiting[0];
      // Split reservations as well as reads: reducing the rate must not leave
      // an old, larger reservation permanently bigger than the token bucket.
      const granted = this.rate === 0 ? next.bytes : Math.min(next.bytes, Math.floor(this.credit));
      if (granted === 0) break;
      if (this.rate !== 0) this.credit -= granted;
      this.waiting.shift();
      next.signal.removeEventListener('abort', next.abort);
      next.ready(granted);
    }
    if (this.waiting.length) {
      const target = Math.min(this.waiting[0].bytes, this.burst());
      const delay = Math.max(5, Math.min(1000, Math.ceil((target - this.credit) * 1000 / this.rate)));
      this.timer = setTimeout(() => this.pump(), delay);
    }
  }

  private take(bytes: number, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.rate === 0 && !this.waiting.length) return Promise.resolve(bytes);
    return new Promise<number>((ready, failed) => {
      const next: WaitingRead = {
        bytes, signal, ready, failed,
        abort: () => {
          this.waiting = this.waiting.filter(item => item !== next);
          failed(signal.reason);
          this.pump();
        },
      };
      signal.addEventListener('abort', next.abort, { once: true });
      this.waiting.push(next);
      this.pump();
    });
  }

  wrap(source: Readable, signal?: AbortSignal): Readable {
    const cancellation = new AbortController();
    const limiter = this;
    const output = new Transform({
      readableHighWaterMark: 16 * 1024, writableHighWaterMark: 16 * 1024,
      transform(chunk: Buffer, _encoding, done) {
        if (!Buffer.isBuffer(chunk)) { done(new Error('Upload source must contain bytes')); return; }
        if (limiter.rate === 0) { done(null, chunk); return; }
        const send = async () => {
          for (let offset = 0; offset < chunk.length;) {
            const length = Math.min(chunk.length - offset, 16 * 1024,
              limiter.rate === 0 ? 16 * 1024 : limiter.burst());
            const granted = await limiter.take(length, cancellation.signal);
            this.push(chunk.subarray(offset, offset + granted));
            offset += granted;
          }
        };
        void send().then(() => done(), done);
      },
      destroy(error, done) {
        cancellation.abort(error ?? new Error('Upload stream closed'));
        source.destroy();
        done(error);
      },
    });
    const abort = () => output.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Upload cancelled'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    output.once('close', () => signal?.removeEventListener('abort', abort));
    const forwardError = (error: Error) => output.destroy(error);
    source.once('error', forwardError);
    source.once('close', () => source.removeListener('error', forwardError));
    source.pipe(output);
    return output;
  }
}
