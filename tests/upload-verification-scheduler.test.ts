import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UploadVerificationTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

function verificationState(localDir: string): any {
  const now = new Date().toISOString();
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      BVVERIFY: { bvid: "BVVERIFY", title: "Verify", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "uploaded", localDir },
    },
    relations: {
      "u1:1:BVVERIFY": {
        userId: "u1", mediaId: 1, bvid: "BVVERIFY", folderTitle: "Favorites", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "uploaded", remotePath: "/target",
        remoteFiles: [{ name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4", verificationStatus: "awaiting_verification", putCompletedAt: now }],
      },
    },
  };
}

test("upload confirmation survives restart and times out into a delayed reupload", async () => {
  const runtime = await createTestDir("upload-confirm-restart");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  let manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const configStore = { get: () => config } as any;
  const userStore = { list: () => [], getById: () => undefined } as any;
  let scheduler = new SyncScheduler(configStore, userStore, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const putCompletedAt = new Date().toISOString();
  scheduler.jobStore.enqueue({
    kind: "verify_upload",
    dedupeKey: "verify:u1:1:BVVERIFY:main:/target/video.mp4",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    maxAttempts: 8,
    payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir, remotePath: "/target", files: ["video.mp4"], putCompletedAt, folderTitle: "Favorites", videoTitle: "Verify" },
  });
  let job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
  const missing = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
  missing.persistentJobId = job.id;
  missing.persistentJob = job;
  missing.result = { status: "missing" };
  scheduler.handleUploadVerificationCompleted(missing);
  assert.equal(scheduler.jobStore.findById(job.id)?.status, "retry_wait");
  scheduler.stop();
  manager.close();

  manager = new StateManager({ statePath, dbPath });
  scheduler = new SyncScheduler(configStore, userStore, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const persisted = scheduler.jobStore.findByDedupeKey("verify:u1:1:BVVERIFY:main:/target/video.mp4");
  assert.equal(persisted?.status, "retry_wait");
  manager.getDatabase().db.prepare("UPDATE jobs SET status='retry_wait', attempts=5, not_before=0, lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(persisted!.id);
  job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
  const timedOut = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
  timedOut.persistentJobId = job.id;
  timedOut.persistentJob = { ...job, attempts: 5, payload: { ...job.payload, putCompletedAt: new Date(Date.now() - 11 * 60_000).toISOString() } };
  timedOut.result = { status: "missing" };
  const beforeTimeout = Date.now();
  scheduler.handleUploadVerificationCompleted(timedOut);
  const reupload = scheduler.jobStore.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
  assert.ok(reupload);
  assert.ok(reupload!.notBefore >= beforeTimeout + 29 * 60_000);
  assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "upload_failed");
  assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
  scheduler.stop();
  manager.close();
  await removeTestDir(runtime);
});

test("a successful confirmation promotes uploaded to verified without another PUT", async () => {
  const runtime = await createTestDir("upload-confirm-success");
  try {
    const localDir = path.join(runtime, "temp", "BVVERIFY");
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
    const manager = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
    manager.replaceStateSnapshot(verificationState(localDir));
    const config = testConfig();
    const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
    scheduler.uploadQueue.setStartGate(() => false);
    scheduler.jobStore.enqueue({ kind: "verify_upload", dedupeKey: "verify:success", bvid: "BVVERIFY", userId: "u1", mediaId: 1, payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir: "" } });
    const job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
    const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.result = { status: "verified", remoteSize: 12 };
    scheduler.handleUploadVerificationCompleted(task);
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
    scheduler.stop();
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});

test("upload circuit state is restored from the shared cooldown table", async () => {
  const runtime = await createTestDir("upload-circuit-persist");
  try {
    const statePath = path.join(runtime, "data", "state.json");
    const dbPath = path.join(runtime, "data", "bfb.sqlite");
    let manager = new StateManager({ statePath, dbPath });
    manager.setUploadCooldown({ state: "open", reason: "backend unavailable", category: "auth", openedAt: Date.now(), retryAt: Date.now() + 60_000, consecutiveFailures: 1 });
    manager.close();
    manager = new StateManager({ statePath, dbPath });
    const config = testConfig();
    const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [] } as any, manager);
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.state, "open");
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.pausedDownloads, true);
    scheduler.stop();
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});
