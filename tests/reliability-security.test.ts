import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import {
  BBDownCredentialTempPrefix,
  cleanupStaleBBDownCredentialDirectories,
  createBBDownCredentialDirectory,
} from "../src/credential-temp.js";
import { cleanupDownloadRecoveryArtifacts, writeDownloadSession } from "../src/download-session.js";
import { createZipFromSources } from "../src/zip.js";
import {
  extractMigrationPackageFile,
  previewMigrationPackageFile,
} from "../src/migration.js";
import { LogManager } from "../src/logger.js";
import {
  collectSecurityConfigurationWarnings,
  createLoginRateLimiter,
} from "../src/security.js";
import { StateManager } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { QualityUpgradeTask } from "../src/tasks.js";
import { computeQualityCleanupRetryDelayMs, SyncScheduler } from "../src/scheduler.js";
import { batchRenameRemotePaths } from "../src/uploader.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

async function sha256(filePath: string) {
  return crypto.createHash("sha256").update(await fs.promises.readFile(filePath)).digest("hex");
}

async function buildMigrationArchive(
  runtime: string,
  name: string,
  files: Record<string, string | Buffer>,
  counts: { users?: number; videos?: number; relations?: number; unavailableVideos?: number } = {}
) {
  const root = path.join(runtime, `${name}-source`);
  await fs.promises.mkdir(root, { recursive: true });
  const checksums: Record<string, { size: number; sha256: string }> = {};
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
    checksums[relative] = {
      size: (await fs.promises.stat(target)).size,
      sha256: await sha256(target),
    };
  }
  await fs.promises.writeFile(path.join(root, "checksums.json"), JSON.stringify(checksums));
  await fs.promises.writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schema: 3,
    app: "Bili-favorites-backup",
    version: "2.4.0",
    exportedAt: new Date().toISOString(),
    mode: files["temp/sample.bin"] ? "complete" : "lightweight",
    includes: {},
    counts: {
      users: counts.users ?? 0,
      videos: counts.videos ?? 0,
      relations: counts.relations ?? 0,
      unavailableVideos: counts.unavailableVideos ?? 0,
    },
    warning: "test",
    archive: {
      files: Object.keys(files).length + 2,
      expandedBytes: Object.values(checksums).reduce((total, item) => total + item.size, 0),
    },
  }));
  const archive = path.join(runtime, `${name}.zip`);
  await createZipFromSources([{ root, prefix: false }], archive);
  return archive;
}

test("BBDown credentials use private OS temp directories and stale directories are removed", async () => {
  const runtime = await createTestDir("credential-temp");
  try {
    const directory = await createBBDownCredentialDirectory(runtime);
    assert.equal(path.dirname(directory), runtime);
    assert.match(path.basename(directory), new RegExp(`^${BBDownCredentialTempPrefix}`));
    if (process.platform !== "win32") assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
    await fs.promises.writeFile(path.join(directory, "BBDown.config"), "Cookie: secret", { mode: 0o600 });
    const legacyDirectory = path.join(runtime, "bbdown-credentials-legacy");
    await fs.promises.mkdir(legacyDirectory);
    await fs.promises.writeFile(path.join(legacyDirectory, "BBDown.config"), "legacy");
    assert.equal(await cleanupStaleBBDownCredentialDirectories(runtime), 2);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(fs.existsSync(legacyDirectory), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("fragment cleanup removes historical credential directories without treating them as downloads", async () => {
  const runtime = await createTestDir("legacy-credential-fragment");
  try {
    const legacy = path.join(runtime, "bbdown-credentials-old");
    await fs.promises.mkdir(legacy, { recursive: true });
    await fs.promises.writeFile(path.join(legacy, "BBDown.config"), "do-not-read");
    const result = await cleanupDownloadRecoveryArtifacts(runtime);
    assert.equal(result.removedDirectories, 1);
    assert.equal(result.removedBytes, 0);
    assert.equal(fs.existsSync(legacy), false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("schema 3 import verifies then discards historical credential payloads", async () => {
  const runtime = await createTestDir("migration-credential-discard");
  try {
    const archive = await buildMigrationArchive(runtime, "credential", {
      "temp/bbdown-credentials-old/BBDown.config": "Cookie: secret",
    });
    const extracted = await extractMigrationPackageFile(archive);
    try {
      assert.equal(extracted.files.some((file) => file.includes("credentials")), false);
      assert.equal(fs.existsSync(path.join(extracted.extractDir, "temp", "bbdown-credentials-old")), false);
    } finally {
      await fs.promises.rm(extracted.root, { recursive: true, force: true });
    }
  } finally {
    await removeTestDir(runtime);
  }
});

test("migration preview rejects malformed config, duplicate users and malformed logs", async () => {
  const runtime = await createTestDir("migration-semantics");
  try {
    const invalidConfig = await buildMigrationArchive(runtime, "bad-config", { "data/config.json": "[]" });
    await assert.rejects(previewMigrationPackageFile(invalidConfig), /配置数据必须是JSON对象/);

    const duplicateUsers = JSON.stringify([
      { id: "u1", cookie: {}, favorites: [] },
      { id: "u1", cookie: {}, favorites: [] },
    ]);
    const invalidUsers = await buildMigrationArchive(runtime, "bad-users", { "data/users.json": duplicateUsers }, { users: 2 });
    await assert.rejects(previewMigrationPackageFile(invalidUsers), /重复ID/);

    const invalidLogs = await buildMigrationArchive(runtime, "bad-logs", { "data/logs.json": JSON.stringify([{ raw: 1 }]) });
    await assert.rejects(previewMigrationPackageFile(invalidLogs), /日志第 1 项字段结构错误/);
  } finally {
    await removeTestDir(runtime);
  }
});

test("rename supports path swaps and reports a file stranded at its temporary path", async () => {
  const swapPaths = new Set(["/target/a.mp4", "/target/b.mp4"]);
  const swapClient = {
    exists: async (target: string) => swapPaths.has(target),
    moveFile: async (from: string, to: string) => {
      if (!swapPaths.delete(from)) throw Object.assign(new Error("missing"), { status: 404 });
      if (swapPaths.has(to)) throw Object.assign(new Error("conflict"), { status: 409 });
      swapPaths.add(to);
    },
  } as any;
  const swapped = await batchRenameRemotePaths(testConfig({ alistDest: "/target" }), [
    { oldPath: "/target/a.mp4", newPath: "/target/b.mp4" },
    { oldPath: "/target/b.mp4", newPath: "/target/a.mp4" },
  ], swapClient);
  assert.equal(swapped.success, 2);
  assert.deepEqual(swapped.results.map((item) => item.status), ["renamed", "renamed"]);
  assert.deepEqual(swapped.results.map((item) => item.actualPath), ["/target/b.mp4", "/target/a.mp4"]);

  const strandedPaths = new Set(["/target/old.mp4"]);
  const strandedClient = {
    exists: async (target: string) => strandedPaths.has(target),
    moveFile: async (from: string, to: string) => {
      if (to === "/target/new.mp4" || to === "/target/old.mp4" && from.includes("__bfb_rename_")) {
        throw new Error("MOVE rejected");
      }
      if (!strandedPaths.delete(from)) throw new Error("missing");
      strandedPaths.add(to);
    },
  } as any;
  const stranded = await batchRenameRemotePaths(testConfig({ alistDest: "/target" }), [
    { oldPath: "/target/old.mp4", newPath: "/target/new.mp4" },
  ], strandedClient);
  assert.equal(stranded.results[0].status, "stranded");
  assert.match(stranded.results[0].actualPath || "", /__bfb_rename_/);
  assert.deepEqual(stranded.results[0].observedPaths, [stranded.results[0].actualPath]);
});

test("SQLite rename writeback applies swaps from the original path snapshot", async () => {
  const runtime = await createTestDir("rename-state-swap");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const now = new Date().toISOString();
    manager.replaceStateSnapshot({
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      folderScans: {},
      userCooldowns: {},
      videos: {
        BVSWAP: {
          bvid: "BVSWAP", title: "swap", upperName: "up", firstSeenAt: now, lastSeenAt: now,
          biliStatus: "available", backupStatus: "verified", remotePath: "/target",
          remoteFiles: [
            { name: "a.mp4", path: "/target/a.mp4" },
            { name: "b.mp4", path: "/target/b.mp4" },
          ],
        },
      },
      relations: {
        "u1:1:BVSWAP": {
          userId: "u1", mediaId: 1, bvid: "BVSWAP", folderTitle: "fav", firstSeenAt: now, lastSeenAt: now,
          activeInFavorite: true, backupStatus: "verified", remotePath: "/target",
          remoteFiles: [
            { name: "a.mp4", path: "/target/a.mp4" },
            { name: "b.mp4", path: "/target/b.mp4" },
          ],
        },
      },
    } as any);
    assert.equal(manager.renameRemoteFilesBatch("BVSWAP", [
      { oldPath: "/target/a.mp4", newPath: "/target/b.mp4" },
      { oldPath: "/target/b.mp4", newPath: "/target/a.mp4" },
    ]), true);
    const relation = manager.getRelationStatus("u1", 1, "BVSWAP");
    assert.deepEqual(relation?.remoteFiles?.map((file) => [file.name, file.path]), [
      ["b.mp4", "/target/b.mp4"],
      ["a.mp4", "/target/a.mp4"],
    ]);
    assert.equal(new Set(relation?.remoteFiles?.map((file) => file.path)).size, 2);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("StateManager database replacement can roll back until explicitly committed", async () => {
  const runtime = await createTestDir("database-replacement");
  const oldManager = new StateManager({ dbPath: path.join(runtime, "active.sqlite"), statePath: path.join(runtime, "old.json") });
  const importedManager = new StateManager({ dbPath: path.join(runtime, "import.sqlite"), statePath: path.join(runtime, "new.json") });
  try {
    oldManager.recordFavoriteItem("u1", 1, "old", { bvid: "BVOLD", title: "old", upperName: "up" } as any);
    importedManager.recordFavoriteItem("u2", 2, "new", { bvid: "BVNEW", title: "new", upperName: "up" } as any);
    importedManager.close();

    const first = await oldManager.beginDatabaseReplacement(path.join(runtime, "import.sqlite"));
    assert.equal(oldManager.getVideoMeta("BVNEW")?.title, "new");
    await first.rollback();
    assert.equal(oldManager.getVideoMeta("BVOLD")?.title, "old");
    assert.equal(oldManager.getVideoMeta("BVNEW"), null);

    const second = await oldManager.beginDatabaseReplacement(path.join(runtime, "import.sqlite"));
    await second.commit();
    assert.equal(oldManager.getVideoMeta("BVNEW")?.title, "new");
    assert.equal((await fs.promises.readdir(runtime)).some((name) => name.includes("before-import")), false);
  } finally {
    try { oldManager.close(); } catch {}
    try { importedManager.close(); } catch {}
    await removeTestDir(runtime);
  }
});

test("LogManager persists and emits the same sanitized object", async () => {
  const runtime = await createTestDir("log-sanitization");
  const filePath = path.join(runtime, "logs.json");
  await fs.promises.writeFile(filePath, JSON.stringify([{
    timestamp: new Date().toISOString(),
    type: "system",
    level: "error",
    summary: "old",
    raw: "Cookie: SESSDATA=old-secret",
  }]));
  const manager = new LogManager(filePath);
  try {
    assert.doesNotMatch(JSON.stringify(manager.getAll()), /old-secret/);
    manager.clear();
    let emitted: any;
    manager.once("log", (entry) => { emitted = entry; });
    manager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "error",
      summary: "safe summary",
      raw: "Cookie: SESSDATA=secret; bili_jct=csrf-secret\nhttps://u:p@example.com/a?access_key=access-secret\nvisible",
    });
    manager.flush();
    const stored = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.deepEqual(emitted, stored[0]);
    assert.doesNotMatch(JSON.stringify(stored), /secret|u:p/);
    assert.match(stored[0].raw, /visible/);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("login limiter counts only failures, isolates IPs and expires its window", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.post("/login", createLoginRateLimiter({ windowMs: 80, limit: 2 }), (req, res) => {
    if (req.body?.ok) res.json({ success: true });
    else res.status(401).json({ success: false });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/login`;
  const send = (ok: boolean, ip: string) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ ok }),
  });
  try {
    assert.equal((await send(true, "198.51.100.1")).status, 200);
    assert.equal((await send(true, "198.51.100.1")).status, 200);
    assert.equal((await send(false, "198.51.100.1")).status, 401);
    assert.equal((await send(false, "198.51.100.1")).status, 401);
    const limited = await send(false, "198.51.100.1");
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    assert.equal((await send(false, "198.51.100.2")).status, 401);
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal((await send(false, "198.51.100.1")).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("weak security configuration warnings never include secret values", () => {
  const warnings = collectSecurityConfigurationWarnings({
    adminPassword: "admin",
    sessionSecret: "dev-secret",
    secureSessionCookie: false,
    cookieExportEnabled: true,
  });
  assert.equal(warnings.length, 4);
  assert.doesNotMatch(warnings.join(" "), /dev-secret/);
});

test("quality cleanup keeps local files and completion state when DELETE fails", async () => {
  let status = 500;
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const runtime = await createTestDir("quality-cleanup");
  try {
    const config = testConfig({ alistUrl: `http://127.0.0.1:${address.port}` });
    const task = new QualityUpgradeTask("BVQUALITY", { SESSDATA: "", bili_jct: "", DedeUserID: "" }, config, {
      userId: "u1",
      mediaId: 1,
      folderTitle: "fav",
      remotePath: "/backup",
      oldFiles: [],
    });
    task.backupFiles = [{ name: "old.mp4", path: "/backup/.quality/old.mp4" }];
    task.downloadDir = runtime;
    await fs.promises.writeFile(path.join(runtime, "new.mp4"), "new");
    let completed = false;
    task.onCompletedUpgrade = () => { completed = true; };
    await assert.rejects(task.runCleanupPhase(), (error: any) => {
      assert.match(error.message, /Failed to delete/);
      assert.equal(error.status, 500);
      return true;
    });
    assert.equal(completed, false);
    assert.equal(fs.existsSync(path.join(runtime, "new.mp4")), true);
    assert.equal(task.qualityStageLabel, "旧文件清理重试中");

    status = 404;
    const alreadyGone = new QualityUpgradeTask("BVQUALITY", { SESSDATA: "", bili_jct: "", DedeUserID: "" }, config, task.target);
    alreadyGone.backupFiles = task.backupFiles;
    let completedAfter404 = false;
    alreadyGone.onCompletedUpgrade = () => { completedAfter404 = true; };
    await alreadyGone.runCleanupPhase();
    assert.equal(completedAfter404, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTestDir(runtime);
  }
});

test("quality cleanup retry is persistent, unbounded and capped at six hours", async () => {
  const runtime = await createTestDir("quality-retry");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  try {
    const jobs = new PersistentJobStore(manager.getDatabase());
    const job = jobs.enqueue({ kind: "quality_cleanup", dedupeKey: "quality-cleanup:u:1:BV", maxAttempts: 1 });
    const claimed = jobs.claimDue(["quality_cleanup"], 1, "owner")[0];
    assert.equal(claimed.id, job.id);
    const result = jobs.retryIndefinitely(job.id, "owner", "DELETE failed", Date.now() + 60_000);
    assert.equal(result.updated, true);
    assert.equal(jobs.findById(job.id)?.status, "retry_wait");
    assert.equal(computeQualityCleanupRetryDelayMs(0, () => 0), 60_000);
    assert.ok(computeQualityCleanupRetryDelayMs(20, () => 1) <= 6 * 60 * 60_000);
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("account retirement reassigns credentials while preserving detached upload targets", async () => {
  const runtime = await createTestDir("account-reassignment");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = [
    { id: "u1", uid: 1, name: "one", cookie: { SESSDATA: "a", bili_jct: "b", DedeUserID: "1" }, favorites: [{ mediaId: 10, title: "one-fav" }], enabled: true, lastLoginAt: "" },
    { id: "u2", uid: 2, name: "two", cookie: { SESSDATA: "c", bili_jct: "d", DedeUserID: "2" }, favorites: [], enabled: true, lastLoginAt: "" },
  ] as any[];
  const userStore = {
    list: () => [...users],
    getById: (id: string) => users.find((user) => user.id === id) || null,
  } as any;
  const configStore = { get: () => testConfig() } as any;
  const scheduler = new SyncScheduler(configStore, userStore, manager);
  try {
    scheduler.beginShutdown();
    manager.recordFavoriteItem("u1", 10, "one-fav", { bvid: "BVDETACH", title: "video", upperName: "up" } as any);
    manager.markQueued("BVDETACH", "/backup/one/one-fav", "u1", 10);
    (scheduler as any).jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVDETACH",
      bvid: "BVDETACH",
      payload: { primaryUserId: "u1", primaryMediaId: 10, primaryFolderTitle: "one-fav", downloadUserId: "u1" },
    });
    const result = await scheduler.retireUser(users[0]);
    assert.equal(result.reassignedJobs, 1);
    const job = (scheduler as any).jobStore.findByDedupeKey("download:BVDETACH");
    assert.equal(job.payload.downloadUserId, "u2");
    assert.equal(job.payload.detachedTargets[0].remotePath, "/backup/one/one-fav");
    assert.ok(manager.getRelationStatus("u1", 10, "BVDETACH")?.accountDetachedAt);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("account retirement pauses without an alternate and same-UID login resumes the job", async () => {
  const runtime = await createTestDir("account-pause-resume");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users: any[] = [
    { id: "u1", uid: 1, name: "one", cookie: { SESSDATA: "a", bili_jct: "b", DedeUserID: "1" }, favorites: [{ mediaId: 10, title: "fav" }], enabled: true, lastLoginAt: "" },
  ];
  const userStore = {
    list: () => [...users],
    getById: (id: string) => users.find((user) => user.id === id) || null,
  } as any;
  const scheduler = new SyncScheduler({ get: () => testConfig() } as any, userStore, manager);
  try {
    scheduler.beginShutdown();
    manager.recordFavoriteItem("u1", 10, "fav", { bvid: "BVPAUSED", title: "video", upperName: "up" } as any);
    manager.markQueued("BVPAUSED", "/backup/one/fav", "u1", 10);
    (scheduler as any).jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVPAUSED",
      bvid: "BVPAUSED",
      payload: { primaryUserId: "u1", primaryMediaId: 10, primaryFolderTitle: "fav", downloadUserId: "u1" },
    });
    const retired = await scheduler.retireUser(users[0]);
    assert.equal(retired.pausedJobs, 1);
    let job = (scheduler as any).jobStore.findByDedupeKey("download:BVPAUSED");
    assert.equal(job.status, "retry_wait");
    assert.equal(job.payload.pausedForUserId, "u1");

    users.splice(0, users.length);
    users.push({ id: "u1", uid: 1, name: "one-new", cookie: { SESSDATA: "new", bili_jct: "new", DedeUserID: "1" }, favorites: [], enabled: true, lastLoginAt: "" });
    const restored = scheduler.restoreUserAfterLogin("u1");
    assert.equal(restored.resumedJobs, 1);
    job = (scheduler as any).jobStore.findByDedupeKey("download:BVPAUSED");
    assert.equal(job.status, "pending");
    assert.equal(job.payload.downloadUserId, "u1");
    assert.equal(job.payload.pausedForUserId, undefined);
    assert.equal(manager.getRelationStatus("u1", 10, "BVPAUSED")?.accountDetachedAt, undefined);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});

test("account retirement turns a complete local download into upload work without redownloading", async () => {
  const runtime = await createTestDir("account-local-upload");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const user: any = {
    id: "u1", uid: 1, name: "one", cookie: { SESSDATA: "a", bili_jct: "b", DedeUserID: "1" },
    favorites: [{ mediaId: 10, title: "fav" }], enabled: true, lastLoginAt: "",
  };
  const userStore = { list: () => [user], getById: (id: string) => id === "u1" ? user : null } as any;
  const scheduler = new SyncScheduler({ get: () => testConfig() } as any, userStore, manager);
  const downloadDir = path.join(runtime, "BVLOCAL");
  try {
    scheduler.beginShutdown();
    await fs.promises.mkdir(downloadDir, { recursive: true });
    await fs.promises.writeFile(path.join(downloadDir, "video.mp4"), "complete");
    const now = new Date().toISOString();
    writeDownloadSession(downloadDir, {
      schemaVersion: 1,
      sessionId: "local-session",
      kind: "backup",
      bvid: "BVLOCAL",
      accountUid: 1,
      bbdownCommit: "test",
      configFingerprint: "test",
      configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
      createdAt: now,
      updatedAt: now,
      snapshotAt: now,
      status: "complete",
      pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
      outputs: [{
        pageIndex: 1,
        cid: 1,
        relativePath: "video.mp4",
        size: 8,
        duration: 1,
        videoCodec: "h264",
        quickHash: "hash",
        verifiedAt: now,
      }],
      history: [],
    });
    manager.recordFavoriteItem("u1", 10, "fav", { bvid: "BVLOCAL", title: "video", upperName: "up" } as any);
    manager.markDownloaded("BVLOCAL", downloadDir, [{ userId: "u1", mediaId: 10 }]);
    (scheduler as any).jobStore.enqueue({
      kind: "download",
      dedupeKey: "download:BVLOCAL",
      bvid: "BVLOCAL",
      payload: { primaryUserId: "u1", primaryMediaId: 10, primaryFolderTitle: "fav", downloadUserId: "u1" },
    });
    const retired = await scheduler.retireUser(user);
    assert.equal(retired.directUploadTargets, 1);
    assert.equal((scheduler as any).jobStore.findByDedupeKey("download:BVLOCAL"), null);
    const upload = (scheduler as any).jobStore.list(["upload"])[0];
    assert.equal(upload.payload.localDir, downloadDir);
    assert.deepEqual(upload.payload.files, ["video.mp4"]);
    assert.equal(fs.existsSync(path.join(downloadDir, "video.mp4")), true);
  } finally {
    await scheduler.shutdown(100);
    manager.close();
    await removeTestDir(runtime);
  }
});
