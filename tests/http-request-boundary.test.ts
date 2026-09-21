import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ImportMaintenance } from '../src/import-maintenance.js';
import { createHttpErrorHandler, createMaintenanceGuard, createRequestBoundary } from '../src/http/request-boundary.js';

test('HTTP boundary counts ordinary requests, admits exclusive import, and propagates typed failures', async () => {
  const maintenance = new ImportMaintenance();
  const boundary = createRequestBoundary(maintenance);
  const app = express();
  const logs: string[] = [];
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  app.use(createMaintenanceGuard(maintenance));
  app.get('/active', boundary(async (_req, res) => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    res.json({success: true});
  }));
  app.post('/api/migration/import', boundary(async (_req, res) => {
    const release = await maintenance.acquire(50);
    try { res.json({success: true}); } finally { release(); }
  }));
  app.get('/failure', boundary(() => { throw Object.assign(new Error('transaction rejected'), {statusCode: 409}); }));
  app.get('/invalid-status', boundary(() => { throw Object.assign(new Error('broken adapter'), {statusCode: 409.5}); }));
  app.use(createHttpErrorHandler(message => logs.push(message)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const request = fetch(`${url}/active`);
    await active;
    await assert.rejects(maintenance.acquire(0), /维护/);
    finish();
    assert.equal((await request).status, 200);
    assert.equal((await fetch(`${url}/api/migration/import`, {method: 'POST'})).status, 200);
    const release = await maintenance.acquire(0);
    assert.equal((await fetch(`${url}/failure`)).status, 409);
    assert.equal(logs.length, 0, 'maintenance rejects before invoking route');
    release();
    const failure = await fetch(`${url}/failure`);
    assert.equal(failure.status, 409);
    assert.match(await failure.text(), /transaction rejected/);
    assert.equal((await fetch(`${url}/invalid-status`)).status, 500);
    assert.equal(logs.length, 2);
  } finally {
    finish?.();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
