import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { recoveryFixture } from './fixtures/recovery.js';
import { parseEncodingRetryContext, parseStrictMediaTarget } from '../src/scheduler/recovery-context.js';
import { commitVerifiedTransfer } from '../src/scheduler/verified-transfer.js';
import { isRecord } from '../src/shared/api/value.js';
import type { RecoveryUploadItem } from '../src/scheduler/upload-work.js';
import type { EncodingRetryContext } from '../src/tasks.js';
import { StateManager } from "../src/state.js";
import { UploadTask } from "../src/tasks.js";
import { DOWNLOAD_RETAINED_FILE, writeDownloadSession } from "../src/download-session.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("one-off encoding retry stays pending, uses an isolated directory, and is idempotent", async () => {
  const runtime = await createTestDir("encoding-retry-isolated");
  const tempDir = path.join(runtime, "temp");
  const localDir = path.join(tempDir, "BVENCODINGRETRY");
  const state = new StateManager({
    dbPath: path.join(runtime, "state.sqlite"),
    statePath: path.join(runtime, "unused-state.json"),
  });
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
      BVENCODINGRETRY: {
        bvid: "BVENCODINGRETRY",
        title: "Encoding retry",
        upperName: "Tester",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available" as const,
        backupStatus: "upload_failed" as const,
        localDir,
      },
    },
    relations: {
      "u1:1:BVENCODINGRETRY": {
        userId: "u1",
        mediaId: 1,
        bvid: "BVENCODINGRETRY",
        folderTitle: "Favorites",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "upload_failed" as const,
        remotePath: "/backup/BVENCODINGRETRY",
      },
    },
  });
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), "original-avc");

  const config = testConfig({ bbdownEncoding: "", bbdownEncodingPriority: ["HEVC", "AVC", "AV1"] });
  const {service: scheduler, jobs, downloads} = recoveryFixture(state, [user], undefined, {config, tempDir});

  try {
    const parent = jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:BVENCODINGRETRY",
      bvid: "BVENCODINGRETRY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true,
        localDir,
        files: ["video.mp4"],
        remotePath: "/backup/BVENCODINGRETRY",
        recoveryAssessment: {
          kind: "remote_size_limit" as const,
          checkedAt: Date.now(),
          localStatus: "available",
          remoteStatus: "size_limit",
          summary: "远端单文件超过限制",
        },
      },
    });

    const options = { quality: "1080P", encodingPriority: ["AV1", "HEVC", "AVC"], strict: true };
    const first = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "redownload_with_encoding", options);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.ok(first.childJobId);

    const afterStart = jobs.findById(parent.id)!;
    const retry = parseEncodingRetryContext(afterStart.payload.encodingRetry);
    assert.ok(retry);
    assert.equal(afterStart.payload.awaitingManualRecovery, false);
    assert.equal(afterStart.payload.lifecycleState, "retrying");
    assert.equal(scheduler.getRecoveryIssues().some((issue) => issue.id === `upload.${parent.id}`), false);
    assert.deepEqual(retry.priority, options.encodingPriority);
    assert.equal(retry.quality, "1080P");
    assert.equal(retry.strict, true);
    assert.equal(retry.state, "running");
    assert.notEqual(retry.candidateLocalDir, localDir);
    assert.equal(retry.candidateLocalDir.startsWith(path.resolve(tempDir) + path.sep), true);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(config.bbdownEncoding, "");
    assert.deepEqual(config.bbdownEncodingPriority, ["HEVC", "AVC", "AV1"]);

    const child = jobs.findById(String(first.childJobId))!;
    assert.ok(["pending", "leased"].includes(child.status));
    const task = downloads.build(child);
    assert.ok(task);
    assert.ok(task.encodingRetry);
    assert.equal(task.encodingRetry.strict, true);
    assert.equal(task.encodingRetry.quality, "1080P");
    assert.deepEqual(task.encodingRetry.priority, options.encodingPriority);
    assert.equal(task.qualityStrict, true);
    assert.equal(task.config.bbdownQuality, "1080P");
    assert.equal(task.config.bbdownEncoding, "AV1");
    assert.deepEqual(task.config.bbdownEncodingPriority, options.encodingPriority);
    assert.equal(task.downloadDirOverride, retry.candidateLocalDir);

    const blockedRecheck = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "recheck");
    assert.equal(blockedRecheck.ok, false);
    assert.equal(blockedRecheck.status, 409);

    const second = await scheduler.resolveRecoveryIssue(`upload.${parent.id}`, "redownload_with_encoding", options);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.childJobId, first.childJobId);
    assert.equal(jobs.list(["download"]).filter((job) => parseEncodingRetryContext(job.payload.encodingRetry)?.parentJobId === parent.id).length, 1);
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});

test("stale strict encoding upload tasks are blocked before any remote request", async () => {
  const runtime = await createTestDir("encoding-retry-upload-preflight");
  const candidateLocalDir = path.join(runtime, "BVENCODINGPREFLIGHT-encoding-retry-child-g1");
  try {
    await fs.promises.mkdir(candidateLocalDir, { recursive: true });
    await fs.promises.writeFile(path.join(candidateLocalDir, "video.mp4"), "avc-candidate");
    const now = new Date().toISOString();
    writeDownloadSession(candidateLocalDir, {
      schemaVersion: 1,
      sessionId: "encoding-retry-preflight-session",
      kind: "backup" as const,
      bvid: "BVENCODINGPREFLIGHT",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: {
        quality: "4K",
        encoding: "AV1",
        encodingPriority: ["AV1", "HEVC", "AVC"],
        apiMode: "web",
        hiRes: false,
        dolby: false,
        filenameTemplate: "<videoTitle>-<bvid>",
      },
      createdAt: now,
      updatedAt: now,
      snapshotAt: now,
      status: "complete" as const,
      pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
      outputs: [{
        pageIndex: 1,
        cid: 1,
        relativePath: "video.mp4",
        size: 13,
        duration: 2,
        videoCodec: "avc",
        width: 320,
        height: 180,
        frameRate: 30,
        quickHash: "test",
        verifiedAt: now,
      }],
      history: [],
    });

    const task = new UploadTask(
      "BVENCODINGPREFLIGHT",
      candidateLocalDir,
      "/backup/BVENCODINGPREFLIGHT",
      testConfig(),
      {
        files: ["video.mp4"],
        encodingRetry: {
          parentJobId: "parent",
          generation: 1,
          priority: ["AV1", "HEVC", "AVC"],
          strict: true,
          candidateLocalDir,
          originalLocalDir: path.join(runtime, "original"),
        },
      },
    );
    const error: unknown = await task.run().then(() => null, (caught: unknown) => caught);
    assert.ok(isRecord(error));
    assert.equal(error?.code, "BFB_ENCODING_MISMATCH");
    assert.equal(error?.source, "upload_preflight");
    assert.ok(isRecord(error.encodingAssessment));
    assert.deepEqual(error.encodingAssessment.actualEncodings, ["AVC"]);
    assert.equal(fs.existsSync(path.join(candidateLocalDir, "video.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("stale strict quality upload tasks are blocked before any remote request", async () => {
  const runtime = await createTestDir("strict-quality-upload-preflight");
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "avc-candidate");
    const now = new Date().toISOString();
    writeDownloadSession(runtime, {
      schemaVersion: 1,
      sessionId: "strict-quality-upload-session",
      kind: "backup" as const,
      bvid: "BVQUALITYPREFLIGHT",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: {
        quality: "4K",
        encoding: "AVC",
        encodingPriority: ["AVC", "HEVC", "AV1"],
        apiMode: "web",
        hiRes: false,
        dolby: false,
        filenameTemplate: "<videoTitle>-<bvid>",
      },
      createdAt: now,
      updatedAt: now,
      snapshotAt: now,
      status: "complete" as const,
      pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
      selectedStreams: [{ pageIndex: 1, cid: 1, bilibiliQuality: "1080P", observedAt: now }],
      outputs: [{
        pageIndex: 1,
        cid: 1,
        relativePath: "video.mp4",
        size: 13,
        duration: 2,
        videoCodec: "avc",
        width: 320,
        height: 180,
        frameRate: 30,
        quickHash: "test",
        verifiedAt: now,
      }],
      history: [],
    });

    const task = new UploadTask(
      "BVQUALITYPREFLIGHT",
      runtime,
      "/backup/BVQUALITYPREFLIGHT",
      testConfig(),
      {
        files: ["video.mp4"],
        strictMediaTarget: { quality: "4K", encoding: "AVC" },
      },
    );
    const error: unknown = await task.run().then(() => null, (caught: unknown) => caught);
    assert.ok(isRecord(error));
    assert.equal(error?.code, "BFB_QUALITY_MISMATCH");
    assert.equal(error?.source, "upload_preflight");
    assert.ok(isRecord(error.qualityAssessment));
    assert.deepEqual(error.qualityAssessment.actualQualities, ["1080P"]);
    assert.equal(fs.existsSync(path.join(runtime, "video.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("strict media target survives persistent upload task reconstruction", async () => {
  const runtime = await createTestDir("strict-media-target-persistence");
  const state = new StateManager({
    dbPath: path.join(runtime, "state.sqlite"),
    statePath: path.join(runtime, "unused-state.json"),
  });
  const {transfers} = recoveryFixture(state, [], undefined, {tempDir: path.join(runtime, 'temp')});

  try {
    const item: RecoveryUploadItem = {
      bvid: "BVSTRICTPERSIST",
      localDir: runtime,
      remotePath: "/backup/BVSTRICTPERSIST",
      files: ["video.mp4"],
      strictMediaTarget: { quality: "4K", encoding: "AV1" },
    };
    const persistent = transfers.buildPersistentUploadJob(item);
    assert.ok(persistent.payload);
    assert.deepEqual(persistent.payload.strictMediaTarget, item.strictMediaTarget);

    const reconstructed = transfers.buildUploadTask({...item, strictMediaTarget: parseStrictMediaTarget(persistent.payload?.strictMediaTarget)});
    assert.deepEqual(reconstructed.strictMediaTarget, item.strictMediaTarget);

    const invalid = transfers.buildUploadTask({
      ...item,
      strictMediaTarget: parseStrictMediaTarget({ quality: "", encoding: "VP9" }),
    });
    assert.equal(invalid.strictMediaTarget, undefined);
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});

test("encoding retry cannot complete without committed archive evidence and preserves the isolated candidate", async () => {
  const runtime = await createTestDir("encoding-retry-success-cleanup");
  const tempDir = path.join(runtime, "temp");
  const bvid = "BVENCODINGCLEANUP";
  const candidateLocalDir = path.join(tempDir, `${bvid}-encoding-retry-child-g1`);
  const originalLocalDir = path.join(tempDir, bvid);
  const state = new StateManager({
    dbPath: path.join(runtime, "state.sqlite"),
    statePath: path.join(runtime, "unused-state.json"),
  });
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Favorites" }],
    enabled: true,
    lastLoginAt: new Date().toISOString(),
  };
  const config = testConfig({ bbdownEncoding: "AV1" });
  const {jobs, sessions} = recoveryFixture(state, [user], undefined, {config, tempDir});

  try {
    const output = "video.mp4";
    const outputBytes = Buffer.from("replacement-av1");
    await fs.promises.mkdir(candidateLocalDir, { recursive: true });
    await fs.promises.writeFile(path.join(candidateLocalDir, output), outputBytes);
    const unknownArtifact = path.join(candidateLocalDir, "_unknown", "debug.bin");
    await fs.promises.mkdir(path.dirname(unknownArtifact), { recursive: true });
    await fs.promises.writeFile(unknownArtifact, Buffer.alloc(32));
    const now = new Date().toISOString();
    writeDownloadSession(candidateLocalDir, {
      schemaVersion: 1,
      sessionId: "encoding-retry-cleanup-session",
      kind: "backup" as const,
      bvid,
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: {
        quality: "4K",
        encoding: "AV1",
        encodingPriority: ["AV1", "HEVC", "AVC"],
        apiMode: "web",
        hiRes: false,
        dolby: false,
        filenameTemplate: "<videoTitle>-<bvid>",
      },
      createdAt: now,
      updatedAt: now,
      snapshotAt: now,
      status: "complete" as const,
      pages: [{ index: 1, cid: 1, title: "One", duration: 2 }],
      outputs: [{
        pageIndex: 1,
        cid: 1,
        relativePath: output,
        size: outputBytes.length,
        duration: 2,
        videoCodec: "av1",
        width: 1920,
        height: 1080,
        frameRate: 60,
        quickHash: "test",
        verifiedAt: now,
      }],
      history: [],
    });

    const parent = jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:encoding-retry-cleanup",
      bvid,
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: { awaitingManualRecovery: true },
    });
    const context: EncodingRetryContext = {
      parentJobId: parent.id,
      generation: 1,
      priority: ["AV1", "HEVC", "AVC"],
      strict: true,
      candidateLocalDir,
      originalLocalDir,
      state: "running" as const,
    };
    assert.equal(jobs.updatePayload(parent.id, {
      awaitingManualRecovery: true,
      encodingRetry: context,
    }), true);

    assert.throws(() => commitVerifiedTransfer({state, sessions, jobs, now: Date.now, leaseOwner: 'test-owner'}, {
      bvid, userId: user.id, mediaId: 1, jobId: 'unverified-child',
      result: {remotePath: '/backup', files: [], allVerified: false},
      partialBackup: false, historyOnly: false, encodingRetry: context,
    }), /unverified upload group/);
    assert.equal(fs.existsSync(path.join(candidateLocalDir, output)), true);
    assert.equal(fs.existsSync(unknownArtifact), true);
    assert.equal(fs.existsSync(path.join(candidateLocalDir, ".bfb-download.json")), true);
    assert.ok(jobs.findById(parent.id), "parent must remain until a verified archive commit exists");
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});
