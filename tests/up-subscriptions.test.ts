import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { StateManager } from '../src/state.js';
import { ArchiveDeletionService, type ArchiveDeletionDavClient, type ArchiveDeletionOptions } from '../src/archive-deletion.js';
import { createUpArchive } from '../src/scheduler/up-archive.js';
import { createUpScan, type UpScanContext } from '../src/up-subscriptions/scan.js';
import { createUpSubscriptionService } from '../src/up-subscriptions/service.js';
import { createUpSubscriptionRouter } from '../src/http/up-subscriptions.js';
import { createHttpErrorHandler } from '../src/http/request-boundary.js';
import { createUpBiliAdapter,signUpWbi,type UpBiliPort } from '../src/up-subscriptions/bili-adapter.js';
import { decodeUpSubmissions,decodeUpSearch,decodeUpFollowings } from '../src/up-subscriptions/bili-decoders.js';
import { parseUpUid,shouldArchiveUpVideo } from '../src/up-subscriptions/policy.js';
import { parseUpList,parseUpCatalog,parseUpSubscription,parseUpRemovalPreview,parseUpRemovalResult } from '../src/shared/api/up-subscriptions.js';
import { matchesDeletedSource,sourceAdmissionBlocked } from '../src/scheduler/source-admission.js';
import { parseArchiveNavigation,parseArchiveLibraryItem } from '../src/shared/api/archive-library.js';
import { getArchiveLibraryNavigation,queryArchiveLibraryItems } from '../src/archive-library.js';
import { TransferSessionStore } from '../src/transfer-session.js';
import type { UpSubmission } from '../src/shared/up-subscriptions.js';
import { memoryUsers } from './fixtures/memory-users.js';
import { createHeldScheduler } from './fixtures/held-scheduler.js';
import {createTestDir,removeTestDir,testConfig} from './helpers.js';
import {createArchiveTaskAdmission} from '../src/scheduler/archive-task-admission.js';
import {DownloadTask,UploadTask} from '../src/tasks.js';
import {createDownloadTaskFactory} from '../src/scheduler/download-task-factory.js';

const video:UpSubmission={bvid:'BVUPTEST0001',title:'联合投稿',cover:'',publishedAt:2000,ownerUid:99,ownerName:'主投稿者',duration:60,joint:true};
const identity={uid:42,name:'参与 UP',avatar:'',signature:''};
const user={id:'u1',uid:10001,name:'测试账号',cookie:{SESSDATA:'fixture',bili_jct:'fixture',DedeUserID:'10001'},favorites:[{mediaId:11,title:'收藏夹'}],enabled:true,lastLoginAt:'2026-01-01T00:00:00Z'};
const context:UpScanContext={canRun:()=>true,enterUser(){},leaveUser(){},progress(){},counts(){}};
async function fixture(options:Pick<ArchiveDeletionOptions,'prepareSourceDeletion'>={}) {
  const directory=await createTestDir('up-subscriptions');
  const state=new StateManager({dbPath:path.join(directory,'state.sqlite'),statePath:path.join(directory,'missing.json')});
  const users=memoryUsers([user,{...user,id:'u2',uid:10002,cookie:{...user.cookie,DedeUserID:'10002'}}]);
  const remote=new Map<string,number>();let failDelete=false;let blocked=false;let scans=0;
  const client:ArchiveDeletionDavClient={async stat(file){const size=remote.get(file);if(size===undefined)throw Object.assign(new Error('missing'),{status:404});return {type:'file',size};},
    async deleteFile(file){if(failDelete)throw Object.assign(new Error('forbidden'),{status:403});remote.delete(file);},async getDirectoryContents(){return [];}};
  const deletion=new ArchiveDeletionService(state,{get:()=>testConfig()},users,{clientFactory:()=>client,isSchedulerIdle:()=>true,...options});
  const repository=()=>state.getDatabase().upSubscriptions;
  const enqueued:string[]=[];
  const ingest=createUpArchive({state,user:id=>users.getById(id),eligible:value=>value.enabled,accepting:()=>!blocked,
    blocked:(u,m,b)=>state.getDatabase().isArchiveSourceDeletionBlocked(u,m,b),enqueue(value,route,title,bvid){enqueued.push(bvid);state.markQueued(bvid,'/backup/'+bvid,value.id,route);return true;}});
  const bili:UpBiliPort={async profile(_id,uid){return {...identity,uid};},async search(_id,_q,page){return {items:[identity],page,pageSize:20,total:1,hasMore:false};},
    async followings(_id,page){return {items:[{...identity,followed:true}],page,pageSize:50,total:1,hasMore:false};},async submissions(){return {items:[video],total:1,hasMore:false};}};
  const service=createUpSubscriptionService({repository,users,bili,atomic:work=>state.runAtomic(work),ingest,scan(){scans++;return {started:true,queued:false};},
    blocked:()=>blocked,maintenance:work=>work(),canRebind:()=>true,rebind:(source,userId)=>state.rebindUpSubscriptionRelations(source.id,source.userId,userId,source.routingKey),
    relations:bvid=>state.listRelationsForBvid(bvid),deletion,now:()=>5000});
  const source=repository().create(identity,{uid:42,userId:'u1',mode:'selected'},null,1000);
  repository().recordPage(source.id,[video]);
  function proof(mediaId:number,bvid=video.bvid,sourceId?:string,file='/backup/shared/video.mp4') {
    if(sourceId)state.recordUpSubscriptionItem(sourceId,'u1',mediaId,'UP · 参与 UP',{bvid,title:'视频',upperName:'UP'});
    else state.recordFavoriteItem('u1',mediaId,'收藏夹',{bvid,title:'视频',upperName:'UP'});
    remote.set(file,42);
    assert.equal(state.restoreExistingArchiveProof(bvid,'u1',mediaId,{status:'verified',remotePath:path.posix.dirname(file),files:[{path:file,name:path.posix.basename(file),size:42,verificationStatus:'verified'}]}),true);
  }
  return {state,users,source,repository,service,ingest,bili,enqueued,remote,deletion,proof,setBlocked(value:boolean){blocked=value;},get scans(){return scans;},
    async close(){assert.equal(await deletion.stop(5000),true);state.close();await removeTestDir(directory);},setDeleteFailure(value=true){failDelete=value;}};
}
async function completed(deletion:ArchiveDeletionService,id:string,expected='completed') {
  for(let index=0;index<200;index++){const result=deletion.get(id);if(result?.status===expected)return result;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(`删除任务未到达 ${expected}`);
}
test('removing a subscription with retain preserves proof and choices for re-add',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(f.source.routingKey,video.bvid,f.source.id);
    assert.deepEqual(parseUpRemovalResult(f.service.remove(f.source.id,{revision:1})),{retained:true,operation:null});
    assert.equal(f.repository().get(f.source.id)?.removed,true);assert.equal(f.remote.size,1);
    assert.equal(f.state.getRelationStatus('u1',f.source.routingKey,video.bvid)?.backupStatus,'verified');
    const restored=await f.service.create({uid:42,userId:'u1',mode:'selected'});
    assert.equal(restored.id,f.source.id);assert.equal(f.repository().decision(restored.id,video.bvid),'include');
  }finally{await f.close();}
});
test('whole UP removal counts actual memberships, deletes unique files and preserves other sources',async()=>{
  const f=await fixture();try{
    const second={...video,bvid:'BVUPTEST0002'},candidate={...video,bvid:'BVUPTEST0003'};
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.repository().setDecision(f.source.id,second.bvid,'include',1000);
    f.repository().recordPage(f.source.id,[second,candidate]);f.proof(11);f.proof(f.source.routingKey,video.bvid,f.source.id);
    f.proof(f.source.routingKey,second.bvid,f.source.id,'/backup/unique/second.mp4');
    const preview=parseUpRemovalPreview(f.service.previewRemoval(f.source.id,{revision:1}));
    assert.equal(preview.videoCount,2);assert.equal(preview.fileCount,2);assert.equal(preview.sharedCount,1);assert.equal(preview.reclaimableBytes,42);
    assert.equal(f.repository().get(f.source.id)?.removed,false);
    const result=parseUpRemovalResult(f.service.remove(f.source.id,{revision:preview.revision,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}));
    assert.ok(result.operation);await completed(f.deletion,result.operation.id);
    assert.deepEqual([...f.remote.keys()],['/backup/shared/video.mp4']);
    assert.equal(f.state.getRelationStatus('u1',11,video.bvid)?.backupStatus,'verified');
    assert.equal(f.state.getRelationStatus('u1',f.source.routingKey,second.bvid)?.backupStatus,'lost');
    const list=parseUpList(f.service.list());assert.equal(list.items.length,0);assert.equal(list.operations[0].status,'completed');
    const restored=await f.service.create({uid:42,userId:'u1',mode:'all'});
    assert.equal(restored.id,f.source.id);
    for(const item of [video,second,candidate])assert.equal(f.repository().decision(restored.id,item.bvid),'exclude');
    assert.equal(f.enqueued.length,0);assert.equal(f.repository().globallyExcluded(video.bvid),false);
  }finally{await f.close();}
});
test('removal with discovered posts but no archives is a valid zero-file cleanup',async()=>{
  const f=await fixture();try{
    const preview=parseUpRemovalPreview(f.service.previewRemoval(f.source.id,{revision:1}));
    assert.equal(preview.videoCount,0);assert.equal(preview.fileCount,0);assert.equal(preview.reclaimableBytes,0);
    const result=f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation});
    assert.ok(result.operation);await completed(f.deletion,result.operation.id);
    assert.equal(f.repository().decision(f.source.id,video.bvid),'exclude');assert.equal(f.remote.size,0);
  }finally{await f.close();}
});
test('invalid confirmation, stale revision and another source preview do not remove or exclude',async()=>{
  const f=await fixture();try{
    const other=f.repository().create({...identity,uid:84},{uid:84,userId:'u1',mode:'all'},null,1000);
    const preview=f.service.previewRemoval(f.source.id,{revision:1});
    assert.throws(()=>f.service.remove(f.source.id,{revision:2,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}),/变化/);
    assert.throws(()=>f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:'WRONG'}),/确认/);
    assert.throws(()=>f.service.remove(other.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}),/不属于/);
    assert.equal(f.repository().get(f.source.id)?.removed,false);assert.equal(f.repository().decision(f.source.id,video.bvid),'inherit');
    assert.equal(f.deletion.get(preview.previewId)?.status,'preview');
  }finally{await f.close();}
});
test('whole removal rolls back source, exclusions and operation if job registration fails',async()=>{
  const f=await fixture();try{
    const preview=f.service.previewRemoval(f.source.id,{revision:1});
    f.state.getDatabase().db.exec(`CREATE TRIGGER reject_removal_job BEFORE INSERT ON jobs WHEN NEW.kind='archive_delete' BEGIN SELECT RAISE(ABORT,'injected registration failure'); END;`);
    assert.throws(()=>f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}),/registration failure/);
    assert.equal(f.repository().get(f.source.id)?.removed,false);assert.equal(f.repository().get(f.source.id)?.revision,1);
    assert.equal(f.repository().decision(f.source.id,video.bvid),'inherit');assert.equal(f.deletion.get(preview.previewId)?.status,'preview');
    assert.equal(f.deletion.hasActiveOperation(),false);assert.equal(f.service.list().operations.length,0);
  }finally{await f.close();}
});
test('a new membership invalidates the whole removal preview before any source mutation',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    const preview=f.service.previewRemoval(f.source.id,{revision:1});
    f.state.recordUpSubscriptionItem(f.source.id,'u1',f.source.routingKey,'UP',{bvid:video.bvid,title:'视频',upperName:'UP'});
    assert.throws(()=>f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}),/范围已变化/);
    assert.equal(f.repository().get(f.source.id)?.removed,false);assert.equal(f.repository().decision(f.source.id,video.bvid),'include');
  }finally{await f.close();}
});
test('removal decoders keep old list compatibility and reject invalid counts or operations',()=>{
  assert.deepEqual(parseUpList({accounts:[],items:[]}).operations,[]);
  const preview={previewId:'preview',sourceId:'source',revision:1,videoCount:0,fileCount:0,sharedCount:0,totalBytes:0,reclaimableBytes:0,activeTasks:0,confirmation:'DELETE ARCHIVE'};
  assert.equal(parseUpRemovalPreview(preview).videoCount,0);
  assert.throws(()=>parseUpRemovalPreview({...preview,sharedCount:1}));assert.throws(()=>parseUpRemovalPreview({...preview,reclaimableBytes:1}));
  assert.throws(()=>parseUpRemovalPreview({...preview,activeTasks:'0'}));assert.throws(()=>parseUpList({accounts:[],items:[],operations:null}));
  assert.throws(()=>parseUpRemovalResult({retained:false,operation:{id:'id',status:'completed'}}));
});
test('failed removal remains visible, blocks re-add and unblock, and can retry after the file service recovers',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    f.proof(f.source.routingKey,video.bvid,f.source.id);f.setDeleteFailure();
    const preview=f.service.previewRemoval(f.source.id,{revision:1});
    const result=f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);
    await completed(f.deletion,result.operation.id,'failed');
    assert.equal(parseUpList(f.service.list()).operations[0].status,'failed');assert.equal(f.remote.size,1);
    await assert.rejects(f.service.create({uid:42,userId:'u1',mode:'all'}),/先完成/);
    assert.throws(()=>f.service.unblock(f.source.id,video.bvid,{revision:2,scope:'source'}),/先完成/);
    f.setDeleteFailure(false);f.service.retryRemoval(result.operation.id);await completed(f.deletion,result.operation.id);
    assert.equal(f.remote.size,0);assert.equal(f.repository().decision(f.source.id,video.bvid),'exclude');
  }finally{await f.close();}
});
test('draining precedes deletion; changed upload proof fails safely and can be re-previewed',async()=>{
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});const prepared=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture({prepareSourceDeletion:async()=>{entered();await waiting;}});try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    f.proof(f.source.routingKey,video.bvid,f.source.id);
    const preview=f.service.previewRemoval(f.source.id,{revision:1});
    const result=f.service.remove(f.source.id,{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation});assert.ok(result.operation);
    await prepared;assert.equal(f.remote.size,1);
    f.proof(f.source.routingKey,video.bvid,f.source.id,'/backup/late/video.mp4');release();await completed(f.deletion,result.operation.id,'failed');
    assert.equal(f.remote.size,2);
    assert.throws(()=>f.service.retryRemoval(result.operation!.id),/证明/);
    const fresh=f.service.repreviewRemoval(result.operation.id);
    const retried=f.service.remove(f.source.id,{revision:fresh.revision,effect:'delete',previewId:fresh.previewId,confirmation:fresh.confirmation});assert.ok(retried.operation);await completed(f.deletion,retried.operation.id);
    assert.equal(f.remote.has('/backup/late/video.mp4'),false);assert.equal(f.remote.has('/backup/shared/video.mp4'),true);
    assert.equal(f.deletion.get(result.operation.id)?.status,'superseded');
  }finally{release();await f.close();}
});
test('whole source admission blocks every BV in that source without blocking another source',()=>{
  const scope={scope:'source',userId:'u1',mediaId:-2};
  assert.equal(matchesDeletedSource(scope,{userId:'u1',mediaId:-2},'BVONE'),true);
  assert.equal(matchesDeletedSource(scope,{userId:'u1',mediaId:11},'BVONE'),false);
  assert.equal(sourceAdmissionBlocked(false,scope,{userId:'u1',mediaId:-2,bvid:'BVTWO'}),true);
  assert.equal(sourceAdmissionBlocked(false,scope,{userId:'u2',mediaId:-2,bvid:'BVTWO'}),false);
  assert.equal(sourceAdmissionBlocked(false,{...scope,bvid:'BVONE'},{userId:'u1',mediaId:-2,bvid:'BVTWO'}),false);
});
test('whole subscription preparation visits the queue once and preserves shared and unrelated work',async()=>{
  const f=await fixture();const held=createHeldScheduler({get:()=>testConfig()},f.users,f.state,{deferAdmissionUntilStart:true});try{
    const route=f.source.routingKey,second='BVUPTEST0002';
    for(const bv of [video.bvid,second]){f.repository().setDecision(f.source.id,bv,'include',1000);f.state.recordUpSubscriptionItem(f.source.id,'u1',route,'UP',{bvid:bv,title:'视频',upperName:'UP'});}
    f.state.recordFavoriteItem('u1',11,'收藏夹',{bvid:second,title:'共享视频',upperName:'UP'});
    const own=held.jobs.enqueue({kind:'download',dedupeKey:'whole-own',bvid:video.bvid,initialStatus:'pending',payload:{primaryUserId:'u1',primaryMediaId:route}});
    const shared=held.jobs.enqueue({kind:'download',dedupeKey:'whole-shared',bvid:second,initialStatus:'pending',payload:{primaryUserId:'u1',primaryMediaId:route,detachedTargets:[
      {userId:'u1',mediaId:route,folderTitle:'UP',remotePath:'/backup/up'}, {userId:'u1',mediaId:11,folderTitle:'收藏夹',remotePath:'/backup/favorite'}]}});
    const other=held.jobs.enqueue({kind:'download',dedupeKey:'whole-other',bvid:'BVOTHERTEST',initialStatus:'pending',payload:{primaryUserId:'u1',primaryMediaId:11}});
    const upload=held.jobs.enqueue({kind:'upload',dedupeKey:'whole-upload',bvid:video.bvid,userId:'u1',mediaId:route,initialStatus:'pending',payload:{}});
    f.repository().remove(f.source.id,1,5000);held.scheduler.setArchiveDeletionMaintenance(true,{id:'whole',status:'pending',scope:'source',userId:'u1',mediaId:route});
    await held.scheduler.prepareSourceDeletion('u1',route,undefined,1000);
    assert.equal(held.jobs.findById(own.id),null);assert.equal(held.jobs.findById(upload.id),null);
    assert.equal(held.jobs.findById(shared.id)?.status,'pending');assert.equal(held.jobs.findById(shared.id)?.payload.primaryMediaId,11);
    assert.deepEqual(held.jobs.findById(other.id)?.payload,other.payload);assert.equal(held.jobs.findById(other.id)?.status,'pending');
  }finally{await held.scheduler.shutdown(1000,{closeDatabase:false});await f.close();}
});
test('single-video preparation does not cancel another queued upload from the same source',async()=>{
  const f=await fixture();const held=createHeldScheduler({get:()=>testConfig()},f.users,f.state,{deferAdmissionUntilStart:true});try{
    const own=new UploadTask(video.bvid,'/isolated','/backup/up',testConfig()),other=new UploadTask('BVUPOTHER','/isolated','/backup/up',testConfig());
    own.userId=other.userId='u1';own.mediaId=other.mediaId=f.source.routingKey;
    const queue=held.queues.get('upload');queue.addTask(own);queue.addTask(other);
    held.scheduler.setArchiveDeletionMaintenance(true,{id:'single',status:'pending',scope:'source',userId:'u1',mediaId:f.source.routingKey,bvid:video.bvid});
    await held.scheduler.prepareSourceDeletion('u1',f.source.routingKey,video.bvid,1000);
    assert.deepEqual(queue.getTasks().map(task=>task.bvid),['BVUPOTHER']);
  }finally{await held.scheduler.shutdown(1000,{closeDatabase:false});await f.close();}
});
test('UP policy uses publication cutoff, explicit selection and durable exclusion precedence',()=>{
  assert.equal(parseUpUid('https://space.bilibili.com/42/video?tid=0'),42);assert.throws(()=>parseUpUid('https://evil.test/42'));assert.throws(()=>parseUpUid('0'));
  const source={enabled:true,removed:false,mode:'from_video' as const,since:2000};
  assert.equal(shouldArchiveUpVideo(source,video,'inherit',false),true);
  assert.equal(shouldArchiveUpVideo({...source,since:2001},video,'inherit',false),false);
  assert.equal(shouldArchiveUpVideo({...source,mode:'selected'},video,'include',false),true);
  assert.equal(shouldArchiveUpVideo(source,video,'include',true),false);
  assert.equal(shouldArchiveUpVideo(source,video,'exclude',false),false);
});
test('Bili decoders retain joint contributions and reject damaged or false empty pages',()=>{
  const row={bvid:video.bvid,title:'联合投稿',pic:'',created:2,mid:99,author:'主投稿者',length:'01:00',is_union_video:1};
  const response={page:{pn:1,ps:30,count:1},list:{vlist:[row]}};
  assert.deepEqual(decodeUpSubmissions(response,1,30).items,[video]);
  assert.throws(()=>decodeUpSubmissions({...response,list:{vlist:[]}},1,30));
  assert.throws(()=>decodeUpSubmissions({...response,list:{vlist:[{...row,created:'2'}]}},1,30));
  assert.throws(()=>decodeUpSubmissions({...response,list:{vlist:[row,row]}},1,30));
  assert.throws(()=>decodeUpSubmissions({...response,page:{pn:2,ps:30,count:1}},1,30));
  assert.equal(decodeUpFollowings({list:[],total:0},1,50).items.length,0);
  assert.equal(decodeUpSearch({page:1,pagesize:20,numPages:1,numResults:1,result:[{type:'bili_user',mid:42,uname:'UP',upic:'',usign:''}]}).items[0].followed,undefined);
});
test('selected posts create real UP source memberships; existing proof is shared without downloading again',async()=>{
  const f=await fixture();try{
    f.proof(11);const saved=f.service.select(f.source.id,{revision:1,items:[{bvid:video.bvid,decision:'include'}]});
    const source=f.repository().get(saved.id);assert.ok(source);
    const relation=f.state.getRelationStatus('u1',source.routingKey,video.bvid);assert.equal(relation?.sourceKind,'up');assert.equal(relation?.sourceId,source.id);assert.equal(relation?.backupStatus,'verified');assert.equal(f.enqueued.length,0);
    const page=parseUpCatalog(f.service.catalog(source.id,{}));assert.equal(page.items[0].playable,true);
    const navigation=parseArchiveNavigation(getArchiveLibraryNavigation(f.state.getDatabase(),f.users.list()));assert.equal(navigation.upSubscriptions[0].sourceId,source.id);
    const library=queryArchiveLibraryItems(f.state.getDatabase(),f.users.list(),{scope:'folder',userId:'u1',mediaId:source.routingKey});assert.equal(parseArchiveLibraryItem(library.items[0]).bvid,video.bvid);
  }finally{await f.close();}
});
test('exclusions survive remove/readd and expanding the rule; global unblock retains the source exclusion',async()=>{
  const f=await fixture();try{
    const excluded=f.service.select(f.source.id,{revision:1,items:[{bvid:video.bvid,decision:'exclude'}]});
    f.service.remove(excluded.id,{revision:excluded.revision});const restored=await f.service.create({uid:42,userId:'u1',mode:'all'});assert.equal(restored.id,f.source.id);
    assert.equal(f.repository().decision(restored.id,video.bvid),'exclude');assert.equal(f.repository().isBlocked('u1',f.source.routingKey,video.bvid),true);
    f.repository().setGlobalExclusion(video.bvid,true,5000);const unblocked=f.service.unblock(restored.id,video.bvid,{revision:restored.revision,scope:'global'});
    assert.equal(f.repository().globallyExcluded(video.bvid),false);assert.equal(f.repository().decision(restored.id,video.bvid),'exclude');assert.equal(f.enqueued.length,0);
    assert.throws(()=>f.service.select(restored.id,{revision:restored.revision,items:[{bvid:video.bvid,decision:'include'}]}));assert.ok(unblocked.revision>restored.revision);
  }finally{await f.close();}
});
test('credential rebind preserves canonical source and archive proof; old account admission is blocked',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(f.source.routingKey,video.bvid,f.source.id);
    const updated=await f.service.update(f.source.id,{revision:1,userId:'u2'});
    assert.equal(updated.id,f.source.id);assert.equal(f.state.getRelationStatus('u2',f.source.routingKey,video.bvid)?.backupStatus,'verified');assert.equal(f.state.getRelationStatus('u1',f.source.routingKey,video.bvid),null);
    assert.equal(f.repository().isBlocked('u1',f.source.routingKey,video.bvid),true);assert.equal(f.repository().isBlocked('u2',f.source.routingKey,video.bvid),false);
    assert.equal(f.repository().catalog(f.repository().get(f.source.id)!,{}).items[0].playable,true);
  }finally{await f.close();}
});
test('source-only deletion keeps shared files and the other source; global deletion removes both',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(11);f.proof(f.source.routingKey,video.bvid,f.source.id);
    let preview=f.service.previewAction(f.source.id,video.bvid,{revision:1,scope:'source',effect:'delete'});assert.equal(preview.sharedCount,1);
    const started=f.service.action(f.source.id,video.bvid,{previewId:preview.previewId,confirmation:'DELETE ARCHIVE'});assert.ok(started.operation);await completed(f.deletion,started.operation.id);
    assert.equal(f.remote.has('/backup/shared/video.mp4'),true);assert.equal(f.state.getRelationStatus('u1',11,video.bvid)?.backupStatus,'verified');
    const latest=f.repository().get(f.source.id)!;
    preview=f.service.previewAction(latest.id,video.bvid,{revision:latest.revision,scope:'global',effect:'delete'});
    const all=f.service.action(latest.id,video.bvid,{previewId:preview.previewId,confirmation:'DELETE ARCHIVE'});assert.ok(all.operation);await completed(f.deletion,all.operation.id);
    assert.equal(f.remote.size,0);assert.equal(f.repository().globallyExcluded(video.bvid),true);
    f.state.recordFavoriteItem('u1',11,'收藏夹',{bvid:video.bvid,title:'视频',upperName:'UP'});assert.notEqual(f.state.getRelationStatus('u1',11,video.bvid)?.backupStatus,'discovered');
  }finally{await f.close();}
});
test('deletion failure keeps the permanent ban and original file; mutation is blocked during maintenance',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(f.source.routingKey,video.bvid,f.source.id);f.setDeleteFailure();
    const preview=f.service.previewAction(f.source.id,video.bvid,{revision:1,scope:'source',effect:'delete'});
    const result=f.service.action(f.source.id,video.bvid,{previewId:preview.previewId,confirmation:'DELETE ARCHIVE'});assert.ok(result.operation);await completed(f.deletion,result.operation.id,'failed');
    assert.equal(f.remote.size,1);assert.equal(f.repository().decision(f.source.id,video.bvid),'exclude');f.setBlocked(true);assert.throws(()=>f.service.select(f.source.id,{revision:2,items:[{bvid:video.bvid,decision:'include'}]}));
  }finally{await f.close();}
});
test('scan stops late responses after revision changes, stop and account replacement',async()=>{
  for(const change of ['revision','stop','account']){
    const f=await fixture();try{
      let resolve:(result:{items:UpSubmission[];total:number;hasMore:boolean})=>void=()=>{};
      const awaited=new Promise<{items:UpSubmission[];total:number;hasMore:boolean}>(done=>{resolve=done;});
      const scanner=createUpScan({repository:f.repository,users:f.users,bili:{submissions:()=>awaited},atomic:work=>f.state.runAtomic(work),ingest:f.ingest,now:()=>5000,interval:()=>1000,accountCooling:()=>false});
      const running=scanner.run(context);
      if(change==='revision')f.repository().bumpRevision(f.source.id,1,5000);else if(change==='stop')scanner.stop();else f.users.updatePartial('u1',{cookie:{...user.cookie,SESSDATA:'replacement'}});
      resolve({items:[{...video,bvid:'BVLATEUP0002'}],total:1,hasMore:false});await running;
      assert.equal(f.repository().item(f.source.id,'BVLATEUP0002'),null);assert.equal(f.enqueued.length,0);
    }finally{await f.close();}
  }
});
test('bad later page does not advance history to completion, and joint-owner posts are queued',async()=>{
  const f=await fixture();try{
    f.repository().update(f.source.id,1,{userId:'u1',enabled:true,mode:'all',since:null,anchorBvid:null},5000);
    const scanner=createUpScan({repository:f.repository,users:f.users,bili:{async submissions(_u,_uid,page){if(page===2)throw new Error('bad page');return {items:[video],total:40,hasMore:true};}},atomic:work=>f.state.runAtomic(work),ingest:f.ingest,now:()=>5000,interval:()=>1000,accountCooling:()=>false});
    await scanner.run(context);const result=f.repository().get(f.source.id)!;assert.equal(result.historyComplete,false);assert.match(result.lastError??'',/bad page/);assert.equal(f.enqueued.length,1);assert.equal(result.nextPage,2);
  }finally{await f.close();}
});
test('catalog pagination is stable, damaged records fail, and selection rollback includes queue admission',async()=>{
  const f=await fixture();try{
    f.repository().recordPage(f.source.id,Array.from({length:35},(_,index)=>({...video,bvid:`BVPAGE${index}`,publishedAt:1000+index})));
    const first=f.service.catalog(f.source.id,{});assert.equal(first.items.length,30);assert.ok(first.nextCursor);const second=f.service.catalog(f.source.id,{cursor:first.nextCursor});assert.equal(second.items.some(item=>first.items.some(previous=>previous.bvid===item.bvid)),false);
    const db=f.state.getDatabase().db;db.exec("CREATE TRIGGER reject_up_relation BEFORE INSERT ON favorite_relations BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(()=>f.service.select(f.source.id,{revision:1,items:[{bvid:video.bvid,decision:'include'}]}),/injected/);assert.equal(f.repository().decision(f.source.id,video.bvid),'inherit');assert.equal(f.repository().get(f.source.id)?.revision,1);
    db.prepare('UPDATE up_catalog SET payload_json=? WHERE source_id=? AND bvid=?').run('{bad',f.source.id,video.bvid);assert.throws(()=>f.repository().item(f.source.id,video.bvid),/JSON/);
  }finally{await f.close();}
});

test('range changes rescan older posts while pause, resume and credential changes retain the cursor',async()=>{
  const f=await fixture();try{
    f.repository().saveScan(f.source.id,1,{nextPage:1,historyComplete:true,watermark:5000,pendingWatermark:5000,nextScanAt:10000,lastError:null},5000);
    const all=await f.service.update(f.source.id,{revision:1,mode:'all'});
    assert.equal(all.watermark,0);assert.equal(all.historyComplete,false);
    const pages:number[]=[];
    const scanner=createUpScan({repository:f.repository,users:f.users,bili:{async submissions(_u,_uid,page){pages.push(page);return {items:[page===1?video:{...video,bvid:'BVOLDERUP0002',publishedAt:1000}],total:31,hasMore:page===1};}},atomic:work=>f.state.runAtomic(work),ingest:f.ingest,now:()=>5000,interval:()=>1000,accountCooling:()=>false});
    await scanner.run(context);assert.deepEqual(pages,[1,2]);assert.ok(f.repository().item(f.source.id,'BVOLDERUP0002'));
    f.repository().saveScan(f.source.id,all.revision,{nextPage:7,historyComplete:false,watermark:2000,pendingWatermark:6000,nextScanAt:10000,lastError:null},5000);
    const paused=await f.service.update(f.source.id,{revision:all.revision,enabled:false});
    const resumed=await f.service.update(f.source.id,{revision:paused.revision,enabled:true});
    const rebound=await f.service.update(f.source.id,{revision:resumed.revision,userId:'u2'});
    for(const item of [paused,resumed,rebound]){assert.equal(item.nextPage,7);assert.equal(item.historyComplete,false);assert.equal(item.watermark,2000);assert.equal(item.pendingWatermark,6000);}
    f.service.remove(f.source.id,{revision:rebound.revision});
    const restored=await f.service.create({uid:42,userId:'u2',mode:'all'});assert.equal(restored.watermark,0);assert.equal(restored.nextPage,1);
  }finally{await f.close();}
});

test('a repeated external page records a retryable error and does not block independent subscriptions',async()=>{
  const f=await fixture();try{
    f.repository().update(f.source.id,1,{userId:'u1',enabled:true,mode:'all',since:null,anchorBvid:null},5000);
    const second=f.repository().create({...identity,uid:84},{uid:84,userId:'u1',mode:'all'},null,0);
    const calls:number[]=[];
    const scanner=createUpScan({repository:f.repository,users:f.users,bili:{async submissions(_u,uid){calls.push(uid);return {items:[uid===42?video:{...video,bvid:'BVOTHERUP0003'}],total:uid===42?60:1,hasMore:uid===42};}},atomic:work=>f.state.runAtomic(work),ingest:f.ingest,now:()=>5000,interval:()=>1000,accountCooling:()=>false});
    await scanner.run(context);assert.deepEqual(calls,[42,42,84]);
    const failed=f.repository().get(f.source.id)!;assert.match(failed.lastError??'',/重复页面/);assert.equal(failed.historyComplete,false);assert.equal(failed.nextPage,2);assert.ok(failed.nextScanAt>5000);
    assert.equal(f.repository().get(second.id)?.historyComplete,true);assert.ok(f.repository().item(second.id,'BVOTHERUP0003'));
  }finally{await f.close();}
});
test('UP API routes return validated DTOs, reject stale decisions and do not scan when browsing',async()=>{
  const f=await fixture();const app=express();app.use(express.json());app.use(createUpSubscriptionRouter({service:f.service,boundary:handler=>(req,res,next)=>{Promise.resolve().then(()=>handler(req,res,next)).catch(next);}}));app.use(createHttpErrorHandler(()=>{}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  try{
    const body:unknown=await(await fetch(base+'/api/up-subscriptions')).json();assert.ok(body&&typeof body==='object'&&'data'in body);assert.equal(parseUpList(body.data).items.length,1);
    await fetch(`${base}/api/up-subscriptions/${f.source.id}/items`);assert.equal(f.scans,0);
    const response=await fetch(`${base}/api/up-subscriptions/${f.source.id}/selection`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:9,items:[{bvid:video.bvid,decision:'include'}]})});assert.equal(response.status,409);
    const request=async(path:string,method:string,value:unknown)=>{
      const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
      assert.equal(response.status,200);const result:unknown=await response.json();assert.ok(result&&typeof result==='object'&&'data'in result);return result.data;
    };
    const preview=parseUpRemovalPreview(await request(`/api/up-subscriptions/${f.source.id}/removal-preview`,'POST',{revision:1}));
    const removed=parseUpRemovalResult(await request(`/api/up-subscriptions/${f.source.id}`,'DELETE',{revision:1,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation}));
    assert.ok(removed.operation);await completed(f.deletion,removed.operation.id);
    const after:unknown=await(await fetch(base+'/api/up-subscriptions')).json();assert.ok(after&&typeof after==='object'&&'data'in after);
    assert.equal(parseUpList(after.data).items.length,0);assert.equal(parseUpList(after.data).operations[0].status,'completed');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
test('JSON snapshots preserve subscriptions, catalog, choices and exclusions; missing evidence rolls back',async()=>{
  const f=await fixture();const directory=await createTestDir('up-snapshot-target');const target=new StateManager({dbPath:path.join(directory,'state.sqlite'),statePath:path.join(directory,'missing.json')});
  try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(f.source.routingKey,video.bvid,f.source.id);f.repository().setGlobalExclusion(video.bvid,true,5000);
    const snapshot=f.state.getStateSnapshot();assert.ok(snapshot.upSubscriptions);assert.match(JSON.stringify(snapshot),/upSubscriptions/);
    target.replaceStateSnapshot(structuredClone(snapshot));assert.equal(target.getDatabase().upSubscriptions.get(f.source.id)?.uid,42);assert.equal(target.getDatabase().upSubscriptions.globallyExcluded(video.bvid),true);assert.equal(target.getRelationStatus('u1',f.source.routingKey,video.bvid)?.backupStatus,'verified');
    assert.throws(()=>target.replaceStateSnapshot({...snapshot,upSubscriptions:undefined}),/恢复证据/);assert.equal(target.getDatabase().upSubscriptions.globallyExcluded(video.bvid),true);assert.equal(target.getRelationStatus('u1',f.source.routingKey,video.bvid)?.backupStatus,'verified');
    const invalid=structuredClone(snapshot);assert.ok(invalid.upSubscriptions);invalid.upSubscriptions.sources[0].subscription.routingKey=1;
    assert.throws(()=>target.replaceStateSnapshot(invalid),/映射/);assert.equal(target.getDatabase().upSubscriptions.get(f.source.id)?.uid,42);
    for(const field of ['id','userId','anchorBvid'] as const){
      const damaged=structuredClone(snapshot);assert.ok(damaged.upSubscriptions);
      damaged.upSubscriptions.sources[0].subscription[field]=field==='anchorBvid'?'invalid-bv':'';
      assert.throws(()=>target.replaceStateSnapshot(damaged),new RegExp(field));
      assert.equal(target.getDatabase().upSubscriptions.get(f.source.id)?.uid,42);
    }
  }finally{target.close();await removeTestDir(directory);await f.close();}
});
test('UP playback boundary requires source identity and accepts the real archive projection',async()=>{
  const f=await fixture();try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);f.proof(f.source.routingKey,video.bvid,f.source.id);
    const item=queryArchiveLibraryItems(f.state.getDatabase(),f.users.list(),{scope:'folder',userId:'u1',mediaId:f.source.routingKey}).items[0];
    assert.equal(parseArchiveLibraryItem(item).memberships[0].sourceId,f.source.id);
    assert.throws(()=>parseArchiveLibraryItem({...item,memberships:[{userId:'u1',mediaId:-2}]}));
  }finally{await f.close();}
});
test('Bili adapter signs with cached keys, serializes calls, aborts stop and cools risk responses',async()=>{
  const users=memoryUsers([user]);let calls=0,active=0,maxActive=0,risk=false;
  const adapter=createUpBiliAdapter({users,intervalMs:0,fetch:async url=>{calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    if(risk)return Response.json({code:-352});const path=String(url);if(path.includes('/nav'))return Response.json({code:0,data:{wbi_img:{img_url:'https://i.test/'+ 'a'.repeat(32)+'.png',sub_url:'https://i.test/'+ 'b'.repeat(32)+'.png'}}});
    return Response.json({code:0,data:{page:1,pagesize:20,numPages:0,numResults:0,result:[]}});}});
  await Promise.all([adapter.search('u1','a',1),adapter.search('u1','b',1)]);assert.equal(calls,3);assert.equal(maxActive,1);
  risk=true;await assert.rejects(adapter.search('u1','c',1),/352/);const before=calls;await assert.rejects(adapter.search('u1','d',1),/冷却/);assert.equal(calls,before);
  adapter.stop();await assert.rejects(adapter.search('u1','e',1),/停止/);assert.match(signUpWbi({keyword:'a!'},'key',10),/^keyword=a&wts=10&w_rid=[a-f0-9]{32}$/);
});
test('production scheduler admits UP sources into the existing persistent queue and transfer store',async()=>{
  const f=await fixture();const held=createHeldScheduler({get:()=>testConfig()},f.users,f.state);
  try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    assert.equal(held.scheduler.archiveUpSubmission(f.repository().get(f.source.id)!,video).queued,true);
    const job=held.jobs.findByDedupeKey(`download:${video.bvid}`);assert.ok(job);assert.equal(job.kind,'download');assert.equal(job.payload.primaryMediaId,f.source.routingKey);
    const sessions=new TransferSessionStore(f.state.getDatabase());const session=sessions.ensure({dedupeKey:'up-test-transfer',bvid:video.bvid,userId:'u1',mediaId:f.source.routingKey,localDir:'/isolated',remotePath:'/backup/up/video'});
    assert.equal(sessions.get(session.id)?.mediaId,f.source.routingKey);
    f.repository().setDecision(f.source.id,video.bvid,'exclude',1000);assert.equal(held.scheduler.archiveUpSubmission(f.repository().get(f.source.id)!,video).queued,false);
  }finally{await held.scheduler.shutdown(5000,{closeDatabase:false});await f.close();}
});

test('prefetched excluded tasks cannot start external work; shared targets and later resumption remain valid',async()=>{
  const f=await fixture();const held=createHeldScheduler({get:()=>testConfig()},f.users,f.state);
  try{
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    held.scheduler.archiveUpSubmission(f.repository().get(f.source.id)!,video);
    const queued=held.queues.get('download').getTasks().find(task=>task.bvid===video.bvid);assert.ok(queued instanceof DownloadTask);
    f.repository().setDecision(f.source.id,video.bvid,'exclude',1000);
    held.queues.get('download').allowExecution();
    assert.equal(queued.startedAt,undefined);assert.equal(held.jobs.findById(queued.persistentJobId!),null);
    assert.equal(f.state.getRelationStatus('u1',f.source.routingKey,video.bvid)?.backupStatus,'discovered');
    f.repository().setDecision(f.source.id,video.bvid,'include',1000);
    held.queues.get('download').setStartGate(()=>false);
    assert.equal(held.scheduler.archiveUpSubmission(f.repository().get(f.source.id)!,video).queued,true);
    const admit=createArchiveTaskAdmission({blocked:(u,m,b)=>f.repository().isBlocked(u,m,b),state:f.state,jobs:held.jobs,leaseOwner:held.owner});
    const shared=new DownloadTask(video.bvid,user.cookie,testConfig());shared.targets=[{userId:'u1',mediaId:f.source.routingKey,folderTitle:'UP',remotePath:'/backup/up'}, {userId:'u1',mediaId:11,folderTitle:'收藏夹',remotePath:'/backup/favorite'}];
    f.repository().setDecision(f.source.id,video.bvid,'exclude',1000);
    assert.equal(admit(shared),true);assert.deepEqual(shared.targets.map(target=>target.mediaId),[11]);
    const persisted=held.jobs.findByDedupeKey(`download:${video.bvid}`);assert.ok(persisted);
    const factory=createDownloadTaskFactory({configStore:{get:()=>testConfig()},userStore:f.users,stateManager:f.state,
      isArchiveSourceDeletionBlocked:(u,m,b)=>f.repository().isBlocked(u,m,b),resolveRelation:relation=>({user:f.users.getById(relation.userId)!,mediaId:relation.mediaId,folderTitle:relation.folderTitle}),
      resolveRelationRemotePath:()=>'/backup/up',handleDownloadApiReady(){},generation:()=>0});
    assert.equal(factory.build({...persisted,payload:{...persisted.payload,encodingRetry:{parentJobId:'parent',generation:1,priority:['HEVC','AVC','AV1'],candidateLocalDir:'/isolated/new',originalLocalDir:'/isolated/old',target:{userId:'u1',mediaId:f.source.routingKey,folderTitle:'UP',remotePath:'/backup/up'}}}}),null);
    const upload=new UploadTask(video.bvid,'/isolated','/backup/up',testConfig());upload.userId='u1';upload.mediaId=f.source.routingKey;
    assert.equal(admit(upload),false);f.repository().setGlobalExclusion(video.bvid,true,5000);
    assert.equal(admit(shared),false);
  }finally{await held.scheduler.shutdown(5000,{closeDatabase:false});await f.close();}
});
test('stopping the Bili adapter cancels an actual in-flight request and releases its owner',async()=>{
  const users=memoryUsers([user]);let entered:()=>void=()=>{};const ready=new Promise<void>(resolve=>{entered=resolve;});
  const adapter=createUpBiliAdapter({users,intervalMs:0,fetch:(_url,options)=>new Promise<Response>((_resolve,reject)=>{
    entered();options?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  })});
  const pending=adapter.profile('u1',42);await ready;adapter.stop();await assert.rejects(pending,/aborted/);assert.equal(adapter.isIdle(),true);
});
