import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createTestDir, removeTestDir} from './helpers.js';
import {OnlineCoverCache, type OnlineCoverAdapters} from '../src/online-cover-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return {promise, resolve};
}

async function fixture(adapters: OnlineCoverAdapters = {}) {
  const root = await createTestDir('cover-contract');
  const directory = path.join(root, 'covers');
  const cache = new OnlineCoverCache(64, {
    directory, temporaryDirectory: path.join(root, 'temp'),
    download: async (_url, output) => { await fs.writeFile(output, 'image'); },
    transcode: async (_source, output) => { await fs.writeFile(output, 'webp'); },
    ...adapters,
  });
  return {cache, root, directory, close: () => removeTestDir(root)};
}

test('cleanup failure releases cover download slots', async () => {
  let downloads = 0;
  const f = await fixture({
    download: async () => { downloads++; throw new Error('download failed'); },
    removeTemporary: async () => { throw Object.assign(new Error('cleanup denied'), {code: 'EACCES'}); },
  });
  try {
    for (let batch = 0; batch < 2; batch++) {
      const results = await Promise.all(Array.from({length: 8}, (_, i) => f.cache.getOrFetch(`${batch}-${i}`, 'fixture')));
      assert.deepEqual(results, Array(8).fill(null));
    }
    assert.equal(downloads, 16);
    await f.cache.clear();
    assert.equal((await f.cache.inspect()).files, 0);
  } finally { await f.close(); }
});

test('failed eviction and clearing retain accounting until deletion succeeds', async () => {
  let denied = true;
  let unlinks = 0;
  const f = await fixture({unlink: async file => {
    unlinks++;
    if (denied) throw Object.assign(new Error('denied'), {code: 'EACCES'});
    await fs.unlink(file);
  }});
  try {
    await fs.mkdir(f.directory, {recursive: true});
    const file = await fs.open(path.join(f.directory, 'fixture.webp'), 'w');
    await file.truncate(65 * 1024 * 1024);
    await file.close();
    const snapshot = await f.cache.inspect();
    assert.ok(unlinks > 0, 'initial eviction must try deleting an over-limit entry');
    assert.equal(snapshot.bytes, 65 * 1024 * 1024);
    await assert.rejects(f.cache.clear());
    assert.equal((await f.cache.inspect()).files, 1);
    denied = false;
    await f.cache.clear();
    assert.equal((await f.cache.inspect()).bytes, 0);
  } finally { await f.close(); }
});

test('clearing waits for a write and invalidates its generation without deadlock', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture({transcode: async (_source, output) => {
    entered.resolve(); await release.promise; await fs.writeFile(output, 'webp');
  }});
  try {
    const fetch = f.cache.getOrFetch('race-write', 'fixture');
    await entered.promise;
    let finished = false;
    const clear = f.cache.clear().then(() => { finished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release.resolve();
    assert.equal(await fetch, null, 'old generation cannot publish after clear');
    await clear;
    assert.equal((await f.cache.inspect()).files, 0);
  } finally { release.resolve(); await f.close(); }
});

test('clearing waits for an active archive cover promotion', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture({promote: async () => { entered.resolve(); await release.promise; return 'covers/BV1.webp'; }});
  try {
    assert.ok(await f.cache.getOrFetch('bvid:BV1', 'fixture'));
    const promotion = f.cache.promoteBvid('BV1', 'bvid:BV1');
    await entered.promise;
    let finished = false;
    const clear = f.cache.clear().then(() => { finished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release.resolve();
    assert.equal(await promotion, 'covers/BV1.webp');
    await clear;
    assert.equal((await f.cache.inspect()).files, 0);
  } finally { release.resolve(); await f.close(); }
});

test('queued downloads hand off all four slots to subsequent batches', async () => {
  let active = 0, maximum = 0, calls = 0;
  const f = await fixture({download: async (_url, output) => {
    active++; calls++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    await fs.writeFile(output, 'image'); active--;
  }});
  try {
    for (let batch = 0; batch < 2; batch++) {
      const results = await Promise.all(Array.from({length: 12}, (_, i) => f.cache.getOrFetch(`${batch}-${i}`, 'fixture')));
      assert.ok(results.every(Boolean));
    }
    assert.equal(calls, 24);
    assert.equal(maximum, 4);
    assert.equal(active, 0);
  } finally { await f.close(); }
});
