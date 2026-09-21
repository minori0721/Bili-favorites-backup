import assert from 'node:assert/strict';
import { heldQueues } from './fixtures/held-queues.js';
import { recoveryFixture } from './fixtures/recovery.js';
import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

const stateManager = new StateManager();
const config = new ConfigStore();
const users = new UserStore();
const queues = heldQueues();
const {jobs, downloads} = recoveryFixture(stateManager, users.list(), undefined, {config: config.get()});
const scheduler = new SyncScheduler(config, users, stateManager, {createQueue: queues.create});
await scheduler.resumePersistedWorkOnStartup();

const initial = scheduler.getQueueSnapshot();
const uploadOrder = initial.uploadPending.map((item) => item.bvid);
const pending = jobs.list(['download'], 1)[0];
assert.ok(pending);
const candidate = downloads.build(pending);
assert.ok(candidate);
const blocked = queues.get('download').admitted(candidate);
const uploads = queues.get('upload').getTasks();
queues.get('upload').removePendingTasks(() => true);
for (const task of uploads) {
  if (task.persistentJobId) jobs.complete(task.persistentJobId);
}
scheduler.wake();
const released = scheduler.getQueueSnapshot();

console.log("RECOVERY_PRIORITY_RESULT=" + JSON.stringify({
  uploadOrder,
  blocked,
  initialDownloadTasks: initial.downloadPending.length,
  initialDownloadJobs: initial.recovery.pendingDownloads,
  releasedDownloadTasks: released.downloadPending.length,
}));
scheduler.stop();
stateManager.close();
