import { required } from '../contract-values.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test('job recovery never replaces corrupted evidence with an empty payload', async () => {
  const root = await createTestDir('job-corruption');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  const db = state.getDatabase().db;
  try {
    const job = jobs.enqueue({kind: 'upload' as const, dedupeKey: 'corruption', maxAttempts: 1, payload: {localDir: '/only-copy'}});
    jobs.claimDue(['upload'], 1, 'worker', 60_000);
    const read = () => db.prepare<[string], {payload_json: string; status: string; lease_owner: string}>('SELECT payload_json, status, lease_owner FROM jobs WHERE id=?').get(job.id);
    for (const raw of ['null', '[]', '"invalid"', '{broken']) {
      db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(raw, job.id);
      const before = read();
      assert.throws(() => jobs.findById(job.id));
      assert.throws(() => jobs.parkManualRecovery(job.id, 'worker', 'failed'));
      assert.deepEqual(read(), before);
      assert.throws(() => jobs.retry(job.id, 'worker', 'failed', Date.now()));
      assert.deepEqual(read(), before);
      assert.throws(() => jobs.updateEncodingRetry(job.id, 1, {state: 'failed' as const}));
      assert.deepEqual(read(), before);
    }
  } finally { state.close(); await removeTestDir(root); }
});

test('terminal recovery normalization is atomic when one payload is damaged', async () => {
  const root = await createTestDir('job-normalization-corruption');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  const db = state.getDatabase().db;
  try {
    const valid = jobs.enqueue({kind: 'upload' as const, dedupeKey: 'valid', payload: {localDir: '/valid'}});
    const damaged = jobs.enqueue({kind: 'upload' as const, dedupeKey: 'damaged', payload: {localDir: '/only-copy'}});
    db.prepare("UPDATE jobs SET status='failed'").run();
    for (const raw of ['null', '[]', '{broken']) {
      db.prepare('UPDATE jobs SET payload_json=? WHERE id=?').run(raw, damaged.id);
      assert.throws(() => jobs.normalizeTerminalUploadRecovery());
      assert.equal(required(jobs.findById(valid.id)?.payload).awaitingManualRecovery, undefined);
      const persisted = db.prepare<[string], {payload_json: string}>('SELECT payload_json FROM jobs WHERE id=?').get(damaged.id);
      assert.equal(persisted?.payload_json, raw);
    }
  } finally { state.close(); await removeTestDir(root); }
});
