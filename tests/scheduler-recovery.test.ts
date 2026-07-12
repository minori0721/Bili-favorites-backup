import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeJsonFile } from "../src/storage.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("1000 persisted tasks stay bounded and refill at the low-water mark", async () => {
  const runtime = await createTestDir("scheduler-stress");
  try {
    const dataDir = path.join(runtime, "data");
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtime, "temp"), { recursive: true });
    const state: any = {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
    };
    const padding = "x".repeat(6000);
    for (let index = 0; index < 1000; index += 1) {
      const bvid = `BVSTRESS${String(index).padStart(6, "0")}`;
      state.videos[bvid] = {
        bvid,
        title: `Stress ${index}`,
        upperName: "Stress",
        description: padding,
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        biliStatus: "available",
        backupStatus: index % 2 === 0 ? "uploading" : "queued",
      };
      state.relations[`u1:1:${bvid}`] = {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Stress",
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        activeInFavorite: true,
        backupStatus: index % 2 === 0 ? "uploading" : "queued",
        remotePath: `/backup/${bvid}`,
      };
    }
    writeJsonFile(path.join(dataDir, "state.json"), state);
    writeJsonFile(path.join(dataDir, "config.json"), testConfig({ queuePrefetchLimit: 25 }));
    writeJsonFile(path.join(dataDir, "users.json"), [{
      id: "u1",
      uid: 1,
      name: "Stress",
      cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Stress" }],
      enabled: true,
      lastLoginAt: "2026-07-10T00:00:00.000Z",
    }]);
    const originalBytes = (await fs.promises.stat(path.join(dataDir, "state.json"))).size;
    const repoRoot = process.cwd();
    const result = spawnSync(process.execPath, [
      "--expose-gc",
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "tests", "recovery-harness.ts"),
    ], {
      cwd: runtime,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("RECOVERY_RESULT="));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice("RECOVERY_RESULT=".length));
    assert.equal(data.stateJsonExists, false);
    assert.ok(data.databaseBytes <= originalBytes * 3);
    assert.equal(data.firstPending, 25);
    assert.equal(data.firstJobs, 1000);
    assert.equal(data.secondPending, 25);
    assert.equal(data.secondJobs, 980);
    assert.equal(data.thirdJobs, 980);
    assert.ok(data.heapUsed < 192 * 1024 * 1024, `recovery process heap too high: ${data.heapUsed} (delta ${data.heapUsedDelta})`);
    assert.ok(data.rss < 512 * 1024 * 1024, `recovery process RSS too high: ${data.rss}`);
  } finally {
    await removeTestDir(runtime);
  }
});

test("startup recovery prioritizes upload_failed and downloaded local files before downloads", async () => {
  const runtime = await createTestDir("scheduler-priority");
  try {
    const dataDir = path.join(runtime, "data");
    const tempDir = path.join(runtime, "temp");
    const downloadedDir = path.join(tempDir, "downloaded");
    const failedDir = path.join(tempDir, "failed");
    await fs.promises.mkdir(downloadedDir, { recursive: true });
    await fs.promises.mkdir(failedDir, { recursive: true });
    await fs.promises.writeFile(path.join(downloadedDir, "downloaded.mp4"), "downloaded");
    await fs.promises.writeFile(path.join(failedDir, "failed.mp4"), "failed");
    const writeCompleteManifest = (localDir: string, bvid: string, fileName: string) => writeJsonFile(path.join(localDir, ".bfb-download.json"), {
      schemaVersion: 1,
      sessionId: `${bvid}-session`,
      kind: "backup",
      bvid,
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      snapshotAt: "2026-07-10T00:00:00.000Z",
      status: "complete",
      pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
      outputs: [{ pageIndex: 1, cid: 1, relativePath: fileName, size: 1, duration: 1, videoCodec: "test", quickHash: "test", verifiedAt: "2026-07-10T00:00:00.000Z" }],
      history: [],
    });
    writeCompleteManifest(downloadedDir, "BVDOWNLOADED", "downloaded.mp4");
    writeCompleteManifest(failedDir, "BVFAILED", "failed.mp4");

    const state: any = {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
    };
    const add = (bvid: string, status: string, localDir?: string) => {
      state.videos[bvid] = {
        bvid,
        title: bvid,
        upperName: "Tester",
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        biliStatus: "available",
        backupStatus: status,
        localDir,
      };
      state.relations[`u1:1:${bvid}`] = {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Favorites",
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        activeInFavorite: true,
        backupStatus: status,
        remotePath: `/backup/${bvid}`,
      };
    };
    add("BVDOWNLOADED", "downloaded", downloadedDir);
    add("BVQUEUED", "queued");
    add("BVFAILED", "upload_failed", failedDir);

    writeJsonFile(path.join(dataDir, "state.json"), state);
    writeJsonFile(path.join(dataDir, "config.json"), testConfig({ queuePrefetchLimit: 5 }));
    writeJsonFile(path.join(dataDir, "users.json"), [{
      id: "u1",
      uid: 1,
      name: "Tester",
      cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Favorites" }],
      enabled: true,
      lastLoginAt: "2026-07-10T00:00:00.000Z",
    }]);

    const repoRoot = process.cwd();
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "tests", "recovery-priority-harness.ts"),
    ], {
      cwd: runtime,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("RECOVERY_PRIORITY_RESULT="));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice("RECOVERY_PRIORITY_RESULT=".length));
    assert.deepEqual(data.uploadOrder, ["BVFAILED", "BVDOWNLOADED"]);
    assert.equal(data.blocked, false);
    assert.equal(data.initialDownloadTasks, 0);
    assert.equal(data.initialDownloadJobs, 1);
    assert.equal(data.releasedDownloadTasks, 1);
  } finally {
    await removeTestDir(runtime);
  }
});

test("startup restores each orphaned upload relation after persistent bootstrap was completed", async () => {
  const runtime = await createTestDir("scheduler-orphaned-upload");
  const localDir = path.join(runtime, "temp", "BVORPHAN");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "orphan.mp4"), "orphan-content");
  writeJsonFile(path.join(localDir, ".bfb-download.json"), {
    schemaVersion: 1,
    sessionId: "orphan-session",
    kind: "backup",
    bvid: "BVORPHAN",
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    snapshotAt: "2026-07-12T00:00:00.000Z",
    status: "complete",
    pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
    outputs: [{ pageIndex: 1, cid: 1, relativePath: "orphan.mp4", size: 14, duration: 1, videoCodec: "test", quickHash: "test", verifiedAt: "2026-07-12T00:00:00.000Z" }],
    history: [],
  });
  const manager = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  manager.replaceStateSnapshot({
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    videos: {
      BVORPHAN: {
        bvid: "BVORPHAN",
        title: "Orphaned upload",
        upperName: "Tester",
        firstSeenAt: "2026-07-12T00:00:00.000Z",
        lastSeenAt: "2026-07-12T00:00:00.000Z",
        biliStatus: "available",
        backupStatus: "upload_failed",
        localDir,
      },
    },
    relations: {
      "u1:1:BVORPHAN": {
        userId: "u1",
        mediaId: 1,
        bvid: "BVORPHAN",
        folderTitle: "Favorites",
        firstSeenAt: "2026-07-12T00:00:00.000Z",
        lastSeenAt: "2026-07-12T00:00:00.000Z",
        activeInFavorite: true,
        backupStatus: "upload_failed",
        remotePath: "/backup/orphan-a",
      },
      "u2:2:BVORPHAN": {
        userId: "u2",
        mediaId: 2,
        bvid: "BVORPHAN",
        folderTitle: "Second Favorites",
        firstSeenAt: "2026-07-12T00:00:00.000Z",
        lastSeenAt: "2026-07-12T00:00:00.000Z",
        activeInFavorite: true,
        backupStatus: "upload_failed",
        remotePath: "/backup/orphan-b",
      },
    },
    folderScans: {},
    userCooldowns: {},
  } as any);
  manager.markPersistentJobBootstrapComplete();
  const config = testConfig({ queuePrefetchLimit: 25 });
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    enabled: true,
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Favorites" }],
  };
  const secondUser = {
    ...user,
    id: "u2",
    uid: 2,
    name: "Second Tester",
    favorites: [{ mediaId: 2, title: "Second Favorites" }],
  };
  const users = [user, secondUser];
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => users, getById: (id: string) => users.find((item) => item.id === id) } as any, manager) as any;
  try {
    scheduler.uploadQueue.setStartGate(() => false);
    scheduler.jobStore.enqueue({
      kind: "upload",
      dedupeKey: "upload:u1:1:BVORPHAN:/backup/orphan-a:main",
      bvid: "BVORPHAN",
      userId: "u1",
      mediaId: 1,
      payload: {
        bvid: "BVORPHAN",
        userId: "u1",
        mediaId: 1,
        localDir,
        remotePath: "/backup/orphan-a",
        folderTitle: "Favorites",
        videoTitle: "Orphaned upload",
        upperName: "Tester",
        files: ["orphan.mp4"],
        priority: true,
      },
    });
    scheduler.resumePersistedWorkOnStartup();
    const job = scheduler.jobStore.findByDedupeKey("upload:u2:2:BVORPHAN:/backup/orphan-b:main");
    assert.ok(job);
    assert.notEqual(job.status, "failed");
    assert.match(String(job.payload.conflictArchiveSegment), /^\d{8}T\d{9}Z$/);
    const existingJob = scheduler.jobStore.findByDedupeKey("upload:u1:1:BVORPHAN:/backup/orphan-a:main");
    assert.equal(existingJob?.id !== job.id, true);
    assert.match(String(existingJob?.payload.conflictArchiveSegment), /^\d{8}T\d{9}Z$/);
    assert.equal(scheduler.getQueueSnapshot().uploadPending.filter((item: any) => item.bvid === "BVORPHAN").length, 2);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("one deterministic upload failure is isolated without blocking unrelated downloads", async () => {
  const runtime = await createTestDir("scheduler-isolated-upload");
  try {
    const dataDir = path.join(runtime, "data");
    const localDir = path.join(runtime, "temp", "BVISOLATED");
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "isolated.mp4"), "local-upload-content");
    writeJsonFile(path.join(dataDir, "state.json"), {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: {
        BVISOLATED: {
          bvid: "BVISOLATED",
          title: "Isolated upload",
          upperName: "Tester",
          firstSeenAt: "2026-07-10T00:00:00.000Z",
          lastSeenAt: "2026-07-10T00:00:00.000Z",
          biliStatus: "available",
          backupStatus: "uploading",
          localDir,
        },
      },
      relations: {
        "u1:1:BVISOLATED": {
          userId: "u1",
          mediaId: 1,
          bvid: "BVISOLATED",
          folderTitle: "Favorites",
          firstSeenAt: "2026-07-10T00:00:00.000Z",
          lastSeenAt: "2026-07-10T00:00:00.000Z",
          activeInFavorite: true,
          backupStatus: "uploading",
          remotePath: "/backup/isolated",
        },
      },
      folderScans: {},
      userCooldowns: {},
    });
    writeJsonFile(path.join(dataDir, "config.json"), testConfig({ localCacheLimitGB: 0 }));
    writeJsonFile(path.join(dataDir, "users.json"), [{
      id: "u1",
      uid: 1,
      name: "Tester",
      cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Favorites" }],
      enabled: true,
      lastLoginAt: "2026-07-10T00:00:00.000Z",
    }]);

    const repoRoot = process.cwd();
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "tests", "isolated-upload-failure-harness.ts"),
    ], {
      cwd: runtime,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("ISOLATED_UPLOAD_FAILURE_RESULT="));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice("ISOLATED_UPLOAD_FAILURE_RESULT=".length));
    assert.equal(data.retryStatus, "retry_wait");
    assert.ok(data.retryDelayMs > 5.9 * 60 * 60_000, `Retry delay too short: ${data.retryDelayMs}`);
    assert.ok(data.retryDelayMs <= 6 * 60 * 60_000, `Retry delay too long: ${data.retryDelayMs}`);
    assert.equal(data.canStartDownload, true);
    assert.equal(data.localFileExists, true);
    assert.equal(data.videoStatus, "upload_failed");
    assert.equal(data.relationStatus, "upload_failed");
  } finally {
    await removeTestDir(runtime);
  }
});

test("a progressive 405 persists a five-minute upload retry without opening the circuit", async () => {
  const runtime = await createTestDir("scheduler-progressive-upload-405");
  try {
    const dataDir = path.join(runtime, "data");
    const localDir = path.join(runtime, "temp", "BVISOLATED");
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "isolated.mp4"), "local-upload-content");
    writeJsonFile(path.join(dataDir, "state.json"), {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: {
        BVISOLATED: {
          bvid: "BVISOLATED",
          title: "Isolated upload",
          upperName: "Tester",
          firstSeenAt: "2026-07-10T00:00:00.000Z",
          lastSeenAt: "2026-07-10T00:00:00.000Z",
          biliStatus: "available",
          backupStatus: "uploading",
          localDir,
        },
      },
      relations: {
        "u1:1:BVISOLATED": {
          userId: "u1",
          mediaId: 1,
          bvid: "BVISOLATED",
          folderTitle: "Favorites",
          firstSeenAt: "2026-07-10T00:00:00.000Z",
          lastSeenAt: "2026-07-10T00:00:00.000Z",
          activeInFavorite: true,
          backupStatus: "uploading",
          remotePath: "/backup/isolated",
        },
      },
      folderScans: {},
      userCooldowns: {},
    });
    writeJsonFile(path.join(dataDir, "config.json"), testConfig({ localCacheLimitGB: 0 }));
    writeJsonFile(path.join(dataDir, "users.json"), [{
      id: "u1",
      uid: 1,
      name: "Tester",
      cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Favorites" }],
      enabled: true,
      lastLoginAt: "2026-07-10T00:00:00.000Z",
    }]);

    const repoRoot = process.cwd();
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "tests", "isolated-upload-failure-harness.ts"),
    ], {
      cwd: runtime,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test", BFB_TEST_UPLOAD_SESSION_TRANSIENT: "1" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("ISOLATED_UPLOAD_FAILURE_RESULT="));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice("ISOLATED_UPLOAD_FAILURE_RESULT=".length));
    assert.equal(data.retryStatus, "retry_wait");
    assert.ok(data.retryDelayMs > 4.9 * 60_000, `Retry delay too short: ${data.retryDelayMs}`);
    assert.ok(data.retryDelayMs <= 5 * 60_000, `Retry delay too long: ${data.retryDelayMs}`);
    assert.equal(data.uploadHealthState, "closed");
    assert.equal(data.canStartDownload, true);
    assert.equal(data.localFileExists, true);
    assert.equal(data.videoStatus, "upload_failed");
    assert.equal(data.relationStatus, "upload_failed");
  } finally {
    await removeTestDir(runtime);
  }
});
