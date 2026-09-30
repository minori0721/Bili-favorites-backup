import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createAccessProbeWorkflow } from '../../src/scheduler/access-probe-workflow.js';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { createTestDir, removeTestDir } from '../helpers.js';

for (const stopAfterFirst of [false, true]) {
  test(`request pacing ${stopAfterFirst ? 'stops before another request' : 'spans accounts, fallback calls and consecutive videos'}`, async () => {
    const runtime = await createTestDir('access-probe-pacing');
    const state = new StateManager({statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite')});
    const jobs = new PersistentJobStore(state.getDatabase());
    jobs.enqueue({kind: 'access_probe', dedupeKey: 'access_probe:BVPACE1', bvid: 'BVPACE1'});
    jobs.enqueue({kind: 'access_probe', dedupeKey: 'access_probe:BVPACE2', bvid: 'BVPACE2'});
    const starts: number[] = [], waits: number[] = [];
    let clock = Date.now(), completed = 0;
    const initial = clock;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let workflow: ReturnType<typeof createAccessProbeWorkflow>;
    workflow = createAccessProbeWorkflow({
      jobs, owner: 'pacing-test', now: () => clock, generation: () => 0,
      accepting: () => true, shuttingDown: () => false, requestIntervalMs: 10_000,
      run: async (job, beforeRequest) => {
        for (let i = 0; i < 2; i++) {
          await beforeRequest(() => {});
          starts.push(clock);
          clock += 100;
        }
        assert.equal(jobs.complete(job.id, 'pacing-test'), true);
        completed++;
      },
      failed: (_job, error) => { throw error; },
      wake: () => { if (stopAfterFirst) workflow.stop(); if (stopAfterFirst || completed === 2) finish(); else workflow.dispatch(); },
      sleep: async ms => { waits.push(ms); clock += ms; },
    });
    try {
      workflow.start();
      workflow.dispatch();
      await done;
      assert.deepEqual(starts.map(at => at - initial), stopAfterFirst ? [0, 10_000] : [0, 10_000, 20_000, 30_000]);
      assert.deepEqual(waits, stopAfterFirst ? [9_900] : [9_900, 9_900, 9_900]);
    } finally { workflow.stop(); state.close(); await removeTestDir(runtime); }
  });
}

test('stop during request pacing keeps the operation busy until its wait settles', async () => {
  const root = await createTestDir('probe-stop-wait');
  const state = new StateManager({ statePath: path.join(root, 'state.json'), dbPath: path.join(root, 'bfb.sqlite') });
  const jobs = new PersistentJobStore(state.getDatabase());
  jobs.enqueue({ kind: 'access_probe', dedupeKey: 'probe:stop' });
  let clock = Date.now(), requests = 0;
  let release!: () => void, waiting!: () => void, finish!: () => void;
  const start = new Promise<void>(resolve => { waiting = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const workflow = createAccessProbeWorkflow({ jobs, owner: 'pacing-test', now: () => clock, generation: () => 0,
    accepting: () => true, shuttingDown: () => false, requestIntervalMs: 10_000,
    sleep: async ms => { waiting(); await wait; clock += ms; },
    run: async (_job, beforeRequest) => { await beforeRequest(() => {}); requests++; await beforeRequest(() => {}); requests++; },
    failed: () => assert.fail('stopping must not record an external failure'), wake: finish });
  try {
    workflow.dispatch(); await start; workflow.stop();
    assert.equal(workflow.isBusy(), true); assert.throws(() => workflow.resetAfterRebind(), /active/);
    release(); await done;
    assert.equal(requests, 1); assert.equal(workflow.isIdle(), true);
    assert.equal(jobs.list(['access_probe'], 10)[0].status, 'running');
  } finally { workflow.stop(); release(); state.close(); await removeTestDir(root); }
});
