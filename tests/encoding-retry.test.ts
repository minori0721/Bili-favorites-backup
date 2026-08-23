import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("one-off encoding retry stays pending, uses an isolated directory, and is idempotent", async () => {
  const runtime = await createTestDir("encoding-retry-isolated");
  const tempDir = path.join(runtime, "temp");
  const localDir = path.join(tempDir, "BVENCODINGRETRY");
  const state = new StateManager({
    dbPath: path.join(runtime, "state.sqlite"),
    statePath: path.join(runtime, "unused-state.json"),
  });
  const now = new Date().toISOString();
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Favorites" }],
    enabled: true,
    lastLoginAt: now,
  };
  state.replaceStateSnapshot({
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      BVENCODINGRETRY: {
        bvid: "BVENCODINGRETRY",
        title: "Encoding retry",
        upperName: "Tester",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available",
        backupStatus: "upload_failed",
        localDir,
      },
    },
    relations: {
      "u1:1:BVENCODINGRETRY": {
        userId: "u1",
        mediaId: 1,
        bvid: "BVENCODINGRETRY",
        folderTitle: "Favorites",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "upload_failed",
        remotePath: "/backup/BVENCODINGRETRY",
      },
    },
  });
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), "original-avc");

  const config = testConfig({ bbdownEncoding: "", bbdownEncodingPriority: ["HEVC", "AVC", "AV1"] });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : undefined } as any,
    state,
    { legacyTempDir: tempDir },
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  scheduler.uploadQueue.setStartGate(() => false);

  try {
    const parent = scheduler.jobStore.enqueue({
      kind: "upload",
      dedupeKey: "upload:BVENCODINGRETRY",
      bvid: "BVENCODINGRETRY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true,
        localDir,
        files: ["video.mp4"],
        remotePath: "/backup/BVENCODINGRETRY",
        recoveryAssessment: {
          kind: "remote_size_limit",
          checkedAt: Date.now(),
          localStatus: "available",
          remoteStatus: "size_limit",
          summary: "远端单文件超过限制",
        },
      },
    });

    const options = { encodingPriority: ["AV1", "HEVC", "AVC"], strict: true };
    const first = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "redownload_with_encoding", options);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.ok(first.childJobId);

    const afterStart = scheduler.jobStore.findById(parent.id)!;
    const retry = (afterStart.payload as any).encodingRetry;
    assert.deepEqual(retry.priority, options.encodingPriority);
    assert.equal(retry.strict, true);
    assert.equal(retry.state, "running");
    assert.notEqual(retry.candidateLocalDir, localDir);
    assert.equal(retry.candidateLocalDir.startsWith(path.resolve(tempDir) + path.sep), true);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(config.bbdownEncoding, "");
    assert.deepEqual(config.bbdownEncodingPriority, ["HEVC", "AVC", "AV1"]);

    const child = scheduler.jobStore.findById(String(first.childJobId))!;
    assert.ok(["pending", "leased"].includes(child.status));
    const task = scheduler.buildDownloadTask(child);
    assert.ok(task);
    assert.equal(task.encodingRetry.strict, true);
    assert.deepEqual(task.encodingRetry.priority, options.encodingPriority);
    assert.equal(task.config.bbdownEncoding, "AV1");
    assert.deepEqual(task.config.bbdownEncodingPriority, options.encodingPriority);
    assert.equal(task.downloadDirOverride, retry.candidateLocalDir);

    const blockedRecheck = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "recheck");
    assert.equal(blockedRecheck.ok, false);
    assert.equal(blockedRecheck.status, 409);

    const second = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "redownload_with_encoding", options);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.childJobId, first.childJobId);
    assert.equal(scheduler.jobStore.list(["download"]).filter((job) => (job.payload as any).encodingRetry?.parentJobId === parent.id).length, 1);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});
