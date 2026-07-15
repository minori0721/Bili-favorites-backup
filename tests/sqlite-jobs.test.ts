import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER,
  LEGACY_TEMP_CACHE_MARKER,
  StateDatabase,
} from "../src/database.js";
import { PersistentJobStore } from "../src/job-store.js";
import { createTestDir, removeTestDir } from "./helpers.js";

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
    database.clearStateAndJobs();
    assert.equal(database.getMeta("persistent_jobs_bootstrap_v1"), null);
    assert.equal(database.getMeta("legacy_failure_classification_v1"), null);
    assert.equal(database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), null);
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

test("an exhausted persistent job is retained and a later enqueue revives it", () => {
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

    const revived = jobs.enqueue({
      kind: "upload",
      dedupeKey: "upload:revive",
      bvid: "BVREVIVE",
      maxAttempts: 3,
      payload: { phase: "retry" },
    });
    assert.equal(revived.id, queued.id);
    assert.equal(revived.status, "pending");
    assert.equal(revived.attempts, 0);
    assert.deepEqual(revived.payload, { phase: "retry" });
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
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 4);
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
    assert.equal(upgraded.db.pragma("user_version", { simple: true }), 4);
    upgraded.close();
  } finally {
    await removeTestDir(runtime);
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
