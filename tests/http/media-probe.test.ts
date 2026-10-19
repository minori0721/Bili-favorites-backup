import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMediaProbeRouter } from '../../src/http/media-probe.js';
import { createMediaProbeRequests } from '../../src/media-probe-service.js';
import { MediaProbeService } from '../../src/media-probe.js';
import { isRecord } from '../../src/shared/api/value.js';
import { parseProbeReference, parseProbeSummary } from '../../src/shared/api/media-probe.js';
import type { BiliUser } from '../../src/users.js';
import { testConfig } from '../helpers.js';

test('HTTP preview reuse reaches the real per-video probe cache and validates optional input',async context=>{
  context.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T00:00:00Z')});
  const user:BiliUser={id:'test',uid:1,name:'test',enabled:true,favorites:[],lastLoginAt:'',cookie:{SESSDATA:'',bili_jct:'',DedeUserID:'1'}};
  let calls=0;
  const probe=new MediaProbeService({get:()=>testConfig()},async bvid=>{
    calls++;return {bvid,source:'bbdown',pages:[{version:1,bvid,cid:'1',pageIndex:1,pageTitle:'one',tracks:[{bilibiliQuality:'4K',codec:'HEVC'}]}]};
  });
  const app=express();app.use(express.json());
  app.use(createMediaProbeRouter({service:createMediaProbeRequests({users:{getById:id=>id===user.id?user:null},probe}),
    boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}/api/media-probe`;
  const post=(reuse:unknown,bvid='BVtest')=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:'test',bvid,reuse})});
  const data=async(response:Response)=>{const value:unknown=await response.json();assert.ok(isRecord(value)&&value.success===true);return value.data;};
  try {
    assert.equal((await post('true')).status,400);assert.equal(calls,0);
    const first=await post(true);assert.equal(first.status,202);const id=parseProbeReference(await data(first));
    const state=await fetch(base+'/'+id);assert.equal(parseProbeSummary(await data(state)).status,'complete');
    assert.equal(parseProbeReference(await data(await post(true))),id);assert.equal(calls,1);
    assert.equal((await post(true,'BVother')).status,409);
    context.mock.timers.tick(2_001);
    const other=parseProbeReference(await data(await post(true,'BVother')));assert.notEqual(other,id);
    const otherResult=await data(await fetch(base+'/'+other));
    assert.ok(isRecord(otherResult));assert.equal(otherResult.bvid,'BVother');assert.equal(calls,2);
    assert.equal(parseProbeReference(await data(await post(true))),id);assert.equal(calls,2);
    const fresh=parseProbeReference(await data(await post(undefined)));assert.notEqual(fresh,id);assert.equal(calls,3);
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
