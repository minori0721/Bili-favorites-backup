import type { MaintenanceLease, MaintenanceScope } from './maintenance-admission.js';

export interface PathMaintenanceSummary {
  id: string;
  status: string;
  sourceRoot: string;
  destinationRoot: string;
}

export interface ArchiveDeletionSummary {
  id: string;
  status: string;
  scope: string;
  userId?: string;
  mediaId?: number;
  bvid?: string;
}

interface Admission {
  enter(scope: MaintenanceScope, id?: string): MaintenanceLease;
  leave(lease: MaintenanceLease | null | undefined): boolean;
  isLocked(scope: MaintenanceScope): boolean;
}

/** Owns maintenance leases and their projections as one state boundary. */
export function createMaintenanceState(admission: Admission) {
  let path: PathMaintenanceSummary | null = null;
  let pathLease: MaintenanceLease | null = null;
  let archive: ArchiveDeletionSummary | null = null;
  let archiveLease: MaintenanceLease | null = null;

  function setPath(locked: boolean, summary?: PathMaintenanceSummary | { id: string }) {
    if (locked) {
      if (!pathLease || (summary?.id && pathLease.id !== summary.id)) {
        pathLease = admission.enter('path_migration', summary?.id);
      }
      if (summary && 'sourceRoot' in summary) path = { ...summary };
    } else if (!summary?.id || pathLease?.id === summary.id) {
      admission.leave(pathLease);
      pathLease = null;
      if (!admission.isLocked('path_migration')) path = null;
    }
  }

  function setArchive(locked: boolean, summary?: ArchiveDeletionSummary) {
    if (locked) {
      if (!summary) {
        if (!archiveLease) archiveLease = admission.enter('archive_deletion');
        return false;
      }
      const previousId = archive?.id;
      const wasLocked = admission.isLocked('archive_deletion');
      // A new operation can replace a completed one before its final notification.
      // Its scope decides whether the previous account-wide lease still applies.
      if (archiveLease && (archiveLease.id !== summary.id || summary.scope !== 'account')) {
        if (!admission.leave(archiveLease)) return false;
        archiveLease = null;
      }
      if (summary.scope === 'account' && !archiveLease) {
        archiveLease = admission.enter('archive_deletion', summary.id);
      }
      archive = { ...summary };
      const isLocked = admission.isLocked('archive_deletion');
      return !isLocked && (wasLocked || (previousId !== undefined && previousId !== summary.id));
    }

    // Source deletions have no global lease: match their summary identity instead.
    if (summary?.id && archive?.id !== summary.id && archiveLease?.id !== summary.id) return false;
    const hadState = Boolean(archive || archiveLease);
    if (archiveLease && (!summary?.id || archiveLease.id === summary.id)) {
      if (!admission.leave(archiveLease)) return false;
      archiveLease = null;
    }
    if (!admission.isLocked('archive_deletion') && (!summary?.id || archive?.id === summary.id)) {
      archive = null;
    }
    return hadState && !archive && !archiveLease;
  }

  return {
    setPath,
    setArchive,
    getPath: () => path,
    getArchive: () => archive,
    pathLocked: () => admission.isLocked('path_migration'),
    archiveLocked: () => admission.isLocked('archive_deletion'),
  };
}
