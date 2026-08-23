import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeJsonFile } from "../src/storage.js";
import { mapQueueBoardTask } from "../src/queue.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { createTestDir, removeTestDir, testConfig } from "./helpers.js";

test("queue board restores manual remote verification metadata after restart", async () => {
  const runtime = await createTestDir("queue-board");
  const bvid = "BV1wzGP6jEPh";
  const nextCheckAt = Date.now() + 5 * 60_000;
  const dataDir = path.join(runtime, "data");
  const statePath = path.join(dataDir, "state.json");
  const dbPath = path.join(dataDir, "state.db");
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtime, "temp"), { recursive: true });
    writeJsonFile(statePath, {
      schemaVersion: 13,
      processedByUser: {},
      failedByUser: {},
      videos: {
        [bvid]: {
          bvid,
          title: "99ninth_ AZUR LANE 2026 Summer Festival",
          upperName: "-キリリ-",
          cover: "https://example.test/cover.jpg",
          firstSeenAt: "2026-08-15T00:00:00.000Z",
          lastSeenAt: "2026-08-15T00:00:00.000Z",
          biliStatus: "available",
          backupStatus: "upload_failed",
        },
      },
      relations: {},
      folderScans: {},
      userCooldowns: {},
    });

    const manager = new StateManager({ statePath, dbPath });
    const scheduler = new SyncScheduler(
      { get: () => testConfig({ queuePrefetchLimit: 25 }) } as any,
      { list: () => [], getById: () => undefined } as any,
      manager,
    ) as any;
    try {
      scheduler.jobStore.enqueue({
        kind: "upload",
        dedupeKey: `upload:user-1:101:${bvid}:main`,
        bvid,
        userId: "user-1",
        mediaId: 101,
        initialStatus: "manual_wait",
        payload: {
          bvid,
          userId: "user-1",
          mediaId: 101,
          folderTitle: "惨6",
          awaitingManualRecovery: true,
          recoveryAssessment: {
            kind: "remote_visibility_timeout",
            checkedAt: Date.now(),
            nextCheckAt,
            localStatus: "available",
            remoteStatus: "missing",
            summary: "远端文件暂不可见，系统会继续只读复核，不会自动重复上传。",
          },
        },
      });

      const item = scheduler.getQueueSnapshot().uploadPending.find((candidate: any) => candidate.bvid === bvid);
      assert.ok(item);
      assert.equal(item.title, "99ninth_ AZUR LANE 2026 Summer Festival");
      assert.equal(item.upperName, "-キリリ-");
      assert.equal(item.cover, "https://example.test/cover.jpg");
      assert.equal(item.folderTitle, "惨6");
      assert.equal(item.phase, "background_wait");
      assert.equal(item.nextAction, "recheck");
      assert.equal(item.nextActionAt, nextCheckAt);
      assert.equal(item.actionRequired, false);
      assert.equal(item.retries, 0);
      assert.equal(item.maxRetries, 3);
      assert.match(item.detail, /远端文件暂不可见/);
    } finally {
      scheduler.stop();
      manager.close();
    }
  } finally {
    await removeTestDir(runtime);
  }
});

test("queue board task mapping rejects non-string cover fields", () => {
  const item = mapQueueBoardTask({
    id: "task-1",
    bvid: "BVTEST",
    cover: true,
    coverLocalPath: true,
    error: new Error("GET https://user:password@example.test/archive/video.mp4?token=secret"),
  }, "upload_pending");
  assert.equal(item.cover, "");
  assert.equal(item.coverLocalPath, undefined);
  assert.ok(item.lastError);
  assert.doesNotMatch(item.lastError!, /password|token=secret/);
});
