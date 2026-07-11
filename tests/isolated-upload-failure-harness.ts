import fs from "node:fs";
import { ConfigStore } from "../src/config.js";
import { classifyUploadError, UploadOperationError } from "../src/upload-health.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

const bvid = "BVISOLATED";
const localDir = `${process.cwd()}\\temp\\${bvid}`;
const remotePath = "/backup/isolated";
const stateManager = new StateManager();
const configStore = new ConfigStore();
const scheduler = new SyncScheduler(configStore, new UserStore(), stateManager) as any;
scheduler.localCacheSnapshot = { usedBytes: 0, limitBytes: 0, reserveBytes: 0, paused: false, checkedAt: Date.now() };
scheduler.uploadQueue.setStartGate(() => false);
scheduler.queueUploadWork({
  bvid,
  localDir,
  remotePath,
  userId: "u1",
  mediaId: 1,
  folderTitle: "Favorites",
  videoTitle: "Isolated upload",
  upperName: "Tester",
  files: ["isolated.mp4"],
  priority: true,
});
const task = scheduler.uploadQueue.getTasks()[0];
const failure = classifyUploadError({ status: 405, message: "Method Not Allowed" }, `${remotePath}/isolated.mp4`);
scheduler.uploadQueue.emit("taskError", task, new UploadOperationError(failure));
scheduler.uploadQueue.queue.splice(0);

await new Promise((resolve) => setTimeout(resolve, 25));
const retry = scheduler.jobStore.findById(task.persistentJobId);
const state = stateManager.getStateSnapshot();
console.log("ISOLATED_UPLOAD_FAILURE_RESULT=" + JSON.stringify({
  retryStatus: retry?.status,
  retryDelayMs: Number(retry?.notBefore || 0) - Date.now(),
  canStartDownload: scheduler.canStartDownloadTask(),
  localFileExists: fs.existsSync(`${localDir}\\isolated.mp4`),
  videoStatus: state.videos?.[bvid]?.backupStatus,
  relationStatus: state.relations?.[`u1:1:${bvid}`]?.backupStatus,
}));
scheduler.stop();
stateManager.close();
