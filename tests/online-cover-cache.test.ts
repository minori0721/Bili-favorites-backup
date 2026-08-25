import assert from "node:assert/strict";
import test from "node:test";
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
