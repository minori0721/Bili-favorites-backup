import type { Task } from '../queue.js';
import type { StateManager } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import {
  DownloadTask, UploadTask, QualityUpgradeDownloadTask, QualityUpgradeUploadReplaceTask,
  QualityUpgradeReplaceTask,
} from '../tasks.js';

/** Policy may change after prefetch. Recheck immediately before external work. */
export function createArchiveTaskAdmission(deps: {
  blocked(userId: string, mediaId: number, bvid: string): boolean;
  state: Pick<StateManager, 'runAtomic' | 'getRelationStatus' | 'markRelationRetryPending'>;
  jobs: Pick<JobRepository, 'complete'>;
  leaseOwner: string;
}) {
  return (task: Task): boolean => {
    if (!task.bvid) return true;
    const bvid = task.bvid;
    const removed: Array<{userId: string; mediaId: number}> = [];
    const allowed = (target: {userId: string; mediaId: number}) => {
      if (!deps.blocked(target.userId, target.mediaId, bvid)) return true;
      removed.push(target);
      return false;
    };
    let canRun = true;
    if (task instanceof QualityUpgradeDownloadTask || task instanceof QualityUpgradeUploadReplaceTask
      || task instanceof QualityUpgradeReplaceTask) {
      const targets = task.control.targets.filter(allowed);
      canRun = targets.length > 0;
      if (removed.length) task.control.setTargets(targets);
    } else if (task instanceof DownloadTask && task.targets?.length) {
      const targets = task.targets.filter(allowed);
      canRun = targets.length > 0;
      if (removed.length) task.targets = targets;
    } else if ((task instanceof DownloadTask || task instanceof UploadTask)
      && task.userId && task.mediaId !== undefined) {
      canRun = allowed({userId: task.userId, mediaId: task.mediaId});
    }
    if (!removed.length) return canRun;
    deps.state.runAtomic(() => {
      if (!canRun && task.persistentJobId && !deps.jobs.complete(task.persistentJobId, deps.leaseOwner)) {
        throw new Error('Queued archive task ownership changed while cancelling excluded sources');
      }
      for (const target of removed) {
        const relation = deps.state.getRelationStatus(target.userId, target.mediaId, bvid);
        if (relation?.backupStatus === 'queued' || relation?.backupStatus === 'downloaded') {
          deps.state.markRelationRetryPending(bvid, target.userId, target.mediaId);
        }
      }
    });
    return canRun;
  };
}
