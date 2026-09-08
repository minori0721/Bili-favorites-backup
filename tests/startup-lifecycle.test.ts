import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupLifecycle } from '../src/startup-lifecycle.js';

test('startup is ordered and idempotent and stop prevents later steps without pretending to drain', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const startup = createStartupLifecycle([
    async () => { calls.push('first'); await pending; calls.push('settled'); },
    () => { calls.push('second'); },
  ]);
  const work = startup.start();
  assert.equal(startup.start(), work);
  startup.stop();
  assert.equal(await startup.waitForIdle(0), false);
  release();
  await work;
  assert.equal(await startup.waitForIdle(0), true);
  await startup.start();
  assert.deepEqual(calls, ['first', 'settled']);
});

test('startup failure prevents dependent recovery and remains observable to its caller', async () => {
  let ran = false;
  const startup = createStartupLifecycle([
    () => { throw new Error('recovery evidence missing'); },
    () => { ran = true; },
  ]);
  await assert.rejects(startup.start(), /evidence missing/);
  assert.equal(ran, false);
  assert.equal(await startup.waitForIdle(0), true);
});
