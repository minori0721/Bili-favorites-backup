import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { StateManager } from "../src/state.js";
import { MANUAL_ARCHIVE_MEDIA_ID, MANUAL_ARCHIVE_FOLDER_TITLE } from "../src/state.js";
import { SyncScheduler } from "../src/scheduler.js";
import { buildQualityArtifactKey } from "../src/quality-artifact.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("manual archive creates a schema 11 source without pretending to be a favorite folder", async () => {
  const runtime = await createTestDir("manual-archive");
  const manager = new StateManager({
    dbPath: path.join(runtime, "bfb.sqlite"),
    statePath: path.join(runtime, "missing.json"),
  });
  try {
    const result = manager.recordManualArchiveItem("u1", {
      bvid: "BV1MANUAL0001",
      title: "在线条目",
      upperName: "在线UP",
      cover: undefined,
    });
    assert.equal(result.relation?.sourceKind, "manual");
    assert.equal(result.relation?.mediaId, MANUAL_ARCHIVE_MEDIA_ID);
    assert.equal(result.relation?.folderTitle, MANUAL_ARCHIVE_FOLDER_TITLE);
    const row = manager.getDatabase().db.prepare(
      "SELECT source_kind, media_id, folder_title FROM favorite_relations WHERE user_id=? AND bvid=?",
    ).get("u1", "BV1MANUAL0001") as any;
    assert.deepEqual(row, { source_kind: "manual", media_id: -1, folder_title: MANUAL_ARCHIVE_FOLDER_TITLE });
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual archive exact quality and encoding use an isolated strict download job", async () => {
  const runtime = await createTestDir("manual-archive-exact");
  const manager = new StateManager({
    dbPath: path.join(runtime, "bfb.sqlite"),
    statePath: path.join(runtime, "missing.json"),
  });
  const now = new Date().toISOString();
  const user = {
    id: "u1", uid: 1, name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [], enabled: true, lastLoginAt: now,
  };
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BV1MANUALEXACT: { bvid: "BV1MANUALEXACT", title: "Exact", upperName: "UP", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "discovered" } },
    relations: {},
  } as any);
  const config = testConfig({ bbdownQuality: "4K", bbdownEncoding: "HEVC" });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : undefined } as any,
    manager,
    { legacyTempDir: path.join(runtime, "temp") },
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  try {
    const profile = { quality: "1080P", encoding: "AV1", hiRes: false, dolby: false, filenameTemplate: "<videoTitle>-<bvid>" };
    const result = scheduler.enqueueManualArchive("u1", {
      bvid: "BV1MANUALEXACT", title: "Exact", upperName: "UP",
      qualityProfile: profile, qualityStrict: true,
      qualityEncodingOverride: { generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true },
    });
    assert.equal(result.status, "queued");
    const job = scheduler.jobStore.findByDedupeKey(`download:BV1MANUALEXACT:manual:${buildQualityArtifactKey("BV1MANUALEXACT", profile)}`)!;
    assert.equal((job.payload as any).qualityStrict, true);
    assert.deepEqual((job.payload as any).qualityEncodingOverride.priority, ["AV1", "HEVC", "AVC"]);
    assert.equal((job.payload as any).qualityProfile.quality, "1080P");
    const task = scheduler.buildDownloadTask(job);
    assert.ok(task);
    assert.equal(task.config.bbdownQuality, "1080P");
    assert.equal(task.config.bbdownEncoding, "AV1");
    assert.equal(task.qualityStrict, true);
    assert.equal(typeof task.downloadDirOverride, "string");
    assert.equal(task.downloadDirOverride.includes("BV1MANUALEXACT"), true);
    const duplicate = scheduler.enqueueManualArchive("u1", {
      bvid: "BV1MANUALEXACT", title: "Exact", upperName: "UP",
      qualityProfile: profile, qualityStrict: true,
      qualityEncodingOverride: { generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true },
    });
    assert.equal(duplicate.status, "already_pending");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("strict regular download recovery keeps the candidate isolated when changing quality or encoding", async () => {
  const runtime = await createTestDir("strict-download-recovery");
  const manager = new StateManager({
    dbPath: path.join(runtime, "bfb.sqlite"),
    statePath: path.join(runtime, "missing.json"),
  });
  const now = new Date().toISOString();
  const user = {
    id: "u1", uid: 1, name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Fav" }], enabled: true, lastLoginAt: now,
  };
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BVSTRICTRECOVERY: { bvid: "BVSTRICTRECOVERY", title: "Strict recovery", upperName: "UP", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "failed" } },
    relations: {
      "u1:1:BVSTRICTRECOVERY": {
        userId: "u1", mediaId: 1, bvid: "BVSTRICTRECOVERY", folderTitle: "Fav", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "failed",
      },
    },
  } as any);
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ bbdownQuality: "4K", bbdownEncoding: "HEVC" }) } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager,
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  try {
    const failed = scheduler.jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVSTRICTRECOVERY:manual:old-artifact",
      bvid: "BVSTRICTRECOVERY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        bvid: "BVSTRICTRECOVERY",
        qualityProfile: { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false, filenameTemplate: "<videoTitle>-<bvid>" },
        qualityStrict: true,
        qualityEncodingOverride: { generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true },
        qualityArtifactKey: "old-artifact",
        downloadUserId: "u1",
        awaitingManualRecovery: true,
        downloadRecovery: {
          category: "tool",
          summary: "请求 AV1，但实际只得到 AVC；未上传候选。",
          targets: [{ userId: "u1", mediaId: 1 }],
          downloadUserId: "u1",
        },
        qualityFailure: {
          category: "tool",
          requestedQuality: "4K",
          actualQualities: ["1080P"],
          qualityMismatch: true,
          qualityEligible: true,
          requestedEncoding: "AV1",
          actualEncodings: ["AVC"],
          encodingMismatch: true,
          encodingEligible: true,
          verifiedPages: 1,
        },
      },
    });
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `download.${failed.id}`);
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), [
      "redownload_with_encoding", "retry_download", "defer_download", "abandon_attempt",
    ]);
    assert.deepEqual(issue?.availableActions[0].mediaProfile, { quality: true, encoding: true });

    const changed = await scheduler.resolveRecoveryIssue(`download.${failed.id}`, "redownload_with_encoding", {
      quality: "1080P",
      encodingPriority: ["AV1", "HEVC", "AVC"],
      strict: true,
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const resumed = scheduler.jobStore.findById(failed.id)!;
    assert.ok(["pending", "leased"].includes(resumed.status));
    assert.equal((resumed.payload as any).qualityProfile.quality, "1080P");
    assert.equal((resumed.payload as any).qualityProfile.encoding, "AV1");
    assert.deepEqual((resumed.payload as any).qualityEncodingOverride.priority, ["AV1", "HEVC", "AVC"]);
    assert.equal((resumed.payload as any).qualityStrict, true);
    assert.equal((resumed.payload as any).awaitingManualRecovery, false);
    assert.notEqual((resumed.payload as any).qualityArtifactKey, "old-artifact");
    assert.equal((resumed.payload as any).downloadDir, undefined);
    assert.equal(scheduler.jobStore.list(["download"]).filter((candidate) => candidate.bvid === "BVSTRICTRECOVERY").length, 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});
