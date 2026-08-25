import assert from "node:assert/strict";
import test from "node:test";
import { createBBDownSelectionTracker, parseBBDownSelectedVideoLine } from "../src/logger.js";

test("BBDown selected streams keep the Bilibili tier and bind to the current page", () => {
  assert.deepEqual(
    parseBBDownSelectedVideoLine("[2026-07-28 08:15:44.814] - [视频] [4K 超清] [HEVC] [3321 kbps] [~8.92 MB]"),
    { bilibiliQuality: "4K", codec: "HEVC", bitrate: "3321 kbps", estimatedSize: "~8.92 MB" }
  );

  const tracker = createBBDownSelectionTracker();
  assert.equal(tracker.consume("[视频] [4K 超清] [HEVC] [3321 kbps] [~8.92 MB]"), null);
  assert.equal(tracker.consume("开始解析P2"), null);
  assert.deepEqual(tracker.consume("[视频] [4K 超清] [HEVC] [3321 kbps] [~8.92 MB]"), {
    pageIndex: 2,
    bilibiliQuality: "4K",
  });
  assert.equal(tracker.consume("开始解析P1..."), null);
  assert.deepEqual(tracker.consume("[视频] [1080P 高清] [1080x1920] [AVC]"), {
    pageIndex: 1,
    bilibiliQuality: "1080P",
  });

  const diagnosticTracker = createBBDownSelectionTracker(1);
  const observation = diagnosticTracker.consumeWithDiagnostics("[视频] [4K 超清] [HEVC] [3321 kbps]");
  assert.deepEqual(observation?.selection, { pageIndex: 1, bilibiliQuality: "4K" });
  assert.equal(observation?.diagnostics.codec, "HEVC");
});

test("single-page BBDown selection can use the explicit fallback page", () => {
  const tracker = createBBDownSelectionTracker(5);
  assert.equal(tracker.consume("普通输出"), null);
  assert.deepEqual(tracker.consume("[视频] [720P 高清] [AVC] [225 kbps] [~618.75 KB]"), {
    pageIndex: 5,
    bilibiliQuality: "720P",
  });
});

test("legacy BBDown stream lines still identify optional resolution and codec fields", () => {
  assert.deepEqual(parseBBDownSelectedVideoLine("[视频] [1080P 60帧] [1080x1920] [HEVC]"), {
    bilibiliQuality: "1080P60",
    legacyResolution: "1080x1920",
    codec: "HEVC",
  });
});

test("BBDown stream parsing requires the video marker at the start of the output body", () => {
  const invalidLines = [
    "视频标题: [视频] [4K 超清] [HEVC] [3321 kbps]",
    "[错误] 无法解析 [视频] [4K 超清] [HEVC]",
    "[INFO] [视频] [4K 超清] [HEVC]",
    "普通输出包含 [视频] [4K 超清] [HEVC]",
    "[视频]",
    "[视频] [] [HEVC]",
    "[视频] 普通文字",
  ];
  for (const line of invalidLines) {
    assert.equal(parseBBDownSelectedVideoLine(line), null, line);
  }

  assert.deepEqual(parseBBDownSelectedVideoLine("  [视频][4K 超清][HEVC][3321 kbps]  "), {
    bilibiliQuality: "4K",
    codec: "HEVC",
    bitrate: "3321 kbps",
  });
});

test("BBDown selection tracking ignores misleading video markers in titles and errors", () => {
  const tracker = createBBDownSelectionTracker();
  assert.equal(tracker.consume("开始解析P3"), null);
  assert.equal(tracker.consume("视频标题: [视频] [720P 高清] [AVC]"), null);
  assert.equal(tracker.consume("[错误] 无法解析 [视频] [1080P 高清] [HEVC]"), null);
  assert.deepEqual(tracker.consume("  [2026-07-28 08:15:44.814] -   [视频] [4K 超清] [HEVC]"), {
    pageIndex: 3,
    bilibiliQuality: "4K",
  });
});
