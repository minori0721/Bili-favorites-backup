import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArchiveDeletionService } from './archive-deletion.js';
import type { UnavailableCoverBackfill } from './cover-cache.js';
import type { ImportMaintenance } from './import-maintenance.js';
import type { applyMigrationPackageFile, createMigrationExport, estimateMigrationExport, previewMigrationPackageFile } from './migration.js';
import type { PathMigrationService } from './path-migration.js';
interface Dependencies {
  scheduler: {
    hasRunningTransferTasks(): boolean; hasActiveOrQueuedSchedulerWork(): boolean; hasPersistentTransferWork(): boolean;
    withCleanupLock<T>(work: () => Promise<T>): Promise<T>;
    captureLegacyRecoveryMarkers(): { quality: string | null | undefined; temp: string | null | undefined };
    beginShutdown(): void;
  };
  pathMigration: Pick<PathMigrationService, 'isBusy' | 'waitForIdle' | 'tryAcquireLifecycleBarrier' | 'releaseLifecycleBarrier'>;
  archiveDeletion: Pick<ArchiveDeletionService, 'hasUnfinishedOperation' | 'setImportMaintenance'>;
  importMaintenance: Pick<ImportMaintenance, 'acquire' | 'failClosed' | 'blocked'>;
  mediaProbe: { isBusy(): boolean };
  unavailableCoverBackfill: Pick<UnavailableCoverBackfill, 'stop' | 'restart'>;
  waitForRenamePreviewIdle(timeout: number): Promise<boolean>;
  waitForCoverCacheIdle(timeout: number): Promise<boolean>;
  activePathMigration(): { status: string } | undefined;
  clearCoverBackfillMarker(): void;
  reload(restored: string[], markers: { quality: string | null | undefined; temp: string | null | undefined }): Promise<void>;
  resume(): void | Promise<void>;
  exportArchive(options: Parameters<typeof createMigrationExport>[0]): ReturnType<typeof createMigrationExport>;
  estimate(options: Parameters<typeof estimateMigrationExport>[0]): ReturnType<typeof estimateMigrationExport>;
  preview: typeof previewMigrationPackageFile;
  apply(archive: string, options: Parameters<typeof applyMigrationPackageFile>[1]): ReturnType<typeof applyMigrationPackageFile>;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
function badRequest(message: string) { return Object.assign(new Error(message), { statusCode: 400 }); }
function parseMigrationOptions(input: unknown) {
  const value = record(input);
  return {
    mode: value?.mode === "complete" ? "complete" as const : "lightweight" as const,
    includeConfig: value?.includeConfig !== false,
    includeUsers: value?.includeUsers !== false,
    includeState: value?.includeState !== false,
    includeLogs: Boolean(value?.includeLogs),
    includeDebug: Boolean(value?.includeDebug),
    includeCovers: value?.includeCovers !== false,
  };
}

async function receiveMigrationArchive(source: AsyncIterable<Uint8Array | string>) {
  const maxBytes = Number(process.env.MIGRATION_MAX_ARCHIVE_GB || 100) * 1024 ** 3;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bfb-migration-upload-"));
  const archivePath = path.join(root, "migration.zip");
  const handle = await fs.promises.open(archivePath, "wx");
  let bytes = 0;
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw badRequest("迁移压缩包超过允许大小");
      await handle.write(buffer);
    }
    if (bytes === 0) throw badRequest("迁移压缩包为空");
    return { root, archivePath, bytes };
  } catch (error) {
    await handle.close();
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await handle.close(); // FileHandle.close is idempotent; a failed close must remain observable.
  }
}

function parseBooleanOption(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}


export function createMigrationService(deps: Dependencies) {
  async function exportArchive(input: unknown) {
    const activePathMigration = deps.activePathMigration();
    if (activePathMigration && activePathMigration.status !== "cleanup_pending") {
      throw Object.assign(new Error("归档路径迁移期间禁止导出迁移包"), { statusCode: 409 });
    }
    if (deps.archiveDeletion.hasUnfinishedOperation()) {
      throw Object.assign(new Error("仍有未完成的归档清理，禁止导出迁移包"), { statusCode: 409 });
    }
    const options = parseMigrationOptions(input);
    if (options.mode === "complete" && (deps.scheduler.hasRunningTransferTasks() || deps.scheduler.hasActiveOrQueuedSchedulerWork())) {
      throw Object.assign(new Error("完整迁移要求调度和传输任务全部空闲。"), { statusCode: 409 });
    }
    const result = options.mode === "complete"
      ? await deps.scheduler.withCleanupLock(() => deps.exportArchive(options))
      : await deps.exportArchive(options);
    return result;
  }
  async function estimate(input: unknown) {
    const activePathMigration = deps.activePathMigration();
    if (activePathMigration && activePathMigration.status !== "cleanup_pending") {
      throw Object.assign(new Error("归档路径迁移期间禁止估算迁移包"), { statusCode: 409 });
    }
    if (deps.archiveDeletion.hasUnfinishedOperation()) {
      throw Object.assign(new Error("仍有未完成的归档清理，禁止估算迁移包"), { statusCode: 409 });
    }
    return await deps.estimate(parseMigrationOptions(input));
  }
  async function preview(source: AsyncIterable<Uint8Array | string>) {
    if (deps.pathMigration.isBusy()) {
      throw Object.assign(new Error("归档路径任务仍在运行，禁止导入预览包"), { statusCode: 409 });
    }
    if (deps.activePathMigration()) {
      throw Object.assign(new Error("归档路径迁移期间禁止导入迁移包"), { statusCode: 409 });
    }
    if (deps.archiveDeletion.hasUnfinishedOperation()) {
      throw Object.assign(new Error("仍有未完成的归档清理，禁止导入迁移包"), { statusCode: 409 });
    }
    const upload = await receiveMigrationArchive(source);
    let preview: Awaited<ReturnType<typeof previewMigrationPackageFile>>;
    try {
      preview = await deps.preview(upload.archivePath);
    } catch (error) {
      if (record(error).statusCode === 409) throw error;
      throw badRequest(error instanceof Error ? error.message : "导入包无法解析");
    } finally {
      await fs.promises.rm(upload.root, { recursive: true, force: true });
    }
    return preview;
  }
  async function importArchive(source: AsyncIterable<Uint8Array | string>, options: Record<string, unknown>) {
    if (deps.pathMigration.isBusy()) {
      throw Object.assign(new Error("归档路径任务仍在运行，禁止导入迁移包"), { statusCode: 409 });
    }
    if (deps.activePathMigration()) {
      throw Object.assign(new Error("归档路径迁移期间禁止导入迁移包"), { statusCode: 409 });
    }
    if (deps.archiveDeletion.hasUnfinishedOperation()) {
      throw Object.assign(new Error("仍有未完成的归档清理，禁止导入迁移包"), { statusCode: 409 });
    }
    if (deps.scheduler.hasRunningTransferTasks() || deps.scheduler.hasPersistentTransferWork() || deps.scheduler.hasActiveOrQueuedSchedulerWork()) {
      throw Object.assign(new Error("当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再导入。"), { statusCode: 409 });
    }
    const previousLegacyRecoveryMarkers = deps.scheduler.captureLegacyRecoveryMarkers();
    const upload = await receiveMigrationArchive(source);
    let releaseMaintenance: (() => void) | undefined;
    let result: Awaited<ReturnType<typeof applyMigrationPackageFile>>;
    try {
      // Validate the uploaded archive before taking the exclusive maintenance boundary.
      await deps.preview(upload.archivePath);
      releaseMaintenance = await deps.importMaintenance.acquire();
      deps.archiveDeletion.setImportMaintenance(true);
      if (deps.mediaProbe.isBusy() || deps.archiveDeletion.hasUnfinishedOperation() || deps.activePathMigration()
        || deps.scheduler.hasRunningTransferTasks() || deps.scheduler.hasPersistentTransferWork() || deps.scheduler.hasActiveOrQueuedSchedulerWork()) {
        throw Object.assign(new Error("导入准备期间任务状态已变化，请稍后重试"), { statusCode: 409 });
      }
      if (!await deps.waitForRenamePreviewIdle(30_000)) throw Object.assign(new Error("重命名预览尚未结束，请稍后重试"), { statusCode: 409 });
      const backfillStopped = await deps.unavailableCoverBackfill.stop(30_000);
      const coverQueueIdle = backfillStopped && await deps.waitForCoverCacheIdle(30_000);
      if (!backfillStopped || !coverQueueIdle) {
        throw Object.assign(new Error("封面任务未能在安全期限内停止，请稍后重试导入"), { statusCode: 409 });
      }
      result = await deps.scheduler.withCleanupLock(async () => {
        if (!await deps.pathMigration.waitForIdle(30_000)) {
          throw Object.assign(new Error("归档路径任务未能在安全期限内停止，请稍后重试导入"), { statusCode: 409 });
        }
        if (!deps.pathMigration.tryAcquireLifecycleBarrier()) {
          throw Object.assign(new Error("归档路径任务刚刚开始运行，请稍后重试导入"), { statusCode: 409 });
        }
        try {
          return await deps.apply(upload.archivePath, {
            restoreConfig: parseBooleanOption(options.restoreConfig, true),
            restoreUsers: parseBooleanOption(options.restoreUsers, true),
            restoreState: parseBooleanOption(options.restoreState, true),
            restoreCovers: parseBooleanOption(options.restoreCovers, true),
            restoreLogs: parseBooleanOption(options.restoreLogs, false),
            restoreDebug: parseBooleanOption(options.restoreDebug, false),
            reload: restored => deps.reload(restored, previousLegacyRecoveryMarkers),
            resume: deps.resume,
          });
        } finally {
          deps.pathMigration.releaseLifecycleBarrier();
        }
      });
      if (result.restored.some((item) => item === "state" || item === "covers")) {
        deps.clearCoverBackfillMarker();
      }
    } catch (error) {
      if (record(error).recoveryRequired) {
        deps.importMaintenance.failClosed();
        deps.scheduler.beginShutdown();
        throw error;
      }
      if (record(error).statusCode === 409) throw error;
      throw badRequest(error instanceof Error ? error.message : "导入包无法解析");
    } finally {
      try { await fs.promises.rm(upload.root, { recursive: true, force: true }); }
      finally {
        releaseMaintenance?.();
        if (!deps.importMaintenance.blocked) {
          deps.archiveDeletion.setImportMaintenance(false);
          deps.unavailableCoverBackfill.restart();
        }
      }
    }
    return result;
  }
  return { exportArchive, estimate, preview, importArchive };
}
