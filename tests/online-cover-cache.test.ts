import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createTestDir, removeTestDir } from "./helpers.js";
import { OnlineCoverCache } from "../src/online-cover-cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function isolatedCache() {
  const cache = new OnlineCoverCache(64) as any;
  cache.initialized = true;
  cache.initialize = async () => undefined;
  cache.get = async () => null;
  return cache as OnlineCoverCache & Record<string, any>;
}

test("清理临时目录失败后仍释放所有封面并发名额", async () => {
  const root = await createTestDir("cover-cleanup-denied");
  const cache = isolatedCache();
  const mkdtemp = fs.promises.mkdtemp, rm = fs.promises.rm;
  fs.promises.mkdtemp = ((prefix: any, options: any) => mkdtemp(path.basename(String(prefix)).startsWith("online-cover-") ? path.join(root, "online-cover-") : prefix, options)) as typeof mkdtemp;
  fs.promises.rm = (async (target: any, options: any) => {
    if (String(target).startsWith(root)) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
    return rm(target, options);
  }) as typeof rm;
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, (_, i) => cache.getOrFetch(`failure-${i}`, "invalid-url"))), Array(8).fill(null));
    assert.equal(cache.runningFetches, 0);
    assert.equal(cache.fetchWaiters.length, 0);
    await cache.clear();
  } finally { fs.promises.mkdtemp = mkdtemp; fs.promises.rm = rm; await removeTestDir(root); }
});

test("封面删除失败时清空与淘汰保留占用，重试成功才清账", async () => {
  const cache = isolatedCache();
  const entry = { fileName: "fixture-denied.webp", bytes: 100, accessedAt: 1, lastAccessPersistAt: 1 };
  cache.entries.set("fixture", entry);
  cache.totalBytes = 100;
  cache.limitBytes = 1;
  const unlink = fs.promises.unlink;
  fs.promises.unlink = (async (file: any) => {
    if (path.basename(String(file)) === entry.fileName) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return unlink(file);
  }) as typeof unlink;
  try {
    await cache.evictIfNeeded();
    assert.equal((await cache.inspect()).bytes, 100);
    await assert.rejects(cache.clear(), /未能删除/);
    assert.equal((await cache.inspect()).files, 1);
    fs.promises.unlink = (async (file: any) => {
      if (path.basename(String(file)) === entry.fileName) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return unlink(file);
    }) as typeof unlink;
    await cache.clear();
    assert.equal((await cache.inspect()).bytes, 0);
  } finally { fs.promises.unlink = unlink; }
});

test("在线缩略图清理等待正在写入的文件且不会互相死锁", async () => {
  const cache = isolatedCache();
  const gate = deferred<string | null>();
  cache.fetchAndStore = async () => {
    const result = await gate.promise;
    // 清理期间跳过非必要的淘汰，不等待自己的 clear promise。
    await cache.evictIfNeeded();
    return result;
  };

  const fetchPromise = cache.getOrFetch("race-write", "https://example.invalid/cover.jpg");
  let clearFinished = false;
  const clearPromise = cache.clear().then(() => { clearFinished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clearFinished, false);

  gate.resolve(null);
  await Promise.all([fetchPromise, clearPromise]);
  assert.equal(clearFinished, true);
});

test("在线缩略图清理等待正在提升为归档封面的操作", async () => {
  const cache = isolatedCache();
  const gate = deferred<string | null>();
  cache.promoteBvidNow = async () => gate.promise;

  const promotion = cache.promoteBvid("BV1PROMOTION", "bvid:BV1PROMOTION");
  let clearFinished = false;
  const clearPromise = cache.clear().then(() => { clearFinished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clearFinished, false);

  gate.resolve("covers/BV1PROMOTION.webp");
  await Promise.all([promotion, clearPromise]);
  assert.equal(clearFinished, true);
});

test("在线缩略图并发槽位在等待任务之间交接后会完整释放", async () => {
  const cache = isolatedCache();
  let active = 0;
  let maximum = 0;
  const run = async () => {
    await cache.acquireFetchSlot();
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    cache.releaseFetchSlot();
  };

  await Promise.all(Array.from({ length: 12 }, run));
  assert.equal(maximum, 4);
  assert.equal(cache.runningFetches, 0);
  assert.equal(cache.fetchWaiters.length, 0);

  await Promise.all(Array.from({ length: 4 }, run));
  assert.equal(cache.runningFetches, 0);
  assert.equal(cache.fetchWaiters.length, 0);
});
