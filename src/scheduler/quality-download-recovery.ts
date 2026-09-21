import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from '../config.js';
import { readDownloadSession } from '../download-session.js';
import { applyQualityArtifactProfile, buildQualityArtifactKey, normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig } from '../quality-artifact.js';
import { StateManager, relationKey } from '../state.js';
import { QualityUpgradeTask } from '../tasks.js';
import { downloadCredentialsForUser, type UserStore } from '../users.js';

export interface QualityDownloadRecoveryDependencies {
  state: Pick<StateManager, 'listInterruptedQualityUpgrades' | 'getVideoMeta'>;
  config: Pick<ConfigStore, 'get'>;
  users: Pick<UserStore, 'getById' | 'list'>;
  directory: string;
  enqueue(task: QualityUpgradeTask): unknown;
}
export async function recoverInterruptedQualityDownloads(dependencies: QualityDownloadRecoveryDependencies) {
  const { state: stateManager, config: configStore, users: userStore, directory: tempDir, enqueue } = dependencies;
  const remoteRecoveryBlocked = new Set(
    stateManager.listInterruptedQualityUpgrades().map((relation) => relationKey(relation.userId, relation.mediaId, relation.bvid))
  );
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(tempDir, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("quality-upgrade-")) continue;
    const downloadDir = path.join(tempDir, entry.name);
    const manifest = readDownloadSession(downloadDir);
    const target = manifest?.qualityUpgrade;
    if (!manifest || manifest.kind !== "quality_upgrade" || !target || manifest.status === "partial") continue;
    const targets = (Array.isArray(target.targets) && target.targets.length > 0 ? target.targets : [target])
      .filter((candidate) => !remoteRecoveryBlocked.has(relationKey(candidate.userId, candidate.mediaId, manifest.bvid)));
    if (targets.length === 0) continue;
    const user = (target.downloadUserId ? userStore.getById(target.downloadUserId) : null)
      || userStore.list().find((candidate) => candidate.enabled && Number(candidate.uid || candidate.cookie.DedeUserID || 0) === manifest.accountUid)
      || userStore.getById(targets[0].userId);
    if (!user || !user.enabled) continue;
    const qualityProfile = normalizeQualityArtifactProfile(
      target.qualityProfile || manifest.configSnapshot || qualityArtifactProfileFromConfig(configStore.get())
    );
    const artifactKey = target.artifactKey || buildQualityArtifactKey(manifest.bvid, qualityProfile);
    const meta = stateManager.getVideoMeta(manifest.bvid);
    const task = new QualityUpgradeTask(
      manifest.bvid,
      downloadCredentialsForUser(user),
      applyQualityArtifactProfile(configStore.get(), qualityProfile),
      targets[0],
      { targets, artifactKey, qualityProfile }
    );
    task.downloadDir = downloadDir;
    task.runId = `resume-${manifest.sessionId}`;
    task.videoTitle = meta?.title || manifest.bvid;
    task.folderTitle = targets.length > 1 ? `${targets.length}个目标` : targets[0].folderTitle;
    task.downloadUserId = user.id;
    task.userId = user.id;
    task.mediaId = targets[0].mediaId;
    enqueue(task);
  }
}
