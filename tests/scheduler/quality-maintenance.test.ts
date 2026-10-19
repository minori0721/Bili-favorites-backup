import assert from 'node:assert/strict';
import test from 'node:test';
import { createQualityMaintenance, getQualityUpgradeMatchStatus } from '../../src/scheduler/quality-maintenance.js';
import { parseQualityUpgradeRequest } from '../../src/http/quality-maintenance.js';
import { testConfig } from '../helpers.js';
import type { RemoteFilePreviewVideoRecord, RemoteFileRecord } from '../../src/state.js';
import type { AppConfig } from '../../src/config.js';
import type { BiliUser } from '../../src/users.js';
import type { QualityUpgradeTask } from '../../src/tasks.js';

function qualityPreview(files: RemoteFileRecord[], overrides: Partial<AppConfig> = {}) {
  const records: RemoteFilePreviewVideoRecord[] = [{bvid:'BVfixture',title:'fixture',upperName:'fixture',remoteFiles:[],relations:[{
    userId:'user',mediaId:1,folderTitle:'fixture',backupStatus:'verified',hasInterruptedQualityUpgrade:false,
    remotePath:'/archive/video',remoteFiles:files,
  }]}];
  return createQualityMaintenance({
    config:()=>testConfig({alistDest:'/archive',bbdownQuality:'1080P',bbdownEncoding:'HEVC',...overrides}),
    records:()=>records,targetKeys:()=>new Set(),users:{getById:()=>null},
    enqueue:()=>{throw new Error('A preview must not enqueue work');},
  }).preview();
}

test('quality preview describes measured quality and codec instead of the previous requested settings', () => {
  const preview=qualityPreview([{
    name:'video.mp4',path:'/archive/video/video.mp4',
    qualityProfile:{quality:'4K',encoding:'HEVC',hiRes:false,dolby:false},
    mediaMetadata:{width:1280,height:720,codec:'h264',source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'},
  }]);
  assert.equal(preview.candidates.length,1);
  assert.equal(preview.candidates[0].reason,'现有：720P / AVC → 目标：1080P / HEVC');
});

test('quality preview preserves selected premium quality and actual encoding metadata', () => {
  const preview=qualityPreview([{
    name:'video.mp4',path:'/archive/video/video.mp4',
    qualityProfile:{quality:'1080P+',encoding:'AVC',hiRes:false,dolby:false},
    filenameMetadata:{bilibiliQuality:'1080P 高码率',videoCodecs:'avc1'},
    mediaMetadata:{width:1920,height:1080,codec:'unknown',source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'},
  }],{bbdownQuality:'4K'});
  assert.equal(preview.candidates[0].reason,'现有：1080P+ / AVC → 目标：4K / HEVC');
});

test('quality preview distinguishes historical download preferences and the automatic target', () => {
  const preview=qualityPreview([{
    name:'video.mp4',path:'/archive/video/video.mp4',
    qualityProfile:{quality:'720P',encoding:'AVC',hiRes:false,dolby:false},
  }],{bbdownQuality:'',bbdownEncoding:'',bbdownEncodingPriority:['AV1','AVC','HEVC']});
  assert.equal(preview.candidates[0].reason,'现有：720P（原下载设置） / AVC（原编码设置） → 目标：自动最高可用画质 / AV1 > AVC > HEVC（编码优先顺序）');
});

test('quality preview uses the same filename evidence as candidate classification', () => {
  const preview=qualityPreview([{
    name:'BVfixture-720P 高清-AVC.mp4',path:'/archive/video/video.mp4',
  }],{filenameTemplate:'<bvid>-<dfn>-<videoCodecs>'});
  assert.equal(preview.candidates[0].reason,'现有：720P / AVC → 目标：1080P / HEVC');
});

test('quality preview retains mixed multipart quality and incomplete evidence without authorizing unknown work', () => {
  const file={name:'part.mp4',path:'/archive/video/part.mp4'};
  const preview=qualityPreview([
    {...file,name:'part1.mp4',mediaMetadata:{width:1280,height:720,codec:'h264',source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'}},
    {...file,name:'part2.mp4',mediaMetadata:{width:1920,height:1080,fps:60,codec:'hevc',source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'}},
    {...file,name:'part3.mp4'},
    {...file,name:'cover.jpg',mediaMetadata:{width:3840,height:2160,source:'ffprobe',observedAt:'2026-10-19T00:00:00Z'}},
  ]);
  assert.equal(preview.candidates.length,0);
  assert.equal(preview.uncertain.length,1);
  assert.equal(preview.uncertain[0].reason,'现有：720P / AVC；1080P60 / HEVC；原画质未记录 / 原编码未记录 → 目标：1080P / HEVC；旧画质档案不完整，需要人工确认');
  const noMedia=qualityPreview([{...file,name:'cover.jpg'}],{bbdownHiRes:true,bbdownDolby:true});
  assert.match(noMedia.uncertain[0].reason,/现有：原画质未记录 \/ 原编码未记录 → 目标：1080P \/ HEVC/);
  assert.match(noMedia.uncertain[0].reason,/Hi-Res 优先：未记录 → 开；杜比音频优先：未记录 → 开/);
});

test('quality preview explains audio preference changes even when resolution is unchanged', () => {
  const preview=qualityPreview([{
    name:'video.mp4',path:'/archive/video/video.mp4',
    qualityProfile:{quality:'1080P',encoding:'HEVC',hiRes:false,dolby:true},
  }],{bbdownHiRes:true,bbdownDolby:false});
  assert.match(preview.candidates[0].reason,/Hi-Res 优先：关 → 开；杜比音频优先：开 → 关$/);
});

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
