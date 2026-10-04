import assert from 'node:assert/strict';
import test from 'node:test';
import { Task, TaskQueue, QueueLifecycleError } from '../src/queue.js';
import { StateDatabase } from '../src/database.js';
import { PersistentJobStore } from '../src/job-store.js';

class ControlledTask extends Task {
  constructor(readonly execute: () => Promise<void> = async () => {}) { super('isolated task'); }
  run() { return this.execute(); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('queue deduplicates persistent identities for both single and batch admission', () => {
  const queue = new TaskQueue(1, 5);
  queue.setStartGate(() => false);
  const make = (id: string) => { const task = new ControlledTask(); task.persistentJobId = id; return task; };
  assert.equal(queue.addTask(make('one')), true);
  assert.equal(queue.addTask(make('one')), false);
  assert.equal(queue.addTasks([make('one'), make('two'), make('two'), make('three')]), 2);
  assert.deepEqual(queue.getTasks().map(task => task.persistentJobId), ['one', 'two', 'three']);
});

test('a stale execution claim skips work and failure policy, then continues the queue once', async () => {
  const queue = new TaskQueue();
  const calls: string[] = [];
  queue.setStartGate(() => false);
  queue.setBeforeRun(task => task.persistentJobId !== 'stale');
  queue.on('taskError', () => calls.push('error policy'));
  const stale = new ControlledTask(async () => { calls.push('stale executed'); });
  stale.persistentJobId = 'stale';
  const next = new ControlledTask(async () => { calls.push('next'); });
  queue.addTasks([stale, next]);
  queue.setStartGate(() => true);
  assert.equal(await queue.waitForIdle(), true);
  assert.deepEqual(calls, ['next']);
  assert.equal(queue.getActiveCount(), 0);
  assert.equal(queue.getFailure(), null);
});

for (const event of ['taskStart', 'taskCompleted', 'taskError', 'taskRetry', 'taskSettled'] as const) {
  test(`${event} failure stops admission and releases its slot without re-executing work`, async t => {
    t.mock.method(console, 'error', () => {});
    const queue = new TaskQueue();
    const original = new Error(`${event} persistence failed`);
    let runs = 0, reported = 0;
    queue.setStartGate(() => false);
    queue.setFailureHandler(error => { reported++; assert.equal(error.cause, original); });
    queue.on(event, () => { throw original; });
    const task = new ControlledTask(async () => {
      runs++;
      if (event === 'taskError' || event === 'taskRetry') throw new Error('external failure');
    });
    if (event === 'taskError') task.maxRetries = 0;
    const second = new ControlledTask(async () => { runs += 100; });
    queue.addTasks([task, second]);
    queue.setStartGate(() => true);
    await flush();
    assert.equal(reported, 1);
    assert.equal(runs, event === 'taskStart' ? 0 : 1);
    assert.equal(queue.getActiveCount(), 0);
    assert.ok(queue.getFailure() instanceof QueueLifecycleError);
    assert.equal(queue.canAccept(), false);
    queue.poke();
    assert.equal(second.status, 'pending');
    await assert.rejects(queue.waitForIdle(), QueueLifecycleError);
  });
}

test('SQLite start failure leaves the claim recoverable and never starts the transfer', async t => {
  t.mock.method(console, 'error', () => {});
  const database = new StateDatabase(':memory:');
  const jobs = new PersistentJobStore(database);
  jobs.enqueue({ kind: 'upload', dedupeKey: 'start-fault', bvid: 'BVSTART' });
  const [claim] = jobs.claimDue(['upload'], 1, 'owner');
  const queue = new TaskQueue();
  let runs = 0;
  const task = new ControlledTask(async () => { runs++; });
  task.persistentJobId = claim.id;
  queue.setBeforeRun(value => jobs.markRunning(value.persistentJobId!, 'owner'));
  database.db.pragma('query_only=ON');
  try {
    queue.addTask(task);
    await flush();
    assert.equal(runs, 0);
    assert.equal(queue.getActiveCount(), 0);
    const failure = queue.getFailure();
    assert.ok(failure instanceof QueueLifecycleError);
    assert.equal(failure.phase, 'start');
    assert.match(String(failure.cause), /readonly/i);
    assert.equal(jobs.findById(claim.id)?.status, 'leased');
    assert.equal(jobs.findById(claim.id)?.leaseOwner, 'owner');
  } finally { database.close(); }
});

test('a successful upload with a failed SQLite commit never enters upload retry policy', async t => {
  t.mock.method(console, 'error', () => {});
  const database = new StateDatabase(':memory:');
  const jobs = new PersistentJobStore(database);
  jobs.enqueue({ kind: 'upload', dedupeKey: 'commit-fault', bvid: 'BVCOMMIT' });
  const [claim] = jobs.claimDue(['upload'], 1, 'owner');
  const queue = new TaskQueue();
  let runs = 0, retryPolicy = 0, errorPolicy = 0;
  const task = new ControlledTask(async () => { runs++; database.db.pragma('query_only=ON'); });
  task.persistentJobId = claim.id;
  queue.setBeforeRun(value => jobs.markRunning(value.persistentJobId!, 'owner'));
  queue.on('taskCompleted', () => jobs.complete(claim.id, 'owner'));
  queue.on('taskRetry', () => retryPolicy++);
  queue.on('taskError', () => errorPolicy++);
  try {
    queue.addTask(task);
    await flush();
    assert.equal(runs, 1);
    assert.equal(task.retries, 0);
    assert.equal(retryPolicy + errorPolicy, 0);
    assert.equal(queue.getActiveCount(), 0);
    assert.equal(jobs.findById(claim.id)?.status, 'running');
    await assert.rejects(queue.waitForIdle(), /phase=completion/);
  } finally { database.close(); }
});

test('an idle waiter observes a commit failure instead of reporting successful drain', async t => {
  t.mock.method(console, 'error', () => {});
  let finish!: () => void;
  const queue = new TaskQueue();
  const task = new ControlledTask(() => new Promise<void>(resolve => { finish = resolve; }));
  queue.on('taskCompleted', () => { throw new Error('commit failed'); });
  queue.addTask(task);
  const waiting = assert.rejects(queue.waitForIdle(), /commit failed/);
  finish();
  await waiting;
  assert.equal(queue.getActiveCount(), 0);
});

test('failure in the terminal notification is observed without an unhandled rejection', async t => {
  const messages: unknown[][] = [];
  t.mock.method(console, 'error', (...message: unknown[]) => { messages.push(message); });
  const queue = new TaskQueue();
  queue.on('taskStart', () => { throw new Error('original failure'); });
  queue.setFailureHandler(() => { throw new Error('notification failure'); });
  queue.addTask(new ControlledTask());
  await flush();
  assert.equal(queue.getActiveCount(), 0);
  assert.match(queue.getFailure()?.message ?? '', /original failure/);
  assert.ok(messages.some(message => String(message[0]).includes('notification failure')));
});

test('ordinary transfer failures retain the existing retry decision', async () => {
  const queue = new TaskQueue();
  let policy = 0;
  queue.on('taskError', () => policy++);
  const task = new ControlledTask(async () => { throw new Error('network unavailable'); });
  task.maxRetries = 0;
  queue.addTask(task);
  assert.equal(await queue.waitForIdle(), true);
  assert.equal(policy, 1);
  assert.equal(queue.getFailure(), null);
});
