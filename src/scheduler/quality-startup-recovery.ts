import type { AppConfig } from '../config.js';
import type { LogEntry } from '../logger.js';
import type { RemoteReplacementRunner } from '../remote-operations.js';
import { joinRemotePath } from '../remote-path.js';
import type { StateManager } from '../state.js';
import { sanitizeUploadText } from '../upload-health.js';
import type { deleteRemoteFiles } from '../uploader.js';

export interface QualityStartupRecoveryDependencies {
  state: Pick<StateManager, 'listInterruptedQualityUpgrades' | 'completeQualityUpgrade' | 'resetRelationForRetry'>;
  config: { get(): AppConfig };
  remove: typeof deleteRemoteFiles;
  replacement(config: AppConfig): Promise<RemoteReplacementRunner>;
  log(entry: LogEntry): void;
  now(): number;
}

/** Recovery owns remote compensation and publishes state only after it succeeds. */
export function createQualityStartupRecovery(dependencies: QualityStartupRecoveryDependencies) {
  const { state: stateManager, config: configStore, remove: deleteRemoteFiles,
    replacement: createRemoteReplacementRunner } = dependencies;
  const logManager = { push: dependencies.log };
  async function restoreInterruptedQualityUpgrade(relation: ReturnType<StateManager["listInterruptedQualityUpgrades"]>[number]) {
    const operation = relation.qualityUpgrade;
    const config = configStore.get();
    if (operation.finalizedAt && operation.newFiles?.length) {
      const backupFiles = operation.backupFiles?.length
        ? operation.backupFiles
        : operation.oldFiles.map((file) => ({
          ...file,
          path: joinRemotePath(operation.backupRemotePath, file.name),
        }));
      const cleanup = await deleteRemoteFiles(config, backupFiles);
      if (cleanup.failed > 0) {
        throw new Error(`Failed to clean interrupted quality-upgrade backups for ${relation.bvid}`);
      }
      if (!stateManager.completeQualityUpgrade(relation.bvid, relation.userId, relation.mediaId, operation.oldRemotePath, operation.newFiles)) {
        throw new Error(`Cannot commit interrupted quality-upgrade recovery for ${relation.bvid}`);
      }
      return;
    }
    const replace = await createRemoteReplacementRunner(config);
    for (const newFile of operation.newFiles || []) {
      await replace(config, newFile.path, joinRemotePath(operation.stageRemotePath, newFile.name), newFile.size, { targetPreviouslyVerified: true });
    }
    const backupFiles = [...(operation.backupFiles || [])];
    for (const backupFile of [...backupFiles].reverse()) {
      const oldFile = operation.oldFiles.find((file) => file.name === backupFile.name);
      if (oldFile) {
        await replace(config, backupFile.path, oldFile.path, oldFile.size);
      }
    }
    const stageNames = new Set([
      ...operation.oldFiles.map((file) => file.name),
      ...(operation.newFiles || []).map((file) => file.name),
    ]);
    const cleanup = await deleteRemoteFiles(config, [...stageNames].map((name) => ({
      name,
      path: joinRemotePath(operation.stageRemotePath, name),
    })));
    if (cleanup.failed > 0) {
      throw new Error(`Failed to clean interrupted quality-upgrade stage files for ${relation.bvid}`);
    }
    stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Interrupted quality upgrade was restored for retry.");
    logManager.push({
      timestamp: new Date(dependencies.now()).toISOString(),
      type: "system",
      level: "warn",
      summary: `已恢复中断的画质重调任务 ${relation.bvid}`,
      raw: `[QualityUpgrade] restored interrupted upgrade ${relation.userId}/${relation.mediaId}/${relation.bvid}`,
      bvid: relation.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
  }

  async function recoverInterruptedQualityUpgrades() {
    const interrupted = stateManager.listInterruptedQualityUpgrades();
    for (const relation of interrupted) {
      try {
        await restoreInterruptedQualityUpgrade(relation);
      } catch (error) {
        const safeError = sanitizeUploadText(error instanceof Error ? error.message : String(error));
        logManager.push({
          timestamp: new Date(dependencies.now()).toISOString(),
          type: "system",
          level: "error",
          summary: `恢复中断的画质重调失败 ${relation.bvid}: ${safeError}`,
          raw: `[QualityUpgrade] interrupted restore failed ${relation.userId}/${relation.mediaId}/${relation.bvid}: ${safeError}`,
          bvid: relation.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        throw error;
      }
    }
  }

  return { recover: recoverInterruptedQualityUpgrades };
}
