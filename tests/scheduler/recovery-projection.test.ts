import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isVerifiedArchiveProofForRecovery,
  parseExistingArchiveProof,
  parseRecoveryAssessment,
  verifiedFilesFromRecovery,
} from '../../src/scheduler/recovery-projection.js';

test('recovery assessment projection rejects unsafe values and keeps safe diagnostics', () => {
  const assessment = parseRecoveryAssessment({ recoveryAssessment: {
    checkedAt: 100, kind: 'unknown_kind' as const, localStatus: 'bad', remoteStatus: 'bad',
    responseHeaders: { allow: 'GET', authorization: 'secret' },
    responseSnippet: 'x'.repeat(400), summary: 'manual', writeStatus: 500,
  } });
  assert.equal(assessment?.kind, 'manual_review');
  assert.equal(assessment?.localStatus, 'unknown');
  assert.equal(assessment?.remoteStatus, 'unknown');
  assert.deepEqual(assessment?.responseHeaders, { allow: 'GET' });
  assert.equal(assessment?.responseSnippet?.length, 240);
});

test('archive proof rejects a damaged member as a whole instead of filtering it', () => {
  const valid = { name: 'v.mp4', path: '/a/v.mp4', size: 10 };
  for (const files of [[], [valid, null], [valid, { ...valid, size: '10' }], [valid, { ...valid, size: 0 }],
    [valid, { ...valid, verificationStatus: 'yes' }], [valid, { ...valid, mediaMetadata: {} }], [valid, { ...valid, path: '/../v.mp4' }]]) {
    assert.throws(() => parseExistingArchiveProof({ existingArchiveProof: { remotePath: '/a', status: 'verified', files } }), /Invalid persisted JSON/);
  }
  assert.equal(parseExistingArchiveProof({}), null);
  assert.throws(() => parseExistingArchiveProof({ existingArchiveProof: { remotePath: '../a', status: 'verified', files: [valid] } }), /remotePath is invalid/);
});

test('historical optional evidence remains readable without inventing cleanup authorization', () => {
  const proof = parseExistingArchiveProof({ existingArchiveProof: { status: 'verified',
    files: [{ name: 'v.mp4', path: '/a/v.mp4', size: 10 }] } });
  assert.ok(proof); assert.equal(proof.remotePath, '/a');
  assert.equal(proof.files[0].localRelativePath, undefined);
  assert.equal(proof.files[0].putCompletedAt, undefined);
  assert.equal(proof.files[0].verificationStatus, undefined);
  assert.equal(isVerifiedArchiveProofForRecovery({ remotePath: '/a', files: ['v.mp4'] }, proof), false);
  assert.throws(() => parseExistingArchiveProof({ existingArchiveProof: { status: 'verified',
    files: [{ name: 'v.mp4', path: '/a/v.mp4', size: 10 }, { name: 'p.mp4', path: '/b/p.mp4', size: 10 }] } }), /inconsistent directories/);
});

test('provided recovery metadata is decoded and malformed metadata cannot become a verified record', () => {
  assert.throws(() => verifiedFilesFromRecovery({ filenameMetadataByPath: [] }, []), /expected an object/);
});

test('verified archive proof requires matching directory, complete names and positive files', () => {
  const payload = { remotePath: '/archive/BV1', files: ['video.mp4', 'part-1.mp4'] };
  const proof = parseExistingArchiveProof({ existingArchiveProof: {
    remotePath: '/archive/BV1', status: 'verified' as const, verifiedAt: '2026-09-08T00:00:00Z',
    files: [
      { name: 'video.mp4', path: '/archive/BV1/video.mp4', localRelativePath: 'video.mp4', size: 10, verificationStatus: 'verified' as const },
      { name: 'part-1.mp4', path: '/archive/BV1/part-1.mp4', localRelativePath: 'part-1.mp4', size: 20, verificationStatus: 'verified' as const },
    ],
  } });
  assert.ok(proof);
  assert.equal(isVerifiedArchiveProofForRecovery(payload, proof), true);
  assert.equal(isVerifiedArchiveProofForRecovery({ ...payload, remotePath: '/other' }, proof), false);
  assert.equal(isVerifiedArchiveProofForRecovery({ ...payload, files: ['video.mp4'] }, proof), false);
});
