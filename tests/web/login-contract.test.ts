import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLoginStart, parseLoginStatus } from '../../src/web/client/features/accounts/login-contract.js';

test('login boundary accepts QR images and rejects malformed sessions and status responses', () => {
  const valid = {loginId:'isolated', qrDataUrl:'data:image/png;base64,YQ=='};
  assert.deepEqual(parseLoginStart(valid), valid);
  for (const value of [null, {}, {...valid,loginId:''}, {...valid,qrDataUrl:'https://example.invalid/qr'}]) {
    assert.throws(() => parseLoginStart(value));
  }
  assert.equal(parseLoginStatus({status:'completed'}).status, 'completed');
  for (const value of [null, {}, {status:'unknown'}, {status:'error',message:{}}]) assert.throws(() => parseLoginStatus(value));
});
