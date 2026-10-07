import { memoryUsers } from './fixtures/memory-users.js';
import { required } from './contract-values.js';
import { inspectLocalArchiveDirectory } from '../src/scheduler/local-archive-evidence.js';
import { createLocalCleanupStorage } from '../src/scheduler/local-cleanup-storage.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/storage.js";
import { cleanupUploadedSessionFiles, readDownloadSession as readDownloadSessionResult, writeDownloadSession } from "../src/download-session.js";
import { SyncScheduler } from "../src/scheduler.js";
import { createLocalCleanup } from '../src/scheduler/local-cleanup.js';
import { inspectLocalCleanupDirectory } from '../src/scheduler/local-cleanup-directory.js';
import type { inspectRemoteFileSize } from '../src/uploader.js';
import { StateManager, type RemoteFileRecord } from "../src/state.js";
import { PersistentJobStore } from "../src/job-store.js";
import { TransferSessionStore } from "../src/transfer-session.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

function readDownloadSession(downloadDir: string) {
  const result = readDownloadSessionResult(downloadDir);
  return result.kind === 'valid' ? result.manifest : null;
}

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
    kind: "backup" as const,
    bvid,
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    snapshotAt: "2026-08-18T00:00:00.000Z",
    status: "complete" as const,
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

function seedVerifiedState(state: StateManager, bvid: string, localDir: string, remoteFiles: RemoteFileRecord[], authorizeCleanup = true) {
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
        biliStatus: "available" as const,
        backupStatus: "verified" as const,
        localDir,
        downloadSession: { id: `${bvid}-session`, localDir, kind: 'backup', status: 'complete', completedPages: remoteFiles.length, totalPages: remoteFiles.length, updatedAt: now },
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
        backupStatus: "verified" as const,
        remotePath: "/archive",
        remoteFiles,
      },
    },
  });
  if (authorizeCleanup) {
    const jobs = new PersistentJobStore(state.getDatabase());
    const job = jobs.enqueue({ kind: "upload" as const, dedupeKey: `cleanup-test:${bvid}`, bvid });
    const transfers = new TransferSessionStore(state.getDatabase());
    const session = transfers.ensurePrepared({ dedupeKey: `cleanup-test:${bvid}`, bvid, localDir, remotePath: "/archive" },
      remoteFiles.map((file) => ({ relativePath: required(file.localRelativePath), name: file.name, expectedSize: required(file.size) })));
    for (const file of remoteFiles) transfers.updateFile(session.id, required(file.localRelativePath), { status: "verified" as const, verifiedAt: Date.now(), putAcceptedAt: Date.now() }, session.generation);
    transfers.updateSession(session.id, { phase: "completed" as const }, session.generation);
    state.recordLocalCleanupPlan(bvid, {
    id: `cleanup:${bvid}`,
    localDir,
    manifestSessionId: `${bvid}-session`,
    reason: "upload_verified",
    transferSessionId: session.id,
    transferGeneration: session.generation,
    createdAt: now,
    files: remoteFiles.map((file) => {
      const stat = fs.lstatSync(path.join(localDir, required(file.localRelativePath)));
      return { relativePath: required(file.localRelativePath), expectedSize: required(file.size), remotePaths: [file.path],
        expectedIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
    }),
    }, job.id);
    jobs.complete(job.id);
    return job.id;
  }
}

function makeScheduler(
  state: StateManager,
  tempRoot: string,
  remoteFileInspector: typeof inspectRemoteFileSize,
) {
  const config = testConfig({ pollIntervalMinutes: 60 });
  return new SyncScheduler(
    { get: () => config },
    memoryUsers([]),
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
  );
}

function makeCleanup(state: StateManager, tempRoot: string, inspectRemote: typeof inspectRemoteFileSize,
  options: { inspectDirectory?: typeof inspectLocalCleanupDirectory; now?: () => number } = {}) {
  let enabled = true;
  let generation = 0;
  const jobStore = new PersistentJobStore(state.getDatabase());
  const service = createLocalCleanup({
    storage: createLocalCleanupStorage(state),
    state, jobs: jobStore, transfers: new TransferSessionStore(state.getDatabase()), tempRoot,
    config: { get: () => testConfig({ pollIntervalMinutes: 60 }) }, now: options.now || Date.now,
    canRun: () => enabled, generation: () => generation, inspectRemote,
    safeCandidate: value => {
      const candidate = path.resolve(value);
      return candidate.startsWith(path.resolve(tempRoot) + path.sep) && !fs.lstatSync(candidate).isSymbolicLink();
    },
    refreshCapacity() {},
    inspectDirectory: options.inspectDirectory,
  });
  return { ...service, jobStore, now: Date.now,
    get busy() { return service.busy; },
    setAdmission(value: boolean) { enabled = value; },
    invalidate() { generation++; },
    stop() { enabled = false; service.stop(); },
  };
}

async function missingCleanupFixture(name: string, nested = false) {
  const runtime = await createTestDir(`cleanup-missing-${name}`);
  const tempRoot = path.join(runtime, 'temp'), bvid = 'BVLOCALMISSING';
  const localDir = nested ? path.join(tempRoot, bvid, 'attempt') : path.join(tempRoot, bvid);
  const options = { statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'bfb.sqlite') };
  let state = new StateManager(options), remoteCalls = 0;
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, 'video.mp4'), 'hello');
  writeManifest(localDir, bvid, [{ relativePath: 'video.mp4', size: 5 }]);
  const jobId = required(seedVerifiedState(state, bvid, localDir, [{ name: 'video.mp4', path: '/archive/video.mp4', size: 5,
    localRelativePath: 'video.mp4', verificationStatus: 'verified' }]));
  const before = required(state.getVideoForLocalCleanup(bvid));
  await fs.promises.rm(localDir, { recursive: true });
  return {
    runtime, tempRoot, bvid, localDir, before, jobId,
    get state() { return state; }, get remoteCalls() { return remoteCalls; },
    reopen() { state.close(); state = new StateManager(options); },
    cleanup(settings: Parameters<typeof makeCleanup>[3] = {}) {
      return makeCleanup(state, tempRoot, async () => { remoteCalls++; return { status: 'verified', remoteSize: 5 }; }, settings);
    },
    async close() { state.close(); await removeTestDir(runtime); },
  };
}

test('missing-directory startup cleanup atomically settles old plans and references after SQLite reopen without remote requests', async () => {
  const f = await missingCleanupFixture('restart'); f.reopen();
  const cleanup = f.cleanup();
  try {
    cleanup.startSweep(); await waitForCondition(() => !cleanup.busy);
    assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0);
    assert.equal(cleanup.jobStore.findById(f.jobId), null);
    const video = required(f.state.getVideoForLocalCleanup(f.bvid));
    assert.equal(video.localDir, undefined); assert.equal(video.downloadSession, undefined);
    assert.equal(video.backupStatus, f.before.backupStatus); assert.deepEqual(video.remoteFiles, f.before.remoteFiles);
    await cleanup.perform(f.bvid, f.localDir); assert.equal(f.remoteCalls, 0);
    f.reopen(); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, undefined);
  } finally { cleanup.stop(); await f.close(); }
});

test('a missing nested attempt directory uses the same completion path', async () => {
  const f = await missingCleanupFixture('nested', true), cleanup = f.cleanup();
  try {
    await cleanup.perform(f.bvid, f.localDir);
    assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).downloadSession, undefined);
    assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('an unavailable temporary root retains the plan and retries instead of treating all children as removed', async () => {
  const f = await missingCleanupFixture('root'); let now = Date.now();
  const cleanup = f.cleanup({ now: () => now });
  try {
    await fs.promises.rm(f.tempRoot, { recursive: true }); await cleanup.request(f.bvid, f.localDir);
    assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1); assert.ok(cleanup.retryState(f.bvid));
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, f.localDir);
    await fs.promises.mkdir(f.tempRoot); now += 60_001; await cleanup.request(f.bvid, f.localDir);
    assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0); assert.equal(cleanup.retryState(f.bvid), undefined);
    assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`directory inspection ${code} remains observable and retryable without consuming proof or plans`, async () => {
    const f = await missingCleanupFixture(code); let failing = true, now = Date.now();
    const cleanup = f.cleanup({ now: () => now, inspectDirectory(root, dir) {
      if (failing) throw Object.assign(new Error(`injected ${code}`), { code });
      return inspectLocalCleanupDirectory(root, dir);
    } });
    try {
      await cleanup.request(f.bvid, f.localDir); assert.ok(cleanup.retryState(f.bvid));
      assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
      assert.deepEqual(required(f.state.getVideoForLocalCleanup(f.bvid)).remoteFiles, f.before.remoteFiles);
      failing = false; now += 60_001; await cleanup.request(f.bvid, f.localDir);
      assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0); assert.equal(f.remoteCalls, 0);
    } finally { cleanup.stop(); await f.close(); }
  });
}

test('a directory recreated between the missing checks is preserved with its cleanup plan', async () => {
  const f = await missingCleanupFixture('recreated'); let inspections = 0;
  const cleanup = f.cleanup({ inspectDirectory(root, dir) {
    inspections++;
    if (inspections === 2) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'new.mp4'), 'new attempt'); }
    return inspectLocalCleanupDirectory(root, dir);
  } });
  try {
    await cleanup.perform(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
    assert.equal(fs.readFileSync(path.join(f.localDir, 'new.mp4'), 'utf8'), 'new attempt'); assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

for (const interruption of ['stop', 'generation', 'job', 'transfer', 'transfer-generation'] as const) {
  test(`missing-directory completion rejects an intervening ${interruption}`, async () => {
    const f = await missingCleanupFixture(interruption); let inspected = false;
    const cleanup = f.cleanup({ inspectDirectory(root, dir) {
      const result = inspectLocalCleanupDirectory(root, dir);
      if (!inspected) {
        inspected = true;
        if (interruption === 'stop') cleanup.setAdmission(false);
        if (interruption === 'generation') cleanup.invalidate();
        if (interruption === 'job') cleanup.jobStore.enqueue({ kind: 'download', bvid: f.bvid, dedupeKey: 'new-download' });
        const transfers = new TransferSessionStore(f.state.getDatabase());
        if (interruption === 'transfer') transfers.ensurePrepared({ dedupeKey: 'new-transfer', bvid: f.bvid, localDir: f.localDir, remotePath: '/new' }, [{ relativePath: 'new.mp4', name: 'new.mp4', expectedSize: 5 }]);
        if (interruption === 'transfer-generation') {
          const plan = required(f.state.getLocalCleanupPlans(f.bvid)[0]);
          const previous = required(transfers.get(required(plan.transferSessionId)));
          const advanced = transfers.ensurePrepared({ dedupeKey: previous.dedupeKey, bvid: f.bvid, localDir: f.localDir, remotePath: '/archive' },
            [{ relativePath: 'video.mp4', name: 'video.mp4', expectedSize: 5 }]);
          transfers.updateSession(advanced.id, { phase: 'completed' }, advanced.generation);
        }
      }
      return result;
    } });
    try {
      await cleanup.perform(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
      assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, f.localDir); assert.equal(f.remoteCalls, 0);
    } finally { cleanup.stop(); await f.close(); }
  });
}

test('changing a checked plan snapshot blocks missing-directory completion', async () => {
  const f = await missingCleanupFixture('new-plan'); let inspected = false;
  const cleanup = f.cleanup({ inspectDirectory(root, dir) {
    const result = inspectLocalCleanupDirectory(root, dir);
    if (!inspected) {
      inspected = true;
      const original = required(f.state.getLocalCleanupPlans(f.bvid)[0]);
      const jobs = new PersistentJobStore(f.state.getDatabase()), job = required(jobs.findById(f.jobId));
      f.state.recordLocalCleanupPlan(f.bvid, { ...original, id: 'new-plan', manifestSessionId: 'new-session' }, job.id);
    }
    return result;
  } });
  try {
    await cleanup.perform(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 2);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, f.localDir); assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('a root replaced between the missing checks keeps the plan and schedules retry', async () => {
  const f = await missingCleanupFixture('root-replaced'); let inspections = 0;
  const cleanup = f.cleanup({ inspectDirectory(root, dir) {
    inspections++;
    if (inspections === 2) { fs.renameSync(root, `${root}-old`); fs.mkdirSync(root); }
    return inspectLocalCleanupDirectory(root, dir);
  } });
  try {
    await cleanup.request(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
    assert.ok(cleanup.retryState(f.bvid)); assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, f.localDir);
    assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('a new download session reference is not cleared by an old missing-directory plan', async () => {
  const f = await missingCleanupFixture('new-session');
  const session = required(f.before.downloadSession);
  f.state.markDownloadPrepared(f.bvid, f.localDir, { ...session, id: 'new-session', status: 'downloading' });
  const cleanup = f.cleanup();
  try {
    await cleanup.perform(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).downloadSession?.id, 'new-session'); assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('missing-directory completion leaves another directory plan and a newer directory reference intact', async () => {
  const f = await missingCleanupFixture('another-directory');
  const other = path.join(f.tempRoot, 'another-attempt'); await fs.promises.mkdir(other);
  await fs.promises.writeFile(path.join(other, 'new.mp4'), 'keep');
  const original = required(f.state.getLocalCleanupPlans(f.bvid)[0]);
  const jobs = new PersistentJobStore(f.state.getDatabase()), job = required(jobs.findById(f.jobId));
  f.state.recordLocalCleanupPlan(f.bvid, { ...original, id: 'other-plan', localDir: other, manifestSessionId: 'new-session' }, job.id);
  f.state.markDownloadPrepared(f.bvid, other, { ...required(f.before.downloadSession), id: 'new-session', localDir: other });
  const cleanup = f.cleanup();
  try {
    await cleanup.perform(f.bvid, f.localDir);
    assert.equal(f.state.getLocalCleanupPlans(f.bvid, f.localDir).length, 0); assert.equal(f.state.getLocalCleanupPlans(f.bvid, other).length, 1);
    assert.equal(required(jobs.findById(f.jobId)).status, 'completed'); assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, other);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).downloadSession?.id, 'new-session');
    assert.equal(fs.readFileSync(path.join(other, 'new.mp4'), 'utf8'), 'keep'); assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('a cleanup commit failure rolls back plan deletion and local references, then retries the transaction', async () => {
  const f = await missingCleanupFixture('rollback'); let now = Date.now();
  const cleanup = f.cleanup({ now: () => now });
  try {
    f.state.getDatabase().db.exec("CREATE TRIGGER reject_cleanup_reference BEFORE UPDATE OF local_dir ON videos WHEN NEW.local_dir IS NULL BEGIN SELECT RAISE(ABORT, 'injected cleanup commit failure'); END");
    await cleanup.request(f.bvid, f.localDir);
    assert.ok(cleanup.retryState(f.bvid)); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 1);
    assert.equal(required(cleanup.jobStore.findById(f.jobId)).status, 'completed');
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, f.localDir);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).downloadSession?.id, f.before.downloadSession?.id);
    f.state.getDatabase().db.exec('DROP TRIGGER reject_cleanup_reference'); now += 60_001;
    await cleanup.request(f.bvid, f.localDir); assert.equal(f.state.getLocalCleanupPlans(f.bvid).length, 0);
    assert.equal(required(f.state.getVideoForLocalCleanup(f.bvid)).localDir, undefined); assert.equal(f.remoteCalls, 0);
  } finally { cleanup.stop(); await f.close(); }
});

test('directory inspection rejects escaped paths and symlink ancestors and distinguishes a missing root', async (t) => {
  const runtime = await createTestDir('cleanup-directory-paths'), root = path.join(runtime, 'temp');
  try {
    await fs.promises.mkdir(root);
    assert.equal(inspectLocalCleanupDirectory(root, path.join(runtime, 'outside')).kind, 'unsafe');
    assert.equal(inspectLocalCleanupDirectory(root, root).kind, 'unsafe');
    assert.equal(inspectLocalCleanupDirectory(root, path.join(root, 'missing', 'child')).kind, 'missing');
    assert.throws(() => inspectLocalCleanupDirectory(path.join(runtime, 'missing-root'), path.join(runtime, 'missing-root', 'child')), /ENOENT/);
    const target = path.join(runtime, 'target'), link = path.join(root, 'linked'); await fs.promises.mkdir(target);
    try { await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('Creating test links is unavailable'); return; } throw error; }
    assert.equal(inspectLocalCleanupDirectory(root, path.join(link, 'missing')).kind, 'unsafe');
  } finally { await removeTestDir(runtime); }
});

test("startup cleanup verifies remote proof before removing a completed local session", async () => {
  const runtime = await createTestDir("local-cleanup-startup");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALCLEAN");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const inspected: string[] = [];
  const cleanup = makeCleanup(state, tempRoot, async (_config, remotePath, expectedSize) => {
    inspected.push(remotePath);
    return { status: "verified" as const, remoteSize: expectedSize };
  });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }];
    writeManifest(localDir, "BVLOCALCLEAN", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALCLEAN", localDir, remoteFiles);

    cleanup.startSweep();
    await waitForCondition(() => !cleanup.busy && !fs.existsSync(localDir));

    assert.deepEqual(inspected, ["/archive/video.mp4"]);
    assert.equal(fs.existsSync(localDir), false);
    const row = state.getDatabase().db.prepare<[string], { local_dir: string | null }>("SELECT local_dir FROM videos WHERE bvid=?").get("BVLOCALCLEAN");
    assert.ok(row);
    assert.equal(row.local_dir, null);
    const video = required(state.getVideoForLocalCleanup('BVLOCALCLEAN'));
    assert.equal(video.downloadSession, undefined);
    assert.equal(video.backupStatus, 'verified');
    assert.deepEqual(video.remoteFiles, remoteFiles);
  } finally {
    cleanup.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test('a commit failure after authorized deletion retries only local bookkeeping without another remote request', async () => {
  const runtime = await createTestDir('cleanup-deleted-commit-failure');
  const tempRoot = path.join(runtime, 'temp'), bvid = 'BVLOCALCOMMIT', localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, 'state.json'), dbPath: path.join(runtime, 'bfb.sqlite') });
  let now = Date.now(), inspections = 0;
  const cleanup = makeCleanup(state, tempRoot, async () => { inspections++; return { status: 'verified', remoteSize: 5 }; }, { now: () => now });
  try {
    await fs.promises.mkdir(localDir, { recursive: true }); await fs.promises.writeFile(path.join(localDir, 'video.mp4'), 'hello');
    writeManifest(localDir, bvid, [{ relativePath: 'video.mp4', size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: 'video.mp4', path: '/archive/video.mp4', size: 5, localRelativePath: 'video.mp4', verificationStatus: 'verified' }]);
    state.getDatabase().db.exec("CREATE TRIGGER reject_cleanup_reference BEFORE UPDATE OF local_dir ON videos WHEN NEW.local_dir IS NULL BEGIN SELECT RAISE(ABORT, 'injected cleanup commit failure'); END");
    await cleanup.request(bvid, localDir);
    assert.equal(fs.existsSync(localDir), false); assert.equal(inspections, 1); assert.ok(cleanup.retryState(bvid));
    assert.equal(state.getLocalCleanupPlans(bvid).length, 1); assert.equal(required(state.getVideoForLocalCleanup(bvid)).localDir, localDir);
    state.getDatabase().db.exec('DROP TRIGGER reject_cleanup_reference'); now += 60_001;
    await cleanup.request(bvid, localDir);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0); assert.equal(cleanup.retryState(bvid), undefined);
    assert.equal(required(state.getVideoForLocalCleanup(bvid)).localDir, undefined);
    assert.equal(required(state.getVideoForLocalCleanup(bvid)).downloadSession, undefined); assert.equal(inspections, 1);
  } finally { cleanup.stop(); state.close(); await removeTestDir(runtime); }
});

test("cleanup plans survive SQLite reopen and are removed only after authorized files are gone", async () => {
  const runtime = await createTestDir("local-cleanup-restart");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALRESTART";
  const localDir = path.join(tempRoot, bvid);
  const options = { statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") };
  let state = new StateManager(options);
  let cleanup: ReturnType<typeof makeCleanup> | undefined;
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }]);
    state.close();
    state = new StateManager(options);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 1);
    cleanup = makeCleanup(state, tempRoot, async () => ({ status: "verified" as const, remoteSize: 5 }));
    await cleanup.perform(bvid, localDir);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), false);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
    assert.equal(state.getDatabase().db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE bvid=?").get(bvid)?.count, 0);
  } finally {
    cleanup?.stop(); state.close(); await removeTestDir(runtime);
  }
});

test("a verified archive alone never authorizes deleting an uncommitted local copy", async () => {
  const runtime = await createTestDir("local-cleanup-no-authorization");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALUNCOMMITTED";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let inspections = 0;
  const cleanup = makeCleanup(state, tempRoot, async () => { inspections++; return { status: "verified" as const, remoteSize: 5 }; });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }], false);
    await cleanup.perform(bvid, localDir);
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(inspections, 0);
  } finally {
    cleanup.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

for (const change of ["same-size replacement", "new active job", "new transfer generation", "runtime generation", "maintenance admission"] as const) {
  test(`cleanup preserves local media when remote verification races with ${change}`, async () => {
    const runtime = await createTestDir("local-cleanup-race");
    const tempRoot = path.join(runtime, "temp");
    const bvid = "BVLOCALRACE";
    const localDir = path.join(tempRoot, bvid);
    const target = path.join(localDir, "video.mp4");
    const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
    const cleanup = makeCleanup(state, tempRoot, async () => {
      if (change === "same-size replacement") {
        await fs.promises.writeFile(target, "other");
        await fs.promises.utimes(target, new Date("2020-01-01"), new Date("2020-01-01"));
      } else if (change === "runtime generation") {
        cleanup.invalidate();
      } else if (change === "maintenance admission") {
        cleanup.setAdmission(false);
      } else if (change === "new active job") {
        cleanup.jobStore.enqueue({ kind: "upload" as const, dedupeKey: "upload:race", bvid, initialStatus: "pending" });
      } else {
        state.getDatabase().db.prepare("UPDATE transfer_sessions SET generation=generation+1, phase='completed' WHERE bvid=?").run(bvid);
      }
      return { status: "verified" as const, remoteSize: 5 };
    });
    try {
      await fs.promises.mkdir(localDir, { recursive: true });
      await fs.promises.writeFile(target, "hello");
      writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
      seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }]);
      await cleanup.perform(bvid, localDir);
      assert.equal(fs.existsSync(target), true);
      assert.equal(state.getLocalCleanupPlans(bvid).length, 1);
    } finally {
      cleanup.stop();
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
  const cleanup = makeCleanup(state, tempRoot, async () => ({ status: "verified" as const, remoteSize: 5 }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    const target = path.join(localDir, "video.mp4");
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }]);
    await fs.promises.unlink(target);
    await cleanup.perform(bvid, localDir);
    assert.equal(fs.existsSync(localDir), false);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
  } finally {
    cleanup.stop(); state.close(); await removeTestDir(runtime);
  }
});

test("startup cleanup skips a BVID while any persistent task is active", async () => {
  const runtime = await createTestDir("local-cleanup-active-job");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALBLOCKED");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const cleanup = makeCleanup(state, tempRoot, async (_config, _remotePath, expectedSize) => ({ status: "verified" as const, remoteSize: expectedSize }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }];
    writeManifest(localDir, "BVLOCALBLOCKED", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALBLOCKED", localDir, remoteFiles);
    cleanup.jobStore.enqueue({ kind: "upload" as const, dedupeKey: "upload:blocked", bvid: "BVLOCALBLOCKED", initialStatus: "pending" });

    cleanup.startSweep();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.ok(state.getDatabase().db.prepare<unknown[], { "local_dir": string | null }>("SELECT local_dir FROM videos WHERE bvid=?").get("BVLOCALBLOCKED"));
  } finally {
    cleanup.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("remote size conflicts keep the local file and enter bounded retry state", async () => {
  const runtime = await createTestDir("local-cleanup-remote-conflict");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALCONFLICT");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const cleanup = makeCleanup(state, tempRoot, async () => ({ status: "mismatch" as const, remoteSize: 7 }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    const remoteFiles = [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }];
    writeManifest(localDir, "BVLOCALCONFLICT", [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, "BVLOCALCONFLICT", localDir, remoteFiles);

    const work = cleanup.request("BVLOCALCONFLICT", localDir);
    assert.ok(work);
    await work;
    assert.equal(fs.existsSync(path.join(localDir, "video.mp4")), true);
    assert.equal(required(cleanup.retryState("BVLOCALCONFLICT")).attempts, 1);
    const retryDelay = required(cleanup.retryState("BVLOCALCONFLICT")).nextAt - cleanup.now();
    assert.ok(retryDelay >= 59_000 && retryDelay <= 60_000);
  } finally {
    cleanup.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("cleanup keeps unconfirmed manifest outputs and never deletes unknown artifacts", async () => {
  const runtime = await createTestDir("local-cleanup-selective");
  const tempRoot = path.join(runtime, "temp");
  const localDir = path.join(tempRoot, "BVLOCALSELECTIVE");
  const state = new StateManager({ statePath: path.join(runtime, "data", "state.json"), dbPath: path.join(runtime, "data", "bfb.sqlite") });
  const cleanup = makeCleanup(state, tempRoot, async (_config, remotePath, expectedSize) => (
    remotePath.endsWith("first.mp4")
      ? { status: "verified" as const, remoteSize: expectedSize }
      : { status: "missing" as const }
  ));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "first.mp4"), "first");
    await fs.promises.writeFile(path.join(localDir, "second.mp4"), "second");
    await fs.promises.writeFile(path.join(localDir, "unknown.bin"), "unknown");
    const remoteFiles = [
      { name: "first.mp4", path: "/archive/first.mp4", size: 5, localRelativePath: "first.mp4", verificationStatus: "verified" as const },
      { name: "second.mp4", path: "/archive/second.mp4", size: 6, localRelativePath: "second.mp4", verificationStatus: "verified" as const },
    ];
    writeManifest(localDir, "BVLOCALSELECTIVE", [
      { relativePath: "first.mp4", size: 5 },
      { relativePath: "second.mp4", size: 6 },
    ]);
    seedVerifiedState(state, "BVLOCALSELECTIVE", localDir, remoteFiles);

    await assert.rejects(() => cleanup.perform("BVLOCALSELECTIVE", localDir));
    assert.equal(fs.existsSync(path.join(localDir, "first.mp4")), true);
    assert.equal(fs.existsSync(path.join(localDir, "second.mp4")), true);
    assert.equal(fs.existsSync(path.join(localDir, "unknown.bin")), true);
  } finally {
    cleanup.stop();
    state.close();
    await removeTestDir(runtime);
  }
});

test("verified local cleanup candidates use the paged SQLite index and exclude active jobs", () => {
  const state = new StateManager({ statePath: path.join(process.cwd(), ".test-runtime", `local-cleanup-page-${Date.now()}.json`) });
  try {
    const plan = state.getDatabase().db.prepare<[], { detail: string }>(`
      EXPLAIN QUERY PLAN
      SELECT v.bvid FROM videos v
      WHERE v.local_dir IS NOT NULL AND v.backup_status IN ('verified','partial_verified')
      ORDER BY v.updated_at ASC, v.bvid ASC
    `).all().map(row => row.detail).join("\n");
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
  const cleanup = makeScheduler(state, tempRoot, async () => ({ status: "verified" as const, remoteSize: 5 }));
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    assert.equal(inspectLocalArchiveDirectory(localDir).status, "unknown");
    await fs.promises.writeFile(path.join(localDir, "first.mp4"), "first");
    writeManifest(localDir, bvid, [
      { relativePath: "first.mp4", size: 5 },
      { relativePath: "missing.mp4", size: 7 },
    ]);
    const proof = inspectLocalArchiveDirectory(localDir);
    assert.equal(proof.status, "unknown");
    assert.equal(proof.retainedBytes, 5);
    assert.equal(proof.verifiedFiles, 1);
    assert.equal(proof.totalFiles, 2);
  } finally {
    cleanup.stop(); state.close(); await removeTestDir(runtime);
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
    assert.equal(required(readDownloadSession(runtime)?.outputs).length, 2);
  } finally { await removeTestDir(runtime); }
});

test("explicit release removes stopped local media without requiring remote success", async () => {
  const runtime = await createTestDir("local-release-no-remote");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALONLY";
  const localDir = path.join(tempRoot, bvid);
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let requests = 0;
  const cleanup = makeCleanup(state, tempRoot, async () => { requests++; throw new Error("must not access remote"); });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(path.join(localDir, "video.mp4"), "hello");
    await fs.promises.writeFile(path.join(localDir, "unknown.txt"), "keep");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [], false);
    state.markUploadFailed(bvid, localDir, "u1", 1, "Remote write rejected");
    const preview = cleanup.preview(bvid);
    assert.ok(preview.candidates);
    assert.equal(preview.candidates[0].requiresExplicitDeletion, true);
    assert.ok(preview.candidates);
    assert.equal(preview.candidates[0].hasVerifiedArchive, false);
    assert.equal(preview.totalBytes, 5);
    assert.equal(cleanup.release(bvid, preview.candidates[0].releaseId, "DELETE").ok, false);
    assert.ok(fs.existsSync(path.join(localDir, "video.mp4")));
    const jobs = new PersistentJobStore(state.getDatabase());
    const running = jobs.enqueue({ kind: "upload" as const, dedupeKey: "release-running", bvid });
    assert.equal(cleanup.release(bvid, preview.candidates[0].releaseId, "DELETE LOCAL").status, 409);
    assert.ok(fs.existsSync(path.join(localDir, "video.mp4")));
    jobs.complete(running.id);
    assert.equal(cleanup.release(bvid, preview.candidates[0].releaseId, "DELETE LOCAL").ok, true);
    await waitForCondition(() => !fs.existsSync(path.join(localDir, "video.mp4")));
    assert.equal(fs.existsSync(path.join(localDir, "unknown.txt")), true);
    assert.equal(requests, 0);
    assert.equal(cleanup.preview(bvid).fileCount, 0);
  } finally { cleanup.stop(); state.close(); await removeTestDir(runtime); }
});

test("manual local release rejects a stale same-size replacement after preview", async () => {
  const runtime = await createTestDir("local-release-stale");
  const tempRoot = path.join(runtime, "temp");
  const bvid = "BVLOCALRELEASESTALE";
  const localDir = path.join(tempRoot, bvid);
  const target = path.join(localDir, "video.mp4");
  const state = new StateManager({ statePath: path.join(runtime, "state.json"), dbPath: path.join(runtime, "bfb.sqlite") });
  let inspections = 0;
  const cleanup = makeCleanup(state, tempRoot, async () => { inspections += 1; return { status: "verified" as const, remoteSize: 5 }; });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }]);
    const preview = cleanup.preview(bvid);
    assert.equal(preview.ok, true);
    assert.equal(preview.fileCount, 1);
    const releaseId = preview.candidates[0].releaseId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.promises.writeFile(target, "other");
    const result = cleanup.release(bvid, releaseId, "DELETE LOCAL");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(fs.existsSync(target), true);
    assert.equal(inspections, 0, "stale UI requests must fail before remote verification or deletion");
  } finally {
    cleanup.stop(); state.close(); await removeTestDir(runtime);
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
  const cleanup = makeCleanup(state, tempRoot, async (_config, remotePath, expectedSize) => {
    inspected.push(remotePath);
    return { status: "verified" as const, remoteSize: expectedSize };
  });
  try {
    await fs.promises.mkdir(localDir, { recursive: true });
    await fs.promises.writeFile(target, "hello");
    writeManifest(localDir, bvid, [{ relativePath: "video.mp4", size: 5 }]);
    seedVerifiedState(state, bvid, localDir, [{ name: "video.mp4", path: "/archive/video.mp4", size: 5, localRelativePath: "video.mp4", verificationStatus: "verified" as const }]);
    const preview = cleanup.preview(bvid);
    assert.equal(preview.ok, true);
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.totalBytes, 5);
    const denied = cleanup.release(bvid, preview.candidates[0].releaseId, "DELETE");
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 400);
    assert.equal(fs.existsSync(target), true);

    const started = cleanup.release(bvid, preview.candidates[0].releaseId, "DELETE LOCAL");
    assert.equal(started.ok, true);
    assert.equal(started.fileCount, 1);
    await waitForCondition(() => !fs.existsSync(target) && state.getLocalCleanupPlans(bvid).length === 0);
    assert.deepEqual(inspected, ["/archive/video.mp4"]);
    assert.equal(state.getLocalCleanupPlans(bvid).length, 0);
  } finally {
    cleanup.stop(); state.close(); await removeTestDir(runtime);
  }
});
