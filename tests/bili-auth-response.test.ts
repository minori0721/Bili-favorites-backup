import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTvAuthResult } from '../src/bili-auth-response.js';
const cookies = [{name: 'SESSDATA', value: 'isolated-session', expires: 123}, {name: 'bili_jct', value: 'isolated-csrf'}, {name: 'DedeUserID', value: '12'}];
test('TV auth accepts nested and raw responses while preserving token and expiry semantics', () => {
  const data = {cookie_info: {cookies}, token_info: {mid: 12, access_token: 'isolated-access', refresh_token: 'isolated-refresh'}};
  const raw = normalizeTvAuthResult(data);
  assert.deepEqual(normalizeTvAuthResult({data}), raw);
  assert.equal(raw.uid, 12); assert.equal(raw.expires, 123000); assert.equal(raw.cookie.accessToken, 'isolated-access');
});
test('TV auth rejects incomplete, duplicate, or malformed credential responses', () => {
  for (const value of [null, [], {}, {data: null}, {cookie_info: {cookies: []}},
    {cookie_info: {cookies: [...cookies, cookies[0]]}}, {cookie_info: {cookies: [{name: 'SESSDATA', value: {}}]}},
    {cookie_info: {cookies}, access_token: {}}, {cookie_info: {cookies}, mid: 'broken'}]) {
    assert.throws(() => normalizeTvAuthResult(value));
  }
});
