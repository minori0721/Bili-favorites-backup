import assert from 'node:assert/strict';
import test from 'node:test';
import { describeQualityProbe } from '../../src/web/client/features/settings/quality-probe.js';

const track=(quality:string,encoding:string,available=true)=>({quality,encoding,bilibiliQuality:quality,available});
const result=(pages:unknown[])=>({bvid:'BVfixture',status:'complete',pages,combinations:[]});

test('quality preview compares returned streams and preserves actual selection order',()=>{
  const value=result([{pageIndex:1,tracks:[track('1080P','HEVC'),track('4K','AV1'),track('8K','AV1',false)]}]);
  assert.equal(describeQualityProbe(value,'BVfixture').text,'当前账号可获取最高：4K / AV1；本次预计下载：1080P / HEVC（已探测，下载时重新确认）');
});

test('quality preview reports each multipart result instead of using the first page',()=>{
  const value=result([{pageIndex:1,tracks:[track('4K','HEVC'),track('4K','AV1')]},{pageIndex:2,tracks:[track('1080P60','AVC')]}]);
  assert.equal(describeQualityProbe(value,'BVfixture').text,'当前账号可获取最高：P1：4K / HEVC、AV1；P2：1080P60 / AVC；本次预计下载：P1：4K / HEVC；P2：1080P60 / AVC（已探测，下载时重新确认）');
  const same=result([{pageIndex:1,tracks:[track('720P','AVC')]},{pageIndex:2,tracks:[track('720P','AVC')]}]);
  assert.match(describeQualityProbe(same,'BVfixture').text,/各分P均为 720P \/ AVC/);
});

test('missing, malformed, unknown or foreign probe evidence cannot become a successful highest quality',()=>{
  const page={pageIndex:1,tracks:[track('4K','HEVC')]};
  for(const value of [result([]),result([page,page]),result([page,{pageIndex:2,tracks:[]}]),
    result([{...page,pageIndex:0}]),result([{...page,tracks:[track('unknown','AVC')]}]),
    result([{...page,tracks:[{quality:'4K',available:true}]}]),{...result([page]),bvid:'BVother'}]) {
    assert.throws(()=>describeQualityProbe(value,'BVfixture'));
  }
  assert.deepEqual(describeQualityProbe({bvid:'BVfixture',status:'running'},'BVfixture'),{status:'running',text:''});
  assert.deepEqual(describeQualityProbe({bvid:'BVfixture',status:'failed',error:'test timeout'},'BVfixture'),{status:'failed',text:'test timeout'});
});
