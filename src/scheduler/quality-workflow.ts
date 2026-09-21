import type { BBDownApiMode, ConfigStore } from '../config.js';
import type { PersistentJobStore } from '../job-store.js';
import { QualityUpgradeDownloadTask, type QualityUpgradeTarget, type QualityUpgradeTask } from '../tasks.js';
import type { TaskQueue } from '../queue.js';
import { qualityDownloadStageLabel, qualityTargetsFromPayload, serializeQualityUpgrade } from './quality-rules.js';

export interface QualityWorkflowDependencies {
  jobs: Pick<PersistentJobStore, 'hasQualityTarget' | 'mergeQualityDownload'>;
  configStore: Pick<ConfigStore, 'get'>;
  downloadQueue: Pick<TaskQueue, 'getTasks'>;
  onApiReady(task: QualityUpgradeTask, mode: BBDownApiMode): void;
  dispatch(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Owns quality task merging, artifact locks and quality phase state. */
export function createQualityWorkflow() {
  const cleanupLocks = new Set<string>();
  let stopped = false;
  let dependencies: QualityWorkflowDependencies | null = null;
  function configure(next: QualityWorkflowDependencies) { dependencies = next; }
  function enqueue(task: QualityUpgradeTask) {
    if (!dependencies) throw new Error('Quality workflow has not been configured');
    if (stopped) return false;
    task.status = 'pending';
    task.error = undefined;
    task.qualityStage = 'download';
    task.qualityStageLabel = qualityDownloadStageLabel(task, '等待下载新版');
    task.onApiReady = (control, mode) => dependencies?.onApiReady(control, mode);
    const pendingTargets = task.targets.filter(target => !dependencies?.jobs.hasQualityTarget(target.userId, target.mediaId, task.bvid));
    if (pendingTargets.length === 0) return false;
    task.setTargets(pendingTargets);
    task.qualityStageLabel = qualityDownloadStageLabel(task, '等待下载新版');
    const target = task.target;
    const merged = dependencies.jobs.mergeQualityDownload({
      kind: 'quality_download',
      dedupeKey: `quality-download:${task.bvid}:${task.artifactKey}`,
      bvid: task.bvid,
      userId: task.downloadUserId || task.userId || target.userId,
      mediaId: target.mediaId,
      priority: 35,
      maxAttempts: dependencies.configStore.get().maxRetries + 1,
      payload: serializeQualityUpgrade(task),
    });
    if (!merged.created && merged.targetAdded) {
      const mergedTargets = qualityTargetsFromPayload(merged.job.payload);
      for (const phase of dependencies.downloadQueue.getTasks()) {
        if (!(phase instanceof QualityUpgradeDownloadTask) || phase.control.artifactKey !== task.artifactKey) continue;
        phase.control.setTargets(mergedTargets);
        phase.control.qualityStageLabel = qualityDownloadStageLabel(
          phase.control,
          phase.control.status === 'running' ? '下载新版' : '等待下载新版',
        );
        phase.folderTitle = mergedTargets.length > 1 ? `${mergedTargets.length}个目标` : mergedTargets[0]?.folderTitle;
      }
    }
    dependencies.dispatch();
    return merged.created || merged.targetAdded;
  }
  return {
    configure,
    enqueue,
    targetsFromPayload: (payload: unknown, fallback: QualityUpgradeTarget[] = []) => qualityTargetsFromPayload(payload, fallback),
    stageLabel: (task: QualityUpgradeTask, label: string) => qualityDownloadStageLabel(task, label),
    serialize: (task: QualityUpgradeTask, target: QualityUpgradeTarget = task.target, targets: QualityUpgradeTarget[] = task.targets) => serializeQualityUpgrade(task, target, targets),
    start: () => { stopped = false; },
    stop: () => { stopped = true; },
    acquireCleanupLock: (artifactKey: string) => { cleanupLocks.add(artifactKey); },
    releaseCleanupLock: (artifactKey: string) => { cleanupLocks.delete(artifactKey); },
    // A shutdown stops new work, but an existing cleanup lock remains observable
    // until its owner releases it.  Hiding it while stopped would admit a new
    // artifact download during the drain window.
    isCleanupLocked: (artifactKey: string) => cleanupLocks.has(artifactKey),
    isIdle: () => cleanupLocks.size === 0,
    async waitForIdle(timeoutMs = 20_000) {
      if (!dependencies) return cleanupLocks.size === 0;
      const deadline = dependencies.now() + timeoutMs;
      while (cleanupLocks.size > 0 && dependencies.now() < deadline) {
        await dependencies.sleep(Math.min(50, Math.max(1, deadline - dependencies.now())));
      }
      return cleanupLocks.size === 0;
    },
    resetAfterRebind: () => {
      if (cleanupLocks.size > 0) throw new Error('Cannot reset quality workflow while cleanup is active');
      stopped = false;
    },
  };
}
