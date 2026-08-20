import assert from "node:assert/strict";
import test from "node:test";
import {
  isRemotePathWithin,
  joinRemotePath,
  normalizeRemotePath,
  normalizeStoredRemoteFilePath,
  remoteDirname,
} from "../src/remote-path.js";
import { buildStorageDavUrl, parseStorageBaseUrl } from "../src/storage-url.js";

test("strict remote paths handle roots and trailing slashes without accepting traversal", () => {
  assert.equal(normalizeRemotePath("/"), "/");
  assert.equal(normalizeRemotePath("/", { allowRoot: true, allowTrailingSlash: true }), "/");
  assert.equal(normalizeRemotePath("/archive///", { allowTrailingSlash: true }), "/archive");
  assert.equal(joinRemotePath("/", "archive", "video.mp4"), "/archive/video.mp4");
  assert.equal(remoteDirname("/video.mp4"), "/");
  assert.equal(isRemotePathWithin("/archive", "/archive/video.mp4"), true);
  assert.equal(isRemotePathWithin("/archive", "/archive-other/video.mp4"), false);
  assert.equal(normalizeStoredRemoteFilePath("/archive/video.mp4"), "/archive/video.mp4");
  assert.equal(normalizeStoredRemoteFilePath("/archive/video.mp4/"), null);
  assert.throws(() => normalizeRemotePath("/", { allowRoot: false }), /根目录/);
  assert.throws(() => normalizeRemotePath("/archive/"), /非法片段/);
  assert.throws(() => normalizeRemotePath("/archive//video.mp4"), /非法片段/);
  assert.throws(() => normalizeRemotePath("/archive/../video.mp4"), /非法片段/);
  assert.throws(() => joinRemotePath("/archive", "../video.mp4"), /非法片段/);
});

test("storage base URLs preserve AList/OpenList reverse-proxy paths and reject unsafe URL parts", () => {
  assert.equal(buildStorageDavUrl("https://storage.example/openlist/"), "https://storage.example/openlist/dav");
  assert.equal(buildStorageDavUrl("http://127.0.0.1:5244"), "http://127.0.0.1:5244/dav");
  assert.throws(() => parseStorageBaseUrl("https://user:pass@storage.example"), /凭据/);
  assert.throws(() => parseStorageBaseUrl("https://storage.example/openlist?raw=1"), /查询串/);
  assert.throws(() => parseStorageBaseUrl("https://storage.example/openlist#dav"), /片段/);
  assert.throws(() => parseStorageBaseUrl("ftp://storage.example"), /HTTP或HTTPS/);
});

test("shared storage URL parsing preserves reverse-proxy paths for all callers", () => {
  const parsed = parseStorageBaseUrl("http://openlist:5244/gateway/");
  assert.equal(parsed.pathname, "/gateway/");
  assert.equal(buildStorageDavUrl(parsed.toString()), "http://openlist:5244/gateway/dav");
});
