import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { PersistentJobStore } from "../src/job-store.js";
import { LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER } from "../src/database.js";
import {
  buildQualityArtifactKey,
  qualityArtifactProfileFromConfig,
} from "../src/quality-artifact.js";
import { writeDownloadSession, type DownloadOutputRecord, type DownloadSessionManifest } from "../src/download-session.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { QualityUpgradeDownloadTask, QualityUpgradeTask, type QualityUpgradeTarget } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

function target(userId: string, mediaId: number): QualityUpgradeTarget {
  return {
    userId,
    mediaId,
    folderTitle: `Favorites ${mediaId}`,
    remotePath: `/backup/${userId}/${mediaId}`,
    oldFiles: [{
      name: "old.mp4",
      path: `/backup/${userId}/${mediaId}/old.mp4`,
      size: 10,
      verificationStatus: "verified",
    }],
  };
}

function user(id: string, uid: number) {
  return {
    id,
    uid,
    name: id,
    enabled: true,
    cookie: { SESSDATA: id, bili_jct: id, DedeUserID: String(uid) },
    accessToken: `${id}-token`,
    favorites: [],
    lastLoginAt: "",
  };
}

function qualityMetadataOutput(overrides: Partial<DownloadOutputRecord> = {}): DownloadOutputRecord {
  return {
    pageIndex: 1,
    cid: 501,
    relativePath: "new.mp4",
    size: 1024,
    duration: 30,
    videoCodec: "hevc",
    width: 1080,
    height: 1920,
    frameRate: 60,
    quickHash: "quick-hash",
    verifiedAt: "2026-07-29T00:00:02.000Z",
    ...overrides,
  };
}

function writeQualityMetadataSession(downloadDir: string, overrides: Partial<DownloadSessionManifest> = {}) {
  writeDownloadSession(downloadDir, {
    schemaVersion: 1,
    sessionId: "quality-metadata-session",
    kind: "quality_upgrade",
    bvid: "BVQUALITYMETADATA",
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
    pages: [{ index: 1, cid: 501, title: "P1", duration: 30 }],
    selectedStreams: [{
      pageIndex: 1,
      cid: 501,
      bilibiliQuality: "1080P60",
      observedAt: "2026-07-29T00:00:01.000Z",
    }],
    outputs: [qualityMetadataOutput()],
    history: [],
    ...overrides,
  });
}

test("artifact identity ignores API mode but separates output-affecting profiles", () => {
  const web = testConfig({ bbdownApiMode: "web", bbdownQuality: "1080P", bbdownEncoding: "HEVC" });
  const app = testConfig({ bbdownApiMode: "app", bbdownQuality: "1080P", bbdownEncoding: "HEVC" });
  const otherQuality = testConfig({ bbdownApiMode: "web", bbdownQuality: "4K", bbdownEncoding: "HEVC" });
  const otherTemplate = testConfig({ bbdownApiMode: "web", bbdownQuality: "1080P", bbdownEncoding: "HEVC", filenameTemplate: "<bvid>-<dfn>" });
  const webKey = buildQualityArtifactKey("BVSHARED", qualityArtifactProfileFromConfig(web));
  assert.equal(buildQualityArtifactKey("BVSHARED", qualityArtifactProfileFromConfig(app)), webKey);
  assert.notEqual(buildQualityArtifactKey("BVSHARED", qualityArtifactProfileFromConfig(otherQuality)), webKey);
  assert.notEqual(buildQualityArtifactKey("BVSHARED", qualityArtifactProfileFromConfig(otherTemplate)), webKey);
});

test("three targets share one quality download and fan out after a running target merge", async () => {
  const runtime = await createTestDir("quality-shared-download");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2), user("u3", 3)];
  const config = testConfig({ bbdownQuality: "1080P", bbdownEncoding: "HEVC" });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager
  ) as any;
  try {
    scheduler.downloadQueue.setStartGate(() => false);
    scheduler.uploadQueue.setStartGate(() => false);
    const controls = users.map((item, index) => {
      const control = new QualityUpgradeTask("BVSHARED", item.cookie, config, target(item.id, index + 1));
      control.downloadUserId = item.id;
      control.userId = item.id;
      return control;
    });
    assert.equal(scheduler.enqueueQualityUpgrade(controls[0]), true);
    const phase = scheduler.downloadQueue.getTasks()[0];
    assert.ok(phase);
    assert.equal(scheduler.enqueueQualityUpgrade(controls[1]), true);
    assert.equal(scheduler.enqueueQualityUpgrade(controls[2]), true);
    assert.equal(scheduler.jobStore.countOutstanding(["quality_download"]), 1);
    assert.equal(scheduler.downloadQueue.getSize(), 1);
    assert.equal(phase.control.targets.length, 3);
    assert.equal(phase.detail, "等待下载新版 · 3个目标");

    let invocations = 0;
    phase.control.downloadRunner = async (_bvid: string, _cookie: any, frozenConfig: any) => {
      invocations += 1;
      assert.equal(frozenConfig.bbdownQuality, "1080P");
      assert.equal(frozenConfig.bbdownEncoding, "HEVC");
      return {
        downloadDir: path.join(runtime, "artifact"),
        files: ["video.mp4"],
        recoveredPages: 1,
        totalPages: 1,
        partial: false,
      };
    };
    await phase.run();
    assert.equal(invocations, 1);
    scheduler.downloadQueue.queue.splice(0);
    scheduler.downloadQueue.emit("taskCompleted", phase);
    const uploads = scheduler.jobStore.list(["quality_upload"]);
    assert.equal(uploads.length, 3);
    assert.deepEqual(new Set(uploads.map((job: any) => `${job.userId}:${job.mediaId}`)), new Set(["u1:1", "u2:2", "u3:3"]));
    assert.ok(uploads.every((job: any) => job.payload.artifactKey === controls[0].artifactKey));
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("different quality profiles keep independent jobs and artifact cleanup counts", async () => {
  const runtime = await createTestDir("quality-profile-isolation");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2)];
  const config1080 = testConfig({ bbdownQuality: "1080P" });
  const config4k = testConfig({ bbdownQuality: "4K" });
  const scheduler = new SyncScheduler(
    { get: () => config1080 } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager
  ) as any;
  try {
    scheduler.downloadQueue.setStartGate(() => false);
    const first = new QualityUpgradeTask("BVPROFILES", users[0].cookie, config1080, target("u1", 1));
    const second = new QualityUpgradeTask("BVPROFILES", users[1].cookie, config4k, target("u2", 2));
    assert.equal(scheduler.enqueueQualityUpgrade(first), true);
    assert.equal(scheduler.enqueueQualityUpgrade(second), true);
    assert.notEqual(first.artifactKey, second.artifactKey);
    assert.equal(scheduler.jobStore.countOutstanding(["quality_download"]), 2);
    assert.equal(scheduler.jobStore.countQualityJobsForArtifact(first.artifactKey), 1);
    assert.equal(scheduler.jobStore.countQualityJobsForArtifact(second.artifactKey), 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy per-target quality downloads merge without shortening retry time", async () => {
  const runtime = await createTestDir("quality-legacy-merge");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2)];
  const config = testConfig({ bbdownQuality: "1080P" });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager
  ) as any;
  const now = Date.now();
  try {
    scheduler.beginShutdown();
    const first = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:u1:1:BVLEGACY",
      bvid: "BVLEGACY",
      userId: "u1",
      mediaId: 1,
      notBefore: now + 10_000,
      payload: { bvid: "BVLEGACY", downloadUserId: "u1", target: target("u1", 1) },
    });
    const second = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:u2:2:BVLEGACY",
      bvid: "BVLEGACY",
      userId: "u2",
      mediaId: 2,
      notBefore: now + 60_000,
      payload: { bvid: "BVLEGACY", downloadUserId: "u2", target: target("u2", 2) },
    });
    manager.getDatabase().db.prepare("UPDATE jobs SET attempts=1, status='retry_wait' WHERE id=?").run(first.id);
    manager.getDatabase().db.prepare("UPDATE jobs SET attempts=2, status='retry_wait' WHERE id=?").run(second.id);
    assert.equal(scheduler.migrateLegacyQualityDownloadJobs(), 2);
    const [merged] = scheduler.jobStore.list(["quality_download"]);
    assert.ok(merged.dedupeKey.startsWith("quality-download:BVLEGACY:"));
    assert.equal(merged.attempts, 2);
    assert.equal(merged.notBefore, now + 60_000);
    assert.equal(merged.payload.targets.length, 2);
    assert.ok(merged.payload.artifactKey);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), "complete");
    scheduler.jobStore.countLegacyQualityDownloadJobs = () => {
      throw new Error("completed migration must not query jobs");
    };
    assert.equal(scheduler.migrateLegacyQualityDownloadJobs(), 0);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy quality migration enforces its safety limit without listing or marking jobs", async () => {
  const runtime = await createTestDir("quality-legacy-limit");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => null } as any,
    manager
  ) as any;
  try {
    scheduler.beginShutdown();
    scheduler.jobStore.countLegacyQualityDownloadJobs = () => 100_001;
    scheduler.jobStore.listLegacyQualityDownloadJobs = () => {
      throw new Error("over-limit migration must not list jobs");
    };
    assert.equal(scheduler.migrateLegacyQualityDownloadJobs(), 0);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a database with only shared quality jobs marks legacy migration complete without changing them", async () => {
  const runtime = await createTestDir("quality-legacy-empty");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => null } as any,
    manager
  ) as any;
  try {
    scheduler.beginShutdown();
    const shared = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:BVSHAREDONLY:artifact",
      bvid: "BVSHAREDONLY",
      payload: {
        bvid: "BVSHAREDONLY",
        artifactKey: "artifact",
        targets: [target("u1", 1)],
      },
    });
    assert.equal(scheduler.migrateLegacyQualityDownloadJobs(), 0);
    assert.equal(scheduler.jobStore.findById(shared.id)?.dedupeKey, shared.dedupeKey);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), "complete");
    scheduler.jobStore.countLegacyQualityDownloadJobs = () => {
      throw new Error("completed empty migration must not query jobs");
    };
    assert.equal(scheduler.migrateLegacyQualityDownloadJobs(), 0);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy quality migration leaves its marker absent when a candidate has no BVID", async () => {
  const runtime = await createTestDir("quality-legacy-missing-bvid");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => null } as any,
    manager
  ) as any;
  try {
    scheduler.beginShutdown();
    const legacy = scheduler.jobStore.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:missing-bvid",
      payload: { target: target("u1", 1) },
    });
    assert.throws(() => scheduler.migrateLegacyQualityDownloadJobs(), /missing its BVID/);
    assert.ok(scheduler.jobStore.findById(legacy.id));
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy quality migration rolls back all replacements before writing its marker", async () => {
  const runtime = await createTestDir("quality-legacy-rollback");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    const first = jobs.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:u1:1:BVROLLBACK1",
      bvid: "BVROLLBACK1",
      payload: { bvid: "BVROLLBACK1", target: target("u1", 1) },
    });
    const second = jobs.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:u2:2:BVROLLBACK2",
      bvid: "BVROLLBACK2",
      payload: { bvid: "BVROLLBACK2", target: target("u2", 2) },
    });
    assert.throws(() => jobs.applyQualityDownloadMigration([
      {
        jobs: [first],
        replacement: {
          kind: "quality_download",
          dedupeKey: "quality-download:BVROLLBACK1:artifact",
          bvid: "BVROLLBACK1",
          payload: { artifactKey: "artifact", targets: [target("u1", 1)] },
        },
      },
      {
        jobs: [second],
        replacement: {
          kind: "download",
          dedupeKey: "invalid",
          bvid: "BVROLLBACK2",
        },
      },
    ], LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER));
    assert.ok(jobs.findById(first.id));
    assert.ok(jobs.findById(second.id));
    assert.equal(jobs.findByDedupeKey("quality-download:BVROLLBACK1:artifact"), null);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a failed target stays persisted and cannot release another artifact", async () => {
  const runtime = await createTestDir("quality-failed-target");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    const artifactKey = "artifact-a";
    const failed = jobs.enqueue({
      kind: "quality_upload",
      dedupeKey: "quality-upload:u1:1:BVFAIL",
      bvid: "BVFAIL",
      userId: "u1",
      mediaId: 1,
      maxAttempts: 1,
      payload: { artifactKey, target: target("u1", 1) },
    });
    jobs.enqueue({
      kind: "quality_cleanup",
      dedupeKey: "quality-cleanup:u2:2:BVFAIL",
      bvid: "BVFAIL",
      userId: "u2",
      mediaId: 2,
      payload: { artifactKey, target: target("u2", 2) },
    });
    jobs.enqueue({
      kind: "quality_cleanup",
      dedupeKey: "quality-cleanup:u3:3:BVFAIL",
      bvid: "BVFAIL",
      userId: "u3",
      mediaId: 3,
      payload: { artifactKey: "artifact-b", target: target("u3", 3) },
    });
    const claimed = jobs.claimDue(["quality_upload"], 1, "owner")[0];
    assert.equal(claimed.id, failed.id);
    const retry = jobs.retry(failed.id, "owner", "upload failed", Date.now() + 60_000);
    assert.equal(retry.exhausted, true);
    assert.equal(jobs.findById(failed.id)?.status, "failed");
    assert.equal(jobs.countQualityJobsForArtifact(artifactKey), 2);
    assert.equal(jobs.countQualityJobsForArtifact("artifact-b"), 1);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("quality cleanup locks the artifact against a concurrent new download", async () => {
  const runtime = await createTestDir("quality-cleanup-lock");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2)];
  const config = testConfig({ bbdownQuality: "1080P" });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager
  ) as any;
  try {
    scheduler.beginShutdown();
    const artifactKey = buildQualityArtifactKey("BVCLEANLOCK", qualityArtifactProfileFromConfig(config));
    const cleanupJob = scheduler.jobStore.enqueue({
      kind: "quality_cleanup",
      dedupeKey: "quality-cleanup:u1:1:BVCLEANLOCK",
      bvid: "BVCLEANLOCK",
      userId: "u1",
      mediaId: 1,
      payload: {
        bvid: "BVCLEANLOCK",
        artifactKey,
        qualityProfile: qualityArtifactProfileFromConfig(config),
        target: target("u1", 1),
        targets: [target("u1", 1)],
      },
    });
    const cleanupControl = scheduler.buildQualityUpgradeTask(cleanupJob);
    assert.equal(cleanupControl.shouldCleanupLocal(), true);
    assert.equal(scheduler.qualityArtifactCleanupLocks.has(artifactKey), true);

    const nextControl = new QualityUpgradeTask("BVCLEANLOCK", users[1].cookie, config, target("u2", 2));
    const nextPhase = new QualityUpgradeDownloadTask(nextControl);
    assert.equal(scheduler.canStartDownloadTask(nextPhase), false);
    cleanupControl.onLocalCleanupFinished(cleanupControl);
    assert.equal(scheduler.qualityArtifactCleanupLocks.has(artifactKey), false);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("an exhausted quality download can be submitted again without a stuck failed job", async () => {
  const runtime = await createTestDir("quality-download-exhaustion");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    const queued = jobs.enqueue({
      kind: "quality_download",
      dedupeKey: "quality-download:BVEXHAUST:artifact",
      bvid: "BVEXHAUST",
      maxAttempts: 1,
      payload: { artifactKey: "artifact", target: target("u1", 1), targets: [target("u1", 1)] },
    });
    const claimed = jobs.claimDue(["quality_download"], 1, "owner")[0];
    assert.equal(claimed.id, queued.id);
    assert.equal(jobs.retry(queued.id, "owner", "download failed", Date.now() + 60_000).exhausted, true);
    assert.equal(jobs.findById(queued.id), null);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("account reassignment preserves every shared target and completed artifacts still revalidate", async () => {
  const runtime = await createTestDir("quality-account-reassign");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2)];
  const config = testConfig({ bbdownQuality: "1080P" });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager
  ) as any;
  try {
    scheduler.downloadQueue.setStartGate(() => false);
    const control = new QualityUpgradeTask("BVREASSIGN", users[0].cookie, config, target("u1", 1), {
      targets: [target("u1", 1), target("u2", 2)],
    });
    control.downloadUserId = "u1";
    control.userId = "u1";
    assert.equal(scheduler.enqueueQualityUpgrade(control), true);
    const retired = await scheduler.retireUser(users[0]);
    assert.equal(retired.reassignedJobs, 1);
    const [job] = scheduler.jobStore.list(["quality_download"]);
    assert.equal(job.payload.downloadUserId, "u2");
    assert.equal(job.payload.targets.length, 2);

    const rebuilt = scheduler.buildQualityUpgradeTask(job);
    rebuilt.downloadDir = path.join(runtime, "completed-artifact");
    rebuilt.outputFiles = ["video.mp4"];
    let revalidationCalls = 0;
    rebuilt.downloadRunner = async () => {
      revalidationCalls += 1;
      return {
        downloadDir: rebuilt.downloadDir,
        files: rebuilt.outputFiles,
        recoveredPages: 1,
        totalPages: 1,
        partial: false,
      };
    };
    await rebuilt.runDownloadPhase("resume");
    assert.equal(revalidationCalls, 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("quality-upgrade staged upload rebuilds metadata and writes actual media proof to SQLite", async () => {
  const runtime = await createTestDir("quality-metadata-writeback");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const config = testConfig({ bbdownQuality: "4K", bbdownEncoding: "HEVC" });
  const oldFile = {
    name: "old.mp4",
    path: "/backup/u1/1/old.mp4",
    size: 512,
    verificationStatus: "verified" as const,
  };
  try {
    manager.recordFavoriteItem("u1", 1, "Favorites", {
      bvid: "BVQUALITYMETADATA",
      title: "Metadata video",
      upperName: "Tester",
    });
    manager.markVerifiedUpload("BVQUALITYMETADATA", "/backup/u1/1", [oldFile], "u1", 1);
    writeQualityMetadataSession(runtime);

    const task = new QualityUpgradeTask("BVQUALITYMETADATA", {}, config, {
      userId: "u1",
      mediaId: 1,
      folderTitle: "Favorites",
      remotePath: "/backup/u1/1",
      oldFiles: [oldFile],
    });
    task.downloadDir = runtime;
    task.outputFiles = ["new.mp4"];
    let receivedMetadata: any;
    task.uploadRunner = async (_localDir, remotePath, frozenConfig, options) => {
      receivedMetadata = options.filenameMetadataByPath?.["new.mp4"];
      const { mediaMetadata, ...filenameMetadata } = receivedMetadata || {};
      return {
        remotePath,
        allVerified: true,
        files: [{
          name: "new.mp4",
          path: `${remotePath}/new.mp4`,
          size: 1024,
          qualityProfile: {
            quality: frozenConfig.bbdownQuality,
            encoding: frozenConfig.bbdownEncoding,
            hiRes: frozenConfig.bbdownHiRes,
            dolby: frozenConfig.bbdownDolby,
          },
          filenameMetadata,
          mediaMetadata,
          localRelativePath: "new.mp4",
          verificationStatus: "verified",
        }],
      };
    };
    task.verifyRunner = async () => ({ ok: true, missing: [] });
    task.moveRunner = async () => undefined;
    task.onReplacing = (_task, stageRemotePath, backupRemotePath) => manager.markQualityUpgradeReplacing(
      task.bvid,
      "u1",
      1,
      {
        artifactKey: task.artifactKey,
        stageRemotePath,
        backupRemotePath,
        oldRemotePath: "/backup/u1/1",
        oldFiles: [oldFile],
      }
    );
    task.onBackupFileMoved = (_task, file) => { manager.recordQualityUpgradeBackupFile(task.bvid, "u1", 1, file); };
    task.onFinalFileMoved = (_task, file) => { manager.recordQualityUpgradeFinalFile(task.bvid, "u1", 1, file); };
    task.onUploaded = (_task, result) => { manager.finalizeQualityUpgradeRemoteFiles(task.bvid, "u1", 1, result.remotePath, result.files); };

    await task.runUploadStagePhase("run");
    await task.runReplacePhase("run");
    assert.equal(manager.completeQualityUpgrade(task.bvid, "u1", 1, "/backup/u1/1", task.finalFiles || []), true);

    assert.deepEqual(receivedMetadata, {
      publishDate: 1_700_000_000,
      videoDate: 1_700_000_000,
      cid: 501,
      pageIndex: 1,
      bilibiliQuality: "1080P60",
      dfn: "1080p60",
      videoCodecs: "HEVC",
      mediaMetadata: {
        width: 1080,
        height: 1920,
        duration: 30,
        fps: 60,
        codec: "HEVC",
        source: "ffprobe",
        observedAt: "2026-07-29T00:00:02.000Z",
      },
    });

    const resumedTask = new QualityUpgradeTask("BVQUALITYMETADATA", {}, config, target("u2", 2));
    resumedTask.downloadDir = runtime;
    resumedTask.outputFiles = ["new.mp4"];
    let resumedMetadata: any;
    resumedTask.uploadRunner = async (_localDir, remotePath, _frozenConfig, options) => {
      resumedMetadata = options.filenameMetadataByPath?.["new.mp4"];
      return { remotePath, allVerified: true, files: [] };
    };
    resumedTask.verifyRunner = async () => ({ ok: true, missing: [] });
    await resumedTask.runUploadStagePhase("resumed");
    assert.deepEqual(resumedMetadata, receivedMetadata);

    const relation = manager.getRelation("u1", 1, task.bvid);
    assert.equal(relation?.remoteFiles?.[0].filenameMetadata?.bilibiliQuality, "1080P60");
    assert.deepEqual(relation?.remoteFiles?.[0].mediaMetadata, receivedMetadata.mediaMetadata);
    assert.equal(relation?.remoteFiles?.[0].qualityProfile?.quality, "4K");

    const row = manager.getDatabase().db.prepare(`
      SELECT actual_width, actual_height, actual_fps, actual_duration, actual_codec, actual_metadata_source
      FROM remote_files WHERE user_id=? AND media_id=? AND bvid=?
    `).get("u1", 1, task.bvid) as any;
    assert.deepEqual(row, {
      actual_width: 1080,
      actual_height: 1920,
      actual_fps: 60,
      actual_duration: 30,
      actual_codec: "HEVC",
      actual_metadata_source: "ffprobe",
    });
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("quality-upgrade preflight stops before remote upload when ffprobe proof is incomplete", async () => {
  const runtime = await createTestDir("quality-metadata-preflight");
  try {
    writeQualityMetadataSession(runtime, { outputs: [qualityMetadataOutput({ width: undefined })] });
    const task = new QualityUpgradeTask("BVQUALITYMETADATA", {}, testConfig(), target("u1", 1));
    task.downloadDir = runtime;
    task.outputFiles = ["new.mp4"];
    let uploadCalls = 0;
    task.uploadRunner = async () => {
      uploadCalls += 1;
      throw new Error("remote upload must not start");
    };
    await assert.rejects(() => task.runUploadStagePhase("run"), /lack verified ffprobe dimensions/);
    assert.equal(uploadCalls, 0);
    assert.equal(task.stageRemotePath, undefined);
  } finally {
    await removeTestDir(runtime);
  }
});
