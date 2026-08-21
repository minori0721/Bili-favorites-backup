import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteFileResolutionConflictError,
  RemoteFileResolver,
  classifyRemoteFailure,
  isLikelyEncodedFilename,
  normalizeRemoteDirectoryEntry,
  remoteNameMatches,
} from "../src/remote-file-resolver.js";

function notFound() {
  const error: any = new Error("not found");
  error.status = 404;
  return error;
}

test("remote error classification trusts HTTP status over misleading response text", () => {
  assert.equal(classifyRemoteFailure(Object.assign(new Error("not found"), { status: 500 })).category, "transient");
  assert.equal(classifyRemoteFailure(Object.assign(new Error("not found"), { status: 403 })).category, "permission");
  assert.equal(classifyRemoteFailure(Object.assign(new Error("not found"), { status: 404 })).category, "not_found");
  assert.equal(classifyRemoteFailure(Object.assign(new Error("not found"), { code: "EUNKNOWN" })).category, "unknown");
  assert.equal(classifyRemoteFailure(Object.assign(new Error("missing"), { code: "ENOENT" })).category, "not_found");
});

test("safe first-upload names keep the stat fast path and do not list the directory", async () => {
  let statCalls = 0;
  let listCalls = 0;
  const resolver = new RemoteFileResolver({
    stat: async () => {
      statCalls += 1;
      throw notFound();
    },
    getDirectoryContents: async () => {
      listCalls += 1;
      return [];
    },
  });

  const result = await resolver.inspect("/target/plain-video.mp4", { fallback: "risk_only" });
  assert.deepEqual(result, {
    status: "missing",
    path: "/target/plain-video.mp4",
    directory: false,
    source: "stat",
    name: "plain-video.mp4",
  });
  assert.equal(statCalls, 1);
  assert.equal(listCalls, 0);
});

test("OpenList-style escaped punctuation is resolved from one parent directory listing", async () => {
  let listCalls = 0;
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async (directory) => {
      listCalls += 1;
      assert.equal(directory, "/target");
      return [
        { filename: "/target/旅谣\\'米砂'.mp4", basename: "旅谣\\'米砂'.mp4", type: "file", size: 247991104 },
        { filename: "/target/other.mp4", basename: "other.mp4", type: "file", size: 12 },
      ];
    },
  });

  const first = await resolver.inspect("/target/旅谣'米砂'.mp4", { fallback: "risk_only" });
  const second = await resolver.inspect("/target/旅谣'米砂'.mp4", { fallback: "risk_only" });
  assert.equal(first.status, "exists");
  assert.equal(first.size, 247991104);
  assert.equal(first.path, "/target/旅谣\\'米砂'.mp4");
  assert.equal(first.source, "directory");
  assert.deepEqual(second, first);
  assert.equal(listCalls, 1);
});

test("six files in one failed-stat directory share one PROPFIND", async () => {
  let listCalls = 0;
  const names = Array.from({ length: 6 }, (_, index) => `part-${index + 1}'special'.mp4`);
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async () => {
      listCalls += 1;
      return names.map((name, index) => ({
        filename: `/target/${name}`,
        basename: name,
        type: "file",
        size: index + 100,
      }));
    },
  });

  const results = await Promise.all(names.map((name, index) => resolver.inspect(`/target/${name}`, { fallback: "always" })));
  assert.equal(results.filter((result) => result.status === "exists").length, 6);
  assert.equal(listCalls, 1);
});

test("directory size mismatch is observable and never treated as a verified file", async () => {
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async () => [{
      filename: "/target/video'new'.mp4",
      basename: "video'new'.mp4",
      type: "file",
      size: 99,
    }],
  });

  const result = await resolver.inspect("/target/video'new'.mp4", { fallback: "always" });
  assert.equal(result.status, "exists");
  assert.equal(result.size, 99);
  assert.notEqual(result.size, 100);
});

test("multiple normalized candidates fail closed", async () => {
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async () => [
      { filename: "/target/video\\'name.mp4", basename: "video\\'name.mp4", type: "file", size: 10 },
      { filename: "/target/video'name.mp4", basename: "video'name.mp4", type: "file", size: 10 },
    ],
  });

  await assert.rejects(
    resolver.inspect("/target/video'name.mp4", { fallback: "always" }),
    RemoteFileResolutionConflictError,
  );
});

test("comparison normalization does not make ordinary punctuation or case equivalent", () => {
  assert.equal(remoteNameMatches("A 'file'.mp4", "A \\'file\\'.mp4"), true);
  assert.equal(remoteNameMatches("video.mp4", "VIDEO.mp4"), false);
  assert.equal(remoteNameMatches("100%.mp4", "100%.mp4"), true);
  assert.equal(isLikelyEncodedFilename("plain-video.mp4"), false);
  assert.equal(isLikelyEncodedFilename("video'name.mp4"), true);
});

test("structured OpenList fields keep literal hash and question-mark filenames", () => {
  assert.deepEqual(
    normalizeRemoteDirectoryEntry("/target", {
      filename: "/target/clip#one?.mp4",
      basename: "clip#one?.mp4",
      type: "file",
      size: 42,
    }),
    {
      path: "/target/clip#one?.mp4",
      name: "clip#one?.mp4",
      type: "file",
      size: 42,
    },
  );
  assert.equal(
    normalizeRemoteDirectoryEntry("/target", { basename: "clip#one?.mp4", type: "file", size: 42 }).path,
    "/target/clip#one?.mp4",
  );
});

test("href uses URL semantics while percent-encoded punctuation remains valid", () => {
  assert.equal(
    normalizeRemoteDirectoryEntry("/target", {
      href: "/target/clip%23one%3Ftwo.mp4",
      basename: "clip#one?two.mp4",
      type: "file",
      size: 7,
    }).path,
    "/target/clip#one?two.mp4",
  );
  assert.throws(
    () => normalizeRemoteDirectoryEntry("/target", { href: "/target/clip.mp4?token=redacted", type: "file" }),
    /查询串或片段/,
  );
  assert.throws(
    () => normalizeRemoteDirectoryEntry("/target", { href: "/target/clip.mp4#part", type: "file" }),
    /查询串或片段/,
  );
});

test("structured fields and href must identify the same remote path", () => {
  assert.throws(
    () => normalizeRemoteDirectoryEntry("/target", {
      filename: "/target/clip-a.mp4",
      href: "/target/clip-b.mp4",
      basename: "clip-a.mp4",
      type: "file",
    }),
    /路径字段不一致/,
  );
});

test("an unrelated malformed directory entry is isolated from a valid target", async () => {
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async () => [
      { filename: "/target/unrelated\0.mp4", basename: "unrelated.mp4", type: "file", size: 1 },
      { filename: "/target/clip#one?.mp4", basename: "clip#one?.mp4", type: "file", size: 42 },
    ],
  });

  const result = await resolver.inspect("/target/clip#one?.mp4", { fallback: "always" });
  assert.equal(result.status, "exists");
  assert.equal(result.path, "/target/clip#one?.mp4");
  assert.equal(result.size, 42);
});

test("a malformed entry that may be the target fails closed", async () => {
  const resolver = new RemoteFileResolver({
    stat: async () => { throw notFound(); },
    getDirectoryContents: async () => [{
      filename: "/target/clip#one?.mp4\0",
      basename: "clip#one?.mp4",
      type: "file",
      size: 42,
    }],
  });

  await assert.rejects(
    resolver.inspect("/target/clip#one?.mp4", { fallback: "always" }),
    RemoteFileResolutionConflictError,
  );
});
