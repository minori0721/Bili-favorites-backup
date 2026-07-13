import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createDebugLogPath,
  readDebugLogRetentionPolicy,
  rotateDebugLogs,
  writeDebugLogAtomic,
} from "../src/debug-log-retention.js";
import { StateDatabase } from "../src/database.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir } from "./helpers.js";

function insertStateRows(database: StateDatabase, count: number) {
  const timestamp = Date.parse("2026-07-13T00:00:00.000Z");
  const insertVideo = database.db.prepare(`
    INSERT INTO videos(bvid, backup_status, bili_status, local_dir, payload_json, updated_at)
    VALUES(?, ?, 'available', NULL, ?, ?)
  `);
  const insertRelation = database.db.prepare(`
    INSERT INTO favorite_relations(user_id, media_id, bvid, backup_status, active_in_favorite,
      folder_title, fav_order, last_seen_at, favorite_unavailable, self_visible,
      next_remote_check_at, account_detached_at, payload_json, updated_at)
    VALUES('u1', 1, ?, ?, 1, 'Performance', ?, ?, 0, 0, NULL, NULL, ?, ?)
  `);
  database.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const bvid = `BVPERF${String(index).padStart(8, "0")}`;
      const status = index % 3 === 0 ? "verified" : "discovered";
      const video = {
        bvid,
        title: bvid,
        upperName: "Tester",
        firstSeenAt: new Date(timestamp).toISOString(),
        lastSeenAt: new Date(timestamp).toISOString(),
        biliStatus: "available",
        backupStatus: status,
      };
      const relation = {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Performance",
        favOrder: index,
        firstSeenAt: video.firstSeenAt,
        lastSeenAt: video.lastSeenAt,
        activeInFavorite: true,
        backupStatus: status,
      };
      insertVideo.run(bvid, status, JSON.stringify(video), timestamp);
      insertRelation.run(bvid, status, index, timestamp, JSON.stringify(relation), timestamp);
    }
  })();
}

test("runtime state reads avoid lazy full enumeration and keep caches bounded", async () => {
  const runtime = await createTestDir("state-hot-path");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const database = new StateDatabase(dbPath);
  insertStateRows(database, 300);
  database.close();
  const enumerations: string[] = [];
  const manager = new StateManager({
    dbPath,
    statePath: path.join(runtime, "missing-state.json"),
    onFullEnumeration: (kind) => enumerations.push(kind),
  });
  try {
    const page = manager.listFolderItemsForUser("u1", 1, 25, 25, "pending");
    assert.equal(page.items.length, 25);
    assert.equal(manager.getRemoteFilePreviewRecords().length, 300);
    assert.equal(manager.listPendingUploadVerifications(20).length, 0);
    assert.equal(manager.normalizePersistedWorkForRecovery(), false);
    for (let index = 0; index < 300; index += 1) {
      manager.getVideoMeta(`BVPERF${String(index).padStart(8, "0")}`);
    }
    assert.deepEqual(enumerations, []);
    assert.ok(manager.getLazyCacheStats().videos <= 256);
    assert.ok(manager.getLazyCacheStats().relations <= 256);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("SQLite hot-path indexes are present and selected by representative plans", () => {
  const database = new StateDatabase(":memory:");
  try {
    const indexes = new Set((database.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((row) => row.name));
    for (const name of [
      "idx_videos_bili_status",
      "idx_relations_folder_status",
      "idx_failures_folder_time",
      "idx_remote_files_verify",
      "idx_jobs_due",
    ]) assert.equal(indexes.has(name), true, name);

    const plans = [
      database.db.prepare("EXPLAIN QUERY PLAN SELECT bvid FROM videos WHERE bili_status=? ORDER BY bvid LIMIT 10").all("unavailable"),
      database.db.prepare("EXPLAIN QUERY PLAN SELECT bvid FROM favorite_relations WHERE user_id=? AND media_id=? AND backup_status=? ORDER BY last_seen_at DESC LIMIT 10").all("u1", 1, "failed"),
      database.db.prepare("EXPLAIN QUERY PLAN SELECT bvid FROM failures WHERE user_id=? AND media_id=? ORDER BY failed_at DESC LIMIT 10").all("u1", 1),
      database.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE status='pending' AND not_before<=? ORDER BY priority, created_at LIMIT 10").all(Date.now()),
    ].map((rows) => (rows as any[]).map((row) => row.detail).join("\n"));
    assert.match(plans[0], /idx_videos_bili_status/);
    assert.match(plans[1], /idx_relations_folder_status/);
    assert.match(plans[2], /idx_failures_folder_time/);
    assert.match(plans[3], /idx_jobs_due/);
  } finally {
    database.close();
  }
});

test("debug log policy uses safe defaults without echoing invalid values", () => {
  const warnings: string[] = [];
  const policy = readDebugLogRetentionPolicy({
    BFB_DEBUG_LOG_RETENTION_DAYS: "secret-invalid-value",
    BFB_DEBUG_LOG_MAX_FILES: "0",
    BFB_DEBUG_LOG_MAX_MIB: "NaN",
  }, (message) => warnings.push(message));
  assert.deepEqual(policy, { maxAgeDays: 14, maxFiles: 200, maxBytes: 256 * 1024 * 1024 });
  assert.equal(warnings.length, 3);
  assert.doesNotMatch(warnings.join(" "), /secret-invalid-value/);
});

test("debug logs rotate by age, count and bytes while preserving unknown files", async () => {
  const runtime = await createTestDir("debug-retention");
  try {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    const files = [
      { name: "expired.log", ageDays: 20, size: 30 },
      { name: "old.log", ageDays: 3, size: 80 },
      { name: "middle.log", ageDays: 2, size: 80 },
      { name: "new.log", ageDays: 1, size: 80 },
    ];
    for (const file of files) {
      const target = path.join(runtime, file.name);
      await fs.promises.writeFile(target, Buffer.alloc(file.size, 1));
      const at = new Date(now - file.ageDays * 24 * 60 * 60_000);
      await fs.promises.utimes(target, at, at);
    }
    await fs.promises.writeFile(path.join(runtime, "keep.txt"), "keep");
    await fs.promises.mkdir(path.join(runtime, "nested.log"));

    const result = await rotateDebugLogs({
      directory: runtime,
      nowMs: now,
      policy: { maxAgeDays: 14, maxFiles: 2, maxBytes: 120 },
      warn: () => undefined,
    });
    assert.equal(result.removedFiles, 3);
    assert.deepEqual((await fs.promises.readdir(runtime)).sort(), ["keep.txt", "nested.log", "new.log"]);
  } finally {
    await removeTestDir(runtime);
  }
});

test("debug log writes are atomic and leave no temporary files", async () => {
  const runtime = await createTestDir("debug-atomic");
  try {
    const target = createDebugLogPath("BV1TEST", runtime, new Date("2026-07-13T12:00:00.000Z"));
    await writeDebugLogAtomic(target, "safe debug output");
    assert.equal(await fs.promises.readFile(target, "utf8"), "safe debug output");
    assert.equal((await fs.promises.readdir(runtime)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await removeTestDir(runtime);
  }
});
