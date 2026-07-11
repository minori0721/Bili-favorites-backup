import assert from "node:assert/strict";
import test from "node:test";
import { DownloadApiHealth } from "../src/download-api-health.js";
import { computeDownloadStartDelayMs } from "../src/scheduler.js";

test("web voucher pauses for 180 seconds and allows one APP probe", () => {
  let now = 1_000;
  const health = new DownloadApiHealth(() => now);
  health.configure("web");
  const persisted = health.open({ bvid: "BV1RISK", userId: "u1", hasAppToken: true });
  assert.equal(persisted?.until, 181_000);
  assert.equal(health.getSnapshot().activeMode, "app");
  assert.equal(health.claimStart({ bvid: "BV1RISK", userId: "u1", hasAppToken: true }).allowed, false);
  now = 181_000;
  assert.deepEqual(health.claimStart({ bvid: "BVOTHER", userId: "u1", hasAppToken: true }), { allowed: false, probe: false });
  assert.deepEqual(health.claimStart({ bvid: "BV1RISK", userId: "u1", hasAppToken: true }), {
    allowed: true,
    probe: true,
    apiModeOverride: "app",
  });
  assert.equal(health.claimStart({ bvid: "BV1RISK", userId: "u1", hasAppToken: true }).allowed, false);
  assert.equal(health.ready({ bvid: "BV1RISK", userId: "u1" }), true);
  assert.equal(health.getSnapshot().state, "healthy");
});

test("an orphaned probe can be abandoned without leaving downloads blocked", () => {
  const health = new DownloadApiHealth(() => 1_000);
  health.configure("web");
  health.open({ bvid: "BV1GONE", userId: "u4", hasAppToken: true });
  assert.deepEqual(health.getProbeIdentity(), { bvid: "BV1GONE", userId: "u4" });
  assert.equal(health.abandonProbe(), true);
  assert.equal(health.getSnapshot().state, "healthy");
});

test("web probe is used without a token and failed probes restart a fixed cooldown", () => {
  let now = 10_000;
  const health = new DownloadApiHealth(() => now);
  health.configure("web");
  health.open({ bvid: "BV1WEB", userId: "u2", hasAppToken: false });
  now += 180_000;
  assert.equal(health.claimStart({ bvid: "BV1WEB", userId: "u2", hasAppToken: false }).apiModeOverride, "web");
  const persisted = health.probeFailed({ bvid: "BV1WEB", userId: "u2" }, "still blocked");
  assert.equal(persisted?.until, now + 180_000);
  assert.equal(health.getSnapshot().state, "cooldown");
});

test("APP configuration ignores the Web circuit and persisted cooldown restores after restart", () => {
  let now = 5_000;
  const first = new DownloadApiHealth(() => now);
  first.configure("web");
  const persisted = first.open({ bvid: "BV1RESTORE", userId: "u3", hasAppToken: true });
  const restored = new DownloadApiHealth(() => now);
  restored.configure("web");
  restored.restore(persisted);
  assert.equal(restored.getSnapshot().state, "cooldown");
  restored.configure("app");
  assert.equal(restored.getSnapshot().state, "healthy");
  assert.equal(restored.claimStart({ bvid: "ANY", userId: "u3", hasAppToken: true }).allowed, true);
});

test("BBDown launches are spaced between three and six seconds", () => {
  assert.equal(computeDownloadStartDelayMs(() => 0), 3_000);
  assert.equal(computeDownloadStartDelayMs(() => 0.5), 4_500);
  assert.equal(computeDownloadStartDelayMs(() => 1), 6_000);
});
