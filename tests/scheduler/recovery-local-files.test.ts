import fs from 'node:fs';
import path from 'node:path';
import {createTestDir, removeTestDir} from '../helpers.js';
import { inspectLocalArchiveDirectory } from '../../src/scheduler/local-archive-evidence.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRecoveryLocalFiles } from '../../src/scheduler/recovery-local-files.js';

test('local recovery distinguishes a missing file from an unreadable file', () => {
  const transfers = { get: () => null, listFiles: () => [] };
  const job = { payload: { localDir: '/isolated', files: ['video.mp4'] } };
  const directory = () => ({ status: 'unknown' as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 });
  const missing = inspectRecoveryLocalFiles(transfers, job, {
    directory, stat() { throw Object.assign(Error('not present'), { code: 'ENOENT' }); },
  });
  assert.equal(missing.status, 'missing');
  for (const code of ['EACCES', 'EIO', 'EBUSY']) {
    const failure = Object.assign(Error('cannot read local proof'), { code });
    assert.throws(() => inspectRecoveryLocalFiles(transfers, job, { directory, stat() { throw failure; } }), error => error === failure);
  }
});

test('local inspection rejects paths outside the archive without inspecting them', () => {
  let reads = 0;
  const result = inspectRecoveryLocalFiles({ get: () => null, listFiles: () => [] }, {
    payload: { localDir: '/isolated', files: ['../outside.mp4'] },
  }, {
    stat() { reads++; return { size: 12, isFile: () => true }; },
    directory() { throw Error('unexpected manifest fallback'); },
  });
  assert.equal(result.status, 'changed');
  assert.equal(reads, 0);
});

test('archive root inspection does not classify storage errors as absent proof', () => {
  const missing = inspectLocalArchiveDirectory('/isolated', () => { throw Object.assign(Error('missing'), {code: 'ENOENT'}); });
  assert.equal(missing.status, 'missing');
  for (const code of ['EACCES', 'EIO']) {
    const failure = Object.assign(Error('unreadable'), {code});
    assert.throws(() => inspectLocalArchiveDirectory('/isolated', () => { throw failure; }), error => error === failure);
  }
});


test('corrupt evidence retains actual bytes and distinguishes absent manifests', async () => {
  const directory = await createTestDir('local-corrupt-bytes');
  try {
    await fs.promises.writeFile(path.join(directory, 'video.mp4'), Buffer.alloc(123));
    const missing = inspectLocalArchiveDirectory(directory);
    assert.equal(missing.evidence, 'missing');
    assert.equal(missing.retainedBytes, 123);
    await fs.promises.writeFile(path.join(directory, '.bfb-download.json'), '{bad');
    const invalid = inspectLocalArchiveDirectory(directory);
    assert.equal(invalid.evidence, 'invalid');
    assert.equal(invalid.retainedBytes, 127);
  } finally { await removeTestDir(directory); }
});
