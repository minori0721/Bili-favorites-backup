import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

(globalThis as any).gc?.();
const baselineMemory = process.memoryUsage();
const stateManager = new StateManager();
const scheduler = new SyncScheduler(new ConfigStore(), new UserStore(), stateManager) as any;
scheduler.downloadQueue.setStartGate(() => false);
scheduler.uploadQueue.setStartGate(() => false);
scheduler.resumePersistedWorkOnStartup();

const first = scheduler.getQueueSnapshot();
const removed = scheduler.downloadQueue.queue.splice(0, 20);
for (const task of removed) {
  if (task.persistentJobId) scheduler.jobStore.complete(task.persistentJobId);
}
scheduler.dispatchPersistentJobs();
const second = scheduler.getQueueSnapshot();
scheduler.resumePersistedWorkOnStartup();
const third = scheduler.getQueueSnapshot();
const databaseFiles = ["bfb.sqlite", "bfb.sqlite-wal", "bfb.sqlite-shm"]
  .map((name) => path.join(process.cwd(), "data", name))
  .filter((file) => fs.existsSync(file));
(globalThis as any).gc?.();
const finalMemory = process.memoryUsage();

console.log("RECOVERY_RESULT=" + JSON.stringify({
  stateJsonExists: fs.existsSync(path.join(process.cwd(), "data", "state.json")),
  databaseBytes: databaseFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0),
  firstPending: first.downloadPending.length,
  firstJobs: first.recovery.pendingDownloads,
  secondPending: second.downloadPending.length,
  secondJobs: second.recovery.pendingDownloads,
  thirdJobs: third.recovery.pendingDownloads,
  rss: finalMemory.rss,
  rssDelta: Math.max(0, finalMemory.rss - baselineMemory.rss),
  heapUsed: finalMemory.heapUsed,
  heapUsedDelta: Math.max(0, finalMemory.heapUsed - baselineMemory.heapUsed),
}));
scheduler.stop();
stateManager.close();
