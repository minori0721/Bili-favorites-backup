import assert from 'node:assert/strict';
import test from 'node:test';
import { createPollingSchedule } from '../../src/scheduler/polling.js';

function fixture(random = 0.5) {
  let now = 1000;
  let runs = 0;
  const timers: Array<{ callback: () => void; delay: number; recurring: boolean; cancelled: boolean }> = [];
  const polling = createPollingSchedule({
    now: () => now,
    random: () => random,
    run: () => { runs += 1; },
    schedule: (callback, delay, recurring) => {
      const timer = { callback, delay, recurring, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return { polling, timers, runs: () => runs, setNow: (value: number) => { now = value; } };
}

test('polling preserves startup jitter and interval while repeated start is idempotent', () => {
  const { polling, timers, runs, setNow } = fixture();
  assert.equal(polling.getNextRunAt(), undefined);
  assert.equal(polling.start(300_000), true);
  assert.equal(polling.start(300_000), false);
  assert.deepEqual(timers.map(({delay, recurring}) => ({delay, recurring})), [
    { delay: 300_000, recurring: true }, { delay: 75_000, recurring: false },
  ]);
  assert.equal(polling.getNextRunAt(), 76_000);
  setNow(76_000);
  timers[1].callback();
  assert.equal(runs(), 1);
  assert.equal(polling.getNextRunAt(), 301_000);
  setNow(301_000);
  timers[0].callback();
  assert.equal(runs(), 2);
  assert.equal(polling.getNextRunAt(), 601_000);
  polling.stop();
  assert.equal(polling.getNextRunAt(), undefined);
});

test('polling reports whichever scheduled attempt comes first when the interval precedes startup jitter', () => {
  const { polling, timers, runs, setNow } = fixture();
  polling.start(40_000);
  assert.equal(polling.getNextRunAt(), 41_000);
  setNow(41_000);
  timers[0].callback();
  assert.equal(runs(), 1);
  assert.equal(timers[1].cancelled, true);
  assert.equal(polling.getNextRunAt(), 81_000);
  setNow(76_000);
  timers[1].callback();
  assert.equal(runs(), 1);
  assert.equal(polling.getNextRunAt(), 81_000);
  polling.stop();
});

test('polling cancels a late startup jitter after the interval has already run', () => {
  const { polling, timers, runs, setNow } = fixture(0.99);
  polling.start(60_000);
  assert.equal(polling.getNextRunAt(), 61_000);
  setNow(61_000);
  timers[0].callback();
  assert.equal(runs(), 1);
  assert.equal(timers[1].cancelled, true);
  setNow(120_000);
  timers[1].callback();
  assert.equal(runs(), 1);
  polling.stop();
});

test('reschedule and stop invalidate callbacks already queued by the timer provider', () => {
  const { polling, timers, runs } = fixture();
  polling.start(300_000);
  polling.start(600_000);
  assert.ok(timers.slice(0, 2).every(timer => timer.cancelled));
  timers[0].callback();
  timers[1].callback();
  assert.equal(runs(), 0);
  timers[2].callback();
  assert.equal(runs(), 1);
  polling.stop();
  polling.stop();
  assert.ok(timers.every(timer => timer.cancelled));
  timers[2].callback();
  timers[3].callback();
  assert.equal(runs(), 1);
  assert.equal(polling.start(600_000), true);
  timers[3].callback();
  timers[5].callback();
  assert.equal(runs(), 2);
  polling.stop();
});
