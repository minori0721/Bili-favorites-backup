import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { request, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createAppAssetService, type AssetManifest } from '../../src/web/server/assets.js';
import { createTestDir, removeTestDir } from '../helpers.js';

async function fixture(directory: string, compressed = false) {
  const script = 'console.log("fixture");', style = 'body { color: black; }';
  const entry = (file: string, content: string) => ({file, sha256:createHash('sha256').update(content).digest('hex')});
  const manifest: AssetManifest = {version:1,script:entry('app-ABC123.js',script),style:entry('app-DEF456.css',style)};
  await fs.writeFile(path.join(directory, manifest.script.file), script);
  await fs.writeFile(path.join(directory, manifest.style.file), style);
  if (compressed) for (const kind of ['script','style'] as const) {
    const bytes = gzipSync(kind === 'script' ? script : style, {level:9});
    manifest[kind].gzip = {sha256:createHash('sha256').update(bytes).digest('hex')};
    await fs.writeFile(path.join(directory, manifest[kind].file + '.gz'), bytes);
  }
  await fs.writeFile(path.join(directory,'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('asset startup rejects missing, malformed, unsafe and incomplete artifacts', async () => {
  const directory = await createTestDir('web-assets-invalid');
  try {
    assert.throws(() => createAppAssetService(directory).readAssetManifest(), /ENOENT/);
    const manifest = await fixture(directory);
    assert.deepEqual(createAppAssetService(directory).readAssetManifest(), manifest);
    for (const value of [{version:2}, {...manifest,script:{...manifest.script,file:'../secret.js'}}, {...manifest,style:null}]) {
      await fs.writeFile(path.join(directory,'manifest.json'), JSON.stringify(value));
      assert.throws(() => createAppAssetService(directory).readAssetManifest());
    }
    await fixture(directory);
    await fs.writeFile(path.join(directory,manifest.script.file),'tampered');
    assert.throws(() => createAppAssetService(directory).readAssetManifest(), /integrity/);
    await fs.unlink(path.join(directory,manifest.style.file));
    assert.throws(() => createAppAssetService(directory).readAssetManifest());
  } finally { await removeTestDir(directory); }
});

test('advertised gzip assets must exist and match their integrity metadata', async () => {
  const directory = await createTestDir('web-assets-gzip-integrity');
  try {
    const manifest = await fixture(directory, true);
    assert.deepEqual(createAppAssetService(directory).readAssetManifest(), manifest);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({...manifest,script:{...manifest.script,gzip:{sha256:'invalid'}}}));
    assert.throws(() => createAppAssetService(directory).readAssetManifest(), /compressed browser asset entry/);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, manifest.script.file + '.gz'), 'corrupt');
    assert.throws(() => createAppAssetService(directory).readAssetManifest(), /integrity/);
    await fixture(directory, true);
    await fs.unlink(path.join(directory, manifest.style.file + '.gz'));
    assert.throws(() => createAppAssetService(directory).readAssetManifest(), /ENOENT/);
  } finally { await removeTestDir(directory); }
});

async function rawResponse(url: string, headers: OutgoingHttpHeaders = {}, method = 'GET') {
  const response = await new Promise<IncomingMessage>((resolve,reject) => {
    request(url, {headers,method}, resolve).on('error', reject).end();
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return {status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)};
}

test('gzip assets preserve authentication, MIME, negotiation, private caching, HEAD, conditional and range responses', async () => {
  const directory = await createTestDir('web-assets-gzip-http');
  const manifest = await fixture(directory, true);
  const assets = createAppAssetService(directory);
  const app = express();
  app.get('/assets/app/:name', (req,res,next) => {
    if (req.headers.authorization !== 'test-session') { res.sendStatus(401); return; }
    next();
  }, assets.serveAppAsset);
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const address = server.address();assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/assets/app/`;
    const headers = {authorization:'test-session','accept-encoding':'gzip'};
    assert.equal((await rawResponse(base + manifest.script.file, {'accept-encoding':'gzip'})).status,401);
    for (const kind of ['script','style'] as const) {
      const url = base + manifest[kind].file;
      const original = await fs.readFile(path.join(directory, manifest[kind].file));
      const compressed = await rawResponse(url, headers);
      assert.equal(compressed.status,200);
      assert.equal(compressed.headers['content-encoding'],'gzip');
      assert.match(compressed.headers['content-type'] ?? '', kind === 'script' ? /javascript/ : /text\/css/);
      assert.equal(compressed.headers['cache-control'],'private, max-age=31536000, immutable');
      assert.match(compressed.headers.vary ?? '', /Accept-Encoding/);
      assert.deepEqual(gunzipSync(compressed.body), original);
      for (const encoding of ['identity','gzip;q=0','gzip;q=0.1, identity;q=1','br']) {
        const identity = await rawResponse(url, {...headers,'accept-encoding':encoding});
        assert.equal(identity.headers['content-encoding'],undefined);
        assert.deepEqual(identity.body,original);
        assert.notEqual(identity.headers.etag,compressed.headers.etag);
      }
      assert.deepEqual((await rawResponse(url,{authorization:'test-session'})).body,original);
      const head = await rawResponse(url,headers,'HEAD');
      assert.equal(head.headers['content-encoding'],'gzip');assert.equal(head.body.length,0);
      assert.equal(Number(head.headers['content-length']),compressed.body.length);
      const cached = await rawResponse(url,{...headers,'if-none-match':compressed.headers.etag});
      assert.equal(cached.status,304);assert.equal(cached.body.length,0);assert.match(cached.headers.vary ?? '',/Accept-Encoding/);
      const range = await rawResponse(url,{...headers,range:'bytes=0-6'});
      assert.equal(range.status,206);assert.equal(range.headers['content-encoding'],undefined);
      assert.deepEqual(range.body,original.subarray(0,7));
    }
    await fs.writeFile(path.join(directory,'app-OLD123.js'),'old cached page');
    const old = await rawResponse(base+'app-OLD123.js',headers);
    assert.equal(old.status,200);assert.equal(old.headers['content-encoding'],undefined);assert.equal(old.body.toString(),'old cached page');
    assert.equal((await rawResponse(base+manifest.script.file+'.gz',headers)).status,404);
  } finally {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTestDir(directory);
  }
});

test('shared asset responder supports authentication and private immutable caching', async () => {
  const directory = await createTestDir('web-assets-http');
  const manifest = await fixture(directory);
  const assets = createAppAssetService(directory);
  const app = express();
  app.get('/assets/app/:name', (req,res,next) => {
    if (req.headers.authorization !== 'test-session') { res.sendStatus(401); return; }
    next();
  }, assets.serveAppAsset);
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/assets/app/`;
    assert.equal((await fetch(base + manifest.script.file)).status,401);
    const headers = {authorization:'test-session'};
    const response = await fetch(base + manifest.script.file,{headers});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, max-age=31536000, immutable');
    assert.equal(await response.text(),'console.log("fixture");');
    assert.equal((await fetch(base+'manifest.json',{headers})).status,404);
    assert.equal((await fetch(base+'app-NOTFOUND.js',{headers})).status,404);
    assert.match(assets.renderAppAssets(), /script defer src="\/assets\/app\/app-ABC123.js"/);
    assert.match(assets.renderAppAssets(), /appAssetError/);
  } finally {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTestDir(directory);
  }
});
