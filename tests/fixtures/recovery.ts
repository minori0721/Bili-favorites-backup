import { buildQualityUpgradeTask } from '../../src/scheduler/quality-task-factory.js';
import type { PersistentJobRecord } from '../../src/database.js';
import path from 'node:path';
import { createRecoveryWorkflow } from '../../src/scheduler/recovery-workflow.js';
import { createBackupEnqueue } from '../../src/scheduler/backup-enqueue.js';
import { createArchiveTargets } from '../../src/scheduler/archive-targets.js';
import { createDownloadTaskFactory } from '../../src/scheduler/download-task-factory.js';
import { createTransferWorkflow } from '../../src/scheduler/transfer-workflow.js';
import { TransferSessionStore } from '../../src/transfer-session.js';
import { PersistentJobStore } from '../../src/job-store.js';
import { UploadCircuitBreaker } from '../../src/upload-health.js';
import type { StateManager } from '../../src/state.js';
import type { BiliUser } from '../../src/users.js';
import type { AppConfig } from '../../src/config.js';
import type { getVideoPageSnapshot } from '../../src/bili.js';
import { testConfig } from '../helpers.js';

/** Real workflow and SQLite with no queue workers or external side effects. */
export function recoveryFixture(state: StateManager, users: BiliUser[], videoAccessProbe: typeof getVideoPageSnapshot = async () => {
  throw new Error('Unexpected video probe');
}, options: {config?: AppConfig; tempDir?: string} = {}) {
  const jobs = new PersistentJobStore(state.getDatabase());
  const sessions = new TransferSessionStore(state.getDatabase());
  const config = {get: () => options.config ?? testConfig()};
  const eligible = (user: BiliUser | null | undefined): user is BiliUser => user?.enabled === true;
  const enqueue = createBackupEnqueue({
    config, state, jobs, eligible, blocked: () => false,
    remotePath: () => '/backup', proof: () => undefined,
    uploadJob: () => { throw new Error('Unexpected upload'); },
    probe: () => { throw new Error('Unexpected probe enqueue'); },
    historySegment: value => value, cycleStartedAt: () => undefined,
    generation: () => 1, now: Date.now, dispatch: () => {},
  });
  const service = createRecoveryWorkflow({
    stateManager: state, jobStore: jobs, transferSessions: sessions,
    database: () => state.getDatabase(), atomic: work => state.getDatabase().db.transaction(work)(),
    configStore: config, userStore: {list: () => users, getById: id => users.find(user => user.id === id) ?? null},
    uploadCircuit: new UploadCircuitBreaker(),
    remoteFileInspector: async () => { throw new Error('Unexpected remote file request'); },
    videoAccessProbe, legacyTempDir: options.tempDir ?? '', canRun: () => true, generation: () => 1, now: Date.now,
    cleanup: () => { throw new Error('Unexpected cleanup'); },
    resolveRelation: relation => {
      const user = users.find(user => user.id === relation.userId);
      return user ? {user, mediaId: relation.mediaId, folderTitle: relation.folderTitle} : null;
    },
    isUserSyncEligible: eligible, prepareDownload: enqueue.prepareRecoveryDownload,
    buildLocalCleanupPlan: () => null, isSafeEncodingRetryDirectory: directory => {
      if (!options.tempDir) return false;
      const relative = path.relative(path.resolve(options.tempDir), path.resolve(directory));
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    },
    dispatchPersistentJobs: () => {},
  });
  const targets = createArchiveTargets({
    config, state, users: {getById: id => users.find(user => user.id === id) ?? null}, eligible,
    sourceBlocked: (userId, mediaId, bvid) => state.getDatabase().isArchiveSourceDeletionBlocked(userId, mediaId, bvid),
  });
  const downloads = createDownloadTaskFactory({
    configStore: config, stateManager: state, userStore: {getById: id => users.find(user => user.id === id) ?? null},
    generation: () => 1, isArchiveSourceDeletionBlocked: (u, m, b) => state.getDatabase().isArchiveSourceDeletionBlocked(u, m, b),
    resolveRelation: targets.resolveRelation, resolveRelationRemotePath: targets.resolveRelationRemotePath,
    handleDownloadApiReady: () => {},
  });
  const transfers = createTransferWorkflow({
    stateManager: state, configStore: config, jobStore: jobs, transferSessions: sessions, leaseOwner: 'test-owner',
    generation: () => 1, captureExistingArchiveProof: service.captureExistingArchiveProof,
    transferRuntime: {
      recordFailure: (_key, failure) => failure,
      clearProbeTimer: () => {},
      scheduleProbe: () => {},
    },
    downloadQueue: { poke: () => {} },
    blocked: (u, m, b) => state.getDatabase().isArchiveSourceDeletionBlocked(u, m, b), wake: () => {},
  });
  const qualityLocks = new Set<string>();
  const quality = (job: PersistentJobRecord) => buildQualityUpgradeTask(job, {
    config, users: {getById: id => users.find(user => user.id === id) ?? null}, state, jobs,
    isUserSyncEligible: eligible, leaseOwner: 'test-owner', now: Date.now,
    qualityArtifactCleanupLocks: { acquire: key => qualityLocks.add(key), release: key => qualityLocks.delete(key) },
    refreshLocalCacheState: () => {}, pokeDownloadQueue: () => {}, dispatchPersistentJobs: () => {},
    reconcileObsoleteVerifiedArchiveRecoveries: service.reconcileObsoleteVerifiedArchiveRecoveries,
  });
  return {service, jobs, sessions, downloads, transfers, quality, enqueue};
}
