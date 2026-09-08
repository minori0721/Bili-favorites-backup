import type { PersistentJobStore } from '../job-store.js';

export const RECOVERY_AUTOMATION_INTERVAL_MS = 5 * 60_000;

interface RecoveryAutomationDependencies {
  jobs: Pick<PersistentJobStore, 'listDueManualRecovery'>;
  now(): number;
  canRun(): boolean;
  generation(): number;
  refreshProjection(): void;
  assess(jobId: string): Promise<unknown>;
  reportError(error: unknown): void;
}

/** Owns recovery polling and its in-flight batch; shutdown must wait for busy=false. */
export function createRecoveryAutomation(deps: RecoveryAutomationDependencies) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let epoch = 0;
  function run() {
    if (pending) return pending;
    if (!deps.canRun()) return Promise.resolve();
    const current = epoch;
    const generation = deps.generation();
    const active = () => current === epoch && generation === deps.generation() && deps.canRun();
    // Publish the promise before invoking collaborators so reentrant calls share the batch.
    pending = Promise.resolve().then(async () => {
      if (!active()) return;
      deps.refreshProjection();
      const jobs = deps.jobs.listDueManualRecovery(['upload', 'history_upload'], deps.now(), 25);
      for (const job of jobs) {
        if (!active()) break;
        await deps.assess(job.id);
      }
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    run,
    get busy() { return pending !== undefined; },
    start() {
      if (timer || !deps.canRun()) return;
      const current = epoch;
      const invoke = () => {
        if (current === epoch) void run().catch(deps.reportError);
      };
      startup = setTimeout(() => { startup = undefined; invoke(); }, 30_000);
      startup.unref?.();
      timer = setInterval(invoke, RECOVERY_AUTOMATION_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      epoch++;
      if (timer) clearInterval(timer);
      if (startup) clearTimeout(startup);
      timer = undefined;
      startup = undefined;
    },
  };
}
