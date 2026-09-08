import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from '../../src/web/client/shared/api.js';

test('API client validates envelopes and preserves error details and silent semantics', async () => {
  const messages: string[] = [];
  const reply = {success:false, message:'维护中', code:'MAINTENANCE', data:{retry:true}};
  const api = createApiClient({fetch:async () => Response.json(reply, {status:503}), notifyError: message => messages.push(message)});
  await assert.rejects(api.silent('/api/example'), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'MAINTENANCE');
    assert.deepEqual(error.details, {retry:true});
    return true;
  });
  assert.deepEqual(messages, []);
  await assert.rejects(api.request('/api/example'));
  assert.deepEqual(messages, ['维护中']);
});

test('API client does not notify cancellation or stale archive cursors', async () => {
  const messages: string[] = [];
  const abort = new DOMException('Aborted', 'AbortError');
  const api = createApiClient({fetch:async (_url, options) => {
    assert.ok(options?.signal?.aborted);
    throw abort;
  }, notifyError: message => messages.push(message)});
  await assert.rejects(api.request('/api/example', {signal:AbortSignal.abort()}), error => error === abort);
  const stale = createApiClient({fetch:async () => Response.json({success:false, code:'ARCHIVE_CURSOR_STALE'}), notifyError: message => messages.push(message)});
  await assert.rejects(stale.request('/api/example'), ApiError);
  assert.deepEqual(messages, []);
});

test('API client returns unknown data and rejects malformed envelopes', async () => {
  for (const body of [null, [], {success:'yes'}, {items:[]}]) {
    const api = createApiClient({fetch:async () => Response.json(body), notifyError:() => {}});
    await assert.rejects(api.silent('/api/example'), ApiError);
  }
  const api = createApiClient({fetch:async () => Response.json({success:true, data:{items:[1]}}), notifyError:() => {}});
  assert.deepEqual(await api.request('/api/example'), {items:[1]});
  const unavailable = createApiClient({fetch:async () => Response.json({success:true, data:{}}, {status:503}), notifyError:() => {}});
  await assert.rejects(unavailable.silent('/api/example'), error => error instanceof ApiError && error.status === 503);
});
