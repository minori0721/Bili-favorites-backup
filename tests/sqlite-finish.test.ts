import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildAppInfo } from "../src/app-info.js";
import { StateDatabase } from "../src/database.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { writeJsonFile } from "../src/storage.js";
import { renderAppPage, renderLoginPage } from "../src/web.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const timestamp = "2026-07-14T00:00:00.000Z";

function insertVideoRelation(
  database: StateDatabase,
  bvid: string,
  status: string,
  localDir: string | null,
  index = 0
) {
  const video = {
    bvid,
    title: `Video ${index}`,
    upperName: "Tester",
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    biliStatus: "available",
    backupStatus: status,
    localDir: localDir || undefined,
  };
  const relation = {
    userId: "u1",
    mediaId: 1,
    bvid,
    folderTitle: "Recovery",
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    activeInFavorite: true,
    backupStatus: status,
    remotePath: `/backup/${bvid}`,
  };
  database.db.prepare(`
    INSERT INTO videos(bvid,backup_status,bili_status,local_dir,payload_json,updated_at)
    VALUES(?,?,'available',?,?,?)
  `).run(bvid, status, localDir, JSON.stringify(video), Date.parse(timestamp) + index);
  database.db.prepare(`
    INSERT INTO favorite_relations(user_id,media_id,bvid,backup_status,active_in_favorite,
      folder_title,last_seen_at,payload_json,updated_at)
    VALUES('u1',1,?,?,1,'Recovery',?,?,?)
  `).run(bvid, status, Date.parse(timestamp) + index, JSON.stringify(relation), Date.parse(timestamp) + index);
}

function writeCompleteManifest(localDir: string) {
  writeJsonFile(path.join(localDir, ".bfb-download.json"), {
    schemaVersion: 1,
    sessionId: "shared-session",
    kind: "backup",
    bvid: "BVSHARED",
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "1080P", encoding: "HEVC", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: timestamp,
    updatedAt: timestamp,
    snapshotAt: timestamp,
    status: "complete",
    pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
    outputs: [{ pageIndex: 1, cid: 1, relativePath: "video.mp4", size: 1, duration: 1, videoCodec: "HEVC", quickHash: "test", verifiedAt: timestamp }],
    history: [],
  });
}

test("application info derives safe dev, release, and local build labels", () => {
  const metadata = { version: "2.4.0", homepage: "https://github.com/minori0721/Bili-favorites-backup" };
  const revision = "7f0e71689d68e3a061e8609da3152561964cb509";
  const dev = buildAppInfo({ BFB_BUILD_REF: "dev", BFB_BUILD_REVISION: revision }, metadata);
  assert.equal(dev.versionLabel, "v2.4.0 · dev@7f0e716");
  assert.equal(dev.versionUrl, `${metadata.homepage}/commit/${revision}`);

  const release = buildAppInfo({ BFB_BUILD_REF: "v2.4.0", BFB_BUILD_REVISION: revision }, metadata);
  assert.equal(release.versionLabel, "v2.4.0 · 7f0e716");

  const local = buildAppInfo({}, metadata);
  assert.equal(local.versionLabel, "v2.4.0 · local");
  assert.equal(local.versionUrl, metadata.homepage);

  const unsafe = buildAppInfo({ BFB_BUILD_REF: "<script>", BFB_BUILD_REVISION: "javascript:alert(1)" }, {
    version: "not-semver",
    homepage: "https://example.com/steal",
  });
  assert.equal(unsafe.versionLabel, "v0.0.0 · local");
  assert.equal(unsafe.repositoryUrl, metadata.homepage);

  for (const html of [renderLoginPage(), renderAppPage()]) {
    assert.match(html, /class="version-link/);
    assert.match(html, /class="github-link/);
    assert.match(html, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
    assert.match(html, /%2339C5BB/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /https:\/\/github\.com\/minori0721\/Bili-favorites-backup/);
  }
  assert.match(renderAppPage(), /class="app-brand"/);
  assert.match(renderAppPage(), /class="header-actions"/);
  assert.match(renderAppPage(), /setInterval\(\(\) => \{[\s\S]*?refreshQueueBoard\(\);[\s\S]*?\}, 1000\)/);
  assert.match(renderAppPage(), /visibilitychange/);
  assert.match(renderAppPage(), /if \(document\.hidden\) stopQueueBoardPolling\(\)/);
  assert.match(renderLoginPage(), /class="login-meta"/);
});

test("runtime failure and cooldown changes update only their SQLite rows", async () => {
  const runtime = await createTestDir("sqlite-row-crud");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const database = new StateDatabase(dbPath);
  insertVideoRelation(database, "BVFAIL", "discovered", null);
  database.upsertFailure("u2", {
    bvid: "BVOTHER",
    mediaId: 2,
    failedAt: timestamp,
    reason: "unrelated",
    permanent: true,
  });
  database.close();
  const dirtyFailures: boolean[] = [];
  const manager = new StateManager({
    dbPath,
    statePath: path.join(runtime, "missing.json"),
    onFlush: (dirty) => dirtyFailures.push(dirty.failures),
  });
  try {
    manager.markFailed("u1", "BVFAIL", 1, "failed", true);
    assert.equal(manager.getDatabase().db.prepare("SELECT COUNT(*) AS count FROM failures").get().count, 2);
    assert.equal(manager.getDatabase().getFailure("u1", "BVFAIL", 1)?.reason, "failed");
    assert.equal(manager.getDatabase().getFailure("u2", "BVOTHER", 2)?.reason, "unrelated");
    assert.deepEqual(dirtyFailures, [false]);

    manager.clearFailed("u1", 1, "BVFAIL");
    assert.equal(manager.getDatabase().getFailure("u1", "BVFAIL", 1), undefined);
    assert.equal(manager.getDatabase().getFailure("u2", "BVOTHER", 2)?.reason, "unrelated");

    manager.setUserCooldown("u1", "rate limit", 60_000);
    manager.getDatabase().setCooldown("user", "expired", Date.now() - 1, "expired", {
      userId: "expired",
      until: Date.now() - 1,
      reason: "expired",
      setAt: timestamp,
    });
    assert.equal(manager.getUserCooldown("u1")?.reason, "rate limit");
    assert.equal(manager.getUserCooldown("expired"), null);
    assert.deepEqual(Object.keys(manager.getAllCooldowns()), ["u1"]);

    manager.setDownloadApiCooldown({
      until: Date.now() + 60_000,
      reason: "risk",
      probeBvid: "BVFAIL",
      probeUserId: "u1",
      probeMode: "web",
      setAt: timestamp,
    });
    manager.setUploadCooldown({ state: "open", retryAt: Date.now() + 60_000, reason: "backend" });
    manager.clearDownloadApiCooldown();
    assert.equal(manager.getDownloadApiCooldown(), null);
    assert.equal(manager.getUploadCooldown()?.reason, "backend");
    assert.equal(manager.getUserCooldown("u1")?.reason, "rate limit");

    const snapshot = manager.getStateSnapshot();
    assert.equal(snapshot.failedByUser?.u2?.["2:BVOTHER"]?.reason, "unrelated");
    assert.equal(snapshot.userCooldowns?.u1?.reason, "rate limit");
  } finally {
    manager.close();
    await removeTestDir(runtime);
  }
});

test("1000 orphaned upload failures persist in bounded SQL pages and keep the task queue capped", async () => {
  const runtime = await createTestDir("orphan-upload-pages");
  const dbPath = path.join(runtime, "bfb.sqlite");
  const localDir = path.join(runtime, "complete");
  const invalidDir = path.join(runtime, "invalid");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.mkdir(invalidDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "video.mp4"), "x");
  writeCompleteManifest(localDir);
  writeJsonFile(path.join(invalidDir, ".bfb-download.json"), { status: "failed", outputs: [] });

  const database = new StateDatabase(dbPath);
  database.db.transaction(() => {
    for (let index = 0; index < 1000; index += 1) {
      const bvid = `BVORPHAN${String(index).padStart(6, "0")}`;
      insertVideoRelation(database, bvid, "upload_failed", index === 999 ? invalidDir : localDir, index);
    }
  })();
  database.close();

  const enumerations: string[] = [];
  const manager = new StateManager({
    dbPath,
    statePath: path.join(runtime, "missing.json"),
    onFullEnumeration: (kind) => enumerations.push(kind),
  });
  const config = testConfig({ queuePrefetchLimit: 25, concurrentUploads: 2 });
  const user = {
    id: "u1",
    uid: 1,
    name: "Tester",
    enabled: true,
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "Recovery" }],
    lastLoginAt: timestamp,
  };
  const scheduler = new SyncScheduler(
    { get: () => config } as any,
    { list: () => [user], getById: (id: string) => id === user.id ? user : null } as any,
    manager
  ) as any;
  const pageSizes: number[] = [];
  const originalPage = manager.listUploadFailuresForRecoveryPage.bind(manager);
  manager.listUploadFailuresForRecoveryPage = ((cursor: any, limit: number) => {
    const page = originalPage(cursor, limit);
    pageSizes.push(page.items.length);
    return page;
  }) as typeof manager.listUploadFailuresForRecoveryPage;
  try {
    scheduler.uploadQueue.setStartGate(() => false);
    scheduler.recoverOrphanedUploadFailures();
    assert.equal(scheduler.jobStore.countOutstanding(["upload"]), 999);
    assert.equal(scheduler.uploadQueue.getSize(), 25);
    assert.ok(pageSizes.length >= 10);
    assert.ok(pageSizes.every((size) => size <= 100));
    assert.deepEqual(enumerations, []);
    assert.equal(manager.getRelationStatus("u1", 1, "BVORPHAN000999")?.backupStatus, "upload_failed");

    scheduler.recoverOrphanedUploadFailures();
    assert.equal(scheduler.jobStore.countOutstanding(["upload"]), 999);
    assert.equal(scheduler.uploadQueue.getSize(), 25);
  } finally {
    scheduler.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});
