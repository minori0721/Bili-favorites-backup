import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePlaybackMediaError,
  resolvePlaybackDeliveryViewStatus,
  type PlaybackMediaErrorInput,
} from "../src/playback-policy.js";

const defaults: PlaybackMediaErrorInput = {
  mediaErrorCode: 0,
  forceProxy: false,
  fallbackStarted: false,
  actualCodec: "",
  requestedCodec: "",
  browserSupportsHevc: false,
};

function decide(input: Partial<PlaybackMediaErrorInput>) {
  return decidePlaybackMediaError({ ...defaults, ...input });
}

test("playback media errors retry only transport failures and never loop proxy fallback", () => {
  assert.equal(decide({ mediaErrorCode: 1 }), "ignore");
  assert.equal(decide({ mediaErrorCode: 2, actualCodec: "AVC" }), "proxy");
  assert.equal(decide({ mediaErrorCode: 4, actualCodec: "AVC" }), "proxy");
  assert.equal(decide({ mediaErrorCode: 2, fallbackStarted: true }), "final");
  assert.equal(decide({ mediaErrorCode: 2, forceProxy: true }), "final");
  assert.equal(decide({ mediaErrorCode: 0, forceProxy: true }), "final");
});

test("playback media errors distinguish HEVC compatibility from generic decoding failures", () => {
  assert.equal(decide({ mediaErrorCode: 3, actualCodec: "HEVC", browserSupportsHevc: true }), "hevc");
  assert.equal(decide({ mediaErrorCode: 3, actualCodec: "HEVC Main", browserSupportsHevc: true }), "hevc");
  assert.equal(decide({ mediaErrorCode: 4, actualCodec: "H.265 Main 10", browserSupportsHevc: false }), "hevc");
  assert.equal(decide({ mediaErrorCode: 0, requestedCodec: "HEVC", browserSupportsHevc: false }), "hevc");
  assert.equal(decide({ mediaErrorCode: 3, requestedCodec: "HEVC" }), "hevc");
  assert.equal(decide({ mediaErrorCode: 4, requestedCodec: "HEVC", browserSupportsHevc: false }), "hevc");
  assert.equal(decide({ mediaErrorCode: 4, requestedCodec: "HEVC", browserSupportsHevc: true }), "proxy");
  assert.equal(decide({ mediaErrorCode: 3, actualCodec: "AVC", requestedCodec: "HEVC" }), "decode");
  assert.equal(decide({ mediaErrorCode: 3 }), "decode");
});

test("playback delivery display preserves confirmed transports and maps failures to unknown", () => {
  assert.equal(resolvePlaybackDeliveryViewStatus("pending", "pending", false), "pending");
  assert.equal(resolvePlaybackDeliveryViewStatus("pending", "failed", false), "unknown");
  assert.equal(resolvePlaybackDeliveryViewStatus("pending", "failed", true), "unknown");
  assert.equal(resolvePlaybackDeliveryViewStatus("direct", "pending", false), "direct");
  assert.equal(resolvePlaybackDeliveryViewStatus("direct", "failed", true), "direct");
  assert.equal(resolvePlaybackDeliveryViewStatus("direct", "proxy", true), "proxy");
  assert.equal(resolvePlaybackDeliveryViewStatus("proxy", "failed", true), "proxy");
});
