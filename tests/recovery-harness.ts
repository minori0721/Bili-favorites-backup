import { heldQueues } from './fixtures/held-queues.js';
import { PersistentJobStore } from '../src/job-store.js';
import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

if ('gc' in globalThis && typeof globalThis.gc === 'function') globalThis.gc();
const baselineMemory = process.memoryUsage();
const stateManager = new StateManager();
const queues = heldQueues();
const jobs = new PersistentJobStore(stateManager.getDatabase(), {normalizeRecovery: false});
const scheduler = new SyncScheduler(new ConfigStore(), new UserStore(), stateManager, {createQueue: queues.create});
await scheduler.resumePersistedWorkOnStartup();

const first = scheduler.getQueueSnapshot();
const downloadQueue = queues.get('download');
const removed = downloadQueue.getTasks().slice(0, 20);
const removedIds = new Set(removed.map(task => task.id));
downloadQueue.removePendingTasks(task => removedIds.has(task.id));
for (const task of removed) {
  if (task.persistentJobId) jobs.complete(task.persistentJobId);
}
scheduler.wake();
const second = scheduler.getQueueSnapshot();
await scheduler.resumePersistedWorkOnStartup();
const third = scheduler.getQueueSnapshot();
const databaseFiles = ["bfb.sqlite", "bfb.sqlite-wal", "bfb.sqlite-shm"]
  .map((name) => path.join(process.cwd(), "data", name))
  .filter((file) => fs.existsSync(file));
if ('gc' in globalThis && typeof globalThis.gc === 'function') globalThis.gc();
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
