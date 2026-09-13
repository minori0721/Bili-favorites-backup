import { waitForQuiescence } from './scheduler/quiescence.js';

export interface StartupStep {
  name: string;
  run(): unknown;
  onDegraded?: (error: unknown) => void;
}
export type StartupOutcome = { name: string; status: 'success' | 'degraded' | 'failed' };

export function optionalStartupStep(name: string, run: StartupStep['run'], report: (error: unknown) => void): StartupStep {
  return { name, run, onDegraded: report };
}

/** Serial startup work remains owned until its current asynchronous step settles. */
export function createStartupLifecycle(steps: ReadonlyArray<StartupStep | (() => void | Promise<unknown>)>) {
  let stopped = false;
  let started = false;
  let running = false;
  let work: Promise<void> | undefined;
  const outcomes: StartupOutcome[] = [];

  function start(): Promise<void> {
    if (work) return work;
    if (started || stopped) return Promise.resolve();
    started = true;
    running = true;
    work = (async () => {
      try {
        for (const [index, entry] of steps.entries()) {
          if (stopped) return;
          const step: StartupStep = typeof entry === 'function' ? { name: `step-${index + 1}`, run: entry } : entry;
          try {
            await step.run();
            outcomes.push({ name: step.name, status: 'success' });
          } catch (error) {
            outcomes.push({ name: step.name, status: step.onDegraded ? 'degraded' : 'failed' });
            if (!step.onDegraded) throw error;
            step.onDegraded(error);
          }
        }
      } finally { running = false; }
    })();
    return work;
  }

  return {
    start,
    outcomes: () => outcomes.map(outcome => ({ ...outcome })),
    stop() { stopped = true; },
    waitForIdle(timeoutMs: number) { return waitForQuiescence(() => running, timeoutMs); },
  };
}
