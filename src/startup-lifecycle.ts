import { waitForQuiescence } from './scheduler/quiescence.js';

/** Serial startup work remains owned until its current asynchronous step settles. */
export function createStartupLifecycle(steps: ReadonlyArray<() => void | Promise<unknown>>) {
  let stopped = false;
  let started = false;
  let running = false;
  let work: Promise<void> | undefined;

  function start(): Promise<void> {
    if (work) return work;
    if (started || stopped) return Promise.resolve();
    started = true;
    running = true;
    work = (async () => {
      try {
        for (const step of steps) {
          if (stopped) return;
          await step();
        }
      } finally { running = false; }
    })();
    return work;
  }

  return {
    start,
    stop() { stopped = true; },
    waitForIdle(timeoutMs: number) { return waitForQuiescence(() => running, timeoutMs); },
  };
}
