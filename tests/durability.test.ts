import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { StateDatabase } from '../src/database.js';
import { ConfigStore } from '../src/config.js';
import { UserStore, type BiliUser } from '../src/users.js';
import { createConfigurationService } from '../src/configuration-service.js';
import { JsonFileDurabilityError, writeJsonFile } from '../src/storage.js';
import { syncCompletedFile, syncCreatedDirectory } from '../src/durability.js';
import { createTestDir, removeTestDir } from './helpers.js';

test('business SQLite uses FULL for new and reopened WAL connections', async () => {
  const root = await createTestDir('durable-sqlite');
  const file = path.join(root, 'state.sqlite');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = new StateDatabase(file);
      try {
        assert.equal(db.db.pragma('journal_mode', {simple: true}), 'wal');
        assert.equal(db.db.pragma('synchronous', {simple: true}), 2);
        assert.equal(db.db.pragma('quick_check', {simple: true}), 'ok');
      } finally { db.close(); }
    }
  } finally { await removeTestDir(root); }
});

test('durable JSON syncs data before rename, then new directory entries; post-rename I/O failure is distinct', async t => {
  const root = await createTestDir('durable-json');
  const file = path.join(root, 'new', 'nested', 'record.json');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, rename = fs.renameSync;
  const directories = new Map<number, string>();
  const events: string[] = [];
  let failDirectory = false;
  try {
    // Exercise Linux ordering on Windows too, using isolated fake directory handles only.
    Object.defineProperty(process, 'platform', {...platform, value: 'linux'});
    t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (flags === 'r' && fs.statSync(file).isDirectory()) {
        const fd = 900_000 + directories.size;
        directories.set(fd, String(file));
        return fd;
      }
      return open(file, flags, mode);
    });
    t.mock.method(fs, 'closeSync', (fd: number) => { if (!directories.has(fd)) close(fd); });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      const directory = directories.get(fd);
      events.push(directory ? `directory:${path.relative(root, directory)}` : 'file');
      if (directory) {
        if (failDirectory) throw Object.assign(new Error('injected directory sync'), {code: 'EIO'});
      } else sync(fd);
    });
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => { events.push('rename'); rename(from, to); });
    writeJsonFile(file, {value: 1}, {flush: true});
    assert.deepEqual(events, ['file', 'rename', `directory:${path.join('new', 'nested')}`]);
    events.length = 0;
    syncCreatedDirectory(path.dirname(file), path.join(root, 'new'));
    assert.deepEqual(events, [`directory:${path.join('new', 'nested')}`, 'directory:new', 'directory:']);
    failDirectory = true;
    assert.throws(() => writeJsonFile(file, {value: 2}, {flush: true}), JsonFileDurabilityError);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).value, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['record.json']);
  } finally {
    t.mock.restoreAll();
    Object.defineProperty(process, 'platform', platform);
    await removeTestDir(root);
  }
});

test('a post-rename configuration failure reconciles memory and applies the visible value, while reporting failure', async () => {
  const root = await createTestDir('durable-config');
  const filePath = path.join(root, 'config.json');
  let fail = false, applied = 0;
  const config = new ConfigStore({filePath, write(file, value) {
    writeJsonFile(file, value);
    if (fail) throw new JsonFileDurabilityError(new Error('disk I/O'));
  }});
  const service = createConfigurationService({config, users: () => [], hasPathMigration: () => false,
    hasArchiveDeletion: () => false, hasRemotePaths: () => false, changed() {applied++;},
    inspectStorage: async () => {throw new Error('unused');}});
  try {
    fail = true;
    assert.throws(() => service.update({pollIntervalMinutes: 17}), JsonFileDurabilityError);
    assert.equal(applied, 1);
    assert.equal(config.get().pollIntervalMinutes, 17);
    assert.equal(new ConfigStore({filePath}).get().pollIntervalMinutes, 17);
  } finally { await removeTestDir(root); }
});

for (const operation of ['update', 'upsert', 'remove'] as const) {
  test(`post-rename account ${operation} failure reconciles identity with the visible file`, async () => {
    const root = await createTestDir('durable-users');
    const filePath = path.join(root, 'users.json');
    let fail = false;
    const user: BiliUser = {id: 'fixture', uid: 1, name: 'Fixture', enabled: true, favorites: [], lastLoginAt: '',
      cookie: {SESSDATA: '', bili_jct: '', DedeUserID: '1'}};
    const users = new UserStore({filePath, write(file, value) {
      writeJsonFile(file, value);
      if (fail) throw new JsonFileDurabilityError(new Error('disk I/O'));
    }});
    users.upsert(user);
    const before = users.captureAccount(user.id)!;
    try {
      fail = true;
      assert.throws(() => operation === 'remove' ? users.remove(user.id)
        : operation === 'upsert' ? users.upsert({...user, name: 'New login'})
          : users.updatePartial(user.id, {accessToken: 'fixture-new'}), JsonFileDurabilityError);
      assert.deepEqual(users.list(), new UserStore({filePath}).list());
      assert.equal(users.isAuthorizationCurrent(before.identity), false);
    } finally { await removeTestDir(root); }
  });
}

test('completed-file sync propagates disk failure without changing media', async t => {
  const root = await createTestDir('durable-media');
  const file = path.join(root, 'video.mp4');
  fs.writeFileSync(file, Buffer.alloc(64 * 1024, 29));
  const open = fs.promises.open;
  let syncs = 0;
  const injected = new Error('injected media fsync');
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (String(args[0]) === file) t.mock.method(handle, 'sync', async () => {syncs++; throw injected;});
    return handle;
  });
  try {
    await assert.rejects(syncCompletedFile(file, root, 64 * 1024), error => error === injected);
    assert.equal(syncs, 1);
    assert.deepEqual(fs.readFileSync(file), Buffer.alloc(64 * 1024, 29));
  } finally { t.mock.restoreAll(); await removeTestDir(root); }
});
