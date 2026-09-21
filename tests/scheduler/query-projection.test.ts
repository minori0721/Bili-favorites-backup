import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PersistentJobStore } from '../../src/job-store.js';
import { SyncScheduler } from '../../src/scheduler.js';
import { StateManager } from '../../src/state.js';
import { inspectDownloadCache } from '../../src/download-session.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

test('construction and repeated snapshots do not normalize jobs or start filesystem work', async () => {
  const directory = await createTestDir('query-projection');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  jobs.enqueue({kind:'upload' as const,dedupeKey:'stopped-fixture',initialStatus:'manual_wait',payload:{userDisposition:'abandoned',awaitingManualRecovery:true}});
  const changes = () => state.getDatabase().db.prepare<unknown[], { "count": number }>('SELECT total_changes() AS count').get();
  const before = changes();
  let inspections = 0;
  const scheduler = new SyncScheduler({get:() => testConfig()}, {list:() => [],getById:() => null,updatePartial:() => null}, state,
    {cacheInspector:async () => {inspections+=1;return inspectDownloadCache(directory);}});
  try {
    for(let index=0;index<5;index++) {
      scheduler.getQueueSnapshot(); scheduler.getRecoveryIssueSnapshot();
    }
    assert.deepEqual(changes(),before);
    assert.equal(inspections,0);
    assert.equal(jobs.findByDedupeKey('stopped-fixture')?.status,'manual_wait');
    scheduler.refreshRecoveryProjection(true);
    assert.equal(jobs.findByDedupeKey('stopped-fixture')?.status,'failed');
  } finally {await scheduler.shutdown(1000,{closeDatabase:false});state.close();await removeTestDir(directory);}
});
