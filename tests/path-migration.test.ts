import assert from "node:assert/strict";
import { test } from "node:test";
import { StateDatabase } from "../src/database.js";
import { PathMigrationService, validateArchiveMigrationRoots, type PathMigrationDavClient } from "../src/path-migration.js";

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    alistUrl: "http://alist:5244",
    alistUsername: "admin",
    alistPassword: "secret",
    alistDest: "/drive/old",
    ...overrides,
  } as any;
}

class FakeDav implements PathMigrationDavClient {
  files = new Map<string, { type: "file" | "directory"; size?: number }>();
  copies: Array<[string, string]> = [];
  constructor() {
    this.files.set("/drive", { type: "directory" });
    this.files.set("/drive/old", { type: "directory" });
    this.files.set("/drive/old/empty", { type: "directory" });
    this.files.set("/drive/old/_history", { type: "directory" });
    this.files.set("/drive/old/_history/旧文件.mp4", { type: "file", size: 7 });
    this.files.set("/drive/old/视频.mp4", { type: "file", size: 11 });
    this.files.set("/drive/new", { type: "directory" });
  }
  async getDirectoryContents(directory: string) {
    const prefix = `${directory.replace(/\/$/, "")}/`;
    return [...this.files.entries()]
      .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes("/"))
      .map(([name, stat]) => ({ filename: name, basename: name.slice(name.lastIndexOf("/") + 1), ...stat }));
  }
  async createDirectory(directory: string) {
    if (this.files.has(directory)) return;
    const parent = directory.slice(0, directory.lastIndexOf("/")) || "/";
    if (parent !== "/" && !this.files.has(parent)) throw Object.assign(new Error("parent missing"), { status: 409 });
    this.files.set(directory, { type: "directory" });
  }
  async copyFile(source: string, destination: string) {
    const sourceStat = this.files.get(source);
    if (!sourceStat) throw Object.assign(new Error("not found"), { status: 404 });
    if (this.files.has(destination)) throw Object.assign(new Error("conflict"), { status: 409 });
    const parent = destination.slice(0, destination.lastIndexOf("/")) || "/";
    if (parent !== "/" && !this.files.has(parent)) throw Object.assign(new Error("parent missing"), { status: 409 });
    this.files.set(destination, { ...sourceStat });
    this.copies.push([source, destination]);
  }
  async stat(target: string) {
    const stat = this.files.get(target);
    if (!stat) throw Object.assign(new Error("not found"), { status: 404 });
    return stat;
  }
  async deleteFile(target: string) {
    for (const name of [...this.files.keys()]) if (name === target || name.startsWith(`${target}/`)) this.files.delete(name);
  }
}

function fakeStore(config: any) {
  return {
    get: () => ({ ...config }),
    update: (patch: any) => Object.assign(config, patch),
  } as any;
}

async function waitFor(service: PathMigrationService, predicate: (state: any) => boolean) {
  for (let i = 0; i < 100; i += 1) {
    const state = service.getState();
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`migration state did not reach expected phase: ${JSON.stringify(service.getState())}`);
}

test("path migration validates mount boundaries and nesting", () => {
  assert.deepEqual(validateArchiveMigrationRoots("/drive/old", "/drive/new"), { source: "/drive/old", destination: "/drive/new" });
  assert.throws(() => validateArchiveMigrationRoots("/drive/old", "/drive/old/sub"), /嵌套/);
  assert.throws(() => validateArchiveMigrationRoots("/drive/old", "/other/new"), /同一AList挂载/);
  assert.throws(() => validateArchiveMigrationRoots("relative", "/drive/new"), /绝对路径/);
});

test("path migration copies the complete tree, switches state, and keeps the old root", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    sleep: async () => undefined,
  });
  const preview = await service.preview("/drive/new");
  await waitFor(service, (state) => state.status === "ready");
  assert.equal(preview.sourceRoot, "/drive/old");
  assert.equal(service.getState()?.entryCount, 4);
  assert.equal(service.getState()?.extraCount, 0);
  await service.start(preview.id);
  const switched = await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.equal(switched.conflictCount, 0);
  assert.equal(config.alistDest, "/drive/new");
  assert.equal(dav.copies.length, 2);
  assert.ok(dav.files.has("/drive/new/视频.mp4"));
  assert.ok(dav.files.has("/drive/new/_history/旧文件.mp4"));
  await service.cleanupOld(preview.id, true);
  assert.equal(service.getState()?.status, "completed");
  assert.ok(dav.files.has("/drive/old/视频.mp4"));
  db.close();
});

test("path migration creates a missing nested destination root", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.files.delete("/drive/new");
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    sleep: async () => undefined,
  });
  const preview = await service.preview("/drive/fresh/nested");
  await waitFor(service, (state) => state.status === "ready");
  await service.start(preview.id);
  await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.equal(dav.files.get("/drive/fresh")?.type, "directory");
  assert.equal(dav.files.get("/drive/fresh/nested")?.type, "directory");
  assert.ok(dav.files.has("/drive/fresh/nested/视频.mp4"));
  db.close();
});

test("cancelling a slow preview cannot be overwritten by its late completion", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalList = dav.getDirectoryContents.bind(dav);
  let blocked = true;
  dav.getDirectoryContents = async (directory: string) => {
    if (blocked && directory === "/drive/old") {
      blocked = false;
      await gate;
    }
    return originalList(directory);
  };
  const service = new PathMigrationService(db, fakeStore(config), { clientFactory: () => dav });
  const preview = await service.preview("/drive/new");
  assert.equal(service.cancel(preview.id).status, "cancelled");
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.getState()?.status, "cancelled");
  assert.equal(db.countPathMigrationItems(preview.id).pending?.count || 0, 0);
  db.close();
});

test("reusable targets are revalidated before switching and missing files are copied", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.files.set("/drive/new/视频.mp4", { type: "file", size: 11 });
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    sleep: async () => undefined,
  });
  const preview = await service.preview("/drive/new");
  await waitFor(service, (state) => state.status === "ready");
  dav.files.delete("/drive/new/视频.mp4");
  await service.start(preview.id);
  await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.ok(dav.copies.some(([source, destination]) => source === "/drive/old/视频.mp4" && destination === "/drive/new/视频.mp4"));
  assert.equal(config.alistDest, "/drive/new");
  db.close();
});

test("a reusable target that changes size pauses instead of switching", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.files.set("/drive/new/视频.mp4", { type: "file", size: 11 });
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    sleep: async () => undefined,
  });
  const preview = await service.preview("/drive/new");
  await waitFor(service, (state) => state.status === "ready");
  dav.files.set("/drive/new/视频.mp4", { type: "file", size: 99 });
  await service.start(preview.id);
  const paused = await waitFor(service, (state) => state.status === "paused");
  assert.equal(paused.conflictCount, 1);
  assert.equal(config.alistDest, "/drive/old");
  db.close();
});

test("remote entries with traversal segments fail the preview", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.getDirectoryContents = async (directory: string) => {
    if (directory === "/drive/old") return [{ filename: "/drive/old/../outside.mp4", type: "file", size: 1 }];
    return [];
  };
  const service = new PathMigrationService(db, fakeStore(config), { clientFactory: () => dav });
  const preview = await service.preview("/drive/new");
  const failed = await waitFor(service, (state) => state.status === "failed");
  assert.match(failed.lastError || "", /非法相对路径/);
  assert.equal(preview.sourceRoot, "/drive/old");
  db.close();
});

test("path migration reuses same-size files and blocks size conflicts", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.files.set("/drive/new/视频.mp4", { type: "file", size: 11 });
  dav.files.set("/drive/new/_history/旧文件.mp4", { type: "file", size: 99 });
  const service = new PathMigrationService(db, fakeStore(config), { clientFactory: () => dav, sleep: async () => undefined });
  await service.preview("/drive/new");
  const state = await waitFor(service, (current) => current.status === "failed");
  assert.equal(state.reusableCount, 1);
  assert.equal(state.conflictCount, 1);
  await assert.rejects(() => service.start(), /就绪预览/);
  assert.equal(dav.copies.length, 0);
  db.close();
});

test("path migration verifies delayed COPY visibility without copying twice", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  let now = 1_000;
  let hiddenChecks = 2;
  const originalStat = dav.stat.bind(dav);
  dav.stat = async (target: string) => {
    if (target === "/drive/new/视频.mp4" && dav.copies.some(([, destination]) => destination === target) && hiddenChecks > 0) {
      hiddenChecks -= 1;
      throw Object.assign(new Error("not visible yet"), { status: 404 });
    }
    return originalStat(target);
  };
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    now: () => now,
    sleep: async (delay) => { now += delay; },
  });
  const preview = await service.preview("/drive/new");
  await waitFor(service, (state) => state.status === "ready");
  await service.start(preview.id);
  await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.equal(dav.copies.filter(([, destination]) => destination === "/drive/new/视频.mp4").length, 1);
  assert.equal(hiddenChecks, 0);
  db.close();
});

test("path migration rechecks a persisted copying item before resuming", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  dav.files.set("/drive/new/视频.mp4", { type: "file", size: 11 });
  db.createPathMigration({
    id: "migration-copying",
    sourceRoot: "/drive/old",
    destinationRoot: "/drive/new",
    alistIdentityHash: "hash",
    status: "copying",
    sourceManifestHash: "hash",
    entryCount: 1,
    fileCount: 1,
    directoryCount: 0,
    totalBytes: 11,
    reusableCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    conflictCount: 0,
    extraCount: 0,
  });
  db.insertPathMigrationItems([{
    migrationId: "migration-copying",
    relativePath: "视频.mp4",
    itemType: "file",
    expectedSize: 11,
    sourcePath: "/drive/old/视频.mp4",
    destinationPath: "/drive/new/视频.mp4",
    status: "copying",
    attempts: 1,
    nextAttemptAt: 0,
    verificationStartedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }]);
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    sleep: async () => undefined,
  });
  await service.resumePersisted();
  await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.equal(dav.copies.length, 0);
  db.close();
});

test("path migration locks scheduling during its source recheck", async () => {
  const db = new StateDatabase(":memory:");
  const config = fakeConfig();
  const dav = new FakeDav();
  const maintenance: boolean[] = [];
  const service = new PathMigrationService(db, fakeStore(config), {
    clientFactory: () => dav,
    isSchedulerIdle: () => true,
    setMaintenance: (locked) => { maintenance.push(locked); },
    sleep: async () => undefined,
  });
  const preview = await service.preview("/drive/new");
  await waitFor(service, (state) => state.status === "ready");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalList = dav.getDirectoryContents.bind(dav);
  let blocked = false;
  dav.getDirectoryContents = async (directory: string) => {
    if (!blocked && directory === "/drive/old") {
      blocked = true;
      await gate;
    }
    return originalList(directory);
  };
  const starting = service.start(preview.id);
  while (!blocked) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(maintenance.at(-1), true);
  await assert.rejects(() => service.start(preview.id), /开始前复核/);
  release();
  await starting;
  await waitFor(service, (state) => state.status === "cleanup_pending");
  assert.equal(maintenance.at(-1), false);
  db.close();
});

test("path migration rewrites only known archive path fields and task keys", () => {
  const db = new StateDatabase(":memory:");
  db.db.prepare("INSERT INTO videos(bvid,backup_status,bili_status,payload_json,updated_at) VALUES(?,?,?,?,?)")
    .run("BVPATH", "verified", "available", JSON.stringify({ bvid: "BVPATH", remotePath: "/drive/old/video", title: "keep /drive/old/text" }), Date.now());
  db.db.prepare("INSERT INTO favorite_relations(user_id,media_id,bvid,backup_status,active_in_favorite,payload_json,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("u1", 1, "BVPATH", "verified", 1, JSON.stringify({
      userId: "u1",
      mediaId: 1,
      bvid: "BVPATH",
      remotePath: "/drive/old/video",
      remoteConflictArchives: [{
        archivePath: "/drive/old/video/_history/old",
        files: [{ oldPath: "/drive/old/video/video.mp4", archivedPath: "/drive/old/video/_history/old/video.mp4" }],
      }],
    }), Date.now());
  db.db.prepare("INSERT INTO remote_files(bvid,user_id,media_id,name,remote_path,status,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("BVPATH", "u1", 1, "video.mp4", "/drive/old/video/video.mp4", "verified", Date.now());
  db.db.prepare("INSERT INTO jobs(id,kind,dedupe_key,bvid,user_id,media_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("job1", "verify_upload", "verify:u1:1:BVPATH:main:/drive/old/video/video.mp4", "BVPATH", "u1", 1, "pending", JSON.stringify({ remoteFile: "/drive/old/video/video.mp4", remotePath: "/drive/old/video" }), Date.now(), Date.now());
  db.rewriteArchiveRoot("migration", "/drive/old", "/drive/new");
  const video = JSON.parse(String((db.db.prepare("SELECT payload_json FROM videos WHERE bvid='BVPATH'").get() as any).payload_json));
  assert.equal(video.remotePath, "/drive/new/video");
  assert.equal(video.title, "keep /drive/old/text");
  const relation = JSON.parse(String((db.db.prepare("SELECT payload_json FROM favorite_relations WHERE bvid='BVPATH'").get() as any).payload_json));
  assert.equal(relation.remoteConflictArchives[0].archivePath, "/drive/new/video/_history/old");
  assert.equal(relation.remoteConflictArchives[0].files[0].archivedPath, "/drive/new/video/_history/old/video.mp4");
  assert.equal((db.db.prepare("SELECT remote_path FROM remote_files").get() as any).remote_path, "/drive/new/video/video.mp4");
  const job = db.db.prepare("SELECT dedupe_key,payload_json FROM jobs WHERE id='job1'").get() as any;
  assert.equal(job.dedupe_key, "verify:u1:1:BVPATH:main:/drive/new/video/video.mp4");
  assert.equal(JSON.parse(job.payload_json).remotePath, "/drive/new/video");
  db.close();
});

test("path migration SQL path matching treats wildcard characters literally", () => {
  const db = new StateDatabase(":memory:");
  for (const bvid of ["BVMATCH", "BVOTHER"]) {
    db.db.prepare("INSERT INTO videos(bvid,backup_status,bili_status,payload_json,updated_at) VALUES(?,?,?,?,?)")
      .run(bvid, "verified", "available", JSON.stringify({ bvid }), Date.now());
  }
  db.db.prepare("INSERT INTO remote_files(bvid,user_id,media_id,name,remote_path,status,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("BVMATCH", "u1", 1, "match.mp4", "/drive/old_root/match.mp4", "verified", Date.now());
  db.db.prepare("INSERT INTO remote_files(bvid,user_id,media_id,name,remote_path,status,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("BVOTHER", "u1", 2, "other.mp4", "/drive/oldXroot/other.mp4", "verified", Date.now());
  db.rewriteArchiveRoot("migration", "/drive/old_root", "/drive/new_root");
  const paths = db.db.prepare("SELECT bvid,remote_path FROM remote_files ORDER BY bvid").all() as any[];
  assert.deepEqual(paths.map((row) => [row.bvid, row.remote_path]), [
    ["BVMATCH", "/drive/new_root/match.mp4"],
    ["BVOTHER", "/drive/oldXroot/other.mp4"],
  ]);
  db.close();
});

test("path migration retry scheduling returns the earliest persisted retry time", () => {
  const db = new StateDatabase(":memory:");
  db.createPathMigration({
    id: "migration-retry",
    sourceRoot: "/drive/old",
    destinationRoot: "/drive/new",
    alistIdentityHash: "hash",
    status: "copying",
    entryCount: 1,
    fileCount: 1,
    directoryCount: 0,
    totalBytes: 1,
    reusableCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    conflictCount: 0,
    extraCount: 0,
  });
  db.insertPathMigrationItems([{
    migrationId: "migration-retry",
    relativePath: "video.mp4",
    itemType: "file",
    expectedSize: 1,
    sourcePath: "/drive/old/video.mp4",
    destinationPath: "/drive/new/video.mp4",
    status: "failed",
    attempts: 1,
    nextAttemptAt: 5_000,
    createdAt: 0,
    updatedAt: 0,
  }]);
  assert.equal(db.nextPathMigrationAttemptAt("migration-retry", 1_000), 5_000);
  assert.equal(db.nextPathMigrationAttemptAt("migration-retry", 5_000), undefined);
  db.close();
});
