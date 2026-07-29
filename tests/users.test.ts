import assert from "node:assert/strict";
import test from "node:test";
import {
  biliWebCookieValues,
  buildCookieString,
  downloadCredentialsForUser,
  ensureUserAppBuvid,
  ensureUserAppBuvids,
  generateAppBuvid,
  type BiliUser,
} from "../src/users.js";

function user(id: string, appBuvid?: string): BiliUser {
  return {
    id,
    uid: Number(id),
    name: `User ${id}`,
    cookie: { SESSDATA: "sess", bili_jct: "csrf", DedeUserID: id },
    favorites: [],
    enabled: true,
    lastLoginAt: "2026-07-29T00:00:00.000Z",
    accessToken: "access",
    appBuvid,
  };
}

test("APP buvid generation is stable in format and deterministic with injected entropy", () => {
  const first = generateAppBuvid(() => Buffer.alloc(16, 7));
  const second = generateAppBuvid(() => Buffer.alloc(16, 7));
  assert.equal(first, second);
  assert.match(first, /^XY[0-9a-f]{35}$/);
});

test("all existing users receive one stable APP buvid without replacing valid values", () => {
  const existing = "XY0123456789abcdef0123456789abcdef012";
  const lowercasePrefix = "xy0123456789abcdef0123456789abcdef012";
  const users = [user("1"), user("2", existing), user("3", "invalid"), user("4", lowercasePrefix)];

  assert.equal(ensureUserAppBuvids(users), true);
  assert.match(String(users[0].appBuvid), /^XY[0-9a-f]{35}$/);
  assert.equal(users[1].appBuvid, existing);
  assert.match(String(users[2].appBuvid), /^XY[0-9a-f]{35}$/);
  assert.match(String(users[3].appBuvid), /^XY[0-9a-f]{35}$/);
  assert.notEqual(users[3].appBuvid, lowercasePrefix);
  const generated = users.map((item) => item.appBuvid);
  assert.equal(ensureUserAppBuvids(users), false);
  assert.deepEqual(users.map((item) => item.appBuvid), generated);
  assert.equal(ensureUserAppBuvid(users[0]), false);
});

test("download credentials carry APP identity but the web Cookie header does not", () => {
  const account = user("42");
  const credentials = downloadCredentialsForUser(account);

  assert.equal(credentials.accessToken, "access");
  assert.match(String(credentials.appBuvid), /^XY[0-9a-f]{35}$/);
  const cookie = buildCookieString(credentials);
  assert.match(cookie, /SESSDATA=sess/);
  assert.doesNotMatch(cookie, /access|appBuvid|XY[0-9a-f]{35}/i);
  const webCookieValues = biliWebCookieValues(credentials);
  assert.equal(webCookieValues.SESSDATA, "sess");
  assert.equal("accessToken" in webCookieValues, false);
  assert.equal("refreshToken" in webCookieValues, false);
  assert.equal("appBuvid" in webCookieValues, false);
});
