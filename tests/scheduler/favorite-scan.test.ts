import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createFavoriteScan } from '../../src/scheduler/favorite-scan.js';
import { StateManager } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import { BiliResponseFormatError, BiliRiskOrLoginError, decodeFavoriteItemsPage, type FavoriteItemsPage } from '../../src/bili.js';
import { createTestDir, removeTestDir } from '../helpers.js';
import { availabilityJitter } from '../../src/scheduler/retry-policy.js';
import { createSyncWorkflow } from '../../src/scheduler/sync-workflow.js';
import type { SchedulerSnapshot } from '../../src/scheduler/sync-runtime.js';

const user: BiliUser = { id: 'scan-account', uid: 1, name: 'Fixture', enabled: true, favorites: [], lastLoginAt: '',
  cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };
const item = { bvid: 'BVSCAN', title: 'Fixture', upperName: 'Fixture', cover: 'https://example.test/cover.jpg' };

test('a contradictory later empty page preserves old relations and retries the folder on the next cycle', async t => {
  const root = await createTestDir('scan-empty-continuation');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const authUser = {...user, favorites: [{mediaId: 1, title: 'Favorites'}, {mediaId: 2, title: 'Independent'}]};
  const previous = {...item, bvid: 'BVPREVIOUS'};
  state.recordFavoriteItem(user.id, 1, 'Favorites', previous);
  let broken = true;
  const messages: string[] = [];
  const calls: Array<[number, number]> = [];
  t.mock.method(console, 'error', (message: string) => { messages.push(message); });
  const scan = createFavoriteScan({
    state, deletions: {folder: () => false, source: () => false}, users: {getById: () => authUser, updatePartial: () => authUser},
    now: () => 1_000, random: () => 0, sleep: async () => {}, generation: () => 0, canRun: () => true,
    listPage: async (_cookie, mediaId, page = 1, pageSize = 20) => {
      calls.push([mediaId, page]);
      if (mediaId === 2) return decodeFavoriteItemsPage({medias: [], has_more: false}, page, pageSize);
      if (page === 1) return decodeFavoriteItemsPage({medias: [{bvid: item.bvid, title: item.title}], has_more: true, info: {media_count: 40}}, page, pageSize);
      return decodeFavoriteItemsPage({medias: broken ? [] : [{bvid: previous.bvid}], has_more: broken, info: {media_count: 40}}, page, pageSize);
    },
    refreshAuth: async () => { throw new Error('unexpected auth refresh'); },
    resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {}, progress() {}, recordCount() {}, probe() {}, enqueue: () => false,
  });
  const workflow = createSyncWorkflow({users: () => [authUser], eligible: () => true, state, scan,
    progress() {}, scanPosition: () => ({mediaId: 1, page: 2}), enterUser() {}, leaveUser() {}, random: () => 0, sleep: async () => {}});
  try {
    await workflow.run(true, true);
    assert.equal(state.getRelationStatus(user.id, 1, previous.bvid)?.activeInFavorite, true);
    assert.ok(state.getVideoMeta(item.bvid));
    assert.equal(state.getFolderScan(user.id, 1, 'Favorites').initStatus, 'initializing');
    assert.equal(state.getFolderScan(user.id, 2, 'Independent').initStatus, 'complete');
    assert.equal(state.getUserCooldown(user.id), null);
    assert.ok(messages.some(message => message.includes('category=response_format') && message.includes('empty_continuation')));
    broken = false;
    await workflow.run(true, true);
    assert.equal(state.getFolderScan(user.id, 1, 'Favorites').initStatus, 'complete');
    assert.equal(state.getRelationStatus(user.id, 1, previous.bvid)?.activeInFavorite, true);
    assert.deepEqual(calls, [[1, 1], [1, 2], [2, 1], [1, 1], [1, 2], [2, 1]]);
  } finally { state.close(); await removeTestDir(root); }
});

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

for (const retryError of [
  new BiliResponseFormatError('favorite.medias'),
  Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
  new BiliRiskOrLoginError('new login rejection'),
]) {
  test(`auth refresh retry reports the actual ${retryError.name}: ${retryError.message}`, async () => {
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
        throw retryError;
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
      await assert.rejects(scan.hot(authUser, 1, 'Favorites', false), error => error === retryError);
      assert.equal(pageCalls, 2);
      assert.equal(authUser.accessToken, 'new-access');
    } finally { state.close(); await removeTestDir(runtime); }
  });
}

for (const failurePoint of ['persistence', 'missing-account', 'late-response', 'late-risk-response', 'late-network-response'] as const) {
  test(`refreshed auth ${failurePoint} cannot become an obsolete risk cooldown`, async (t) => {
    const runtime = await createTestDir('scan-auth-failure');
    const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
    const authUser: BiliUser = { ...user, id: 'auth-failure', cookie: { ...user.cookie }, favorites: [{ mediaId: 1, title: 'Favorites' }], accessToken: 'old-access', refreshToken: 'old-refresh' };
    let pageCalls = 0;
    let generation = 0;
    let position: { mediaId?: number; page?: number } = {};
    const messages: string[] = [];
    t.mock.method(console, 'error', (message: string) => { messages.push(message); });
    const scan = createFavoriteScan({
      state, deletions: { folder: () => false, source: () => false },
      users: {
        getById: () => authUser,
        updatePartial: (_id, patch) => {
          if (failurePoint === 'persistence') throw new Error('account persistence failed');
          if (failurePoint === 'missing-account') return null;
          return Object.assign(authUser, patch);
        },
      },
      now: () => 1_000, random: () => 0, sleep: async () => {}, generation: () => generation, canRun: () => true,
      listPage: async () => {
        pageCalls++;
        if (pageCalls === 1) throw new BiliRiskOrLoginError('old expired login');
        generation++;
        if (failurePoint === 'late-risk-response') throw new BiliRiskOrLoginError('late rejected login');
        if (failurePoint === 'late-network-response') throw Object.assign(new Error('late reset'), { code: 'ECONNRESET' });
        return { items: [item], page: 1, pageSize: 20, hasMore: false };
      },
      refreshAuth: async () => ({ rawAuth: '{}', cookie: { ...user.cookie }, accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expires: 2_000, uid: 1 }),
      resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {},
      progress: patch => { position = { ...position, ...patch }; }, recordCount() {}, probe() {}, enqueue: () => false,
    });
    const workflow = createSyncWorkflow({
      users: () => [authUser], eligible: () => true, state, scan, scanPosition: () => position,
      progress: patch => { position = { ...position, ...patch }; }, enterUser() {}, leaveUser() {}, random: () => 0, sleep: async () => {},
    });
    try {
      await workflow.run(false, false);
      assert.equal(state.getUserCooldown(authUser.id), null);
      assert.equal(state.getVideoMeta(item.bvid), null);
      assert.equal(pageCalls, failurePoint.startsWith('late-') ? 2 : 1);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /media_id=1 phase=hot page=1 category=other/);
      assert.doesNotMatch(messages[0], /old expired login/);
      assert.match(messages[0], failurePoint === 'persistence' ? /account persistence failed/ : failurePoint === 'missing-account' ? /Account no longer exists/ : /lifecycle change/);
    } finally { state.close(); await removeTestDir(runtime); }
  });
}

test('a retried network failure reports its page without cooling the refreshed account', async (t) => {
  const runtime = await createTestDir('scan-auth-network');
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
  const authUser: BiliUser = { ...user, id: 'auth-network', cookie: { ...user.cookie }, favorites: [{ mediaId: 1, title: 'Favorites' }], accessToken: 'old-access', refreshToken: 'old-refresh' };
  let pageCalls = 0;
  let position: { mediaId?: number; page?: number } = {};
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => { messages.push(message); });
  const scan = createFavoriteScan({
    state, deletions: { folder: () => false, source: () => false },
    users: { getById: () => authUser, updatePartial: (_id, patch) => Object.assign(authUser, patch) },
    now: () => 1_000, random: () => 0, sleep: async () => {}, generation: () => 0, canRun: () => true,
    listPage: async () => {
      pageCalls++;
      if (pageCalls === 1) throw new BiliRiskOrLoginError('expired login');
      throw Object.assign(new Error('read reset access_token=secret-value'), { code: 'ECONNRESET' });
    },
    refreshAuth: async () => ({ rawAuth: '{}', cookie: { ...user.cookie }, accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expires: 2_000, uid: 1 }),
    resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {},
    progress: patch => { position = { ...position, ...patch }; }, recordCount() {}, probe() {}, enqueue: () => false,
  });
  try {
    await createSyncWorkflow({
      users: () => [authUser], eligible: () => true, state, scan, scanPosition: () => position,
      progress: patch => { position = { ...position, ...patch }; }, enterUser() {}, leaveUser() {}, random: () => 0, sleep: async () => {},
    }).run(false, false);
    assert.equal(pageCalls, 2);
    assert.equal(authUser.accessToken, 'fresh-access');
    assert.equal(state.getUserCooldown(authUser.id), null);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /phase=hot page=1 category=network code=ECONNRESET/);
    assert.doesNotMatch(messages[0], /secret-value|expired login/);
  } finally { state.close(); await removeTestDir(runtime); }
});

test('each scan request publishes its current page and display identity before waiting', async () => {
  const runtime = await createTestDir('scan-request-progress');
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite') });
  const snapshots: Array<Partial<SchedulerSnapshot>> = [];
  let requests = 0;
  const scan = createFavoriteScan({
    state, deletions: { folder: () => false, source: () => false },
    users: { getById: () => user, updatePartial: () => user },
    now: () => 1_000, random: () => 0, sleep: async () => {}, generation: () => 0, canRun: () => true,
    listPage: async (_cookie, mediaId, page = 1, pageSize = 20) => {
      requests++;
      const current = snapshots.at(-1);
      assert.equal(current?.userName, user.name);
      assert.equal(current?.folderTitle, 'Favorites');
      assert.equal(current?.mediaId, mediaId);
      assert.equal(current?.page, page);
      assert.equal(current?.pageSize, pageSize);
      assert.match(current?.detail ?? '', new RegExp(`第 ${page} 页`));
      return { items: [], page, pageSize, hasMore: false, total: 0 };
    },
    refreshAuth: async () => { throw new Error('unexpected refresh'); },
    resolveSelfVisible: async (_cookie, _uid, value) => value, cacheCover() {},
    progress: patch => { snapshots.push(patch); }, recordCount() {}, probe() {}, enqueue: () => false,
  });
  try {
    await scan.all(user, 1, 'Favorites');
    await scan.hot(user, 1, 'Favorites', false);
    await scan.history(user, 1, 'Favorites', false);
    assert.equal(requests, 3);
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
