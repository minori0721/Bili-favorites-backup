import crypto from "node:crypto";
import { createClient, type WebDAVClient } from "webdav";
import type { AppConfig, ConfigStore } from "./config.js";
import {
  type PathMigrationItemRecord,
  type PathMigrationItemStatus,
  type PathMigrationRecord,
  type PathMigrationStatus,
  type StateDatabase,
} from "./database.js";
import { PersistentJobStore } from "./job-store.js";
import { safeErrorSummary } from "./diagnostics.js";
import { isRemoteNotFoundError } from "./uploader.js";

export interface PathMigrationDavClient {
  getDirectoryContents(path: string): Promise<any>;
  createDirectory(path: string): Promise<any>;
  copyFile(source: string, destination: string, options?: Record<string, unknown>): Promise<any>;
  stat(path: string): Promise<any>;
  deleteFile(path: string): Promise<any>;
}

export interface PathMigrationOptions {
  clientFactory?: (config: AppConfig) => PathMigrationDavClient;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  isSchedulerIdle?: () => boolean;
  setMaintenance?: (locked: boolean, summary?: { id: string; status: string; sourceRoot: string; destinationRoot: string }) => void;
  onConfigSwitched?: (previous: AppConfig, next: AppConfig) => void;
}

const ACTIVE_STATUSES: PathMigrationStatus[] = ["scanning", "ready", "copying", "verifying", "paused", "switching", "cleanup_pending"];
const TERMINAL_ITEM_STATUSES: PathMigrationItemStatus[] = ["reusable", "verified"];
const MAX_ENTRIES = 100_000;
const VERIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeRoot(value: string) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw.startsWith("/")) throw new Error("归档路径必须是绝对路径");
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("归档路径不能包含 .、.. 或非法字符");
  }
  return `/${parts.join("/")}` || "/";
}

function isWithin(root: string, target: string) {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function relativePath(root: string, target: string) {
  if (!isWithin(root, target)) throw new Error("远端条目超出迁移根路径");
  if (target === root) return "";
  const relative = target.slice(root.length + 1);
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("远端条目包含非法相对路径");
  }
  return parts.join("/");
}

function joinRemote(root: string, relative: string) {
  return relative ? `${root.replace(/\/$/g, "")}/${relative}` : root;
}

function entryType(value: any): "file" | "directory" {
  return value?.type === "directory" || value?.isDirectory === true ? "directory" : "file";
}

function statusCode(error: any) {
  return Number(error?.statusCode || error?.response?.status || error?.status || 0);
}

function isTransientError(error: any) {
  const status = statusCode(error);
  return status === 0 || status >= 500 || status === 408 || status === 429;
}

function isImmediateStopError(error: any) {
  const status = statusCode(error);
  return status === 401 || status === 403 || status === 405 || status === 409 || status === 412;
}

function migrationConflictError(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function matchesRemoteItem(item: PathMigrationItemRecord, stat: any) {
  return entryType(stat) === item.itemType
    && (item.itemType === "directory" || Number(stat?.size) === Number(item.expectedSize));
}

function identityHash(config: AppConfig) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      alistUrl: String(config.alistUrl || "").replace(/\/$/, ""),
      alistUsername: String(config.alistUsername || ""),
      alistPassword: String(config.alistPassword || ""),
    }))
    .digest("hex");
}

function pathSummary(record: PathMigrationRecord) {
  return {
    id: record.id,
    status: record.status,
    sourceRoot: record.sourceRoot,
    destinationRoot: record.destinationRoot,
  };
}

export function validateArchiveMigrationRoots(sourceValue: string, destinationValue: string) {
  const source = normalizeRoot(sourceValue);
  const destination = normalizeRoot(destinationValue);
  if (source === destination) throw new Error("新旧归档路径不能相同");
  if (isWithin(source, destination) || isWithin(destination, source)) {
    throw new Error("新旧归档路径不能互相嵌套");
  }
  const sourceMount = source.split("/").filter(Boolean)[0] || "";
  const destinationMount = destination.split("/").filter(Boolean)[0] || "";
  if (sourceMount !== destinationMount) {
    throw new Error("只能在同一AList挂载存储内迁移归档路径");
  }
  return { source, destination };
}

export class PathMigrationService {
  private db: StateDatabase;
  private readonly configStore: ConfigStore;
  private readonly jobStore: PersistentJobStore;
  private readonly clientFactory: (config: AppConfig) => PathMigrationDavClient;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly isSchedulerIdle: () => boolean;
  private readonly setMaintenance: NonNullable<PathMigrationOptions["setMaintenance"]>;
  private readonly onConfigSwitched: NonNullable<PathMigrationOptions["onConfigSwitched"]>;
  private worker: Promise<void> | null = null;
  private starting = false;
  private stopped = false;
  private readonly ensuredDirectories = new Set<string>();
  private readonly leaseOwner = `path-migration:${crypto.randomUUID()}`;
  private leaseTimer: NodeJS.Timeout | null = null;

  constructor(db: StateDatabase, configStore: ConfigStore, options: PathMigrationOptions = {}) {
    this.db = db;
    this.configStore = configStore;
    this.jobStore = new PersistentJobStore(db);
    this.clientFactory = options.clientFactory || ((config) => {
      const davUrl = `${String(config.alistUrl || "").replace(/\/$/, "")}/dav`;
      return createClient(davUrl, { username: config.alistUsername, password: config.alistPassword }) as unknown as PathMigrationDavClient;
    });
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.isSchedulerIdle = options.isSchedulerIdle || (() => true);
    this.setMaintenance = options.setMaintenance || (() => undefined);
    this.onConfigSwitched = options.onConfigSwitched || (() => undefined);
  }

  getState() {
    const record = this.db.getActivePathMigration() || this.db.getPathMigration(this.latestMigrationId());
    if (!record) return undefined;
    const itemCounts = this.db.countPathMigrationItems(record.id);
    const total = Math.max(0, record.entryCount);
    const verified = Number(itemCounts.verified?.count || 0) + Number(itemCounts.reusable?.count || 0);
    return {
      ...record,
      progress: { completed: verified, total, ratio: total > 0 ? Math.min(1, verified / total) : 0 },
      pendingCount: Number(itemCounts.pending?.count || 0),
      copyingCount: Number(itemCounts.copying?.count || 0),
      awaitingVerificationCount: Number(itemCounts.awaiting_verification?.count || 0),
      verifiedCount: verified,
      failedCount: Number(itemCounts.failed?.count || 0),
      conflictCount: Number(itemCounts.conflict?.count || 0),
      bytesToCopy: Number(itemCounts.pending?.bytes || 0) + Number(itemCounts.copying?.bytes || 0),
    };
  }

  listItems(statuses: PathMigrationItemStatus[] = ["conflict", "failed"], offset = 0, limit = 100) {
    const record = this.db.getActivePathMigration() || this.db.getPathMigration(this.latestMigrationId());
    return record ? this.db.listPathMigrationItems(record.id, statuses, offset, limit) : [];
  }

  async preview(destinationValue: string) {
    const config = this.configStore.get();
    const active = this.db.getActivePathMigration();
    if (active) throw new Error("已有未结束的归档路径迁移");
    const roots = validateArchiveMigrationRoots(config.alistDest, destinationValue);
    const id = crypto.randomUUID();
    const record = this.db.createPathMigration({
      id,
      sourceRoot: roots.source,
      destinationRoot: roots.destination,
      alistIdentityHash: identityHash(config),
      status: "scanning",
      entryCount: 0,
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      reusableCount: 0,
      copiedCount: 0,
      verifiedCount: 0,
      conflictCount: 0,
      extraCount: 0,
    });
    void this.runPreview(record.id).catch((error) => {
      const current = this.db.getPathMigration(record.id);
      if (current && current.status !== "cancelled") {
        this.db.updatePathMigration(record.id, { status: "failed", lastError: safeErrorSummary(error) });
      }
    });
    return record;
  }

  private latestMigrationId() {
    const row = this.db.db.prepare("SELECT id FROM path_migrations ORDER BY created_at DESC LIMIT 1").get() as any;
    return row ? String(row.id) : "";
  }

  private previewStillActive(id: string) {
    return this.db.getPathMigration(id)?.status === "scanning";
  }

  rebind(database: StateDatabase) {
    this.db = database;
    this.jobStore.rebind(database);
    this.ensuredDirectories.clear();
  }

  private async walk(
    client: PathMigrationDavClient,
    root: string,
    visit: (entry: { path: string; relativePath: string; itemType: "file" | "directory"; size?: number }) => Promise<void>,
    allowMissing = false,
    shouldContinue?: () => boolean
  ) {
    const walkDir = async (directory: string, depth: number): Promise<void> => {
      if (shouldContinue && !shouldContinue()) return;
      let entries: any[];
      try {
        entries = await client.getDirectoryContents(directory) as any[];
      } catch (error) {
        if (allowMissing && isRemoteNotFoundError(error) && depth === 0) return;
        throw error;
      }
      if (!Array.isArray(entries)) throw new Error("AList 返回了无效的目录清单");
      if (entries.length > MAX_ENTRIES) throw new Error(`远端目录条目超过安全上限 ${MAX_ENTRIES}`);
      entries.sort((left, right) => String(left?.filename || left?.path || left?.basename || "").localeCompare(String(right?.filename || right?.path || right?.basename || "")));
      for (const entry of entries) {
        if (shouldContinue && !shouldContinue()) return;
        const entryPath = String(entry?.filename || entry?.path || `${directory.replace(/\/$/g, "")}/${entry?.basename || ""}`).replace(/\\/g, "/");
        if (!isWithin(root, entryPath) || entryPath === root) continue;
        const itemType = entryType(entry);
        let size = typeof entry?.size === "number" && Number.isFinite(entry.size) ? Number(entry.size) : undefined;
        if (itemType === "file" && size === undefined) {
          const stat = await client.stat(entryPath);
          size = Number.isFinite(Number(stat?.size)) ? Number(stat.size) : undefined;
        }
        await visit({ path: entryPath, relativePath: relativePath(root, entryPath), itemType, size });
        if (itemType === "directory") await walkDir(entryPath, depth + 1);
      }
    };
    await walkDir(root, 0);
  }

  private async runPreview(id: string) {
    const record = this.db.getPathMigration(id);
    if (!record || record.status !== "scanning") return;
    const config = this.configStore.get();
    const client = this.clientFactory(config);
    const sourceItems: PathMigrationItemRecord[] = [];
    let entryCount = 0;
    let fileCount = 0;
    let directoryCount = 0;
    let totalBytes = 0;
    await this.walk(client, record.sourceRoot, async (entry) => {
      if (!this.previewStillActive(id)) return;
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) throw new Error(`远端目录条目超过安全上限 ${MAX_ENTRIES}`);
      if (entry.itemType === "file") { fileCount += 1; totalBytes += Number(entry.size || 0); }
      else directoryCount += 1;
      const now = this.now();
      sourceItems.push({
        migrationId: id,
        relativePath: entry.relativePath,
        itemType: entry.itemType,
        expectedSize: entry.size,
        sourcePath: entry.path,
        destinationPath: joinRemote(record.destinationRoot, entry.relativePath),
        status: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: now,
        updatedAt: now,
      });
      if (sourceItems.length >= 500) {
        this.db.insertPathMigrationItems(sourceItems.splice(0, sourceItems.length));
      }
    }, false, () => this.previewStillActive(id));
    if (!this.previewStillActive(id)) return;
    if (sourceItems.length > 0) this.db.insertPathMigrationItems(sourceItems.splice(0, sourceItems.length));

    let reusableCount = 0;
    let conflictCount = 0;
    await this.walk(client, record.sourceRoot, async (entry) => {
      if (!this.previewStillActive(id)) return;
      const item = this.db.getPathMigrationItem(id, entry.relativePath);
      if (!item) return;
      let target: any;
      try { target = await client.stat(item.destinationPath); } catch (error) {
        if (!isRemoteNotFoundError(error)) throw error;
      }
      if (!target) return;
      const sameType = entryType(target) === item.itemType;
      const sameSize = item.itemType === "directory" || Number(target?.size) === Number(item.expectedSize);
      const status: PathMigrationItemStatus = sameType && sameSize ? "reusable" : "conflict";
      this.db.updatePathMigrationItem(id, item.relativePath, { status });
      if (status === "reusable") reusableCount += 1;
      else conflictCount += 1;
    }, false, () => this.previewStillActive(id));
    if (!this.previewStillActive(id)) return;

    let extraCount = 0;
    await this.walk(client, record.destinationRoot, async (entry) => {
      if (!this.previewStillActive(id)) return;
      if (!this.db.getPathMigrationItem(id, entry.relativePath)) extraCount += 1;
    }, true, () => this.previewStillActive(id));
    if (!this.previewStillActive(id)) return;
    const sourceManifestHash = this.db.hashPathMigrationItems(id);
    this.db.updatePathMigration(id, {
      status: conflictCount > 0 ? "failed" : "ready",
      sourceManifestHash,
      entryCount,
      fileCount,
      directoryCount,
      totalBytes,
      reusableCount,
      copiedCount: 0,
      verifiedCount: reusableCount,
      conflictCount,
      extraCount,
      lastError: conflictCount > 0 ? "目标存在大小或类型冲突，请更换目标路径或处理冲突" : undefined,
    });
  }

  async start(id?: string) {
    if (this.starting) throw new Error("归档路径迁移正在执行开始前复核");
    const record = this.db.getPathMigration(id || this.latestMigrationId());
    if (!record || record.status !== "ready") throw new Error("只有无冲突的就绪预览才能开始迁移");
    if (record.conflictCount > 0 || !this.isSchedulerIdle()) throw new Error("开始迁移前必须没有同步、下载、上传或远端确认任务");
    const config = this.configStore.get();
    if (identityHash(config) !== record.alistIdentityHash || normalizeRoot(config.alistDest) !== record.sourceRoot) {
      throw new Error("AList身份或当前归档路径已变化，请重新预览");
    }
    this.starting = true;
    this.setMaintenance(true, pathSummary(record));
    try {
      const manifest = await this.computeManifest(this.clientFactory(config), record.sourceRoot);
      const current = this.db.getPathMigration(record.id);
      if (!current || current.status !== "ready") {
        throw new Error("归档路径迁移已在开始前复核期间取消或改变状态");
      }
      if (manifest !== record.sourceManifestHash) {
        this.db.updatePathMigration(record.id, { status: "failed", lastError: "预览后源目录已变化，请重新生成预览" });
        throw new Error("预览后源目录已变化，请重新生成预览");
      }
      this.db.updatePathMigration(record.id, { status: "copying", lastError: undefined });
      this.jobStore.enqueue({ kind: "path_migration", dedupeKey: `path-migration:${record.id}`, priority: 1, maxAttempts: 1_000_000, payload: { migrationId: record.id } });
      this.startWorker(record.id);
      return this.getState();
    } catch (error) {
      const current = this.db.getPathMigration(record.id);
      if (current?.status === "ready") {
        this.db.updatePathMigration(record.id, { lastError: safeErrorSummary(error) });
      }
      if (!current || !["copying", "verifying", "paused", "switching", "cleanup_pending"].includes(current.status)) {
        this.setMaintenance(false);
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async computeManifest(client: PathMigrationDavClient, root: string, migrationId?: string) {
    this.db.db.exec("CREATE TEMP TABLE IF NOT EXISTS path_migration_scan (relative_path TEXT PRIMARY KEY, item_type TEXT NOT NULL, expected_size INTEGER)");
    this.db.db.exec("DELETE FROM path_migration_scan");
    const insert = this.db.db.prepare("INSERT OR REPLACE INTO path_migration_scan(relative_path,item_type,expected_size) VALUES(?,?,?)");
    let count = 0;
    await this.walk(client, root, async (entry) => {
      count += 1;
      if (count > MAX_ENTRIES) throw new Error(`远端目录条目超过安全上限 ${MAX_ENTRIES}`);
      insert.run(entry.relativePath, entry.itemType, entry.size == null ? null : entry.size);
    });
    if (migrationId) {
      const changed = this.db.db.prepare(`
        SELECT EXISTS(SELECT 1 FROM path_migration_scan s LEFT JOIN path_migration_items i
          ON i.migration_id=? AND i.relative_path=s.relative_path
          WHERE i.relative_path IS NULL OR i.item_type<>s.item_type OR COALESCE(i.expected_size,-1)<>COALESCE(s.expected_size,-1))
        OR EXISTS(SELECT 1 FROM path_migration_items i LEFT JOIN path_migration_scan s ON s.relative_path=i.relative_path
          WHERE i.migration_id=? AND s.relative_path IS NULL) AS changed
      `).get(migrationId, migrationId) as any;
      if (changed?.changed) throw new Error("源目录条目在预览后发生变化");
    }
    const hash = crypto.createHash("sha256");
    for (const row of this.db.db.prepare("SELECT relative_path,item_type,COALESCE(expected_size,-1) AS expected_size FROM path_migration_scan ORDER BY relative_path ASC").iterate() as Iterable<any>) {
      hash.update(`${row.relative_path}\0${row.item_type}\0${row.expected_size}\n`);
    }
    this.db.db.exec("DELETE FROM path_migration_scan");
    return hash.digest("hex");
  }

  private startWorker(id: string) {
    if (this.worker) return;
    this.ensuredDirectories.clear();
    this.worker = this.runWorkerWithLease(id).finally(() => { this.worker = null; });
  }

  private async runWorkerWithLease(id: string) {
    const dedupeKey = `path-migration:${id}`;
    let job = this.jobStore.findByDedupeKey(dedupeKey);
    if (!job) {
      this.jobStore.enqueue({
        kind: "path_migration",
        dedupeKey,
        priority: 1,
        maxAttempts: 1_000_000,
        payload: { migrationId: id },
      });
    }
    while (!this.stopped) {
      job = this.jobStore.claimByDedupeKey(dedupeKey, this.leaseOwner, 30 * 60_000, this.now());
      if (job) break;
      const current = this.jobStore.findByDedupeKey(dedupeKey);
      if (!current) return;
      const waitMs = current.leaseExpiresAt
        ? Math.max(100, Math.min(30_000, current.leaseExpiresAt - this.now() + 100))
        : 1_000;
      await this.sleep(waitMs);
    }
    if (!job || this.stopped) return;
    this.leaseTimer = setInterval(() => {
      this.jobStore.extendLease(job!.id, this.leaseOwner, 30 * 60_000);
    }, 5 * 60_000);
    this.leaseTimer.unref?.();
    try {
      await this.runWorker(id);
    } catch (error) {
      const current = this.db.getPathMigration(id);
      if (current && ACTIVE_STATUSES.includes(current.status)) {
        this.db.updatePathMigration(id, { status: "paused", lastError: safeErrorSummary(error) });
      }
    } finally {
      if (this.leaseTimer) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
      }
      this.jobStore.releaseOwner(this.leaseOwner);
    }
  }

  private async runWorker(id: string) {
    while (!this.stopped) {
      const record = this.db.getPathMigration(id);
      if (!record || ["cancelled", "completed", "failed"].includes(record.status)) return;
      if (record.status === "paused") return;
      if (record.status === "switching") {
        await this.switchConfig(id);
        continue;
      }
      if (record.status === "cleanup_pending") return;
      const item = this.db.nextPathMigrationItem(id, this.now());
      if (!item) {
        const counts = this.db.countPathMigrationItems(id);
        const incomplete = Object.keys(counts).some((key) => !TERMINAL_ITEM_STATUSES.includes(key as PathMigrationItemStatus) && Number(counts[key]?.count || 0) > 0);
        if (incomplete) {
          const now = this.now();
          const nextAt = this.db.nextPathMigrationAttemptAt(id, now) ?? now + 1_000;
          await this.sleep(Math.max(100, Math.min(60 * 60_000, nextAt - now)));
          continue;
        }
        await this.switchConfig(id);
        continue;
      }
      await this.processItem(record, item);
      this.refreshCounters(id);
    }
  }

  private async processItem(record: PathMigrationRecord, item: PathMigrationItemRecord) {
    const client = this.clientFactory(this.configStore.get());
    if (item.status === "copying" || item.status === "awaiting_verification") {
      try {
        await this.verifyItem(record, item);
      } catch (error) {
        await this.handleItemError(record, this.db.getPathMigrationItem(record.id, item.relativePath) || item, error);
      }
      return;
    }
    if (item.status === "reusable") {
      try {
        const stat = await client.stat(item.destinationPath);
        if (!matchesRemoteItem(item, stat)) {
          await this.handleItemError(record, item, migrationConflictError("预览后目标文件类型或大小发生变化"));
          return;
        }
        this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "verified", verificationStartedAt: 0 });
        return;
      } catch (error: any) {
        if (!isRemoteNotFoundError(error)) {
          await this.handleItemError(record, item, error);
          return;
        }
        this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "pending", nextAttemptAt: 0, verificationStartedAt: 0, lastError: undefined });
      }
    }
    if (item.status === "failed") {
      try {
        const stat = await client.stat(item.destinationPath);
        if (!matchesRemoteItem(item, stat)) {
          await this.handleItemError(record, item, migrationConflictError("失败重试前发现目标文件类型或大小冲突"));
          return;
        }
        this.db.updatePathMigrationItem(record.id, item.relativePath, {
          status: "verified",
          nextAttemptAt: 0,
          verificationStartedAt: 0,
          lastError: undefined,
        });
        return;
      } catch (error) {
        if (!isRemoteNotFoundError(error)) {
          await this.handleItemError(record, item, error);
          return;
        }
        this.db.updatePathMigrationItem(record.id, item.relativePath, {
          status: "pending",
          nextAttemptAt: 0,
          verificationStartedAt: 0,
          lastError: undefined,
        });
      }
    }
    try {
      const verificationStartedAt = this.now();
      if (item.itemType === "directory") {
        await this.ensureDirectory(client, item.destinationPath);
        this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "awaiting_verification", verificationStartedAt });
      } else {
        this.db.updatePathMigrationItem(record.id, item.relativePath, {
          status: "copying",
          attempts: item.attempts + 1,
          verificationStartedAt,
        });
        await this.ensureDirectory(client, item.destinationPath.slice(0, item.destinationPath.lastIndexOf("/")) || "/");
        await client.copyFile(item.sourcePath, item.destinationPath, { overwrite: false });
        this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "awaiting_verification" });
      }
      await this.verifyItem(record, this.db.getPathMigrationItem(record.id, item.relativePath)!);
    } catch (error: any) {
      await this.handleItemError(record, this.db.getPathMigrationItem(record.id, item.relativePath) || item, error);
    }
  }

  private async ensureDirectory(client: PathMigrationDavClient, directory: string) {
    const segments = normalizeRoot(directory).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      if (this.ensuredDirectories.has(current)) continue;
      let stat: any;
      try {
        stat = await client.stat(current);
      } catch (error) {
        if (!isRemoteNotFoundError(error)) throw error;
        try {
          await client.createDirectory(current);
          stat = await client.stat(current);
        } catch (createError) {
          if (![405, 409].includes(statusCode(createError))) throw createError;
          stat = await client.stat(current);
        }
      }
      if (entryType(stat) !== "directory") throw migrationConflictError("目标目录路径被文件占用");
      this.ensuredDirectories.add(current);
    }
  }

  private async verifyItem(record: PathMigrationRecord, item: PathMigrationItemRecord) {
    const client = this.clientFactory(this.configStore.get());
    let stat: any;
    try { stat = await client.stat(item.destinationPath); } catch (error) {
      if (isRemoteNotFoundError(error)) {
        const startedAt = item.verificationStartedAt || item.updatedAt || this.now();
        const elapsed = this.now() - startedAt;
        if (elapsed > VERIFY_WINDOW_MS) {
          const message = "COPY后24小时仍未在目标路径可见";
          this.db.updatePathMigrationItem(record.id, item.relativePath, {
            status: "failed",
            nextAttemptAt: 0,
            lastError: message,
          });
          this.db.updatePathMigration(record.id, { status: "paused", lastError: message });
          return;
        }
        const attempts = item.attempts + 1;
        const delay = Math.min(10 * 60_000, 1_000 * (2 ** Math.min(attempts, 10)));
        this.db.updatePathMigrationItem(record.id, item.relativePath, {
          status: "awaiting_verification",
          attempts,
          nextAttemptAt: this.now() + delay,
          verificationStartedAt: startedAt,
          lastError: "目标暂未可见",
        });
        return;
      }
      throw error;
    }
    const sameType = entryType(stat) === item.itemType;
    const sameSize = item.itemType === "directory" || Number(stat?.size) === Number(item.expectedSize);
    if (!sameType || !sameSize) {
      await this.handleItemError(record, item, migrationConflictError("目标类型或大小与源文件不一致"));
      return;
    }
    this.db.updatePathMigrationItem(record.id, item.relativePath, {
      status: "verified",
      nextAttemptAt: 0,
      verificationStartedAt: 0,
      lastError: undefined,
    });
  }

  private async handleItemError(record: PathMigrationRecord, item: PathMigrationItemRecord, error: any) {
    const status = statusCode(error);
    const message = safeErrorSummary(error);
    if (isImmediateStopError(error) || !isTransientError(error)) {
      this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "conflict", lastError: message, nextAttemptAt: 0 });
      this.db.updatePathMigration(record.id, { status: "paused", lastError: message });
      return;
    }
    const attempts = item.attempts + 1;
    if (attempts >= 10) {
      this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "failed", attempts, lastError: message, nextAttemptAt: 0 });
      this.db.updatePathMigration(record.id, { status: "paused", lastError: message });
      return;
    }
    const delay = Math.min(60 * 60_000, 60_000 * (2 ** Math.min(attempts - 1, 6)));
    this.db.updatePathMigrationItem(record.id, item.relativePath, { status: "failed", attempts, lastError: message, nextAttemptAt: this.now() + delay });
    if (status >= 500 || status === 0) this.db.updatePathMigration(record.id, { lastError: message });
  }

  private refreshCounters(id: string) {
    const counts = this.db.countPathMigrationItems(id);
    const record = this.db.getPathMigration(id);
    if (!record) return;
    this.db.updatePathMigration(id, {
      reusableCount: Number(counts.reusable?.count || 0),
      copiedCount: Number(counts.verified?.count || 0),
      verifiedCount: Number(counts.verified?.count || 0) + Number(counts.reusable?.count || 0),
      conflictCount: Number(counts.conflict?.count || 0),
    });
  }

  private async switchConfig(id: string) {
    const record = this.db.getPathMigration(id);
    if (!record) return;
    const counts = this.db.countPathMigrationItems(id);
    if (Number(counts.conflict?.count || 0) > 0 || Number(counts.failed?.count || 0) > 0) {
      this.db.updatePathMigration(id, { status: "paused", lastError: "仍有未确认的冲突或失败项目" });
      return;
    }
    this.db.updatePathMigration(id, { status: "switching", lastError: undefined });
    const previous = this.configStore.get();
    try {
      this.db.rewriteArchiveRoot(id, record.sourceRoot, record.destinationRoot);
      const next = this.configStore.update({ alistDest: record.destinationRoot });
      this.onConfigSwitched(previous, next);
      this.db.updatePathMigration(id, { status: "cleanup_pending", switchedAt: this.now(), lastError: undefined });
      const migrationJob = this.jobStore.findByDedupeKey(`path-migration:${id}`);
      if (migrationJob) this.jobStore.complete(migrationJob.id);
      this.setMaintenance(false);
    } catch (error) {
      this.db.updatePathMigration(id, { status: "switching", lastError: safeErrorSummary(error) });
      throw error;
    }
  }

  pause(id?: string) {
    const record = this.db.getPathMigration(id || this.latestMigrationId());
    if (!record || !["copying", "verifying"].includes(record.status)) throw new Error("当前迁移不能暂停");
    this.db.updatePathMigration(record.id, { status: "paused" });
    return this.getState();
  }

  resume(id?: string) {
    const record = this.db.getPathMigration(id || this.latestMigrationId());
    if (!record || record.status !== "paused") throw new Error("当前迁移不能继续");
    this.db.updatePathMigration(record.id, { status: "copying", lastError: undefined });
    this.setMaintenance(true, pathSummary(this.db.getPathMigration(record.id)!));
    this.startWorker(record.id);
    return this.getState();
  }

  cancel(id?: string) {
    const record = this.db.getPathMigration(id || this.latestMigrationId());
    if (!record || ["switching", "cleanup_pending", "completed", "cancelled"].includes(record.status)) throw new Error("切换后不能取消迁移");
    this.db.updatePathMigration(record.id, { status: "cancelled" });
    const migrationJob = this.jobStore.findByDedupeKey(`path-migration:${record.id}`);
    if (migrationJob) this.jobStore.complete(migrationJob.id);
    this.setMaintenance(false);
    return this.getState();
  }

  async cleanupOld(id?: string, keepOld = false) {
    const record = this.db.getPathMigration(id || this.latestMigrationId());
    if (!record || record.status !== "cleanup_pending") throw new Error("只有切换完成的迁移才能处理旧目录");
    if (keepOld) {
      this.db.updatePathMigration(record.id, { status: "completed", lastError: "旧归档目录按用户选择保留" });
      return this.getState();
    }
    const config = this.configStore.get();
    const client = this.clientFactory(config);
    const currentManifest = await this.computeManifest(client, record.sourceRoot, record.id);
    if (currentManifest !== record.sourceManifestHash) throw new Error("旧目录已发生变化，已拒绝删除");
    const counts = this.db.countPathMigrationItems(record.id);
    if (Number(counts.verified?.count || 0) + Number(counts.reusable?.count || 0) !== record.entryCount) {
      throw new Error("目标目录仍未完成全部确认，已拒绝删除旧目录");
    }
    for (let offset = 0; offset < record.entryCount; offset += 1000) {
      const page = this.db.listPathMigrationItems(record.id, [], offset, 1000);
      for (const item of page) {
        const stat = await client.stat(item.destinationPath);
        if (entryType(stat) !== item.itemType || (item.itemType === "file" && Number(stat?.size) !== Number(item.expectedSize))) {
          throw new Error(`目标文件复核失败: ${item.relativePath}`);
        }
      }
      if (page.length < 1000) break;
    }
    try { await client.deleteFile(record.sourceRoot); } catch (error) {
      if (!isRemoteNotFoundError(error)) throw error;
    }
    try { await client.stat(record.sourceRoot); } catch (error) {
      if (isRemoteNotFoundError(error)) {
        this.db.updatePathMigration(record.id, { status: "completed", lastError: undefined });
        return this.getState();
      }
      throw error;
    }
    throw new Error("旧归档目录删除后仍可见，未标记完成");
  }

  async resumePersisted() {
    const record = this.db.getActivePathMigration();
    if (!record) return;
    if (record.status === "scanning") {
      try { await this.runPreview(record.id); } catch (error) { this.db.updatePathMigration(record.id, { status: "failed", lastError: safeErrorSummary(error) }); }
      return;
    }
    if (["copying", "verifying", "paused", "switching"].includes(record.status)) {
      this.setMaintenance(true, pathSummary(record));
      if (record.status !== "paused") this.startWorker(record.id);
    }
  }

  stop() {
    this.stopped = true;
    this.ensuredDirectories.clear();
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    try {
      if (this.db.db.open) this.jobStore.releaseOwner(this.leaseOwner);
    } catch {
      // The state database may already have been replaced during shutdown/import.
    }
    this.setMaintenance(false);
  }
}
