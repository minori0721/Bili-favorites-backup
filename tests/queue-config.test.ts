import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { validateBBDownRuntimeConfig, validateConfig } from "../src/config.js";
import { Task, TaskQueue } from "../src/queue.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { DownloadTask, QualityUpgradeTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

class IdleTask extends Task {
  async run() {}
}

function seedQueuedDownload(state: StateManager, bvid: string) {
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
      [bvid]: {
        bvid,
        title: bvid,
        upperName: "Tester",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available",
        backupStatus: "queued",
      },
    },
    relations: {
      [`u1:1:${bvid}`]: {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Favorites",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "queued",
      },
    },
  });
  return user;
}

function enqueueDownloadJob(scheduler: any, bvid: string) {
  scheduler.jobStore.enqueue({
    kind: "download",
    dedupeKey: `download:${bvid}`,
    bvid,
    priority: 10,
    payload: { primaryUserId: "u1", primaryMediaId: 1, primaryFolderTitle: "Favorites" },
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
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

test("cache refresh completion dispatches persisted downloads without an external wake", async () => {
  const runtime = await createTestDir("cache-dispatch-wake");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  try {
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
        BVCACHEWAKE: {
          bvid: "BVCACHEWAKE",
          title: "Cache wake",
          upperName: "Tester",
          firstSeenAt: now,
          lastSeenAt: now,
          biliStatus: "available",
          backupStatus: "queued",
        },
      },
      relations: {
        "u1:1:BVCACHEWAKE": {
          userId: "u1",
          mediaId: 1,
          bvid: "BVCACHEWAKE",
          folderTitle: "Favorites",
          firstSeenAt: now,
          lastSeenAt: now,
          activeInFavorite: true,
          backupStatus: "queued",
        },
      },
    });
    const scheduler = new SyncScheduler(
      { get: () => testConfig({ localCacheLimitGB: 1, startupRecoveryBatchSize: 5 }) } as any,
      { list: () => [user], getById: () => user } as any,
      state
    ) as any;
    await scheduler.localCacheRefresh;
    scheduler.stop();
    scheduler.acceptingJobs = true;
    scheduler.downloadQueue.setStartGate(() => false);
    scheduler.localCacheSnapshot = null;
    scheduler.localCacheRefresh = null;

    let finishRefresh!: (snapshot: any) => void;
    const pendingRefresh = new Promise<any>((resolve) => { finishRefresh = resolve; });
    scheduler.refreshLocalCacheSnapshot = async () => {
      const snapshot = await pendingRefresh;
      scheduler.localCacheSnapshot = snapshot;
      return snapshot;
    };
    scheduler.jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVCACHEWAKE",
      bvid: "BVCACHEWAKE",
      priority: 10,
      payload: { primaryUserId: "u1", primaryMediaId: 1, primaryFolderTitle: "Favorites" },
    });

    scheduler.dispatchPersistentJobs();
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVCACHEWAKE")?.status, "pending");
    assert.equal(scheduler.downloadQueue.getSize(), 0);

    finishRefresh({
      limitBytes: 1024 * 1024 * 1024,
      usedBytes: 0,
      reserveBytes: 512 * 1024 * 1024,
      paused: false,
      checkedAt: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVCACHEWAKE")?.status, "leased");
    assert.equal(scheduler.downloadQueue.getSize(), 1);
    scheduler.stop();
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});

test("starting polling preserves persistent job wake and lease heartbeat timers", async () => {
  const runtime = await createTestDir("timer-preservation");
  const config = testConfig();
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [], getById: () => undefined } as any,
    state
  ) as any;
  try {
    const heartbeat = scheduler.leaseHeartbeatTimer;
    assert.ok(heartbeat);
    scheduler.jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVFUTUREWAKE",
      bvid: "BVFUTUREWAKE",
      notBefore: Date.now() + 60_000,
    });
    scheduler.dispatchPersistentJobs();
    const jobWake = scheduler.jobDispatchTimer;
    assert.ok(jobWake);
    assert.equal(scheduler.leaseHeartbeatTimer, heartbeat);

    scheduler.start();

    assert.ok(scheduler.jobDispatchTimer);
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVFUTUREWAKE")?.status, "pending");
    assert.equal(scheduler.leaseHeartbeatTimer, heartbeat);

    scheduler.start();
    assert.ok(scheduler.jobDispatchTimer);
    assert.equal(scheduler.leaseHeartbeatTimer, heartbeat);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("a stopped scheduler does not dispatch when an in-flight cache refresh completes", async () => {
  const runtime = await createTestDir("stopped-cache-refresh");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVSTOPPEDREFRESH");
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  try {
    await scheduler.localCacheRefresh;
    scheduler.stop();
    scheduler.acceptingJobs = true;
    scheduler.downloadQueue.setStartGate(() => false);
    scheduler.localCacheSnapshot = null;
    scheduler.localCacheRefresh = null;

    let finishRefresh!: (snapshot: any) => void;
    const pendingRefresh = new Promise<any>((resolve) => { finishRefresh = resolve; });
    scheduler.refreshLocalCacheSnapshot = async () => {
      const snapshot = await pendingRefresh;
      scheduler.localCacheSnapshot = snapshot;
      return snapshot;
    };
    enqueueDownloadJob(scheduler, "BVSTOPPEDREFRESH");
    scheduler.dispatchPersistentJobs();
    scheduler.stop();

    finishRefresh({
      limitBytes: 1024 * 1024 * 1024,
      usedBytes: 0,
      reserveBytes: 512 * 1024 * 1024,
      paused: false,
      checkedAt: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVSTOPPEDREFRESH")?.status, "pending");
    assert.equal(scheduler.downloadQueue.getSize(), 0);
    assert.equal(scheduler.jobDispatchTimer, null);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("concurrent cache wake callbacks lease a persisted download only once", async () => {
  const runtime = await createTestDir("concurrent-cache-wake");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVCONCURRENTWAKE");
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  try {
    await scheduler.localCacheRefresh;
    scheduler.stop();
    scheduler.acceptingJobs = true;
    scheduler.downloadQueue.setStartGate(() => false);
    scheduler.localCacheSnapshot = null;
    scheduler.localCacheRefresh = null;

    let finishRefresh!: (snapshot: any) => void;
    const pendingRefresh = new Promise<any>((resolve) => { finishRefresh = resolve; });
    scheduler.refreshLocalCacheSnapshot = async () => {
      const snapshot = await pendingRefresh;
      scheduler.localCacheSnapshot = snapshot;
      return snapshot;
    };
    enqueueDownloadJob(scheduler, "BVCONCURRENTWAKE");
    scheduler.dispatchPersistentJobs();
    scheduler.refreshLocalCacheAndWake(true);
    scheduler.refreshLocalCacheAndWake(true);

    finishRefresh({
      limitBytes: 1024 * 1024 * 1024,
      usedBytes: 0,
      reserveBytes: 512 * 1024 * 1024,
      paused: false,
      checkedAt: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVCONCURRENTWAKE")?.status, "leased");
    assert.equal(scheduler.downloadQueue.getSize(), 1);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("a transient cache refresh failure recovers without an external scheduler event", async () => {
  const runtime = await createTestDir("cache-refresh-recovery");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVREFRESHRECOVERY");
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  const originalWarn = console.warn;
  try {
    await scheduler.localCacheRefresh;
    scheduler.stop();
    scheduler.acceptingJobs = true;
    scheduler.downloadQueue.setStartGate(() => false);
    scheduler.localCacheSnapshot = null;
    scheduler.localCacheRefresh = null;
    scheduler.persistentJobWakeMinMs = 20;
    let refreshAttempts = 0;
    let warningCount = 0;
    console.warn = (...args: any[]) => {
      if (String(args[0]).includes("Failed to refresh local cache state")) warningCount += 1;
      else originalWarn(...args);
    };
    scheduler.refreshLocalCacheSnapshot = async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new Error("temporary cache scan failure");
      const snapshot = {
        limitBytes: 1024 * 1024 * 1024,
        usedBytes: 0,
        reserveBytes: 512 * 1024 * 1024,
        paused: false,
        checkedAt: Date.now(),
      };
      scheduler.localCacheSnapshot = snapshot;
      return snapshot;
    };
    enqueueDownloadJob(scheduler, "BVREFRESHRECOVERY");
    scheduler.dispatchPersistentJobs();

    await waitForCondition(() => scheduler.jobStore.findByDedupeKey("download:BVREFRESHRECOVERY")?.status === "leased");

    assert.ok(refreshAttempts >= 2);
    assert.equal(warningCount, 1);
    assert.equal(scheduler.downloadQueue.getSize(), 1);
  } finally {
    console.warn = originalWarn;
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("stop followed by start immediately resumes due persisted jobs", async () => {
  const runtime = await createTestDir("scheduler-restart-wake");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVRESTARTWAKE");
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  try {
    await scheduler.localCacheRefresh;
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.stop();
    scheduler.downloadQueue.setStartGate(() => false);
    enqueueDownloadJob(scheduler, "BVRESTARTWAKE");

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVRESTARTWAKE")?.status, "leased");
    assert.equal(scheduler.downloadQueue.getSize(), 1);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("a due download blocked by a full cache does not create a zero-delay dispatch loop", async () => {
  const runtime = await createTestDir("cache-backpressure-loop");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVCACHEFULL");
  const scheduler = new SyncScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) } as any,
    { list: () => [user], getById: () => user } as any,
    state
  ) as any;
  try {
    await scheduler.localCacheRefresh;
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.stop();
    scheduler.acceptingJobs = true;
    scheduler.persistentJobWakeMinMs = 40;
    scheduler.localCacheSnapshot = {
      limitBytes: 1024 * 1024 * 1024,
      usedBytes: 900 * 1024 * 1024,
      reserveBytes: 512 * 1024 * 1024,
      paused: true,
      checkedAt: Date.now(),
    };
    enqueueDownloadJob(scheduler, "BVCACHEFULL");

    const originalDispatch = scheduler.dispatchPersistentJobs.bind(scheduler);
    let dispatchCalls = 0;
    scheduler.dispatchPersistentJobs = () => {
      dispatchCalls += 1;
      return originalDispatch();
    };
    scheduler.dispatchPersistentJobs();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(dispatchCalls, 1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(dispatchCalls >= 2 && dispatchCalls <= 3, `unexpected dispatch count: ${dispatchCalls}`);
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVCACHEFULL")?.status, "pending");
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
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
