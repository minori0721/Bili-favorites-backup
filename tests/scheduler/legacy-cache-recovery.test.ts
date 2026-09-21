import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { StateManager } from '../../src/state.js';
import { LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, LEGACY_TEMP_CACHE_MARKER } from '../../src/database.js';
import { createLegacyCacheRecovery } from '../../src/scheduler/legacy-cache-recovery.js';
import { createLegacyImportRecovery } from '../../src/scheduler/legacy-import-recovery.js';
import { createArchiveTargets } from '../../src/scheduler/archive-targets.js';
import { recoveryFixture } from '../fixtures/recovery.js';
import { seedQueuedDownload } from '../fixtures/queued-download.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';
import type { AppConfig } from '../../src/config.js';
import type { BiliUser } from '../../src/users.js';

function legacyFixture(config: {get(): AppConfig}, users: {list(): BiliUser[]; getById(id: string): BiliUser | null}, state: StateManager, options: {legacyTempDir: string}) {
  let accepting = true;
  const {jobs, enqueue} = recoveryFixture(state, users.list(), undefined, {config: config.get()});
  const targets = createArchiveTargets({config, state, users, eligible: (user): user is BiliUser => user?.enabled === true, sourceBlocked: () => false});
  const recovery = createLegacyCacheRecovery({
    stateManager: state, legacyTempDir: options.legacyTempDir, canRun: () => accepting, generation: () => 1,
    getMeta: key => state.getDatabase().getMeta(key), setMeta: (key,value) => state.getDatabase().setMeta(key,value),
    findBestRelationForBvid: targets.findBestRelationForBvid, enqueueIfNeeded: enqueue.enqueue, wake: () => {},
  });
  return {recovery, jobs, stop: () => { accepting = false; }};
}

test("legacy local cache recovery is asynchronous, persistent, and skipped after completion", async () => {
  const runtime = await createTestDir("legacy-cache-once");
  const legacyTemp = path.join(runtime, "temp");
  const state = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const user = seedQueuedDownload(state, "BVLEGACYCACHE");
  await fs.promises.mkdir(path.join(legacyTemp, "BVLEGACYCACHE"), { recursive: true });
  await fs.promises.writeFile(path.join(legacyTemp, "BVLEGACYCACHE", "track.part"), "partial");
  const {recovery, jobs, stop} = legacyFixture(
    { get: () => testConfig() },
    { list: () => [user], getById: () => user },
    state,
    { legacyTempDir: legacyTemp }
  );
  try {
    recovery.start();
    assert.equal(recovery.busy, true);
    assert.equal(jobs.countOutstanding(["download"]), 0);
    await recovery.whenIdle();
    assert.equal(state.getDatabase().getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");
    assert.equal(state.getDatabase().getVideo("BVLEGACYCACHE")?.localDir, path.join(legacyTemp, "BVLEGACYCACHE"));
    assert.equal(jobs.countOutstanding(["download"]), 1);

    recovery.start();
    assert.equal(recovery.busy, false);
  } finally {
    stop();
    await recovery.whenIdle();
    state.close();
    await removeTestDir(runtime);
  }
});
test("legacy local cache recovery treats a corrupt manifest as an interrupted legacy directory", async () => {
  const runtime = await createTestDir("legacy-cache-corrupt-manifest");
  const legacyTemp = path.join(runtime, "temp");
  const state = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const user = seedQueuedDownload(state, "BVCORRUPTCACHE");
  const downloadDir = path.join(legacyTemp, "BVCORRUPTCACHE");
  await fs.promises.mkdir(downloadDir, { recursive: true });
  await fs.promises.writeFile(path.join(downloadDir, ".bfb-download.json"), "{broken", "utf8");
  const {recovery, jobs, stop} = legacyFixture(
    { get: () => testConfig() },
    { list: () => [user], getById: () => user },
    state,
    { legacyTempDir: legacyTemp }
  );
  try {
    recovery.start();
    await recovery.whenIdle();
    assert.equal(state.getDatabase().getVideo("BVCORRUPTCACHE")?.localDir, downloadDir);
    assert.equal(jobs.countOutstanding(["download"]), 1);
    assert.equal(state.getDatabase().getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");
  } finally {
    stop();
    await recovery.whenIdle();
    state.close();
    await removeTestDir(runtime);
  }
});
test("legacy cache failure leaves downloads gated only until the attempt settles", async () => {
  const runtime = await createTestDir("legacy-cache-failure");
  const state = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const {recovery, jobs, stop} = legacyFixture(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    state,
    { legacyTempDir: path.join(runtime, "temp") }
  );
  try {
    await fs.promises.writeFile(path.join(runtime, "temp"), "not a directory");
    recovery.start();
    assert.equal(recovery.busy, true);
    await recovery.whenIdle();
    assert.equal(recovery.busy, false);
    assert.equal(state.getDatabase().getMeta(LEGACY_TEMP_CACHE_MARKER), null);
  } finally {
    stop();
    await recovery.whenIdle();
    state.close();
    await removeTestDir(runtime);
  }
});
test("legacy cache scan skips managed sessions and symlinks and retains unresolved BV directories once", async () => {
  const runtime = await createTestDir("legacy-cache-filtering");
  const legacyTemp = path.join(runtime, "temp");
  const managed = path.join(legacyTemp, "BVMANAGEDCACHE");
  const unresolved = path.join(legacyTemp, "BVUNRESOLVEDCACHE");
  const linkTarget = path.join(runtime, "link-target");
  await fs.promises.mkdir(managed, { recursive: true });
  await fs.promises.mkdir(unresolved, { recursive: true });
  await fs.promises.mkdir(linkTarget, { recursive: true });
  await fs.promises.writeFile(path.join(managed, ".bfb-download.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId: "managed",
    kind: "backup" as const,
    bvid: "BVMANAGEDCACHE",
    pages: [],
    outputs: [],
    history: [],
  }));
  await fs.promises.symlink(linkTarget, path.join(legacyTemp, "BVLINKCACHE"), "junction");
  const state = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const {recovery, jobs, stop} = legacyFixture(
    { get: () => testConfig() },
    { list: () => [], getById: () => null },
    state,
    { legacyTempDir: legacyTemp }
  );
  try {
    recovery.start();
    await recovery.whenIdle();
    assert.equal(state.getDatabase().getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");
    assert.equal(jobs.countOutstanding(["download"]), 0);
    recovery.start();
    assert.equal(recovery.busy, false);
    assert.equal(fs.existsSync(unresolved), true);
  } finally {
    stop();
    await recovery.whenIdle();
    state.close();
    await removeTestDir(runtime);
  }
});
test("migration restore invalidates only the matching legacy recovery markers", async () => {
  const runtime = await createTestDir("legacy-import-markers");
  const state = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  let stateRecoveries = 0;
  let cacheChecks = 0;
  const service = createLegacyImportRecovery({
    database: () => state.getDatabase(),
    recoverState: async () => { stateRecoveries++; }, recoverTemp: () => { cacheChecks++; }, wake: () => {},
  });
  try {
    const database = state.getDatabase();
    database.setMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, "complete");
    database.setMeta(LEGACY_TEMP_CACHE_MARKER, "complete");
    const previousMarkers = service.capture();
    await service.resume(["config", "users"], previousMarkers);
    service.afterAdmissionResumed();
    assert.equal(stateRecoveries, 0);
    assert.equal(cacheChecks, 0);
    assert.equal(database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), "complete");
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");

    await service.resume(["state"], previousMarkers);
    service.afterAdmissionResumed();
    assert.equal(stateRecoveries, 1);
    assert.equal(database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER), null);
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), "complete");

    await service.resume(["temp"], previousMarkers);
    assert.equal(cacheChecks, 0);
    service.afterAdmissionResumed();
    assert.equal(cacheChecks, 1);
    assert.equal(database.getMeta(LEGACY_TEMP_CACHE_MARKER), null);
  } finally {
    state.close();
    await removeTestDir(runtime);
  }
});
