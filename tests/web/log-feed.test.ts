import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogFeed, type LogConnection, type LogEntry } from '../../src/web/client/features/task-center/log-feed.js';

test('log disconnect checks authentication once and never reconnects after disposal', async () => {
  let connection!: LogConnection;
  let finish!: () => void;
  let checked: AbortSignal | undefined;
  let reconnects = 0;
  const feed = createLogFeed({connect:()=> connection = {onmessage:null,onerror:null,close:()=>{}},receive:()=>{},
    schedule:()=>{reconnects++;return 1;},cancel:()=>{},checkSession:signal=>{checked=signal;return new Promise<void>(resolve=>{finish=resolve;});}});
  feed.start();
  const error = connection.onerror!;
  error();error();
  await Promise.resolve();
  assert.ok(checked);
  feed.stop();
  assert.equal(checked.aborted,true);
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reconnects,0);
});

test('log feed has one connection, cancels reconnect and rejects late events after stop', () => {
  const connections:LogConnection[] = [], entries:LogEntry[] = [];
  const timers = new Map<number,() => void>();
  let closed = 0, next = 0;
  const feed = createLogFeed({connect:() => {
    const source:LogConnection = {onmessage:null,onerror:null,close:() => { closed += 1; }};
    connections.push(source); return source;
  },receive:entry => entries.push(entry),schedule:callback => { timers.set(++next,callback); return next; },cancel:id => { timers.delete(id); }});
  feed.start(); feed.start();
  assert.equal(connections.length,1);
  const late = connections[0].onmessage!;
  late({data:'{"summary":"first"}'});
  const onerror = connections[0].onerror!;
  onerror(); onerror();
  assert.equal(timers.size,1);
  assert.equal(closed,1);
  feed.stop(); feed.stop();
  late({data:'{"summary":"late"}'});
  assert.equal(entries.length,1);
  assert.equal(timers.size,0);
  feed.start();
  assert.equal(connections.length,2);
  for (let i = 0; i < 600; i += 1) connections[1].onmessage?.({data:JSON.stringify({summary:String(i)})});
  assert.equal(feed.recent().length,200);
  assert.equal(feed.recent()[0].summary,'400');
  feed.stop();
});
