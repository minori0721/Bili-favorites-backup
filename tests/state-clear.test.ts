import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { StateManager } from '../src/state.js';
import { PersistentJobStore } from '../src/job-store.js';
import { createTestDir, removeTestDir } from './helpers.js';

const tables = ['up_catalog', 'up_subscriptions', 'archive_video_decisions', 'archive_global_exclusions', 'videos', 'favorite_relations', 'jobs'] as const;
function seed(manager: StateManager) {
  manager.runAtomic(()=>manager.recordFavoriteItem('cleanup-user', 11, '收藏夹', {bvid:'BVCLEANUP',title:'清理测试',upperName:'测试'}));
  const db=manager.getDatabase(), repository=db.upSubscriptions;
  const source=repository.create({uid:10002,name:'测试 UP',avatar:'',signature:''},{uid:10002,userId:'cleanup-user',mode:'selected'},null,1000);
  repository.recordPage(source.id,[{bvid:'BVCLEANUP',title:'清理测试',cover:'',publishedAt:1000,ownerUid:10002,ownerName:'测试 UP',duration:60,joint:false}]);
  repository.setDecision(source.id,'BVCLEANUP','include',1000);
  repository.setGlobalExclusion('BVEXCLUDED',true,1000);
  new PersistentJobStore(db).enqueue({kind:'download',dedupeKey:'cleanup-test',bvid:'BVCLEANUP'});
  db.setMeta('unrelated-test-setting','keep');
}
function counts(manager: StateManager) {
  return tables.map(table=>manager.getDatabase().db.prepare<[],{count:number}>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
}

test('state clear removes UP rules, catalog and cached archive records and stays empty after reopen',async()=>{
  const root=await createTestDir('state-clear');
  const options={dbPath:path.join(root,'state.sqlite'),statePath:path.join(root,'missing.json')};
  let manager=new StateManager(options);
  try {
    seed(manager);
    assert.ok(counts(manager).every(count=>count>0));
    assert.ok(manager.getVideoMeta('BVCLEANUP'));
    manager.clear();
    assert.deepEqual(counts(manager),tables.map(()=>0));
    assert.equal(manager.getVideoMeta('BVCLEANUP'),null);
    assert.equal(manager.getDatabase().getMeta('unrelated-test-setting'),'keep');
    manager.close();manager=new StateManager(options);
    assert.deepEqual(counts(manager),tables.map(()=>0));
    manager.clear();
    assert.deepEqual(counts(manager),tables.map(()=>0));
  }finally{manager.close();await removeTestDir(root);}
});

test('an SQL failure during state clear rolls back UP child rows and preserves cached state',async()=>{
  const root=await createTestDir('state-clear-rollback');
  const manager=new StateManager({dbPath:path.join(root,'state.sqlite'),statePath:path.join(root,'missing.json')});
  try {
    seed(manager);const before=counts(manager);
    assert.ok(manager.getVideoMeta('BVCLEANUP'));
    manager.getDatabase().db.exec("CREATE TEMP TRIGGER fail_clear BEFORE DELETE ON up_subscriptions BEGIN SELECT RAISE(ABORT,'injected clear failure'); END;");
    assert.throws(()=>manager.clear(),/injected clear failure/);
    assert.deepEqual(counts(manager),before);
    assert.ok(manager.getVideoMeta('BVCLEANUP'));
  }finally{manager.close();await removeTestDir(root);}
});
