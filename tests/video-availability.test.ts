import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  classifyVideoAccess,
  classifyVideoPageAvailability,
  type VideoPageSnapshotResult,
} from "../src/bili.js";
import { classifyBBDownFailure, downloadWithBBDown } from "../src/downloader.js";
import { PersistentJobStore } from "../src/job-store.js";
import {
  computeAvailabilityUnavailableDelayMs,
  computeAvailabilityUnknownDelayMs,
  SyncScheduler,
} from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { DownloadTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const checkedAt = "2026-09-04T00:00:00.000Z";

function unavailableSnapshot(reason: "api_not_found" | "submission_invisible" = "api_not_found"): VideoPageSnapshotResult {
  return {
    available: false,
    availability: "unavailable",
    availabilityReason: reason,
    apiCodes: [reason === "submission_invisible" ? 62002 : -404],
    access: classifyVideoAccess(undefined),
    pages: [],
  };
}

function availableSnapshot(): VideoPageSnapshotResult {
  return {
    available: true,
    availability: "available",
    access: classifyVideoAccess({ is_upower_exclusive: false }),
    pages: [{ index: 1, cid: 100, title: "P1", duration: 60 }],
  };
}

function availabilityState(status = "discovered") {
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    videos: {
      BVAVAIL: {
        bvid: "BVAVAIL",
        title: "Availability",
        upperName: "UP",
        upperMid: 2,
        firstSeenAt: checkedAt,
        lastSeenAt: checkedAt,
        biliStatus: "available",
        backupStatus: status,
      },
    },
    relations: {
      "u1:1:BVAVAIL": {
        userId: "u1",
        mediaId: 1,
        bvid: "BVAVAIL",
        folderTitle: "Favorites",
        firstSeenAt: checkedAt,
        lastSeenAt: checkedAt,
        activeInFavorite: true,
        backupStatus: status,
      },
    },
    folderScans: {},
    userCooldowns: {},
  } as any;
}

function testUsers() {
  return [
    {
      id: "u1",
      uid: 1,
      name: "Collector",
      cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Favorites" }],
      enabled: true,
      lastLoginAt: checkedAt,
    },
    {
      id: "u2",
      uid: 2,
      name: "Owner",
      cookie: { SESSDATA: "two", bili_jct: "two", DedeUserID: "2" },
      favorites: [],
      enabled: true,
      lastLoginAt: checkedAt,
    },
  ];
}

test("video detail endpoints use a conservative three-state classification", () => {
  const available = { availability: "available", reason: "temporary_error" } as const;
  const missing = { availability: "unavailable", reason: "api_not_found", apiCode: -404 } as const;
  const invisible = { availability: "unavailable", reason: "submission_invisible", apiCode: 62002 } as const;
  const unknown = { availability: "unknown", reason: "temporary_error", apiCode: 500 } as const;
  const empty = { availability: "unknown", reason: "empty_response", apiCode: 0 } as const;

  assert.equal(classifyVideoPageAvailability([missing, available]).availability, "available");
  assert.deepEqual(classifyVideoPageAvailability([missing, invisible]), {
    availability: "unavailable",
    reason: "submission_invisible",
    apiCodes: [-404, 62002],
  });
  assert.equal(classifyVideoPageAvailability([missing, unknown]).availability, "unknown");
  assert.equal(classifyVideoPageAvailability([invisible, empty]).reason, "empty_response");
  assert.equal(classifyVideoPageAvailability([]).availability, "unknown");
});

test("availability retry delays follow the fixed low-frequency schedule", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(computeAvailabilityUnknownDelayMs), [
    10 * 60_000,
    60 * 60_000,
    6 * 60 * 60_000,
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ]);
  assert.deepEqual([0, 1, 2].map(computeAvailabilityUnavailableDelayMs), [
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
    30 * 24 * 60 * 60_000,
  ]);
});

test("only explicit BBDown unavailable output enters the source soft terminal", () => {
  assert.equal(classifyBBDownFailure("Arg_KeyNotFound: dash")?.category, "tool");
  assert.equal(classifyBBDownFailure("未找到此 EP/SS")?.category, "tool");
  assert.equal(classifyBBDownFailure("解析此分P失败")?.category, "transient");
  assert.equal(classifyBBDownFailure("稿件不可见")?.category, "source_unavailable");
  assert.equal(classifyBBDownFailure("视频不存在")?.category, "source_unavailable");
});

test("a favorite unavailable flag pauses download until an explicit probe confirms it", async () => {
  const runtime = await createTestDir("availability-pending");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  try {
    manager.replaceStateSnapshot(availabilityState());
    manager.recordFavoriteItem("u1", 1, "Favorites", {
      bvid: "BVAVAIL",
      title: "Availability",
      upperName: "UP",
      unavailable: true,
      favoriteUnavailable: true,
    }, undefined, checkedAt);

    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "pending_confirmation");
    assert.equal(manager.getVideoMeta("BVAVAIL")?.sourceAvailability?.state, "pending_confirmation");
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "discovered");
    assert.equal(manager.shouldEnqueueBackup("BVAVAIL", "u1", 1), false);

    manager.markAvailabilityConfirmedUnavailable("BVAVAIL", "api_not_found", checkedAt);
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "lost");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("source recovery preserves unrelated failures and manual archive relations", async () => {
  const runtime = await createTestDir("availability-precise-recovery");
  const state = availabilityState("failed");
  state.videos.BVAVAIL.biliStatus = "unavailable";
  state.videos.BVAVAIL.favoriteUnavailable = true;
  state.videos.BVAVAIL.sourceAvailability = {
    state: "confirmed_unavailable",
    reason: "api_not_found",
    firstSeenAt: checkedAt,
    lastCheckedAt: checkedAt,
    checkRound: 1,
  };
  state.relations["u1:1:BVAVAIL"].favoriteUnavailable = true;
  state.relations["u1:1:BVAVAIL"].lastError = "WebDAV permission denied";
  state.relations["u1:-1:BVAVAIL"] = {
    userId: "u1",
    mediaId: -1,
    sourceKind: "manual",
    bvid: "BVAVAIL",
    folderTitle: "Manual",
    firstSeenAt: checkedAt,
    lastSeenAt: checkedAt,
    activeInFavorite: true,
    backupStatus: "discovered",
    lastError: "manual task error",
  };
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  try {
    manager.replaceStateSnapshot(state);
    manager.markAvailabilityRecovered("BVAVAIL", checkedAt);
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "failed");
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.lastError, "WebDAV permission denied");
    assert.equal(manager.getRelationStatus("u1", -1, "BVAVAIL")?.lastError, "manual task error");

    manager.markAvailabilityConfirmedUnavailable("BVAVAIL", "api_not_found", checkedAt);
    assert.equal(manager.getRelationStatus("u1", -1, "BVAVAIL")?.backupStatus, "discovered");
    assert.equal(manager.getRelationStatus("u1", -1, "BVAVAIL")?.lastError, "manual task error");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy unavailable recovery clears only a source-owned permanent failure", async () => {
  const runtime = await createTestDir("availability-legacy-recovery");
  const state = availabilityState("lost");
  state.videos.BVAVAIL.biliStatus = "unavailable";
  state.videos.BVAVAIL.favoriteUnavailable = true;
  state.relations["u1:1:BVAVAIL"].favoriteUnavailable = true;
  state.relations["u1:1:BVAVAIL"].lastError = "BBDown reported failure: 稿件不可见";
  state.failedByUser = {
    u1: {
      "1:BVAVAIL": {
        bvid: "BVAVAIL",
        mediaId: 1,
        failedAt: checkedAt,
        reason: "BBDown reported failure: 稿件不可见",
        permanent: true,
      },
    },
  };
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  try {
    manager.replaceStateSnapshot(state);
    manager.markLegacyAccessClassification("BVAVAIL", { result: "available", classifiedAt: checkedAt });
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "discovered");
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.lastError, undefined);
    assert.equal(manager.getFailedEntry("u1", "BVAVAIL", 1), undefined);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a definitive unavailable preflight never starts BBDown", async () => {
  const runtime = await createTestDir("availability-download-preflight");
  const downloadDir = path.join(runtime, "BVAVAIL");
  try {
    await assert.rejects(
      downloadWithBBDown("BVAVAIL", { DedeUserID: "1" }, testConfig(), {
        downloadDir,
        pageSnapshot: unavailableSnapshot(),
        command: "this-command-must-not-run",
      }),
      (error: any) => error?.code === "BILI_VIDEO_UNAVAILABLE"
        && error?.downloadFailureCategory === "source_unavailable",
    );
    assert.equal(fs.existsSync(downloadDir), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("a source-unavailable download becomes a low-frequency probe without an upload", async () => {
  const runtime = await createTestDir("availability-download-terminal");
  const nowMs = Date.parse(checkedAt);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState("downloading"));
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs },
  );
  try {
    (scheduler as any).acceptingJobs = false;
    const task = new DownloadTask("BVAVAIL", users[0].cookie, testConfig());
    task.userId = "u1";
    (scheduler as any).handleSourceUnavailableTask(task, { availabilityReason: "api_not_found" });

    const store = (scheduler as any).jobStore as PersistentJobStore;
    const probe = store.findByDedupeKey("access_probe:BVAVAIL");
    assert.equal(probe?.notBefore, nowMs + 24 * 60 * 60_000);
    assert.deepEqual(probe?.payload.intents, ["availability"]);
    assert.equal(store.countOutstanding(["upload"]), 0);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "confirmed_unavailable");
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, 1);
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "lost");
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("unavailable probes prefer the uploader account and become dormant after 1d, 7d, and 30d", async () => {
  const runtime = await createTestDir("availability-lifecycle");
  let nowMs = Date.parse(checkedAt);
  const checkedUsers: string[] = [];
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityPending("BVAVAIL", "favorite_flag", checkedAt);
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    {
      now: () => nowMs,
      videoAccessProbe: async (cookie) => {
        checkedUsers.push(String(cookie.DedeUserID));
        return unavailableSnapshot();
      },
    },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { preferredUserId: "u1", notBefore: nowMs });
    const expectedDelays = [24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000];
    for (let round = 0; round < 4; round += 1) {
      const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
      assert.ok(job, `round ${round} should have a due probe`);
      store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
      await (scheduler as any).runAvailabilityProbe(job);
      if (round < expectedDelays.length) {
        const next = store.findByDedupeKey("access_probe:BVAVAIL");
        assert.equal(next?.notBefore, nowMs + expectedDelays[round]);
        assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, round + 1);
        nowMs = Number(next?.notBefore);
      }
    }

    assert.deepEqual(checkedUsers.slice(0, 2), ["2", "1"]);
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL"), null);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "dormant");
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, 3);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("temporarily unknown availability backs off through 10m, 1h, 6h, 1d, and 7d before dormancy", async () => {
  const runtime = await createTestDir("availability-unknown-lifecycle");
  let nowMs = Date.now();
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityPending("BVAVAIL", "favorite_flag", checkedAt);
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    {
      now: () => nowMs,
      videoAccessProbe: async () => ({
        available: false,
        availability: "unknown",
        availabilityReason: "temporary_error",
        access: classifyVideoAccess(undefined),
        pages: [],
      }),
    },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { preferredUserId: "u1", notBefore: nowMs });
    const delays = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000];
    for (let round = 0; round <= delays.length; round += 1) {
      const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
      assert.ok(job, `unknown round ${round} should have a due probe`);
      store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
      await (scheduler as any).runAvailabilityProbe(job);
      if (round < delays.length) {
        const next = store.findByDedupeKey("access_probe:BVAVAIL");
        assert.equal(next?.notBefore, nowMs + delays[round]);
        assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, round + 1);
        nowMs = Number(next?.notBefore);
      }
    }
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL"), null);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "dormant");
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.reason, "temporary_error");
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("manual recheck preserves an existing unavailable schedule when the source is still unavailable", async () => {
  const runtime = await createTestDir("availability-manual-preserves-schedule");
  const nowMs = Date.parse(checkedAt);
  const scheduledAt = nowMs + 7 * 24 * 60 * 60_000;
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityConfirmedUnavailable(
    "BVAVAIL",
    "api_not_found",
    checkedAt,
    new Date(scheduledAt).toISOString(),
    2,
  );
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs, videoAccessProbe: async () => unavailableSnapshot() },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", {
      preferredUserId: "u1",
      notBefore: scheduledAt,
      availabilityRound: 2,
      availabilityReason: "api_not_found",
    });
    assert.equal(scheduler.requestAvailabilityRecheck("BVAVAIL").ok, true);
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    await (scheduler as any).runAvailabilityProbe(job);

    const next = store.findByDedupeKey("access_probe:BVAVAIL");
    assert.equal(next?.notBefore, scheduledAt);
    assert.equal(next?.payload.manual, false);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "confirmed_unavailable");
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, 2);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.nextCheckAt, new Date(scheduledAt).toISOString());
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("one available account revives the relation and queues exactly one download", async () => {
  const runtime = await createTestDir("availability-recovered");
  const nowMs = Date.parse(checkedAt);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityConfirmedUnavailable("BVAVAIL", "api_not_found", checkedAt, checkedAt, 1);
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs, videoAccessProbe: async () => availableSnapshot() },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { preferredUserId: "u1", notBefore: nowMs, availabilityRound: 1 });
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    await (scheduler as any).runAvailabilityProbe(job);

    assert.equal(manager.getSourceAvailability("BVAVAIL"), undefined);
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "queued");
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL"), null);
    assert.equal(store.list(["download"], 10).filter((item) => item.bvid === "BVAVAIL").length, 1);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("an archived video keeps its source status without an automatic long-term probe", async () => {
  const runtime = await createTestDir("availability-archived-no-probe");
  const nowMs = Date.parse(checkedAt);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState("verified"));
  manager.markAvailabilityPending("BVAVAIL", "favorite_flag", checkedAt);
  const users = testUsers();
  let probeCalls = 0;
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs, videoAccessProbe: async () => { probeCalls += 1; return availableSnapshot(); } },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { preferredUserId: "u1", notBefore: nowMs });
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    await (scheduler as any).runAvailabilityProbe(job);
    assert.equal(probeCalls, 0);
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL"), null);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "pending_confirmation");
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "verified");
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("charging and availability intents share one persistent probe", async () => {
  const runtime = await createTestDir("availability-merged-intents");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: () => users[0] } as any,
    manager,
    { now: () => Date.parse(checkedAt) },
  );
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueChargingAccessProbe("BVAVAIL", { intents: ["charging"] });
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { availabilityRound: 1 });
    const store = (scheduler as any).jobStore as PersistentJobStore;
    const job = store.findByDedupeKey("access_probe:BVAVAIL");
    assert.deepEqual(new Set(job?.payload.intents), new Set(["charging", "availability"]));
    assert.equal(store.list(["access_probe"], 10).length, 1);
    assert.equal(store.accessProbeScheduleSummary("charging").count, 1);
    assert.equal(store.accessProbeScheduleSummary("availability").count, 1);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("manual availability recheck requires an enabled account", async () => {
  const runtime = await createTestDir("availability-no-account");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => null } as any,
    manager,
    { now: () => Date.parse(checkedAt) },
  );
  try {
    (scheduler as any).acceptingJobs = false;
    const result = scheduler.requestAvailabilityRecheck("BVAVAIL");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal((scheduler as any).jobStore.findByDedupeKey("access_probe:BVAVAIL"), null);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("logging in wakes a related dormant video once without resetting its lifecycle", async () => {
  const runtime = await createTestDir("availability-dormant-login");
  const nowMs = Date.parse(checkedAt);
  const state = availabilityState("lost");
  state.videos.BVAVAIL.biliStatus = "unavailable";
  state.videos.BVAVAIL.favoriteUnavailable = true;
  state.videos.BVAVAIL.sourceAvailability = {
    state: "dormant",
    reason: "api_not_found",
    firstSeenAt: checkedAt,
    lastCheckedAt: checkedAt,
    checkRound: 3,
  };
  state.relations["u1:1:BVAVAIL"].favoriteUnavailable = true;
  state.relations["u1:1:BVAVAIL"].lastError = "Video is currently unavailable on Bilibili.";
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(state);
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs, videoAccessProbe: async () => unavailableSnapshot() },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    assert.equal(scheduler.wakeChargingAccessProbes("u1"), 1);
    assert.equal(scheduler.wakeChargingAccessProbes("u1"), 1);
    assert.equal(store.list(["access_probe"], 10).length, 1);
    const job = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs)[0];
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    await (scheduler as any).runAvailabilityProbe(job);
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL"), null);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "dormant");
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.checkRound, 3);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});
