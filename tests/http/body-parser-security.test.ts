import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qs from 'qs';

test('query serialization preserves comma arrays and survives hostile toString fields', () => {
  assert.equal(qs.stringify({a: ['one', 'two']}, {arrayFormat: 'comma'}), 'a=one%2Ctwo');
  for (const input of [
    JSON.parse('{"a":[{"toString":"fixture"}]}'),
    qs.parse('a[0][toString]=fixture', {allowPrototypes: true}),
    qs.parse('a[][b]=fixture', {plainObjects: true}),
  ]) {
    for (const encodeValuesOnly of [false, true]) {
      assert.doesNotThrow(() => qs.stringify(input, {arrayFormat: 'comma', encodeValuesOnly}));
    }
  }
});

test('production login middleware survives late compressed-body errors and retains normal gzip/form/limit behavior', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/compressed-login.ts', import.meta.url))], {
    encoding: 'utf8', timeout: 15_000, env: {...process.env, NODE_ENV: 'test'},
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /compressed login and late decoder errors: ok/);
});
