import { performance } from 'node:perf_hooks';

type Outcome = 'ok' | 'error';
type Level = 'info' | 'warn';

interface Options {
  slowMs: number;
  windowMs?: number;
  now?: () => number;
  emit?: (level: Level, message: string) => void;
}

/** Emits one immediate slow warning per window and a compact periodic summary. */
export function createDurationObservation(name: string, options: Options) {
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? ((level: Level, message: string) => console[level](message));
  const windowMs = options.windowMs ?? 5 * 60_000;
  let windowStartedAt = now();
  let count = 0;
  let errors = 0;
  let slow = 0;
  let totalMs = 0;
  let maxMs = 0;
  let warned = false;

  function record(durationMs: number, outcome: Outcome, detail?: { files: number; bytes: number }) {
    const current = now();
    if (current - windowStartedAt >= windowMs) {
      if (count > 0) {
        emit('info', `[Perf] ${name} count=${count} errors=${errors} slow=${slow} avg_ms=${Math.round(totalMs / count)} max_ms=${Math.round(maxMs)} window_ms=${Math.round(current - windowStartedAt)}`);
      }
      windowStartedAt = current;
      count = errors = slow = totalMs = maxMs = 0;
      warned = false;
    }
    count++;
    totalMs += durationMs;
    maxMs = Math.max(maxMs, durationMs);
    if (outcome === 'error') errors++;
    if (durationMs >= options.slowMs) {
      slow++;
      if (!warned) {
        emit('warn', `[Perf] ${name} slow duration_ms=${Math.round(durationMs)} threshold_ms=${options.slowMs} result=${outcome}${detail ? ` files=${detail.files} bytes=${detail.bytes}` : ''}`);
        warned = true;
      }
    }
  }

  return { record };
}
