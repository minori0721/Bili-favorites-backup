import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerificationPayload } from '../../src/scheduler/verification-payload.js';

test('verification recovery keeps filename evidence and explicit media targets', () => {
  const parsed = parseVerificationPayload({ sessionId: 'session', sessionGeneration: 2,
    files: ['video.mp4'], filenameMetadataByPath: { 'video.mp4': { cid: 123, pageIndex: 1, bilibiliQuality: '4K' } },
    strictMediaTarget: { quality: '4K', encoding: 'HEVC' }, historyOnly: true, historySnapshotAt: 'snapshot' });
  assert.equal(parsed.sessionGeneration, 2);
  assert.equal(parsed.filenameMetadataByPath?.['video.mp4'].cid, 123);
  assert.deepEqual(parsed.strictMediaTarget, { quality: '4K', encoding: 'HEVC' });
  assert.equal(parsed.historySnapshotAt, 'snapshot');
});

test('malformed verification metadata cannot become a file or a session generation', () => {
  const parsed = parseVerificationPayload({ files: ['video.mp4', {}], sessionGeneration: Infinity,
    filenameMetadataByPath: { 'video.mp4': { cid: {}, publishDate: NaN }, bad: [] }, historyOnly: 'true' });
  assert.deepEqual(parsed.files, ['video.mp4']);
  assert.equal(parsed.sessionGeneration, undefined);
  assert.equal(parsed.filenameMetadataByPath?.['video.mp4'].cid, undefined);
  assert.equal(parsed.filenameMetadataByPath?.bad, undefined);
  assert.equal(parsed.historyOnly, false);
});
