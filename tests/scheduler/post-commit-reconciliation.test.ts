import assert from 'node:assert/strict';
import test from 'node:test';
import { runPostCommitReconciliation } from '../../src/scheduler/post-commit-reconciliation.js';

test('post-commit reconciliation returns an observable degraded result', async () => {
  const failure = new Error('remote proof unavailable');
  const result = await runPostCommitReconciliation(async () => { throw failure; });
  assert.deepEqual(result, { ok: false, error: failure });
});

test('post-commit reconciliation reports successful convergence', async () => {
  let completed = false;
  const result = await runPostCommitReconciliation(async () => { completed = true; });
  assert.deepEqual(result, { ok: true });
  assert.equal(completed, true);
});
