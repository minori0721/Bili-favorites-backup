import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundPreviewCache } from "../src/preview-cache.js";
import { buildIndexedRemoteFiles, buildRenamePreview, mergeRenamePreviews } from "../src/rename-preview.js";
import { SkippedPreviewCollector } from "../src/preview-summary.js";
import { listRemoteFilesRecursive } from "../src/uploader.js";
import type { RemoteFilePreviewVideoRecord } from "../src/state.js";
import { testConfig } from "./helpers.js";

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("skipped preview summaries keep totals while limiting rendered samples", () => {
  const collector = new SkippedPreviewCollector<{ path: string; reason: string }>(2);
  collector.add({ path: "/one", reason: "目录读取失败：temporary" });
  collector.add({ path: "/two", reason: "目录读取失败：timeout" });
  collector.add({ path: "/three", reason: "不是支持的视频文件" });

  const summary = collector.snapshot();
  assert.equal(summary.skipped.length, 2);
  assert.equal(summary.skippedTotal, 3);
  assert.deepEqual(summary.skippedByReason, {
    "目录读取失败": 2,
    "不是支持的视频文件": 1,
  });
});

test("background preview cache deduplicates, reuses, expires, and contains failures", async () => {
  let now = 0;
  let calls = 0;
  let release!: (value: number) => void;
  const gate = new Promise<number>((resolve) => { release = resolve; });
  const cache = new BackgroundPreviewCache<number>({
    now: () => now,
    ttlMs: 1_000,
    failedTtlMs: 500,
    maxEntries: 2,
  });

  const first = cache.start("same", async () => {
    calls += 1;
    return gate;
  });
  const duplicate = cache.start("same", async () => {
    calls += 1;
    return 99;
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(cache.activeCount, 1);
  release(7);
  assert.equal(await cache.waitForIdle(100), true);
  assert.equal(calls, 1);
  assert.equal(cache.get(first.id)?.result, 7);

  const reused = cache.start("same", async () => {
    calls += 1;
    return 8;
  });
  assert.equal(reused.id, first.id);
  assert.equal(calls, 1);

  now = 1_001;
  const refreshed = cache.start("same", async () => {
    calls += 1;
    return 8;
  });
  assert.notEqual(refreshed.id, first.id);
  assert.equal(await cache.waitForIdle(100), true);
  assert.equal(calls, 2);

  const failure = cache.start("failure", async () => {
    throw new Error("remote response\ncontains details");
  });
  assert.equal(await cache.waitForIdle(100), true);
  const failed = cache.get(failure.id);
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error || "", /^remote response contains details$/);
  now = 2_002;
  assert.equal(cache.get(failure.id)?.status, "expired");
});

test("recursive remote preview bounds directory-list concurrency and summarizes skips", async () => {
  const entries: Record<string, any[]> = {
    "/target": [
      { filename: "/target/a", basename: "a", type: "directory" },
      { filename: "/target/b", basename: "b", type: "directory" },
      { filename: "/target/readme.txt", basename: "readme.txt", type: "file", size: 1 },
    ],
    "/target/a": [{ filename: "/target/a/a.mp4", basename: "a.mp4", type: "file", size: 10 }],
    "/target/b": [{ filename: "/target/b/b.mp4", basename: "b.mp4", type: "file", size: 20 }],
  };
  let active = 0;
  let maximum = 0;
  const result = await listRemoteFilesRecursive(
    testConfig(),
    "/target",
    { maxDepth: 1, maxFiles: 10, concurrency: 2, skippedLimit: 1 },
    {
      getDirectoryContents: async (directory) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(5);
        active -= 1;
        return entries[directory] || [];
      },
    } as any,
  );

  assert.equal(result.complete, true);
  assert.equal(maximum, 2);
  assert.deepEqual(result.files.map((file) => file.name), ["a.mp4", "b.mp4"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skippedTotal, 1);
  assert.deepEqual(result.skippedByReason, { "不是支持的视频文件": 1 });
});

test("local rename index deduplicates proofs and excludes unverified files", () => {
  const record: RemoteFilePreviewVideoRecord = {
    bvid: "BVINDEX",
    title: "Demo",
    upperName: "Tester",
    remotePath: "/backup",
    remoteFiles: [
      { name: "old-BVINDEX.mp4", path: "/backup/old-BVINDEX.mp4", size: 42, verificationStatus: "verified" },
      { name: "pending-BVINDEX.mp4", path: "/backup/pending-BVINDEX.mp4", size: 99, verificationStatus: "awaiting_verification" },
    ],
    relations: [{
      userId: "u1",
      mediaId: 1,
      folderTitle: "Favorites",
      backupStatus: "verified",
      hasInterruptedQualityUpgrade: false,
      remoteFiles: [{ name: "old-BVINDEX.mp4", path: "/backup/old-BVINDEX.mp4", size: 42, verificationStatus: "verified" }],
    }],
  };
  const indexed = buildIndexedRemoteFiles([record], "/backup");
  assert.deepEqual(indexed.map((file) => file.strictPath), ["/backup/old-BVINDEX.mp4"]);

  const preview = buildRenamePreview({
    config: testConfig({ filenameTemplate: "<videoTitle>-<bvid>" }),
    root: "/backup",
    records: [record],
    scanned: { files: indexed, skipped: [], complete: true },
    scanLimit: 100,
  });
  assert.equal(preview.complete, true);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].oldPath, "/backup/old-BVINDEX.mp4");
  assert.equal(preview.candidates[0].newPath, "/backup/Demo-BVINDEX.mp4");
});

test("merged rename preview does not count the same skipped files twice", () => {
  const candidate = {
    bvid: "BVMERGED",
    title: "Demo",
    ownerName: "Tester",
    remoteDir: "/backup",
    oldName: "old-BVMERGED.mp4",
    newName: "Demo-BVMERGED.mp4",
    oldPath: "/backup/old-BVMERGED.mp4",
    newPath: "/backup/Demo-BVMERGED.mp4",
    reason: "同目录内按当前命名模板重命名",
  };
  const skipped = { path: "/backup/readme.txt", reason: "不是支持的视频文件" };
  const local = {
    candidates: [candidate],
    skipped: [skipped],
    skippedTotal: 1,
    skippedByReason: { "不是支持的视频文件": 1 },
    complete: true,
    scannedFiles: 1,
    scanLimit: 100,
    indexedFiles: 1,
    coverage: "local" as const,
  };
  const remote = {
    candidates: [],
    skipped: [skipped],
    skippedTotal: 1,
    skippedByReason: { "不是支持的视频文件": 1 },
    complete: true,
    scannedFiles: 2,
    scanLimit: 100,
    coverage: "remote" as const,
  };

  const merged = mergeRenamePreviews(local, remote, 10);
  assert.equal(merged.skippedTotal, 1);
  assert.deepEqual(merged.skippedByReason, { "不是支持的视频文件": 1 });
  assert.deepEqual(merged.skipped, [skipped]);
  assert.deepEqual(merged.candidates, [candidate]);
  assert.equal(merged.coverage, "merged");
});
