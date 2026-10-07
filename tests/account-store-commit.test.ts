import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../src/config.js';
import { createConfigurationService } from '../src/configuration-service.js';
import { writeJsonFile } from '../src/storage.js';
import { AccountOperationCancelled, UserStore, type BiliUser } from '../src/users.js';
import { createTestDir, removeTestDir } from './helpers.js';
import { memoryUsers } from './fixtures/memory-users.js';

const account = (): BiliUser => ({id: '1', uid: 1, name: 'Fixture', enabled: true,
  favorites: [{mediaId: 10, title: 'Favorites'}], lastLoginAt: '',
  cookie: {SESSDATA: 'fixture', bili_jct: 'fixture', DedeUserID: '1'}});

test('account authority survives profile updates but not removal, re-addition or selection changes', async () => {
  const users = memoryUsers([account()]);
  const before = users.captureAccount('1')!;
  users.updatePartial('1', {name: 'Renamed'});
  assert.equal(users.isAuthorizationCurrent(before.identity), true);
  assert.equal(users.isScanCurrent(before.identity, 10), true);
  assert.equal(users.getCurrentUser(before.user)?.name, 'Renamed');
  const release = users.beginAccountRemoval('1');
  assert.equal(users.isAccountCurrent(before.identity), false);
  assert.equal(users.captureAccount('1'), null);
  assert.throws(() => users.updatePartial('1', {name: 'Old callback'}), AccountOperationCancelled);
  let finished = false;
  const waiting = users.waitForAccountRemoval('1').then(() => {finished = true;});
  await Promise.resolve();
  assert.equal(finished, false);
  users.remove('1');
  release();
  await waiting;
  users.upsert(account());
  assert.equal(users.getCurrentUser(before.user), null);
  assert.equal(users.isAuthorizationCurrent(before.identity), false);
  const next = users.captureAccount('1')!;
  const nextRelease = users.beginAccountRemoval('1');
  release(); // A completed lease cannot release a new deletion.
  assert.equal(users.captureAccount('1'), null);
  nextRelease();
  assert.equal(users.isAccountCurrent(next.identity), false);
  const selected = users.captureAccount('1')!;
  users.updateFavorites('1', []);
  assert.equal(users.isScanCurrent(selected.identity, 10), false);
  assert.equal(users.isAuthorizationCurrent(selected.identity), true);
  users.reload();
  assert.equal(users.isAccountCurrent(selected.identity), false);
});

for (const operation of ['update', 'upsert', 'remove'] as const) {
  test(`failed account ${operation} preserves durable data, memory and operation authority`, async () => {
    const root = await createTestDir('account-save');
    const filePath = path.join(root, 'users.json');
    writeJsonFile(filePath, [account()]);
    let fail = false;
    const users = new UserStore({filePath, write(file, value) {
      if (fail) throw new Error('injected account persistence failure');
      writeJsonFile(file, value);
    }});
    const bytes = fs.readFileSync(filePath, 'utf8');
    const snapshot = users.captureAccount('1')!;
    fail = true;
    try {
      assert.throws(() => operation === 'update' ? users.updatePartial('1', {accessToken: 'new'})
        : operation === 'upsert' ? users.upsert({...account(), name: 'New login'}) : users.remove('1'), /persistence failure/);
      assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
      assert.deepEqual(users.getById('1'), snapshot.user);
      assert.equal(users.isAuthorizationCurrent(snapshot.identity), true);
    } finally {await removeTestDir(root);}
  });
}

test('configuration save failure and runtime apply failure report their actual commit stage', async () => {
  const root = await createTestDir('config-save');
  const filePath = path.join(root, 'config.json');
  let failSave = false, failApply = false, applied = 0;
  const config = new ConfigStore({filePath, write(file, value) {
    if (failSave) throw new Error('injected config save failure');
    writeJsonFile(file, value);
  }});
  const service = createConfigurationService({config, users: () => [], hasPathMigration: () => false,
    hasArchiveDeletion: () => false, hasRemotePaths: () => false,
    changed() {applied++; if (failApply) throw new Error('injected runtime failure');},
    inspectStorage: async () => {throw new Error('unused');}});
  const before = config.get();
  const bytes = fs.readFileSync(filePath, 'utf8');
  try {
    failSave = true;
    assert.throws(() => service.update({pollIntervalMinutes: 17}), /config save failure/);
    assert.deepEqual(config.get(), before);
    assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
    assert.equal(applied, 0);
    failSave = false;
    failApply = true;
    assert.throws(() => service.update({pollIntervalMinutes: 17}), {code: 'CONFIG_APPLY_FAILED', statusCode: 500});
    assert.equal(config.get().pollIntervalMinutes, 17);
    assert.equal(new ConfigStore({filePath}).get().pollIntervalMinutes, 17);
    assert.equal(applied, 1);
  } finally {await removeTestDir(root);}
});

for (const operation of ['fchmodSync', 'writeFileSync', 'fsyncSync', 'renameSync'] as const) {
  test(`atomic JSON ${operation} failure retains the old file and removes only its own temporary file`, async t => {
    const root = await createTestDir('atomic-json');
    const file = path.join(root, 'config.json');
    writeJsonFile(file, {value: 'old'}, {flush: true});
    fs.writeFileSync(path.join(root, 'unrelated.tmp'), 'keep');
    const injected = new Error(`injected ${operation}`);
    const mock = t.mock.method(fs, operation, () => {throw injected;});
    try {
      assert.throws(() => writeJsonFile(file, {value: 'new'}, {flush: true}), error => error === injected);
      mock.mock.restore();
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({value: 'old'}, null, 2));
      assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'unrelated.tmp']);
    } finally {mock.mock.restore(); await removeTestDir(root);}
  });
}

test('atomic JSON writes preserve existing Unix permissions', {skip: process.platform === 'win32' ? 'Windows permission bits do not implement Unix file modes' : false}, async () => {
  const root = await createTestDir('atomic-mode');
  const file = path.join(root, 'users.json');
  const previousMask = process.umask(0o077);
  try {
    writeJsonFile(file, []);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o640);
    writeJsonFile(file, [1], {flush: true});
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally {process.umask(previousMask); await removeTestDir(root);}
});
