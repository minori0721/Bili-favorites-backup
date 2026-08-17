import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  buildCompatibilityUploadName,
  ensureRemoteDir,
  uploadWithAList,
  resumeUploadSession,
  verifyUploadedFile,
  inspectRemoteFileSize,
  detectUploadMimeType,
  UploadStartLimiter,
} from "../src/uploader.js";
import { StateDatabase } from "../src/database.js";
import { TransferSessionStore } from "../src/transfer-session.js";
import { UploadOperationError } from "../src/upload-health.js";
import { UploadTask } from "../src/tasks.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const noopLog = { push() {} };

test("upload MIME detection covers media subtitles images and JSON", () => {
  assert.equal(detectUploadMimeType("video.mp4"), "video/mp4");
  assert.equal(detectUploadMimeType("audio.m4a"), "audio/mp4");
  assert.equal(detectUploadMimeType("subtitle.ass"), "text/x-ssa");
  assert.equal(detectUploadMimeType("cover.webp"), "image/webp");
  assert.equal(detectUploadMimeType("metadata.json"), "application/json");
  assert.equal(detectUploadMimeType("unknown.bin"), "application/octet-stream");
});

function xmlEscape(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[char]!));
}

async function startWebDavServer(options: {
  failFirstPut?: boolean;
  failPutName?: string;
  failPutStatus?: number;
  failMoveName?: string;
  rejectFourByteNames?: boolean;
  remoteSizeOffset?: number;
  putStatus?: 201 | 204;
  writeBeforePutFailure?: boolean;
  visibilityDelayPropfinds?: number;
  existingFiles?: Record<string, Buffer>;
} = {}) {
  const directories = new Set(["/dav"]);
  const files = new Map<string, Buffer>(Object.entries(options.existingFiles || {}));
  const hiddenChecks = new Map<string, number>();
  const puts: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  const moves: Array<{ oldPath: string; newPath: string }> = [];
  let putCount = 0;
  let failMoveName = options.failMoveName;

  const server = http.createServer(async (req, res) => {
    const requestPath = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname).replace(/\/$/, "") || "/";
    if (req.method === "MKCOL") {
      directories.add(requestPath);
      res.statusCode = 201;
      res.end();
      return;
    }
    if (req.method === "PROPFIND") {
      const isDirectory = directories.has(requestPath);
      const body = files.get(requestPath);
      const hidden = hiddenChecks.get(requestPath) || 0;
      if (body && hidden > 0) {
        hiddenChecks.set(requestPath, hidden - 1);
        res.statusCode = 404;
        res.end();
        return;
      }
      if (!isDirectory && !body) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const size = body ? body.length + Number(options.remoteSizeOffset || 0) : 0;
      const name = path.posix.basename(requestPath) || "dav";
      const resourceType = isDirectory ? "<d:collection/>" : "";
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>${xmlEscape(requestPath)}</d:href><d:propstat><d:prop><d:displayname>${xmlEscape(name)}</d:displayname><d:resourcetype>${resourceType}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype><d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
      res.statusCode = 207;
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.end(xml);
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      puts.push({ path: requestPath, headers: req.headers, body });
      putCount += 1;
      if (options.failFirstPut && putCount === 1) {
        res.statusCode = 500;
        res.end("temporary failure");
        return;
      }
      if (options.failPutName && requestPath.endsWith(`/${options.failPutName}`)) {
        if (options.writeBeforePutFailure) files.set(requestPath, body);
        res.statusCode = options.failPutStatus || 405;
        res.end("Method Not Allowed");
        return;
      }
      if (options.rejectFourByteNames && Array.from(requestPath).some((character) => Buffer.byteLength(character, "utf-8") === 4)) {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }
      files.set(requestPath, body);
      if (options.visibilityDelayPropfinds) hiddenChecks.set(requestPath, options.visibilityDelayPropfinds);
      res.statusCode = options.putStatus || 201;
      res.end();
      return;
    }
    if (req.method === "MOVE") {
      const destinationHeader = String(req.headers.destination || "");
      const destinationPath = decodeURIComponent(new URL(destinationHeader, "http://127.0.0.1").pathname).replace(/\/$/, "") || "/";
      if (failMoveName && requestPath.endsWith(`/${failMoveName}`)) {
        res.statusCode = 500;
        res.end("move failed");
        return;
      }
      const body = files.get(requestPath);
      if (!body) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (files.has(destinationPath)) {
        res.statusCode = 412;
        res.end("destination exists");
        return;
      }
      files.set(destinationPath, body);
      files.delete(requestPath);
      moves.push({ oldPath: requestPath, newPath: destinationPath });
      res.statusCode = 201;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    puts,
    moves,
    files,
    setFailMoveName: (value?: string) => { failMoveName = value; },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("stream upload sends exact length, MIME and ownCloud timestamps without chunked encoding", async () => {
  const runtime = await createTestDir("upload-headers");
  const server = await startWebDavServer({ putStatus: 204 });
  try {
    const filePath = path.join(runtime, "sample.mp4");
    await fs.promises.writeFile(filePath, Buffer.from("hello-webdav"));
    await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(server.puts.length, 1);
    const put = server.puts[0];
    assert.equal(put.headers["content-length"], String(put.body.length));
    assert.equal(put.headers["transfer-encoding"], undefined);
    assert.equal(put.headers["content-type"], "video/mp4");
    assert.match(String(put.headers["x-oc-mtime"]), /^\d+$/);
    assert.equal(put.headers["x-oc-ctime"], put.headers["x-oc-mtime"]);
    assert.equal(put.body.toString(), "hello-webdav");
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("upload result preserves selected Bilibili quality and actual media metadata", async () => {
  const runtime = await createTestDir("upload-media-metadata");
  const server = await startWebDavServer();
  try {
    await fs.promises.writeFile(path.join(runtime, "sample.mp4"), Buffer.from("media-metadata"));
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
      filenameMetadataByPath: {
        "sample.mp4": {
          pageIndex: 1,
          cid: 501,
          bilibiliQuality: "1080P60",
          dfn: "1080p60",
          videoCodecs: "HEVC",
          mediaMetadata: {
            width: 1080,
            height: 1920,
            duration: 30,
            fps: 60,
            codec: "HEVC",
            source: "ffprobe",
            observedAt: "2026-07-28T00:00:00.000Z",
          },
        },
      },
    });
    assert.deepEqual(result.files[0].filenameMetadata, {
      pageIndex: 1,
      cid: 501,
      bilibiliQuality: "1080P60",
      dfn: "1080p60",
      videoCodecs: "HEVC",
    });
    assert.deepEqual(result.files[0].mediaMetadata, {
      width: 1080,
      height: 1920,
      duration: 30,
      fps: 60,
      codec: "HEVC",
      source: "ffprobe",
      observedAt: "2026-07-28T00:00:00.000Z",
    });
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("the global upload limiter spaces concurrent PUT starts", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const limiter = new UploadStartLimiter(
    () => now,
    async (delayMs) => {
      sleeps.push(delayMs);
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += delayMs;
    }
  );
  const starts: number[] = [];
  await Promise.all([1, 2, 3].map(async () => {
    await limiter.wait(10_000);
    starts.push(now);
  }));
  assert.deepEqual(starts, [0, 10_000, 20_000]);
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test("history upload preflight skips do not consume an upload start slot", async () => {
  const runtime = await createTestDir("upload-limit-preflight");
  const existing = Buffer.from("already-there");
  const server = await startWebDavServer({ existingFiles: { "/dav/target/p01.mp4": existing } });
  const waits: number[] = [];
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), existing);
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), "new-file");
    await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url, uploadFileIntervalSeconds: 10 }), {
      cleanupLocal: false,
      files: ["p01.mp4", "p02.mp4"],
      verificationDelaysMs: [0],
      log: noopLog,
      uploadStartLimiter: { wait: async (intervalMs: number) => { waits.push(intervalMs); } } as UploadStartLimiter,
      uploadIntent: "history_upload",
    });
    assert.equal(server.puts.length, 1);
    assert.deepEqual(waits, [10_000]);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a 405 after completed files is treated as a temporary upload session failure", async () => {
  const runtime = await createTestDir("upload-progressive-405");
  const server = await startWebDavServer({ failPutName: "p02.mp4", failPutStatus: 405 });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "first-file");
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), "second-file");
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4", "p02.mp4"],
        uploadIntent: "history_upload",
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => {
        assert.ok(error instanceof UploadOperationError);
        assert.equal(error.uploadFailure.status, 405);
        assert.equal(error.uploadFailure.category, "transient");
        assert.equal(error.uploadFailure.retryable, true);
        assert.equal(error.uploadSessionTransient, true);
        assert.equal(error.completedFilesBeforeFailure, 1);
        return true;
      }
    );
    assert.equal(server.puts.length, 2);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("history preflight-verified files count as progress before a later 405", async () => {
  const runtime = await createTestDir("upload-resumed-progressive-405");
  const first = Buffer.from("already-uploaded");
  const server = await startWebDavServer({
    existingFiles: { "/dav/target/p01.mp4": first },
    failPutName: "p02.mp4",
    failPutStatus: 405,
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), first);
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), "second-file");
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4", "p02.mp4"],
        uploadIntent: "history_upload",
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => {
        assert.ok(error instanceof UploadOperationError);
        assert.equal(error.uploadSessionTransient, true);
        assert.equal(error.completedFilesBeforeFailure, 1);
        return true;
      }
    );
    assert.equal(server.puts.length, 1);
    assert.equal(server.puts[0].path, "/dav/target/p02.mp4");
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a 405 on the first upload file remains deterministic", async () => {
  const runtime = await createTestDir("upload-first-405");
  const server = await startWebDavServer({ failPutName: "p01.mp4", failPutStatus: 405 });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "first-file");
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4"],
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => {
        assert.ok(error instanceof UploadOperationError);
        assert.equal(error.uploadFailure.category, "deterministic");
        assert.equal(error.uploadSessionTransient, undefined);
        return true;
      }
    );
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a 405 after the remote driver writes the file is accepted after exact verification", async () => {
  const runtime = await createTestDir("upload-405-written");
  const server = await startWebDavServer({
    failPutName: "p01.mp4",
    failPutStatus: 405,
    writeBeforePutFailure: true,
  });
  try {
    const body = "written-before-405";
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), body);
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      files: ["p01.mp4"],
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(result.allVerified, true);
    assert.equal(result.files[0].verificationStatus, "verified");
    assert.equal(server.files.get("/dav/target/p01.mp4")?.toString(), body);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a 405 with a missing remote file remains a failure", async () => {
  const runtime = await createTestDir("upload-405-missing");
  const server = await startWebDavServer({ failPutName: "p01.mp4", failPutStatus: 405 });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "missing-after-405");
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4"],
        verificationDelaysMs: [0],
        log: noopLog,
        uploadIntent: "history_upload",
      }),
      (error: any) => {
        assert.ok(error instanceof UploadOperationError);
        assert.equal(error.uploadFailure.status, 405);
        assert.equal(error.uploadFailure.category, "deterministic");
        return true;
      }
    );
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a 405 with a different remote size is reported as a conflict", async () => {
  const runtime = await createTestDir("upload-405-mismatch");
  const server = await startWebDavServer({
    failPutName: "p01.mp4",
    failPutStatus: 405,
    writeBeforePutFailure: true,
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "remote-size-conflict");
    server.files.set("/dav/target/p01.mp4", Buffer.from("different"));
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4"],
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => {
        assert.ok(error instanceof UploadOperationError);
        assert.equal(error.uploadFailure.status, 409);
        return true;
      }
    );
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("one size conflict stops the complete direct-upload batch before any PUT", async () => {
  const runtime = await createTestDir("upload-conflict-archive");
  const oldSameSize = Buffer.from("OLD-SAME");
  const newSameSize = Buffer.from("NEW-SAME");
  const oldDifferentSize = Buffer.alloc(32, 1);
  const newDifferentSize = Buffer.alloc(40, 2);
  const server = await startWebDavServer({
    existingFiles: {
      "/dav/target/p01.mp4": oldSameSize,
      "/dav/target/p02.mp4": oldDifferentSize,
    },
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), newSameSize);
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), newDifferentSize);
    await assert.rejects(uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      files: ["p01.mp4", "p02.mp4"],
      conflictArchiveSegment: "20260712T120000000Z",
      verificationDelaysMs: [0],
      log: noopLog,
    }), UploadOperationError);
    assert.equal(server.moves.length, 0);
    assert.equal(server.puts.length, 0);
    assert.deepEqual(server.files.get("/dav/target/p01.mp4"), oldSameSize);
    assert.deepEqual(server.files.get("/dav/target/p02.mp4"), oldDifferentSize);
    assert.equal(fs.existsSync(path.join(runtime, "p01.mp4")), true);
    assert.equal(fs.existsSync(path.join(runtime, "p02.mp4")), true);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a direct-upload conflict can retry after the old target is resolved without MOVE", async () => {
  const runtime = await createTestDir("upload-conflict-retry");
  const server = await startWebDavServer({
    existingFiles: {
      "/dav/target/p01.mp4": Buffer.from("old-one"),
      "/dav/target/p02.mp4": Buffer.from("old-two"),
    },
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "new-one-longer");
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), "new-two-longer");
    const options = {
      cleanupLocal: false,
      files: ["p01.mp4", "p02.mp4"],
      conflictArchiveSegment: "20260712T120100000Z",
      verificationDelaysMs: [0],
      log: noopLog,
    };
    await assert.rejects(uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), options), UploadOperationError);
    server.files.delete("/dav/target/p01.mp4");
    server.files.delete("/dav/target/p02.mp4");
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), options);
    assert.equal(result.allVerified, true);
    assert.equal(server.moves.length, 0);
    assert.deepEqual(server.files.get("/dav/target/p01.mp4"), Buffer.from("new-one-longer"));
    assert.deepEqual(server.files.get("/dav/target/p02.mp4"), Buffer.from("new-two-longer"));
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("direct upload succeeds on a backend whose MOVE operation is unavailable", async () => {
  const runtime = await createTestDir("upload-conflict-move-failure");
  const server = await startWebDavServer({
    failMoveName: "p02.mp4",
    existingFiles: {},
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), "new-one-longer");
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), "new-two-longer");
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      files: ["p01.mp4", "p02.mp4"],
      conflictArchiveSegment: "20260712T120200000Z",
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(result.allVerified, true);
    assert.equal(server.moves.length, 0);
    assert.equal(server.puts.length, 2);
    assert.equal(fs.existsSync(path.join(runtime, "p01.mp4")), true);
    assert.equal(fs.existsSync(path.join(runtime, "p02.mp4")), true);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("same-name same-size normal upload is rejected without proof", async () => {
  const runtime = await createTestDir("upload-preflight");
  const body = Buffer.from("already-remote");
  const server = await startWebDavServer({ existingFiles: { "/dav/target/existing.mp4": body } });
  try {
    await fs.promises.writeFile(path.join(runtime, "existing.mp4"), body);
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["existing.mp4"],
        log: noopLog,
      }),
      (error: any) => error instanceof UploadOperationError
        && error.uploadFailure.code === "UPLOAD_UNKNOWN_SAME_SIZE_TARGET",
    );
    assert.equal(server.puts.length, 0);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("ordinary multipart conflict uploads one complete stable candidate without changing official paths", async () => {
  const runtime = await createTestDir("upload-conflict-candidate-group");
  const oldFirst = Buffer.from("OLD-SAME");
  const newFirst = Buffer.from("NEW-SAME");
  const oldSecond = Buffer.from("old-second");
  const newSecond = Buffer.from("new-second-longer");
  const server = await startWebDavServer({
    existingFiles: {
      "/dav/target/p01.mp4": oldFirst,
      "/dav/target/p02.mp4": oldSecond,
    },
  });
  try {
    await fs.promises.writeFile(path.join(runtime, "p01.mp4"), newFirst);
    await fs.promises.writeFile(path.join(runtime, "p02.mp4"), newSecond);
    const buildTask = () => {
      const task = new UploadTask("BVCANDIDATE", runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["p01.mp4", "p02.mp4"],
        conflictCandidateId: "upload-job-1",
        conflictCandidateRemotePath: "/target/_conflicts/upload-job-1",
      });
      task.userId = "u1";
      task.mediaId = 1;
      return task;
    };

    const first = buildTask();
    await first.run();
    assert.equal(first.result?.disposition, "conflict_candidate");
    assert.equal(first.result?.files.length, 2);
    assert.deepEqual(server.files.get("/dav/target/p01.mp4"), oldFirst);
    assert.deepEqual(server.files.get("/dav/target/p02.mp4"), oldSecond);
    assert.deepEqual(server.files.get("/dav/target/_conflicts/upload-job-1/p01.mp4"), newFirst);
    assert.deepEqual(server.files.get("/dav/target/_conflicts/upload-job-1/p02.mp4"), newSecond);
    assert.equal(server.moves.length, 0);
    assert.deepEqual(server.puts.map((entry) => entry.path), [
      "/dav/target/_conflicts/upload-job-1/p01.mp4",
      "/dav/target/_conflicts/upload-job-1/p02.mp4",
    ]);

    const retry = buildTask();
    await retry.run();
    assert.equal(retry.result?.disposition, "conflict_candidate");
    assert.equal(server.puts.length, 2);
    assert.equal(server.moves.length, 0);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("direct PUT rejects an unproven same-size target that appears after preflight", async () => {
  const runtime = await createTestDir("upload-conditional-put");
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "same-size");
    let statCalls = 0;
    let putOptions: any;
    const client = {
      exists: async () => true,
      createDirectory: async () => undefined,
      stat: async () => {
        statCalls += 1;
        if (statCalls <= 2) {
          const error: any = new Error("not found");
          error.status = 404;
          throw error;
        }
        return { size: Buffer.byteLength("same-size") };
      },
      putFileContents: async (_remote: string, _stream: any, options: any) => {
        putOptions = options;
        return false;
      },
    } as any;
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig(), {
        cleanupLocal: false,
        client,
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => error instanceof UploadOperationError
        && error.uploadFailure.code === "UPLOAD_CONDITIONAL_TARGET_APPEARED",
    );
    assert.equal(putOptions.overwrite, false);
  } finally {
    await removeTestDir(runtime);
  }
});

test("manual re-upload never bypasses a pre-existing size conflict and sends no batch PUT", async () => {
  const runtime = await createTestDir("upload-preexisting-conflict");
  const server = await startWebDavServer({
    existingFiles: { "/dav/target/first.mp4": Buffer.from("old-remote-content") },
  });
  const database = new StateDatabase(":memory:");
  try {
    await fs.promises.writeFile(path.join(runtime, "first.mp4"), "new-content");
    await fs.promises.writeFile(path.join(runtime, "second.mp4"), "second-content");
    const sessions = new TransferSessionStore(database);
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        files: ["first.mp4", "second.mp4"],
        bvid: "BVPREEXISTINGCONFLICT",
        userId: "u1",
        mediaId: 1,
        transferSessionStore: sessions,
        allowReupload: true,
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => error?.uploadFailure?.status === 409,
    );
    assert.equal(server.puts.length, 0);
    const session = sessions.getByDedupeKey("upload:u1:1:BVPREEXISTINGCONFLICT:/target:main");
    assert.ok(session);
    assert.equal(session.allowReupload, false);
  } finally {
    database.close();
    await server.close();
    await removeTestDir(runtime);
  }
});

test("conditional PUT does not overwrite a different-size target that appears after preflight", async () => {
  const runtime = await createTestDir("upload-conditional-conflict");
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "new-content");
    let statCalls = 0;
    let putCalls = 0;
    const client = {
      exists: async () => true,
      createDirectory: async () => undefined,
      stat: async () => {
        statCalls += 1;
        if (statCalls <= 2) {
          const error: any = new Error("not found");
          error.status = 404;
          throw error;
        }
        return { size: 3 };
      },
      putFileContents: async () => {
        putCalls += 1;
        return false;
      },
    } as any;
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig(), {
        cleanupLocal: false,
        client,
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      (error: any) => {
        assert.equal(error.uploadFailure.status, 409);
        return true;
      },
    );
    assert.equal(putCalls, 1);
    assert.equal(fs.existsSync(path.join(runtime, "video.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("accepted PUT can remain awaiting verification until the remote file becomes visible", async () => {
  const runtime = await createTestDir("upload-delayed-visible");
  const server = await startWebDavServer({ visibilityDelayPropfinds: 1 });
  try {
    const body = Buffer.from("delayed-visible");
    await fs.promises.writeFile(path.join(runtime, "delayed.mp4"), body);
    const config = testConfig({ alistUrl: server.url });
    const result = await uploadWithAList(runtime, "/target", config, {
      cleanupLocal: true,
      files: ["delayed.mp4"],
      log: noopLog,
    });
    assert.equal(result.allVerified, false);
    assert.equal(result.files[0].verificationStatus, "awaiting_verification");
    assert.equal(fs.existsSync(path.join(runtime, "delayed.mp4")), true);
    const verified = await inspectRemoteFileSize(config, result.files[0].path, body.length);
    assert.equal(verified.status, "verified");
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("persistent upload sessions PUT only to the final path and never require MOVE", async () => {
  const runtime = await createTestDir("upload-transfer-direct");
  const server = await startWebDavServer({ failMoveName: "video.mp4" });
  const database = new StateDatabase(":memory:");
  try {
    const body = Buffer.from("direct-session");
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), body);
    const sessions = new TransferSessionStore(database);
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      files: ["video.mp4"],
      bvid: "BVDIRECT",
      userId: "u1",
      mediaId: 1,
      transferSessionStore: sessions,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(result.allVerified, true);
    assert.equal(server.moves.length, 0);
    assert.deepEqual(server.puts.map((put) => put.path), ["/dav/target/video.mp4"]);
    assert.equal(server.puts.some((put) => put.path.includes(".bfb-staging")), false);
    const session = sessions.get(result.sessionId!);
    assert.equal(session?.phase, "completed");
    assert.equal(session?.stagingPath, "/target");
    assert.equal(sessions.listFiles(result.sessionId!)[0].stagingPath, "/target/video.mp4");
  } finally {
    database.close();
    await server.close();
    await removeTestDir(runtime);
  }
});

test("persistent direct upload keeps the compatible filename fallback without MOVE", async () => {
  const runtime = await createTestDir("upload-transfer-compatible-name");
  const server = await startWebDavServer({ rejectFourByteNames: true, failMoveName: "video.mp4" });
  const database = new StateDatabase(":memory:");
  try {
    const originalName = "video-🍷.mp4";
    await fs.promises.writeFile(path.join(runtime, originalName), Buffer.from("compatible"));
    const sessions = new TransferSessionStore(database);
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      files: [originalName],
      bvid: "BVCOMPATSESSION",
      transferSessionStore: sessions,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(result.allVerified, true);
    assert.equal(server.moves.length, 0);
    assert.equal(server.puts.length, 2);
    assert.equal(result.files[0].name.includes("🍷"), false);
    assert.equal(sessions.listFiles(result.sessionId!)[0].finalPath, result.files[0].path);
  } finally {
    database.close();
    await server.close();
    await removeTestDir(runtime);
  }
});

test("direct upload confirmation does not repeat PUT, while explicit recovery permits one retry", async () => {
  const runtime = await createTestDir("upload-transfer-recovery");
  const server = await startWebDavServer();
  const database = new StateDatabase(":memory:");
  try {
    const body = Buffer.from("recoverable-session");
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), body);
    const sessions = new TransferSessionStore(database);
    const config = testConfig({ alistUrl: server.url });
    const first = await uploadWithAList(runtime, "/target", config, {
      cleanupLocal: false,
      files: ["video.mp4"],
      bvid: "BVRECOVER",
      userId: "u1",
      mediaId: 1,
      transferSessionStore: sessions,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(first.allVerified, true);
    server.files.delete("/dav/target/video.mp4");
    const session = sessions.get(first.sessionId!)!;
    sessions.updateFile(session.id, "video.mp4", {
      status: "awaiting_remote",
      putAcceptedAt: Date.now(),
      verifiedAt: null,
      lastError: "test visibility loss",
    });
    sessions.allowReupload(session.id);
    const confirmation = await resumeUploadSession(config, sessions, session.id, { verificationDelaysMs: [0], log: noopLog });
    assert.equal(confirmation.allVerified, false);
    assert.equal(server.puts.length, 1);
    assert.equal(sessions.get(session.id)?.allowReupload, false);
    let permissionConsumes = 0;
    const retried = await resumeUploadSession(config, sessions, session.id, {
      reuploadAuthorizedFiles: ["video.mp4"],
      consumeReuploadPermission: (relativePath) => {
        assert.equal(relativePath, "video.mp4");
        permissionConsumes += 1;
        return permissionConsumes === 1;
      },
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(retried.allVerified, true);
    assert.equal(server.puts.length, 2);
    assert.equal(permissionConsumes, 1);
    assert.equal(sessions.get(session.id)?.allowReupload, false);
    assert.equal(sessions.get(session.id)?.lastError, undefined);
    assert.ok(sessions.get(session.id)?.completedAt);
    const verifiedFile = sessions.getFile(session.id, "video.mp4");
    assert.equal(verifiedFile?.lastError, undefined);
    assert.equal(verifiedFile?.nextCheckAt, undefined);
    assert.ok(verifiedFile?.verifiedAt);
  } finally {
    database.close();
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a completed transfer session reopens in place when a later upload uses the same dedupe key", async () => {
  const runtime = await createTestDir("upload-transfer-reopen");
  const server = await startWebDavServer();
  const database = new StateDatabase(":memory:");
  try {
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), Buffer.from("reopen-session"));
    const sessions = new TransferSessionStore(database);
    const config = testConfig({ alistUrl: server.url });
    const first = await uploadWithAList(runtime, "/target", config, {
      cleanupLocal: false,
      files: ["video.mp4"],
      bvid: "BVREOPEN",
      userId: "u1",
      mediaId: 1,
      transferSessionStore: sessions,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(first.allVerified, true);
    const sessionId = first.sessionId;
    const firstGeneration = first.sessionGeneration;
    assert.equal(firstGeneration, 1);
    server.files.delete("/dav/target/video.mp4");

    const second = await uploadWithAList(runtime, "/target", config, {
      cleanupLocal: false,
      files: ["video.mp4"],
      bvid: "BVREOPEN",
      userId: "u1",
      mediaId: 1,
      transferSessionStore: sessions,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(second.sessionId, sessionId);
    assert.equal(second.sessionGeneration, 2);
    assert.equal(second.allVerified, true);
    assert.equal(server.puts.length, 2);
    assert.equal(sessions.get(sessionId!)?.phase, "completed");
    assert.equal(sessions.listFiles(sessionId!, firstGeneration).length, 1);
    assert.equal(sessions.listFiles(sessionId!, 2).length, 1);
    assert.equal(Number((database.db.prepare("SELECT COUNT(*) AS count FROM transfer_session_files WHERE session_id=?").get(sessionId) as any).count), 2);
    await assert.rejects(
      () => resumeUploadSession(config, sessions, sessionId!, { sessionGeneration: firstGeneration, verificationDelaysMs: [0], log: noopLog }),
      (error: any) => error?.uploadSessionStale === true,
    );
    assert.throws(
      () => sessions.updateFile(sessionId!, "video.mp4", { lastError: "stale" }, firstGeneration),
      (error: any) => error?.uploadSessionStale === true,
    );
  } finally {
    database.close();
    await server.close();
    await removeTestDir(runtime);
  }
});

test("explicit upload file list excludes session and debug artifacts", async () => {
  const runtime = await createTestDir("upload-allowlist");
  const server = await startWebDavServer();
  try {
    await fs.promises.mkdir(path.join(runtime, "_history"), { recursive: true });
    await fs.promises.writeFile(path.join(runtime, "video.mp4"), "verified-video");
    await fs.promises.writeFile(path.join(runtime, ".bfb-download.json"), "{}");
    await fs.promises.writeFile(path.join(runtime, "debug_1.json"), "{}");
    await fs.promises.writeFile(path.join(runtime, "_history", "old.mp4"), "old-video");
    await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
      files: ["video.mp4"],
    });
    assert.deepEqual(server.puts.map((put) => put.path), ["/dav/target/video.mp4"]);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a failed request can be retried with a fresh full stream", async () => {
  const runtime = await createTestDir("upload-retry");
  const server = await startWebDavServer({ failFirstPut: true });
  try {
    const payload = Buffer.from("fresh-stream-content");
    await fs.promises.writeFile(path.join(runtime, "retry.m4a"), payload);
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
        cleanupLocal: false,
        verificationDelaysMs: [0],
        log: noopLog,
      }),
      UploadOperationError
    );
    await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
    });
    assert.equal(server.puts.length, 2);
    assert.deepEqual(server.puts[0].body, payload);
    assert.deepEqual(server.puts[1].body, payload);
    assert.equal(fs.existsSync(runtime), true);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a four-byte filename falls back once and records the verified compatible remote path", async () => {
  const runtime = await createTestDir("upload-compatible-name");
  const server = await startWebDavServer({ rejectFourByteNames: true });
  try {
    const originalName = "2026-05-29_15-15-39-谁的🍷 自己来认领-爱拍照的千鹤-BV1XeVa6jEog.mp4";
    const compatibleName = "2026-05-29_15-15-39-谁的 自己来认领-爱拍照的千鹤-BV1XeVa6jEog.mp4";
    const payload = Buffer.from("compatible-name-content");
    await fs.promises.writeFile(path.join(runtime, originalName), payload);
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
    });

    assert.equal(server.puts.length, 2);
    assert.equal(server.puts[0].path, `/dav/target/${originalName}`);
    assert.equal(server.puts[1].path, `/dav/target/${compatibleName}`);
    assert.deepEqual(server.puts[0].body, payload);
    assert.deepEqual(server.puts[1].body, payload);
    assert.equal(server.puts[1].headers["content-length"], String(payload.length));
    assert.equal(server.puts[1].headers["transfer-encoding"], undefined);
    assert.equal(result.files[0].name, compatibleName);
    assert.equal(result.files[0].path, `/target/${compatibleName}`);
    assert.equal(fs.existsSync(path.join(runtime, originalName)), true);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("a WebDAV backend that accepts four-byte filenames keeps the original name", async () => {
  const runtime = await createTestDir("upload-original-name");
  const server = await startWebDavServer();
  try {
    const originalName = "title-🍷-BV1TEST.mp4";
    await fs.promises.writeFile(path.join(runtime, originalName), "original-name-content");
    const result = await uploadWithAList(runtime, "/target", testConfig({ alistUrl: server.url }), {
      cleanupLocal: false,
      verificationDelaysMs: [0],
      log: noopLog,
    });

    assert.equal(server.puts.length, 1);
    assert.equal(result.files[0].name, originalName);
    assert.equal(result.files[0].path, `/target/${originalName}`);
  } finally {
    await server.close();
    await removeTestDir(runtime);
  }
});

test("compatible filename generation avoids collisions with existing local names", () => {
  const reserved = new Set(["title-BV1TEST.mp4", "title-BV1TEST-compat-2.mp4"]);
  assert.equal(
    buildCompatibilityUploadName("title-🍷BV1TEST.mp4", reserved),
    "title-BV1TEST-compat-3.mp4"
  );
});

test("zero-byte and remote-size mismatch failures preserve local files", async () => {
  const zeroDir = await createTestDir("upload-zero");
  try {
    await fs.promises.writeFile(path.join(zeroDir, "empty.mp4"), Buffer.alloc(0));
    const client = {
      exists: async () => true,
      createDirectory: async () => undefined,
      putFileContents: async () => true,
      stat: async () => ({ size: 0 }),
    } as any;
    await assert.rejects(
      uploadWithAList(zeroDir, "/target", testConfig(), { cleanupLocal: false, client, verificationDelaysMs: [0], log: noopLog }),
      UploadOperationError
    );
    assert.equal(fs.existsSync(path.join(zeroDir, "empty.mp4")), true);

    const mismatchDir = await createTestDir("upload-mismatch");
    try {
      await fs.promises.writeFile(path.join(mismatchDir, "bad.mp4"), "12345");
      const mismatchClient = {
        exists: async () => true,
        createDirectory: async () => undefined,
        putFileContents: async () => true,
        stat: async () => ({ size: 4 }),
      } as any;
      await assert.rejects(
        uploadWithAList(mismatchDir, "/target", testConfig(), { cleanupLocal: false, client: mismatchClient, verificationDelaysMs: [0], log: noopLog }),
        UploadOperationError
      );
      assert.equal(fs.existsSync(path.join(mismatchDir, "bad.mp4")), true);
    } finally {
      await removeTestDir(mismatchDir);
    }
  } finally {
    await removeTestDir(zeroDir);
  }
});

test("ensureRemoteDir ignores only a confirmed concurrent create", async () => {
  let existsCalls = 0;
  const concurrentClient = {
    exists: async () => {
      existsCalls += 1;
      return existsCalls >= 2;
    },
    createDirectory: async () => {
      throw new Error("already exists");
    },
  } as any;
  await ensureRemoteDir(concurrentClient, "/one");

  const authClient = {
    exists: async () => {
      const error: any = new Error("unauthorized");
      error.status = 401;
      throw error;
    },
    createDirectory: async () => undefined,
  } as any;
  await assert.rejects(ensureRemoteDir(authClient, "/one"), /unauthorized/);
});

test("directory errors are classified before queue retry decisions", async () => {
  const runtime = await createTestDir("upload-directory-errors");
  try {
    await fs.promises.writeFile(path.join(runtime, "sample.mp4"), "content");
    for (const status of [401, 403, 405, 429] as const) {
      const client = {
        exists: async () => false,
        stat: async () => {
          const error: any = new Error("missing");
          error.status = 404;
          throw error;
        },
        createDirectory: async () => {
          const error: any = new Error(`directory failure ${status}`);
          error.status = status;
          if (status === 429) error.headers = { "retry-after": "7" };
          throw error;
        },
      } as any;
      await assert.rejects(
        uploadWithAList(runtime, "/target", testConfig(), { cleanupLocal: false, client, log: noopLog }),
        (error: any) => {
          assert.ok(error instanceof UploadOperationError);
          assert.equal(error.uploadFailure.status, status);
          if (status === 401 || status === 403) assert.equal(error.permanent, true);
          if (status === 405) assert.equal(error.deferToNextCycle, true);
          if (status === 429) assert.equal(error.retryAfterMs, 7_000);
          return true;
        }
      );
    }
    assert.equal(fs.existsSync(path.join(runtime, "sample.mp4")), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("an empty local directory is rejected and retained", async () => {
  const runtime = await createTestDir("upload-empty-directory");
  try {
    const client = {
      exists: async () => true,
      createDirectory: async () => undefined,
    } as any;
    await assert.rejects(
      uploadWithAList(runtime, "/target", testConfig(), { cleanupLocal: false, client, log: noopLog }),
      UploadOperationError
    );
    assert.equal(fs.existsSync(runtime), true);
  } finally {
    await removeTestDir(runtime);
  }
});

test("verifyUploadedFile retries delayed visibility and rejects mismatched size", async () => {
  let calls = 0;
  const delayed = {
    stat: async () => {
      calls += 1;
      if (calls < 2) throw new Error("not visible");
      return { size: 10 };
    },
  } as any;
  await verifyUploadedFile(delayed, "/file", 10, [0, 0]);
  assert.equal(calls, 2);

  await assert.rejects(
    verifyUploadedFile({ stat: async () => ({ size: 9 }) } as any, "/file", 10, [0]),
    UploadOperationError
  );
});
