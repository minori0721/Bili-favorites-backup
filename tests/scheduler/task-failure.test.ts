import assert from 'node:assert/strict';
import test from 'node:test';
import { readTaskFailure, taskUploadFailure } from '../../src/scheduler/task-failure.js';

test('task error boundary preserves Error messages and validates control flags', () => {
  const error = Object.assign(new Error('failed'), { permanent: true, retryAfterMs: 100, qualityValidation: 'true' });
  assert.equal(readTaskFailure(error).message, 'failed');
  assert.equal(readTaskFailure(error).permanent, true);
  assert.equal(readTaskFailure(error).qualityValidation, false);
  assert.equal(readTaskFailure(error).retryAfterMs, 100);
  assert.equal(readTaskFailure({ retryAfterMs: Infinity }).retryAfterMs, undefined);
});

test('preclassified upload failures retain conflict and backend evidence', () => {
  const uploadFailure = { category: 'deterministic' as const, summary: 'conflict', status: 409,
    code: 'CONFLICT', remotePath: '/a', retryable: false, fingerprint: 'conflict-a',
    remoteWriteEvidence: 'target_missing_parent_visible' as const, remoteWriteStatus: 405,
    remoteParentStatus: 'visible' as const, responseHeaders: { allow: 'GET' } };
  const result = taskUploadFailure({ uploadFailure }, 'BV1');
  for (const [key, value] of Object.entries(uploadFailure)) assert.deepEqual(Reflect.get(result, key), value);
});
