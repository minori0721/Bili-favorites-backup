import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { gzipSync, deflateSync } from 'node:zlib';
import { setTimeout } from 'node:timers/promises';
import express from 'express';
import session from 'express-session';
import { createAuthentication } from '../../src/http/authentication.js';
import { createLoginRateLimiter } from '../../src/security.js';

// A child process is intentional: a regression in a decompression error
// listener must fail this fixture, without killing the main test runner.
const credentials = {username: 'fixture', password: 'isolated-compression-fixture'};
const app = express();
const auth = createAuthentication({...credentials, secret: 'isolated-compression-secret', secure: false,
  store: new session.MemoryStore(), now: Date.now, rateLimit: createLoginRateLimiter({limit: 50})});
app.use(auth.session, auth.login);
app.get('/health', (_req, res) => res.sendStatus(204));
app.use(((error, _req, res, _next) => {
  res.status(typeof error?.status === 'number' ? error.status : 400).end();
}) satisfies express.ErrorRequestHandler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

function send(body: Buffer, encoding: string, contentType: string, trailing?: Buffer) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(origin + '/api/login', {method: 'POST', headers: {
      Origin: origin, 'Content-Type': contentType, 'Content-Encoding': encoding,
      'Content-Length': body.length + (trailing?.length ?? 0), Connection: 'close',
    }}, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    req.on('error', reject);
    if (trailing) {
      req.write(body);
      void setTimeout(25).then(() => req.end(trailing));
    } else req.end(body);
  });
}

try {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync]] as const) {
    for (const [contentType, text] of [
      ['application/json', JSON.stringify(credentials)],
      ['application/x-www-form-urlencoded', new URLSearchParams(credentials).toString()],
    ]) {
      const frame = compress(text);
      assert.equal(await send(frame, encoding, contentType), 200);
      const status = await send(frame, encoding, contentType, Buffer.from([0xff, 0xff, 0xff, 0xff]));
      // A completed valid first frame can already have received a response;
      // a late decoder error must still never terminate the process.
      assert.ok(status === 200 || status === 400, String(status));
      await setTimeout(50);
      assert.equal((await fetch(origin + '/health')).status, 204);
    }
    assert.equal(await send(compress('{invalid'), encoding, 'application/json'), 400);
    assert.equal(await send(compress(JSON.stringify({password: 'x'.repeat(20_000)})), encoding, 'application/json'), 413);
  }
  console.log('compressed login and late decoder errors: ok');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
