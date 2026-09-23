import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQueueStatus } from '../../src/shared/api/queue-status.js';
import { parseQueueSnapshot } from '../../src/shared/api/queue-snapshot.js';

test('queue status preserves zero counts and both persisted numeric and ISO schedule timestamps',()=>{
  const status=parseQueueStatus({scheduler:{status:'idle' as const,nextRunAt:100,queuedActions:['同步']},recovery:{pendingUploads:0},chargingAccess:{pending:1,nextCheckAt:'2026-09-08T00:00:00Z'},localCache:{usedBytes:0,limitBytes:10,paused:false}});
  assert.equal(status.scheduler.nextRunAt,100);assert.equal(status.scheduler.recovery.pendingUploads,0);assert.equal(status.scheduler.recovery.pendingQualityMaintenance,0);assert.equal(status.scheduler.accountCooldown,null);assert.equal(status.localCache?.usedBytes,0);assert.equal(status.chargingAccess?.nextCheckAt,'2026-09-08T00:00:00Z');
});
test('queue status accepts validated quality and account cooldown summaries',()=>{
  const status=parseQueueStatus({scheduler:{status:'cooldown',nextRunAt:100,queuedActions:[],accountCooldown:{count:2,earliestUntil:200}},recovery:{pendingQualityMaintenance:3}});
  assert.equal(status.scheduler.nextRunAt,100);
  assert.deepEqual(status.scheduler.accountCooldown,{count:2,earliestUntil:200,userName:''});
  assert.equal(status.scheduler.recovery.pendingQualityMaintenance,3);
  for(const value of [
    {scheduler:{status:'idle',accountCooldown:{count:0,earliestUntil:200}}},
    {scheduler:{status:'idle',accountCooldown:{count:1.5,earliestUntil:200}}},
    {scheduler:{status:'idle',accountCooldown:{count:1,earliestUntil:'later'}}},
    {scheduler:{status:'idle'},recovery:{pendingQualityMaintenance:'2'}},
  ]) assert.throws(()=>parseQueueStatus({...value,recovery:'recovery' in value ? value.recovery : {}}));
});
test('queue snapshot rejects malformed status before publishing any new board state',()=>{
  for(const value of [{scheduler:{queuedActions:[{}]}},{localCache:{paused:'false'}},{uploadHealth:{retryAt:{}}},{recovery:{pendingUploads:'1'}},{scheduler:[]}])assert.throws(()=>parseQueueSnapshot(value));
  assert.throws(() => parseQueueStatus({}), /状态/);
});
