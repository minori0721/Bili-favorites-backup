import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore, AppConfig } from '../config.js';
import type { UserStore, BiliUser } from '../users.js';
import type { StateManager } from '../state.js';
import type { PersistentJobRecord } from '../database.js';
import type { UploadTarget } from '../tasks.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { tempDir } from '../paths.js';
import { readDownloadSession, historySessionGroups, buildUploadFileMetadataFromSession } from '../download-session.js';
import { joinRemotePath } from '../utils.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig, buildQualityArtifactKey } from '../quality-artifact.js';
interface Dependencies {
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  stateManager: Pick<StateManager, 'listRelationsForBvid' | 'getVideoMeta' | 'markDownloaded'>;
  isArchiveSourceDeletionBlocked(userId: string, mediaId: number, bvid: string): boolean;
  resolveRelationRemotePath(user: BiliUser, mediaId: number, title: string, config: AppConfig): string;
  historySnapshotSegment(snapshotAt: string): string;
  queueUploadWork(item: RecoveryUploadItem, dispatch: boolean): string | false;
  dispatchPersistentJobs(): void;
}
export function createRetirementTransfers(deps: Dependencies) {
  function snapshotRetirementTargets(bvid: string) {
    const config = deps.configStore.get();
    const targets = new Map<string, UploadTarget>();
    for (const relation of deps.stateManager.listRelationsForBvid(bvid)) {
      if (["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
      if (deps.isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, relation.bvid)) continue;
      const relationUser = deps.userStore.getById(relation.userId);
      if (!relationUser) continue;
      const folder = relationUser.favorites.find((item) => item.mediaId === relation.mediaId);
      const folderTitle = folder?.title || relation.folderTitle;
      targets.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle,
        remotePath: relation.remotePath || deps.resolveRelationRemotePath(relationUser, relation.mediaId, folderTitle, config),
      });
    }
    return [...targets.values()];
  }

  function buildCompletedRetirementUploads(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ): RecoveryUploadItem[] {
    if (targets.length === 0) return [];
    const meta = deps.stateManager.getVideoMeta(bvid);
    const items: RecoveryUploadItem[] = [];
    for (const target of targets) {
      items.push({
        bvid,
        localDir: local.localDir,
        remotePath: target.remotePath,
        userId: target.userId,
        mediaId: target.mediaId,
        folderTitle: target.folderTitle,
        videoTitle: meta?.title || bvid,
        upperName: meta?.upperName || "",
        cover: meta?.cover || "",
        files: local.files,
        filenameMetadataByPath: buildUploadFileMetadataFromSession(local.localDir, local.files),
        partialBackup: local.partialBackup,
        priority: true,
      });
      for (const history of historySessionGroups(local.localDir)) {
        items.push({
          bvid,
          localDir: local.localDir,
          remotePath: joinRemotePath(target.remotePath, "_history", deps.historySnapshotSegment(history.snapshotAt)),
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: meta?.title || bvid,
          upperName: meta?.upperName || "",
          cover: meta?.cover || "",
          files: history.files.map((file) => file.relativePath),
          historyOnly: true,
          historySnapshotAt: history.snapshotAt,
          priority: false,
        });
      }
    }
    return items;
  }

  function persistCompletedRetirementUploadJobs(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ) {
    let queued = 0;
    for (const item of buildCompletedRetirementUploads(bvid, local, targets)) {
      if (deps.queueUploadWork(item, false)) queued += 1;
    }
    return queued;
  }

  function queueCompletedRetirementUpload(
    bvid: string,
    local: NonNullable<ReturnType<StateManager["getCompletedLocalDownload"]>>,
    targets: UploadTarget[],
  ) {
    if (targets.length === 0) return 0;
    deps.stateManager.markDownloaded(bvid, local.localDir, targets);
    const queued = persistCompletedRetirementUploadJobs(bvid, local, targets);
    deps.dispatchPersistentJobs();
    return queued;
  }

  function findCompletedQualitySession(job: PersistentJobRecord) {
    const payload = job.payload || {};
    const expectedArtifactKey = String(payload.artifactKey || "");
    const candidates = new Set<string>();
    if (typeof payload.downloadDir === "string" && payload.downloadDir) candidates.add(payload.downloadDir);
    try {
      for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(`quality-upgrade-${job.bvid}-`)) {
          candidates.add(path.join(tempDir, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const downloadDir of candidates) {
      const manifest = readDownloadSession(downloadDir);
      if (!manifest || manifest.kind !== "quality_upgrade" || manifest.status !== "complete" || manifest.outputs.length === 0) continue;
      const manifestProfile = normalizeQualityArtifactProfile(
        manifest.qualityUpgrade?.qualityProfile || manifest.configSnapshot || qualityArtifactProfileFromConfig(deps.configStore.get())
      );
      const manifestArtifactKey = String(
        manifest.qualityUpgrade?.artifactKey || buildQualityArtifactKey(manifest.bvid, manifestProfile)
      );
      if (expectedArtifactKey && manifestArtifactKey !== expectedArtifactKey) continue;
      const outputFiles = manifest.outputs.map((output) => output.relativePath);
      if (!outputFiles.every((relative) => fs.existsSync(path.join(downloadDir, relative)))) continue;
      return { downloadDir, outputFiles, runId: String(payload.runId || `resume-${manifest.sessionId}`) };
    }
    return null;
  }

  return { snapshotRetirementTargets, buildCompletedRetirementUploads, persistCompletedRetirementUploadJobs, queueCompletedRetirementUpload, findCompletedQualitySession };
}
