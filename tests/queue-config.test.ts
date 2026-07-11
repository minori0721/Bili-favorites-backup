import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { validateBBDownRuntimeConfig, validateConfig } from "../src/config.js";
import { Task, TaskQueue } from "../src/queue.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { DownloadTask, QualityUpgradeTask } from "../src/tasks.js";
import { testConfig } from "./helpers.js";

class IdleTask extends Task {
  async run() {}
}

test("task queue enforces its high-water size and batch admission", () => {
  const queue = new TaskQueue(1, 3);
  queue.setStartGate(() => false);
  assert.equal(queue.addTask(new IdleTask("one")), true);
  assert.equal(queue.addTasks([new IdleTask("two"), new IdleTask("three"), new IdleTask("four")]), 2);
  assert.equal(queue.getSize(), 3);
  assert.equal(queue.canAccept(), false);
  assert.equal(queue.addTask(new IdleTask("five")), false);
});

test("startup recovery batch setting validates the supported range", () => {
  assert.equal(validateConfig({ startupRecoveryBatchSize: 25 }), null);
  assert.match(String(validateConfig({ startupRecoveryBatchSize: 4 })), /between 5 and 100/);
  assert.match(String(validateConfig({ startupRecoveryBatchSize: 101 })), /between 5 and 100/);
});

test("BBDown API mode validates explicit values", () => {
  assert.equal(validateConfig({ bbdownApiMode: "web" }), null);
  assert.equal(validateConfig({ bbdownApiMode: "app" }), null);
  assert.match(String(validateConfig({ bbdownApiMode: "mobile" as any })), /web or app/);
});

test("APP mode requires tokens and premium audio rejects Web mode", () => {
  assert.match(String(validateBBDownRuntimeConfig(
    { bbdownApiMode: "web", bbdownHiRes: true, bbdownDolby: false },
    []
  )), /必须使用 APP/);
  assert.match(String(validateBBDownRuntimeConfig(
    { bbdownApiMode: "app", bbdownHiRes: false, bbdownDolby: false },
    [{ id: "u1", name: "Tester", enabled: true }]
  )), /Tester/);
  assert.equal(validateBBDownRuntimeConfig(
    { bbdownApiMode: "app", bbdownHiRes: true, bbdownDolby: false },
    [{ id: "u1", name: "Tester", enabled: true, accessToken: "token" }]
  ), null);
});

test("retry-pending recovery applies one global budget across folders", () => {
  const config = testConfig({ remoteRequeueLimitPerCycle: 3 });
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "One" }, { mediaId: 2, title: "Two" }],
    enabled: true,
    lastLoginAt: "2026-07-10T00:00:00.000Z",
  };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `queue-config-${Date.now()}.json`) });
  const snapshot: any = { schemaVersion: 11, processedByUser: {}, failedByUser: {}, videos: {}, relations: {}, folderScans: {}, userCooldowns: {} };
  for (let index = 0; index < 8; index += 1) {
    const mediaId = index < 5 ? 1 : 2;
    const bvid = `BV${mediaId}${index}`;
    snapshot.videos[bvid] = { bvid, title: bvid, upperName: "Tester", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), biliStatus: "available", backupStatus: "failed" };
    snapshot.relations[`u1:${mediaId}:${bvid}`] = { userId: "u1", mediaId, bvid, folderTitle: mediaId === 1 ? "One" : "Two", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeInFavorite: true, backupStatus: "failed" };
  }
  state.replaceStateSnapshot(snapshot);
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  scheduler.cycleContext = { queuedItems: 0, startedAt: new Date().toISOString() };
  scheduler.requeueRetryPendingBeforeScan();

  assert.equal(scheduler.downloadQueue.getSize(), 3);
  assert.equal(scheduler.jobStore.countOutstanding(["download"]), 3);
  assert.equal(scheduler.cycleContext.queuedItems, 3);
  scheduler.stop();
  state.close();
});

test("persistent quality uploads respect the upload queue hard limit", () => {
  const config = testConfig({ startupRecoveryBatchSize: 5 });
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {}, accessToken: "token", favorites: [] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `quality-capacity-${Date.now()}.json`) });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(scheduler.uploadQueue.addTask(new IdleTask(`fill-${index}`)), true);
  }
  scheduler.jobStore.enqueue({ kind: "quality_upload", dedupeKey: "quality-upload:u1:1:BVQUALITY", bvid: "BVQUALITY", userId: "u1", mediaId: 1, payload: { bvid: "BVQUALITY", userId: "u1", mediaId: 1, runId: "run", downloadDir: "missing", target: { userId: "u1", mediaId: 1, folderTitle: "Favorites", remotePath: "/backup/BVQUALITY", oldFiles: [] } } });
  scheduler.dispatchPersistentJobs();
  assert.equal(scheduler.uploadQueue.getSize(), 5);
  assert.equal(scheduler.jobStore.countOutstanding(["quality_upload"]), 1);

  scheduler.uploadQueue.queue.splice(0, 1);
  scheduler.dispatchPersistentJobs();
  assert.equal(scheduler.uploadQueue.getSize(), 5);
  assert.equal(scheduler.jobStore.list(["quality_upload"])[0].status, "leased");
  scheduler.stop();
  state.close();
});

test("quality upgrade advances through persistent download upload replace and cleanup jobs", () => {
  const config = testConfig();
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {}, accessToken: "token", favorites: [] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `quality-phases-${Date.now()}.json`) });
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [user], getById: () => user } as any, state) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  scheduler.uploadQueue.setStartGate(() => false);
  const control = new QualityUpgradeTask("BVQUALITYPHASE", {}, config, { userId: "u1", mediaId: 1, folderTitle: "Favorites", remotePath: "/target", oldFiles: [] });
  control.videoTitle = "Quality phase";
  assert.equal(scheduler.enqueueQualityUpgrade(control), true);
  let phase: any = scheduler.downloadQueue.getTasks()[0];
  scheduler.downloadQueue.queue.splice(0);
  phase.control.runId = "run";
  phase.control.downloadDir = "local";
  phase.control.outputFiles = ["video.mp4"];
  scheduler.downloadQueue.emit("taskCompleted", phase);
  assert.equal(scheduler.jobStore.list(["quality_upload"])[0].status, "leased");

  phase = scheduler.uploadQueue.getTasks()[0];
  scheduler.uploadQueue.queue.splice(0);
  phase.control.uploadResult = { remotePath: "/target/.stage", files: [{ name: "video.mp4", path: "/target/.stage/video.mp4", size: 1, verificationStatus: "verified" }], allVerified: true };
  scheduler.uploadQueue.emit("taskCompleted", phase);
  assert.equal(scheduler.jobStore.list(["quality_replace"])[0].status, "leased");

  phase = scheduler.uploadQueue.getTasks()[0];
  scheduler.uploadQueue.queue.splice(0);
  phase.control.finalFiles = [{ name: "video.mp4", path: "/target/video.mp4", size: 1, verificationStatus: "verified" }];
  phase.control.backupFiles = [];
  scheduler.uploadQueue.emit("taskCompleted", phase);
  assert.equal(scheduler.jobStore.list(["quality_cleanup"])[0].status, "leased");

  phase = scheduler.uploadQueue.getTasks()[0];
  scheduler.uploadQueue.queue.splice(0);
  scheduler.uploadQueue.emit("taskCompleted", phase);
  assert.equal(scheduler.jobStore.countOutstanding(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"]), 0);
  scheduler.stop();
  state.close();
});

test("download completion re-reads relations added after the BVID job was claimed", () => {
  const config = testConfig();
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {}, favorites: [{ mediaId: 1, title: "One" }, { mediaId: 2, title: "Two" }] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `download-target-race-${Date.now()}.json`) });
  const now = new Date().toISOString();
  state.replaceStateSnapshot({
    schemaVersion: 11, processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BVRACE: { bvid: "BVRACE", title: "Race", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "downloaded", localDir: "local" } },
    relations: {
      "u1:1:BVRACE": { userId: "u1", mediaId: 1, bvid: "BVRACE", folderTitle: "One", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "downloaded" },
      "u1:2:BVRACE": { userId: "u1", mediaId: 2, bvid: "BVRACE", folderTitle: "Two", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "queued" },
    },
  });
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [user], getById: () => user } as any, state) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const task = new DownloadTask("BVRACE", {}, config);
  task.downloadDir = "local";
  task.outputFiles = ["video.mp4"];
  task.targets = [{ userId: "u1", mediaId: 1, folderTitle: "One", remotePath: "/one" }];
  scheduler.downloadQueue.emit("taskCompleted", task);
  assert.equal(scheduler.jobStore.countOutstanding(["upload"]), 2);
  scheduler.stop();
  state.close();
});
