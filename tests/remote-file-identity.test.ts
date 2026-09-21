import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateDatabase, type StateDirtySet } from '../src/database.js';
import { getPlaybackQueue, resolvePlaybackFile } from '../src/playback.js';
import type { StateFile, RemoteFileRecord } from '../src/state.js';
import { StateManager } from '../src/state.js';
import { PersistentJobStore } from '../src/job-store.js';
import { TransferSessionStore } from '../src/transfer-session.js';
import { createStartupRecovery } from '../src/scheduler/startup-recovery.js';
import { createTestDir, removeTestDir, testConfig } from './helpers.js';

const at = '2026-09-18T00:00:00.000Z';
function fixture(count = 1): StateFile {
  const state: StateFile = { schemaVersion: 13, processedByUser: {}, failedByUser: {},
    userCooldowns: {}, folderScans: {}, videos: {}, relations: {} };
  for (let n = 0; n < count; n++) {
    const bvid = `BVFIXTURE${String(n).padStart(5, '0')}`;
    const file: RemoteFileRecord = { name: 'part.mp4', path: `/archive/${bvid}/part.mp4`, size: 42,
      verificationStatus: 'verified' as const, putCompletedAt: at };
    state.videos![bvid] = { bvid, title: 'Fixture', upperName: 'Fixture', firstSeenAt: at, lastSeenAt: at,
      backupStatus: 'verified' as const, biliStatus: 'available' as const, remotePath: `/archive/${bvid}`, remoteFiles: [file] };
    state.relations![`u:1:${bvid}`] = { userId: 'u', mediaId: 1, bvid, folderTitle: 'Fixture',
      firstSeenAt: at, lastSeenAt: at, activeInFavorite: true, backupStatus: 'verified' as const,
      remotePath: `/archive/${bvid}`, remoteFiles: [structuredClone(file)] };
  }
  return state;
}
const dirty = (bvid: string): StateDirtySet => ({ videos: new Set([bvid]), relations: new Set([`u:1:${bvid}`]),
  folderScans: new Set(), failures: false, cooldowns: false, metadata: false });
function queue(db: StateDatabase, mediaId = 1) {
  const result = getPlaybackQueue(db, 'u', mediaId, {});
  assert.ok(result);
  return result;
}
const first = (db: StateDatabase) => queue(db).items[0].parts[0];

test('database replacement cannot reuse a previous page fingerprint for a colliding file ID', () => {
  const oldDb = new StateDatabase(':memory:');
  const newDb = new StateDatabase(':memory:');
  try {
    const oldState = fixture();
    const newState = fixture();
    const bvid = Object.keys(newState.videos!)[0];
    const source = newState.relations![`u:1:${bvid}`];
    source.remoteFiles![0].path = `/archive/${bvid}/replacement.mp4`;
    oldDb.replaceState(oldState);
    newDb.replaceState(newState);
    const oldPart = first(oldDb), newPart = first(newDb);
    assert.equal(newPart.fileId, oldPart.fileId);
    assert.notEqual(newPart.fingerprint, oldPart.fingerprint);
    assert.ok(!newPart.fingerprint.includes('/archive'));
    assert.equal(newDb.updateBrowserMediaMetadata('u', 1, newPart.fileId,
      { fingerprint: oldPart.fingerprint, width: 1920, height: 1080 }), null);
  } finally { oldDb.close(); newDb.close(); }
});

test('bookkeeping preserves existing playback IDs, progress fingerprints and metadata reports', () => {
  const db = new StateDatabase(':memory:');
  try {
    const state = fixture();
    db.replaceState(state);
    const bvid = Object.keys(state.videos!)[0];
    const before = first(db);
    for (let n = 1; n <= 3; n++) {
      state.relations![`u:1:${bvid}`].lastRemoteCheckAt = `2026-09-18T0${n}:00:00.000Z`;
      state.relations![`u:1:${bvid}`].remoteFiles![0].verifyAttempts = n;
      db.flushState(state, dirty(bvid));
      assert.equal(first(db).fileId, before.fileId);
      assert.equal(first(db).fingerprint, before.fingerprint);
      assert.equal(resolvePlaybackFile(db, 'u', 1, before.fileId).size, 42);
    }
    assert.equal(db.updateBrowserMediaMetadata('u', 1, before.fileId,
      { fingerprint: before.fingerprint, width: 1920, height: 1080, duration: 10 })?.status, 'updated');
    assert.equal(first(db).fingerprint, before.fingerprint);
    assert.deepEqual(db.db.prepare('SELECT count(*) records,count(DISTINCT remote_path) paths FROM remote_files').get(),
      { records: 2, paths: 1 });
  } finally { db.close(); }
});

for (const replacement of ['same-size-upload', 'changed-size', 'removed-and-restored'] as const) {
  test(`${replacement} invalidates the previous file incarnation and late browser metadata`, () => {
    const db = new StateDatabase(':memory:');
    try {
      const state = fixture();
      db.replaceState(state);
      const bvid = Object.keys(state.videos!)[0];
      const before = first(db);
      const source = state.relations![`u:1:${bvid}`];
      const previousFiles = structuredClone(source.remoteFiles!);
      if (replacement === 'same-size-upload') source.remoteFiles![0].putCompletedAt = '2026-09-18T01:00:00.000Z';
      if (replacement === 'changed-size') source.remoteFiles![0].size = 84;
      if (replacement === 'removed-and-restored') {
        source.remoteFiles = [];
        db.flushState(state, dirty(bvid));
        source.remoteFiles = previousFiles;
      }
      db.flushState(state, dirty(bvid));
      const after = first(db);
      assert.notEqual(after.fileId, before.fileId);
      assert.notEqual(after.fingerprint, before.fingerprint);
      assert.throws(() => resolvePlaybackFile(db, 'u', 1, before.fileId), { code: 'PLAYBACK_FILE_NOT_FOUND' });
      assert.equal(db.updateBrowserMediaMetadata('u', 1, before.fileId,
        { fingerprint: before.fingerprint, width: 1920, height: 1080 }), null);
      assert.equal(db.updateBrowserMediaMetadata('u', 1, after.fileId,
        { fingerprint: before.fingerprint, width: 1920, height: 1080 }), null);
    } finally { db.close(); }
  });
}

test('missing historical upload time is stable, while a new explicit upload replaces it', () => {
  const db = new StateDatabase(':memory:');
  try {
    const state = fixture();
    const bvid = Object.keys(state.videos!)[0];
    const file = state.relations![`u:1:${bvid}`].remoteFiles![0];
    delete file.putCompletedAt;
    db.replaceState(state);
    const before = first(db);
    db.flushState(state, dirty(bvid));
    assert.equal(first(db).fingerprint, before.fingerprint);
    file.putCompletedAt = at;
    db.flushState(state, dirty(bvid));
    const uploaded = first(db);
    assert.notEqual(uploaded.fileId, before.fileId);
    delete file.putCompletedAt;
    db.flushState(state, dirty(bvid));
    assert.equal(first(db).fingerprint, uploaded.fingerprint);
    file.putCompletedAt = at;
    db.flushState(state, dirty(bvid));
    assert.equal(first(db).fingerprint, uploaded.fingerprint);
  } finally { db.close(); }
});

test('source removal preserves shared references; duplicate input rolls back the whole save', () => {
  const db = new StateDatabase(':memory:');
  try {
    const state = fixture();
    const bvid = Object.keys(state.videos!)[0];
    const source = state.relations![`u:1:${bvid}`];
    state.relations![`u:2:${bvid}`] = { ...structuredClone(source), mediaId: 2 };
    db.replaceState(state);
    const originalRows = db.db.prepare<unknown[], { "id": number; "bvid": string; "user_id": string; "media_id": number; "kind": string; "local_relative_path": string | null; "name": string; "remote_path": string; "expected_size": number | null; "status": string; "quality_json": string | null; "actual_width": number | null; "actual_height": number | null; "actual_fps": number | null; "actual_duration": number | null; "actual_codec": string | null; "actual_metadata_source": string | null; "actual_metadata_at": number | null; "put_completed_at": number | null; "verify_attempts": number; "next_verify_at": number | null; "last_error": string | null; "updated_at": number }>('SELECT * FROM remote_files ORDER BY id').all();
    source.remoteFiles!.push(structuredClone(source.remoteFiles![0]));
    assert.throws(() => db.flushState(state, dirty(bvid)), /Duplicate remote file/);
    assert.deepEqual(db.db.prepare<unknown[], { "id": number; "bvid": string; "user_id": string; "media_id": number; "kind": string; "local_relative_path": string | null; "name": string; "remote_path": string; "expected_size": number | null; "status": string; "quality_json": string | null; "actual_width": number | null; "actual_height": number | null; "actual_fps": number | null; "actual_duration": number | null; "actual_codec": string | null; "actual_metadata_source": string | null; "actual_metadata_at": number | null; "put_completed_at": number | null; "verify_attempts": number; "next_verify_at": number | null; "last_error": string | null; "updated_at": number }>('SELECT * FROM remote_files ORDER BY id').all(), originalRows);
    const shared = queue(db, 2).items[0].parts[0];
    source.remoteFiles = [];
    db.flushState(state, dirty(bvid));
    assert.equal(queue(db).items.length, 0);
    assert.equal(queue(db, 2).items[0].parts[0].fileId, shared.fileId);
    assert.equal(resolvePlaybackFile(db, 'u', 2, shared.fileId).size, 42);
  } finally { db.close(); }
});

test('pending verification limits and pages count real uploaded sources, not global copies', () => {
  const db = new StateDatabase(':memory:');
  try {
    const state = fixture(5);
    for (const video of Object.values(state.videos!)) {
      video.backupStatus = 'uploaded';
      video.remoteFiles![0].verificationStatus = 'awaiting_verification';
      video.remoteFiles![0].nextVerifyAt = '2030-01-01T00:00:00Z';
    }
    for (const source of Object.values(state.relations!)) {
      source.backupStatus = 'uploaded';
      source.remoteFiles = structuredClone(state.videos![source.bvid].remoteFiles!);
    }
    const keys = Object.keys(state.relations!);
    delete state.relations![keys[0]]; // orphaned global proof must not occupy the first slot
    state.relations![keys[1]].backupStatus = 'upload_failed';
    db.replaceState(state);
    const expected = Object.values(state.relations!).filter(r => r.backupStatus === 'uploaded').map(r => r.bvid);
    const pages = expected.map((_, offset) => db.listPendingUploadVerifications(1, offset));
    assert.deepEqual(pages.flatMap(page => page.map(item => item.relation.bvid)), expected);
    assert.equal(db.listPendingUploadVerifications(1, expected.length).length, 0);
    assert.equal(pages[0][0].relation.remoteFiles![0].nextVerifyAt, '2030-01-01T00:00:00Z');
    assert.deepEqual(db.listPendingUploadVerifications(20).map(item => item.relation.bvid), expected);
  } finally { db.close(); }
});

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
