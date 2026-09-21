import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskQueue } from '../../src/queue.js';
import { createWorkStateProjection } from '../../src/scheduler/work-state-projection.js';

function projection(overrides: Partial<Parameters<typeof createWorkStateProjection>[0]> = {}) {
  const queue = new TaskQueue(1, 10);
  return createWorkStateProjection({
    sync: { isBusy: () => false, hasPending: () => false },
    queues: [queue],
    accessProbe: { isBusy: () => false },
    recoveryAutomation: { busy: false },
    legacyCacheRecovery: { busy: false },
    localCapacity: { pending: null },
    localCleanup: { sweeping: false, busy: false },
    recovery: { busy: false },
    accountRetirement: { busy: false },
    quality: { isIdle: () => true },
    anyMaintenanceLocked: () => false,
    jobs: { counts: () => ({}) },
    ...overrides,
  });
}

test('work state projection keeps cleanup closed while any public workflow is active', () => {
  const syncBusy = { value: false };
  const state = projection({
    sync: { isBusy: () => syncBusy.value, hasPending: () => false },
  });
  assert.equal(state.canEnterCleanup(), true);
  syncBusy.value = true;
  assert.equal(state.hasActiveOrQueuedSchedulerWork(), true);
  assert.equal(state.canEnterCleanup(), false);
});

test('work state projection exposes persistent transfer work by kind and status', () => {
  const state = projection({
    jobs: { counts: () => ({ upload: { manual_wait: 1 }, sync: { pending: 99 } }) },
  });
  assert.equal(state.hasPersistentTransferWork(), true);
});

test('cleanup and rebind use distinct public lifecycle barriers', () => {
  const maintenance = { locked: false };
  const capacity = { pending: Promise.resolve() as Promise<unknown> | null };
  const state = projection({
    anyMaintenanceLocked: () => maintenance.locked,
    localCapacity: capacity,
  });

  assert.equal(state.isBusy(), true, 'capacity inspection participates in shutdown drain');
  assert.equal(state.canRebind(), true, 'generation invalidation makes an old capacity inspection safe during rebind');
  maintenance.locked = true;
  assert.equal(state.canEnterCleanup(), false);
  capacity.pending = null;
  assert.equal(state.isBusy(), false);
});

test('recovery automation is visible to idle checks and cleanup admission', () => {
  const automation = { busy: true };
  const state = projection({ recoveryAutomation: automation });
  assert.equal(state.hasRunningTransferTasks(), true);
  assert.equal(state.hasActiveOrQueuedSchedulerWork(), true);
  assert.equal(state.canEnterCleanup(), false);
  automation.busy = false;
  assert.equal(state.canEnterCleanup(), true);
});
