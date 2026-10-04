import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PersistentJobRecord } from '../../src/database.js';
import type { ExistingArchiveProof } from '../../src/upload-preflight.js';
import type { RecoveryAssessment } from '../../src/scheduler/recovery-contracts.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { BBDOWN_SOURCE_COMMIT, writeDownloadSession, type DownloadSessionManifest } from '../../src/download-session.js';
import { isRecoveryProtected } from '../../src/recovery-file-protection.js';
import { createRecoveryEvidenceRebuild, preserveRecoveryEvidence } from '../../src/scheduler/recovery-evidence-rebuild.js';
import { createRecoveryAssessmentService } from '../../src/scheduler/recovery-assessment.js';
import { createRecoveryFinalization } from '../../src/scheduler/recovery-finalization.js';
import { createBackupEnqueue } from '../../src/scheduler/backup-enqueue.js';
import { createRecoveryWork } from '../../src/scheduler/recovery-work.js';
import { inspectRecoveryLocalFiles } from '../../src/scheduler/recovery-local-files.js';
import { parseExistingArchiveProof, parseRecoveryAssessment, isVerifiedArchiveProofForRecovery, verifiedFilesFromRecovery } from '../../src/scheduler/recovery-projection.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import { recoveryFixture } from '../fixtures/recovery.js';

const bvid = 'BVEVIDENCE';
const timestamp = '2026-10-03T00:00:00.000Z';
const invalidProof = { status: 'verified', remotePath: '/archive', files: [null] };
const user = { id: 'u', uid: 1, name: 'Fixture', enabled: true, lastLoginAt: '', favorites: [{ mediaId: 1, title: 'Favorites' }],
  cookie: { SESSDATA: '', bili_jct: '', DedeUserID: '1' } };

async function fixture(options: { proof?: ExistingArchiveProof; preserve?: (job: PersistentJobRecord) => Promise<string> } = {}) {
  const root = await createTestDir('evidence-rebuild');
  const directory = path.join(root, 'local');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'v.mp4'), 'media');
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite') });
  state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
  const jobs = new PersistentJobStore(state.getDatabase());
  const sessions = new TransferSessionStore(state.getDatabase());
  const work = createRecoveryWork<void>();
  const control = { active: true, epoch: 1, now: 1_000, backups: 0, inspections: 0, dispatches: 0 };
  const rebuild = createRecoveryEvidenceRebuild({ jobs, sessions, atomic: fn => state.runAtomic(fn),
    captureProof: () => options.proof, canRun: () => control.active, generation: () => control.epoch, now: () => control.now,
    preserve: async job => { control.backups++; return options.preserve ? options.preserve(job) : preserveRecoveryEvidence(root, job); },
  });
  const enqueue = (key: string, payload: Record<string, unknown> = {}) => jobs.enqueue({ kind: 'upload', dedupeKey: key,
    bvid, userId: 'u', mediaId: 1, initialStatus: 'manual_wait', payload: {
      awaitingManualRecovery: true, localDir: directory, remotePath: '/archive', files: ['v.mp4'], ...payload,
    } });
  const transfer = (key: string, put = false) => {
    const session = sessions.ensure({ dedupeKey: key, bvid, userId: 'u', mediaId: 1, localDir: directory, remotePath: '/archive' });
    sessions.ensureFile(session.id, { relativePath: 'v.mp4', name: 'v.mp4', expectedSize: 5 }, session.generation);
    if (put) sessions.updateFile(session.id, 'v.mp4', { putAcceptedAt: 100, status: 'awaiting_remote' }, session.generation);
    return session;
  };
  const manifest: DownloadSessionManifest = {
    schemaVersion: 1, sessionId: 'local-download', kind: 'backup', bvid, accountUid: 1,
    bbdownCommit: BBDOWN_SOURCE_COMMIT, configFingerprint: 'fixture',
    configSnapshot: { quality: '', encoding: '', apiMode: 'web', hiRes: false, dolby: false, filenameTemplate: '<videoTitle>-<bvid>' },
    createdAt: timestamp, updatedAt: timestamp, snapshotAt: timestamp, status: 'complete',
    pages: [{ index: 1, cid: 11, title: 'P1', duration: 1 }], history: [],
    outputs: [{ pageIndex: 1, cid: 11, relativePath: 'v.mp4', size: 5, verifiedAt: timestamp,
      duration: 1, width: 64, height: 64, videoCodec: 'h264', quickHash: 'fixture' }],
  };
  const dispatch = () => { control.dispatches++; };
  const backup = createBackupEnqueue({ config: { get: () => testConfig() }, state, jobs, eligible: () => user.enabled, blocked: () => false,
    remotePath: () => '/archive', proof: () => options.proof, uploadJob: () => assert.fail('fresh recovery must enqueue a download'),
    historySegment: value => value, probe: () => assert.fail('no extra access requests'), cycleStartedAt: () => undefined,
    generation: () => control.epoch, now: () => control.now, dispatch });
  const finalization = createRecoveryFinalization({ stateManager: state, jobStore: jobs, transferSessions: sessions,
    resolveRelation: () => user.enabled ? { user, folderTitle: 'Favorites' } : null, prepareDownload: backup.prepareRecoveryDownload,
    verifiedFilesFromRecovery: (job, files) => verifiedFilesFromRecovery(job.payload, files), buildLocalCleanupPlan: () => null,
    cleanup: () => assert.fail('rebuilt evidence must not delete local files'), now: () => control.now, canRun: () => control.active,
    dispatchPersistentJobs: dispatch });
  const assessment = (remoteFileInspector: Parameters<typeof createRecoveryAssessmentService>[0]['remoteFileInspector']) => createRecoveryAssessmentService({
    jobStore: jobs, transferSessions: sessions, configStore: { get: () => testConfig() }, recoveryJobLocks: work.locks,
    atomic: fn => state.runAtomic(fn), now: () => control.now, canRun: () => control.active, generation: () => control.epoch,
    rebuildEvidence: rebuild.rebuild, preserveForReprobe: rebuild.preserveForReprobe, downloadReadiness: finalization.downloadReadiness,
    recoveryAssessment: parseRecoveryAssessment, captureExistingArchiveProof: () => options.proof,
    isVerifiedArchiveProofForRecovery: (job, proof) => isVerifiedArchiveProofForRecovery(job.payload, proof),
    updateRecoveryAssessment: (id, value) => { const job = jobs.findById(id); assert.ok(job);
      return jobs.updatePayload(id, { ...job.payload, recoveryAssessment: value, recoveryEvidenceChecked: true }); },
    inspectRecoveryLocalFiles: job => inspectRecoveryLocalFiles(sessions, job), persistedExistingArchiveProof: parseExistingArchiveProof,
    remoteFileInspector: async (...args) => { control.inspections++; return remoteFileInspector(...args); },
    finalizeRetainedArchiveRecovery: finalization.finalizeRetainedArchiveRecovery, finalizeVerifiedRecovery: finalization.finalizeVerifiedRecovery,
    queueFreshDownloadForRecovery: finalization.queueFreshDownloadForRecovery,
    startConflictCandidate: () => ({ ok: false }),
    resumeUpload: job => { const resumed = jobs.wakeManualJob(job.id, { awaitingManualRecovery: false, resumeOnly: false, allowReupload: false });
      if (resumed) dispatch(); return Boolean(resumed); },
  });
  return { root, directory, state, jobs, sessions, control, rebuild, enqueue, transfer, manifest, finalization, assessment, work,
    writeManifest: () => writeDownloadSession(directory, manifest),
    close: async () => { state.close(); await removeTestDir(root); } };
}

test('damaged derived proof rebuilds from the current transfer, preserves its payload, and commits without another PUT', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('owned', true);
    const job = f.enqueue('owned', { sessionId: session.id, sessionGeneration: session.generation, existingArchiveProof: invalidProof });
    const service = f.assessment(async () => ({ status: 'verified', remoteSize: 5, parentStatus: 'visible' }));
    const result = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(result.resolved, true); assert.equal(f.jobs.findById(job.id), null);
    assert.equal(f.sessions.get(session.id)?.phase, 'completed');
    assert.equal(f.sessions.getFile(session.id, 'v.mp4')?.putAcceptedAt, 100);
    assert.equal(f.state.getRelationStatus('u', 1, bvid)?.backupStatus, 'verified');
    assert.equal(f.control.backups, 1); assert.equal(f.control.inspections, 1);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
    assert.equal(isRecoveryProtected(f.directory), true);
    const backups = await fs.readdir(path.join(f.root, '_recovery-evidence'));
    const preserved: unknown = JSON.parse(await fs.readFile(path.join(f.root, '_recovery-evidence', backups[0]), 'utf8'));
    assert.deepEqual(preserved, { jobId: job.id, payload: job.payload });
  } finally { await f.close(); }
});

test('independent archive proof replaces only a complete matching file group', async () => {
  const proof: ExistingArchiveProof = { status: 'verified', remotePath: '/archive', verifiedAt: timestamp,
    files: [{ name: 'v.mp4', path: '/archive/v.mp4', size: 5, verificationStatus: 'verified', localRelativePath: 'v.mp4' }] };
  const f = await fixture({ proof });
  try {
    const job = f.enqueue('archive', { existingArchiveProof: invalidProof });
    const result = await f.rebuild.rebuild(job);
    assert.equal(result.kind, 'repaired');
    if (result.kind !== 'repaired') assert.fail();
    assert.deepEqual(result.job.payload.existingArchiveProof, proof);
    assert.equal(result.job.payload.sessionId, undefined); assert.equal(isRecoveryProtected(f.directory), false);
    assert.equal(f.control.backups, 1);
    const other = f.enqueue('other-files', { files: ['other.mp4'], existingArchiveProof: invalidProof });
    assert.equal((await f.rebuild.rebuild(other)).kind, 'blocked');
  } finally { await f.close(); }
});

test('valid local manifest rebuilds missing transfer rows as pending, never as uploaded or verified', async () => {
  const f = await fixture();
  try {
    f.writeManifest(); const job = f.enqueue('missing-transfer');
    const result = await f.rebuild.rebuild(job); assert.equal(result.kind, 'repaired');
    if (result.kind !== 'repaired') assert.fail();
    const id = result.job.payload.sessionId; assert.equal(typeof id, 'string');
    const files = f.sessions.listFiles(String(id)); assert.equal(files.length, 1);
    assert.equal(files[0].status, 'pending'); assert.equal(files[0].putAcceptedAt, undefined); assert.equal(files[0].verifiedAt, undefined);
    assert.equal((await f.rebuild.rebuild(result.job)).kind, 'unchanged'); assert.equal(f.control.backups, 1);
    const service = f.assessment(async () => ({ status: 'missing', parentStatus: 'visible' }));
    assert.equal((await service.assess(job.id, { force: true, allowAutomatic: true })).resumed, true);
    assert.equal(f.jobs.findById(job.id)?.status, 'pending'); assert.equal(f.control.dispatches, 1);
    assert.equal(f.jobs.findById(job.id)?.payload.allowReupload, false);
    assert.equal((await service.assess(job.id, { force: true, allowAutomatic: true })).changed, false);
  } finally { await f.close(); }
});

test('malformed optional metadata is rebuilt from the validated manifest without changing PUT evidence', async () => {
  const f = await fixture();
  try {
    f.writeManifest(); const session = f.transfer('metadata', true);
    const job = f.enqueue('metadata', { sessionId: session.id, sessionGeneration: session.generation,
      filenameMetadataByPath: { 'v.mp4': { mediaMetadata: {} } } });
    const result = await f.rebuild.rebuild(job); assert.equal(result.kind, 'repaired');
    if (result.kind !== 'repaired') assert.fail();
    const files = verifiedFilesFromRecovery(result.job.payload, f.sessions.listFiles(session.id));
    assert.equal(files[0].mediaMetadata?.width, 64); assert.equal(f.sessions.getFile(session.id, 'v.mp4')?.putAcceptedAt, 100);
  } finally { await f.close(); }
});

test('the upload file list is rebuilt from complete current transfer rows rather than resuming an untracked file', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('files');
    const job = f.enqueue('files', { sessionId: session.id, sessionGeneration: session.generation, files: ['untracked.mp4'] });
    const result = await f.rebuild.rebuild(job); assert.equal(result.kind, 'repaired');
    if (result.kind !== 'repaired') assert.fail();
    assert.deepEqual(result.job.payload.files, ['v.mp4']);
    assert.equal(f.sessions.listFiles(session.id).length, 1); assert.equal(f.control.backups, 1);
  } finally { await f.close(); }
});

test('a partial manifest cannot be converted to a full successful upload', async () => {
  const f = await fixture();
  try {
    f.manifest.pages.push({ index: 2, cid: 22, title: 'P2', duration: 1 }); f.manifest.status = 'partial';
    f.writeManifest();
    const result = await f.rebuild.rebuild(f.enqueue('partial'));
    assert.equal(result.kind, 'blocked'); if (result.kind === 'blocked') assert.equal(result.canReprobe, true);
    assert.equal(f.control.backups, 0);
    assert.equal(f.sessions.getByDedupeKey('partial'), null);
  } finally { await f.close(); }
});

test('rebuilding a damaged proof cannot turn a same-size remote file without PUT evidence into this upload', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('unowned');
    const job = f.enqueue('unowned', { sessionId: session.id, sessionGeneration: session.generation, existingArchiveProof: invalidProof });
    const service = f.assessment(async () => ({ status: 'verified', remoteSize: 5, parentStatus: 'visible' }));
    const result = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(result.assessment?.kind, 'unknown_same_size');
    assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait');
    assert.equal(f.sessions.getFile(session.id, 'v.mp4')?.putAcceptedAt, undefined);
    assert.notEqual(f.state.getRelationStatus('u', 1, bvid)?.backupStatus, 'verified');
    assert.equal(isRecoveryProtected(f.directory), true);
  } finally { await f.close(); }
});

test('saving the damaged payload fails visibly without queuing a new download or changing original media', async () => {
  const f = await fixture({ preserve: async () => { throw new Error('disk full'); } });
  try {
    const session = f.transfer('backup-failed');
    const job = f.enqueue('backup-failed', { sessionId: session.id, sessionGeneration: session.generation, existingArchiveProof: invalidProof });
    const result = await f.assessment(async () => assert.fail('no inspection before preservation')).assess(job.id, { allowAutomatic: true });
    assert.equal(result.assessment?.kind, 'manual_review'); assert.match(result.assessment.summary, /无法保存/);
    assert.deepEqual(f.jobs.findById(job.id)?.payload.existingArchiveProof, invalidProof);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`), null);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
    assert.equal(f.work.busy, false);
  } finally { await f.close(); }
});

test('legacy interrupted conflict is rejected before any evidence reconstruction or external inspection', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('legacy-conflict', { legacyConflictSideEffectsStarted: true, existingArchiveProof: invalidProof });
    const result = await f.assessment(async () => assert.fail('legacy conflict must remain untouched')).assess(job.id, { allowAutomatic: true });
    assert.equal(result.assessment?.kind, 'legacy_conflict_interrupted'); assert.equal(f.control.backups, 0);
    assert.deepEqual(f.jobs.findById(job.id)?.payload.existingArchiveProof, invalidProof);
  } finally { await f.close(); }
});

for (const mode of ['backup-fails', 'late-generation', 'stopped', 'payload-changed', 'sqlite-fails'] as const) {
  test(`evidence preservation and commit reject unsafe completion: ${mode}`, async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture(mode === 'sqlite-fails' ? {} : { preserve: async () => {
      entered(); if (mode === 'backup-fails') throw new Error('disk full'); await gate; return 'preserved';
    } });
    try {
      f.writeManifest(); const job = f.enqueue(mode);
      if (mode === 'sqlite-fails') {
        f.state.getDatabase().db.exec("CREATE TRIGGER abort_evidence BEFORE UPDATE OF payload_json ON jobs BEGIN SELECT RAISE(ABORT, 'injected evidence failure'); END");
        await assert.rejects(f.rebuild.rebuild(job), /injected evidence failure/);
        assert.equal(f.sessions.getByDedupeKey(`evidence-rebuild:${job.id}`), null);
      } else if (mode === 'backup-fails') await assert.rejects(f.rebuild.rebuild(job), /无法保存/);
      else {
        const pending = f.rebuild.rebuild(job); await entering;
        if (mode === 'late-generation') f.control.epoch++;
        if (mode === 'stopped') f.control.active = false;
        if (mode === 'payload-changed') f.jobs.updatePayload(job.id, { ...job.payload, userDisposition: 'abandoned' });
        release(); assert.equal((await pending).kind, 'stale');
      }
      assert.equal(f.jobs.findById(job.id)?.payload.sessionId, undefined);
      assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
      assert.equal(isRecoveryProtected(f.directory), false);
      if (mode !== 'payload-changed') assert.deepEqual(f.jobs.findById(job.id)?.payload, job.payload);
    } finally { release(); await f.close(); }
  });
}

test('missing explicit session, stale generation and corrupted candidate identities cannot be reconstructed', async () => {
  const f = await fixture();
  try {
    f.writeManifest(); const session = f.transfer('identity');
    for (const [index, payload] of [
      { sessionId: 'missing' }, { sessionId: session.id, sessionGeneration: session.generation + 1 },
      { sessionId: session.id, sessionGeneration: session.generation, remotePath: '/other' },
      { conflictCandidate: { files: [{ name: 'v', path: '/candidate/v', size: 5 }, null] } },
    ].entries()) {
      const result = await f.rebuild.rebuild(f.enqueue(`invalid-${index}`, payload));
      assert.equal(result.kind, 'blocked'); if (result.kind === 'blocked') assert.equal(result.canReprobe, false);
    }
    assert.equal(f.control.backups, 0);
  } finally { await f.close(); }
});

test('unrebuildable manifest queues one isolated download and keeps the original files and evidence', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('reprobe');
    const job = f.enqueue('reprobe', { sessionId: session.id, sessionGeneration: session.generation, filenameMetadataByPath: [] });
    const service = f.assessment(async () => assert.fail('reprobe does not guess remote identities'));
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).redownloaded, true);
    assert.equal(f.jobs.findById(job.id), null); assert.equal(f.sessions.get(session.id)?.phase, 'superseded');
    const replacement = f.jobs.findByDedupeKey(`download:${bvid}`); assert.ok(replacement);
    assert.equal(replacement.payload.recoveryParentJobId, job.id);
    assert.equal(replacement.payload.recoveryOriginalLocalDir, f.directory);
    assert.equal(replacement.payload.automaticRecoveryAttempts, 1);
    assert.equal(isRecoveryProtected(f.directory), true);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
    assert.equal(f.control.backups, 1); assert.equal(f.control.dispatches, 1);
    assert.equal((await service.assess(job.id, { force: true, allowAutomatic: true })).changed, false);
  } finally { await f.close(); }
});

test('the real recovery workflow and task factory connect reconstruction to stable isolated download directories', async () => {
  const f = await fixture();
  try {
    const production = recoveryFixture(f.state, [user], undefined, { tempDir: f.root });
    const session = f.transfer('production');
    const job = f.enqueue('production', { sessionId: session.id, sessionGeneration: session.generation, filenameMetadataByPath: [] });
    assert.equal((await production.service.assessManualRecoveryJob(job.id, { allowAutomatic: true })).redownloaded, true);
    const next = f.jobs.findByDedupeKey(`download:${bvid}`); assert.ok(next);
    const task = production.downloads.build(next); assert.ok(task?.downloadDirOverride);
    assert.notEqual(task.downloadDirOverride, f.directory);
    assert.equal(task.recoverySourceDir, f.directory);
    assert.equal(production.downloads.build(next)?.downloadDirOverride, task.downloadDirOverride);
    f.jobs.complete(next.id);
    const second = f.jobs.enqueue({ kind: 'download', dedupeKey: `download:${bvid}`, bvid,
      payload: { ...next.payload, recoveryParentJobId: 'second-attempt' } });
    assert.notEqual(production.downloads.build(second)?.downloadDirOverride, task.downloadDirOverride);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
    assert.equal(production.service.busy, false);
  } finally { await f.close(); }
});

test('source unavailable waits in the background without spending a download attempt, then resumes after availability returns', async () => {
  const f = await fixture();
  try {
    f.state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP', favoriteUnavailable: true });
    const job = f.enqueue('source', { filenameMetadataByPath: [] });
    const service = f.assessment(async () => assert.fail('no remote/Bili polling during source wait'));
    const waiting = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(waiting.assessment?.kind, 'recovery_source_wait'); assert.ok(waiting.assessment.nextCheckAt);
    assert.equal(f.jobs.findById(job.id)?.payload.automaticRecoveryAttempts, undefined);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`), null); assert.equal(f.control.backups, 0);
    const manualCheck = await service.assess(job.id, { force: true, allowAutomatic: false });
    assert.equal(manualCheck.assessment?.kind, 'recovery_source_wait');
    assert.deepEqual(f.jobs.listDueManualRecovery(['upload'], f.control.now), []);
    f.state.recordFavoriteItem('u', 1, 'Favorites', { bvid, title: 'Fixture', upperName: 'UP' });
    f.control.now = waiting.assessment.nextCheckAt;
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).redownloaded, true);
  } finally { await f.close(); }
});

test('a read-only manual check keeps eligible reprobe work scheduled instead of converting it to permanent manual review', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('read-only-reprobe', { filenameMetadataByPath: [] });
    const service = f.assessment(async () => assert.fail('no external calls for corrupt local metadata'));
    const result = await service.assess(job.id, { force: true, allowAutomatic: false });
    assert.equal(result.assessment?.kind, 'recovery_evidence_wait'); assert.ok(result.assessment.nextCheckAt);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`), null); assert.equal(f.control.backups, 0);
    f.control.now = result.assessment.nextCheckAt;
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).redownloaded, true);
  } finally { await f.close(); }
});

test('the public manual retry authorizes only one extra isolated download after the automatic budget is exhausted', async () => {
  const f = await fixture();
  try {
    const production = recoveryFixture(f.state, [user], undefined, { tempDir: f.root });
    const job = f.enqueue('manual-budget', { automaticRecoveryAttempts: 3, filenameMetadataByPath: [] });
    await production.service.assessManualRecoveryJob(job.id, { allowAutomatic: true });
    const issue = production.service.getRecoveryIssueSnapshot().actionRequiredIssues.find(item => item.id === `upload.${job.id}`);
    assert.ok(issue?.availableActions.some(action => action.id === 'redownload'));
    assert.equal((await production.service.resolveRecoveryIssue(`upload.${job.id}`, 'redownload')).ok, true);
    const download = f.jobs.findByDedupeKey(`download:${bvid}`); assert.ok(download);
    assert.equal(download.payload.automaticRecoveryAttempts, 4);
    assert.equal(isRecoveryProtected(f.directory), true);
    assert.equal((await production.service.resolveRecoveryIssue(`upload.${job.id}`, 'redownload')).ok, true);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`)?.id, download.id);
  } finally { await f.close(); }
});

test('a historical task without a download manifest stays scheduled after a read-only check', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('historical-no-manifest');
    const service = f.assessment(async () => assert.fail('missing evidence must not cause an external request'));
    const waiting = await service.assess(job.id, { force: true, allowAutomatic: false });
    assert.equal(waiting.assessment?.kind, 'recovery_evidence_wait'); assert.ok(waiting.assessment.nextCheckAt);
    assert.equal(f.control.backups, 0); assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`), null);
    f.control.now = waiting.assessment.nextCheckAt;
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).redownloaded, true);
    assert.equal(isRecoveryProtected(f.directory), true);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});

test('a historical task without a download manifest exposes the same explicit retry after budget exhaustion', async () => {
  const f = await fixture();
  try {
    const production = recoveryFixture(f.state, [user], undefined, { tempDir: f.root });
    const job = f.enqueue('historical-budget', { automaticRecoveryAttempts: 3 });
    const waiting = await production.service.assessManualRecoveryJob(job.id, { allowAutomatic: true });
    assert.equal(waiting.assessment?.kind, 'download_retry_exhausted');
    const issue = production.service.getRecoveryIssueSnapshot().actionRequiredIssues.find(item => item.id === `upload.${job.id}`);
    assert.ok(issue?.availableActions.some(action => action.id === 'redownload'));
    assert.equal((await production.service.resolveRecoveryIssue(`upload.${job.id}`, 'redownload')).ok, true);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`)?.payload.automaticRecoveryAttempts, 4);
    assert.equal(await fs.readFile(path.join(f.directory, 'v.mp4'), 'utf8'), 'media');
  } finally { await f.close(); }
});

test('automatic download budget stops at three and explicit manual retry remains possible', async () => {
  const f = await fixture();
  try {
    const job = f.enqueue('exhausted', { automaticRecoveryAttempts: 3, filenameMetadataByPath: [] });
    const service = f.assessment(async () => assert.fail('exhausted job must not issue a request'));
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).assessment?.kind, 'download_retry_exhausted');
    assert.equal(f.control.backups, 0); assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`), null);
    const live = f.jobs.findById(job.id); assert.ok(live);
    assert.equal(f.finalization.queueFreshDownloadForRecovery(live, 'unknown', true), true);
    assert.equal(f.jobs.findByDedupeKey(`download:${bvid}`)?.payload.automaticRecoveryAttempts, 4);
  } finally { await f.close(); }
});

test('a delayed inspection cannot finalize after maintenance, and duplicate assessment shares the job lock', async () => {
  const f = await fixture();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = () => {};
  const entering = new Promise<void>(resolve => { entered = resolve; });
  try {
    const session = f.transfer('late', true);
    const job = f.enqueue('late', { sessionId: session.id, sessionGeneration: session.generation });
    const service = f.assessment(async () => { entered(); await gate; return { status: 'verified' }; });
    const pending = service.assess(job.id, { force: true }); await entering;
    assert.equal((await service.assess(job.id, { force: true })).busy, true);
    f.control.active = false; f.control.epoch++; release();
    assert.equal((await pending).changed, false);
    assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait'); assert.notEqual(f.sessions.get(session.id)?.phase, 'completed');
    assert.equal(f.control.inspections, 1); assert.equal(f.work.busy, false);
  } finally { release(); await f.close(); }
});

test('legacy manual jobs get one automatic assessment; stopped tasks and future checks are not selected', async () => {
  const f = await fixture();
  try {
    const assessment: RecoveryAssessment = { kind: 'manual_review', checkedAt: 100, localStatus: 'unknown', remoteStatus: 'unknown', summary: 'legacy' };
    const unchecked = f.enqueue('unchecked', { recoveryAssessment: assessment });
    const checked = f.enqueue('checked', { recoveryAssessment: assessment, recoveryEvidenceChecked: true });
    f.enqueue('abandoned', { userDisposition: 'abandoned', recoveryAssessment: assessment });
    f.enqueue('future', { recoveryAssessment: { ...assessment, kind: 'recovery_source_wait', nextCheckAt: 10_000 } });
    assert.deepEqual(f.jobs.listDueManualRecovery(['upload'], 1000).map(job => job.id), [unchecked.id]);
    f.jobs.updatePayload(unchecked.id, { ...unchecked.payload, recoveryEvidenceChecked: true });
    assert.deepEqual(f.jobs.listDueManualRecovery(['upload'], 1000), []);
    assert.equal(f.jobs.findById(checked.id)?.status, 'manual_wait');
    assert.equal(f.jobs.listDueManualRecovery(['upload'], 10_000).length, 1);
  } finally { await f.close(); }
});

test('damaged descriptions can be removed without a manifest when owned PUT evidence is complete', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('optional-only', true);
    const job = f.enqueue('optional-only', { sessionId: session.id, sessionGeneration: session.generation,
      filenameMetadataByPath: { 'v.mp4': { cid: 11, pageIndex: 1, publishDate: 'broken', mediaMetadata: {} } } });
    const result = await f.rebuild.rebuild(job); assert.equal(result.kind, 'repaired');
    if (result.kind !== 'repaired') assert.fail();
    const files = verifiedFilesFromRecovery(result.job.payload, f.sessions.listFiles(session.id));
    assert.equal(files[0].filenameMetadata?.cid, 11); assert.equal(files[0].filenameMetadata?.publishDate, undefined);
    assert.equal(files[0].mediaMetadata, undefined); assert.equal(f.control.backups, 1);
    assert.equal(f.sessions.getFile(session.id, 'v.mp4')?.putAcceptedAt, 100);
    assert.ok(await fs.readFile(path.join(f.directory, 'v.mp4')));
  } finally { await f.close(); }
});

test('page identity, strict target evidence and unacknowledged uploads cannot use descriptive repair', async () => {
  const f = await fixture();
  try {
    for (const [key, metadata, strict] of [
      ['cid', { cid: 'broken', publishDate: 'broken' }, undefined],
      ['page', { pageIndex: 'broken', publishDate: 'broken' }, undefined],
      ['strict', { cid: 11, mediaMetadata: {} }, { encoding: 'AVC' }],
    ] as const) {
      const session = f.transfer(key, true);
      const result = await f.rebuild.rebuild(f.enqueue(key, { sessionId: session.id, sessionGeneration: session.generation,
        filenameMetadataByPath: { 'v.mp4': metadata }, strictMediaTarget: strict }));
      assert.equal(result.kind, 'blocked'); assert.notEqual(f.sessions.get(session.id)?.phase, 'completed');
    }
    const session = f.transfer('no-put');
    assert.equal((await f.rebuild.rebuild(f.enqueue('no-put', { sessionId: session.id, sessionGeneration: session.generation,
      filenameMetadataByPath: { 'v.mp4': { publishDate: 'broken' } } }))).kind, 'blocked');
    assert.equal(f.control.backups, 0);
  } finally { await f.close(); }
});

test('remote write rejection keeps scheduled read-only checks and finalizes when files become visible', async () => {
  const f = await fixture();
  try {
    const session = f.transfer('visibility', true);
    f.sessions.updateFile(session.id, 'v.mp4', { attempts: 2 }, session.generation);
    const job = f.enqueue('visibility', { sessionId: session.id, sessionGeneration: session.generation,
      remoteWriteEvidence: 'target_missing_parent_visible', remoteWriteStatus: 405 });
    let visible = false;
    const service = f.assessment(async () => visible ? { status: 'verified' } : { status: 'missing', parentStatus: 'visible' });
    const first = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(first.assessment?.kind, 'remote_write_rejected'); assert.ok(first.assessment.nextCheckAt);
    assert.equal(f.control.dispatches, 0); assert.equal(f.jobs.listDueManualRecovery(['upload'], f.control.now).length, 0);
    f.control.now = first.assessment.nextCheckAt; visible = true;
    assert.equal(f.jobs.listDueManualRecovery(['upload'], f.control.now).length, 1);
    assert.equal((await service.assess(job.id, { allowAutomatic: true })).resolved, true);
    assert.equal(f.sessions.get(session.id)?.phase, 'completed'); assert.equal(f.jobs.findById(job.id), null);
  } finally { await f.close(); }
});

test('owned partial upload resumes only never-started pages from the unchanged download snapshot', async t => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'p2.mp4'), 'second');
    const stats = await Promise.all(['v.mp4', 'p2.mp4'].map(file => fs.stat(path.join(f.directory, file))));
    // Windows filesystem timestamps can lead Date.now() slightly. Model the
    // actual sequence: file probe first, transfer session creation afterward.
    const observedAt = Math.ceil(Math.max(Date.now(), ...stats.flatMap(stat => [stat.mtimeMs, stat.ctimeMs])));
    const observed = new Date(observedAt).toISOString();
    t.mock.method(Date, 'now', () => observedAt + 1);
    f.manifest.outputs[0].verifiedAt = observed;
    f.manifest.pages.push({ index: 2, cid: 22, title: 'P2', duration: 1 });
    f.manifest.outputs.push({ ...f.manifest.outputs[0], cid: 22, pageIndex: 2, relativePath: 'p2.mp4', size: 6 }); f.writeManifest();
    const session = f.transfer('partial-resume', true);
    f.sessions.ensureFile(session.id, { relativePath: 'p2.mp4', name: 'p2.mp4', expectedSize: 6 }, session.generation);
    const job = f.enqueue('partial-resume', { sessionId: session.id, sessionGeneration: session.generation, files: ['v.mp4', 'p2.mp4'] });
    const service = f.assessment(async (_config, remote) => remote.endsWith('v.mp4') ? { status: 'verified' } : { status: 'missing', parentStatus: 'visible' });
    const result = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(result.resumed, true, JSON.stringify(result));
    assert.equal(f.jobs.findById(job.id)?.payload.allowReupload, false);
    assert.equal(f.sessions.getFile(session.id, 'v.mp4')?.putAcceptedAt, 100);
    assert.equal(f.sessions.getFile(session.id, 'p2.mp4')?.attempts, 0);
  } finally { await f.close(); }
});

test('partially visible owned PUTs keep read-only review and never create another complete upload candidate', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'p2.mp4'), 'second');
    const session = f.transfer('partial-visibility', true);
    f.sessions.ensureFile(session.id, { relativePath: 'p2.mp4', name: 'p2.mp4', expectedSize: 6 }, session.generation);
    f.sessions.updateFile(session.id, 'p2.mp4', { putAcceptedAt: 100, attempts: 1, status: 'awaiting_remote' }, session.generation);
    const job = f.enqueue('partial-visibility', { sessionId: session.id, sessionGeneration: session.generation, files: ['v.mp4', 'p2.mp4'] });
    const service = f.assessment(async (_config, remote) => remote.endsWith('v.mp4') ? { status: 'verified' } : { status: 'missing', parentStatus: 'visible' });
    const result = await service.assess(job.id, { allowAutomatic: true });
    assert.equal(result.assessment?.kind, 'partial_remote_state'); assert.ok(result.assessment.nextCheckAt);
    assert.equal(result.candidateStarted, undefined); assert.equal(result.resumed, undefined); assert.equal(f.control.dispatches, 0);
  } finally { await f.close(); }
});
