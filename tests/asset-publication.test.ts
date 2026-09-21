import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { publishAsset } from '../scripts/publish-asset.mjs';
import { createTestDir, removeTestDir } from './helpers.js';

test('rebuilding unchanged hashed assets leaves the served file untouched', async () => {
  const directory = await createTestDir('asset-publication');
  try {
    const file = path.join(directory, 'app.js');
    await publishAsset(file, 'complete script');
    const timestamp = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(file, timestamp, timestamp);
    await publishAsset(file, 'complete script');
    assert.equal((await fs.stat(file)).mtimeMs, timestamp.getTime());
    assert.equal(await fs.readFile(file, 'utf8'), 'complete script');
    assert.deepEqual(await fs.readdir(directory), ['app.js']);
  } finally { await removeTestDir(directory); }
});

test('asset replacement never exposes a truncated file to concurrent readers', async () => {
  const directory = await createTestDir('asset-publication-readers');
  try {
    const file = path.join(directory, 'manifest.json');
    const previous = 'a'.repeat(256 * 1024);
    const next = 'b'.repeat(256 * 1024);
    await publishAsset(file, previous);
    const publish = publishAsset(file, next);
    const reads = await Promise.all(Array.from({ length: 20 }, () => fs.readFile(file, 'utf8')));
    await publish;
    for (const value of reads) assert.ok(value === previous || value === next);
    assert.equal(await fs.readFile(file, 'utf8'), next);
    assert.deepEqual(await fs.readdir(directory), ['manifest.json']);
  } finally { await removeTestDir(directory); }
});
