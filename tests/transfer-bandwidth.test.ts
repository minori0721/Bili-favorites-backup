import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createClient } from 'webdav';
import { ByteRateLimiter } from '../src/byte-rate-limiter.js';
import { ManagedAria2 } from '../src/managed-aria2.js';
import { decodeStoredConfig, normalizeLoadedConfig, validateConfig } from '../src/config.js';
import { createTestDir, removeTestDir } from './helpers.js';
import { testConfig } from './helpers.js';
import { buildDownloadConfigFingerprint } from '../src/download-session.js';
import { downloadWithBBDown, cancelActiveDownloadsForAccount } from '../src/downloader.js';
import type { DownloadTransport } from '../src/managed-aria2.js';
import { parseSettings } from '../src/web/client/features/settings/contract.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) { if (Date.now() > deadline) assert.fail('Runtime rate update did not complete'); await wait(10); }
}

test('bandwidth config preserves old defaults and rejects invalid current fields', () => {
  assert.equal(normalizeLoadedConfig(decodeStoredConfig({})).downloadLimitMBps, 0);
  assert.equal(normalizeLoadedConfig(decodeStoredConfig({})).uploadLimitMBps, 0);
  for (const key of ['downloadLimitMBps', 'uploadLimitMBps'] as const) {
    for (const value of [-1, NaN, Infinity, '1', null, 10001]) {
      assert.throws(() => decodeStoredConfig({ [key]: value }), new RegExp(key));
      assert.match(String(validateConfig({ [key]: value })), new RegExp(key));
      assert.throws(() => parseSettings({ [key]: value }), new RegExp(key));
    }
    assert.equal(validateConfig({ [key]: 0.25 }), null);
    assert.equal(parseSettings({ [key]: 0.25 })[key], 0.25);
    assert.equal(parseSettings({})[key], undefined);
  }
  assert.equal(buildDownloadConfigFingerprint(testConfig(), 12),
    buildDownloadConfigFingerprint(testConfig({ downloadLimitMBps: 0.25, uploadLimitMBps: 1 }), 12));
});

test('real WebDAV PUTs share the upload rate and retain content length, condition and bytes', async () => {
  const limiter = new ByteRateLimiter(); limiter.setBytesPerSecond(256 * 1024);
  const content = Buffer.alloc(128 * 1024, 90), received: Buffer[] = [], headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (request, response) => {
    headers.push(request.headers); const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks)); response.writeHead(201).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createClient(`http://127.0.0.1:${address.port}`);
  const started = performance.now();
  try {
    await Promise.all(['one', 'two'].map(name => client.putFileContents('/' + name,
      limiter.wrap(Readable.from([content])), { contentLength: false, overwrite: false, headers: { 'Content-Length': String(content.length) } })));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 800 && elapsed < 5000, `aggregate transfer elapsed=${elapsed}`);
    for (const data of received) assert.deepEqual(data, content);
    assert.equal(received.length, 2);
    for (const h of headers) { assert.equal(h['content-length'], String(content.length)); assert.equal(h['if-none-match'], '*'); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('upload limit changes apply to existing readers, including unlimited and very low rates', async () => {
  const limiter = new ByteRateLimiter(); limiter.setBytesPerSecond(1);
  const content = Buffer.alloc(64 * 1024, 12);
  const output = limiter.wrap(Readable.from([content]));
  const collected: Buffer[] = [];
  const done = (async () => { for await (const chunk of output) collected.push(chunk); })();
  await wait(30); limiter.setBytesPerSecond(128 * 1024); await wait(80); limiter.setBytesPerSecond(0);
  await done; assert.deepEqual(Buffer.concat(collected), content);
  const neverFinishes = limiter.wrap(Readable.from([content]));
  limiter.setBytesPerSecond(1);
  const consuming = (async () => { for await (const _chunk of neverFinishes) { /* consume until cancelled */ } })();
  await wait(20); neverFinishes.destroy(new Error('cancelled'));
  const cancelledAt = performance.now();
  await assert.rejects(consuming, /cancelled/);
  assert.ok(performance.now() - cancelledAt < 250, 'cancellation must interrupt an allowance wait immediately');
});

test('abort also interrupts an upload whose source has not produced a byte', async () => {
  const limiter = new ByteRateLimiter(), abort = new AbortController();
  const source = new Readable({ read() {} });
  const output = limiter.wrap(source, abort.signal);
  const consuming = (async () => { for await (const _chunk of output) { /* consume */ } })();
  await wait(10); const started = performance.now(); abort.abort(new Error('cancel empty source'));
  await assert.rejects(consuming, /cancel empty source/);
  assert.ok(performance.now() - started < 250); assert.equal(source.destroyed, true);
});

test('cancelling a waiting upload removes its reservation and lets another stream finish', async () => {
  const limiter = new ByteRateLimiter(); limiter.setBytesPerSecond(1024);
  const abort = new AbortController(), content = Buffer.alloc(8192);
  const first = limiter.wrap(Readable.from([content]), abort.signal);
  const cancelled = (async () => { for await (const _chunk of first) { /* consume */ } })();
  const second = limiter.wrap(Readable.from([content]));
  const done = (async () => { let bytes = 0; for await (const chunk of second) bytes += chunk.length; return bytes; })();
  await wait(20); abort.abort(new Error('stop first')); limiter.setBytesPerSecond(0);
  await assert.rejects(cancelled, /stop first/); assert.equal(await done, content.length);
});

test('managed download sessions share one engine and cancel only their own task identities', async () => {
  const root = await createTestDir('aria2-owner');
  const manager = new ManagedAria2({ command: process.execPath, commandArgs: [path.resolve('tests/fixtures/aria2-rpc.mjs')], temporaryRoot: root });
  const sessions = await Promise.all([manager.acquire(), manager.acquire()]);
  const read = async (file: string): Promise<{ endpoint: string; secret: string; gidPrefix: string; options: { continue: string } }> => JSON.parse(await fs.readFile(file, 'utf8'));
  const [one, two] = await Promise.all(sessions.map(s => read(s.configPath)));
  const rpc = async (method: string, ...args: unknown[]) => {
    const response = await fetch(one.endpoint, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params: [`token:${one.secret}`, ...args] }) });
    return response.json();
  };
  try {
    assert.equal(one.endpoint, two.endpoint); assert.notEqual(one.gidPrefix, two.gidPrefix);
    assert.equal(one.options.continue, 'true');
    if (process.platform !== 'win32') assert.equal((await fs.stat(sessions[0].configPath)).mode & 0o777, 0o600);
    for (const item of [one, two]) await rpc('aria2.addUri', ['http://127.0.0.1/file'], { gid: item.gidPrefix + '0001' });
    assert.equal(await sessions[0].progressBytes(), 1234); assert.equal(await sessions[1].progressBytes(), 1234);
    manager.setBytesPerSecond(32000);
    const third = await manager.acquire();
    assert.equal((await rpc('aria2.getGlobalOption')).result['max-overall-download-limit'], '32000');
    await third.release();
    await eventually(async () => (await rpc('aria2.getGlobalOption')).result['max-overall-download-limit'] === '32000');
    assert.equal(sessions[0].minimumProgressRate(), Number.MIN_VALUE);
    manager.setBytesPerSecond(0);
    await eventually(async () => (await rpc('aria2.getGlobalOption')).result['max-overall-download-limit'] === '0');
    await sessions[0].release(); await sessions[0].release();
    assert.equal(await sessions[1].progressBytes(), 1234);
    const active = (await rpc('aria2.tellActive')).result;
    assert.deepEqual(active.map((row: { gid: string }) => row.gid), [two.gidPrefix + '0001']);
    await rpc('fixture.invalidRows');
    await assert.rejects(sessions[1].progressBytes(), /Invalid aria2 transfer fields/);
  } finally {
    await manager.close(); await Promise.all(sessions.map(s => s.release())); await removeTestDir(root);
  }
});

test('private download control bypasses global HTTP proxies and fetch dispatchers', async () => {
  const root = await createTestDir('aria2-direct-control');
  const manager = new ManagedAria2({ command: process.execPath, commandArgs: [path.resolve('tests/fixtures/aria2-rpc.mjs')], temporaryRoot: root });
  const originalAgent = http.globalAgent;
  const proxyAgent = new http.Agent({ proxyEnv: { http_proxy: 'http://127.0.0.1:9', no_proxy: '' } });
  http.globalAgent = proxyAgent;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Private control used global fetch'); };
  try {
    const session = await manager.acquire();
    assert.equal(await session.progressBytes(), 0);
    manager.setBytesPerSecond(1234);
    const next = await manager.acquire();
    await session.release(); await next.release();
    await manager.close();
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    globalThis.fetch = originalFetch; http.globalAgent = originalAgent; proxyAgent.destroy();
    await manager.close(); await removeTestDir(root);
  }
});

test('failed engine startup is observable and temporary resources do not remain', async () => {
  const root = await createTestDir('aria2-failure');
  const manager = new ManagedAria2({ command: path.join(root, 'missing-aria2'), temporaryRoot: root });
  try { await assert.rejects(manager.acquire(), /Cannot start/); assert.deepEqual(await fs.readdir(root), []); }
  finally { await manager.close(); await removeTestDir(root); }
});

test('account cancellation waits for shared transport cleanup after BBDown exits', { timeout: 10000 }, async () => {
  const root = await createTestDir('download-transport-cancel');
  const script = path.join(root, 'bbdown.mjs');
  await fs.writeFile(script, "console.log('BFB_SIGNAL:PLAYURL_READY:WEB'); setInterval(() => {}, 1000);");
  let ready!: () => void, releaseStarted!: () => void, finishRelease!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
  const released = new Promise<void>(resolve => { finishRelease = resolve; });
  const transport: DownloadTransport = {
    configPath: path.join(root, 'private.json'), progressBytes: async () => 0,
    minimumProgressRate: () => Number.MIN_VALUE, progressWindowMs: () => 600000,
    release: () => { releaseStarted(); return released; },
  };
  const result = downloadWithBBDown('BVTRANSPORT', { SESSDATA: 'test', bili_jct: 'test', DedeUserID: '777' }, testConfig(), {
    downloadDir: path.join(root, 'video'), command: process.execPath, commandArgsPrefix: [script],
    acquireTransport: async () => transport, onApiReady: ready,
    pageSnapshot: { access: { classification: 'normal', source: 'view' }, available: true, pages: [{ index: 1, cid: 1, title: 'One', duration: 2 }] },
  }).then(() => null, error => error);
  try {
    await started;
    let cancellationFinished = false;
    const stopping = cancelActiveDownloadsForAccount('777', 3000).then(() => { cancellationFinished = true; });
    await releasing; await wait(30);
    assert.equal(cancellationFinished, false, 'process exit alone cannot authorize account cleanup');
    finishRelease(); await stopping;
    assert.ok(await result instanceof Error);
  } finally { finishRelease(); await result; await removeTestDir(root); }
});
