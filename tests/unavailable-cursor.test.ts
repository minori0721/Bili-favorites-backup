import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnavailableCursor, encodeUnavailableCursor } from '../src/unavailable-cursor.js';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
test('unavailable pagination preserves v2 and legacy continuation without accepting damaged cursors', () => {
  const cursor = {lastSeenAt: 10, bvid: 'BVTEST', mediaId: 1};
  assert.deepEqual(parseUnavailableCursor(encodeUnavailableCursor(cursor, 'all'), 'all'), {ok: true, cursor, legacyOffset: 0});
  assert.deepEqual(parseUnavailableCursor(encode({offset: 20}), 'all'), {ok: true, cursor: null, legacyOffset: 20});
  assert.deepEqual(parseUnavailableCursor(undefined, 'all'), {ok: true, cursor: null, legacyOffset: 0});
  for (const input of ['broken', encode({}), encode([]), encode({offset: null}), encode({offset: -1}),
    encode({version: 9, offset: 20}), encode({version: 2, filter: 'missing', ...cursor}),
    encode({version: 2, filter: 'all', ...cursor, lastSeenAt: null})]) {
    assert.equal(parseUnavailableCursor(input, 'all').ok, false);
  }
});
