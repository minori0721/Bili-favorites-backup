import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { commitRetainedRecovery, commitVerifiedRecovery } from '../../src/scheduler/recovery-commit.js';
import { createTestDir, removeTestDir } from '../helpers.js';

for (const failure of ['proof', 'completion', 'none'] as const) {
  test(`retained recovery commits session, archive and job together: ${failure}`, async () => {
    const directory = await createTestDir('retained-recovery-atomic');
    const state = new StateManager({ statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite') });
    try {
      const bvid = 'BVRETAIN';
      state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
      const sessions = new TransferSessionStore(state.getDatabase());
      const jobs = new PersistentJobStore(state.getDatabase());
      const session = sessions.ensure({ dedupeKey: 'recover', bvid, localDir: directory, remotePath: '/backup' });
      const job = jobs.enqueue({ kind: 'upload', dedupeKey: 'recover', bvid, userId: 'u', mediaId: 1,
        initialStatus: 'manual_wait', payload: { awaitingManualRecovery: true, sessionId: session.id, sessionGeneration: session.generation } });
      const before = state.getStateSnapshot();
      const result = commitRetainedRecovery({ state, sessions, jobs: {
        findById: id => jobs.findById(id), complete: id => failure === 'completion' ? false : jobs.complete(id),
      } }, job.id, { status: 'verified', remotePath: '/backup', verifiedAt: new Date().toISOString(),
        files: failure === 'proof' ? [] : [{ name: 'v.mp4', path: '/backup/v.mp4', size: 12, verificationStatus: 'verified' }] });
      if (failure === 'none') {
        assert.ok(result);
        assert.equal(sessions.get(session.id)?.phase, 'superseded');
        assert.equal(jobs.findById(job.id), null);
        assert.equal(state.listRelationsForBvid(bvid)[0].backupStatus, 'verified');
      } else {
        assert.equal(result, null);
        assert.equal(sessions.get(session.id)?.phase, session.phase);
        assert.equal(jobs.findById(job.id)?.status, 'manual_wait');
        assert.deepEqual(state.getStateSnapshot(), before);
      }
    } finally { state.close(); await removeTestDir(directory); }
  });
}

test('verified recovery rejects changed persisted evidence and rolls back a failed completion', async () => {
  const directory = await createTestDir('verified-recovery-atomic');
  const state = new StateManager({ statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite') });
  try {
    const bvid = 'BVRECOVER';
    state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
    const sessions = new TransferSessionStore(state.getDatabase());
    const jobs = new PersistentJobStore(state.getDatabase());
    const session = sessions.ensure({ dedupeKey: 'recover', bvid, localDir: directory, remotePath: '/backup' });
    sessions.ensureFile(session.id, { relativePath: 'v.mp4', name: 'v.mp4', expectedSize: 12 }, session.generation);
    sessions.updateFile(session.id, 'v.mp4', { putAcceptedAt: 100 }, session.generation);
    const files = sessions.listFiles(session.id, session.generation);
    const job = jobs.enqueue({ kind: 'upload', dedupeKey: 'recover', bvid, userId: 'u', mediaId: 1,
      initialStatus: 'manual_wait', payload: { awaitingManualRecovery: true, sessionId: session.id, sessionGeneration: session.generation } });
    const command = { job, session, files, expectedGeneration: session.generation, now: 200, cleanupPlan: null,
      verifiedFiles: [{ name: 'v.mp4', path: files[0].finalPath, size: 12, verificationStatus: 'verified' as const }] };
    sessions.updateFile(session.id, 'v.mp4', { putAcceptedAt: 101 }, session.generation);
    assert.throws(() => commitVerifiedRecovery({ state, sessions, jobs }, command), /evidence changed/);
    sessions.updateFile(session.id, 'v.mp4', { putAcceptedAt: 100 }, session.generation);
    const before = state.getStateSnapshot();
    assert.throws(() => commitVerifiedRecovery({ state, sessions, jobs: { findById: id => jobs.findById(id), complete: () => false } }, command), /completion/);
    assert.equal(sessions.get(session.id)?.phase, session.phase);
    assert.equal(sessions.listFiles(session.id)[0].verifiedAt, undefined);
    assert.deepEqual(state.getStateSnapshot(), before);
    commitVerifiedRecovery({ state, sessions, jobs }, command);
    assert.equal(sessions.get(session.id)?.phase, 'completed');
    assert.equal(jobs.findById(job.id), null);
    assert.equal(state.listRelationsForBvid(bvid)[0].backupStatus, 'verified');
  } finally { state.close(); await removeTestDir(directory); }
});
