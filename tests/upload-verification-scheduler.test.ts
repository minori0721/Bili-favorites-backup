import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeUploadVerificationTiming, SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UploadTask, UploadVerificationTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

function verificationState(localDir: string): any {
  const now = new Date().toISOString();
  return {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      BVVERIFY: { bvid: "BVVERIFY", title: "Verify", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "uploaded", localDir },
    },
    relations: {
      "u1:1:BVVERIFY": {
        userId: "u1", mediaId: 1, bvid: "BVVERIFY", folderTitle: "Favorites", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "uploaded", remotePath: "/target",
        remoteFiles: [{ name: "video.mp4", path: "/target/video.mp4", size: 12, localRelativePath: "video.mp4", verificationStatus: "awaiting_verification", putCompletedAt: now }],
      },
    },
  };
}

test("staggered multipart PUTs each receive the full confirmation window", () => {
  const firstPut = Date.parse("2026-08-17T00:00:00.000Z");
  const secondPut = firstPut + 8 * 60_000;
  const beforeSecondDeadline = secondPut + 9 * 60_000;
  const stillWaiting = computeUploadVerificationTiming([firstPut, secondPut], beforeSecondDeadline);
  assert.equal(stillWaiting.timedOut, false);
  assert.ok((stillWaiting.nextAt || 0) > beforeSecondDeadline);
  assert.equal(computeUploadVerificationTiming([firstPut, secondPut], secondPut + 10 * 60_000).timedOut, true);
});

test("manual recovery uploads keep scheduler maintenance locked", async () => {
  const runtime = await createTestDir("manual-wait-maintenance-lock");
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
  ) as any;
  try {
    assert.equal(scheduler.hasPersistentTransferWork(), false);
    scheduler.jobStore.enqueue({
      kind: "upload",
      dedupeKey: "upload:manual-maintenance-lock",
      bvid: "BVMANUALLOCK",
      initialStatus: "manual_wait",
      payload: { awaitingManualRecovery: true, files: ["video.mp4"] },
    });
    assert.equal(scheduler.hasPersistentTransferWork(), true);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

async function createStructuredRecoveryFixture(
  name: string,
  remoteResult: {
    status: "verified" | "missing" | "mismatch" | "unknown";
    remoteSize?: number;
    parentStatus?: "visible" | "missing" | "unknown";
    failure?: { category: "transient" | "permission" | "unsupported" | "not_found" | "conflict" | "unknown"; status?: number };
  },
  options: { local?: "available" | "missing" | "changed"; automaticRecoveryAttempts?: number; attempts?: number; now?: () => number } = {},
) {
  const runtime = await createTestDir(name);
  const localDir = path.join(runtime, "temp", "BVVERIFY");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), Buffer.alloc(options.local === "changed" ? 8 : 12, 1));
  if (options.local === "missing") await fs.promises.rm(path.join(localDir, "video.mp4"));
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  manager.replaceStateSnapshot(verificationState(localDir));
  const user = {
    id: "u1", uid: 1, name: "Tester",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Favorites" }],
    enabled: true, lastLoginAt: new Date().toISOString(),
  };
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager,
    { remoteFileInspector: async () => remoteResult, legacyTempDir: path.join(runtime, "temp"), now: options.now },
  ) as any;
  scheduler.downloadQueue.setStartGate(() => false);
  scheduler.uploadQueue.setStartGate(() => false);
  scheduler.verificationQueue.setStartGate(() => false);
  const session = scheduler.transferSessions.ensure({
    dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    localDir,
    remotePath: "/target",
  });
  scheduler.transferSessions.ensureFile(session.id, { relativePath: "video.mp4", name: "video.mp4", expectedSize: 12 }, session.generation);
  scheduler.transferSessions.updateFile(session.id, "video.mp4", {
    status: "awaiting_remote",
    putAcceptedAt: Date.now() - 11 * 60_000,
    attempts: options.attempts || 0,
  }, session.generation);
  scheduler.transferSessions.updateSession(session.id, { phase: "failed", lastError: "visibility timeout" }, session.generation);
  const job = scheduler.jobStore.enqueue({
    kind: "upload",
    dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    initialStatus: "manual_wait",
    payload: {
      awaitingManualRecovery: true,
      resumeOnly: true,
      localDir,
      remotePath: "/target",
      files: ["video.mp4"],
      folderTitle: "Favorites",
      videoTitle: "Verify",
      sessionId: session.id,
      sessionGeneration: session.generation,
      automaticRecoveryAttempts: options.automaticRecoveryAttempts || 0,
      filenameMetadataByPath: {
        "video.mp4": { cid: 100, pageIndex: 1, mediaMetadata: { width: 1920, height: 1080, source: "ffprobe", observedAt: new Date().toISOString() } },
      },
    },
  });
  return { runtime, localDir, manager, scheduler, session, job };
}

test("recovery automation finalizes a remotely visible file without reading the missing local body", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-verified", { status: "verified", remoteSize: 12 }, { local: "missing" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "completed");
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remoteFiles?.[0]?.path, "/target/video.mp4");
    assert.equal(relation?.remoteFiles?.[0]?.mediaMetadata?.width, 1920);
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVVERIFY"), null);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("same-size recovery without a PUT proof becomes an isolated candidate and never writes new media metadata", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-unknown-same-size", { status: "verified", remoteSize: 12 });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    scheduler.transferSessions.updateFile(session.id, "video.mp4", {
      status: "awaiting_remote",
      putAcceptedAt: null,
      verifiedAt: null,
    }, session.generation);
    await scheduler.runRecoveryAutomationNow();
    const current = scheduler.jobStore.findById(job.id);
    assert.equal((current?.payload as any).conflictCandidateOnly, true);
    assert.equal((current?.payload as any).lifecycleState, "conflict_candidate");
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.notEqual(relation?.backupStatus, "verified");
    assert.equal(relation?.remoteFiles?.[0]?.mediaMetadata, undefined);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("abandoning a recovery attempt supersedes its session and stays hidden on later reconciliation", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-abandon-attempt", { status: "missing", parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    const first = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "abandon_attempt", {});
    assert.equal(first.ok, true);
    const abandoned = scheduler.jobStore.findById(job.id);
    assert.equal(abandoned?.status, "failed");
    assert.equal((abandoned?.payload as any).awaitingManualRecovery, false);
    assert.equal((abandoned?.payload as any).lifecycleState, "abandoned");
    assert.equal((abandoned?.payload as any).userDisposition, "abandoned");
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "superseded");
    assert.equal(scheduler.getRecoveryIssues().some((item: any) => item.id === `upload.${job.id}`), false);

    const second = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "abandon_attempt", {});
    assert.equal(second.ok, true);
    assert.equal((second as any).idempotent, true);
    scheduler.reconcileTransferSessionRecoveryJobs(true);
    assert.equal(scheduler.jobStore.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`)?.id, undefined);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("transfer-session recovery projection reaches orphan sessions beyond the first thousand active rows", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-projection-pagination", { status: "missing", parentStatus: "visible" });
  const { runtime, manager, scheduler, session: seedSession, job: seedJob } = fixture;
  try {
    scheduler.jobStore.complete(seedJob.id);
    scheduler.transferSessions.supersede(seedSession.id, seedSession.generation);
    const orphanIndex = 1_001;
    let orphanSessionId = "";
    for (let index = 0; index <= orphanIndex; index += 1) {
      const bvid = `BVPAGE${String(index).padStart(4, "0")}`;
      const transfer = scheduler.transferSessions.ensure({
        dedupeKey: `upload-page:${index}`,
        bvid,
        userId: "u1",
        mediaId: 1,
        localDir: path.join(runtime, "temp", bvid),
        remotePath: `/page/${index}`,
      });
      scheduler.transferSessions.ensureFile(transfer.id, {
        relativePath: "video.mp4",
        name: "video.mp4",
        expectedSize: 12,
      }, transfer.generation);
      scheduler.transferSessions.updateSession(transfer.id, {
        phase: "failed",
        lastError: "orphaned upload session",
      }, transfer.generation);
      if (index < orphanIndex) {
        scheduler.jobStore.enqueue({
          kind: "upload",
          dedupeKey: `upload-page-job:${index}`,
          bvid,
          userId: "u1",
          mediaId: 1,
          payload: {
            sessionId: transfer.id,
            sessionGeneration: transfer.generation,
            awaitingManualRecovery: false,
          },
        });
      } else {
        orphanSessionId = transfer.id;
      }
    }
    scheduler.reconcileTransferSessionRecoveryJobs(true);
    const projected = scheduler.jobStore.findByDedupeKey(`upload-session:${orphanSessionId}:g1`);
    assert.ok(projected);
    assert.equal((projected?.payload as any).recoveryProjection, true);
    assert.equal((projected?.payload as any).awaitingManualRecovery, true);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("projected multipart sessions expose partial-upload lifecycle without touching local files", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-partial-lifecycle", { status: "missing", parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    scheduler.jobStore.complete(job.id);
    scheduler.transferSessions.ensureFile(session.id, {
      relativePath: "video-2.mp4",
      name: "video-2.mp4",
      expectedSize: 24,
    }, session.generation);
    scheduler.transferSessions.updateFile(session.id, "video.mp4", { status: "verified", verifiedAt: Date.now() }, session.generation);
    scheduler.transferSessions.updateFile(session.id, "video-2.mp4", { status: "pending" }, session.generation);
    scheduler.transferSessions.updateSession(session.id, { phase: "awaiting_remote" }, session.generation);
    scheduler.reconcileTransferSessionRecoveryJobs(true);
    const projected = scheduler.jobStore.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`);
    assert.ok(projected);
    assert.equal((projected?.payload as any).lifecycleState, "partial_upload");
    assert.equal((projected?.payload as any).verifiedPages, 1);
    assert.equal((projected?.payload as any).totalPages, 2);
    assert.equal((projected?.payload as any).recoveryAssessment.localStatus, "unknown");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a failed transfer session without a job is projected once into recovery", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-projection", { status: "missing", parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    scheduler.jobStore.complete(job.id);
    scheduler.transferSessions.updateSession(session.id, { phase: "failed", lastError: "WebDAV 405 write result was not confirmed" }, session.generation);

    const first = scheduler.getRecoveryIssueSnapshot().issues.filter((item: any) => item.bvid === "BVVERIFY");
    assert.equal(first.length, 1);
    const projected = scheduler.jobStore.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`);
    assert.ok(projected);
    assert.equal(projected?.status, "manual_wait");
    assert.equal((projected?.payload as any).lifecycleState, "manual_required");
    assert.equal((projected?.payload as any).totalPages, 1);
    assert.equal(first[0]?.kind, "remote_write_rejected");

    const second = scheduler.getRecoveryIssueSnapshot().issues.filter((item: any) => item.bvid === "BVVERIFY");
    assert.equal(second.length, 1);
    assert.equal(scheduler.jobStore.list(["upload"]).filter((candidate) => candidate.bvid === "BVVERIFY").length, 1);

    manager.getDatabase().db.prepare("UPDATE jobs SET status='completed', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(projected!.id);
    scheduler.reconcileTransferSessionRecoveryJobs(true);
    assert.equal(scheduler.jobStore.findById(projected!.id)?.status, "manual_wait");

    const nonManualTerminalPayload = { ...(scheduler.jobStore.findById(projected!.id)?.payload as any), awaitingManualRecovery: false };
    manager.getDatabase().db.prepare("UPDATE jobs SET status='failed', payload_json=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?")
      .run(JSON.stringify(nonManualTerminalPayload), projected!.id);
    scheduler.reconcileTransferSessionRecoveryJobs(true);
    assert.equal(scheduler.jobStore.findById(projected!.id)?.status, "manual_wait");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("remote invisibility creates one isolated candidate after three persisted observations over 30 minutes", async () => {
  const start = Date.parse("2026-08-24T00:00:00.000Z");
  let clock = start;
  const fixture = await createStructuredRecoveryFixture(
    "recovery-visibility-stalled",
    { status: "missing", parentStatus: "visible" },
    { now: () => clock },
  );
  const { runtime, manager, scheduler, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    let assessment = (scheduler.jobStore.findById(job.id)?.payload as any).recoveryAssessment;
    assert.equal(assessment.kind, "remote_visibility_timeout");
    assert.equal(assessment.consecutiveObservations, 1);

    clock = start + 6 * 60_000;
    await scheduler.runRecoveryAutomationNow();
    assessment = (scheduler.jobStore.findById(job.id)?.payload as any).recoveryAssessment;
    assert.equal(assessment.kind, "remote_visibility_timeout");
    assert.equal(assessment.consecutiveObservations, 2);

    clock = start + 31 * 60_000;
    await scheduler.runRecoveryAutomationNow();
    const current = scheduler.jobStore.findById(job.id)!;
    assert.equal((current.payload as any).conflictCandidateOnly, true, JSON.stringify(current));
    assert.equal((current.payload as any).lifecycleState, "conflict_candidate");
    assert.equal((current.payload as any).userDisposition, "automatic_candidate");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation queues one fresh download when both local and remote files are missing", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-redownload", { status: "missing" }, { local: "missing" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "superseded");
    const download = scheduler.jobStore.findByDedupeKey("download:BVVERIFY");
    assert.ok(download);
    assert.equal(download.payload.automaticRecoveryAttempts, 1);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "queued");
    assert.equal(scheduler.getRecoveryIssues().length, 0);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("repeated missing target with a visible parent becomes actionable without claiming a size limit", async () => {
  const fixture = await createStructuredRecoveryFixture(
    "recovery-remote-write-rejected",
    { status: "missing", parentStatus: "visible" },
    { local: "available", attempts: 3 },
  );
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const current = scheduler.jobStore.findById(job.id);
    assert.equal(current?.status, "manual_wait");
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "failed");
    const issue = scheduler.getQueueSnapshot().issues.find((item: any) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "remote_write_rejected");
    assert.equal(issue?.severity, "warning");
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), [
      "redownload_with_encoding",
      "open_settings",
      "recheck",
      "abandon_attempt",
    ]);
    const boardItem = scheduler.getQueueSnapshot().uploadPending.find((item: any) => item.persistentJobId === job.id);
    assert.equal(boardItem?.phase, "manual_action");
    assert.equal(boardItem?.actionRequired, true);
    assert.deepEqual(boardItem?.recoveryActions?.map((action: any) => action.id), ["redownload_with_encoding"]);
    assert.match(issue?.summary || "", /可以尝试一次换编码/);
    assert.doesNotMatch(issue?.summary || "", /超过存储限制/);
    assert.doesNotMatch(issue?.safeDiagnostic || "", /\/target/);

    const retry = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "redownload_with_encoding", {
      encodingPriority: ["AV1", "HEVC", "AVC"],
      strict: true,
    });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.ok(retry.childJobId);
    assert.equal((scheduler.jobStore.findById(job.id)?.payload as any).encodingRetry.strict, true);
    assert.equal(scheduler.jobStore.list(["download"]).filter((candidate) => (candidate.payload as any).encodingRetry?.parentJobId === job.id).length, 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("one missing target with a visible parent remains a background visibility check", async () => {
  const fixture = await createStructuredRecoveryFixture(
    "recovery-visible-parent-single-attempt",
    { status: "missing", parentStatus: "visible" },
    { local: "available", attempts: 1 },
  );
  const { runtime, manager, scheduler, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${job.id}`);
    assert.ok(issue, JSON.stringify({ job: scheduler.jobStore.findById(job.id), issues: scheduler.getRecoveryIssues() }));
    assert.equal(issue?.kind, "remote_visibility_timeout");
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), ["recheck"]);
    assert.equal(issue?.disposition, "background");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual recheck stays read-only when both local and remote files are missing", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-manual-recheck-readonly", { status: "missing" }, { local: "missing" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    const result = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "recheck");
    assert.equal(result.ok, true);
    assert.ok(scheduler.jobStore.findById(job.id));
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "failed");
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVVERIFY"), null);
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "local_file_missing");
    assert.equal(issue?.recommendedAction?.id, "redownload");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual redownload shares an in-flight automatic recheck before deciding", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-shared-recheck", { status: "missing" }, { local: "missing" });
  const { runtime, manager, scheduler, session, job } = fixture;
  let releaseRemoteCheck!: () => void;
  let signalRemoteCheckStarted!: () => void;
  const remoteCheckStarted = new Promise<void>((resolve) => { signalRemoteCheckStarted = resolve; });
  let inspections = 0;
  scheduler.remoteFileInspector = async () => {
    inspections += 1;
    signalRemoteCheckStarted();
    await new Promise<void>((resolve) => { releaseRemoteCheck = resolve; });
    return { status: "verified", remoteSize: 12 };
  };
  scheduler.jobStore.updatePayload(job.id, {
    ...job.payload,
    recoveryAssessment: {
      kind: "remote_visibility_timeout",
      checkedAt: Date.now() - 10_000,
      nextCheckAt: Date.now() - 1,
      localStatus: "missing",
      remoteStatus: "missing",
      summary: "waiting",
    },
  });
  try {
    const automatic = scheduler.runRecoveryAutomationNow();
    await remoteCheckStarted;
    const manual = scheduler.resolveRecoveryIssue(`upload.${job.id}`, "redownload");
    releaseRemoteCheck();
    const [, result] = await Promise.all([automatic, manual]);
    assert.equal(result.ok, true);
    assert.equal(inspections, 1);
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "completed");
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVVERIFY"), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation selects due work beyond a thousand deferred issues", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-due-selection", { status: "verified", remoteSize: 12 });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    manager.getDatabase().db.prepare("UPDATE jobs SET priority=100 WHERE id=?").run(job.id);
    const future = Date.now() + 60 * 60_000;
    for (let index = 0; index < 1_000; index += 1) {
      scheduler.jobStore.enqueue({
        kind: "upload",
        dedupeKey: `upload:deferred:${index}`,
        bvid: `BVDEFERRED${index}`,
        priority: 1,
        initialStatus: "manual_wait",
        payload: {
          awaitingManualRecovery: true,
          recoveryAssessment: {
            kind: "remote_connection",
            checkedAt: Date.now(),
            nextCheckAt: future,
            localStatus: "available",
            remoteStatus: "error",
            summary: "deferred",
          },
        },
      });
    }
    await scheduler.runRecoveryAutomationNow();
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "completed");
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation stops after the automatic redownload limit and reports the stale local file", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-loop-guard", { status: "missing" }, {
    local: "missing",
    automaticRecoveryAttempts: 3,
  });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.ok(scheduler.jobStore.findById(job.id));
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "failed");
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVVERIFY"), null);
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "local_file_missing");
    assert.equal(issue?.recommendedAction?.id, "redownload");
    assert.match(issue?.summary || "", /自动重新下载 3 次/);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation isolates remote size conflicts without touching the official path", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-remote-conflict", { status: "mismatch", remoteSize: 99 }, { local: "available" });
  const { runtime, manager, scheduler, session, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.ok(scheduler.jobStore.findById(job.id));
    assert.equal(scheduler.transferSessions.get(session.id)?.phase, "failed");
    assert.equal(scheduler.jobStore.findByDedupeKey("download:BVVERIFY"), null);
    const current = scheduler.jobStore.findById(job.id)!;
    assert.equal((current.payload as any).conflictCandidateOnly, true, JSON.stringify(current));
    assert.equal((current.payload as any).remotePath, "/target");
    assert.match(String((current.payload as any).conflictCandidateRemotePath), /\/_conflicts\/upload-/);
    assert.equal(scheduler.getRecoveryIssueSnapshot().issues.some((item: any) => item.id === `upload.${job.id}`), false);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a size conflict candidate is idempotently projected as one full-group upload", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-create-candidate", { status: "mismatch", remoteSize: 99 });
  const { runtime, manager, scheduler, job } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const updated = scheduler.jobStore.findById(job.id)!;
    assert.equal((updated.payload as any).conflictCandidateOnly, true, JSON.stringify(updated.payload));
    assert.equal((updated.payload as any).awaitingManualRecovery, false);
    assert.match(String((updated.payload as any).conflictCandidateRemotePath), /\/_conflicts\/upload-/);
    assert.equal((updated.payload as any).remotePath, "/target");
    assert.deepEqual((updated.payload as any).files, ["video.mp4"]);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("multipart mixed remote state creates one candidate containing every part", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-multipart-candidate", { status: "missing", parentStatus: "visible" });
  const { runtime, localDir, manager, scheduler, session, job } = fixture;
  try {
    await fs.promises.writeFile(path.join(localDir, "video-p2.mp4"), Buffer.alloc(7, 2));
    scheduler.transferSessions.ensureFile(session.id, {
      relativePath: "video-p2.mp4",
      name: "video-p2.mp4",
      expectedSize: 7,
    }, session.generation);
    scheduler.transferSessions.updateFile(session.id, "video-p2.mp4", {
      status: "awaiting_remote",
      putAcceptedAt: Date.now() - 11 * 60_000,
    }, session.generation);
    scheduler.jobStore.updatePayload(job.id, {
      ...job.payload,
      files: ["video.mp4", "video-p2.mp4"],
      filenameMetadataByPath: {
        ...(job.payload as any).filenameMetadataByPath,
        "video-p2.mp4": { cid: 101, pageIndex: 2 },
      },
    });
    scheduler.remoteFileInspector = async (_config: unknown, remotePath: string) => remotePath.endsWith("video.mp4")
      ? { status: "verified", remoteSize: 12 }
      : { status: "missing", parentStatus: "visible" };

    await scheduler.runRecoveryAutomationNow();
    const updated = scheduler.jobStore.findById(job.id)!;
    assert.equal((updated.payload as any).conflictCandidateOnly, true);
    assert.deepEqual((updated.payload as any).files, ["video.mp4", "video-p2.mp4"]);
    assert.equal((updated.payload as any).remotePath, "/target");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("unknown WebDAV failures offer candidates only when the failure is path-specific and writable-looking", async () => {
  const supportedFallback = await createStructuredRecoveryFixture("recovery-unsupported-candidate", {
    status: "unknown",
    parentStatus: "visible",
    failure: { category: "unsupported", status: 405 },
  });
  try {
    await supportedFallback.scheduler.runRecoveryAutomationNow();
    const issue = supportedFallback.scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${supportedFallback.job.id}`);
    assert.equal(issue?.kind, "remote_unsupported");
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), ["create_candidate", "recheck", "open_settings", "abandon_attempt"]);
  } finally {
    supportedFallback.scheduler.stop();
    supportedFallback.manager.close();
    await removeTestDir(supportedFallback.runtime);
  }

  const permissionFailure = await createStructuredRecoveryFixture("recovery-permission-no-candidate", {
    status: "unknown",
    parentStatus: "visible",
    failure: { category: "permission", status: 403 },
  });
  try {
    await permissionFailure.scheduler.runRecoveryAutomationNow();
    const issue = permissionFailure.scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${permissionFailure.job.id}`);
    assert.equal(issue?.kind, "remote_permission");
    assert.equal((permissionFailure.scheduler.jobStore.findById(permissionFailure.job.id)?.payload as any).recoveryAssessment.candidateEligible, false);
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), ["open_settings", "recheck", "abandon_attempt"]);
  } finally {
    permissionFailure.scheduler.stop();
    permissionFailure.manager.close();
    await removeTestDir(permissionFailure.runtime);
  }
});

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
  const configStore = { get: () => config } as any;
  const userStore = { list: () => [], getById: () => undefined } as any;
  let scheduler = new SyncScheduler(configStore, userStore, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const putCompletedAt = new Date().toISOString();
  scheduler.jobStore.enqueue({
    kind: "verify_upload",
    dedupeKey: "verify:u1:1:BVVERIFY:main:/target/video.mp4",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    maxAttempts: 8,
    payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir, remotePath: "/target", files: ["video.mp4"], putCompletedAt, folderTitle: "Favorites", videoTitle: "Verify" },
  });
  let job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
  const missing = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
  missing.persistentJobId = job.id;
  missing.persistentJob = job;
  missing.result = { status: "missing" };
  scheduler.handleUploadVerificationCompleted(missing);
  assert.equal(scheduler.jobStore.findById(job.id)?.status, "retry_wait");
  scheduler.stop();
  manager.close();

  manager = new StateManager({ statePath, dbPath });
  scheduler = new SyncScheduler(configStore, userStore, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const persisted = scheduler.jobStore.findByDedupeKey("verify:u1:1:BVVERIFY:main:/target/video.mp4");
  assert.equal(persisted?.status, "retry_wait");
  manager.getDatabase().db.prepare("UPDATE jobs SET status='retry_wait', attempts=5, not_before=0, lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(persisted!.id);
  job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
  const timedOut = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
  timedOut.persistentJobId = job.id;
  timedOut.persistentJob = { ...job, attempts: 5, payload: { ...job.payload, putCompletedAt: new Date(Date.now() - 11 * 60_000).toISOString() } };
  timedOut.result = { status: "missing" };
  const beforeTimeout = Date.now();
  scheduler.handleUploadVerificationCompleted(timedOut);
  const reupload = scheduler.jobStore.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
  assert.ok(reupload);
  assert.equal(reupload!.status, "manual_wait");
  assert.equal(reupload!.payload.awaitingManualRecovery, true);
  assert.equal(reupload!.notBefore, 0);
  assert.equal(reupload!.notBefore >= beforeTimeout + 29 * 60_000, false);
  const recovery = await scheduler.recoverUploadJob(reupload!.id, false);
  assert.equal(recovery.ok, true);
  assert.equal(scheduler.jobStore.findById(reupload!.id)?.payload.awaitingManualRecovery, false);
  assert.equal(
    scheduler.uploadQueue.getTasks().some((task: any) => task.resumeOnly === true),
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
  snapshot.videos.BVVERIFY = {
    ...snapshot.videos.BVVERIFY,
    backupStatus: "upload_failed",
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
    lastError: "旧恢复任务曾读取不到本地文件",
  };
  snapshot.relations["u1:1:BVVERIFY"] = {
    ...snapshot.relations["u1:1:BVVERIFY"],
    backupStatus: "upload_failed",
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
    lastError: "旧恢复任务曾读取不到本地文件",
  };
  manager.replaceStateSnapshot(snapshot);
  await fs.promises.rm(path.join(localDir, "video.mp4"));
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    { remoteFileInspector: async () => ({ status: "verified" }) } as any,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "upload",
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
    assert.equal(scheduler.jobStore.findById(job.id), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
    assert.equal(manager.getDatabase().getVideo("BVVERIFY")?.backupStatus, "verified");
    assert.equal(scheduler.uploadQueue.getTasks().length, 0);
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
  snapshot.videos.BVVERIFY = {
    ...snapshot.videos.BVVERIFY,
    backupStatus: "upload_failed",
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
  };
  snapshot.relations["u1:1:BVVERIFY"] = {
    ...snapshot.relations["u1:1:BVVERIFY"],
    backupStatus: "upload_failed",
    remotePath: "/target",
    remoteFiles: [{ ...verifiedFile }],
    uploadedAt: verifiedAt,
    verifiedAt,
  };
  manager.replaceStateSnapshot(snapshot);
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    { remoteFileInspector: async () => ({ status: "verified" }) } as any,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const obsolete = scheduler.jobStore.enqueue({
      kind: "upload",
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
    const candidate = scheduler.jobStore.enqueue({
      kind: "upload",
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

    await scheduler.reconcileObsoleteVerifiedArchiveRecoveries();

    assert.equal(scheduler.jobStore.findById(obsolete.id), null);
    assert.equal(scheduler.jobStore.findById(candidate.id)?.payload.conflictCandidate !== undefined, true);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {
    scheduler.stop();
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
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let inspections = 0;
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    { remoteFileInspector: async () => { inspections += 1; return { status: "verified" }; } } as any,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "upload", dedupeKey: "upload:u1:1:BVVERIFY:/target:conflict-retained-proof", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"],
        conflictCandidate: { id: "candidate-1", candidateRemotePath: "/target/_conflicts/candidate-1", files: [{ ...verifiedFile, path: "/target/_conflicts/candidate-1/video.mp4" }] },
      },
    });
    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, false);
    assert.equal(inspections, 0);
    assert.equal(scheduler.jobStore.findById(job.id)?.status, "manual_wait");
    assert.equal(scheduler.jobStore.findById(job.id)?.payload.conflictCandidate?.id, "candidate-1");
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
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let inspections = 0;
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    { remoteFileInspector: async () => { inspections += 1; return { status: "missing" }; } } as any,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "upload", dedupeKey: "upload:u1:1:BVVERIFY:/target:remote-missing", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "retry_wait",
      payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"] },
    });
    const result = await scheduler.recoverUploadJob(job.id, false);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, undefined);
    assert.equal(inspections, 1);
    assert.equal(scheduler.jobStore.findById(job.id)?.status, "retry_wait");
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
  snapshot.videos.BVVERIFY = { ...snapshot.videos.BVVERIFY, backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  snapshot.relations["u1:1:BVVERIFY"] = { ...snapshot.relations["u1:1:BVVERIFY"], backupStatus: "upload_failed", remotePath: "/target", remoteFiles: [{ ...verifiedFile }], uploadedAt: verifiedAt, verifiedAt };
  manager.replaceStateSnapshot(snapshot);
  let active = 0;
  let maximumActive = 0;
  let inspections = 0;
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    { remoteFileInspector: async () => {
      inspections += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "verified" };
    } } as any,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const empty = scheduler.jobStore.enqueue({
      kind: "upload", dedupeKey: "upload:u1:1:BVVERIFY:/target:empty-files", bvid: "BVVERIFY", userId: "u1", mediaId: 1,
      initialStatus: "retry_wait",
      payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: [] },
    });
    for (let index = 0; index < 3; index += 1) {
      scheduler.jobStore.enqueue({
        kind: "upload", dedupeKey: `upload:u1:1:BVVERIFY:/target:bounded-${index}`, bvid: "BVVERIFY", userId: "u1", mediaId: 1,
        initialStatus: "retry_wait",
        payload: { awaitingManualRecovery: false, resumeOnly: true, allowReupload: false, localDir, remotePath: "/target", files: ["video.mp4"] },
      });
    }
    await scheduler.reconcileObsoleteVerifiedArchiveRecoveries(10, undefined, 2);
    assert.ok(scheduler.jobStore.findById(empty.id));
    assert.equal(inspections, 3);
    assert.equal(maximumActive <= 2, true);
  } finally {
    scheduler.stop();
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
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "upload",
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
    assert.equal(scheduler.jobStore.findById(job.id)?.status, "manual_wait");
    assert.equal(scheduler.jobStore.findById(job.id)?.payload.awaitingManualRecovery, true);
    assert.equal(scheduler.uploadQueue.getTasks().length, 0);
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
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const putCompletedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  scheduler.jobStore.enqueue({
    kind: "verify_upload",
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
  const job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
  const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
  task.persistentJobId = job.id;
  task.persistentJob = { ...job, attempts: 5, payload: { ...job.payload, putCompletedAt } };
  task.result = { status: "missing" };
  task.transferResult = {
    remotePath: "/target",
    files: [{ name: "video.mp4", path: "/target/video.mp4", size: 12, verificationStatus: "awaiting_verification" }],
    allVerified: false,
    pendingChecks: [{ remoteFile: "/target/video.mp4", expectedSize: 12, finalFile: "/target/video.mp4", localRelativePath: "video.mp4" }],
  };
  scheduler.handleUploadVerificationCompleted(task);
  const recovery = scheduler.jobStore.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
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
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  scheduler.verificationQueue.setStartGate(() => false);
  try {
    scheduler.enqueueUploadVerificationJobs({
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
      { path: "/target/p01.mp4", size: 12, verificationStatus: "awaiting_verification", localRelativePath: "p01.mp4" },
      { path: "/target/p02.mp4", size: 13, verificationStatus: "awaiting_verification", localRelativePath: "p02.mp4" },
    ], [
      { remoteFile: "/target/p01.mp4", expectedSize: 12, finalFile: "/target/p01.mp4", localRelativePath: "p01.mp4" },
      { remoteFile: "/target/p02.mp4", expectedSize: 13, finalFile: "/target/p02.mp4", localRelativePath: "p02.mp4" },
    ]);
    const jobs = scheduler.jobStore.listForBoard(["verify_upload"], 10);
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
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    scheduler.jobStore.enqueue({
      kind: "upload",
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      payload: { localDir: path.join(runtime, "temp", "BVVERIFY"), remotePath: "/target" },
    });
    const claimed = scheduler.jobStore.claimDue(["upload"], 1, scheduler.leaseOwner, 60_000)!;
    assert.ok(claimed[0]);
    scheduler.jobStore.markRunning(claimed[0].id, scheduler.leaseOwner, 60_000);
    const task: any = {
      name: "Upload BVVERIFY",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      historyOnly: false,
      downloadDir: path.join(runtime, "temp", "BVVERIFY"),
      remotePath: "/target",
      retries: 0,
      maxRetries: 3,
      persistentJobId: claimed[0].id,
      persistentJob: scheduler.jobStore.findById(claimed[0].id),
    };
    const error: any = new Error("Remote size conflict");
    error.uploadFailure = {
      category: "deterministic",
      status: 409,
      summary: "Remote size conflict",
      remotePath: "/target/video.mp4",
      retryable: false,
      fingerprint: "deterministic|409|conflict",
    };
    scheduler.uploadQueue.emit("taskError", task, error);
    const parked = scheduler.jobStore.findById(claimed[0].id);
    assert.equal(parked?.status, "manual_wait");
    assert.equal(parked?.payload.awaitingManualRecovery, true);
    assert.equal(parked?.payload.resumeOnly, true);
    assert.equal(parked?.payload.allowReupload, false);
    scheduler.jobStore.enqueue({
      kind: "upload",
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      payload: { localDir: "new-sync-payload", remotePath: "/target" },
    });
    const preserved = scheduler.jobStore.findById(claimed[0].id);
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
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const session = scheduler.transferSessions.ensure({
      dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
      bvid: "BVVERIFY",
      userId: "u1",
      mediaId: 1,
      localDir,
      remotePath: "/target",
    });
    scheduler.transferSessions.ensureFile(session.id, { relativePath: "video.mp4", name: "video.mp4", expectedSize: 12 }, session.generation);
    const verifyJob = scheduler.jobStore.enqueue({
      kind: "verify_upload",
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
    const claimed = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
    assert.equal(claimed.id, verifyJob.id);
    const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config, {
      transferSessionStore: scheduler.transferSessions,
      sessionId: session.id,
      sessionGeneration: session.generation,
      sessionVerification: true,
    }) as any;
    task.persistentJobId = claimed.id;
    task.persistentJob = claimed;
    const error: any = new Error("Remote size conflict");
    error.uploadFailure = {
      category: "deterministic",
      status: 409,
      summary: "Remote size conflict",
      remotePath: "/target/video.mp4",
      retryable: false,
      fingerprint: "deterministic|409|confirm-conflict",
    };
    scheduler.verificationQueue.emit("taskError", task, error);

    assert.equal(scheduler.jobStore.findById(verifyJob.id), null);
    const recovery = scheduler.jobStore.findByDedupeKey("upload:u1:1:BVVERIFY:/target:main");
    assert.equal(recovery?.status, "manual_wait");
    assert.equal(recovery?.payload.awaitingManualRecovery, true);
    assert.equal(recovery?.payload.resumeOnly, true);
    assert.equal(recovery?.payload.allowReupload, false);
    assert.equal(recovery?.payload.sessionId, session.id);
    assert.equal(recovery?.payload.sessionGeneration, 1);
    assert.equal(recovery?.payload.conflictRemotePath, "/target/video.mp4");
    assert.equal(scheduler.transferSessions.listFiles(session.id, 1).length, 1);
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
  const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  try {
    const job = scheduler.jobStore.enqueue({
      kind: "upload",
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
    const claimed = scheduler.jobStore.claimDue(["upload"], 1, scheduler.leaseOwner, 60_000)[0];
    assert.equal(claimed.id, job.id);

    const task = new UploadTask("BVVERIFY", localDir, "/target", config, {
      files: ["video.mp4"],
      reuploadAuthorizedFiles: ["video.mp4"],
      resumeOnly: true,
    }) as any;
    task.persistentJobId = claimed.id;
    task.persistentJob = claimed;
    task.userId = "u1";
    task.mediaId = 1;
    task.consumeReuploadPermission = (relativePath: string) => scheduler.jobStore.consumeUploadReuploadPermission(
      claimed.id,
      scheduler.leaseOwner,
      relativePath,
    );

    scheduler.uploadQueue.emit("taskStart", task);
    assert.equal(task.reuploadPermissionUsed, false);
    assert.deepEqual(scheduler.jobStore.findById(job.id)?.payload.reuploadAuthorizedFiles, ["video.mp4"]);
    task.reuploadPermissionUsed = task.consumeReuploadPermission("video.mp4");
    assert.equal(task.reuploadPermissionUsed, true);
    assert.equal(scheduler.jobStore.findById(job.id)?.payload.allowReupload, false);

    const error: any = new Error("temporary upload failure after authorized retry");
    error.uploadFailure = {
      category: "server",
      status: 503,
      summary: "temporary upload failure after authorized retry",
      remotePath: "/target/video.mp4",
      retryable: true,
      fingerprint: "server|503|authorized-retry",
    };
    scheduler.uploadQueue.emit("taskError", task, error);

    const parked = scheduler.jobStore.findById(job.id);
    assert.equal(parked?.status, "manual_wait");
    assert.equal(parked?.payload.awaitingManualRecovery, true);
    assert.equal(parked?.payload.allowReupload, false);
    assert.equal(parked?.payload.resumeOnly, true);
    assert.equal(scheduler.jobStore.claimDue(["upload"], 1, scheduler.leaseOwner, 60_000).length, 0);
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
    const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [], getById: () => undefined } as any, manager) as any;
    scheduler.uploadQueue.setStartGate(() => false);
    scheduler.jobStore.enqueue({ kind: "verify_upload", dedupeKey: "verify:success", bvid: "BVVERIFY", userId: "u1", mediaId: 1, payload: { remoteFile: "/target/video.mp4", expectedSize: 12, localDir: "" } });
    const job = scheduler.jobStore.claimDue(["verify_upload"], 1, scheduler.leaseOwner, 60_000)[0];
    const task = new UploadVerificationTask("BVVERIFY", "u1", 1, "/target/video.mp4", 12, config) as any;
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.result = { status: "verified", remoteSize: 12 };
    scheduler.handleUploadVerificationCompleted(task);
    assert.equal(scheduler.jobStore.findById(job.id), null);
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
  Object.assign(snapshot.videos.BVVERIFY, {
    backupStatus: oldProof.status,
    remotePath: oldProof.remotePath,
    remoteFiles: oldProof.files,
    uploadedAt: oldProof.uploadedAt,
    verifiedAt: oldProof.verifiedAt,
  });
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
  const scheduler = new SyncScheduler(
    { get: () => testConfig() } as any,
    { list: () => [], getById: () => undefined } as any,
    manager,
    {
      remoteFileInspector: async (_config, remotePath) => ({
        status: "verified" as const,
        remoteSize: remotePath.includes("/_conflicts/") ? 12 : 10,
      }),
    },
  ) as any;
  scheduler.uploadQueue.setStartGate(() => false);
  const job = scheduler.jobStore.enqueue({
    kind: "upload",
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
  const claimed = scheduler.jobStore.claimDue(["upload"], 1, scheduler.leaseOwner, 60_000)[0];
  scheduler.jobStore.markRunning(claimed.id, scheduler.leaseOwner, 60_000);
  const task = new UploadTask("BVVERIFY", localDir, "/target", testConfig(), {
    cleanupLocal: false,
    files: ["video.mp4"],
    existingArchiveProof: oldProof,
    conflictCandidateId: "upload-candidate",
    conflictCandidateRemotePath: "/target/_conflicts/upload-candidate",
  }) as any;
  task.userId = "u1";
  task.mediaId = 1;
  task.partialBackup = Boolean(options.partialCandidate);
  task.persistentJobId = job.id;
  task.persistentJob = scheduler.jobStore.findById(job.id);
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
  scheduler.uploadQueue.emit("taskCompleted", task);
  return { runtime, localDir, manager, scheduler, job, oldProof, candidateFiles };
}

test("conflict candidate selection preserves the old archive proof in the audit record", async () => {
  const fixture = await createConflictCandidateFixture("upload-candidate-select");
  const { runtime, manager, scheduler, job } = fixture;
  try {
    const parked = scheduler.jobStore.findById(job.id);
    assert.equal(parked?.status, "manual_wait");
    const retained = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(retained?.backupStatus, "verified");
    assert.equal(retained?.remotePath, "/target");
    assert.equal(retained?.remoteFiles?.[0]?.mediaMetadata?.width, 640);
    const issue = scheduler.getRecoveryIssues().find((item: any) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "conflict_candidate_ready");
    assert.deepEqual(issue?.availableActions.map((action: any) => action.id), ["keep_existing", "use_candidate", "recheck", "abandon_attempt"]);

    const result = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "use_candidate");
    assert.equal(result.ok, true);
    assert.equal(scheduler.jobStore.findById(job.id), null);
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
    cleanupLocal: false,
    files: ["video.mp4"],
    conflictCandidateOnly: true,
    conflictCandidateId: "upload-candidate",
    conflictCandidateRemotePath: "/target/_conflicts/upload-candidate",
  }) as any;
  let ordinaryUploadTransitions = 0;
  let candidateTransitions = 0;
  task.onUploading = () => { ordinaryUploadTransitions += 1; };
  task.onConflictCandidateUploading = () => { candidateTransitions += 1; };
  task.uploadConflictCandidate = async () => ({
    remotePath: "/target/_conflicts/upload-candidate",
    files: [{ name: "video.mp4", path: "/target/_conflicts/upload-candidate/video.mp4", size: 12 }],
    allVerified: true,
    disposition: "conflict_candidate",
  });

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

    scheduler.markUploadTaskFailed(task, "candidate upload failed");

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
    assert.equal(scheduler.jobStore.findById(job.id), null);
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
    assert.equal(scheduler.jobStore.findById(job.id), null);
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
  scheduler.remoteFileInspector = async (_config: any, remotePath: string) => {
    if (remotePath.includes("/_conflicts/")) {
      started();
      await releasePromise;
      return { status: "verified", remoteSize: 12 };
    }
    return { status: "verified", remoteSize: 10 };
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
    changed.scheduler.remoteFileInspector = async (_config: any, remotePath: string) => remotePath.includes("/_conflicts/")
      ? { status: "mismatch", remoteSize: 99 }
      : { status: "verified", remoteSize: 10 };
    const result = await changed.scheduler.resolveRecoveryIssue(`upload.${changed.job.id}`, "use_candidate");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(changed.scheduler.jobStore.findById(changed.job.id)?.status, "manual_wait");
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
    manager.setUploadCooldown({ state: "open", reason: "backend unavailable", category: "auth", openedAt: Date.now(), retryAt: Date.now() + 60_000, consecutiveFailures: 1 });
    manager.close();
    manager = new StateManager({ statePath, dbPath });
    const config = testConfig();
    const scheduler = new SyncScheduler({ get: () => config } as any, { list: () => [] } as any, manager);
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.state, "open");
    assert.equal(scheduler.getQueueSnapshot().uploadHealth.pausedDownloads, true);
    scheduler.stop();
    manager.close();
  } finally {
    await removeTestDir(runtime);
  }
});
