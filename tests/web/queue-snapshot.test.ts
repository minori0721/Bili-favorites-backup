import { queueResponse, parseQueueFixture } from './queue-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueueSnapshotResource } from '../../src/web/client/features/task-center/snapshot.js';
import { parseQueueSnapshot, type QueueSnapshot } from '../../src/shared/api/queue-snapshot.js';

test('missing queue fields cannot be presented as an empty or idle queue', () => {
  for (const field of ['scheduler', 'recovery', 'downloadPending', 'downloadRunning', 'uploadPending', 'uploadRunning']) {
    assert.throws(() => parseQueueSnapshot({...queueResponse(), [field]: undefined}));
  }
  assert.equal(parseQueueSnapshot(queueResponse()).downloadPending.length, 0);
});

test('board and issue panel share a request while retaining independent cancellation', async () => {
  let calls = 0;
  let release!: (value:unknown) => void;
  let signal:AbortSignal | null | undefined;
  const receive:QueueSnapshot[] = [];
  const request = async (_url:string, options?:RequestInit) => {
    calls += 1; signal = options?.signal;
    return new Promise(resolve => { release = value => resolve(queueResponse(value)); });
  };
  const resource = createQueueSnapshotResource({api:{request,silent:request},receive:snapshot => receive.push(snapshot)});
  const first = new AbortController(), second = new AbortController();
  const board = resource.request(first.signal);
  const issues = resource.request(second.signal);
  assert.equal(calls,1);
  first.abort();
  await assert.rejects(board,{name:'AbortError'});
  assert.equal(signal?.aborted,false);
  release({issues:[{id:'issue'}]});
  const result = await issues;
  assert.equal(result.issues[0].id,'issue');
  assert.equal(receive.length,1);
  assert.equal(resource.current,result);
});

test('cancelled late responses cannot replace the new snapshot or resolve new consumers', async () => {
  const pending:Array<(value:unknown) => void> = [];
  const receive:QueueSnapshot[] = [];
  const request = async () => new Promise(resolve => pending.push(value => resolve(queueResponse(value))));
  const resource = createQueueSnapshotResource({api:{request,silent:request},receive:snapshot => receive.push(snapshot)});
  const old = resource.request();
  resource.cancel();
  await assert.rejects(old,{name:'AbortError'});
  const current = resource.request();
  pending[0]({issues:[{id:'old'}]});
  pending[1]({issues:[{id:'new'}]});
  assert.equal((await current).issues[0].id,'new');
  assert.equal(receive.length,1);
  assert.equal(resource.current?.issues[0].id,'new');
  resource.reset();
  assert.equal(resource.current,null);
});

test('queue boundary rejects invalid arrays and supports the existing issue fallbacks', () => {
  assert.throws(() => parseQueueSnapshot(null));
  assert.throws(() => parseQueueFixture({downloadPending:{}}));
  assert.throws(() => parseQueueFixture({issues:[null]}));
  assert.deepEqual(parseQueueFixture({actionRequiredIssues:[{id:'action'}],intentionalConfirmations:[{id:'confirm'}]}).issues.map(item => item.id),['action','confirm']);
  assert.equal(parseQueueFixture({uploadPending:[{id:'job'}]}).uploadPending[0].stage,'upload_pending');
  assert.throws(() => parseQueueFixture({uploadPending:[{id:'job',retries:'1'}]}));
  assert.throws(() => parseQueueFixture({uploadPending:[{id:'job',recoveryActions:[{label:'重试'}]}]}));
  assert.throws(() => parseQueueFixture({uploadPending:[{id:'job',recoveryActions:[{id:'retry'}]}]}));
  assert.throws(() => parseQueueFixture({uploadPending:[{id:'job',recoveryDisposition:'unknown'}]}));
});

test('completed issue actions invalidate older board responses and preserve the last board columns', async () => {
  const pending:Array<(value:unknown) => void> = [];
  const received:QueueSnapshot[] = [];
  const request = async () => new Promise(resolve => pending.push(value => resolve(queueResponse(value))));
  const resource = createQueueSnapshotResource({api:{request,silent:request},receive:value => received.push(value)});
  const initial = resource.request();
  pending[0]({downloadRunning:[{id:'running'}],issues:[{id:'before'}]});
  await initial;
  const stale = resource.request();
  resource.applyIssueUpdate({issues:[{id:'after'}]});
  await assert.rejects(stale,{name:'AbortError'});
  pending[1]({downloadRunning:[],issues:[{id:'before'}]});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(received.length,2);
  assert.equal(resource.current?.issues[0].id,'after');
  assert.equal(resource.current?.downloadRunning[0].id,'running');
  assert.throws(() => resource.applyIssueUpdate({issues:[null]}));
  assert.equal(resource.current?.issues[0].id,'after');
});
