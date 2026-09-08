import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { SyncScheduler } from '../../src/scheduler.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

test('storage rebind requires maintenance and cannot restart before all adapters complete', async () => {
  const directory = await createTestDir('scheduler-rebind');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const scheduler = new SyncScheduler({get:() => testConfig()}, {list:() => [],getById:() => undefined,updatePartial:() => undefined}, state);
  try {
    assert.throws(() => scheduler.reloadStateDatabase(), /maintenance barrier/);
    await assert.rejects(scheduler.withCleanupLock(async () => {
      scheduler.reloadStateDatabase();
      assert.equal(scheduler.start(),false);
      assert.deepEqual(scheduler.runNow(),{started:false,queued:false});
      throw new Error('later adapter failed');
    }), /later adapter failed/);
    assert.equal(scheduler.start(),false);
    assert.deepEqual(scheduler.runNow(),{started:false,queued:false});
    await scheduler.withCleanupLock(async () => {
      // The import rollback calls the same rebind sequence against the restored database.
      scheduler.reloadStateDatabase();
      scheduler.resumeAfterStateRebind();
    });
    assert.equal(scheduler.start(),true);
  } finally { await scheduler.shutdown(1000,{closeDatabase:false}); state.close(); await removeTestDir(directory); }
});

test('a cache inspection from before rebind cannot publish into the new generation', async () => {
  const directory = await createTestDir('scheduler-rebind-cache');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const scheduler = new SyncScheduler({get:() => testConfig()}, {list:() => [],getById:() => undefined,updatePartial:() => undefined}, state, {
    cacheInspector:async () => {
      const first = ++calls === 1;
      if (first) await held;
      return {usedBytes:first ? 99 : 7,fileCount:0,exportableBytes:0,exportableFiles:0,recovery:{
        resumableSessions:0,completedPages:0,totalPages:0,retainedBytes:0,legacyDirectories:0,legacyBytes:0,cleanupEligibleBytes:0,
      }};
    },
  });
  try {
    const old = scheduler.getLocalCacheCapacity();
    await scheduler.withCleanupLock(async () => { scheduler.reloadStateDatabase(); scheduler.resumeAfterStateRebind(); });
    release();
    await old;
    assert.notEqual(scheduler.getQueueSnapshot().localCache.usedBytes,99);
    assert.equal((await scheduler.getLocalCacheCapacity()).usedBytes,7);
  } finally { release(); await scheduler.shutdown(1000,{closeDatabase:false}); state.close(); await removeTestDir(directory); }
});
