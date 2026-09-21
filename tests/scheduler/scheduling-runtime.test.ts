import assert from 'node:assert/strict';
import test from 'node:test';
import { createSchedulingRuntime } from '../../src/scheduler/scheduling-runtime.js';

function fixture() {
  let now = 0;
  const state = { busy: false, barrier: false, rebindFailure: false, resumeFailure: false };
  const calls: string[] = [];
  const runtime = createSchedulingRuntime({
    initiallyAccepting: true,
    stopProducers() { calls.push('stop'); }, beginDrain() { calls.push('drain'); },
    busy: () => state.busy,
    releaseWork() { calls.push('release'); }, closeDatabase() { calls.push('close'); },
    canRebind: () => state.barrier && !state.busy,
    rebindAdapters() { calls.push('rebind'); if (state.rebindFailure) throw Error('rebind failed'); },
    resumeAfterRebind() { calls.push('resume'); if (state.resumeFailure) throw Error('projection failed'); },
    clock: { now: () => now, sleep: async ms => { now += ms; } },
  });
  return { runtime, state, calls };
}

test('initialization succeeds once and a failed initialization remains retryable', () => {
  const { runtime } = fixture();
  let attempts = 0;
  assert.throws(() => runtime.initialize(() => { attempts++; throw Error('recovery failed'); }));
  runtime.initialize(() => { attempts++; });
  runtime.initialize(() => { attempts++; });
  assert.equal(attempts, 2);
  runtime.beginShutdown();
  assert.equal(runtime.admit(), false);
});

test('shutdown coalesces, retains leases and database on timeout, and can drain later', async () => {
  const { runtime, state, calls } = fixture();
  state.busy = true;
  const first = runtime.shutdown(30);
  assert.equal(runtime.accepting, false);
  assert.equal(runtime.admit(), false);
  assert.equal(runtime.shutdown(30), first);
  await assert.rejects(first, /database and leases retained/);
  assert.equal(runtime.accepting, false);
  assert.equal(runtime.closed, false);
  assert.equal(runtime.generation, 1);
  assert.deepEqual(calls, ['stop', 'drain']);
  state.busy = false;
  await runtime.shutdown(30);
  assert.equal(runtime.closed, true);
  assert.equal(runtime.generation, 1);
  assert.deepEqual(calls.slice(-2), ['release', 'close']);
  const length = calls.length;
  await runtime.shutdown(); runtime.beginShutdown();
  assert.equal(calls.length, length);
});

test('rebind requires idle maintenance and failures keep admission closed until retry completes', () => {
  const { runtime, state } = fixture();
  assert.throws(() => runtime.rebind(), /maintenance barrier/);
  state.barrier = true; state.rebindFailure = true;
  assert.throws(() => runtime.rebind(), /rebind failed/);
  assert.equal(runtime.accepting, false);
  assert.equal(runtime.admit(), false);
  assert.throws(() => runtime.resume(), /maintenance barrier/);
  state.rebindFailure = false;
  runtime.rebind();
  state.resumeFailure = true;
  assert.throws(() => runtime.resume(), /projection failed/);
  assert.equal(runtime.accepting, false);
  state.resumeFailure = false;
  runtime.resume();
  assert.equal(runtime.accepting, true);
  assert.equal(runtime.rebinding, false);
  assert.equal(runtime.generation, 2);
});

test('shutdown during storage replacement prevents resume from reopening admission', async () => {
  const { runtime, state, calls } = fixture();
  state.barrier = true;
  runtime.rebind();
  runtime.beginShutdown();
  runtime.resume();
  assert.equal(runtime.accepting, false);
  assert.ok(!calls.includes('resume'));
  await runtime.shutdown(0, { closeDatabase: false });
  assert.ok(calls.includes('release'));
  assert.ok(!calls.includes('close'));
});
