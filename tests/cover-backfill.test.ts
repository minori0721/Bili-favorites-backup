import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { normalizeBilibiliCoverUrl, runCoverFfmpeg, UnavailableCoverBackfill } from "../src/cover-cache.js";
import {
  LEGACY_UNAVAILABLE_COVER_BACKFILL_MARKER,
  UNAVAILABLE_COVER_BACKFILL_MARKER,
} from "../src/database.js";
import { StateManager, type StateFile } from "../src/state.js";
import { createTestDir, removeTestDir } from "./helpers.js";

const at = "2026-07-27T00:00:00.000Z";

function unavailableState(): StateFile {
  const ids = ["BVEXIST", "BVDOWN", "BVFAIL"];
  return {
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: Object.fromEntries(ids.map((bvid) => [bvid, {
      bvid,
      title: bvid,
      upperName: "Tester",
      cover: `https://i0.hdslb.com/bfs/archive/${bvid}.jpg`,
      firstSeenAt: at,
      lastSeenAt: at,
      biliStatus: "unavailable",
      backupStatus: "lost",
    }])),
    relations: Object.fromEntries(ids.map((bvid, index) => [`u1:1:${bvid}`, {
      userId: "u1",
      mediaId: 1,
      bvid,
      folderTitle: "Unavailable",
      firstSeenAt: at,
      lastSeenAt: at,
      favOrder: index + 1,
      activeInFavorite: false,
      backupStatus: "lost",
      favoriteUnavailable: true,
    }])),
  };
}

test("unavailable cover backfill links existing files, downloads once, and records terminal summary", async () => {
  const runtime = await createTestDir("cover-backfill");
  const manager = new StateManager({
    dbPath: path.join(runtime, "bfb.sqlite"),
    statePath: path.join(runtime, "missing-state.json"),
  });
  const attempts = new Map<string, number>();
  try {
    manager.getDatabase().replaceState(unavailableState());
    manager.getDatabase().setMeta(LEGACY_UNAVAILABLE_COVER_BACKFILL_MARKER, JSON.stringify({ failed: 3 }));
    manager.reload();
    const backfill = new UnavailableCoverBackfill(manager, {
      coverExists: async (bvid) => bvid === "BVEXIST",
      enqueue: async (bvid) => {
        attempts.set(bvid, (attempts.get(bvid) || 0) + 1);
        return bvid === "BVDOWN"
          ? { path: "covers/BVDOWN.webp" }
          : { path: null, retryable: false };
      },
      retryDelaysMs: [1, 1],
    });
    await backfill.start();
    assert.equal(manager.getDatabase().getVideo("BVEXIST")?.originalMeta?.coverLocalPath, "covers/BVEXIST.webp");
    assert.equal(manager.getDatabase().getVideo("BVDOWN")?.originalMeta?.coverLocalPath, "covers/BVDOWN.webp");
    assert.equal(manager.getDatabase().getVideo("BVFAIL")?.originalMeta?.coverLocalPath, undefined);
    assert.deepEqual(Object.fromEntries(attempts), { BVDOWN: 1, BVFAIL: 1 });
    const summary = JSON.parse(String(manager.getDatabase().getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER)));
    assert.deepEqual({
      linked: summary.linked,
      downloaded: summary.downloaded,
      skipped: summary.skipped,
      failed: summary.failed,
    }, { linked: 1, downloaded: 1, skipped: 0, failed: 1 });
    assert.equal(manager.getDatabase().getMeta(LEGACY_UNAVAILABLE_COVER_BACKFILL_MARKER), null);
    await backfill.start();
    assert.deepEqual(Object.fromEntries(attempts), { BVDOWN: 1, BVFAIL: 1 });
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("cover URL validation upgrades legacy Bilibili HTTP URLs without weakening host checks", async () => {
  const upgraded = normalizeBilibiliCoverUrl("http://i0.hdslb.com:80/bfs/archive/cover.jpg?size=large#fragment");
  assert.equal(upgraded.toString(), "https://i0.hdslb.com/bfs/archive/cover.jpg?size=large");
  assert.equal(
    normalizeBilibiliCoverUrl("http://archive.biliimg.com/cover.jpg").toString(),
    "https://archive.biliimg.com/cover.jpg"
  );

  for (const url of [
    "http://example.com/cover.jpg",
    "http://i0.hdslb.com.example.com/cover.jpg",
    "http://evilihdslb.com/cover.jpg",
    "http://i0.hdslb.com:8080/cover.jpg",
    "https://user:pass@i0.hdslb.com/cover.jpg",
    "https://127.0.0.1/cover.jpg",
    "https://localhost/cover.jpg",
    "https://example.com/cover.jpg",
    "not a URL",
  ]) {
    assert.throws(() => normalizeBilibiliCoverUrl(url));
  }
});

test("cover ffmpeg conversion has a hard timeout and terminates its child", async () => {
  let killed = false;
  const hangingSpawn = (() => {
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; return true; };
    return child;
  }) as typeof spawn;
  await assert.rejects(
    () => runCoverFfmpeg("input", "output", { timeoutMs: 20, spawnImpl: hangingSpawn }),
    /timed out/
  );
  assert.equal(killed, true);
});

test("timed out cover backfill stop can restart only after the old run exits", async () => {
  const runtime = await createTestDir("cover-backfill-stop");
  const manager = new StateManager({
    dbPath: path.join(runtime, "bfb.sqlite"),
    statePath: path.join(runtime, "missing-state.json"),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  try {
    manager.getDatabase().replaceState(unavailableState());
    manager.reload();
    const backfill = new UnavailableCoverBackfill(manager, {
      coverExists: async () => false,
      enqueue: async (bvid) => {
        attempts += 1;
        if (attempts === 1) await gate;
        return { path: `covers/${bvid}.webp`, retryable: false };
      },
      retryDelaysMs: [1, 1],
    });
    const firstRun = backfill.start();
    for (let i = 0; i < 50 && attempts === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(await backfill.stop(10), false);
    backfill.restart();
    release();
    await firstRun;
    for (let i = 0; i < 100 && !manager.getDatabase().getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(manager.getDatabase().getMeta(UNAVAILABLE_COVER_BACKFILL_MARKER));
    assert.ok(attempts > 1);
    assert.equal(await backfill.stop(100), true);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});
