import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyVideoAccess, type VideoPageSnapshotResult } from "../src/bili.js";
import { downloadWithBBDown } from "../src/downloader.js";
import {
  computeAvailabilityUnavailableDelayMs,
  computeChargingRecheckDelayMs,
  computeChargingTransientDelayMs,
} from "../src/scheduler.js";
import { StateManager, type BackupStatus, type StateFile } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";
import { createAccessProbes } from "../src/scheduler/access-probes.js";
import { createBackupEnqueue } from "../src/scheduler/backup-enqueue.js";
import type { BiliUser } from "../src/users.js";
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

function createChargingState(status: BackupStatus = "failed") {
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
  } satisfies StateFile;
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
      (error: unknown) => error instanceof Error && "chargingRestricted" in error && error.chargingRestricted === true && "accountUid" in error && error.accountUid === 1
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
    const verifiedState: StateFile = verified;
    verifiedState.failedByUser = {};
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
  const store = new PersistentJobStore(manager.getDatabase());
  const probes = accessFixture(manager, store, users, async cookie => {
    checked.push(String(cookie.DedeUserID));
    return chargingSnapshot(cookie.DedeUserID === "2");
  }, Date.parse(at));
  try {
    store.enqueue({ kind: "access_probe", dedupeKey: "access_probe:BVCHARGE", bvid: "BVCHARGE", notBefore: 0, payload: { preferredUserId: "u1" } });
    const [job] = store.claimDue(["access_probe"], 1, "charging-test", 300_000, Date.parse(at));
    store.markRunning(job.id, "charging-test", 300_000);
    await probes.charging(job);
    assert.deepEqual(checked, ["1", "2"]);
    assert.equal(manager.getChargingRestriction("BVCHARGE"), undefined);
    const downloadJob = store.findByDedupeKey("download:BVCHARGE");
    assert.equal(downloadJob?.payload.downloadUserId, "u2");
    assert.equal(downloadJob?.payload.primaryUserId, "u1");
  } finally {
    manager.close();
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
  Object.assign(state.videos.BVCHARGE, {localDir});
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(state);
  manager.markChargingRestricted("BVCHARGE", { checkedAt: at, nextCheckAt: at, checkedAccountUids: ["1"] });
  const user = { id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at };
  const store = new PersistentJobStore(manager.getDatabase());
  const enqueue = backupFixture(manager, store);
  try {
    const queued = enqueue.enqueue(user, 1, "Favorites", "BVCHARGE");
    assert.equal(queued, true);
    assert.equal(manager.getChargingRestriction("BVCHARGE"), undefined);
    assert.equal(store.list(["upload"], 10).length, 1);
    assert.equal(store.findByDedupeKey("access_probe:BVCHARGE"), null);
  } finally {
    manager.close();
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
      name: "unavailable becomes a low-frequency availability probe",
      users: [{ id: "u1", uid: 1, name: "One", cookie: { SESSDATA: "one", bili_jct: "one", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Favorites" }], enabled: true, lastLoginAt: at }],
      snapshot: { available: false, access: classifyVideoAccess(undefined), pages: [] },
      expectedDelay: computeAvailabilityUnavailableDelayMs(0, "BVCHARGE"),
      expectedStatus: "lost",
    },
  ] satisfies Array<{name: string; users: BiliUser[]; snapshot: VideoPageSnapshotResult; expectedDelay: number; expectedStatus: string}>;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const runtime = await createTestDir(`charging-${scenario.name.replace(/\W+/g, "-")}`);
      let manager = new StateManager({
        statePath: path.join(runtime, "data", "state.json"),
        dbPath: path.join(runtime, "data", "bfb.sqlite"),
      });
      manager.replaceStateSnapshot(createChargingState("charging_restricted"));
      manager.markChargingRestricted("BVCHARGE", { checkedAt: at, nextCheckAt: at, checkedAccountUids: [] });
      const store = new PersistentJobStore(manager.getDatabase());
      const probes = accessFixture(manager, store, scenario.users, async () => scenario.snapshot, nowMs);
      try {
        store.enqueue({ kind: "access_probe", dedupeKey: "access_probe:BVCHARGE", bvid: "BVCHARGE", notBefore: 0, payload: { preferredUserId: "u1" } });
        const [job] = store.claimDue(["access_probe"], 1, "charging-test", 300_000, nowMs);
        store.markRunning(job.id, "charging-test", 300_000);
        await probes.charging(job);
        const stored = store.findByDedupeKey("access_probe:BVCHARGE");
        if (scenario.expectedDelay === null) assert.equal(stored, null);
        else assert.equal(stored?.notBefore, nowMs + scenario.expectedDelay);
        assert.equal(manager.getRelationStatus("u1", 1, "BVCHARGE")?.backupStatus, scenario.expectedStatus);
        manager.close();
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

function backupFixture(state: StateManager, jobs: PersistentJobStore) {
  return createBackupEnqueue({state, jobs, config: {get: () => testConfig()},
    eligible: user => user.enabled, blocked: () => false, remotePath: () => '/archive', proof: () => undefined,
    uploadJob: item => ({kind: 'upload', dedupeKey: `upload:${item.bvid}`, bvid: item.bvid}),
    historySegment: value => value, probe: () => assert.fail('unexpected access probe'),
    cycleStartedAt: () => undefined, generation: () => 0, now: () => Date.parse(at), dispatch: () => {},
  });
}
function accessFixture(state: StateManager, jobs: PersistentJobStore, users: BiliUser[], inspect: (cookie: BiliUser['cookie']) => Promise<VideoPageSnapshotResult>, now: number) {
  const backup = backupFixture(state, jobs);
  return createAccessProbes({state, jobs, users: {list: () => users}, owner: 'charging-test',
    now: () => now, random: () => 0.5, generation: () => 0, canContinue: () => true,
    eligible: user => user.enabled, inspect, enqueue: backup.enqueue, prepareCharging: backup.prepareAfterAccessCheck,
    resolve: relation => {
      const user = users.find(user => user.id === relation.userId);
      return user ? {user, mediaId: relation.mediaId, folderTitle: relation.folderTitle || 'Favorites'} : null;
    },
  });
}

test('access recovery rolls back permission, probe completion and download state when task insertion fails', async () => {
  const runtime = await createTestDir('charging-atomic');
  const state = new StateManager({statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'state.sqlite')});
  try {
    state.replaceStateSnapshot(createChargingState('charging_restricted'));
    state.markChargingRestricted('BVCHARGE', {checkedAt: at, nextCheckAt: at, checkedAccountUids: []});
    const jobs = new PersistentJobStore(state.getDatabase());
    const users: BiliUser[] = [{id: 'u1', uid: 1, name: 'One', enabled: true, favorites: [{mediaId: 1, title: 'Favorites'}], lastLoginAt: at, cookie: {SESSDATA: 'test', bili_jct: 'test', DedeUserID: '1'}}];
    jobs.enqueue({kind: 'access_probe', dedupeKey: 'access_probe:BVCHARGE', bvid: 'BVCHARGE', notBefore: 0});
    const [job] = jobs.claimDue(['access_probe'], 1, 'charging-test', 300_000, Date.parse(at));
    const before = state.getChargingRestriction('BVCHARGE');
    state.getDatabase().db.exec("CREATE TRIGGER fail_download BEFORE INSERT ON jobs WHEN NEW.kind='download' BEGIN SELECT RAISE(ABORT, 'injected task insert failure'); END");
    await assert.rejects(accessFixture(state, jobs, users, async () => chargingSnapshot(true), Date.parse(at)).charging(job), /injected task insert/);
    assert.deepEqual(state.getChargingRestriction('BVCHARGE'), before);
    assert.equal(jobs.findById(job.id)?.status, 'leased');
    assert.equal(jobs.findByDedupeKey('download:BVCHARGE'), null);
  } finally { state.close(); await removeTestDir(runtime); }
});
