import { safeErrorSummary } from './diagnostics.js';
import type { ScheduleTimer } from './ports/timer.js';
import { scheduleSystemTimer } from './scheduler/runtime-timers.js';

interface MemoryResources {
  stateCache: { videos: number; relations: number };
  folders: { entries: number; requests: number; generations: number };
  covers: { entries: number; requests: number; promotions: number; waitingFetches: number };
  logs: number;
  queues: { download: number; upload: number; verification: number };
}

interface MemoryObservationOptions {
  resources(): MemoryResources;
  memory?: () => NodeJS.MemoryUsage;
  schedule?: ScheduleTimer;
  emit?: (level: 'info' | 'warn', message: string) => void;
}

/** Low-frequency snapshots only: no database queries, disk scans or forced GC. */
export function createRuntimeMemoryObservation(options: MemoryObservationOptions) {
  const memory = options.memory ?? (() => process.memoryUsage());
  const schedule = options.schedule ?? scheduleSystemTimer;
  const emit = options.emit ?? ((level, message) => console[level](message));
  let cancelTimer: (() => void) | undefined;
  let generation = 0;
  let previousHeapUsed: number | undefined;

  function sample() {
    try {
      const usage = memory();
      const resources = options.resources();
      const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
      const delta = previousHeapUsed === undefined ? 0 : usage.heapUsed - previousHeapUsed;
      emit('info', [
        `[Perf] memory rss_mib=${mib(usage.rss)} heap_used_mib=${mib(usage.heapUsed)} heap_total_mib=${mib(usage.heapTotal)}`,
        `external_mib=${mib(usage.external)} array_buffers_mib=${mib(usage.arrayBuffers)} heap_delta_mib=${mib(delta)}`,
        `state_videos=${resources.stateCache.videos} state_relations=${resources.stateCache.relations}`,
        `folder_entries=${resources.folders.entries} folder_requests=${resources.folders.requests} folder_generations=${resources.folders.generations}`,
        `cover_entries=${resources.covers.entries} cover_requests=${resources.covers.requests} cover_promotions=${resources.covers.promotions} cover_waiters=${resources.covers.waitingFetches}`,
        `log_entries=${resources.logs} download_tasks=${resources.queues.download} upload_tasks=${resources.queues.upload} verification_tasks=${resources.queues.verification}`,
      ].join(' '));
      previousHeapUsed = usage.heapUsed;
    } catch (error) {
      // Diagnostics are an optional observation boundary, never scheduling work.
      emit('warn', `[Perf] memory sampling failed: ${safeErrorSummary(error)}`);
    }
  }

  return {
    start() {
      if (cancelTimer) return;
      const currentGeneration = ++generation;
      cancelTimer = schedule(() => {
        if (currentGeneration === generation && cancelTimer) sample();
      }, 5 * 60_000, true);
      sample();
    },
    stop() {
      generation++;
      cancelTimer?.();
      cancelTimer = undefined;
      previousHeapUsed = undefined;
    },
  };
}
