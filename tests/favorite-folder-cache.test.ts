import assert from "node:assert/strict";
import test from "node:test";
import { FavoriteFolderListCache } from "../src/favorite-folder-cache.js";
import type { BiliUser } from "../src/users.js";

function user(): BiliUser {
  return {
    id: "folder-user",
    uid: 10001,
    name: "测试账号",
    cookie: { SESSDATA: "", bili_jct: "", DedeUserID: "10001" },
    favorites: [],
    enabled: true,
    lastLoginAt: "",
  };
}

function folder(mediaId: number, cover?: string) {
  return { mediaId, title: `收藏夹${mediaId}`, mediaCount: mediaId, cover };
}

test("收藏夹列表短缓存合并并发请求且不影响选中状态合并", async () => {
  let calls = 0;
  const cache = new FavoriteFolderListCache(async () => {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return [folder(1, "https://i0.hdslb.com/one.jpg")];
  });
  const account = user();
  const [first, second] = await Promise.all([cache.get(account), cache.get(account)]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal((await cache.get(account))[0].mediaId, 1);
  assert.equal(calls, 1);
});

test("更新后的收藏夹列表不会被迟到的旧请求覆盖", async () => {
  let release!: (value: ReturnType<typeof folder>[]) => void;
  const oldResult = new Promise<ReturnType<typeof folder>[]>((resolve) => { release = resolve; });
  let calls = 0;
  const cache = new FavoriteFolderListCache(async () => {
    calls += 1;
    return oldResult;
  });
  const account = user();
  const pending = cache.get(account);
  cache.set(account, [folder(2, "https://i0.hdslb.com/two.jpg")]);
  release([folder(1, "https://i0.hdslb.com/old.jpg")]);
  await pending;

  assert.equal(calls, 1);
  assert.equal((await cache.get(account))[0].mediaId, 2);
});
