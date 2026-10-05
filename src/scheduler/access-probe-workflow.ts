import type { PersistentJobRecord } from '../database.js';
import type { PersistentJobStore } from '../job-store.js';

export type AccessProbeRequestGate = (check: () => void) => Promise<void>;

/** External request failures are handled by probes; escaped state failures stop scheduling. */
export class AccessProbeStateError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Access probe state operation failed');
  }
}

export interface AccessProbeWorkflowDependencies {
  jobs: Pick<PersistentJobStore, 'claimDue' | 'markRunning' | 'findById' | 'extendLease'>;
  owner: string;
  now(): number;
  generation(): number;
  accepting(): boolean;
  shuttingDown(): boolean;
  run(job: PersistentJobRecord, beforeRequest: AccessProbeRequestGate): Promise<void>;
  failed(job: PersistentJobRecord, error: unknown): void;
  fatal(error: unknown): void;
  wake(): void;
  sleep(ms: number): Promise<void>;
  requestIntervalMs?: number;
}

/** Owns the claimed access-probe job and its promise for the full lifecycle. */
export function createAccessProbeWorkflow(dependencies: AccessProbeWorkflowDependencies) {
  let active: Promise<void> | null = null;
  let jobId: string | null = null;
  let stopped = false;
  let nextAllowedAt = 0;

  function dispatch() {
    if (stopped || active || !dependencies.accepting()) return;
    const [job] = dependencies.jobs.claimDue(['access_probe'], 1, dependencies.owner, 5 * 60_000, dependencies.now());
    if (!job || !dependencies.jobs.markRunning(job.id, dependencies.owner, 5 * 60_000)) return;
    jobId = job.id;
    const generation = dependencies.generation();
    const beforeRequest: AccessProbeRequestGate = async (check) => {
      const assertAdmission = () => {
        if (stopped || !dependencies.accepting() || generation !== dependencies.generation()) {
          throw new Error('Access probe interrupted by lifecycle or lease change');
        }
        check();
      };
      assertAdmission();
      while (nextAllowedAt > dependencies.now()) {
        await dependencies.sleep(nextAllowedAt - dependencies.now());
        assertAdmission();
      }
      nextAllowedAt = dependencies.now() + (dependencies.requestIntervalMs ?? 0);
    };
    const admitted = () => !stopped && dependencies.accepting()
      && generation === dependencies.generation() && !dependencies.shuttingDown();
    active = Promise.resolve().then(async () => {
      let shouldWake = false;
      try {
        if (admitted()) {
          try { await dependencies.run(job, beforeRequest); shouldWake = true; }
          catch (error: unknown) {
            if (admitted()) {
              const current = dependencies.jobs.findById(job.id);
              if (current?.leaseOwner === dependencies.owner && current.attempts === job.attempts
                && ['leased', 'running'].includes(current.status) && (current.leaseExpiresAt ?? 0) > dependencies.now()) {
                if (error instanceof AccessProbeStateError) throw error.cause;
                dependencies.failed(job, error);
                shouldWake = true;
              }
            }
          }
        }
      } catch (error: unknown) {
        stopped = true;
        dependencies.fatal(error);
      } finally {
        active = null;
        jobId = null;
      }
      if (shouldWake && admitted()) {
        try { dependencies.wake(); }
        catch (error: unknown) { stopped = true; dependencies.fatal(error); }
      }
    });
  }

  return {
    start: () => { stopped = false; },
    stop: () => { stopped = true; },
    dispatch,
    renewLease: () => {
      if (jobId) dependencies.jobs.extendLease(jobId, dependencies.owner, 5 * 60_000);
    },
    isBusy: () => active !== null,
    isIdle: () => active === null,
    async waitForIdle(timeoutMs = 20_000) {
      const deadline = dependencies.now() + timeoutMs;
      while (active && dependencies.now() < deadline) await dependencies.sleep(Math.min(50, Math.max(1, deadline - dependencies.now())));
      return active === null;
    },
    resetAfterRebind: () => {
      if (active || jobId) throw new Error('Cannot reset access probe workflow while a probe is active');
      stopped = false;
    },
    get jobId() { return jobId; },
  };
}
