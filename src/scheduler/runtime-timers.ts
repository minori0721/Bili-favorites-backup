import type { ScheduleTimer } from '../ports/timer.js';

export type RuntimeTimer = 'projection' | 'dispatch' | 'heartbeat' | 'uploadProbe' | 'downloadStart' | 'queuedSync';

export const scheduleSystemTimer: ScheduleTimer = (callback, delayMs, recurring) => {
  const timer = recurring ? setInterval(callback, delayMs) : setTimeout(callback, delayMs);
  timer.unref();
  return () => { if (recurring) clearInterval(timer); else clearTimeout(timer); };
};

/** Owns timer registrations and invalidates callbacks from replaced or cancelled timers. */
export function createRuntimeTimers(schedule: ScheduleTimer = scheduleSystemTimer) {
  const registrations = new Map<RuntimeTimer, { cancel(): void }>();
  function cancel(key: RuntimeTimer) {
    const previous = registrations.get(key);
    registrations.delete(key);
    previous?.cancel();
  }
  function start(key: RuntimeTimer, callback: () => void, delayMs: number, recurring = false) {
    cancel(key);
    const entry = { cancel: () => {} };
    registrations.set(key, entry);
    try {
      entry.cancel = schedule(() => {
        if (registrations.get(key) !== entry) return;
        if (!recurring) registrations.delete(key);
        callback();
      }, delayMs, recurring);
    } catch (error) {
      registrations.delete(key);
      throw error;
    }
  }
  return {
    start, cancel,
    has: (key: RuntimeTimer) => registrations.has(key),
    stopProducers() {
      for (const key of registrations.keys()) if (key !== 'heartbeat') cancel(key);
    },
    dispose() { for (const key of registrations.keys()) cancel(key); },
  };
}
