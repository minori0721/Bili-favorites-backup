import express from 'express';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createLogRouter } from '../../src/http/logs.js';
import type { LogEntry } from '../../src/logger.js';

test('log HTTP stream sends history and releases its subscription on disconnect', { timeout: 5000 }, async () => {
  const entry: LogEntry = { timestamp: '2026-09-20T00:00:00.000Z', type: 'system', level: 'info', summary: 'test', raw: 'test' };
  let active = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const app = express(); app.use(createLogRouter({ getAll: () => [entry], subscribe: () => { active++; return () => { active--; release(); }; } },
    {observe: () => () => {}}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/logs`;
  try {
    assert.deepEqual(await (await fetch(base)).json(), { success: true, data: [entry] });
    const response = await fetch(base + '/stream');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /data: .*test/);
    assert.equal(active, 1);
    await reader.cancel(); await released;
    assert.equal(active, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a slow log connection has bounded live backlog and releases both subscriptions', {timeout:5000},async()=>{
  const entry:LogEntry={timestamp:'2026-10-28T00:00:00Z',type:'system',level:'info',summary:'event',raw:'x'.repeat(200)};
  let send:((entry:LogEntry)=>void)|undefined,active=0,observed=0;
  let stream:ServerResponse|undefined;
  const app=express();app.use((_req,res,next)=>{stream=res;next();});
  app.use(createLogRouter({getAll:()=>[],subscribe(listener){send=listener;active++;return()=>{active--;};}},
    {observe:()=>{observed++;return()=>{observed--;};}},{maxPendingBytes:1024}));
  const server=createServer({highWaterMark:1},app);server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/logs/stream`);
  try {
    assert.equal(active,1);
    for(let i=0;i<100;i++)send?.(entry);
    assert.equal(active,0);assert.equal(observed,0);assert.equal(stream?.destroyed,true);
  } finally {
    await response.body?.cancel().catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('history larger than the live backlog cap drains completely, including UTF-8 logs', {timeout:5000},async()=>{
  const history=Array.from({length:500},(_,index):LogEntry=>({timestamp:'2026-10-28T00:00:00Z',type:'system',level:'info',summary:String(index),raw:'测'.repeat(2000)}));
  let active=0;
  let released!:()=>void;const release=new Promise<void>(resolve=>{released=resolve;});
  const app=express();app.use(createLogRouter({getAll:()=>history,subscribe(){active++;return()=>{active--;released();};}},
    {observe:()=>()=>{}},{maxPendingBytes:1024}));
  const server=createServer({highWaterMark:1024},app);server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/logs/stream`),reader=response.body!.getReader();
  let text='';
  try {
    const decoder=new TextDecoder();while(text.split('\n\n').length-1<500){const part=await reader.read();assert.equal(part.done,false);text+=decoder.decode(part.value,{stream:true});}
    const entries=text.trim().split('\n\n').map(frame=>JSON.parse(frame.slice(6)) as LogEntry);
    assert.deepEqual(entries.map(entry=>entry.summary),history.map(entry=>entry.summary));assert.equal(active,1);
  } finally {
    await reader.cancel().catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
  await release;assert.equal(active,0);
});

test('a connection with no drain signal times out and cancels its listener', {timeout:5000},async t=>{
  let stream:ServerResponse|undefined,send:((entry:LogEntry)=>void)|undefined,active=0;
  let released!:()=>void;const release=new Promise<void>(resolve=>{released=resolve;});
  const app=express();app.use((_req,res,next)=>{
    stream=res;const emit=res.emit.bind(res);
    t.mock.method(res,'emit',(name:string|symbol,...args:unknown[])=>name==='drain'?false:emit(name,...args));next();
  });
  app.use(createLogRouter({getAll:()=>[],subscribe(listener){send=listener;active++;return()=>{active--;released();};}},
    {observe:()=>()=>{}},{stallTimeoutMs:20}));
  const server=createServer({highWaterMark:1},app);server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/logs/stream`);
  try {
    send?.({timestamp:'2026-10-28T00:00:00Z',type:'system',level:'info',summary:'event',raw:'event'});
    await release;assert.equal(active,0);assert.equal(stream?.destroyed,true);
  } finally {
    await response.body?.cancel().catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));t.mock.restoreAll();
  }
});
