import { required } from './contract-values.js';
import { recoveryFixture } from './fixtures/recovery.js';
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { classifyDownloadRecoveryFailure } from "../src/download-recovery.js";
import type { VideoAccessClassification } from "../src/bili.js";
import { PersistentJobStore } from "../src/job-store.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("download recovery classifier separates unavailable, account, tool and transient failures", () => {
  assert.equal(classifyDownloadRecoveryFailure({ code: "BILI_VIDEO_UNAVAILABLE", message: "gone" }).category, "source_unavailable");
  assert.equal(classifyDownloadRecoveryFailure({ statusCode: 401, message: "denied" }).kind, "download_account_required");
  assert.equal(classifyDownloadRecoveryFailure({ code: "ENOENT", message: "spawn BBDown ENOENT" }).kind, "download_tool_failure");
  assert.equal(classifyDownloadRecoveryFailure({ code: "ETIMEDOUT", message: "timeout" }).kind, "download_retry_exhausted");
});

test("exhausted persistent downloads are parked instead of deleted", async () => {
  const runtime = await createTestDir("download-manual-fallback");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  try {
    const store = new PersistentJobStore(manager.getDatabase());
    const job = store.enqueue({ kind: "download" as const, dedupeKey: "download:BVPARK", bvid: "BVPARK", maxAttempts: 1 });
    const [leased] = store.claimDue(["download"], 1, "test-owner", 60_000, Date.now());
    assert.equal(leased.id, job.id);
    const result = store.retryDownloadWithManualFallback(job.id, "test-owner", "timeout", Date.now(), {
      downloadRecovery: { category: "transient", kind: "download_retry_exhausted" as const },
    });
    assert.equal(result.exhausted, true);
    const parked = store.findById(job.id)!;
    assert.equal(parked.status, "manual_wait");
    assert.equal((parked.payload).awaitingManualRecovery, true);
    assert.equal(store.listManualRecovery(["download"]).length, 1);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("manual download recovery can preflight an alternate account and preserve targets", async () => {
  const runtime = await createTestDir("download-account-recovery");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  const now = new Date().toISOString();
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: {
      BVACCOUNT: { bvid: "BVACCOUNT", title: "Account test", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available" as const, backupStatus: "verified" as const },
      BVDEFER: { bvid: "BVDEFER", title: "Deferred", upperName: "Tester", firstSeenAt: now, lastSeenAt: now, biliStatus: "available" as const, backupStatus: "failed" as const },
    },
    relations: {
      "u1:1:BVACCOUNT": { userId: "u1", mediaId: 1, bvid: "BVACCOUNT", folderTitle: "Fav", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "failed" as const, lastError: "auth" },
      "u2:2:BVACCOUNT": {
        userId: "u2", mediaId: 2, bvid: "BVACCOUNT", folderTitle: "Archived", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "verified" as const, remotePath: "/archive",
        remoteFiles: [{ name: "video.mp4", path: "/archive/video.mp4", size: 12, verificationStatus: "verified" as const }],
      },
      "u1:3:BVDEFER": { userId: "u1", mediaId: 3, bvid: "BVDEFER", folderTitle: "Deferred", firstSeenAt: now, lastSeenAt: now, activeInFavorite: true, backupStatus: "failed" as const, lastError: "timeout" },
    },
  });
  const users = [
    { id: "u1", uid: 1, name: "Primary", cookie: { SESSDATA: "a", bili_jct: "a", DedeUserID: "1" }, favorites: [{ mediaId: 1, title: "Fav" }], enabled: true, lastLoginAt: now },
    { id: "u2", uid: 2, name: "Backup", cookie: { SESSDATA: "b", bili_jct: "b", DedeUserID: "2" }, favorites: [], enabled: true, lastLoginAt: now },
  ];
  let probedUid = "";
  let probeAvailable = false;
  const { service: scheduler, jobs } = recoveryFixture(manager, users, async (cookie, _bvid) => {
    probedUid = String(cookie.DedeUserID || '');
    return {
      available: probeAvailable,
      pages: probeAvailable ? [{index: 1, cid: 1, title: 'P1', duration: 1}] : [],
      access: {classification: (probeAvailable ? 'normal' : 'unavailable') as VideoAccessClassification, source: 'view' as const},
    };
  });
  try {
    const job = jobs.enqueue({
      kind: "download" as const,
      dedupeKey: "download:BVACCOUNT",
      bvid: "BVACCOUNT",
      initialStatus: "manual_wait",
      payload: {
        primaryUserId: "u1",
        primaryMediaId: 1,
        primaryFolderTitle: "Fav",
        downloadUserId: "u1",
        awaitingManualRecovery: true,
        downloadRecovery: { category: "account", kind: "download_account_required" as const, summary: "account failed" },
      },
    });
    const issue = scheduler.getRecoveryIssues().find((item) => item.id === `download.${job.id}`);
    assert.ok(issue);
    assert.deepEqual(issue.availableActions.map((action) => action.id), ["retry_download_with_account", "retry_download", "defer_download", "abandon_attempt"]);
    assert.equal(required(issue.availableActions[0].choices?.[0]).value, "u2");

    const rejected = await scheduler.resolveRecoveryIssue(`download.${job.id}`, "retry_download_with_account", { userId: "u2" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 409);
    const unchanged = jobs.findById(job.id)!;
    assert.equal(unchanged.status, "manual_wait");
    assert.equal((unchanged.payload).downloadUserId, "u1");
    assert.equal((unchanged.payload).awaitingManualRecovery, true);

    probeAvailable = true;
    const result = await scheduler.resolveRecoveryIssue(`download.${job.id}`, "retry_download_with_account", { userId: "u2" });
    assert.equal(result.ok, true);
    assert.equal(probedUid, "2");
    const resumed = jobs.findById(job.id)!;
    assert.ok(["pending", "leased"].includes(resumed.status));
    assert.equal((resumed.payload).downloadUserId, "u2");
    assert.equal((resumed.payload).awaitingManualRecovery, false);
    assert.equal(manager.getRelationStatus("u1", 1, "BVACCOUNT")?.backupStatus, "discovered");
    assert.equal(manager.getRelationStatus("u2", 2, "BVACCOUNT")?.backupStatus, "verified");
    assert.equal(manager.getRelationStatus("u2", 2, "BVACCOUNT")?.remotePath, "/archive");

    const deferredJob = jobs.enqueue({
      kind: "download" as const,
      dedupeKey: "download:BVDEFER",
      bvid: "BVDEFER",
      initialStatus: "manual_wait",
      payload: {
        primaryUserId: "u1",
        primaryMediaId: 3,
        downloadUserId: "u1",
        awaitingManualRecovery: true,
        downloadRecovery: {
          category: "transient",
          kind: "download_retry_exhausted" as const,
          summary: "timeout",
          targets: [{ userId: "u1", mediaId: 3, folderTitle: "Deferred", remotePath: "/deferred" }],
        },
      },
    });
    const beforeDefer = Date.now();
    const deferred = await scheduler.resolveRecoveryIssue(`download.${deferredJob.id}`, "defer_download", {});
    assert.equal(deferred.ok, true);
    const scheduled = jobs.findById(deferredJob.id)!;
    assert.ok(["pending", "retry_wait"].includes(scheduled.status));
    assert.ok(scheduled.notBefore >= beforeDefer + 24 * 60 * 60_000);
    assert.equal((scheduled.payload).awaitingManualRecovery, false);
    assert.equal(manager.getRelationStatus("u1", 3, "BVDEFER")?.backupStatus, "failed");
    assert.equal(manager.getRelationStatus("u1", 3, "BVDEFER")?.lastError, "timeout");
    assert.equal(scheduler.getRecoveryIssues().some((item) => item.id === `download.${deferredJob.id}`), false);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("legacy permanent download failures become manual recovery items without automatic requeue", async () => {
  const runtime = await createTestDir("legacy-download-recovery");
  const manager = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "state.sqlite") });
  const now = new Date().toISOString();
  manager.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
    videos: {
      BVLEGACY: {
        bvid: "BVLEGACY", title: "Legacy self-visible video", upperName: "Owner", firstSeenAt: now, lastSeenAt: now,
        biliStatus: "unavailable" as const, backupStatus: "failed" as const,
      },
    },
    relations: {
      "u1:7:BVLEGACY": {
        userId: "u1", mediaId: 7, bvid: "BVLEGACY", folderTitle: "My favorites", firstSeenAt: now, lastSeenAt: now,
        activeInFavorite: true, backupStatus: "failed" as const, favoriteUnavailable: true, selfVisible: true,
      },
    },
  });
  manager.markFailed("u1", "BVLEGACY", 7, "Arg_IndexOutOfRangeException from old BBDown", true);
  const user = {
    id: "u1", uid: 1, name: "Owner", cookie: { SESSDATA: "a", bili_jct: "a", DedeUserID: "1" },
    favorites: [{ mediaId: 7, title: "My favorites" }], enabled: true, lastLoginAt: now,
  };
  const { service: scheduler, jobs } = recoveryFixture(manager, [user]);
  try {
    scheduler.reconcileLegacyDownloadRecoveryJobs();
    const issue = scheduler.getRecoveryIssues().find((item) => item.bvid === "BVLEGACY");
    assert.ok(issue);
    assert.equal(issue.kind, "download_retry_exhausted");
    assert.ok(issue.summary.includes("旧版下载失败记录"));
    assert.match(issue.id, /^download\./);
    assert.equal(jobs.findByDedupeKey("download:BVLEGACY"), null);

    const retried = await scheduler.resolveRecoveryIssue(issue.id, "retry_download", {});
    assert.equal(retried.ok, true);
    assert.equal(manager.getDatabase().getFailure("u1", "BVLEGACY", 7), undefined);
    assert.equal(manager.getRelationStatus("u1", 7, "BVLEGACY")?.backupStatus, "queued");
    const job = jobs.findByDedupeKey("download:BVLEGACY");
    assert.ok(job);
    assert.equal((job!.payload).primaryUserId, "u1");
    assert.equal(scheduler.getRecoveryIssues().some((item) => item.id === issue.id), false);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});
