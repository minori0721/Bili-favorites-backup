import assert from 'node:assert/strict';
import test from 'node:test';
import { templateKeys, templatePreview } from '../../src/web/client/features/settings/template.js';
import { normalizeClientEncodingPriority } from '../../src/web/client/features/settings/encoding.js';
import { parseStorageCheck } from '../../src/web/client/features/settings/storage-check.js';
import { parseSettings } from '../../src/web/client/features/settings/contract.js';

test('template rules preserve custom separators, repeated tokens and configured order', () => {
  assert.deepEqual(templateKeys('<bvid>_<ownerName>_<bvid>'), ['<bvid>', '<ownerName>']);
  assert.equal(templatePreview('<bvid>_<videoTitle>_<bvid>'), 'BV1xxxxx_视频标题示例_BV1xxxxx.mp4');
  assert.equal(templatePreview(''), '视频标题示例-BV1xxxxx.mp4');
  assert.equal(templatePreview('custom.<unknown>'), 'custom.<unknown>.mp4');
});

test('encoding priority rejects partial or duplicate orders and retains legacy preference', () => {
  assert.deepEqual(normalizeClientEncodingPriority(['av1', 'hevc', 'avc']), ['AV1', 'HEVC', 'AVC']);
  assert.deepEqual(normalizeClientEncodingPriority(['AV1', 'AV1', 'AVC'], 'AVC'), ['AVC', 'HEVC', 'AV1']);
  assert.deepEqual(normalizeClientEncodingPriority(null), ['HEVC', 'AVC', 'AV1']);
});

test('storage check boundary requires typed status and user-facing messages', () => {
  assert.deepEqual(parseStorageCheck({ok:false,title:'path',message:'missing',field:'alistDest'}),
    {ok:false,title:'path',message:'missing',field:'alistDest'});
  for (const value of [null, {}, {ok:'false',title:'path',message:'missing'}, {ok:true,title:'ok',message:4}]) {
    assert.throws(() => parseStorageCheck(value));
  }
});

test('settings response rejects wrong field types before applying any form values', () => {
  assert.equal(parseSettings({concurrentDownloads:2,bbdownHiRes:false}).concurrentDownloads,2);
  for (const value of [{concurrentDownloads:'2'},{concurrentDownloads:Infinity},{alistUrl:{}},{bbdownHiRes:'false'}]) {
    assert.throws(() => parseSettings(value));
  }
  assert.equal(parseSettings({localCacheLimitGB:0}).localCacheLimitGB,0);
});
