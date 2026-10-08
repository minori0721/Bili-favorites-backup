import assert from 'node:assert/strict';
import test, {mock} from 'node:test';
import { once } from 'node:events';
import {request as httpRequest} from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { AdminSessionStore, ADMIN_REMEMBER_TTL_MS, ADMIN_SESSION_TTL_MS } from '../../src/admin-session.js';
import { createAuthentication, requireAuth, requireSameOrigin } from '../../src/http/authentication.js';
import { createLogRouter } from '../../src/http/logs.js';
import { createHttpErrorHandler } from '../../src/http/request-boundary.js';
import type { LogEntry } from '../../src/logger.js';
import { createLoginRateLimiter, describeProxyTrust, parseTrustedProxies } from '../../src/security.js';
import { createTestDir, removeTestDir } from '../helpers.js';

class ExpiryClock {
  now = Date.now();
  private nextId = 0;
  private readonly timers = new Map<number, {at: number; callback: () => void}>();
  readonly schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0 && delayMs <= 2_147_483_647);
    const id = ++this.nextId;
    this.timers.set(id, {at: this.now + delayMs, callback});
    return () => { this.timers.delete(id); };
  };
  get pending() { return this.timers.size; }
  get nextDelay() { return Math.min(...[...this.timers.values()].map(timer => timer.at - this.now)); }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

const credentials = {username: 'fixture-admin', password: 'only-an-isolated-fixture-password'};
const history: LogEntry = {timestamp: '2026-10-09T00:00:00.000Z', type: 'system', level: 'info', summary: 'history', raw: 'history'};

async function createFixture(options: {trustProxy?: string; secure?: boolean; loginLimit?: number; sessionLimit?: number} = {}) {
  const runtime = await createTestDir('login-security');
  const databasePath = path.join(runtime, 'auth.sqlite');
  const clock = new ExpiryClock();
  const store = new AdminSessionStore({filePath: databasePath, sessionSecret: 'isolated-session-secret',
    adminUser: credentials.username, adminPassword: credentials.password, cleanupIntervalMs: 0,
    now: () => clock.now, scheduleExpiry: clock.schedule, sessionLimit: options.sessionLimit});
  const listeners = new Set<(entry: LogEntry) => void>();
  const errors: string[] = [];
  const app = express();
  app.set('trust proxy', parseTrustedProxies(options.trustProxy));
  const auth = createAuthentication({secret: 'isolated-session-secret', ...credentials, secure: options.secure ?? false,
    store, now: () => clock.now, rateLimit: createLoginRateLimiter({limit: options.loginLimit ?? 5})});
  app.use(auth.session);
  app.use(auth.login);
  app.use('/api', requireAuth, requireSameOrigin);
  app.use('/api', express.json({limit: '10mb'}), express.urlencoded({extended: true}));
  app.use(auth.logout);
  app.use(createLogRouter({getAll: () => [history], subscribe: listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }}, store));
  app.get('/api/protected', (_req, res) => { res.json({success: true}); });
  app.put('/api/protected', (req, res) => {
    const body: unknown = req.body;
    const value = body !== null && typeof body === 'object' && 'value' in body ? body.value : undefined;
    res.json({success: true, length: typeof value === 'string' ? value.length : 0});
  });
  app.use(createHttpErrorHandler(message => { errors.push(message); }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  // Node fetch discards a custom Host header. Use actual HTTP requests so the
  // reverse-proxy cases exercise the domain and port seen by Express.
  const postLogin = (body: string, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const request = httpRequest(origin + '/api/login', {
      method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin, ...headers},
    }, response => {
      response.setEncoding('utf8');
      let content = '';
      response.on('data', (chunk: string) => { content += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, values] of Object.entries(response.headers)) {
          if (values === undefined) continue;
          for (const value of Array.isArray(values) ? values : [values]) resultHeaders.append(name, value);
        }
        resolve(new Response(content, {status: response.statusCode, headers: resultHeaders}));
      });
    });
    request.on('error', reject);
    request.end(body);
  });
  async function login(remember = false, headers: Record<string, string> = {}) {
    const response = await postLogin(JSON.stringify({...credentials, remember}), headers);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie);
    return cookie.split(';')[0];
  }
  async function stream(cookie: string) {
    const response = await fetch(origin + '/api/logs/stream', {headers: {Cookie: cookie}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /history/);
    return reader;
  }
  return {origin, databasePath, clock, store, errors, listeners, postLogin, login, stream,
    emit(summary: string) { for (const listener of listeners) listener({...history, summary, raw: summary}); },
    async close() {
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.equal(clock.pending, 0);
      await removeTestDir(runtime);
    },
  };
}

async function status(response: Response) { await response.arrayBuffer(); return response.status; }

test('proxy configuration accepts explicit peers and reminds both deployment modes', () => {
  for (const value of [undefined, '', ' ', 'false']) assert.equal(parseTrustedProxies(value), false);
  assert.deepEqual(parseTrustedProxies('127.0.0.1, ::1, 172.18.0.0/24,127.0.0.1'), ['127.0.0.1', '::1', '172.18.0.0/24']);
  for (const value of ['true', '1', '0', 'loopback', '127.0.0.1,', '127.0.0.1/33', '::1/129', '0.0.0.0/0', '::/0', 'proxy.example']) {
    assert.throws(() => parseTrustedProxies(value), /TRUST_PROXY/);
  }
  assert.match(describeProxyTrust(false, false), /直连.*HTTPS 反代.*Docker.*COOKIE_SECURE=false/);
  assert.match(describeProxyTrust(['127.0.0.1'], true), /代理须覆盖.*端口应只向代理开放.*COOKIE_SECURE=true/);
});

test('direct and untrusted peers cannot rotate forwarded IPs to bypass login limits', async () => {
  const warnings: unknown[][] = [];
  const warning = mock.method(console, 'error', (...args: unknown[]) => { warnings.push(args); });
  try {
    for (const trustProxy of [undefined, '192.0.2.1']) {
      const fixture = await createFixture({trustProxy});
      try {
        const results: number[] = [];
        for (let i = 1; i <= 6; i++) results.push(await status(await fixture.postLogin(
          JSON.stringify({username: credentials.username, password: 'wrong'}), {'X-Forwarded-For': `198.51.100.${i}`})));
        assert.deepEqual(results, [401, 401, 401, 401, 401, 429]);
      } finally { await fixture.close(); }
    }
    // The library's warning is expected for a deliberately untrusted header;
    // its default IP validation and rate-limit behavior remain enabled.
    assert.equal(warnings.length, 1);
    const error = warnings[0][0];
    assert.ok(error instanceof Error && 'code' in error && error.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR');
  } finally { warning.mock.restore(); }
});

test('a configured proxy preserves independent client limits and secure domain login', async () => {
  const fixture = await createFixture({trustProxy: '127.0.0.1', secure: true});
  const headers = {Host: 'bfb.example:8443', Origin: 'https://bfb.example:8443', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.1'};
  try {
    for (let i = 0; i < 5; i++) assert.equal(await status(await fixture.postLogin(JSON.stringify({username: credentials.username, password: 'wrong'}), headers)), 401);
    assert.equal(await status(await fixture.postLogin(JSON.stringify(credentials), headers)), 429);
    const response = await fixture.postLogin(JSON.stringify({...credentials, remember: true}), {...headers, 'X-Forwarded-For': '198.51.100.2'});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /Secure/);
    await response.arrayBuffer();
  } finally { await fixture.close(); }
});

test('same-origin validation includes scheme, host and port and does not fall back from a bad Origin', async () => {
  const fixture = await createFixture({loginLimit: 100});
  const wrong = JSON.stringify({username: credentials.username, password: 'wrong'});
  try {
    for (const origin of [fixture.origin.replace('http:', 'https:'), 'http://other.example', fixture.origin.replace(/:\d+$/, ':1'), 'null', fixture.origin + '/path']) {
      assert.equal(await status(await fixture.postLogin(wrong, {Origin: origin, Referer: fixture.origin + '/login'})), 403);
    }
    assert.equal(await status(await fixture.postLogin(wrong, {'X-Forwarded-Proto': 'https', Origin: fixture.origin.replace('http:', 'https:')})), 403);
    assert.equal(await status(await fixture.postLogin(wrong, {Host: 'bfb.example:80', Origin: 'http://BFB.EXAMPLE'})), 401);
    const response = await fetch(fixture.origin + '/api/login', {method: 'POST',
      headers: {'Content-Type': 'application/json', Referer: fixture.origin + '/login?from=home'}, body: JSON.stringify(credentials)});
    assert.equal(await status(response), 200);
    assert.equal(await status(await fetch(fixture.origin + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: wrong})), 403);
  } finally { await fixture.close(); }
});

test('login body errors stay small and private while protected business bodies retain their capacity', async () => {
  const fixture = await createFixture();
  try {
    const malformed = await fixture.postLogin('{"password":"fixture-sensitive-body",');
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /fixture-sensitive-body/);
    assert.equal(await status(await fixture.postLogin(JSON.stringify({password: 'x'.repeat(20_000)}))), 413);
    const cookie = await fixture.login();
    const response = await fetch(fixture.origin + '/api/protected', {method: 'PUT',
      headers: {'Content-Type': 'application/json', Origin: fixture.origin, Cookie: cookie}, body: JSON.stringify({value: 'x'.repeat(1024 * 1024)})});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {success: true, length: 1024 * 1024});
    assert.equal(await status(await fetch(fixture.origin + '/api/protected', {method: 'PUT',
      headers: {'Content-Type': 'application/json', Origin: fixture.origin}, body: '{"invalid":'})), 401);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('login rate limiting happens before parsing invalid or oversized bodies', async () => {
  const fixture = await createFixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal(await status(await fixture.postLogin('{}')), 401);
    assert.equal(await status(await fixture.postLogin('not JSON ' + 'x'.repeat(1024 * 1024))), 429);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('normal form login and session regeneration remain compatible', async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.login();
    const response = await fetch(fixture.origin + '/api/login', {method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: fixture.origin, Cookie: first},
      body: new URLSearchParams(credentials)});
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('set-cookie')?.split(';')[0], first);
    await response.arrayBuffer();
    assert.equal(await status(await fetch(fixture.origin + '/api/protected', {headers: {Cookie: first}})), 401);
  } finally { await fixture.close(); }
});

test('logout immediately closes all streams of that session without closing another session', {timeout: 5000}, async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.login(), second = await fixture.login();
    const a = await fixture.stream(first), b = await fixture.stream(first), other = await fixture.stream(second);
    assert.equal(fixture.listeners.size, 3);
    assert.equal(await status(await fetch(fixture.origin + '/api/logout', {method: 'POST', headers: {Origin: fixture.origin, Cookie: first}})), 200);
    fixture.emit('after-logout');
    assert.equal((await a.read()).done, true);
    assert.equal((await b.read()).done, true);
    assert.match(new TextDecoder().decode((await other.read()).value), /after-logout/);
    assert.equal(fixture.listeners.size, 1);
    assert.equal(await status(await fetch(fixture.origin + '/api/protected', {headers: {Cookie: first}})), 401);
    await other.cancel();
  } finally { await fixture.close(); }
});

test('ordinary and thirty-day streams expire at their fixed session deadline without timer overflow', {timeout: 5000}, async () => {
  for (const remember of [false, true]) {
    const fixture = await createFixture();
    try {
      const cookie = await fixture.login(remember);
      const reader = await fixture.stream(cookie);
      const ttl = remember ? ADMIN_REMEMBER_TTL_MS : ADMIN_SESSION_TTL_MS;
      assert.equal(fixture.clock.nextDelay, Math.min(ttl, 2_147_483_647));
      fixture.clock.advance(ttl - 1);
      assert.equal(fixture.listeners.size, 1);
      assert.equal(await status(await fetch(fixture.origin + '/api/protected', {headers: {Cookie: cookie}})), 200);
      fixture.clock.advance(1);
      assert.equal((await reader.read()).done, true);
      assert.equal(fixture.listeners.size, 0);
      assert.equal(fixture.clock.pending, 0);
      assert.equal(await status(await fetch(fixture.origin + '/api/protected', {headers: {Cookie: cookie}})), 401);
    } finally { await fixture.close(); }
  }
});

test('session eviction and store shutdown release streams and expiry resources', {timeout: 5000}, async () => {
  const fixture = await createFixture({sessionLimit: 2});
  try {
    const first = await fixture.login(), second = await fixture.login();
    const a = await fixture.stream(first), b = await fixture.stream(second);
    await fixture.login();
    assert.equal((await a.read()).done, true);
    assert.equal(fixture.listeners.size, 1);
    assert.equal(fixture.clock.pending, 1);
    fixture.store.close(); fixture.store.close();
    assert.equal((await b.read()).done, true);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.clock.pending, 0);
  } finally { await fixture.close(); }
});

test('a failed SQLite logout is not reported as success or used to revoke a still-valid session', {timeout: 5000}, async () => {
  const fixture = await createFixture();
  try {
    const cookie = await fixture.login();
    const reader = await fixture.stream(cookie);
    const database = new Database(fixture.databasePath);
    database.exec("CREATE TRIGGER fail_logout BEFORE DELETE ON admin_sessions BEGIN SELECT RAISE(ABORT, 'isolated deletion failure'); END");
    database.close();
    assert.equal(await status(await fetch(fixture.origin + '/api/logout', {method: 'POST', headers: {Origin: fixture.origin, Cookie: cookie}})), 500);
    assert.equal(fixture.listeners.size, 1);
    fixture.emit('logout-failed');
    assert.match(new TextDecoder().decode((await reader.read()).value), /logout-failed/);
    await reader.cancel();
  } finally { await fixture.close(); }
});
