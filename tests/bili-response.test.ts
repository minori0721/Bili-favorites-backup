import assert from "node:assert/strict";
import test from "node:test";
import {
  BiliFavoriteFolderResponseError,
  BiliResponseFormatError,
  decodeBiliEnvelope,
  decodeFavoriteItemsPage,
  decodeOnlineContentPage,
  normalizeFavoriteFolderListResponse,
} from "../src/bili.js";

test("收藏夹列表响应必须包含数组，否则返回可读的接口异常", () => {
  assert.deepEqual(normalizeFavoriteFolderListResponse({ list: [{ id: 1 }] }), [{ id: 1 }]);
  assert.throws(
    () => normalizeFavoriteFolderListResponse(null),
    (error) => error instanceof BiliFavoriteFolderResponseError
      && error.message.includes("收藏夹接口返回异常"),
  );
  assert.throws(() => normalizeFavoriteFolderListResponse({ list: null }), BiliFavoriteFolderResponseError);
});

test("B站响应信封必须明确提供状态码和数据字段", () => {
  assert.deepEqual(decodeBiliEnvelope({ data: { code: 0, data: { list: [] } } }), { list: [] });
  assert.throws(() => decodeBiliEnvelope({ data: { data: {} } }), /response\.code/);
  assert.throws(() => decodeBiliEnvelope({ data: { code: 0 } }), /response\.data/);
});

test("在线内容区分合法空页和损坏响应", () => {
  assert.deepEqual(decodeOnlineContentPage({ list: [], has_more: 0, total: 0 }, "history", 1, 20), {
    items: [], kind: "history", page: 1, pageSize: 20, nextCursor: undefined, hasMore: false, total: 0,
  });
  assert.throws(() => decodeOnlineContentPage({}, "history", 1, 20), BiliResponseFormatError);
  assert.throws(() => decodeOnlineContentPage({ list: [{}] }, "history", 1, 20), /history\.list\[0\]\.history\.oid/);
  assert.throws(() => decodeOnlineContentPage({ list: [], has_more: "0" }, "history", 1, 20), /history\.has_more/);
  assert.throws(() => decodeOnlineContentPage({ list: [{ oid: 1, title: "History", pic: {} }] }, "history", 1, 20), /history\.list\[0\]\.pic/);
});

for (const kind of ["collected", "bangumi", "drama", "watch_later", "history"] as const) {
  test(`${kind} 使用自己的明确列表字段`, () => {
    const page = decodeOnlineContentPage({ list: [], count: 0, total: 0 }, kind, 1, 20);
    assert.equal(page.items.length, 0);
    assert.equal(page.total, 0);
    assert.throws(() => decodeOnlineContentPage({ items: [] }, kind, 1, 20), new RegExp(`${kind}\\.list`));
  });
}

test("在线历史保留没有 BVID 的合法条目", () => {
  const page = decodeOnlineContentPage({
    list: [{ oid: 42, business: "live", title: "直播回放", uri: "https://www.bilibili.com/video/av42" }],
    has_more: false,
  }, "history", 1, 20);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].bvid, undefined);
  assert.equal(page.items[0].playable, false);
  assert.equal(page.items[0].title, "直播回放");
});

test("收藏内容坏条目和坏分页不能变成空页", () => {
  assert.deepEqual(decodeFavoriteItemsPage({ medias: [], info: { media_count: 0 }, has_more: false }, 1, 20), {
    items: [], page: 1, pageSize: 20, hasMore: false, total: 0,
  });
  assert.throws(() => decodeFavoriteItemsPage({ medias: null }, 1, 20), /favorite\.medias/);
  assert.throws(() => decodeFavoriteItemsPage({ medias: [{ title: "缺少身份" }] }, 1, 20), /favorite\.medias\[0\]\.bvid/);
  assert.throws(() => decodeFavoriteItemsPage({ medias: [], has_more: "false" }, 1, 20), /favorite\.has_more/);
});


test('endpoint identity rules reject fabricated watch-later entries and preserve non-video history', () => {
  assert.throws(() => decodeOnlineContentPage({list: [{id: 1, title: 'bad'}], count: 1}, 'watch_later', 1, 20), /aid/);
  assert.throws(() => decodeOnlineContentPage({list: [{id: 1, title: 'bad'}], count: 1}, 'bangumi', 1, 20), /season_id/);
  const history = decodeOnlineContentPage({list: [{title: 'Article', history: {oid: 42, business: 'article', bvid: ''}}], has_more: false}, 'history', 1, 20);
  assert.equal(history.items[0].playable, false);
  assert.equal(history.items[0].rawType, 'article');
  assert.throws(() => decodeOnlineContentPage({list: [], cursor: {}}, 'history', 1, 20), /cursor.max/);
  assert.throws(() => decodeFavoriteItemsPage({medias: []}, 1, 20), /pagination/);
});


test('collected null empty list is supported only with an explicit zero count', () => {
  assert.equal(decodeOnlineContentPage({list: null, count: 0}, 'collected', 1, 20).hasMore, false);
  assert.throws(() => decodeOnlineContentPage({list: null, count: 1}, 'collected', 1, 20), /collected.list/);
  assert.throws(() => decodeOnlineContentPage({list: []}, 'watch_later', 1, 20), /pagination/);
});


test('history search count and cursor fields reject malformed pagination', () => {
  assert.equal(decodeOnlineContentPage({list: [], page: {count: 0}}, 'history', 1, 20).hasMore, false);
  assert.throws(() => decodeOnlineContentPage({list: [], page: {count: '0'}}, 'history', 1, 20), /page.count/);
  assert.throws(() => decodeOnlineContentPage({list: [], cursor: null}, 'history', 1, 20), /cursor/);
  assert.throws(() => decodeOnlineContentPage({list: [], has_more: null}, 'history', 1, 20), /has_more/);
});


test('followed seasons preserve a supplied episode destination', () => {
  const result = decodeOnlineContentPage({list: [{season_id: 42, ep_id: 17, title: 'Episode'}], total: 1}, 'bangumi', 1, 20);
  assert.equal(result.items[0].openUrl, 'https://www.bilibili.com/bangumi/play/ep17');
  assert.throws(() => decodeOnlineContentPage({list: [{season_id: 42, ep_id: 'bad', title: 'Episode'}], total: 1}, 'bangumi', 1, 20), /ep_id/);
});

test('online decoders validate consumed nested objects without rejecting unrelated metadata', () => {
  const page = decodeOnlineContentPage({
    list: [{aid: 7, title: 'Later', archive: 'unused upstream metadata'}],
    count: 1,
  }, 'watch_later', 1, 20);
  assert.equal(page.items[0].id, 'watch_later-7');
  assert.throws(() => decodeOnlineContentPage({
    list: [{aid: 7, title: 'Later', owner: 'invalid consumed metadata'}],
    count: 1,
  }, 'watch_later', 1, 20), /owner/);
});
