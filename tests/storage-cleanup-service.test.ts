import assert from 'node:assert/strict';
import test from 'node:test';
import { createStorageCleanup } from '../src/storage-cleanup-service.js';
import { testConfig } from './helpers.js';

function fixture() {
  const calls: string[] = [];
  const state = { busy: false, migration: false, deletion: false, coverIdle: true, failClear: false };
  const service = createStorageCleanup({
    scheduler: {
      refreshLocalCacheState() { calls.push('capacity'); }, updateInterval() { calls.push('interval'); },
      hasRunningTransferTasks: () => state.busy, hasActiveOrQueuedSchedulerWork: () => false,
      async withCleanupLock(work) {
        calls.push('lock');
        try { return await work(); } finally { calls.push('unlock'); }
      },
    },
    stateManager: { clear() { calls.push('state'); if (state.failClear) throw Error('database busy'); }, clearCoverCachePaths() { return true; } },
    userStore: { clear() { calls.push('users'); } },
    configStore: { get: testConfig, reset() { calls.push('config'); } },
    onlineCoverCache: { clear: async () => { }, inspect: async () => ({ bytes: 0, files: 0, limitBytes: 0 }), setLimitMb() { } },
    unavailableCoverBackfill: { stop: async () => { calls.push('stop-covers'); return state.coverIdle; }, restart() { calls.push('restart-covers'); } },
    waitForCoverCacheIdle: async () => { calls.push('drain-covers'); return state.coverIdle; },
    clearMemoryCaches() { calls.push('memory'); }, clearLogs() { calls.push('logs'); },
    clearCoverBackfillMarker() { }, hasPathMigration: () => state.migration, hasUnfinishedDeletion: () => state.deletion,
  });
  return { service, state, calls };
}

test('cleanup admission rejects active migrations, transfers and missing confirmation before mutation', async () => {
  const f = fixture();
  await assert.rejects(f.service.execute({ items: ['state'] }), /DELETE/);
  f.state.migration = true;
  await assert.rejects(f.service.execute({ items: ['state'], confirmation: 'DELETE' }), /迁移/);
  f.state.migration = false; f.state.deletion = true;
  await assert.rejects(f.service.execute({ items: ['state'], confirmation: 'DELETE' }), /归档清理/);
  f.state.deletion = false; f.state.busy = true;
  await assert.rejects(f.service.execute({ items: ['state'], confirmation: 'DELETE' }), /正在运行/);
  assert.deepEqual(f.calls, []);
});

test('cleanup reports partial failure and releases its lock after restarting cover work', async () => {
  const f = fixture();
  f.state.failClear = true;
  const result = await f.service.execute({ items: ['state', 'logs'], confirmation: 'DELETE' });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body.data.results.map(item => [item.key, item.ok]), [['state', false], ['logs', true]]);
  assert.match(result.body.data.results[0].error || '', /database busy/);
  assert.deepEqual(f.calls, ['lock', 'stop-covers', 'drain-covers', 'state', 'logs', 'restart-covers', 'unlock']);
});

test('cover drain timeout prevents state cleanup and never claims success', async () => {
  const f = fixture();
  f.state.coverIdle = false;
  await assert.rejects(f.service.execute({ items: ['state'], confirmation: 'DELETE' }), /安全期限/);
  assert.deepEqual(f.calls, ['lock', 'stop-covers', 'restart-covers', 'unlock']);
});

test('safe cache cleanup is deduplicated and remains available during transfers', async () => {
  const f = fixture();
  f.state.busy = true;
  const result = await f.service.execute({ items: ['memory-cache', 'logs', 'memory-cache'] });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls, ['memory', 'logs']);
});
