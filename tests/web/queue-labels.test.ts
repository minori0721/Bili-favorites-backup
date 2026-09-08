import assert from 'node:assert/strict';
import test from 'node:test';
import { formatElapsed, queuePhaseLabel, queueTimeLabel, makeQueueCardKey } from '../../src/web/client/features/task-center/queue-labels.js';
import type { QueueBoardItem } from '../../src/shared/api/queue-item.js';

const item:QueueBoardItem={id:'job',bvid:'BV',title:'fixture',upperName:'',cover:'',folderTitle:'',remotePath:'/archive',detail:'',userId:'user',mediaId:1,retries:0,maxRetries:3,stage:'download_pending'};
test('queue labels distinguish execution, remote evidence and scheduled recheck',()=>{
  assert.equal(queuePhaseLabel({...item,phase:'running',stage:'download_running'}),'正在下载');
  assert.equal(queuePhaseLabel({...item,phase:'remote_verifying'}),'正在确认远端');
  assert.equal(queuePhaseLabel({...item,phase:'running',lifecycleState:'manual_required'}),'等待处理');
  assert.equal(queueTimeLabel({...item,nextAction:'recheck',nextActionAt:62_000},1_000),'约 1m 1s后自动复核');
  assert.equal(queueTimeLabel({...item,nextAction:'verify',nextActionAt:1_000},2_000),'等待确认调度');
  assert.equal(queueTimeLabel({...item,phase:'running',startedAt:5_000},2_000),'已运行 0s');
  assert.equal(formatElapsed(NaN),'0s');
});
test('queue card identity survives stage changes but separates archive targets',()=>{
  assert.equal(makeQueueCardKey(item),makeQueueCardKey({...item,id:'new-job',stage:'upload_running'}));
  assert.notEqual(makeQueueCardKey(item),makeQueueCardKey({...item,remotePath:'/other'}));
});
