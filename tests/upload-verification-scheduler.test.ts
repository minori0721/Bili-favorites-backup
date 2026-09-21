import { required, readField } from './contract-values.js';
import { createHeldScheduler } from './fixtures/held-scheduler.js';
import { buildUploadVerificationJobs } from '../src/scheduler/verification-jobs.js';
import type { UploadFailureInfo } from '../src/upload-health.js';
import { verificationState } from './fixtures/verification-state.js';
import { createArchiveProofRecovery } from '../src/scheduler/archive-proof-recovery.js';
import { createRecoveryWork } from '../src/scheduler/recovery-work.js';
import { PersistentJobStore } from '../src/job-store.js';
import { TransferSessionStore } from '../src/transfer-session.js';
import type { inspectRemoteFileSize } from '../src/uploader.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeUploadVerificationTiming, SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UploadTask, UploadVerificationTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const fixtures = new WeakMap<SyncScheduler, ReturnType<typeof createHeldScheduler>>();
function makeScheduler(...args: Parameters<typeof createHeldScheduler>) {
  const fixture = createHeldScheduler(...args);
  fixtures.set(fixture.scheduler, fixture);
  return fixture.scheduler;
}
function resources(scheduler: SyncScheduler) {
  const fixture = fixtures.get(scheduler);
  assert.ok(fixture);
  return fixture;
}

test("upload confirmation survives restart and times out into manual recovery", async () => {
  const runtime = await createTestDir("upload-confirm-restart");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  let manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const configStore = { get: () => config };
  const userStore = { list: () => [], getById: () => null };
  let scheduler = makeScheduler(configStore, userStore, manager);

  const putCompletedAt = new Date().toISOString();
  resources(scheduler).jobs.enqueue({
    kind: "verify_upload" as const,
    dedupeKey: "verify:u1:1:BVVERIFY:main:/target/video.mp4",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    maxAttempts: 8,
    payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir, remotePath: "/target", files: ["video.mp4"], putCompletedAt, folderTitle: "Favorites", videoTitle: "Verify" },
  });
  let job = resources(scheduler).jobs.claimDue(["verify_upload"], 1, resources(scheduler).owner, 60_000)[0];
  const missing = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config);
  missing.persistentJobId = job.id;
  missing.persistentJob = job;
  missing.result = { status: "missing" as const };
  resources(scheduler).queues.get('verification').emit('taskCompleted', missing);
  assert.equal(resources(scheduler).jobs.findById(job.id)?.status, "retry_wait");
  scheduler.stop();
  manager.close();

  manager = new StateManager({ statePath, dbPath });
  scheduler = makeScheduler(configStore, userStore, manager);

  const persisted = resources(scheduler).jobs.findByDedupeKey("verify:u1:1:BVVERIFY:main:/target/video.mp4");
  assert.equal(persisted?.status, "retry_wait");
  manager.getDatabase().db.prepare("UPDATE jobs SET status='retry_wait', attempts=5, not_before=0, lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(persisted!.id);
  job = resources(scheduler).jobs.claimDue(["verify_upload"], 1, resources(scheduler).owner, 60_000)[0];
  const timedOut = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config);
  timedOut.persistentJobId = job.id;
  timedOut.persistentJob = { ...job, attempts: 5, payload: { ...job.payload, putCompletedAt: new Date(Date.now() - 11 * 60_000).toISOString() } };
  timedOut.result = { status: "missing" as const };
  const beforeTimeout = Date.now();
  resources(scheduler).queues.get('verification').emit('taskCompleted', timedOut);
  const reupload = resources(scheduler).jobs.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
  assert.ok(reupload);
  assert.equal(reupload!.status, "manual_wait");
  assert.equal(reupload!.payload.awaitingManualRecovery, true);
  assert.equal(reupload!.notBefore, 0);
  assert.equal(reupload!.notBefore >= beforeTimeout + 29 * 60_000, false);
  const recovery = await scheduler.recoverUploadJob(reupload!.id, false);
  assert.equal(recovery.ok, true);
  assert.equal(required(resources(scheduler).jobs.findById(reupload!.id)?.payload).awaitingManualRecovery, false);
  assert.equal(
    resources(scheduler).queues.get('upload').getTasks().some((task) => task instanceof UploadTask && task.resumeOnly === true),
    true,
  );
  const duplicateRecovery = await scheduler.recoverUploadJob(reupload!.id, false);
  assert.equal(duplicateRecovery.ok, true);
  assert.equal(duplicateRecovery.idempotent, true);
  assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "upload_failed");
  assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
  scheduler.stop();
  manager.close();
  await removeTestDir(runtime);
});

test("stale resume-only recovery converges to the current verified archive when its local candidate is gone", async () => {
  const runtime = await createTestDir("upload-stale-resume-verified-proof");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  const manager = new StateManager({ statePath, dbPath });
  const snapshot = verificationState(localDir);
  const verifiedAt = new Date().toISOString();
  const verifiedFile = {
    name: "video.mp4",
    path: "/target/video.mp4",
    size: 12,
    localRelativePath: "video.mp4",
    verificationStatus: "verified" as const,
    putAcceptedAt: verifiedAt,
    verifiedAt,
  };
  assert.ok(snapshot.videos);
  snapshot.videos.BVVERIFY = {
    ...snapshot.videos.BVVERIFY,
    backupStatus: "upload_failed" as const,
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
    lastError: "旧恢复任务曾读取不到本地文件",
  };
  assert.ok(snapshot.relations);
  snapshot.relations["u1:1:BVVERIFY"] = {
    ...snapshot.relations["u1:1:BVVERIFY"],
    backupStatus: "upload_failed" as const,
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
    lastError: "旧恢复任务曾读取不到本地文件",
  };
  manager.replaceStateSnapshot(snapshot);
  await fs.promises.rm(path.join(localDir, "video.mp4"));
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager,
    { remoteFileInspector: async () => ({ status: "verified" as const }) },
  );

  try {
    const job = resources(scheduler).jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:stale-resume",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "retry_wait",
      payload: {
        awaitingManualRecovery: false,
        resumeOnly: true,
        allowReupload: false,
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
      },
    });

    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(result.resolved, "verified_archive");
    assert.equal(resources(scheduler).jobs.findById(job.id), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
    assert.equal(manager.getDatabase().getVideo("BVVERIFY")?.backupStatus, "verified");
    assert.equal(resources(scheduler).queues.get('upload').getTasks().length, 0);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("startup recovery removes obsolete verified-archive jobs but preserves real conflict candidates", async () => {
  const runtime = await createTestDir("upload-stale-resume-startup-reconcile");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  const snapshot = verificationState(localDir);
  const verifiedAt = new Date().toISOString();
  const verifiedFile = {
    name: "video.mp4",
    path: "/target/video.mp4",
    size: 12,
    localRelativePath: "video.mp4",
    verificationStatus: "verified" as const,
    putAcceptedAt: verifiedAt,
    verifiedAt,
  };
  assert.ok(snapshot.videos);
  snapshot.videos.BVVERIFY = {
    ...snapshot.videos.BVVERIFY,
    backupStatus: "upload_failed" as const,
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
  };
  assert.ok(snapshot.relations);
  snapshot.relations["u1:1:BVVERIFY"] = {
    ...snapshot.relations["u1:1:BVVERIFY"],
    backupStatus: "upload_failed" as const,
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
  };
  manager.replaceStateSnapshot(snapshot);
  const jobs = new PersistentJobStore(manager.getDatabase());
  const recovery = createArchiveProofRecovery({
      stateManager: manager, jobStore: jobs,
      transferSessions: new TransferSessionStore(manager.getDatabase()), configStore: { get: () => testConfig() },
      recoveryWork: createRecoveryWork(), canRun: () => true, generation: () => 0, now: Date.now,
      cleanup: () => null, ...{ remoteFileInspector: async () => ({ status: "verified" as const }) },
    });

  try {
    const obsolete = jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:obsolete-startup",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "retry_wait",
      payload: {
        awaitingManualRecovery: false,
        resumeOnly: true,
        allowReupload: false,
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
      },
    });
    const candidate = jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:conflict-startup",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true,
        resumeOnly: true,
        allowReupload: false,
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
        conflictCandidate: {
          id: "candidate-1",
          candidateRemotePath: "/target/_conflicts/candidate-1",
          files: [{ ...verifiedFile, path: "/target/_conflicts/candidate-1/video.mp4" }],
        },
      },
    });

    await recovery.reconcileObsoleteVerifiedArchiveRecoveries();

    assert.equal(jobs.findById(obsolete.id), null);
    assert.equal(required(jobs.findById(candidate.id)?.payload).conflictCandidate !== undefined, true);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {

    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual recovery never settles a conflict candidate from an unrelated verified archive", async () => {
  const runtime = await createTestDir("upload-conflict-candidate-retained-proof");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  const snapshot = verificationState(localDir);
  const verifiedAt = new Date().toISOString();
  const verifiedFile = {
    name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4",
    verificationStatus: "verified" as const, putAcceptedAt: verifiedAt, verifiedAt,
  };
  assert.ok(snapshot.videos);
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  assert.ok(snapshot.relations);
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let inspections = 0;
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager,
    { remoteFileInspector: async () => { inspections += 1; return { status: "verified" as const }; } },
  );

  try {
    const job = resources(scheduler).jobs.enqueue({
      kind: "upload" as const, dedupeKey: "upload:u1:1:BVVERIFY:/target:conflict-retained-proof", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"],
        conflictCandidate: { id: "candidate-1", candidateRemotePath: "/target/_conflicts/candidate-1", files: [{ ...verifiedFile, path: "/target/_conflicts/candidate-1/video.mp4" }] },
      },
    });
    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, false);
    assert.equal(inspections, 0);
    assert.equal(resources(scheduler).jobs.findById(job.id)?.status, "manual_wait");
    assert.equal(readField(required(resources(scheduler).jobs.findById(job.id)?.payload).conflictCandidate, 'id'), "candidate-1");
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "upload_failed");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("stale resume-only recovery stays pending when the stored archive is no longer remotely visible", async () => {
  const runtime = await createTestDir("upload-stale-resume-remote-missing");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  const snapshot = verificationState(localDir);
  const verifiedAt = new Date().toISOString();
  const verifiedFile = {
    name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4",
    verificationStatus: "verified" as const, putAcceptedAt: verifiedAt, verifiedAt,
  };
  assert.ok(snapshot.videos);
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  assert.ok(snapshot.relations);
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let inspections = 0;
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager,
    { remoteFileInspector: async () => { inspections += 1; return { status: "missing" as const }; } },
  );

  try {
    const job = resources(scheduler).jobs.enqueue({
      kind: "upload" as const, dedupeKey: "upload:u1:1:BVVERIFY:/target:remote-missing", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "retry_wait",
      payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"] },
    });
    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, undefined);
    assert.equal(inspections, 1);
    assert.equal(resources(scheduler).jobs.findById(job.id)?.status, "retry_wait");
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "upload_failed");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("obsolete archive recovery requires an exact nonempty file set and uses bounded remote checks", async () => {
  const runtime = await createTestDir("upload-stale-resume-bounded-checks");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  const snapshot = verificationState(localDir);
  const verifiedAt = new Date().toISOString();
  const verifiedFile = {
    name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4",
    verificationStatus: "verified" as const, putAcceptedAt: verifiedAt, verifiedAt,
  };
  assert.ok(snapshot.videos);
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  assert.ok(snapshot.relations);
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed" as const, remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let active = 0;
  let maximumActive = 0;
  let inspections = 0;
  const jobs = new PersistentJobStore(manager.getDatabase());
  const recovery = createArchiveProofRecovery({
      stateManager: manager, jobStore: jobs,
      transferSessions: new TransferSessionStore(manager.getDatabase()), configStore: { get: () => testConfig() },
      recoveryWork: createRecoveryWork(), canRun: () => true, generation: () => 0, now: Date.now,
      cleanup: () => null, ...{ remoteFileInspector: async () => {
      inspections += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "verified" as const };
    } },
    });

  try {
    const empty = jobs.enqueue({
      kind: "upload" as const, dedupeKey: "upload:u1:1:BVVERIFY:/target:empty-files", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "retry_wait",
      payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: [] },
    });
    for (let index = 0; index < 3; index += 1) {
      jobs.enqueue({
        kind: "upload" as const, dedupeKey: `upload:u1:1:BVVERIFY:/target:bounded-${index}`, bvid: "BVVERIFY", userId: "u1", mediaId: 1,
        initialStatus: "retry_wait",
        payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"] },
      });
    }
    await recovery.reconcileObsoleteVerifiedArchiveRecoveries(10, undefined, 2);
    assert.ok(jobs.findById(empty.id));
    assert.equal(inspections, 3);
    assert.equal(maximumActive <= 2, true);
  } finally {

    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual recovery with no session refuses a missing local candidate before waking upload", async () => {
  const runtime = await createTestDir("upload-legacy-missing-local-preflight");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager,
  );

  try {
    const job = resources(scheduler).jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:legacy-missing-local",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true,
        resumeOnly: true,
        allowReupload: false,
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
      },
    });

    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.message, /重新下载/);
    assert.equal(resources(scheduler).jobs.findById(job.id)?.status, "manual_wait");
    assert.equal(required(resources(scheduler).jobs.findById(job.id)?.payload).awaitingManualRecovery, true);
    assert.equal(resources(scheduler).queues.get('upload').getTasks().length, 0);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("transfer-session verification uses the same timeout and manual recovery path", async () => {
  const runtime = await createTestDir("upload-transfer-confirm-timeout");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);

  const putCompletedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  resources(scheduler).jobs.enqueue({
    kind: "verify_upload" as const,
    dedupeKey: "verify:session-timeout",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    maxAttempts: 8,
    payload: {
      remoteFile: "/target/video.mp4",
      expectedSize: 12,
      localDir,
      remotePath: "/target",
      files: ["video.mp4"],
      putCompletedAt,
      sessionId: "transfer-session-timeout",
      folderTitle: "Favorites",
      videoTitle: "Verify",
    },
  });
  const job = resources(scheduler).jobs.claimDue(["verify_upload"], 1, resources(scheduler).owner, 60_000)[0];
  const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config);
  task.persistentJobId = job.id;
  task.persistentJob = { ...job, attempts: 5, payload: { ...job.payload, putCompletedAt } };
  task.result = { status: "missing" as const };
  task.transferResult = {
    remotePath: "/target",
    files: [{ name: "video.mp4", path: "/target/video.mp4", size: 12, verificationStatus: "awaiting_verification" as const }],
    allVerified: false,
    pendingChecks: [{ remoteFile: "/target/video.mp4", expectedSize: 12, finalFile: "/target/video.mp4", localRelativePath: "video.mp4" }],
  };
  resources(scheduler).queues.get('verification').emit('taskCompleted', task);
  const recovery = resources(scheduler).jobs.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
  assert.ok(recovery);
  assert.equal(recovery!.status, "manual_wait");
  assert.equal(recovery!.payload.awaitingManualRecovery, true);
  assert.equal(recovery!.payload.resumeOnly, true);
  assert.equal(recovery!.payload.sessionId, "transfer-session-timeout");
  scheduler.stop();
  manager.close();
  await removeTestDir(runtime);
});

test("one transfer session creates one session-level verification job for multiple parts", async () => {
  const runtime = await createTestDir("upload-session-single-verify");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);


  try {
    resources(scheduler).jobs.enqueueBatch(buildUploadVerificationJobs({
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      downloadDir: localDir,
      remotePath: "/target",
      files: ["p01.mp4", "p02.mp4"],
      sessionId: "session-multi",
      historyOnly: false,
      partialBackup: false,
      folderTitle: "Favorites",
      videoTitle: "Verify",
    }, [
      { path: "/target/p01.mp4", size: 12, verificationStatus: "awaiting_verification" as const, localRelativePath: "p01.mp4" },
      { path: "/target/p02.mp4", size: 13, verificationStatus: "awaiting_verification" as const, localRelativePath: "p02.mp4" },
    ], [
      { remoteFile: "/target/p01.mp4", expectedSize: 12, finalFile: "/target/p01.mp4", localRelativePath: "p01.mp4" },
      { remoteFile: "/target/p02.mp4", expectedSize: 13, finalFile: "/target/p02.mp4", localRelativePath: "p02.mp4" },
    ]));
    const jobs = resources(scheduler).jobs.listForBoard(["verify_upload"], 10);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupeKey, "verify-session:u1:1:BVVERIFY:main:session-multi:g1");
    assert.equal(jobs[0].payload.sessionVerification, true);
    assert.equal(jobs[0].payload.sessionId, "session-multi");
    assert.equal(jobs[0].payload.sessionGeneration, undefined);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("deterministic remote size conflicts enter manual recovery instead of retrying indefinitely", async () => {
  const runtime = await createTestDir("upload-conflict-manual-recovery");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(path.join(runtime, "temp", "BVVERIFY")));
  const config = testConfig();
  const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);

  try {
    resources(scheduler).jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      payload: { localDir: path.join(runtime, "temp", "BVVERIFY"), remotePath: "/target" },
    });
    const claimed = resources(scheduler).jobs.claimDue(["upload"], 1, resources(scheduler).owner, 60_000)!;
    assert.ok(claimed[0]);
    resources(scheduler).jobs.markRunning(claimed[0].id, resources(scheduler).owner, 60_000);
    const task = new UploadTask('BVVERIFY', path.join(runtime, 'temp', 'BVVERIFY'), '/target', config);
    task.userId = 'u1';
    task.mediaId = 1;
    task.persistentJobId = claimed[0].id;
    task.persistentJob = claimed[0];
    const error = Object.assign(new Error("Remote size conflict"), {uploadFailure: {
      category: "deterministic",
      status: 409,
      summary: "Remote size conflict",
      remotePath: "/target/video.mp4",
      retryable: false,
      fingerprint: "deterministic|409|conflict",
    } satisfies UploadFailureInfo});
    resources(scheduler).queues.get('upload').emit("taskError", task, error);
    const parked = resources(scheduler).jobs.findById(claimed[0].id);
    assert.equal(parked?.status, "manual_wait");
    assert.equal(parked?.payload.awaitingManualRecovery, true);
    assert.equal(parked?.payload.resumeOnly, true);
    assert.equal(parked?.payload.allowReupload, false);
    resources(scheduler).jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      payload: { localDir: "new-sync-payload", remotePath: "/target" },
    });
    const preserved = resources(scheduler).jobs.findById(claimed[0].id);
    assert.equal(preserved?.status, "manual_wait");
    assert.equal(preserved?.payload.awaitingManualRecovery, true);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("confirmation-stage 409 parks one generation-aware upload recovery item", async () => {
  const runtime = await createTestDir("upload-confirm-conflict-manual-recovery");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);

  try {
    const session = resources(scheduler).sessions.ensure({
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      localDir,
      remotePath: "/target",
    });
    resources(scheduler).sessions.ensureFile(session.id, { relativePath: "video.mp4", name: "video.mp4", expectedSize: 12 }, session.generation);
    const verifyJob = resources(scheduler).jobs.enqueue({
      kind: "verify_upload" as const,
      dedupeKey: "verify-session:u1:1:BVVERIFY:main:confirm:g1",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      payload: {
        remoteFile: "/target/video.mp4",
        expectedSize: 12,
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
        sessionId: session.id,
        sessionGeneration: session.generation,
        sessionVerification: true,
        folderTitle: "Favorites",
        videoTitle: "Verify",
      },
    });
    const claimed = resources(scheduler).jobs.claimDue(["verify_upload"], 1, resources(scheduler).owner, 60_000)[0];
    assert.equal(claimed.id, verifyJob.id);
    const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config, {
      transferSessionStore: resources(scheduler).sessions,
      sessionId: session.id,
      sessionGeneration: session.generation,
      sessionVerification: true,
    });
    task.persistentJobId = claimed.id;
    task.persistentJob = claimed;
    const error = Object.assign(new Error("Remote size conflict"), {uploadFailure: {
      category: "deterministic",
      status: 409,
      summary: "Remote size conflict",
      remotePath: "/target/video.mp4",
      retryable: false,
      fingerprint: "deterministic|409|confirm-conflict",
    } satisfies UploadFailureInfo});
    resources(scheduler).queues.get('verification').emit("taskError", task, error);

    assert.equal(resources(scheduler).jobs.findById(verifyJob.id), null);
    const recovery = resources(scheduler).jobs.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
    assert.equal(recovery?.status, "manual_wait");
    assert.equal(recovery?.payload.awaitingManualRecovery, true);
    assert.equal(recovery?.payload.resumeOnly, true);
    assert.equal(recovery?.payload.allowReupload, false);
    assert.equal(recovery?.payload.sessionId, session.id);
    assert.equal(recovery?.payload.sessionGeneration, 1);
    assert.equal(recovery?.payload.conflictRemotePath, "/target/video.mp4");
    assert.equal(resources(scheduler).sessions.listFiles(session.id, 1).length, 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a one-time re-upload authorization failure parks the upload for manual recovery", async () => {
  const runtime = await createTestDir("upload-authorized-recovery-failure");
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
  const manager = new StateManager({ statePath, dbPath });
  manager.replaceStateSnapshot(verificationState(localDir));
  const config = testConfig();
  const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);

  try {
    const job = resources(scheduler).jobs.enqueue({
      kind: "upload" as const,
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      maxAttempts: 4,
      payload: {
        localDir,
        remotePath: "/target",
        files: ["video.mp4"],
        bvid: "BVVERIFY",
        userId: "u1",
        mediaId: 1,
        allowReupload: false,
        reuploadAuthorizedFiles: ["video.mp4"],
        resumeOnly: true,
      },
    });
    const claimed = resources(scheduler).jobs.claimDue(["upload"], 1, resources(scheduler).owner, 60_000)[0];
    assert.equal(claimed.id, job.id);

    const task = new UploadTask("BVVERIFY", localDir, "/target", config, {
      files: ["video.mp4"],
      reuploadAuthorizedFiles: ["video.mp4"],
      resumeOnly: true,
    });
    task.persistentJobId = claimed.id;
    task.persistentJob = claimed;
    task.userId = "u1";
    task.mediaId = 1;
    task.consumeReuploadPermission = (relativePath: string) => resources(scheduler).jobs.consumeUploadReuploadPermission(
      claimed.id,
      resources(scheduler).owner,
      relativePath,
    );

    resources(scheduler).queues.get('upload').emit("taskStart", task);
    assert.equal(task.reuploadPermissionUsed, false);
    assert.deepEqual(required(resources(scheduler).jobs.findById(job.id)?.payload).reuploadAuthorizedFiles, ["video.mp4"]);
    task.reuploadPermissionUsed = task.consumeReuploadPermission("video.mp4");
    assert.equal(task.reuploadPermissionUsed, true);
    assert.equal(required(resources(scheduler).jobs.findById(job.id)?.payload).allowReupload, false);

    const error = Object.assign(new Error("temporary upload failure after authorized retry"), {uploadFailure: {
      category: "server",
      status: 503,
      summary: "temporary upload failure after authorized retry",
      remotePath: "/target/video.mp4",
      retryable: true,
      fingerprint: "server|503|authorized-retry",
    } satisfies UploadFailureInfo});
    resources(scheduler).queues.get('upload').emit("taskError", task, error);

    const parked = resources(scheduler).jobs.findById(job.id);
    assert.equal(parked?.status, "manual_wait");
    assert.equal(parked?.payload.awaitingManualRecovery, true);
    assert.equal(parked?.payload.allowReupload, false);
    assert.equal(parked?.payload.resumeOnly, true);
    assert.equal(resources(scheduler).jobs.claimDue(["upload"], 1, resources(scheduler).owner, 60_000).length, 0);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a successful confirmation promotes uploaded to verified without another PUT", async () => {
  const runtime = await createTestDir("upload-confirm-success");
  try {
    const localDir = path.join(runtime, "temp", "BVVERIFY");
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 1));
    const manager = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
    manager.replaceStateSnapshot(verificationState(localDir));
    const config = testConfig();
    const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);

    resources(scheduler).jobs.enqueue({ kind: "verify_upload" as const, dedupeKey: "verify:success", bvid: "BVVERIFY", userId: "u1", mediaId: 1, payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir: "" } });
    const job = resources(scheduler).jobs.claimDue(["verify_upload"], 1, resources(scheduler).owner, 60_000)[0];
    const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config);
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.result = { status: "verified" as const, remoteSize: 12 };
    resources(scheduler).queues.get('verification').emit('taskCompleted', task);
    assert.equal(resources(scheduler).jobs.findById(job.id), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
    scheduler.stop();
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});

async function createConflictCandidateFixture(
  name: string,
  options: { existingStatus?: "verified" | "partial_verified"; partialCandidate?: boolean } = {},
) {
  const runtime = await createTestDir(name);
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(12, 2));
  const observedAt = "2026-08-17T12:00:00.000Z";
  const oldProof = {
    remotePath: "/target",
    status: options.existingStatus || "verified",
    uploadedAt: observedAt,
    verifiedAt: observedAt,
    files: [{
      name: "video.mp4",
      path: "/target/video.mp4",
      size: 10,
      localRelativePath: "video.mp4",
      verificationStatus: "verified" as const,
      mediaMetadata: { width: 640, height: 360, source: "ffprobe" as const, observedAt },
    }],
  };
  const candidateFiles = [{
    name: "video.mp4",
    path: "/target/_conflicts/upload-candidate/video.mp4",
    size: 12,
    localRelativePath: "video.mp4",
    verificationStatus: "verified" as const,
    mediaMetadata: { width: 1920, height: 1080, source: "ffprobe" as const, observedAt },
  }];
  const snapshot = verificationState(localDir);
  assert.ok(snapshot.videos);
  Object.assign(snapshot.videos.BVVERIFY, {
    backupStatus: oldProof.status,
    remotePath: oldProof.remotePath,
    remoteFiles: oldProof.files,
    uploadedAt: oldProof.uploadedAt,
    verifiedAt: oldProof.verifiedAt,
  });
  assert.ok(snapshot.relations);
  Object.assign(snapshot.relations["u1:1:BVVERIFY"], {
    backupStatus: oldProof.status,
    remotePath: oldProof.remotePath,
    remoteFiles: oldProof.files,
    uploadedAt: oldProof.uploadedAt,
    verifiedAt: oldProof.verifiedAt,
  });
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(snapshot);
  const remote: { inspect: typeof inspectRemoteFileSize } = {
    inspect: async (_config, remotePath) => ({ status: "verified" as const, remoteSize: remotePath.includes("/_conflicts/") ? 12 : 10 }),
  };
  const scheduler = makeScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    manager,
    {
      remoteFileInspector: (...args) => remote.inspect(...args),
    },
  );

  const job = resources(scheduler).jobs.enqueue({
    kind: "upload" as const,
    dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    payload: {
      localDir,
      remotePath: "/target",
      files: ["video.mp4"],
      existingArchiveProof: oldProof,
    },
  });
  const claimed = resources(scheduler).jobs.claimDue(["upload"], 1, resources(scheduler).owner, 60_000)[0];
  resources(scheduler).jobs.markRunning(claimed.id, resources(scheduler).owner, 60_000);
  const task = new UploadTask("BVVERIFY", localDir, "/target", testConfig(), {
    cleanupLocal: false,
    files: ["video.mp4"],
    existingArchiveProof: oldProof,
    conflictCandidateId: "upload-candidate",
    conflictCandidateRemotePath: "/target/_conflicts/upload-candidate",
  });
  task.userId = "u1";
  task.mediaId = 1;
  task.partialBackup = Boolean(options.partialCandidate);
  task.persistentJobId = job.id;
  task.persistentJob = resources(scheduler).jobs.findById(job.id) ?? undefined;
  task.result = {
    remotePath: "/target/_conflicts/upload-candidate",
    files: candidateFiles,
    allVerified: true,
    disposition: "conflict_candidate",
    conflictCandidate: {
      id: "upload-candidate",
      originalRemotePath: "/target",
      candidateRemotePath: "/target/_conflicts/upload-candidate",
      reasonCode: "UPLOAD_REMOTE_SIZE_CONFLICT",
      reasonSummary: "remote conflict",
      existingArchiveProof: oldProof,
    },
  };
  resources(scheduler).queues.get('upload').emit("taskCompleted", task);
  return { runtime, localDir, manager, scheduler, remote, job, oldProof, candidateFiles };
}

test("conflict candidate selection preserves the old archive proof in the audit record", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-select");
  const { runtime, manager, scheduler, job } = fixture;
  try {
    const parked = resources(scheduler).jobs.findById(job.id);
    assert.equal(parked?.status, "manual_wait");
    const retained = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(retained?.backupStatus, "verified");
    assert.equal(retained?.remotePath, "/target");
    assert.equal(retained?.remoteFiles?.[0]?.mediaMetadata?.width, 640);
    const issue = scheduler.getRecoveryIssues().find((item) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "conflict_candidate_ready");
    assert.deepEqual(issue?.availableActions.map((action) => action.id), ["keep_existing", "use_candidate", "recheck", "abandon_attempt"]);

    const result = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "use_candidate");
    assert.equal(result.ok, true);
    assert.equal(resources(scheduler).jobs.findById(job.id), null);
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remotePath, "/target/_conflicts/upload-candidate");
    assert.equal(relation?.remoteFiles?.[0]?.mediaMetadata?.width, 1920);
    const audit = relation?.remoteConflictCandidates?.find((item) => item.id === "upload-candidate");
    assert.equal(audit?.resolution, "selected_candidate");
    assert.equal(audit?.existingArchiveProof?.remotePath, "/target");
    assert.equal(audit?.existingArchiveProof?.files[0]?.mediaMetadata?.width, 640);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("conflict candidate uploads do not replace the official archive with an uploading state", async () => {
  const task = new UploadTask("BVCANDIDATE", "C:/isolated", "/target", testConfig(), {
    upload: async (_localDir, remotePath, _config, options) => {
      assert.equal(remotePath, '/target/_conflicts/upload-candidate');
      assert.equal(options?.uploadIntent, 'conflict_candidate');
      assert.equal(options?.cleanupLocal, false);
      return {remotePath, files: [{name: 'video.mp4', path: `${remotePath}/video.mp4`, size: 12}], allVerified: true};
    },
    cleanupLocal: false,
    files: ["video.mp4"],
    conflictCandidateOnly: true,
    conflictCandidateId: "upload-candidate",
    conflictCandidateRemotePath: "/target/_conflicts/upload-candidate",
  });
  let ordinaryUploadTransitions = 0;
  let candidateTransitions = 0;
  task.onUploading = () => { ordinaryUploadTransitions += 1; };
  task.onConflictCandidateUploading = () => { candidateTransitions += 1; };
  await task.run();

  assert.equal(task.conflictCandidateAttempted, true);
  assert.equal(ordinaryUploadTransitions, 0);
  assert.equal(candidateTransitions, 1);
});

test("a failed candidate attempt preserves a complete existing archive proof", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-failure-proof");
  const { runtime, manager, scheduler, oldProof } = fixture;
  try {
    const task = new UploadTask("BVVERIFY", fixture.localDir, "/target", testConfig(), {
      cleanupLocal: false,
      files: ["video.mp4"],
      existingArchiveProof: oldProof,
      conflictCandidateOnly: true,
    });
    task.userId = "u1";
    task.mediaId = 1;
    task.conflictCandidateAttempted = true;
    manager.markUploading("BVVERIFY", "u1", 1);

    resources(scheduler).queues.get('upload').emit('taskError', task, new Error('candidate upload failed'));

    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remotePath, "/target");
    assert.equal(relation?.remoteFiles?.[0]?.size, 10);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a verified candidate automatically replaces an incomplete existing source", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-auto-select", {
    existingStatus: "partial_verified",
  });
  const { runtime, manager, scheduler, job } = fixture;
  try {
    assert.equal(resources(scheduler).jobs.findById(job.id), null);
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remotePath, "/target/_conflicts/upload-candidate");
    assert.equal(relation?.remoteConflictCandidates?.[0]?.resolution, "selected_candidate");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a partial candidate automatically keeps a complete existing source", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-auto-keep", {
    partialCandidate: true,
  });
  const { runtime, manager, scheduler, job } = fixture;
  try {
    assert.equal(resources(scheduler).jobs.findById(job.id), null);
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remotePath, "/target");
    assert.equal(relation?.remoteConflictCandidates?.[0]?.resolution, "kept_existing");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("conflict candidate and its old proof survive a SQLite reopen", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-reopen");
  const { runtime, manager, scheduler } = fixture;
  const statePath = path.join(runtime, "data", "state.json");
  const dbPath = path.join(runtime, "data", "bfb.sqlite");
  let closed = false;
  try {
    scheduler.stop();
    manager.close();
    closed = true;
    const reopened = new StateManager({ statePath, dbPath });
    try {
      const candidate = reopened.getRelationStatus("u1", 1, "BVVERIFY")?.remoteConflictCandidates?.[0];
      assert.equal(candidate?.id, "upload-candidate");
      assert.equal(candidate?.existingArchiveProof?.remotePath, "/target");
      assert.equal(candidate?.existingArchiveProof?.files[0]?.mediaMetadata?.width, 640);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      scheduler.stop();
      manager.close();
    }
    await removeTestDir(runtime);
  }
});

test("keeping the existing archive restores its exact metadata and leaves the candidate audited", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-keep-existing");
  const { runtime, manager, scheduler, job } = fixture;
  try {
    const result = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "keep_existing");
    assert.equal(result.ok, true);
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remotePath, "/target");
    assert.equal(relation?.remoteFiles?.[0]?.mediaMetadata?.width, 640);
    assert.equal(relation?.remoteConflictCandidates?.[0]?.resolution, "kept_existing");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("conflict candidate decisions are serialized and reject a changed candidate", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-lock");
  const { runtime, manager, scheduler, job } = fixture;
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  fixture.remote.inspect = async (_config, remotePath) => {
    if (remotePath.includes("/_conflicts/")) {
      started();
      await releasePromise;
      return { status: "verified" as const, remoteSize: 12 };
    }
    return { status: "verified" as const, remoteSize: 10 };
  };
  try {
    const first = scheduler.resolveRecoveryIssue(`upload.${job.id}`, "use_candidate");
    await startedPromise;
    const concurrent = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "keep_existing");
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.status, 409);
    release();
    assert.equal((await first).ok, true);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.remotePath, "/target/_conflicts/upload-candidate");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    release();
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }

  const changed = await createConflictCandidateFixture("upload-candidate-changed");
  try {
    changed.remote.inspect = async (_config, remotePath) => remotePath.includes("/_conflicts/")
      ? { status: "mismatch" as const, remoteSize: 99 }
      : { status: "verified" as const, remoteSize: 10 };
    const result = await changed.scheduler.resolveRecoveryIssue(`upload.${changed.job.id}`, "use_candidate");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(resources(changed.scheduler).jobs.findById(changed.job.id)?.status, "manual_wait");
    assert.equal(changed.manager.getRelationStatus("u1", 1, "BVVERIFY")?.remoteConflictCandidates?.[0]?.resolution, undefined);
  } finally {
    changed.scheduler.stop();
    changed.manager.close();
    await removeTestDir(changed.runtime);
  }
});

test("upload circuit state is restored from the shared cooldown table", async () => {
  const runtime = await createTestDir("upload-circuit-persist");
  try {
    const statePath = path.join(runtime, "data", "state.json");
    const dbPath = path.join(runtime, "data", "bfb.sqlite");
    let manager = new StateManager({ statePath, dbPath });
    manager.setUploadCooldown({ state: "open" as const, reason: "backend unavailable", category: "auth", openedAt: Date.now(), retryAt: Date.now() + 60_000, consecutiveFailures: 1 });
    manager.close();
    manager = new StateManager({ statePath, dbPath });
    const config = testConfig();
    const scheduler = makeScheduler({ get: () => config }, { list: () => [], getById: () => null }, manager);
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.state, "open");
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.pausedDownloads, true);
    scheduler.stop();
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});
