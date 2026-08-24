import assert from "node:assert/strict";
import test from "node:test";
import { checkRemoteStorageReadOnly } from "../src/storage-diagnostic.js";
import { testConfig } from "./helpers.js";

function httpError(statusCode: number) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

test("read-only storage check only stats the configured destination on success", async () => {
  const calls: string[] = [];
  const result = await checkRemoteStorageReadOnly(testConfig(), {
    stat: async (remotePath: string) => {
      calls.push(remotePath);
      return { type: "directory" };
    },
  } as any);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.writeVerified, false);
  assert.deepEqual(calls, ["/backup"]);
});

test("missing destination is distinguished from a broken WebDAV endpoint", async () => {
  const calls: string[] = [];
  const result = await checkRemoteStorageReadOnly(testConfig(), {
    stat: async (remotePath: string) => {
      calls.push(remotePath);
      if (remotePath === "/backup") throw httpError(404);
      return { type: "directory" };
    },
  } as any);
  assert.equal(result.category, "path");
  assert.equal(result.field, "alistDest");
  assert.deepEqual(calls, ["/backup", "/"]);
});

test("storage diagnostic classifies auth, permission, unsupported and network failures without writes", async () => {
  const cases = [
    { error: httpError(401), category: "auth", field: "alistPassword" },
    { error: httpError(403), category: "permission", field: "alistUsername" },
    { error: httpError(405), category: "unsupported", field: "alistUrl" },
    { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), category: "network", field: "alistUrl" },
  ];
  for (const item of cases) {
    let calls = 0;
    const result = await checkRemoteStorageReadOnly(testConfig(), {
      stat: async () => { calls += 1; throw item.error; },
    } as any);
    assert.equal(result.category, item.category);
    assert.equal(result.field, item.field);
    assert.equal(calls, 1);
  }
});

test("read-only storage check aborts a stalled WebDAV request", async () => {
  let observedSignal: AbortSignal | undefined;
  const stalled = {
    stat: (_remotePath: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      observedSignal = options?.signal;
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  const startedAt = Date.now();
  const result = await checkRemoteStorageReadOnly(testConfig(), stalled as any, 10);
  assert.equal(result.ok, false);
  assert.equal(result.category, "network");
  assert.equal(observedSignal?.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
