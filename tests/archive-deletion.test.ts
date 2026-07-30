import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ArchiveDeletionService, type ArchiveDeletionDavClient } from "../src/archive-deletion.js";
import { getArchiveLibraryNavigation, queryArchiveLibraryItems } from "../src/archive-library.js";
import type { AppConfig } from "../src/config.js";
import { PersistentJobStore } from "../src/job-store.js";
import { StateManager, type FavoriteRelation, type RemoteFileRecord, type VideoArchiveEntry } from "../src/state.js";
import type { BiliUser } from "../src/users.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const now = Date.parse("2026-07-29T00:00:00.000Z");

class FakeDav implements ArchiveDeletionDavClient {
  readonly files = new Map<string, { type: "file" | "directory"; size?: number }>();
  readonly deleteCalls: string[] = [];
  readonly statCalls: string[] = [];
  statFailures = new Map<string, any>();
  deleteFailures = new Map<string, any>();

  async stat(remotePath: string) {
    this.statCalls.push(remotePath);
    const failure = this.statFailures.get(remotePath);
    if (failure) throw failure;
    const file = this.files.get(remotePath);
    if (!file) throw Object.assign(new Error("not found"), { status: 404 });
    return { ...file };
  }

  async deleteFile(remotePath: string) {
    this.deleteCalls.push(remotePath);
    const failure = this.deleteFailures.get(remotePath);
    if (failure) throw failure;
    const file = this.files.get(remotePath);
    if (!file) throw Object.assign(new Error("not found"), { status: 404 });
    if (file.type === "directory" && [...this.files.keys()].some((candidate) => candidate.startsWith(`${remotePath}/`))) {
      throw Object.assign(new Error("directory not empty"), { status: 409 });
    }
    this.files.delete(remotePath);
  }

  async getDirectoryContents(remotePath: string) {
    const prefix = `${remotePath.replace(/\/$/, "")}/`;
    return [...this.files.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map(([filename, file]) => ({ filename, basename: filename.slice(filename.lastIndexOf("/") + 1), ...file }));
  }
}

function user(id = "u1", favorites: Array<{ mediaId: number; title: string }> = [{ mediaId: 10, title: "当前收藏夹" }]): BiliUser {
  return {
    id,
    uid: Number(id.replace(/\D/g, "") || 1),
    name: `账号${id}`,
    avatar: "",
    cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: id },
    favorites,
    enabled: true,
    lastLoginAt: new Date(now).toISOString(),
  };
}

function fakeUserStore(initial: BiliUser[]) {
  let users = [...initial];
  return {
    list: () => [...users],
    getById: (id: string) => users.find((entry) => entry.id === id) || null,
    set: (next: BiliUser[]) => { users = [...next]; },
  };
}

function fakeConfigStore(config: AppConfig) {
  return { get: () => ({ ...config }) };
}

function insertSource(
  manager: StateManager,
  options: {
    userId: string;
    mediaId: number;
    bvid: string;
    active?: boolean;
    paths: Array<{ path: string; size: number; globalProof?: boolean }>;
  }
) {
  const database = manager.getDatabase();
  const at = new Date(now).toISOString();
  const video: VideoArchiveEntry = {
    bvid: options.bvid,
    title: options.bvid,
    upperName: "测试UP",
    firstSeenAt: at,
    lastSeenAt: at,
    biliStatus: "available",
    backupStatus: "verified",
  };
  database.db.prepare(`
    INSERT OR IGNORE INTO videos(
      bvid, backup_status, bili_status, local_dir, access_restriction_type,
      access_last_checked_at, payload_json, updated_at
    ) VALUES(?, 'verified', 'available', NULL, NULL, NULL, ?, ?)
  `).run(options.bvid, JSON.stringify(video), now);
  const remoteFiles: RemoteFileRecord[] = options.paths.map((entry, index) => ({
    name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
    path: entry.path,
    size: entry.size,
    verificationStatus: "verified",
    filenameMetadata: { pageIndex: index + 1 },
  }));
  const relation: FavoriteRelation = {
    userId: options.userId,
    mediaId: options.mediaId,
    bvid: options.bvid,
    folderTitle: `收藏夹${options.mediaId}`,
    firstSeenAt: at,
    lastSeenAt: at,
    activeInFavorite: options.active !== false,
    backupStatus: "verified",
    remoteFiles,
    verifiedAt: at,
  };
  database.db.prepare(`
    INSERT INTO favorite_relations(
      user_id, media_id, bvid, backup_status, active_in_favorite, folder_title,
      fav_order, last_seen_at, favorite_unavailable, self_visible,
      last_remote_check_at, next_remote_check_at, account_detached_at, payload_json, updated_at
    ) VALUES(?, ?, ?, 'verified', ?, ?, NULL, ?, 0, 0, ?, NULL, NULL, ?, ?)
  `).run(options.userId, options.mediaId, options.bvid, options.active === false ? 0 : 1, relation.folderTitle, now, now, JSON.stringify(relation), now);
  const insertFile = database.db.prepare(`
    INSERT INTO remote_files(
      bvid, user_id, media_id, kind, name, remote_path, expected_size, status, updated_at
    ) VALUES(?, ?, ?, 'main', ?, ?, ?, 'verified', ?)
  `);
  for (const entry of options.paths) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    insertFile.run(options.bvid, options.userId, options.mediaId, name, entry.path, entry.size, now);
    if (entry.globalProof) insertFile.run(options.bvid, "", 0, name, entry.path, entry.size, now);
  }
}

function createService(
  manager: StateManager,
  users: ReturnType<typeof fakeUserStore>,
  dav: FakeDav,
  options: {
    schedulerIdle?: () => boolean;
    maintenance?: Array<boolean>;
    now?: () => number;
    config?: AppConfig;
    previewCleanupIntervalMs?: number;
  } = {}
) {
  const config = options.config || testConfig({
    alistDest: "/backup",
    alistUrl: "http://alist:5244",
    alistUsername: "admin",
    alistPassword: "secret",
  });
  return new ArchiveDeletionService(manager, fakeConfigStore(config) as any, users as any, {
    clientFactory: () => dav,
    sleep: async () => undefined,
    now: options.now,
    previewCleanupIntervalMs: options.previewCleanupIntervalMs,
    isSchedulerIdle: options.schedulerIdle || (() => true),
    setMaintenance: (locked) => options.maintenance?.push(locked),
  });
}

function deletionRowCount(manager: StateManager, table: "archive_deletion_items" | "archive_deleted_sources", deletionId: string) {
  return Number((manager.getDatabase().db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE deletion_id=?`).get(deletionId) as any)?.count || 0);
}

async function waitForOperation(service: ArchiveDeletionService, id: string, statuses: string[]) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const operation = service.get(id);
    if (operation && statuses.includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`archive deletion did not reach ${statuses.join("/")}: ${JSON.stringify(service.get(id))}`);
}

test("archive deletion rejects active sources and keeps all remote files when any preflight item conflicts", async () => {
  const runtime = await createTestDir("archive-delete-preflight");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user()]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, {
      userId: "u1", mediaId: 10, bvid: "BVACTIVE", active: true,
      paths: [{ path: "/backup/BVACTIVE.mp4", size: 10 }],
    });
    service = createService(manager, users, dav);
    assert.throws(() => service!.previewSource("u1", 10, "BVACTIVE"), /仍在当前同步收藏夹/);

    insertSource(manager, {
      userId: "u1", mediaId: 11, bvid: "BVHISTORY", active: false,
      paths: [
        { path: "/backup/history/a.mp4", size: 10 },
        { path: "/backup/history/b.mp4", size: 20 },
      ],
    });
    dav.files.set("/backup/history/a.mp4", { type: "file", size: 10 });
    dav.files.set("/backup/history/b.mp4", { type: "file", size: 999 });
    const preview = service.previewSource("u1", 11, "BVHISTORY");
    service.start(preview.id, "DELETE ARCHIVE");
    const failed = await waitForOperation(service, preview.id, ["failed"]);
    assert.equal(failed.conflictCount, 1);
    assert.equal(dav.deleteCalls.length, 0);
    assert.equal(dav.files.has("/backup/history/a.mp4"), true);

    dav.files.set("/backup/history/b.mp4", { type: "file", size: 20 });
    service.retry(preview.id);
    const completed = await waitForOperation(service, preview.id, ["completed"]);
    assert.equal(completed.completedCount, 2);
    assert.equal(dav.files.has("/backup/history/a.mp4"), false);
    assert.equal(dav.files.has("/backup/history/b.mp4"), false);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion retains a shared physical file and only removes the selected source proof", async () => {
  const runtime = await createTestDir("archive-delete-shared");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", []), user("u2", [{ mediaId: 20, title: "保留来源" }])]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    const remotePath = "/backup/shared/video.mp4";
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVSHAREDDELETE", active: false, paths: [{ path: remotePath, size: 42, globalProof: true }] });
    insertSource(manager, { userId: "u2", mediaId: 20, bvid: "BVSHAREDDELETE", active: true, paths: [{ path: remotePath, size: 42 }] });
    dav.files.set(remotePath, { type: "file", size: 42 });
    service = createService(manager, users, dav);
    const preview = service.previewSource("u1", 10, "BVSHAREDDELETE");
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.sharedCount, 1);
    service.start(preview.id, "DELETE ARCHIVE");
    const completed = await waitForOperation(service, preview.id, ["completed"]);
    assert.equal(completed.retainedCount, 1);
    assert.deepEqual(dav.statCalls, [remotePath]);
    assert.equal(dav.deleteCalls.length, 0);
    assert.equal(dav.files.has(remotePath), true);
    const remaining = manager.getDatabase().db.prepare("SELECT user_id, media_id FROM remote_files WHERE remote_path=? ORDER BY user_id").all(remotePath) as any[];
    assert.deepEqual(remaining.map((row) => [row.user_id, row.media_id]), [["", 0], ["u2", 20]]);

    const normal = queryArchiveLibraryItems(manager.getDatabase(), users.list(), { scope: "global", filter: "all" });
    assert.equal(normal.items.length, 1);
    assert.equal(normal.items[0].memberships.some((membership) => membership.userId === "u1"), false);
    const deleted = queryArchiveLibraryItems(manager.getDatabase(), users.list(), { scope: "global", filter: "deleted" });
    assert.equal(deleted.items[0].statusGroup, "deleted");
    assert.equal(deleted.items[0].memberships[0].deletionId, preview.id);
    assert.equal(deleted.items[0].memberships[0].deletionStatus, "completed");

    manager.recordFavoriteItem("u1", 10, "重新加入", {
      bvid: "BVSHAREDDELETE", title: "重新加入", upperName: "测试UP",
    } as any, { favOrder: 1 }, new Date(now + 10_000).toISOString());
    const restored = manager.getDatabase().db.prepare(`
      SELECT status FROM archive_deleted_sources
      WHERE user_id='u1' AND media_id=10 AND bvid='BVSHAREDDELETE'
    `).get() as any;
    assert.equal(restored.status, "restored");
    assert.equal(manager.getRelation("u1", 10, "BVSHAREDDELETE")?.backupStatus, "discovered");
    const visibleAgain = queryArchiveLibraryItems(manager.getDatabase(), users.list(), { scope: "global", filter: "all" });
    assert.equal(visibleAgain.items.some((item) => item.bvid === "BVSHAREDDELETE"), true);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion does not retry authorization failures and never removes unknown directory contents", async () => {
  const runtime = await createTestDir("archive-delete-auth-and-directory");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVAUTHHEAD", active: false, paths: [{ path: "/backup/auth-head.mp4", size: 10 }] });
    dav.statFailures.set("/backup/auth-head.mp4", Object.assign(new Error("secret remote path /backup/auth-head.mp4"), { status: 401 }));
    service = createService(manager, users, dav);
    const headPreview = service.previewSource("u1", 10, "BVAUTHHEAD");
    service.start(headPreview.id, "DELETE ARCHIVE");
    const headFailed = await waitForOperation(service, headPreview.id, ["failed"]);
    assert.equal(headFailed.conflictCount, 1);
    assert.equal(dav.statCalls.filter((entry) => entry === "/backup/auth-head.mp4").length, 1);
    assert.equal(dav.deleteCalls.length, 0);
    assert.equal(JSON.stringify(headFailed).includes("/backup/auth-head.mp4"), false);
    manager.recordFavoriteItem("u1", 10, "重新加入", {
      bvid: "BVAUTHHEAD", title: "重新加入", upperName: "测试UP",
    } as any, { favOrder: 1 }, new Date(now + 1_000).toISOString());
    const restoredFailure = manager.getDatabase().db.prepare(`
      SELECT status FROM archive_deleted_sources WHERE deletion_id=?
    `).get(headPreview.id) as any;
    assert.equal(restoredFailure.status, "restored");
    assert.equal(manager.getRelation("u1", 10, "BVAUTHHEAD")?.backupStatus, "discovered");
    assert.equal(service.get(headPreview.id)?.status, "superseded");
    assert.equal(manager.getDatabase().hasUnfinishedArchiveDeletion(), false);

    insertSource(manager, { userId: "u1", mediaId: 11, bvid: "BVAUTHDELETE", active: false, paths: [{ path: "/backup/folder/auth-delete.mp4", size: 11 }] });
    dav.files.set("/backup/folder/auth-delete.mp4", { type: "file", size: 11 });
    dav.files.set("/backup/folder/unknown.txt", { type: "file", size: 99 });
    dav.deleteFailures.set("/backup/folder/auth-delete.mp4", Object.assign(new Error("forbidden"), { status: 403 }));
    const deletePreview = service.previewSource("u1", 11, "BVAUTHDELETE");
    service.start(deletePreview.id, "DELETE ARCHIVE");
    const deleteFailed = await waitForOperation(service, deletePreview.id, ["failed"]);
    assert.equal(deleteFailed.failedCount, 1);
    assert.equal(dav.deleteCalls.filter((entry) => entry === "/backup/folder/auth-delete.mp4").length, 1);

    dav.deleteFailures.delete("/backup/folder/auth-delete.mp4");
    service.retry(deletePreview.id);
    await waitForOperation(service, deletePreview.id, ["completed"]);
    assert.equal(dav.files.has("/backup/folder/unknown.txt"), true);
    assert.equal(dav.deleteCalls.includes("/backup/folder"), false);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("failed archive deletion can be re-previewed after AList identity changes", async () => {
  const runtime = await createTestDir("archive-delete-repreview");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let config = testConfig({ alistDest: "/backup", alistUrl: "http://alist:5244", alistUsername: "admin", alistPassword: "secret" });
  let service: ArchiveDeletionService | undefined;
  try {
    const remotePath = "/backup/repreview.mp4";
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVREPREVIEW", active: false, paths: [{ path: remotePath, size: 15 }] });
    dav.files.set(remotePath, { type: "file", size: 15 });
    dav.statFailures.set(remotePath, Object.assign(new Error("forbidden"), { status: 403 }));
    service = new ArchiveDeletionService(manager, { get: () => ({ ...config }) } as any, users as any, {
      clientFactory: () => dav,
      sleep: async () => undefined,
      isSchedulerIdle: () => true,
    });
    const first = service.previewSource("u1", 10, "BVREPREVIEW");
    service.start(first.id, "DELETE ARCHIVE");
    await waitForOperation(service, first.id, ["failed"]);
    config = { ...config, alistUsername: "replacement" };
    assert.throws(() => service!.retry(first.id), /请重新预览/);
    const replacement = service.repreview(first.id);
    assert.equal(replacement.status, "preview");
    assert.notEqual(replacement.id, first.id);
    assert.equal(service.get(first.id)?.status, "failed");
    dav.statFailures.delete(remotePath);
    service.start(replacement.id, "DELETE ARCHIVE");
    assert.equal(service.get(first.id)?.status, "superseded");
    await waitForOperation(service, replacement.id, ["completed"]);
    assert.equal(manager.getDatabase().hasUnfinishedArchiveDeletion(), false);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion applies the three persistent transient backoffs before manual retry", async () => {
  const runtime = await createTestDir("archive-delete-backoff");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  const services: ArchiveDeletionService[] = [];
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVBACKOFF", active: false, paths: [{ path: "/backup/backoff.mp4", size: 12 }] });
    dav.statFailures.set("/backup/backoff.mp4", Object.assign(new Error("temporary upstream failure"), { status: 503 }));
    let service = createService(manager, users, dav);
    services.push(service);
    const preview = service.previewSource("u1", 10, "BVBACKOFF");
    service.start(preview.id, "DELETE ARCHIVE");
    const expectedDelays = [60_000, 10 * 60_000, 60 * 60_000];
    for (const expectedDelay of expectedDelays) {
      await waitForOperation(service, preview.id, ["retry_wait"]);
      const job = manager.getDatabase().db.prepare("SELECT not_before, updated_at FROM jobs WHERE kind='archive_delete'").get() as any;
      assert.ok(Number(job.not_before) - Number(job.updated_at) >= expectedDelay - 1_000);
      assert.ok(Number(job.not_before) - Number(job.updated_at) <= expectedDelay + 1_000);
      await service.stop();
      manager.getDatabase().db.prepare("UPDATE jobs SET not_before=0 WHERE kind='archive_delete'").run();
      service = createService(manager, users, dav);
      services.push(service);
    }
    const failed = await waitForOperation(service, preview.id, ["failed"]);
    assert.ok(failed.lastError);
    assert.equal(String(failed.lastError).includes("/backup/backoff.mp4"), false);
    assert.equal(dav.statCalls.filter((entry) => entry === "/backup/backoff.mp4").length, 4);
    assert.equal(Number((manager.getDatabase().db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='archive_delete'").get() as any).count), 0);
  } finally {
    for (const service of services) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion recovers when DELETE succeeded but its response was lost", async () => {
  const runtime = await createTestDir("archive-delete-lost-response");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let first: ArchiveDeletionService | undefined;
  let second: ArchiveDeletionService | undefined;
  try {
    const remotePath = "/backup/lost-response.mp4";
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVLOSTRESPONSE", active: false, paths: [{ path: remotePath, size: 13 }] });
    dav.files.set(remotePath, { type: "file", size: 13 });
    let responseLost = true;
    dav.deleteFile = async (target: string) => {
      dav.deleteCalls.push(target);
      if (responseLost) {
        responseLost = false;
        dav.files.delete(target);
        throw Object.assign(new Error("socket timed out after delete"), { code: "ETIMEDOUT" });
      }
      if (!dav.files.delete(target)) throw Object.assign(new Error("not found"), { status: 404 });
    };
    first = createService(manager, users, dav);
    const preview = first.previewSource("u1", 10, "BVLOSTRESPONSE");
    first.start(preview.id, "DELETE ARCHIVE");
    await waitForOperation(first, preview.id, ["retry_wait"]);
    await first.stop();
    manager.getDatabase().db.prepare("UPDATE jobs SET not_before=0 WHERE kind='archive_delete'").run();
    second = createService(manager, users, dav);
    const completed = await waitForOperation(second, preview.id, ["completed"]);
    assert.equal(completed.completedCount, 1);
    assert.deepEqual(dav.deleteCalls, [remotePath]);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion shutdown has a deadline and leaves the database open until the WebDAV request exits", async () => {
  const runtime = await createTestDir("archive-delete-shutdown");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    const remotePath = "/backup/shutdown.mp4";
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVSHUTDOWN", active: false, paths: [{ path: remotePath, size: 15 }] });
    dav.files.set(remotePath, { type: "file", size: 15 });
    const originalStat = dav.stat.bind(dav);
    let releaseRequest!: () => void;
    let markStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    let firstStat = true;
    dav.stat = async (target: string) => {
      if (firstStat) {
        firstStat = false;
        markStarted();
        await requestGate;
      }
      return originalStat(target);
    };
    service = createService(manager, users, dav);
    const preview = service.previewSource("u1", 10, "BVSHUTDOWN");
    service.start(preview.id, "DELETE ARCHIVE");
    await requestStarted;
    assert.equal(await service.stop(20), false);
    assert.equal(manager.getDatabase().db.open, true);
    releaseRequest();
    await waitForOperation(service, preview.id, ["completed"]);
    assert.equal(await service.stop(1_000), true);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("account previews report active tasks, expire after thirty minutes, and source previews remain idle-only", async () => {
  const runtime = await createTestDir("archive-delete-preview-lifecycle");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const live = user("u1", []);
  const users = fakeUserStore([live]);
  const dav = new FakeDav();
  let currentTime = now;
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVPREVIEWTTL", active: false, paths: [{ path: "/backup/preview-ttl.mp4", size: 14 }] });
    new PersistentJobStore(manager.getDatabase()).enqueue({
      kind: "download", dedupeKey: "download:BVPREVIEWTTL", userId: "u1", mediaId: 10,
      bvid: "BVPREVIEWTTL", payload: {}, notBefore: now,
    });
    service = createService(manager, users, dav, { schedulerIdle: () => false, now: () => currentTime });
    const accountPreview = service.previewAccount(live);
    assert.equal(accountPreview.activeTasks, 1);
    currentTime += 10 * 60_000;
    const reused = service.previewAccount(live);
    assert.equal(reused.id, accountPreview.id);
    assert.equal(reused.expiresAt, accountPreview.expiresAt);
    assert.equal(deletionRowCount(manager, "archive_deletion_items", accountPreview.id), 1);
    assert.equal(deletionRowCount(manager, "archive_deleted_sources", accountPreview.id), 1);
    assert.throws(() => service!.previewSource("u1", 10, "BVPREVIEWTTL"), /任务空闲/);
    currentTime = accountPreview.expiresAt! + 1;
    assert.throws(
      () => service!.validateStart(accountPreview.id, "DELETE REMOTE ARCHIVE"),
      (error: any) => error?.statusCode === 409 && error?.message === "预览已过期，请重新预览"
    );
    const replacement = service.previewAccount(live);
    assert.notEqual(replacement.id, accountPreview.id);
    assert.equal(service.get(accountPreview.id)?.status, "expired");
    assert.equal(deletionRowCount(manager, "archive_deletion_items", accountPreview.id), 0);
    assert.equal(deletionRowCount(manager, "archive_deleted_sources", accountPreview.id), 0);
    assert.throws(
      () => service!.validateStart(accountPreview.id, "DELETE REMOTE ARCHIVE"),
      (error: any) => error?.statusCode === 409 && error?.message === "预览已过期，请重新预览"
    );
    currentTime = accountPreview.expiresAt! + 24 * 60 * 60_000 + 1;
    (service as any).pruneExpiredPreviews();
    assert.equal(service.get(accountPreview.id), undefined);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("preview reuse expires stale snapshots when config, proofs, or source membership changes", async () => {
  const runtime = await createTestDir("archive-delete-preview-reuse-drift");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const live = user("u1", []);
  const users = fakeUserStore([live]);
  const dav = new FakeDav();
  const config = testConfig({ alistDest: "/backup", alistUrl: "http://alist:5244", alistUsername: "admin", alistPassword: "secret" });
  let currentTime = now;
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, {
      userId: "u1", mediaId: 10, bvid: "BVPREVIEWDRIFT", active: false,
      paths: [{ path: "/backup/drift.mp4", size: 10, globalProof: true }],
    });
    service = createService(manager, users, dav, { config, now: () => currentTime });
    const assertReplaced = (previousId: string, nextId: string) => {
      assert.notEqual(nextId, previousId);
      assert.equal(service!.get(previousId)?.status, "expired");
      assert.equal(service!.get(previousId)?.expiresAt, currentTime);
      assert.equal(deletionRowCount(manager, "archive_deletion_items", previousId), 0);
      assert.equal(deletionRowCount(manager, "archive_deleted_sources", previousId), 0);
    };

    const first = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    currentTime += 1;
    config.alistPassword = "changed";
    const identityChanged = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    assertReplaced(first.id, identityChanged.id);

    currentTime += 1;
    config.alistDest = "/another-root";
    const rootChanged = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    assertReplaced(identityChanged.id, rootChanged.id);

    currentTime += 1;
    config.alistDest = "/backup";
    const rootRestored = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    assertReplaced(rootChanged.id, rootRestored.id);

    currentTime += 1;
    manager.getDatabase().db.prepare(`
      UPDATE remote_files SET name='moved.mp4', remote_path='/backup/moved.mp4', updated_at=?
      WHERE bvid='BVPREVIEWDRIFT'
    `).run(currentTime);
    const pathChanged = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    assertReplaced(rootRestored.id, pathChanged.id);

    currentTime += 1;
    manager.getDatabase().db.prepare(`
      UPDATE remote_files SET expected_size=11, updated_at=? WHERE bvid='BVPREVIEWDRIFT'
    `).run(currentTime);
    const sizeChanged = service.previewSource("u1", 10, "BVPREVIEWDRIFT");
    assertReplaced(pathChanged.id, sizeChanged.id);

    const accountPreview = service.previewAccount(live);
    currentTime += 1;
    insertSource(manager, {
      userId: "u1", mediaId: 11, bvid: "BVPREVIEWSOURCE", active: false,
      paths: [{ path: "/backup/source.mp4", size: 12 }],
    });
    const sourceChanged = service.previewAccount(live);
    assertReplaced(accountPreview.id, sourceChanged.id);
    assert.equal(sourceChanged.sourceCount, 2);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("preview cleanup runs on construction, rebind, interval, and releases its timer on stop", async () => {
  const runtime = await createTestDir("archive-delete-preview-cleanup-lifecycle");
  const firstManager = new StateManager({ dbPath: path.join(runtime, "first.sqlite"), statePath: path.join(runtime, "first.json") });
  const secondManager = new StateManager({ dbPath: path.join(runtime, "second.sqlite"), statePath: path.join(runtime, "second.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let currentTime = now;
  let seedFirst: ArchiveDeletionService | undefined;
  let seedSecond: ArchiveDeletionService | undefined;
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(firstManager, { userId: "u1", mediaId: 10, bvid: "BVSTARTCLEAN", active: false, paths: [{ path: "/backup/start.mp4", size: 10 }] });
    seedFirst = createService(firstManager, users, dav, { now: () => currentTime });
    const startupPreview = seedFirst.previewSource("u1", 10, "BVSTARTCLEAN");
    await seedFirst.stop();
    seedFirst = undefined;

    currentTime = startupPreview.expiresAt! + 1;
    service = createService(firstManager, users, dav, { now: () => currentTime, previewCleanupIntervalMs: 5 });
    assert.equal(service.get(startupPreview.id)?.status, "expired");
    assert.equal(deletionRowCount(firstManager, "archive_deletion_items", startupPreview.id), 0);
    assert.equal((service as any).previewCleanupTimer.hasRef(), false);

    insertSource(secondManager, { userId: "u1", mediaId: 11, bvid: "BVREBINDCLEAN", active: false, paths: [{ path: "/backup/rebind.mp4", size: 11 }] });
    seedSecond = createService(secondManager, users, dav, { now: () => currentTime });
    const rebindPreview = seedSecond.previewSource("u1", 11, "BVREBINDCLEAN");
    await seedSecond.stop();
    seedSecond = undefined;

    currentTime = rebindPreview.expiresAt! + 1;
    service.rebind(secondManager.getDatabase());
    assert.equal(service.get(rebindPreview.id)?.status, "expired");
    assert.equal(deletionRowCount(secondManager, "archive_deletion_items", rebindPreview.id), 0);

    const intervalPreview = service.previewSource("u1", 11, "BVREBINDCLEAN");
    currentTime = intervalPreview.expiresAt! + 1;
    for (let attempt = 0; attempt < 50 && service.get(intervalPreview.id)?.status !== "expired"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(service.get(intervalPreview.id)?.status, "expired");
    assert.equal(deletionRowCount(secondManager, "archive_deletion_items", intervalPreview.id), 0);
    assert.equal(await service.stop(), true);
    assert.equal((service as any).previewCleanupTimer, null);
    service = undefined;
  } finally {
    if (seedFirst) await seedFirst.stop();
    if (seedSecond) await seedSecond.stop();
    if (service) await service.stop();
    firstManager.close();
    secondManager.close();
    await removeTestDir(runtime);
  }
});

test("preview cleanup never removes operational deletion records or their details", async () => {
  const runtime = await createTestDir("archive-delete-preview-cleanup-statuses");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let currentTime = now;
  let service: ArchiveDeletionService | undefined;
  try {
    const statuses = ["pending", "running", "retry_wait", "failed", "completed", "superseded"];
    service = createService(manager, users, dav, { now: () => currentTime });
    for (const [index, status] of statuses.entries()) {
      const bvid = `BVKEEP${String(index).padStart(3, "0")}`;
      insertSource(manager, {
        userId: "u1", mediaId: 100 + index, bvid, active: false,
        paths: [{ path: `/backup/keep-${index}.mp4`, size: index + 1 }],
      });
      const preview = service.previewSource("u1", 100 + index, bvid);
      const database = manager.getDatabase().db;
      database.prepare("UPDATE archive_deletions SET status=? WHERE id=?").run(status, preview.id);
      database.prepare("UPDATE archive_deletion_items SET status=? WHERE deletion_id=?").run(status, preview.id);
      database.prepare("UPDATE archive_deleted_sources SET status=? WHERE deletion_id=?").run(status, preview.id);
      currentTime = preview.expiresAt! + 48 * 60 * 60_000;
      (service as any).pruneExpiredPreviews();
      assert.equal(service.get(preview.id)?.status, status);
      assert.equal(deletionRowCount(manager, "archive_deletion_items", preview.id), 1);
      assert.equal(deletionRowCount(manager, "archive_deleted_sources", preview.id), 1);
      if (["pending", "running", "retry_wait"].includes(status)) {
        database.prepare("UPDATE archive_deletions SET status='completed' WHERE id=?").run(preview.id);
      }
    }
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion treats missing files as idempotent success and rejects local proof drift before WebDAV", async () => {
  const runtime = await createTestDir("archive-delete-drift");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVMISSING", active: false, paths: [{ path: "/backup/missing.mp4", size: 8 }] });
    service = createService(manager, users, dav);
    const missingPreview = service.previewSource("u1", 10, "BVMISSING");
    service.start(missingPreview.id, "DELETE ARCHIVE");
    const missing = await waitForOperation(service, missingPreview.id, ["completed"]);
    assert.equal(missing.completedCount, 1);
    assert.equal(dav.deleteCalls.length, 0);

    insertSource(manager, { userId: "u1", mediaId: 11, bvid: "BVDRIFT", active: false, paths: [{ path: "/backup/drift-a.mp4", size: 9 }] });
    dav.files.set("/backup/drift-a.mp4", { type: "file", size: 9 });
    const driftPreview = service.previewSource("u1", 11, "BVDRIFT");
    manager.getDatabase().db.prepare(`
      INSERT INTO remote_files(bvid,user_id,media_id,kind,name,remote_path,expected_size,status,updated_at)
      VALUES('BVDRIFT','u1',11,'main','drift-b.mp4','/backup/drift-b.mp4',10,'verified',?)
    `).run(now + 1);
    assert.throws(() => service!.start(driftPreview.id, "DELETE ARCHIVE"), /证明已变化/);
    assert.equal(dav.deleteCalls.length, 0);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive deletion recovers a persisted pending job and holds maintenance through completion", async () => {
  const runtime = await createTestDir("archive-delete-recovery");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const users = fakeUserStore([user("u1", [])]);
  const dav = new FakeDav();
  const maintenance: boolean[] = [];
  let first: ArchiveDeletionService | undefined;
  let second: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVRECOVER", active: false, paths: [{ path: "/backup/recover.mp4", size: 14 }] });
    dav.files.set("/backup/recover.mp4", { type: "file", size: 14 });
    first = createService(manager, users, dav);
    const preview = first.previewSource("u1", 10, "BVRECOVER");
    await first.stop();
    const database = manager.getDatabase();
    database.db.prepare("UPDATE archive_deletions SET status='pending', started_at=?, updated_at=? WHERE id=?").run(now, now, preview.id);
    database.db.prepare("UPDATE archive_deleted_sources SET status='pending' WHERE deletion_id=?").run(preview.id);
    new PersistentJobStore(database).enqueue({
      kind: "archive_delete",
      dedupeKey: `archive-delete:${preview.id}`,
      userId: "u1",
      mediaId: 10,
      bvid: "BVRECOVER",
      priority: 5,
      payload: { deletionId: preview.id },
      maxAttempts: 4,
      notBefore: Date.now(),
    });
    second = createService(manager, users, dav, { maintenance });
    const completed = await waitForOperation(second, preview.id, ["completed"]);
    assert.equal(completed.completedCount, 1);
    assert.equal(maintenance.includes(true), true);
    assert.equal(maintenance.at(-1), false);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive account snapshots preserve local browsing and defer same-UID restore while cleanup is unfinished", async () => {
  const runtime = await createTestDir("archive-delete-account");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const live = user("u1", [{ mediaId: 10, title: "账号归档" }]);
  const users = fakeUserStore([live]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVACCOUNT", active: true, paths: [{ path: "/backup/account.mp4", size: 16 }] });
    service = createService(manager, users, dav);
    service.rememberAccount(live);
    service.markAccountRemoved(live.id);
    users.set([]);
    assert.equal(service.isKnownOwner("u1"), true);
    const navigation = getArchiveLibraryNavigation(manager.getDatabase(), users.list());
    assert.equal(navigation.accounts[0].removed, true);
    assert.equal(queryArchiveLibraryItems(manager.getDatabase(), users.list(), { scope: "account", userId: "u1" }).items[0].playback.available, true);

    users.set([live]);
    const preview = service.previewAccount(live);
    manager.getDatabase().db.prepare("UPDATE archive_deletions SET status='failed' WHERE id=?").run(preview.id);
    assert.equal(service.restoreAccount("u1"), false);
    assert.equal(manager.getDatabase().hasUnfinishedArchiveAccountDeletion("u1"), true);
    assert.equal(getArchiveLibraryNavigation(manager.getDatabase(), users.list()).accounts[0].removed, true);
    manager.getDatabase().db.prepare("UPDATE archive_deletions SET status='completed' WHERE id=?").run(preview.id);
    assert.equal(service.restoreAccount("u1"), true);
    assert.equal(service.isKnownOwner("u1"), true);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("archive account preview folds 9065 proof rows into 4533 physical paths", async () => {
  const runtime = await createTestDir("archive-delete-dedup-large");
  const manager = new StateManager({ dbPath: path.join(runtime, "bfb.sqlite"), statePath: path.join(runtime, "missing.json") });
  const live = user("u1", []);
  const users = fakeUserStore([live]);
  const dav = new FakeDav();
  let currentTime = now;
  let service: ArchiveDeletionService | undefined;
  try {
    const database = manager.getDatabase();
    insertSource(manager, { userId: "u1", mediaId: 10, bvid: "BVLARGE", active: false, paths: [] });
    const insert = database.db.prepare(`
      INSERT INTO remote_files(bvid,user_id,media_id,kind,name,remote_path,expected_size,status,updated_at)
      VALUES('BVLARGE',?,?,?,?,?,?, 'verified', ?)
    `);
    database.db.transaction(() => {
      for (let index = 0; index < 4533; index += 1) {
        const remotePath = `/backup/large/p${String(index).padStart(4, "0")}.mp4`;
        insert.run("u1", 10, "main", `p${index}.mp4`, remotePath, index + 1, now);
        if (index < 4532) insert.run("", 0, "main", `p${index}.mp4`, remotePath, index + 1, now);
      }
    })();
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM remote_files").get() as any).count), 9065);
    service = createService(manager, users, dav, { now: () => currentTime });
    const preview = service.previewAccount(live);
    assert.equal(preview.sourceCount, 1);
    assert.equal(preview.fileCount, 4533);
    assert.equal(preview.conflictCount, 0);
    currentTime += 10 * 60_000;
    const repeated = await Promise.all(Array.from({ length: 6 }, async () => service!.previewAccount(live)));
    assert.deepEqual(new Set(repeated.map((entry) => entry.id)), new Set([preview.id]));
    assert.equal(repeated.every((entry) => entry.expiresAt === preview.expiresAt), true);
    assert.equal(deletionRowCount(manager, "archive_deletion_items", preview.id), 4533);
    assert.equal(deletionRowCount(manager, "archive_deleted_sources", preview.id), 1);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM archive_deletions WHERE status='preview'").get() as any).count), 1);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM remote_files").get() as any).count), 9065);
  } finally {
    if (service) await service.stop();
    manager.close();
    await removeTestDir(runtime);
  }
});

test("schema 7 archive deletion audit survives migration database backup and replacement", async () => {
  const runtime = await createTestDir("archive-delete-migration-roundtrip");
  const source = new StateManager({ dbPath: path.join(runtime, "source.sqlite"), statePath: path.join(runtime, "source.json") });
  const target = new StateManager({ dbPath: path.join(runtime, "target.sqlite"), statePath: path.join(runtime, "target.json") });
  const live = user("u1", []);
  const users = fakeUserStore([live]);
  const dav = new FakeDav();
  let service: ArchiveDeletionService | undefined;
  try {
    insertSource(source, { userId: "u1", mediaId: 10, bvid: "BVMIGRATION", active: false, paths: [{ path: "/backup/migration.mp4", size: 18 }] });
    service = createService(source, users, dav);
    service.rememberAccount(live);
    service.markAccountRemoved(live.id);
    const preview = service.previewSource("u1", 10, "BVMIGRATION");
    source.getDatabase().db.prepare("UPDATE archive_deletions SET status='completed', completed_at=? WHERE id=?").run(now, preview.id);
    source.getDatabase().db.prepare("UPDATE archive_deleted_sources SET status='completed', deleted_at=? WHERE deletion_id=?").run(now, preview.id);
    const exported = path.join(runtime, "exported.sqlite");
    await source.backupDatabase(exported);

    const replacement = await target.beginDatabaseReplacement(exported);
    await replacement.commit();
    const operation = target.getDatabase().db.prepare("SELECT status FROM archive_deletions WHERE id=?").get(preview.id) as any;
    const snapshot = target.getDatabase().db.prepare("SELECT removed_at FROM archive_accounts WHERE user_id='u1'").get() as any;
    assert.equal(operation.status, "completed");
    assert.ok(Number(snapshot.removed_at) > 0);
    assert.equal(target.getDatabase().db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(target.getDatabase().db.pragma("foreign_key_check"), []);
  } finally {
    if (service) await service.stop();
    source.close();
    target.close();
    await removeTestDir(runtime);
  }
});
