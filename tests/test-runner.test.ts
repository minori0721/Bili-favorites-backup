import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.resolve('scripts/test.mjs'), ...args], {
    cwd: process.cwd(), encoding: 'utf8', env, timeout: 15_000, windowsHide: true,
  });
}

test('test:files consumes and deduplicates file arguments', () => {
  const fixture = 'tests/fixtures/test-runner-once.test.ts';
  const result = run('--test-concurrency=1', '--files', fixture, fixture, `./${fixture}`, path.resolve(fixture));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal((output.match(/BFB_TEST_RUNNER_ONCE/g) || []).length, 1, output);
});

function list(...args: string[]): { scope: string; concurrency: number; files: string[] } {
  const result = run('--list', ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('core and slow selections are disjoint and together retain every recursively discovered test file', () => {
  const full = list();
  const core = list('--scope', 'core');
  const slow = list('--scope', 'slow');
  assert.equal(full.scope, 'full');
  assert.ok(full.concurrency >= 1 && full.concurrency <= 2);
  assert.ok(core.files.length > 0 && slow.files.length > 0);
  assert.deepEqual([...core.files, ...slow.files].sort(), full.files);
  assert.equal(new Set([...core.files, ...slow.files]).size, full.files.length);
  assert.ok(slow.files.every(file => file.startsWith('tests/slow/')));
  assert.ok(core.files.every(file => !file.startsWith('tests/slow/')));
  assert.ok(full.files.includes('tests/fixtures/test-runner-once.test.ts'));
});

test('release selection resolves production contract tests and concurrency can be overridden explicitly', () => {
  const full = list();
  const release = list('--scope', 'release', '--test-concurrency', '1');
  assert.equal(release.scope, 'release');
  assert.equal(release.concurrency, 1);
  assert.ok(release.files.includes('tests/dev-preview.test.ts'));
  assert.ok(release.files.includes('tests/update-check.test.ts'));
  assert.ok(release.files.every(file => full.files.includes(file)));
  assert.equal(list('--test-concurrency=4', '--files', 'tests/fixtures/test-runner-once.test.ts').concurrency, 4);
});

test('invalid selectors and concurrency fail without accidentally running a different suite', () => {
  for (const args of [
    ['--scope', 'unknown'], ['--scope'], ['--scope', 'core', '--scope', 'slow'],
    ['--scope', 'core', '--files', 'tests/fixtures/test-runner-once.test.ts'], ['--files'],
    ['--test-concurrency=0'], ['--test-concurrency=NaN'], ['--test-concurrency'],
    ['--test-concurrency=2', '--test-concurrency=1'], ['--files', '../outside.test.ts'],
  ]) {
    const result = run('--list', ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.doesNotMatch(result.stdout, /BFB_TEST_RUNNER_ONCE|Running \d+ test files/);
  }
});
