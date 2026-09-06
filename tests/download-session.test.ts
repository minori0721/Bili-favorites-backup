import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  BBDOWN_SOURCE_COMMIT,
  assessStrictEncoding,
  assessStrictQuality,
  buildUploadFileMetadataFromSession,
  buildSelectPageArgument,
  cleanupDownloadRecoveryArtifacts,
  cleanupUploadedSessionFiles,
  DOWNLOAD_RETAINED_FILE,
  inspectDownloadCache,
  prepareDownloadSession,
  quarantineBrokenAria2Track,
  readDownloadSession,
  refreshDownloadSessionOutputs,
  writeDownloadSession,
  type DownloadSessionManifest,
} from "../src/download-session.js";
import {
  detectAria2TrackRecoveryIssue,
  downloadWithBBDown,
  runWindowsTaskkill,
  sanitizeDownloadDiagnosticText,
  shutdownActiveDownloads,
  interactivePageSetHash,
} from "../src/downloader.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";
import { writeJsonFile } from "../src/storage.js";

function localFfmpeg() {
  const configured = process.env.FFMPEG_PATH;
  if (configured) return configured;
  const known = "E:\\ffmpeg-2025-12-04\\bin\\ffmpeg.exe";
  return fs.existsSync(known) ? known : "ffmpeg";
}

function configureFfprobe() {
  const ffmpeg = localFfmpeg();
  if (path.isAbsolute(ffmpeg)) {
    const candidate = path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (fs.existsSync(candidate)) process.env.FFPROBE_PATH = candidate;
  }
}

async function createVideo(filePath: string, seconds = 2, videoCodec = "mpeg4") {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=320x180:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=1000:duration=${seconds}`,
    "-shortest", "-c:v", videoCodec, "-c:a", "aac", filePath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(localFfmpeg(), args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg exited ${code}`)));
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("interactive download expands the root snapshot, protects the page set and resumes all CIDs", async () => {
  configureFfprobe();
  const runtime = await createTestDir("interactive-download");
  try {
    const fixture = path.join(runtime, "fixture.mp4");
    await createVideo(fixture);
    const bvid = "BV1pT4y157sf";
    const downloadDir = path.join(runtime, bvid);
    const records = [101, 102, 103].map((cid, i) => ({
      version: 2, bvid, cid: String(cid), pageIndex: i + 1, pageTitle: `Node ${i + 1}`,
      durationSeconds: 2, tracks: [],
    }));
    const digest = interactivePageSetHash(records);
    const log = path.join(runtime, "runs.jsonl");
    const script = path.join(runtime, "fake.mjs");
    await fs.promises.writeFile(script, `
      import fs from 'node:fs'; import path from 'node:path';
      const args = process.argv.slice(2);
      if (args.includes('--bfb-pages-json')) {
        for (const p of ${JSON.stringify(records)}) console.log('BFB_PROBE_JSON:' + JSON.stringify(p));
        console.log('BFB_PAGES_COMPLETE:${digest}');
      } else {
        if (args[args.indexOf('--bfb-page-set-sha256') + 1] !== '${digest}') process.exit(9);
        const resumed = fs.existsSync(${JSON.stringify(log)});
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
        const indexes = resumed ? [3] : [1, 2];
        for (const i of indexes) fs.copyFileSync(${JSON.stringify(fixture)}, path.join(process.cwd(), 'video-${bvid}_P' + i + '.mp4'));
      }
    `);
    const options = {
      downloadDir, command: process.execPath, commandArgsPrefix: [script],
      pageSnapshot: { available: true, interactive: true, access: { classification: "normal", source: "view" },
        pages: [{ index: 1, cid: 101, title: "Root", duration: 2 }] } as const,
    };
    const cookie = { SESSDATA: "fake", DedeUserID: "1" };
    const runOptions = { ...options, accessRecheck: async () => options.pageSnapshot };
    await assert.rejects(downloadWithBBDown(bvid, cookie, testConfig(), runOptions as any), /remaining 1/);
    assert.equal(readDownloadSession(downloadDir)?.status, "failed");
    assert.equal(readDownloadSession(downloadDir)?.outputs.length, 2);
    const first = await downloadWithBBDown(bvid, cookie, testConfig(), runOptions as any);
    assert.equal(first.files.length, 3);
    assert.equal(first.totalPages, 3);
    assert.equal(readDownloadSession(downloadDir)?.status, "complete");
    assert.deepEqual(readDownloadSession(downloadDir)?.pages.map(p => p.cid), [101, 102, 103]);
    const second = await downloadWithBBDown(bvid, cookie, testConfig(), runOptions as any);
    assert.equal(second.files.length, 3);
    const calls = (await fs.promises.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[1][calls[1].indexOf("--select-page") + 1], "3");
  } finally { await removeTestDir(runtime); }
});

test("interactive inventory failures preserve the existing manifest and page-set drift stops media download", async () => {
  const runtime = await createTestDir("interactive-boundaries");
  try {
    const bvid = "BV1pT4y157sf";
    const downloadDir = path.join(runtime, bvid);
    await prepareDownloadSession({ downloadDir, bvid, accountUid: 1, config: testConfig(),
      pages: [{ index: 1, cid: 101, title: "Root", duration: 2 }] });
    const before = readDownloadSession(downloadDir);
    const script = path.join(runtime, "fake.mjs");
    const records = [{ version: 2, bvid, cid: "101", pageIndex: 1, pageTitle: "Root", tracks: [] }];
    const options = { downloadDir, command: process.execPath, commandArgsPrefix: [script],
      pageSnapshot: { available: true, interactive: true, pages: [{ index: 1, cid: 101, title: "Root", duration: 2 }] } };
    await fs.promises.writeFile(script, `console.log('BFB_PROBE_JSON:' + ${JSON.stringify(JSON.stringify(records[0]))});`);
    await assert.rejects(downloadWithBBDown(bvid, { SESSDATA: "fake", DedeUserID: "1" }, testConfig(), options as any), /片段清单不完整/);
    assert.deepEqual(readDownloadSession(downloadDir), before);
    await fs.promises.writeFile(script, `
      if (process.argv.includes('--bfb-pages-json')) {
        console.log('BFB_PROBE_JSON:' + ${JSON.stringify(JSON.stringify(records[0]))});
        console.log('BFB_PAGES_COMPLETE:${interactivePageSetHash(records)}');
      } else { console.log('BFB_SIGNAL:INTERACTIVE_CHANGED'); process.exit(1); }
    `);
    await assert.rejects(downloadWithBBDown(bvid, { SESSDATA: "fake", DedeUserID: "1" }, testConfig(), options as any), /片段清单发生变化/);
    assert.equal(readDownloadSession(downloadDir)?.status, "failed");
    assert.equal(readDownloadSession(downloadDir)?.outputs.length, 0);
  } finally { await removeTestDir(runtime); }
});

function uploadMetadataManifest(overrides: Partial<DownloadSessionManifest> = {}): DownloadSessionManifest {
  return {
    schemaVersion: 1,
    sessionId: "metadata-session",
    kind: "quality_upgrade",
    bvid: "BVMETADATA",
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "fingerprint",
    configSnapshot: {
      quality: "4K",
      encoding: "HEVC",
      apiMode: "web",
      hiRes: false,
      dolby: false,
      filenameTemplate: "<videoTitle>-<bvid>",
    },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    snapshotAt: "2026-07-29T00:00:00.000Z",
    publishedAt: 1_700_000_000,
    status: "complete",
    pages: [{ index: 1, cid: 501, title: "P1", duration: 30, publishedAt: 1_700_000_100 }],
    selectedStreams: [{
      pageIndex: 1,
      cid: 501,
      bilibiliQuality: "4K",
      observedAt: "2026-07-29T00:00:01.000Z",
    }],
    outputs: [{
      pageIndex: 1,
      cid: 501,
      relativePath: "parts\\sample.mp4",
      size: 1024,
      duration: 30,
      videoCodec: "hevc",
      audioCodec: "aac",
      width: 1772,
      height: 3840,
      frameRate: 60,
      quickHash: "quick-hash",
      verifiedAt: "2026-07-29T00:00:02.000Z",
    }],
    history: [],
    ...overrides,
  };
}

test("upload metadata is rebuilt from the persistent download session", async () => {
  const runtime = await createTestDir("upload-metadata-builder");
  try {
    writeDownloadSession(runtime, uploadMetadataManifest());
    const metadata = buildUploadFileMetadataFromSession(runtime, ["parts/sample.mp4"], {
      requireVerifiedMediaMetadata: true,
    });
    assert.deepEqual(metadata?.["parts/sample.mp4"], {
      publishDate: 1_700_000_000,
      videoDate: 1_700_000_100,
      cid: 501,
      pageIndex: 1,
      bilibiliQuality: "4K",
      dfn: "1772p60",
      videoCodecs: "HEVC",
      mediaMetadata: {
        width: 1772,
        height: 3840,
        duration: 30,
        fps: 60,
        codec: "HEVC",
        source: "ffprobe",
        observedAt: "2026-07-29T00:00:02.000Z",
      },
    });

    const legacy = uploadMetadataManifest({ selectedStreams: undefined });
    writeDownloadSession(runtime, legacy);
    const legacyMetadata = buildUploadFileMetadataFromSession(runtime, ["parts/sample.mp4"], {
      requireVerifiedMediaMetadata: true,
    });
    assert.equal(legacyMetadata?.["parts/sample.mp4"].bilibiliQuality, undefined);
    assert.equal(legacyMetadata?.["parts/sample.mp4"].dfn, "1772p60");
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict upload metadata preflight rejects incomplete quality-upgrade artifacts", async () => {
  const runtime = await createTestDir("upload-metadata-preflight");
  const missingRuntime = path.join(runtime, "missing");
  try {
    assert.throws(
      () => buildUploadFileMetadataFromSession(missingRuntime, ["sample.mp4"], { requireVerifiedMediaMetadata: true }),
      /download session manifest is missing/
    );

    writeDownloadSession(runtime, uploadMetadataManifest());
    assert.throws(
      () => buildUploadFileMetadataFromSession(runtime, ["other.mp4"], { requireVerifiedMediaMetadata: true }),
      /absent from the download session/
    );

    const incomplete = uploadMetadataManifest({
      outputs: [{ ...uploadMetadataManifest().outputs[0], width: undefined }],
    });
    writeDownloadSession(runtime, incomplete);
    assert.throws(
      () => buildUploadFileMetadataFromSession(runtime, ["parts/sample.mp4"], { requireVerifiedMediaMetadata: true }),
      /lack verified ffprobe dimensions/
    );
    assert.equal(
      buildUploadFileMetadataFromSession(runtime, ["parts/sample.mp4"])?.["parts/sample.mp4"].mediaMetadata,
      undefined
    );

    writeDownloadSession(runtime, uploadMetadataManifest({
      outputs: [{ ...uploadMetadataManifest().outputs[0], verifiedAt: "invalid" }],
    }));
    assert.throws(
      () => buildUploadFileMetadataFromSession(runtime, ["parts/sample.mp4"], { requireVerifiedMediaMetadata: true }),
      /lack verified ffprobe dimensions/
    );
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict encoding assessment is based on every ffprobe output, not the BBDown log", async () => {
  const runtime = await createTestDir("strict-encoding-assessment");
  try {
    const base = uploadMetadataManifest();
    writeDownloadSession(runtime, {
      ...base,
      pages: [
        base.pages[0],
        { index: 2, cid: 502, title: "P2", duration: 30 },
      ],
      outputs: [
        base.outputs[0],
        { ...base.outputs[0], pageIndex: 2, cid: 502, relativePath: "parts/second.mp4", videoCodec: "h264" },
      ],
    });

    const mismatch = assessStrictEncoding(runtime, "AV1", ["parts/sample.mp4", "parts/second.mp4"]);
    assert.equal(mismatch.status, "mismatch");
    assert.equal(mismatch.encodingMismatch, true);
    assert.deepEqual(mismatch.actualEncodings, ["AVC", "HEVC"]);
    assert.equal(mismatch.verifiedPages, 2);
    assert.match(mismatch.summary, /请求 AV1/);

    writeDownloadSession(runtime, {
      ...base,
      outputs: [{ ...base.outputs[0], videoCodec: "h264" }],
    });
    const matched = assessStrictEncoding(runtime, "AVC");
    assert.equal(matched.status, "matched");
    assert.equal(matched.encodingMismatch, false);
    assert.deepEqual(matched.actualEncodings, ["AVC"]);

    writeDownloadSession(runtime, {
      ...base,
      outputs: [{ ...base.outputs[0], videoCodec: "unknown" }],
    });
    const unknown = assessStrictEncoding(runtime, "AVC");
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.verifiedPages, 0);
    assert.deepEqual(unknown.actualEncodings, ["UNKNOWN"]);
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict quality assessment requires every page's persisted BBDown selection", async () => {
  const runtime = await createTestDir("strict-quality-assessment");
  try {
    const base = uploadMetadataManifest();
    writeDownloadSession(runtime, base);
    const matched = assessStrictQuality(runtime, "4K");
    assert.equal(matched.status, "matched");
    assert.equal(matched.qualityMismatch, false);
    assert.deepEqual(matched.actualQualities, ["4K"]);

    writeDownloadSession(runtime, {
      ...base,
      selectedStreams: [{ ...base.selectedStreams![0], bilibiliQuality: "1080P" }],
    });
    const mismatch = assessStrictQuality(runtime, "4K");
    assert.equal(mismatch.status, "mismatch");
    assert.equal(mismatch.qualityMismatch, true);
    assert.match(mismatch.summary, /实际画质为 1080P/);

    writeDownloadSession(runtime, { ...base, selectedStreams: undefined });
    const unknown = assessStrictQuality(runtime, "4K");
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.verifiedPages, 0);
    assert.deepEqual(unknown.actualQualities, ["UNKNOWN"]);
  } finally {
    await removeTestDir(runtime);
  }
});

async function inspectRecovery(rootDir: string) {
  return (await inspectDownloadCache(rootDir)).recovery;
}

test("select-page argument compacts long consecutive ranges", () => {
  const pages = [1, 2, 3, 5, 7, 8].map((index) => ({ index, cid: index, title: `P${index}`, duration: 1 }));
  assert.equal(buildSelectPageArgument(pages), "1-3,5,7,8");
});

test("async download cache inspection matches recovery classification without blocking the event loop", { timeout: 60_000 }, async () => {
  const runtime = await createTestDir("download-cache-async");
  try {
    for (let directoryIndex = 0; directoryIndex < 100; directoryIndex += 1) {
      const downloadDir = path.join(runtime, `BVASYNC${String(directoryIndex).padStart(4, "0")}`);
      await fs.promises.mkdir(downloadDir, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, fileIndex) =>
        fs.promises.writeFile(path.join(downloadDir, `track-${fileIndex}.part`), Buffer.alloc(1))
      ));
    }
    const credentialDir = path.join(runtime, "bbdown-credentials-old");
    await fs.promises.mkdir(credentialDir, { recursive: true });
    await fs.promises.writeFile(path.join(credentialDir, "secret.txt"), Buffer.alloc(7));

    let settled = false;
    const pending = inspectDownloadCache(runtime).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    const inspection = await pending;
    assert.equal(inspection.usedBytes, 10_007);
    assert.equal(inspection.fileCount, 10_001);
    assert.equal(inspection.exportableBytes, 10_000);
    assert.equal(inspection.exportableFiles, 10_000);
    assert.equal(inspection.recovery.legacyDirectories, 100);
    assert.equal(inspection.recovery.cleanupEligibleBytes, 10_000);
  } finally {
    await removeTestDir(runtime);
  }
});

test("invalid quarantined files are cleanup bytes instead of resumable retained bytes", async () => {
  const runtime = await createTestDir("download-recovery-invalid");
  const downloadDir = path.join(runtime, "BVINVALID");
  try {
    await fs.promises.mkdir(path.join(downloadDir, "_invalid", "old"), { recursive: true });
    await fs.promises.writeFile(path.join(downloadDir, "_invalid", "old", "preview.mp4"), Buffer.alloc(1024));
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), {
      schemaVersion: 1,
      sessionId: "invalid-session",
      kind: "backup",
      bvid: "BVINVALID",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      snapshotAt: "2026-07-12T00:00:00.000Z",
      status: "failed",
      pages: [{ index: 1, cid: 1, title: "P1", duration: 60 }],
      outputs: [],
      history: [],
    });
    const summary = await inspectRecovery(runtime);
    assert.equal(summary.resumableSessions, 0);
    assert.equal(summary.retainedBytes, 0);
    assert.equal(summary.cleanupEligibleBytes, 1024);
    const cleanup = await cleanupDownloadRecoveryArtifacts(runtime);
    assert.equal(cleanup.removedFiles, 1);
    assert.equal(cleanup.removedBytes, 1024);
    assert.equal(fs.existsSync(path.join(downloadDir, "_invalid", "old", "preview.mp4")), false);
    assert.equal(fs.existsSync(path.join(downloadDir, ".bfb-download.json")), true);
    assert.equal((await inspectRecovery(runtime)).cleanupEligibleBytes, 0);
  } finally {
    await removeTestDir(runtime);
  }
});

test("manual fragment cleanup preserves verified outputs and resumable aria2 tracks", async () => {
  const runtime = await createTestDir("download-recovery-selective-cleanup");
  const downloadDir = path.join(runtime, "BVSELECTIVECLEANUP");
  const output = path.join(downloadDir, "verified.mp4");
  const track = path.join(downloadDir, "1", "video.P1.80.mp4");
  const control = `${track}.aria2`;
  const incompatible = path.join(downloadDir, "_incompatible", "old", "audio.tmp");
  try {
    await fs.promises.mkdir(path.dirname(track), { recursive: true });
    await fs.promises.mkdir(path.dirname(incompatible), { recursive: true });
    await fs.promises.writeFile(output, Buffer.alloc(2048));
    await fs.promises.writeFile(track, Buffer.alloc(4096));
    await fs.promises.writeFile(control, Buffer.alloc(64));
    await fs.promises.writeFile(incompatible, Buffer.alloc(512));
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), {
      schemaVersion: 1,
      sessionId: "selective-cleanup-session",
      kind: "backup",
      bvid: "BVSELECTIVECLEANUP",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: { quality: "80", encoding: "AVC", hiRes: false, dolby: false, filenameTemplate: "test" },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      snapshotAt: "2026-07-12T00:00:00.000Z",
      status: "failed",
      pages: [{ index: 1, cid: 1, title: "P1", duration: 60 }],
      outputs: [{ pageIndex: 1, cid: 1, relativePath: "verified.mp4", size: 2048, duration: 60, videoCodec: "h264", quickHash: "hash", verifiedAt: "2026-07-12T00:00:00.000Z" }],
      history: [],
    });

    const cleanup = await cleanupDownloadRecoveryArtifacts(runtime);
    assert.equal(cleanup.removedFiles, 1);
    assert.equal(cleanup.removedBytes, 512);
    assert.equal(fs.existsSync(incompatible), false);
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.existsSync(track), true);
    assert.equal(fs.existsSync(control), true);
    const summary = await inspectRecovery(runtime);
    assert.equal(summary.cleanupEligibleBytes, 0);
    assert.equal(summary.resumableSessions, 1);
    assert.ok(summary.retainedBytes >= 2048 + 4096 + 64);
  } finally {
    await removeTestDir(runtime);
  }
});

test("a late charging restriction removes only invalid files created by the current run", async () => {
  const runtime = await createTestDir("download-late-charging");
  const downloadDir = path.join(runtime, "BVLATECHARGE");
  const fakeScript = path.join(runtime, "fake-late-charge.mjs");
  const oldInvalid = path.join(downloadDir, "_invalid", "old", "old-preview.mp4");
  try {
    await fs.promises.mkdir(path.dirname(oldInvalid), { recursive: true });
    await fs.promises.writeFile(oldInvalid, "old");
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      fs.writeFileSync('new-preview-BVLATECHARGE.mp4', 'not-a-complete-video');
    `, "utf8");
    await assert.rejects(downloadWithBBDown(
      "BVLATECHARGE",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        pageSnapshot: {
          available: true,
          access: { classification: "unknown", source: "unknown" },
          pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
        },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
        accessRecheck: async () => ({
          available: true,
          access: { classification: "charging_restricted", isUPowerExclusive: true, isUPowerPlay: false, previewAvailable: true, source: "view_detail" },
          pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
        }),
      }
    ), (error: any) => error?.chargingRestricted === true);
    assert.equal(fs.existsSync(oldInvalid), true);
    const invalidFiles = fs.readdirSync(path.join(downloadDir, "_invalid"), { recursive: true }).map(String);
    assert.equal(invalidFiles.some((name) => name.includes("new-preview")), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("legacy completed pages are adopted and replaced CIDs move to history", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-media");
  const downloadDir = path.join(runtime, "BV1SESSIONTEST");
  try {
    await createVideo(path.join(downloadDir, "video-BV1SESSIONTEST_P1.mp4"));
    await createVideo(path.join(downloadDir, "video-BV1SESSIONTEST_P2.mp4"));
    const pages = [
      { index: 1, cid: 11, title: "One", duration: 2 },
      { index: 2, cid: 22, title: "Two", duration: 2 },
    ];
    const first = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1SESSIONTEST",
      accountUid: 1,
      config: testConfig(),
      pages,
    });
    assert.equal(first.manifest.status, "complete");
    assert.equal(first.manifest.outputs.length, 2);
    assert.equal(first.manifest.legacyAdopted, true);

    const changed = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1SESSIONTEST",
      accountUid: 1,
      config: testConfig(),
      pages: [pages[0], { index: 2, cid: 33, title: "New Two", duration: 2 }],
    });
    assert.deepEqual(changed.missingPages.map((page) => page.cid), [33]);
    assert.equal(changed.manifest.outputs.length, 1);
    assert.equal(changed.manifest.history.length, 1);
    assert.equal(fs.existsSync(path.join(downloadDir, changed.manifest.history[0].relativePath)), true);

    await createVideo(path.join(downloadDir, "video-BV1SESSIONTEST_P2.mp4"));
    const refreshed = await refreshDownloadSessionOutputs(downloadDir);
    assert.equal(refreshed.manifest.status, "complete");
    assert.deepEqual(refreshed.manifest.outputs.map((output) => output.cid), [11, 33]);
  } finally {
    await removeTestDir(runtime);
  }
});

test("CID-based page reordering reuses files without allowing a later page replacement to overwrite them", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-reorder");
  const downloadDir = path.join(runtime, "BV1REORDER");
  try {
    await createVideo(path.join(downloadDir, "video-BV1REORDER_P1.mp4"));
    await createVideo(path.join(downloadDir, "video-BV1REORDER_P2.mp4"));
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1REORDER",
      accountUid: 1,
      config: testConfig(),
      pages: [
        { index: 1, cid: 11, title: "One", duration: 2 },
        { index: 2, cid: 22, title: "Two", duration: 2 },
      ],
    });
    const reordered = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1REORDER",
      accountUid: 1,
      config: testConfig(),
      pages: [
        { index: 1, cid: 22, title: "Two", duration: 2 },
        { index: 2, cid: 11, title: "One", duration: 2 },
      ],
    });
    assert.deepEqual(
      reordered.manifest.outputs.map((output) => [output.pageIndex, output.cid, path.basename(output.relativePath)]),
      [
        [1, 22, "video-BV1REORDER_P1.mp4"],
        [2, 11, "video-BV1REORDER_P2.mp4"],
      ]
    );
    const replaced = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1REORDER",
      accountUid: 1,
      config: testConfig(),
      pages: [
        { index: 1, cid: 22, title: "Two", duration: 2 },
        { index: 2, cid: 33, title: "New", duration: 2 },
      ],
    });
    assert.deepEqual(replaced.manifest.outputs.map((output) => output.cid), [22]);
    assert.equal(fs.existsSync(path.join(downloadDir, "video-BV1REORDER_P1.mp4")), true);
    assert.equal(replaced.manifest.history.some((output) => output.cid === 11), true);
    await createVideo(path.join(downloadDir, "video-BV1REORDER_P2.mp4"));
    const refreshed = await refreshDownloadSessionOutputs(downloadDir);
    assert.deepEqual(refreshed.manifest.outputs.map((output) => output.cid), [22, 33]);
  } finally {
    await removeTestDir(runtime);
  }
});

test("a corrupt session manifest is preserved before safe legacy adoption", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-corrupt");
  const downloadDir = path.join(runtime, "BV1CORRUPT");
  try {
    await fs.promises.mkdir(downloadDir, { recursive: true });
    await fs.promises.writeFile(path.join(downloadDir, ".bfb-download.json"), "{broken-json", "utf8");
    await createVideo(path.join(downloadDir, "video-BV1CORRUPT.mp4"));
    const prepared = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1CORRUPT",
      accountUid: 1,
      config: testConfig(),
      pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
    });
    assert.equal(prepared.manifest.outputs.length, 1);
    const preserved = (await fs.promises.readdir(downloadDir)).filter((name) => name.startsWith(".bfb-download.json.corrupt-"));
    assert.equal(preserved.length, 1);
    assert.equal(await fs.promises.readFile(path.join(downloadDir, preserved[0]), "utf8"), "{broken-json");
  } finally {
    await removeTestDir(runtime);
  }
});

test("successful uploads remove only verified session files and retain unknown artifacts for manual cleanup", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-selective-cleanup");
  const downloadDir = path.join(runtime, "BV1SELECTIVECLEAN");
  try {
    await createVideo(path.join(downloadDir, "video-BV1SELECTIVECLEAN.mp4"));
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1SELECTIVECLEAN",
      accountUid: 1,
      config: testConfig(),
      pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
    });
    const unknown = path.join(downloadDir, "_invalid", "unknown.bin");
    await fs.promises.mkdir(path.dirname(unknown), { recursive: true });
    await fs.promises.writeFile(unknown, Buffer.alloc(32));
    const retained = await cleanupUploadedSessionFiles(downloadDir);
    assert.equal(retained.removedFiles, 0);
    assert.equal(fs.existsSync(path.join(downloadDir, "video-BV1SELECTIVECLEAN.mp4")), true);
    const result = await cleanupUploadedSessionFiles(downloadDir, { confirmedRelativePaths: ["video-BV1SELECTIVECLEAN.mp4"] });
    assert.equal(result.removedDirectory, false);
    assert.equal(fs.existsSync(path.join(downloadDir, "video-BV1SELECTIVECLEAN.mp4")), false);
    assert.equal(fs.existsSync(unknown), true);
    assert.equal(fs.existsSync(path.join(downloadDir, DOWNLOAD_RETAINED_FILE)), true);
    const summary = await inspectRecovery(runtime);
    assert.ok(summary.retainedBytes >= 32);
    assert.equal(summary.resumableSessions, 0);
  } finally {
    await removeTestDir(runtime);
  }
});

test("cleanup preserves changed files and their manifest records", async () => {
  const runtime = await createTestDir("download-cleanup-changed");
  try {
    const manifest = uploadMetadataManifest();
    writeDownloadSession(runtime, manifest);
    const output = manifest.outputs[0];
    const target = path.join(runtime, output.relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, Buffer.alloc(output.size + 1));
    const result = await cleanupUploadedSessionFiles(runtime, { confirmedRelativePaths: [output.relativePath] });
    assert.equal(result.removedFiles, 0);
    assert.equal(fs.existsSync(target), true);
    assert.equal(readDownloadSession(runtime)?.outputs.length, 1);
  } finally {
    await removeTestDir(runtime);
  }
});

test("explicit cleanup authorization cannot fall back to legacy paths after identity rejection", async () => {
  const runtime = await createTestDir("download-cleanup-stale-authorization");
  try {
    const manifest = uploadMetadataManifest();
    writeDownloadSession(runtime, manifest);
    const output = manifest.outputs[0];
    const target = path.join(runtime, output.relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, Buffer.alloc(output.size));
    const result = await cleanupUploadedSessionFiles(runtime, {
      authorizedFiles: [{ relativePath: output.relativePath, expectedSize: output.size, manifestSessionId: "previous-session" }],
      confirmedRelativePaths: [output.relativePath],
    });
    assert.equal(result.removedFiles, 0);
    assert.equal(fs.existsSync(target), true);
    assert.equal(readDownloadSession(runtime)?.outputs.length, 1);
  } finally {
    await removeTestDir(runtime);
  }
});

test("cleanup never deletes a non-empty directory when its session manifest is missing", async () => {
  const runtime = await createTestDir("download-session-missing-cleanup-manifest");
  const downloadDir = path.join(runtime, "BV1MISSINGMANIFEST");
  try {
    await fs.promises.mkdir(downloadDir, { recursive: true });
    await fs.promises.writeFile(path.join(downloadDir, "unknown.bin"), Buffer.alloc(16));
    const result = await cleanupUploadedSessionFiles(downloadDir, { confirmedRelativePaths: [] });
    assert.equal(result.removedDirectory, false);
    assert.equal(fs.existsSync(path.join(downloadDir, "unknown.bin")), true);
    assert.equal(fs.existsSync(path.join(downloadDir, DOWNLOAD_RETAINED_FILE)), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("nested filename templates are discovered while BBDown raw track directories are ignored", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-nested-output");
  const downloadDir = path.join(runtime, "BV1NESTED");
  try {
    await createVideo(path.join(downloadDir, "UP", "video-BV1NESTED.mp4"));
    await createVideo(path.join(downloadDir, "123456", "123456.P1.77.mp4"));
    const prepared = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1NESTED",
      accountUid: 1,
      config: testConfig({ filenameTemplate: "UP/<videoTitle>-<bvid>" }),
      pages: [{ index: 1, cid: 77, title: "One", duration: 2 }],
    });
    assert.deepEqual(prepared.manifest.outputs.map((output) => output.relativePath), [path.join("UP", "video-BV1NESTED.mp4")]);
    assert.equal(fs.existsSync(path.join(downloadDir, "123456", "123456.P1.77.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("configuration changes preserve completed data but isolate unsafe fragments", async () => {
  const runtime = await createTestDir("download-session-config");
  const downloadDir = path.join(runtime, "BV1CONFIGTEST");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1CONFIGTEST",
      accountUid: 1,
      config: testConfig({ bbdownEncoding: "HEVC" }),
      pages,
    });
    await fs.promises.writeFile(path.join(downloadDir, "track.mp4.aria2"), "resume-state");
    const rawTrackDir = path.join(downloadDir, "123456");
    await fs.promises.mkdir(rawTrackDir, { recursive: true });
    await fs.promises.writeFile(path.join(rawTrackDir, "123456.P1.101.mp4"), "partial-video");
    await fs.promises.writeFile(path.join(rawTrackDir, "123456.P1.101.mp4.aria2"), "control");
    const next = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1CONFIGTEST",
      accountUid: 1,
      config: testConfig({ bbdownEncoding: "AV1" }),
      pages,
    });
    assert.equal(next.incompatibleFragmentsMoved, 3);
    assert.equal(fs.existsSync(path.join(downloadDir, "track.mp4.aria2")), false);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "123456.P1.101.mp4")), false);
    assert.equal(fs.existsSync(readDownloadSession(downloadDir) ? path.join(downloadDir, ".bfb-download.json") : ""), true);
  } finally {
    await removeTestDir(runtime);
  }
});

for (const mode of ["web", "app"] as const) {
  test(`BBDown 2.0.5 retains 2.0.4 ${mode} tracks but still isolates changed runtime settings`, async () => {
    const runtime = await createTestDir(`bbdown-205-${mode}`);
    try {
      const downloadDir = path.join(runtime, "BV1pT4y157sf");
      const pages = [{ index: 1, cid: 101, title: "Root", duration: 2 }];
      const config = testConfig({ bbdownApiMode: mode });
      await prepareDownloadSession({ downloadDir, bvid: "BV1pT4y157sf", accountUid: 1, config, pages });
      const old = readDownloadSession(downloadDir)!;
      old.bbdownCommit = "0ea9463202e8a57e0d673f29166e54f4ed770255";
      old.configFingerprint = "old-runtime";
      writeJsonFile(path.join(downloadDir, ".bfb-download.json"), old);
      const track = path.join(downloadDir, "video.mp4.aria2");
      await fs.promises.writeFile(track, "resume");
      const upgraded = await prepareDownloadSession({ downloadDir, bvid: old.bvid, accountUid: 1, config, pages });
      assert.equal(upgraded.incompatibleFragmentsMoved, 0);
      assert.equal(upgraded.manifest.bbdownCommit, BBDOWN_SOURCE_COMMIT);
      assert.equal(fs.existsSync(track), true);
      writeJsonFile(path.join(downloadDir, ".bfb-download.json"), old);
      const changed = await prepareDownloadSession({ downloadDir, bvid: old.bvid, accountUid: 2, config, pages });
      assert.equal(changed.incompatibleFragmentsMoved, 1);
      assert.equal(fs.existsSync(track), false);
    } finally { await removeTestDir(runtime); }
  });
}

test("BBDown current release keeps 2.0.3 Web resume tracks when runtime settings are unchanged", async () => {
  const runtime = await createTestDir("download-session-compatible-bbdown-upgrade");
  const downloadDir = path.join(runtime, "BV1BBDOWNUPGRADE");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1BBDOWNUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "web" }),
      pages,
    });
    const previous = readDownloadSession(downloadDir)!;
    previous.bbdownCommit = "76c1a802825efd9761699d42955fd0553a9dfa9d";
    previous.configFingerprint = "previous-bbdown";
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), previous);
    await fs.promises.writeFile(path.join(downloadDir, "video-track.mp4.aria2"), "resume");

    const upgraded = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1BBDOWNUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "web" }),
      pages,
    });
    assert.equal(upgraded.incompatibleFragmentsMoved, 0);
    assert.equal(fs.existsSync(path.join(downloadDir, "video-track.mp4.aria2")), true);
    assert.equal(upgraded.manifest.bbdownCommit, BBDOWN_SOURCE_COMMIT);
  } finally {
    await removeTestDir(runtime);
  }
});

test("BBDown current release keeps 2.0.3 APP resume tracks because download behavior is unchanged", async () => {
  const runtime = await createTestDir("download-session-compatible-app-bbdown-upgrade");
  const downloadDir = path.join(runtime, "BV1BBDOWNAPPUPGRADE");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1BBDOWNAPPUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "app" }),
      pages,
    });
    const previous = readDownloadSession(downloadDir)!;
    previous.bbdownCommit = "76c1a802825efd9761699d42955fd0553a9dfa9d";
    previous.configFingerprint = "previous-bbdown";
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), previous);
    await fs.promises.writeFile(path.join(downloadDir, "app-video-track.mp4.aria2"), "resume");

    const upgraded = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1BBDOWNAPPUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "app" }),
      pages,
    });
    assert.equal(upgraded.incompatibleFragmentsMoved, 0);
    assert.equal(fs.existsSync(path.join(downloadDir, "app-video-track.mp4.aria2")), true);
    assert.equal(upgraded.manifest.bbdownCommit, BBDOWN_SOURCE_COMMIT);
  } finally {
    await removeTestDir(runtime);
  }
});

test("BBDown current release keeps historic Web resume tracks when runtime settings are unchanged", async () => {
  const runtime = await createTestDir("download-session-legacy-web-bbdown-upgrade");
  const downloadDir = path.join(runtime, "BV1LEGACYBBDOWN");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1LEGACYBBDOWN",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "web" }),
      pages,
    });
    const previous = readDownloadSession(downloadDir)!;
    previous.bbdownCommit = "fcb895f357df49c45010cefab773025d5d50cf7c";
    previous.configFingerprint = "legacy-bbdown";
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), previous);
    await fs.promises.writeFile(path.join(downloadDir, "legacy-track.mp4.aria2"), "resume");

    const upgraded = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1LEGACYBBDOWN",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "web" }),
      pages,
    });
    assert.equal(upgraded.incompatibleFragmentsMoved, 0);
    assert.equal(fs.existsSync(path.join(downloadDir, "legacy-track.mp4.aria2")), true);
    assert.equal(upgraded.manifest.bbdownCommit, BBDOWN_SOURCE_COMMIT);
  } finally {
    await removeTestDir(runtime);
  }
});

test("BBDown current release still isolates older APP resume tracks before redownload", async () => {
  const runtime = await createTestDir("download-session-app-bbdown-upgrade");
  const downloadDir = path.join(runtime, "BV1APPBBDOWNUPGRADE");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1APPBBDOWNUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "app" }),
      pages,
    });
    const previous = readDownloadSession(downloadDir)!;
    previous.bbdownCommit = "fd926373dfe03d68bf84a1ad8a4ffbf402b00988";
    previous.configFingerprint = "previous-bbdown";
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), previous);
    const rawTrackDir = path.join(downloadDir, "123456");
    await fs.promises.mkdir(rawTrackDir, { recursive: true });
    await fs.promises.writeFile(path.join(rawTrackDir, "123456.P1.101.mp4"), "old-app-video");
    await fs.promises.writeFile(path.join(rawTrackDir, "123456.P1.101.mp4.aria2"), "old-app-resume");

    const upgraded = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1APPBBDOWNUPGRADE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "app" }),
      pages,
    });
    assert.equal(upgraded.incompatibleFragmentsMoved, 2);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "123456.P1.101.mp4")), false);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "123456.P1.101.mp4.aria2")), false);
    assert.equal(upgraded.manifest.bbdownCommit, BBDOWN_SOURCE_COMMIT);
  } finally {
    await removeTestDir(runtime);
  }
});

test("legacy Web sessions migrate in place while switching to APP isolates raw fragments", async () => {
  const runtime = await createTestDir("download-session-api-mode");
  const downloadDir = path.join(runtime, "BV1APIMODE");
  const pages = [{ index: 1, cid: 101, title: "One", duration: 10 }];
  try {
    await prepareDownloadSession({
      downloadDir,
      bvid: "BV1APIMODE",
      accountUid: 1,
      config: testConfig(),
      pages,
    });
    const legacy = readDownloadSession(downloadDir)!;
    delete legacy.configSnapshot.apiMode;
    legacy.bbdownCommit = "259a5558cee0a349a7ebb60bd31e40c88e5bc1ed";
    legacy.configFingerprint = "legacy";
    writeJsonFile(path.join(downloadDir, ".bfb-download.json"), legacy);
    await fs.promises.writeFile(path.join(downloadDir, "web-track.mp4.aria2"), "resume");

    const web = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1APIMODE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "web" }),
      pages,
    });
    assert.equal(web.incompatibleFragmentsMoved, 0);
    assert.equal(fs.existsSync(path.join(downloadDir, "web-track.mp4.aria2")), true);
    assert.equal(web.manifest.configSnapshot.apiMode, "web");

    await fs.promises.writeFile(path.join(downloadDir, "app-track.m4a.aria2"), "resume");
    const app = await prepareDownloadSession({
      downloadDir,
      bvid: "BV1APIMODE",
      accountUid: 1,
      config: testConfig({ bbdownApiMode: "app" }),
      pages,
    });
    assert.equal(app.incompatibleFragmentsMoved, 2);
    assert.equal(fs.existsSync(path.join(downloadDir, "web-track.mp4.aria2")), false);
    assert.equal(fs.existsSync(path.join(downloadDir, "app-track.m4a.aria2")), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("recovery summary separates managed sessions from legacy fragments", async () => {
  const runtime = await createTestDir("download-session-summary");
  try {
    const managed = path.join(runtime, "BV1MANAGED");
    await prepareDownloadSession({
      downloadDir: managed,
      bvid: "BV1MANAGED",
      accountUid: 1,
      config: testConfig(),
      pages: [{ index: 1, cid: 1, title: "One", duration: 1 }],
    });
    await fs.promises.writeFile(path.join(managed, "track.mp4.aria2"), "resume");
    const legacy = path.join(runtime, "BV1LEGACY");
    await fs.promises.mkdir(legacy, { recursive: true });
    await fs.promises.writeFile(path.join(legacy, "00000_track.vclip"), Buffer.alloc(64));
    const quality = path.join(runtime, "quality-upgrade-session-BV1QUALITY");
    await prepareDownloadSession({
      downloadDir: quality,
      bvid: "BV1QUALITY",
      accountUid: 1,
      config: testConfig(),
      kind: "quality_upgrade",
      pages: [{ index: 1, cid: 2, title: "One", duration: 1 }],
    });
    await fs.promises.writeFile(path.join(quality, "track.m4a.aria2"), "resume");
    const summary = await inspectRecovery(runtime);
    assert.equal(summary.resumableSessions, 2);
    assert.equal(summary.legacyDirectories, 1);
    assert.equal(summary.cleanupEligibleBytes, 64);
  } finally {
    await removeTestDir(runtime);
  }
});

test("only deterministic aria2 resume incompatibilities reset the current track", async () => {
  const runtime = await createTestDir("aria2-track-reset");
  const downloadDir = path.join(runtime, "BV1ARIA2RESET");
  const rawTrackDir = path.join(downloadDir, "987654");
  try {
    await fs.promises.mkdir(rawTrackDir, { recursive: true });
    for (const name of [
      "987654.P1.101.mp4",
      "987654.P1.101.mp4.aria2",
      "987654.P1.101.m4a",
      "987654.P2.202.mp4",
      "987654.P2.202.mp4.aria2",
    ]) {
      await fs.promises.writeFile(path.join(rawTrackDir, name), name);
    }
    const transient = detectAria2TrackRecoveryIssue("开始下载P1视频... ECONNRESET");
    assert.equal(transient, null);
    const issue = detectAria2TrackRecoveryIssue("开始下载P1视频... HTTP 416 Range Not Satisfiable");
    assert.deepEqual(issue, { pageIndex: 1, track: "video", reason: "range" });
    assert.ok(issue);
    const moved = await quarantineBrokenAria2Track(downloadDir, issue);
    assert.equal(moved, 2);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "987654.P1.101.mp4")), false);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "987654.P1.101.m4a")), true);
    assert.equal(fs.existsSync(path.join(rawTrackDir, "987654.P2.202.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("download diagnostics redact signed URLs and credential values", () => {
  const sanitized = sanitizeDownloadDiagnosticText(
    "URI=https://example.test/video.m4s?token=secret&sign=abc Cookie: SESSDATA=private token=plain",
    ["private"]
  );
  assert.doesNotMatch(sanitized, /secret|sign=abc|private|token=plain/);
  assert.match(sanitized, /REDACTED/);
});

test("strict encoding retry stops before download when BBDown explicitly selects another codec", { timeout: 30_000 }, async () => {
  const runtime = await createTestDir("strict-encoding-early-stop");
  const downloadDir = path.join(runtime, "BVSTRICTEARLY");
  const fakeScript = path.join(runtime, "fake-bbdown-wrong-selection.mjs");
  const pidFile = path.join(runtime, "fake-bbdown.pid");
  try {
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[2], String(process.pid));
      console.log('开始解析P1');
      console.log('[视频] [4K 超清] [AVC] [1000 kbps]');
      setInterval(() => {}, 1000);
    `, "utf8");
    const error: any = await downloadWithBBDown(
      "BVSTRICTEARLY",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        expectedEncoding: "AV1",
        pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
        command: process.execPath,
        commandArgsPrefix: [fakeScript, pidFile],
      },
    ).then(() => null, (caught) => caught);
    assert.equal(error?.code, "BFB_ENCODING_SELECTED_MISMATCH");
    assert.equal(error?.source, "selected_stream");
    assert.equal(error?.encodingAssessment?.actualEncodings?.[0], "AVC");
    assert.equal(readDownloadSession(downloadDir)?.status, "failed");
    assert.equal(readDownloadSession(downloadDir)?.outputs.length, 0);
    assert.equal(isProcessAlive(Number(await fs.promises.readFile(pidFile, "utf8"))), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict quality retry stops before download when BBDown explicitly selects another tier", { timeout: 30_000 }, async () => {
  const runtime = await createTestDir("strict-quality-early-stop");
  const downloadDir = path.join(runtime, "BVSTRICTQUALITY");
  const fakeScript = path.join(runtime, "fake-bbdown-wrong-quality.mjs");
  try {
    await fs.promises.writeFile(fakeScript, `
      console.log('开始解析P1');
      console.log('[视频] [1080P 高清] [AV1] [1000 kbps]');
      setInterval(() => {}, 1000);
    `, "utf8");
    const error: any = await downloadWithBBDown(
      "BVSTRICTQUALITY",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        expectedQuality: "4K",
        pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
      },
    ).then(() => null, (caught) => caught);
    assert.equal(error?.code, "BFB_QUALITY_MISMATCH");
    assert.equal(error?.source, "selected_stream");
    assert.equal(error?.qualityAssessment?.actualQualities?.[0], "1080P");
    assert.equal(readDownloadSession(downloadDir)?.status, "failed");
    assert.equal(readDownloadSession(downloadDir)?.outputs.length, 0);
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict encoding retry uses ffprobe as the final gate and allows a matching codec", { timeout: 60_000 }, async () => {
  configureFfprobe();
  const runtime = await createTestDir("strict-encoding-ffprobe-gate");
  const fixture = path.join(runtime, "fixture.mp4");
  const fakeScript = path.join(runtime, "fake-bbdown-no-diagnostic.mjs");
  const previousFfprobe = process.env.FFPROBE_PATH;
  try {
    await createVideo(fixture, 2, "libx264");
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      const bvid = /video\\/(BV[0-9A-Za-z]+)/.exec(args[0])?.[1] || 'BVSTRICTFFPROBE';
      fs.copyFileSync(process.env.FAKE_MEDIA_SOURCE, path.join(process.cwd(), 'video-' + bvid + '.mp4'));
      console.log('任务完成');
    `, "utf8");
    const previousSource = process.env.FAKE_MEDIA_SOURCE;
    process.env.FAKE_MEDIA_SOURCE = fixture;
    try {
      const mismatchDir = path.join(runtime, "BVSTRICTFFPROBE-MISMATCH");
      const mismatch: any = await downloadWithBBDown(
        "BVSTRICTFFPROBE",
        { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
        testConfig(),
        {
          downloadDir: mismatchDir,
          expectedEncoding: "AV1",
          pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
          command: process.execPath,
          commandArgsPrefix: [fakeScript],
        },
      ).then(() => null, (caught) => caught);
      assert.equal(mismatch?.code, "BFB_ENCODING_MISMATCH");
      assert.equal(mismatch?.source, "ffprobe");
      assert.deepEqual(mismatch?.encodingAssessment?.actualEncodings, ["AVC"]);
      assert.equal(readDownloadSession(mismatchDir)?.status, "failed");
      assert.equal(readDownloadSession(mismatchDir)?.outputs.length, 1);

      const matchedDir = path.join(runtime, "BVSTRICTFFPROBE-MATCH");
      const matched = await downloadWithBBDown(
        "BVSTRICTFFPROBE",
        { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
        testConfig(),
        {
          downloadDir: matchedDir,
          expectedEncoding: "AVC",
          pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
          command: process.execPath,
          commandArgsPrefix: [fakeScript],
        },
      );
      assert.equal(matched.files.length, 1);
      assert.equal(readDownloadSession(matchedDir)?.status, "complete");
    } finally {
      if (previousSource === undefined) delete process.env.FAKE_MEDIA_SOURCE;
      else process.env.FAKE_MEDIA_SOURCE = previousSource;
    }
  } finally {
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = previousFfprobe;
    await removeTestDir(runtime);
  }
});

test("downloader invokes BBDown with aria2 once and reuses the verified session", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-fake-bbdown");
  const downloadDir = path.join(runtime, "BV1FAKEBBDOWN");
  const fixture = path.join(runtime, "fixture.mp4");
  const fakeScript = path.join(runtime, "fake-bbdown.mjs");
  const argsLog = path.join(runtime, "args.jsonl");
  try {
    await createVideo(fixture);
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + '\\n');
      if (args.includes('-app')) {
        const configPath = args[args.indexOf('--config-file') + 1];
        const config = fs.readFileSync(configPath, 'utf8');
        if (!/^--app-buvid XY[0-9a-f]{35}$/im.test(config)) throw new Error('missing stable app buvid');
      }
      const bvid = /video\\/(BV[0-9A-Za-z]+)/.exec(args[0])?.[1] || 'BV1FAKEBBDOWN';
      fs.copyFileSync(process.env.FAKE_MEDIA_SOURCE, path.join(process.cwd(), 'video-' + bvid + '.mp4'));
      console.log('[2026-07-11 00:00:00.000] - BFB_SIGNAL:PLAYURL_READY:' + (args.includes('-app') ? 'APP' : 'WEB'));
      console.log('[视频] [1080P 60帧] [HEVC] [4000 kbps] [~12 MB]');
      console.log('视频标题: [视频] [720P 高清] [AVC] [1000 kbps]');
      console.log('任务完成');
    `, "utf8");
    const previousSource = process.env.FAKE_MEDIA_SOURCE;
    const previousLog = process.env.FAKE_ARGS_LOG;
    process.env.FAKE_MEDIA_SOURCE = fixture;
    process.env.FAKE_ARGS_LOG = argsLog;
    try {
      const options = {
        downloadDir,
        pageSnapshot: {
          available: true,
          pages: [{ index: 1, cid: 501, title: "One", duration: 2 }],
        },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
      };
      const cookie = { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" };
      const readyModes: string[] = [];
      const first = await downloadWithBBDown("BV1FAKEBBDOWN", cookie, testConfig(), {
        ...options,
        onApiReady: (mode) => readyModes.push(mode),
      });
      assert.equal(first.files.length, 1);
      assert.deepEqual(readDownloadSession(downloadDir)?.selectedStreams?.map((item) => ({
        pageIndex: item.pageIndex,
        cid: item.cid,
        bilibiliQuality: item.bilibiliQuality,
      })), [{ pageIndex: 1, cid: 501, bilibiliQuality: "1080P60" }]);
      const second = await downloadWithBBDown("BV1FAKEBBDOWN", cookie, testConfig(), options);
      assert.equal(second.files.length, 1);
      const appResult = await downloadWithBBDown(
        "BV1FAKEAPP",
        { ...cookie, accessToken: "app-token", appBuvid: "XY0123456789abcdef0123456789abcdef012" },
        testConfig({ bbdownApiMode: "app" }),
        {
          ...options,
          downloadDir: path.join(runtime, "BV1FAKEAPP"),
          onApiReady: (mode) => readyModes.push(mode),
        }
      );
      assert.equal(appResult.files.length, 1);
      const invocations = (await fs.promises.readFile(argsLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0].includes("--use-aria2c"), true);
      assert.equal(invocations[0].includes("--select-page"), true);
      assert.equal(invocations[0].includes("-app"), false);
      assert.equal(invocations[1].includes("-app"), true);
      assert.deepEqual(readyModes, ["web", "app"]);
    } finally {
      if (previousSource === undefined) delete process.env.FAKE_MEDIA_SOURCE;
      else process.env.FAKE_MEDIA_SOURCE = previousSource;
      if (previousLog === undefined) delete process.env.FAKE_ARGS_LOG;
      else process.env.FAKE_ARGS_LOG = previousLog;
    }
  } finally {
    await removeTestDir(runtime);
  }
});

test("APP empty play response falls back to Web exactly once", async () => {
  configureFfprobe();
  const runtime = await createTestDir("download-session-app-web-fallback");
  const downloadDir = path.join(runtime, "BV1APPFALLBACK");
  const fixture = path.join(runtime, "fixture.mp4");
  const fakeScript = path.join(runtime, "fake-bbdown-app-fallback.mjs");
  const argsLog = path.join(runtime, "args.jsonl");
  const previousSource = process.env.FAKE_MEDIA_SOURCE;
  const previousLog = process.env.FAKE_ARGS_LOG;
  try {
    await createVideo(fixture);
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + '\\n');
      if (args.includes('-app')) {
        console.log('BFB_SIGNAL:APP_NO_VIDEO_INFO: APP play response had no video info');
        process.exitCode = 1;
      } else {
        fs.copyFileSync(process.env.FAKE_MEDIA_SOURCE, path.join(process.cwd(), 'video-BV1APPFALLBACK.mp4'));
        console.log('BFB_SIGNAL:PLAYURL_READY:WEB');
        console.log('任务完成');
      }
    `, "utf8");
    process.env.FAKE_MEDIA_SOURCE = fixture;
    process.env.FAKE_ARGS_LOG = argsLog;
    const readyModes: string[] = [];
    const result = await downloadWithBBDown(
      "BV1APPFALLBACK",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1", accessToken: "app-token" },
      testConfig({ bbdownApiMode: "app" }),
      {
        downloadDir,
        pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
        onApiReady: (mode) => readyModes.push(mode),
      }
    );
    assert.equal(result.files.length, 1);
    const invocations = (await fs.promises.readFile(argsLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].includes("-app"), true);
    assert.equal(invocations[1].includes("-app"), false);
    assert.equal(invocations[1].includes("--use-aria2c"), true);
    assert.equal(invocations[1].includes("--select-page"), true);
    assert.deepEqual(readyModes, ["web"]);
    assert.equal(fs.existsSync(path.join(runtime, "data", "debug")), false);
  } finally {
    if (previousSource === undefined) delete process.env.FAKE_MEDIA_SOURCE;
    else process.env.FAKE_MEDIA_SOURCE = previousSource;
    if (previousLog === undefined) delete process.env.FAKE_ARGS_LOG;
    else process.env.FAKE_ARGS_LOG = previousLog;
    await removeTestDir(runtime);
  }
});

test("voucher signal defers without exposing the marker or running a debug probe", async () => {
  const runtime = await createTestDir("download-session-voucher");
  const downloadDir = path.join(runtime, "BV1VOUCHER");
  const fakeScript = path.join(runtime, "fake-bbdown-voucher.mjs");
  const argsLog = path.join(runtime, "args.jsonl");
  const previousLog = process.env.FAKE_ARGS_LOG;
  try {
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
      console.error('[2026-07-11 00:00:00.000] - BFB_SIGNAL:RISK_V_VOUCHER');
    `, "utf8");
    process.env.FAKE_ARGS_LOG = argsLog;
    const error: any = await downloadWithBBDown(
      "BV1VOUCHER",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        pageSnapshot: { available: true, pages: [{ index: 1, cid: 1, title: "One", duration: 2 }] },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
      }
    ).then(() => null, (caught) => caught);
    assert.equal(error?.biliRiskControl, true);
    assert.equal(error?.deferToNextCycle, true);
    assert.doesNotMatch(String(error?.message || ""), /v_voucher/i);
    const invocations = (await fs.promises.readFile(argsLog, "utf8")).trim().split(/\r?\n/);
    assert.equal(invocations.length, 1);
    assert.equal(fs.existsSync(path.join(runtime, "data", "debug")), false);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_ARGS_LOG;
    else process.env.FAKE_ARGS_LOG = previousLog;
    await removeTestDir(runtime);
  }
});

test("downloader quarantines only the broken aria2 track before the next retry", async () => {
  const runtime = await createTestDir("download-session-fake-aria2-failure");
  const downloadDir = path.join(runtime, "BV1FAKEARIA2");
  const fakeScript = path.join(runtime, "fake-bbdown-failure.mjs");
  try {
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const raw = path.join(process.cwd(), '123456');
      fs.mkdirSync(raw, { recursive: true });
      fs.writeFileSync(path.join(raw, '123456.P1.501.mp4'), 'partial-video');
      fs.writeFileSync(path.join(raw, '123456.P1.501.mp4.aria2'), 'resume-control');
      fs.writeFileSync(path.join(raw, '123456.P1.501.m4a'), 'partial-audio');
      console.log('开始下载P1视频...');
      console.error('HTTP 416 Range Not Satisfiable');
      process.exit(1);
    `, "utf8");
    await assert.rejects(() => downloadWithBBDown(
      "BV1FAKEARIA2",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        pageSnapshot: {
          available: true,
          pages: [{ index: 1, cid: 501, title: "One", duration: 2 }],
        },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
      }
    ));
    assert.equal(fs.existsSync(path.join(downloadDir, "123456", "123456.P1.501.mp4")), false);
    assert.equal(fs.existsSync(path.join(downloadDir, "123456", "123456.P1.501.mp4.aria2")), false);
    assert.equal(fs.existsSync(path.join(downloadDir, "123456", "123456.P1.501.m4a")), true);
    const manifest = readDownloadSession(downloadDir);
    assert.equal(manifest?.status, "failed");
    assert.match(manifest?.lastError || "", /416/);
  } finally {
    await removeTestDir(runtime);
  }
});

test("Windows taskkill helper is bounded and reports success, failure, and timeout", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as any;
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }) as typeof spawn;
  const success = await runWindowsTaskkill(1234, true, { timeoutMs: 50, spawnImpl: fakeSpawn });
  assert.deepEqual(success, { ok: true, timedOut: false, code: 0 });
  assert.deepEqual(calls[0], { command: "taskkill", args: ["/PID", "1234", "/T", "/F"] });

  const nonzeroSpawn = (() => {
    const child = new EventEmitter() as any;
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", 128));
    return child;
  }) as typeof spawn;
  assert.deepEqual(
    await runWindowsTaskkill(9, false, { timeoutMs: 50, spawnImpl: nonzeroSpawn }),
    { ok: false, timedOut: false, code: 128 }
  );

  let killed = false;
  const hangingSpawn = (() => {
    const child = new EventEmitter() as any;
    child.kill = () => { killed = true; return true; };
    return child;
  }) as typeof spawn;
  const timedOut = await runWindowsTaskkill(10, false, { timeoutMs: 20, spawnImpl: hangingSpawn });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.ok, false);
  assert.equal(killed, true);

  const throwingSpawn = (() => { throw new Error("missing taskkill"); }) as typeof spawn;
  const failed = await runWindowsTaskkill(11, false, { timeoutMs: 20, spawnImpl: throwingSpawn });
  assert.equal(failed.ok, false);
  assert.match(failed.error || "", /missing taskkill/);
});

test("shutdown terminates the BBDown process tree", async () => {
  const runtime = await createTestDir("download-session-shutdown-tree");
  const downloadDir = path.join(runtime, "BV1SHUTDOWNTREE");
  const fakeScript = path.join(runtime, "fake-bbdown-tree.mjs");
  const childPidFile = path.join(runtime, "child.pid");
  const previousPidFile = process.env.FAKE_CHILD_PID_FILE;
  try {
    await fs.promises.writeFile(fakeScript, `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
      setInterval(() => {}, 1000);
    `, "utf8");
    process.env.FAKE_CHILD_PID_FILE = childPidFile;
    const downloadPromise = downloadWithBBDown(
      "BV1SHUTDOWNTREE",
      { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      testConfig(),
      {
        downloadDir,
        pageSnapshot: {
          available: true,
          pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
        },
        command: process.execPath,
        commandArgsPrefix: [fakeScript],
      }
    );
    const guardedDownload = downloadPromise.then(
      () => null,
      (error) => error as Error
    );
    for (let attempt = 0; attempt < 50 && !fs.existsSync(childPidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(childPidFile), true);
    const childPid = Number(await fs.promises.readFile(childPidFile, "utf8"));
    await shutdownActiveDownloads(2_000);
    assert.ok(await guardedDownload);
    await new Promise((resolve) => setTimeout(resolve, 100));
    let childAlive = true;
    try { process.kill(childPid, 0); } catch { childAlive = false; }
    assert.equal(childAlive, false);
  } finally {
    if (previousPidFile === undefined) delete process.env.FAKE_CHILD_PID_FILE;
    else process.env.FAKE_CHILD_PID_FILE = previousPidFile;
    await removeTestDir(runtime);
  }
});
