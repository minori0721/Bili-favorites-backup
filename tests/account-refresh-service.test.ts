import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountRefresh, type AccountRefreshDependencies } from '../src/account-refresh-service.js';
import { ImportMaintenance } from '../src/import-maintenance.js';
import type { BiliUser } from '../src/users.js';

function fixture() {
  const user: BiliUser = { id: 'u', uid: 1, name: 'user', cookie: { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' }, favorites: [], enabled: true, lastLoginAt: '', accessToken: 'old', refreshToken: 'refresh' };
  const maintenance = new ImportMaintenance();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let writes = 0;
  let wakes = 0;
  const dependencies: AccountRefreshDependencies = {
    users: {
      list: () => [user], getById: id => id === user.id ? user : null,
      updatePartial: (_id, patch) => { writes++; Object.assign(user, patch); return user; }
    },
    maintenance, refresh: async () => ({ cookie: user.cookie, rawAuth: '{}', accessToken: 'new', refreshToken: 'refresh', expires: 2_000_000_000_000 }),
    info: async () => ({ uid: 1, name: 'updated' }), wake: () => { wakes++; }, transfersRunning: () => false,
    now: () => 1_700_000_000_000,
    timers: { set: (_callback, _ms) => { const timer = setTimeout(() => { }, 1_000_000); timer.unref(); timers.push(timer); return timer; }, clear: clearTimeout },
  };
  return { dependencies, user, maintenance, timers, counts: () => ({ writes, wakes }) };
}

test('account refresh coalesces duplicate requests and drains before shutdown', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const original = f.dependencies.refresh;
  f.dependencies.refresh = async (...args) => { await pending; return original(...args); };
  const service = createAccountRefresh(f.dependencies);
  service.start(); service.start();
  assert.equal(f.timers.length, 1);
  const first = service.refresh('u', 'manual');
  assert.equal(service.refresh('u', 'manual'), first);
  assert.equal(await service.stop(0), false);
  await assert.rejects(service.refresh('u', 'manual'), /stopping/);
  release(); await first;
  assert.equal(await service.stop(0), true);
  service.start();
  assert.equal(f.timers.length, 1);
  assert.deepEqual(f.counts(), { writes: 1, wakes: 1 });
  assert.equal(f.user.lastAuthRefreshAt, new Date(f.dependencies.now()).toISOString());
});

test('account refresh honors import admission and does not report a blocked call as remote failure', async () => {
  const f = fixture(); const service = createAccountRefresh(f.dependencies);
  const release = await f.maintenance.acquire(0);
  try {
    await assert.rejects(service.refresh('u', 'manual'), /维护/);
    assert.deepEqual(f.counts(), { writes: 0, wakes: 0 });
  } finally { release(); await service.stop(0); }
});

test('account refresh failure is persisted and propagated without waking probes', async () => {
  const f = fixture(); const failure = new Error('timeout');
  f.dependencies.refresh = async () => { throw failure; };
  const service = createAccountRefresh(f.dependencies);
  await assert.rejects(service.refresh('u', 'manual'), error => error === failure);
  assert.deepEqual(f.counts(), { writes: 1, wakes: 0 });
  assert.equal(f.user.accessToken, 'old');
  assert.equal(f.user.authRefreshFailureAttempts, 1);
  assert.equal(await service.stop(0), true);
});
