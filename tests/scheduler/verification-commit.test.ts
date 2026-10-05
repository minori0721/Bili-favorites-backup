import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { UploadVerificationTask } from '../../src/tasks.js';
import { UploadCircuitBreaker } from '../../src/upload-health.js';
import { createVerificationHandlers } from '../../src/scheduler/verification-handlers.js';
import { createVerifiedTransferCommit } from '../../src/scheduler/verified-transfer-commit.js';
import { createStartupRecovery } from '../../src/scheduler/startup-recovery.js';
import { createUploadAdmission } from '../../src/scheduler/upload-admission.js';
import { readDownloadSession, writeDownloadSession, type DownloadSessionManifest } from '../../src/download-session.js';
import { verificationState } from '../fixtures/verification-state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

const owner = 'verification-contract', bvid = 'BVVERIFY', remoteFile = '/target/video.mp4';
const snapshotAt = '2026-09-07T00:00:00.000Z';
const unexpected = () => assert.fail('unexpected workflow');

async function fixture(acceptRecovery = true) {
  const root = await createTestDir('verification-commit');
  const statePath = path.join(root, 'state.json'), dbPath = path.join(root, 'state.sqlite');
  const state = new StateManager({ statePath, dbPath });
  state.replaceStateSnapshot(verificationState(root));
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const jobs = new PersistentJobStore(state.getDatabase(), { now }), sessions = new TransferSessionStore(state.getDatabase());
  const cleanup: string[] = [];
  const handlers = createVerificationHandlers({ stateManager: state, jobStore: jobs, transferSessions: sessions,
    leaseOwner: owner, now, uploadCircuit: new UploadCircuitBreaker(),
    localCleanup: { request: id => { cleanup.push(id); } }, isEncodingRetryParentActive: unexpected,
    dispatchPersistentJobs: () => {}, schedulePersistentJobWake: () => {}, scheduleUploadProbe: () => {},
    afterEncodingRetryCommitted: unexpected, finishEncodingRetryFailure: unexpected,
    queueUploadWork: createUploadAdmission({ jobs, blocked: () => !acceptRecovery, wake: () => {},
      build: item => ({ kind: item.historyOnly ? 'history_upload' : 'upload', bvid: item.bvid,
        userId: item.userId, mediaId: item.mediaId, initialStatus: 'manual_wait', payload: { ...item },
        dedupeKey: `upload:${item.userId}:${item.mediaId}:${item.bvid}:${item.remotePath}:${item.historySnapshotAt || 'main'}` }) }),
    commitVerifiedTransfer: createVerifiedTransferCommit({ state, jobs, sessions, leaseOwner: owner,
      now, buildCleanupPlan: () => null }),
  });
  function task(payload: Record<string, unknown> = {}, dedupeKey = 'verify:contract') {
    jobs.enqueue({ kind: 'verify_upload', dedupeKey, bvid, userId: 'u1', mediaId: 1,
      payload: { remoteFile, expectedSize: 12, localDir: root, remotePath: '/target', ...payload } });
    const job = jobs.claimByDedupeKey(dedupeKey, owner, 300_000);
    assert.ok(job);
    const result = new UploadVerificationTask(bvid, 'u1', 1, remoteFile, 12, testConfig());
    result.persistentJobId = job.id; result.persistentJob = job;
    result.result = { status: 'verified', remoteSize: 12 };
    return result;
  }
  function rejectArchiveWrite(status: string) {
    for (const operation of ['INSERT', 'UPDATE']) state.getDatabase().db.exec(`
      CREATE TRIGGER contract_${operation} BEFORE ${operation} ON favorite_relations
      WHEN NEW.backup_status='${status}' BEGIN SELECT RAISE(ABORT, 'injected archive write failure'); END`);
  }
  function restoreWrites() {
    state.getDatabase().db.exec('DROP TRIGGER IF EXISTS contract_INSERT; DROP TRIGGER IF EXISTS contract_UPDATE;');
  }
  return { root, statePath, dbPath, state, jobs, sessions, cleanup, handlers, task, rejectArchiveWrite, restoreWrites,
    advance: (ms: number) => { clockOffset += ms; },
    close: async () => { restoreWrites(); state.close(); await removeTestDir(root); } };
}

for (const outcome of ['verified', 'mismatch'] as const) {
  test(`legacy ${outcome} rolls back archive, memory and job together on SQLite failure`, async () => {
    const f = await fixture();
    try {
      const task = f.task();
      task.result = outcome === 'verified' ? { status: 'verified', remoteSize: 12 } : { status: 'mismatch', remoteSize: 13 };
      f.rejectArchiveWrite(outcome === 'verified' ? 'verified' : 'upload_failed');
      assert.throws(() => f.handlers.completed(task), /injected archive write failure/);
      assert.equal(f.jobs.findById(task.persistentJobId!)?.status, 'running');
      assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'uploaded');
      assert.equal(f.state.getDatabase().getRelation('u1:1:' + bvid)?.backupStatus, 'uploaded');
      assert.deepEqual(f.cleanup, []);
      f.restoreWrites(); f.handlers.completed(task);
      assert.equal(f.jobs.findById(task.persistentJobId!), null);
      assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, outcome === 'verified' ? 'verified' : 'upload_failed');
      assert.equal(f.cleanup.length, outcome === 'verified' ? 1 : 0);
      f.handlers.completed(task);
      assert.equal(f.cleanup.length, outcome === 'verified' ? 1 : 0);
    } finally { await f.close(); }
  });
}

for (const nextOwner of [owner, 'replacement-owner']) {
  test(`late verification cannot update a replacement execution owned by ${nextOwner}`, async () => {
    const f = await fixture();
    try {
      const task = f.task();
      f.jobs.retry(task.persistentJobId!, owner, 'retry', Date.now());
      const next = f.jobs.claimByDedupeKey('verify:contract', nextOwner);
      assert.ok(next);
      f.handlers.completed(task);
      f.handlers.failed(task, new Error('late network failure'));
      assert.equal(f.jobs.findById(next.id)?.leaseOwner, nextOwner);
      assert.equal(f.jobs.findById(next.id)?.attempts, next.attempts);
      assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'uploaded');
      assert.deepEqual(f.cleanup, []);
    } finally { await f.close(); }
  });
}

function historyManifest(): DownloadSessionManifest {
  return { schemaVersion: 1, sessionId: 'history-contract', kind: 'backup', bvid, accountUid: 1,
    bbdownCommit: 'test', configFingerprint: 'test',
    configSnapshot: { quality: '', encoding: '', hiRes: false, dolby: false, filenameTemplate: '<bvid>' },
    createdAt: snapshotAt, updatedAt: snapshotAt, snapshotAt, status: 'complete',
    pages: [{ index: 1, cid: 1, title: 'P1', duration: 1 }], outputs: [],
    history: [{ pageIndex: 1, cid: 1, relativePath: 'old.mp4', size: 12, duration: 1,
      videoCodec: 'avc1', quickHash: 'test', verifiedAt: snapshotAt, snapshotAt, reason: 'removed' }] };
}

for (const sessionBased of [false, true]) {
  test(`${sessionBased ? 'session' : 'legacy'} history retains finalizer after damaged manifest and resumes without another upload`, async () => {
    const f = await fixture();
    try {
      const session = sessionBased ? f.sessions.ensure({ dedupeKey: 'history-session', bvid, userId: 'u1', mediaId: 1,
        localDir: f.root, remotePath: '/target', historyOnly: true, historySnapshotAt: snapshotAt }) : null;
      const task = f.task({ historyOnly: true, historySnapshotAt: snapshotAt,
        ...(session ? { sessionId: session.id, sessionGeneration: session.generation, sessionVerification: true } : {}) },
        `verify:u1:1:${bvid}:history:${snapshotAt}:file`);
      if (session) {
        const file = f.sessions.ensureFile(session.id, { relativePath: 'old.mp4', name: 'old.mp4', expectedSize: 12 }, session.generation);
        assert.ok(file);
        f.sessions.updateFile(session.id, 'old.mp4', { status: 'verified' }, session.generation);
        task.transferResult = { remotePath: '/target', allVerified: true, sessionId: session.id, sessionGeneration: session.generation,
          files: [{ name: 'old.mp4', path: file.finalPath, size: 12, verificationStatus: 'verified' }] };
      }
      await fs.writeFile(path.join(f.root, '.bfb-download.json'), '{broken json');
      assert.throws(() => f.handlers.completed(task), /download|清单/i);
      assert.equal(f.jobs.findById(task.persistentJobId!)?.status, 'running');
      assert.deepEqual(f.cleanup, []);
      assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'uploaded');
      writeDownloadSession(f.root, historyManifest());
      f.handlers.completed(task);
      const manifest = readDownloadSession(f.root);
      assert.equal(manifest.kind, 'valid');
      if (manifest.kind !== 'valid') assert.fail('history manifest must be readable');
      assert.deepEqual(manifest.manifest.history[0].uploadedTargets, ['u1:1']);
      assert.equal(f.jobs.findById(task.persistentJobId!), null);
      assert.deepEqual(f.cleanup, [bvid]);
      f.handlers.completed(task);
      assert.deepEqual(f.cleanup, [bvid]);
    } finally { await f.close(); }
  });
}

test('one conflicting historical file prevents another verifier from marking the group uploaded', async () => {
  const f = await fixture();
  try {
    writeDownloadSession(f.root, historyManifest());
    const prefix = `verify:u1:1:${bvid}:history:${snapshotAt}:`;
    const bad = f.task({ historyOnly: true, historySnapshotAt: snapshotAt }, prefix + 'bad');
    bad.result = { status: 'mismatch', remoteSize: 13 };
    f.handlers.completed(bad);
    assert.equal(f.jobs.findById(bad.persistentJobId!), null);
    assert.equal(f.jobs.listManualRecovery(['history_upload']).length, 1);
    const good = f.task({ historyOnly: true, historySnapshotAt: snapshotAt }, prefix + 'good');
    f.handlers.completed(good);
    const result = readDownloadSession(f.root);
    assert.equal(result.kind, 'valid');
    if (result.kind !== 'valid') assert.fail('manifest must remain readable');
    assert.equal(result.manifest.history[0].uploadedTargets, undefined);
    assert.deepEqual(f.cleanup, []);
  } finally { await f.close(); }
});

test('expired verification execution cannot commit until the task is reclaimed', async () => {
  const f = await fixture();
  try {
    const task = f.task(); f.advance(300_001);
    f.handlers.completed(task);
    f.handlers.failed(task, new Error('late failure'));
    assert.equal(f.jobs.findById(task.persistentJobId!)?.status, 'running');
    assert.equal(f.state.getRelationStatus('u1', 1, bvid)?.backupStatus, 'uploaded');
    assert.deepEqual(f.cleanup, []);
  } finally { await f.close(); }
});

test('failed recovery handoff retains the verifier instead of losing the recovery entry', async () => {
  const f = await fixture(false);
  try {
    const task = f.task({ historyOnly: true, historySnapshotAt: snapshotAt });
    task.result = { status: 'mismatch', remoteSize: 13 };
    assert.throws(() => f.handlers.completed(task), /recovery task was not accepted/);
    assert.equal(f.jobs.findById(task.persistentJobId!)?.status, 'running');
    assert.deepEqual(f.cleanup, []);
  } finally { await f.close(); }
});

function startup(state: StateManager, jobs: PersistentJobStore) {
  return createStartupRecovery({ stateManager: state, jobStore: jobs,
    transferSessions: new TransferSessionStore(state.getDatabase()), configStore: { get: () => testConfig() },
    staleActiveBackupMs: 1000, resolveRelation: () => null, findBestRelationForBvid: () => null,
    resolveRelationRemotePath: unexpected, enqueueIfNeeded: unexpected, queueUploadWork: unexpected,
    buildPersistentUploadJob: unexpected, historySnapshotSegment: unexpected,
    ensurePersistedAvailabilityProbes: () => {}, ensurePersistedChargingAccessProbes: () => {},
    dispatchPersistentJobs: unexpected, recordQueued: unexpected });
}

test('restart repairs a lost verifier after bootstrap while preserving manual wait', async () => {
  const f = await fixture();
  let reopened: StateManager | undefined;
  let closed = false;
  try {
    f.state.markPersistentJobBootstrapComplete();
    const task = f.task();
    assert.equal(f.jobs.complete(task.persistentJobId!, owner), true);
    f.state.close(); closed = true;
    reopened = new StateManager({ statePath: f.statePath, dbPath: f.dbPath });
    const jobs = new PersistentJobStore(reopened.getDatabase());
    const recovery = startup(reopened, jobs);
    recovery.resumePersistedWork(); recovery.resumePersistedWork();
    const pending = jobs.list(['verify_upload'], 10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.remoteFile, remoteFile);
    assert.equal(pending[0].payload.expectedSize, 12);
    const claimed = jobs.claimByDedupeKey(pending[0].dedupeKey, owner);
    assert.ok(claimed);
    assert.equal(jobs.parkManualRecovery(claimed.id, owner, 'manual conflict'), true);
    const held = jobs.findById(claimed.id);
    recovery.resumePersistedWork();
    assert.deepEqual(jobs.findById(claimed.id), held);
    assert.equal(jobs.list(['verify_upload'], 10).length, 1);
  } finally { if (!closed) f.state.close(); reopened?.close(); await removeTestDir(f.root); }
});

test('startup does not replace a verifier with a noncanonical key or an active upload', async () => {
  const f = await fixture();
  try {
    f.state.markPersistentJobBootstrapComplete();
    const task = f.task({}, 'custom-verifier-key');
    const future = Date.now() + 86_400_000;
    f.jobs.defer(task.persistentJobId!, owner, 'delayed', future);
    const before = f.jobs.findById(task.persistentJobId!);
    const recovery = startup(f.state, f.jobs);
    recovery.resumePersistedWork();
    assert.deepEqual(f.jobs.findById(task.persistentJobId!), before);
    assert.equal(f.jobs.list(['verify_upload'], 10).length, 1);
    const claimed = f.jobs.claimByDedupeKey('custom-verifier-key', owner, 300_000, future);
    assert.ok(claimed); f.jobs.complete(claimed.id, owner);
    f.jobs.enqueue({ kind: 'upload', dedupeKey: 'manual-upload', bvid, userId: 'u1', mediaId: 1, initialStatus: 'manual_wait' });
    recovery.resumePersistedWork();
    assert.equal(f.jobs.list(['verify_upload'], 10).length, 0);
  } finally { await f.close(); }
});

test('startup groups missing session verifiers and does not reuse an older generation', async () => {
  const f = await fixture();
  try {
    const input = { dedupeKey: 'session-restore', bvid, userId: 'u1', mediaId: 1, localDir: f.root, remotePath: '/target' };
    const previous = f.sessions.ensure(input);
    f.sessions.supersede(previous.id, previous.generation);
    const session = f.sessions.ensure(input);
    const files = ['video.mp4', 'part2.mp4'].map(name => {
      const file = f.sessions.ensureFile(session.id, { relativePath: name, name, expectedSize: 12 }, session.generation);
      assert.ok(file);
      f.sessions.updateFile(session.id, name, { status: 'awaiting_remote', putAcceptedAt: Date.now() }, session.generation);
      return { name, path: file.finalPath, size: 12, localRelativePath: name,
        verificationStatus: 'awaiting_verification' as const, putCompletedAt: new Date().toISOString() };
    });
    f.sessions.updateSession(session.id, { phase: 'awaiting_remote' }, session.generation);
    f.state.markUploadedPendingVerification(bvid, '/target', files, 'u1', 1);
    f.state.markPersistentJobBootstrapComplete();
    f.jobs.enqueue({ kind: 'verify_upload', dedupeKey: 'old-session-generation', bvid, userId: 'u1', mediaId: 1,
      payload: { remoteFile, sessionId: session.id, sessionGeneration: previous.generation } });
    const recovery = startup(f.state, f.jobs);
    recovery.resumePersistedWork(); recovery.resumePersistedWork();
    const current = f.jobs.list(['verify_upload'], 10).filter(job => job.payload.sessionGeneration === session.generation);
    assert.equal(current.length, 1);
    assert.equal(current[0].payload.sessionId, session.id);
    assert.equal(current[0].payload.sessionVerification, true);
    assert.deepEqual(current[0].payload.files, ['part2.mp4', 'video.mp4']);
    assert.equal(f.jobs.list(['upload', 'history_upload'], 10).length, 0);
  } finally { await f.close(); }
});
