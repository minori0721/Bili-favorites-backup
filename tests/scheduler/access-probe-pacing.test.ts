import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createAccessProbeWorkflow } from '../../src/scheduler/access-probe-workflow.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { createTestDir, removeTestDir } from '../helpers.js';

for (const stopAfterFirst of [false, true]) {
  test(`access probes ${stopAfterFirst ? 'cancel a pending paced wake on stop' : 'pace consecutive videos'}`, async () => {
    const runtime = await createTestDir('access-probe-pacing');
    const state = new StateManager({statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite')});
    const jobs = new PersistentJobStore(state.getDatabase());
    jobs.enqueue({kind: 'access_probe', dedupeKey: 'access_probe:BVPACE1', bvid: 'BVPACE1'});
    jobs.enqueue({kind: 'access_probe', dedupeKey: 'access_probe:BVPACE2', bvid: 'BVPACE2'});
    const starts: number[] = [];
    let workflow: ReturnType<typeof createAccessProbeWorkflow>;
    workflow = createAccessProbeWorkflow({
      jobs, owner: 'pacing-test', now: Date.now, generation: () => 0,
      accepting: () => true, shuttingDown: () => false, minIntervalMs: 60,
      run: async (job) => {
        starts.push(Date.now());
        assert.equal(jobs.complete(job.id, 'pacing-test'), true);
      },
      failed: (_job, error) => { throw error; },
      wake: () => { if (stopAfterFirst) workflow.stop(); workflow.dispatch(); },
      sleep: async () => {},
    });
    try {
      workflow.start();
      workflow.dispatch();
      await new Promise((resolve) => setTimeout(resolve, 160));
      assert.equal(starts.length, stopAfterFirst ? 1 : 2);
      if (!stopAfterFirst) assert.ok(starts[1] - starts[0] >= 50);
    } finally { workflow.stop(); state.close(); await removeTestDir(runtime); }
  });
}
