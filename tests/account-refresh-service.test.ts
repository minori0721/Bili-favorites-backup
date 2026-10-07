import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountRefresh, type AccountRefreshDependencies } from '../src/account-refresh-service.js';
import { ImportMaintenance } from '../src/import-maintenance.js';
import type { BiliUser } from '../src/users.js';
import { AccountOperationCancelled } from '../src/users.js';
import { memoryUsers } from './fixtures/memory-users.js';

function fixture() {
  const user: BiliUser = { id: 'u', uid: 1, name: 'user', cookie: { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' }, favorites: [], enabled: true, lastLoginAt: '', accessToken: 'old', refreshToken: 'refresh' };
  const maintenance = new ImportMaintenance();
  const store = memoryUsers([user]);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let writes = 0;
  let wakes = 0;
  const dependencies: AccountRefreshDependencies = {
    users: {
      list: () => store.list(), getById: id => store.getById(id),
      captureAccount: id => store.captureAccount(id), isAuthorizationCurrent: identity => store.isAuthorizationCurrent(identity),
      updatePartial: (id, patch) => { writes++; return store.updatePartial(id, patch); }
    },
    maintenance, refresh: async () => ({ cookie: user.cookie, rawAuth: '{}', accessToken: 'new', refreshToken: 'refresh', expires: 2_000_000_000_000 }),
    info: async () => ({ uid: 1, name: 'updated' }), wake: () => { wakes++; }, transfersRunning: () => false,
    now: () => 1_700_000_000_000,
    timers: { set: (_callback, _ms) => { const timer = setTimeout(() => { }, 1_000_000); timer.unref(); timers.push(timer); return timer; }, clear: clearTimeout },
  };
  return { dependencies, get user() { return store.getById('u')!; }, store, maintenance, timers, counts: () => ({ writes, wakes }) };
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
  assert.equal(service.refresh('u', 'auto'), first);
  assert.equal(service.refresh('u', 'on_error'), first);
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

for (const outcome of ['success', 'failure'] as const) {
  test(`a superseded refresh ${outcome} cannot overwrite a newer login`, async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = f.dependencies.refresh;
    f.dependencies.refresh = async (...args) => {
      await pending;
      if (outcome === 'failure') throw new Error('old token rejected');
      return original(...args);
    };
    const service = createAccountRefresh(f.dependencies);
    const old = service.refresh('u', 'auto');
    const rejected = assert.rejects(old, AccountOperationCancelled);
    f.store.upsert({ ...f.user, cookie: { ...f.user.cookie, SESSDATA: 'new-login' }, accessToken: 'new-login', refreshToken: 'new-login-refresh' });
    release(); await rejected;
    assert.equal(f.user.accessToken, 'new-login');
    assert.equal(f.user.lastAuthRefreshError, undefined);
    assert.equal(f.user.authRefreshFailureAttempts, undefined);
    assert.deepEqual(f.counts(), { writes: 0, wakes: 0 });
    assert.equal(await service.stop(0), true);
  });
}

test('refresh tracks superseded requests until settlement and old finally cannot remove a new request', async () => {
  const f = fixture();
  const release: Array<() => void> = [];
  f.dependencies.refresh = async () => {
    await new Promise<void>(resolve => { release.push(resolve); });
    return { cookie: f.user.cookie, rawAuth: '{}', accessToken: 'refreshed', refreshToken: 'refreshed', expires: 2_000_000_000_000 };
  };
  const service = createAccountRefresh(f.dependencies);
  const old = service.refresh('u', 'auto');
  const rejected = assert.rejects(old, AccountOperationCancelled);
  f.store.upsert({ ...f.user, accessToken: 'login-2', refreshToken: 'login-2' });
  const current = service.refresh('u', 'manual');
  assert.equal(release.length, 2);
  release[0](); await rejected;
  assert.equal(service.refresh('u', 'on_error'), current);
  assert.equal(await service.stop(0), false);
  release[1](); await current;
  assert.equal(await service.stop(0), true);
  assert.deepEqual(f.counts(), { writes: 1, wakes: 1 });
});

test('shutdown still waits for an older refresh after the newer refresh completes', async () => {
  const f = fixture();
  let release!: () => void;
  let calls = 0;
  const original = f.dependencies.refresh;
  f.dependencies.refresh = async (...args) => {
    if (++calls === 1) await new Promise<void>(resolve => { release = resolve; });
    return original(...args);
  };
  const service = createAccountRefresh(f.dependencies);
  const old = service.refresh('u', 'auto');
  const rejected = assert.rejects(old, AccountOperationCancelled);
  f.store.upsert({ ...f.user, accessToken: 'new-login' });
  await service.refresh('u', 'manual');
  assert.equal(await service.stop(0), false);
  release(); await rejected;
  assert.equal(await service.stop(0), true);
});

test('credential persistence failure is propagated without an authentication failure patch', async () => {
  const f = fixture();
  const storageError = new Error('isolated disk failure');
  let writes = 0;
  f.dependencies.users.updatePartial = () => { writes++; throw storageError; };
  const service = createAccountRefresh(f.dependencies);
  await assert.rejects(service.refresh('u', 'manual'), error => error === storageError);
  assert.equal(writes, 1);
  assert.equal(f.user.accessToken, 'old');
  assert.equal(f.user.lastAuthRefreshError, undefined);
  assert.equal(f.user.authRefreshFailureAttempts, undefined);
  assert.equal(f.counts().wakes, 0);
});

test('refreshing with a different account response never saves those credentials', async () => {
  const f = fixture();
  f.dependencies.info = async () => ({uid: 2, name: 'another account'});
  await assert.rejects(createAccountRefresh(f.dependencies).refresh('u', 'manual'), /different account/);
  assert.equal(f.user.accessToken, 'old');
  assert.equal(f.counts().wakes, 0);
});
