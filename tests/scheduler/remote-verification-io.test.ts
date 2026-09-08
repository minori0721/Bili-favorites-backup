import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteVerificationIO } from '../../src/scheduler/remote-verification-io.js';

test('cache invalidation prevents an old directory observation from populating a new generation', async () => {
  let resolveOld!:(names:string[])=>void;
  let reads=0;
  const io=createRemoteVerificationIO({now:()=>100,sleep:async()=>{},list:async()=>{
    reads++;
    if(reads===1)return new Promise<string[]>(resolve=>{resolveOld=resolve;});
    return ['current'];
  }});
  const old=io.list('/folder');
  io.reset();
  assert.deepEqual(await io.list('/folder'),['current']);
  resolveOld(['old']);
  assert.deepEqual(await old,['old']);
  assert.deepEqual(await io.list('/folder'),['current']);
  assert.equal(reads,2);
});

test('path reservations preserve the global rate and extra same-path spacing', async () => {
  const sleeps:number[]=[];
  const io=createRemoteVerificationIO({now:()=>1000,list:async()=>[],sleep:async ms=>{sleeps.push(ms);}});
  await io.waitForSlot(2,'/one');
  await io.waitForSlot(2,'/two');
  await io.waitForSlot(2,'/two');
  assert.deepEqual(sleeps,[500,1250]);
  io.reset();
  await io.waitForSlot(2,'/two');
  assert.equal(sleeps.length,2);
});
