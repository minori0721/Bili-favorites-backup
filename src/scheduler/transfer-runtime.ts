import type { StateManager } from '../state.js';
import { UploadCircuitBreaker, type UploadFailureInfo } from '../upload-health.js';
import type { RuntimeTimer } from './runtime-timers.js';

export interface TransferRuntimeDependencies {
  state: Pick<StateManager, 'setUploadCooldown'>;
  now(): number;
  cancelTimer(name: RuntimeTimer): void;
  startTimer(name: RuntimeTimer, callback: () => void, delayMs: number): void;
  dispatch(): void;
  pokeDownloads(): void;
}

/** Owns upload health, cooldown persistence and the single upload probe timer. */
export function createTransferRuntime(dependencies: TransferRuntimeDependencies) {
  const circuit = new UploadCircuitBreaker();
  let stopped = false;

  function clearProbeTimer() {
    dependencies.cancelTimer('uploadProbe');
  }

  function scheduleProbe() {
    clearProbeTimer();
    const retryAt = stopped ? undefined : circuit.getRetryAt();
    if (!retryAt) return;
    dependencies.startTimer('uploadProbe', () => {
      dependencies.dispatch();
      dependencies.pokeDownloads();
    }, Math.max(0, retryAt - dependencies.now()));
  }

  return {
    start() { stopped = false; scheduleProbe(); },
    stop() { stopped = true; clearProbeTimer(); },
    isIdle: () => true,
    waitForIdle: async () => true,
    resetAfterRebind() { clearProbeTimer(); },
    circuit,
    restore(snapshot: Parameters<UploadCircuitBreaker['restore']>[0]) { circuit.restore(snapshot); },
    recordFailure(key: string, failure: UploadFailureInfo) {
      circuit.recordFailure(key, failure);
      if (circuit.getSnapshot().state !== 'closed') dependencies.state.setUploadCooldown({ ...circuit.getSnapshot() });
      scheduleProbe();
      dependencies.pokeDownloads();
      return failure;
    },
    clearProbeTimer,
    scheduleProbe,
  };
}
