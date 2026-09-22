import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistentJobRecord } from '../../src/database.js';
import { createQualityRecoveryAdmission } from '../../src/scheduler/quality-recovery-admission.js';

const job = {
  id: 'quality-job', kind: 'quality_download', dedupeKey: 'quality:BV1', bvid: 'BV1',
  status: 'pending', priority: 10, payload: {}, attempts: 0, maxAttempts: 3,
  notBefore: 0, createdAt: 1, updatedAt: 1,
} satisfies PersistentJobRecord;

test('quality recovery logs a persisted pause and refuses to build an ambiguous task', () => {
  const parked: string[] = [];
  const logs: Array<{summary: string}> = [];
  const admission = createQualityRecoveryAdmission({
    build: () => { throw new Error('invalid recovery proof'); },
    park: (jobId) => { parked.push(jobId); return true; },
    now: () => 0,
    log: entry => { logs.push({summary: entry.summary}); },
  });
  assert.equal(admission.build(job), null);
  assert.deepEqual(parked, ['quality-job']);
  assert.match(logs[0].summary, /已暂停/);
});

test('quality recovery propagates when the paused state cannot be persisted', () => {
  const logs: Array<{summary: string}> = [];
  const admission = createQualityRecoveryAdmission({
    build: () => { throw new Error('invalid recovery proof'); },
    park: () => false,
    now: () => 0,
    log: entry => { logs.push({summary: entry.summary}); },
  });
  assert.throws(() => admission.build(job), /Failed to persist the paused quality recovery state/);
  assert.deepEqual(logs, []);
});
