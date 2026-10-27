import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { StateDatabase } from '../src/database.js';
import { createInstalledReleaseNotice, INSTALLED_RELEASE_MARKER } from '../src/installed-release-notice.js';
import { createUpdatesRouter } from '../src/http/updates.js';
import { decodeUpdatesResponse } from '../src/shared/api/updates.js';
import { updatesFixture } from './fixtures/updates.js';

test('fresh installations skip release notes while each changed dev build is acknowledged once', () => {
  const database = new StateDatabase(':memory:');
  const current = {version:'2.7.2-dev',revision:'a'.repeat(40),buildRef:'dev'};
  const dependencies = {current,newInstallation:true,firstRun:()=>false,
    read:()=>database.getMeta(INSTALLED_RELEASE_MARKER),write:(build:string)=>database.setMeta(INSTALLED_RELEASE_MARKER,build)};
  try {
    const fresh = createInstalledReleaseNotice(dependencies); fresh.initialize(); assert.equal(fresh.pending(),null);
    const same = createInstalledReleaseNotice({...dependencies,newInstallation:false}); same.initialize(); assert.equal(same.pending(),null);
    const updated = createInstalledReleaseNotice({...dependencies,newInstallation:false,current:{...current,revision:'b'.repeat(40)}});
    updated.initialize(); const key = updated.pending(); assert.ok(key);
    assert.equal(updated.acknowledge('stale'),false); assert.equal(updated.pending(),key);
    assert.equal(updated.acknowledge(key),true); assert.equal(updated.pending(),null);
    const restart = createInstalledReleaseNotice({...dependencies,newInstallation:false,current:{...current,revision:'b'.repeat(40),buildRef:'v2.7.2-dev'}});
    assert.equal(restart.pending(),null,'same code and version, including an image-only rebuild, does not repeat');
  } finally { database.close(); }
});

test('existing installations without a browser baseline still show the installed notes', () => {
  let marker:string|null=null;
  const service=createInstalledReleaseNotice({current:{version:'2.7.2',revision:'',buildRef:'main'},newInstallation:false,firstRun:()=>false,
    read:()=>marker,write:build=>{marker=build;}});
  service.initialize(); assert.equal(service.pending(),'2.7.2:main');
  service.acknowledge(); assert.equal(service.pending(),null);
});

test('unfinished first-run setup and database import do not manufacture upgrade popups', () => {
  const original = new StateDatabase(':memory:'), imported = new StateDatabase(':memory:');
  let database = original, firstRun = true;
  const service = createInstalledReleaseNotice({current:{version:'2.7.2-dev',revision:'b'.repeat(40),buildRef:'dev'},newInstallation:false,
    firstRun:()=>firstRun,read:()=>database.getMeta(INSTALLED_RELEASE_MARKER),write:build=>database.setMeta(INSTALLED_RELEASE_MARKER,build)});
  try {
    service.initialize(); assert.equal(service.pending(),null);
    firstRun=false; assert.equal(service.pending(),null);
    database=imported; assert.ok(service.pending()); service.acknowledge(); assert.equal(service.pending(),null);
    assert.ok(original.getMeta(INSTALLED_RELEASE_MARKER));
  } finally { original.close(); imported.close(); }
});

test('older update responses remain supported and malformed notice identities are rejected', () => {
  const fixture=updatesFixture();
  assert.equal(decodeUpdatesResponse(fixture).installedNotice,undefined);
  assert.equal(decodeUpdatesResponse({...fixture,installedNotice:null}).installedNotice,null);
  for(const installedNotice of ['',3,{},'x'.repeat(200)])assert.throws(()=>decodeUpdatesResponse({...fixture,installedNotice}),/格式异常/);
});

test('release acknowledgement rejects malformed or stale builds without changing its marker', async () => {
  let writes=0;
  const app=express(); app.use(express.json());
  app.use(createUpdatesRouter({check:async()=>({}),seenInstalled:build=>{if(build!=='current')return false;writes++;return true;},
    boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const post=(body:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/updates/installed/seen`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    assert.equal((await post({})).status,400);assert.equal((await post({build:'old'})).status,409);assert.equal(writes,0);
    assert.equal((await post({build:'current'})).status,200);assert.equal(writes,1);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
