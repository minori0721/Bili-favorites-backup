import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager, type StateFile } from "../src/state.js";
import { UserStore } from "../src/users.js";
import { writeJsonFile } from "../src/storage.js";
import path from "node:path";

const statePath = path.join(process.cwd(), "data", "state.json");
let writes = 0;
let writtenBytes = 0;
const stateManager = new StateManager({
  statePath,
  writeState(filePath: string, value: StateFile) {
    writes += 1;
    const serialized = JSON.stringify(value, null, 2);
    writtenBytes += Buffer.byteLength(serialized);
    writeJsonFile(filePath, value);
  },
});
const scheduler = new SyncScheduler(new ConfigStore(), new UserStore(), stateManager) as any;
scheduler.downloadQueue.setStartGate(() => false);
scheduler.uploadQueue.setStartGate(() => false);
scheduler.resumePersistedWorkOnStartup();

const first = scheduler.getQueueSnapshot();
scheduler.downloadQueue.queue.splice(0, 20);
scheduler.drainRecoveryBacklog();
const second = scheduler.getQueueSnapshot();

console.log("RECOVERY_RESULT=" + JSON.stringify({
  writes,
  writtenBytes,
  firstPending: first.downloadPending.length,
  firstBacklog: first.recovery.pendingDownloads,
  secondPending: second.downloadPending.length,
  secondBacklog: second.recovery.pendingDownloads,
  rss: process.memoryUsage().rss,
}));
process.exit(0);
