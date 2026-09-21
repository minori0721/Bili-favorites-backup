import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { createVerificationTaskFactory } from '../../src/scheduler/verification-task-factory.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

test('invalid verification evidence is retained under manual recovery; lost leases cannot be parked', async () => {
  const root = await createTestDir('verification-evidence');
  const state = new StateManager({statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'state.sqlite')});
  const jobs = new PersistentJobStore(state.getDatabase());
  const sessions = new TransferSessionStore(state.getDatabase());
  const rejected: string[] = [];
  const build = createVerificationTaskFactory({config: testConfig, sessions, jobs, leaseOwner: 'worker', rejected: job => { rejected.push(job.id); }});
  try {
    const input = {kind: 'verify_upload' as const, dedupeKey: 'verify-invalid', bvid: 'BVINVALID',
      payload: {remoteFile: '/archive/video.mp4', expectedSize: 10, files: ['video.mp4', 42], localDir: '/preserved'}};
    const stored = jobs.enqueue(input);
    const [claimed] = jobs.claimDue(['verify_upload'], 1, 'worker', 60_000);
    assert.ok(claimed);
    assert.equal(build(claimed), null);
    const failed = jobs.findById(stored.id);
    assert.equal(failed?.status, 'manual_wait');
    assert.deepEqual(failed?.payload.files, ['video.mp4', 42]);
    assert.equal(failed?.payload.localDir, '/preserved');
    assert.equal(failed?.payload.verificationPayloadInvalid, true);
    assert.deepEqual(rejected, [stored.id]);
    assert.throws(() => build(claimed), /ownership changed/);
    assert.deepEqual(rejected, [stored.id]);

    jobs.enqueue({...input, dedupeKey: 'verify-valid', payload: {...input.payload, files: ['video.mp4']}});
    const [valid] = jobs.claimDue(['verify_upload'], 1, 'worker', 60_000);
    assert.ok(valid);
    const task = build(valid);
    assert.equal(task?.remoteFile, '/archive/video.mp4');
    assert.equal(task?.persistentJobId, valid.id);
  } finally { state.close(); await removeTestDir(root); }
});
