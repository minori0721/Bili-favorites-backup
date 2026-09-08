import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createFavoriteScan } from '../../src/scheduler/favorite-scan.js';
import { StateManager } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import type { FavoriteItemsPage } from '../../src/bili.js';
import { createTestDir, removeTestDir } from '../helpers.js';

const user: BiliUser = { id: 'scan-account', uid: 1, name: 'Fixture', enabled: true, favorites: [], lastLoginAt: '',
  cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
const item = { bvid: 'BVSCAN', title: 'Fixture', upperName: 'Fixture', cover: 'https://example.test/cover.jpg' };

for (const interruption of ['generation', 'maintenance', 'reset'] as const) {
  test(`late scan page cannot commit after ${interruption}`, async () => {
    const runtime = await createTestDir('scan-late');
    const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
    let resolve!: (page: FavoriteItemsPage) => void;
    let generation = 0;
    let admitted = true;
    let queued = 0;
    const scan = createFavoriteScan({
      deletions: { folder: (u,m) => state.getDatabase().isArchiveFolderDeletionActive(u,m), source: (u,m,b) => state.getDatabase().isArchiveSourceDeletionActive(u,m,b) },
      state, users: { getById: () => user, updatePartial: () => user }, now: () => 1_000, random: () => 0, sleep: async () => {},
      generation: () => generation, canRun: () => admitted,
      listPage: () => new Promise(done => { resolve = done; }), refreshAuth: async () => { throw new Error('unexpected refresh'); },
      resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {}, progress() {}, recordCount() {}, probe() {},
      enqueue() { queued++; return true; },
    });
    try {
      const work = scan.hot(user, 1, 'Favorites', false);
      if (interruption === 'generation') generation++;
      if (interruption === 'maintenance') admitted = false;
      if (interruption === 'reset') scan.reset();
      resolve({ items: [item], page: 1, pageSize: 20, hasMore: false, total: 1 });
      await assert.rejects(work, /lifecycle change/);
      assert.equal(queued, 0);
      assert.equal(state.getVideoMeta(item.bvid), null);
    } finally { state.close(); await removeTestDir(runtime); }
  });
}

test('scan preserves page policy and rejects a late cover callback after reset', async () => {
  const runtime = await createTestDir('scan-policy');
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
  const pages: number[] = [], waits: number[] = [];
  let cover: ((path: string) => void) | undefined;
  let fresh = 0;
  const scan = createFavoriteScan({
      deletions: { folder: (u,m) => state.getDatabase().isArchiveFolderDeletionActive(u,m), source: (u,m,b) => state.getDatabase().isArchiveSourceDeletionActive(u,m,b) },
    state, users: { getById: () => user, updatePartial: () => user }, now: () => 1_000, random: () => 0.5,
    sleep: async ms => { waits.push(ms); }, generation: () => 0, canRun: () => true,
    listPage: async (_cookie, _mediaId, page, pageSize) => { pages.push(page); return { items: [item], page, pageSize, hasMore: true, total: 100 }; },
    refreshAuth: async () => { throw new Error('unexpected refresh'); }, resolveSelfVisible: async (_cookie, _uid, value) => value,
    cacheCover(_bvid, _url, callback) { cover = callback; }, progress() {}, recordCount(n) { fresh += n; }, probe() {}, enqueue: () => false,
  });
  try {
    await scan.hot(user, 1, 'Favorites', false);
    assert.deepEqual(pages, [1, 2, 3, 4]);
    assert.deepEqual(waits, [2000, 2000, 2000]);
    assert.equal(fresh, 1);
    scan.reset();
    cover?.('stale-cover.jpg');
    assert.equal(state.getVideoMeta(item.bvid)?.coverLocalPath, undefined);
  } finally { state.close(); await removeTestDir(runtime); }
});
