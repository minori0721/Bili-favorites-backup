import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  ensureRemoteDir,
  uploadWithAList,
  verifyUploadedFile,
} from "../src/uploader.js";
import { UploadOperationError } from "../src/upload-health.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

const noopLog = { push() {} };

function xmlEscape(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" }[char]!));
}

async function startWebDavServer(options: { failFirstPut?: boolean; remoteSizeOffset?: number; putStatus?: 201 | 204 } = {}) {
  const directories = new Set(["/dav"]);
  const files = new Map<string, Buffer>();
  const puts: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  let putCount = 0;

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
      files.set(requestPath, body);
      res.statusCode = options.putStatus || 201;
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
