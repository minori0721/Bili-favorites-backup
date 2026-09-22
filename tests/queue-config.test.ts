import { requeueRetryPending } from '../src/scheduler/retry-pending-recovery.js';
import { recoveryFixture } from './fixtures/recovery.js';
import { heldQueues } from './fixtures/held-queues.js';
import { ManualTime } from './fixtures/manual-time.js';
import { PersistentJobStore } from '../src/job-store.js';
import type { StateFile } from '../src/state.js';
import { QualityUpgradeDownloadTask, QualityUpgradeUploadReplaceTask, QualityUpgradeReplaceTask, QualityUpgradeCleanupTask } from '../src/tasks.js';
import { seedQueuedDownload } from './fixtures/queued-download.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import {
  applyBBDownEncodingPreference,
  decodeStoredConfig,
  isValidBBDownEncodingPriority,
  normalizeBBDownEncodingPriority,
  normalizeLoadedConfig,
  validateBBDownRuntimeConfig,
  validateConfig,
} from "../src/config.js";
import { buildEncodingPriority } from "../src/downloader.js";
import { Task, TaskQueue } from "../src/queue.js";
import { computeUploadSessionRetryDelayMs, SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { DownloadTask, QualityUpgradeTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";
import { inspectDownloadCache } from '../src/download-session.js';

class IdleTask extends Task {
  async run() {}
}

const cacheAdapters = new WeakMap<SyncScheduler, (read: () => Promise<{ usedBytes: number }>) => void>();
type SchedulerArgs = ConstructorParameters<typeof SyncScheduler>;
const fixtureResources = new WeakMap<SyncScheduler, {jobs: PersistentJobStore; queues: ReturnType<typeof heldQueues>; time: ManualTime}>();
function resources(scheduler: SyncScheduler) {
  const value = fixtureResources.get(scheduler);
  assert.ok(value);
  return value;
}
function makeScheduler(config: SchedulerArgs[0], users: Omit<SchedulerArgs[1], 'updatePartial'>, state: SchedulerArgs[2], dependencies: SchedulerArgs[3] = {}) {
  const args = [config, {...users, updatePartial: () => { throw new Error('Unexpected user update'); }}, state, dependencies] as const;
  const queues = heldQueues();
  const time = new ManualTime();
  let inspect = args[3]?.cacheInspector ?? inspectDownloadCache;
  const scheduler = new SyncScheduler(args[0], args[1], args[2], {
    now: time.now, scheduleTimer: time.schedule, random: () => 0.99, createQueue: queues.create, ...args[3], cacheInspector: (root, concurrency) => inspect(root, concurrency),
  });
  fixtureResources.set(scheduler, {queues, time, jobs: new PersistentJobStore(state.getDatabase(), {normalizeRecovery: false, now: time.now})});
  cacheAdapters.set(scheduler, read => {
    inspect = async () => {
      const result = await read();
      return { usedBytes: result.usedBytes, fileCount: 0, exportableBytes: 0, exportableFiles: 0,
        recovery: { resumableSessions: 0, completedPages: 0, totalPages: 0, retainedBytes: 0, legacyDirectories: 0, legacyBytes: 0, cleanupEligibleBytes: 0 } };
    };
  });
  return scheduler;
}
function setCacheObservation(scheduler: SyncScheduler, read: () => Promise<{ usedBytes: number }>) {
  const configure = cacheAdapters.get(scheduler);
  assert.ok(configure);
  configure(read);
  scheduler.refreshLocalCacheState();
}

function enqueueDownloadJob(scheduler: SyncScheduler, bvid: string) {
  resources(scheduler).jobs.enqueue({
    kind: "download" as const,
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

test("queue snapshots reuse one asynchronous cache inspection and coalesce forced refreshes", async () => {
  const runtime = await createTestDir("queue-cache-inspection");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const resolvers: Array<(value: Awaited<ReturnType<typeof inspectDownloadCache>>) => void> = [];
  let inspections = 0;
  const cacheInspector = async () => {
    inspections += 1;
    return new Promise<Awaited<ReturnType<typeof inspectDownloadCache>>>((resolve) => resolvers.push(resolve));
  };
  const scheduler = makeScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) },
    { list: () => [], getById: () => null },
    state,
    { cacheInspector }
  );
  const inspection = (usedBytes: number) => ({
    usedBytes,
    fileCount: 0,
    exportableBytes: usedBytes,
    exportableFiles: 0,
    recovery: {
      resumableSessions: 0, completedPages: 0, totalPages: 0, retainedBytes: 0,
      legacyDirectories: 0, legacyBytes: 0, cleanupEligibleBytes: 0,
    },
  });
  try {
    assert.equal(inspections, 0);
    scheduler.start();
    assert.equal(inspections, 1);
    for (let index = 0; index < 100; index += 1) scheduler.getQueueSnapshot();
    assert.equal(inspections, 1);
    scheduler.refreshLocalCacheState();
    scheduler.refreshLocalCacheState();
    assert.equal(inspections, 1);

    resolvers[0](inspection(10));
    await waitForCondition(() => inspections === 2);
    assert.equal(resolvers.length, 2);
    resolvers[1](inspection(20));
    await scheduler.getLocalCacheCapacity();
    assert.equal(scheduler.getQueueSnapshot().localCache.usedBytes, 20);
    assert.equal(inspections, 2);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("task queue enforces its high-water size and batch admission", () => {
  const queue = new TaskQueue(1, 3);
  queue.setStartGate(() => false);
  assert.equal(queue.addTask(new IdleTask("one")), true);
  assert.equal(queue.addTasks([new IdleTask("two"), new IdleTask("three"), new IdleTask("four")]), 2);
  assert.equal(queue.getSize(), 3);
  assert.equal(queue.canAccept(), false);
  assert.equal(queue.addTask(new IdleTask("five")), false);
});

test("queue prefetch setting validates its range and migrates the legacy name", () => {
  assert.equal(validateConfig({ queuePrefetchLimit: 25 }), null);
  assert.match(String(validateConfig({ queuePrefetchLimit: 4 })), /between 5 and 100/);
  assert.match(String(validateConfig({ queuePrefetchLimit: 101 })), /between 5 and 100/);
  assert.equal(normalizeLoadedConfig({ startupRecoveryBatchSize: 37 }).queuePrefetchLimit, 37);
});

test('stored configuration decoding rejects malformed fields before normalization', () => {
  assert.deepEqual(decodeStoredConfig({ queuePrefetchLimit: 37 }).queuePrefetchLimit, 37);
  assert.deepEqual(decodeStoredConfig({ bbdownEncodingPriority: ['av1', 'hevc', 'avc'] }).bbdownEncodingPriority, ['AV1', 'HEVC', 'AVC']);
  assert.throws(() => decodeStoredConfig({ queuePrefetchLimit: '37' }));
  assert.throws(() => decodeStoredConfig({ bbdownHiRes: 'true' }));
  assert.throws(() => decodeStoredConfig({ bbdownEncodingPriority: ['AV1', 1] }));
  assert.throws(() => decodeStoredConfig({ bbdownEncodingPriority: ['AV1'] }));
  assert.throws(() => decodeStoredConfig({ bbdownEncodingPriority: ['AV1', 'AV1', 'HEVC'] }));
  assert.throws(() => decodeStoredConfig({ bbdownEncodingPriority: ['AV1', 'HEVC', 'VP9'] }));
});

test("playback delivery defaults to safe redirect preference and validates proxy mode", () => {
  assert.equal(normalizeLoadedConfig({}).playbackDeliveryMode, "auto");
  assert.equal(normalizeLoadedConfig({ playbackDeliveryMode: "proxy" }).playbackDeliveryMode, "proxy");
  assert.equal(Reflect.apply(normalizeLoadedConfig, undefined, [{ playbackDeliveryMode: "invalid" }]).playbackDeliveryMode, "auto");
  assert.equal(validateConfig({ playbackDeliveryMode: "auto" }), null);
  assert.equal(validateConfig({ playbackDeliveryMode: "proxy" }), null);
  assert.match(String(Reflect.apply(validateConfig, undefined, [{ playbackDeliveryMode: "invalid" }])), /auto or proxy/);
  assert.equal(normalizeLoadedConfig({}).alistBrowserUrl, "");
  assert.equal(normalizeLoadedConfig({ alistBrowserUrl: " https://alist.example.com/base/ " }).alistBrowserUrl, "https://alist.example.com/base/");
  assert.equal(validateConfig({ alistBrowserUrl: "https://alist.example.com/base" }), null);
  assert.equal(validateConfig({ alistBrowserUrl: "http://alist.example.com" }), null);
  assert.match(String(validateConfig({ alistBrowserUrl: "ftp://alist.example.com" })), /http\(s\)/);
  assert.match(String(validateConfig({ alistBrowserUrl: "https://user:pass@alist.example.com" })), /credentials/);
  assert.match(String(validateConfig({ alistBrowserUrl: "https://alist.example.com/?token=secret" })), /query/);
});

test("encoding preference normalizes legacy settings and preserves the selected fallback order", () => {
  assert.deepEqual(normalizeBBDownEncodingPriority(undefined), ["HEVC", "AVC", "AV1"]);
  assert.deepEqual(normalizeBBDownEncodingPriority(["avc", "av1", "hevc"]), ["AVC", "AV1", "HEVC"]);
  assert.deepEqual(normalizeBBDownEncodingPriority(undefined, "AV1"), ["AV1", "HEVC", "AVC"]);
  assert.equal(isValidBBDownEncodingPriority(["HEVC", "AVC", "AV1"]), true);
  assert.equal(isValidBBDownEncodingPriority(["HEVC", "HEVC", "AV1"]), false);

  const base = testConfig();
  const reordered = applyBBDownEncodingPreference(base, ["AV1", "HEVC", "AVC"]);
  assert.equal(reordered.bbdownEncoding, "");
  assert.deepEqual(reordered.bbdownEncodingPriority, ["AV1", "HEVC", "AVC"]);
  assert.equal(buildEncodingPriority(reordered), "av1,hevc,avc");

  const strict = applyBBDownEncodingPreference(base, ["AVC", "HEVC", "AV1"], true);
  assert.equal(strict.bbdownEncoding, "AVC");
  assert.equal(buildEncodingPriority(strict), "avc");
  assert.equal(buildEncodingPriority(testConfig({ bbdownEncoding: "HEVC", bbdownEncodingPriority: ["AV1", "AVC", "HEVC"] })), "hevc");
  assert.match(String(validateConfig({ bbdownEncodingPriority: ["AV1", "HEVC", "AVC"] })), /^null$/);
  assert.match(String(Reflect.apply(validateConfig, undefined, [{ bbdownEncodingPriority: ["AV1", "HEVC"] }])), /exactly once/);
});

test("upload file interval validates its range and session retries use bounded backoff", () => {
  assert.equal(validateConfig({ uploadFileIntervalSeconds: 0 }), null);
  assert.equal(validateConfig({ uploadFileIntervalSeconds: 10 }), null);
  assert.match(String(validateConfig({ uploadFileIntervalSeconds: -1 })), /between 0 and 120/);
  assert.match(String(validateConfig({ uploadFileIntervalSeconds: 121 })), /between 0 and 120/);
  assert.equal(computeUploadSessionRetryDelayMs(0), 5 * 60_000);
  assert.equal(computeUploadSessionRetryDelayMs(1), 10 * 60_000);
  assert.equal(computeUploadSessionRetryDelayMs(2), 30 * 60_000);
  assert.equal(computeUploadSessionRetryDelayMs(99), 30 * 60_000);
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
          biliStatus: "available" as const,
          backupStatus: "queued" as const,
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
          backupStatus: "queued" as const,
        },
      },
    });
    const scheduler = makeScheduler(
      { get: () => testConfig({ localCacheLimitGB: 1, queuePrefetchLimit: 5 }) },
      { list: () => [user], getById: () => user },
      state
    );
    await scheduler.getLocalCacheCapacity();




    let finishRefresh!: (snapshot: {usedBytes: number}) => void;
    const pendingRefresh = new Promise<{usedBytes: number}>((resolve) => { finishRefresh = resolve; });
    setCacheObservation(scheduler, async () => {
      const snapshot = await pendingRefresh;
      return snapshot;
    });
    resources(scheduler).jobs.enqueue({
      kind: "download" as const,
      dedupeKey: "download:BVCACHEWAKE",
      bvid: "BVCACHEWAKE",
      priority: 10,
      payload: { primaryUserId: "u1", primaryMediaId: 1, primaryFolderTitle: "Favorites" },
    });

    scheduler.wake();
    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVCACHEWAKE")?.status, "pending");
    assert.equal(resources(scheduler).queues.get('download').getSize(), 0);

    finishRefresh({usedBytes: 0});
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVCACHEWAKE")?.status, "leased");
    assert.equal(resources(scheduler).queues.get('download').getSize(), 1);
    scheduler.stop();
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});

test("repeated start preserves scheduled admission and renews active leases only once", async () => {
  const runtime = await createTestDir("timer-preservation");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVFUTUREWAKE");
  const scheduler = makeScheduler({get: () => testConfig()}, {list: () => [user], getById: () => user}, state);
  const {time, jobs, queues} = resources(scheduler);
  try {
    await scheduler.getLocalCacheCapacity();
    const job = jobs.enqueue({kind: "download" as const, dedupeKey: "download:BVFUTUREWAKE", bvid: "BVFUTUREWAKE",
      notBefore: time.now() + 1_000, payload: {primaryUserId: "u1", primaryMediaId: 1, primaryFolderTitle: "Favorites"}});
    scheduler.start();
    const registrations = time.pending;
    scheduler.start();
    scheduler.start();
    assert.equal(time.pending, registrations);
    assert.equal(jobs.findById(job.id)?.status, 'pending');
    time.advance(1_000);
    assert.equal(jobs.findById(job.id)?.status, 'leased');
    const task = queues.get('download').getTasks()[0];
    assert.ok(task);
    task.status = 'running';
    queues.get('download').emit('taskStart', task);
    const firstLease = jobs.findById(job.id)?.leaseExpiresAt;
    assert.ok(firstLease);
    scheduler.start();
    time.advance(59_000);
    assert.equal(jobs.findById(job.id)?.leaseExpiresAt, time.now() + 30 * 60_000);
    assert.ok(jobs.findById(job.id)!.leaseExpiresAt! > firstLease);
    task.status = 'completed';
    queues.get('download').removePendingTasks(() => true);
  } finally {
    await new Promise<void>(resolve => setImmediate(resolve));
    await scheduler.shutdown(1_000, {closeDatabase: false});
    assert.equal(time.pending, 0);
    state.close();
    await removeTestDir(runtime);
  }
});

test("a stopped scheduler does not dispatch when an in-flight cache refresh completes", async () => {
  const runtime = await createTestDir("stopped-cache-refresh");
  const state = new StateManager({ statePath: path.join(runtime, "state.json") });
  const user = seedQueuedDownload(state, "BVSTOPPEDREFRESH");
  const scheduler = makeScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) },
    { list: () => [user], getById: () => user },
    state
  );
  try {
    await scheduler.getLocalCacheCapacity();




    let finishRefresh!: (snapshot: {usedBytes: number}) => void;
    const pendingRefresh = new Promise<{usedBytes: number}>((resolve) => { finishRefresh = resolve; });
    setCacheObservation(scheduler, async () => {
      const snapshot = await pendingRefresh;
      return snapshot;
    });
    enqueueDownloadJob(scheduler, "BVSTOPPEDREFRESH");
    scheduler.wake();
    scheduler.stop();

    finishRefresh({usedBytes: 0});
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVSTOPPEDREFRESH")?.status, "pending");
    assert.equal(resources(scheduler).queues.get('download').getSize(), 0);
    assert.equal(scheduler.wake(), false);
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
  const scheduler = makeScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) },
    { list: () => [user], getById: () => user },
    state
  );
  try {
    await scheduler.getLocalCacheCapacity();




    let finishRefresh!: (snapshot: {usedBytes: number}) => void;
    const pendingRefresh = new Promise<{usedBytes: number}>((resolve) => { finishRefresh = resolve; });
    setCacheObservation(scheduler, async () => {
      const snapshot = await pendingRefresh;
      return snapshot;
    });
    enqueueDownloadJob(scheduler, "BVCONCURRENTWAKE");
    scheduler.wake();
    scheduler.refreshLocalCacheState();
    scheduler.refreshLocalCacheState();

    finishRefresh({usedBytes: 0});
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVCONCURRENTWAKE")?.status, "leased");
    assert.equal(resources(scheduler).queues.get('download').getSize(), 1);
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
  const scheduler = makeScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) },
    { list: () => [user], getById: () => user },
    state
  );
  const originalWarn = console.warn;
  try {
    await scheduler.getLocalCacheCapacity();



    let refreshAttempts = 0;
    let warningCount = 0;
    console.warn = (...args: unknown[]) => {
      if (String(args[0]).includes("Failed to refresh local cache state")) warningCount += 1;
      else originalWarn(...args);
    };
    setCacheObservation(scheduler, async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new Error("temporary cache scan failure");
      const snapshot = {
        limitBytes: 1024 * 1024 * 1024,
        usedBytes: 0,
        reserveBytes: 512 * 1024 * 1024,
        paused: false,
        checkedAt: Date.now(),
      };
      return snapshot;
    });
    enqueueDownloadJob(scheduler, "BVREFRESHRECOVERY");
    scheduler.wake();

    await new Promise<void>(resolve => setImmediate(resolve));
    resources(scheduler).time.advance(1_000);
    await waitForCondition(() => resources(scheduler).jobs.findByDedupeKey("download:BVREFRESHRECOVERY")?.status === "leased");

    assert.ok(refreshAttempts >= 2);
    assert.equal(warningCount, 1);
    assert.equal(resources(scheduler).queues.get('download').getSize(), 1);
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
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [user], getById: () => user },
    state
  );
  try {
    await scheduler.getLocalCacheCapacity();
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.stop();

    enqueueDownloadJob(scheduler, "BVRESTARTWAKE");

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVRESTARTWAKE")?.status, "leased");
    assert.equal(resources(scheduler).queues.get('download').getSize(), 1);
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
  const scheduler = makeScheduler(
    { get: () => testConfig({ localCacheLimitGB: 1 }) },
    { list: () => [user], getById: () => user },
    state
  );
  try {
    await scheduler.getLocalCacheCapacity();
    await new Promise<void>((resolve) => setImmediate(resolve));

    setCacheObservation(scheduler, async () => ({
      limitBytes: 1024 * 1024 * 1024,
      usedBytes: 900 * 1024 * 1024,
      reserveBytes: 512 * 1024 * 1024,
      paused: true,
      checkedAt: Date.now(),
    }));
    await scheduler.getLocalCacheCapacity();
    enqueueDownloadJob(scheduler, "BVCACHEFULL");

    const {time} = resources(scheduler);
    scheduler.wake();
    assert.equal(time.advance(999), 0);
    assert.equal(time.advance(1), 1);
    assert.equal(time.advance(1_000), 1);
    assert.equal(resources(scheduler).jobs.findByDedupeKey("download:BVCACHEFULL")?.status, "pending");
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("BBDown API mode validates explicit values", () => {
  assert.equal(validateConfig({ bbdownApiMode: "web" }), null);
  assert.equal(validateConfig({ bbdownApiMode: "app" }), null);
  assert.match(String(Reflect.apply(validateConfig, undefined, [{ bbdownApiMode: "mobile" }])), /web or app/);
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
  const snapshot: StateFile = { schemaVersion: 11, processedByUser: {}, failedByUser: {}, videos: {}, relations: {}, folderScans: {}, userCooldowns: {} };
  for (let index = 0; index < 8; index += 1) {
    const mediaId = index < 5 ? 1 : 2;
    const bvid = `BV${mediaId}${index}`;
    assert.ok(snapshot.videos);
    snapshot.videos[bvid] = { bvid, title: bvid, upperName: "Tester", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), biliStatus: "available" as const, backupStatus: "failed" as const };
    assert.ok(snapshot.relations);
    snapshot.relations[`u1:${mediaId}:${bvid}`] = { userId: "u1", mediaId, bvid, folderTitle: mediaId === 1 ? "One" : "Two", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeInFavorite: true, backupStatus: "failed" as const };
  }
  state.replaceStateSnapshot(snapshot);
  const {jobs, enqueue} = recoveryFixture(state, [user], undefined, {config});
  const queued = requeueRetryPending({
    users: () => [user], eligible: user => user.enabled, limit: () => config.remoteRequeueLimitPerCycle,
    state, enqueue: enqueue.enqueue,
  });
  assert.equal(queued, 3);
  assert.equal(jobs.countOutstanding(["download"]), 3);
  state.close();
});

test("persistent quality uploads respect the upload queue hard limit", () => {
  const config = testConfig({ queuePrefetchLimit: 5 });
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {SESSDATA: "test", bili_jct: "test", DedeUserID: "1"}, lastLoginAt: new Date().toISOString(), accessToken: "token", favorites: [] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `quality-capacity-${Date.now()}.json`) });
  const scheduler = makeScheduler(
    { get: () => config },
    { list: () => [user], getById: () => user },
    state
  );

  for (let index = 0; index < 5; index += 1) {
    assert.equal(resources(scheduler).queues.get('upload').addTask(new IdleTask(`fill-${index}`)), true);
  }
  resources(scheduler).jobs.enqueue({ kind: "quality_upload" as const, dedupeKey: "quality-upload:u1:1:BVQUALITY", bvid: "BVQUALITY", userId: "u1", mediaId: 1, payload: { bvid: "BVQUALITY", userId: "u1", mediaId: 1, runId: "run", downloadDir: "missing", target: { userId: "u1", mediaId: 1, folderTitle: "Favorites", remotePath: "/backup/BVQUALITY", oldFiles: [] } } });
  scheduler.wake();
  assert.equal(resources(scheduler).queues.get('upload').getSize(), 5);
  assert.equal(resources(scheduler).jobs.countOutstanding(["quality_upload"]), 1);

  const first = resources(scheduler).queues.get('upload').getTasks()[0];
  resources(scheduler).queues.get('upload').removePendingTasks(task => task.id === first.id);
  scheduler.wake();
  assert.equal(resources(scheduler).queues.get('upload').getSize(), 5);
  assert.equal(resources(scheduler).jobs.list(["quality_upload"])[0].status, "leased");
  scheduler.stop();
  state.close();
});

test("quality upgrade advances atomically through download upload and replace while cleanup waits for final archive commit", () => {
  const config = testConfig();
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {SESSDATA: "test", bili_jct: "test", DedeUserID: "1"}, lastLoginAt: new Date().toISOString(), accessToken: "token", favorites: [] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `quality-phases-${Date.now()}.json`) });
  const scheduler = makeScheduler({ get: () => config }, { list: () => [user], getById: () => user }, state);


  const control = new QualityUpgradeTask("BVQUALITYPHASE", user.cookie, config, { userId: "u1", mediaId: 1, folderTitle: "Favorites", remotePath: "/target", oldFiles: [] });
  control.videoTitle = "Quality phase";
  assert.equal(scheduler.enqueueQualityUpgrade(control), true);
  let phase = resources(scheduler).queues.get('download').getTasks()[0];
  resources(scheduler).queues.get('download').removePendingTasks(() => true);
  assert.ok(phase instanceof QualityUpgradeDownloadTask);
  phase.control.runId = "run";
  phase.control.downloadDir = "local";
  phase.control.outputFiles = ["video.mp4"];
  resources(scheduler).queues.get('download').emit("taskCompleted", phase);
  assert.equal(resources(scheduler).jobs.list(["quality_upload"])[0].status, "leased");

  phase = resources(scheduler).queues.get('upload').getTasks()[0];
  resources(scheduler).queues.get('upload').removePendingTasks(() => true);
  assert.ok(phase instanceof QualityUpgradeUploadReplaceTask);
  phase.control.uploadResult = { remotePath: "/target/.stage", files: [{ name: "video.mp4", path: "/target/.stage/video.mp4", size: 1, verificationStatus: "verified" as const }], allVerified: true };
  resources(scheduler).queues.get('upload').emit("taskCompleted", phase);
  assert.equal(resources(scheduler).jobs.list(["quality_replace"])[0].status, "leased");

  phase = resources(scheduler).queues.get('upload').getTasks()[0];
  resources(scheduler).queues.get('upload').removePendingTasks(() => true);
  assert.ok(phase instanceof QualityUpgradeReplaceTask);
  phase.control.finalFiles = [{ name: "video.mp4", path: "/target/video.mp4", size: 1, verificationStatus: "verified" as const }];
  phase.control.backupFiles = [];
  resources(scheduler).queues.get('upload').emit("taskCompleted", phase);
  assert.equal(resources(scheduler).jobs.list(["quality_cleanup"])[0].status, "leased");

  phase = resources(scheduler).queues.get('upload').getTasks()[0];
  resources(scheduler).queues.get('upload').removePendingTasks(() => true);
  assert.ok(phase instanceof QualityUpgradeCleanupTask);
  resources(scheduler).queues.get('upload').emit("taskCompleted", phase);
  assert.equal(resources(scheduler).jobs.countOutstanding(["quality_download", "quality_upload", "quality_replace", "quality_cleanup"]), 1);
  assert.equal(resources(scheduler).jobs.list(["quality_cleanup"])[0]?.status, "leased");
  scheduler.stop();
  state.close();
});

test("download completion re-reads relations added after the BVID job was claimed", () => {
  const config = testConfig();
  const user = { id: "u1", uid: 1, name: "Tester", enabled: true, cookie: {SESSDATA: "test", bili_jct: "test", DedeUserID: "1"}, lastLoginAt: new Date().toISOString(), favorites: [{ mediaId: 1, title: "One" }, { mediaId: 2, title: "Two" }] };
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `download-target-race-${Date.now()}.json`) });
  const now = new Date().toISOString();
  state.replaceStateSnapshot({
    schemaVersion: 11, processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: { BVRACE: { bvid: "BVRACE", title: "Race", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available" as const, backupStatus: "downloaded" as const, localDir: "local" } },
    relations: {
      "u1:1:BVRACE": { userId: "u1", mediaId: 1, bvid: "BVRACE", folderTitle: "One", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "downloaded" as const },
      "u1:2:BVRACE": { userId: "u1", mediaId: 2, bvid: "BVRACE", folderTitle: "Two", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "queued" as const },
    },
  });
  const scheduler = makeScheduler({ get: () => config }, { list: () => [user], getById: () => user }, state);

  const task = new DownloadTask("BVRACE", user.cookie, config);
  task.downloadDir = "local";
  task.outputFiles = ["video.mp4"];
  task.targets = [{ userId: "u1", mediaId: 1, folderTitle: "One", remotePath: "/one" }];
  resources(scheduler).queues.get('download').emit("taskCompleted", task);
  assert.equal(resources(scheduler).jobs.countOutstanding(["upload"]), 2);
  scheduler.stop();
  state.close();
});
