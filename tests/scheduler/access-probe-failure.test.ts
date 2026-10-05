import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { AccessProbeStateError, createAccessProbeWorkflow } from '../../src/scheduler/access-probe-workflow.js';
import { createAccessProbes } from '../../src/scheduler/access-probes.js';
import { createTestDir, removeTestDir } from '../helpers.js';

for (const failure of ['retry-write', 'run-write', 'read', 'wake', 'external'] as const) {
  test(`probe ${failure} failure has an owned error boundary and retains durable recovery`, async () => {
    const root = await createTestDir('probe-failure');
    const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'bfb.sqlite') });
    const owner = 'probe-contract'; let clock = Date.now(), accepting = true, wakes = 0;
    const jobs = new PersistentJobStore(state.getDatabase(), { now: () => clock });
    const fatal: unknown[] = [];
    state.recordFavoriteItem('u1', 1, 'Fake', { bvid: 'BVPROBE', title: 'Fake', upperName: 'Fake' });
    const job = jobs.enqueue({ kind: 'access_probe', dedupeKey: 'probe:failure', bvid: 'BVPROBE', payload: { intents: ['availability'] } });
    const probes = createAccessProbes({ state, jobs, owner, now: () => clock, random: () => 0.5,
      generation: () => 0, canContinue: () => accepting, users: { list: () => [] }, eligible: () => true,
      inspect: async () => assert.fail('no external requests'), resolve: () => null, prepareAfterAccessCheck: () => null });
    if (failure === 'retry-write' || failure === 'run-write') state.getDatabase().db.exec(`CREATE TRIGGER contract_retry_failure BEFORE UPDATE ON jobs
      WHEN NEW.status='retry_wait' BEGIN SELECT RAISE(ABORT, 'injected retry write failure'); END`);
    const workflow = createAccessProbeWorkflow({ owner, now: () => clock, generation: () => 0,
      accepting: () => accepting, shuttingDown: () => false, sleep: async ms => { await new Promise(resolve => setTimeout(resolve, 1)); clock += ms; },
      jobs: { claimDue: jobs.claimDue.bind(jobs), markRunning: jobs.markRunning.bind(jobs), extendLease: jobs.extendLease.bind(jobs),
        findById: id => { if (failure === 'read') throw new Error('injected read failure'); return jobs.findById(id); } },
      run: async (claimed, gate) => {
        if (failure === 'run-write') { await probes.availability(claimed, gate); return; }
        if (failure !== 'wake') throw new Error('external timeout');
      },
      failed: (claimed, error) => probes.failed(claimed, error),
      fatal: error => { fatal.push(error); accepting = false; assert.equal(workflow.isBusy(), failure !== 'wake'); },
      wake: () => { if (failure === 'wake') throw new Error('injected wake failure'); wakes++; },
    });
    try {
      workflow.dispatch();
      assert.equal(await workflow.waitForIdle(), true);
      if (failure === 'external') {
        assert.deepEqual(fatal, []); assert.equal(wakes, 1);
        assert.equal(jobs.findById(job.id)?.status, 'retry_wait');
        assert.equal(jobs.findById(job.id)?.leaseOwner, undefined);
        assert.equal(state.getSourceAvailability('BVPROBE')?.state, 'unknown');
      } else {
        assert.equal(fatal.length, 1); assert.equal(accepting, false); assert.equal(wakes, 0);
        assert.equal(jobs.findById(job.id)?.status, 'running');
        workflow.dispatch();
        assert.equal(fatal.length, 1);
        state.getDatabase().db.exec('DROP TRIGGER IF EXISTS contract_retry_failure');
        clock += 300_001;
        jobs.recoverExpiredLeases(clock);
        assert.equal(jobs.claimDue(['access_probe'], 1, 'restarted-owner', 300_000, clock)[0]?.id, job.id);
      }
    } finally { workflow.stop(); state.getDatabase().db.exec('DROP TRIGGER IF EXISTS contract_retry_failure'); state.close(); await removeTestDir(root); }
  });
}

for (const change of ['generation', 'same-owner-lease', 'new-owner-lease'] as const) {
test(`late rejected probe after ${change} neither retries nor stops the new execution`, async () => {
  const root = await createTestDir('probe-late-error');
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'bfb.sqlite') });
  const jobs = new PersistentJobStore(state.getDatabase());
  const job = jobs.enqueue({ kind: 'access_probe', dedupeKey: 'probe:late' });
  let generation = 0, reject!: (error: Error) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const workflow = createAccessProbeWorkflow({ jobs, owner: 'probe-contract', now: Date.now,
    generation: () => generation, accepting: () => true, shuttingDown: () => false,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), run: async () => { started(); await pending; },
    failed: () => assert.fail('old generation cannot record retries'), fatal: () => assert.fail('old result is not a critical failure'),
    wake: () => assert.fail('old generation cannot wake scheduling') });
  try {
    workflow.dispatch(); await ready;
    if (change === 'generation') generation++;
    else {
      jobs.retry(job.id, 'probe-contract', 'replacement', Date.now());
      assert.ok(jobs.claimByDedupeKey(job.dedupeKey, change === 'same-owner-lease' ? 'probe-contract' : 'new-owner'));
    }
    const current = jobs.findById(job.id);
    reject(new AccessProbeStateError(new Error('late operation')));
    assert.equal(await workflow.waitForIdle(), true);
    assert.deepEqual(jobs.findById(job.id), current);
  } finally { workflow.stop(); state.close(); await removeTestDir(root); }
});
}
