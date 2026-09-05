import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  DATABASE_SCHEMA_VERSION,
  LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER,
  LEGACY_TEMP_CACHE_MARKER,
  StateDatabase,
  UNAVAILABLE_COVER_BACKFILL_MARKER,
} from "../src/database.js";
import { PersistentJobStore } from "../src/job-store.js";
import { TransferSessionStore } from "../src/transfer-session.js";
import { createTestDir, removeTestDir } from "./helpers.js";

test("completed upload jobs retain cleanup authorization without blocking a new attempt", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const job = jobs.enqueue({ kind: "upload", bvid: "BVCLEANUP", dedupeKey: "upload:cleanup-test",
      payload: { localCleanupPlans: [{ id: "authorized-plan", files: [{ relativePath: "video.mp4", expectedSize: 10 }] }] } });
    assert.equal(jobs.complete(job.id), true);
    assert.equal(jobs.findById(job.id)?.status, "completed");
    assert.equal(jobs.findById(job.id)?.payload.localCleanupPlans.length, 1);
    assert.equal(jobs.list(["upload"]).length, 0);
    assert.equal(jobs.hasActiveJobsForBvid("BVCLEANUP"), false);
    assert.equal(jobs.normalizeTerminalUploadRecovery(), 0);
    const next = jobs.enqueue({ kind: "upload", bvid: "BVCLEANUP", dedupeKey: "upload:cleanup-test" });
    assert.notEqual(next.id, job.id);
    assert.equal(next.status, "pending");
    assert.equal(jobs.complete(job.id), true);
    assert.ok(jobs.findById(job.id)?.payload.localCleanupPlans);
  } finally { database.close(); }
});

test("encoding retry counts only replacement children and keeps duplicate starts idempotent", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  const retry = {
    parentJobId: "upload-parent",
    generation: 1,
    priority: ["AV1", "HEVC", "AVC"],
    strict: true,
    candidateLocalDir: "C:/temp/BVENC-encoding-retry",
    originalLocalDir: "C:/temp/BVENC",
    state: "running",
  };
  try {
    const parent = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload-parent",
      bvid: "BVENC",
      userId: "u1",
      mediaId: 1,
      status: undefined,
      payload: { awaitingManualRecovery: true, encodingRetry: retry },
    } as any);
    retry.parentJobId = parent.id;
    const childInput: any = {
      kind: "verify_upload",
      dedupeKey: "encoding-retry-verify",
      bvid: "BVENC",
      userId: "u1",
      mediaId: 1,
      payload: { encodingRetry: retry },
    };
    const child = jobs.enqueue(childInput);
    jobs.updatePayload(parent.id, {
      ...parent.payload,
      encodingRetry: { ...retry, replacementJobId: child.id },
    });
    assert.equal(jobs.countEncodingRetryJobs(parent.id, 1), 1);

    const duplicate = jobs.startEncodingRetry(parent.id, childInput, retry);
    assert.equal(duplicate?.idempotent, true);
    assert.equal(duplicate?.child.id, child.id);
    assert.equal(jobs.countEncodingRetryJobs(parent.id, 1), 1);

    jobs.complete(child.id);
    assert.equal(jobs.countEncodingRetryJobs(parent.id, 1), 0);
    assert.equal(jobs.finishEncodingRetry(parent.id, 1), true);
    assert.equal(jobs.completeEncodingRetryParent(parent.id, 1), false);
    assert.ok(jobs.findById(parent.id));
    const failedPayload = jobs.findById(parent.id)!.payload as any;
    assert.equal(jobs.updatePayload(parent.id, {
      ...failedPayload,
      awaitingManualRecovery: false,
      lifecycleState: "retrying",
      encodingRetry: { ...failedPayload.encodingRetry, state: "running" },
    }), true);
    assert.equal(jobs.completeEncodingRetryParent(parent.id, 1), true);
    assert.equal(jobs.findById(parent.id), null);
  } finally {
    database.close();
  }
});

test("encoding retry hides its parent while running and restores it on failure", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const parent = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload-parent-lifecycle",
      bvid: "BVLIFECYCLE",
      userId: "u1",
      mediaId: 1,
      initialStatus: "manual_wait",
      payload: {
        awaitingManualRecovery: true,
        lifecycleState: "manual_required",
        encodingRetry: {
          parentJobId: "placeholder",
          generation: 1,
          priority: ["AV1", "HEVC", "AVC"],
          strict: true,
          state: "failed",
        },
      },
    } as any);
    const retry = {
      parentJobId: parent.id,
      generation: 2,
      priority: ["AV1", "HEVC", "AVC"],
      strict: true,
      state: "running",
    };
    const started = jobs.startEncodingRetry(parent.id, {
      kind: "download",
      dedupeKey: "encoding-retry-download-lifecycle",
      bvid: "BVLIFECYCLE",
      userId: "u1",
      mediaId: 1,
      payload: { encodingRetry: retry },
    } as any, retry);
    assert.equal(started?.idempotent, false);
    const running = jobs.findById(parent.id)!;
    assert.equal((running.payload as any).awaitingManualRecovery, false);
    assert.equal((running.payload as any).lifecycleState, "retrying");
    assert.equal(jobs.listManualRecovery(["upload"]).length, 0);

    assert.equal(jobs.finishEncodingRetry(parent.id, 2, { manualRecoveryReason: "候选失败" }), true);
    const failed = jobs.findById(parent.id)!;
    assert.equal((failed.payload as any).awaitingManualRecovery, true);
    assert.equal((failed.payload as any).lifecycleState, "manual_required");
    assert.equal((failed.payload as any).encodingRetry.state, "failed");
    assert.equal(jobs.listManualRecovery(["upload"]).length, 1);
  } finally {
    database.close();
  }
});

test("archive source restoration skips write transactions when no deletion record exists", () => {
  const database = new StateDatabase(":memory:");
  const sqlite = database.db as any;
  const originalTransaction = sqlite.transaction.bind(sqlite);
  let transactionCalls = 0;
  sqlite.transaction = (action: (...args: any[]) => any) => {
    transactionCalls += 1;
    return originalTransaction(action);
  };
  try {
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(database.restoreCompletedArchiveSource("u1", 1, `BVEMPTY${index}`), 0);
    }
    assert.equal(transactionCalls, 0);

    const now = Date.now();
    database.db.prepare(`
      INSERT INTO videos(bvid,backup_status,bili_status,payload_json,updated_at)
      VALUES('BVRESTORETX','lost','available','{}',?)
    `).run(now);
    database.db.prepare(`
      INSERT INTO archive_deletions(
        id,scope,user_id,media_id,bvid,status,alist_identity_hash,archive_root,created_at,updated_at
      ) VALUES('restore-tx','source','u1',1,'BVRESTORETX','completed','hash','/backup',?,?)
    `).run(now, now);
    database.db.prepare(`
      INSERT INTO archive_deleted_sources(user_id,media_id,bvid,deletion_id,status)
      VALUES('u1',1,'BVRESTORETX','restore-tx','completed')
    `).run();
    assert.equal(database.restoreCompletedArchiveSource("u1", 1, "BVRESTORETX", now + 1), 1);
    assert.equal(transactionCalls, 1);
    assert.equal((database.db.prepare("SELECT status FROM archive_deleted_sources WHERE deletion_id='restore-tx'").get() as any).status, "restored");

    const indexSql = String((database.db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_archive_deletions_active'").get() as any)?.sql || "");
    assert.match(indexSql, /preparing/);
  } finally {
    sqlite.transaction = originalTransaction;
    database.close();
  }
});

test("video status reads use relation priority with the video row as fallback", () => {
  const database = new StateDatabase(":memory:");
  try {
    const baseVideo = (bvid: string, backupStatus: string) => ({
      bvid,
      title: bvid,
      upperName: "Tester",
      firstSeenAt: "2026-07-11T00:00:00.000Z",
      lastSeenAt: "2026-07-11T00:00:00.000Z",
      biliStatus: "available",
      backupStatus,
    });
    database.replaceState({
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      folderScans: {},
      userCooldowns: {},
      videos: {
        BVRELATION: baseVideo("BVRELATION", "verified") as any,
        BVFALLBACK: baseVideo("BVFALLBACK", "failed") as any,
      },
      relations: {
        "u1:1:BVRELATION": {
          userId: "u1",
          mediaId: 1,
          bvid: "BVRELATION",
          folderTitle: "One",
          firstSeenAt: "2026-07-11T00:00:00.000Z",
          lastSeenAt: "2026-07-11T00:00:00.000Z",
          activeInFavorite: true,
          backupStatus: "uploaded",
        },
        "u2:2:BVRELATION": {
          userId: "u2",
          mediaId: 2,
          bvid: "BVRELATION",
          folderTitle: "Two",
          firstSeenAt: "2026-07-11T00:00:00.000Z",
          lastSeenAt: "2026-07-11T00:00:00.000Z",
          activeInFavorite: true,
          backupStatus: "upload_failed",
        },
      },
    });

    assert.equal(database.getVideo("BVRELATION")?.backupStatus, "upload_failed");
    assert.equal(database.getVideo("BVFALLBACK")?.backupStatus, "failed");
    assert.equal(database.listVideos().find((video) => video.bvid === "BVRELATION")?.backupStatus, "upload_failed");
    assert.equal(database.loadState().videos?.BVRELATION.backupStatus, "upload_failed");
  } finally {
    database.close();
  }
});

test("full state replacement clears jobs and state markers while preserving the local cache marker", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    jobs.enqueue({ kind: "download", dedupeKey: "download:stale", bvid: "BVSTALE" });
    database.setMeta("persistent_jobs_bootstrap_v1", "complete");
    database.setMeta("legacy_failure_classification_v1", "complete");
    database.setMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, "complete");
    database.setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
    database.setMeta(UNAVAILABLE_COVER_BACKFILL_MARKER, "complete");
    database.replaceState({
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      folderScans: {},
      userCooldowns: {},
      videos: {},
      relations: {},
    });
    assert.equal(jobs.countOutstanding(["download"]), 0);
    assert.equal(database.getMeta("persistent_jobs_bootstrap_v1"), null);
    assert.equal(database.getMeta("legacy_failure_classification_v1"), null);
    assert.equal(database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");
    assert.equal(database.getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER), null);
  } finally {
    database.close();
  }
});

test("clearing state and jobs resets one-time state markers", () => {
  const database = new StateDatabase(":memory:");
  try {
    database.setMeta("persistent_jobs_bootstrap_v1", "complete");
    database.setMeta("legacy_failure_classification_v1", "complete");
    database.setMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, "complete");
    database.setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
    database.setMeta(UNAVAILABLE_COVER_BACKFILL_MARKER, "complete");
    database.clearStateAndJobs();
    assert.equal(database.getMeta("persistent_jobs_bootstrap_v1"), null);
    assert.equal(database.getMeta("legacy_failure_classification_v1"), null);
    assert.equal(database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), null);
    assert.equal(database.getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER), null);
  } finally {
    database.close();
  }
});

test("SQLite runtime pragmas and persistent job leasing are deterministic", () => {
  const database = new StateDatabase(":memory:");
  try {
    assert.equal(database.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.db.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(String(database.db.pragma("synchronous", { simple: true })), "1");

    const jobs = new PersistentJobStore(database);
    const base = Date.now();
    jobs.enqueue({ kind: "download", dedupeKey: "download:later", bvid: "BVLATER", priority: 50, notBefore: base + 5_000 });
    jobs.enqueue({ kind: "download", dedupeKey: "download:first", bvid: "BVFIRST", priority: 10 });
    jobs.enqueue({ kind: "download", dedupeKey: "download:first", bvid: "BVFIRST", priority: 5 });
    assert.equal(jobs.countOutstanding(["download"]), 2);

    const claimed = jobs.claimDue(["download"], 5, "worker-a", 10_000, base);
    assert.deepEqual(claimed.map((job) => job.bvid), ["BVFIRST"]);
    assert.equal(jobs.markRunning(claimed[0].id, "worker-a", 10_000), true);
    const beforeExtend = jobs.findById(claimed[0].id)!.leaseExpiresAt!;
    assert.equal(jobs.extendLease(claimed[0].id, "worker-a", 30_000), true);
    assert.ok(jobs.findById(claimed[0].id)!.leaseExpiresAt! > beforeExtend);
    assert.equal(jobs.recoverExpiredLeases(Date.now() + 40_000), 1);
    assert.equal(jobs.findById(claimed[0].id)?.status, "pending");
  } finally {
    database.close();
  }
});

test("10000 persistent jobs only claim the configured high-water batch", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    database.db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        jobs.enqueue({
          kind: "download",
          dedupeKey: `download:BVSTRESS${index}`,
          bvid: `BVSTRESS${index}`,
          priority: 40,
        });
      }
    })();
    const claimed = jobs.claimDue(["download"], 25, "worker", 60_000);
    assert.equal(claimed.length, 25);
    assert.equal(jobs.countOutstanding(["download"]), 10_000);
    assert.equal(jobs.counts().download.leased, 25);
    assert.equal(jobs.counts().download.pending, 9_975);
  } finally {
    database.close();
  }
});

test("10000 favorite relations are paged and aggregated in SQLite", () => {
  const database = new StateDatabase(":memory:");
  try {
    const insertVideo = database.db.prepare(`
      INSERT INTO videos(bvid, backup_status, bili_status, local_dir, payload_json, updated_at)
      VALUES(?, ?, 'available', NULL, ?, ?)
    `);
    const insertRelation = database.db.prepare(`
      INSERT INTO favorite_relations(user_id, media_id, bvid, backup_status, active_in_favorite,
        folder_title, fav_order, last_seen_at, favorite_unavailable, self_visible,
        next_remote_check_at, account_detached_at, payload_json, updated_at)
      VALUES('u1', 1, ?, ?, 1, 'Stress', ?, ?, 0, 0, NULL, NULL, ?, ?)
    `);
    const timestamp = Date.parse("2026-07-12T00:00:00.000Z");
    database.db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const bvid = `BVSTRESS${String(index).padStart(6, "0")}`;
        const status = index % 2 === 0 ? "verified" : "discovered";
        const video = {
          bvid, title: bvid, upperName: "Tester", firstSeenAt: new Date(timestamp).toISOString(),
          lastSeenAt: new Date(timestamp).toISOString(), biliStatus: "available", backupStatus: status,
        };
        const relation = {
          userId: "u1", mediaId: 1, bvid, folderTitle: "Stress", favOrder: index,
          firstSeenAt: video.firstSeenAt, lastSeenAt: video.lastSeenAt,
          activeInFavorite: true, backupStatus: status,
        };
        insertVideo.run(bvid, status, JSON.stringify(video), timestamp);
        insertRelation.run(bvid, status, index, timestamp, JSON.stringify(relation), timestamp);
      }
    })();

    const page = database.queryFolderPage("u1", 1, "pending", 100, 25);
    assert.equal(page.rows.length, 25);
    assert.equal(page.totalFiltered, 5_000);
    assert.deepEqual(page.summary, {
      total: 10_000,
      activeTotal: 10_000,
      historicalTotal: 0,
      uploaded: 5_000,
      pending: 5_000,
      pendingUnavailable: 0,
      uploadedUnavailable: 0,
    });
    assert.equal(page.rows.every(({ relation }) => relation.backupStatus === "discovered"), true);
  } finally {
    database.close();
  }
});

test("persistent retry keeps not_before and does not consume attempts for a defer", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    const queued = jobs.enqueue({ kind: "upload", dedupeKey: "upload:test", bvid: "BV1", maxAttempts: 3 });
    const claimed = jobs.claimDue(["upload"], 1, "worker", 60_000)[0];
    assert.equal(claimed.id, queued.id);
    const base = Date.now();
    jobs.defer(claimed.id, "worker", "cooldown", base + 123_000);
    assert.equal(jobs.findById(claimed.id)?.attempts, 0);
    const reclaimed = jobs.claimDue(["upload"], 1, "worker", 60_000, base + 123_000)[0];
    jobs.retry(reclaimed.id, "worker", "temporary", base + 456_000);
    assert.equal(jobs.findById(reclaimed.id)?.attempts, 1);
    assert.equal(jobs.findById(reclaimed.id)?.notBefore, base + 456_000);
  } finally {
    database.close();
  }
});

test("an exhausted normal upload stays visible to recovery and a normal enqueue cannot hide it", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    const queued = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:revive",
      bvid: "BVREVIVE",
      maxAttempts: 1,
      payload: { phase: "first" },
    });
    const claimed = jobs.claimDue(["upload"], 1, "worker", 60_000)[0];
    const result = jobs.retry(claimed.id, "worker", "remote conflict", Date.now() + 60_000);
    assert.equal(result.exhausted, true);
    assert.equal(jobs.findById(queued.id)?.status, "failed");
    assert.equal(jobs.findById(queued.id)?.payload.awaitingManualRecovery, true);

    const duplicate = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:revive",
      bvid: "BVREVIVE",
      maxAttempts: 3,
      payload: { phase: "retry" },
    });
    assert.equal(duplicate.id, queued.id);
    assert.equal(duplicate.status, "failed");
    assert.equal(duplicate.attempts, 1);
    assert.equal(duplicate.payload.awaitingManualRecovery, true);
    assert.equal(duplicate.payload.phase, "first");

    const revived = jobs.wakeManualJob(queued.id, { phase: "retry" });
    assert.equal(revived?.status, "pending");
    assert.equal(revived?.attempts, 0);
    assert.equal(revived?.payload.phase, "retry");
  } finally {
    database.close();
  }
});

test("startup normalization exposes legacy failed upload jobs without touching active or quality jobs", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    const legacy = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:legacy-recovery",
      bvid: "BVLEGACYRECOVERY",
      payload: { localDir: "/tmp/legacy" },
    });
    database.db.prepare("UPDATE jobs SET status='failed', payload_json='{}', lease_owner=NULL, lease_expires_at=NULL WHERE id=?").run(legacy.id);
    const retryWait = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:retry-wait-preserved",
      bvid: "BVRETRYWAIT",
      payload: { localDir: "/tmp/retry" },
    });
    database.db.prepare("UPDATE jobs SET status='retry_wait', payload_json='{}' WHERE id=?").run(retryWait.id);
    const quality = jobs.enqueue({
      kind: "quality_upload",
      dedupeKey: "quality:failed-preserved",
      bvid: "BVQUALITYFAILED",
      payload: { localDir: "/tmp/quality" },
    });
    database.db.prepare("UPDATE jobs SET status='failed', payload_json='{}' WHERE id=?").run(quality.id);

    assert.equal(jobs.normalizeTerminalUploadRecovery(), 1);
    assert.equal(jobs.findById(legacy.id)?.payload.awaitingManualRecovery, true);
    assert.equal(jobs.findById(legacy.id)?.payload.allowReupload, false);
    assert.equal(jobs.findById(retryWait.id)?.payload.awaitingManualRecovery, undefined);
    assert.equal(jobs.findById(quality.id)?.payload.awaitingManualRecovery, undefined);
    assert.equal(jobs.listManualRecovery(["upload"]).some((job) => job.id === legacy.id), true);
    assert.equal(jobs.normalizeTerminalUploadRecovery(), 0);
  } finally {
    database.close();
  }
});

test("database schema 4 refreshes the aggregate view and adds query columns", async () => {
  const runtime = await createTestDir("sqlite-view-migration");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const legacy = new StateDatabase(dbPath);
    const checkedAt = "2026-07-15T01:02:03.456Z";
    const remoteCheckedAt = "2026-07-14T04:05:06.789Z";
    legacy.replaceState({
      schemaVersion: 13,
      processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: {
        BVMIGRATE4: {
          bvid: "BVMIGRATE4", title: "Schema 4", upperName: "Tester",
          firstSeenAt: checkedAt, lastSeenAt: checkedAt, biliStatus: "available",
          backupStatus: "charging_restricted",
          accessRestriction: {
            type: "charging", firstDetectedAt: checkedAt, lastCheckedAt: checkedAt,
            nextCheckAt: checkedAt, previewAvailable: true, checkedAccountUids: [],
          },
        },
      },
      relations: {
        "u1:1:BVMIGRATE4": {
          userId: "u1", mediaId: 1, bvid: "BVMIGRATE4", folderTitle: "Migration",
          firstSeenAt: checkedAt, lastSeenAt: checkedAt, activeInFavorite: true,
          backupStatus: "verified", lastRemoteCheckAt: remoteCheckedAt,
        },
      },
    });
    legacy.db.exec("UPDATE videos SET access_restriction_type=NULL, access_last_checked_at=NULL");
    legacy.db.exec("UPDATE favorite_relations SET last_remote_check_at=NULL");
    legacy.db.exec("DROP VIEW IF EXISTS video_backup_summary");
    legacy.db.exec("CREATE VIEW video_backup_summary AS SELECT v.bvid, v.backup_status AS backup_status FROM videos v");
    legacy.db.pragma("user_version = 1");
    legacy.close();

    const migrated = new StateDatabase(dbPath);
    try {
      const row = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='video_backup_summary'").get() as any;
      assert.match(String(row?.sql || ""), /charging_restricted/);
      assert.equal(migrated.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
      const columns = new Set((migrated.db.pragma("table_info(favorite_relations)") as any[]).map((item) => item.name));
      assert.equal(columns.has("fav_order"), true);
      assert.equal(columns.has("account_detached_at"), true);
      assert.equal(columns.has("last_remote_check_at"), true);
      const videoColumns = new Set((migrated.db.pragma("table_info(videos)") as any[]).map((item) => item.name));
      assert.equal(videoColumns.has("access_restriction_type"), true);
      assert.equal(videoColumns.has("access_last_checked_at"), true);
      const migratedVideo = migrated.db.prepare("SELECT access_restriction_type, access_last_checked_at FROM videos WHERE bvid='BVMIGRATE4'").get() as any;
      assert.equal(migratedVideo.access_restriction_type, "charging");
      assert.equal(migratedVideo.access_last_checked_at, Date.parse(checkedAt));
      const migratedRelation = migrated.db.prepare("SELECT last_remote_check_at FROM favorite_relations WHERE bvid='BVMIGRATE4'").get() as any;
      assert.equal(migratedRelation.last_remote_check_at, Date.parse(remoteCheckedAt));
    } finally {
      migrated.close();
    }

    const backupDir = path.join(runtime, "backups");
    const backupName = (await fs.promises.readdir(backupDir)).find((name) => name.endsWith(".sqlite"));
    assert.ok(backupName);
    const backupPath = path.join(backupDir, backupName);
    const checksum = (await fs.promises.readFile(`${backupPath}.sha256`, "utf8")).split(/\s+/, 1)[0];
    const actual = crypto.createHash("sha256").update(await fs.promises.readFile(backupPath)).digest("hex");
    assert.equal(checksum, actual);
  } finally {
    await removeTestDir(runtime);
  }
});

test("state replacement and clearing remove transfer sessions with their child files", () => {
  const database = new StateDatabase(":memory:");
  try {
    const sessions = new TransferSessionStore(database);
    const session = sessions.ensure({
      dedupeKey: "upload:session-clear",
      bvid: "BVSESSIONCLEAR",
      localDir: "/tmp/BVSESSIONCLEAR",
      remotePath: "/backup/BVSESSIONCLEAR",
    });
    sessions.ensureFile(session.id, { relativePath: "video.mp4", name: "video.mp4", expectedSize: 12 }, session.generation);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM transfer_sessions").get() as any).count), 1);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM transfer_session_files").get() as any).count), 1);

    database.clearStateAndJobs();
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM transfer_sessions").get() as any).count), 0);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM transfer_session_files").get() as any).count), 0);
  } finally {
    database.close();
  }
});

test("prepared attempts roll back generation, files and binding together", () => {
  const database = new StateDatabase(":memory:");
  try {
    const sessions = new TransferSessionStore(database);
    const input = { dedupeKey: "atomic-attempt", bvid: "BVATOMIC", localDir: "/tmp/BVATOMIC", remotePath: "/backup" };
    const files = [{ relativePath: "one.mp4", name: "one.mp4", expectedSize: 12 }];
    const first = sessions.ensurePrepared(input, files);
    sessions.updateSession(first.id, { phase: "completed" }, first.generation);
    assert.throws(() => sessions.ensurePrepared(input, files, () => { throw new Error("binding failed"); }), /binding failed/);
    assert.equal(sessions.get(first.id)?.generation, 1);
    assert.equal(sessions.get(first.id)?.phase, "completed");
    assert.equal(sessions.listFiles(first.id, 2).length, 0);
    const second = sessions.ensurePrepared(input, files);
    assert.equal(second.generation, 2);
    assert.equal(sessions.listFiles(first.id, 2).length, 1);
    assert.equal(sessions.ensurePrepared(input, files).generation, 2);
  } finally { database.close(); }
});

test("legacy transfer session phases can be superseded by a fresh download", () => {
  const database = new StateDatabase(":memory:");
  try {
    const sessions = new TransferSessionStore(database);
    const session = sessions.ensure({
      dedupeKey: "upload:legacy-supersede",
      bvid: "BVLEGACYSUPERSEDE",
      localDir: "/tmp/BVLEGACYSUPERSEDE",
      remotePath: "/backup/BVLEGACYSUPERSEDE",
    });
    database.db.prepare("UPDATE transfer_sessions SET phase='awaiting_final' WHERE id=?").run(session.id);
    assert.equal(sessions.get(session.id)?.phase, "awaiting_remote");
    assert.equal(sessions.supersede(session.id, session.generation), true);
    assert.equal(sessions.get(session.id)?.phase, "superseded");
    assert.equal(sessions.listRecoverable().some((item) => item.id === session.id), false);
  } finally {
    database.close();
  }
});

test("history upload exhaustion remains a manual recovery item and normal enqueue cannot hide it", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    const job = jobs.enqueue({
      kind: "history_upload",
      dedupeKey: "upload:history-recovery",
      bvid: "BVHISTORYRECOVERY",
      maxAttempts: 1,
      payload: { localDir: "/tmp/history", historyOnly: true },
    });
    const claimed = jobs.claimDue(["history_upload"], 1, "history-worker", 60_000)[0];
    assert.equal(claimed.id, job.id);
    const retried = jobs.retry(job.id, "history-worker", "temporary WebDAV failure", Date.now() + 60_000);
    assert.equal(retried.exhausted, true);
    const failed = jobs.findById(job.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.payload.awaitingManualRecovery, true);
    assert.equal(failed.payload.resumeOnly, true);
    assert.equal(failed.payload.allowReupload, false);

    const duplicate = jobs.enqueue({
      kind: "history_upload",
      dedupeKey: "upload:history-recovery",
      bvid: "BVHISTORYRECOVERY",
      payload: { localDir: "/tmp/new-history" },
    });
    assert.equal(duplicate.status, "failed");
    assert.equal(duplicate.payload.awaitingManualRecovery, true);
    assert.equal(duplicate.payload.localDir, "/tmp/history");
  } finally {
    database.close();
  }
});

test("manual upload permission is atomically consumed from a claimed job", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    const job = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:consume-permission",
      bvid: "BVCONSUMEPERMISSION",
      payload: { allowReupload: true, files: ["p01.mp4", "p02.mp4"] },
    });
    const claimed = jobs.claimDue(["upload"], 1, "permission-worker", 60_000)[0];
    assert.equal(claimed.id, job.id);
    assert.equal(jobs.markRunning(job.id, "permission-worker"), true);
    assert.equal(jobs.consumeUploadReuploadPermission(job.id, "permission-worker", "p01.mp4"), true);
    assert.equal(jobs.consumeUploadReuploadPermission(job.id, "permission-worker", "p01.mp4"), false);
    assert.equal(jobs.consumeUploadReuploadPermission(job.id, "permission-worker", "p02.mp4"), true);
    assert.equal(jobs.findById(job.id)?.payload.allowReupload, false);
    assert.deepEqual(jobs.findById(job.id)?.payload.reuploadAuthorizedFiles, []);
  } finally {
    database.close();
  }
});

test("schema 4 upgrade aborts before mutation when its consistent backup cannot be created", async () => {
  const runtime = await createTestDir("sqlite-schema-backup-failure");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const previous = new StateDatabase(dbPath);
    previous.db.pragma("user_version = 3");
    previous.close();
    await fs.promises.writeFile(path.join(runtime, "backups"), "blocked", "utf8");

    assert.throws(() => new StateDatabase(dbPath));
    const raw = new Database(dbPath, { readonly: true });
    try {
      assert.equal(raw.pragma("user_version", { simple: true }), 3);
    } finally {
      raw.close();
    }

    await fs.promises.rm(path.join(runtime, "backups"), { force: true });
    const upgraded = new StateDatabase(dbPath);
    assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
    upgraded.close();
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 6 adds actual media columns without treating requested quality as measured metadata", async () => {
  const runtime = await createTestDir("sqlite-schema-6-media");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const at = "2026-07-26T00:00:00.000Z";
  try {
    const previous = new StateDatabase(dbPath);
    const file = {
      name: "target-4k.mp4",
      path: "/archive/BVSCHEMA6/target-4k.mp4",
      size: 123,
      verificationStatus: "verified" as const,
      qualityProfile: { quality: "4K", encoding: "HEVC", hiRes: false, dolby: false },
      filenameMetadata: { dfn: "4K", videoCodecs: "HEVC" },
    };
    previous.replaceState({
      schemaVersion: 13,
      processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: {
        BVSCHEMA6: {
          bvid: "BVSCHEMA6", title: "Schema 6", upperName: "Tester",
          firstSeenAt: at, lastSeenAt: at, biliStatus: "available", backupStatus: "verified",
          remotePath: "/archive/BVSCHEMA6", remoteFiles: [file],
        },
      },
      relations: {
        "u1:1:BVSCHEMA6": {
          userId: "u1", mediaId: 1, bvid: "BVSCHEMA6", folderTitle: "Schema",
          firstSeenAt: at, lastSeenAt: at, activeInFavorite: true, backupStatus: "verified",
          remotePath: "/archive/BVSCHEMA6", remoteFiles: [file],
        },
      },
    });
    previous.close();

    const raw = new Database(dbPath);
    for (const column of [
      "actual_width", "actual_height", "actual_fps", "actual_duration", "actual_codec",
      "actual_metadata_source", "actual_metadata_at",
    ]) raw.exec(`ALTER TABLE remote_files DROP COLUMN ${column}`);
    raw.pragma("user_version = 5");
    raw.close();

    const upgraded = new StateDatabase(dbPath);
    try {
      assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
      const columns = new Set((upgraded.db.pragma("table_info(remote_files)") as any[]).map((row) => String(row.name)));
      for (const column of [
        "actual_width", "actual_height", "actual_fps", "actual_duration", "actual_codec",
        "actual_metadata_source", "actual_metadata_at",
      ]) assert.equal(columns.has(column), true, column);
      const row = upgraded.db.prepare(`
        SELECT quality_json, actual_width, actual_height, actual_codec, actual_metadata_source
        FROM remote_files WHERE user_id='u1' AND media_id=1
      `).get() as any;
      assert.equal(JSON.parse(row.quality_json).quality, "4K");
      assert.equal(row.actual_width, null);
      assert.equal(row.actual_height, null);
      assert.equal(row.actual_codec, null);
      assert.equal(row.actual_metadata_source, null);
    } finally {
      upgraded.close();
    }
    const backups = (await fs.promises.readdir(path.join(runtime, "backups")))
      .filter((name) => name.includes(`before-schema-${DATABASE_SCHEMA_VERSION}-v5`) && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 7 archive deletion tables survive a direct upgrade through the current schema", async () => {
  const runtime = await createTestDir("sqlite-schema-7-archive-delete");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const current = new StateDatabase(dbPath);
    current.close();

    const legacy = new Database(dbPath);
    legacy.exec(`
      DROP TABLE archive_deleted_sources;
      DROP TABLE archive_deletion_items;
      DROP TABLE archive_deletions;
      DROP TABLE archive_accounts;
    `);
    legacy.pragma("user_version = 6");
    legacy.close();

    const upgraded = new StateDatabase(dbPath);
    try {
      assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
      const tables = new Set((upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name));
      for (const table of ["archive_accounts", "archive_deletions", "archive_deletion_items", "archive_deleted_sources"]) {
        assert.equal(tables.has(table), true, table);
      }
      const foreignKeys = upgraded.db.pragma("foreign_key_list(archive_deleted_sources)") as any[];
      assert.deepEqual(new Set(foreignKeys.map((row) => row.table)), new Set(["archive_deletions", "videos"]));
      upgraded.db.prepare(`
        INSERT INTO archive_deletions(
          id,scope,user_id,status,alist_identity_hash,archive_root,created_at,updated_at
        ) VALUES('failed-delete','source','u1','failed','identity','/backup',1,1)
      `).run();
      assert.equal(upgraded.hasActiveArchiveDeletion(), false);
      assert.equal(upgraded.hasUnfinishedArchiveDeletion(), true);
      assert.equal(upgraded.db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(upgraded.db.pragma("foreign_key_check"), []);
    } finally {
      upgraded.close();
    }

    const reopened = new StateDatabase(dbPath);
    reopened.close();
    const backups = (await fs.promises.readdir(path.join(runtime, "backups")))
      .filter((name) => name.includes(`before-schema-${DATABASE_SCHEMA_VERSION}-v6`) && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
    const checksum = (await fs.promises.readFile(path.join(runtime, "backups", `${backups[0]}.sha256`), "utf8")).split(/\s+/, 1)[0];
    const actual = crypto.createHash("sha256").update(await fs.promises.readFile(path.join(runtime, "backups", backups[0]))).digest("hex");
    assert.equal(checksum, actual);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 9 to 10 adds upload generations and preserves the previous attempt", async () => {
  const runtime = await createTestDir("sqlite-schema-10-upload-generations");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const current = new StateDatabase(dbPath);
    current.db.prepare(`
      INSERT INTO transfer_sessions(
        id, dedupe_key, kind, bvid, user_id, media_id, local_dir, remote_path,
        staging_path, phase, generation, history_only, allow_reupload, created_at, updated_at
      ) VALUES('session-schema10','upload:schema10','upload','BVSCHEMA10','u1',1,'/tmp/BVSCHEMA10','/target','/target','completed',1,0,0,1,1)
    `).run();
    current.db.prepare(`
      INSERT INTO transfer_session_files(
        session_id, generation, relative_path, name, staging_path, final_path, expected_size,
        status, verified_at, created_at, updated_at
      ) VALUES('session-schema10',1,'video.mp4','video.mp4','/target/video.mp4','/target/video.mp4',12,'verified',1,1,1)
    `).run();
    current.close();

    const legacy = new Database(dbPath);
    legacy.exec("DROP INDEX IF EXISTS idx_transfer_session_files_due");
    legacy.exec("DROP INDEX IF EXISTS idx_transfer_session_files_path");
    legacy.exec("ALTER TABLE transfer_session_files RENAME TO transfer_session_files_v10");
    legacy.exec(`
      CREATE TABLE transfer_session_files (
        session_id TEXT NOT NULL REFERENCES transfer_sessions(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        staging_path TEXT NOT NULL,
        final_path TEXT NOT NULL,
        expected_size INTEGER NOT NULL,
        status TEXT NOT NULL,
        put_accepted_at INTEGER,
        stage_verified_at INTEGER,
        moved_at INTEGER,
        verified_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_check_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, relative_path)
      )
    `);
    legacy.exec(`
      INSERT INTO transfer_session_files(
        session_id, relative_path, name, staging_path, final_path, expected_size, status,
        put_accepted_at, stage_verified_at, moved_at, verified_at, attempts, next_check_at,
        last_error, created_at, updated_at
      )
      SELECT session_id, relative_path, name, staging_path, final_path, expected_size, status,
        put_accepted_at, stage_verified_at, moved_at, verified_at, attempts, next_check_at,
        last_error, created_at, updated_at
      FROM transfer_session_files_v10
    `);
    legacy.exec("DROP TABLE transfer_session_files_v10");
    legacy.exec("ALTER TABLE transfer_sessions DROP COLUMN generation");
    legacy.pragma("user_version = 9");
    legacy.close();

    const upgraded = new StateDatabase(dbPath);
    try {
      assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
      const session = upgraded.db.prepare("SELECT generation, phase FROM transfer_sessions WHERE id='session-schema10'").get() as any;
      assert.deepEqual(session, { generation: 1, phase: "completed" });
      const file = upgraded.db.prepare("SELECT generation, relative_path FROM transfer_session_files WHERE session_id='session-schema10'").get() as any;
      assert.deepEqual(file, { generation: 1, relative_path: "video.mp4" });
      assert.equal(upgraded.db.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      upgraded.close();
    }
    const backups = (await fs.promises.readdir(path.join(runtime, "backups")))
      .filter((name) => name.includes(`before-schema-${DATABASE_SCHEMA_VERSION}-v9`) && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 9 atomically builds and preserves the archive library projection from schema 7", async () => {
  const runtime = await createTestDir("sqlite-schema-9-archive-library");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const at = "2026-08-01T00:00:00.000Z";
  try {
    const current = new StateDatabase(dbPath);
    current.replaceState({
      schemaVersion: 13,
      processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: {
        BVSCHEMA8: {
          bvid: "BVSCHEMA8", title: "Schema 8", upperName: "Tester",
          firstSeenAt: at, lastSeenAt: at, biliStatus: "available", backupStatus: "queued",
        },
      },
      relations: {
        "u1:8:BVSCHEMA8": {
          userId: "u1", mediaId: 8, bvid: "BVSCHEMA8", folderTitle: "Schema 8",
          firstSeenAt: at, lastSeenAt: at, activeInFavorite: true, backupStatus: "queued",
        },
      },
    });
    current.close();

    const legacy = new Database(dbPath);
    legacy.exec("DROP TABLE archive_library_projection");
    legacy.pragma("user_version = 7");
    legacy.close();

    const migrationLogs: string[] = [];
    const originalLog = console.log;
    let upgraded: StateDatabase | null = null;
    try {
      console.log = (...args: unknown[]) => migrationLogs.push(args.map(String).join(" "));
      upgraded = new StateDatabase(dbPath);
    } finally {
      console.log = originalLog;
    }
    assert.ok(upgraded);
    try {
      assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
      const rows = upgraded.db.prepare(`
        SELECT scope_type, scope_id, visibility, bvid, status_group
        FROM archive_library_projection ORDER BY scope_type, scope_id
      `).all() as any[];
      assert.deepEqual(rows, [
        { scope_type: "account", scope_id: "u1", visibility: "normal", bvid: "BVSCHEMA8", status_group: "pending" },
        { scope_type: "global", scope_id: "", visibility: "normal", bvid: "BVSCHEMA8", status_group: "pending" },
      ]);
      assert.equal(upgraded.db.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      upgraded.close();
    }
    assert.equal(migrationLogs.length, 2);
    assert.match(
      migrationLogs[0],
      new RegExp(`^\\[Database\\] Starting SQLite schema migration 7 -> ${DATABASE_SCHEMA_VERSION}; creating and verifying a backup before changes\\.$`),
    );
    assert.match(
      migrationLogs[1],
      new RegExp(`^\\[Database\\] Completed SQLite schema migration 7 -> ${DATABASE_SCHEMA_VERSION} in \\d+ ms\\.$`),
    );
    assert.equal(migrationLogs.some((message) => message.includes(dbPath)), false);

    const reopened = new StateDatabase(dbPath);
    try {
      assert.equal(Number((reopened.db.prepare("SELECT COUNT(*) AS count FROM archive_library_projection").get() as any).count), 2);
    } finally {
      reopened.close();
    }
    const backups = (await fs.promises.readdir(path.join(runtime, "backups")))
      .filter((name) => name.includes(`before-schema-${DATABASE_SCHEMA_VERSION}-v7`) && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
    const backupPath = path.join(runtime, "backups", backups[0]);
    const checksum = (await fs.promises.readFile(`${backupPath}.sha256`, "utf8")).split(/\s+/, 1)[0];
    const actual = crypto.createHash("sha256").update(await fs.promises.readFile(backupPath)).digest("hex");
    assert.equal(checksum, actual);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 9 projection rebuild rolls back the whole upgrade when projection insertion fails", async () => {
  const runtime = await createTestDir("sqlite-schema-9-rollback");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const current = new StateDatabase(dbPath);
    current.db.prepare(`
      INSERT INTO videos(bvid,backup_status,bili_status,payload_json,updated_at)
      VALUES('BVROLLBACK8','failed','available','{"bvid":"BVROLLBACK8","title":"Rollback"}',1)
    `).run();
    current.db.prepare(`
      INSERT INTO favorite_relations(
        user_id,media_id,bvid,backup_status,active_in_favorite,folder_title,
        last_seen_at,favorite_unavailable,self_visible,payload_json,updated_at
      ) VALUES('u1',8,'BVROLLBACK8','failed',1,'Rollback',1,0,0,
        '{"userId":"u1","mediaId":8,"bvid":"BVROLLBACK8","folderTitle":"Rollback","firstSeenAt":"2026-08-01T00:00:00.000Z","lastSeenAt":"2026-08-01T00:00:00.000Z","activeInFavorite":true,"backupStatus":"failed"}',1)
    `).run();
    current.rebuildArchiveLibraryProjection();
    current.db.exec(`
      CREATE TRIGGER reject_schema9_projection
      BEFORE INSERT ON archive_library_projection
      BEGIN SELECT RAISE(ABORT, 'projection blocked'); END;
    `);
    current.db.pragma("user_version = 7");
    current.close();

    const migrationLogs: string[] = [];
    const migrationErrors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = (...args: unknown[]) => migrationLogs.push(args.map(String).join(" "));
      console.error = (...args: unknown[]) => migrationErrors.push(args.map(String).join(" "));
      assert.throws(() => new StateDatabase(dbPath), /projection blocked/);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(migrationLogs.length, 1);
    assert.match(
      migrationLogs[0],
      new RegExp(`^\\[Database\\] Starting SQLite schema migration 7 -> ${DATABASE_SCHEMA_VERSION}; creating and verifying a backup before changes\\.$`),
    );
    assert.equal(migrationErrors.length, 1);
    assert.match(
      migrationErrors[0],
      new RegExp(`^\\[Database\\] SQLite schema migration 7 -> ${DATABASE_SCHEMA_VERSION} failed after \\d+ ms; no database changes were committed\\.$`),
    );
    assert.equal([...migrationLogs, ...migrationErrors].some((message) => (
      message.includes(dbPath) || message.includes("projection blocked")
    )), false);
    const raw = new Database(dbPath);
    try {
      assert.equal(raw.pragma("user_version", { simple: true }), 7);
      assert.equal(Number((raw.prepare("SELECT COUNT(*) AS count FROM archive_library_projection").get() as any).count), 2);
      raw.exec("DROP TRIGGER reject_schema9_projection");
    } finally {
      raw.close();
    }
    const upgraded = new StateDatabase(dbPath);
    assert.equal(upgraded.db.pragma("user_version", { simple: true }), DATABASE_SCHEMA_VERSION);
    upgraded.close();
  } finally {
    await removeTestDir(runtime);
  }
});

test("folder detail keeps current order ahead of historical relations", () => {
  const database = new StateDatabase(":memory:");
  const at = "2026-07-22T00:00:00.000Z";
  const video = (bvid: string) => ({
    bvid, title: bvid, upperName: "Tester", firstSeenAt: at, lastSeenAt: at,
    biliStatus: "available", backupStatus: "verified",
  });
  const relation = (bvid: string, activeInFavorite: boolean, favOrder: number, lastSeenAt: string) => ({
    userId: "u1", mediaId: 1, bvid, folderTitle: "Detail", firstSeenAt: at, lastSeenAt,
    activeInFavorite, favOrder, backupStatus: "verified",
  });
  try {
    database.replaceState({
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      folderScans: {},
      userCooldowns: {},
      videos: {
        BVCURRENT2: video("BVCURRENT2") as any,
        BVCURRENT1: video("BVCURRENT1") as any,
        BVHISTORY: video("BVHISTORY") as any,
      },
      relations: {
        "u1:1:BVCURRENT2": relation("BVCURRENT2", true, 2, "2026-07-20T00:00:00.000Z") as any,
        "u1:1:BVCURRENT1": relation("BVCURRENT1", true, 1, "2026-07-19T00:00:00.000Z") as any,
        "u1:1:BVHISTORY": relation("BVHISTORY", false, 0, "2026-07-22T00:00:00.000Z") as any,
      },
    });

    const page = database.queryFolderPage("u1", 1, "all", 0, 10);
    assert.deepEqual(page.rows.map(({ relation: item }) => item.bvid), ["BVCURRENT1", "BVCURRENT2", "BVHISTORY"]);
    assert.equal(page.summary.total, 3);
    assert.equal(page.summary.activeTotal, 2);
    assert.equal(page.summary.historicalTotal, 1);
  } finally {
    database.close();
  }
});

test("schema 4 query projections keep invalid compatibility timestamps out of indexed columns", () => {
  const database = new StateDatabase(":memory:");
  try {
    database.replaceState({
      schemaVersion: 13,
      processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: {
        BVINVALIDTIME: {
          bvid: "BVINVALIDTIME", title: "Invalid time", upperName: "Tester",
          firstSeenAt: "2026-07-15T00:00:00.000Z", lastSeenAt: "2026-07-15T00:00:00.000Z",
          biliStatus: "available", backupStatus: "charging_restricted",
          accessRestriction: {
            type: "charging", firstDetectedAt: "invalid", lastCheckedAt: "invalid",
            nextCheckAt: "invalid", previewAvailable: false, checkedAccountUids: [],
          },
        },
      },
      relations: {
        "u1:1:BVINVALIDTIME": {
          userId: "u1", mediaId: 1, bvid: "BVINVALIDTIME", folderTitle: "Invalid",
          firstSeenAt: "2026-07-15T00:00:00.000Z", lastSeenAt: "2026-07-15T00:00:00.000Z",
          activeInFavorite: true, backupStatus: "charging_restricted",
          lastRemoteCheckAt: "invalid", nextRemoteCheckAt: "invalid",
        },
      },
    });
    const video = database.db.prepare("SELECT access_restriction_type, access_last_checked_at FROM videos WHERE bvid='BVINVALIDTIME'").get() as any;
    const relation = database.db.prepare("SELECT last_remote_check_at, next_remote_check_at FROM favorite_relations WHERE bvid='BVINVALIDTIME'").get() as any;
    assert.equal(video.access_restriction_type, "charging");
    assert.equal(video.access_last_checked_at, null);
    assert.equal(relation.last_remote_check_at, null);
    assert.equal(relation.next_remote_check_at, null);
  } finally {
    database.close();
  }
});

test("pending upload verification query only returns awaiting relations", () => {
  const database = new StateDatabase(":memory:");
  try {
    const now = "2026-07-12T00:00:00.000Z";
    const video = (bvid: string) => ({ bvid, title: bvid, upperName: "UP", firstSeenAt: now, lastSeenAt: now, biliStatus: "available", backupStatus: "uploaded" });
    const relation = (bvid: string, verificationStatus: string) => ({
      userId: "u1", mediaId: 1, bvid, folderTitle: "One", firstSeenAt: now, lastSeenAt: now,
      activeInFavorite: true, backupStatus: "uploaded",
      remoteFiles: [{ name: `${bvid}.mp4`, path: `/remote/${bvid}.mp4`, size: 42, verificationStatus }],
    });
    database.replaceState({
      schemaVersion: 13, processedByUser: {}, failedByUser: {}, folderScans: {}, userCooldowns: {},
      videos: { BVWAIT: video("BVWAIT") as any, BVDONE: video("BVDONE") as any },
      relations: {
        "u1:1:BVWAIT": relation("BVWAIT", "awaiting_verification") as any,
        "u1:1:BVDONE": relation("BVDONE", "verified") as any,
      },
    });
    const pending = database.listPendingUploadVerifications(10);
    assert.deepEqual(pending.map((item) => item.relation.bvid), ["BVWAIT"]);
    const plan = database.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT user_id, media_id, bvid FROM remote_files
      WHERE status='awaiting_verification'
      ORDER BY next_verify_at ASC LIMIT 10
    `).all() as any[];
    assert.match(plan.map((row) => row.detail).join("\n"), /idx_remote_files_verify/);
  } finally {
    database.close();
  }
});
test("completeAndEnqueue rolls back the source job when downstream creation fails", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const source = jobs.enqueue({ kind: "quality_download", dedupeKey: "quality-transition-source", bvid: "BVTRANSITION" });
    const claimed = jobs.claimDue(["quality_download"], 1, "owner")[0];
    assert.equal(claimed.id, source.id);
    assert.equal(jobs.markRunning(source.id, "owner"), true);
    assert.throws(() => jobs.completeAndEnqueue(source.id, "owner", [{
      kind: "quality_upload",
      dedupeKey: "quality-transition-next-invalid",
      bvid: "BVTRANSITION",
      initialStatus: "completed" as any,
    }]), /Unsupported initial persistent job status/);
    assert.equal(jobs.findById(source.id)?.status, "running");
    assert.equal(jobs.findByDedupeKey("quality-transition-next-invalid"), null);

    const transitioned = jobs.completeAndEnqueue(source.id, "owner", [{
      kind: "quality_upload",
      dedupeKey: "quality-transition-next",
      bvid: "BVTRANSITION",
    }]);
    assert.equal(transitioned?.length, 1);
    assert.equal(jobs.findById(source.id), null);
    assert.ok(jobs.findByDedupeKey("quality-transition-next"));
  } finally {
    database.close();
  }
});

test("encoding retry child and parent completion roll back together when generation changes", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const parent = jobs.enqueue({
      kind: "upload",
      dedupeKey: "encoding-parent-atomic",
      bvid: "BVENCATOMIC",
      initialStatus: "manual_wait",
      payload: { encodingRetry: { parentJobId: "self", generation: 2, state: "uploading" } },
    });
    const child = jobs.enqueue({
      kind: "upload",
      dedupeKey: "encoding-child-atomic",
      bvid: "BVENCATOMIC",
      payload: { encodingRetry: { parentJobId: parent.id, generation: 1, state: "uploading" } },
    });
    const claimed = jobs.claimDue(["upload"], 1, "owner").find((job) => job.id === child.id);
    assert.ok(claimed);
    assert.equal(jobs.markRunning(child.id, "owner"), true);
    assert.throws(() => jobs.completeEncodingRetryCommit(parent.id, 1, child.id, "owner"), /parent changed/);
    assert.equal(jobs.findById(child.id)?.status, "running", "child deletion must roll back");
    assert.ok(jobs.findById(parent.id));

    jobs.updatePayload(parent.id, { encodingRetry: { parentJobId: parent.id, generation: 1, state: "uploading" } });
    assert.equal(jobs.completeEncodingRetryCommit(parent.id, 1, child.id, "owner"), true);
    assert.equal(jobs.findById(child.id), null);
    assert.equal(jobs.findById(parent.id), null);
  } finally {
    database.close();
  }
});
test("encoding retry commits keep their parent until all siblings finish", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const parent = jobs.enqueue({ kind: "upload", dedupeKey: "commit-parent", bvid: "BVCOMMIT",
      initialStatus: "manual_wait", payload: { encodingRetry: { generation: 1, state: "uploading" } } });
    const encodingRetry = { parentJobId: parent.id, generation: 1 };
    jobs.enqueue({ kind: "upload", dedupeKey: "commit-a", bvid: "BVCOMMIT", payload: { encodingRetry } });
    jobs.enqueue({ kind: "upload", dedupeKey: "commit-b", bvid: "BVCOMMIT", payload: { encodingRetry } });
    const children = jobs.claimDue(["upload"], 2, "owner");
    assert.equal(children.length, 2);
    assert.equal(jobs.completeEncodingRetryCommit(parent.id, 1, children[0].id, "owner"), true);
    assert.ok(jobs.findById(parent.id), "first success cannot retire the parent");
    assert.equal(jobs.countEncodingRetryJobs(parent.id, 1), 1);
    assert.equal(jobs.completeEncodingRetryCommit(parent.id, 1, children[1].id, "owner"), true);
    assert.equal(jobs.findById(parent.id), null);
  } finally { database.close(); }
});

test("encoding retry transitions preserve sibling job ids and ignore completed cleanup authorization", () => {
  const database = new StateDatabase(":memory:");
  const jobs = new PersistentJobStore(database);
  try {
    const parent = jobs.enqueue({
      kind: "upload", dedupeKey: "encoding-parent-siblings", bvid: "BVENCIDS", initialStatus: "manual_wait",
      payload: { awaitingManualRecovery: true },
    });
    const retry = { parentJobId: parent.id, generation: 1, priority: ["AV1", "HEVC", "AVC"], strict: true, state: "running" };
    const started = jobs.startEncodingRetry(parent.id, {
      kind: "download", dedupeKey: "encoding-download-siblings", bvid: "BVENCIDS",
      payload: { encodingRetry: retry },
    } as any, retry);
    assert.ok(started);
    const download = started!.child;
    const claimedDownload = jobs.claimDue(["download"], 1, "owner")[0];
    assert.equal(claimedDownload.id, download.id);
    assert.equal(jobs.markRunning(download.id, "owner"), true);
    const uploads = jobs.transitionEncodingRetryChildren(parent.id, 1, download.id, "owner", "uploading", [
      { kind: "upload", dedupeKey: "encoding-upload-a", bvid: "BVENCIDS", payload: { encodingRetry: retry } },
      { kind: "upload", dedupeKey: "encoding-upload-b", bvid: "BVENCIDS", payload: { encodingRetry: retry } },
    ]);
    assert.equal(uploads?.length, 2);
    let parentRetry = (jobs.findById(parent.id)?.payload as any).encodingRetry;
    assert.deepEqual(new Set(parentRetry.replacementJobIds), new Set(uploads!.map((job) => job.id)));

    const first = jobs.claimDue(["upload"], 1, "owner")[0];
    assert.ok(first);
    assert.equal(jobs.markRunning(first.id, "owner"), true);
    const verify = jobs.transitionEncodingRetryChildren(parent.id, 1, first.id, "owner", "verifying", [
      { kind: "verify_upload", dedupeKey: "encoding-verify-a", bvid: "BVENCIDS", payload: { encodingRetry: retry } },
    ]);
    assert.equal(verify?.length, 1);
    const sibling = uploads!.find((job) => job.id !== first.id)!;
    parentRetry = (jobs.findById(parent.id)?.payload as any).encodingRetry;
    assert.deepEqual(new Set(parentRetry.replacementJobIds), new Set([sibling.id, verify![0].id]));

    const retained = jobs.enqueue({
      kind: "upload", dedupeKey: "encoding-completed-proof", bvid: "BVENCIDS",
      payload: {
        encodingRetry: retry,
        localCleanupPlans: [{ id: "proof-plan", localDir: "x", manifestSessionId: "m", reason: "upload_verified", files: [{ relativePath: "x.mp4", expectedSize: 1, expectedIdentity: { dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 }, remotePaths: ["/x.mp4"] }], createdAt: new Date().toISOString() }],
      },
    });
    assert.equal(jobs.complete(retained.id), true);
    assert.equal(jobs.findById(retained.id)?.status, "completed");
    assert.equal(jobs.countEncodingRetryJobs(parent.id, 1), 2, "completed cleanup proof must not count as active retry work");
    jobs.cancelEncodingRetryChildren(parent.id, 1);
    assert.ok(jobs.findById(retained.id), "cancel must preserve completed cleanup authorization");
  } finally {
    database.close();
  }
});
