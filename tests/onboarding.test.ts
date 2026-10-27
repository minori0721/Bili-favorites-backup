import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { StateDatabase } from '../src/database.js';
import { createOnboardingService, isNewInstallation } from '../src/onboarding-service.js';
import { ONBOARDING_MARKER, parseOnboardingStatus } from '../src/shared/api/onboarding.js';
import { createOnboardingRouter } from '../src/http/onboarding.js';
import { createTestDir, removeTestDir } from './helpers.js';

test('first-run marker survives a restart and completion is installation-wide', async () => {
  const directory = await createTestDir('onboarding-persistence');
  const fresh = isNewInstallation(directory);
  let database = new StateDatabase(path.join(directory, 'bfb.sqlite'));
  const service = createOnboardingService({newInstallation:fresh,read:()=>database.getMeta(ONBOARDING_MARKER),write:value=>database.setMeta(ONBOARDING_MARKER,value)});
  try {
    service.initialize(); assert.deepEqual(service.status(), {autoStart:true});
    database.close(); database = new StateDatabase(path.join(directory, 'bfb.sqlite'));
    const restarted = createOnboardingService({newInstallation:false,read:()=>database.getMeta(ONBOARDING_MARKER),write:value=>database.setMeta(ONBOARDING_MARKER,value)});
    restarted.initialize(); assert.equal(restarted.status().autoStart,true);
    restarted.finish(); service.initialize(); assert.equal(service.status().autoStart,false);
  } finally { database.close(); await removeTestDir(directory); }
});

test('existing and partially restored installations are not inferred from empty account lists', async () => {
  for (const file of ['config.json','users.json','state.json','bfb.sqlite','bfb.sqlite-wal','auth-sessions.sqlite']) {
    const directory = await createTestDir('onboarding-existing');
    try { fs.writeFileSync(path.join(directory,file),'isolated'); assert.equal(isNewInstallation(directory),false,file); }
    finally { await removeTestDir(directory); }
  }
  assert.throws(()=>isNewInstallation(path.join('work','onboarding-directory-that-does-not-exist')));
});

test('old databases and restored connections stay separate from fresh setup', () => {
  const original = new StateDatabase(':memory:'), restored = new StateDatabase(':memory:');
  let current = original;
  const service = createOnboardingService({newInstallation:false,read:()=>current.getMeta(ONBOARDING_MARKER),write:value=>current.setMeta(ONBOARDING_MARKER,value)});
  try {
    service.initialize(); assert.equal(service.status().autoStart,false);
    original.setMeta(ONBOARDING_MARKER,'pending'); assert.equal(service.status().autoStart,true);
    current = restored; assert.equal(service.status().autoStart,false);
    service.finish(); assert.equal(restored.getMeta(ONBOARDING_MARKER),'complete');
    assert.equal(original.getMeta(ONBOARDING_MARKER),'pending');
    restored.setMeta(ONBOARDING_MARKER,'invalid'); assert.throws(()=>service.status(),/损坏/);
  } finally { original.close(); restored.close(); }
});

test('onboarding status accepts only an explicit boolean and never invents first-run success', () => {
  assert.deepEqual(parseOnboardingStatus({autoStart:false}),{autoStart:false});
  for (const value of [null,{},[],{autoStart:1},{autoStart:'true'}]) assert.throws(()=>parseOnboardingStatus(value),/格式错误/);
});

test('HTTP onboarding status is not cached and completion changes only its marker', async () => {
  let pending = true, writes = 0;
  const app = express();
  app.use(createOnboardingRouter({status:()=>({autoStart:pending}),finish:()=>{pending=false;writes++;},boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address = server.address(); assert.ok(address&&typeof address==='object');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(url+'/api/onboarding');
    assert.match(response.headers.get('cache-control')||'',/no-store/);
    assert.deepEqual(await response.json(),{success:true,data:{autoStart:true}}); assert.equal(writes,0);
    assert.equal((await fetch(url+'/api/onboarding/seen',{method:'POST'})).status,200);
    assert.equal(writes,1);
    assert.deepEqual(await (await fetch(url+'/api/onboarding')).json(),{success:true,data:{autoStart:false}});
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
