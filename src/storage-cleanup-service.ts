import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from './config.js';
import type { UnavailableCoverBackfill } from './cover-cache.js';
import { sqlitePaths } from './database.js';
import { safeErrorSummary } from './diagnostics.js';
import { cleanupDownloadRecoveryArtifacts, inspectDownloadCache } from './download-session.js';
import { logsPath } from './logger.js';
import type { OnlineCoverCache } from './online-cover-cache.js';
import { backupsDir, coversDir, databasePath, dataDir, exportsDir, onlineCoversDir, tempDir } from './paths.js';
import type { StateManager } from './state.js';
import { clearDirectoryContents } from './storage.js';
import type { UserStore } from './users.js';
export type CleanupItem = "memory-cache" | "temp" | "orphan-fragments" | "logs" | "debug-logs" | "covers" | "online-covers" | "exports" | "backups" | "state" | "users" | "config";
interface CleanupAdmission {
  refreshLocalCacheState(): void;
  updateInterval(): void;
  hasRunningTransferTasks(): boolean;
  hasActiveOrQueuedSchedulerWork(): boolean;
  withCleanupLock<T>(work: () => Promise<T>): Promise<T>;
}
interface Dependencies {
  scheduler: CleanupAdmission;
  stateManager: Pick<StateManager, 'clear' | 'clearCoverCachePaths'>;
  userStore: Pick<UserStore, 'clear'>;
  configStore: Pick<ConfigStore, 'get' | 'reset'>;
  onlineCoverCache: Pick<OnlineCoverCache, 'clear' | 'inspect' | 'setLimitMb'>;
  unavailableCoverBackfill: Pick<UnavailableCoverBackfill, 'stop' | 'restart'>;
  waitForCoverCacheIdle(timeout: number): Promise<boolean>;
  clearMemoryCaches(): void;
  clearLogs(): void;
  clearCoverBackfillMarker(): void;
  hasPathMigration(): boolean;
  hasUnfinishedDeletion(): boolean;
}
export function createStorageCleanup(deps: Dependencies) {


  const cleanupItems: Record<CleanupItem, { label: string; important: boolean; path?: string }> = {
    "memory-cache": { label: "页面缓存", important: false },
    temp: { label: "全部临时下载文件", important: true, path: tempDir },
    "orphan-fragments": { label: "无法续传的下载残片", important: true },
    logs: { label: "网页日志", important: false, path: logsPath },
    "debug-logs": { label: "Debug 日志", important: false, path: path.join(dataDir, "debug") },
    covers: { label: "归档封面（永久保存）", important: true, path: coversDir },
    "online-covers": { label: "在线缩略图缓存", important: false, path: onlineCoversDir },
    exports: { label: "导出压缩包", important: false, path: exportsDir },
    backups: { label: "导入前备份", important: false, path: backupsDir },
    state: { label: "备份状态与持久化任务", important: true, path: databasePath },
    users: { label: "账号登录信息", important: true, path: path.join(dataDir, "users.json") },
    config: { label: "全局配置", important: true, path: path.join(dataDir, "config.json") },
  };

  const allCleanupKeys = Object.keys(cleanupItems) as CleanupItem[];

  async function pathSize(targetPath: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(targetPath);
      if (stat.isFile()) return stat.size;
      if (!stat.isDirectory()) return 0;
      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        total += await pathSize(path.join(targetPath, entry.name));
      }
      return total;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
  }

  function normalizeCleanupItems(value: unknown): CleanupItem[] {
    if (!Array.isArray(value)) return [];
    const picked = new Set<CleanupItem>();
    for (const item of value) {
      if (typeof item === "string" && allCleanupKeys.includes(item as CleanupItem)) {
        picked.add(item as CleanupItem);
      }
    }
    return [...picked];
  }

  function cleanupRequiresIdle(items: CleanupItem[]) {
    return items.some((item) => item !== "memory-cache" && item !== "logs" && item !== "debug-logs" && item !== "exports" && item !== "backups");
  }

  function cleanupConfirmationRequired(items: CleanupItem[]) {
    if (items.length === 1 && items[0] === "covers") return "DELETE ARCHIVE COVERS";
    const important = items.some((item) => cleanupItems[item].important);
    const full = allCleanupKeys.every((key) => items.includes(key));
    if (full) return "DELETE ALL PROJECT DATA";
    if (important) return "DELETE";
    return "";
  }

  async function removeCleanupTarget(item: CleanupItem) {
    if (item === "memory-cache") {
      deps.clearMemoryCaches();
      return;
    }
    if (item === "logs") {
      deps.clearLogs();
      return;
    }
    if (item === "online-covers") {
      await deps.onlineCoverCache.clear();
      return;
    }
    if (item === "orphan-fragments") {
      await cleanupDownloadRecoveryArtifacts(tempDir);
      deps.scheduler.refreshLocalCacheState();
      return;
    }
    if (item === "state") {
      deps.stateManager.clear();
      return;
    }
    const targetPath = cleanupItems[item].path;
    if (!targetPath) return;
    if (item === "temp") {
      await clearDirectoryContents(tempDir);
      deps.scheduler.refreshLocalCacheState();
      return;
    }
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    if (item === "covers") {
      await fs.promises.mkdir(coversDir, { recursive: true });
      deps.stateManager.clearCoverCachePaths();
      deps.clearCoverBackfillMarker();
    } else if (item === "exports") {
      await fs.promises.mkdir(exportsDir, { recursive: true });
    } else if (item === "backups") {
      await fs.promises.mkdir(backupsDir, { recursive: true });
    } else if (item === "users") {
      deps.userStore.clear();
    } else if (item === "config") {
      deps.configStore.reset();
      deps.onlineCoverCache.setLimitMb(deps.configStore.get().onlineCoverCacheLimitMB);
      deps.scheduler.updateInterval();
    }
  }

  async function inspect() {
    const cacheInspection = await inspectDownloadCache(tempDir);
    const downloadRecovery = cacheInspection.recovery;
    const items = await Promise.all(allCleanupKeys.map(async (key) => ({
      key,
      label: cleanupItems[key].label,
      important: cleanupItems[key].important,
      bytes: key === "orphan-fragments"
        ? downloadRecovery.cleanupEligibleBytes
        : key === "temp"
          ? cacheInspection.usedBytes
          : key === "state"
            ? (await Promise.all(sqlitePaths(databasePath).map((file) => pathSize(file)))).reduce((sum, value) => sum + value, 0)
            : key === "online-covers"
              ? (await deps.onlineCoverCache.inspect()).bytes
              : cleanupItems[key].path ? await pathSize(cleanupItems[key].path) : 0,
    })));
    return {
      items,
      runningTransfers: deps.scheduler.hasRunningTransferTasks(),
      activeScheduler: deps.scheduler.hasActiveOrQueuedSchedulerWork(),
      downloadRecovery,
    };
  }
  async function execute(input: { items?: unknown; confirmation?: unknown }) {
    const items = normalizeCleanupItems(input.items);
    if (items.length === 0) {
      throw Object.assign(new Error("请选择要清理的内容"), { statusCode: 400 });
    }
    if (items.includes("state") && deps.hasPathMigration()) {
      throw Object.assign(new Error("归档路径迁移期间不能清理业务状态"), { statusCode: 409 });
    }
    if (items.some((item) => item === "state" || item === "users" || item === "config") && deps.hasUnfinishedDeletion()) {
      throw Object.assign(new Error("仍有未完成的归档清理，不能清理业务状态、账号或配置"), { statusCode: 409 });
    }
    const requiresIdle = cleanupRequiresIdle(items);
    if (requiresIdle && (deps.scheduler.hasRunningTransferTasks() || deps.scheduler.hasActiveOrQueuedSchedulerWork())) {
      throw Object.assign(new Error("当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再清理重要数据。"), { statusCode: 409 });
    }
    const required = cleanupConfirmationRequired(items);
    if (required && String(input.confirmation || "") !== required) {
      throw Object.assign(new Error(`请输入 ${required} 确认清理`), { statusCode: 400 });
    }
    const runCleanup = async () => {
      const quiesceCoverWork = items.includes("covers") || items.includes("state");
      if (quiesceCoverWork) {
        const stopped = await deps.unavailableCoverBackfill.stop(30_000);
        const idle = stopped && await deps.waitForCoverCacheIdle(30_000);
        if (!stopped || !idle) {
          deps.unavailableCoverBackfill.restart();
          throw Object.assign(new Error("封面任务未能在安全期限内停止，请稍后重试清理"), { statusCode: 409 });
        }
      }
      const results: Array<{ key: CleanupItem; label: string; ok: boolean; error?: string; skipped?: boolean; note?: string }> = [];
      for (const item of items) {
        if (item === "orphan-fragments" && items.includes("temp")) {
          const tempResult = results.find((result) => result.key === "temp");
          if (tempResult?.ok) {
            results.push({
              key: item,
              label: cleanupItems[item].label,
              ok: true,
              skipped: true,
              note: "已包含在全部临时下载文件中",
            });
            continue;
          }
        }
        try {
          await removeCleanupTarget(item);
          results.push({ key: item, label: cleanupItems[item].label, ok: true });
        } catch (error) {
          results.push({ key: item, label: cleanupItems[item].label, ok: false, error: safeErrorSummary(error) });
        }
      }
      if (quiesceCoverWork) deps.unavailableCoverBackfill.restart();
      return results;
    };
    const results = requiresIdle ? await deps.scheduler.withCleanupLock(runCleanup) : await runCleanup();
    const failed = results.filter((item) => !item.ok);
    if (failed.length > 0) {
      return { status: 500, body: { success: false, message: `有 ${failed.length} 项清理失败`, data: { results } } };
    }
    return { status: 200, body: { success: true, data: { results } } };
  }
  return { inspect, execute };
}
