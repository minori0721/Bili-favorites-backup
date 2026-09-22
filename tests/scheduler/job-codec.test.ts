import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBvidProjectionRow,
  decodeAttemptsRow,
  decodeCountAndNextAtRow,
  decodeCountRow,
  decodeJobRetryRow,
  decodeNextAtRow,
  decodePayloadRow,
  decodeSessionIdentityRow,
  rowToJob,
} from '../../src/repositories/job-codec.js';

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

test('SQL projections reject invalid aggregate, schedule and session identities', () => {
  assert.deepEqual(decodeCountRow({ count: 0 }, 'count'), { count: 0 });
  assert.deepEqual(decodeCountAndNextAtRow({ count: 2, next_at: null }, 'schedule'), { count: 2, next_at: null });
  assert.deepEqual(decodeSessionIdentityRow({ session_id: 'session', session_generation: 1 }, 'session'), {
    session_id: 'session', session_generation: 1,
  });
  assert.deepEqual(decodeSessionIdentityRow({ session_id: 'legacy', session_generation: null, legacy_generation: 1 }, 'legacy session'), {
    session_id: 'legacy', session_generation: 1,
  });
  assert.deepEqual(decodeNextAtRow({ next_at: null }, 'empty schedule'), { next_at: null });
  assert.deepEqual(decodeNextAtRow({ next_at: 10 }, 'schedule'), { next_at: 10 });
  assert.deepEqual(decodeAttemptsRow({ attempts: 0 }, 'attempts'), { attempts: 0 });
  assert.deepEqual(decodePayloadRow({ payload_json: '{}' }, 'payload'), { payload_json: '{}' });
  assert.deepEqual(decodeJobRetryRow({ kind: 'download', attempts: 0, max_attempts: 3 }, 'retry'), {
    kind: 'download', attempts: 0, max_attempts: 3,
  });
  assert.deepEqual(decodeBvidProjectionRow({ bvid: 'BV1' }, 'bvid'), { bvid: 'BV1' });
  assert.throws(() => decodeCountRow({ count: -1 }, 'count'));
  assert.throws(() => decodeCountRow({ count: '2' }, 'count'));
  assert.throws(() => decodeCountAndNextAtRow({ count: 1, next_at: -1 }, 'schedule'));
  assert.throws(() => decodeNextAtRow({ next_at: '10' }, 'schedule'));
  assert.throws(() => decodeNextAtRow({}, 'schedule'));
  assert.throws(() => decodeAttemptsRow({ attempts: -1 }, 'attempts'));
  assert.throws(() => decodePayloadRow({ payload_json: null }, 'payload'));
  assert.throws(() => decodeJobRetryRow({ kind: '', attempts: 0, max_attempts: 3 }, 'retry'));
  assert.throws(() => decodeJobRetryRow({ kind: 'download', attempts: 0, max_attempts: 0 }, 'retry'));
  assert.throws(() => decodeSessionIdentityRow({ session_id: 'session', session_generation: 0 }, 'session'));
  assert.throws(() => decodeSessionIdentityRow({ session_id: 'session', session_generation: null }, 'current session'));
  assert.throws(() => decodeSessionIdentityRow({ session_id: 'session', session_generation: '1', legacy_generation: 0 }, 'current session'));
  assert.throws(() => decodeSessionIdentityRow({ session_id: '', session_generation: 1 }, 'session'));
  assert.throws(() => decodeBvidProjectionRow({ bvid: '' }, 'bvid'));
  assert.throws(() => decodeBvidProjectionRow({ bvid: 1 }, 'bvid'));
});
