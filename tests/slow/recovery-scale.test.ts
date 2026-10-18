import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { StateFile } from '../../src/state.js';
import { writeJsonFile } from '../../src/storage.js';
import { createTestDir, removeTestDir, testConfig } from '../helpers.js';

test("1000 persisted tasks stay bounded and refill at the low-water mark", async () => {
  const runtime = await createTestDir("scheduler-stress");
  try {
    const dataDir = path.join(runtime, "data");
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.mkdir(path.join(runtime, "temp"), { recursive: true });
    const state: StateFile = {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: {},
      relations: {},
      folderScans: {},
      userCooldowns: {},
    };
    const padding = "x".repeat(6000);
    for (let index = 0; index < 1000; index += 1) {
      const bvid = `BVSTRESS${String(index).padStart(6, "0")}`;
      assert.ok(state.videos);
      state.videos[bvid] = {
        bvid,
        title: `Stress ${index}`,
        upperName: "Stress",
        description: padding,
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        biliStatus: "available" as const,
        backupStatus: index % 2 === 0 ? "uploading" : "queued",
      };
      assert.ok(state.relations);
      state.relations[`u1:1:${bvid}`] = {
        userId: "u1",
        mediaId: 1,
        bvid,
        folderTitle: "Stress",
        firstSeenAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        activeInFavorite: true,
        backupStatus: index % 2 === 0 ? "uploading" : "queued",
        remotePath: `/backup/${bvid}`,
      };
    }
    writeJsonFile(path.join(dataDir, "state.json"), state);
    writeJsonFile(path.join(dataDir, "config.json"), testConfig({ queuePrefetchLimit: 25 }));
    writeJsonFile(path.join(dataDir, "users.json"), [{
      id: "u1",
      uid: 1,
      name: "Stress",
      cookie: { SESSDATA: "test", bili_jct: "test", DedeUserID: "1" },
      favorites: [{ mediaId: 1, title: "Stress" }],
      enabled: true,
      lastLoginAt: "2026-07-10T00:00:00.000Z",
    }]);
    const originalBytes = (await fs.promises.stat(path.join(dataDir, "state.json"))).size;
    const repoRoot = process.cwd();
    const result = spawnSync(process.execPath, [
      "--expose-gc",
      path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(repoRoot, "tests", "recovery-harness.ts"),
    ], {
      cwd: runtime,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: "test", BFB_TEST_APP_ROOT: runtime },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("RECOVERY_RESULT="));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice("RECOVERY_RESULT=".length));
    assert.equal(data.stateJsonExists, false);
    assert.ok(data.databaseBytes <= originalBytes * 3);
    assert.equal(data.firstPending, 25);
    assert.equal(data.firstJobs, 1000);
    assert.equal(data.secondPending, 25);
    assert.equal(data.secondJobs, 980);
    assert.equal(data.thirdJobs, 980);
    assert.ok(data.heapUsed < 192 * 1024 * 1024, `recovery process heap too high: ${data.heapUsed} (delta ${data.heapUsedDelta})`);
    assert.ok(
      data.rssDelta < 512 * 1024 * 1024,
      `recovery process RSS growth too high: ${data.rssDelta} (final ${data.rss})`,
    );
  } finally {
    await removeTestDir(runtime);
  }
});
