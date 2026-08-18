import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/storage.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

async function waitForCondition(check: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

function writeManifest(downloadDir: string, bvid: string, outputs: Array<{ relativePath: string; size: number }>) {
  writeJsonFile(path.join(downloadDir, ".bfb-download.json"), {
    schemaVersion: 1,
    sessionId: `${bvid}-session`,
    kind: "backup",
    bvid,
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    snapshotAt: "2026-08-18T00:00:00.000Z",
    status: "complete",
    pages: outputs.map((output, index) => ({ index: index + 1, cid: index + 1, title: `P${index + 1}`, duration: 1 })),
    outputs: outputs.map((output, index) => ({
      pageIndex: index + 1,
      cid: index + 1,
      relativePath: output.relativePath,
      size: output.size,
      duration: 1,
      videoCodec: "avc1",
      quickHash: "test",
      verifiedAt: "2026-08-18T00:00:00.000Z",
    })),
    history: [],
  });
}

function seedVerifiedState(state: StateManager, bvid: string, localDir: string, remoteFiles: any[]) {
  const now = "2026-08-18T00:00:00.000Z";
  state.replaceStateSnapshot({
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {},
    folderScans: {},
    userCooldowns: {},
    videos: {
      [bvid]: {
        bvid,
        title: bvid,
        upperName: "Tester",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available",
        backupStatus: "verified",
        localDir,
        remotePath: "/archive",
        remoteFiles,
      },
    },
    relations: {
      [`u1:1:${bvid}`]: {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Favorites",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "verified",
        remotePath: "/archive",
        remoteFiles,
      },
    },
  } as any);
}

function makeScheduler(
  state: StateManager,
  tempRoot: string,
  remoteFileInspector: any,
) {
  const config = testConfig({ pollIntervalMinutes: 60 });
  return new SyncScheduler(
    { get: () => config } as any,
    { list: () => [], getById: () => undefined } as any,
    state,
    {
      legacyTempDir: tempRoot,
      remoteFileInspector,
      cacheInspector: async () => ({
        usedBytes: 0,
        fileCount: 0,
        exportableBytes: 0,
        exportableFiles: 0,
        recovery: {
          resumableSessions: 0,
          completedPages: 0,
          totalPages: 0,
          retainedBytes: 0,
          legacyDirectories: 0,
          legacyBytes: 0,
          cleanupEligibleBytes: 0,
        },
      }),
    },
  ) as any;
}

test("startup cleanup verifies remote proof before removing a completed local session", async () => {
  const runtime = await createTestDir("local-cleanup-startup");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALCLEAN");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const inspected: string[] = [];
  const scheduler = makeScheduler(state, tempRoot, async (_config: any, remotePath: string, expectedSize: number) => {
    inspected.push(remotePath);
    return { status: "verified", remoteSize: expectedSize };
  });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }];
    writeManifest(localDir, "BVLOCALCLEAN", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALCLEAN", localDir, remoteFiles);

    scheduler.startLocalCleanupSweep();
    await waitForCondition(() => !fs.existsSync(path.join(localDir, "video.mp4")) && !fs.existsSync(localDir));

    assert.deepEqual(inspected, ["/archive/video.mp4"]);
    assert.equal(fs.existsSync(localDir), false);
    const row = state.getDatabase().db.prepare("SELECT local_dir FROM videos WHERE bvid=?").get("BVLOCALCLEAN") as any;
    assert.equal(row.local_dir, null);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("startup cleanup skips a BVID while any persistent task is active", async () => {
  const runtime = await createTestDir("local-cleanup-active-job");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALBLOCKED");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const scheduler = makeScheduler(state, tempRoot, async (_config: any, _remotePath: string, expectedSize: number) => ({ status: "verified", remoteSize: expectedSize }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }];
    writeManifest(localDir, "BVLOCALBLOCKED", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALBLOCKED", localDir, remoteFiles);
    scheduler.jobStore.enqueue({ kind: "upload", dedupeKey: "upload:blocked", bvid: "BVLOCALBLOCKED", status: "pending" });

    scheduler.startLocalCleanupSweep();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.ok(state.getDatabase().db.prepare("SELECT local_dir FROM videos WHERE bvid=?").get("BVLOCALBLOCKED"));
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("remote size conflicts keep the local file and enter bounded retry state", async () => {
  const runtime = await createTestDir("local-cleanup-remote-conflict");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALCONFLICT");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const scheduler = makeScheduler(state, tempRoot, async () => ({ status: "mismatch", remoteSize: 7 })) as any;
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }];
    writeManifest(localDir, "BVLOCALCONFLICT", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALCONFLICT", localDir, remoteFiles);

    const work = scheduler.requestLocalCleanup("BVLOCALCONFLICT", localDir);
    assert.ok(work);
    await work;
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(scheduler.localCleanupRetries.get("BVLOCALCONFLICT").attempts, 1);
    const retryDelay = scheduler.localCleanupRetries.get("BVLOCALCONFLICT").nextAt - scheduler.now();
    assert.ok(retryDelay >= 59_000 && retryDelay <= 60_000);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("cleanup keeps unconfirmed manifest outputs and never deletes unknown artifacts", async () => {
  const runtime = await createTestDir("local-cleanup-selective");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALSELECTIVE");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const scheduler = makeScheduler(state, tempRoot, async (_config: any, remotePath: string, expectedSize: number) => (
    remotePath.endsWith("first.mp4")
      ? { status: "verified", remoteSize: expectedSize }
      : { status: "missing" }
  )) as any;
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "first.mp4"), "first");
    await fs.promises.writeFile(path.join(localDir, "second.mp4"), "second");
    await fs.promises.writeFile(path.join(localDir, "unknown.bin"), "unknown");
    const remoteFiles = [
      { name: "first.mp4", path: "/archive/first.mp4", size: 5, localRelativePath: "first.mp4", verificationStatus: "verified" },
      { name: "second.mp4", path: "/archive/second.mp4", size: 6, localRelativePath: "second.mp4", verificationStatus: "verified" },
    ];
    writeManifest(localDir, "BVLOCALSELECTIVE", [
      { relativePath: "first.mp4", size: 5 },
      { relativePath: "second.mp4", size: 6 },
    ]);
    seedVerifiedState(state, "BVLOCALSELECTIVE", localDir, remoteFiles);

    await assert.rejects(() => scheduler.performVerifiedLocalCleanup("BVLOCALSELECTIVE", localDir));
    assert.equal(fs.existsSync(path.join(localDir, "first.mp4")), true);
    assert.equal(fs.existsSync(path.join(localDir, "second.mp4")), true);
    assert.equal(fs.existsSync(path.join(localDir, "unknown.bin")), true);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("verified local cleanup candidates use the paged SQLite index and exclude active jobs", () => {
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `local-cleanup-page-${Date.now()}.json`) });
  try {
    const plan = state.getDatabase().db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT v.bvid FROM videos v
      WHERE v.local_dir IS NOT NULL AND v.backup_status IN ('verified','partial_verified')
      ORDER BY v.updated_at ASC, v.bvid ASC
    `).all().map((row: any) => row.detail).join("\n");
    assert.match(plan, /idx_videos_local_cleanup|idx_videos_status/);
    const page = state.listVerifiedLocalCleanupPage(null, 25);
    assert.equal(page.items.length, 0);
  } finally {
    state.close();
  }
});
