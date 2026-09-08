import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedTransport, SessionExpiredError } from '../../src/web/client/shared/session.js';
import { createApiClient } from '../../src/web/client/shared/api.js';

test('parallel 401 responses expire once before JSON parsing and reject late success', async () => {
  const replies: ((response: Response) => void)[] = [];
  const signals: AbortSignal[] = [];
  let expirations = 0;
  const transport = createProtectedTransport({ fetch: async (_url, options) => {
    signals.push(options!.signal!);
    return new Promise(resolve => replies.push(resolve));
  }, expired: () => { expirations++; } });
  const requests = [transport.request('/api/a'), transport.request('/api/b'), transport.request('/api/c')];
  const checked = requests.map(request => assert.rejects(request, SessionExpiredError));
  replies[0](new Response('<html>expired</html>', {status:401}));
  await checked[0];
  replies[1](Response.json({success:true}));
  replies[2](new Response('', {status:401}));
  await Promise.all(checked);
  assert.equal(expirations, 1);
  assert.ok(signals.every(signal => signal.aborted));
  await assert.rejects(transport.request('/api/new'), SessionExpiredError);
  assert.equal(replies.length, 3);
});

test('expired ordinary and silent calls do not emit duplicate error notifications', async () => {
  const messages: string[] = [];
  let expirations = 0;
  const transport = createProtectedTransport({fetch: async () => new Response('', {status:401}), expired: () => { expirations++; }});
  const api = createApiClient({fetch:transport.request, notifyError:message => messages.push(message)});
  await assert.rejects(api.request('/api/config'), SessionExpiredError);
  await assert.rejects(api.silent('/api/queue/state'), SessionExpiredError);
  assert.equal(expirations,1);
  assert.deepEqual(messages,[]);
});

test('403, 409, 503 and canceled late 401 do not invalidate the session', async () => {
  for (const status of [403,409,503]) {
    const transport = createProtectedTransport({fetch:async () => new Response('', {status}), expired:() => assert.fail('unexpected expiry')});
    assert.equal((await transport.request('/api/a')).status,status);
  }
  const controller = new AbortController();
  const transport = createProtectedTransport({fetch:async () => {controller.abort(); return new Response('', {status:401});}, expired:() => assert.fail('canceled request expired session')});
  await assert.rejects(transport.request('/api/a',{signal:controller.signal}), {name:'AbortError'});
});
