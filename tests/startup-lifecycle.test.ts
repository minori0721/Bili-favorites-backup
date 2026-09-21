import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupLifecycle, optionalStartupStep } from '../src/startup-lifecycle.js';

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

test('startup exposes success, degradation and critical failure and never opens scheduling after recovery failure', async () => {
  const errors: unknown[] = [];
  let scheduled = false;
  const failure = new Error('database restore failed');
  const startup = createStartupLifecycle([
    {name: 'config', run: () => {}},
    optionalStartupStep('covers', () => { throw new Error('cache offline'); }, error => errors.push(error)),
    {name: 'database', run: () => { throw failure; }},
    {name: 'scheduling', run: () => { scheduled = true; }},
  ]);
  await assert.rejects(startup.start(), error => error === failure);
  assert.equal(scheduled, false);
  assert.equal(errors.length, 1);
  assert.deepEqual(startup.outcomes(), [{name: 'config', status: 'success' as const}, {name: 'covers', status: 'degraded' as const}, {name: 'database', status: 'failed' as const}]);
});
