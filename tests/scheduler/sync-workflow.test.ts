import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliRiskOrLoginError } from '../../src/bili.js';
import { createSyncWorkflow, type SyncWorkflowDependencies } from '../../src/scheduler/sync-workflow.js';
import type { BiliUser } from '../../src/users.js';
import { createSyncRuntime } from '../../src/scheduler/sync-runtime.js';

function fixture() {
  const user: BiliUser = { id: 'u', uid: 1, name: 'user', cookie: { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' }, favorites: [{ mediaId: 1, title: 'one' }, { mediaId: 2, title: 'two' }], enabled: true, lastLoginAt: '' };
  const calls: string[] = [];
  const dependencies: SyncWorkflowDependencies = {
    users: () => [user], eligible: item => item.enabled,
    state: { getUserCooldown: () => null, setUserCooldown: (_id, _reason, ms) => { calls.push(`cooldown:${ms}`); } },
    scan: {
      all: async (_user, id) => { calls.push(`all:${id}`); },
      hot: async (_user, id) => { calls.push(`hot:${id}`); return 3; },
      history: async (_user, id, _title, _manual, page) => { calls.push(`history:${id}:${page}`); }
    },
    progress: () => { }, scanPosition: () => null,
    enterUser: id => { calls.push(`enter:${id}`); }, leaveUser: id => { calls.push(`leave:${id}`); },
    random: () => 0, sleep: async ms => { calls.push(`sleep:${ms}`); },
  };
  return { dependencies, calls };
}

test('sync workflow preserves hot/history order and injected pacing', async () => {
  const f = fixture(); await createSyncWorkflow(f.dependencies).run(false, false);
  assert.deepEqual(f.calls, ['enter:u', 'hot:1', 'history:1:3', 'sleep:2000', 'hot:2', 'history:2:3', 'sleep:2000', 'leave:u']);
});

test('full scan selects only the full-scan capability', async () => {
  const f = fixture(); await createSyncWorkflow(f.dependencies).run(true, true);
  assert.deepEqual(f.calls, ['enter:u', 'all:1', 'sleep:2000', 'all:2', 'sleep:2000', 'leave:u']);
});

test('risk response applies bounded cooldown and releases the active-user owner', async () => {
  const f = fixture(); f.dependencies.scan.hot = async () => { throw new BiliRiskOrLoginError('risk'); };
  await createSyncWorkflow(f.dependencies).run(false, false);
  assert.deepEqual(f.calls, ['enter:u', 'cooldown:1800000', 'leave:u']);
});

test('sleep cancellation propagates and releases active-user accounting', async () => {
  const f = fixture(); const failure = new Error('cancelled');
  f.dependencies.sleep = async () => { throw failure; };
  await assert.rejects(createSyncWorkflow(f.dependencies).run(false, false), error => error === failure);
  assert.deepEqual(f.calls, ['enter:u', 'hot:1', 'history:1:3', 'leave:u']);
});

test('network failure logs the actual page once and continues without account cooldown', async (t) => {
  const f = fixture();
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => { messages.push(message); });
  let position: { mediaId?: number; page?: number } = {};
  f.dependencies.progress = patch => { position = { ...position, ...patch }; };
  f.dependencies.scanPosition = () => position;
  f.dependencies.scan.hot = async (_user, id) => {
    f.calls.push(`hot:${id}`);
    if (id === 1) {
      position.page = 4;
      throw Object.assign(new Error('read failed access_token=do-not-log'), { code: 'ECONNRESET' });
    }
    return 3;
  };
  await createSyncWorkflow(f.dependencies).run(false, false);
  assert.deepEqual(f.calls, ['enter:u', 'hot:1', 'sleep:2000', 'hot:2', 'history:2:3', 'sleep:2000', 'leave:u']);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /user_id="u" media_id=1 phase=hot page=4 category=network code=ECONNRESET/);
  assert.doesNotMatch(messages[0], /do-not-log/);
});

test('history and full-scan failure context does not reuse a previous page', async (t) => {
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => { messages.push(message); });
  const f = fixture();
  let position: { mediaId?: number; page?: number } = {};
  f.dependencies.progress = patch => { position = { ...position, ...patch }; };
  f.dependencies.scanPosition = () => position;
  f.dependencies.scan.hot = async (_user, id) => { position = { mediaId: id, page: 3 }; return 3; };
  f.dependencies.scan.history = async () => { throw new Error('failed before requesting a history page'); };
  await createSyncWorkflow(f.dependencies).run(false, false);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /media_id=1 phase=history page=unknown/);
  assert.match(messages[1], /media_id=2 phase=history page=unknown/);
  messages.length = 0;
  f.dependencies.scan.all = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  await createSyncWorkflow(f.dependencies).run(true, true);
  assert.match(messages[0], /phase=full page=unknown category=network code=ETIMEDOUT/);
});

test('production sync-runtime wiring reads failure position from its owned progress', async (t) => {
  const f = fixture();
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => { messages.push(message); });
  const runtime = createSyncRuntime({
    users: f.dependencies.users, eligible: f.dependencies.eligible, state: f.dependencies.state, scan: f.dependencies.scan,
    accepting: () => true, blocked: () => false, now: () => 1_000, random: () => 0, sleep: async () => {},
    triggerLabel: trigger => trigger, clearRemoteListings() {}, recoverStaleActiveBackups() {},
    requeueRetryPendingBeforeScan: () => 0, verifyRemoteSamples: async () => ({}), logCycleSummary() {}, scheduleQueued() {},
  });
  f.dependencies.scan.hot = async (_user, id) => {
    runtime.updateProgress({ mediaId: id, page: id === 1 ? 4 : 8 });
    throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  };
  await runtime.run(false);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /media_id=1 phase=hot page=4/);
  assert.match(messages[1], /media_id=2 phase=hot page=8/);
  assert.equal(f.calls.some(call => call.startsWith('cooldown:')), false);
  assert.equal(runtime.isIdle(), true);
});
