import assert from "node:assert/strict";
import test from "node:test";
import {
  RenamePreviewSessionStore,
  type RenamePreviewRemoteScanInfo,
} from "../src/rename-preview-session.js";
import type { InternalRenamePreviewData } from "../src/rename-preview.js";

function scan(status: RenamePreviewRemoteScanInfo["status"], id = "scan-1"): RenamePreviewRemoteScanInfo {
  return { id, status, startedAt: 0, ...(status === "ready" ? { completedAt: 1, complete: true } : {}) };
}

function preview(candidate = true): InternalRenamePreviewData {
  return {
    candidates: candidate ? [{
      bvid: "BVSESSION",
      title: "会话候选",
      ownerName: "测试UP",
      remoteDir: "/backup",
      oldName: "old-BVSESSION.mp4",
      newName: "new-BVSESSION.mp4",
      oldPath: "/backup/old-BVSESSION.mp4",
      newPath: "/backup/new-BVSESSION.mp4",
      reason: "测试",
      sourceAccessPath: "/backup/old-BVSESSION.mp4",
      expectedSize: 12,
    }] : [],
    skipped: [],
    skippedTotal: 0,
    skippedByReason: {},
    complete: true,
    scannedFiles: candidate ? 1 : 0,
    scanLimit: 100,
  };
}

test("rename preview sessions reuse valid snapshots and keep access paths private", () => {
  const store = new RenamePreviewSessionStore({ now: () => 1_000, ttlMs: 300_000, maxEntries: 8 });
  const first = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("scanning"),
    remoteSignature: "scanning-1",
  });
  const reused = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("scanning"),
    remoteSignature: "scanning-1",
  });

  assert.equal(reused.previewId, first.previewId);
  assert.equal(reused.revision, 1);
  assert.equal(reused.candidates.length, 1);
  assert.ok(reused.candidates[0].candidateId);
  assert.equal("sourceAccessPath" in reused.candidates[0], false);
  assert.equal("expectedSize" in reused.candidates[0], false);
});

test("complete remote scans replace local candidates and preserve IDs for unchanged candidates", () => {
  const store = new RenamePreviewSessionStore({ now: () => 1_000 });
  const first = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("scanning"),
    remoteSignature: "scanning-1",
  });
  const oldId = first.candidates[0].candidateId;
  const changed = store.applyScan(first.previewId, {
    current: preview(false),
    remoteScan: scan("ready"),
    remoteSignature: "ready-1",
  });
  assert.equal(changed, true);
  const after = store.getResponse(first.previewId)!;
  assert.equal(after.revision, 2);
  assert.deepEqual(after.candidates, []);
  assert.equal(store.beginExecution(first.previewId, [oldId]).kind, "invalid");
});

test("rename execution consumes candidate IDs once and makes duplicate requests idempotent", () => {
  const store = new RenamePreviewSessionStore({ now: () => 1_000 });
  const created = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("scanning"),
    remoteSignature: "scanning-1",
  });
  const candidateId = created.candidates[0].candidateId;
  const started = store.beginExecution(created.previewId, [candidateId]);
  assert.equal(started.kind, "started");
  assert.equal(store.beginExecution(created.previewId, [candidateId]).kind, "in_progress");
  const result = { success: 1, failed: 0, results: [] };
  store.finishExecution(created.previewId, result);
  const repeated = store.beginExecution(created.previewId, [candidateId]);
  assert.equal(repeated.kind, "completed");
  if (repeated.kind === "completed") assert.deepEqual(repeated.result, result);
  assert.deepEqual(store.getResponse(created.previewId)?.candidates, []);
  assert.deepEqual(store.getResponse(created.previewId, true)?.skipped, []);
});

test("expired rename preview sessions cannot be executed", () => {
  let now = 0;
  const store = new RenamePreviewSessionStore({ now: () => now, ttlMs: 100 });
  const created = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("scanning"),
    remoteSignature: "scanning-1",
  });
  now = 101;
  assert.equal(store.get(created.previewId), undefined);
  assert.equal(store.beginExecution(created.previewId, [created.candidates[0].candidateId]).kind, "missing");
});

test("config invalidation removes stale previews but keeps an executing result alive", () => {
  const store = new RenamePreviewSessionStore({ now: () => 1_000, maxEntries: 8 });
  const first = store.create({
    key: "config-1",
    configKey: "config-1",
    scanId: "scan-1",
    local: preview(),
    current: preview(),
    remoteScan: scan("ready"),
    remoteSignature: "ready-1",
  });
  const executing = store.create({
    key: "config-2",
    configKey: "config-2",
    scanId: "scan-2",
    local: preview(),
    current: preview(),
    remoteScan: scan("ready", "scan-2"),
    remoteSignature: "ready-2",
  });
  store.beginExecution(executing.previewId, [executing.candidates[0].candidateId]);
  store.invalidateConfig("config-2");
  assert.equal(store.get(first.previewId), undefined);
  assert.ok(store.get(executing.previewId));
});
