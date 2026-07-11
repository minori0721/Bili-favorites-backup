import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { StateManager, type StateFile } from "../src/state.js";
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

    let writes = 0;
    const manager = new StateManager({
      statePath,
      writeState(filePath, value) {
        writes += 1;
        writeJsonFile(filePath, value);
      },
    });
    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.schemaVersion, 11);
    assert.equal(snapshot.videos![bvid].backupStatus, "upload_failed");
    assert.equal(snapshot.relations![`u1:1:${bvid}`].backupStatus, "upload_failed");
    assert.equal(writes, 1);
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

    let writes = 0;
    let writtenBytes = 0;
    const manager = new StateManager({
      statePath,
      writeState(filePath, value) {
        writes += 1;
        const serialized = JSON.stringify(value, null, 2);
        writtenBytes += Buffer.byteLength(serialized);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, serialized, "utf-8");
      },
    });
    manager.normalizePersistedWorkForRecovery();
    const snapshot = manager.getStateSnapshot();
    assert.equal(writes, 1);
    assert.ok(writtenBytes <= originalBytes * 3);
    assert.equal(Object.values(snapshot.videos || {}).filter((item) => item.backupStatus === "queued").length, 1000);
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
    let writes = 0;
    const manager = new StateManager({
      statePath,
      writeState(filePath, value) {
        writes += 1;
        writeJsonFile(filePath, value);
      },
    });
    manager.runBatch(() => {
      manager.markQueued(first, "/one", "u1", 1);
      manager.markQueued(second, "/two", "u1", 1);
    });
    assert.equal(writes, 1);
  } finally {
    await removeTestDir(runtime);
  }
});
