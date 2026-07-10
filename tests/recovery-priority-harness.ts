import path from "node:path";
import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

const scheduler = new SyncScheduler(
  new ConfigStore(),
  new UserStore(),
  new StateManager({ statePath: path.join(process.cwd(), "data", "state.json") })
) as any;
scheduler.downloadQueue.setStartGate(() => false);
scheduler.uploadQueue.setStartGate(() => false);
scheduler.resumePersistedWorkOnStartup();

const initial = scheduler.getQueueSnapshot();
const uploadOrder = initial.uploadPending.map((item: any) => item.bvid);
const blocked = scheduler.canStartDownloadTask();
scheduler.priorityUploadKeys.clear();
scheduler.drainRecoveryBacklog(true);
const released = scheduler.getQueueSnapshot();

console.log("RECOVERY_PRIORITY_RESULT=" + JSON.stringify({
  uploadOrder,
  blocked,
  initialDownloadTasks: initial.downloadPending.length,
  initialDownloadBacklog: initial.recovery.pendingDownloads,
  releasedDownloadTasks: released.downloadPending.length,
}));
process.exit(0);
