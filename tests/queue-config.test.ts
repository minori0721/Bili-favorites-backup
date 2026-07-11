import assert from "node:assert/strict";
import test from "node:test";
import { validateBBDownRuntimeConfig, validateConfig } from "../src/config.js";
import { Task, TaskQueue } from "../src/queue.js";
import { SyncScheduler } from "../src/scheduler.js";
import { QualityUpgradeUploadReplaceTask } from "../src/tasks.js";
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
  const requestedLimits: number[] = [];
  const state = {
    runBatch(fn: () => void) { fn(); },
    listRetryCandidatesForFolder(_userId: string, mediaId: number, limit: number) {
      requestedLimits.push(limit);
      return Array.from({ length: limit }, (_, index) => `BV${mediaId}${index}`);
    },
    shouldEnqueueBackup() { return true; },
    getVideoMeta() { return undefined; },
    markQueued() {},
  };
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user] } as any,
    state as any
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  scheduler.cycleContext = { queuedItems: 0, startedAt: new Date().toISOString() };
  scheduler.requeueRetryPendingBeforeScan();

  assert.equal(scheduler.downloadQueue.getSize(), 3);
  assert.deepEqual(requestedLimits, [3]);
  assert.equal(scheduler.cycleContext.queuedItems, 3);
});

test("deferred quality uploads respect the upload queue hard limit", () => {
  const config = testConfig({ startupRecoveryBatchSize: 5 });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [] } as any,
    {} as any
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(scheduler.uploadQueue.addTask(new IdleTask(`fill-${index}`)), true);
  }
  const control: any = {
    id: "quality-control",
    bvid: "BVQUALITY",
    status: "pending",
    retries: 0,
    qualityStage: "upload",
    qualityStageLabel: "等待上传",
    maxRetries: 2,
    retryDelaySeconds: 1,
    target: {
      userId: "u1",
      mediaId: 1,
      folderTitle: "Favorites",
      remotePath: "/backup/BVQUALITY",
    },
  };
  scheduler.qualityUpgradeUploadBacklog.push({ task: new QualityUpgradeUploadReplaceTask(control) });
  scheduler.drainQualityUpgradeUploadBacklog();
  assert.equal(scheduler.uploadQueue.getSize(), 5);
  assert.equal(scheduler.qualityUpgradeUploadBacklog.length, 1);

  scheduler.uploadQueue.queue.splice(0, 1);
  scheduler.drainQualityUpgradeUploadBacklog();
  assert.equal(scheduler.uploadQueue.getSize(), 5);
  assert.equal(scheduler.qualityUpgradeUploadBacklog.length, 0);
});
