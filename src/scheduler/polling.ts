export interface PollingDependencies {
  now(): number;
  random(): number;
  run(): void;
  schedule?: (callback: () => void, delayMs: number, recurring: boolean) => () => void;
}

function schedule(callback: () => void, delayMs: number, recurring: boolean) {
  if (recurring) {
    const timer = setInterval(callback, delayMs);
    return () => clearInterval(timer);
  }
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

/** Owns scan timers only. Admission and running scans remain with scheduling control. */
export function createPollingSchedule(dependencies: PollingDependencies) {
  const register = dependencies.schedule || schedule;
  let cancelInterval: (() => void) | undefined;
  let cancelStartup: (() => void) | undefined;
  let activeInterval: number | undefined;
  let generation = 0;
  let nextRunAt: number | undefined;
  let nextIntervalAt: number | undefined;
  let nextStartupAt: number | undefined;

  function updateNextRunAt() {
    nextRunAt = nextIntervalAt === undefined ? nextStartupAt
      : nextStartupAt === undefined ? nextIntervalAt
      : Math.min(nextIntervalAt, nextStartupAt);
  }

  function stop() {
    generation += 1;
    cancelInterval?.();
    cancelStartup?.();
    cancelInterval = cancelStartup = undefined;
    activeInterval = undefined;
    nextIntervalAt = nextStartupAt = undefined;
    nextRunAt = undefined;
  }

  function start(intervalMs: number) {
    if (activeInterval === intervalMs) return false;
    stop();
    activeInterval = intervalMs;
    const current = generation;
    const startupJitter = 30_000 + Math.floor(dependencies.random() * 90_000);
    const startedAt = dependencies.now();
    nextStartupAt = startedAt + startupJitter;
    nextIntervalAt = startedAt + intervalMs;
    updateNextRunAt();
    cancelInterval = register(() => {
      if (generation !== current) return;
      nextIntervalAt = dependencies.now() + intervalMs;
      updateNextRunAt();
      dependencies.run();
    }, intervalMs, true);
    cancelStartup = register(() => {
      if (generation !== current) return;
      cancelStartup = undefined;
      nextStartupAt = undefined;
      updateNextRunAt();
      dependencies.run();
    }, startupJitter, false);
    return true;
  }

  return { start, stop, getNextRunAt: () => nextRunAt };
}
