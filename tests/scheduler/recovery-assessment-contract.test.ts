import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { createRecoveryWork } from '../../src/scheduler/recovery-work.js';
import { createRecoveryAssessmentService } from '../../src/scheduler/recovery-assessment.js';
import { parseExistingArchiveProof, parseRecoveryAssessment, isVerifiedArchiveProofForRecovery, verifiedFilesFromRecovery } from '../../src/scheduler/recovery-projection.js';
import { createRecoveryIssueProjection } from '../../src/scheduler/recovery-issue-projection.js';
import { UploadCircuitBreaker } from '../../src/upload-health.js';
import type { ExistingArchiveProof } from '../../src/upload-preflight.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import type { RemoteContentReader } from '../../src/remote-content-inspection.js';
import type { UploadFileContent } from '../../src/upload-content-proof.js';
import { createRecoveryFinalization } from '../../src/scheduler/recovery-finalization.js';

async function fixture(options: { failCompletion?: boolean; proof?: ExistingArchiveProof; remoteContentReader?: RemoteContentReader;
  localChanged?: boolean; commitContent?: boolean; missingPath?: string } = {}) {
  const directory = await createTestDir('recovery-assessment-contract');
  const state = new StateManager({ statePath: path.join(directory, 'state.json'), dbPath: path.join(directory, 'state.sqlite') });
  const jobs = new PersistentJobStore(state.getDatabase());
  const sessions = new TransferSessionStore(state.getDatabase());
  const work = createRecoveryWork<void>();
  let inspections = 0, finalizations = 0, generation = 0;
  const confirmed: UploadFileContent[] = [];
  const finalizer = createRecoveryFinalization({ stateManager: state, jobStore: jobs, transferSessions: sessions,
    canRun: () => true, now: () => 1000, dispatchPersistentJobs() {}, cleanup: () => assert.fail('changed files have no cleanup authority'),
    resolveRelation: () => null, prepareDownload: () => null, buildLocalCleanupPlan: () => null,
    verifiedFilesFromRecovery: (job, files) => verifiedFilesFromRecovery(job.payload, files) });
  const service = createRecoveryAssessmentService({ jobStore: {
    findById: id => jobs.findById(id), complete: id => options.failCompletion ? false : jobs.complete(id),
  }, transferSessions: sessions,
    configStore: { get: () => testConfig() }, recoveryJobLocks: work.locks, now: () => 1000,
    atomic: fn => state.runAtomic(fn), recoveryAssessment: parseRecoveryAssessment,
    canRun: () => true, generation: () => generation,
    remoteContentReader: options.remoteContentReader,
    rebuildEvidence: async job => ({ kind: 'unchanged', job }), preserveForReprobe: async job => ({ kind: 'unchanged', job }),
    downloadReadiness: () => 'eligible', resumeUpload: () => false,
    captureExistingArchiveProof: () => options.proof, isVerifiedArchiveProofForRecovery: (job, proof) => isVerifiedArchiveProofForRecovery(job.payload, proof),
    updateRecoveryAssessment: (id, assessment) => {
      const job = jobs.findById(id); assert.ok(job); return jobs.updatePayload(id, { ...job.payload, recoveryAssessment: assessment });
    },
    inspectRecoveryLocalFiles: job => {
      const session = sessions.get(String(job.payload.sessionId || ''));
      return { status: options.localChanged ? 'changed' as const : 'available' as const, session, files: session ? sessions.listFiles(session.id, session.generation) : [] };
    },
    remoteFileInspector: async (_config, remotePath) => { inspections++; return { status: remotePath === options.missingPath ? 'missing' as const : 'verified' as const }; },
    persistedExistingArchiveProof: parseExistingArchiveProof,
    finalizeRetainedArchiveRecovery: job => { finalizations++; if (job.payload.failCommit) throw new Error('database commit failed'); return false; },
    finalizeVerifiedRecovery: (_job, _session, files, contents = []) => {
      finalizations++; confirmed.push(...contents);
      verifiedFilesFromRecovery(_job.payload, files);
      if (!options.commitContent) return false;
      return finalizer.finalizeVerifiedRecovery(_job, _session, files, contents);
    },
    startConflictCandidate: () => assert.fail('invalid evidence must not start a candidate'),
    queueFreshDownloadForRecovery: () => assert.fail('invalid evidence must not start a download'),
  });
  const enqueue = (key: string, payload: Record<string, unknown>) => jobs.enqueue({ kind: 'upload', dedupeKey: key,
    bvid: 'BVCONTRACT', userId: 'u', mediaId: 1, initialStatus: 'manual_wait', payload: { awaitingManualRecovery: true, ...payload } });
  return { directory, state, jobs, sessions, service, enqueue, work, confirmed, advance: () => { generation++; }, counts: () => ({ inspections, finalizations }),
    close: async () => { state.close(); await removeTestDir(directory); } };
}

for (const mode of ['match', 'mismatch', 'unsupported', 'legacy', 'old-generation', 'bad-proof', 'stale', 'mixed'] as const) {
  test(`content-based interrupted recovery checks the whole group without fabricating a PUT receipt: ${mode}`, async () => {
    let invalidate = () => {};
    let reads = 0;
    const f = await fixture({ localChanged: true, commitContent: true, missingPath: mode === 'mixed' ? '/a/p2.mp4' : undefined,
      remoteContentReader: async () => { reads++; invalidate(); return mode === 'unsupported' ? null : { size: 12, md5: (mode === 'mismatch' ? 'b' : 'a').repeat(32) }; } });
    try {
      f.state.recordFavoriteItem('u', 1, 'Favorites', { bvid: 'BVCONTRACT', title: 'Fixture', upperName: 'UP' });
      const session = f.sessions.ensure({ dedupeKey: 'content', bvid: 'BVCONTRACT', localDir: f.directory, remotePath: '/a' });
      for (const name of ['p1.mp4', 'p2.mp4']) f.sessions.ensureFile(session.id, { relativePath: name, name, expectedSize: 12 }, session.generation);
      const proof = { sessionId: session.id, generation: session.generation + (mode === 'old-generation' ? 1 : 0), files:
        f.sessions.listFiles(session.id).map(file => ({ relativePath: file.relativePath, finalPath: file.finalPath, size: 12, md5: 'a'.repeat(32) })) };
      const job = f.enqueue('content', { sessionId: session.id, sessionGeneration: session.generation,
        ...(mode === 'legacy' ? {} : { uploadContentProof: mode === 'bad-proof' ? { ...proof, files: [null] } : proof }) });
      if (mode === 'stale') invalidate = f.advance;
      const result = await f.service.assess(job.id, { force: true });
      if (mode === 'match') {
        assert.equal(result.resolved, true); assert.equal(f.jobs.findById(job.id), null);
        assert.equal(f.sessions.get(session.id)?.phase, 'completed'); assert.equal(f.confirmed.length, 2);
        assert.equal(f.state.listRelationsForBvid('BVCONTRACT')[0].backupStatus, 'verified');
      } else {
        assert.equal(result.resolved, undefined); assert.ok(f.jobs.findById(job.id)); assert.equal(f.counts().finalizations, 0);
        if (mode === 'stale') assert.equal(result.stale, true);
        if (mode === 'bad-proof') assert.equal(result.assessment?.kind, 'manual_review');
        if (mode === 'mismatch') assert.match(result.assessment?.summary || '', /内容.*不一致/);
      }
      for (const file of f.sessions.listFiles(session.id)) assert.equal(file.putAcceptedAt, undefined);
      if (['legacy', 'old-generation', 'bad-proof', 'mixed'].includes(mode)) assert.equal(reads, 0);
    } finally { await f.close(); }
  });
}

test('empty and partially damaged candidates remain manual and never trigger inspection or finalization', async () => {
  const f = await fixture();
  try {
    for (const [index, files] of [[], [{ name: 'v', path: '/a/v', size: 1 }, null], [{ name: 'v', path: '/../v', size: 1 }]].entries()) {
      const job = f.enqueue(`bad-${index}`, { conflictCandidate: { files } });
      const result = await f.service.assess(job.id, { force: true, allowAutomatic: true });
      assert.equal(result.assessment?.kind, 'manual_review');
      assert.equal(result.assessment?.remoteStatus, 'unknown');
      assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait');
    }
    assert.deepEqual(f.counts(), { inspections: 0, finalizations: 0 }); assert.equal(f.work.busy, false);
    const good = f.enqueue('good', { conflictCandidate: { files: [{ name: 'v', path: '/a/v', size: 1 }] } });
    assert.equal((await f.service.assess(good.id, { force: true })).assessment?.kind, 'conflict_candidate_ready');
    assert.equal(f.counts().inspections, 1);
  } finally { await f.close(); }
});

test('retained recovery reports the real commit outcome and propagates transaction failures', async () => {
  const f = await fixture();
  try {
    const proof = { status: 'verified', remotePath: '/a', files: [{ name: 'v', path: '/a/v', size: 1 }] };
    const job = f.enqueue('retained', { existingArchiveProof: proof });
    const result = await f.service.assess(job.id, { force: true });
    assert.equal(result.changed, false); assert.equal(result.resolved, false);
    assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait');
    const failed = f.enqueue('failed', { existingArchiveProof: proof, failCommit: true });
    await assert.rejects(f.service.assess(failed.id, { force: true }), /database commit failed/);
    assert.equal(f.work.busy, false);
  } finally { await f.close(); }
});

test('verified transfer reports false finalization and rejects malformed metadata without discarding files', async () => {
  const f = await fixture();
  try {
    const session = f.sessions.ensure({ dedupeKey: 'transfer', bvid: 'BVCONTRACT', localDir: f.directory, remotePath: '/a' });
    f.sessions.ensureFile(session.id, { relativePath: 'v.mp4', name: 'v.mp4', expectedSize: 1 }, session.generation);
    f.sessions.updateFile(session.id, 'v.mp4', { putAcceptedAt: 100 }, session.generation);
    const job = f.enqueue('transfer', { sessionId: session.id, sessionGeneration: session.generation });
    const result = await f.service.assess(job.id, { force: true });
    assert.equal(result.changed, false); assert.equal(result.resolved, false);
    f.jobs.updatePayload(job.id, { ...job.payload, filenameMetadataByPath: { 'v.mp4': { mediaMetadata: {} } } });
    const damaged = await f.service.assess(job.id, { force: true });
    assert.equal(damaged.assessment?.kind, 'manual_review');
    assert.equal(f.sessions.listFiles(session.id).length, 1); assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait');
  } finally { await f.close(); }
});

test('one damaged proof cannot break the issue list or expose unsafe choices', async () => {
  const f = await fixture();
  try {
    const bad = f.enqueue('bad-proof', { existingArchiveProof: { status: 'verified', remotePath: '/a', files: [null] } });
    f.enqueue('bad-path', { existingArchiveProof: { status: 'verified', remotePath: '/a', files: [{ name: 'v', path: '/../v', size: 1 }] } });
    f.enqueue('good-proof', { existingArchiveProof: { status: 'verified', remotePath: '/a', files: [{ name: 'v', path: '/a/v', size: 1 }] } });
    const projection = createRecoveryIssueProjection({ jobs: f.jobs, users: { list: () => [] }, state: f.state,
      uploadCircuit: new UploadCircuitBreaker(), now: () => 1000, isUserSyncEligible: () => true,
      manualRecoveryJobs: () => f.jobs.listManualRecovery(['upload']), manualDownloadRecoveryJobs: () => [],
      recoveryAssessment: parseRecoveryAssessment, inspectConflictCandidateEligibility: () => ({ eligible: true }),
    });
    const snapshot = projection.getRecoveryIssueSnapshot();
    assert.equal(snapshot.issues.length, 1); assert.equal(snapshot.backgroundRecoveries.length, 2);
    const issue = snapshot.backgroundRecoveries.find(item => item.id === `upload.${bad.id}`); assert.ok(issue);
    assert.equal(issue.kind, 'recovery_evidence_wait');
    assert.match(issue.summary, /证据损坏/);
    assert.ok(issue.availableActions.every(action => action.id === 'recheck' || action.id === 'abandon_attempt'));
    assert.equal((await f.service.assess(bad.id, { force: true })).assessment?.kind, 'manual_review');
    assert.ok(projection.getRecoveryIssueSnapshot().actionRequiredIssues.some(item => item.id === issue.id));
  } finally { await f.close(); }
});

for (const failCompletion of [false, true]) {
  test(`empty transfer recovery commits atomically and does not swallow completion failure: ${failCompletion}`, async () => {
    const f = await fixture({ failCompletion, proof: { status: 'verified', remotePath: '/a', verifiedAt: '2026-10-03T00:00:00Z',
      files: [{ name: 'v.mp4', path: '/a/v.mp4', size: 1, verificationStatus: 'verified' }] } });
    try {
      const input = { dedupeKey: 'empty-generation', bvid: 'BVCONTRACT', userId: 'u', mediaId: 1, localDir: f.directory, remotePath: '/a' };
      const old = f.sessions.ensure(input);
      f.sessions.ensureFile(old.id, { relativePath: 'v.mp4', name: 'v.mp4', expectedSize: 1 }, old.generation);
      f.sessions.updateFile(old.id, 'v.mp4', { status: 'verified', putAcceptedAt: 100 }, old.generation);
      f.sessions.updateSession(old.id, { phase: 'completed' }, old.generation);
      const active = f.sessions.ensure(input);
      assert.equal(active.generation, old.generation + 1);
      const job = f.enqueue('empty-generation', { emptyAttempt: true, sessionId: active.id, sessionGeneration: active.generation, remotePath: '/a' });
      if (failCompletion) {
        await assert.rejects(f.service.assess(job.id, { force: true }), /completion failed/);
        assert.equal(f.sessions.get(active.id)?.phase, active.phase);
        assert.equal(f.jobs.findById(job.id)?.status, 'manual_wait');
      } else {
        const result = await f.service.assess(job.id, { force: true });
        assert.equal(result.resolved, true); assert.equal(f.sessions.get(active.id)?.phase, 'superseded');
        assert.equal(f.jobs.findById(job.id), null);
      }
      assert.equal(f.work.busy, false);
    } finally { await f.close(); }
  });
}

test('a fully committed checksum recovery remains reusable after a new empty generation is interrupted', async () => {
  const f = await fixture({ proof: { status: 'verified', remotePath: '/a', verifiedAt: '2026-10-03T00:00:00Z',
    files: [{ name: 'v.mp4', path: '/a/v.mp4', size: 12, verificationStatus: 'verified' }] } });
  try {
    const input = { dedupeKey: 'content-generation', bvid: 'BVCONTRACT', userId: 'u', mediaId: 1, localDir: f.directory, remotePath: '/a' };
    const old = f.sessions.ensure(input);
    f.sessions.ensureFile(old.id, { relativePath: 'v.mp4', name: 'v.mp4', expectedSize: 12 }, old.generation);
    f.sessions.updateFile(old.id, 'v.mp4', { status: 'verified', verifiedAt: 100 }, old.generation);
    f.sessions.updateSession(old.id, { phase: 'completed', completedAt: 100 }, old.generation);
    const next = f.sessions.ensure(input);
    const job = f.enqueue('content-empty', { emptyAttempt: true, sessionId: next.id, sessionGeneration: next.generation, remotePath: '/a' });
    assert.equal((await f.service.assess(job.id, { force: true })).resolved, true);
    assert.equal(f.jobs.findById(job.id), null);
    assert.equal(f.sessions.listFiles(old.id, old.generation)[0].putAcceptedAt, undefined);
  } finally { await f.close(); }
});
