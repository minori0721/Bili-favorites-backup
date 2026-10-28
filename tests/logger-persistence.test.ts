import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { LogManager, type LogEntry } from '../src/logger.js';
import { JsonFileDecodeError, readJsonFileDecoded } from '../src/storage.js';
import { createTestDir, removeTestDir } from './helpers.js';

const entry: LogEntry = { timestamp: '2026-10-03T00:00:00Z', type: 'system', level: 'info', summary: 'new event', raw: 'new event' };

test('log read I/O failure cannot authorize overwriting existing history', async t => {
  const directory = await createTestDir('log-read-failure');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, JSON.stringify([entry]));
    const read = t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    const logs = new LogManager(file);
    read.mock.restore(); logs.push(entry); logs.flush(); logs.close();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [entry]);
    assert.deepEqual(fs.readdirSync(directory), ['logs.json']);
  } finally { t.mock.restoreAll(); await removeTestDir(directory); }
});

test('failed corrupt-log backup preserves the sole original through push, flush and close', async t => {
  const directory = await createTestDir('log-backup-failure');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, '{broken');
    t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup denied'); });
    assert.throws(() => readJsonFileDecoded(file, [], value => value), error => error instanceof JsonFileDecodeError && error.preservedAt === null);
    const logs = new LogManager(file);
    logs.push(entry); logs.flush(); logs.close();
    assert.equal(logs.getAll()[0].summary, entry.summary);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(directory), ['logs.json']);
  } finally { t.mock.restoreAll(); await removeTestDir(directory); }
});

test('successful preservation permits a new log while retaining the corrupt original', async () => {
  const directory = await createTestDir('log-backup-success');
  const file = path.join(directory, 'logs.json');
  try {
    fs.writeFileSync(file, '{broken');
    const logs = new LogManager(file); logs.push(entry); logs.close();
    const backup = fs.readdirSync(directory).find(name => name.startsWith('logs.json.corrupt-'));
    assert.ok(backup); assert.equal(fs.readFileSync(path.join(directory, backup), 'utf8'), '{broken');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].summary, entry.summary);
  } finally { await removeTestDir(directory); }
});

test('reload cancels pending writes when preservation fails', async t => {
  const directory = await createTestDir('log-reload');
  const file = path.join(directory, 'logs.json');
  const logs = new LogManager(file);
  try {
    logs.push(entry); fs.writeFileSync(file, '{broken');
    t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup denied'); });
    logs.reload(); logs.push(entry);
    await new Promise(resolve => setTimeout(resolve, 350));
    logs.flush(); logs.close(); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { logs.close(); t.mock.restoreAll(); await removeTestDir(directory); }
});

test('persistence failure is observable and disables retries without stopping in-memory logging', async t => {
  const directory = await createTestDir('log-write-failure');
  const file = path.join(directory, 'logs.json');
  const logs = new LogManager(file);
  try {
    const warning = t.mock.method(console, 'warn', () => {});
    const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk write denied'); });
    logs.push(entry); assert.doesNotThrow(() => logs.flush());
    logs.push(entry); logs.flush(); logs.close();
    assert.equal(rename.mock.callCount(), 1); assert.equal(warning.mock.callCount(), 1);
    assert.equal(logs.getEntryCount(), 2); assert.equal(fs.readFileSync(file, 'utf8'), '[]');
  } finally { t.mock.restoreAll(); logs.close(); await removeTestDir(directory); }
});

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
function holdLogWrite(t:TestContext,file:string) {
  const entered=deferred(),release=deferred();
  const open=fs.promises.open;
  let writes=0;
  t.mock.method(fs.promises,'open',async(...args:Parameters<typeof open>)=>{
    const handle=await open(...args);
    if(String(args[0]).startsWith(file+'.')&&String(args[0]).endsWith('.tmp')) {
      const write=handle.writeFile.bind(handle);
      t.mock.method(handle,'writeFile',async(...values:Parameters<typeof handle.writeFile>)=>{
        writes++;entered.resolve();await release.promise;return write(...values);
      });
    }
    return handle;
  });
  return {entered:entered.promise,release:release.resolve,get writes(){return writes;}};
}

test('normal log writes coalesce while pending and close waits without restoring an old snapshot', {timeout:5000},async t=>{
  const directory=await createTestDir('log-async-close'),file=path.join(directory,'logs.json');
  const logs=new LogManager(file),held=holdLogWrite(t,file);
  try {
    logs.push(entry);await held.entered;
    logs.push({...entry,summary:'latest'});
    await new Promise(resolve=>setTimeout(resolve,350));assert.equal(held.writes,1);
    let stopped=false;const close=logs.close().then(()=>{stopped=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
    held.release();await close;
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).at(-1).summary,'latest');
    assert.deepEqual(fs.readdirSync(directory),['logs.json']);
  }finally{held.release();await logs.close();t.mock.restoreAll();await removeTestDir(directory);}
});

test('clear invalidates a pending log commit and cannot resurrect cleared history', {timeout:5000},async t=>{
  const directory=await createTestDir('log-async-clear'),file=path.join(directory,'logs.json');
  const logs=new LogManager(file),held=holdLogWrite(t,file);
  try {
    logs.push(entry);await held.entered;logs.clear();
    const pause=logs.pausePersistence();held.release();const resume=await pause;
    assert.equal(fs.existsSync(file),false);assert.deepEqual(logs.getAll(),[]);
    resume();await logs.close();assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),[]);
    assert.deepEqual(fs.readdirSync(directory),['logs.json']);
  }finally{held.release();await logs.close();t.mock.restoreAll();await removeTestDir(directory);}
});

test('import pauses old writes and retains restored logs plus subsequent events', {timeout:5000},async t=>{
  const directory=await createTestDir('log-async-import'),file=path.join(directory,'logs.json');
  const logs=new LogManager(file),held=holdLogWrite(t,file);
  try {
    logs.push(entry);await held.entered;
    let paused=false;const pause=logs.pausePersistence().then(resume=>{paused=true;return resume;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(paused,false);
    held.release();const resume=await pause;
    const restored={...entry,summary:'imported history'};fs.writeFileSync(file,JSON.stringify([restored]));
    logs.reload();logs.push({...entry,summary:'after import'});
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),[restored]);
    resume();await logs.close();
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).map((item:LogEntry)=>item.summary),['imported history','after import']);
    assert.deepEqual(fs.readdirSync(directory),['logs.json']);
  }finally{held.release();await logs.close();t.mock.restoreAll();await removeTestDir(directory);}
});

test('reload with failed preservation blocks an older asynchronous commit', {timeout:5000},async t=>{
  const directory=await createTestDir('log-async-corrupt'),file=path.join(directory,'logs.json');
  const logs=new LogManager(file),held=holdLogWrite(t,file);
  try {
    logs.push(entry);await held.entered;fs.writeFileSync(file,'{broken');
    t.mock.method(fs,'copyFileSync',()=>{throw new Error('preservation denied');});
    logs.reload();held.release();await logs.close();
    assert.equal(fs.readFileSync(file,'utf8'),'{broken');assert.deepEqual(fs.readdirSync(directory),['logs.json']);
  }finally{held.release();await logs.close();t.mock.restoreAll();await removeTestDir(directory);}
});

test('asynchronous persistence failure degrades once and keeps the original file', {timeout:5000},async t=>{
  const directory=await createTestDir('log-async-failure'),file=path.join(directory,'logs.json');
  const logs=new LogManager(file);const failed=deferred();
  const warning=t.mock.method(console,'warn',()=>{failed.resolve();});
  const rename=t.mock.method(fs,'renameSync',()=>{throw new Error('write denied');});
  try {
    logs.push(entry);await failed.promise;logs.push(entry);await logs.close();
    assert.equal(rename.mock.callCount(),1);assert.equal(warning.mock.callCount(),1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),[]);assert.deepEqual(fs.readdirSync(directory),['logs.json']);
    assert.equal(logs.getEntryCount(),2);
  }finally{await logs.close();t.mock.restoreAll();await removeTestDir(directory);}
});
