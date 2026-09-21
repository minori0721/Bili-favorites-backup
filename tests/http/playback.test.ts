import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import path from 'node:path';
import { createPlaybackService } from '../../src/playback-service.js';
import { createPlaybackRouter } from '../../src/http/playback.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import type { BiliUser } from '../../src/users.js';

test('playback HTTP validates inputs and resolves current storage after replacement', async () => {
  const root = await createTestDir('playback-routes');
  const first = new StateManager({dbPath: path.join(root, 'first.sqlite'), statePath: path.join(root, 'first.json')});
  const second = new StateManager({dbPath: path.join(root, 'second.sqlite'), statePath: path.join(root, 'second.json')});
  let current = first;
  let reads = 0;
  const user: BiliUser = {id: 'user', uid: 1, name: 'test', cookie: {SESSDATA: '', bili_jct: '', DedeUserID: ''}, favorites: [], enabled: true, lastLoginAt: ''};
  const service = createPlaybackService({
    database: () => { reads++; return current.getDatabase(); }, config: () => testConfig(),
    users: {getById: id => id === user.id ? user : null}, isKnownOwner: id => id === 'deleted-owner',
    updateMetadata: (...args) => current.updatePlaybackMediaMetadata(...args),
  });
  const app = express(); app.use(express.json());
  app.use(createPlaybackRouter({service, boundary: handler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); }}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/users`;
  try {
    assert.equal((await fetch(base + '/missing/favorites/1/playback-queue')).status, 404);
    assert.equal((await fetch(base + '/user/favorites/1/playback-queue?pageSize=51')).status, 400);
    assert.equal((await fetch(base + '/user/favorites/0/playback-search?q=x')).status, 400);
    assert.equal(reads, 0);
    assert.equal((await fetch(base + '/user/favorites/1/playback-search?q=x')).status, 200);
    current = second; first.close();
    const rebound = await fetch(base + '/user/favorites/1/playback-search?q=x');
    assert.equal(rebound.status, 200);
    assert.deepEqual((await rebound.json()).data, service.search('user', 1, {query: 'x', page: 1, pageSize: 50}));
    assert.equal(reads, 3);
    const gone = await fetch(base + '/deleted-owner/favorites/1/playback/files/1/open-in-alist');
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).code, 'PLAYBACK_FILE_NOT_FOUND');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    first.close(); second.close(); await removeTestDir(root);
  }
});
