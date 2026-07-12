import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyVideoAccess } from "../src/bili.js";
import { downloadWithBBDown } from "../src/downloader.js";
import {
  computeChargingRecheckDelayMs,
  computeChargingTransientDelayMs,
  SyncScheduler,
} from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";
import { writeJsonFile } from "../src/storage.js";

const at = "2026-07-12T00:00:00.000Z";

function chargingSnapshot(play: boolean, preview = true) {
  return {
    available: true,
    access: classifyVideoAccess({
      is_upower_exclusive: true,
      is_upower_play: play,
      is_upower_preview: preview,
    }, "view_detail"),
    pages: [{ index: 1, cid: 1, title: "P1", duration: 60 }],
  };
}

function createChargingState(status = "failed") {
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {
      u1: {
        "1:BVCHARGE": {
          bvid: "BVCHARGE",
          mediaId: 1,
          failedAt: at,
          reason: "old download failure",
          permanent: true,
        },
      },
    },
    videos: {
      BVCHARGE: {
        bvid: "BVCHARGE",
        title: "Charge",
        upperName: "UP",
        firstSeenAt: at,
        lastSeenAt: at,
        biliStatus: "available",
        backupStatus: status,
      },
    },
    relations: {
      "u1:1:BVCHARGE": {
        userId: "u1",
        mediaId: 1,
        bvid: "BVCHARGE",
        folderTitle: "Favorites",
        firstSeenAt: at,
        lastSeenAt: at,
        activeInFavorite: true,
        backupStatus: status,
      },
    },
    folderScans: {},
    userCooldowns: {},
  } as any;
}

test("charging access fields distinguish normal, restricted, allowed, and unknown", () => {
  assert.equal(classifyVideoAccess({ is_upower_exclusive: false, is_upower_play: false }).classification, "normal");
  assert.equal(classifyVideoAccess({ is_upower_exclusive: true, is_upower_play: false }).classification, "charging_restricted");
  assert.equal(classifyVideoAccess({ is_upower_exclusive: true, is_upower_play: true }).classification, "charging_allowed");
  assert.equal(classifyVideoAccess({ is_upower_exclusive: true }).classification, "unknown");
  assert.equal(classifyVideoAccess({ is_ugc_pay_preview: true }).classification, "unknown");
});

test("charging restriction is raised before a download directory or BBDown process is created", async () => {
  const runtime = await createTestDir("charging-preflight");
  const downloadDir = path.join(runtime, "BVCHARGE");
  try {
    await assert.rejects(
      downloadWithBBDown("BVCHARGE", {
        SESSDATA: "test",
        bili_jct: "test",
        DedeUserID: "1",
      }, testConfig(), {
        downloadDir,
        pageSnapshot: chargingSnapshot(false),
        command: "this-command-must-not-run",
      }),
      (error: any) => error?.chargingRestricted === true && error?.accountUid === 1
    );
    assert.equal(fs.existsSync(downloadDir), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("charging status clears old failures but preserves verified relations", async () => {
  const runtime = await createTestDir("charging-state");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  try {
    manager.replaceStateSnapshot(createChargingState());
    manager.markChargingRestricted("BVCHARGE", {
      checkedAt: at,
      nextCheckAt: "2026-07-19T00:00:00.000Z",
      previewAvailable: true,
      checkedAccountUids: ["1"],
    });
    const restricted = manager.listFolderItemsForUser("u1", 1, 0, 20, "pending").items[0];
    assert.equal(restricted.backupStatus, "charging_restricted");
    assert.equal(restricted.failed, false);
    assert.equal(restricted.accessRestriction?.previewAvailable, true);
    assert.equal(manager.getStateSnapshot().schemaVersion, 13);

    manager.clearChargingRestriction("BVCHARGE", "2026-07-20T00:00:00.000Z");
    assert.equal(manager.listFolderItemsForUser("u1", 1, 0, 20, "pending").items[0].backupStatus, "discovered");

    const verified = createChargingState("verified");
    verified.failedByUser = {};
    manager.replaceStateSnapshot(verified);
    manager.markChargingRestricted("BVCHARGE", {
      checkedAt: at,
      nextCheckAt: "2026-07-19T00:00:00.000Z",
      checkedAccountUids: ["1"],
    });
    assert.equal(manager.getRelationStatus("u1", 1, "BVCHARGE")?.backupStatus, "verified");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("access probe checks enabled accounts in order and queues download with the account that has access", async () => {
  const runtime = await createTestDir("charging-multi-account");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(createChargingState("charging_restricted"));
  manager.markChargingRestricted("BVCHARGE", {
    checkedAt: at,
    nextCheckAt: at,
    checkedAccountUids: [],
  });
  const users = [
    { id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at },
    { id: "u2", uid: 2, name: "Two", cookie: { SESSDATA: "two", bili_jct: "two", DedeUserID: "2" }, favorites: [], enabled: true, lastLoginAt: at },
  ];
  const checked: string[] = [];
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [...users], getById: (id: string) => users.find((user) => user.id === id) || null } as any,
    manager,
    {
      now: () => Date.parse(at),
      random: () => 0.5,
      videoAccessProbe: async (cookie) => {
        checked.push(String(cookie.DedeUserID));
        return chargingSnapshot(cookie.DedeUserID === "2");
      },
    }
  );
  try {
    const store = (scheduler as any).jobStore;
    store.enqueue({ kind: "access_probe", dedupeKey: "access_probe:BVCHARGE", bvid: "BVCHARGE", notBefore: 0, payload: { preferredUserId: "u1" } });
    const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, Date.parse(at));
    store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
    (scheduler as any).acceptingJobs = false;
    await (scheduler as any).runChargingAccessProbe(job);
    assert.deepEqual(checked, ["1", "2"]);
    assert.equal(manager.getChargingRestriction("BVCHARGE"), undefined);
    const downloadJob = store.findByDedupeKey("download:BVCHARGE");
    assert.equal(downloadJob?.payload.downloadUserId, "u2");
    assert.equal(downloadJob?.payload.primaryUserId, "u1");
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("charging delays remain inside their configured jitter windows", () => {
  assert.equal(computeChargingRecheckDelayMs(() => 0), 6.5 * 24 * 60 * 60_000);
  assert.equal(computeChargingRecheckDelayMs(() => 1), 7.5 * 24 * 60 * 60_000);
  assert.equal(computeChargingTransientDelayMs(() => 0), 5.5 * 60 * 60_000);
  assert.equal(computeChargingTransientDelayMs(() => 1), 6.5 * 60 * 60_000);
});

test("a complete local session uploads immediately instead of waiting for charging access", async () => {
  const runtime = await createTestDir("charging-local-upload");
  const localDir = path.join(runtime, "temp", "BVCHARGE");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "complete.mp4"), "complete");
  writeJsonFile(path.join(localDir, ".bfb-download.json"), {
    schemaVersion: 1,
    sessionId: "complete-session",
    kind: "backup",
    bvid: "BVCHARGE",
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: at,
    updatedAt: at,
    snapshotAt: at,
    status: "complete",
    pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
    outputs: [{ pageIndex: 1, cid: 1, relativePath: "complete.mp4", size: 8, duration: 1, videoCodec: "test", quickHash: "test", verifiedAt: at }],
    history: [],
  });
  const state = createChargingState("charging_restricted");
  state.videos.BVCHARGE.localDir = localDir;
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(state);
  manager.markChargingRestricted("BVCHARGE", { checkedAt: at, nextCheckAt: at, checkedAccountUids: ["1"] });
  const user = { id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at };
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager
  );
  try {
    (scheduler as any).acceptingJobs = false;
    const queued = (scheduler as any).enqueueIfNeeded(user, 1, "Favorites", "BVCHARGE");
    assert.equal(queued, true);
    assert.equal(manager.getChargingRestriction("BVCHARGE"), undefined);
    assert.equal((scheduler as any).jobStore.list(["upload"], 10).length, 1);
    assert.equal((scheduler as any).jobStore.findByDedupeKey("access_probe:BVCHARGE"), null);
  } finally {
    await scheduler.shutdown(100);
    await removeTestDir(runtime);
  }
});

test("access probe maps restricted, transient, unavailable, and no-account results to persistent schedules", async (t) => {
  const nowMs = Date.now();
  const scenarios = [
    {
      name: "restricted for seven days",
      users: [{ id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at }],
      snapshot: chargingSnapshot(false),
      expectedDelay: 7 * 24 * 60 * 60_000,
      expectedStatus: "charging_restricted",
    },
    {
      name: "unknown for six hours",
      users: [{ id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at }],
      snapshot: { available: true, access: classifyVideoAccess(undefined), pages: [{ index: 1, cid: 1, title: "P1", duration: 60 }] },
      expectedDelay: 6 * 60 * 60_000,
      expectedStatus: "charging_restricted",
    },
    {
      name: "no account for twenty-four hours",
      users: [],
      snapshot: chargingSnapshot(false),
      expectedDelay: 24 * 60 * 60_000,
      expectedStatus: "charging_restricted",
    },
    {
      name: "unavailable becomes lost",
      users: [{ id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at }],
      snapshot: { available: false, access: classifyVideoAccess(undefined), pages: [] },
      expectedDelay: null,
      expectedStatus: "lost",
    },
  ] as any[];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const runtime = await createTestDir(`charging-${scenario.name.replace(/\W+/g, "-")}`);
      let manager = new StateManager({
        statePath: path.join(runtime, "data", "state.json"),
        dbPath: path.join(runtime, "data", "bfb.sqlite"),
      });
      manager.replaceStateSnapshot(createChargingState("charging_restricted"));
      manager.markChargingRestricted("BVCHARGE", { checkedAt: at, nextCheckAt: at, checkedAccountUids: [] });
      const scheduler = new SyncScheduler(
        { get: () => testConfig() } as any,
        { list: () => [...scenario.users], getById: (id: string) => scenario.users.find((user: any) => user.id === id) || null } as any,
        manager,
        { now: () => nowMs, random: () => 0.5, videoAccessProbe: async () => scenario.snapshot }
      );
      try {
        const store = (scheduler as any).jobStore as PersistentJobStore;
        store.enqueue({ kind: "access_probe", dedupeKey: "access_probe:BVCHARGE", bvid: "BVCHARGE", notBefore: 0, payload: { preferredUserId: "u1" } });
        const [job] = store.claimDue(["access_probe"], 1, (scheduler as any).leaseOwner, 300_000, nowMs);
        store.markRunning(job.id, (scheduler as any).leaseOwner, 300_000);
        (scheduler as any).acceptingJobs = false;
        await (scheduler as any).runChargingAccessProbe(job);
        const stored = store.findByDedupeKey("access_probe:BVCHARGE");
        if (scenario.expectedDelay === null) assert.equal(stored, null);
        else assert.equal(stored?.notBefore, nowMs + scenario.expectedDelay);
        assert.equal(manager.getRelationStatus("u1", 1, "BVCHARGE")?.backupStatus, scenario.expectedStatus);
        await scheduler.shutdown(100);
        manager = new StateManager({
          statePath: path.join(runtime, "data", "state.json"),
          dbPath: path.join(runtime, "data", "bfb.sqlite"),
        });
        const reopened = new PersistentJobStore(manager.getDatabase()).findByDedupeKey("access_probe:BVCHARGE");
        assert.equal(reopened?.notBefore ?? null, scenario.expectedDelay === null ? null : nowMs + scenario.expectedDelay);
      } finally {
        manager.close();
        await removeTestDir(runtime);
      }
    });
  }
});
