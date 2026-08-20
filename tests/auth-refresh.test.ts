import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS,
  classifyAuthRefreshError,
  computeAuthRefreshRetryDelayMs,
  isAuthRefreshAttemptBlocked,
  nextAuthRefreshFailureState,
} from "../src/auth-refresh.js";

test("auth refresh classifies permanent token failures before transient wrappers", () => {
  assert.equal(classifyAuthRefreshError({ status: 401, message: "refresh failed" }), "permanent");
  assert.equal(classifyAuthRefreshError({ response: { status: 403 }, message: "forbidden" }), "permanent");
  assert.equal(classifyAuthRefreshError({ originalError: { code: "ERR_REFRESH_TOKEN_INVALID" } }), "permanent");
  assert.equal(classifyAuthRefreshError({ message: "refresh_token expired" }), "permanent");
});

test("auth refresh classifies transport failures as unattended retries", () => {
  assert.equal(classifyAuthRefreshError({ code: "ETIMEDOUT" }), "transient");
  assert.equal(classifyAuthRefreshError({ response: { status: 503 } }), "transient");
  assert.equal(classifyAuthRefreshError({ message: "socket hang up" }), "transient");
  assert.equal(classifyAuthRefreshError({ message: "unexpected response" }), "unknown");
});

test("auth refresh retry delays are 1 hour, 6 hours, then 24 hours", () => {
  assert.equal(computeAuthRefreshRetryDelayMs(1), 60 * 60_000);
  assert.equal(computeAuthRefreshRetryDelayMs(2), 6 * 60 * 60_000);
  assert.equal(computeAuthRefreshRetryDelayMs(3), 24 * 60 * 60_000);
  assert.equal(computeAuthRefreshRetryDelayMs(100), 24 * 60 * 60_000);
});

test("auth refresh failure state resets the streak when category changes", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const transient = nextAuthRefreshFailureState(undefined, undefined, { code: "ECONNRESET" }, now);
  assert.deepEqual(transient, {
    category: "transient",
    attempts: 1,
    retryAt: "2026-08-20T01:00:00.000Z",
  });

  const second = nextAuthRefreshFailureState("transient", 1, { code: "ETIMEDOUT" }, now);
  assert.equal(second.attempts, 2);
  assert.equal(second.retryAt, "2026-08-20T06:00:00.000Z");

  const permanent = nextAuthRefreshFailureState("transient", 2, { status: 401 }, now);
  assert.equal(permanent.category, "permanent");
  assert.equal(permanent.attempts, 1);
  assert.equal(permanent.retryAt, undefined);
});

test("unknown auth refresh errors stop after a bounded number of retries", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const exhausted = nextAuthRefreshFailureState(
    "unknown",
    AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS - 1,
    { message: "unrecognized provider response" },
    now,
  );
  assert.equal(exhausted.category, "unknown");
  assert.equal(exhausted.attempts, AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS);
  assert.equal(exhausted.retryAt, undefined);
});

test("auth refresh attempts honor the persisted backoff and permanent failures", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  assert.equal(isAuthRefreshAttemptBlocked("transient", 1, "2026-08-20T00:30:00.000Z", now), true);
  assert.equal(isAuthRefreshAttemptBlocked("transient", 1, "2026-08-08T00:00:00.000Z", now), false);
  assert.equal(isAuthRefreshAttemptBlocked("permanent", 1, undefined, now), true);
  assert.equal(isAuthRefreshAttemptBlocked("unknown", AUTH_REFRESH_MAX_UNKNOWN_ATTEMPTS, undefined, now), true);
});
