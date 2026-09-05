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

test("availability ignores unrelated accounts while charging probes retain them", async () => {
  const runtime = await createTestDir("availability-related-users");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityPending("BVAVAIL", "favorite_flag", checkedAt);
  const users = [...testUsers(), { ...testUsers()[0], id: "u3", uid: 3, cookie: { SESSDATA: "three", bili_jct: "three", DedeUserID: "3" }, favorites: [] }];
  const checked: string[] = [];
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { videoAccessProbe: async (cookie) => {
      checked.push(String(cookie.DedeUserID));
      if (cookie.DedeUserID === "3") throw Object.assign(new Error("unrelated account expired"), { biliLoginRequired: true });
      return unavailableSnapshot();
    } },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { notBefore: Date.now() });
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, Date.now());
    await (scheduler as any).runAvailabilityProbe(job);
    assert.deepEqual(checked, ["2", "1"]);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "confirmed_unavailable");
    const chargingUsers = (scheduler as any).availabilityProbeUsers("BVAVAIL", "", new Set(), true);
    assert.equal(chargingUsers.some((user: any) => user.id === "u3"), true);
    users.splice(0, 2);
    assert.equal(scheduler.requestAvailabilityRecheck("BVAVAIL").status, 409);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

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

test("availability retry delays keep the base schedule and add stable BVID staggering", () => {
  const unknownBase = [
    10 * 60_000,
    60 * 60_000,
    6 * 60 * 60_000,
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ];
  const unavailableBase = [
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
    30 * 24 * 60 * 60_000,
  ];
  assert.deepEqual([0, 1, 2, 3, 4].map((round) => computeAvailabilityUnknownDelayMs(round)), unknownBase);
  assert.deepEqual([0, 1, 2].map((round) => computeAvailabilityUnavailableDelayMs(round)), unavailableBase);
  const stagger = computeAvailabilityUnknownDelayMs(0, "BVAVAIL") - unknownBase[0];
  assert.ok(stagger >= 0 && stagger < 15 * 60_000);
  assert.deepEqual([0, 1, 2, 3, 4].map((round) => computeAvailabilityUnknownDelayMs(round, "BVAVAIL")),
    unknownBase.map((delay) => delay + stagger));
  assert.deepEqual([0, 1, 2].map((round) => computeAvailabilityUnavailableDelayMs(round, "BVAVAIL")),
    unavailableBase.map((delay) => delay + stagger));
  const repeated = computeAvailabilityUnknownDelayMs(0, "BVAVAIL");
  assert.equal(repeated, unknownBase[0] + stagger);
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
    assert.equal(probe?.notBefore, nowMs + computeAvailabilityUnavailableDelayMs(0, "BVAVAIL"));
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
  let nowMs = Math.max(Date.parse(checkedAt), Date.now());
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
    const expectedDelays = [0, 1, 2].map((round) => computeAvailabilityUnavailableDelayMs(round, "BVAVAIL"));
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
    const delays = [0, 1, 2, 3, 4].map((round) => computeAvailabilityUnknownDelayMs(round, "BVAVAIL"));
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

test("ordinary availability probes do not download through an unrelated enabled account", async () => {
  const runtime = await createTestDir("availability-unrelated-account");
  const nowMs = Date.parse(checkedAt);
  const manager = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityConfirmedUnavailable("BVAVAIL", "api_not_found", checkedAt, checkedAt, 1);
  const users = [
    ...testUsers(),
    { id: "u3", uid: 3, name: "Fallback", cookie: { SESSDATA: "three", bili_jct: "three", DedeUserID: "3" }, favorites: [], enabled: true, lastLoginAt: checkedAt },
  ];
  const checkedUsers: string[] = [];
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs, videoAccessProbe: async (cookie) => { const uid = String(cookie.DedeUserID || ""); checkedUsers.push(uid); return uid === "3" ? availableSnapshot() : unavailableSnapshot(); } },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    (scheduler as any).enqueueAvailabilityProbe("BVAVAIL", { preferredUserId: "u1", notBefore: nowMs, availabilityRound: 1 });
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
    assert.ok(job);
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    await (scheduler as any).runAvailabilityProbe(job);
    assert.deepEqual(checkedUsers, ["2", "1"]);
    assert.equal(manager.getSourceAvailability("BVAVAIL")?.state, "confirmed_unavailable");
    assert.equal(manager.getRelationStatus("u1", 1, "BVAVAIL")?.backupStatus, "lost");
    const downloads = store.list(["download"], 10).filter((item) => item.bvid === "BVAVAIL");
    assert.equal(downloads.length, 0);
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

test("logging in wakes charging plus related or owner availability probes without waking unrelated availability", async () => {
  const runtime = await createTestDir("availability-targeted-login-wake");
  const nowMs = Date.parse(checkedAt);
  const future = nowMs + 7 * 24 * 60 * 60_000;
  const state = availabilityState();
  state.videos.BVOWNER = { ...state.videos.BVAVAIL, bvid: "BVOWNER", title: "Owner", upperMid: 1 };
  state.videos.BVOTHER = { ...state.videos.BVAVAIL, bvid: "BVOTHER", title: "Other", upperMid: 99 };
  state.videos.BVCHARGELOGIN = { ...state.videos.BVAVAIL, bvid: "BVCHARGELOGIN", title: "Charging", upperMid: 99 };
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
    { now: () => nowMs },
  );
  const store = (scheduler as any).jobStore as PersistentJobStore;
  try {
    (scheduler as any).acceptingJobs = false;
    for (const [bvid, intents] of [
      ["BVAVAIL", ["availability"]],
      ["BVOWNER", ["availability"]],
      ["BVOTHER", ["availability"]],
      ["BVCHARGELOGIN", ["charging"]],
    ] as const) {
      store.enqueue({
        kind: "access_probe",
        dedupeKey: `access_probe:${bvid}`,
        bvid,
        priority: 90,
        maxAttempts: 1,
        notBefore: future,
        payload: { intents: [...intents], purpose: intents[0] === "charging" ? "charging_recheck" : "availability_recheck" },
      });
    }

    assert.equal(scheduler.wakeChargingAccessProbes("u1"), 3);
    assert.equal(store.findByDedupeKey("access_probe:BVAVAIL")?.notBefore, nowMs);
    assert.equal(store.findByDedupeKey("access_probe:BVOWNER")?.notBefore, nowMs);
    assert.equal(store.findByDedupeKey("access_probe:BVCHARGELOGIN")?.notBefore, nowMs);
    assert.equal(store.findByDedupeKey("access_probe:BVOTHER")?.notBefore, future);
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
test("startup migrates a legacy fixed availability schedule once and keeps one staggered probe", async () => {
  const runtime = await createTestDir("availability-startup-idempotent");
  const nowMs = Date.parse(checkedAt);
  const legacyNextAt = nowMs + computeAvailabilityUnavailableDelayMs(1);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityConfirmedUnavailable(
    "BVAVAIL",
    "api_not_found",
    checkedAt,
    new Date(legacyNextAt).toISOString(),
    2,
  );
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs },
  );
  try {
    (scheduler as any).acceptingJobs = false;
    const store = (scheduler as any).jobStore as PersistentJobStore;
    (scheduler as any).ensurePersistedAvailabilityProbes();
    const migratedAt = nowMs + computeAvailabilityUnavailableDelayMs(1, "BVAVAIL");
    (scheduler as any).ensurePersistedAvailabilityProbes();
    const jobs = store.list(["access_probe"], 10).filter((job) => job.bvid === "BVAVAIL");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].notBefore, migratedAt);
    assert.equal(Date.parse(manager.getSourceAvailability("BVAVAIL")?.nextCheckAt || ""), migratedAt);
    assert.equal(jobs[0].payload.availabilityRound, 2);
    assert.deepEqual(jobs[0].payload.intents, ["availability"]);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("overdue legacy availability schedules migrate into a short stable catch-up spread", async () => {
  const runtime = await createTestDir("availability-startup-catchup");
  const checkedAtMs = Date.parse(checkedAt);
  const nowMs = checkedAtMs + 40 * 24 * 60 * 60_000;
  const legacyNextAt = checkedAtMs + computeAvailabilityUnavailableDelayMs(1);
  const stagger = computeAvailabilityUnavailableDelayMs(1, "BVAVAIL") - computeAvailabilityUnavailableDelayMs(1);
  const expectedCatchUpAt = nowMs + Math.max(1_000, stagger);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(availabilityState());
  manager.markAvailabilityConfirmedUnavailable(
    "BVAVAIL",
    "api_not_found",
    checkedAt,
    new Date(legacyNextAt).toISOString(),
    2,
  );
  const users = testUsers();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    { now: () => nowMs },
  );
  try {
    (scheduler as any).acceptingJobs = false;
    const store = (scheduler as any).jobStore as PersistentJobStore;
    (scheduler as any).ensurePersistedAvailabilityProbes();
    (scheduler as any).ensurePersistedAvailabilityProbes();
    const job = store.findByDedupeKey("access_probe:BVAVAIL");
    assert.equal(job?.notBefore, expectedCatchUpAt);
    assert.equal(Date.parse(manager.getSourceAvailability("BVAVAIL")?.nextCheckAt || ""), expectedCatchUpAt);
    assert.ok(Number(job?.notBefore) > nowMs);
    assert.ok(Number(job?.notBefore) <= nowMs + 15 * 60_000);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("startup migration leaves manual, merged charging, leased, and already-woken availability probes untouched", async () => {
  const scenarios = [
    { name: "manual", payload: { intents: ["availability"], purpose: "availability_recheck", manual: true }, leased: false, woken: false },
    { name: "merged", payload: { intents: ["charging", "availability"], purpose: "charging_recheck" }, leased: false, woken: false },
    { name: "leased", payload: { intents: ["availability"], purpose: "availability_recheck" }, leased: true, woken: false },
    { name: "woken", payload: { intents: ["availability"], purpose: "availability_recheck" }, leased: false, woken: true },
  ] as const;

  for (const scenario of scenarios) {
    const runtime = await createTestDir(`availability-startup-skip-${scenario.name}`);
    const nowMs = Date.parse(checkedAt);
    const legacyNextAt = nowMs + computeAvailabilityUnavailableDelayMs(1);
    const manager = new StateManager({
      statePath: path.join(runtime, "data", "state.json"),
      dbPath: path.join(runtime, "data", "bfb.sqlite"),
    });
    manager.replaceStateSnapshot(availabilityState());
    manager.markAvailabilityConfirmedUnavailable(
      "BVAVAIL",
      "api_not_found",
      checkedAt,
      new Date(legacyNextAt).toISOString(),
      2,
    );
    const users = testUsers();
    const scheduler = new SyncScheduler(
      { get: () => testConfig() } as any,
      { list: () => users, getById: (id: string) => users.find((user) => user.id === id) || null } as any,
      manager,
      { now: () => nowMs },
    );
    const store = (scheduler as any).jobStore as PersistentJobStore;
    try {
      (scheduler as any).acceptingJobs = false;
      store.enqueue({
        kind: "access_probe",
        dedupeKey: "access_probe:BVAVAIL",
        bvid: "BVAVAIL",
        priority: 90,
        maxAttempts: 1,
        notBefore: scenario.leased || scenario.woken ? nowMs : legacyNextAt,
        payload: { ...scenario.payload },
      });
      if (scenario.leased) {
        const leased = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs)[0];
        assert.ok(leased);
      }

      (scheduler as any).ensurePersistedAvailabilityProbes();
      assert.equal(Date.parse(manager.getSourceAvailability("BVAVAIL")?.nextCheckAt || ""), legacyNextAt, scenario.name);
      const job = store.findByDedupeKey("access_probe:BVAVAIL");
      if (scenario.leased) assert.equal(job?.status, "leased", scenario.name);
      else assert.equal(job?.notBefore, scenario.woken ? nowMs : legacyNextAt, scenario.name);
    } finally {
      await scheduler.shutdown(100);
      await removeTestDir(runtime);
    }
  }
});
