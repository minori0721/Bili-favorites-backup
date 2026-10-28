import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=process.env.BFB_TEST_APP_ROOT;
assert.ok(root && path.isAbsolute(root));
assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
const paths=await import('../../src/paths.js');
for(const target of [paths.dataDir,paths.tempDir,paths.backupsDir,paths.coversDir,paths.onlineCoversDir,paths.exportsDir]) {
  const relative=path.relative(root,target);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
paths.ensureAppDirs();
const {ConfigStore}=await import('../../src/config.js');
const {UserStore}=await import('../../src/users.js');
const {StateManager}=await import('../../src/state.js');
const {PersistentJobStore}=await import('../../src/job-store.js');
const {OnlineCoverCache}=await import('../../src/online-cover-cache.js');
const {createStorageCleanup}=await import('../../src/storage-cleanup-service.js');
const config=new ConfigStore(),users=new UserStore(),manager=new StateManager(),cache=new OnlineCoverCache();
try {
  config.update({pollIntervalMinutes:17});
  users.upsert({id:'cleanup-user',uid:10001,name:'测试账号',cookie:{SESSDATA:'test-only',bili_jct:'test-only',DedeUserID:'10001'},favorites:[{mediaId:11,title:'测试收藏夹'}],enabled:true,lastLoginAt:new Date().toISOString()});
  manager.runAtomic(()=>manager.recordFavoriteItem('cleanup-user',11,'测试收藏夹',{bvid:'BVCLEANUP',title:'测试',upperName:'测试'}));
  new PersistentJobStore(manager.getDatabase()).enqueue({kind:'download',dedupeKey:'full-clear',bvid:'BVCLEANUP'});
  const repository=manager.getDatabase().upSubscriptions;
  const source=repository.create({uid:10002,name:'测试 UP',avatar:'',signature:''},{uid:10002,userId:'cleanup-user',mode:'selected'},null,1000);
  repository.recordPage(source.id,[{bvid:'BVCLEANUP',title:'测试',cover:'',publishedAt:1000,ownerUid:10002,ownerName:'测试 UP',duration:60,joint:false}]);
  repository.setDecision(source.id,'BVCLEANUP','include',1000);repository.setGlobalExclusion('BVEXCLUDED',true,1000);
  const targets=[path.join(paths.tempDir,'test.mp4'),path.join(paths.coversDir,'test.jpg'),path.join(paths.onlineCoversDir,'a'.repeat(64)+'.webp'),path.join(paths.exportsDir,'test.zip'),path.join(paths.backupsDir,'test.sqlite'),path.join(paths.dataDir,'debug','test.log')];
  for(const file of targets){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'test-only');}
  const remote=path.join(root,'remote-sentinel.mp4');fs.writeFileSync(remote,'remote must stay');
  let busy=false;
  const service=createStorageCleanup({scheduler:{refreshLocalCacheState(){},updateInterval(){},hasRunningTransferTasks:()=>busy,hasActiveOrQueuedSchedulerWork:()=>false,withCleanupLock:async work=>work()},
    stateManager:manager,userStore:users,configStore:config,onlineCoverCache:cache,unavailableCoverBackfill:{stop:async()=>true,restart(){}},waitForCoverCacheIdle:async()=>true,
    clearMemoryCaches(){},clearLogs(){},clearCoverBackfillMarker(){},hasPathMigration:()=>false,hasUnfinishedDeletion:()=>false});
  await service.execute({items:['memory-cache','logs']});
  assert.equal(repository.list().length,1);assert.equal(users.list().length,1);assert.equal(config.get().pollIntervalMinutes,17);
  const items=(await service.inspect()).items.map(item=>item.key);
  await assert.rejects(service.execute({items,confirmation:'DELETE'}),/DELETE ALL PROJECT DATA/);
  busy=true;await assert.rejects(service.execute({items,confirmation:'DELETE ALL PROJECT DATA'}),/正在运行/);busy=false;
  assert.ok(targets.every(file=>fs.existsSync(file)));
  const result=await service.execute({items,confirmation:'DELETE ALL PROJECT DATA'});
  assert.equal(result.status,200);assert.ok(result.body.data.results.every(item=>item.ok));
  assert.ok(targets.every(file=>!fs.existsSync(file)));
  assert.equal(new UserStore().list().length,0);assert.notEqual(new ConfigStore().get().pollIntervalMinutes,17);
  assert.equal(fs.readFileSync(remote,'utf8'),'remote must stay');
}finally{manager.close();}
const reopened=new StateManager();
try {
  for(const table of ['videos','favorite_relations','jobs','up_subscriptions','up_catalog','archive_video_decisions','archive_global_exclusions'])
    assert.equal(reopened.getDatabase().db.prepare<[],{count:number}>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,0,table);
}finally{reopened.close();}
console.log('full cleanup: real SQLite, managed files and restart checks passed');
