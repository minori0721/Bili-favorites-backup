import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateDatabase } from '../../src/database.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { Task, TaskQueue } from '../../src/queue.js';
import { DownloadTask } from '../../src/tasks.js';
import { createPersistentJobDispatcher } from '../../src/scheduler/persistent-job-dispatcher.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import { createHeldScheduler } from '../fixtures/held-scheduler.js';
import { seedQueuedDownload } from '../fixtures/queued-download.js';
import { ManualTime } from '../fixtures/manual-time.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class HeldTask extends Task { async run() {} }
class ControlledDownload extends DownloadTask {
  finish: (() => void) | undefined;
  constructor(bvid: string) { super(bvid, {SESSDATA: '', bili_jct: '', DedeUserID: '1'}, testConfig()); }
  override run() { return new Promise<void>(resolve => { this.finish = resolve; }); }
}
function fixture() {
  let now = 2_000_000_000_000, accepting = true;
  const database = new StateDatabase(':memory:');
  const jobs = new PersistentJobStore(database, {now: () => now});
  const download = new TaskQueue(1, 5), upload = new TaskQueue(1, 5), verification = new TaskQueue(1, 5);
  const owner = 'isolated-owner';
  const tasks: ControlledDownload[] = [];
  for (const queue of [download, upload, verification]) queue.setBeforeRun(task => !task.persistentJobId || jobs.markRunning(task.persistentJobId, owner));
  const dispatcher = createPersistentJobDispatcher({
    configStore: {get: () => testConfig({concurrentDownloads: 1, concurrentUploads: 1, queuePrefetchLimit: 5})},
    jobs, downloadQueue: download, uploadQueue: upload, verificationQueue: verification,
    sessions: new TransferSessionStore(database), leaseOwner: owner, now: () => now,
    accepting: () => accepting, maintenanceLocked: () => false, queueHighWater: () => 5,
    canCreateDownloadTask: () => true, dispatchChargingAccessProbe() {},
    buildDownloadTask: job => { const task = new ControlledDownload(job.bvid!); tasks.push(task); return task; },
    buildUploadTask: () => { throw new Error('unexpected upload'); }, buildQualityUpgradeTask: () => null, scheduleWake() {},
  });
  return {database, jobs, owner, download, upload, verification, dispatcher, tasks,
    advance: (ms: number) => { now += ms; },
    async close() {
      accepting = false;
      for (const queue of [download, upload, verification]) queue.setStartGate(() => false);
      for (const task of tasks) task.finish?.();
      await flush();
      for (const queue of [download, upload, verification]) queue.removePendingTasks(() => true);
      database.close();
    }};
}

test('prefetched downloads remain leased beyond thirty minutes and never appear twice', async () => {
  const f = fixture();
  f.download.on('taskCompleted', (task: Task) => f.jobs.complete(task.persistentJobId!, f.owner));
  f.download.on('taskSettled', () => f.dispatcher.dispatch());
  try {
    for (let index = 0; index < 5; index++) f.jobs.enqueue({kind: 'download', dedupeKey: `long-${index}`, bvid: `BVLONG${index}`, priority: index});
    f.dispatcher.dispatch();
    assert.equal(f.download.getSize(), 5);
    const second = f.download.getTasks()[1];
    for (let minute = 0; minute < 31; minute++) { f.advance(60_000); f.dispatcher.renewLeases(); }
    f.dispatcher.dispatch();
    assert.equal(f.jobs.findById(second.persistentJobId!)?.status, 'leased');
    f.tasks[0].finish?.();
    await flush();
    assert.equal(f.download.getTasks().filter(task => task.persistentJobId === second.persistentJobId).length, 1);
    assert.equal(f.tasks.length, 5);
    assert.equal(second.status, 'running');
  } finally { await f.close(); }
});

test('all three queues renew prefetched and retry-wait claims using their own lease duration', async () => {
  const f = fixture();
  try {
    for (const [kind, queue] of [['download', f.download], ['upload', f.upload], ['verify_upload', f.verification]] as const) {
      queue.setStartGate(() => false);
      f.jobs.enqueue({kind, dedupeKey: kind, bvid: 'BVWAIT'});
      const [claim] = f.jobs.claimDue([kind], 1, f.owner, 60_000);
      const task = new HeldTask(kind);
      task.persistentJobId = claim.id;
      task.persistentJob = claim;
      if (kind === 'upload') task.status = 'retry_wait';
      queue.addTask(task);
    }
    f.advance(30_000);
    f.dispatcher.renewLeases();
    const states = [f.download, f.upload, f.verification].map(queue => f.jobs.findById(queue.getTasks()[0].persistentJobId!)!);
    assert.ok(states.every(job => job.status === 'leased' && job.leaseOwner === f.owner));
    assert.equal(states[0].leaseExpiresAt! - states[0].updatedAt, 30 * 60_000);
    assert.equal(states[2].leaseExpiresAt! - states[2].updatedAt, 5 * 60_000);
  } finally { await f.close(); }
});

test('expired queued claims are discarded before a fresh single claim is admitted', async () => {
  const f = fixture();
  try {
    f.download.setStartGate(() => false);
    f.jobs.enqueue({kind: 'download', dedupeKey: 'expired', bvid: 'BVEXPIRED'});
    f.dispatcher.dispatch();
    const previous = f.download.getTasks()[0];
    f.advance(31 * 60_000);
    f.dispatcher.dispatch();
    assert.equal(f.download.getSize(), 1);
    assert.notEqual(f.download.getTasks()[0], previous);
    assert.equal(previous.status, 'error');
    assert.equal(f.jobs.findById(previous.persistentJobId!)?.status, 'leased');
  } finally { await f.close(); }
});

test('lease loss during execution rejects renewal rather than reclaiming a second task', async () => {
  const f = fixture();
  try {
    f.jobs.enqueue({kind: 'download', dedupeKey: 'running-expired', bvid: 'BVRUNNING'});
    f.dispatcher.dispatch();
    f.advance(31 * 60_000);
    assert.throws(() => f.dispatcher.renewLeases(), /lost its lease/);
    assert.equal(f.tasks.length, 1);
  } finally { await f.close(); }
});

test('expired claims cannot be revived or started by their previous owner', async () => {
  const f = fixture();
  try {
    const job = f.jobs.enqueue({kind: 'download', dedupeKey: 'fenced', bvid: 'BVFENCED'});
    f.jobs.claimDue(['download'], 1, f.owner, 60_000);
    f.advance(60_000);
    assert.equal(f.jobs.markRunning(job.id, f.owner), false);
    assert.equal(f.jobs.extendLease(job.id, f.owner), false);
    const [next] = f.jobs.claimDue(['download'], 1, 'next-owner');
    assert.equal(next.id, job.id);
    assert.equal(f.jobs.markRunning(job.id, f.owner), false);
    assert.equal(f.jobs.extendLease(job.id, f.owner), false);
    assert.equal(f.jobs.markRunning(job.id, 'next-owner'), true);
  } finally { await f.close(); }
});

test('production scheduler heartbeat renews pending claims without executing external work', async () => {
  const root = await createTestDir('scheduler-prefetch-heartbeat');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const user = seedQueuedDownload(state, 'BVHEARTBEAT');
  const time = new ManualTime();
  // Resolve the queued task's account without enrolling it in automatic scans.
  const f = createHeldScheduler({get: () => testConfig({pollIntervalMinutes: 1440})}, {list: () => [], getById: () => user}, state, {now: time.now, scheduleTimer: time.schedule});
  try {
    const job = f.jobs.enqueue({kind: 'download', dedupeKey: 'heartbeat', bvid: 'BVHEARTBEAT', payload: {primaryUserId: user.id, primaryMediaId: 1, primaryFolderTitle: 'Favorites'}});
    f.scheduler.start();
    f.scheduler.wake();
    assert.equal(f.queues.get('download').getSize(), 1);
    time.advance(31 * 60_000);
    await flush();
    assert.equal(f.jobs.findById(job.id)?.status, 'leased');
    assert.ok(f.jobs.findById(job.id)!.leaseExpiresAt! > time.now());
    assert.equal(f.queues.get('download').getActiveCount(), 0);
  } finally { await f.scheduler.shutdown(1000, {closeDatabase: false}); state.close(); await removeTestDir(root); }
});

test('production start failure closes admission and retains SQLite recovery evidence', async t => {
  t.mock.method(console, 'error', () => {});
  const root = await createTestDir('scheduler-start-failure');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const user = seedQueuedDownload(state, 'BVSTARTFAIL');
  let failures = 0, runs = 0;
  const f = createHeldScheduler({get: () => testConfig()}, {list: () => [], getById: () => user}, state, {onFatalError: () => { failures++; }});
  try {
    const job = f.jobs.enqueue({kind: 'download', dedupeKey: 'start-failure', bvid: 'BVSTARTFAIL', payload: {primaryUserId: user.id, primaryMediaId: 1, primaryFolderTitle: 'Favorites'}});
    f.scheduler.start(); f.scheduler.wake();
    const task = f.queues.get('download').getTasks()[0];
    assert.ok(task);
    t.mock.method(task, 'run', async () => { runs++; });
    state.getDatabase().db.pragma('query_only=ON');
    f.queues.get('download').allowExecution();
    await flush();
    assert.equal(failures, 1);
    assert.equal(runs, 0);
    assert.equal(f.scheduler.wake(), false);
    assert.equal(f.scheduler.start(), false);
    assert.equal(f.queues.get('download').getActiveCount(), 0);
    await assert.rejects(f.scheduler.shutdown(100, {closeDatabase: false}), /database and leases retained/);
    assert.equal(f.jobs.findById(job.id)?.status, 'leased');
    assert.equal(f.jobs.findById(job.id)?.leaseOwner, f.owner);
  } finally { state.close(); await removeTestDir(root); }
});

test('production timer persistence failure stops scheduling instead of escaping the timer callback', async t => {
  t.mock.method(console, 'error', () => {});
  const root = await createTestDir('scheduler-timer-failure');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const user = seedQueuedDownload(state, 'BVTIMERFAIL');
  const time = new ManualTime();
  let failures = 0;
  const f = createHeldScheduler({get: () => testConfig({pollIntervalMinutes: 1440})}, {list: () => [], getById: () => user}, state,
    {now: time.now, scheduleTimer: time.schedule, onFatalError: () => { failures++; }});
  try {
    const job = f.jobs.enqueue({kind: 'download', dedupeKey: 'timer-failure', bvid: 'BVTIMERFAIL', payload: {primaryUserId: user.id, primaryMediaId: 1, primaryFolderTitle: 'Favorites'}});
    f.scheduler.start(); f.scheduler.wake();
    await flush();
    state.getDatabase().db.pragma('query_only=ON');
    time.advance(60_000);
    assert.equal(failures, 1);
    assert.equal(f.scheduler.wake(), false);
    assert.equal(f.scheduler.start(), false);
    assert.equal(time.pending, 0);
    await assert.rejects(f.scheduler.shutdown(100, {closeDatabase: false}), /database and leases retained/);
    assert.equal(f.jobs.findById(job.id)?.status, 'leased');
  } finally { state.close(); await removeTestDir(root); }
});
