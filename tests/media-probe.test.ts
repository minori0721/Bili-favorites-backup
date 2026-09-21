import { required, readField } from './contract-values.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MediaProbeService } from "../src/media-probe.js";
import { parseBBDownSignal } from "../src/downloader.js";
import { buildBBDownProbeArgs, buildBBDownTrackSelectionArgs, parseBBDownProbeOutput, probeMediaWithBBDown, interactivePageSetHash, validateInteractiveInventory, validateInteractiveProbeCoverage, classifyBBDownFailure, type BBDownProbePage } from "../src/downloader.js";
import type { BiliUser } from "../src/users.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("BBDown signals accept legacy framing but reject title and JSON markers", () => {
  for (const prefix of ["", "[2026-07-11 00:00:00.000] - "]) {
    assert.equal(parseBBDownSignal(prefix + "BFB_SIGNAL:PLAYURL_READY:WEB"), "PLAYURL_READY:WEB");
    assert.equal(parseBBDownSignal(prefix + "BFB_SIGNAL:RISK_V_VOUCHER"), "RISK_V_VOUCHER");
    assert.equal(parseBBDownSignal(prefix + "BFB_SIGNAL:APP_NO_VIDEO_INFO: APP play response had no video info"), "APP_NO_VIDEO_INFO");
    assert.equal(parseBBDownSignal(prefix + "标题 BFB_SIGNAL:RISK_V_VOUCHER"), undefined);
  }
  assert.equal(parseBBDownSignal('{"title":"BFB_SIGNAL:INTERACTIVE_INCOMPLETE"}'), undefined);
  assert.equal(parseBBDownSignal("BFB_SIGNAL:RISK_V_VOUCHER suffix"), undefined);
});

function user(): BiliUser {
  return {
    id: "probe-user",
    uid: 123,
    name: "探测账号",
    cookie: { bili_jct: '', DedeUserID: "123", SESSDATA: "redacted" },
    favorites: [],
    enabled: true,
    lastLoginAt: new Date().toISOString(),
  };
}

test("interactive inventory requires a complete ordered CID set and a completion marker", () => {
  const inventory = pages();
  const marker = `BFB_PAGES_COMPLETE:${interactivePageSetHash(inventory)}`;
  validateInteractiveInventory(marker, inventory);
  for (const [output, records] of [
    ["", inventory], [marker, inventory.slice(0, 1)], [marker, [...inventory].reverse()],
    [marker + "\n" + marker, inventory], [marker, []],
    [marker, [{ ...inventory[0], cid: "9007199254740992" }]],
  ] as Array<[string, BBDownProbePage[]]>) {
    assert.throws(() => validateInteractiveInventory(output, records), /片段清单不完整/);
  }
});

test("interactive API failure cannot be classified as a deleted video by generic log text", () => {
  const failure = classifyBBDownFailure("剧情图已失效\nBFB_SIGNAL:INTERACTIVE_INCOMPLETE");
  assert.equal(failure?.category, "tool");
  assert.match(failure?.line || "", /互动剧情/);
});

test("interactive media estimates reject skipped branches, ordinary probes stay compatible", () => {
  const records = pages();
  const expected = `BFB_INTERACTIVE_EXPECTED:${interactivePageSetHash(records)}`;
  validateInteractiveProbeCoverage(expected, records);
  assert.throws(() => validateInteractiveProbeCoverage(expected, records.slice(0, 1)), /不完整/);
  assert.throws(() => validateInteractiveProbeCoverage(expected + "\n" + expected, records), /多份/);
  validateInteractiveProbeCoverage("", records);
});

function pages(): BBDownProbePage[] {
  return [
    {
      version: 1,
      bvid: "BV1Probe00001",
      cid: "101",
      pageIndex: 1,
      pageTitle: "第一P",
      durationSeconds: 100,
      tracks: [
        { bilibiliQuality: "4K 超清", codec: "av01", resolution: "3840x2160", frameRate: "60", estimatedBytes: 1000, sizeSource: "api" },
        { bilibiliQuality: "4K 超清", codec: "AVC", resolution: "3840x2160", frameRate: "60", estimatedBytes: 900, sizeSource: "api" },
      ],
    },
    {
      version: 1,
      bvid: "BV1Probe00001",
      cid: "102",
      pageIndex: 2,
      pageTitle: "第二P",
      durationSeconds: 200,
      tracks: [
        { bilibiliQuality: "4K 超清", codec: "AV1", resolution: "3840x2160", frameRate: "60", estimatedBytes: 2000, sizeSource: "bitrate_estimate" },
      ],
    },
  ];
}

test("unknown and legacy availability never claim that a video is invisible", async () => {
  for (const availability of [
    { available: false, availability: "unknown" as const, availabilityReason: "temporary_error" as const, pages: [] },
    { available: false, pages: [] },
  ]) {
    let calls = 0;
    const service = new MediaProbeService({ get: () => testConfig() }, async (bvid) => {
      calls++; return { bvid, pages: pages(), source: "bbdown" as const };
    }, undefined, async () => availability);
    const result = await waitFor(service.start(user(), "BV1Probe00001"));
    assert.equal(result.status, "failed");
    assert.match(result.error || "", /暂时无法确认B站源状态/);
    assert.doesNotMatch(result.error || "", /稿件不可见/);
    assert.equal(calls, 0);
  }
});

test("interactive signals must occupy a complete protocol line, not a title or JSON value", () => {
  for (const text of [
    "[date] - 视频标题: BFB_SIGNAL:INTERACTIVE_AUTH 教程",
    'BFB_PROBE_JSON:{"title":"BFB_SIGNAL:INTERACTIVE_AUTH"}',
    "prefix BFB_SIGNAL:INTERACTIVE_AUTH", "BFB_SIGNAL:INTERACTIVE_AUTH suffix",
  ]) assert.equal(classifyBBDownFailure(text), null);
  assert.equal(classifyBBDownFailure("标题\r\nBFB_SIGNAL:INTERACTIVE_AUTH\r\n")?.category, "tool");
});

test("real probe stdout preserves UTF8 split inside Chinese and four-byte characters", async () => {
  const runtime = await createTestDir("probe-utf8");
  const record = { ...pages()[0], pageTitle: "中文标题😀" };
  const output = `BFB_PROBE_JSON:${JSON.stringify(record)}\n`;
  const script = `const b=Buffer.from(${JSON.stringify(output)}); let i=0;
    const timer=setInterval(()=>{if(i===b.length){clearInterval(timer);return;}process.stdout.write(b.subarray(i,i+1));i++;},1);`;
  try {
    const result = await probeMediaWithBBDown(record.bvid, user().cookie, testConfig(), {
      command: process.execPath, commandArgsPrefix: ["-e", script, "--"], workingRoot: runtime,
    });
    assert.deepEqual(result.pages, [record]);
    assert.deepEqual(await fs.promises.readdir(runtime), []);
  } finally { await removeTestDir(runtime); }
});

async function waitFor<T extends { status: string }>(value: T) {
  const deadline = Date.now() + 2_000;
  while (value.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return value;
}

test("strict media probe marks unavailable codec/quality combinations without fallback", async () => {
  let forwardedTarget: unknown;
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid, cookie, _config, target) => {
      assert.equal(bvid, "BV1Probe00001");
      assert.equal(cookie.DedeUserID, "123");
      forwardedTarget = target;
      return { bvid, pages: pages(), source: "bbdown" as const };
    },
  );

  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: true }));
  assert.equal(result.status, "complete");
  assert.deepEqual(result.target, { quality: "4K", encoding: "AV1", strict: true });
  assert.equal(required(required(result.pages?.[0].tracks)[0]).encoding, "AV1");
  assert.equal(required(result.pages?.[0].tracks[0]).available, true);
  assert.equal(result.pages?.[0].tracks[1].encoding, "AVC");
  assert.equal(result.pages?.[0].tracks[1].available, false);
  assert.equal(result.pages?.[1].tracks[0].available, true);
  assert.equal(result.estimatedBytes, 3000);
  assert.equal(result.estimatedBytesSource, "mixed");
  const av1 = result.combinations?.find((item) => item.quality === "4K" && item.encoding === "AV1");
  assert.equal(av1?.available, true);
  assert.equal(av1?.pageCount, 2);
  assert.equal(av1?.availablePageCount, 2);
  assert.equal(av1?.totalVideoBytes, 3000);
  assert.equal(av1?.totalBytes, 3000);
  assert.equal(av1?.totalBytesKind, "video_only");
  const avc = result.combinations?.find((item) => item.encoding === "AVC");
  assert.equal(avc?.available, false);
  assert.equal(avc?.availablePageCount, 0);
  assert.deepEqual(forwardedTarget, { quality: "4K", encoding: "AV1" });
});

test("Bilibili visibility failure stops BBDown probing and returns a safe explanation", async () => {
  let runnerCalls = 0;
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => {
      runnerCalls += 1;
      return { bvid, pages: pages(), source: "bbdown" as const };
    },
    undefined,
    async () => ({ available: false, availability: "unavailable", pages: [] }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001"));
  assert.equal(result.status, "failed");
  assert.match(result.error || "", /稿件不可见.*无法确认可用画质、编码和大小/);
  assert.equal(runnerCalls, 0);
});

test("non-strict media probe keeps all normalized combinations and does not overcount alternatives", async () => {
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid, _cookie, _config, target) => {
      assert.equal(target, undefined);
      return { bvid, pages: pages(), source: "bbdown" as const };
    },
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: false }));
  assert.equal(result.status, "complete");
  assert.equal(result.target, undefined);
  assert.equal(required(result.pages?.flatMap((page) => page.tracks)).every((track) => track.available), true);
  assert.equal(result.estimatedBytes, 3000);
});

test("catalog probe never exposes an unknown codec as an exact selectable combination", async () => {
  const unknownCodecPages = pages().map((page) => ({
    ...page,
    tracks: [{
      ...page.tracks[0],
      codec: "future-codec",
    }],
  }));
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: unknownCodecPages, source: "bbdown" as const }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001"));
  assert.equal(result.status, "complete");
  assert.equal(result.pages?.every((page) => page.tracks[0].available === false), true);
  assert.equal(result.combinations?.every((item) => item.available === false), true);
  assert.equal(result.estimatedBytes, undefined);
});

test("exact probe sources preserve HEAD and Range provenance", async () => {
  const exactPages = pages().map((page, pageIndex) => ({
    ...page,
    tracks: [{
      ...page.tracks[0],
      sizeSource: pageIndex === 0 ? "head" as const : "range" as const,
      estimatedBytes: pageIndex === 0 ? 1100 : 2200,
    }],
  }));
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: exactPages, source: "bbdown" as const }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: true }));
  assert.equal(result.status, "complete");
  assert.equal(result.estimatedBytes, 3300);
  assert.equal(result.estimatedBytesSource, "mixed");
  assert.equal(required(required(result.pages?.[0].tracks)[0]).sizeSource, "head");
  assert.equal(required(result.pages?.[1].tracks[0]).sizeSource, "range");
});

test("probe args only request exact size refinement for an explicit target", () => {
  const config = testConfig({ bbdownQuality: "4K", bbdownEncodingPriority: ["HEVC", "AVC", "AV1"] });
  const ordinary = buildBBDownProbeArgs("BV1Probe00001", "credential.json", "probe", config);
  assert.equal(ordinary.includes("--bfb-probe-quality"), false);
  assert.equal(ordinary.includes("--bfb-probe-encoding"), false);
  assert.ok(ordinary.indexOf("--encoding-priority") < ordinary.indexOf("--dfn-priority"));

  const exact = buildBBDownProbeArgs("BV1Probe00001", "credential.json", "probe", { ...config, bbdownApiMode: "app" }, { quality: "4K", encoding: "AV1" });
  assert.ok(exact.indexOf("--dfn-priority") < exact.indexOf("--encoding-priority"));
  assert.deepEqual(exact.slice(-5), ["--bfb-probe-quality", "4K", "--bfb-probe-encoding", "AV1", "-app"]);
});

test("strict quality and strict encoding use the intended primary sort", () => {
  const config = testConfig({ bbdownQuality: "8K", bbdownEncodingPriority: ["HEVC", "AVC", "AV1"] });
  const qualityOnly = buildBBDownTrackSelectionArgs(config, { quality: "4K" });
  assert.ok(qualityOnly.indexOf("--dfn-priority") < qualityOnly.indexOf("--encoding-priority"));
  assert.equal(qualityOnly[qualityOnly.indexOf("--dfn-priority") + 1], "4K 超清");

  const encodingOnly = buildBBDownTrackSelectionArgs(config, { encoding: "AV1" });
  assert.ok(encodingOnly.indexOf("--encoding-priority") < encodingOnly.indexOf("--dfn-priority"));
  assert.equal(encodingOnly[encodingOnly.indexOf("--encoding-priority") + 1].includes("av1"), true);
});

test("structured probe JSON survives stdout chunks split inside one record", () => {
  const line = `BFB_PROBE_JSON:${JSON.stringify(pages()[0])}`;
  const splitAt = Math.floor(line.length / 2);
  const parsed = parseBBDownProbeOutput([line.slice(0, splitAt), line.slice(splitAt), "\n"].join(""));
  assert.deepEqual(parsed, { kind: 'ok' as const, pages: [pages()[0]] });
});

test("structured probe parser fails the complete probe on malformed or duplicate page records", () => {
  const valid = pages()[0];
  const malformed = [
    { ...valid, version: 99 },
    { ...valid, bvid: "BV1Other00001" },
    { ...valid, tracks: [{ ...valid.tracks[0], estimatedBytes: -1 }] },
    valid,
  ].map((record) => `BFB_PROBE_JSON:${JSON.stringify(record)}`).join("\n");
  assert.deepEqual(parseBBDownProbeOutput(malformed, valid.bvid), {kind: 'invalid' as const, reason: 'invalid_page', line: 1});
  assert.deepEqual(parseBBDownProbeOutput(`BFB_PROBE_JSON:${JSON.stringify(valid)}`, valid.bvid), {kind: 'ok' as const, pages: [valid]});

  const duplicatePage = { ...pages()[1], pageIndex: valid.pageIndex };
  const duplicates = [valid, duplicatePage]
    .map((record) => `BFB_PROBE_JSON:${JSON.stringify(record)}`)
    .join("\n");
  assert.deepEqual(parseBBDownProbeOutput(duplicates, valid.bvid), {kind: 'partial' as const, pages: [valid], reason: 'duplicate_page', line: 2});
});

test('probe parsing distinguishes missing framing, damaged JSON, missing fields and partial output', () => {
  assert.deepEqual(parseBBDownProbeOutput('ordinary diagnostics'), {kind: 'empty' as const});
  assert.deepEqual(parseBBDownProbeOutput('BFB_PROBE_JSON:{'), {kind: 'invalid' as const, reason: 'malformed_json', line: 1});
  assert.deepEqual(parseBBDownProbeOutput('BFB_PROBE_JSON:{}'), {kind: 'invalid' as const, reason: 'invalid_page', line: 1});
  const valid = pages()[0];
  assert.deepEqual(parseBBDownProbeOutput(`BFB_PROBE_JSON:${JSON.stringify(valid)}\nBFB_PROBE_JSON:{`),
    {kind: 'partial' as const, pages: [valid], reason: 'malformed_json', line: 2});
  const duplicateCid = {...pages()[1], cid: valid.cid};
  assert.equal(parseBBDownProbeOutput([valid, duplicateCid].map(value => `BFB_PROBE_JSON:${JSON.stringify(value)}`).join('\n')).kind, 'partial');
});

test("structured probe output cap waits for the BBDown process to exit", { timeout: 30_000 }, async () => {
  const runtime = await createTestDir("media-probe-output-cap");
  const fakeScript = path.join(runtime, "fake-probe-output-cap.mjs");
  const pidFile = path.join(runtime, "fake-probe.pid");
  try {
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[2], String(process.pid));
      process.stdout.write('x'.repeat(5 * 1024 * 1024));
      setInterval(() => {}, 1000);
    `, "utf8");
    const error: unknown = await probeMediaWithBBDown(
      "BV1Probe00001",
      user().cookie,
      testConfig(),
      {
        command: process.execPath,
        commandArgsPrefix: [fakeScript, pidFile],
        timeoutMs: 20_000,
        workingRoot: path.join(runtime, "missing-probe-root"),
      },
    ).then(() => null, (caught) => caught);
    assert.equal(readField(error, 'code'), "BBDOWN_PROBE_OUTPUT_TOO_LARGE");
    const pid = Number(await fs.promises.readFile(pidFile, "utf8"));
    assert.equal(Number.isInteger(pid) && pid > 0, true);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await removeTestDir(runtime);
  }
});

test("multi-page combinations allow different dimensions at the same Bilibili tier and codec", async () => {
  const multiPage = pages();
  multiPage[1].tracks[0].resolution = "2160x3840";
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: multiPage, source: "bbdown" as const }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: true }));
  const combination = result.combinations?.find((item) => item.encoding === "AV1");
  assert.equal(combination?.available, true);
  assert.equal(combination?.resolution, "各分P不同");
});

test("protocol v2 includes audio, mux allowance, peak space, and current cache capacity", async () => {
  const v2Pages = pages().map((page, index) => ({
    ...page,
    version: 2,
    selectedAudio: {
      codec: "AAC",
      bitrateKbps: 128,
      estimatedBytes: index === 0 ? 100 : 200,
      sizeSource: "bitrate_estimate" as const,
    },
  }));
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: v2Pages, source: "bbdown" as const }),
    async () => ({ limitBytes: 10_000, usedBytes: 1_000, reserveBytes: 500 }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: true }));
  assert.equal(result.estimatedVideoBytes, 3000);
  assert.equal(result.estimatedAudioBytes, 300);
  assert.equal(result.estimatedBytes, 3333);
  assert.equal(result.estimatedBytesKind, "final");
  assert.equal(result.estimatedPeakBytes, 6633);
  assert.equal(result.cacheAvailableBytes, 8500);
  assert.equal(result.cacheLimitBytes, 10_000);
  assert.equal(result.estimatedBytesSource, "mixed");
  assert.equal(result.combinations?.find((item) => item.encoding === "AV1")?.totalSizeConfidence, "estimate");
});

test("selected combinations expose exact confidence only when every final component has usable size evidence", async () => {
  const exactPages = pages().map((page, index) => ({
    ...page,
    version: 2,
    tracks: [{
      ...page.tracks[0],
      sizeSource: index === 0 ? "head" as const : "range" as const,
      estimatedBytes: index === 0 ? 1100 : 2200,
    }],
    selectedAudio: {
      codec: "AAC",
      bitrateKbps: 128,
      estimatedBytes: index === 0 ? 100 : 200,
      sizeSource: "api" as const,
    },
  }));
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: exactPages, source: "bbdown" as const }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "4K", encoding: "AV1", strict: true }));
  assert.equal(result.combinations?.find((item) => item.encoding === "AV1")?.totalSizeConfidence, "exact");
});

test("cache inspection failure does not discard a valid media probe", async () => {
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({ bvid, pages: pages(), source: "bbdown" as const }),
    async () => { throw new Error("cache unavailable"); },
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001"));
  assert.equal(result.status, "complete");
  assert.equal(result.estimatedVideoBytes, 3000);
  assert.equal(result.cacheAvailableBytes, undefined);
});

test("strict quality probe does not treat 1080P60 as exact 1080P", async () => {
  const service = new MediaProbeService(
    { get: () => testConfig() },
    async (bvid) => ({
      bvid,
      source: "bbdown" as const,
      pages: [{
        ...pages()[0],
        tracks: [{
          bilibiliQuality: "1080P 60帧",
          codec: "AVC",
          resolution: "1920x1080",
          frameRate: "60",
          estimatedBytes: 500,
          sizeSource: "api",
        }],
      }],
    }),
  );
  const result = await waitFor(service.start(user(), "BV1Probe00001", { quality: "1080P", strict: true }));
  assert.equal(result.status, "complete");
  assert.equal(required(required(result.pages?.[0].tracks)[0]).available, false);
  assert.equal(required(result.combinations?.[0]).available, false);
  assert.equal(result.estimatedBytes, undefined);
});
