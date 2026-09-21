import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountLogin } from '../src/account-login-service.js';
import type { BiliUser } from '../src/users.js';

function fixture() {
  let completed!: (value: unknown) => void;
  let failed!: (value: unknown) => void;
  let resolveInfo!: (value: {uid: number; name: string}) => void;
  let enterInfo!: () => void;
  const entered = new Promise<void>(resolve => {enterInfo = resolve;});
  const users: BiliUser[] = [];
  let releases = 0;
  let stopped = 0;
  let now = 0;
  const service = createAccountLogin({
    create: () => ({login: async () => 'isolated-url', completed: cb => {completed = cb;}, failed: cb => {failed = cb;}, stop() {stopped++;}}),
    qr: async () => 'isolated-qr', normalize: () => ({rawAuth: '{}', cookie: {SESSDATA: '', bili_jct: '', DedeUserID: ''}, accessToken: '', refreshToken: '', expires: 0}),
    info: async () => {enterInfo(); return new Promise(resolve => {resolveInfo = resolve;});},
    users: {upsert(user) {users.push(user); return user;}}, maintenance: {enter: () => () => {releases++;}},
    restore: () => undefined, id: () => 'login-test', now: () => now,
  });
  return {service, users, entered, complete: () => completed({}), fail: () => failed(Error('external login error')),
    finish: () => resolveInfo({uid: 1, name: 'test'}), releases: () => releases, stopped: () => stopped,
    expire: () => {now = 600_001;}};
}

test('login invalidation rejects old user info and shutdown waits for the active callback', async () => {
  const f = fixture();
  await f.service.start(); f.complete(); await f.entered;
  f.service.invalidate();
  assert.equal(await f.service.stop(0), false);
  f.finish();
  assert.equal(await f.service.stop(1000), true);
  assert.equal(f.users.length, 0);
  assert.equal(f.releases(), 1);
  assert.equal(f.service.status('login-test'), undefined);
});

test('login consumes completion once and reports external errors through session status', async () => {
  const f = fixture(); await f.service.start(); f.complete(); f.complete(); await f.entered;
  f.finish();
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(f.users.length, 1);
  assert.equal(f.service.status('login-test')?.status, 'completed');
  assert.equal(f.releases(), 1);
  assert.equal(await f.service.stop(1000), true);
  const error = fixture(); await error.service.start(); error.fail();
  assert.equal(error.service.status('login-test')?.status, 'error');
  error.expire(); assert.equal(error.service.status('login-test'), undefined);
  assert.ok(error.stopped() >= 1);
  await error.service.stop(1000);
});
