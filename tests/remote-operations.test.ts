import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createRemoteReplacementRunner,
  probeRemoteCapabilities,
  type RemoteOperationsClient,
} from "../src/remote-operations.js";
import { QualityUpgradeTask } from "../src/tasks.js";
import { batchRenameRemotePaths, uploadWithAList } from "../src/uploader.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

class MemoryRemote implements RemoteOperationsClient {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>(["/"]);
  readonly copies: Array<[string, string]> = [];
  readonly moves: Array<[string, string]> = [];
  readonly deletes: string[] = [];
  readonly puts: string[] = [];
  copySupported = true;
  moveSupported = true;
  copyStatus = 405;
  moveStatus = 405;
  loseMoveResponse = false;
  failDeleteCount = 0;
  corruptCopies = false;

  private normalize(value: string) {
    const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
    return normalized.startsWith("/") ? normalized || "/" : `/${normalized}`;
  }

  private parent(value: string) {
    const normalized = this.normalize(value);
    const index = normalized.lastIndexOf("/");
    return index <= 0 ? "/" : normalized.slice(0, index);
  }

  async exists(value: string) {
    const target = this.normalize(value);
    return this.files.has(target) || this.directories.has(target);
  }

  async createDirectory(value: string) {
    const target = this.normalize(value);
    this.directories.add(target);
  }

  async putFileContents(value: string, data: string | Buffer) {
    const target = this.normalize(value);
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(data)) chunks.push(data);
    else if (typeof data === "string") chunks.push(Buffer.from(data));
    else for await (const chunk of data as any) chunks.push(Buffer.from(chunk));
    this.files.set(target, Buffer.concat(chunks));
    this.directories.add(this.parent(target));
    this.puts.push(target);
  }

  async stat(value: string) {
    const target = this.normalize(value);
    if (this.files.has(target)) return { type: "file", size: this.files.get(target)!.length };
    if (this.directories.has(target)) return { type: "directory", size: 0 };
    throw Object.assign(new Error("not found"), { status: 404 });
  }

  async copyFile(sourceValue: string, targetValue: string) {
    const source = this.normalize(sourceValue);
    const target = this.normalize(targetValue);
    if (!this.copySupported) throw Object.assign(new Error("COPY not supported"), { status: this.copyStatus });
    const body = this.files.get(source);
    if (!body) throw Object.assign(new Error("source not found"), { status: 404 });
    if (this.files.has(target)) throw Object.assign(new Error("destination exists"), { status: 412 });
    this.files.set(target, this.corruptCopies ? Buffer.from("corrupt") : Buffer.from(body));
    this.directories.add(this.parent(target));
    this.copies.push([source, target]);
  }

  async moveFile(sourceValue: string, targetValue: string) {
    const source = this.normalize(sourceValue);
    const target = this.normalize(targetValue);
    if (!this.moveSupported) throw Object.assign(new Error("MOVE not supported"), { status: this.moveStatus });
    const body = this.files.get(source);
    if (!body) throw Object.assign(new Error("source not found"), { status: 404 });
    if (this.files.has(target)) throw Object.assign(new Error("destination exists"), { status: 412 });
    this.files.set(target, body);
    this.files.delete(source);
    this.directories.add(this.parent(target));
    this.moves.push([source, target]);
    if (this.loseMoveResponse) throw Object.assign(new Error("connection closed"), { status: 502 });
  }

  async deleteFile(value: string) {
    const target = this.normalize(value);
    if (this.failDeleteCount > 0 && this.files.has(target)) {
      this.failDeleteCount -= 1;
      throw Object.assign(new Error("temporary delete failure"), { status: 503 });
    }
    this.files.delete(target);
    const children = [...this.files.keys(), ...this.directories].some((item) => item !== target && item.startsWith(`${target}/`));
    if (!children) this.directories.delete(target);
    this.deletes.push(target);
  }
}

const config = testConfig({ alistDest: "/target" });

test("remote capability probe records COPY and MOVE independently", async () => {
  const client = new MemoryRemote();
  client.copySupported = false;
  const capabilities = await probeRemoteCapabilities(client, "/target");
  assert.deepEqual(capabilities, { copy: "unsupported", move: "supported" });
  assert.equal([...client.files.keys()].some((item) => item.includes("._bfb-replace-probe-")), false);
});

test("replacement prefers MOVE when both methods are supported", async () => {
  const client = new MemoryRemote();
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "supported" },
  });
  await runner(config, "/target/old.mp4", "/target/new.mp4");
  assert.equal(client.copies.length, 0);
  assert.deepEqual(client.files.get("/target/new.mp4"), Buffer.from("old"));
  assert.equal(client.files.has("/target/old.mp4"), false);
});

test("replacement falls back to COPY plus DELETE only after MOVE is explicitly unsupported", async () => {
  const client = new MemoryRemote();
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unsupported" },
  });
  await runner(config, "/target/old.mp4", "/target/new.mp4");
  assert.equal(client.copies.length, 1);
  assert.equal(client.moves.length, 0);
  assert.equal(client.files.has("/target/old.mp4"), false);
  assert.deepEqual(client.files.get("/target/new.mp4"), Buffer.from("old"));
});

test("a MOVE response loss is resolved by checking source and target without trying COPY", async () => {
  const client = new MemoryRemote();
  client.loseMoveResponse = true;
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "supported" },
  });
  await runner(config, "/target/old.mp4", "/target/new.mp4", 3);
  assert.equal(client.copies.length, 0);
  assert.equal(client.moves.length, 1);
  assert.equal(client.files.has("/target/old.mp4"), false);
});

test("a missing source only resolves with a persisted target proof", async () => {
  const client = new MemoryRemote();
  client.files.set("/target/new.mp4", Buffer.from("wrong-size"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "supported" },
  });
  await assert.rejects(() => runner(config, "/target/old.mp4", "/target/new.mp4", 3), /目标文件也未确认/);
  client.files.set("/target/new.mp4", Buffer.from("old"));
  await assert.rejects(() => runner(config, "/target/old.mp4", "/target/new.mp4", 3), /目标文件也未确认/);
  await runner(config, "/target/old.mp4", "/target/new.mp4", 3, { targetPreviouslyVerified: true });
  assert.deepEqual(client.files.get("/target/new.mp4"), Buffer.from("old"));
});

test("COPY target verification failure preserves the source", async () => {
  const client = new MemoryRemote();
  client.corruptCopies = true;
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unsupported" },
  });
  await assert.rejects(() => runner(config, "/target/old.mp4", "/target/new.mp4"), /校验失败/);
  assert.equal(client.files.has("/target/old.mp4"), true);
});

test("COPY response loss with a same-size target preserves both files without proof", async () => {
  const client = new MemoryRemote();
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const originalCopy = client.copyFile.bind(client);
  client.copyFile = async (...args: Parameters<MemoryRemote["copyFile"]>) => {
    await originalCopy(...args);
    throw Object.assign(new Error("connection reset after COPY"), { status: 502 });
  };
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unsupported" },
  });
  let targetVerified = false;
  await assert.rejects(
    () => runner(config, "/target/old.mp4", "/target/new.mp4"),
    (error: any) => {
      assert.equal(error.code, "REMOTE_COPY_RESULT_UNCERTAIN");
      assert.equal(error.targetReady, true);
      assert.equal(error.sourceStillPresent, true);
      return true;
    },
  );
  assert.equal(targetVerified, false);
  assert.equal(client.files.has("/target/old.mp4"), true);
  assert.equal(client.files.has("/target/new.mp4"), true);
});

test("COPY plus DELETE retry does not copy the same file twice", async () => {
  const client = new MemoryRemote();
  client.failDeleteCount = 1;
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unsupported" },
  });
  let targetVerified = false;
  await assert.rejects(() => runner(config, "/target/old.mp4", "/target/new.mp4", undefined, {
    onTargetVerified: () => { targetVerified = true; },
  }), /删除源文件失败/);
  assert.equal(client.copies.length, 1);
  assert.equal(targetVerified, true);
  await runner(config, "/target/old.mp4", "/target/new.mp4", undefined, { targetPreviouslyVerified: targetVerified });
  assert.equal(client.copies.length, 1);
  assert.equal(client.files.has("/target/old.mp4"), false);
});

test("quality upgrade persists a copied backup proof before DELETE and resumes without copying twice", async () => {
  const client = new MemoryRemote();
  client.moveSupported = false;
  client.failDeleteCount = 1;
  client.files.set("/target/old.mp4", Buffer.from("old"));
  client.files.set("/target/.quality-upgrade-run/new.mp4", Buffer.from("new"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unsupported" },
  });
  const persistedBackupFiles: Array<{ name: string; path: string; size?: number }> = [];
  const persistedFinalFiles: Array<{ name: string; path: string; size?: number }> = [];
  const buildTask = () => {
    const task = new QualityUpgradeTask("BVQUALITYPROOF", {}, config, {
      userId: "u1",
      mediaId: 1,
      folderTitle: "Favorites",
      remotePath: "/target",
      oldFiles: [{
        name: "old.mp4",
        path: "/target/old.mp4",
        size: 3,
        verificationStatus: "verified",
      }],
    });
    task.stageRemotePath = "/target/.quality-upgrade-run";
    task.uploadResult = {
      remotePath: task.stageRemotePath,
      allVerified: true,
      files: [{
        name: "new.mp4",
        path: "/target/.quality-upgrade-run/new.mp4",
        size: 3,
        verificationStatus: "verified",
      }],
    };
    task.backupFiles = persistedBackupFiles.map((file) => ({ ...file }));
    task.finalFiles = persistedFinalFiles.map((file) => ({ ...file }));
    task.replacementRunner = runner;
    task.verifyRunner = async () => ({ ok: true, missing: [] });
    task.onBackupFileMoved = (_task, file) => {
      if (!persistedBackupFiles.some((candidate) => candidate.path === file.path)) persistedBackupFiles.push({ ...file });
    };
    task.onFinalFileMoved = (_task, file) => {
      if (!persistedFinalFiles.some((candidate) => candidate.path === file.path)) persistedFinalFiles.push({ ...file });
    };
    return task;
  };

  await assert.rejects(() => buildTask().runReplacePhase("run"), /删除源文件失败/);
  assert.deepEqual(persistedBackupFiles.map((file) => file.path), ["/target/.quality-upgrade-backup-run/old.mp4"]);
  assert.equal(client.copies.filter(([source]) => source === "/target/old.mp4").length, 1);
  assert.equal(client.files.has("/target/old.mp4"), true);

  const resumed = buildTask();
  await resumed.runReplacePhase("run");
  assert.equal(client.copies.filter(([source]) => source === "/target/old.mp4").length, 1);
  assert.equal(client.files.has("/target/old.mp4"), false);
  assert.deepEqual(client.files.get("/target/.quality-upgrade-backup-run/old.mp4"), Buffer.from("old"));
  assert.deepEqual(client.files.get("/target/new.mp4"), Buffer.from("new"));
  assert.deepEqual(persistedFinalFiles.map((file) => file.path), ["/target/new.mp4"]);
});

test("unknown MOVE capability never silently falls back to COPY", async () => {
  const client = new MemoryRemote();
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const runner = await createRemoteReplacementRunner(config, {
    client,
    capabilities: { copy: "supported", move: "unknown" },
  });
  await assert.rejects(() => runner(config, "/target/old.mp4", "/target/new.mp4"), /能力未知/);
  assert.equal(client.copies.length, 0);
  assert.equal(client.files.has("/target/old.mp4"), true);
});

test("batch rename uses COPY plus DELETE on a MOVE-unsupported backend", async () => {
  const client = new MemoryRemote();
  client.moveSupported = false;
  client.files.set("/target/old.mp4", Buffer.from("old"));
  const result = await batchRenameRemotePaths(config, [{ oldPath: "/target/old.mp4", newPath: "/target/new.mp4" }], client as any);
  assert.equal(result.success, 1);
  assert.equal(client.copies.filter(([source]) => !source.includes("._bfb-replace-probe-")).length, 2);
  assert.equal(client.files.has("/target/old.mp4"), false);
  assert.equal(client.files.has("/target/new.mp4"), true);
});

test("ordinary upload retains a verified old archive without COPY MOVE or PUT", async () => {
  const runtime = await createTestDir("upload-conflict-history");
  const client = new MemoryRemote();
  client.moveSupported = false;
  client.files.set("/target/video.mp4", Buffer.from("old-content"));
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "new-content-longer");
    const result = await uploadWithAList(runtime, "/target", config, {
      cleanupLocal: false,
      client: client as any,
      files: ["video.mp4"],
      existingArchiveProof: {
        remotePath: "/target",
        status: "verified",
        verifiedAt: new Date().toISOString(),
        files: [{
          name: "video.mp4",
          path: "/target/video.mp4",
          size: Buffer.byteLength("old-content"),
          verificationStatus: "verified",
        }],
      },
      verificationDelaysMs: [0],
      log: { push() {} },
    });
    assert.equal(result.allVerified, true);
    assert.equal(result.disposition, "retained_existing_archive");
    assert.deepEqual(client.files.get("/target/video.mp4"), Buffer.from("old-content"));
    assert.equal(client.copies.length, 0);
    assert.equal(client.moves.length, 0);
    assert.equal(client.puts.length, 0);
  } finally {
    await removeTestDir(runtime);
  }
});

test("legacy conflict archival side effects stop without further remote writes", async () => {
  const runtime = await createTestDir("upload-conflict-history-recovery-proof");
  const client = new MemoryRemote();
  client.moveSupported = false;
  client.files.set("/target/video.mp4", Buffer.from("old-content"));
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "new-content-longer");
    const options = {
      cleanupLocal: false,
      client: client as any,
      files: ["video.mp4"],
      legacyConflictSideEffectsStarted: true,
      verificationDelaysMs: [0],
      log: { push() {} },
    };
    await assert.rejects(
      () => uploadWithAList(runtime, "/target", config, options),
      (error: any) => error.uploadFailure?.code === "UPLOAD_LEGACY_CONFLICT_ARCHIVE_INTERRUPTED",
    );
    assert.equal(client.files.has("/target/video.mp4"), true);
    assert.equal(client.copies.length, 0);
    assert.equal(client.moves.length, 0);
    assert.equal(client.puts.length, 0);
  } finally {
    await removeTestDir(runtime);
  }
});
