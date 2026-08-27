import assert from "node:assert/strict";
import test from "node:test";
import { resolveRenameLogicalFile } from "../src/rename-proof.js";

test("strict rename scan entries preserve the legacy path-first behavior", () => {
  const observation = {
    name: "old-BV1TEST.mp4",
    accessPath: "/target/old-BV1TEST.mp4",
    accessDir: "/target",
    strictPath: "/target/old-BV1TEST.mp4",
    strictDir: "/target",
    size: 42,
  };
  assert.equal(resolveRenameLogicalFile(observation, []).ok, true);
  const resolved = resolveRenameLogicalFile(observation, [{
    name: "old-BV1TEST.mp4",
    path: "/target/old-BV1TEST.mp4",
    size: 42,
  }]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.logicalPath, "/target/old-BV1TEST.mp4");
});

test("OpenList escaped rename entries map only through matching path and size proofs", () => {
  const observation = {
    name: "旅谣\\'米砂-BV1TEST.mp4",
    accessPath: "/target/旅谣\\'米砂-BV1TEST.mp4",
    accessDir: "/target",
    size: 99,
  };
  const resolved = resolveRenameLogicalFile(observation, [{
    name: "旅谣'米砂-BV1TEST.mp4",
    path: "/target/旅谣'米砂-BV1TEST.mp4",
    size: 99,
  }]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.logicalPath, "/target/旅谣'米砂-BV1TEST.mp4");

  assert.match(resolveRenameLogicalFile(observation, [{
    name: "旅谣'米砂-BV1TEST.mp4",
    path: "/target/旅谣'米砂-BV1TEST.mp4",
    size: 100,
  }]).reason, /没有匹配/);
});

test("Unicode-equivalent proofs remain ambiguous instead of being guessed", () => {
  const observation = {
    name: "Café-BV1TEST.mp4",
    accessPath: "/target/Café-BV1TEST.mp4",
    accessDir: "/target",
    size: 5,
  };
  const result = resolveRenameLogicalFile(observation, [
    { name: "Café-BV1TEST.mp4", path: "/target/Café-BV1TEST.mp4", size: 5 },
    { name: "Café-BV1TEST.mp4", path: "/target/Café-BV1TEST.mp4", size: 5 },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /多个本地证明/);
});
