import assert from "node:assert/strict";
import test from "node:test";
import { FavoriteFolderCoverService } from "../src/favorite-folder-cover.js";

function user(id: string, uid: number) {
  return {
    id,
    uid,
    name: "测试账号",
    cookie: { SESSDATA: "", bili_jct: "", DedeUserID: String(uid) },
    favorites: [],
    enabled: true,
    lastLoginAt: "",
  };
}

test("收藏夹封面命中在线缓存时不重复查询B站", async () => {
  const files = new Map<string, string>();
  let metadataCalls = 0;
  let fetchCalls = 0;
  const cache = {
    async get(key: string) {
      const path = files.get(key);
      return path ? { path, relativePath: path, bytes: 1 } : null;
    },
    async getOrFetch(key: string, url: string) {
      fetchCalls += 1;
      assert.match(url, /^https:\/\//);
      files.set(key, `/cache/${key}.webp`);
      return { path: files.get(key)!, relativePath: `online-covers/${key}.webp`, bytes: 1 };
    },
  } as any;
  const service = new FavoriteFolderCoverService(cache, async () => {
    metadataCalls += 1;
    return "https://i0.hdslb.com/bfs/archive/folder-cover.jpg";
  });

  const account = user("user-1", 10001);
  assert.equal(await service.resolve(account, 101), "/cache/favorite-folder:10001:101.webp");
  assert.equal(await service.resolve(account, 101), "/cache/favorite-folder:10001:101.webp");
  assert.equal(metadataCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("收藏夹列表提供的封面提示可以跳过详情元数据请求", async () => {
  let metadataCalls = 0;
  let fetchCalls = 0;
  const cache = {
    async get() { return null; },
    async getOrFetch(_key: string, url: string) {
      fetchCalls += 1;
      assert.match(url, /^https:\/\//);
      return { path: "/cache/folder-hint.webp", relativePath: "online-covers/folder-hint.webp", bytes: 1 };
    },
  } as any;
  const service = new FavoriteFolderCoverService(cache, async () => {
    metadataCalls += 1;
    return "https://i0.hdslb.com/bfs/archive/fallback.jpg";
  });
  const account = user("user-1", 10001);
  service.prime(account, 101, "https://i0.hdslb.com/bfs/archive/list-cover.jpg");

  assert.equal(await service.resolve(account, 101), "/cache/folder-hint.webp");
  assert.equal(metadataCalls, 0);
  assert.equal(fetchCalls, 1);
});

test("同一收藏夹并发首次加载只查询一次元数据", async () => {
  let release!: (value: string) => void;
  const metadata = new Promise<string>((resolve) => { release = resolve; });
  let metadataCalls = 0;
  const cache = {
    async get() { return null; },
    async getOrFetch() { return { path: "/cache/folder.webp", relativePath: "online-covers/folder.webp", bytes: 1 }; },
  } as any;
  const service = new FavoriteFolderCoverService(cache, async () => {
    metadataCalls += 1;
    return metadata;
  });
  const account = user("user-1", 10001);
  const first = service.resolve(account, 101);
  const second = service.resolve(account, 101);
  release("https://i0.hdslb.com/bfs/archive/folder-cover.jpg");
  await Promise.all([first, second]);
  assert.equal(metadataCalls, 1);
});

test("不同收藏夹的详情元数据请求按账号限制为两个并发", async () => {
  let active = 0;
  let maximum = 0;
  let metadataCalls = 0;
  const cache = {
    async get() { return null; },
    async getOrFetch(_key: string, _url: string) {
      return { path: "/cache/folder.webp", relativePath: "online-covers/folder.webp", bytes: 1 };
    },
  } as any;
  const service = new FavoriteFolderCoverService(cache, async (_cookie, mediaId) => {
    metadataCalls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return `https://i0.hdslb.com/bfs/archive/folder-${mediaId}.jpg`;
  });
  const account = user("user-1", 10001);

  await Promise.all([101, 102, 103, 104].map((mediaId) => service.resolve(account, mediaId)));
  assert.equal(metadataCalls, 4);
  assert.equal(maximum, 2);
});
