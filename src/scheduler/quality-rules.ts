import type { PersistentJobRecord } from '../database.js';
import type { StateManager, RemoteFileRecord } from '../state.js';
import type { QualityEncodingOverride } from '../tasks.js';
import { QualityUpgradeTask, qualityUpgradeTargetKey, type QualityUpgradeTarget } from '../tasks.js';
import type { QualityArtifactProfile } from '../quality-artifact.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(item => String(item || '')).filter(Boolean) : [];
}

export function qualityTargetsFromPayload(payload: unknown, fallback: QualityUpgradeTarget[] = []) {
  const item = record(payload);
  const candidates = [
    ...(Array.isArray(item.targets) ? item.targets : []),
    ...(item.target ? [item.target] : []),
    ...fallback,
  ];
  const unique = new Map<string, QualityUpgradeTarget>();
  for (const candidateValue of candidates) {
    const candidate = record(candidateValue);
    const userId = String(candidate.userId || '');
    const mediaId = Number(candidate.mediaId);
    const remotePath = String(candidate.remotePath || '');
    if (!userId || !Number.isInteger(mediaId) || !remotePath) continue;
    const target: QualityUpgradeTarget = {
      userId,
      mediaId,
      folderTitle: String(candidate.folderTitle || ''),
      remotePath,
      oldFiles: Array.isArray(candidate.oldFiles) ? candidate.oldFiles as RemoteFileRecord[] : [],
    };
    unique.set(qualityUpgradeTargetKey(target), target);
  }
  return [...unique.values()];
}

export function filterArchiveDeletionTargets<T extends { userId?: unknown; mediaId?: unknown }>(
  state: Pick<StateManager, 'getDatabase'>,
  bvid: string,
  targets: T[],
) {
  return targets.filter(target => !state.getDatabase().isArchiveSourceDeletionBlocked(
    String(target.userId || ''), Number(target.mediaId || 0), bvid,
  ));
}

export function resolveQualityUpgradeTarget(job: Pick<PersistentJobRecord, 'kind' | 'userId' | 'mediaId'>, payload: unknown, targets: QualityUpgradeTarget[]) {
  if (targets.length === 0) return null;
  const item = record(payload);
  const payloadTargetValue = record(item.target);
  const payloadTarget = item.target && typeof item.target === 'object'
    ? targets.find(candidate => qualityUpgradeTargetKey(candidate) === qualityUpgradeTargetKey({
      userId: String(payloadTargetValue.userId || ''), mediaId: Number(payloadTargetValue.mediaId),
    }))
    : undefined;
  if (job.kind === 'quality_download') return payloadTarget || targets[0];
  const jobUserId = String(job.userId || '');
  const jobMediaId = Number(job.mediaId);
  const exact = targets.find(candidate => candidate.userId === jobUserId && candidate.mediaId === jobMediaId);
  if (exact) return exact;
  if (!jobUserId && !Number.isInteger(jobMediaId) && payloadTarget) return payloadTarget;
  return targets.length === 1 ? targets[0] : null;
}

export function qualityDownloadStageLabel(task: Pick<QualityUpgradeTask, 'targets'>, label: string) {
  return task.targets.length > 1 ? `${label} · ${task.targets.length}个目标` : label;
}

export function qualityUpgradeProof(
  getProof: (userId: string, mediaId: number, bvid: string) => ReturnType<StateManager['getQualityUpgradeOperation']>,
  bvid: string,
  target: QualityUpgradeTarget,
  artifactKey?: string,
) {
  const proof = getProof(target.userId, target.mediaId, bvid);
  if (!proof || (artifactKey && proof.artifactKey && proof.artifactKey !== artifactKey)) return null;
  return proof;
}

export function mergeQualityProofFiles(payloadFiles: unknown, relationFiles: RemoteFileRecord[] | undefined) {
  if (relationFiles && relationFiles.length > 0) return relationFiles.map(file => ({ ...file }));
  const merged = new Map<string, RemoteFileRecord>();
  if (Array.isArray(payloadFiles)) {
    for (const value of payloadFiles) {
      if (!value || typeof value !== 'object') continue;
      const file = value as RemoteFileRecord;
      const key = String(file.name || file.path || '');
      if (key) merged.set(key, { ...file });
    }
  }
  return [...merged.values()];
}

export function serializeQualityUpgrade(
  task: QualityUpgradeTask,
  target: QualityUpgradeTarget = task.target,
  targets: QualityUpgradeTarget[] = task.targets,
) {
  const normalizedTargets = qualityTargetsFromPayload({ target, targets }, [target]);
  return {
    bvid: task.bvid,
    userId: target.userId,
    mediaId: target.mediaId,
    videoTitle: task.videoTitle || task.bvid,
    folderTitle: task.folderTitle || target.folderTitle,
    downloadUserId: task.downloadUserId || task.userId || target.userId,
    target,
    targets: normalizedTargets,
    targetCount: normalizedTargets.length,
    artifactKey: task.artifactKey,
    qualityProfile: task.qualityProfile as QualityArtifactProfile,
    qualityStrict: task.qualityStrict,
    qualityEncodingOverride: task.qualityEncodingOverride as QualityEncodingOverride | undefined,
    qualityStageLabel: task.qualityStageLabel,
    runId: task.runId,
    downloadDir: task.downloadDir,
    outputFiles: stringArray(task.outputFiles),
    uploadResult: task.uploadResult,
    backupFiles: task.backupFiles || [],
    finalFiles: task.finalFiles || [],
    stageRemotePath: task.stageRemotePath,
    backupRemotePath: task.backupRemotePath,
  };
}
