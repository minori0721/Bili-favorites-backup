import assert from "node:assert/strict";
import test from "node:test";
import { executeAccountRemoval } from "../src/account-removal.js";
import type { BiliUser } from "../src/users.js";

function account(): BiliUser {
  return {
    id: "1001",
    uid: 1001,
    name: "测试账号",
    cookie: { SESSDATA: "secret", bili_jct: "csrf", DedeUserID: "1001" },
    favorites: [{ mediaId: 1, title: "收藏夹" }],
    enabled: true,
    lastLoginAt: "2026-07-29T00:00:00.000Z",
  };
}

function harness(options: {
  removeError?: Error;
  retireError?: Error;
  quiesce?: () => Promise<void>;
  preview?: any;
} = {}) {
  const user = account();
  let storedUser: BiliUser | null = user;
  let operation: any = options.preview;
  const calls: string[] = [];
  const archiveDeletion = {
    get: (_id: string) => options.preview,
    getAccountOperation: () => operation,
    rememberAccount: () => { calls.push("remember"); },
    markAccountRemoved: () => { calls.push("mark-removed"); },
    restoreAccount: () => { calls.push("restore-snapshot"); return true; },
    beginAccountPreparation: () => {
      calls.push("begin");
      operation = { id: "preview-1", scope: "account", userId: "1001", status: "preparing" };
      return { operation, claimed: true };
    },
    validateAccountPreparation: () => { calls.push("validate-preparing"); },
    completeAccountPreparation: () => {
      calls.push("complete");
      operation = { id: "preview-1", scope: "account", userId: "1001", status: "pending" };
      return operation;
    },
    abortAccountPreparation: () => { calls.push("abort"); operation.status = "preview"; return true; },
  };
  const scheduler = {
    retireUser: async () => {
      calls.push("retire");
      if (options.retireError) throw options.retireError;
      return { detachedRelations: 1 };
    },
    quiesceUserRemoteDeletion: async () => {
      calls.push("quiesce");
      await options.quiesce?.();
      return { canceledProcesses: 0 };
    },
    finalizeUserRemoteDeletion: (_userId: string, commit: () => void) => {
      calls.push("finalize");
      commit();
      return { detachedRelations: 1 };
    },
    restoreUserAfterLogin: () => { calls.push("restore-scheduler"); },
  };
  const userStore = {
    getById: () => storedUser,
    upsert: (next: BiliUser) => { calls.push("upsert"); storedUser = next; },
    remove: () => {
      calls.push("remove");
      if (options.removeError) throw options.removeError;
      storedUser = null;
    },
  };
  return { user, calls, archiveDeletion, scheduler, userStore, getStoredUser: () => storedUser };
}

test("account removal keeps the legacy no-body request as account-only", async () => {
  const fixture = harness();
  const result = await executeAccountRemoval(fixture as any, fixture.user.id);
  assert.equal(result.mode, "account_only");
  assert.equal(result.operation, undefined);
  assert.deepEqual(fixture.calls, ["remember", "retire", "mark-removed", "remove"]);
  assert.equal(fixture.getStoredUser(), null);
});

test("account and remote removal claims preparation before pruning tasks", async () => {
  const fixture = harness({ preview: { id: "preview-1", scope: "account", userId: "1001", status: "preview" } });
  const result = await executeAccountRemoval(fixture as any, fixture.user.id, {
    mode: "account_and_remote",
    previewId: "preview-1",
    confirmation: "DELETE REMOTE ARCHIVE",
  });
  assert.equal(result.operation?.status, "pending");
  assert.deepEqual(fixture.calls, [
    "begin", "quiesce", "validate-preparing", "remember", "finalize", "remove", "mark-removed", "complete",
  ]);

  const mismatch = harness({ preview: { id: "preview-2", scope: "source", userId: "1001" } });
  await assert.rejects(() => executeAccountRemoval(mismatch as any, mismatch.user.id, {
    mode: "account_and_remote", previewId: "preview-2", confirmation: "DELETE REMOTE ARCHIVE",
  }), /预览不存在或已失效/);
  assert.deepEqual(mismatch.calls, []);
});

test("account removal restores the account and scheduler when config persistence fails", async () => {
  const fixture = harness({ removeError: new Error("users.json write failed") });
  await assert.rejects(() => executeAccountRemoval(fixture as any, fixture.user.id), /write failed/);
  assert.equal(fixture.getStoredUser()?.id, fixture.user.id);
  assert.deepEqual(fixture.calls, [
    "remember", "retire", "mark-removed", "remove", "restore-snapshot", "restore-scheduler",
  ]);
});

test("remote account removal releases preparation when users.json cannot be updated", async () => {
  const fixture = harness({
    removeError: new Error("users.json write failed"),
    preview: { id: "preview-1", scope: "account", userId: "1001", status: "preview" },
  });
  await assert.rejects(() => executeAccountRemoval(fixture as any, fixture.user.id, {
    mode: "account_and_remote",
    previewId: "preview-1",
    confirmation: "DELETE REMOTE ARCHIVE",
  }), /write failed/);
  assert.equal(fixture.getStoredUser()?.id, fixture.user.id);
  assert.deepEqual(fixture.calls, [
    "begin", "quiesce", "validate-preparing", "remember", "finalize", "remove",
    "abort", "restore-snapshot", "restore-scheduler",
  ]);
});

test("account removal also rolls back a partially failed scheduler retirement", async () => {
  const fixture = harness({ retireError: new Error("retirement failed") });
  await assert.rejects(() => executeAccountRemoval(fixture as any, fixture.user.id), /retirement failed/);
  assert.equal(fixture.getStoredUser()?.id, fixture.user.id);
  assert.deepEqual(fixture.calls, ["remember", "retire", "restore-snapshot", "restore-scheduler"]);
});

test("concurrent remote removals return one operation without restoring the removed account", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fixture = harness({
    preview: { id: "preview-1", scope: "account", userId: "1001", status: "preview" },
    quiesce: () => wait,
  });
  const request = {
    mode: "account_and_remote",
    previewId: "preview-1",
    confirmation: "DELETE REMOTE ARCHIVE",
  };
  const first = executeAccountRemoval(fixture as any, fixture.user.id, request);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = executeAccountRemoval(fixture as any, fixture.user.id, request);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.operation?.id, "preview-1");
  assert.equal(secondResult.operation?.id, "preview-1");
  assert.equal(fixture.getStoredUser(), null);
  assert.equal(fixture.calls.filter((call) => call === "begin").length, 1);
  assert.equal(fixture.calls.filter((call) => call === "remove").length, 1);
  assert.equal(fixture.calls.includes("upsert"), false);
});
