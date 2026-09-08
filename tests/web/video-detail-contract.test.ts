import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVideoDetailItem, parseUnavailablePage, parseVideoDetailPage } from '../../src/shared/api/video-detail.js';

test('video display boundary preserves favorite-only evidence independently from recovery unavailability',()=>{
  const item=parseVideoDetailItem({bvid:'BVfixture',unavailable:false,archivedSourceUnavailable:true,processed:true,sourceAvailability:{state:'pending_confirmation',reason:'favorite_flag'},cookie:'private'});
  assert.equal(item.unavailable,false);assert.equal(item.archivedSourceUnavailable,true);assert.equal('cookie' in item,false);
  assert.equal(item.sourceAvailability?.reason,'favorite_flag');
  for(const value of [{bvid:''},{bvid:'BV',processed:'false'},{bvid:'BV',playback:{available:'true'}},{bvid:'BV',mediaId:NaN}]) assert.throws(()=>parseVideoDetailItem(value));
});
test('unavailable cursor pagination rejects invalid continuation instead of looping the first page',()=>{
  assert.equal(parseUnavailablePage({items:[],hasMore:false}).nextCursor,null);
  assert.equal(parseUnavailablePage({items:[{bvid:'BV'}],hasMore:true,nextCursor:'cursor'}).items.length,1);
  assert.throws(()=>parseUnavailablePage({items:[],hasMore:true}));
  assert.throws(()=>parseUnavailablePage({items:[],hasMore:'false'}));
});
test('detail response validates both item and summary state before changing the view',()=>{
  const data=parseVideoDetailPage({items:[{bvid:'BV'}],hasMore:false,page:1,summary:{total:1,activeTotal:0},indexSummary:{indexed:1,scanComplete:false}});
  assert.equal(data.summary?.activeTotal,0);assert.equal(data.indexSummary?.scanComplete,false);
  assert.throws(()=>parseVideoDetailPage({items:[{bvid:'BV'}],hasMore:false,summary:{total:'1'}}));
  assert.throws(()=>parseVideoDetailPage({items:[{bvid:'BV'}],hasMore:false,indexSummary:{scanComplete:'false'}}));
});
