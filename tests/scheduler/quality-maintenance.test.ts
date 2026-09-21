import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityMaintenance, getQualityUpgradeMatchStatus } from '../../src/scheduler/quality-maintenance.js';
import { parseQualityUpgradeRequest } from '../../src/http/quality-maintenance.js';
import { testConfig } from '../helpers.js';
import type { RemoteFilePreviewVideoRecord } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import type { QualityUpgradeTask } from '../../src/tasks.js';

test('quality rules prefer explicit profiles and do not infer premium audio from a filename', () => {
  const config=testConfig({bbdownQuality:'1080P',bbdownEncoding:'HEVC',filenameTemplate:'<bvid>-<dfn>-<videoCodecs>'});
  const file={name:'BVfixture-1080P 高清-HEVC.mp4',path:'/archive/file.mp4'};
  assert.equal(getQualityUpgradeMatchStatus([file],'BVfixture',config),'same');
  assert.equal(getQualityUpgradeMatchStatus([file],'BVfixture',{...config,bbdownHiRes:true}),'unknown');
  assert.equal(getQualityUpgradeMatchStatus([{...file,qualityProfile:{quality:'720P',encoding:'HEVC',hiRes:false,dolby:false}}],'BVfixture',config),'different');
  assert.equal(getQualityUpgradeMatchStatus([{...file,name:'unrelated.mp4'}],'BVfixture',config),'unknown');
});

test('quality maintenance rechecks candidates, requires unknown confirmation and retains scheduler admission', () => {
  const config=testConfig({alistDest:'/archive',bbdownQuality:'1080P'});
  const user:BiliUser={id:'user',uid:1,name:'fixture',enabled:true,favorites:[],lastLoginAt:'',cookie:{SESSDATA:'',bili_jct:'',DedeUserID:''}};
  const records:RemoteFilePreviewVideoRecord[]=[{bvid:'BVfixture',title:'fixture',upperName:'fixture',remoteFiles:[],relations:[{userId:'user',mediaId:1,folderTitle:'fixture',backupStatus:'verified' as const,hasInterruptedQualityUpgrade:false,remotePath:'/archive/video',remoteFiles:[{name:'video.mp4',path:'/archive/video/video.mp4',size:10}]}]}];
  let admit=true;const submitted:QualityUpgradeTask[]=[];
  const service=createQualityMaintenance({config:()=>config,records:()=>records,targetKeys:()=>new Set(),users:{getById:()=>user},enqueue:task=>{submitted.push(task);return admit;}});
  const preview=service.preview();assert.equal(preview.candidates.length,0);assert.equal(preview.uncertain.length,1);
  const key=preview.uncertain[0].key;
  assert.equal(service.submit([{key}]).queued.length,0);assert.equal(submitted.length,0);
  const result=service.submit([{key,forceUnknown:true},{key,forceUnknown:true}]);
  assert.equal(result.queued.length,1);assert.equal(result.skipped[0].reason,'重复提交');assert.equal(submitted.length,1);
  admit=false;assert.equal(service.submit([{key,forceUnknown:true}]).queued.length,0);
  records[0].relations[0].hasInterruptedQualityUpgrade=true;
  const before=submitted.length;assert.equal(service.submit([{key,forceUnknown:true}]).queued.length,0);assert.equal(submitted.length,before);
});

test('quality request rejects invalid entries before any batch can be partially admitted', () => {
  assert.deepEqual(parseQualityUpgradeRequest({items:[{key:'fixture',forceUnknown:false}]}),[{key:'fixture',forceUnknown:false,userId:undefined,bvid:undefined,mediaId:undefined}]);
  for(const value of [null,{items:[]},{items:[null]},{items:[{key:'valid'},{key:{}}]},{items:[{key:'fixture',forceUnknown:'false'}]},{items:Array.from({length:51},()=>({key:'fixture'}))}]) assert.equal(parseQualityUpgradeRequest(value),null);
});
