import assert from "node:assert/strict";
import test from "node:test";
import { listRemoteFilesRecursive } from "../src/uploader.js";
import { testConfig } from "./helpers.js";

test("recursive scan accepts literal #/? names from structured directory fields", async () => {
  const result = await listRemoteFilesRecursive(
    testConfig(),
    "/target",
    { maxDepth: 1, maxFiles: 10 },
    {
      getDirectoryContents: async (directory) => {
        assert.equal(directory, "/target");
        return [
          { filename: "/target/clip#one?.mp4", basename: "clip#one?.mp4", type: "file", size: 42 },
          { filename: "/target/readme.txt", basename: "readme.txt", type: "file", size: 1 },
        ];
      },
    } as any,
  );

  assert.equal(result.complete, true);
  assert.deepEqual(result.files, [{
    name: "clip#one?.mp4",
    path: "/target/clip#one?.mp4",
    dir: "/target",
    size: 42,
  }]);
});

test("recursive scan reports incomplete when an entry cannot be safely parsed", async () => {
  const result = await listRemoteFilesRecursive(
    testConfig(),
    "/target",
    { maxDepth: 1, maxFiles: 10 },
    {
      getDirectoryContents: async () => [
        { filename: "/target/unrelated\0.mp4", basename: "unrelated.mp4", type: "file", size: 1 },
        { filename: "/target/clip#one?.mp4", basename: "clip#one?.mp4", type: "file", size: 42 },
      ],
    } as any,
  );

  assert.equal(result.complete, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, "clip#one?.mp4");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /解析失败/);
});

test("recursive scan reports incomplete when a directory cannot be read", async () => {
  const result = await listRemoteFilesRecursive(
    testConfig(),
    "/target",
    { maxDepth: 1, maxFiles: 10 },
    {
      getDirectoryContents: async () => { throw new Error("temporary listing failure"); },
    } as any,
  );

  assert.equal(result.complete, false);
  assert.deepEqual(result.files, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /目录读取失败/);
});
