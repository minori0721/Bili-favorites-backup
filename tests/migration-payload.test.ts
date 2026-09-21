import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMigrationPayload } from '../src/migration-payload.js';

test('migration payload parsing preserves object data and rejects damaged or missing rows', () => {
  assert.deepEqual(parseMigrationPayload('{"bvid":"BVTEST","extra":{"keep":true}}'), {bvid: 'BVTEST', extra: {keep: true}});
  for (const value of [undefined, null, '', '{', 'null', '[]', '1', '"value"']) {
    assert.throws(() => parseMigrationPayload(value));
  }
});
