import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFavoriteDetailService } from '../src/favorite-detail-service.js';
import { StateManager } from '../src/state.js';
import type { FavoriteItemsPage } from '../src/bili.js';
import type { BiliUser } from '../src/users.js';
import { createTestDir, removeTestDir } from './helpers.js';

const user: BiliUser = {id: 'u1', uid: 1, name: 'test', favorites: [], enabled: true, lastLoginAt: '', cookie: {SESSDATA: '', bili_jct: '', DedeUserID: ''}};
const page: FavoriteItemsPage = {items: [{bvid: 'BVCACHE', title: 'Archive', upperName: 'UP'}], page: 1, pageSize: 20, hasMore: false, total: 1};

test('favorite page cache shares requests and rejects late results after clearing', async () => {
  const root = await createTestDir('favorite-detail-service');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  let calls = 0;
  let finish!: (value: FavoriteItemsPage) => void;
  let now = 0;
  const service = createFavoriteDetailService({state, currentUser: () => user, now: () => now,
    listPage: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    resolveVisible: async (_cookie, _uid, item) => item,
  });
  try {
    const first = service.items(user, 1, 1);
    const second = service.items(user, 1, 1);
    await Promise.resolve();
    assert.equal(calls, 1);
    finish(page);
    assert.deepEqual(await first, await second);
    await service.items(user, 1, 1);
    assert.equal(calls, 1);
    now = 60_001;
    const stale = service.items(user, 1, 1);
    const rejected = assert.rejects(stale, /请求已失效/);
    await Promise.resolve();
    service.clear();
    finish(page);
    await rejected;
    const fresh = service.items(user, 1, 1);
    await Promise.resolve(); finish(page); await fresh;
    assert.equal(calls, 3);
  } finally {state.close(); await removeTestDir(root);}
});

test('late favorite visibility checks cannot write metadata after invalidation', async () => {
  const root = await createTestDir('favorite-detail-generation');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const service = createFavoriteDetailService({state, currentUser: () => user, now: () => 0, listPage: async () => page,
    resolveVisible: async (_cookie, _uid, item) => { entered(); await new Promise<void>(resolve => {finish = resolve;}); return item; },
  });
  try {
    const request = service.detail(user, 1, 'favorite', 1, 20, 'all');
    const rejected = assert.rejects(request, /请求已失效/);
    await started;
    service.clear(); finish(); await rejected;
    assert.equal(state.getFolderItemForUser(user.id, 1, 'BVCACHE'), null);
  } finally {state.close(); await removeTestDir(root);}
});

test('favorite detail reuses its page summary for index progress', async context => {
  const root = await createTestDir('favorite-detail-summary');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  const queryPage = context.mock.method(state.getDatabase(), 'queryFolderPage');
  const service = createFavoriteDetailService({state, currentUser: () => user, now: () => 0, listPage: async () => page,
    resolveVisible: async (_cookie, _uid, item) => item,
  });
  try {
    const stored = await service.detail(user, 1, 'favorite', 1, 20, 'pending');
    assert.equal(queryPage.mock.callCount(), 1);
    assert.deepEqual(stored.indexSummary, state.getFolderIndexSummary(user.id, 1));

    const live = await service.detail(user, 1, 'favorite', 1, 20, 'all');
    assert.equal(queryPage.mock.callCount(), 3);
    assert.deepEqual(live.indexSummary, state.getFolderIndexSummary(user.id, 1, page.total));
  } finally {state.close(); await removeTestDir(root);}
});

test('concurrent live details share visibility checks and metadata writes without caching projections', async context => {
  const root = await createTestDir('favorite-detail-concurrent');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  const record = context.mock.method(state, 'recordFavoriteItem');
  let lists = 0;
  let probes = 0;
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const service = createFavoriteDetailService({state, currentUser: () => user, now: () => 0,
    listPage: async () => {lists++; return page;},
    resolveVisible: async (_cookie, _uid, item) => {probes++; entered(); await gate; return item;},
  });
  try {
    const first = service.detail(user, 1, 'favorite', 1, 20, 'all');
    const second = service.detail(user, 1, 'favorite', 1, 20, 'all');
    await started;
    assert.equal(lists, 1);
    assert.equal(probes, 1);
    finish();
    assert.deepEqual(await first, await second);
    assert.equal(record.mock.callCount(), 1);

    await service.detail(user, 1, 'favorite', 1, 20, 'all');
    assert.equal(lists, 1, 'the existing 60-second list cache remains in effect');
    assert.equal(probes, 2, 'a later request may refresh visibility');
    assert.equal(record.mock.callCount(), 2);
  } finally {state.close(); await removeTestDir(root);}
});

test('credential replacement invalidates late detail writes and cached favorite pages', async () => {
  const root = await createTestDir('favorite-detail-credentials');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  let current = {...user, cookie: {...user.cookie}};
  let lists = 0;
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const service = createFavoriteDetailService({state, currentUser: () => current, now: () => 0,
    listPage: async () => {lists++; return page;},
    resolveVisible: async (_cookie, _uid, item) => {entered(); await gate; return item;},
  });
  try {
    const stale = service.detail(current, 1, 'favorite', 1, 20, 'all');
    const rejected = assert.rejects(stale, /请求已失效/);
    await started;
    current = {...current, cookie: {...current.cookie}};
    finish();
    await rejected;
    assert.equal(state.getFolderItemForUser(user.id, 1, page.items[0].bvid), null);

    await service.detail(current, 1, 'favorite', 1, 20, 'all');
    assert.equal(lists, 2, 'the refreshed credentials must not reuse the old page cache');
    assert.ok(state.getFolderItemForUser(user.id, 1, page.items[0].bvid));
  } finally {state.close(); await removeTestDir(root);}
});

test('failed shared visibility work is retried on the next request', async () => {
  const root = await createTestDir('favorite-detail-retry');
  const state = new StateManager({dbPath: path.join(root, 'state.sqlite'), statePath: path.join(root, 'state.json')});
  let probes = 0;
  const service = createFavoriteDetailService({state, currentUser: () => user, now: () => 0,
    listPage: async () => page,
    resolveVisible: async (_cookie, _uid, item) => {
      if (++probes === 1) throw new Error('probe failed');
      return item;
    },
  });
  try {
    const first = service.detail(user, 1, 'favorite', 1, 20, 'all');
    const second = service.detail(user, 1, 'favorite', 1, 20, 'all');
    await assert.rejects(first, /probe failed/);
    await assert.rejects(second, /probe failed/);
    assert.equal(probes, 1);
    assert.equal(state.getFolderItemForUser(user.id, 1, page.items[0].bvid), null);
    await service.detail(user, 1, 'favorite', 1, 20, 'all');
    assert.equal(probes, 2);
  } finally {state.close(); await removeTestDir(root);}
});
