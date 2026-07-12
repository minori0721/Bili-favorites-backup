import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { StateManager, type StateFile } from "../src/state.js";
import { StateDatabase } from "../src/database.js";
import { writeJsonFile } from "../src/storage.js";
import { createTestDir, removeTestDir } from "./helpers.js";

const now = "2026-07-10T00:00:00.000Z";

function baseState(): StateFile {
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    videos: {},
    relations: {},
    folderScans: {},
    userCooldowns: {},
  };
}

function addVideo(state: StateFile, index: number, status: any, localDir?: string, description = "") {
  const bvid = `BVTEST${String(index).padStart(6, "0")}`;
  state.videos![bvid] = {
    bvid,
    title: `Video ${index}`,
    upperName: "Tester",
    description,
    firstSeenAt: now,
    lastSeenAt: now,
    biliStatus: "available",
    backupStatus: status,
    localDir,
  };
  state.relations![`u1:1:${bvid}`] = {
    userId: "u1",
    mediaId: 1,
    bvid,
    folderTitle: "Favorites",
    firstSeenAt: now,
    lastSeenAt: now,
    activeInFavorite: true,
    backupStatus: status,
    remotePath: `/backup/${bvid}`,
  };
  return bvid;
}

test("schema 8 failed state with an existing local directory migrates to upload_failed", async () => {
  const runtime = await createTestDir("state-migration");
  try {
    const localDir = path.join(runtime, "local-video");
    await fs.promises.mkdir(localDir);
    const state = baseState();
    state.schemaVersion = 8;
    const bvid = addVideo(state, 1, "failed", localDir);
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);

    const manager = new StateManager({
      statePath,
      dbPath: path.join(runtime, "bfb.sqlite"),
    });
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.schemaVersion, 13);
    assert.equal(snapshot.videos![bvid].backupStatus, "upload_failed");
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "upload_failed");
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(path.join(runtime, "bfb.sqlite")), true);
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});

test("an incomplete schema 10 download session resumes downloading instead of uploading", async () => {
  const runtime = await createTestDir("state-incomplete-session");
  try {
    const localDir = path.join(runtime, "video");
    await fs.promises.mkdir(localDir, { recursive: true });
    writeJsonFile(path.join(localDir, ".bfb-download.json"), {
      schemaVersion: 1,
      sessionId: "session-1",
      kind: "backup",
      bvid: "BVTEST000077",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
      createdAt: now,
      updatedAt: now,
      snapshotAt: now,
      status: "downloading",
      pages: [{ index: 1, cid: 1, title: "P1", duration: 10 }],
      outputs: [],
      history: [],
    });
    const state = baseState();
    addVideo(state, 77, "downloading", localDir);
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    const manager = new StateManager({ statePath });
    manager.normalizePersistedWorkForRecovery();
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos!.BVTEST000077.backupStatus, "queued");
    assert.equal(snapshot.videos!.BVTEST000077.localDir, localDir);
    assert.equal(snapshot.videos!.BVTEST000077.downloadSession?.status, "downloading");
  } finally {
    await removeTestDir(runtime);
  }
});

test("legacy local cache without a manifest is adopted before any upload is attempted", async () => {
  const runtime = await createTestDir("state-legacy-adoption");
  try {
    const localDir = path.join(runtime, "legacy-video");
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "legacy.mp4"), "legacy");
    const state = baseState();
    const bvid = addVideo(state, 78, "upload_failed", localDir);
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    const manager = new StateManager({ statePath });
    manager.normalizePersistedWorkForRecovery();
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos![bvid].backupStatus, "queued");
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "queued");
    assert.equal(snapshot.videos![bvid].localDir, localDir);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 8 migrates a failed relation even when another target kept the video verified", async () => {
  const runtime = await createTestDir("state-relation-migration");
  try {
    const localDir = path.join(runtime, "local-video");
    await fs.promises.mkdir(localDir);
    const state = baseState();
    state.schemaVersion = 8;
    const bvid = addVideo(state, 9, "verified", localDir);
    state.relations![`u1:1:${bvid}`].backupStatus = "failed";
    state.relations![`u2:2:${bvid}`] = {
      userId: "u2",
      mediaId: 2,
      bvid,
      folderTitle: "Second",
      firstSeenAt: now,
      lastSeenAt: now,
      activeInFavorite: true,
      backupStatus: "verified",
    };
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);

    const manager = new StateManager({ statePath });
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "upload_failed");
    assert.equal(snapshot.relations![`u2:2:${bvid}`].backupStatus, "verified");
    assert.equal(snapshot.videos![bvid].backupStatus, "upload_failed");
  } finally {
    await removeTestDir(runtime);
  }
});

test("multi-target upload keeps local data until every target is verified", async () => {
  const runtime = await createTestDir("state-multi-target");
  try {
    const localDir = path.join(runtime, "video");
    await fs.promises.mkdir(localDir);
    const state = baseState();
    const bvid = addVideo(state, 2, "downloaded", localDir);
    state.relations![`u2:2:${bvid}`] = {
      userId: "u2",
      mediaId: 2,
      bvid,
      folderTitle: "Second",
      firstSeenAt: now,
      lastSeenAt: now,
      activeInFavorite: true,
      backupStatus: "downloaded",
      remotePath: `/second/${bvid}`,
    };
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    const manager = new StateManager({ statePath });

    manager.markUploadFailed(bvid, localDir, "u2", 2, "backend unavailable");
    manager.markVerifiedUpload(bvid, `/backup/${bvid}`, [{ name: "a.mp4", path: `/backup/${bvid}/a.mp4`, size: 10 }], "u1", 1);
    let snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos![bvid].localDir, localDir);
    assert.equal(snapshot.videos![bvid].backupStatus, "upload_failed");
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "verified");
    assert.equal(snapshot.relations![`u2:2:${bvid}`].backupStatus, "upload_failed");
    assert.equal(snapshot.videos![bvid].lastError, "backend unavailable");

    manager.markVerifiedUpload(bvid, `/second/${bvid}`, [{ name: "a.mp4", path: `/second/${bvid}/a.mp4`, size: 10 }], "u2", 2);
    snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos![bvid].backupStatus, "verified");
    assert.equal(snapshot.videos![bvid].localDir, localDir);

    manager.markLocalUploadGroupComplete(bvid, localDir);
    snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos![bvid].localDir, undefined);
    assert.equal(snapshot.videos![bvid].backupStatus, "verified");
  } finally {
    await removeTestDir(runtime);
  }
});

test("partial uploads remain distinguishable from complete verified backups", async () => {
  const runtime = await createTestDir("state-partial-verified");
  try {
    const state = baseState();
    const bvid = addVideo(state, 88, "downloaded");
    state.relations![`u1:1:${bvid}`] = {
      userId: "u1",
      mediaId: 1,
      bvid,
      folderTitle: "Favorites",
      firstSeenAt: now,
      lastSeenAt: now,
      activeInFavorite: true,
      backupStatus: "downloaded",
    };
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    const manager = new StateManager({ statePath });
    manager.markVerifiedUpload(bvid, "/remote", [{ name: "partial.mp4", path: "/remote/partial.mp4", size: 10 }], "u1", 1, true);
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.videos![bvid].backupStatus, "partial_verified");
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "partial_verified");
    assert.equal(manager.isProcessed("u1", bvid, 1), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("remote conflict archival clears stale current proofs and keeps an audit record", async () => {
  const runtime = await createTestDir("state-remote-conflict-archive");
  const statePath = path.join(runtime, "state.json");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const state = baseState();
  const bvid = addVideo(state, 88, "uploading", path.join(runtime, "temp", "BVTEST000088"));
  state.relations![`u1:1:${bvid}`] = {
    userId: "u1",
    mediaId: 1,
    bvid,
    folderTitle: "Favorites",
    firstSeenAt: now,
    lastSeenAt: now,
    activeInFavorite: true,
    backupStatus: "uploading",
    remotePath: "/backup",
    remoteFiles: [{ name: "p01.mp4", path: "/backup/p01.mp4", size: 8, verificationStatus: "verified" }],
  };
  state.videos![bvid].remoteFiles = [{ name: "p01.mp4", path: "/backup/p01.mp4", size: 8, verificationStatus: "verified" }];
  const manager = new StateManager({ statePath, dbPath });
  try {
    manager.replaceStateSnapshot(state);
    assert.equal(manager.markRemoteConflictArchived(bvid, "u1", 1, {
      archivePath: "/backup/_history/20260712T120000000Z",
      files: [{
        name: "p01.mp4",
        oldPath: "/backup/p01.mp4",
        archivedPath: "/backup/_history/20260712T120000000Z/p01.mp4",
        size: 8,
      }],
    }), true);
    const relation = manager.getRelationStatus("u1", 1, bvid)!;
    assert.equal(relation.remoteFiles?.length ?? 0, 0);
    assert.equal(relation.remoteConflictArchives?.length, 1);
    assert.equal(relation.remoteConflictArchives?.[0].files[0].archivedPath, "/backup/_history/20260712T120000000Z/p01.mp4");
    assert.equal(manager.getStateSnapshot().videos![bvid].remoteFiles?.length ?? 0, 0);
    const relationRemoteRows = manager.getDatabase().db.prepare("SELECT COUNT(*) AS count FROM remote_files WHERE bvid=? AND user_id=? AND media_id=?").get(bvid, "u1", 1) as any;
    assert.equal(Number(relationRemoteRows.count), 0);
    const allRemoteRows = manager.getDatabase().db.prepare("SELECT COUNT(*) AS count FROM remote_files WHERE bvid=?").get(bvid) as any;
    assert.equal(Number(allRemoteRows.count), 0);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("1000 persisted active records normalize with one full state write", async () => {
  const runtime = await createTestDir("state-stress");
  try {
    const state = baseState();
    const padding = "x".repeat(6000);
    for (let index = 0; index < 1000; index += 1) {
      addVideo(state, index, "uploading", undefined, padding);
    }
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    const originalBytes = (await fs.promises.stat(statePath)).size;
    assert.ok(originalBytes >= 5 * 1024 * 1024);

    let flushes = 0;
    const manager = new StateManager({
      statePath,
      dbPath: path.join(runtime, "bfb.sqlite"),
      onFlush() { flushes += 1; },
    });
    manager.normalizePersistedWorkForRecovery();
    const snapshot = manager.getStateSnapshot();
    assert.ok(flushes <= 1);
    assert.equal(Object.values(snapshot.videos || {}).filter((item) => item.backupStatus === "queued").length, 1000);
    manager.close();
    const sqliteBytes = (await fs.promises.stat(path.join(runtime, "bfb.sqlite"))).size;
    assert.ok(sqliteBytes <= originalBytes * 3);
  } finally {
    await removeTestDir(runtime);
  }
});

test("runBatch coalesces multiple state transitions into one write", async () => {
  const runtime = await createTestDir("state-batch");
  try {
    const state = baseState();
    const first = addVideo(state, 1, "discovered");
    const second = addVideo(state, 2, "discovered");
    const statePath = path.join(runtime, "state.json");
    writeJsonFile(statePath, state);
    let flushes = 0;
    const manager = new StateManager({
      statePath,
      dbPath: path.join(runtime, "bfb.sqlite"),
      onFlush() { flushes += 1; },
    });
    manager.runBatch(() => {
      manager.markQueued(first, "/one", "u1", 1);
      manager.markQueued(second, "/two", "u1", 1);
    });
    assert.equal(flushes, 1);
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});

test("corrupt legacy JSON aborts migration without deleting the source", async () => {
  const runtime = await createTestDir("state-corrupt-json");
  try {
    const statePath = path.join(runtime, "state.json");
    const dbPath = path.join(runtime, "bfb.sqlite");
    await fs.promises.writeFile(statePath, "{not-json", "utf8");
    assert.throws(() => new StateManager({ statePath, dbPath }), /JSON/);
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("an existing corrupt SQLite database never falls back to legacy JSON", async () => {
  const runtime = await createTestDir("state-corrupt-sqlite");
  try {
    const statePath = path.join(runtime, "state.json");
    const dbPath = path.join(runtime, "bfb.sqlite");
    writeJsonFile(statePath, baseState());
    await fs.promises.writeFile(dbPath, "not-sqlite", "utf8");
    assert.throws(() => new StateManager({ statePath, dbPath }));
    assert.equal(fs.existsSync(statePath), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("foreign-key corruption is rejected before scheduling starts", async () => {
  const runtime = await createTestDir("state-foreign-key");
  try {
    const dbPath = path.join(runtime, "bfb.sqlite");
    const database = new StateDatabase(dbPath);
    database.db.pragma("foreign_keys = OFF");
    database.db.prepare(`
      INSERT INTO favorite_relations(user_id,media_id,bvid,backup_status,active_in_favorite,payload_json,updated_at)
      VALUES('u1',1,'BVMISSING','queued',1,'{}',0)
    `).run();
    database.close();
    assert.throws(() => new StateManager({ statePath: path.join(runtime, "state.json"), dbPath }), /foreign key/i);
  } finally {
    await removeTestDir(runtime);
  }
});

test("legacy migration is idempotent and permanently archives the original", async () => {
  const runtime = await createTestDir("state-idempotent");
  try {
    const state = baseState();
    addVideo(state, 1, "queued");
    const statePath = path.join(runtime, "state.json");
    const dbPath = path.join(runtime, "bfb.sqlite");
    const archiveDir = path.join(runtime, "backups");
    writeJsonFile(statePath, state);
    const first = new StateManager({ statePath, dbPath, archiveDir });
    first.close();
    const archivesAfterFirst = (await fs.promises.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    const second = new StateManager({ statePath, dbPath, archiveDir });
    assert.equal(Object.keys(second.getStateSnapshot().videos || {}).length, 1);
    second.close();
    const archivesAfterSecond = (await fs.promises.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(archivesAfterSecond, archivesAfterFirst);
  } finally {
    await removeTestDir(runtime);
  }
});

test("clearing backup state empties SQLite tables without deleting the open database", async () => {
  const runtime = await createTestDir("state-clear-sqlite");
  try {
    const state = baseState();
    addVideo(state, 1, "queued");
    const statePath = path.join(runtime, "state.json");
    const dbPath = path.join(runtime, "bfb.sqlite");
    writeJsonFile(statePath, state);
    const manager = new StateManager({ statePath, dbPath });
    manager.getDatabase().db.prepare("INSERT INTO jobs(id,kind,dedupe_key,status,priority,payload_json,attempts,max_attempts,not_before,created_at,updated_at) VALUES('j1','download','download:test','pending',1,'{}',0,1,0,0,0)").run();
    manager.clear();
    const counts = manager.getDatabase().db.prepare("SELECT (SELECT COUNT(*) FROM videos) videos, (SELECT COUNT(*) FROM favorite_relations) relations, (SELECT COUNT(*) FROM jobs) jobs").get() as any;
    assert.deepEqual(counts, { videos: 0, relations: 0, jobs: 0 });
    assert.equal(fs.existsSync(dbPath), true);
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});
