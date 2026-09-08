import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { BiliUser } from '../../src/users.js';
import { createOnlineContentRouter } from '../../src/http/online-content.js';

test('online read routes preserve validation and caching behind one boundary',async()=>{
  const user:BiliUser={id:'user',uid:1,name:'fixture',cookie:{SESSDATA:'',bili_jct:'',DedeUserID:''},favorites:[],enabled:true,lastLoginAt:''};
  let entered=0;let reads=0;
  const app=express();
  app.use(createOnlineContentRouter({users:{list:()=>[user],getById:id=>id===user.id?user:undefined},archiveStates:()=>new Map(),
    content:{getNavigation:async()=>({accounts:[]}),resolveCover:async()=>null,list:async(_user,query)=>{
      reads++;
      return {items:[],page:{items:[],kind:query.kind,page:query.page||1,pageSize:50,hasMore:false}};
    }},boundary:handler=>(req,res,next)=>{entered++;Promise.resolve().then(()=>handler(req,res,next)).catch(next);},
  }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}/api/online-content`;
  try{
    const navigation=await fetch(base+'/navigation');
    assert.equal(navigation.headers.get('cache-control'),'private, max-age=30');
    const valid=await fetch(base+'/items?userId=user&kind=history');
    assert.equal(valid.status,200);assert.equal(valid.headers.get('cache-control'),'private, no-store');
    for(const suffix of ['kind=invalid','page=0','pageSize=51','mediaId=-1'])assert.equal((await fetch(base+'/items?userId=user&'+suffix)).status,400);
    assert.equal((await fetch(base+'/items?userId=missing')).status,404);
    assert.equal(reads,1);assert.equal(entered,7);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
