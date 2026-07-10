import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { computeTaskRetryDelayMs } from "../src/queue.js";
import {
  classifyUploadError,
  captureUploadResponseBody,
  sanitizeUploadText,
  UploadCircuitBreaker,
} from "../src/upload-health.js";

test("upload error text redacts credentials", () => {
  const text = sanitizeUploadText('Authorization: Bearer abc Cookie=sessionKey=secret password=hunter2 https://u:p@example.com/a?token=xyz');
  assert.doesNotMatch(text, /abc|secret|hunter2|u:p|xyz/);
  assert.match(text, /REDACTED/);
  const jsonText = sanitizeUploadText('{"code":401,"message":"token=secret"}');
  assert.equal(jsonText, '{"code":401,"message":"token=[REDACTED]"}');
});

test("upload response body is captured with a hard size limit before sanitizing", async () => {
  const error: any = { response: { body: Readable.from(["InvalidArgument token=secret ", "x".repeat(5000)]) } };
  await captureUploadResponseBody(error, 64);
  assert.ok(Buffer.byteLength(error.responseBody) <= 64);
  assert.doesNotMatch(sanitizeUploadText(error.responseBody), /secret/);
});

test("upload errors are classified without treating wrapped network 405 as deterministic", () => {
  const auth = classifyUploadError({ status: 401, message: "unauthorized" }, "/a");
  assert.equal(auth.category, "auth");
  assert.equal(auth.retryable, false);

  const wrappedReset = classifyUploadError({ status: 405, code: "ECONNRESET", message: "write ECONNRESET" }, "/a");
  assert.equal(wrappedReset.category, "transient");
  assert.equal(wrappedReset.retryable, true);

  const invalid = classifyUploadError({ status: 405, message: "InvalidArgument: necessary parameters cannot be null" }, "/a");
  assert.equal(invalid.category, "deterministic");
  assert.equal(invalid.retryable, false);

  const rateLimited = classifyUploadError({ status: 429, message: "slow down", headers: { "retry-after": "12" } }, "/a");
  assert.equal(rateLimited.category, "rate_limit");
  assert.equal(rateLimited.retryAfterMs, 12_000);

  assert.equal(classifyUploadError({ status: 500, message: "backend failed" }, "/a").category, "server");
  assert.equal(classifyUploadError({ code: "ETIMEDOUT", message: "request timeout" }, "/a").category, "transient");
});

test("retry delay uses exponential backoff, jitter and explicit Retry-After", () => {
  assert.equal(computeTaskRetryDelayMs(5, 0, undefined, () => 0.5), 5000);
  assert.equal(computeTaskRetryDelayMs(5, 1, undefined, () => 0.5), 10000);
  assert.equal(computeTaskRetryDelayMs(5, 5, 12000, () => 0), 12000);
});

test("circuit opens for auth, repeated deterministic failures and half-open failure", () => {
  const authCircuit = new UploadCircuitBreaker();
  const auth = classifyUploadError({ status: 403, message: "forbidden" }, "/a");
  assert.equal(authCircuit.recordFailure("a", auth, 1000), true);
  assert.equal(authCircuit.getSnapshot().state, "open");
  assert.equal(authCircuit.allowUploadStart("probe", 60_999), false);
  assert.equal(authCircuit.allowUploadStart("probe", 61_000), true);
  assert.equal(authCircuit.getSnapshot().state, "half_open");
  authCircuit.recordFailure("probe", auth, 61_001);
  assert.equal(authCircuit.getSnapshot().retryAt, 181_001);

  const deterministicCircuit = new UploadCircuitBreaker();
  const deterministic = classifyUploadError({ status: 405, message: "InvalidArgument parameters null" }, "/x/BV1");
  assert.equal(deterministicCircuit.recordFailure("one", deterministic, 1000), false);
  assert.equal(deterministicCircuit.recordFailure("one", deterministic, 1100), false);
  assert.equal(deterministicCircuit.recordFailure("two", deterministic, 1200), true);
  assert.equal(deterministicCircuit.getSnapshot().state, "open");
});

test("five transient failures open the circuit and success resets it", () => {
  const circuit = new UploadCircuitBreaker();
  const transient = classifyUploadError({ code: "ECONNRESET", message: "socket reset" }, "/a");
  for (let index = 0; index < 4; index += 1) {
    assert.equal(circuit.recordFailure(String(index), transient, 1000 + index), false);
  }
  assert.equal(circuit.recordFailure("five", transient, 1005), true);
  assert.equal(circuit.allowUploadStart("probe", 61_005), true);
  circuit.recordSuccess("probe");
  assert.equal(circuit.getSnapshot().state, "closed");
  assert.equal(circuit.getSnapshot().pausedDownloads, false);
});

test("an old concurrent success cannot close an open or half-open circuit", () => {
  const circuit = new UploadCircuitBreaker();
  const auth = classifyUploadError({ status: 401, message: "unauthorized" }, "/a");
  circuit.recordFailure("failed", auth, 1_000);
  assert.equal(circuit.recordSuccess("old-success"), false);
  assert.equal(circuit.getSnapshot().state, "open");

  assert.equal(circuit.allowUploadStart("probe", 61_000), true);
  assert.equal(circuit.recordSuccess("old-success"), false);
  assert.equal(circuit.getSnapshot().state, "half_open");
  assert.equal(circuit.recordSuccess("probe"), true);
  assert.equal(circuit.getSnapshot().state, "closed");
});

test("deterministic fingerprints ignore request ids", () => {
  const first = classifyUploadError({ status: 405, message: "request 01234567-89ab-cdef-0123-456789abcdef InvalidArgument" }, "/a");
  const second = classifyUploadError({ status: 405, message: "request fedcba98-7654-3210-fedc-ba9876543210 InvalidArgument" }, "/a");
  assert.equal(first.fingerprint, second.fingerprint);
});
