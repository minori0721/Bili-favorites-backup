import assert from 'node:assert/strict';
import test from 'node:test';
import { rowToJob } from '../../src/repositories/job-codec.js';

const row = {
  id: 'job', kind: 'download' as const, dedupe_key: 'download:BVTEST', bvid: 'BVTEST',
  user_id: null, media_id: null, status: 'pending' as const, priority: 0,
  payload_json: '{"localDir":"/only-copy"}', attempts: 0, max_attempts: 3,
  not_before: 0, lease_owner: null, lease_expires_at: null, last_error: null,
  created_at: 100, updated_at: 100,
};

test('persisted job decoding retains zero priority and explicit optional fields', () => {
  const job = rowToJob(row);
  assert.equal(job.priority, 0);
  assert.equal(job.notBefore, 0);
  assert.equal(job.mediaId, undefined);
  assert.equal(job.payload.localDir, '/only-copy');
  assert.equal(rowToJob({...row, status: 'completed' as const}).status, 'completed');
});

test('persisted job decoding rejects malformed fields instead of manufacturing defaults', () => {
  for (const patch of [
    {status: 'unknown' as const}, {id: undefined}, {priority: '10'}, {attempts: null},
    {not_before: Number.NaN}, {lease_expires_at: '100'}, {media_id: 1.5},
    {payload_json: 'null'}, {payload_json: '[]'}, {payload_json: '{broken'},
  ]) {
    assert.throws(() => rowToJob({...row, ...patch}));
  }
  assert.throws(() => rowToJob(null));
});
