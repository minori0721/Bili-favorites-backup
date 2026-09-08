import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalCapacity } from '../../src/scheduler/local-capacity.js';
import type { DownloadCacheInspection } from '../../src/download-session.js';

function inspection(usedBytes: number): DownloadCacheInspection {
  return { usedBytes, fileCount: 0, exportableFiles: 0, exportableBytes: 0,
    recovery: { resumableSessions: 0, completedPages: 0, totalPages: 0, retainedBytes: usedBytes, legacyDirectories: 0, legacyBytes: 0, cleanupEligibleBytes: 0 } };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('capacity coalesces forced inspections and only wakes after the newest observation', async () => {
  const resolves: Array<(value: DownloadCacheInspection) => void> = [];
  let wakes = 0;
  const capacity = createLocalCapacity({ limitGB: () => 1, now: () => 1_000, generation: () => 0, canRun: () => true,
    inspect: () => new Promise(resolve => resolves.push(resolve)), wake() { wakes++; }, failed: error => assert.fail(String(error)) });
  capacity.refreshAndWake(true);
  for (let i = 0; i < 20; i++) { capacity.refreshAndWake(true); capacity.ensureFresh(); }
  assert.equal(resolves.length, 1);
  resolves[0](inspection(10));
  await flush();
  assert.equal(resolves.length, 2);
  assert.equal(wakes, 0);
  resolves[1](inspection(20));
  await flush();
  assert.equal(capacity.view().usedBytes, 20);
  assert.equal(resolves.length, 2);
  assert.equal(wakes, 1);
});

test('capacity reset rejects old observations and does not wake a new storage generation', async () => {
  let resolve!: (value: DownloadCacheInspection) => void;
  let generation = 0, wakes = 0;
  const capacity = createLocalCapacity({ limitGB: () => 1, now: () => 1_000, generation: () => generation, canRun: () => true,
    inspect: () => new Promise(done => { resolve = done; }), wake() { wakes++; }, failed: error => assert.fail(String(error)) });
  capacity.refreshAndWake();
  generation++;
  capacity.reset();
  resolve(inspection(500));
  await flush();
  assert.equal(capacity.view().checkedAt, 0);
  assert.equal(capacity.view().paused, true);
  assert.equal(capacity.recovery.retainedBytes, 0);
  assert.equal(wakes, 0);
  capacity.refreshAndWake();
  resolve(inspection(20));
  await flush();
  assert.equal(capacity.view().paused, false);
  assert.equal(capacity.view().usedBytes, 20);
  assert.equal(wakes, 1);
});

test('a failed forced inspection cannot turn a paused fresh snapshot into a cached success', async () => {
  let calls = 0, failures = 0;
  const capacity = createLocalCapacity({ limitGB: () => 1, now: () => 1_000, generation: () => 0, canRun: () => true,
    inspect: async () => { if (++calls === 2) throw new Error('temporary scan failure'); return inspection(0); },
    wake() {}, failed() { failures++; } });
  await capacity.refresh();
  capacity.reconfigure();
  await flush();
  assert.equal(capacity.view().paused, true);
  assert.equal(failures, 1);
  capacity.ensureFresh();
  await flush();
  assert.equal(calls, 3);
  assert.equal(capacity.view().paused, false);
});
