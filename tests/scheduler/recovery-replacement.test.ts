import { createUploadTaskFactory } from '../../src/scheduler/upload-task-factory.js';
import { parseRecoveryUploadItem } from '../../src/scheduler/upload-work.js';
import { buildUploadVerificationJobs } from '../../src/scheduler/verification-jobs.js';
import { createVerificationTaskFactory } from '../../src/scheduler/verification-task-factory.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { StateManager, type RemoteFileRecord } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { writeDownloadSession, cleanupUploadedSessionFiles, type DownloadSessionManifest } from '../../src/download-session.js';
import { protectRecoveryDirectory } from '../../src/recovery-file-protection.js';
import { captureRecoverySource, buildRecoveryReplacementPlans, decodeRecoverySources } from '../../src/scheduler/recovery-replacement.js';
import { cleanupRecoveryReplacement } from '../../src/scheduler/recovery-replacement-cleanup.js';
import { createLocalCleanup } from '../../src/scheduler/local-cleanup.js';
import { createLocalCleanupStorage } from '../../src/scheduler/local-cleanup-storage.js';
import { buildLocalCleanupPlan } from '../../src/scheduler/local-cleanup-plan.js';
import { commitVerifiedTransfer } from '../../src/scheduler/verified-transfer.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

async function fixture(extraPage = false) {
  const root = await createTestDir('replacement-cleanup'), old = path.join(root, 'old'), next = path.join(root, 'next');
  fs.mkdirSync(old); fs.mkdirSync(next); fs.writeFileSync(path.join(old, 'p1.mp4'), 'old');
  if (extraPage) fs.writeFileSync(path.join(old, 'p2.mp4'), 'unique');
  fs.writeFileSync(path.join(next, 'new.mp4'), 'newer');
  const timestamp = new Date(Date.now() + 10).toISOString();
  const manifest: DownloadSessionManifest = { schemaVersion: 1, sessionId: 'old-download', kind: 'backup', bvid: 'BVREPLACE', accountUid: 1,
    bbdownCommit: '', configFingerprint: '', configSnapshot: { quality: '', encoding: '', hiRes: false, dolby: false, filenameTemplate: '' },
    createdAt: timestamp, updatedAt: timestamp, snapshotAt: timestamp, status: 'complete',
    pages: [{ index: 1, cid: 11, title: 'P1', duration: 1 }, ...(extraPage ? [{ index: 2, cid: 22, title: 'P2', duration: 1 }] : [])],
    outputs: [{ pageIndex: 1, cid: 11, relativePath: 'p1.mp4', size: 3, duration: 1, videoCodec: 'h264', quickHash: '', verifiedAt: timestamp },
      ...(extraPage ? [{ pageIndex: 2, cid: 22, relativePath: 'p2.mp4', size: 6, duration: 1, videoCodec: 'h264', quickHash: '', verifiedAt: timestamp }] : [])], history: [] };
  writeDownloadSession(old, manifest); protectRecoveryDirectory(old);
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite') });
  state.recordFavoriteItem('u', 1, 'Favorites', { bvid: 'BVREPLACE', title: 'Fixture', upperName: 'UP' });
  const jobs = new PersistentJobStore(state.getDatabase()), sessions = new TransferSessionStore(state.getDatabase());
  const parent = jobs.enqueue({ kind: 'upload', bvid: 'BVREPLACE', dedupeKey: 'original', userId: 'u', mediaId: 1,
    payload: { localDir: old, files: manifest.outputs.map(file => file.relativePath) }, initialStatus: 'manual_wait' });
  const source = captureRecoverySource(parent); assert.ok(source); assert.equal(source.files.length, extraPage ? 2 : 1);
  jobs.complete(parent.id);
  const child = jobs.enqueue({ kind: 'upload', bvid: 'BVREPLACE', dedupeKey: 'replacement', userId: 'u', mediaId: 1 });
  assert.ok(jobs.claimByDedupeKey('replacement', 'owner'));
  const session = sessions.ensurePrepared({ dedupeKey: 'replacement', bvid: 'BVREPLACE', userId: 'u', mediaId: 1, localDir: next, remotePath: '/archive' },
    [{ relativePath: 'new.mp4', name: 'new.mp4', expectedSize: 5 }]);
  sessions.updateFile(session.id, 'new.mp4', { status: 'verified', putAcceptedAt: Date.now(), verifiedAt: Date.now() }, session.generation);
  const remote: RemoteFileRecord = { name: 'new.mp4', path: '/archive/new.mp4', size: 5, localRelativePath: 'new.mp4',
    verificationStatus: 'verified', filenameMetadata: { cid: 11, pageIndex: 1 } };
  const plans = buildRecoveryReplacementPlans([source], [remote], session, Date.now());
  const command = { bvid: 'BVREPLACE', userId: 'u', mediaId: 1, jobId: child.id, partialBackup: false, historyOnly: false,
    replacementPlans: plans, result: { remotePath: '/archive', allVerified: true, sessionId: session.id, sessionGeneration: session.generation, files: [remote] } };
  return { root, old, next, state, jobs, sessions, session, source, plans, remote, command, manifest,
    commit: () => commitVerifiedTransfer({ state, jobs, sessions, now: Date.now, leaseOwner: 'owner' }, command),
    close: async () => { state.close(); await removeTestDir(root); } };
}

test('replacement cleanup authorization commits atomically and rolls back on a stale lease', async () => {
  const f = await fixture();
  try {
    assert.throws(() => commitVerifiedTransfer({ state: f.state, jobs: f.jobs, sessions: f.sessions, now: Date.now, leaseOwner: 'stale' }, f.command), /ownership/);
    assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 0);
    assert.notEqual(f.sessions.get(f.session.id)?.phase, 'completed'); assert.ok(fs.existsSync(path.join(f.old, 'p1.mp4')));
    f.commit(); assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 1);
    assert.equal(f.sessions.get(f.session.id)?.phase, 'completed');
  } finally { await f.close(); }
});

test('a successful replacement automatically releases its held original directory through the cleanup owner', async () => {
  const f = await fixture();
  try {
    f.commit();
    const cleanup = createLocalCleanup({ state: f.state, jobs: f.jobs, transfers: f.sessions, tempRoot: f.root,
      storage: createLocalCleanupStorage(f.state), config: { get: testConfig }, now: Date.now, canRun: () => true, generation: () => 0,
      inspectRemote: async () => ({ status: 'verified' }), safeCandidate: () => true, refreshCapacity() {} });
    await cleanup.request('BVREPLACE', f.next);
    assert.equal(fs.existsSync(f.old), false); assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 0);
    assert.ok(fs.existsSync(path.join(f.next, 'new.mp4'))); cleanup.stop();
  } finally { await f.close(); }
});

test('a replacement whose original directory is already gone settles only its old plan without remote calls', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.commit(); await fs.promises.rm(f.old, { recursive: true });
    const cleanup = createLocalCleanup({ state: f.state, jobs: f.jobs, transfers: f.sessions, tempRoot: f.root,
      storage: createLocalCleanupStorage(f.state), config: { get: testConfig }, now: Date.now, canRun: () => true, generation: () => 0,
      inspectRemote: async () => { calls++; return { status: 'verified' }; }, safeCandidate: () => true, refreshCapacity() {} });
    try {
      await cleanup.perform('BVREPLACE', f.old); assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 0);
      assert.ok(fs.existsSync(path.join(f.next, 'new.mp4'))); assert.equal(calls, 0);
    } finally { cleanup.stop(); }
  } finally { await f.close(); }
});

test('replacement cleanup distinguishes an unavailable root from a missing child', async () => {
  const f = await fixture();
  try {
    f.commit(); const unavailableRoot = path.join(f.root, 'not-mounted');
    await assert.rejects(cleanupRecoveryReplacement({ ...f.plans[0], localDir: path.join(unavailableRoot, 'old') },
      { tempRoot: unavailableRoot, current: () => true, proof: () => true, inspect: async () => true }), /ENOENT/);
    assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 1); assert.ok(fs.existsSync(path.join(f.old, 'p1.mp4')));
  } finally { await f.close(); }
});

test('replacement coverage preserves old-only pages, historical versions and unknown files', async () => {
  const f = await fixture(true);
  try {
    fs.mkdirSync(path.join(f.old, '_history')); fs.writeFileSync(path.join(f.old, '_history', 'old.mp4'), 'history');
    fs.writeFileSync(path.join(f.old, 'untracked.mp4'), 'unknown'); f.commit();
    assert.equal(f.plans[0].files.length, 1);
    await cleanupRecoveryReplacement(f.plans[0], { tempRoot: f.root, current: () => true, proof: () => true, inspect: async () => true });
    assert.equal(fs.existsSync(path.join(f.old, 'p1.mp4')), false);
    for (const file of ['p2.mp4', '_history/old.mp4', 'untracked.mp4']) assert.ok(fs.existsSync(path.join(f.old, file)));
  } finally { await f.close(); }
});

test('changed files, changed manifests, missing remote proof and late shutdown all prevent replacement deletion', async () => {
  const f = await fixture();
  try {
    const deps = { tempRoot: f.root, current: () => true, proof: () => true, inspect: async () => true };
    await fs.promises.appendFile(path.join(f.old, 'p1.mp4'), 'changed');
    assert.deepEqual(await cleanupRecoveryReplacement(f.plans[0], deps), ['p1.mp4']);
    assert.equal(await cleanupRecoveryReplacement(f.plans[0], { ...deps, proof: () => false }), null);
    let active = true;
    assert.equal(await cleanupRecoveryReplacement(f.plans[0], { ...deps, current: () => active,
      inspect: async () => { active = false; return true; } }), null);
    writeDownloadSession(f.old, { ...f.manifest, sessionId: 'another-attempt' });
    assert.equal(await cleanupRecoveryReplacement(f.plans[0], deps), null);
    assert.ok(fs.existsSync(path.join(f.old, 'p1.mp4')));
  } finally { await f.close(); }
});

test('replacement filesystem failure preserves its authorization and succeeds on a later attempt', async () => {
  const f = await fixture();
  try {
    f.commit(); const deps = { tempRoot: f.root, current: () => true, proof: () => true, inspect: async () => true };
    await assert.rejects(cleanupRecoveryReplacement(f.plans[0], { ...deps, unlink: () => { throw Object.assign(new Error('disk busy'), { code: 'EPERM' }); } }), /disk busy/);
    assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 1); assert.ok(fs.existsSync(path.join(f.old, 'p1.mp4')));
    assert.deepEqual(await cleanupRecoveryReplacement(f.plans[0], deps), []);
    assert.equal(fs.existsSync(f.old), false);
  } finally { await f.close(); }
});

test('held ordinary outputs clean after proof commits; IO failure schedules retry without discarding the plan', async () => {
  const f = await fixture();
  try {
    f.commit();
    const session = f.sessions.ensurePrepared({ dedupeKey: 'ordinary', bvid: 'BVREPLACE', localDir: f.old, remotePath: '/ordinary' },
      [{ relativePath: 'p1.mp4', name: 'p1.mp4', expectedSize: 3 }]);
    f.sessions.updateSession(session.id, { phase: 'completed' }, session.generation);
    const file: RemoteFileRecord = { name: 'p1.mp4', path: '/ordinary/p1.mp4', size: 3, localRelativePath: 'p1.mp4', verificationStatus: 'verified' };
    f.state.markVerifiedUpload('BVREPLACE', '/ordinary', [file], 'u', 1, false);
    const plan = buildLocalCleanupPlan('BVREPLACE', f.old, [file], 'upload_verified', Date.now, { transferSessionId: session.id, transferGeneration: session.generation });
    assert.ok(plan);
    // Isolate this ordinary plan from the independently tested superseded-source plan.
    f.state.reconcileLocalCleanupPlans('BVREPLACE', f.old, [], true);
    const cleanupJob = f.jobs.enqueue({ kind: 'upload', bvid: 'BVREPLACE', dedupeKey: 'ordinary-cleanup' });
    assert.ok(f.state.recordLocalCleanupPlan('BVREPLACE', plan, cleanupJob.id)); f.jobs.complete(cleanupJob.id);
    let now = Date.now(), attempts = 0;
    const cleanup = createLocalCleanup({ state: f.state, jobs: f.jobs, transfers: f.sessions, tempRoot: f.root,
      storage: createLocalCleanupStorage(f.state), config: { get: testConfig }, now: () => now, canRun: () => true, generation: () => 0,
      inspectRemote: async () => ({ status: 'verified' }), safeCandidate: () => true, refreshCapacity() {},
      cleanupFiles: async (...args) => { attempts++; if (attempts === 1) throw Object.assign(new Error('disk busy'), { code: 'EPERM' }); return cleanupUploadedSessionFiles(...args); } });
    await cleanup.request('BVREPLACE', f.old); assert.equal(attempts, 1);
    assert.ok(cleanup.retryState('BVREPLACE')); assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 1);
    now += 60_001; await cleanup.request('BVREPLACE', f.old);
    assert.equal(attempts, 2); assert.equal(fs.existsSync(f.old), false); assert.equal(cleanup.retryState('BVREPLACE'), undefined); cleanup.stop();
  } finally { await f.close(); }
});

test('source decoding rejects unsafe paths and invalid identities instead of filtering damaged evidence', () => {
  assert.deepEqual(decodeRecoverySources(undefined), []);
  for (const relativePath of ['../outside', '/absolute']) assert.throws(() => decodeRecoverySources([{ jobId: 'j', localDir: 'd', manifestStamp: 's',
    files: [{ relativePath, cid: 1, expectedSize: 1, expectedIdentity: { dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 } }] }]), /Invalid/);
});

test('control-file cleanup can finish after an IO failure without orphaning the retained directory', async () => {
  const f = await fixture();
  try {
    f.commit(); let calls = 0;
    const deps = { tempRoot: f.root, current: () => true, proof: () => true, inspect: async () => true };
    await assert.rejects(cleanupRecoveryReplacement(f.plans[0], { ...deps, unlink: file => {
      calls++; if (calls === 3) throw Object.assign(new Error('control locked'), { code: 'EPERM' });
      fs.unlinkSync(file);
    } }), /control locked/);
    assert.equal(fs.existsSync(path.join(f.old, 'p1.mp4')), false);
    assert.equal(f.state.getLocalCleanupPlans('BVREPLACE').length, 1);
    assert.deepEqual(await cleanupRecoveryReplacement(f.plans[0], deps), []);
    assert.equal(fs.existsSync(f.old), false);
  } finally { await f.close(); }
});

test('production upload and verification handoffs retain the independent recovery budget and original inventory', async () => {
  const f = await fixture();
  try {
    const factory = createUploadTaskFactory({ stateManager: f.state, configStore: { get: testConfig }, jobStore: f.jobs,
      transferSessions: f.sessions, leaseOwner: 'owner', generation: () => 0, captureExistingArchiveProof: () => undefined,
      legacyConflictSideEffectsStarted: () => false, restoreConflictCandidateExistingArchive: () => false });
    const task = factory.build(parseRecoveryUploadItem({ bvid: 'BVREPLACE', localDir: f.next, remotePath: '/archive', userId: 'u', mediaId: 1,
      files: ['new.mp4'], sessionId: f.session.id, sessionGeneration: f.session.generation,
      automaticRecoveryAttempts: 3, recoverySources: [f.source] }));
    assert.equal(task.automaticRecoveryAttempts, 3); assert.deepEqual(task.recoverySources, [f.source]);
    const inputs = buildUploadVerificationJobs(task, [{ path: f.remote.path, size: 5, localRelativePath: 'new.mp4', verificationStatus: 'awaiting_verification' }]);
    assert.equal(inputs.length, 1);
    const job = f.jobs.enqueue(inputs[0]);
    const verification = createVerificationTaskFactory({ config: testConfig, sessions: f.sessions, jobs: f.jobs, leaseOwner: 'owner', rejected: assert.fail })(job);
    assert.ok(verification); assert.equal(verification.automaticRecoveryAttempts, 3); assert.deepEqual(verification.recoverySources, [f.source]);
  } finally { await f.close(); }
});
