import { DownloadTask, QualityUpgradeDownloadTask } from '../tasks.js';
import type { BBDownApiMode } from '../config.js';

type DownloadLike = DownloadTask | QualityUpgradeDownloadTask;

interface DownloadAdmissionPort {
  getSnapshot(): { state: string };
  beforeStart(): boolean;
  taskIdentity(task: DownloadLike): { bvid: string; userId: string; hasAppToken: boolean };
  claimStart(identity: { bvid: string; userId: string; hasAppToken: boolean }): {
    allowed: boolean;
    apiModeOverride?: BBDownApiMode;
    probe?: boolean;
  };
}

interface CapacityPort {
  ensureFresh(): void;
  view(): { paused: boolean };
}

export interface DownloadAdmissionPolicyDependencies {
  isAccepting(): boolean;
  isMaintenanceLocked(scope?: 'cleanup' | 'path_migration' | 'archive_deletion'): boolean;
  legacyCacheBusy(): boolean;
  isArchiveDeletionTargetBlocked(task: DownloadLike): boolean;
  isQualityCleanupLocked(artifactKey: string): boolean;
  capacity: CapacityPort;
  transferPaused(): boolean;
  uploadQueueSize(): number;
  dueUploadCount(): number;
  uploadQueueCanAccept(): boolean;
  downloadQueueCanAccept(): boolean;
  admission: DownloadAdmissionPort;
}

/**
 * Decides whether a download may start or be created.  Health and cooldown
 * state remain owned by createDownloadAdmission; this policy only combines
 * runtime admission, maintenance and queue constraints.
 */
export function createDownloadAdmissionPolicy(deps: DownloadAdmissionPolicyDependencies) {
  function baseAllowed() {
    deps.capacity.ensureFresh();
    const snapshot = deps.capacity.view();
    return !snapshot.paused
      && !deps.transferPaused()
      && deps.uploadQueueSize() === 0
      && deps.dueUploadCount() === 0
      && deps.uploadQueueCanAccept();
  }

  function canStart(task?: DownloadLike) {
    if (!deps.isAccepting() || deps.isMaintenanceLocked() || deps.legacyCacheBusy()) return false;
    if (task && deps.isArchiveDeletionTargetBlocked(task)) return false;
    if (task instanceof QualityUpgradeDownloadTask && deps.isQualityCleanupLocked(task.control.artifactKey)) return false;
    if (!baseAllowed()) return false;
    if (!task) return deps.admission.getSnapshot().state === 'healthy';
    if (!deps.admission.beforeStart()) return false;
    const decision = deps.admission.claimStart(deps.admission.taskIdentity(task));
    if (!decision.allowed) return false;
    const download = task instanceof QualityUpgradeDownloadTask ? task.control : task;
    download.apiModeOverride = decision.apiModeOverride;
    download.apiProbe = Boolean(decision.probe);
    return true;
  }

  function canCreate() {
    if (!deps.isAccepting() || deps.isMaintenanceLocked('cleanup')) return false;
    if (!baseAllowed()) return false;
    return !deps.isMaintenanceLocked('path_migration')
      && !deps.isMaintenanceLocked('archive_deletion')
      && deps.downloadQueueCanAccept();
  }

  return { canStart, canCreate };
}
