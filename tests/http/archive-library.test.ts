import express from 'express';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';
import type { BiliUser } from '../../src/users.js';
import { createArchiveLibraryService } from '../../src/archive-library-service.js';
import { createArchiveLibraryRouter } from '../../src/http/archive-library.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir } from '../helpers.js';

test('archive artwork validates identity, serves cached files and follows replacement storage',async()=>{
  const root=await createTestDir('archive-artwork');
  const first=new StateManager({dbPath:path.join(root,'first.sqlite'),statePath:path.join(root,'first.json')});
  const second=new StateManager({dbPath:path.join(root,'second.sqlite'),statePath:path.join(root,'second.json')});
  const picture=path.join(root,'cover.svg');await fs.writeFile(picture,'<svg xmlns="http://www.w3.org/2000/svg"/>');
  let current=first;const calls:number[][]=[];const avatars:Array<[number,string]>=[];
  const users:BiliUser[]=[{id:'owner',uid:123,name:'Name is not identity',avatar:'',enabled:true,lastLoginAt:'',favorites:[{mediaId:10,title:'Folder'}],cookie:{SESSDATA:'',bili_jct:'',DedeUserID:''}}];
  first.recordFavoriteItem('owner',11,'Old',{bvid:'BVARTWORK',title:'Video',upperName:'UP'});
  const source=first.getDatabase().upSubscriptions.create({uid:987,name:'Name can change',avatar:'https://i0.hdslb.com/bfs/face/real.jpg',signature:''},{uid:987,userId:'owner',mode:'all'},null,Date.now());
  const service=createArchiveLibraryService({database:()=>current.getDatabase(),users:()=>users,
    artwork:{folder:async(uid,mediaId)=>{calls.push([uid,mediaId]);return mediaId===10?picture:null;},avatar:async(uid,url)=>{avatars.push([uid,url]);return picture;}}});
  const app=express();app.use(createArchiveLibraryRouter(service));const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}/api/archive-library/artwork`;
  try{
    const valid=await fetch(base+'?userId=owner&mediaId=10');assert.equal(valid.status,200);assert.match(await valid.text(),/<svg/);
    assert.equal(valid.headers.get('cache-control'),'private, max-age=300');
    assert.equal((await fetch(base+'?userId=owner&mediaId=11')).status,404);
    assert.deepEqual(calls,[[123,10],[123,11]]);
    assert.equal((await fetch(base+'?userId=owner&mediaId='+source.routingKey)).status,200);
    assert.deepEqual(avatars,[[987,'https://i0.hdslb.com/bfs/face/real.jpg']]);
    assert.equal((await fetch(base+'?userId=other&mediaId='+source.routingKey)).status,404);assert.equal(avatars.length,1);
    assert.equal((await fetch(base+'?userId=other&mediaId=10')).status,404);
    for(const media of ['0','-1','abc','10.5'])assert.equal((await fetch(base+'?userId=owner&mediaId='+media)).status,400);
    current=second;first.close();
    assert.equal((await fetch(base+'?userId=owner&mediaId=11')).status,404);assert.equal(calls.length,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));first.close();second.close();await removeTestDir(root);}
});

test('archive routes retain contracts and resolve current storage after a rebind', async () => {
  const root = await createTestDir('archive-routes');
  const first = new StateManager({ dbPath: path.join(root, 'first.sqlite'), statePath: path.join(root, 'first.json') });
  const second = new StateManager({ dbPath: path.join(root, 'second.sqlite'), statePath: path.join(root, 'second.json') });
  let current = first;
  let reads = 0;
  const service = createArchiveLibraryService({ database: () => { reads++; return current.getDatabase(); }, users: () => [] });
  const app = express(); app.use(createArchiveLibraryRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/archive-library`;
  try {
    const navigation = await fetch(base + '/navigation');
    assert.equal(navigation.status, 200);
    assert.equal(navigation.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await navigation.json()).data.summary, {
      total: 0, playable: 0, pending: 0, issue: 0, deleted: 0,
      sourceReferenceCount: 0, uniqueRemotePathCount: 0, lastSyncedAt: '',
    });
    assert.equal((await fetch(base + '/items?pageSize=51')).status, 400);
    assert.equal((await fetch(base + '/items/BVMISSING')).status, 404);
    assert.equal((await fetch(base + '/playback-queue?direction=invalid')).status, 400);
    assert.equal((await fetch(base + '/playback-search?queueQ=test&page=0')).status, 400);
    current = second;
    first.close();
    const rebound = await fetch(base + '/items');
    assert.equal(rebound.status, 200);
    assert.deepEqual((await rebound.json()).data, JSON.parse(JSON.stringify(service.items({}))));
    assert.equal(reads, 4);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    first.close(); second.close(); await removeTestDir(root);
  }
});
