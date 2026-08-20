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
  } as any, { favOrder: 1 }, new Date(now).toISOString());
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
    { get: () => testConfig() } as any,
    { list: () => users, getById: (id: string) => users.find((item) => item.id === id) || null } as any,
    manager,
  ) as any;
  scheduler.stop();
  return { runtime, manager, scheduler };
}

test("source deletion blocks a shared task when any target matches, while other sources remain runnable", async () => {
  const fixture = await createScheduler("source-deletion-target-gate", [user("u1", 1), user("u2", 2)]);
  try {
    fixture.scheduler.setArchiveDeletionMaintenance(true, {
      id: "source-delete",
      status: "running",
      scope: "source",
      userId: "u1",
      mediaId: 1,
      bvid: "BVSHAREDGATE",
    });
    const shared = {
      bvid: "BVSHAREDGATE",
      targets: [
        { userId: "u2", mediaId: 2 },
        { userId: "u1", mediaId: 1 },
      ],
    };
    assert.equal(fixture.scheduler.isArchiveDeletionTargetBlocked(shared), true);
    assert.equal(fixture.scheduler.isArchiveDeletionTargetBlocked({
      bvid: "BVSHAREDGATE",
      targets: [{ userId: "u2", mediaId: 2 }],
    }), false);
    assert.equal(fixture.scheduler.isArchiveDeletionTargetBlocked({
      bvid: "BVOTHER",
      targets: [{ userId: "u1", mediaId: 1 }],
    }), false);
  } finally {
    fixture.manager.close();
    await removeTestDir(fixture.runtime);
  }
});

test("source preparation trims shared download and quality targets without touching the other account", async () => {
  const fixture = await createScheduler("source-deletion-target-trim", [user("u1", 1), user("u2", 2)]);
  try {
    const { scheduler } = fixture;
    scheduler.setArchiveDeletionMaintenance(true, {
      id: "source-delete",
      status: "pending",
      scope: "source",
      userId: "u1",
      mediaId: 1,
      bvid: "BVTRIMQUALITY",
    });
    const quality = scheduler.jobStore.enqueue({
      kind: "quality_download",
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
    const trimmed = scheduler.jobStore.findById(quality.id)!;
    assert.deepEqual(trimmed.payload.targets.map((target: any) => [target.userId, target.mediaId]), [["u2", 2]]);
    assert.deepEqual([trimmed.payload.target.userId, trimmed.payload.target.mediaId], ["u2", 2]);
    assert.equal(trimmed.payload.downloadUserId, "u2");

    scheduler.setArchiveDeletionMaintenance(true, {
      id: "source-delete-download",
      status: "pending",
      scope: "source",
      userId: "u1",
      mediaId: 1,
      bvid: "BVTRIMDOWNLOAD",
    });
    const download = scheduler.jobStore.enqueue({
      kind: "download",
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
    const retained = scheduler.jobStore.findById(download.id)!;
    assert.deepEqual(retained.payload.detachedTargets.map((target: any) => [target.userId, target.mediaId]), [["u2", 2]]);
  } finally {
    fixture.manager.close();
    await removeTestDir(fixture.runtime);
  }
});

test("blocked quality targets are removed during task recovery and cannot create a replacement upload", async () => {
  const fixture = await createScheduler("source-deletion-quality-recovery", [user("u1", 1), user("u2", 2)]);
  try {
    addDeletionBlock(fixture.manager, "u1", 1, "BVQUALITYBLOCK");
    const task = fixture.scheduler.buildQualityUpgradeTask({
      kind: "quality_download",
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
    assert.deepEqual(task.targets.map((target: any) => [target.userId, target.mediaId]), [["u2", 2]]);

    const blockedOnly = fixture.scheduler.buildQualityUpgradeTask({
      kind: "quality_download",
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

    const queued = fixture.scheduler.queueUploadWork({
      bvid: "BVQUALITYBLOCK",
      localDir: "/tmp/does-not-need-to-exist",
      remotePath: "/backup/a",
      userId: "u1",
      mediaId: 1,
      folderTitle: "A",
      files: ["video.mp4"],
    });
    assert.equal(queued, false);
    assert.equal(fixture.scheduler.jobStore.findByDedupeKey("upload:u1:1:BVQUALITYBLOCK:/backup/a:main"), null);
  } finally {
    fixture.manager.close();
    await removeTestDir(fixture.runtime);
  }
});
