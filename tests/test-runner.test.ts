import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('test:files consumes and deduplicates file arguments', () => {
  const fixture = 'tests/fixtures/test-runner-once.test.ts';
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    path.resolve('scripts/test.mjs'),
    '--files',
    fixture,
    fixture,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal((output.match(/BFB_TEST_RUNNER_ONCE/g) || []).length, 1, output);
});
