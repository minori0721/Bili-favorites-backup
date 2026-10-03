import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDownloadProgressSampler, readDownloadDirectorySize } from '../src/download-progress.js';
import { createTestDir, removeTestDir } from './helpers.js';

const policy = { sampleIntervalMs: 1000, minRuntimeMs: 0, windowMs: 10_000, minBytesPerSecond: 1 };

test('failed size measurements invalidate the window instead of creating zero-byte progress', async () => {
  let now = 0, size = 100, failing = false, warnings = 0, stops = 0;
  const sampler = createDownloadProgressSampler({ startedAt: 0, now: () => now,
    readSize: async () => { if (failing) throw new Error('unreadable'); return size; },
    onSamplingFailure: () => { warnings++; }, onLowSpeed: () => { stops++; },
  }, policy);
  await sampler.sample();
  now = 9000; failing = true; await sampler.sample();
  now = 10_000; await sampler.sample();
  assert.equal(warnings, 1); assert.equal(stops, 0);
  now = 11_000; failing = false; await sampler.sample();
  now = 20_000; await sampler.sample(); assert.equal(stops, 0);
  now = 21_000; await sampler.sample(); assert.equal(stops, 1);
  await sampler.sample(); assert.equal(stops, 1);
  size = 0; sampler.stop();
});

test('initial failure uses the same recovery window and merging restarts the baseline', async () => {
  let now = 0, size = 200, failing = true, stops = 0;
  const sampler = createDownloadProgressSampler({ startedAt: 0, now: () => now,
    readSize: async () => { if (failing) throw new Error('initial failure'); return size; },
    onSamplingFailure: () => {}, onLowSpeed: () => { stops++; },
  }, policy);
  await sampler.sample(); failing = false; now = 1000; await sampler.sample();
  now = 10_000; size = 50; await sampler.sample();
  now = 11_000; await sampler.sample(); assert.equal(stops, 0);
  now = 20_000; await sampler.sample(); assert.equal(stops, 1);
});

test('one pending read is shared and a stopped sampler ignores a late result', async () => {
  let finish: (value: number) => void = () => assert.fail('read not started');
  let reads = 0, stops = 0, warnings = 0;
  const sampler = createDownloadProgressSampler({ startedAt: 0, now: () => 50_000,
    readSize: () => { reads++; return new Promise<number>(resolve => { finish = resolve; }); },
    onSamplingFailure: () => { warnings++; }, onLowSpeed: () => { stops++; },
  }, policy);
  const first = sampler.sample(); assert.equal(sampler.sample(), first);
  await Promise.resolve(); assert.equal(reads, 1);
  sampler.stop(); finish(0); await first; await sampler.sample();
  assert.equal(reads, 1); assert.equal(stops, 0); assert.equal(warnings, 0);
});

test('valid growing measurements respect minimum runtime and do not report a stall', async () => {
  let now = 0, stops = 0;
  const sampler = createDownloadProgressSampler({ startedAt: 0, now: () => now,
    readSize: async () => now * 2, onSamplingFailure: () => assert.fail('unexpected failure'),
    onLowSpeed: () => { stops++; },
  }, { ...policy, minRuntimeMs: 30_000 });
  for (now = 0; now <= 40_000; now += 1000) await sampler.sample();
  assert.equal(stops, 0); sampler.stop();
});

test('directory size distinguishes an empty directory, disappearing child and I/O failure', async t => {
  const directory = await createTestDir('download-size');
  try {
    assert.equal(await readDownloadDirectorySize(directory), 0);
    await assert.rejects(readDownloadDirectorySize(path.join(directory, 'missing')), { code: 'ENOENT' });
    await fs.promises.writeFile(path.join(directory, 'media.mp4'), '123');
    assert.equal(await readDownloadDirectorySize(directory), 3);
    const stat = t.mock.method(fs.promises, 'stat', async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); });
    await assert.rejects(readDownloadDirectorySize(directory), { code: 'EACCES' });
    stat.mock.restore();
    t.mock.method(fs.promises, 'stat', async () => { throw Object.assign(new Error('merged'), { code: 'ENOENT' }); });
    assert.equal(await readDownloadDirectorySize(directory), 0);
  } finally { t.mock.restoreAll(); await removeTestDir(directory); }
});
