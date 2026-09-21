import { DownloadTask, QualityUpgradeDownloadTask } from '../tasks.js';
import type { BiliUser, UserStore } from '../users.js';
import type { StateManager } from '../state.js';
import type { JobRepository, PersistentJobKind } from '../repositories/jobs.js';
import type { TaskQueue } from '../queue.js';
import type { UploadTarget } from '../tasks.js';
import type { cancelActiveDownloadsForAccount } from '../downloader.js';
import { sanitizeUploadText } from '../upload-health.js';
import { qualityTargetsFromPayload } from './quality-rules.js';
import { retirementTargets, record, archiveTaskReferencesUser } from './retirement-targets.js';
import { readTaskFailure } from './task-failure.js';
type Queue = Pick<TaskQueue, 'getTasks' | 'removePendingTasks' | 'poke'>;
interface Dependencies {
  jobStore: Pick<JobRepository, 'list' | 'updatePayload' | 'complete' | 'reassignDownloadJob' | 'wakeByBvid'>;
  userStore: Pick<UserStore, 'getById' | 'list'>;
  stateManager: Pick<StateManager, 'getCompletedLocalDownload' | 'detachUserRelations' | 'markDownloaded' | 'reload' | 'listRelationsForUser' | 'runAtomic'>;
  downloadQueue: Queue; uploadQueue: Queue; verificationQueue: Queue;
  cancelDownloads: typeof cancelActiveDownloadsForAccount;
  isDeletionLocked(): boolean;
  isSyncing(userId: string): boolean;
  markAborted(jobId: string): void;
  archiveDeletionTargetMatches(userId: unknown, mediaId: unknown, bvid: string): boolean;
  snapshotRetirementTargets(bvid: string): UploadTarget[];
  persistCompletedRetirementUploadJobs(bvid: string, local: NonNullable<ReturnType<StateManager['getCompletedLocalDownload']>>, targets: UploadTarget[]): number;
  isUserSyncEligible(user: BiliUser | undefined | null): user is BiliUser;
  dispatchPersistentJobs(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  deadlineNow(): number;
}
export function createSourceDeletion(deps: Dependencies) {
  async function prepareSourceDeletion(userId: string, mediaId: number, bvid: string, timeoutMs = 30_000) {
    if (deps.isDeletionLocked()) {
      throw Object.assign(new Error("账号归档清理期间不能执行来源级准备"), { statusCode: 409 });
    }
    const matches = (value: unknown) => {
      const target = record(value);
      return deps.archiveDeletionTargetMatches(target.userId, target.mediaId, bvid)
        && String(target.userId || '') === userId && Number(target.mediaId || 0) === mediaId;
    };
    const filterTargets = <T extends { userId?: unknown; mediaId?: unknown }>(targets: T[]) =>
      targets.filter((target) => !matches(target));
    let removedQueuedTasks = 0;

    for (const task of deps.downloadQueue.getTasks()) {
      if (String(task.bvid || "") !== bvid) continue;
      const running = task.status === "running";
      const taskTargets = retirementTargets(task.targets);
      if (taskTargets.length > 0) {
        const remaining = filterTargets(taskTargets);
        task.targets = remaining;
        if (remaining.length > 0 && matches(task.target)) {
          task.target = remaining[0];
          task.userId = remaining[0].userId;
          task.mediaId = remaining[0].mediaId;
          task.remotePath = remaining[0].remotePath;
        }
        if (remaining.length === 0 && !running) {
          task.target = undefined;
          task.userId = undefined;
          task.mediaId = undefined;
        }
      } else if (matches(task) && !running) {
        task.userId = undefined;
        task.mediaId = undefined;
        task.remotePath = undefined;
      }
      const control = task instanceof QualityUpgradeDownloadTask ? task.control : undefined;
      if (control && Array.isArray(control.targets)) {
        const remaining = filterTargets(control.targets);
        if (typeof control.setTargets === "function") control.setTargets(remaining);
        else control.targets = remaining;
      }
    }
    removedQueuedTasks += deps.downloadQueue.removePendingTasks((task) => {
      if (String(task.bvid || "") !== bvid) return false;
      const targets = Array.isArray(task.targets) ? task.targets : [];
      return targets.length === 0 && !(task.userId && task.mediaId);
    }).length;
    removedQueuedTasks += deps.uploadQueue.removePendingTasks((task) => matches(task)).length;
    removedQueuedTasks += deps.verificationQueue.removePendingTasks((task) => matches(task)).length;

    const downloadJobs = deps.jobStore.list(["download", "quality_download"], 100_000);
    for (const job of downloadJobs) {
      if (String(job.bvid || "") !== bvid) continue;
      const payload = { ...job.payload };
      if (job.kind === "quality_download") {
        const targets = filterTargets(qualityTargetsFromPayload(payload));
        const nextPayload: Record<string, unknown> = { ...payload, targets, targetCount: targets.length };
        if (targets.length > 0) {
          nextPayload.target = targets[0];
          nextPayload.userId = targets[0].userId;
          nextPayload.mediaId = targets[0].mediaId;
          nextPayload.folderTitle = targets[0].folderTitle;
        } else {
          delete nextPayload.target;
          delete nextPayload.userId;
          delete nextPayload.mediaId;
          delete nextPayload.folderTitle;
        }
        if (targets.length === 0) {
          if (["running", "leased"].includes(String(job.status))) {
            deps.jobStore.updatePayload(job.id, nextPayload);
          }
          if (!["running", "leased"].includes(String(job.status))) deps.jobStore.complete(job.id);
          continue;
        }
        const downloadUser = deps.isUserSyncEligible(deps.userStore.getById(String(payload.downloadUserId || "")))
          && String(payload.downloadUserId) !== userId
          ? String(payload.downloadUserId)
          : targets[0].userId;
        deps.jobStore.updatePayload(job.id, {
          ...nextPayload,
          userId: targets[0].userId,
          mediaId: targets[0].mediaId,
          folderTitle: targets[0].folderTitle,
          target: targets[0],
          targets,
          targetCount: targets.length,
          downloadUserId: downloadUser,
        });
        continue;
      }

      const payloadTargets = retirementTargets(payload.detachedTargets);
      const candidates = new Map<string, UploadTarget>();
      for (const target of payloadTargets) {
        if (!matches(target)) candidates.set(`${target.userId}:${Number(target.mediaId)}`, target);
      }
      for (const target of deps.snapshotRetirementTargets(bvid)) {
        candidates.set(`${target.userId}:${target.mediaId}`, target);
      }
      const targets = [...candidates.values()];
      if (targets.length === 0) {
        if (["running", "leased"].includes(String(job.status))) {
          deps.jobStore.updatePayload(job.id, { ...payload, detachedTargets: [] });
        }
        if (!["running", "leased"].includes(String(job.status))) deps.jobStore.complete(job.id);
        continue;
      }
      deps.jobStore.updatePayload(job.id, {
        ...payload,
        primaryUserId: targets[0].userId,
        primaryMediaId: targets[0].mediaId,
        primaryFolderTitle: targets[0].folderTitle,
        downloadUserId: deps.isUserSyncEligible(deps.userStore.getById(String(payload.downloadUserId || "")))
          ? String(payload.downloadUserId)
          : targets[0].userId,
        detachedTargets: targets,
      });
    }

    const transferKinds: PersistentJobKind[] = [
      "upload", "verify_upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup",
    ];
    for (const job of deps.jobStore.list(transferKinds, 100_000)) {
      if (String(job.bvid || "") !== bvid
        || String(job.userId || "") !== userId
        || Number(job.mediaId || 0) !== mediaId) continue;
      if (!["running", "leased"].includes(String(job.status))) deps.jobStore.complete(job.id);
    }

    deps.downloadQueue.poke();
    deps.uploadQueue.poke();
    deps.verificationQueue.poke();
    deps.dispatchPersistentJobs();

    const deadline = deps.deadlineNow() + Math.max(1, timeoutMs);
    while (true) {
      const runningQueueTask = [deps.downloadQueue, deps.uploadQueue, deps.verificationQueue]
        .some((queue) => queue.getTasks().some((task) => task.status === "running"
          && String(task.bvid || "") === bvid
          && (matches(task) || (Array.isArray(task.targets)
            && task.targets.some((target: unknown) => matches(target))))));
      const runningJob = deps.jobStore.list(transferKinds, 100_000).some((job) =>
        String(job.bvid || "") === bvid
        && String(job.userId || "") === userId
        && Number(job.mediaId || 0) === mediaId
        && ["leased", "running"].includes(String(job.status)));
      if (!runningQueueTask && !runningJob) return { removedQueuedTasks };
      if (deps.deadlineNow() >= deadline) {
        throw Object.assign(new Error("该归档来源仍有正在执行的传输任务，请稍后重试"), { statusCode: 409 });
      }
      await deps.sleep(50);
    }
  }

  async function quiesceUserRemoteDeletion(user: BiliUser, timeoutMs = 30_000) {
    if (!deps.isDeletionLocked()) {
      throw Object.assign(new Error("账号归档清理尚未取得维护锁"), { statusCode: 409 });
    }
    for (const task of deps.downloadQueue.getTasks()) {
      if (task.status !== "running") continue;
      const download = task instanceof QualityUpgradeDownloadTask ? task.control : task instanceof DownloadTask ? task : undefined;
      const downloadUserId = String(download?.downloadUserId || task.userId || "");
      if (downloadUserId === user.id && task.persistentJobId) deps.markAborted(task.persistentJobId);
    }
    const canceledProcesses = await deps.cancelDownloads(String(user.uid || user.cookie.DedeUserID || ""));
    const deadline = deps.deadlineNow() + Math.max(1, timeoutMs);
    while (true) {
      const runningTransfer = [deps.downloadQueue, deps.uploadQueue, deps.verificationQueue]
        .some((queue) => queue.getTasks().some((task) => task.status === "running" && archiveTaskReferencesUser(task, user.id)));
      if (!deps.isSyncing(user.id) && !runningTransfer) break;
      if (deps.deadlineNow() >= deadline) {
        throw Object.assign(new Error("账号仍有正在执行的同步或传输任务，请稍后重新确认清理"), { statusCode: 409 });
      }
      await deps.sleep(50);
    }
    return { canceledProcesses };
  }

  function finalizeUserRemoteDeletion(userId: string, commit: () => void = () => undefined) {
    if (!deps.isDeletionLocked()) {
      throw Object.assign(new Error("账号归档清理尚未取得维护锁"), { statusCode: 409 });
    }
    const runningTransfer = [deps.downloadQueue, deps.uploadQueue, deps.verificationQueue]
      .some((queue) => queue.getTasks().some((task) => task.status === "running" && archiveTaskReferencesUser(task, userId)));
    if (deps.isSyncing(userId) || runningTransfer) {
      throw Object.assign(new Error("账号仍有正在执行的同步或传输任务"), { statusCode: 409 });
    }

    const postCommitRetirements: Array<{
      bvid: string;
      local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>;
      targets: UploadTarget[];
    }> = [];
    try {
      let removedQueuedTasks = 0;
      const result = deps.stateManager.runAtomic(() => {
        const relationBvids = new Set(deps.stateManager.listRelationsForUser(userId).map((relation) => relation.bvid));
        const downloadJobs = deps.jobStore.list(["download", "quality_download"], 100_000);
        let reassignedJobs = 0;
        let canceledJobs = 0;
        let directUploadTargets = 0;

        for (const job of downloadJobs) {
          const payload = { ...job.payload };
          const payloadTargets = [
            ...(Array.isArray(payload.targets) ? payload.targets : []),
            ...(payload.target ? [payload.target] : []),
          ];
          const affected = relationBvids.has(String(job.bvid || ""))
            || [job.userId, payload.primaryUserId, payload.downloadUserId, payload.pausedForUserId]
              .some((value) => String(value || "") === userId)
            || payloadTargets.some((target) => String(record(target).userId || "") === userId);
          if (!affected) continue;

          if (job.kind === "quality_download") {
            const targets = qualityTargetsFromPayload(payload).filter((target) => target.userId !== userId);
            if (targets.length === 0) {
              if (deps.jobStore.complete(job.id)) canceledJobs += 1;
              continue;
            }
            const alternateUser = targets
              .map((target) => deps.userStore.getById(target.userId))
              .find((candidate) => deps.isUserSyncEligible(candidate))
              || deps.userStore.list().find((candidate) => candidate.id !== userId && deps.isUserSyncEligible(candidate));
            if (!alternateUser) {
              if (deps.jobStore.complete(job.id)) canceledJobs += 1;
              continue;
            }
            const target = targets[0];
            const nextPayload: Record<string, unknown> = {
              ...payload,
              userId: target.userId,
              mediaId: target.mediaId,
              folderTitle: target.folderTitle,
              downloadUserId: alternateUser.id,
              target,
              targets,
              targetCount: targets.length,
            };
            delete nextPayload.pausedForUserId;
            if (deps.jobStore.reassignDownloadJob(job.id, alternateUser.id, nextPayload)) reassignedJobs += 1;
            continue;
          }

          const targetMap = new Map<string, UploadTarget>();
          for (const target of retirementTargets(payload.detachedTargets)) {
            if (String(target?.userId || "") === userId || !target?.userId || !Number.isInteger(Number(target.mediaId))) continue;
            targetMap.set(`${target.userId}:${Number(target.mediaId)}`, {
              userId: String(target.userId),
              mediaId: Number(target.mediaId),
              folderTitle: String(target.folderTitle || ""),
              remotePath: String(target.remotePath || ""),
            });
          }
          for (const target of deps.snapshotRetirementTargets(String(job.bvid || ""))) {
            if (target.userId !== userId) targetMap.set(`${target.userId}:${target.mediaId}`, target);
          }
          const targets = [...targetMap.values()].filter((target) => target.remotePath);
          const local = job.bvid ? deps.stateManager.getCompletedLocalDownload(job.bvid) : null;
          if (local) {
            deps.jobStore.complete(job.id);
            canceledJobs += 1;
            directUploadTargets += deps.persistCompletedRetirementUploadJobs(String(job.bvid), local, targets);
            if (targets.length > 0) postCommitRetirements.push({ bvid: String(job.bvid), local, targets });
            continue;
          }
          if (targets.length === 0) {
            if (deps.jobStore.complete(job.id)) canceledJobs += 1;
            continue;
          }
          const alternateUser = targets
            .map((target) => deps.userStore.getById(target.userId))
            .find((candidate) => deps.isUserSyncEligible(candidate))
            || deps.userStore.list().find((candidate) => candidate.id !== userId && deps.isUserSyncEligible(candidate));
          if (!alternateUser) {
            if (deps.jobStore.complete(job.id)) canceledJobs += 1;
            continue;
          }
          const primary = targets[0];
          const nextPayload: Record<string, unknown> = {
            ...payload,
            primaryUserId: primary.userId,
            primaryMediaId: primary.mediaId,
            primaryFolderTitle: primary.folderTitle,
            downloadUserId: alternateUser.id,
            detachedTargets: targets,
          };
          delete nextPayload.pausedForUserId;
          if (deps.jobStore.reassignDownloadJob(job.id, alternateUser.id, nextPayload)) reassignedJobs += 1;
        }

        const targetKinds: PersistentJobKind[] = [
          "upload", "verify_upload", "history_upload", "quality_upload", "quality_replace", "quality_cleanup",
        ];
        for (const job of deps.jobStore.list(targetKinds, 100_000)) {
          if (String(job.userId || "") === userId && deps.jobStore.complete(job.id)) canceledJobs += 1;
        }
        for (const job of deps.jobStore.list(["access_probe"], 100_000)) {
          if (String(job.payload?.preferredUserId || "") !== userId) continue;
          deps.jobStore.updatePayload(job.id, { ...job.payload, preferredUserId: "" });
          deps.jobStore.wakeByBvid(String(job.bvid || ""), ["access_probe"], deps.now());
        }
        const detachedRelations = deps.stateManager.detachUserRelations(userId);
        commit();
        return { canceledJobs, reassignedJobs, directUploadTargets, detachedRelations };
      });
      // The maintenance lock prevents these pending in-memory tasks from
      // starting while the SQLite transaction is being committed. Removing
      // them afterwards keeps a failed transaction fully reversible.
      removedQueuedTasks = [deps.downloadQueue, deps.uploadQueue, deps.verificationQueue]
        .reduce((count, queue) => count + queue.removePendingTasks((task) => archiveTaskReferencesUser(task, userId)).length, 0);
      for (const retirement of postCommitRetirements) {
        try {
          deps.stateManager.markDownloaded(retirement.bvid, retirement.local.localDir, retirement.targets);
        } catch (error) {
          console.warn(`[Scheduler] Failed to refresh local retirement state for ${retirement.bvid}: ${sanitizeUploadText(readTaskFailure(error).message || error)}`);
        }
      }
      deps.dispatchPersistentJobs();
      return { ...result, removedQueuedTasks };
    } catch (error) {
      deps.stateManager.reload();
      throw error;
    }
  }

  return { prepareSourceDeletion, quiesceUserRemoteDeletion, finalizeUserRemoteDeletion };
}
