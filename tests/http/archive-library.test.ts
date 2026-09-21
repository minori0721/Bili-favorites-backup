import express from 'express';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createArchiveLibraryService } from '../../src/archive-library-service.js';
import { createArchiveLibraryRouter } from '../../src/http/archive-library.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test('archive routes retain contracts and resolve current storage after a rebind', async () => {
  const root = await createTestDir('archive-routes');
  const first = new StateManager({ dbPath: path.join(root, 'first.sqlite'), statePath: path.join(root, 'first.json') });
  const second = new StateManager({ dbPath: path.join(root, 'second.sqlite'), statePath: path.join(root, 'second.json') });
  let current = first;
  let reads = 0;
  const service = createArchiveLibraryService({ database: () => { reads++; return current.getDatabase(); }, users: () => [] });
  const app = express(); app.use(createArchiveLibraryRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/archive-library`;
  try {
    const navigation = await fetch(base + '/navigation');
    assert.equal(navigation.status, 200);
    assert.equal(navigation.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await navigation.json()).data.summary, {
      total: 0, playable: 0, pending: 0, issue: 0, deleted: 0,
      sourceReferenceCount: 0, uniqueRemotePathCount: 0, lastSyncedAt: '',
    });
    assert.equal((await fetch(base + '/items?pageSize=51')).status, 400);
    assert.equal((await fetch(base + '/items/BVMISSING')).status, 404);
    assert.equal((await fetch(base + '/playback-queue?direction=invalid')).status, 400);
    assert.equal((await fetch(base + '/playback-search?queueQ=test&page=0')).status, 400);
    current = second;
    first.close();
    const rebound = await fetch(base + '/items');
    assert.equal(rebound.status, 200);
    assert.deepEqual((await rebound.json()).data, JSON.parse(JSON.stringify(service.items({}))));
    assert.equal(reads, 4);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    first.close(); second.close(); await removeTestDir(root);
  }
});
