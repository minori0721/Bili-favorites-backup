import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("eligible quality failures restart as one isolated strict quality and encoding artifact", async () => {
  const runtime = await createTestDir("quality-encoding-recovery");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  const now = new Date().toISOString();
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BVQUALITY: { bvid: "BVQUALITY", title: "Quality", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "verified" } },
    relations: {
      "u1:1:BVQUALITY": {
        userId: "u1", mediaId: 1, bvid: "BVQUALITY", folderTitle: "Fav", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "verified", remotePath: "/backup/BVQUALITY",
        remoteFiles: [{ name: "old.mp4", path: "/backup/BVQUALITY/old.mp4", size: 100, verificationStatus: "verified" }],
      },
    },
  } as any);
  const user = { id: "u1", uid: 1, name: "Tester", cookie: { SESSDATA: "a", bili_jct: "a", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Fav" }], enabled: true, lastLoginAt: now };
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ bbdownQuality: "4K" }) } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager,
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  try {
    const profile = { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false, filenameTemplate: "<videoTitle>-<bvid>" };
    const target = {
      userId: "u1", mediaId: 1, folderTitle: "Fav", remotePath: "/backup/BVQUALITY",
      oldFiles: [{ name: "old.mp4", path: "/backup/BVQUALITY/old.mp4", size: 100, verificationStatus: "verified" }],
    };
    const failed = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:BVQUALITY:old-artifact",
      bvid: "BVQUALITY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        bvid: "BVQUALITY", artifactKey: "old-artifact", qualityProfile: profile,
        target, targets: [target], downloadUserId: "u1", awaitingManualRecovery: true,
        qualityFailure: {
          stage: "download",
          category: "unknown",
          summary: "requested media profile unavailable",
          requestedQuality: "4K",
          requestedEncoding: "HEVC",
          encodingEligible: true,
          qualityEligible: true,
        },
      },
    });
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `quality.${failed.id}`);
    assert.deepEqual(issue.availableActions.map((action: any) => action.id), ["retry_quality_with_encoding", "retry_quality"]);
    assert.deepEqual(issue.availableActions[0].mediaProfile, { quality: true, encoding: true });

    const result = await scheduler.resolveRecoveryIssue(`quality.${failed.id}`, "retry_quality_with_encoding", {
      quality: "1080P",
      encodingPriority: ["AV1", "HEVC", "AVC"],
      strict: true,
    });
    assert.equal(result.ok, true);
    assert.equal(scheduler.jobStore.findById(failed.id), null);
    const replacement = scheduler.jobStore.findById(result.jobId);
    assert.ok(replacement);
    assert.notEqual((replacement.payload as any).artifactKey, "old-artifact");
    assert.equal((replacement.payload as any).qualityProfile.quality, "1080P");
    assert.equal((replacement.payload as any).qualityProfile.encoding, "AV1");
    assert.deepEqual((replacement.payload as any).qualityEncodingOverride.priority, ["AV1", "HEVC", "AVC"]);
    assert.equal((replacement.payload as any).qualityStageLabel, "等待按 1080P / AV1（仅此组合）下载新版");
    assert.equal((replacement.payload as any).downloadDir, undefined);
    assert.equal((replacement.payload as any).stageRemotePath, undefined);

    const control = scheduler.buildQualityUpgradeTask(replacement);
    let selectedEncoding = "";
    let selectedQuality = "";
    control.downloadRunner = async (_bvid: string, _cookie: any, config: any) => {
      selectedEncoding = config.bbdownEncoding;
      selectedQuality = config.bbdownQuality;
      return { downloadDir: path.join(runtime, "new-candidate"), files: [] };
    };
    await control.runDownloadPhase("test-run");
    assert.equal(selectedEncoding, "AV1");
    assert.equal(selectedQuality, "1080P");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("replace and cleanup failures never offer a new encoding artifact", async () => {
  const runtime = await createTestDir("quality-encoding-blocked");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => null } as any,
    manager,
  ) as any;
  scheduler.dispatchPersistentJobs = () => {};
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "quality_replace",
      dedupeKey: "quality-replace:blocked",
      bvid: "BVBLOCKED",
      initialStatus: "manual_wait",
      payload: { awaitingManualRecovery: true, qualityFailure: { stage: "replace", encodingEligible: true } },
    });
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `quality.${job.id}`);
    assert.deepEqual(issue.availableActions.map((action: any) => action.id), ["retry_quality"]);
    const retried = await scheduler.resolveRecoveryIssue(`quality.${job.id}`, "retry_quality");
    assert.equal(retried.ok, true);
    const resumed = scheduler.jobStore.findById(job.id)!;
    assert.equal(resumed.status, "pending");
    assert.equal((resumed.payload as any).awaitingManualRecovery, false);
    assert.equal(scheduler.getRecoveryIssues().some((item: any) => item.id === `quality.${job.id}`), false);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("quality recovery can restart an isolated strict resolution artifact", async () => {
  const runtime = await createTestDir("quality-resolution-recovery");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  const now = new Date().toISOString();
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BVQUALITY2: { bvid: "BVQUALITY2", title: "Quality 2", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "verified" } },
    relations: {
      "u1:1:BVQUALITY2": {
        userId: "u1", mediaId: 1, bvid: "BVQUALITY2", folderTitle: "Fav", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "verified", remotePath: "/backup/BVQUALITY2",
        remoteFiles: [{ name: "old.mp4", path: "/backup/BVQUALITY2/old.mp4", size: 100, verificationStatus: "verified" }],
      },
    },
  } as any);
  const user = { id: "u1", uid: 1, name: "Tester", cookie: { SESSDATA: "a", bili_jct: "a", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Fav" }], enabled: true, lastLoginAt: now };
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ bbdownQuality: "4K" }) } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager,
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  try {
    const target = {
      userId: "u1", mediaId: 1, folderTitle: "Fav", remotePath: "/backup/BVQUALITY2",
      oldFiles: [{ name: "old.mp4", path: "/backup/BVQUALITY2/old.mp4", size: 100, verificationStatus: "verified" }],
    };
    const failed = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:BVQUALITY2:old-artifact",
      bvid: "BVQUALITY2",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        bvid: "BVQUALITY2", artifactKey: "old-artifact",
        qualityProfile: { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false, filenameTemplate: "<videoTitle>-<bvid>" },
        target, targets: [target], downloadUserId: "u1", awaitingManualRecovery: true,
        qualityFailure: { stage: "download", category: "tool", summary: "请求画质不可用", qualityEligible: true },
      },
    });
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `quality.${failed.id}`);
    assert.equal(issue.availableActions[0].id, "retry_quality_with_quality");
    const result = await scheduler.resolveRecoveryIssue(`quality.${failed.id}`, "retry_quality_with_quality", { quality: "1080P" });
    assert.equal(result.ok, true);
    const replacement = scheduler.jobStore.findById(result.jobId);
    assert.ok(replacement);
    assert.equal((replacement.payload as any).qualityProfile.quality, "1080P");
    assert.equal((replacement.payload as any).qualityStrict, true);
    assert.equal((replacement.payload as any).qualityStageLabel, "等待按 1080P（仅此画质）下载新版");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});
