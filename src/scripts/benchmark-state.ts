import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StateDatabase } from "../database.js";
import { PersistentJobStore } from "../job-store.js";

const recordCount = 100_000;
const iterations = 100;
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "bfb-state-benchmark-"));
const dbPath = path.join(runtime, "benchmark.sqlite");
const database = new StateDatabase(dbPath);

try {
  const timestamp = Date.now();
  const insertVideo = database.db.prepare(`
    INSERT INTO videos(bvid, backup_status, bili_status, local_dir, payload_json, updated_at)
    VALUES(?, ?, 'available', NULL, ?, ?)
  `);
  const insertRelation = database.db.prepare(`
    INSERT INTO favorite_relations(user_id, media_id, bvid, backup_status, active_in_favorite,
      folder_title, fav_order, last_seen_at, favorite_unavailable, self_visible,
      next_remote_check_at, account_detached_at, payload_json, updated_at)
    VALUES('benchmark', 1, ?, ?, 1, 'Benchmark', ?, ?, 0, 0, NULL, NULL, ?, ?)
  `);
  const insertStarted = performance.now();
  database.db.transaction(() => {
    for (let index = 0; index < recordCount; index += 1) {
      const bvid = `BVBENCH${String(index).padStart(10, "0")}`;
      const status = index % 2 === 0 ? "verified" : "discovered";
      const iso = new Date(timestamp).toISOString();
      const video = { bvid, title: bvid, upperName: "Benchmark", firstSeenAt: iso, lastSeenAt: iso, biliStatus: "available", backupStatus: status };
      const relation = { userId: "benchmark", mediaId: 1, bvid, folderTitle: "Benchmark", favOrder: index, firstSeenAt: iso, lastSeenAt: iso, activeInFavorite: true, backupStatus: status };
      insertVideo.run(bvid, status, JSON.stringify(video), timestamp);
      insertRelation.run(bvid, status, index, timestamp, JSON.stringify(relation), timestamp);
    }
  })();
  const jobs = new PersistentJobStore(database);
  database.db.transaction(() => {
    for (let index = 0; index < 1_000; index += 1) {
      jobs.enqueue({ kind: "download", dedupeKey: `download:benchmark:${index}`, bvid: `BVBENCH${index}`, priority: 40 });
    }
  })();

  const heapBefore = process.memoryUsage().heapUsed;
  const queryStarted = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    database.queryFolderPage("benchmark", 1, index % 2 ? "pending" : "uploaded", (index * 25) % 10_000, 25);
    jobs.counts();
  }
  const queryDurationMs = performance.now() - queryStarted;
  const heapAfter = process.memoryUsage().heapUsed;
  const plans = {
    folder: database.db.prepare("EXPLAIN QUERY PLAN SELECT bvid FROM favorite_relations WHERE user_id=? AND media_id=? AND backup_status=? ORDER BY last_seen_at DESC LIMIT 25").all("benchmark", 1, "discovered"),
    jobs: database.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE status='pending' AND not_before<=? ORDER BY priority, created_at LIMIT 25").all(Date.now()),
  };
  console.log(JSON.stringify({
    records: recordCount,
    iterations,
    insertDurationMs: Math.round(performance.now() - insertStarted - queryDurationMs),
    queryDurationMs: Math.round(queryDurationMs),
    averageIterationMs: Number((queryDurationMs / iterations).toFixed(2)),
    heapDeltaMiB: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    plans,
  }, null, 2));
} finally {
  database.close();
  fs.rmSync(runtime, { recursive: true, force: true });
}
