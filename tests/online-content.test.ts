import { required } from './contract-values.js';
import assert from "node:assert/strict";
import test from "node:test";
import { OnlineContentService, type OnlineContentCoverPort } from "../src/online-content.js";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  normalizeOnlineContentPageSize,
  type OnlineContentPage,
} from "../src/bili.js";
import type { BiliUser } from "../src/users.js";

function coverPort(overrides: Partial<OnlineContentCoverPort> = {}): OnlineContentCoverPort {
  return { get: async () => null, getOrFetch: async () => null, promoteBvid: async () => null, ...overrides };
}

function user(): BiliUser {
  return {
    id: "online-user",
    uid: 456,
    name: "在线账号",
    cookie: { bili_jct: '', DedeUserID: "456", SESSDATA: "redacted" },
    favorites: [],
    enabled: true,
    lastLoginAt: new Date().toISOString(),
  };
}

test("online content clamps each Bilibili API to its real page-size limit", () => {
  assert.equal(normalizeOnlineContentPageSize("favorite", 50), 40);
  assert.equal(normalizeOnlineContentPageSize("collected", 50), 50);
  assert.equal(normalizeOnlineContentPageSize("bangumi", 50), 30);
  assert.equal(normalizeOnlineContentPageSize("drama", 50), 30);
  assert.equal(normalizeOnlineContentPageSize("watch_later", 50), 50);
  assert.equal(normalizeOnlineContentPageSize("history", 50), 30);
  assert.equal(normalizeOnlineContentPageSize("history", 50, true), 20);
  assert.equal(normalizeOnlineContentPageSize("favorite", 12), 12);
  assert.equal(normalizeOnlineContentPageSize("history", 0), 30);
});

test("history cursor uses an empty business value for the all-history feed", () => {
  assert.deepEqual(decodeHistoryCursor(undefined), { max: 0, view_at: 0, business: "" });
  const cursor = encodeHistoryCursor({ max: 123, view_at: 456, business: "live" });
  assert.deepEqual(decodeHistoryCursor(cursor), { max: 123, view_at: 456, business: "live" });
  const allCursor = encodeHistoryCursor({ max: 0, view_at: 0, business: "" });
  assert.equal(decodeHistoryCursor(allCursor).business, "");
});

test("online content keeps a short-lived BVID reference even when the cover is gone", async () => {
  const page: OnlineContentPage = {
    kind: "history" as const,
    page: 1,
    pageSize: 50,
    hasMore: false,
    items: [{
      id: "BV1NOIMAGE01",
      kind: "history" as const,
      bvid: "BV1NOIMAGE01",
      title: "封面已失效但仍可归档",
      upperName: "测试UP",
      playable: true,
    }],
  };
  const service = new OnlineContentService(coverPort(), {
    listPage: async () => page,
  });
  const result = await service.list(user(), { kind: "history" as const }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  const item = result.items[0];
  assert.ok(item.coverToken);
  assert.ok(item.coverUrl);
  const reference = service.getItem(item.coverToken!);
  assert.equal(reference?.userId, "online-user");
  assert.equal(reference?.item.bvid, "BV1NOIMAGE01");
  assert.equal(reference?.item.cover, undefined);
  assert.ok((reference?.expiresAt || 0) - Date.now() > 23 * 60 * 60 * 1000);
});

test("online favorite items always expose a canonical safe Bilibili URL", async () => {
  const service = new OnlineContentService(coverPort(), {
    listPage: async () => ({
      kind: "favorite" as const,
      page: 1,
      pageSize: 50,
      hasMore: false,
      items: [{ id: "BV1CANONICAL", kind: "favorite" as const, bvid: "BV1CANONICAL", title: "收藏", playable: true }],
    }),
  });
  const result = await service.list(user(), { kind: "favorite" as const, mediaId: 1 }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  assert.equal(result.items[0].openUrl, "https://www.bilibili.com/video/BV1CANONICAL");
});

test("失效视频没有新封面时仍优先提供本地在线缓存", async () => {
  const service = new OnlineContentService(coverPort({
    get: async (key: string) => key === "bvid:BV1STALECOVER" ? { path: "C:/isolated/online-cover.webp" } : null,
  }), {
    listPage: async () => ({
      kind: "history" as const,
      page: 1,
      pageSize: 50,
      hasMore: false,
      items: [{ id: "BV1STALECOVER", kind: "history" as const, bvid: "BV1STALECOVER", title: "失效视频", playable: true }],
    }),
  });
  const result = await service.list(user(), { kind: "history" as const }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  const item = result.items[0];
  assert.ok(item.coverUrl);
  assert.equal(await service.resolveCover(item.coverToken!), "C:/isolated/online-cover.webp");
});

test("在线内容页缓存和导航缓存保持有界", async () => {
  let pageCalls = 0;
  let navigationCalls = 0;
  const service = new OnlineContentService(coverPort(), {
    listFolders: async () => { navigationCalls += 1; return []; },
    listPage: async (_cookie, kind, options) => { pageCalls += 1; return ({
      kind,
      page: Number(required(options).page || 1),
      pageSize: 1,
      hasMore: false,
      items: [{
        id: `BV1CACHE${required(options).page}`,
        kind,
        bvid: `BV1CACHE${required(options).page}`,
        title: "缓存边界",
        playable: true,
      }],
    }); },
  });
  const states = () => new Map<string, "unarchived">();
  for (let page = 1; page <= 130; page += 1) {
    await service.list(user(), { kind: "history" as const, page, pageSize: 1 }, states);
  }
  const accounts = Array.from({ length: 130 }, (_, index) => ({ ...user(), id: `online-user-${index}` }));
  await service.getNavigation(accounts);
  assert.equal(pageCalls, 130);
  await service.list(user(), { kind: "history", page: 130, pageSize: 1 }, states);
  assert.equal(pageCalls, 130);
  await service.list(user(), { kind: "history", page: 1, pageSize: 1 }, states);
  assert.equal(pageCalls, 131);
  assert.equal(navigationCalls, 130);
  await service.getNavigation([accounts[129]]);
  assert.equal(navigationCalls, 130);
  await service.getNavigation([accounts[0]]);
  assert.equal(navigationCalls, 131);
});

test("在线导航保留收藏夹的服务端视频总数", async () => {
  const service = new OnlineContentService(coverPort(), {
    listFolders: async () => [{ mediaId: 9, title: "我的收藏", mediaCount: 42 }],
  });
  const navigation = await service.getNavigation([user()]);
  assert.deepEqual(navigation.accounts[0].sources[0], {
    kind: "favorite" as const,
    mediaId: 9,
    title: "我的收藏",
    count: 42,
    countLabel: "个视频",
  });
});

test("在线内容命中页面缓存时重新读取归档状态而不重新请求B站", async () => {
  let listCalls = 0;
  let stateCalls = 0;
  let currentState: "archived" | "unarchived" = "unarchived";
  const service = new OnlineContentService(coverPort(), {
    listPage: async () => {
      listCalls += 1;
      return {
        kind: "history" as const,
        page: 1,
        pageSize: 1,
        hasMore: false,
        items: [{ id: "BVFRESHSTATE", kind: "history" as const, bvid: "BVFRESHSTATE", title: "状态会变化", playable: true }],
      };
    },
  });
  const states = () => {
    stateCalls += 1;
    return new Map([["BVFRESHSTATE", currentState]]);
  };

  const first = await service.list(user(), { kind: "history" as const, page: 1, pageSize: 1 }, states);
  assert.equal(first.items[0].archiveState, "unarchived");
  currentState = "archived";
  const second = await service.list(user(), { kind: "history" as const, page: 1, pageSize: 1 }, states);
  assert.equal(second.items[0].archiveState, "archived");
  assert.equal(listCalls, 1);
  assert.equal(stateCalls, 2);
});
