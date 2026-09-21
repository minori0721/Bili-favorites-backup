import { waitForQuiescence, type QuiescenceClock } from './quiescence.js';

import type { ShutdownOptions } from '../ports/scheduler-control.js';
export type { ShutdownOptions } from '../ports/scheduler-control.js';
interface Dependencies {
  initiallyAccepting: boolean;
  stopProducers(): void;
  beginDrain(): void;
  busy(): boolean;
  releaseWork(): void;
  closeDatabase(): void;
  canRebind(): boolean;
  rebindAdapters(): void;
  resumeAfterRebind(): void;
  clock?: QuiescenceClock;
}

/** Owns admission, generation and shutdown/rebind transitions, independently of business workflows. */
export function createSchedulingRuntime(deps: Dependencies) {
  let accepting = deps.initiallyAccepting;
  let generation = 0;
  let shuttingDown = false;
  let closed = false;
  let shutdown: Promise<void> | null = null;
  let resumeAdmission: boolean | null = null;
  let adaptersRebound = false;
  let initialized = false;

  function stop() {
    accepting = false;
    deps.stopProducers();
  }
  function closeAdmissionForShutdown() {
    if (!shuttingDown) generation++;
    shuttingDown = true;
    accepting = false;
  }
  function beginShutdown() {
    if (closed) return;
    closeAdmissionForShutdown();
    stop();
    deps.beginDrain();
  }
  async function finishShutdown(timeoutMs: number, options: ShutdownOptions) {
    beginShutdown();
    if (!await waitForQuiescence(deps.busy, timeoutMs, deps.clock)) {
      throw new Error('Scheduler work did not stop before the shutdown deadline; database and leases retained');
    }
    deps.releaseWork();
    if (options.closeDatabase !== false) deps.closeDatabase();
    closed = true;
  }
  return {
    get accepting() { return accepting; },
    get generation() { return generation; },
    get shuttingDown() { return shuttingDown; },
    get closed() { return closed; },
    get rebinding() { return resumeAdmission !== null; },
    isIdle() { return !deps.busy(); },
    waitForIdle(timeoutMs = 20_000) {
      return waitForQuiescence(deps.busy, timeoutMs, deps.clock);
    },
    initialize(work: () => void) {
      if (shuttingDown || initialized) return;
      work();
      initialized = true;
    },
    admit() {
      if (shuttingDown || resumeAdmission !== null) return false;
      accepting = true;
      return true;
    },
    stop,
    beginShutdown,
    shutdown(timeoutMs = 20_000, options: ShutdownOptions = {}): Promise<void> {
      if (closed) return Promise.resolve();
      if (shutdown) return shutdown;
      closeAdmissionForShutdown();
      // Defer execution until the shared promise is registered, including synchronous reentry.
      shutdown = Promise.resolve().then(() => finishShutdown(timeoutMs, options)).finally(() => { shutdown = null; });
      return shutdown;
    },
    rebind() {
      if (!deps.canRebind()) throw new Error('State database rebind requires an idle maintenance barrier');
      if (resumeAdmission === null) resumeAdmission = accepting;
      accepting = false;
      generation++;
      adaptersRebound = false;
      deps.rebindAdapters();
      adaptersRebound = true;
    },
    resetAfterRebind() {
      if (resumeAdmission !== null) throw new Error('Cannot reset rebind state before admission resumes');
      adaptersRebound = false;
    },
    resume() {
      if (!deps.canRebind() || resumeAdmission === null || !adaptersRebound) {
        throw new Error('State database rebind completion requires its maintenance barrier');
      }
      accepting = resumeAdmission && !shuttingDown;
      try {
        if (accepting) deps.resumeAfterRebind();
        resumeAdmission = null;
        adaptersRebound = false;
      } catch (error) {
        accepting = false;
        throw error;
      }
    },
  };
}
