import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { waitForQuiescence } from '../../src/scheduler/quiescence.js';
import { Task, TaskQueue } from '../../src/queue.js';
import path from 'node:path';
import { SyncScheduler } from '../../src/scheduler.js';
import { StateManager } from '../../src/state.js';
import { inspectDownloadCache } from '../../src/download-session.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

test('quiescence timeout cannot report busy work as idle', async () => {
  let now = 0, sleeps = 0;
  const clock = {now:() => now,sleep:async (ms:number) => { now += ms; sleeps += 1; }};
  assert.equal(await waitForQuiescence(() => true,60,clock),false);
  assert.equal(now,60);
  assert.equal(sleeps,3);
  assert.equal(await waitForQuiescence(() => false,0,clock),true);
  assert.equal(await waitForQuiescence(() => now < 100,80,clock),true);
  assert.equal(now,110);
});

test('removing a queued retry cancels its wakeup and cannot resurrect the task', async () => {
  class RetryTask extends Task {
    runs = 0;
    async run() { this.runs += 1; throw Object.assign(new Error('retry'),{retryAfterMs:30}); }
  }
  const queue = new TaskQueue();
  const task = new RetryTask('isolated retry');
  const settled = once(queue,'taskSettled');
  queue.addTask(task);
  await settled;
  assert.equal(task.status,'retry_wait');
  queue.removePendingTasks(() => true);
  await new Promise(resolve => setTimeout(resolve,60));
  assert.equal(task.status,'error');
  assert.equal(task.runs,1);
  assert.equal(queue.getSize(),0);
});

test('scheduler timeout leaves the database usable, blocks new scans, and allows a later idempotent shutdown', async () => {
  const directory = await createTestDir('scheduler-shutdown');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let inspections = 0;
  const scheduler = new SyncScheduler({get:() => testConfig()}, {list:() => [],getById:() => undefined,updatePartial:() => undefined}, state,
    {cacheInspector:async () => { inspections += 1; await held; return inspectDownloadCache(directory); },legacyTempDir:directory});
  try {
    assert.equal(inspections,0,'construction must not launch background inspection');
    assert.equal(scheduler.start(),true);
    assert.equal(scheduler.start(),false);
    assert.equal(inspections,1);
    await assert.rejects(scheduler.shutdown(0),/database and leases retained/);
    assert.equal(scheduler.start(),false);
    scheduler.updateInterval();
    assert.doesNotThrow(() => state.getDatabase().db.prepare('SELECT 1').get());
    assert.deepEqual(scheduler.runNow(),{started:false,queued:false});
    assert.equal(await scheduler.tick(true),false);
    release();
    await scheduler.shutdown(1000,{closeDatabase:false});
    assert.doesNotThrow(() => state.getDatabase().db.prepare('SELECT 1').get());
    await scheduler.shutdown(0,{closeDatabase:false});
    assert.equal(scheduler.start(),false);
    scheduler.beginShutdown();
    scheduler.resumePersistedWorkOnStartup();
    assert.deepEqual(scheduler.runNow(),{started:false,queued:false});
  } finally { release(); await scheduler.shutdown(1000,{closeDatabase:false}); state.close(); await removeTestDir(directory); }
});
