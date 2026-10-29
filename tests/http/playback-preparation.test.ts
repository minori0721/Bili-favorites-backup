import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { StateDatabase } from '../../src/database.js';
import type { StateFile, RemoteFileRecord, FavoriteRelation, VideoArchiveEntry } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import { createPlaybackService } from '../../src/playback-service.js';
import { createPlaybackRouter } from '../../src/http/playback.js';
import { testConfig } from '../helpers.js';
import { parsePlaybackPreparationTargets } from '../../src/shared/api/playback-queue.js';

function fixture() {
  const state: StateFile = {processedByUser:{},videos:{},relations:{}};
  const add = (bvid:string, mediaId:number, remotePath:string, backupStatus:FavoriteRelation['backupStatus']='verified') => {
    const file:RemoteFileRecord = {name:remotePath.split('/').at(-1)!,path:remotePath,size:128,verificationStatus:'verified'};
    const common={bvid,title:bvid,firstSeenAt:'2026-10-01T00:00:00Z',lastSeenAt:'2026-10-01T00:00:00Z',backupStatus,remotePath:remotePath.slice(0,remotePath.lastIndexOf('/')),remoteFiles:[file]};
    const video:VideoArchiveEntry={...common,upperName:'fixture UP',biliStatus:'available'};
    const relation:FavoriteRelation={...common,userId:'owner',mediaId,folderTitle:'fixture folder',activeInFavorite:true};
    state.videos![bvid]=video; state.relations![`owner:${mediaId}:${bvid}`]=relation;
  };
  add('BVFIRST001',10,'/archive/A/first.mp4');
  add('BVSECOND002',10,'/archive/A/second.mp4');
  add('BVTHIRD003',20,'/archive/B/third.mp4');
  add('BVFIRST001',-2,'/archive/A/first.mp4'); // an UP source reuses the favorite's file.
  add('BVPENDING004',30,'/archive/C/pending.mp4','uploaded');
  const original=state.relations!['owner:10:BVFIRST001'];
  state.relations={unavailable:{...original,userId:'unavailable-owner'},...state.relations};
  return state;
}

async function harness() {
  const first=new StateDatabase(':memory:'); first.replaceState(fixture());
  const current={database:first,config:testConfig({alistUrl:'http://storage.local',playbackDeliveryMode:'auto'})};
  const requests:{method:string;range:string|null}[]=[], reads:string[]=[];
  let gate:Promise<void>|null=null, dnsAddress='93.184.216.34',upstreamStatus=302;
  let respond:((method:string)=>Promise<Response>)|undefined;
  const user:BiliUser={id:'owner',uid:1,name:'fixture',cookie:{SESSDATA:'',bili_jct:'',DedeUserID:''},favorites:[],enabled:true,lastLoginAt:''};
  const service=createPlaybackService({
    database:()=>current.database,config:()=>current.config,users:{getById:id=>id==='owner'?user:null},isKnownOwner:()=>false,
    updateMetadata:()=>{throw new Error('not used');},
    readDirectory:async(_config,directory,signal)=>{signal.throwIfAborted();reads.push(directory);},
    transport:{lookup:async()=>[{address:dnsAddress,family:4}],fetch:async(_url,init)=>{
      requests.push({method:init?.method??'GET',range:new Headers(init?.headers).get('range')});
      if(gate)await gate;
      if(respond)return respond(init?.method??'GET');
      if(upstreamStatus!==302)return new Response(null,{status:upstreamStatus});
      return new Response(null,{status:302,headers:{Location:`https://cdn.example/video?Expires=${Math.floor(Date.now()/1000)+600}&Signature=${requests.length}`}});
    }},
  });
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.sessionID='isolated-playback-fixture';next();});
  app.use(createPlaybackRouter({service,boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const fileId=(bvid:string,mediaId=10)=>current.database.db.prepare<[string,number],{id:number}>('SELECT id FROM remote_files WHERE bvid=? AND media_id=?').get(bvid,mediaId)!.id;
  const stream=(id:number,query='',mediaId=10)=>`${base}/api/users/owner/favorites/${mediaId}/playback/files/${id}${query}`;
  return {current,service,requests,reads,base,fileId,stream,setGate:(value:Promise<void>|null)=>{gate=value;},setAddress:(value:string)=>{dnsAddress=value;},setStatus:(value:number)=>{upstreamStatus=value;},
    setResponse:(value:(method:string)=>Promise<Response>)=>{respond=value;},
    async close(){service.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));current.database.close();if(current.database!==first)first.close();}};
}

test('preparation HTTP groups actual directories, prioritizes a source and never accepts a supplied path',async()=>{
  const h=await harness();try{
    const response=await fetch(h.base+'/api/playback/preparation-targets?userId=owner&mediaId=20');
    const data=(await response.json()).data;
    const targets=parsePlaybackPreparationTargets(data);assert.equal(targets.length,2);assert.equal(targets[0].mediaId,20);
    assert.equal(targets.every(target=>target.userId==='owner'),true,'unavailable owners must not displace usable shared directory representatives');
    assert.equal(JSON.stringify(data).includes('/archive/'),false);
    assert.equal(targets.some(x=>x.mediaId===30),false);
    assert.equal((await fetch(h.base+'/api/playback/preparation-targets?mediaId=0')).status,400);
    assert.equal((await fetch(h.base+'/api/playback/preparation-targets?userId[]=owner')).status,400);
    const url=h.stream(h.fileId('BVFIRST001'))+'/prepare';
    const prepared=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'directory',path:'/not-authorized'})});
    assert.equal(prepared.status,200);assert.deepEqual(h.reads,['/archive/A']);
    assert.equal(h.requests.length,0,'directory preparation must not acquire every video link');
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"delete"}'})).status,400);
    assert.equal((await fetch(h.stream(999999)+'/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"link"}'})).status,404);
  }finally{await h.close();}
});

test('real playback wiring reuses prepared signed links, refreshes once on request and rechecks deletion',async()=>{
  const h=await harness();try{
    const id=h.fileId('BVFIRST001'), url=h.stream(id), attempt='a'.repeat(32);
    assert.equal((await fetch(url+'/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"link"}'})).status,200);
    assert.deepEqual(h.requests,[{method:'HEAD',range:null}]);
    const first=await fetch(url+'?attempt='+attempt,{redirect:'manual',headers:{Range:'bytes=5-11'}});
    assert.equal(first.status,302);assert.equal(first.headers.get('cache-control'),'private, no-store');assert.equal(h.requests.length,1);
    const delivery=await fetch(h.base+'/api/users/owner/favorites/10/playback/delivery/'+attempt);
    assert.equal((await delivery.json()).data.cachedDirect,true);
    const refreshed=await fetch(url+'?refresh=1',{redirect:'manual',headers:{Range:'bytes=5-11'}});
    assert.equal(refreshed.status,302);assert.notEqual(refreshed.headers.get('location'),first.headers.get('location'));
    assert.deepEqual(h.requests[1],{method:'GET',range:'bytes=5-11'});
    assert.equal((await fetch(url+'?refresh=yes',{redirect:'manual'})).status,400);
    h.current.database.db.prepare("UPDATE favorite_relations SET backup_status='deleted' WHERE bvid=? AND media_id=10").run('BVFIRST001');
    assert.equal((await fetch(url,{redirect:'manual'})).status,404);assert.equal(h.requests.length,2);
  }finally{await h.close();}
});

test('storage configuration and database replacement discard cached locations and reject late results',async()=>{
  const h=await harness();try{
    const url=h.stream(h.fileId('BVFIRST001'));
    assert.equal((await fetch(url,{redirect:'manual'})).status,302);assert.equal(h.requests.length,1);
    h.current.config={...h.current.config,alistPassword:'different-fixture-credential'};
    assert.equal((await fetch(url,{redirect:'manual'})).status,302);assert.equal(h.requests.length,2);
    const replacement=new StateDatabase(':memory:');replacement.replaceState(fixture());h.current.database=replacement;
    assert.equal((await fetch(url,{redirect:'manual'})).status,302);assert.equal(h.requests.length,3);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});h.setGate(gate);
    const held=fetch(h.stream(h.fileId('BVSECOND002')),{redirect:'manual'});
    while(h.requests.length<4)await new Promise<void>(resolve=>setImmediate(resolve));
    h.current.config={...h.current.config,alistUrl:'http://another-storage.local'};release();
    assert.equal((await held).status,409);
    h.setGate(null);assert.equal((await fetch(h.stream(h.fileId('BVSECOND002')),{redirect:'manual'})).status,302);
    assert.equal(h.requests.length,5);
  }finally{await h.close();}
});

test('file replacement changes cache identity and a cached redirect still checks current DNS',async()=>{
  const h=await harness();try{
    const id=h.fileId('BVFIRST001'),url=h.stream(id);
    const first=await fetch(url,{redirect:'manual'});assert.equal(first.status,302);
    h.current.database.db.prepare('UPDATE remote_files SET put_completed_at=? WHERE id=?').run(Date.now(),id);
    const replaced=await fetch(url,{redirect:'manual'});assert.equal(replaced.status,302);
    assert.notEqual(replaced.headers.get('location'),first.headers.get('location'));assert.equal(h.requests.length,2);
    h.setAddress('10.0.0.2');
    const unsafe=await fetch(url,{redirect:'manual'});assert.equal(unsafe.status,502);assert.equal(unsafe.headers.get('location'),null);
    assert.equal(h.requests.length,2,'unsafe cache hits never make an upstream request');
  }finally{await h.close();}
});

test('link preparation distinguishes unavailable storage from a provider that supplies no direct link',async()=>{
  const h=await harness();try{
    const url=h.stream(h.fileId('BVFIRST001'))+'/prepare';
    const init={method:'POST',headers:{'Content-Type':'application/json'},body:'{"kind":"link"}'};
    h.setStatus(200);const proxy=await fetch(url,init);assert.equal(proxy.status,200);assert.equal((await proxy.json()).data.prepared,false);
    h.setStatus(429);const limited=await fetch(url,init);assert.equal(limited.status,503);assert.equal((await limited.json()).success,false);
  }finally{await h.close();}
});

test('proxy fallback drops the current file redirect instead of retaining a failed cached address',async()=>{
  const h=await harness();try{
    const url=h.stream(h.fileId('BVFIRST001'));
    await fetch(url,{redirect:'manual'});assert.equal(h.requests.length,1);
    h.setStatus(200);
    const proxy=await fetch(url+'?delivery=proxy');assert.equal(proxy.status,200);assert.equal(h.requests.length,2);
    h.setStatus(302);
    assert.equal((await fetch(url,{redirect:'manual'})).status,302);assert.equal(h.requests.length,3);
  }finally{await h.close();}
});

test('late proxy bodies and HEAD compatibility responses cannot cross a storage change',async()=>{
  for(const mode of ['proxy','head-direct','head-proxy']){
    const h=await harness();try{
      let release!:()=>void,canceled=false;
      const gate=new Promise<void>(resolve=>{release=resolve;});
      h.setResponse(async method=>{
        if(method==='HEAD')return new Response(null,{status:405});
        await gate;
        return mode==='head-direct'
          ? new Response(null,{status:302,headers:{Location:'https://cdn.example/late?Expires=9999999999'}})
          : new Response(new ReadableStream({cancel(){canceled=true;}}));
      });
      const held=fetch(h.stream(h.fileId('BVFIRST001')),{method:mode==='proxy'?'GET':'HEAD',redirect:'manual'});
      while(h.requests.length<(mode==='proxy'?1:2))await new Promise<void>(resolve=>setImmediate(resolve));
      h.current.config={...h.current.config,alistUrl:'http://replacement-storage.local'};release();
      const response=await held;
      assert.equal(response.status,409,mode);assert.equal(response.headers.get('location'),null,mode);
      if(mode!=='head-direct')assert.equal(canceled,true,mode+' must release the rejected body');
    }finally{await h.close();}
  }
});
