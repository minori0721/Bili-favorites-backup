import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchiveTargets } from '../../src/scheduler/archive-targets.js';
import { MANUAL_ARCHIVE_MEDIA_ID, type FavoriteRelation } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import { testConfig } from '../helpers.js';

const user: BiliUser = {
  id: 'u', uid: 1, name: 'Owner', enabled: true, lastLoginAt: '',
  cookie: {SESSDATA: '', bili_jct: '', DedeUserID: '1'},
  favorites: [{mediaId: 1, title: 'Current title'}],
};
const relation: FavoriteRelation = {
  userId: 'u', mediaId: 1, bvid: 'BVTEST', folderTitle: 'Historical title',
  firstSeenAt: '', lastSeenAt: '', activeInFavorite: true, backupStatus: 'failed' as const,
  remotePath: '/existing',
};

test('archive target resolution retains existing paths and current source titles', () => {
  let blocked = false;
  let enabled = true;
  const targets = createArchiveTargets({
    config: {get: () => testConfig()}, state: {listRelationsForBvid: () => [relation]},
    users: {getById: () => user},
    eligible: (value): value is BiliUser => enabled && value?.enabled === true,
    sourceBlocked: () => blocked,
  });
  assert.deepEqual(targets.collectUploadTargets('BVTEST'), [{userId: 'u', mediaId: 1, folderTitle: 'Current title', remotePath: '/existing'}]);
  assert.equal(targets.findBestRelationForBvid('BVTEST')?.folderTitle, 'Current title');
  blocked = true;
  assert.deepEqual(targets.collectUploadTargets('BVTEST', [{userId: 'u', mediaId: 1, folderTitle: 'Fallback', remotePath: '/fallback'}]), []);
  enabled = false;
  assert.equal(targets.resolveRelation(relation), null);
  assert.equal(targets.findBestRelationForBvid('BVTEST'), null);
});

test('verified sources do not add upload work and manual paths retain their reserved identity', () => {
  const targets = createArchiveTargets({
    config: {get: () => testConfig()},
    state: {listRelationsForBvid: () => [{...relation, backupStatus: 'verified' as const}]},
    users: {getById: () => user}, eligible: (value): value is BiliUser => value?.enabled === true,
    sourceBlocked: () => false,
  });
  assert.deepEqual(targets.collectUploadTargets('BVTEST'), []);
  assert.match(targets.resolveRelationRemotePath(user, MANUAL_ARCHIVE_MEDIA_ID, 'Manual'), /__BFB_MANUAL_1/);
});
