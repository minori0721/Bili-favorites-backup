import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createFavoriteScan } from '../../src/scheduler/favorite-scan.js';
import { StateManager } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import { BiliResponseFormatError, BiliRiskOrLoginError, type FavoriteItemsPage } from '../../src/bili.js';
import { createTestDir, removeTestDir } from '../helpers.js';
import { availabilityJitter } from '../../src/scheduler/retry-policy.js';

const user: BiliUser = { id: 'scan-account', uid: 1, name: 'Fixture', enabled: true, favorites: [], lastLoginAt: '',
  cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
const item = { bvid: 'BVSCAN', title: 'Fixture', upperName: 'Fixture', cover: 'https://example.test/cover.jpg' };

test('a newly visible favorite advances one probe without clearing its persisted backoff', async () => {
  const runtime = await createTestDir('scan-availability-signal');
  const state = new StateManager({statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite')});
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  const due = new Date(now + 30 * 24 * 60 * 60_000).toISOString();
  state.recordFavoriteItem(user.id, 1, 'Favorites', {...item, unavailable: true});
  state.markAvailabilityConfirmedUnavailable(item.bvid, 'api_not_found', new Date(now).toISOString(), due, 3);
  const probes: {notBefore: number; preferredUserId: string}[] = [];
  const scan = createFavoriteScan({
    deletions: {folder: () => false, source: () => false},
    state, users: {getById: () => user, updatePartial: () => user},
    now: () => now, random: () => 0, sleep: async () => {}, generation: () => 0, canRun: () => true,
    listPage: async () => ({items: [item], page: 1, pageSize: 20, hasMore: false, total: 1}),
    refreshAuth: async () => { throw new Error('unexpected refresh'); },
    resolveSelfVisible: async (_cookie, _uid, value) => value,
    cacheCover() {}, progress() {}, recordCount() {},
    probe: (_bvid, options) => { probes.push(options); }, enqueue: () => false,
  });
  try {
    await scan.hot(user, 1, 'Favorites', false);
    await scan.hot(user, 1, 'Favorites', false);
    assert.deepEqual(probes, [{preferredUserId: user.id, notBefore: now + availabilityJitter(item.bvid), availabilityRound: 3, availabilityReason: 'api_not_found'}]);
    assert.equal(state.getSourceAvailability(item.bvid)?.state, 'confirmed_unavailable');
    assert.equal(state.getSourceAvailability(item.bvid)?.nextCheckAt, due);
  } finally { state.close(); await removeTestDir(runtime); }
});

test('full scan keeps completed pages but does not complete after a malformed later page', async () => {
  const runtime = await createTestDir('scan-malformed-page');
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
  const scan = createFavoriteScan({
    deletions: { folder: () => false, source: () => false },
    state, users: { getById: () => user, updatePartial: () => user }, now: () => 1_000, random: () => 0, sleep: async () => {},
    generation: () => 0, canRun: () => true,
    listPage: async (_cookie, _mediaId, page = 1) => {
      if (page === 1) return { items: [item], page, pageSize: 20, hasMore: true, total: 2 };
      throw new BiliResponseFormatError('favorite.medias');
    },
    refreshAuth: async () => { throw new Error('unexpected refresh'); },
    resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {}, progress() {}, recordCount() {}, probe() {},
    enqueue: () => false,
  });
  try {
    await assert.rejects(scan.all(user, 1, 'Favorites'), BiliResponseFormatError);
    assert.ok(state.getVideoMeta(item.bvid));
    assert.equal(state.getFolderScan(user.id, 1, 'Favorites').initStatus, 'initializing');
  } finally { state.close(); await removeTestDir(runtime); }
});

test('auth refresh retry reports the new response format error', async () => {
  const runtime = await createTestDir('scan-auth-format-retry');
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
  const authUser: BiliUser = {
    ...user,
    id: 'scan-auth-format',
    cookie: { ...user.cookie },
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expires: 1,
  };
  let pageCalls = 0;
  const scan = createFavoriteScan({
    deletions: { folder: () => false, source: () => false },
    state,
    users: {
      getById: () => authUser,
      updatePartial: (_id, patch) => Object.assign(authUser, patch),
    },
    now: () => 1_000,
    random: () => 0,
    sleep: async () => {},
    generation: () => 0,
    canRun: () => true,
    listPage: async () => {
      pageCalls += 1;
      if (pageCalls === 1) throw new BiliRiskOrLoginError('expired login');
      throw new BiliResponseFormatError('favorite.medias');
    },
    refreshAuth: async () => ({
      rawAuth: '{}',
      cookie: { SESSDATA: 'fresh', bili_jct: 'fresh', DedeUserID: '1' },
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expires: 2_000,
      uid: 1,
    }),
    resolveSelfVisible: async (_cookie, _uid, value) => value,
    cacheCover() {},
    progress() {},
    recordCount() {},
    probe() {},
    enqueue: () => false,
  });
  try {
    await assert.rejects(scan.hot(authUser, 1, 'Favorites', false), BiliResponseFormatError);
    assert.equal(pageCalls, 2);
    assert.equal(authUser.accessToken, 'new-access');
  } finally { state.close(); await removeTestDir(runtime); }
});

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
    listPage: async (_cookie, _mediaId, page = 1, pageSize = 20) => { pages.push(page); return { items: [item], page, pageSize, hasMore: true, total: 100 }; },
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
