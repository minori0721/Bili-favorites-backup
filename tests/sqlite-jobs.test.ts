import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { StateDatabase } from "../src/database.js";
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

test("full state replacement clears stale jobs and resets the bootstrap marker", () => {
  const database = new StateDatabase(":memory:");
  try {
    const jobs = new PersistentJobStore(database);
    jobs.enqueue({ kind: "download", dedupeKey: "download:stale", bvid: "BVSTALE" });
    database.setMeta("persistent_jobs_bootstrap_v1", "complete");
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

test("database schema 2 refreshes the aggregate view without changing tables", async () => {
  const runtime = await createTestDir("sqlite-view-migration");
  const dbPath = path.join(runtime, "bfb.sqlite");
  try {
    const legacy = new StateDatabase(dbPath);
    legacy.db.exec("DROP VIEW IF EXISTS video_backup_summary");
    legacy.db.exec("CREATE VIEW video_backup_summary AS SELECT v.bvid, v.backup_status AS backup_status FROM videos v");
    legacy.db.pragma("user_version = 1");
    legacy.close();

    const migrated = new StateDatabase(dbPath);
    const row = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='video_backup_summary'").get() as any;
    assert.match(String(row?.sql || ""), /charging_restricted/);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 2);
    migrated.close();
  } finally {
    await removeTestDir(runtime);
  }
});
