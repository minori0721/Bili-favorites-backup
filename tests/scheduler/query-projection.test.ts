import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { StateDatabase } from '../../src/database.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { SyncScheduler } from '../../src/scheduler.js';
import { StateManager } from '../../src/state.js';
import { inspectDownloadCache } from '../../src/download-session.js';
import { Task, mapQueueBoardTask } from '../../src/queue.js';
import { projectQueueSnapshot } from '../../src/scheduler/queue-projection.js';
import { createSchedulerStatusProjection } from '../../src/scheduler/scheduler-status-projection.js';
import { createStartupRecovery } from '../../src/scheduler/startup-recovery.js';
import type { SchedulerSnapshot } from '../../src/scheduler/sync-runtime.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { logManager } from '../../src/logger.js';
import type { LogEntry } from '../../src/logger.js';
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

test('recovery summary counts active and explicit manual recoveries, not terminal history', async () => {
  const directory = await createTestDir('query-projection-counts');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  const active = jobs.enqueue({kind:'upload',dedupeKey:'active-upload',initialStatus:'pending'});
  const manualWait = jobs.enqueue({kind:'upload',dedupeKey:'manual-wait-upload',initialStatus:'manual_wait',payload:{awaitingManualRecovery:true}});
  const failedManual = jobs.enqueue({kind:'upload',dedupeKey:'failed-manual-upload',initialStatus:'manual_wait',payload:{awaitingManualRecovery:true}});
  const failedAbandoned = jobs.enqueue({kind:'upload',dedupeKey:'failed-abandoned-upload',initialStatus:'manual_wait',payload:{awaitingManualRecovery:true,userDisposition:'abandoned'}});
  const completed = jobs.enqueue({kind:'upload',dedupeKey:'completed-upload',initialStatus:'pending'});
  state.getDatabase().db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(completed.id);
  state.getDatabase().db.prepare("UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(failedManual.id);
  state.getDatabase().db.prepare("UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(failedAbandoned.id);
  try {
    assert.equal(jobs.countRecoverable(['upload']),3);
    const scheduler = new SyncScheduler({get: () => testConfig()}, {list:() => [],getById:() => null,updatePartial:() => null}, state,
      {cacheInspector:async () => inspectDownloadCache(directory)});
    try {
      assert.equal(scheduler.getQueueSnapshot().recovery.pendingUploads,3);
    } finally {
      await scheduler.shutdown(1000,{closeDatabase:false});
    }
  } finally {
    state.close();
    await removeTestDir(directory);
  }
});

test('queue projection fills the bounded board after excluding in-memory duplicates', async () => {
  const directory = await createTestDir('queue-projection-duplicates');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  class ShownTask extends Task { async run() {} }
  try {
    const represented = jobs.enqueue({kind:'upload',dedupeKey:'represented-board',bvid:'BVREPRESENTED',priority:1});
    const waiting = jobs.enqueue({kind:'upload',dedupeKey:'waiting-board',bvid:'BVWAITING',priority:2});
    const task = new ShownTask('represented');
    task.persistentJobId = represented.id;
    task.bvid = represented.bvid;
    const emptyQueue = {getTasks: () => []};
    const snapshot = projectQueueSnapshot({
      downloadQueue:emptyQueue,uploadQueue:{getTasks:() => [task]},verificationQueue:emptyQueue,
      config:{queuePrefetchLimit:2},jobs,chargingRestrictions:{},
      mapTask:(queued,stage) => mapQueueBoardTask(queued,stage),
      mapJob:job => mapQueueBoardTask({id:job.id,bvid:job.bvid,persistentJobId:job.id,status:job.status},'upload_pending'),
      enrich:() => {},
    },{});
    assert.deepEqual(snapshot.uploadPending.map(item => item.persistentJobId),[represented.id,waiting.id]);
    assert.equal(snapshot.recovery.pendingUploads,2);
  } finally { state.close(); await removeTestDir(directory); }
});

test('recoverable summary excludes an encoding-retry parent already replaced by its child', () => {
  const database = new StateDatabase(':memory:');
  const jobs = new PersistentJobStore(database);
  try {
    const parent = jobs.enqueue({
      kind:'upload', dedupeKey:'retry-parent-summary', bvid:'BVRETRYSUMMARY',
      payload:{encodingRetry:{parentJobId:'pending', state:'uploading'}},
    });
    jobs.updatePayload(parent.id, {encodingRetry:{parentJobId:parent.id, state:'uploading'}});
    const child = jobs.enqueue({
      kind:'upload', dedupeKey:'retry-child-summary', bvid:'BVRETRYSUMMARY',
      payload:{encodingRetry:{parentJobId:parent.id, state:'uploading'}},
    });
    assert.equal(jobs.countRecoverable(['upload']), 1);
    assert.deepEqual(jobs.listForBoard(['upload']).map(job => job.id), [child.id]);
  } finally { database.close(); }
});

test('persisted download jobs remain visible after the in-memory queue is empty', () => {
  const database = new StateDatabase(':memory:');
  const jobs = new PersistentJobStore(database);
  const emptyQueue = {getTasks:() => []};
  try {
    const download = jobs.enqueue({kind:'download', dedupeKey:'persisted-download-board', bvid:'BVDOWNLOADBOARD', initialStatus:'manual_wait'});
    const qualityDownload = jobs.enqueue({kind:'quality_download', dedupeKey:'persisted-quality-download-board', bvid:'BVQUALITYBOARD', initialStatus:'manual_wait'});
    const snapshot = projectQueueSnapshot({
      downloadQueue:emptyQueue, uploadQueue:emptyQueue, verificationQueue:emptyQueue,
      config:{queuePrefetchLimit:25}, jobs, chargingRestrictions:{},
      mapTask:(task,stage) => mapQueueBoardTask(task,stage),
      mapJob:job => mapQueueBoardTask({id:job.id,bvid:job.bvid,persistentJobId:job.id,status:job.status},
        job.kind === 'download' || job.kind === 'quality_download' ? 'download_pending' : 'upload_pending'),
      enrich:() => {},
    },{});
    assert.deepEqual(snapshot.downloadPending.map(item => item.persistentJobId).sort(), [download.id, qualityDownload.id].sort());
    assert.equal(snapshot.recovery.pendingDownloads, 2);
  } finally { database.close(); }
});

test('queue summary counts upload, confirmation, and quality finalization separately', async () => {
  const directory = await createTestDir('queue-projection-quality');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  try {
    for (const kind of ['quality_download','quality_upload','quality_replace','quality_cleanup','verify_upload'] as const) {
      jobs.enqueue({kind,dedupeKey:`quality-summary-${kind}`,bvid:`BV${kind}`});
    }
    const scheduler = new SyncScheduler({get:()=>testConfig()}, {list:()=>[],getById:()=>null,updatePartial:()=>null}, state,
      {cacheInspector:async () => inspectDownloadCache(directory)});
    try {
      const snapshot = scheduler.getQueueSnapshot();
      assert.equal(snapshot.recovery.pendingDownloads,1);
      assert.equal(snapshot.recovery.pendingUploads,1);
      assert.equal(snapshot.recovery.pendingVerifications,1);
      assert.equal(snapshot.recovery.pendingQualityMaintenance,2);
      assert.deepEqual(new Set(snapshot.uploadPending.map(item => item.bvid)),
        new Set(['BVquality_upload','BVquality_replace','BVquality_cleanup','BVverify_upload']));
    } finally { await scheduler.shutdown(1000,{closeDatabase:false}); }
  } finally { state.close(); await removeTestDir(directory); }
});

test('scheduler projection keeps polling time separate from per-account cooldowns', async () => {
  const directory = await createTestDir('queue-projection-cooldown');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  let pending: {trigger:'manual'} | null = null;
  let progress: SchedulerSnapshot | null = null;
  const users = [{id:'u1',name:'One'},{id:'u2',name:'Two'}];
  const emptyQueue = {getTasks:() => []};
  try {
    state.setUserCooldown('u1','first cooldown',60_000);
    const firstUntil = state.getUserCooldown('u1')!.until;
    const projection = createSchedulerStatusProjection({
      sync:{getPending:()=>pending,getProgress:()=>progress,getLastError:()=>''},
      nextRunAt:()=>12_345,state,eligibleUsers:()=>users,
      queues:{download:emptyQueue,upload:emptyQueue,verification:emptyQueue},
      queuePrefetchLimit:()=>25,jobs,now:()=>100,
      localCache:()=>({}),uploadHealth:()=>({}),downloadApiHealth:()=>({}),downloadRecovery:()=>({}),
      recoverySnapshot:()=>({}),maintenanceSnapshot:()=>null,
    });
    const partial = projection.schedulerSnapshot();
    assert.equal(partial.status,'idle');
    assert.equal(partial.nextRunAt,12_345);
    assert.deepEqual(partial.accountCooldown,{count:1,earliestUntil:firstUntil,userName:'One'});
    state.setUserCooldown('u2','second cooldown',120_000);
    pending = {trigger:'manual'};
    assert.equal(projection.schedulerSnapshot().status,'queued');
    pending = null;
    const allCooling = projection.schedulerSnapshot();
    assert.equal(allCooling.status,'cooldown');
    assert.equal(allCooling.nextRunAt,12_345);
    assert.deepEqual(allCooling.accountCooldown,{count:2,earliestUntil:firstUntil});
    progress = {status:'running',mode:'manual',title:'Running',detail:'Scanning',queuedActions:[]};
    assert.equal(projection.schedulerSnapshot().status,'running');
  } finally { state.close(); await removeTestDir(directory); }
});

test('one-time startup log reports current recoverable jobs instead of completed history', async () => {
  const directory = await createTestDir('queue-projection-bootstrap-log');
  const state = new StateManager({statePath:path.join(directory,'state.json'),dbPath:path.join(directory,'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  const messages: string[] = [];
  const listener = (entry: LogEntry) => { if (entry.summary.startsWith('启动恢复初始化完成')) messages.push(entry.summary); };
  logManager.on('log',listener);
  try {
    jobs.enqueue({kind:'upload',dedupeKey:'startup-active'});
    jobs.enqueue({kind:'quality_upload',dedupeKey:'startup-quality-upload'});
    jobs.enqueue({kind:'quality_download',dedupeKey:'startup-quality-download'});
    const historical = jobs.enqueue({kind:'upload',dedupeKey:'startup-completed'});
    const failed = jobs.enqueue({kind:'upload',dedupeKey:'startup-failed'});
    jobs.enqueue({kind:'verify_upload',dedupeKey:'startup-verification'});
    state.getDatabase().db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(historical.id);
    state.getDatabase().db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failed.id);
    const unexpected = () => assert.fail('unexpected recovery work');
    const recovery = createStartupRecovery({
      stateManager:state,jobStore:jobs,transferSessions:new TransferSessionStore(state.getDatabase()),
      configStore:{get:()=>testConfig()},staleActiveBackupMs:1000,
      resolveRelation:()=>null,findBestRelationForBvid:()=>null,resolveRelationRemotePath:unexpected,
      enqueueIfNeeded:unexpected,queueUploadWork:unexpected,buildPersistentUploadJob:unexpected,
      historySnapshotSegment:unexpected,ensurePersistedAvailabilityProbes:()=>{},ensurePersistedChargingAccessProbes:()=>{},
      dispatchPersistentJobs:unexpected,recordQueued:unexpected,
    });
    recovery.resumePersistedWork();
    recovery.resumePersistedWork();
    assert.deepEqual(messages,['启动恢复初始化完成，当前待处理：待补传 2，待下载 1，待确认 1']);
  } finally { logManager.off('log',listener); state.close(); await removeTestDir(directory); }
});
