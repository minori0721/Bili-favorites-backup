import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/storage.js";
import { cleanupUploadedSessionFiles, readDownloadSession, writeDownloadSession } from "../src/download-session.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { TransferSessionStore } from "../src/transfer-session.js";
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

function seedVerifiedState(state: StateManager, bvid: string, localDir: string, remoteFiles: any[], authorizeCleanup = true) {
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
  if (authorizeCleanup) {
    const jobs = new PersistentJobStore(state.getDatabase());
    const job = jobs.enqueue({ kind: "upload", dedupeKey: `cleanup-test:${bvid}`, bvid });
    const transfers = new TransferSessionStore(state.getDatabase());
    const session = transfers.ensurePrepared({ dedupeKey: `cleanup-test:${bvid}`, bvid, localDir, remotePath: "/archive" },
      remoteFiles.map((file) => ({ relativePath: file.localRelativePath, name: file.name, expectedSize: file.size })));
    for (const file of remoteFiles) transfers.updateFile(session.id, file.localRelativePath, { status: "verified", verifiedAt: Date.now(), putAcceptedAt: Date.now() }, session.generation);
    transfers.updateSession(session.id, { phase: "completed" }, session.generation);
    state.recordLocalCleanupPlan(bvid, {
    id: `cleanup:${bvid}`,
    localDir,
    manifestSessionId: `${bvid}-session`,
    reason: "upload_verified",
    transferSessionId: session.id,
    transferGeneration: session.generation,
    createdAt: now,
    files: remoteFiles.map((file) => {
      const stat = fs.lstatSync(path.join(localDir, file.localRelativePath));
      return { relativePath: file.localRelativePath, expectedSize: file.size, remotePaths: [file.path],
        expectedIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
    }),
    }, job.id);
    jobs.complete(job.id);
  }
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

test("cleanup plans survive SQLite reopen and are removed only after authorized files are gone", async () => {
  const runtime = await createTestDir("local-cleanup-restart");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALRESTART";
  const localDir = path.join(tempRoot, bvid);
  const options = { statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") };
  let state = new StateManager(options);
  let scheduler: any;
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }]);
    state.close();
    state = new StateManager(options);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 1);
    scheduler = makeScheduler(state, tempRoot, async () => ({ status: "verified", remoteSize: 5 }));
    await scheduler.performVerifiedLocalCleanup(bvid, localDir);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), false);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
    assert.equal((state.getDatabase().db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE bvid=?").get(bvid) as any).count, 0);
  } finally {
    scheduler?.stop(); state.close(); await removeTestDir(runtime);
  }
});

test("a verified archive alone never authorizes deleting an uncommitted local copy", async () => {
  const runtime = await createTestDir("local-cleanup-no-authorization");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALUNCOMMITTED";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let inspections = 0;
  const scheduler = makeScheduler(state, tempRoot, async () => { inspections++; return { status: "verified", remoteSize: 5 }; });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }], false);
    await scheduler.performVerifiedLocalCleanup(bvid, localDir);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(inspections, 0);
  } finally {
    scheduler.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

for (const change of ["same-size replacement", "new active job", "new transfer generation"] as const) {
  test(`cleanup preserves local media when remote verification races with ${change}`, async () => {
    const runtime = await createTestDir("local-cleanup-race");
    const tempRoot = path.join(runtime, "temp");
    const bvid = "BVLOCALRACE";
    const localDir = path.join(tempRoot, bvid);
    const target = path.join(localDir, "video.mp4");
    const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
    const scheduler = makeScheduler(state, tempRoot, async () => {
      if (change === "same-size replacement") {
        await fs.promises.writeFile(target, "other");
        await fs.promises.utimes(target, new Date("2020-01-01"), new Date("2020-01-01"));
      } else if (change === "new active job") {
        scheduler.jobStore.enqueue({ kind: "upload", dedupeKey: "upload:race", bvid, initialStatus: "pending" });
      } else {
        state.getDatabase().db.prepare("UPDATE transfer_sessions SET generation=generation+1, phase='completed' WHERE bvid=?").run(bvid);
      }
      return { status: "verified", remoteSize: 5 };
    });
    try {
      await fs.promises.mkdir(localDir, { recursive: true });
      await fs.promises.writeFile(target, "hello");
      writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
      seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }]);
      await scheduler.performVerifiedLocalCleanup(bvid, localDir);
      assert.equal(fs.existsSync(target), true);
      assert.equal(state.getLocalCleanupPlans(bvid).length, 1);
    } finally {
      scheduler.stop();
      state.close();
      await removeTestDir(runtime);
    }
  });
}

test("cleanup resumes after unlink succeeded but manifest reconciliation was interrupted", async () => {
  const runtime = await createTestDir("local-cleanup-unlink-crash");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALCRASH";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  const scheduler = makeScheduler(state, tempRoot, async () => ({ status: "verified", remoteSize: 5 }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    const target = path.join(localDir, "video.mp4");
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }]);
    await fs.promises.unlink(target);
    await scheduler.performVerifiedLocalCleanup(bvid, localDir);
    assert.equal(fs.existsSync(localDir), false);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
  } finally {
    scheduler.stop(); state.close(); await removeTestDir(runtime);
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
test("local archive proof never treats a directory shell or partial manifest as complete", async () => {
  const runtime = await createTestDir("local-proof-directory-shell");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALPROOF";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  const scheduler = makeScheduler(state, tempRoot, async () => ({ status: "verified", remoteSize: 5 }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    assert.equal(scheduler.inspectLocalArchiveDirectory(localDir).status, "unknown");
    await fs.promises.writeFile(path.join(localDir, "first.mp4"), "first");
    writeManifest(localDir, bvid, [
      { relativePath: "first.mp4", size: 5 },
      { relativePath: "missing.mp4", size: 7 },
    ]);
    const proof = scheduler.inspectLocalArchiveDirectory(localDir);
    assert.equal(proof.status, "unknown");
    assert.equal(proof.retainedBytes, 5);
    assert.equal(proof.verifiedFiles, 1);
    assert.equal(proof.totalFiles, 2);
  } finally {
    scheduler.stop(); state.close(); await removeTestDir(runtime);
  }
});

test("cleanup does not overwrite a changed manifest after deleting the first page", async () => {
  const runtime = await createTestDir("cleanup-manifest-race");
  const bvid = "BVMANIFESTCHANGE";
  try {
    await fs.promises.writeFile(path.join(runtime, "first.mp4"), "first");
    await fs.promises.writeFile(path.join(runtime, "second.mp4"), "other");
    writeManifest(runtime, bvid, [{ relativePath: "first.mp4", size: 5 }, { relativePath: "second.mp4", size: 5 }]);
    let checks = 0;
    await cleanupUploadedSessionFiles(runtime, {
      confirmedRelativePaths: ["first.mp4", "second.mp4"],
      canDelete: () => {
        if (++checks === 2) {
          const manifest = readDownloadSession(runtime)!;
          manifest.sessionId = "new-attempt";
          writeDownloadSession(runtime, manifest);
          return false;
        }
        return true;
      },
    });
    assert.equal(fs.existsSync(path.join(runtime, "first.mp4")), false);
    assert.equal(fs.existsSync(path.join(runtime, "second.mp4")), true);
    assert.equal(readDownloadSession(runtime)?.sessionId, "new-attempt");
    assert.equal(readDownloadSession(runtime)?.outputs.length, 2);
  } finally { await removeTestDir(runtime); }
});

test("explicit release removes stopped local media without requiring remote success", async () => {
  const runtime = await createTestDir("local-release-no-remote");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALONLY";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let requests = 0;
  const scheduler = makeScheduler(state, tempRoot, async () => { requests++; throw new Error("must not access remote"); });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    await fs.promises.writeFile(path.join(localDir, "unknown.txt"), "keep");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [], false);
    state.markUploadFailed(bvid, localDir, "u1", 1, "Remote write rejected");
    const preview = scheduler.previewLocalArchiveRelease(bvid);
    assert.equal(preview.candidates[0].requiresExplicitDeletion, true);
    assert.equal(preview.candidates[0].hasVerifiedArchive, false);
    assert.equal(preview.totalBytes, 5);
    assert.equal(scheduler.requestLocalArchiveRelease(bvid, preview.candidates[0].releaseId, "DELETE").ok, false);
    assert.ok(fs.existsSync(path.join(localDir, "video.mp4")));
    const jobs = new PersistentJobStore(state.getDatabase());
    const running = jobs.enqueue({ kind: "upload", dedupeKey: "release-running", bvid });
    assert.equal(scheduler.requestLocalArchiveRelease(bvid, preview.candidates[0].releaseId, "DELETE LOCAL").status, 409);
    assert.ok(fs.existsSync(path.join(localDir, "video.mp4")));
    jobs.complete(running.id);
    assert.equal(scheduler.requestLocalArchiveRelease(bvid, preview.candidates[0].releaseId, "DELETE LOCAL").ok, true);
    await waitForCondition(() => !fs.existsSync(path.join(localDir, "video.mp4")));
    assert.equal(fs.existsSync(path.join(localDir, "unknown.txt")), true);
    assert.equal(requests, 0);
    assert.equal(scheduler.previewLocalArchiveRelease(bvid).fileCount, 0);
  } finally { scheduler.stop(); state.close(); await removeTestDir(runtime); }
});

test("manual local release rejects a stale same-size replacement after preview", async () => {
  const runtime = await createTestDir("local-release-stale");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALRELEASESTALE";
  const localDir = path.join(tempRoot, bvid);
  const target = path.join(localDir, "video.mp4");
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let inspections = 0;
  const scheduler = makeScheduler(state, tempRoot, async () => { inspections += 1; return { status: "verified", remoteSize: 5 }; });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }]);
    const preview = scheduler.previewLocalArchiveRelease(bvid);
    assert.equal(preview.ok, true);
    assert.equal(preview.fileCount, 1);
    const releaseId = preview.candidates[0].releaseId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.promises.writeFile(target, "other");
    const result = scheduler.requestLocalArchiveRelease(bvid, releaseId, "DELETE LOCAL");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(fs.existsSync(target), true);
    assert.equal(inspections, 0, "stale UI requests must fail before remote verification or deletion");
  } finally {
    scheduler.stop(); state.close(); await removeTestDir(runtime);
  }
});

test("manual local release uses persisted cleanup authorization and the verified cleanup executor", async () => {
  const runtime = await createTestDir("local-release-authorized");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALRELEASE";
  const localDir = path.join(tempRoot, bvid);
  const target = path.join(localDir, "video.mp4");
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  const inspected: string[] = [];
  const scheduler = makeScheduler(state, tempRoot, async (_config: any, remotePath: string, expectedSize: number) => {
    inspected.push(remotePath);
    return { status: "verified", remoteSize: expectedSize };
  });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" }]);
    const preview = scheduler.previewLocalArchiveRelease(bvid);
    assert.equal(preview.ok, true);
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.totalBytes, 5);
    const denied = scheduler.requestLocalArchiveRelease(bvid, preview.candidates[0].releaseId, "DELETE");
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 400);
    assert.equal(fs.existsSync(target), true);

    const started = scheduler.requestLocalArchiveRelease(bvid, preview.candidates[0].releaseId, "DELETE LOCAL");
    assert.equal(started.ok, true);
    assert.equal(started.fileCount, 1);
    await waitForCondition(() => !fs.existsSync(target) && state.getLocalCleanupPlans(bvid).length === 0);
    assert.deepEqual(inspected, ["/archive/video.mp4"]);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
  } finally {
    scheduler.stop(); state.close(); await removeTestDir(runtime);
  }
});
