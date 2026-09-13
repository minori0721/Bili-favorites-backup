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
    state.flush();
    const db = state.getDatabase();
    for (const payload of ['{broken', 'null', '[]', 'false', '1', '"text"']) {
      db.db.prepare('UPDATE videos SET payload_json=? WHERE bvid=?').run(payload, 'BVCORRUPT');
      assert.throws(() => db.loadState(), /Invalid persisted JSON/);
    }
  } finally { state.close(); await removeTestDir(directory); }
});
