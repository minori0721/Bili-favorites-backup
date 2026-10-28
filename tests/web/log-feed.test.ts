import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogFeed, type LogConnection, type LogEntry } from '../../src/web/client/features/task-center/log-feed.js';
import { ApiError } from '../../src/web/client/shared/api.js';
import { SessionExpiredError } from '../../src/web/client/shared/session.js';

test('log disconnect checks authentication once and never reconnects after disposal', async () => {
  let connection!: LogConnection;
  let finish!: () => void;
  let checked: AbortSignal | undefined;
  let reconnects = 0;
  const feed = createLogFeed({connect:()=> connection = {onmessage:null,onerror:null,close:()=>{}},receive:()=>{},
    schedule:(_callback, ms)=>{if (ms !== 10_000) reconnects++;return 1;},cancel:()=>{},checkSession:signal=>{checked=signal;return new Promise<void>(resolve=>{finish=resolve;});}});
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

function retryFixture(checkSession?: (signal: AbortSignal) => Promise<unknown>) {
  const connections: LogConnection[] = [];
  const timers = new Map<number, {callback(): void; ms: number}>();
  let next = 0, closed = 0;
  const feed = createLogFeed({
    connect: () => { const source: LogConnection = {onmessage: null, onerror: null, close: () => { closed++; }}; connections.push(source); return source; },
    receive() {}, checkSession, random: () => 0.5,
    schedule: (callback, ms) => { timers.set(++next, {callback, ms}); return next; },
    cancel: handle => { timers.delete(handle); },
  });
  return {feed, connections, timers, get closed() { return closed; },
    runTimer(ms: number) {
      const match = [...timers].find(([,timer]) => timer.ms === ms);
      assert.ok(match, `expected a ${ms}ms timer`);
      timers.delete(match[0]); match[1].callback();
    },
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('a fresh stream replaces replayed history and ignores stale open callbacks', () => {
  const connections: LogConnection[] = [];
  let retry: (()=>void) | undefined;
  let resets = 0;
  const visible: string[] = [];
  const feed = createLogFeed({
    connect:()=>{const source:LogConnection={onmessage:null,onerror:null,close(){}};connections.push(source);return source;},
    receive:entry=>visible.push(entry.summary),reset:()=>{resets++;visible.length=0;},
    schedule:callback=>{retry=callback;return 1;},cancel(){},random:()=>0.5,
  });
  feed.start();
  const oldOpen=connections[0].onopen;
  connections[0].onopen?.();
  for(const summary of ['first','second','second']) connections[0].onmessage?.({data:JSON.stringify({summary})});
  connections[0].onerror?.();retry?.();
  oldOpen?.();assert.equal(resets,1);
  connections[1].onopen?.();
  for(const summary of ['first','second','second']) connections[1].onmessage?.({data:JSON.stringify({summary})});
  assert.equal(resets,2);assert.equal(feed.recent().length,3);
  assert.deepEqual(visible,['first','second','second']);
  feed.stop();
});

for (const error of [new ApiError('unavailable', undefined, undefined, 503), new TypeError('network unavailable'), new DOMException('timeout', 'TimeoutError')]) {
  test(`log session ${error.name} remains retryable and recovers without page refresh`, async () => {
    let checks = 0;
    const f = retryFixture(async () => { checks++; if (checks === 1) throw error; });
    f.feed.start();
    const previous = f.connections[0];
    previous.onerror?.();
    await flush();
    assert.equal(f.timers.size, 1);
    f.runTimer(3000);
    assert.equal(f.connections.length, 2);
    previous.onopen?.();
    f.connections[1].onerror?.();
    await flush();
    f.runTimer(6000);
    assert.equal(f.connections.length, 3);
    f.connections[2].onopen?.();
    f.connections[2].onerror?.();
    await flush();
    assert.equal([...f.timers.values()][0].ms, 3000);
    f.feed.stop();
    assert.equal(f.timers.size, 0);
  });
}

for (const error of [new SessionExpiredError(), new ApiError('expired', undefined, undefined, 401)]) {
  test(`confirmed ${error.name} stops log reconnection`, async () => {
    const f = retryFixture(async () => { throw error; });
    f.feed.start(); f.connections[0].onerror?.();
    await flush();
    assert.equal(f.timers.size, 0);
    assert.equal(f.connections.length, 1);
    f.feed.stop();
  });
}

test('log reconnection backs off to a bounded interval and stops all timers', () => {
  const f = retryFixture();
  f.feed.start();
  for (const ms of [3000, 6000, 12000, 24000, 30000, 30000]) {
    f.connections.at(-1)?.onerror?.();
    assert.equal(f.timers.size, 1);
    f.runTimer(ms);
  }
  f.feed.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.closed, 7);
});

test('a hung session check times out, aborts the request and still reconnects', async () => {
  let signal: AbortSignal | undefined;
  const f = retryFixture(value => { signal = value; return new Promise<void>(() => {}); });
  f.feed.start(); f.connections[0].onerror?.();
  await Promise.resolve();
  f.runTimer(10_000);
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(f.timers.size, 1);
  f.runTimer(3000);
  assert.equal(f.connections.length, 2);
  f.feed.stop();
});

test('a late failed check cannot stop a restarted log feed or remove its new timer', async () => {
  let rejectPrevious!: (error: Error) => void;
  let checks = 0;
  const f = retryFixture(() => {
    checks++;
    if (checks === 1) return new Promise<void>((_resolve, reject) => { rejectPrevious = reject; });
    return Promise.reject(new ApiError('temporary', undefined, undefined, 503));
  });
  f.feed.start(); f.connections[0].onerror?.();
  await Promise.resolve();
  f.feed.stop(); f.feed.start();
  f.connections[1].onerror?.();
  rejectPrevious(new SessionExpiredError());
  await flush();
  assert.equal(f.timers.size, 1);
  f.runTimer(3000);
  assert.equal(f.connections.length, 3);
  f.feed.stop();
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
