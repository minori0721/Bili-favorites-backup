import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryWork } from '../../src/scheduler/recovery-work.js';

test('recovery ownership publishes one assessment before synchronous reentry', async () => {
  const work = createRecoveryWork<number>();
  let calls = 0;
  let duplicate: Promise<number> | undefined;
  const first = work.run('job', async () => {
    calls++;
    duplicate = work.run('job', async () => 9);
    return 3;
  });
  assert.equal(work.busy, true);
  assert.equal(await first, 3);
  assert.equal(duplicate, first);
  assert.equal(calls, 1);
  assert.equal(work.busy, false);
});

test('manual recovery locks keep shutdown busy after an assessment settles', async () => {
  const work = createRecoveryWork<void>();
  work.locks.add('manual');
  await work.run('assessment', async () => {});
  assert.equal(work.busy, true);
  work.locks.delete('manual');
  assert.equal(work.busy, false);
});

test('a rejected assessment releases its slot without removing another action lock', async () => {
  const work = createRecoveryWork<number>();
  work.locks.add('manual');
  await assert.rejects(work.run('job', async () => { throw new Error('remote'); }), /remote/);
  assert.equal(work.locks.has('manual'), true);
  assert.equal(await work.run('job', async () => 7), 7);
  work.locks.delete('manual');
  assert.equal(work.busy, false);
});
