import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import axios from 'axios';

const require = createRequire(import.meta.url);
const redirects: {http: typeof http} = require('follow-redirects');

test('redirects strip credentials for array headers, metacharacter names and the Bili API Axios dependency', async () => {
  const received: http.IncomingHttpHeaders[] = [];
  const target = http.createServer((req, res) => {
    received.push(req.headers);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({code: 0, data: {ok: true}}));
  }).listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');
  const origin = http.createServer((_req, res) => {
    res.writeHead(302, {Location: `http://localhost:${targetAddress.port}/result`});
    res.end();
  }).listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const address = origin.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/redirect`;
  async function request(headers: http.RequestOptions['headers'], sensitiveHeaders: string[] = []) {
    return new Promise<string>((resolve, reject) => {
      const options = {headers, sensitiveHeaders, family: 4};
      const req = redirects.http.get(url, options, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('error', reject);
        response.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });
  }
  try {
    assert.deepEqual(JSON.parse(await request({Authorization: 'fixture-token', Cookie: 'fixture-cookie',
      'X-Api^Key': 'fixture-key', 'X-Api|Key': 'fixture-key', 'X-Demo': 'kept'}, ['X-Api^Key', 'X-Api|Key'])), {code: 0, data: {ok: true}});
    await request(['Authorization', 'fixture-token', 'Cookie', 'fixture-cookie', 'Proxy-Authorization', 'fixture-proxy', 'X-Demo', 'kept']);
    const result = await axios.get(url, {family: 4, proxy: false, timeout: 3000,
      headers: {Authorization: 'fixture-token', Cookie: 'fixture-cookie', 'X-Demo': 'kept'}});
    assert.deepEqual(result.data, {code: 0, data: {ok: true}});
    assert.equal(received.length, 3);
    for (const headers of received) {
      for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api^key', 'x-api|key']) assert.equal(headers[name], undefined, name);
      assert.equal(headers['x-demo'], 'kept');
    }
  } finally {
    for (const server of [origin, target]) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
