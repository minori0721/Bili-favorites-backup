import { createMaintenanceAdmission, type MaintenanceScope } from './maintenance-admission.js';
import {
  createMaintenanceState,
  type ArchiveDeletionSummary,
  type PathMaintenanceSummary,
} from './maintenance-state.js';
import { matchesDeletedSource, sourceAdmissionBlocked } from './source-admission.js';
import {
  QualityUpgradeCleanupTask,
  QualityUpgradeDownloadTask,
  QualityUpgradeReplaceTask,
  QualityUpgradeUploadReplaceTask,
} from '../tasks.js';
import type { Task } from '../queue.js';

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;

function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask
    || task instanceof QualityUpgradeReplaceTask
    || task instanceof QualityUpgradeCleanupTask;
}

interface MaintenanceCoordinatorDependencies {
  canEnterCleanup(): boolean;
  wakeBlockedWork(): void;
}

/** Owns maintenance identities, summaries and cleanup admission as one boundary. */
export function createMaintenanceCoordinator(deps: MaintenanceCoordinatorDependencies) {
  const admission = createMaintenanceAdmission();
  const state = createMaintenanceState(admission);

  function isLocked(scope: MaintenanceScope) {
    return admission.isLocked(scope);
  }

  function isAnyLocked() {
    return isLocked('cleanup') || isLocked('path_migration') || isLocked('archive_deletion');
  }

  function setPath(
    locked: boolean,
    summary?: PathMaintenanceSummary | { id: string },
  ) {
    state.setPath(locked, summary);
    if (!locked) deps.wakeBlockedWork();
  }

  function setArchive(
    locked: boolean,
    summary?: {
      id: string;
      status?: string;
      scope?: string;
      userId?: string;
      mediaId?: number;
      bvid?: string;
    },
  ) {
    const normalized: ArchiveDeletionSummary | undefined = summary && {
      id: summary.id,
      status: summary.status || 'running',
      scope: summary.scope || 'account',
      userId: summary.userId,
      mediaId: summary.mediaId,
      bvid: summary.bvid,
    };
    const shouldWake = state.setArchive(locked, normalized);
    if (shouldWake) deps.wakeBlockedWork();
  }

  function archiveTargetMatches(userId: unknown, mediaId: unknown, bvid: unknown) {
    return matchesDeletedSource(state.getArchive(), { userId, mediaId }, bvid);
  }

  function archiveTaskBlocked(task: Task) {
    const control = task instanceof QualityUpgradeDownloadTask || isQualityUploadPhaseTask(task)
      ? task.control
      : undefined;
    return sourceAdmissionBlocked(state.archiveLocked(), state.getArchive(), task, control);
  }

  function snapshot() {
    const archive = state.getArchive();
    if (archive) return { kind: 'archive_delete' as const, ...archive };
    const path = state.getPath();
    if (path) return { kind: 'path_migration' as const, ...path };
    return undefined;
  }

  function withCleanupLease<T>(work: () => Promise<T>): Promise<T> {
    if (!deps.canEnterCleanup()) {
      throw new Error('当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再清理重要数据。');
    }
    const lease = admission.enter('cleanup');
    // Deferring invocation converts a synchronous throw into a rejected promise,
    // so the lease is released on every exit path.
    return Promise.resolve().then(work).finally(() => {
      admission.leave(lease);
    });
  }

  return {
    isLocked,
    isAnyLocked,
    setPath,
    setArchive,
    pathLocked: state.pathLocked,
    archiveLocked: state.archiveLocked,
    archiveTargetMatches,
    archiveTaskBlocked,
    snapshot,
    withCleanupLease,
  };
}
