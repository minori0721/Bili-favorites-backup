import type { BiliUser, UserStore } from '../users.js';
import type { StateManager } from '../state.js';
import type { StateDatabase, PersistentJobRecord } from '../database.js';
import type { PersistentJobStore } from '../job-store.js';
import type { TaskQueue } from '../queue.js';
import type { UploadTarget } from '../tasks.js';
import type { cancelActiveDownloadsForAccount } from '../downloader.js';
import { retirementTargets } from './retirement-targets.js';
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'listUserDependentJobs' | 'findByDedupeKey' | 'updatePayload' | 'complete' | 'reassignDownloadJob' | 'pauseDetachedUserJob' | 'list' | 'wakeByBvid' | 'resumeDetachedUserJobs'>;
  stateManager: Pick<StateManager, 'getCompletedLocalDownload' | 'detachUserRelations' | 'reattachUserRelations'>;
  userStore: Pick<UserStore, 'getById' | 'list'>;
  downloadQueue: Pick<TaskQueue, 'getTasks' | 'removePendingTasks'>;
  listRelationsForUser: StateDatabase['listRelationsForUser'];
  cancelDownloads: typeof cancelActiveDownloadsForAccount;
  snapshotRetirementTargets(bvid: string): UploadTarget[];
  queueCompletedRetirementUpload(bvid: string, local: NonNullable<ReturnType<StateManager['getCompletedLocalDownload']>>, targets: UploadTarget[]): number;
  findCompletedQualitySession(job: PersistentJobRecord): { downloadDir: string; outputFiles: string[]; runId: string } | null;
  isUserSyncEligible(user: BiliUser | undefined | null): user is BiliUser;
  enqueueIfNeeded(user: BiliUser, mediaId: number, title: string, bvid: string, options: { persisted: boolean; downloadUserId: string }): boolean;
  wakeChargingAccessProbes(userId: string): unknown;
  dispatchPersistentJobs(): void;
  generation(): number;
  now(): number;
}
export function createAccountRetirement(deps: Dependencies) {
  const abortedJobs = new Set<string>();
  const pending = new Map<string, Promise<Awaited<ReturnType<typeof retireOnce>>>>();
  function retireUser(user: BiliUser) {
    const existing = pending.get(user.id);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => retireOnce(user)).finally(() => { pending.delete(user.id); });
    pending.set(user.id, operation);
    return operation;
  }
  async function retireOnce(user: BiliUser) {
    const epoch = deps.generation();
    const dependentJobs = deps.jobStore.listUserDependentJobs(user.id);
    const jobIds = new Set(dependentJobs.map((job) => job.id));
    const targetsByBvid = new Map<string, UploadTarget[]>();
    for (const relation of deps.listRelationsForUser(user.id)) {
      if (!targetsByBvid.has(relation.bvid)) targetsByBvid.set(relation.bvid, deps.snapshotRetirementTargets(relation.bvid));
    }
    for (const job of dependentJobs) {
      const bvid = String(job.bvid || "");
      if (bvid && !targetsByBvid.has(bvid)) targetsByBvid.set(bvid, deps.snapshotRetirementTargets(bvid));
    }
    for (const [bvid, detachedTargets] of targetsByBvid) {
      const existing = deps.jobStore.findByDedupeKey(`download:${bvid}`);
      if (!existing || jobIds.has(existing.id)) continue;
      const merged = new Map<string, UploadTarget>();
      for (const target of retirementTargets(existing.payload.detachedTargets)) {
        if (target?.userId && Number.isInteger(Number(target.mediaId))) merged.set(`${target.userId}:${target.mediaId}`, target);
      }
      for (const target of detachedTargets) merged.set(`${target.userId}:${target.mediaId}`, target);
      deps.jobStore.updatePayload(existing.id, { ...existing.payload, detachedTargets: [...merged.values()] });
    }
    for (const task of deps.downloadQueue.getTasks()) {
      if (task.persistentJobId && jobIds.has(task.persistentJobId) && task.status === "running") {
        abortedJobs.add(task.persistentJobId);
      }
    }
    const removedQueuedTasks = deps.downloadQueue.removePendingTasks((task) =>
      Boolean(task.persistentJobId && jobIds.has(task.persistentJobId))
    ).length;
    const canceledProcesses = await deps.cancelDownloads(String(user.uid || user.cookie.DedeUserID || ""));
    if (epoch !== deps.generation()) throw Object.assign(new Error('恢复环境已经变化，请重试账号退役'), { statusCode: 409 });
    const alternateUser = deps.userStore.list().find((candidate) => candidate.id !== user.id && deps.isUserSyncEligible(candidate));
    let reassignedJobs = 0;
    let pausedJobs = 0;
    let directUploadTargets = 0;

    for (const job of dependentJobs) {
      const bvid = String(job.bvid || "");
      if (job.kind === "download") {
        const local = bvid ? deps.stateManager.getCompletedLocalDownload(bvid) : null;
        if (local) {
          deps.jobStore.complete(job.id);
          directUploadTargets += deps.queueCompletedRetirementUpload(bvid, local, targetsByBvid.get(bvid) || []);
          continue;
        }
      } else if (job.kind === "quality_download") {
        const completed = deps.findCompletedQualitySession(job);
        if (completed) {
          job.payload = {
            ...job.payload,
            downloadDir: completed.downloadDir,
            outputFiles: completed.outputFiles,
            runId: completed.runId,
          };
        }
      }

      const payload = {
        ...job.payload,
        detachedTargets: job.kind === "download" ? (targetsByBvid.get(bvid) || []) : job.payload.detachedTargets,
      };
      if (alternateUser) {
        if (deps.jobStore.reassignDownloadJob(job.id, alternateUser.id, payload)) reassignedJobs += 1;
      } else if (deps.jobStore.pauseDetachedUserJob(job.id, user.id, payload)) {
        pausedJobs += 1;
      }
    }

    const detachedRelations = deps.stateManager.detachUserRelations(user.id);
    for (const job of deps.jobStore.list(["access_probe"], 100_000)) {
      const preferredUserId = String(job.payload?.preferredUserId || "");
      if (preferredUserId !== user.id) continue;
      deps.jobStore.updatePayload(job.id, { ...job.payload, preferredUserId: "" });
      deps.jobStore.wakeByBvid(String(job.bvid || ""), ["access_probe"], deps.now());
    }
    deps.dispatchPersistentJobs();
    return {
      canceledJobs: dependentJobs.length,
      canceledProcesses,
      removedQueuedTasks,
      reassignedJobs,
      pausedJobs,
      directUploadTargets,
      detachedRelations,
    };
  }


  function restoreUserAfterLogin(userId: string) {
    const user = deps.userStore.getById(userId);
    if (!user?.enabled) return { reattachedRelations: 0, resumedJobs: 0, queuedRelations: 0 };
    const reattachedRelations = deps.stateManager.reattachUserRelations(userId);
    const resumedJobs = deps.jobStore.resumeDetachedUserJobs(userId, deps.now());
    let queuedRelations = 0;
    const relations = deps.listRelationsForUser(userId);
    for (const relation of relations) {
      if (!relation.activeInFavorite || ["uploaded", "verified", "partial_verified", "uploading", "downloaded"].includes(relation.backupStatus || "")) continue;
      if (deps.jobStore.findByDedupeKey(`download:${relation.bvid}`)) continue;
      if (deps.enqueueIfNeeded(user, relation.mediaId, relation.folderTitle, relation.bvid, { persisted: true, downloadUserId: user.id })) {
        queuedRelations += 1;
      }
    }
    deps.wakeChargingAccessProbes(userId);
    deps.dispatchPersistentJobs();
    return { reattachedRelations, resumedJobs, queuedRelations };
  }

  return { retireUser, restoreUserAfterLogin, abortedJobs, get busy() { return pending.size > 0; } };
}
