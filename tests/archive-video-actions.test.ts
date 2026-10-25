import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { StateManager } from '../src/state.js';
import { ArchiveDeletionService, type ArchiveDeletionOptions } from '../src/archive-deletion.js';
import { createArchiveVideoActions } from '../src/archive-video-actions.js';
import { createArchiveVideoActionsRouter } from '../src/http/archive-video-actions.js';
import { createHttpErrorHandler } from '../src/http/request-boundary.js';
import { matchesDeletedSource,sourceAdmissionBlocked } from '../src/scheduler/source-admission.js';
import { parseArchiveVideoContext,parseArchiveVideoPreview } from '../src/shared/api/archive-video-actions.js';
import { archiveDeletionImpactText } from '../src/web/client/shared/archive-deletion-impact.js';
import { memoryUsers } from './fixtures/memory-users.js';
import { createTestDir,removeTestDir,testConfig } from './helpers.js';

const bv='BVSHAREDACTION';
async function fixture() {
  const dir=await createTestDir('archive-video-actions');
  const state=new StateManager({dbPath:':memory:',statePath:path.join(dir,'missing.json')});
  const users=memoryUsers([{id:'u1',uid:1,name:'测试账号',cookie:{SESSDATA:'isolated',bili_jct:'isolated',DedeUserID:'1'},favorites:[{mediaId:11,title:'收藏夹 A'},{mediaId:12,title:'收藏夹 B'}],enabled:true,lastLoginAt:new Date().toISOString()}]);
  const repository=()=>state.getDatabase().upSubscriptions;
  const up=repository().create({uid:42,name:'订阅 UP',avatar:'',signature:''},{uid:42,userId:'u1',mode:'all'},null,Date.now());
  repository().recordPage(up.id,[{bvid:bv,title:'共同视频',cover:'',publishedAt:1000,ownerUid:42,ownerName:'订阅 UP',duration:1,joint:false}]);
  const remote=new Map<string,number>();let failDelete=false,now=Date.now();
  const maintenance:Parameters<NonNullable<ArchiveDeletionOptions['setMaintenance']>>[1][]=[];
  const config=testConfig();
  const initialDestination=config.alistDest;
  const deletion=new ArchiveDeletionService(state,{get:()=>config},users,{isSchedulerIdle:()=>true,setMaintenance:(locked,summary)=>{if(locked)maintenance.push(summary);},
    clientFactory:()=>({async stat(file){if(!remote.has(file))throw Object.assign(new Error('missing'),{status:404});return {type:'file',size:remote.get(file)};},
      async deleteFile(file){if(failDelete)throw Object.assign(new Error('isolated denial'),{status:403});remote.delete(file);},async getDirectoryContents(){return [];}})});
  const ingested:string[]=[];
  const actions=createArchiveVideoActions({repository,relations:bvid=>state.listRelationsForBvid(bvid),accountName:()=> '测试账号',title:bvid=>state.getDatabase().getVideo(bvid)?.title??bvid,ingest:(_source,item)=>ingested.push(item.bvid),
    atomic:work=>state.runAtomic(work),restoreSource:(u,m,b,at)=>state.getDatabase().restoreCompletedArchiveSource(u,m,b,at),blocked:()=>false,deletion,now:()=>now});
  function add(mediaId:number,file='/backup/shared/video.mp4',size=42,bvid=bv) {
    if(mediaId===up.routingKey)state.recordUpSubscriptionItem(up.id,'u1',mediaId,'UP · 订阅 UP',{bvid,title:'共同视频',upperName:'UP'});
    else state.recordFavoriteItem('u1',mediaId,`收藏夹 ${mediaId}`,{bvid,title:'共同视频',upperName:'UP'});
    remote.set(file,size);
    state.restoreExistingArchiveProof(bvid,'u1',mediaId,{status:'verified',remotePath:path.posix.dirname(file),files:[{name:path.posix.basename(file),path:file,size,verificationStatus:'verified'}]});
  }
  return {state,repository,up,actions,deletion,remote,maintenance,add,ingested,changeDestination(){config.alistDest='/changed';},restoreDestination(){config.alistDest=initialDestination;},advance(){now+=11*60_000;},fail(){failDelete=true;},
    async close(){assert.equal(await deletion.stop(5000),true);state.close();await removeTestDir(dir);}};
}
async function completed(deletion:ArchiveDeletionService,id:string,expected='completed') {
  for(let i=0;i<200;i++){const operation=deletion.get(id);if(operation?.status===expected)return operation;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(`cleanup did not reach ${expected}`);
}
test('a favorite can be persistently excluded and restored without changing other favorite or UP rules',async()=>{
  const f=await fixture();try{
    f.add(11);f.add(12);f.add(f.up.routingKey);
    const context=parseArchiveVideoContext(f.actions.context(bv,{userId:'u1',mediaId:11}));assert.equal(context.sources.length,3);
    const preview=parseArchiveVideoPreview(f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'source',effect:'retain'}));
    f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),true);
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',12,bv),false);
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',f.up.routingKey,bv),false);assert.equal(f.remote.size,1);
    const restoreDir=await createTestDir('archive-actions-restore');
    const target=new StateManager({dbPath:':memory:',statePath:path.join(restoreDir,'missing.json')});
    try{target.replaceStateSnapshot(f.state.getStateSnapshot());assert.equal(target.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),true);}finally{target.close();await removeTestDir(restoreDir);}
    f.actions.unblock(bv,{userId:'u1',mediaId:11,scope:'source'});
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),false);
  }finally{await f.close();}
});
test('source deletion keeps a shared physical file and reports zero actual deletion and released bytes',async()=>{
  const f=await fixture();try{
    f.add(11);f.add(12);f.add(f.up.routingKey);
    const preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'source',effect:'delete'});
    assert.deepEqual([preview.fileCount,preview.sharedCount,preview.deleteCount,preview.reclaimableBytes],[1,1,0,0]);
    for(const field of ['fileCount','sharedCount','deleteCount','reclaimableBytes'])assert.throws(()=>parseArchiveVideoPreview({...preview,[field]:-1}));
    assert.throws(()=>parseArchiveVideoPreview({...preview,deleteCount:2}));
    assert.match(archiveDeletionImpactText(preview,String),/实际删除 0 个文件/);
    const result=f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);
    await completed(f.deletion,result.operation.id);assert.equal(f.remote.size,1);
    assert.equal(f.state.getRelationStatus('u1',12,bv)?.backupStatus,'verified');assert.equal(f.state.getRelationStatus('u1',f.up.routingKey,bv)?.backupStatus,'verified');
    const summary=f.maintenance.find(item=>item?.scope==='video');assert.ok(summary);
    assert.equal(matchesDeletedSource({...summary,scope:'video'}, {userId:'u1',mediaId:12},bv),false);
    assert.equal(sourceAdmissionBlocked(false,{...summary,scope:'video'},{bvid:bv,userId:'u1',mediaId:12}),false);
  }finally{await f.close();}
});
test('selected sources delete only their own copy, retaining another source and its independent copy',async()=>{
  const f=await fixture();try{
    f.add(11,'/backup/a/video.mp4',10);f.add(f.up.routingKey,'/backup/a/video.mp4',10);f.add(12,'/backup/b/video.mp4',20);
    const preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'selected',effect:'delete',sources:[{userId:'u1',mediaId:11},{userId:'u1',mediaId:f.up.routingKey}]});
    assert.deepEqual([preview.fileCount,preview.sharedCount,preview.deleteCount,preview.reclaimableBytes],[1,0,1,10]);
    const result=f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);await completed(f.deletion,result.operation.id);
    assert.equal(f.remote.has('/backup/a/video.mp4'),false);assert.equal(f.remote.has('/backup/b/video.mp4'),true);
    assert.equal(f.state.getRelationStatus('u1',12,bv)?.backupStatus,'verified');assert.equal(f.repository().globallyExcluded(bv),false);
  }finally{await f.close();}
});
test('global exclusion affects future sources; undoing it keeps independent source exclusions',async()=>{
  const f=await fixture();try{
    f.add(11);f.add(12);
    let preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'source',effect:'retain'});f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});
    preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'global',effect:'delete'});
    const result=f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);await completed(f.deletion,result.operation.id);
    assert.equal(f.remote.size,0);assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',999,bv),true);
    f.actions.unblock(bv,{userId:'u1',mediaId:11,scope:'global'});
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),true);assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',12,bv),false);
  }finally{await f.close();}
});
test('expired, cross-source and expanded global previews cannot mutate rules or remote files',async()=>{
  const f=await fixture();try{
    f.add(11);f.add(12);
    let preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'source',effect:'delete'});
    assert.throws(()=>f.actions.commit(bv,{userId:'u1',mediaId:12,previewId:preview.previewId,confirmation:preview.confirmation}),/不属于/);
    f.advance();assert.throws(()=>f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation}),/失效/);
    preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'global',effect:'delete'});f.add(f.up.routingKey);
    assert.throws(()=>f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation}),/变化/);
    assert.equal(f.repository().globallyExcluded(bv),false);assert.equal(f.remote.size,1);
    assert.throws(()=>f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'selected',effect:'delete',sources:[]}),/请选择/);
    assert.throws(()=>f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'selected',effect:'delete',sources:[{userId:'u1',mediaId:999}]}),/变化/);
  }finally{await f.close();}
});
test('a failed deletion preserves the original file and the explicit source exclusion',async()=>{
  const f=await fixture();try{
    f.add(11);f.fail();const preview=f.actions.preview(bv,{userId:'u1',mediaId:11,scope:'source',effect:'delete'});
    const result=f.actions.commit(bv,{previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);await completed(f.deletion,result.operation.id,'failed');
    assert.equal(f.remote.size,1);assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),true);
  }finally{await f.close();}
});
test('the actual HTTP router decodes and commits the same source preview without exposing credential records',async()=>{
  const f=await fixture();const app=express();app.use(express.json());
  app.use(createArchiveVideoActionsRouter({service:f.actions,boundary:handler=>(req,res,next)=>{Promise.resolve(handler(req,res,next)).catch(next);}}));
  app.use(createHttpErrorHandler(()=>{}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    f.add(11);f.add(12);const address=server.address();assert.ok(address&&typeof address!=='string');
    const post=async(action:string,body:unknown)=>{const response=await fetch(`http://127.0.0.1:${address.port}/api/archive-library/items/${bv}/actions/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
    const context=await post('context',{userId:'u1',mediaId:11});assert.equal(context.status,200);assert.equal(JSON.stringify(context.data).includes('SESSDATA'),false);
    const preview=await post('preview',{userId:'u1',mediaId:11,scope:'source',effect:'retain'});assert.equal(preview.status,200);
    const decoded=parseArchiveVideoPreview(preview.data.data);
    const committed=await post('commit',{previewId:decoded.previewId,confirmation:decoded.confirmation});assert.equal(committed.status,200);
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',11,bv),true);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('a rejected deletion submission rolls back its rule changes and keeps the preview reusable',async()=>{
  const f=await fixture();try{
    f.add(f.up.routingKey);
    const preview=f.actions.preview(bv,{sourceId:f.up.id,scope:'source',effect:'delete'});
    const revision=f.repository().get(f.up.id)!.revision;
    f.changeDestination();
    assert.throws(()=>f.actions.commit(bv,{sourceId:f.up.id,previewId:preview.previewId,confirmation:preview.confirmation}),/路径|连接/);
    assert.equal(f.repository().decision(f.up.id,bv),'inherit');
    assert.equal(f.repository().get(f.up.id)!.revision,revision);
    assert.equal(f.remote.size,1);assert.equal(f.state.getDatabase().hasActiveArchiveDeletion(),false);
    assert.equal(f.state.getDatabase().db.prepare<[],{count:number}>("SELECT COUNT(*) count FROM jobs WHERE kind='archive_delete'").get()?.count,0);
    f.restoreDestination();const accepted=f.actions.commit(bv,{sourceId:f.up.id,previewId:preview.previewId,confirmation:preview.confirmation});
    assert.ok(accepted.operation);await completed(f.deletion,accepted.operation.id);assert.equal(f.remote.size,0);
  }finally{await f.close();}
});

test('rule-based unblock and explicit restore have distinct results for selected-only subscriptions',async()=>{
  const f=await fixture();try{
    f.add(f.up.routingKey);
    f.repository().update(f.up.id,1,{userId:'u1',enabled:true,mode:'selected',since:null,anchorBvid:null},Date.now());
    f.repository().setDecision(f.up.id,bv,'include',Date.now());
    const exclude=()=>{const p=f.actions.preview(bv,{sourceId:f.up.id,scope:'source',effect:'retain'});f.actions.commit(bv,{previewId:p.previewId,confirmation:p.confirmation});};
    exclude();f.actions.unblock(bv,{sourceId:f.up.id,scope:'source',mode:'rule'});
    let source=f.repository().get(f.up.id)!;
    assert.equal(f.repository().catalog(source,{}).items[0].selected,false);
    assert.deepEqual(f.ingested,[]);
    exclude();f.actions.unblock(bv,{sourceId:f.up.id,scope:'source',mode:'include'});
    source=f.repository().get(f.up.id)!;
    assert.equal(f.repository().catalog(source,{}).items[0].selected,true);
    assert.deepEqual(f.ingested,[bv]);assert.equal(f.remote.size,1);
  }finally{await f.close();}
});

test('selection cannot bypass failed cleanup and stopping it preserves files before explicit restoration',async()=>{
  const f=await fixture();try{
    f.add(f.up.routingKey);f.fail();
    const p=f.actions.preview(bv,{sourceId:f.up.id,scope:'source',effect:'delete'});
    const result=f.actions.commit(bv,{previewId:p.previewId,confirmation:p.confirmation});assert.ok(result.operation);
    await completed(f.deletion,result.operation.id,'failed');
    const revision=f.repository().get(f.up.id)!.revision;
    for(const decision of ['include','inherit']) {
      if(decision==='include')assert.throws(()=>f.actions.select(f.up.id,{revision,items:[{bvid:bv,decision}]}),/完成或停止/);
      else f.actions.select(f.up.id,{revision:f.repository().get(f.up.id)!.revision,items:[{bvid:bv,decision}]});
      assert.equal(f.repository().decision(f.up.id,bv),'exclude');
    }
    assert.throws(()=>f.actions.unblock(bv,{sourceId:f.up.id,scope:'source',mode:'include'}),/完成或停止/);
    assert.equal(f.actions.context(bv,{sourceId:f.up.id}).cleanup?.status,'failed');
    const stopped=await f.deletion.stopRemaining(result.operation.id);
    assert.equal(stopped.status,'stopped');assert.equal(f.remote.size,1);
    assert.equal((await f.deletion.stopRemaining(result.operation.id)).status,'stopped');
    f.actions.unblock(bv,{sourceId:f.up.id,scope:'source',mode:'include'});
    assert.equal(f.state.getDatabase().isArchiveSourceDeletionBlocked('u1',f.up.routingKey,bv),false);
    assert.equal(f.repository().decision(f.up.id,bv),'include');
    assert.equal(f.state.getRelationStatus('u1',f.up.routingKey,bv)?.backupStatus,'verified');
  }finally{await f.close();}
});

test('bulk selection preserves exclusions on clear and rejects global exclusions without partial writes',async()=>{
  const f=await fixture();try{
    f.add(f.up.routingKey);f.repository().setDecision(f.up.id,bv,'exclude',Date.now());
    f.actions.select(f.up.id,{revision:f.repository().get(f.up.id)!.revision,items:[{bvid:bv,decision:'inherit'}]});
    assert.equal(f.repository().decision(f.up.id,bv),'exclude');
    f.repository().setGlobalExclusion(bv,true,Date.now());
    const revision=f.repository().get(f.up.id)!.revision;
    assert.throws(()=>f.actions.select(f.up.id,{revision,items:[{bvid:bv,decision:'include'}]}),/全局排除/);
    assert.equal(f.repository().get(f.up.id)!.revision,revision);
    assert.equal(f.repository().decision(f.up.id,bv),'exclude');
  }finally{await f.close();}
});
