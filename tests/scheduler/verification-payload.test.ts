import { required } from '../contract-values.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerificationPayload } from '../../src/scheduler/verification-payload.js';

test('verification recovery keeps filename evidence and explicit media targets', () => {
  const parsed = parseVerificationPayload({ sessionId: 'session', sessionGeneration: 2,
    files: ['video.mp4'], filenameMetadataByPath: { 'video.mp4': { cid: 123, pageIndex: 1, bilibiliQuality: '4K' } },
    strictMediaTarget: { quality: '4K', encoding: 'HEVC' }, historyOnly: true, historySnapshotAt: 'snapshot' });
  assert.equal(parsed.sessionGeneration, 2);
  assert.equal(required(parsed.filenameMetadataByPath?.['video.mp4']).cid, 123);
  assert.deepEqual(parsed.strictMediaTarget, { quality: '4K', encoding: 'HEVC' });
  assert.equal(parsed.historySnapshotAt, 'snapshot');
});

test('malformed verification evidence is rejected instead of losing files or generation', () => {
  for (const input of [null, [], {files: ['video.mp4', {}]}, {sessionGeneration: Infinity}, {sessionGeneration: 0},
    {filenameMetadataByPath: {'video.mp4': {cid: {}}}}, {filenameMetadataByPath: {bad: []}},
    {historyOnly: 'true'}, {encodingRetry: {}}, {strictMediaTarget: {encoding: 'garbage'}}]) {
    assert.throws(() => parseVerificationPayload(input), /Invalid persisted verification/);
  }
  assert.deepEqual(parseVerificationPayload({}).files, [], 'absence is distinct from invalid evidence');
});
