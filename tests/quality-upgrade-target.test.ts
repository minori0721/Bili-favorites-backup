import assert from "node:assert/strict";
import test from "node:test";
import { resolveQualityUpgradeRemoteTarget } from "../src/quality-upgrade-target.js";

test("quality upgrade target rejects missing proofs without parsing an empty path", () => {
  assert.deepEqual(resolveQualityUpgradeRemoteTarget("/archive", { remoteFiles: [] }), {
    ok: false,
    reason: "没有可替换的远端文件记录",
  });
});

test("quality upgrade target derives one strict directory from all file proofs", () => {
  const result = resolveQualityUpgradeRemoteTarget("/archive", {
    remoteFiles: [
      { name: "p1.mp4", path: "/archive/BV1TEST/p1.mp4", size: 10 },
      { name: "p2.mp4", path: "/archive/BV1TEST/p2.mp4", size: 20 },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.remotePath, "/archive/BV1TEST");
  assert.deepEqual(result.oldFiles.map((file) => file.path), [
    "/archive/BV1TEST/p1.mp4",
    "/archive/BV1TEST/p2.mp4",
  ]);
});

test("quality upgrade target fails closed for inconsistent or unsafe legacy proofs", () => {
  assert.match(resolveQualityUpgradeRemoteTarget("/archive", {
    remoteFiles: [
      { name: "p1.mp4", path: "/archive/a/p1.mp4" },
      { name: "p2.mp4", path: "/archive/b/p2.mp4" },
    ],
  }).reason, /多个远端目录/);
  assert.match(resolveQualityUpgradeRemoteTarget("/archive", {
    remoteFiles: [{ name: "p1.mp4", path: "/outside/p1.mp4" }],
  }).reason, /无效或越界/);
  assert.match(resolveQualityUpgradeRemoteTarget("/archive", {
    remotePath: "/archive/other",
    remoteFiles: [{ name: "p1.mp4", path: "/archive/BV1TEST/p1.mp4" }],
  }).reason, /不一致/);
  assert.match(resolveQualityUpgradeRemoteTarget("/archive", {
    remoteFiles: [{ name: "p1.mp4", path: "/archive/BV1TEST/bad\\name.mp4" }],
  }).reason, /无效或越界/);
});
