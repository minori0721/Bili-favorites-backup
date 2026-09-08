import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isVerifiedArchiveProofForRecovery,
  parseExistingArchiveProof,
  parseRecoveryAssessment,
} from '../../src/scheduler/recovery-projection.js';

test('recovery assessment projection rejects unsafe values and keeps safe diagnostics', () => {
  const assessment = parseRecoveryAssessment({ recoveryAssessment: {
    checkedAt: 100, kind: 'unknown_kind', localStatus: 'bad', remoteStatus: 'bad',
    responseHeaders: { allow: 'GET', authorization: 'secret' },
    responseSnippet: 'x'.repeat(400), summary: 'manual', writeStatus: 500,
  } });
  assert.equal(assessment?.kind, 'manual_review');
  assert.equal(assessment?.localStatus, 'unknown');
  assert.equal(assessment?.remoteStatus, 'unknown');
  assert.deepEqual(assessment?.responseHeaders, { allow: 'GET' });
  assert.equal(assessment?.responseSnippet?.length, 240);
});

test('verified archive proof requires matching directory, complete names and positive files', () => {
  const payload = { remotePath: '/archive/BV1', files: ['video.mp4', 'part-1.mp4'] };
  const proof = parseExistingArchiveProof({ existingArchiveProof: {
    remotePath: '/archive/BV1', status: 'verified', verifiedAt: '2026-09-08T00:00:00Z',
    files: [
      { name: 'video.mp4', path: '/archive/BV1/video.mp4', localRelativePath: 'video.mp4', size: 10, verificationStatus: 'verified' },
      { name: 'part-1.mp4', path: '/archive/BV1/part-1.mp4', localRelativePath: 'part-1.mp4', size: 20, verificationStatus: 'verified' },
    ],
  } });
  assert.ok(proof);
  assert.equal(isVerifiedArchiveProofForRecovery(payload, proof), true);
  assert.equal(isVerifiedArchiveProofForRecovery({ ...payload, remotePath: '/other' }, proof), false);
  assert.equal(isVerifiedArchiveProofForRecovery({ ...payload, files: ['video.mp4'] }, proof), false);
});
