import { ConfigStore } from "../src/config.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

const stateManager = new StateManager();
const scheduler = new SyncScheduler(new ConfigStore(), new UserStore(), stateManager) as any;
scheduler.downloadQueue.setStartGate(() => false);
scheduler.uploadQueue.setStartGate(() => false);
scheduler.resumePersistedWorkOnStartup();

const initial = scheduler.getQueueSnapshot();
const uploadOrder = initial.uploadPending.map((item: any) => item.bvid);
const blocked = scheduler.canStartDownloadTask();
const uploads = scheduler.uploadQueue.queue.splice(0);
for (const task of uploads) {
  if (task.persistentJobId) scheduler.jobStore.complete(task.persistentJobId);
}
scheduler.dispatchPersistentJobs();
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
