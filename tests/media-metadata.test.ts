import assert from "node:assert/strict";
import test from "node:test";
import { actualQualityLabel, normalizeBilibiliQualityLabel } from "../src/media-metadata.js";

test("actual quality labels preserve non-standard short edges and orientation-independent values", () => {
  const cases = [
    [{ width: 3840, height: 2160 }, "2160p"],
    [{ width: 2160, height: 3840 }, "2160p"],
    [{ width: 1772, height: 3840 }, "1772p"],
    [{ width: 2016, height: 3586 }, "2016p"],
    [{ width: 1440, height: 2560 }, "1440p"],
    [{ width: 1772, height: 3840, fps: 50 }, "1772p60"],
    [{ width: 3840, height: 2160, fps: 60 }, "2160p60"],
    [{ width: 1080, height: 1920, fps: 59.94 }, "1080p60"],
    [{ width: 1920, height: 1080, fps: 49.99 }, "1080p"],
    [{ width: 852, height: 480 }, "480p"],
  ] as const;
  for (const [metadata, expected] of cases) {
    assert.equal(actualQualityLabel(metadata), expected);
  }
  assert.equal(actualQualityLabel(undefined), undefined);
  assert.equal(actualQualityLabel({ width: 0, height: 1080 }), undefined);
  assert.equal(actualQualityLabel({ width: Number.NaN, height: 1080 }), undefined);
});

test("Bilibili quality labels use concise platform tiers without inferring from dimensions", () => {
  assert.equal(normalizeBilibiliQualityLabel("4K 超清"), "4K");
  assert.equal(normalizeBilibiliQualityLabel("1080P 60帧"), "1080P60");
  assert.equal(normalizeBilibiliQualityLabel("1080P 高码率"), "1080P+");
  assert.equal(normalizeBilibiliQualityLabel("720P 高帧率"), "720P60");
  assert.equal(normalizeBilibiliQualityLabel("杜比视界"), "杜比视界");
  assert.equal(normalizeBilibiliQualityLabel("HDR 真彩"), "HDR");
  assert.equal(normalizeBilibiliQualityLabel(""), undefined);
});
