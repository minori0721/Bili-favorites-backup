import type { PersistentJobStore } from '../job-store.js';
import { logManager } from '../logger.js';

interface StartupResumeDependencies {
  shuttingDown(): boolean;
  initializeRuntime(): void;
  jobs: Pick<PersistentJobStore, 'recoverExpiredLeases' | 'normalizeTerminalUploadRecovery'>;
  reconcileTransferSessions(force: boolean): void;
  reconcileObsoleteVerifiedArchives(): Promise<unknown>;
  migrateLegacyQualityDownloads(): void;
  bootstrapLegacyFailureClassification(): void;
  resumePersistedWork(): void;
  startLegacyCacheRecovery(): void;
  dispatchPersistentJobs(): void;
  now(): number;
  recoverStaleActiveBackups(): void;
  ensurePersistedChargingAccessProbes(): void;
  ensurePersistedAvailabilityProbes(): void;
}

/** Owns the fixed startup recovery order and exposes only the required recovery operations. */
export function createStartupResumeWorkflow(deps: StartupResumeDependencies) {
  async function resumePersistedWorkOnStartup() {
    if (deps.shuttingDown()) return;
    deps.initializeRuntime();
    deps.jobs.recoverExpiredLeases();
    deps.reconcileTransferSessions(true);
    const normalizedUploadRecoveries = deps.jobs.normalizeTerminalUploadRecovery();
    if (normalizedUploadRecoveries > 0) {
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
        type: 'system',
        level: 'info',
        summary: `已将 ${normalizedUploadRecoveries} 个耗尽的上传任务恢复到待处理中心`,
        raw: `[Recovery] normalized terminal upload jobs=${normalizedUploadRecoveries}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    await deps.reconcileObsoleteVerifiedArchives();
    if (deps.shuttingDown()) return;
    deps.migrateLegacyQualityDownloads();
    deps.bootstrapLegacyFailureClassification();
    deps.resumePersistedWork();
    deps.startLegacyCacheRecovery();
    deps.dispatchPersistentJobs();
  }

  return {
    resumePersistedWorkOnStartup,
    recoverStaleActiveBackups: deps.recoverStaleActiveBackups,
    startLegacyCacheRecovery: deps.startLegacyCacheRecovery,
    ensurePersistedChargingAccessProbes: deps.ensurePersistedChargingAccessProbes,
    ensurePersistedAvailabilityProbes: deps.ensurePersistedAvailabilityProbes,
  };
}
