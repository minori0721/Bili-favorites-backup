import assert from 'node:assert/strict';
import test from 'node:test';
import {safeErrorCode, safeErrorSummary} from '../src/diagnostics.js';

test('unknown errors keep useful messages and redact credentials without coercing arbitrary status objects', () => {
  assert.equal(safeErrorSummary('remote timeout'), 'remote timeout');
  assert.equal(safeErrorSummary({message: 'failed', status: Symbol('invalid')}), 'failed');
  assert.equal(safeErrorSummary({message: 'failed', response: {status: 503}}), 'status=503: failed');
  assert.equal(safeErrorSummary({message: {}, status: {}}), '操作失败');
  assert.doesNotMatch(safeErrorSummary(new Error('Cookie: private-session-value')), /private-session-value/);
});

test('diagnostic codes accept identifiers without exposing arbitrary external values', () => {
  assert.equal(safeErrorCode(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'ECONNRESET');
  for (const error of [null, 'timeout', {}, { code: 403 }, { code: 'Cookie: private-cookie' }, { code: 'A'.repeat(65) }, { code: Symbol('secret') }]) {
    assert.equal(safeErrorCode(error), 'unknown');
  }
});
