import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackDirectLinks, PlaybackDirectoryPreparation, playbackLinkExpiresAt, type PlaybackUpstreamResult } from '../src/playback-preparation.js';
import { parsePlaybackDelivery, parsePlaybackPreparationTargets } from '../src/shared/api/playback-queue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise,resolve};
}
const signal = () => new AbortController().signal;

test('signed playback links follow their actual expiry, margin, explicit refresh and LRU bound', async () => {
  let now = 1_800_000_000_000, calls = 0;
  const links = new PlaybackDirectLinks(() => now, 2);
  const load = async () => ({directLocation:`https://cdn.example/video?Expires=${Math.floor(now / 1000) + 180}&Signature=${++calls}`});
  const first = await links.resolve('a', load, signal());
  assert.equal((await links.resolve('a', load, signal())).directLocation, first.directLocation);
  assert.equal(calls, 1);
  now += 120_001;
  assert.notEqual((await links.resolve('a', load, signal())).directLocation, first.directLocation);
  assert.equal(calls, 2);
  await links.resolve('a', load, signal(), true);
  assert.equal(calls, 3);
  await links.resolve('b', load, signal());
  await links.resolve('a', load, signal()); // a stays most recently used.
  await links.resolve('c', load, signal());
  await links.resolve('b', load, signal());
  assert.equal(calls, 6);
});

test('unknown, duplicate and expired link timestamps never become a fabricated three-hour cache', async () => {
  const now = 1_800_000_000_000;
  for (const suffix of ['', '?Expires=invalid', '?Expires=0', '?Expires=1800000010', '?Expires=1800001000&expires=1800002000']) {
    const cache = new PlaybackDirectLinks(() => now); let calls = 0;
    const load = async () => { calls++; return {directLocation:'https://cdn.example/video' + suffix}; };
    await cache.resolve('file', load, signal()); await cache.resolve('file', load, signal());
    assert.equal(calls, 2, suffix);
  }
  assert.equal(playbackLinkExpiresAt('https://cdn.example/video?Expires=1800001000'), 1_800_001_000_000);
});

test('concurrent link requests share redirects, respect waiter cancellation and reject late cache writes', async () => {
  const links = new PlaybackDirectLinks(() => 0);
  const held = deferred<PlaybackUpstreamResult>(); let loads = 0;
  const load = () => { loads++; return held.promise; };
  const first = links.resolve('file', load, signal());
  const cancelled = new AbortController();
  const waiter = links.resolve('file', load, cancelled.signal);
  const other = links.resolve('file', load, signal());
  cancelled.abort(); await assert.rejects(waiter, {name:'AbortError'});
  held.resolve({directLocation:'https://cdn.example/file?Expires=300'});
  await first; assert.equal((await other).cachedDirect, true); assert.equal(loads, 1);

  const old = deferred<PlaybackUpstreamResult>();
  const oldRequest = links.resolve('late', () => old.promise, signal());
  links.clear();
  await links.resolve('late', async () => ({directLocation:'https://cdn.example/new?Expires=300'}), signal());
  old.resolve({directLocation:'https://cdn.example/old?Expires=300'}); await oldRequest;
  const cached = await links.resolve('late', async () => { throw new Error('cache should be current'); }, signal());
  assert.match(cached.directLocation!, /\/new\?/);
});

test('proxy bodies are never shared between requests and cancelled loads release their body', async () => {
  const links = new PlaybackDirectLinks(); let loads = 0;
  const load = async () => { loads++; return {response:new Response('individual body')}; };
  const [one,two] = await Promise.all([links.resolve('file',load,signal()),links.resolve('file',load,signal())]);
  assert.equal(loads, 2);
  assert.equal(await one.response!.text(), 'individual body');
  assert.equal(await two.response!.text(), 'individual body');
  const abort = new AbortController(); let released = false;
  await assert.rejects(links.resolve('cancel', async () => {
    abort.abort(); return {response:new Response(new ReadableStream({cancel(){released=true;}}))};
  },abort.signal), {name:'AbortError'});
  assert.equal(released, true);
});

test('directory reads merge across visitors and remain sequential when one visitor leaves', async () => {
  const lane = new PlaybackDirectoryPreparation(Date.now, 0), gate = deferred<void>();
  let active = 0, peak = 0; const read: string[] = [];
  const work = (name:string, wait = false) => async () => { read.push(name); peak=Math.max(peak,++active); if(wait)await gate.promise; active--; };
  const leave = new AbortController();
  const first = lane.prepare('a',work('a',true),leave.signal);
  const shared = lane.prepare('a',work('unexpected'),signal());
  const second = lane.prepare('b',work('b'),signal());
  await Promise.resolve(); leave.abort(); await assert.rejects(first, {name:'AbortError'});
  gate.resolve(); await Promise.all([shared,second]);
  assert.deepEqual(read,['a','b']); assert.equal(peak,1);
  // A later visit performs an ordinary read; it does not invent a fresh TTL.
  await lane.prepare('a',work('a-again'),signal());
  assert.deepEqual(read,['a','b','a-again']); lane.clear();
});

test('abandoned queued directory reads do not run and storage failure pauses background retries', async () => {
  const lane = new PlaybackDirectoryPreparation(Date.now,0), gate=deferred<void>(); let reads=0;
  const first = lane.prepare('busy',async()=>{await gate.promise;},signal());
  const leave = new AbortController();
  const queued = lane.prepare('abandoned',async()=>{reads++;},leave.signal);
  leave.abort(); await assert.rejects(queued,{name:'AbortError'}); gate.resolve(); await first;
  await lane.prepare('after',async()=>{reads++;},signal()); assert.equal(reads,1);
  let now=0; const paused = new PlaybackDirectoryPreparation(()=>now);
  await assert.rejects(paused.prepare('failed',async()=>{throw new Error('rate limited');},signal()));
  await assert.rejects(paused.prepare('other',async()=>{reads++;},signal()),/paused/);
  now=60_001; await paused.prepare('other',async()=>{reads++;},signal()); assert.equal(reads,2);
  lane.clear(); paused.clear();
});

test('browser boundaries validate preparation identities and keep older delivery responses compatible', () => {
  assert.equal(parsePlaybackDelivery({status:'direct'}).cachedDirect,false);
  assert.equal(parsePlaybackDelivery({status:'direct',cachedDirect:true}).cachedDirect,true);
  assert.throws(()=>parsePlaybackDelivery({status:'direct',cachedDirect:'yes'}));
  const target={directoryId:'a'.repeat(64),userId:'owner',mediaId:-2,fileId:1};
  assert.deepEqual(parsePlaybackPreparationTargets({targets:[target]}),[target]);
  for (const bad of [{...target,mediaId:0},{...target,fileId:'1'},{...target,directoryId:'/remote/path'}]) {
    assert.throws(()=>parsePlaybackPreparationTargets({targets:[bad]}));
  }
  assert.throws(()=>parsePlaybackPreparationTargets({targets:[target,target]}));
});

test('a stale preparation candidate does not pause unrelated directories',async()=>{
  let reads=0;const lane=new PlaybackDirectoryPreparation(Date.now,0);
  const stale=new Error('candidate removed');
  await assert.rejects(lane.prepare('gone',async()=>{throw stale;},signal(),error=>error!==stale));
  await lane.prepare('valid',async()=>{reads++;},signal());assert.equal(reads,1);lane.clear();
});

test('a failed cached address returned again by storage is not retained as a newly refreshed link',async()=>{
  const links=new PlaybackDirectLinks(()=>0);let calls=0;
  const load=async()=>{calls++;return {directLocation:'https://cdn.example/same?Expires=300'};};
  await links.resolve('file',load,signal());
  await links.resolve('file',load,signal(),true);
  await links.resolve('file',load,signal());assert.equal(calls,3);
  links.forget('file');await links.resolve('file',load,signal());assert.equal(calls,4);
});
