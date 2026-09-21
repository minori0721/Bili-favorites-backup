import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {StateManager} from '../src/state.js';
import {createTestDir, removeTestDir} from './helpers.js';

test('persisted JSON corruption is an error, never a missing video or empty archive', async () => {
  const directory = await createTestDir('corrupt-json');
  const state = new StateManager({statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite')});
  try {
    state.recordFavoriteItem('u', 1, 'folder', {bvid: 'BVCORRUPT', title: 'title', upperName: 'up'});
    const db = state.getDatabase();
    for (const payload of ['{broken', 'null', '[]', 'false', '1', '"text"']) {
      db.db.prepare('UPDATE videos SET payload_json=? WHERE bvid=?').run(payload, 'BVCORRUPT');
      assert.throws(() => db.loadState(), /Invalid persisted JSON/);
      assert.throws(() => db.getVideo('BVCORRUPT'), /Invalid persisted JSON/);
      assert.throws(() => db.listVideosByBvids(['BVCORRUPT']), /Invalid persisted JSON/);
      assert.throws(() => db.listVideos(), /Invalid persisted JSON/);
    }
  } finally { state.close(); await removeTestDir(directory); }
});

test('failure and cooldown repositories do not hide corrupted persisted records', async () => {
  const directory = await createTestDir('corrupt-recovery');
  const state = new StateManager({statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite')});
  try {
    const db = state.getDatabase();
    db.upsertFailure('u', {bvid: 'BVFAIL', mediaId: 1, failedAt: new Date().toISOString(), reason: 'failed', permanent: true});
    assert.equal(db.getFailure('u', 'BVFAIL', 1)?.permanent, true);
    assert.equal(db.getFailure('u', 'BVMISSING', 1), undefined);
    for (const payload of ['{broken', 'null', '[]', '{"bvid":"BVFAIL"}']) {
      db.db.prepare('UPDATE failures SET payload_json=?').run(payload);
      assert.throws(() => db.getFailure('u', 'BVFAIL', 1));
    }
    db.setCooldown('user', 'u', 100, 'test', {until: 100});
    db.db.prepare('UPDATE cooldowns SET payload_json=?').run('null');
    assert.throws(() => db.getCooldown('user', 'u'), /persisted recovery/);
    assert.throws(() => db.listCooldowns('user'), /persisted recovery/);
  } finally { state.close(); await removeTestDir(directory); }
});
