import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecoveryIssuePayload } from '../../src/scheduler/recovery-issue-payload.js';
import { uploadRecoverySummary } from '../../src/scheduler/recovery-issue-projection.js';

test('persisted recovery display rejects malformed fields and never grants retry from truthy strings', () => {
  const value = parseRecoveryIssuePayload({
    videoTitle: {}, mediaId: Infinity, qualityStrict: 'true',
    qualityFailure: { qualityEligible: 'true', encodingEligible: 1, actualEncodings: ['HEVC', {}], requestedEncoding: 'bad' },
    qualityEncodingOverride: { strict: 'true', priority: ['bad', 'HEVC'] },
  });
  assert.equal(value.videoTitle, undefined);
  assert.equal(value.mediaId, undefined);
  assert.equal(value.qualityStrict, undefined);
  assert.equal(value.qualityFailure?.qualityEligible, undefined);
  assert.equal(value.qualityFailure?.encodingEligible, undefined);
  assert.equal(value.qualityFailure?.actualEncodings, undefined);
  assert.deepEqual(value.qualityEncodingOverride.priority, ['HEVC']);
});

test('display and execution share whole-proof validation and keep independent records usable', () => {
  const file = { name: 'v.mp4', path: '/a/v.mp4', size: 10 };
  const records = [{ existingArchiveProof: { status: 'verified', remotePath: '/a', files: [file, null] } },
    { existingArchiveProof: { status: 'verified', remotePath: '/a', files: [file] } }].map(parseRecoveryIssuePayload);
  assert.equal(records[0].existingArchiveProof, undefined);
  assert.match(records[0].evidenceError || '', /files\[1\]/);
  assert.deepEqual(records[1].existingArchiveProof?.files, [file]);
  assert.equal(records[1].evidenceError, undefined);
});

test('recovery display preserves raw proof and target identity for dedicated validators', () => {
  const target = { userId: 'u', mediaId: -1, remotePath: '/a', folderTitle: 'manual' };
  const proof = { status: 'verified' as const, remotePath: '/a', files: [{ name: 'proof.mp4', path: '/a/proof.mp4', size: 1, verificationStatus: 'verified' as const }] };
  const value = parseRecoveryIssuePayload({
    target, existingArchiveProof: proof, totalPages: 2,
    qualityFailure: { qualityEligible: true, requestedQuality: '4K', actualQualities: ['1080P'] },
  });
  assert.deepEqual(value.existingArchiveProof, proof);
  assert.deepEqual(value.target, target);
  assert.equal(value.qualityFailure?.qualityEligible, true);
  assert.equal(uploadRecoverySummary('manual_review', null, null, 'waiting'), 'waiting');
});
