import {relationFor} from './fixtures/state-observation.js';
import { required, readField, readArray } from './contract-values.js';
import { createHeldScheduler } from './fixtures/held-scheduler.js';
import { createLegacyQualityMigration } from '../src/scheduler/legacy-quality-migration.js';
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

type QualityFixture = ReturnType<typeof createHeldScheduler> & { migration: ReturnType<typeof createLegacyQualityMigration> };
const schedulerFixtures = new WeakMap<SyncScheduler, QualityFixture>();
function makeScheduler(config: ConstructorParameters<typeof SyncScheduler>[0], users: {list(): ReturnType<typeof user>[]; getById(id: string): ReturnType<typeof user> | null}, state: StateManager) {
  const fixture = createHeldScheduler(config, users, state);
  schedulerFixtures.set(fixture.scheduler, {...fixture, migration: createLegacyQualityMigration({
    configStore: config, userStore: users, jobStore: fixture.jobs, database: () => state.getDatabase(),
  })});
  return fixture.scheduler;
}
function resources(scheduler: SyncScheduler) {
  const fixture = schedulerFixtures.get(scheduler);
  assert.ok(fixture);
  return fixture;
}

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
      verificationStatus: "verified" as const,
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
    kind: "quality_upgrade" as const,
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
    status: "complete" as const,
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

test("quality replacement proofs are idempotent and reject a different operation", async () => {
  const runtime = await createTestDir("quality-proof-idempotence");
  const manager = new StateManager({ dbPath: ":memory:", statePath: path.join(runtime, "missing.json") });
  const oldFile = {
    name: "old.mp4",
    path: "/backup/u1/1/old.mp4",
    size: 10,
    verificationStatus: "verified" as const,
  };
  try {
    manager.recordFavoriteItem("u1", 1, "Favorites", { bvid: "BVPROOF", title: "Proof", upperName: "Tester" });
    const operation = {
      artifactKey: "artifact-a",
      stageRemotePath: "/backup/u1/1/.stage-a",
      backupRemotePath: "/backup/u1/1/.backup-a",
      oldRemotePath: "/backup/u1/1",
      oldFiles: [oldFile],
    };
    assert.equal(manager.markQualityUpgradeReplacing("BVPROOF", "u1", 1, operation), true);
    const backupFile = { ...oldFile, path: "/backup/u1/1/.backup-a/old.mp4" };
    const newFile = { name: "new.mp4", path: "/backup/u1/1/new.mp4", size: 20, verificationStatus: "verified" as const };
    manager.recordQualityUpgradeBackupFile("BVPROOF", "u1", 1, backupFile);
    manager.recordQualityUpgradeFinalFile("BVPROOF", "u1", 1, newFile);
    assert.equal(manager.markQualityUpgradeReplacing("BVPROOF", "u1", 1, {
      ...operation,
      oldFiles: [],
    }), true);
    assert.equal(manager.markQualityUpgradeReplacing("BVPROOF", "u1", 1, {
      ...operation,
      stageRemotePath: "/backup/u1/1/.stage-other",
    }), false);
    const persisted = manager.getQualityUpgradeOperation("u1", 1, "BVPROOF")!;
    assert.deepEqual(persisted.backupFiles, [backupFile]);
    assert.deepEqual(persisted.newFiles, [newFile]);
    assert.equal(persisted.stageRemotePath, operation.stageRemotePath);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("quality task uses persisted stage and backup paths during replacement recovery", async () => {
  const oldFile = { name: "old.mp4", path: "/target/old.mp4", size: 10, verificationStatus: "verified" as const };
  const task = new QualityUpgradeTask("BVPERSISTEDPATHS", user("u1", 1).cookie, testConfig(), {
    userId: "u1",
    mediaId: 1,
    folderTitle: "Favorites",
    remotePath: "/target",
    oldFiles: [oldFile],
  });
  task.uploadResult = {
    remotePath: "/target/.payload-stage",
    files: [{ name: "new.mp4", path: "/target/.payload-stage/new.mp4", size: 20, verificationStatus: "verified" as const }],
    allVerified: true,
  };
  task.stageRemotePath = "/target/.persisted-stage";
  task.backupRemotePath = "/target/.persisted-backup";
  const calls: Array<[string, string, number | undefined]> = [];
  task.replacementRunner = async (_config, source, targetPath, size) => {
    calls.push([source, targetPath, size]);
  };
  task.verifyRunner = async (_config, files) => ({ ok: files.length === 1, missing: [], unknown: [], failures: {} });
  await task.runReplacePhase("different-run-id");
  assert.deepEqual(calls, [
    ["/target/old.mp4", "/target/.persisted-backup/old.mp4", 10],
    ["/target/.payload-stage/new.mp4", "/target/new.mp4", 20],
  ]);
});

test("scheduler rebuild prefers relation quality proofs over stale job payload files", async () => {
  const runtime = await createTestDir("quality-relation-proof-priority");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const config = testConfig();
  const users = [user("u1", 1)];
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager,
  );
  const oldFile = { name: "old.mp4", path: "/target/old.mp4", size: 10, verificationStatus: "verified" as const };
  try {
    manager.recordFavoriteItem("u1", 1, "Favorites", { bvid: "BVRELATIONPROOF", title: "Proof priority", upperName: "Tester" });
    manager.markQualityUpgradeReplacing("BVRELATIONPROOF", "u1", 1, {
      artifactKey: "artifact-proof",
      stageRemotePath: "/target/.relation-stage",
      backupRemotePath: "/target/.relation-backup",
      oldRemotePath: "/target",
      oldFiles: [oldFile],
    });
    const relationBackup = { ...oldFile, path: "/target/.relation-backup/old.mp4" };
    const relationFinal = { name: "new.mp4", path: "/target/new.mp4", size: 20, verificationStatus: "verified" as const };
    manager.recordQualityUpgradeBackupFile("BVRELATIONPROOF", "u1", 1, relationBackup);
    manager.recordQualityUpgradeFinalFile("BVRELATIONPROOF", "u1", 1, relationFinal);
    const rebuilt = scheduler.buildQualityUpgradeTask(resources(scheduler).jobs.enqueue({
      kind: "quality_replace" as const,
      dedupeKey: "quality-replace:relation-proof",
      bvid: "BVRELATIONPROOF",
      userId: "u1",
      mediaId: 1,
      payload: {
        artifactKey: "artifact-proof",
        target: {
          userId: "u1",
          mediaId: 1,
          folderTitle: "Favorites",
          remotePath: "/stale-target",
          oldFiles: [{ ...oldFile, path: "/stale-target/wrong.mp4" }],
        },
        stageRemotePath: "/stale-stage",
        backupRemotePath: "/stale-backup",
        backupFiles: [{ name: "stale.mp4", path: "/stale-backup/stale.mp4", size: 1 }],
        finalFiles: [{ name: "stale.mp4", path: "/stale-target/stale.mp4", size: 1 }],
      },
    }));
    assert.ok(rebuilt);
    assert.equal(rebuilt.target.remotePath, "/target");
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.target.oldFiles, [oldFile]);
    assert.ok(rebuilt);
    assert.equal(rebuilt.stageRemotePath, "/target/.relation-stage");
    assert.ok(rebuilt);
    assert.equal(rebuilt.backupRemotePath, "/target/.relation-backup");
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.backupFiles, [relationBackup]);
    assert.ok(rebuilt);
    assert.deepEqual(rebuilt.finalFiles, [relationFinal]);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("three targets share one quality download and fan out after a running target merge", async () => {
  const runtime = await createTestDir("quality-shared-download");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [user("u1", 1), user("u2", 2), user("u3", 3)];
  const config = testConfig({ bbdownQuality: "1080P", bbdownEncoding: "HEVC" });
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager
  );
  try {
    resources(scheduler).queues.get('download').setStartGate(() => false);
    resources(scheduler).queues.get('upload').setStartGate(() => false);
    const controls = users.map((item, index) => {
      const control = new QualityUpgradeTask("BVSHARED", item.cookie, config, target(item.id, index + 1));
      control.downloadUserId = item.id;
      control.userId = item.id;
      return control;
    });
    assert.equal(scheduler.enqueueQualityUpgrade(controls[0]), true);
    const phase = resources(scheduler).queues.get('download').getTasks()[0];
    assert.ok(phase instanceof QualityUpgradeDownloadTask);
    assert.equal(scheduler.enqueueQualityUpgrade(controls[1]), true);
    assert.equal(scheduler.enqueueQualityUpgrade(controls[2]), true);
    assert.equal(resources(scheduler).jobs.countOutstanding(["quality_download"]), 1);
    assert.equal(resources(scheduler).queues.get('download').getSize(), 1);
    assert.equal(phase.control.targets.length, 3);
    assert.equal(phase.detail, "等待下载新版 · 3个目标");

    let invocations = 0;
    phase.control.downloadRunner = async (_bvid: string, _cookie: unknown, frozenConfig: ReturnType<typeof testConfig>) => {
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
    resources(scheduler).queues.get('download').removePendingTasks(() => true);
    resources(scheduler).queues.get('download').emit("taskCompleted", phase);
    const uploads = resources(scheduler).jobs.list(["quality_upload"]);
    assert.equal(uploads.length, 3);
    assert.deepEqual(new Set(uploads.map((job) => `${job.userId}:${job.mediaId}`)), new Set(["u1:1", "u2:2", "u3:3"]));
    assert.ok(uploads.every((job) => job.payload.artifactKey === controls[0].artifactKey));
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
  const scheduler = makeScheduler(
    { get: () => config1080 },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager
  );
  try {
    resources(scheduler).queues.get('download').setStartGate(() => false);
    const first = new QualityUpgradeTask("BVPROFILES", users[0].cookie, config1080, target("u1", 1));
    const second = new QualityUpgradeTask("BVPROFILES", users[1].cookie, config4k, target("u2", 2));
    assert.equal(scheduler.enqueueQualityUpgrade(first), true);
    assert.equal(scheduler.enqueueQualityUpgrade(second), true);
    assert.notEqual(first.artifactKey, second.artifactKey);
    assert.equal(resources(scheduler).jobs.countOutstanding(["quality_download"]), 2);
    assert.equal(resources(scheduler).jobs.countQualityJobsForArtifact(first.artifactKey), 1);
    assert.equal(resources(scheduler).jobs.countQualityJobsForArtifact(second.artifactKey), 1);
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
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager
  );
  const now = Date.now();
  try {
    scheduler.beginShutdown();
    const first = resources(scheduler).jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:u1:1:BVLEGACY",
      bvid: "BVLEGACY",
      userId: "u1",
      mediaId: 1,
      notBefore: now + 10_000,
      payload: { bvid: "BVLEGACY", downloadUserId: "u1", target: target("u1", 1) },
    });
    const second = resources(scheduler).jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:u2:2:BVLEGACY",
      bvid: "BVLEGACY",
      userId: "u2",
      mediaId: 2,
      notBefore: now + 60_000,
      payload: { bvid: "BVLEGACY", downloadUserId: "u2", target: target("u2", 2) },
    });
    manager.getDatabase().db.prepare("UPDATE jobs SET attempts=1, status='retry_wait' WHERE id=?").run(first.id);
    manager.getDatabase().db.prepare("UPDATE jobs SET attempts=2, status='retry_wait' WHERE id=?").run(second.id);
    assert.equal(resources(scheduler).migration.migrate(), 2);
    const [merged] = resources(scheduler).jobs.list(["quality_download"]);
    assert.ok(merged.dedupeKey.startsWith("quality-download:BVLEGACY:"));
    assert.equal(merged.attempts, 2);
    assert.equal(merged.notBefore, now + 60_000);
    assert.equal(readArray(merged.payload.targets).length, 2);
    assert.ok(merged.payload.artifactKey);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), "complete");
    resources(scheduler).jobs.countLegacyQualityDownloadJobs = () => {
      throw new Error("completed migration must not query jobs");
    };
    assert.equal(createLegacyQualityMigration({
      configStore: { get: () => testConfig() }, userStore: { getById: () => null },
      database: () => manager.getDatabase(), jobStore: resources(scheduler).jobs,
    }).migrate(), 0);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy quality migration enforces its safety limit without listing or marking jobs", async () => {
  const runtime = await createTestDir("quality-legacy-limit");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager
  );
  try {
    scheduler.beginShutdown();
    const migration = createLegacyQualityMigration({
      configStore: { get: () => testConfig() },
      userStore: { getById: () => null },
      database: () => manager.getDatabase(),
      jobStore: {
        countLegacyQualityDownloadJobs: () => 100_001,
        listLegacyQualityDownloadJobs: () => { throw new Error('over-limit migration must not list jobs'); },
        applyQualityDownloadMigration: () => { throw new Error('over-limit migration must not commit'); },
        findByDedupeKey: () => { throw new Error('over-limit migration must not read shared jobs'); },
      },
    });
    assert.equal(migration.migrate(), 0);
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
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager
  );
  try {
    scheduler.beginShutdown();
    const shared = resources(scheduler).jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:BVSHAREDONLY:artifact",
      bvid: "BVSHAREDONLY",
      payload: {
        bvid: "BVSHAREDONLY",
        artifactKey: "artifact",
        targets: [target("u1", 1)],
      },
    });
    assert.equal(resources(scheduler).migration.migrate(), 0);
    assert.equal(resources(scheduler).jobs.findById(shared.id)?.dedupeKey, shared.dedupeKey);
    assert.equal(manager.getDatabase().getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), "complete");
    resources(scheduler).jobs.countLegacyQualityDownloadJobs = () => {
      throw new Error("completed empty migration must not query jobs");
    };
    assert.equal(createLegacyQualityMigration({
      configStore: { get: () => testConfig() }, userStore: { getById: () => null },
      database: () => manager.getDatabase(), jobStore: resources(scheduler).jobs,
    }).migrate(), 0);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy quality migration leaves its marker absent when a candidate has no BVID", async () => {
  const runtime = await createTestDir("quality-legacy-missing-bvid");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager
  );
  try {
    scheduler.beginShutdown();
    const legacy = resources(scheduler).jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:missing-bvid",
      payload: { target: target("u1", 1) },
    });
    assert.throws(() => resources(scheduler).migration.migrate(), /missing its BVID/);
    assert.ok(resources(scheduler).jobs.findById(legacy.id));
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
      kind: "quality_download" as const,
      dedupeKey: "quality-download:u1:1:BVROLLBACK1",
      bvid: "BVROLLBACK1",
      payload: { bvid: "BVROLLBACK1", target: target("u1", 1) },
    });
    const second = jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:u2:2:BVROLLBACK2",
      bvid: "BVROLLBACK2",
      payload: { bvid: "BVROLLBACK2", target: target("u2", 2) },
    });
    assert.throws(() => jobs.applyQualityDownloadMigration([
      {
        jobs: [first],
        replacement: {
          kind: "quality_download" as const,
          dedupeKey: "quality-download:BVROLLBACK1:artifact",
          bvid: "BVROLLBACK1",
          payload: { artifactKey: "artifact", targets: [target("u1", 1)] },
        },
      },
      {
        jobs: [second],
        replacement: {
          kind: "download" as const,
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
      kind: "quality_upload" as const,
      dedupeKey: "quality-upload:u1:1:BVFAIL",
      bvid: "BVFAIL",
      userId: "u1",
      mediaId: 1,
      maxAttempts: 1,
      payload: { artifactKey, target: target("u1", 1) },
    });
    jobs.enqueue({
      kind: "quality_cleanup" as const,
      dedupeKey: "quality-cleanup:u2:2:BVFAIL",
      bvid: "BVFAIL",
      userId: "u2",
      mediaId: 2,
      payload: { artifactKey, target: target("u2", 2) },
    });
    jobs.enqueue({
      kind: "quality_cleanup" as const,
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
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager
  );
  try {
    scheduler.beginShutdown();
    const artifactKey = buildQualityArtifactKey("BVCLEANLOCK", qualityArtifactProfileFromConfig(config));
    const cleanupJob = resources(scheduler).jobs.enqueue({
      kind: "quality_cleanup" as const,
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
    assert.ok(cleanupControl);
    assert.equal(required(cleanupControl.shouldCleanupLocal)(), true);
    assert.equal(scheduler.isQualityArtifactCleanupLocked(artifactKey), true);

    const nextControl = new QualityUpgradeTask("BVCLEANLOCK", users[1].cookie, config, target("u2", 2));
    const nextPhase = new QualityUpgradeDownloadTask(nextControl);
    assert.equal(resources(scheduler).queues.get('download').admitted(nextPhase), false);
    assert.ok(cleanupControl);
    required(cleanupControl.onLocalCleanupFinished)(cleanupControl);
    assert.equal(scheduler.isQualityArtifactCleanupLocked(artifactKey), false);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("an exhausted quality download remains visible and can be explicitly resumed", async () => {
  const runtime = await createTestDir("quality-download-exhaustion");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    const queued = jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:BVEXHAUST:artifact",
      bvid: "BVEXHAUST",
      maxAttempts: 1,
      payload: { artifactKey: "artifact", target: target("u1", 1), targets: [target("u1", 1)] },
    });
    const claimed = jobs.claimDue(["quality_download"], 1, "owner")[0];
    assert.equal(claimed.id, queued.id);
    assert.equal(jobs.retry(queued.id, "owner", "download failed", Date.now() + 60_000).exhausted, true);
    const failed = jobs.findById(queued.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "download failed");
    const resumed = jobs.wakeManualJob(queued.id, { awaitingManualRecovery: false });
    assert.equal(resumed?.id, queued.id);
    assert.equal(resumed?.status, "pending");
    assert.equal(resumed?.attempts, 0);
    assert.equal(resumed?.lastError, undefined);
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
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) ?? null },
    manager
  );
  try {
    resources(scheduler).queues.get('download').setStartGate(() => false);
    const control = new QualityUpgradeTask("BVREASSIGN", users[0].cookie, config, target("u1", 1), {
      targets: [target("u1", 1), target("u2", 2)],
    });
    control.downloadUserId = "u1";
    control.userId = "u1";
    assert.equal(scheduler.enqueueQualityUpgrade(control), true);
    const retired = await scheduler.retireUser(users[0]);
    assert.equal(retired.reassignedJobs, 1);
    const [job] = resources(scheduler).jobs.list(["quality_download"]);
    assert.equal(job.payload.downloadUserId, "u2");
    assert.equal(readArray(job.payload.targets).length, 2);

    const rebuilt = scheduler.buildQualityUpgradeTask(job);
    assert.ok(rebuilt);
    rebuilt.downloadDir = path.join(runtime, "completed-artifact");
    assert.ok(rebuilt);
    rebuilt.outputFiles = ["video.mp4"];
    let revalidationCalls = 0;
    assert.ok(rebuilt);
    rebuilt.downloadRunner = async () => {
      revalidationCalls += 1;
      assert.ok(rebuilt);
      return {
        downloadDir: required(rebuilt.downloadDir),
        files: rebuilt.outputFiles,
        recoveredPages: 1,
        totalPages: 1,
        partial: false,
      };
    };
    assert.ok(rebuilt);
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

    const task = new QualityUpgradeTask("BVQUALITYMETADATA", user("u1", 1).cookie, config, {
      userId: "u1",
      mediaId: 1,
      folderTitle: "Favorites",
      remotePath: "/backup/u1/1",
      oldFiles: [oldFile],
    });
    task.downloadDir = runtime;
    task.outputFiles = ["new.mp4"];
    let receivedMetadata: import("../src/uploader.js").UploadOptions["filenameMetadataByPath"] extends Record<string, infer T> | undefined ? T | undefined : never;
    task.uploadRunner = async (_localDir, remotePath, frozenConfig, options) => {
      assert.ok(options);
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
          verificationStatus: "verified" as const,
        }],
      };
    };
    task.verifyRunner = async () => ({ ok: true, missing: [], unknown: [], failures: {} });
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
        source: "ffprobe" as const,
        observedAt: "2026-07-29T00:00:02.000Z",
      },
    });

    const resumedTask = new QualityUpgradeTask("BVQUALITYMETADATA", user("u2", 2).cookie, config, target("u2", 2));
    resumedTask.downloadDir = runtime;
    resumedTask.outputFiles = ["new.mp4"];
    let resumedMetadata: unknown;
    resumedTask.uploadRunner = async (_localDir, remotePath, _frozenConfig, options) => {
      assert.ok(options);
      resumedMetadata = options.filenameMetadataByPath?.["new.mp4"];
      return { remotePath, allVerified: true, files: [] };
    };
    resumedTask.verifyRunner = async () => ({ ok: true, missing: [], unknown: [], failures: {} });
    await resumedTask.runUploadStagePhase("resumed");
    assert.deepEqual(resumedMetadata, receivedMetadata);

    const relation = relationFor(manager, "u1", 1, task.bvid);
    assert.equal(required(relation?.remoteFiles?.[0]).filenameMetadata?.bilibiliQuality, "1080P60");
    assert.deepEqual(required(relation?.remoteFiles?.[0]).mediaMetadata, receivedMetadata.mediaMetadata);
    assert.equal(relation?.remoteFiles?.[0].qualityProfile?.quality, "4K");

    const row = manager.getDatabase().db.prepare<unknown[], { "actual_width": number | null; "actual_height": number | null; "actual_fps": number | null; "actual_duration": number | null; "actual_codec": string | null; "actual_metadata_source": string | null }>(`
      SELECT actual_width, actual_height, actual_fps, actual_duration, actual_codec, actual_metadata_source
      FROM remote_files WHERE user_id=? AND media_id=? AND bvid=?
    `).get("u1", 1, task.bvid);
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
    const task = new QualityUpgradeTask("BVQUALITYMETADATA", user("u1", 1).cookie, testConfig(), target("u1", 1));
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

test("strict quality encoding preflight stops before staged upload when the actual codec differs", async () => {
  const runtime = await createTestDir("quality-encoding-preflight");
  try {
    writeQualityMetadataSession(runtime, { outputs: [qualityMetadataOutput({ videoCodec: "avc" })] });
    const task = new QualityUpgradeTask("BVQUALITYMETADATA", user("u1", 1).cookie, testConfig(), target("u1", 1), {
      qualityEncodingOverride: { generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true },
    });
    task.downloadDir = runtime;
    task.outputFiles = ["new.mp4"];
    let uploadCalls = 0;
    task.uploadRunner = async () => {
      uploadCalls += 1;
      throw new Error("remote upload must not start");
    };
    const error: unknown = await task.runUploadStagePhase("run").then(() => null, (caught) => caught);
    assert.equal(readField(error, 'code'), "BFB_ENCODING_MISMATCH");
    assert.equal(readField(error, 'source'), "upload_preflight");
    assert.equal(uploadCalls, 0);
    assert.equal(task.stageRemotePath, undefined);
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict quality download passes the first requested encoding to the downloader", async () => {
  const runtime = await createTestDir("quality-encoding-download-option");
  try {
    const task = new QualityUpgradeTask("BVQUALITYMETADATA", user("u1", 1).cookie, testConfig(), target("u1", 1), {
      qualityEncodingOverride: { generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true },
    });
    let expectedEncoding: string | undefined;
    task.downloadRunner = async (_bvid, _cookie, _config, options) => {
      expectedEncoding = options?.expectedEncoding;
      return {
        downloadDir: runtime,
        files: [],
        recoveredPages: 0,
        totalPages: 0,
        partial: false,
      };
    };
    await task.runDownloadPhase("run");
    assert.equal(expectedEncoding, "AV1");
  } finally {
    await removeTestDir(runtime);
  }
});
