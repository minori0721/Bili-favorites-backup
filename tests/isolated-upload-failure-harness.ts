import assert from 'node:assert/strict';
import { heldQueues } from './fixtures/held-queues.js';
import { recoveryFixture } from './fixtures/recovery.js';
import { DownloadTask } from '../src/tasks.js';
import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "../src/config.js";
import { classifyUploadError, UploadOperationError } from "../src/upload-health.js";
import { SyncScheduler } from "../src/scheduler.js";
import { StateManager } from "../src/state.js";
import { UserStore } from "../src/users.js";

const bvid = "BVISOLATED";
const localDir = path.join(process.cwd(), "temp", bvid);
const remotePath = "/backup/isolated";
const stateManager = new StateManager();
const configStore = new ConfigStore();
const users = new UserStore();
const queues = heldQueues();
const {jobs, transfers} = recoveryFixture(stateManager, users.list(), undefined, {config: configStore.get()});
const scheduler = new SyncScheduler(configStore, users, stateManager, {createQueue: queues.create});
transfers.enqueue({
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
scheduler.wake();
const task = queues.get('upload').getTasks()[0];
assert.ok(task?.persistentJobId, 'Durable upload must be admitted into the queue');
const failure = classifyUploadError(
  process.env.BFB_TEST_UPLOAD_SIZE_LIMIT === "1"
    ? { status: 405, responseBody: JSON.stringify({ code: "SingleFileSizeOverLimit", message: "single file too large" }) }
    : { status: 405, message: "Method Not Allowed" },
  `${remotePath}/isolated.mp4`,
);
const uploadError = new UploadOperationError(failure);
if (process.env.BFB_TEST_UPLOAD_SESSION_TRANSIENT === "1") {
  uploadError.uploadFailure.category = "transient";
  uploadError.uploadFailure.retryable = true;
  uploadError.uploadFailure.code = "ALIST_UPLOAD_SESSION_AFTER_PROGRESS";
  uploadError.uploadFailure.fingerprint = "transient|405|alist-upload-session-after-progress";
  uploadError.uploadSessionTransient = true;
  uploadError.completedFilesBeforeFailure = 1;
}
queues.get('upload').emit("taskError", task, uploadError);
queues.get('upload').removePendingTasks(() => true);

await scheduler.getLocalCacheCapacity();
const retry = jobs.findById(task.persistentJobId);
const state = stateManager.getStateSnapshot();
console.log("ISOLATED_UPLOAD_FAILURE_RESULT=" + JSON.stringify({
  retryStatus: retry?.status,
  retryDelayMs: Number(retry?.notBefore || 0) - Date.now(),
  uploadHealthState: scheduler.getQueueSnapshot().uploadHealth.state,
  canStartDownload: queues.get('download').admitted(new DownloadTask('BVUNRELATED', {SESSDATA: 'test', bili_jct: 'test', DedeUserID: '1'}, configStore.get())),
  localFileExists: fs.existsSync(path.join(localDir, "isolated.mp4")),
  awaitingManualRecovery: retry?.payload?.awaitingManualRecovery === true,
  recoveryIssueKind: scheduler.getRecoveryIssues().find((item) => item.id === `upload.${task.persistentJobId}`)?.kind,
  videoStatus: state.videos?.[bvid]?.backupStatus,
  relationStatus: state.relations?.[`u1:1:${bvid}`]?.backupStatus,
}));
scheduler.stop();
stateManager.close();
