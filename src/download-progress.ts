import fs from 'node:fs';
import path from 'node:path';

export const downloadProgressPolicy = {
  sampleIntervalMs: 60_000,
  minRuntimeMs: 30 * 60_000,
  windowMs: 10 * 60_000,
  minBytesPerSecond: 10 * 1024,
};

/** A partial directory measurement cannot be used as evidence of stalled progress. */
export async function readDownloadDirectorySize(directory: string): Promise<number> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await readDownloadDirectorySize(target);
      else if (entry.isFile()) total += (await fs.promises.stat(target)).size;
    } catch (error) {
      // BBDown may rename or remove an enumerated child while merging tracks.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

interface Dependencies {
  readSize(): Promise<number>;
  now(): number;
  startedAt: number;
  onSamplingFailure(error: unknown): void;
  onLowSpeed(input: { bytesPerSecond: number; seconds: number; runtimeMs: number }): void;
}

/** The process owns the timer; this sampler owns one in-flight read and its valid window. */
export function createDownloadProgressSampler(deps: Dependencies, policy = downloadProgressPolicy) {
  const samples: Array<{ at: number; size: number }> = [];
  let pending: Promise<void> | undefined;
  let stopped = false;
  let samplingFailed = false;

  async function measure() {
    let size: number;
    try {
      size = await deps.readSize();
    } catch (error) {
      if (stopped) return;
      samples.length = 0;
      if (!samplingFailed) deps.onSamplingFailure(error);
      samplingFailed = true;
      return;
    }
    if (stopped) return;
    samplingFailed = false;
    const now = deps.now();
    const previous = samples[samples.length - 1];
    // Merging removes temporary tracks; a shrinking directory starts a new baseline.
    if (previous && (size < previous.size || now < previous.at)) samples.length = 0;
    samples.push({ at: now, size });
    while (samples.length > 1 && samples[1].at <= now - policy.windowMs) samples.shift();
    const first = samples[0];
    if (now - deps.startedAt < policy.minRuntimeMs || now - first.at < policy.windowMs) return;
    const seconds = (now - first.at) / 1000;
    const bytesPerSecond = (size - first.size) / seconds;
    if (bytesPerSecond >= policy.minBytesPerSecond) return;
    stopped = true;
    samples.length = 0;
    deps.onLowSpeed({ bytesPerSecond, seconds, runtimeMs: now - deps.startedAt });
  }

  return {
    sample() {
      if (pending) return pending;
      if (stopped) return Promise.resolve();
      pending = Promise.resolve().then(measure).finally(() => { pending = undefined; });
      return pending;
    },
    stop() { stopped = true; samples.length = 0; },
  };
}
