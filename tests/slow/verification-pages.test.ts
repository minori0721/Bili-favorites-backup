import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { createStartupRecovery } from '../../src/scheduler/startup-recovery.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import { remoteFileFixture as fixture } from '../fixtures/remote-file-state.js';

test('startup recovery traverses all verification pages and preserves delayed execution', async () => {
  const directory = await createTestDir('verification-pages');
  const manager = new StateManager({ statePath: path.join(directory, 'state.json'), dbPath: ':memory:' });
  try {
    const state = fixture(10_001);
    const future = '2030-01-01T00:00:00.000Z';
    for (const video of Object.values(state.videos!)) {
      video.backupStatus = 'uploaded';
      video.remoteFiles![0].verificationStatus = 'awaiting_verification';
      video.remoteFiles![0].nextVerifyAt = future;
    }
    for (const source of Object.values(state.relations!)) {
      source.backupStatus = 'uploaded';
      source.remoteFiles = structuredClone(state.videos![source.bvid].remoteFiles!);
    }
    manager.getDatabase().replaceState(state);
    manager.reload();
    const jobs = new PersistentJobStore(manager.getDatabase());
    const unexpected = () => assert.fail('unexpected transfer during bootstrap');
    const recovery = createStartupRecovery({ stateManager: manager, jobStore: jobs,
      transferSessions: new TransferSessionStore(manager.getDatabase()), configStore: { get: () => testConfig() },
      staleActiveBackupMs: 1000, resolveRelation: () => null, findBestRelationForBvid: () => null,
      resolveRelationRemotePath: unexpected, enqueueIfNeeded: unexpected, queueUploadWork: unexpected,
      buildPersistentUploadJob: unexpected, historySnapshotSegment: unexpected,
      ensurePersistedAvailabilityProbes: () => {}, ensurePersistedChargingAccessProbes: () => {},
      dispatchPersistentJobs: unexpected, recordQueued: unexpected });
    recovery.resumePersistedWork();
    assert.equal(manager.hasPersistentJobBootstrap(), true);
    assert.deepEqual(manager.getDatabase().db.prepare("SELECT count(*) count,min(not_before) earliest,max(not_before) latest FROM jobs WHERE kind='verify_upload'").get(),
      { count: 10_001, earliest: Date.parse(future), latest: Date.parse(future) });
    recovery.resumePersistedWork();
    assert.deepEqual(manager.getDatabase().db.prepare<unknown[], { "count": number }>('SELECT count(*) count FROM jobs').get(), { count: 10_001 });
  } finally { manager.close(); await removeTestDir(directory); }
});
