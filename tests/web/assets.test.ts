import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { createAppAssetService } from '../../src/web/server/assets.js';
import { createTestDir, removeTestDir } from '../helpers.js';

async function fixture(directory: string) {
  const script = 'console.log("fixture");', style = 'body { color: black; }';
  const entry = (file: string, content: string) => ({file, sha256:createHash('sha256').update(content).digest('hex')});
  const manifest = {version:1,script:entry('app-ABC123.js',script),style:entry('app-DEF456.css',style)};
  await fs.writeFile(path.join(directory, manifest.script.file), script);
  await fs.writeFile(path.join(directory, manifest.style.file), style);
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
