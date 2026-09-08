import assert from 'node:assert/strict';
import test from 'node:test';
import { projectQualityUpgradeState } from '../../src/scheduler/quality-projection.js';
import type { PersistentJobRecord } from '../../src/database.js';

test('quality projection preserves grouping, retry labels and lease-derived running state without writes',()=>{
  const base:PersistentJobRecord={id:'job',kind:'quality_download',dedupeKey:'fixture',bvid:'BV',userId:'user',mediaId:1,status:'running',priority:0,payload:{artifactKey:'artifact',videoTitle:'fixture',qualityStageLabel:'下载新版 · stale'},attempts:0,maxAttempts:3,notBefore:0,createdAt:100,updatedAt:200};
  const jobs=Object.freeze([Object.freeze(base),Object.freeze({...base,id:'cleanup',kind:'quality_cleanup',status:'retry_wait' as const})]);
  const before=JSON.stringify(jobs);let counted=0;
  const result=projectQualityUpgradeState(jobs,()=>{counted++;return 2;});
  assert.equal(result.running[0].key,'artifact:artifact');assert.equal(result.running[0].folderTitle,'2个目标');assert.equal(result.running[0].stageLabel,'下载新版 · 2个目标');assert.equal(result.running[0].startedAt,200);
  assert.equal(result.running[1].targetCount,1);assert.equal(result.running[1].stageLabel,'旧文件清理重试中');assert.equal(result.running[1].startedAt,undefined);
  assert.equal(counted,1);assert.deepEqual(result.completed,[]);assert.equal(JSON.stringify(jobs),before);
});
