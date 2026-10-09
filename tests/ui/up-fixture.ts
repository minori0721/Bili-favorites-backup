import path from 'node:path';
import fs from 'node:fs';
import { StateManager } from '../../src/state.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { ArchiveDeletionService, type ArchiveDeletionDavClient } from '../../src/archive-deletion.js';
import { createUpSubscriptionService } from '../../src/up-subscriptions/service.js';
import { createUpScan } from '../../src/up-subscriptions/scan.js';
import { createUpArchive } from '../../src/scheduler/up-archive.js';
import { getArchiveLibraryNavigation,queryArchiveLibraryItems,getArchiveLibraryItemDetail } from '../../src/archive-library.js';
import type { UpIdentity,UpSubmission } from '../../src/shared/up-subscriptions.js';
import type { UpBiliPort } from '../../src/up-subscriptions/bili-adapter.js';
import { memoryUsers } from '../fixtures/memory-users.js';
import { testConfig } from '../helpers.js';

const profiles:UpIdentity[]=[
  {uid:946974,name:'影视飓风',avatar:'/__up/avatar/0.svg',signature:'无限进步。把每一个故事，认真留下。',followed:true},
  {uid:163637592,name:'老师好我叫何同学',avatar:'/__up/avatar/1.svg',signature:'科技与生活的另一种可能。',followed:true},
  {uid:1718161,name:'大象放映室',avatar:'/__up/avatar/2.svg',signature:'关于电影，关于我们。',followed:true},
  {uid:10710448,name:'摄影师陈杰',avatar:'/__up/avatar/3.svg',signature:'山川与日常，都值得被记住。',followed:false},
  {uid:31415926,name:'山野观察员',avatar:'/__up/avatar/4.svg',signature:'关注列表中的未订阅创作者，供隔离演示选择。',followed:true},
];
const titles=['我们用一台摄影机，记录了城市的清晨','一场关于光线与时间的实验','走进山野：在日常之外寻找风景','这一次，我们重新理解了声音','镜头背后，那些没有说出口的故事','把生活拍成一部小小的电影','我们如何保存正在消失的记忆','从一束光开始，认识影像的力量'];
export function createUpUiFixture() {
  const directory=path.join(process.cwd(),'.test-runtime','ui-up');fs.mkdirSync(directory,{recursive:true});
  const manager=new StateManager({dbPath:':memory:',statePath:path.join(directory,'missing.json')});
  const users=memoryUsers([{id:'u1',uid:10001,name:'测试账号',cookie:{SESSDATA:'isolated',bili_jct:'isolated',DedeUserID:'10001'},favorites:[{mediaId:11,title:'测试收藏夹'}],enabled:true,lastLoginAt:new Date().toISOString()}]);
  const jobs=new PersistentJobStore(manager.getDatabase());
  const remote=new Map<string,number>();
  let deletionFailure=false;
  const dav:ArchiveDeletionDavClient={
    async stat(file){const size=remote.get(file);if(size===undefined)throw Object.assign(new Error('not found'),{status:404});return {type:'file',size};},
    async deleteFile(file){if(deletionFailure)throw Object.assign(new Error('隔离演示：远端拒绝删除'),{status:403});remote.delete(file);},async getDirectoryContents(){return [];},
  };
  const deletion=new ArchiveDeletionService(manager,{get:()=>testConfig()},users,{clientFactory:()=>dav,isSchedulerIdle:()=>true});
  function posts(uid:number):UpSubmission[]{return Array.from({length:42},(_,index)=>({bvid:`BVUP${uid}X${String(index+1).padStart(3,'0')}`,
    title:titles[index%titles.length]+(index>=titles.length?` · ${Math.floor(index/titles.length)+1}`:''),cover:`/__up/cover/${index%8}.svg`,
    publishedAt:Date.now()-index*3*86400_000,ownerUid:index===1?407054668:uid,ownerName:index===1?'联合创作者':profiles.find(item=>item.uid===uid)?.name??'测试创作者',duration:420+index*23,joint:index===1}));}
  const bili:UpBiliPort={
    async followings(_id,page,q){const items=profiles.filter(item=>item.followed&&(!q||item.name.includes(q)));return {items:page===1?items:[],page,pageSize:50,total:items.length,hasMore:false};},
    async search(_id,q,page){if(q==='请求失败')throw new Error('隔离演示：B站搜索请求失败');const items=profiles.filter(item=>item.name.includes(q)||item.signature.includes(q));return {items:page===1?items:[],page,pageSize:20,total:items.length,hasMore:false};},
    async profile(_id,uid){const identity=profiles.find(item=>item.uid===uid);return identity??{uid,name:`创作者 ${uid}`,avatar:'',signature:'通过 UID 添加的隔离演示订阅'};},
    async submissions(_id,uid,page){const all=posts(uid);return {items:all.slice((page-1)*30,page*30),total:all.length,hasMore:page*30<all.length};},
  };
  const ingest=createUpArchive({state:manager,user:id=>users.getById(id),eligible:user=>user.enabled,
    blocked:(u,m,b)=>manager.getDatabase().isArchiveSourceDeletionBlocked(u,m,b),accepting:()=>true,
    enqueue(user,route,title,bvid){if(!manager.shouldEnqueueBackup(bvid,user.id,route))return false;manager.markQueued(bvid,`/backup/UP/${bvid}`,user.id,route);jobs.enqueue({kind:'download',dedupeKey:`download:${bvid}`,bvid,payload:{primaryUserId:user.id,primaryMediaId:route,primaryFolderTitle:title},priority:40});return true;}});
  const scanner=createUpScan({repository:()=>manager.getDatabase().upSubscriptions,users,bili,atomic:work=>manager.runAtomic(work),ingest,now:Date.now,interval:()=>600_000,accountCooling:()=>false});
  let scan:Promise<void>|null=null;
  function requestScan(){if(!scan)scan=scanner.run({canRun:()=>true,enterUser(){},leaveUser(){},progress(){},counts(){}})
    .catch(error=>{console.error('[UI UP scan]',error);}).finally(()=>{scan=null;});return {started:true,queued:false};}
  const service=createUpSubscriptionService({repository:()=>manager.getDatabase().upSubscriptions,users,bili,atomic:work=>manager.runAtomic(work),ingest,scan:requestScan,
    blocked:()=>false,maintenance:work=>work(),canRebind:()=>true,rebind:(source,userId)=>manager.rebindUpSubscriptionRelations(source.id,source.userId,userId,source.routingKey),
    relations:bv=>manager.listRelationsForBvid(bv),deletion,now:Date.now});
  function seed(){
    const repository=manager.getDatabase().upSubscriptions;
    for(const profile of profiles.slice(0,3)) {
      const source=repository.create(profile,{uid:profile.uid,userId:'u1',mode:profile.uid===163637592?'selected':'all'},null,Date.now());
      const items=posts(profile.uid);repository.recordPage(source.id,items);
      repository.saveScan(source.id,source.revision,{nextPage:1,historyComplete:true,watermark:items[0].publishedAt,pendingWatermark:items[0].publishedAt,nextScanAt:Date.now()+600_000,lastError:null},Date.now());
      if(profile.uid===1718161)repository.update(source.id,source.revision,{userId:'u1',enabled:false,mode:'all',since:null,anchorBvid:null},Date.now());
      if(profile.uid===163637592)repository.setDecision(source.id,items[0].bvid,'include',Date.now());
      repository.setDecision(source.id,items[3].bvid,'exclude',Date.now());
      for(const item of items.slice(0,3)) {
        if(repository.isBlocked('u1',source.routingKey,item.bvid))continue;
        manager.recordUpSubscriptionItem(source.id,'u1',source.routingKey,`UP · ${profile.name}`,{bvid:item.bvid,title:item.title,upperName:item.ownerName,upperMid:item.ownerUid,cover:item.cover});
        const remotePath=`/backup/up-${profile.uid}/${item.bvid}/video.mp4`;remote.set(remotePath,12*1024*1024);
        manager.restoreExistingArchiveProof(item.bvid,'u1',source.routingKey,{status:'verified',remotePath:path.posix.dirname(remotePath),files:[{name:'video.mp4',path:remotePath,size:12*1024*1024,verificationStatus:'verified'}]});
      }
    }
  }
  seed();
  return {service,
    setDeletionFailure(value:boolean){deletionFailure=value;},
    navigation:()=>getArchiveLibraryNavigation(manager.getDatabase(),users.list()).upSubscriptions,
    items:(query:Parameters<typeof queryArchiveLibraryItems>[2])=>queryArchiveLibraryItems(manager.getDatabase(),users.list(),query),
    detail:(query:Parameters<typeof getArchiveLibraryItemDetail>[2],bvid:string)=>getArchiveLibraryItemDetail(manager.getDatabase(),users.list(),query,bvid),
    async reset(){scanner.stop();if(scan)await scan;deletionFailure=false;service.reset();manager.getDatabase().db.exec(`DELETE FROM archive_deleted_sources;DELETE FROM archive_deletion_items;DELETE FROM archive_deletions;DELETE FROM archive_video_decisions;DELETE FROM archive_global_exclusions;DELETE FROM up_catalog;DELETE FROM up_subscriptions;DELETE FROM jobs;DELETE FROM remote_files;DELETE FROM favorite_relations;DELETE FROM videos;`);manager.reload();remote.clear();seed();scanner.start();},
    async close(){scanner.stop();if(scan)await scan;if(!await deletion.stop(5000))throw new Error('UI 清理未排空');manager.close();},
  };
}
