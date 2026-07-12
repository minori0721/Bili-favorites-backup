import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";
import { createZipFromSources, extractZipFile } from "../src/zip.js";
import { sanitizeDiagnosticText } from "../src/diagnostics.js";
import { batchRenameRemotePaths } from "../src/uploader.js";
import { StateManager } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { renderArchivedFilename } from "../src/filename.js";
import { extractMigrationPackageFile } from "../src/migration.js";

test("streaming zip extracts valid data and rejects excessive compression ratios", async () => {
  const runtime = await createTestDir("streaming-zip");
  try {
    const source = path.join(runtime, "source");
    const output = path.join(runtime, "archive.zip");
    const extracted = path.join(runtime, "extracted");
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(path.join(source, "sample.bin"), Buffer.alloc(256 * 1024, 7));
    await createZipFromSources([{ root: source, prefix: "temp" }], output);
    const result = await extractZipFile(output, extracted, {
      maxEntries: 10,
      maxExpandedBytes: 1024 * 1024,
      maxCompressionRatio: 1000,
    });
    assert.deepEqual(result.files, ["temp/sample.bin"]);
    assert.equal((await fs.promises.stat(path.join(extracted, "temp", "sample.bin"))).size, 256 * 1024);
    await assert.rejects(
      extractZipFile(output, path.join(runtime, "rejected"), {
        maxEntries: 10,
        maxExpandedBytes: 1024 * 1024,
        maxCompressionRatio: 2,
      }),
      /压缩比/
    );
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 3 migration rejects allowed files missing from its checksum manifest", async () => {
  const runtime = await createTestDir("migration-unlisted-file");
  try {
    const source = path.join(runtime, "source");
    await fs.promises.mkdir(path.join(source, "data"), { recursive: true });
    const config = Buffer.from('{"ok":true}');
    await fs.promises.writeFile(path.join(source, "data", "config.json"), config);
    await fs.promises.writeFile(path.join(source, "data", "users.json"), "[]");
    await fs.promises.writeFile(path.join(source, "checksums.json"), JSON.stringify({
      "data/config.json": { size: config.length, sha256: crypto.createHash("sha256").update(config).digest("hex") },
    }));
    await fs.promises.writeFile(path.join(source, "manifest.json"), JSON.stringify({
      schema: 3, app: "Bili-favorites-backup", version: "2.4.0", exportedAt: new Date().toISOString(),
      mode: "lightweight", includes: {}, counts: {}, warning: "test",
    }));
    const archive = path.join(runtime, "migration.zip");
    await createZipFromSources([{ root: source, prefix: false }], archive);
    await assert.rejects(extractMigrationPackageFile(archive), /校验清单不一致/);
  } finally {
    await removeTestDir(runtime);
  }
});

test("diagnostic sanitizer removes headers, json secrets, query tokens and URL credentials", () => {
  const input = 'Authorization: Bearer abc Cookie=SESSDATA=secret https://user:pass@example.com/a?access_token=xyz {"password":"pw","ok":"visible"}';
  const output = sanitizeDiagnosticText(input);
  assert.doesNotMatch(output, /abc|secret|user:pass|xyz|"pw"/);
  assert.match(output, /visible/);
});

test("batch rename stages all paths and rolls back when a MOVE fails", async () => {
  const moves: Array<[string, string]> = [];
  const client = {
    async moveFile(from: string, to: string) {
      moves.push([from, to]);
      if (to === "/target/b.mp4") throw new Error("MOVE rejected");
    },
  } as any;
  const result = await batchRenameRemotePaths(testConfig(), [
    { oldPath: "/target/a-old.mp4", newPath: "/target/a.mp4" },
    { oldPath: "/target/b-old.mp4", newPath: "/target/b.mp4" },
  ], client);
  assert.equal(result.success, 0);
  assert.equal(result.failed, 2);
  assert.equal(moves.some(([from, to]) => from === "/target/a.mp4" && to === "/target/a-old.mp4"), true);
});

test("archived filename rendering preserves multi-page identity and never invents metadata", () => {
  const record = { bvid: "BV1TEST", title: "Title", upperName: "UP" };
  const metadata = { publishDate: new Date(2024, 0, 2, 3, 4, 5).getTime(), videoDate: new Date(2024, 0, 3, 4, 5, 6).getTime(), dfn: "4K", videoCodecs: "HEVC", pageIndex: 2 };
  const rendered = renderArchivedFilename("<publishDate>-<videoDate>-<dfn>-<videoCodecs>-<bvid>", record, metadata, 2, true);
  assert.match(rendered.name, /2024-01-02_03-04-05-2024-01-03_04-05-06-4K-HEVC-BV1TEST_P2/);
  assert.match(renderArchivedFilename("<publishDate>-<bvid>", record, undefined).reason, /缺少视频发布日期/);
  assert.match(renderArchivedFilename("<bvid>", record, undefined, undefined, true).reason, /分P序号/);
});

test("schema 13 finds only active unbacked permanent failures for access classification", async () => {
  const runtime = await createTestDir("legacy-access-classification");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const now = new Date().toISOString();
    manager.replaceStateSnapshot({
      schemaVersion: 12,
      processedByUser: {},
      failedByUser: { u1: { "1:BVLEGACY": { bvid: "BVLEGACY", mediaId: 1, failedAt: now, reason: "old", permanent: true } } },
      videos: { BVLEGACY: { bvid: "BVLEGACY", title: "legacy", upperName: "up", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "failed" } },
      relations: { "u1:1:BVLEGACY": { userId: "u1", mediaId: 1, bvid: "BVLEGACY", folderTitle: "fav", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "failed" } },
      folderScans: {}, userCooldowns: {},
    } as any);
    const candidates = manager.listLegacyFailureClassificationCandidates();
    assert.equal(candidates.length, 1);
    manager.markLegacyAccessClassification("BVLEGACY", { result: "available", classifiedAt: now });
    assert.equal(manager.listLegacyFailureClassificationCandidates().length, 0);
    assert.equal(manager.getRelationStatus("u1", 1, "BVLEGACY")?.backupStatus, "discovered");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("canceling a user removes credential-dependent jobs without deleting upload jobs", async () => {
  const runtime = await createTestDir("cancel-user-jobs");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    jobs.enqueue({ kind: "download", dedupeKey: "download:one", bvid: "BV1", payload: { primaryUserId: "u1" } });
    jobs.enqueue({ kind: "quality_download", dedupeKey: "quality:one", bvid: "BV2", userId: "u1" });
    jobs.enqueue({ kind: "upload", dedupeKey: "upload:one", bvid: "BV3", userId: "u1" });
    assert.equal(jobs.cancelUserDependentJobs("u1"), 2);
    assert.equal(jobs.findByDedupeKey("upload:one")?.kind, "upload");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("detaching an account preserves video and remote proof while deactivating its relations", async () => {
  const runtime = await createTestDir("detach-user-relations");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const now = "2026-07-12T08:00:00.000Z";
    manager.replaceStateSnapshot({
      schemaVersion: 13,
      processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: {
        BVDETACHED: {
          bvid: "BVDETACHED", title: "Preserved", upperName: "UP", firstSeenAt: now, lastSeenAt: now,
          biliStatus: "available", backupStatus: "verified", remotePath: "/backup/BVDETACHED",
          remoteFiles: [{ name: "video.mp4", path: "/backup/BVDETACHED/video.mp4", size: 42, verificationStatus: "verified" }],
        },
      },
      relations: {
        "u1:1:BVDETACHED": {
          userId: "u1", mediaId: 1, bvid: "BVDETACHED", folderTitle: "One",
          firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "verified",
          remotePath: "/backup/BVDETACHED",
          remoteFiles: [{ name: "video.mp4", path: "/backup/BVDETACHED/video.mp4", size: 42, verificationStatus: "verified" }],
        },
      },
    } as any);
    assert.equal(manager.detachUserRelations("u1", now), 1);
    const relation = manager.getRelationStatus("u1", 1, "BVDETACHED");
    assert.equal(relation?.activeInFavorite, false);
    assert.equal(relation?.accountDetachedAt, now);
    assert.equal(relation?.remoteFiles?.[0].path, "/backup/BVDETACHED/video.mp4");
    assert.equal(manager.getDatabase().getVideo("BVDETACHED")?.remotePath, "/backup/BVDETACHED");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});
