import type { ConfigStore, AppConfig } from '../config.js';
import type { PersistentJobRecord } from '../database.js';
import type { PersistentJobStore } from '../job-store.js';
import type { LocalCleanupPlan, RemoteFileRecord, StateManager } from '../state.js';
import type { UserStore, BiliUser } from '../users.js';
import { downloadCredentialsForUser } from '../users.js';
import { logManager } from '../logger.js';
import {
  applyQualityArtifactProfile,
  buildQualityArtifactKey,
  normalizeQualityArtifactProfile,
  qualityArtifactProfileFromConfig,
} from '../quality-artifact.js';
import {
  QualityUpgradeTask,
  type QualityEncodingOverride,
  type QualityUpgradeTarget,
} from '../tasks.js';
import { sanitizeUploadText } from '../upload-health.js';
import { parseQualityEncodingOverride } from './recovery-context.js';
import {
  filterArchiveDeletionTargets,
  mergeQualityProofFiles,
  qualityDownloadStageLabel,
  qualityTargetsFromPayload,
  qualityUpgradeProof,
  resolveQualityUpgradeTarget,
  serializeQualityUpgrade,
} from './quality-rules.js';
import { buildLocalCleanupPlan } from './local-cleanup-plan.js';

type QualityJobStore = Pick<
  PersistentJobStore,
  'findById' | 'updatePayload' | 'complete' | 'countQualityJobsForArtifact' | 'countJobsForBvid'
>;

type QualityState = Pick<
  StateManager,
  | 'getDatabase'
  | 'getQualityUpgradeOperation'
  | 'markQualityUpgradeReplacing'
  | 'recordQualityUpgradeBackupFile'
  | 'recordQualityUpgradeFinalFile'
  | 'finalizeQualityUpgradeRemoteFiles'
  | 'runAtomic'
  | 'completeQualityUpgrade'
  | 'recordLocalCleanupPlan'
>;

type QualityPayload = Record<string, unknown>;

export interface QualityTaskFactoryDependencies {
  config: Pick<ConfigStore, 'get'>;
  users: Pick<UserStore, 'getById'>;
  state: QualityState;
  jobs: QualityJobStore;
  isUserSyncEligible(user: BiliUser | null): user is BiliUser;
  leaseOwner: string;
  now: () => number;
  qualityArtifactCleanupLocks: Set<string>;
  refreshLocalCacheState(): void;
  pokeDownloadQueue(): void;
  dispatchPersistentJobs(): void;
  reconcileObsoleteVerifiedArchiveRecoveries(
    limit: number,
    filter?: { bvid?: string; userId?: string; mediaId?: number },
    concurrency?: number,
  ): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : String(value || '');
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function payloadOf(job: PersistentJobRecord): QualityPayload {
  return record(job.payload);
}

/**
 * Constructs a quality task together with every callback that owns its
 * persisted lifecycle. The scheduler supplies capabilities; this module does
 * not retain the scheduler or a database connection.
 */
export function buildQualityUpgradeTask(
  job: PersistentJobRecord,
  deps: QualityTaskFactoryDependencies,
) {
  const payload = payloadOf(job);
  const bvid = stringValue(payload.bvid || job.bvid);
  const artifactKey = stringValue(payload.artifactKey);
  const fallbackProof = job.userId && Number.isInteger(Number(job.mediaId))
    ? deps.state.getQualityUpgradeOperation(String(job.userId), Number(job.mediaId), bvid)
    : null;
  const fallbackTarget: QualityUpgradeTarget[] = fallbackProof ? [{
    userId: String(job.userId),
    mediaId: Number(job.mediaId),
    folderTitle: stringValue(payload.folderTitle),
    remotePath: fallbackProof.oldRemotePath,
    oldFiles: fallbackProof.oldFiles,
  }] : [];
  const rawTargets = qualityTargetsFromPayload(payload, fallbackTarget);
  const targets = filterArchiveDeletionTargets(deps.state, bvid, rawTargets).map((candidate) => {
    const proof = qualityUpgradeProof(
      (userId, mediaId, videoId) => deps.state.getQualityUpgradeOperation(userId, mediaId, videoId),
      bvid,
      candidate,
      artifactKey || undefined,
    );
    if (!proof) return candidate;
    return {
      ...candidate,
      remotePath: proof.oldRemotePath || candidate.remotePath,
      oldFiles: proof.oldFiles.length > 0 ? proof.oldFiles : candidate.oldFiles,
    };
  });
  if (targets.length === 0) return null;

  const target = resolveQualityUpgradeTarget(job, payload, targets);
  const user = deps.users.getById(stringValue(payload.downloadUserId || payload.userId || job.userId || target?.userId));
  const needsDownloadCredentials = job.kind === 'quality_download';
  if (!target) {
    if (needsDownloadCredentials) return null;
    throw Object.assign(new Error('画质升级任务缺少唯一的归档来源目标，已暂停等待人工复核'), {
      code: 'QUALITY_TARGET_AMBIGUOUS',
      statusCode: 409,
    });
  }
  if (needsDownloadCredentials && !deps.isUserSyncEligible(user)) return null;

  const config = deps.config.get();
  const qualityProfile = normalizeQualityArtifactProfile(
    payload.qualityProfile || qualityArtifactProfileFromConfig(config),
  );
  const resolvedArtifactKey = artifactKey || buildQualityArtifactKey(bvid, qualityProfile);
  const taskConfig = applyQualityArtifactProfile(config, qualityProfile);
  const qualityEncodingOverride = parseQualityEncodingOverride(payload.qualityEncodingOverride);
  const primaryProof = qualityUpgradeProof(
    (userId, mediaId, videoId) => deps.state.getQualityUpgradeOperation(userId, mediaId, videoId),
    bvid,
    target,
    resolvedArtifactKey,
  );
  const stageRemotePath = primaryProof?.stageRemotePath || stringValue(payload.stageRemotePath) || undefined;
  const backupRemotePath = primaryProof?.backupRemotePath || stringValue(payload.backupRemotePath) || undefined;
  const persistedBackupFiles = mergeQualityProofFiles(payload.backupFiles, primaryProof?.backupFiles);
  const persistedFinalFiles = mergeQualityProofFiles(payload.finalFiles, primaryProof?.newFiles);
  const uploadResultRecord = record(payload.uploadResult);
  const persistedUploadResult = payload.uploadResult && typeof payload.uploadResult === 'object'
    ? {
      ...uploadResultRecord,
      files: mergeQualityProofFiles(uploadResultRecord.files, undefined),
    }
    : undefined;

  const task = new QualityUpgradeTask(
    bvid,
    user ? downloadCredentialsForUser(user) : { SESSDATA: '', bili_jct: '', DedeUserID: '' },
    taskConfig,
    target,
    {
      targets,
      artifactKey: resolvedArtifactKey,
      qualityProfile,
      qualityStrict: payload.qualityStrict === true,
      qualityEncodingOverride: qualityEncodingOverride || undefined,
    },
  );
  task.runId = typeof payload.runId === 'string' ? payload.runId : undefined;
  task.downloadDir = typeof payload.downloadDir === 'string' ? payload.downloadDir : undefined;
  task.outputFiles = arrayValue(payload.outputFiles).map(String);
  task.uploadResult = persistedUploadResult as QualityUpgradeTask['uploadResult'];
  task.backupFiles = persistedBackupFiles;
  task.finalFiles = persistedFinalFiles;
  task.stageRemotePath = stageRemotePath;
  task.backupRemotePath = backupRemotePath;
  if (!task.runId && (stageRemotePath || backupRemotePath)) task.runId = `resume-${resolvedArtifactKey.slice(0, 24)}`;
  task.videoTitle = stringValue(payload.videoTitle) || task.bvid;
  task.folderTitle = targets.length > 1 ? `${targets.length}个目标` : stringValue(payload.folderTitle || target.folderTitle);
  task.downloadUserId = user?.id || stringValue(payload.downloadUserId || payload.userId);
  task.userId = needsDownloadCredentials ? task.downloadUserId : target.userId;
  task.mediaId = target.mediaId;
  task.qualityStageLabel = job.kind === 'quality_download'
    ? qualityDownloadStageLabel(task, stringValue(payload.qualityStageLabel || '等待下载新版').split(' · ')[0])
    : stringValue(payload.qualityStageLabel);

  task.onStartUpgrade = () => {
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(), type: 'download', level: 'info',
      summary: `开始重调画质 ${task.bvid}: ${task.videoTitle}（${task.targets.length}个目标）`,
      raw: `[QualityUpgrade] start artifact=${task.artifactKey} targets=${task.targets.length} bvid=${task.bvid}`,
      bvid: task.bvid, simpleVisible: true,
    });
  };
  task.onReplacing = (_task, nextStageRemotePath, nextBackupRemotePath) => {
    const accepted = deps.state.markQualityUpgradeReplacing(task.bvid, target.userId, target.mediaId, {
      artifactKey: task.artifactKey,
      stageRemotePath: nextStageRemotePath,
      backupRemotePath: nextBackupRemotePath,
      oldRemotePath: target.remotePath,
      oldFiles: target.oldFiles,
    });
    if (!accepted) {
      throw Object.assign(new Error('画质升级存在另一份未完成的远端替换证明'), {
        code: 'QUALITY_UPGRADE_OPERATION_CONFLICT',
        statusCode: 409,
      });
    }
  };
  task.onBackupFileMoved = (_task, file) => {
    deps.state.recordQualityUpgradeBackupFile(task.bvid, target.userId, target.mediaId, file);
    if (task.persistentJobId) {
      deps.jobs.updatePayload(task.persistentJobId, serializeQualityUpgrade(task, target, task.targets));
    }
  };
  task.onFinalFileMoved = (_task, file) => {
    deps.state.recordQualityUpgradeFinalFile(task.bvid, target.userId, target.mediaId, file);
    if (task.persistentJobId) {
      deps.jobs.updatePayload(task.persistentJobId, serializeQualityUpgrade(task, target, task.targets));
    }
  };
  task.onUploaded = (_task, result) => {
    deps.state.finalizeQualityUpgradeRemoteFiles(task.bvid, target.userId, target.mediaId, result.remotePath, result.files);
  };
  task.onCompletedUpgrade = async () => {
    const cleanupPlan: LocalCleanupPlan | null = buildLocalCleanupPlan(
      task.bvid,
      String(task.downloadDir || ''),
      task.finalFiles || [],
      'quality_upgrade',
      deps.now,
      { id: `quality:${task.artifactKey}:${target.userId}:${target.mediaId}` },
    );
    const completed = deps.state.runAtomic(() => {
      const current = deps.jobs.findById(job.id);
      if (!current || current.leaseOwner !== deps.leaseOwner || !['leased', 'running'].includes(current.status)
        || String(current.payload.runId || '') !== String(payload.runId || '')) {
        throw new Error('Quality cleanup execution ownership changed before commit');
      }
      const result = deps.state.completeQualityUpgrade(task.bvid, target.userId, target.mediaId, target.remotePath, task.finalFiles || []);
      if (!result) throw new Error('Quality upgrade proof is unavailable before commit');
      if (cleanupPlan) deps.state.recordLocalCleanupPlan(task.bvid, cleanupPlan, job.id);
      if (!deps.jobs.complete(job.id, deps.leaseOwner)) throw new Error('Quality cleanup task changed before commit');
      return result;
    });
    if (completed) {
      void deps.reconcileObsoleteVerifiedArchiveRecoveries(1, {
        bvid: task.bvid,
        userId: target.userId,
        mediaId: target.mediaId,
      }, 1);
    }
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(), type: 'upload', level: 'info',
      summary: `重调画质完成 ${task.bvid}`,
      raw: `[QualityUpgrade] completed ${target.userId}:${target.mediaId}:${task.bvid}`,
      bvid: task.bvid, simpleVisible: true,
    });
  };
  task.onFailed = (_task, error) => {
    const safeError = sanitizeUploadText(error?.message || error);
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: task.qualityStage === 'upload' ? 'upload' : 'download', level: 'error',
      summary: `重调画质失败 ${task.bvid}: ${safeError}`,
      raw: `[QualityUpgrade] failed ${target.userId}:${target.mediaId}:${task.bvid}: ${safeError}`,
      bvid: task.bvid, simpleVisible: true, debugVisible: true,
    });
  };
  task.shouldCleanupLocal = () => {
    const canCleanup = task.artifactKey
      ? deps.jobs.countQualityJobsForArtifact(task.artifactKey) <= 1
      : deps.jobs.countJobsForBvid(task.bvid, ['quality_download', 'quality_upload', 'quality_replace', 'quality_cleanup']) <= 1;
    if (canCleanup && task.artifactKey) deps.qualityArtifactCleanupLocks.add(task.artifactKey);
    return canCleanup;
  };
  task.onLocalCleanupFinished = () => {
    if (task.artifactKey) deps.qualityArtifactCleanupLocks.delete(task.artifactKey);
    deps.refreshLocalCacheState();
    deps.pokeDownloadQueue();
    deps.dispatchPersistentJobs();
  };
  return task;
}
