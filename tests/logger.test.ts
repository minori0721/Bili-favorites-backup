import assert from "node:assert/strict";
import test from "node:test";
import { createBBDownSelectionTracker, parseBBDownSelectedVideoLine } from "../src/logger.js";

test("BBDown selected streams keep the Bilibili tier and bind to the current page", () => {
  assert.deepEqual(
    parseBBDownSelectedVideoLine("[2026-07-28 12:00:00.000] - [视频] [1080P 60帧] [1080x1920] [HEVC]"),
    { bilibiliQuality: "1080P60", resolution: "1080x1920", codec: "HEVC" }
  );

  const tracker = createBBDownSelectionTracker();
  assert.equal(tracker.consume("[视频] [4K 超清] [1772x3840] [HEVC]"), null);
  assert.equal(tracker.consume("开始解析P2"), null);
  assert.deepEqual(tracker.consume("[视频] [4K 超清] [1772x3840] [HEVC]"), {
    pageIndex: 2,
    bilibiliQuality: "4K",
    resolution: "1772x3840",
    codec: "HEVC",
  });
  assert.equal(tracker.consume("开始解析P1..."), null);
  assert.deepEqual(tracker.consume("[视频] [1080P 高清] [1080x1920] [AVC]"), {
    pageIndex: 1,
    bilibiliQuality: "1080P",
    resolution: "1080x1920",
    codec: "AVC",
  });
});

test("single-page BBDown selection can use the explicit fallback page", () => {
  const tracker = createBBDownSelectionTracker(5);
  assert.equal(tracker.consume("普通输出"), null);
  assert.deepEqual(tracker.consume("[视频] [720P 高清] [720x1280] [AVC]"), {
    pageIndex: 5,
    bilibiliQuality: "720P",
    resolution: "720x1280",
    codec: "AVC",
  });
});
