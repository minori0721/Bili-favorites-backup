import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryAutomation } from '../../src/scheduler/recovery-automation.js';
import type { PersistentJobRecord } from '../../src/database.js';

function job(id: string): PersistentJobRecord {
  return { id, kind: 'upload' as const, dedupeKey: id, status: 'manual_wait' as const, priority: 0, payload: {},
    attempts: 0, maxAttempts: 3, notBefore: 0, createdAt: 1, updatedAt: 1 };
}

test('recovery batch shares work and stops before another job after maintenance begins', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let allowed = true;
  const seen: string[] = [];
  const service = createRecoveryAutomation({
    jobs: { listDueManualRecovery: () => [job('first'), job('second')] },
    now: () => 1, canRun: () => allowed, generation: () => 0, refreshProjection: () => {},
    assess: async id => { seen.push(id); await gate; }, reportError: assert.fail,
  });
  const first = service.run();
  assert.equal(service.run(), first);
  await Promise.resolve();
  assert.deepEqual(seen, ['first']);
  allowed = false;
  assert.equal(service.busy, true);
  release();
  await first;
  assert.equal(service.busy, false);
  assert.deepEqual(seen, ['first']);
});

test('stopping invalidates a queued recovery batch before projection reads', async () => {
  let reads = 0;
  const service = createRecoveryAutomation({
    jobs: { listDueManualRecovery: () => { reads++; return []; } },
    now: () => 1, canRun: () => true, generation: () => 0,
    refreshProjection: () => { reads++; }, assess: async () => {}, reportError: assert.fail,
  });
  const pending = service.run();
  service.stop();
  await pending;
  assert.equal(reads, 0);
  await service.run();
  assert.equal(reads, 2);
});

test('recovery rejection releases the batch for a later explicit retry', async () => {
  let failed = true;
  const service = createRecoveryAutomation({
    jobs: { listDueManualRecovery: () => [job('first')] },
    now: () => 1, canRun: () => true, generation: () => 0, refreshProjection: () => {},
    assess: async () => { if (failed) throw new Error('offline'); }, reportError: assert.fail,
  });
  await assert.rejects(service.run(), /offline/);
  assert.equal(service.busy, false);
  failed = false;
  await service.run();
});
