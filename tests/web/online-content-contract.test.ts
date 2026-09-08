import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOnlineItem, parseOnlineNavigation, parseOnlinePage } from '../../src/shared/api/online-content.js';
import { parseProbeReference, parseProbeSummary } from '../../src/shared/api/media-probe.js';

test('online page boundary normalizes both supported pagination envelopes',()=>{
  const item={id:'v',bvid:'BV1',archiveState:'unarchived',coverUrl:'/api/cover?v=1',openUrl:'https://www.bilibili.com/video/BV1'};
  const nested=parseOnlinePage({page:{items:[item],total:0,hasMore:false,nextCursor:null}});
  const flat=parseOnlinePage({items:[item],total:0,hasMore:false});
  assert.deepEqual(nested,flat);
  assert.equal(nested.page.total,0);
  assert.throws(()=>parseOnlineItem({...item,openUrl:'javascript:alert(1)'}));
  assert.throws(()=>parseOnlineItem({...item,coverUrl:'//other.example/image'}));
  assert.throws(()=>parseOnlinePage({items:[item],hasMore:'false'}));
});

test('online navigation keeps display fields and rejects malformed sources',()=>{
  const parsed=parseOnlineNavigation({accounts:[{userId:'u',cookie:'fixture',sources:[{kind:'favorite',title:'folder',mediaId:1,count:0}]}]});
  assert.equal('cookie' in parsed.accounts[0],false);
  assert.equal(parsed.accounts[0].sources[0].count,0);
  assert.throws(()=>parseOnlineNavigation({accounts:[{userId:'u',sources:[{kind:'favorite',count:-1}]}]}));
});

test('probe boundaries distinguish a task reference from summary and preserve zero capacity',()=>{
  assert.equal(parseProbeReference({probeId:'probe'}),'probe');
  assert.equal(parseProbeSummary({status:'complete',cacheAvailableBytes:0}).cacheAvailableBytes,0);
  assert.equal(parseProbeSummary({status:'complete'}).cacheAvailableBytes,undefined);
  assert.throws(()=>parseProbeSummary({status:'complete',estimatedBytes:-1}));
  assert.throws(()=>parseProbeSummary({status:'complete',combinations:[{available:'false'}]}));
});
