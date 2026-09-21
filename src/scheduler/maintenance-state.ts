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
    const admitted = locked && (!summary || summary.scope === 'account');
    if (admitted) {
      if (!archiveLease || (summary?.id && archiveLease.id !== summary.id)) {
        archiveLease = admission.enter('archive_deletion', summary?.id);
      }
    }
    if (locked && summary?.scope) {
      archive = { ...summary };
    } else if (!locked && (!summary?.id || archiveLease?.id === summary.id)) {
      admission.leave(archiveLease);
      archiveLease = null;
      if (!admission.isLocked('archive_deletion')) archive = null;
    }
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
