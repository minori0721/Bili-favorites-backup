import { SchedulerRuntime } from './scheduler/scheduler-runtime.js';

export type { SchedulerDependencies } from './scheduler/scheduler-runtime.js';
export type { AccessProbeIntent } from './scheduler/access-rules.js';
export type { RecoveryIssue } from './scheduler/recovery-contracts.js';
export {
  computeAutomaticQualityRecoveryDelayMs,
  computeAvailabilityUnavailableDelayMs,
  computeAvailabilityUnknownDelayMs,
  computeChargingRecheckDelayMs,
  computeChargingTransientDelayMs,
  computeDownloadStartDelayMs,
  computeLocalCleanupRetryDelayMs,
  computeQualityCleanupRetryDelayMs,
  computeUploadSessionRetryDelayMs,
  computeUploadVerificationTiming,
} from './scheduler/retry-policy.js';
export { recoveryIssueDisposition } from './recovery-policy.js';
export type { RecoveryIssueAction, RecoveryIssueActionId, RecoveryIssueKind } from './recovery-policy.js';
export type { SchedulerControl } from './ports/scheduler-control.js';

/**
 * Stable application-facing scheduler contract.
 *
 * The runtime owns queues, timers, database adapters and workflow wiring. The
 * compatibility object intentionally contains no business state of its own;
 * callers retain the historic API while all lifecycle and policy state stays
 * behind a single runtime boundary.
 */
export class SyncScheduler {
  private readonly runtime: SchedulerRuntime;

  constructor(...args: ConstructorParameters<typeof SchedulerRuntime>) {
    this.runtime = new SchedulerRuntime(...args);
  }

  buildQualityUpgradeTask(...args: Parameters<SchedulerRuntime['buildQualityUpgradeTask']>) { return this.runtime.buildQualityUpgradeTask(...args); }
  isQualityArtifactCleanupLocked(...args: Parameters<SchedulerRuntime['isQualityArtifactCleanupLocked']>) { return this.runtime.isQualityArtifactCleanupLocked(...args); }
  requestAvailabilityRecheck(...args: Parameters<SchedulerRuntime['requestAvailabilityRecheck']>) { return this.runtime.requestAvailabilityRecheck(...args); }
  previewLocalArchiveRelease(...args: Parameters<SchedulerRuntime['previewLocalArchiveRelease']>) { return this.runtime.previewLocalArchiveRelease(...args); }
  requestLocalArchiveRelease(...args: Parameters<SchedulerRuntime['requestLocalArchiveRelease']>) { return this.runtime.requestLocalArchiveRelease(...args); }
  getRecoveryIssues(...args: Parameters<SchedulerRuntime['getRecoveryIssues']>) { return this.runtime.getRecoveryIssues(...args); }
  getRecoveryIssueSnapshot(...args: Parameters<SchedulerRuntime['getRecoveryIssueSnapshot']>) { return this.runtime.getRecoveryIssueSnapshot(...args); }
  resolveRecoveryIssue(...args: Parameters<SchedulerRuntime['resolveRecoveryIssue']>) { return this.runtime.resolveRecoveryIssue(...args); }
  recoverUploadJob(...args: Parameters<SchedulerRuntime['recoverUploadJob']>) { return this.runtime.recoverUploadJob(...args); }
  runRecoveryAutomationNow(...args: Parameters<SchedulerRuntime['runRecoveryAutomationNow']>) { return this.runtime.runRecoveryAutomationNow(...args); }
  refreshRecoveryProjection(...args: Parameters<SchedulerRuntime['refreshRecoveryProjection']>) { return this.runtime.refreshRecoveryProjection(...args); }
  resumePersistedWorkOnStartup(...args: Parameters<SchedulerRuntime['resumePersistedWorkOnStartup']>) { return this.runtime.resumePersistedWorkOnStartup(...args); }
  retireUser(...args: Parameters<SchedulerRuntime['retireUser']>) { return this.runtime.retireUser(...args); }
  prepareSourceDeletion(...args: Parameters<SchedulerRuntime['prepareSourceDeletion']>) { return this.runtime.prepareSourceDeletion(...args); }
  quiesceUserRemoteDeletion(...args: Parameters<SchedulerRuntime['quiesceUserRemoteDeletion']>) { return this.runtime.quiesceUserRemoteDeletion(...args); }
  finalizeUserRemoteDeletion(...args: Parameters<SchedulerRuntime['finalizeUserRemoteDeletion']>) { return this.runtime.finalizeUserRemoteDeletion(...args); }
  restoreUserAfterLogin(...args: Parameters<SchedulerRuntime['restoreUserAfterLogin']>) { return this.runtime.restoreUserAfterLogin(...args); }
  start(...args: Parameters<SchedulerRuntime['start']>) { return this.runtime.start(...args); }
  setPathMigrationMaintenance(...args: Parameters<SchedulerRuntime['setPathMigrationMaintenance']>) { return this.runtime.setPathMigrationMaintenance(...args); }
  isPathMigrationLocked(...args: Parameters<SchedulerRuntime['isPathMigrationLocked']>) { return this.runtime.isPathMigrationLocked(...args); }
  setArchiveDeletionMaintenance(...args: Parameters<SchedulerRuntime['setArchiveDeletionMaintenance']>) { return this.runtime.setArchiveDeletionMaintenance(...args); }
  isArchiveDeletionLocked(...args: Parameters<SchedulerRuntime['isArchiveDeletionLocked']>) { return this.runtime.isArchiveDeletionLocked(...args); }
  applyConfigUpdate(...args: Parameters<SchedulerRuntime['applyConfigUpdate']>) { return this.runtime.applyConfigUpdate(...args); }
  updateInterval(...args: Parameters<SchedulerRuntime['updateInterval']>) { return this.runtime.updateInterval(...args); }
  stop(...args: Parameters<SchedulerRuntime['stop']>) { return this.runtime.stop(...args); }
  beginShutdown(...args: Parameters<SchedulerRuntime['beginShutdown']>) { return this.runtime.beginShutdown(...args); }
  isIdle(...args: Parameters<SchedulerRuntime['isIdle']>) { return this.runtime.isIdle(...args); }
  waitForIdle(...args: Parameters<SchedulerRuntime['waitForIdle']>) { return this.runtime.waitForIdle(...args); }
  wake(...args: Parameters<SchedulerRuntime['wake']>) { return this.runtime.wake(...args); }
  shutdown(...args: Parameters<SchedulerRuntime['shutdown']>) { return this.runtime.shutdown(...args); }
  reloadStateDatabase(...args: Parameters<SchedulerRuntime['reloadStateDatabase']>) { return this.runtime.reloadStateDatabase(...args); }
  resumeAfterStateRebind(...args: Parameters<SchedulerRuntime['resumeAfterStateRebind']>) { return this.runtime.resumeAfterStateRebind(...args); }
  runNow(...args: Parameters<SchedulerRuntime['runNow']>) { return this.runtime.runNow(...args); }
  runReconcileNow(...args: Parameters<SchedulerRuntime['runReconcileNow']>) { return this.runtime.runReconcileNow(...args); }
  runRemoteReconcileNow(...args: Parameters<SchedulerRuntime['runRemoteReconcileNow']>) { return this.runtime.runRemoteReconcileNow(...args); }
  hasRunningTransferTasks(...args: Parameters<SchedulerRuntime['hasRunningTransferTasks']>) { return this.runtime.hasRunningTransferTasks(...args); }
  hasPersistentTransferWork(...args: Parameters<SchedulerRuntime['hasPersistentTransferWork']>) { return this.runtime.hasPersistentTransferWork(...args); }
  hasActiveOrQueuedSchedulerWork(...args: Parameters<SchedulerRuntime['hasActiveOrQueuedSchedulerWork']>) { return this.runtime.hasActiveOrQueuedSchedulerWork(...args); }
  refreshLocalCacheState(...args: Parameters<SchedulerRuntime['refreshLocalCacheState']>) { return this.runtime.refreshLocalCacheState(...args); }
  withCleanupLock<T>(fn: () => Promise<T>) { return this.runtime.withCleanupLock(fn); }
  enqueueQualityUpgrade(...args: Parameters<SchedulerRuntime['enqueueQualityUpgrade']>) { return this.runtime.enqueueQualityUpgrade(...args); }
  wakeChargingAccessProbes(...args: Parameters<SchedulerRuntime['wakeChargingAccessProbes']>) { return this.runtime.wakeChargingAccessProbes(...args); }
  captureLegacyRecoveryMarkers(...args: Parameters<SchedulerRuntime['captureLegacyRecoveryMarkers']>) { return this.runtime.captureLegacyRecoveryMarkers(...args); }
  getLocalCacheCapacity(...args: Parameters<SchedulerRuntime['getLocalCacheCapacity']>) { return this.runtime.getLocalCacheCapacity(...args); }
  recheckLegacyRecoveryAfterImport(...args: Parameters<SchedulerRuntime['recheckLegacyRecoveryAfterImport']>) { return this.runtime.recheckLegacyRecoveryAfterImport(...args); }
  hasQualityUpgrade(...args: Parameters<SchedulerRuntime['hasQualityUpgrade']>) { return this.runtime.hasQualityUpgrade(...args); }
  getQualityUpgradeTargetKeys(...args: Parameters<SchedulerRuntime['getQualityUpgradeTargetKeys']>) { return this.runtime.getQualityUpgradeTargetKeys(...args); }
  getQualityUpgradeState(...args: Parameters<SchedulerRuntime['getQualityUpgradeState']>) { return this.runtime.getQualityUpgradeState(...args); }
  getQueueSnapshot(...args: Parameters<SchedulerRuntime['getQueueSnapshot']>) { return this.runtime.getQueueSnapshot(...args); }
  tick(...args: Parameters<SchedulerRuntime['tick']>) { return this.runtime.tick(...args); }
  enqueueManualArchive(...args: Parameters<SchedulerRuntime['enqueueManualArchive']>) { return this.runtime.enqueueManualArchive(...args); }
}
