import express from 'express';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogRouter } from '../../src/http/logs.js';
import type { LogEntry } from '../../src/logger.js';

test('log HTTP stream sends history and releases its subscription on disconnect', { timeout: 5000 }, async () => {
  const entry: LogEntry = { timestamp: '2026-09-20T00:00:00.000Z', type: 'system', level: 'info', summary: 'test', raw: 'test' };
  let active = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const app = express(); app.use(createLogRouter({ getAll: () => [entry], subscribe: () => { active++; return () => { active--; release(); }; } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/logs`;
  try {
    assert.deepEqual(await (await fetch(base)).json(), { success: true, data: [entry] });
    const response = await fetch(base + '/stream');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /data: .*test/);
    assert.equal(active, 1);
    await reader.cancel(); await released;
    assert.equal(active, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
