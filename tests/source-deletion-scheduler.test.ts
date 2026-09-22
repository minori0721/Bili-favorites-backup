import { sourceAdmissionBlocked } from '../src/scheduler/source-admission.js';
import { createUploadAdmission } from '../src/scheduler/upload-admission.js';
import { buildQualityUpgradeTask } from '../src/scheduler/quality-task-factory.js';
import { PersistentJobStore } from '../src/job-store.js';
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import type { BiliUser } from "../src/users.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

function user(id: string, mediaId: number): BiliUser {
  return {
    id,
    uid: Number(id.replace(/\D/g, "") || 1),
    name: `账号${id}`,
    avatar: "",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: id },
    favorites: [{ mediaId, title: `收藏夹${mediaId}` }],
    enabled: true,
    lastLoginAt: new Date().toISOString(),
  };
}

function addDeletionBlock(manager: StateManager, userId: string, mediaId: number, bvid: string) {
  const database = manager.getDatabase();
  const now = Date.now();
  manager.recordFavoriteItem(userId, mediaId, `收藏夹${mediaId}`, {
    bvid,
    title: bvid,
    upperName: "测试UP",
  }, { favOrder: 1 }, new Date(now).toISOString());
  database.db.prepare(`
    INSERT INTO archive_deletions(
      id, scope, user_id, media_id, bvid, status, alist_identity_hash, archive_root,
      created_at, updated_at
    ) VALUES(?, 'source', ?, ?, ?, 'completed', 'test', '/backup', ?, ?)
  `).run(`deletion-${bvid}`, userId, mediaId, bvid, now, now);
  database.db.prepare(`
    INSERT INTO archive_deleted_sources(user_id, media_id, bvid, deletion_id, status, deleted_at)
    VALUES(?, ?, ?, ?, 'completed', ?)
  `).run(userId, mediaId, bvid, `deletion-${bvid}`, now);
}

async function createScheduler(name: string, users: BiliUser[]) {
  const runtime = await createTestDir(name);
  const manager = new StateManager({
    statePath: path.join(runtime, "data", "state.json"),
    dbPath: path.join(runtime, "data", "bfb.sqlite"),
  });
  const scheduler = new SyncScheduler(
    { get: () => testConfig() },
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null, updatePartial: () => null },
    manager,
    {deferAdmissionUntilStart: true},
  );
  const jobs = new PersistentJobStore(manager.getDatabase());
  return { runtime, manager, scheduler, jobs, users };
}

test("source deletion blocks every shared target while leaving unrelated sources runnable", () => {
  const scope = {scope: 'source', userId: 'u1', mediaId: 1, bvid: 'BVSHAREDGATE'};
  const shared = {bvid: scope.bvid, targets: [{userId: 'u2', mediaId: 2}, {userId: 'u1', mediaId: 1}]};
  assert.equal(sourceAdmissionBlocked(false, scope, shared), true);
  assert.equal(sourceAdmissionBlocked(false, scope, {bvid: scope.bvid, targets: [{userId: 'u2', mediaId: 2}]}), false);
  assert.equal(sourceAdmissionBlocked(false, scope, {bvid: 'BVOTHER', targets: [{userId: 'u1', mediaId: 1}]}), false);
  assert.equal(sourceAdmissionBlocked(false, scope, {bvid: scope.bvid}, shared), true);
  assert.equal(sourceAdmissionBlocked(true, null, {bvid: 'BVOTHER'}), true);
});

test("source preparation trims shared download and quality targets without touching the other account", async () => {
  const fixture = await createScheduler("source-deletion-target-trim", [user("u1", 1), user("u2", 2)]);
  try {
    const { scheduler } = fixture;
    scheduler.setArchiveDeletionMaintenance(true, {
      id: "source-delete",
      status: "pending" as const,
      scope: "source",
      userId: "u1",
      mediaId: 1,
      bvid: "BVTRIMQUALITY",
    });
    const quality = fixture.jobs.enqueue({
      kind: "quality_download" as const,
      dedupeKey: "quality-download:BVTRIMQUALITY:profile",
      bvid: "BVTRIMQUALITY",
      userId: "u2",
      mediaId: 2,
      initialStatus: "pending",
      payload: {
        bvid: "BVTRIMQUALITY",
        downloadUserId: "u2",
        artifactKey: "profile",
        target: { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
        targets: [
          { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
          { userId: "u2", mediaId: 2, folderTitle: "B", remotePath: "/backup/b" },
        ],
      },
    });
    await scheduler.prepareSourceDeletion("u1", 1, "BVTRIMQUALITY", 1_000);
    const trimmed = fixture.jobs.findById(quality.id)!;
    assert.deepEqual(identities(trimmed.payload.targets), [["u2", 2]]);
    assert.deepEqual(identities([trimmed.payload.target])[0], ["u2", 2]);
    assert.equal(trimmed.payload.downloadUserId, "u2");

    scheduler.setArchiveDeletionMaintenance(true, {
      id: "source-delete-download",
      status: "pending" as const,
      scope: "source",
      userId: "u1",
      mediaId: 1,
      bvid: "BVTRIMDOWNLOAD",
    });
    const download = fixture.jobs.enqueue({
      kind: "download" as const,
      dedupeKey: "download:BVTRIMDOWNLOAD",
      bvid: "BVTRIMDOWNLOAD",
      initialStatus: "pending",
      payload: {
        primaryUserId: "u1",
        primaryMediaId: 1,
        detachedTargets: [
          { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
          { userId: "u2", mediaId: 2, folderTitle: "B", remotePath: "/backup/b" },
        ],
      },
    });
    await scheduler.prepareSourceDeletion("u1", 1, "BVTRIMDOWNLOAD", 1_000);
    const retained = fixture.jobs.findById(download.id)!;
    assert.deepEqual(identities(retained.payload.detachedTargets), [["u2", 2]]);
  } finally {
    await fixture.scheduler.shutdown(1000, {closeDatabase: false});
    fixture.manager.close();
    await removeTestDir(fixture.runtime);
  }
});

test("blocked quality targets are removed during task recovery and cannot create a replacement upload", async () => {
  const fixture = await createScheduler("source-deletion-quality-recovery", [user("u1", 1), user("u2", 2)]);
  try {
    addDeletionBlock(fixture.manager, "u1", 1, "BVQUALITYBLOCK");
    const task = buildTask(fixture, {
      kind: "quality_download" as const,
      bvid: "BVQUALITYBLOCK",
      userId: "u2",
      mediaId: 2,
      payload: {
        bvid: "BVQUALITYBLOCK",
        downloadUserId: "u2",
        artifactKey: "profile",
        target: { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
        targets: [
          { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
          { userId: "u2", mediaId: 2, folderTitle: "B", remotePath: "/backup/b" },
        ],
      },
    });
    assert.ok(task);
    assert.deepEqual([task.target.userId, task.target.mediaId], ["u2", 2]);
    assert.deepEqual(task.targets.map((target) => [target.userId, target.mediaId]), [["u2", 2]]);

    const blockedOnly = buildTask(fixture, {
      kind: "quality_download" as const,
      bvid: "BVQUALITYBLOCK",
      userId: "u1",
      mediaId: 1,
      payload: {
        bvid: "BVQUALITYBLOCK",
        downloadUserId: "u1",
        artifactKey: "profile-only",
        target: { userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" },
        targets: [{ userId: "u1", mediaId: 1, folderTitle: "A", remotePath: "/backup/a" }],
      },
    });
    assert.equal(blockedOnly, null);

    const queued = createUploadAdmission({
      jobs: fixture.jobs, blocked: (id, mediaId, bvid) => fixture.manager.getDatabase().isArchiveSourceDeletionBlocked(id, mediaId, bvid),
      build: () => { throw new Error('Deleted source must be rejected before building its upload'); },
      wake: () => { throw new Error('Deleted source must not wake dispatch'); },
    })({
      bvid: "BVQUALITYBLOCK",
      localDir: "/tmp/does-not-need-to-exist",
      remotePath: "/backup/a",
      userId: "u1",
      mediaId: 1,
      folderTitle: "A",
      files: ["video.mp4"],
    });
    assert.equal(queued, false);
    assert.equal(fixture.jobs.findByDedupeKey("upload:u1:1:BVQUALITYBLOCK:/backup/a:main"), null);
  } finally {
    await fixture.scheduler.shutdown(1000, {closeDatabase: false});
    fixture.manager.close();
    await removeTestDir(fixture.runtime);
  }
});

function identities(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.map(item => {
    assert.ok(item && typeof item === 'object' && 'userId' in item && 'mediaId' in item);
    return [item.userId, item.mediaId];
  });
}
function buildTask(fixture: Awaited<ReturnType<typeof createScheduler>>, input: Omit<Parameters<PersistentJobStore['enqueue']>[0], 'dedupeKey'> & {dedupeKey?: string}) {
  const job = fixture.jobs.enqueue({...input, dedupeKey: input.dedupeKey || `quality:${fixture.jobs.list(['quality_download'], 100).length}`});
  return buildQualityUpgradeTask(job, {
    config: {get: () => testConfig()}, users: {getById: id => fixture.users.find(user => user.id === id) || null},
    state: fixture.manager, jobs: fixture.jobs,
    isArchiveSourceDeletionBlocked: (u, m, b) => fixture.manager.getDatabase().isArchiveSourceDeletionBlocked(u, m, b),
    isUserSyncEligible: (user): user is BiliUser => Boolean(user?.enabled),
    leaseOwner: 'test', now: Date.now, qualityArtifactCleanupLocks: { acquire: () => undefined, release: () => undefined },
    refreshLocalCacheState() {}, pokeDownloadQueue() {}, dispatchPersistentJobs() {},
    reconcileObsoleteVerifiedArchiveRecoveries: async () => undefined,
  });
}
