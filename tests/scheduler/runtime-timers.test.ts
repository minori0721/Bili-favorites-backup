import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeTimers } from '../../src/scheduler/runtime-timers.js';
import { ManualTime } from '../fixtures/manual-time.js';

test('runtime timers replace registrations and remove one-shot work before callback reentry', () => {
  const time = new ManualTime();
  const timers = createRuntimeTimers(time.schedule);
  const events: string[] = [];
  timers.start('dispatch', () => events.push('obsolete'), 10);
  timers.start('dispatch', () => {
    assert.equal(timers.has('dispatch'), false);
    events.push('first');
    timers.start('dispatch', () => events.push('second'), 10);
  }, 10);
  time.advance(20);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(time.pending, 0);
});

test('stopping producers cancels queued sync while heartbeat survives until draining completes', () => {
  const time = new ManualTime();
  const timers = createRuntimeTimers(time.schedule);
  let heartbeats = 0;
  timers.start('heartbeat', () => { heartbeats++; }, 10, true);
  for (const key of ['projection', 'dispatch', 'uploadProbe', 'downloadStart', 'queuedSync'] as const) {
    timers.start(key, () => assert.fail('Producer ran after stop'), 0);
  }
  timers.stopProducers();
  timers.stopProducers();
  time.advance(20);
  assert.equal(heartbeats, 2);
  timers.dispose();
  timers.dispose();
  time.advance(20);
  assert.equal(heartbeats, 2);
  assert.equal(time.pending, 0);
});

test('callbacks delivered after cancellation or replacement cannot execute', () => {
  const callbacks: Array<() => void> = [];
  const timers = createRuntimeTimers(callback => { callbacks.push(callback); return () => {}; });
  let calls = 0;
  timers.start('dispatch', () => calls++, 0);
  timers.start('dispatch', () => calls++, 0);
  callbacks[0]();
  assert.equal(calls, 0);
  timers.dispose();
  callbacks[1]();
  assert.equal(calls, 0);
});

test('timer adapter registration failure is propagated without retaining an active timer', () => {
  const timers = createRuntimeTimers(() => { throw new Error('Timer unavailable'); });
  assert.throws(() => timers.start('dispatch', () => {}, 0), /Timer unavailable/);
  assert.equal(timers.has('dispatch'), false);
});
