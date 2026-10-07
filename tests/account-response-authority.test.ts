import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountService } from '../src/account-service.js';
import { createFavoriteBrowsing } from '../src/favorite-browsing-service.js';
import { AccountOperationCancelled, type BiliUser } from '../src/users.js';
import type { FavoriteFolderInfo } from '../src/bili.js';
import { memoryUsers } from './fixtures/memory-users.js';

const user = (): BiliUser => ({id: '1', uid: 1, name: 'Current', favorites: [{mediaId: 10, title: 'Old'}],
  cookie: {SESSDATA: 'fixture', bili_jct: 'fixture', DedeUserID: '1'}, enabled: true, lastLoginAt: ''});
const folders: FavoriteFolderInfo[] = [{mediaId: 20, title: 'New', mediaCount: 1}];

for (const failure of [false, true]) {
  for (const change of ['login', 'readd'] as const) {
    test(`profile ${failure ? 'failure' : 'success'} after ${change} cannot affect the current account`, async () => {
      const users = memoryUsers([user()]);
      let complete!: () => void;
      const held = new Promise<void>(done => {complete = done;});
      const service = createAccountService({users, info: async () => {await held;
        if (failure) throw new Error('old profile failure'); return {uid: 1, name: 'Obsolete'};},
        refresh: async () => {}, cookieExportEnabled: false, log() {}, wake() {}, now: () => 0});
      const request = service.refreshInfo('1');
      if (change === 'readd') users.remove('1');
      users.upsert({...user(), name: 'New login'});
      complete();
      await assert.rejects(request, AccountOperationCancelled);
      assert.equal(users.getById('1')?.name, 'New login');
    });
  }
}

for (const change of ['removal', 'readd', 'login', 'selection', 'old-failure'] as const) {
  test(`favorite selection after ${change} cannot publish obsolete folders or cache entries`, async () => {
    const users = memoryUsers([user()]);
    let complete!: () => void;
    const held = new Promise<void>(done => {complete = done;});
    let cached = 0;
    const service = createFavoriteBrowsing({users, folders: {get: async () => [], peek: () => undefined, set() {cached++;}},
      load: async () => {await held; if (change === 'old-failure') throw new Error('obsolete external failure'); return folders;},
      covers: {resolve: async () => null}});
    const request = service.select('1', [20]);
    let release: (() => void) | undefined;
    if (change === 'removal') release = users.beginAccountRemoval('1');
    if (change === 'readd') {users.remove('1'); users.upsert(user());}
    if (change === 'login') users.upsert({...user(), name: 'New login'});
    if (change === 'selection' || change === 'old-failure') users.updateFavorites('1', [{mediaId: 30, title: 'More recent choice'}]);
    const before = structuredClone(users.getById('1'));
    complete();
    try {
      await assert.rejects(request, AccountOperationCancelled);
      assert.deepEqual(users.getById('1'), before);
      assert.equal(cached, 0);
    } finally {release?.();}
  });
}

test('current profile and favorite responses keep their public success contracts', async () => {
  const users = memoryUsers([user()]);
  const account = createAccountService({users, info: async () => ({uid: 1, name: 'Updated'}),
    refresh: async () => {}, cookieExportEnabled: false, log() {}, wake() {}, now: () => 0});
  assert.equal((await account.refreshInfo('1')).status, 200);
  assert.equal(users.getById('1')?.name, 'Updated');
  let cachedUser: BiliUser | undefined;
  const favorites = createFavoriteBrowsing({users,
    folders: {get: async () => [], peek: () => undefined, set(account) {cachedUser = account;}},
    load: async () => folders, covers: {resolve: async () => null}});
  assert.equal((await favorites.select('1', [20])).status, 200);
  assert.deepEqual(users.getById('1')?.favorites, [{mediaId: 20, title: 'New'}]);
  assert.equal(cachedUser, users.getById('1'));
});
