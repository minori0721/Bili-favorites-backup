import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "../src/config.js";
import { classifyUploadError, UploadOperationError } from "../src/upload-health.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UploadTask } from "../src/tasks.js";
import { UserStore } from "../src/users.js";

const bvid = "BVISOLATED";
const localDir = path.join(process.cwd(), "temp", bvid);
const remotePath = "/backup/isolated";
const stateManager = new StateManager({ statePath: path.join(process.cwd(), "data", "state.json") });
const configStore = new ConfigStore();
const scheduler = new SyncScheduler(configStore, new UserStore(), stateManager) as any;
scheduler.localCacheSnapshot = {
  usedBytes: 0,
  limitBytes: 0,
  reserveBytes: 0,
  paused: false,
  checkedAt: Date.now(),
};

const retryDescriptor = {
  bvid,
  localDir,
  remotePath,
  userId: "u1",
  mediaId: 1,
};
const recoveryKey = scheduler.recoveryUploadKey(retryDescriptor);
const task = new UploadTask(bvid, localDir, remotePath, configStore.get(), { cleanupLocal: false, files: ["isolated.mp4"] });
task.userId = "u1";
task.mediaId = 1;
task.folderTitle = "Favorites";
task.videoTitle = "Isolated upload";
task.upperName = "Tester";
task.sharedDownloadDir = localDir;
task.recoveryKey = recoveryKey;

scheduler.priorityUploadKeys.add(recoveryKey);
scheduler.createSharedUploadDirTracker(localDir, 1, bvid);
const failure = classifyUploadError({ status: 405, message: "Method Not Allowed" }, `${remotePath}/isolated.mp4`);
scheduler.uploadQueue.emit("taskError", task, new UploadOperationError(failure));

await new Promise((resolve) => setTimeout(resolve, 25));
const queuedRetry = scheduler.recoveryUploadBacklog[0];
const state = stateManager.getStateSnapshot();
console.log("ISOLATED_UPLOAD_FAILURE_RESULT=" + JSON.stringify({
  priorityCount: scheduler.priorityUploadKeys.size,
  retryPriority: queuedRetry?.priority,
  retryDelayMs: Number(queuedRetry?.notBefore || 0) - Date.now(),
  canStartDownload: scheduler.canStartDownloadTask(),
  localFileExists: fs.existsSync(path.join(localDir, "isolated.mp4")),
  videoStatus: state.videos?.[bvid]?.backupStatus,
  relationStatus: state.relations?.[`u1:1:${bvid}`]?.backupStatus,
}));
process.exit(0);
