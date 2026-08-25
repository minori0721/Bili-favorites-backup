import assert from "node:assert/strict";
import test from "node:test";
import { OnlineContentService } from "../src/online-content.js";
import type { OnlineContentPage } from "../src/bili.js";
import type { BiliUser } from "../src/users.js";

function user(): BiliUser {
  return {
    id: "online-user",
    uid: 456,
    name: "在线账号",
    cookie: { DedeUserID: "456", SESSDATA: "redacted" },
    favorites: [],
    enabled: true,
    lastLoginAt: new Date().toISOString(),
  };
}

test("online content keeps a short-lived BVID reference even when the cover is gone", async () => {
  const page: OnlineContentPage = {
    kind: "history",
    page: 1,
    pageSize: 50,
    hasMore: false,
    items: [{
      id: "BV1NOIMAGE01",
      kind: "history",
      bvid: "BV1NOIMAGE01",
      title: "封面已失效但仍可归档",
      upperName: "测试UP",
      playable: true,
    }],
  };
  const service = new OnlineContentService({} as any, {
    listPage: async () => page,
  });
  const result = await service.list(user(), { kind: "history" }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  const item = result.items[0];
  assert.ok(item.coverToken);
  assert.ok(item.coverUrl);
  const reference = service.getItem(item.coverToken!);
  assert.equal(reference?.userId, "online-user");
  assert.equal(reference?.item.bvid, "BV1NOIMAGE01");
  assert.equal(reference?.item.cover, undefined);
});

test("online favorite items always expose a canonical safe Bilibili URL", async () => {
  const service = new OnlineContentService({} as any, {
    listPage: async () => ({
      kind: "favorite",
      page: 1,
      pageSize: 50,
      hasMore: false,
      items: [{ id: "BV1CANONICAL", kind: "favorite", bvid: "BV1CANONICAL", title: "收藏", playable: true }],
    }),
  });
  const result = await service.list(user(), { kind: "favorite", mediaId: 1 }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  assert.equal(result.items[0].openUrl, "https://www.bilibili.com/video/BV1CANONICAL");
});

test("失效视频没有新封面时仍优先提供本地在线缓存", async () => {
  const service = new OnlineContentService({
    get: async (key: string) => key === "bvid:BV1STALECOVER" ? { path: "C:/isolated/online-cover.webp" } : null,
  } as any, {
    listPage: async () => ({
      kind: "history",
      page: 1,
      pageSize: 50,
      hasMore: false,
      items: [{ id: "BV1STALECOVER", kind: "history", bvid: "BV1STALECOVER", title: "失效视频", playable: true }],
    }),
  });
  const result = await service.list(user(), { kind: "history" }, (items) => new Map(items.filter((item) => item.bvid).map((item) => [item.bvid!, "unarchived"])));
  const item = result.items[0];
  assert.ok(item.coverUrl);
  assert.equal(await service.resolveCover(item.coverToken!), "C:/isolated/online-cover.webp");
});

test("在线内容页缓存和导航缓存保持有界", async () => {
  const service = new OnlineContentService({} as any, {
    listFolders: async () => [],
    listPage: async (_cookie, kind, options) => ({
      kind,
      page: Number(options.page || 1),
      pageSize: 1,
      hasMore: false,
      items: [{
        id: `BV1CACHE${options.page}`,
        kind,
        bvid: `BV1CACHE${options.page}`,
        title: "缓存边界",
        playable: true,
      }],
    }),
  });
  const states = () => new Map<string, "unarchived">();
  for (let page = 1; page <= 130; page += 1) {
    await service.list(user(), { kind: "history", page, pageSize: 1 }, states);
  }
  const accounts = Array.from({ length: 130 }, (_, index) => ({ ...user(), id: `online-user-${index}` }));
  await service.getNavigation(accounts);
  assert.equal((service as any).pages.size, 128);
  assert.equal((service as any).navigation.size, 128);
  assert.ok((service as any).coverRefs.size <= 128 * 50);
});
