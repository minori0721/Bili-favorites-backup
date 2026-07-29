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

function harness(options: { removeError?: Error; retireError?: Error; preview?: any } = {}) {
  const user = account();
  let storedUser: BiliUser | null = user;
  const calls: string[] = [];
  const archiveDeletion = {
    get: (_id: string) => options.preview,
    rememberAccount: () => { calls.push("remember"); },
    markAccountRemoved: () => { calls.push("mark-removed"); },
    restoreAccount: () => { calls.push("restore-snapshot"); return true; },
    validateStart: () => { calls.push("validate"); },
    start: () => { calls.push("start"); return { id: "delete-1", status: "pending" }; },
  };
  const scheduler = {
    retireUser: async () => {
      calls.push("retire");
      if (options.retireError) throw options.retireError;
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
  const result = await executeAccountRemoval(fixture as any, fixture.user);
  assert.equal(result.mode, "account_only");
  assert.equal(result.operation, undefined);
  assert.deepEqual(fixture.calls, ["remember", "retire", "mark-removed", "remove"]);
  assert.equal(fixture.getStoredUser(), null);
});

test("account and remote removal validates the bound preview before starting", async () => {
  const fixture = harness({ preview: { id: "preview-1", scope: "account", userId: "1001" } });
  const result = await executeAccountRemoval(fixture as any, fixture.user, {
    mode: "account_and_remote",
    previewId: "preview-1",
    confirmation: "DELETE REMOTE ARCHIVE",
  });
  assert.deepEqual(result.operation, { id: "delete-1", status: "pending" });
  assert.deepEqual(fixture.calls, ["remember", "retire", "validate", "mark-removed", "remove", "start"]);

  const mismatch = harness({ preview: { id: "preview-2", scope: "source", userId: "1001" } });
  await assert.rejects(() => executeAccountRemoval(mismatch as any, mismatch.user, {
    mode: "account_and_remote", previewId: "preview-2", confirmation: "DELETE REMOTE ARCHIVE",
  }), /预览不存在或已失效/);
  assert.deepEqual(mismatch.calls, []);
});

test("account removal restores the account and scheduler when config persistence fails", async () => {
  const fixture = harness({ removeError: new Error("users.json write failed") });
  await assert.rejects(() => executeAccountRemoval(fixture as any, fixture.user), /write failed/);
  assert.equal(fixture.getStoredUser()?.id, fixture.user.id);
  assert.deepEqual(fixture.calls, [
    "remember", "retire", "mark-removed", "remove", "restore-snapshot", "restore-scheduler",
  ]);
});

test("account removal also rolls back a partially failed scheduler retirement", async () => {
  const fixture = harness({ retireError: new Error("retirement failed") });
  await assert.rejects(() => executeAccountRemoval(fixture as any, fixture.user), /retirement failed/);
  assert.equal(fixture.getStoredUser()?.id, fixture.user.id);
  assert.deepEqual(fixture.calls, ["remember", "retire", "restore-snapshot", "restore-scheduler"]);
});
