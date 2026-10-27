import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bilibiliVideoUrl, bilibiliProfileUrl} from '../../src/web/client/shared/bilibili-links.js';
import {parseArchiveLibraryItem} from '../../src/shared/api/archive-library.js';
import {parseOnlineItem} from '../../src/shared/api/online-content.js';
import {parseVideoDetailItem} from '../../src/shared/api/video-detail.js';
import {archiveIndexUpdateLabel} from '../../src/web/client/features/archive/navigation-meta.js';

test('B站视频链接保留 BV 大小写和 AV 整数精度，不把其他标识当作视频', () => {
  assert.equal(bilibiliVideoUrl('BV13tWqzAEFG'), 'https://www.bilibili.com/video/BV13tWqzAEFG/');
  assert.equal(bilibiliVideoUrl(' av170001 '), 'https://www.bilibili.com/video/av170001/');
  assert.equal(bilibiliVideoUrl('av9007199254740993'), 'https://www.bilibili.com/video/av9007199254740993/');
  for (const id of ['', '170001', 'ep170001', 'ss170001', 'av0', 'av-1', 'av1.5', 'BVfixture', 'BV13tWqzAEFG/', 'javascript:alert(1)', 'https://example.com']) {
    assert.equal(bilibiliVideoUrl(id), null, id);
  }
});

test('UP 主页只使用已有的合法 UID，缺失与历史 0 不生成链接', () => {
  assert.equal(bilibiliProfileUrl(163637592), 'https://space.bilibili.com/163637592');
  for (const uid of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(bilibiliProfileUrl(uid), null);
  const parsers = [
    (upperMid: unknown) => parseArchiveLibraryItem({bvid:'BVfixture',memberships:[],playback:{available:false,partCount:0,partial:false},upperMid}).upperMid,
    (upperMid: unknown) => parseOnlineItem({id:'fixture',archiveState:'unarchived',upperMid}).upperMid,
    (upperMid: unknown) => parseVideoDetailItem({bvid:'BVfixture',upperMid}).upperMid,
  ];
  for (const parse of parsers) {
    assert.equal(parse(163637592), 163637592);
    for (const value of [undefined, null, 0]) assert.equal(parse(value), undefined);
    for (const value of ['163637592', true, {}, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parse(value), /UID/);
  }
});

test('索引时间显示本地日期，跨年保留年份，非法时间不冒充已更新', () => {
  const now = new Date(2026, 9, 28, 12);
  assert.equal(archiveIndexUpdateLabel(new Date(2026, 9, 28, 4, 9).toISOString(), now), '更新于今天 04:09');
  assert.equal(archiveIndexUpdateLabel(new Date(2026, 9, 27, 4, 9).toISOString(), now), '更新于 10/27 04:09');
  assert.equal(archiveIndexUpdateLabel(new Date(2025, 9, 28, 4, 9).toISOString(), now), '更新于 2025/10/28 04:09');
  assert.equal(archiveIndexUpdateLabel('bad-date', now), null);
});
