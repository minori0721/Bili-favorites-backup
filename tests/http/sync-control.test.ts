import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createSyncControlRouter } from '../../src/http/sync-control.js';

test('sync routes preserve response contracts and pass every command through the application boundary', async () => {
  let entered = 0;
  let mode = 'started';
  const run = () => {if(mode === 'error')throw new Error('isolated failure');return {started:mode==='started',queued:mode==='queued'};};
  const app = express();
  app.use(createSyncControlRouter({sync:run,reconcile:run,remote:run,boundary:handler => (req,res,next) => {
    entered+=1;Promise.resolve().then(() => handler(req,res,next)).catch(next);
  }}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    for(const [path,label] of [['now','Sync'],['reconcile','Reconcile'],['reconcile-remote','Remote-only reconcile']]) {
      for(mode of ['started','queued','busy','error']) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/sync/${path}`,{method:'POST'});
        const body = await response.json();
        assert.equal(response.status,mode==='busy'?409:mode==='error'?500:200);
        if(mode==='started'||mode==='queued') assert.deepEqual(body,{success:true,data:{message:label+(mode==='started'?' triggered':' queued'),queued:mode==='queued'}});
        else assert.equal(body.success,false);
      }
    }
    assert.equal(entered,12);
  } finally {await new Promise<void>((resolve,reject) => server.close(error => error?reject(error):resolve()));}
});
