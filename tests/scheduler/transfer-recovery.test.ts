import { required } from '../contract-values.js';
import { heldQueues } from '../fixtures/held-queues.js';
import { verificationState } from '../fixtures/verification-state.js';
import { parseEncodingRetryContext } from '../../src/scheduler/recovery-context.js';
import { isRecord } from '../../src/shared/api/value.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import type { inspectRemoteFileSize } from '../../src/uploader.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computeUploadVerificationTiming, SyncScheduler } from '../../src/scheduler.js';
import { StateManager } from '../../src/state.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
function record(value: unknown) {
  assert.ok(isRecord(value), 'Expected structured recovery evidence');
  return value;
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
  const jobs = new PersistentJobStore(manager.getDatabase(), {normalizeRecovery: false});
  const sessions = new TransferSessionStore(manager.getDatabase());
  const queues = heldQueues();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() },
    { list: () => [], getById: () => null, updatePartial: () => { throw new Error('Unexpected user update'); } },
    manager, {createQueue: queues.create},
  );
  try {
    assert.equal(scheduler.hasPersistentTransferWork(), false);
    jobs.enqueue({
      kind: "upload" as const,
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
  const remote: { inspect: typeof inspectRemoteFileSize } = { inspect: async () => remoteResult };
  const jobs = new PersistentJobStore(manager.getDatabase(), {normalizeRecovery: false});
  const sessions = new TransferSessionStore(manager.getDatabase());
  const queues = heldQueues();
  const scheduler = new SyncScheduler(
    { get: () => testConfig() },
    { list: () => [user], getById: (id: string) => id === user.id ? user : null, updatePartial: () => { throw new Error('Unexpected user update'); } },
    manager,
    { createQueue: queues.create, remoteFileInspector: (...args) => remote.inspect(...args), legacyTempDir: path.join(runtime, "temp"), now: options.now },
  );



  const session = sessions.ensure({
    dedupeKey: "upload:u1:1:BVVERIFY:/target:main",
    bvid: "BVVERIFY",
    userId: "u1",
    mediaId: 1,
    localDir,
    remotePath: "/target",
  });
  sessions.ensureFile(session.id, { relativePath: "video.mp4", name: "video.mp4", expectedSize: 12 }, session.generation);
  sessions.updateFile(session.id, "video.mp4", {
    status: "awaiting_remote" as const,
    putAcceptedAt: Date.now() - 11 * 60_000,
    attempts: options.attempts || 0,
  }, session.generation);
  sessions.updateSession(session.id, { phase: "failed" as const, lastError: "visibility timeout" }, session.generation);
  const job = jobs.enqueue({
    kind: "upload" as const,
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
        "video.mp4": { cid: 100, pageIndex: 1, mediaMetadata: { width: 1920, height: 1080, source: "ffprobe" as const, observedAt: new Date().toISOString() } },
      },
    },
  });
  return { runtime, localDir, manager, scheduler, remote, session, job, jobs, sessions };
}

test("recovery automation finalizes a remotely visible file without reading the missing local body", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-verified", { status: "verified" as const, remoteSize: 12 }, { local: "missing" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.equal(jobs.findById(job.id), null);
    assert.equal(sessions.get(session.id)?.phase, "completed");
    const relation = manager.getRelationStatus("u1", 1, "BVVERIFY");
    assert.equal(relation?.backupStatus, "verified");
    assert.equal(relation?.remoteFiles?.[0]?.path, "/target/video.mp4");
    assert.equal(relation?.remoteFiles?.[0]?.mediaMetadata?.width, 1920);
    assert.equal(jobs.findByDedupeKey("download:BVVERIFY"), null);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});
test("fully verified orphan generations resume confirmation instead of reopening upload or requiring manual action", async () => {
  const fixture = await createStructuredRecoveryFixture("verified-orphan-generation", { status: "verified" as const, remoteSize: 12 }, { local: "missing" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    jobs.complete(job.id);
    sessions.updateFile(session.id, "video.mp4", { status: "verified" as const, verifiedAt: Date.now() }, session.generation);
    for (let index = 0; index < 2; index++) scheduler.refreshRecoveryProjection(true);
    const projected = jobs.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`);
    assert.ok(projected);
    assert.notEqual(projected.status, "manual_wait");
    assert.equal(projected.payload.resumeOnly, true);
    assert.equal(projected.payload.lifecycleState, "remote_visibility_wait");
    assert.equal(sessions.get(session.id)?.generation, session.generation);
    assert.equal(sessions.listFiles(session.id, session.generation).length, 1);
  } finally {
    scheduler.stop(); manager.close(); await removeTestDir(runtime);
  }
});

test("empty current generations remain recoverable without borrowing previous page success", async () => {
  for (const remoteStatus of ["verified", "unknown"] as const) {
    const fixture = await createStructuredRecoveryFixture(`empty-generation-${remoteStatus}`, { status: remoteStatus }, { local: "missing" });
    const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
    try {
      jobs.complete(job.id);
      sessions.updateFile(session.id, "video.mp4", { status: "verified" as const, verifiedAt: Date.now() }, 1);
      manager.markVerifiedUpload("BVVERIFY", "/target", [{ name: "video.mp4", path: "/target/video.mp4", localRelativePath: "video.mp4", size: 12, verificationStatus: "verified" as const, putCompletedAt: new Date().toISOString() }], "u1", 1, false);
      manager.getDatabase().db.prepare("UPDATE transfer_sessions SET generation=2, phase='uploading' WHERE id=?").run(session.id);
      scheduler.refreshRecoveryProjection(true);
      const projected = jobs.findByDedupeKey(`upload-session:${session.id}:g2`);
      assert.ok(projected);
      assert.equal(projected.payload.emptyAttempt, true);
      await scheduler.resolveRecoveryIssue(`upload.${projected.id}`, "recheck");
      assert.equal(sessions.get(session.id)?.phase, remoteStatus === "verified" ? "superseded" : "uploading");
      assert.equal(sessions.listFiles(session.id, 2).length, 0);
      assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
      if (remoteStatus === "unknown") assert.ok(jobs.findById(projected.id));
    } finally {
      scheduler.stop(); manager.close(); await removeTestDir(runtime);
    }
  }
});

test("same-size recovery without a PUT proof becomes an isolated candidate and never writes new media metadata", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-unknown-same-size", { status: "verified" as const, remoteSize: 12 });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    sessions.updateFile(session.id, "video.mp4", {
      status: "awaiting_remote" as const,
      putAcceptedAt: null,
      verifiedAt: null,
    }, session.generation);
    await scheduler.runRecoveryAutomationNow();
    const current = jobs.findById(job.id);
    assert.equal(current?.payload?.conflictCandidateOnly, true);
    assert.equal(current?.payload?.lifecycleState, "conflict_candidate");
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
  const fixture = await createStructuredRecoveryFixture("recovery-abandon-attempt", { status: "missing" as const, parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    const first = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "abandon_attempt", {});
    assert.equal(first.ok, true);
    const abandoned = jobs.findById(job.id);
    assert.equal(abandoned?.status, "failed");
    assert.equal(abandoned?.payload?.awaitingManualRecovery, false);
    assert.equal(abandoned?.payload?.lifecycleState, "abandoned");
    assert.equal(abandoned?.payload?.userDisposition, "abandoned");
    jobs.normalizeTerminalUploadRecovery();
    assert.equal(required(jobs.findById(job.id)?.payload).awaitingManualRecovery, false);
    assert.equal(sessions.get(session.id)?.phase, "superseded");
    assert.equal(scheduler.getRecoveryIssues().some((item) => item.id === `upload.${job.id}`), false);

    const second = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "abandon_attempt", {});
    assert.equal(second.ok, true);
    assert.equal(('idempotent' in second ? second.idempotent : false), true);
    scheduler.refreshRecoveryProjection(true);
    assert.equal(jobs.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`)?.id, undefined);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("transfer-session recovery projection reaches orphan sessions beyond the first thousand active rows", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-projection-pagination", { status: "missing" as const, parentStatus: "visible" });
  const { runtime, manager, scheduler, session: seedSession, job: seedJob, jobs, sessions } = fixture;
  try {
    jobs.complete(seedJob.id);
    sessions.supersede(seedSession.id, seedSession.generation);
    const orphanIndex = 1_001;
    let orphanSessionId = "";
    for (let index = 0; index <= orphanIndex; index += 1) {
      const bvid = `BVPAGE${String(index).padStart(4, "0")}`;
      const transfer = sessions.ensure({
        dedupeKey: `upload-page:${index}`,
        bvid,
        userId: "u1",
        mediaId: 1,
        localDir: path.join(runtime, "temp", bvid),
        remotePath: `/page/${index}`,
      });
      sessions.ensureFile(transfer.id, {
        relativePath: "video.mp4",
        name: "video.mp4",
        expectedSize: 12,
      }, transfer.generation);
      sessions.updateSession(transfer.id, {
        phase: "failed" as const,
        lastError: "orphaned upload session",
      }, transfer.generation);
      if (index < orphanIndex) {
        jobs.enqueue({
          kind: "upload" as const,
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
    scheduler.refreshRecoveryProjection(true);
    const projected = jobs.findByDedupeKey(`upload-session:${orphanSessionId}:g1`);
    assert.ok(projected);
    assert.equal(projected?.payload?.recoveryProjection, true);
    assert.equal(projected?.payload?.awaitingManualRecovery, true);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("projected multipart sessions expose partial-upload lifecycle without touching local files", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-partial-lifecycle", { status: "missing" as const, parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    jobs.complete(job.id);
    sessions.ensureFile(session.id, {
      relativePath: "video-2.mp4",
      name: "video-2.mp4",
      expectedSize: 24,
    }, session.generation);
    sessions.updateFile(session.id, "video.mp4", { status: "verified" as const, verifiedAt: Date.now() }, session.generation);
    sessions.updateFile(session.id, "video-2.mp4", { status: "pending" as const }, session.generation);
    sessions.updateSession(session.id, { phase: "awaiting_remote" as const }, session.generation);
    scheduler.refreshRecoveryProjection(true);
    const projected = jobs.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`);
    assert.ok(projected);
    assert.equal(projected?.payload?.lifecycleState, "partial_upload");
    assert.equal(projected?.payload?.verifiedPages, 1);
    assert.equal(projected?.payload?.totalPages, 2);
    assert.equal(record(projected?.payload.recoveryAssessment).localStatus, "unknown");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a failed transfer session without a job is projected once into recovery", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-session-projection", { status: "missing" as const, parentStatus: "visible" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    jobs.complete(job.id);
    sessions.updateSession(session.id, { phase: "failed" as const, lastError: "WebDAV 405 write result was not confirmed" }, session.generation);

    scheduler.refreshRecoveryProjection(true);
    const first = scheduler.getRecoveryIssueSnapshot().issues.filter((item) => item.bvid === "BVVERIFY");
    assert.equal(first.length, 1);
    const projected = jobs.findByDedupeKey(`upload-session:${session.id}:g${session.generation}`);
    assert.ok(projected);
    assert.equal(projected?.status, "manual_wait");
    assert.equal(projected?.payload?.lifecycleState, "manual_required");
    assert.equal(projected?.payload?.totalPages, 1);
    assert.equal(first[0]?.kind, "remote_write_rejected");

    const second = scheduler.getRecoveryIssueSnapshot().issues.filter((item) => item.bvid === "BVVERIFY");
    assert.equal(second.length, 1);
    assert.equal(jobs.list(["upload"]).filter((candidate) => candidate.bvid === "BVVERIFY").length, 1);

    manager.getDatabase().db.prepare("UPDATE jobs SET status='completed', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(projected!.id);
    scheduler.refreshRecoveryProjection(true);
    assert.equal(jobs.findById(projected!.id)?.status, "manual_wait");

    const nonManualTerminalPayload = { ...(jobs.findById(projected!.id)?.payload), awaitingManualRecovery: false };
    manager.getDatabase().db.prepare("UPDATE jobs SET status='failed', payload_json=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?")
      .run(JSON.stringify(nonManualTerminalPayload), projected!.id);
    scheduler.refreshRecoveryProjection(true);
    assert.equal(jobs.findById(projected!.id)?.status, "manual_wait");
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
    { status: "missing" as const, parentStatus: "visible" },
    { now: () => clock },
  );
  const { runtime, manager, scheduler, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    let assessment = record(required(jobs.findById(job.id)?.payload).recoveryAssessment);
    assert.equal(assessment.kind, "remote_visibility_timeout");
    assert.equal(assessment.consecutiveObservations, 1);

    clock = start + 6 * 60_000;
    await scheduler.runRecoveryAutomationNow();
    assessment = record(required(jobs.findById(job.id)?.payload).recoveryAssessment);
    assert.equal(assessment.kind, "remote_visibility_timeout");
    assert.equal(assessment.consecutiveObservations, 2);

    clock = start + 31 * 60_000;
    await scheduler.runRecoveryAutomationNow();
    const current = jobs.findById(job.id)!;
    assert.equal((current.payload).conflictCandidateOnly, true, JSON.stringify(current));
    assert.equal((current.payload).lifecycleState, "conflict_candidate");
    assert.equal((current.payload).userDisposition, "automatic_candidate");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation queues one fresh download when both local and remote files are missing", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-redownload", { status: "missing" as const }, { local: "missing" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.equal(jobs.findById(job.id), null);
    assert.equal(sessions.get(session.id)?.phase, "superseded");
    const download = jobs.findByDedupeKey("download:BVVERIFY");
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
    { status: "missing" as const, parentStatus: "visible" },
    { local: "available", attempts: 3 },
  );
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const current = jobs.findById(job.id);
    assert.equal(current?.status, "manual_wait");
    assert.equal(sessions.get(session.id)?.phase, "failed");
    const issue = scheduler.getQueueSnapshot().issues.find((item) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "remote_write_rejected");
    assert.equal(issue?.severity, "warning");
    assert.deepEqual(issue?.availableActions.map((action) => action.id), [
      "redownload_with_encoding",
      "open_settings",
      "recheck",
      "abandon_attempt",
    ]);
    const boardItem = scheduler.getQueueSnapshot().uploadPending.find((item) => item.persistentJobId === job.id);
    assert.equal(boardItem?.phase, "manual_action");
    assert.equal(boardItem?.actionRequired, true);
    assert.deepEqual(boardItem?.recoveryActions?.map((action) => action.id), ["redownload_with_encoding"]);
    assert.match(issue?.summary || "", /可以尝试一次换编码/);
    assert.doesNotMatch(issue?.summary || "", /超过存储限制/);
    assert.doesNotMatch(issue?.safeDiagnostic || "", /\/target/);

    const retry = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "redownload_with_encoding", {
      encodingPriority: ["AV1", "HEVC", "AVC"],
      strict: true,
    });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.ok(retry.childJobId);
    assert.equal(record(required(jobs.findById(job.id)?.payload).encodingRetry).strict, true);
    assert.equal(jobs.list(["download"]).filter((candidate) => parseEncodingRetryContext(candidate.payload.encodingRetry)?.parentJobId === job.id).length, 1);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("one missing target with a visible parent remains a background visibility check", async () => {
  const fixture = await createStructuredRecoveryFixture(
    "recovery-visible-parent-single-attempt",
    { status: "missing" as const, parentStatus: "visible" },
    { local: "available", attempts: 1 },
  );
  const { runtime, manager, scheduler, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const issue = scheduler.getRecoveryIssues().find((item) => item.id === `upload.${job.id}`);
    assert.ok(issue, JSON.stringify({ job: jobs.findById(job.id), issues: scheduler.getRecoveryIssues() }));
    assert.equal(issue?.kind, "remote_visibility_timeout");
    assert.deepEqual(issue?.availableActions.map((action) => action.id), ["recheck"]);
    assert.equal(issue?.disposition, "background");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual recheck stays read-only when both local and remote files are missing", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-manual-recheck-readonly", { status: "missing" as const }, { local: "missing" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    const result = await scheduler.resolveRecoveryIssue(`upload.${job.id}`, "recheck");
    assert.equal(result.ok, true);
    assert.ok(jobs.findById(job.id));
    assert.equal(sessions.get(session.id)?.phase, "failed");
    assert.equal(jobs.findByDedupeKey("download:BVVERIFY"), null);
    const issue = scheduler.getRecoveryIssues().find((item) => item.id === `upload.${job.id}`);
    assert.equal(issue?.kind, "local_file_missing");
    assert.equal(issue?.recommendedAction?.id, "redownload");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual redownload shares an in-flight automatic recheck before deciding", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-shared-recheck", { status: "missing" as const }, { local: "missing" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  let releaseRemoteCheck!: () => void;
  let signalRemoteCheckStarted!: () => void;
  const remoteCheckStarted = new Promise<void>((resolve) => { signalRemoteCheckStarted = resolve; });
  let inspections = 0;
  fixture.remote.inspect = async () => {
    inspections += 1;
    signalRemoteCheckStarted();
    await new Promise<void>((resolve) => { releaseRemoteCheck = resolve; });
    return { status: "verified" as const, remoteSize: 12 };
  };
  jobs.updatePayload(job.id, {
    ...job.payload,
    recoveryAssessment: {
      kind: "remote_visibility_timeout" as const,
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
    assert.equal(jobs.findById(job.id), null);
    assert.equal(sessions.get(session.id)?.phase, "completed");
    assert.equal(jobs.findByDedupeKey("download:BVVERIFY"), null);
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation selects due work beyond a thousand deferred issues", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-due-selection", { status: "verified" as const, remoteSize: 12 });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    manager.getDatabase().db.prepare("UPDATE jobs SET priority=100 WHERE id=?").run(job.id);
    const future = Date.now() + 60 * 60_000;
    for (let index = 0; index < 1_000; index += 1) {
      jobs.enqueue({
        kind: "upload" as const,
        dedupeKey: `upload:deferred:${index}`,
        bvid: `BVDEFERRED${index}`,
        priority: 1,
        initialStatus: "manual_wait",
        payload: {
          awaitingManualRecovery: true,
          recoveryAssessment: {
            kind: "remote_connection" as const,
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
    assert.equal(jobs.findById(job.id), null);
    assert.equal(sessions.get(session.id)?.phase, "completed");
    assert.equal(manager.getRelationStatus("u1", 1, "BVVERIFY")?.backupStatus, "verified");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("recovery automation stops after the automatic redownload limit and reports the stale local file", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-auto-loop-guard", { status: "missing" as const }, {
    local: "missing",
    automaticRecoveryAttempts: 3,
  });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.ok(jobs.findById(job.id));
    assert.equal(sessions.get(session.id)?.phase, "failed");
    assert.equal(jobs.findByDedupeKey("download:BVVERIFY"), null);
    const issue = scheduler.getRecoveryIssues().find((item) => item.id === `upload.${job.id}`);
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
  const fixture = await createStructuredRecoveryFixture("recovery-remote-conflict", { status: "mismatch" as const, remoteSize: 99 }, { local: "available" });
  const { runtime, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    assert.ok(jobs.findById(job.id));
    assert.equal(sessions.get(session.id)?.phase, "failed");
    assert.equal(jobs.findByDedupeKey("download:BVVERIFY"), null);
    const current = jobs.findById(job.id)!;
    assert.equal((current.payload).conflictCandidateOnly, true, JSON.stringify(current));
    assert.equal((current.payload).remotePath, "/target");
    assert.match(String((current.payload).conflictCandidateRemotePath), /\/_conflicts\/upload-/);
    assert.equal(scheduler.getRecoveryIssueSnapshot().issues.some((item) => item.id === `upload.${job.id}`), false);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("a size conflict candidate is idempotently projected as one full-group upload", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-create-candidate", { status: "mismatch" as const, remoteSize: 99 });
  const { runtime, manager, scheduler, job, jobs, sessions } = fixture;
  try {
    await scheduler.runRecoveryAutomationNow();
    const updated = jobs.findById(job.id)!;
    assert.equal((updated.payload).conflictCandidateOnly, true, JSON.stringify(updated.payload));
    assert.equal((updated.payload).awaitingManualRecovery, false);
    assert.match(String((updated.payload).conflictCandidateRemotePath), /\/_conflicts\/upload-/);
    assert.equal((updated.payload).remotePath, "/target");
    assert.deepEqual((updated.payload).files, ["video.mp4"]);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("multipart mixed remote state creates one candidate containing every part", async () => {
  const fixture = await createStructuredRecoveryFixture("recovery-multipart-candidate", { status: "missing" as const, parentStatus: "visible" });
  const { runtime, localDir, manager, scheduler, session, job, jobs, sessions } = fixture;
  try {
    await fs.promises.writeFile(path.join(localDir, "video-p2.mp4"), Buffer.alloc(7, 2));
    sessions.ensureFile(session.id, {
      relativePath: "video-p2.mp4",
      name: "video-p2.mp4",
      expectedSize: 7,
    }, session.generation);
    sessions.updateFile(session.id, "video-p2.mp4", {
      status: "awaiting_remote" as const,
      putAcceptedAt: Date.now() - 11 * 60_000,
    }, session.generation);
    jobs.updatePayload(job.id, {
      ...job.payload,
      files: ["video.mp4", "video-p2.mp4"],
      filenameMetadataByPath: {
        ...record(job.payload.filenameMetadataByPath),
        "video-p2.mp4": { cid: 101, pageIndex: 2 },
      },
    });
    fixture.remote.inspect = async (_config: unknown, remotePath: string) => remotePath.endsWith("video.mp4")
      ? { status: "verified" as const, remoteSize: 12 }
      : { status: "missing" as const, parentStatus: "visible" };

    await scheduler.runRecoveryAutomationNow();
    const updated = jobs.findById(job.id)!;
    assert.equal((updated.payload).conflictCandidateOnly, true);
    assert.deepEqual((updated.payload).files, ["video.mp4", "video-p2.mp4"]);
    assert.equal((updated.payload).remotePath, "/target");
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("unknown WebDAV failures offer candidates only when the failure is path-specific and writable-looking", async () => {
  const supportedFallback = await createStructuredRecoveryFixture("recovery-unsupported-candidate", {
    status: "unknown" as const,
    parentStatus: "visible",
    failure: { category: "unsupported", status: 405 },
  });
  try {
    await supportedFallback.scheduler.runRecoveryAutomationNow();
    const issue = supportedFallback.scheduler.getRecoveryIssues().find((item) => item.id === `upload.${supportedFallback.job.id}`);
    assert.equal(issue?.kind, "remote_unsupported");
    assert.deepEqual(issue?.availableActions.map((action) => action.id), ["create_candidate", "recheck", "open_settings", "abandon_attempt"]);
  } finally {
    supportedFallback.scheduler.stop();
    supportedFallback.manager.close();
    await removeTestDir(supportedFallback.runtime);
  }

  const permissionFailure = await createStructuredRecoveryFixture("recovery-permission-no-candidate", {
    status: "unknown" as const,
    parentStatus: "visible",
    failure: { category: "permission", status: 403 },
  });
  try {
    await permissionFailure.scheduler.runRecoveryAutomationNow();
    const issue = permissionFailure.scheduler.getRecoveryIssues().find((item) => item.id === `upload.${permissionFailure.job.id}`);
    assert.equal(issue?.kind, "remote_permission");
    assert.equal(record(required(permissionFailure.jobs.findById(permissionFailure.job.id)?.payload).recoveryAssessment).candidateEligible, false);
    assert.deepEqual(issue?.availableActions.map((action) => action.id), ["open_settings", "recheck", "abandon_attempt"]);
  } finally {
    permissionFailure.scheduler.stop();
    permissionFailure.manager.close();
    await removeTestDir(permissionFailure.runtime);
  }
});
