import path from 'node:path';
import { DownloadTask } from '../tasks.js';
import type { UploadTarget } from '../tasks.js';
import type { PersistentJobRecord } from '../database.js';
import { applyBBDownEncodingPreference, type ConfigStore, type AppConfig, type BBDownApiMode } from '../config.js';
import { downloadCredentialsForUser, type BiliUser, type UserStore } from '../users.js';
import type { StateManager, FavoriteRelation } from '../state.js';
import { tempDir } from '../paths.js';
import { normalizeQualityArtifactProfile, applyQualityArtifactProfile, buildQualityArtifactKey } from '../quality-artifact.js';
import { parseEncodingRetryContext, parseQualityEncodingOverride } from './recovery-context.js';
type ResolvedRelation = { user: BiliUser; mediaId: number; folderTitle: string };
interface Dependencies {
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  stateManager: Pick<StateManager, 'listRelationsForBvid' | 'getVideoMeta' | 'markDownloading' | 'markDownloadPrepared' | 'markDownloaded'>;
  isArchiveSourceDeletionBlocked(userId: string, mediaId: number, bvid: string): boolean;
  resolveRelation(relation: FavoriteRelation): ResolvedRelation | null;
  resolveRelationRemotePath(user: BiliUser, mediaId: number, title: string, config: AppConfig): string;
  handleDownloadApiReady(task: DownloadTask, mode: BBDownApiMode): void;
  generation(): number;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createDownloadTaskFactory(deps: Dependencies) {
  function build(job: PersistentJobRecord) {
    const epoch = deps.generation();
    const assertCurrent = () => { if (epoch !== deps.generation()) throw new Error('Download task belongs to an inactive runtime'); };
    const bvid = String(job.bvid || "");
    const payload = job.payload || {};
    const baseConfig = deps.configStore.get();
    const encodingRetry = parseEncodingRetryContext(payload.encodingRetry);
    const retryTargetKeys = new Set<string>([
      ...(Array.isArray(payload.detachedTargets) ? payload.detachedTargets : []),
      ...(encodingRetry?.target ? [encodingRetry.target] : []),
    ].map((value: unknown) => `${String(record(value).userId || "")}:${Number(record(value).mediaId || 0)}`));
    const relations = deps.stateManager.listRelationsForBvid(bvid)
      .filter((relation) => encodingRetry
        ? retryTargetKeys.has(`${relation.userId}:${relation.mediaId}`)
        : !["uploaded", "verified", "partial_verified", "downloaded", "uploading", "upload_failed"].includes(relation.backupStatus || ""))
      .filter((relation) => !deps.isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, relation.bvid))
      .map((relation) => ({ relation, resolved: deps.resolveRelation(relation) }))
      .filter((item): item is { relation: FavoriteRelation; resolved: ResolvedRelation } => Boolean(item.resolved));
    const preservedTargets: UploadTarget[] = Array.isArray(payload.detachedTargets)
      ? payload.detachedTargets.flatMap(value => {
        const item = record(value);
        if (typeof item.userId !== 'string' || !Number.isInteger(Number(item.mediaId))
          || typeof item.folderTitle !== 'string' || typeof item.remotePath !== 'string'
          || deps.isArchiveSourceDeletionBlocked(item.userId, Number(item.mediaId), bvid)) return [];
        return [{ userId: item.userId, mediaId: Number(item.mediaId), folderTitle: item.folderTitle, remotePath: item.remotePath }];
      }) : [];
    if (encodingRetry?.target && !preservedTargets.some((target) => target.userId === encodingRetry.target!.userId && target.mediaId === encodingRetry.target!.mediaId)) {
      preservedTargets.push(encodingRetry.target);
    }
    if (relations.length === 0 && preservedTargets.length === 0) return null;

    const primary = relations.find((item) => item.relation.userId === payload.primaryUserId) || relations[0];
    const requestedDownloadUser = payload.downloadUserId
      ? deps.userStore.getById(String(payload.downloadUserId))
      : null;
    const retryDownloadUser = encodingRetry?.target?.userId
      ? deps.userStore.getById(encodingRetry.target.userId)
      : null;
    const downloadUser = requestedDownloadUser?.enabled
      ? requestedDownloadUser
      : (retryDownloadUser?.enabled ? retryDownloadUser : primary?.resolved.user);
    if (!downloadUser?.enabled) return null;
    const targetsByRelation = new Map<string, UploadTarget>();
    for (const target of preservedTargets) targetsByRelation.set(`${target.userId}:${target.mediaId}`, target);
    for (const { relation, resolved } of relations) {
      targetsByRelation.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: resolved.folderTitle,
        remotePath: relation.remotePath || deps.resolveRelationRemotePath(resolved.user, relation.mediaId, resolved.folderTitle, baseConfig),
      });
    }
    const targets = [...targetsByRelation.values()];
    if (targets.length === 0) return null;
    const payloadQualityProfile = payload.qualityProfile && typeof payload.qualityProfile === "object"
      ? normalizeQualityArtifactProfile(record(payload.qualityProfile))
      : undefined;
    const qualityStrict = Boolean(payload.qualityStrict && payloadQualityProfile);
    const qualityEncodingOverride = parseQualityEncodingOverride(payload.qualityEncodingOverride);
    let taskConfig = payloadQualityProfile
      ? applyQualityArtifactProfile(baseConfig, payloadQualityProfile)
      : baseConfig;
    if (encodingRetry) {
      taskConfig = applyBBDownEncodingPreference(taskConfig, encodingRetry.priority, encodingRetry.strict);
    } else if (qualityEncodingOverride) {
      taskConfig = applyBBDownEncodingPreference(
        taskConfig,
        qualityEncodingOverride.priority,
        qualityEncodingOverride.strict,
      );
    }
    const task = new DownloadTask(bvid, downloadCredentialsForUser(downloadUser), taskConfig);
    task.maxRetries = 0;
    task.persistentJobId = job.id;
    task.persistentJob = job;
    task.userId = downloadUser.id;
    task.downloadUserId = downloadUser.id;
    task.mediaId = primary?.relation.mediaId || Number(payload.primaryMediaId || targets[0].mediaId);
    task.folderTitle = primary?.resolved.folderTitle || String(payload.primaryFolderTitle || targets[0].folderTitle);
    task.remotePath = targets[0]?.remotePath;
    task.targets = targets;
    task.encodingRetry = encodingRetry || undefined;
    task.qualityProfile = payloadQualityProfile;
    task.qualityStrict = qualityStrict;
    task.qualityEncodingOverride = qualityEncodingOverride || undefined;
    const exactArtifact = payloadQualityProfile && (qualityStrict || qualityEncodingOverride?.strict)
      ? String(payload.qualityArtifactKey || buildQualityArtifactKey(bvid, payloadQualityProfile))
      : "";
    task.downloadDirOverride = encodingRetry?.candidateLocalDir
      || (exactArtifact ? path.join(tempDir, `manual-${bvid}-${exactArtifact.slice(0, 16)}`) : undefined);
    task.automaticRecoveryAttempts = Math.max(0, Number(payload.automaticRecoveryAttempts || 0));
    const meta = deps.stateManager.getVideoMeta(bvid);
    task.videoTitle = meta?.title || bvid;
    task.upperName = meta?.upperName || "";
    task.cover = meta?.cover || "";
    task.onApiReady = (readyTask, mode) => { assertCurrent(); deps.handleDownloadApiReady(readyTask, mode); };
    task.onDownloading = () => { assertCurrent(); deps.stateManager.markDownloading(bvid, targets); };
    task.onPrepared = (_task, downloadDir, manifest) => { assertCurrent(); deps.stateManager.markDownloadPrepared(
      bvid,
      downloadDir,
      {
        id: manifest.sessionId,
        localDir: downloadDir,
        kind: manifest.kind,
        status: manifest.status,
        completedPages: manifest.outputs.length,
        totalPages: manifest.pages.length,
        updatedAt: manifest.updatedAt,
      },
      targets
    ); };
    task.onDownloaded = (_task, downloadDir) => { assertCurrent(); deps.stateManager.markDownloaded(bvid, downloadDir, targets); };
    return task;
  }

  return { build };
}
