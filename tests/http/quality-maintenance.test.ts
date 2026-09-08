import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createQualityMaintenanceRouter } from '../../src/http/quality-maintenance.js';
import { parseQualityPreview, parseQualityResult, parseQualityState } from '../../src/web/client/features/settings/quality-contract.js';

test('quality routes validate a whole batch and preserve the maintenance boundary and response envelopes',async()=>{
  let entered=0;let submitted=0;let limit:number|undefined;
  const app=express();app.use(express.json());
  app.use(createQualityMaintenanceRouter({
    boundary:handler=>(req,res,next)=>{entered++;Promise.resolve().then(()=>handler(req,res,next)).catch(next);},
    detailLimit:value=>typeof value==='number'?value:undefined,
    state:()=>({running:[],completed:[]}),
    service:{preview:value=>{limit=value;return {candidates:[],uncertain:[],skipped:[],skippedTotal:0,skippedByReason:{},target:{quality:'',encoding:'',hiRes:false,dolby:false}};},
      submit:()=>{submitted++;return {queued:[],skipped:[],downloadGroups:0};}},
  }));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}/api/quality-upgrade`;
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    const preview=await post('/preview',{detailLimit:50});assert.equal(preview.status,200);assert.equal(limit,50);assert.equal(parseQualityPreview((await preview.json()).data).candidates.length,0);
    const invalid=await post('',{items:[{key:'valid'},null]});assert.equal(invalid.status,400);assert.equal(submitted,0);
    const valid=await post('',{items:[{key:'fixture'}]});assert.equal(valid.status,200);assert.equal(parseQualityResult((await valid.json()).data).downloadGroups,0);assert.equal(submitted,1);
    const state=await fetch(base+'/state');assert.equal(parseQualityState((await state.json()).data).completed,0);assert.equal(entered,3);
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
