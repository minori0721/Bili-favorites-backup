import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createArchiveLibraryService } from '../src/archive-library-service.js';
import { getArchiveLibraryNavigation } from '../src/archive-library.js';
import { StateManager } from '../src/state.js';
import type { BiliUser } from '../src/users.js';
import { createTestDir, removeTestDir } from './helpers.js';

test('navigation reuses a bounded snapshot and invalidates across writes, rollback, selection and rebind', async t => {
  const root = await createTestDir('navigation-cache');
  const first = new StateManager({dbPath:path.join(root,'first.sqlite'),statePath:path.join(root,'first.json')});
  const second = new StateManager({dbPath:path.join(root,'second.sqlite'),statePath:path.join(root,'second.json')});
  let current = first, clock = 0;
  let users: BiliUser[] = [{id:'cache-user',uid:1,name:'Account',enabled:true,lastLoginAt:'',
    cookie:{SESSDATA:'',bili_jct:'',DedeUserID:''},favorites:[{mediaId:10,title:'Folder'}]}];
  first.recordFavoriteItem('cache-user',10,'Folder',{bvid:'BVCACHEONE',title:'One',upperName:'UP'});
  second.recordFavoriteItem('cache-user',10,'Folder',{bvid:'BVCACHETWO',title:'Two',upperName:'UP'});
  const db = first.getDatabase().db;
  const prepare = db.prepare.bind(db);
  let summaries = 0;
  t.mock.method(db,'prepare', (...args: Parameters<typeof db.prepare>) => {
    if (String(args[0]).includes('relation_base AS MATERIALIZED')) summaries++;
    return prepare(...args);
  });
  const service = createArchiveLibraryService({database:()=>current.getDatabase(),users:()=>users,now:()=>clock});
  try {
    const initial = service.navigation();
    assert.equal(initial.summary.total,1);
    const again = service.navigation();
    assert.equal(summaries,1);
    again.summary.total = -1;
    assert.equal(service.navigation().summary.total,1);
    first.recordFavoriteItem('cache-user',10,'Folder',{bvid:'BVCACHEMORE',title:'More',upperName:'UP'});
    assert.equal(service.navigation().summary.total,2);
    assert.equal(summaries,2);
    users = users.map(user=>({...user,name:'Renamed',favorites:[]}));
    assert.equal(service.navigation().accounts[0].name,'Renamed');
    assert.equal(service.navigation().accounts[0].folders.length,0);
    const committed = service.navigation();
    assert.throws(()=>db.transaction(()=>{
      db.prepare("UPDATE videos SET payload_json=json_set(payload_json,'$.cover','/uncommitted.jpg')").run();
      assert.equal(service.navigation().summary.cover,'/uncommitted.jpg');
      throw new Error('rollback');
    })(), /rollback/);
    assert.deepEqual(service.navigation(),committed);
    const other = new Database(path.join(root,'first.sqlite'));
    try { other.prepare("UPDATE videos SET payload_json=json_set(payload_json,'$.cover','/external.jpg')").run(); }
    finally { other.close(); }
    assert.equal(service.navigation().summary.cover,'/external.jpg');
    const count = summaries;
    clock = 30_001;
    service.navigation();
    assert.equal(summaries,count+1);
    assert.deepEqual(service.navigation(),getArchiveLibraryNavigation(first.getDatabase(),users));
    current = second;
    first.close();
    assert.equal(service.navigation().summary.total,1);
    assert.deepEqual(service.navigation(),getArchiveLibraryNavigation(second.getDatabase(),users));
  } finally {
    t.mock.restoreAll(); first.close(); second.close(); await removeTestDir(root);
  }
});
