import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test('transfer recovery rejects corrupt session and file rows instead of fabricating missing work', async () => {
  const root = await createTestDir('transfer-corruption');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const transfers = new TransferSessionStore(state.getDatabase());
  try {
    const session = transfers.ensure({dedupeKey: 'transfer-corrupt', bvid: 'BVCORRUPT', localDir: '/local', remotePath: '/remote'});
    transfers.ensureFile(session.id, {relativePath: 'video.mp4', name: 'video.mp4', expectedSize: 10});
    const db = state.getDatabase().db;
    for (const [column, values] of [['phase', ['nonsense']], ['generation', [-1, 'bad']], ['history_only', [2]]] as const) {
      for (const value of values) {
        db.prepare(`UPDATE transfer_sessions SET ${column}=? WHERE id=?`).run(value, session.id);
        assert.throws(() => transfers.get(session.id), /Invalid persisted transfer/);
        db.prepare(`UPDATE transfer_sessions SET ${column}=? WHERE id=?`).run(column === 'phase' ? 'uploading' : column === 'generation' ? 1 : 0, session.id);
      }
    }
    db.prepare("UPDATE transfer_session_files SET status=? WHERE session_id=?").run('corrupt', session.id);
    assert.throws(() => transfers.getFile(session.id, 'video.mp4'), /Invalid persisted transfer/);
    db.prepare("UPDATE transfer_session_files SET status=? WHERE session_id=?").run('pending', session.id);
    db.prepare("UPDATE transfer_session_files SET expected_size=? WHERE session_id=?").run(-1, session.id);
    assert.throws(() => transfers.listFiles(session.id), /Invalid persisted transfer/);
    db.prepare("UPDATE transfer_session_files SET expected_size=? WHERE session_id=?").run(10, session.id);

  } finally { state.close(); await removeTestDir(root); }
});
