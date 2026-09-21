import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createAvailabilityRecheckRouter } from '../../src/http/availability-recheck.js';
import { createQueueStateRouter } from '../../src/http/queue-state.js';
import { createUpdatesRouter } from '../../src/http/updates.js';

test('application status routes preserve update, availability and queue contracts', async () => {
  const refreshes: boolean[] = [];
  const requested: string[] = [];
  let boundaryCalls = 0;
  const app = express();
  app.use(createUpdatesRouter({
    boundary: handler => (request, response, next) => {
      boundaryCalls += 1;
      Promise.resolve(handler(request, response, next)).catch(next);
    },
    async check(refresh) { refreshes.push(refresh); return { version: '2.6.1' }; },
  }));
  app.use(createAvailabilityRecheckRouter({
    request(bvid) {
      requested.push(bvid);
      return bvid === 'BVREJECT'
        ? { ok: false, status: 409, message: 'already running' }
        : { ok: true, bvid, status: 'queued' };
    },
  }));
  app.use(createQueueStateRouter({ snapshot: () => ({ columns: ['download'] }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const update = await fetch(`${base}/api/updates?refresh=1`);
    assert.equal(update.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await update.json(), { success: true, data: { version: '2.6.1' } });
    assert.deepEqual(refreshes, [true]);
    assert.equal(boundaryCalls, 1);

    const invalid = await fetch(`${base}/api/videos/not-a-bvid/availability-recheck`, { method: 'POST' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(requested, []);
    const rejected = await fetch(`${base}/api/videos/BVREJECT/availability-recheck`, { method: 'POST' });
    assert.equal(rejected.status, 409);
    const accepted = await fetch(`${base}/api/videos/BVVALID/availability-recheck`, { method: 'POST' });
    assert.equal(accepted.status, 202);
    assert.deepEqual((await accepted.json()).data, { ok: true, bvid: 'BVVALID', status: 'queued' });

    const queue = await fetch(`${base}/api/queue/state`);
    assert.deepEqual(await queue.json(), { success: true, data: { columns: ['download'] } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
