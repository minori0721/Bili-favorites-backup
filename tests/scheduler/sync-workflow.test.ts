import assert from 'node:assert/strict';
import test from 'node:test';
import { BiliRiskOrLoginError } from '../../src/bili.js';
import { createSyncWorkflow, type SyncWorkflowDependencies } from '../../src/scheduler/sync-workflow.js';
import type { BiliUser } from '../../src/users.js';

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
    progress: () => { }, enterUser: id => { calls.push(`enter:${id}`); }, leaveUser: id => { calls.push(`leave:${id}`); },
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
