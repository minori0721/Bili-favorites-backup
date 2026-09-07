import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { StateManager } from "../src/state.js";
import { ImportMaintenance } from "../src/import-maintenance.js";
import { createTestDir, removeTestDir } from "./helpers.js";

async function fixture() {
  const root = await createTestDir("import-safety");
  const active = path.join(root, "active.sqlite"), source = path.join(root, "source.sqlite");
  for (const [file, bvid] of [[active, "BVOLD"], [source, "BVNEW"]]) {
    const manager = new StateManager({ dbPath: file, statePath: path.join(root, "none.json") });
    manager.recordFavoriteItem("u", 1, "folder", { bvid, title: bvid, upperName: "up" } as any);
    manager.close();
  }
  return { root, active, source };
}

test("initial database rename failure preserves original records", async () => {
  const f = await fixture();
  const manager = new StateManager({ dbPath: f.active });
  manager.recordFavoriteItem("u", 1, "folder", { bvid: "BVLATE", title: "late WAL write" } as any);
  const rename = fs.renameSync;
  fs.renameSync = ((from: any, to: any) => {
    if (String(from) === f.active && String(to).includes(".displaced-")) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(manager.beginDatabaseReplacement(f.source), /fixture EACCES/);
    assert.equal(manager.getVideoMeta("BVOLD")?.title, "BVOLD");
    assert.equal(manager.getVideoMeta("BVNEW"), null);
    assert.equal(manager.getVideoMeta("BVLATE")?.title, "late WAL write");
  } finally { fs.renameSync = rename; manager.close(); await removeTestDir(f.root); }
});

for (const stage of ["old-moved", "installed", "committed"] as const) {
  test(`restart recovers database after child exits at ${stage}`, async () => {
    const f = await fixture();
    const moduleUrl = pathToFileURL(path.resolve("src/state.ts")).href;
    const code = `import fs from 'node:fs';
      const {StateManager}=await import(${JSON.stringify(moduleUrl)});
      const m=new StateManager({dbPath:${JSON.stringify(f.active)}});
      if (${JSON.stringify(stage)}==='old-moved') {
        const rename=fs.renameSync; fs.renameSync=(a,b)=>{rename(a,b);if(String(a)===${JSON.stringify(f.active)} && String(b).includes('.displaced-'))process.exit(79);};
      }
      const h=await m.beginDatabaseReplacement(${JSON.stringify(f.source)});
      if (${JSON.stringify(stage)}==='committed') await h.commit();
      process.exit(79);`;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 79, result.stderr);
      const manager = new StateManager({ dbPath: f.active });
      try {
        const kept = stage === "committed" ? "BVNEW" : "BVOLD";
        assert.equal(manager.getVideoMeta(kept)?.title, kept);
      } finally { manager.close(); }
    } finally { await removeTestDir(f.root); }
  });
}

test("missing rollback snapshot fails closed instead of opening an empty database", async () => {
  const f = await fixture();
  try {
    fs.rmSync(f.active);
    fs.writeFileSync(`${f.active}.replacement.json`, JSON.stringify({version:1,id:"a".repeat(32),committed:false}));
    assert.throws(() => new StateManager({ dbPath: f.active }));
    assert.equal(fs.existsSync(f.active), false);
  } finally { await removeTestDir(f.root); }
});

for (const committed of [false, true]) {
  test(`restart restores a consistent config/database pair (commit=${committed})`, async () => {
    const root = await createTestDir("import-pair");
    const stateUrl = pathToFileURL(path.resolve("src/state.ts")).href;
    const transactionUrl = pathToFileURL(path.resolve("src/import-transaction.ts")).href;
    const setup = `process.env.NODE_ENV='test';process.env.BFB_TEST_APP_ROOT=${JSON.stringify(root)};
      const fs=await import('node:fs');const path=await import('node:path');
      const {StateManager}=await import(${JSON.stringify(stateUrl)});
      const {beginImportTransaction,recoverImportTransaction}=await import(${JSON.stringify(transactionUrl)});
      const data=path.join(${JSON.stringify(root)},'data');fs.mkdirSync(data,{recursive:true});
      const active=path.join(data,'bfb.sqlite');`;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", setup + `
        const old=new StateManager({dbPath:active});old.recordFavoriteItem('u',1,'f',{bvid:'BVOLD',title:'old'});
        const source=path.join(data,'source.sqlite');const next=new StateManager({dbPath:source});next.recordFavoriteItem('u',1,'f',{bvid:'BVNEW',title:'new'});next.close();
        const id='b'.repeat(32),target=path.join(data,'config.json'),staged=target+'.migration-'+id,backup=target+'.before-migration-'+id;
        fs.writeFileSync(target,'old');fs.writeFileSync(staged,'new');
        const tx=beginImportTransaction(id);tx.add({target,staged,backup});fs.renameSync(target,backup);fs.renameSync(staged,target);
        await old.beginDatabaseReplacement(source);
        if(${committed})tx.commit();
        process.exit(79);`], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 79, result.stderr);
      const recovered = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", setup + `
        recoverImportTransaction();const m=new StateManager({dbPath:active});
        console.log(JSON.stringify({config:fs.readFileSync(path.join(data,'config.json'),'utf8'),old:!!m.getVideoMeta('BVOLD'),next:!!m.getVideoMeta('BVNEW')}));m.close();`], { encoding: "utf8", timeout: 15000 });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(JSON.parse(recovered.stdout.trim()), { config: committed ? "new" : "old", old: !committed, next: committed });
    } finally { await removeTestDir(root); }
  });
}

test("database commit remains successful when backup deletion fails", async () => {
  const f = await fixture();
  const manager = new StateManager({ dbPath: f.active });
  const rm = fs.rmSync;
  try {
    const handle = await manager.beginDatabaseReplacement(f.source);
    fs.rmSync = ((target: any, options: any) => {
      if (String(target).startsWith(`${f.active}.before-import-`)) throw new Error("fixture cleanup denied");
      return rm(target, options);
    }) as typeof fs.rmSync;
    await handle.commit();
    await handle.rollback();
    assert.equal(manager.getVideoMeta("BVNEW")?.title, "BVNEW");
  } finally { fs.rmSync = rm; manager.close(); }
  try {
    const recovered = new StateManager({ dbPath: f.active });
    try { assert.equal(recovered.getVideoMeta("BVNEW")?.title, "BVNEW"); } finally { recovered.close(); }
  } finally { await removeTestDir(f.root); }
});

test("failed rollback retains its snapshot and can recover on next startup", async () => {
  const f = await fixture();
  const manager = new StateManager({ dbPath: f.active });
  const rename = fs.renameSync;
  try {
    const handle = await manager.beginDatabaseReplacement(f.source);
    fs.renameSync = ((from: any, to: any) => {
      if (String(from).endsWith(".restore")) throw Object.assign(new Error("fixture restore denied"), { code: "EACCES" });
      return rename(from, to);
    }) as typeof rename;
    await assert.rejects(handle.rollback(), (error: any) => error.recoveryRequired === true);
    assert.equal(fs.existsSync(`${f.active}.replacement.json`), true);
    assert.ok(fs.readdirSync(f.root).some(name => name.includes(".before-import-")));
  } finally { fs.renameSync = rename; try { manager.close(); } catch {} }
  try {
    const restored = new StateManager({ dbPath: f.active });
    try { assert.equal(restored.getVideoMeta("BVOLD")?.title, "BVOLD"); } finally { restored.close(); }
  } finally { await removeTestDir(f.root); }
});

test("import maintenance drains admitted work, blocks new work, and keeps recovery failure closed", async () => {
  const gate = new ImportMaintenance();
  const leave = gate.enter();
  let acquired = false;
  const pending = gate.acquire().then(release => { acquired = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(acquired, false);
  assert.throws(() => gate.enter(), /维护/);
  leave();
  const release = await pending;
  release();
  await assert.rejects(gate.run(async () => { throw new Error("fixture"); }), /fixture/);
  const releaseAgain = await gate.acquire();
  gate.failClosed();
  releaseAgain();
  assert.throws(() => gate.enter(), /维护/);
});

test("repeated recovery accepts a rolled-back file that did not exist before import", async () => {
  const root = await createTestDir("import-absent-file");
  const transactionUrl = pathToFileURL(path.resolve("src/import-transaction.ts")).href;
  try {
    const code = `process.env.NODE_ENV='test';process.env.BFB_TEST_APP_ROOT=${JSON.stringify(root)};
      const {default:fs}=await import('node:fs');const {default:path}=await import('node:path');
      const {beginImportTransaction,recoverImportTransaction}=await import(${JSON.stringify(transactionUrl)});
      const data=path.join(${JSON.stringify(root)},'data');fs.mkdirSync(data,{recursive:true});
      const id='c'.repeat(32),target=path.join(data,'config.json'),staged=target+'.migration-'+id,backup=target+'.before-migration-'+id;
      fs.writeFileSync(staged,'new');const tx=beginImportTransaction(id);tx.add({target,staged,backup});fs.renameSync(staged,target);
      const rm=fs.rmSync;fs.rmSync=(f,o)=>{if(String(f).endsWith('import-transaction.json'))throw new Error('fixture cleanup denied');return rm(f,o);};
      try{recoverImportTransaction();}catch{}finally{fs.rmSync=rm;}
      recoverImportTransaction();if(fs.existsSync(target))throw new Error('unexpected new config');`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { await removeTestDir(root); }
});
