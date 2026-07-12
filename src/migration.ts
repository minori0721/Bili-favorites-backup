import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { appRoot, backupsDir, coversDir, dataDir, databasePath, exportsDir, tempDir } from "./paths.js";
import { logsPath } from "./logger.js";
import { readJsonFile } from "./storage.js";
import { createZipFromDirectory, createZipFromSources, extractZipFile } from "./zip.js";
import { StateDatabase } from "./database.js";
import { safeErrorSummary } from "./diagnostics.js";

const exportSchema = 3;
const appName = "Bili-favorites-backup";
export class MigrationConflictError extends Error { statusCode = 409; }
const allowedImportFiles = new Set([
  "data/config.json",
  "data/users.json",
  "data/state.json",
  "data/bfb.sqlite",
  "data/logs.json",
]);

export interface MigrationStateAccess {
  getStateSnapshot(): any;
  backupDatabase(destination: string): Promise<void>;
  replaceDatabaseFile(source: string): Promise<void>;
  replaceStateSnapshot(state: any): void;
  getMigrationPendingUploadCount?(): number;
}

export interface MigrationExportOptions {
  mode?: "lightweight" | "complete";
  includeConfig?: boolean;
  includeUsers?: boolean;
  includeState?: boolean;
  includeLogs?: boolean;
  includeDebug?: boolean;
  includeCovers?: boolean;
}

export interface MigrationManifest {
  schema: number;
  app: string;
  version: string;
  exportedAt: string;
  mode: "lightweight" | "complete";
  includes: Required<MigrationExportOptions>;
  counts: {
    users: number;
    videos: number;
    relations: number;
    unavailableVideos: number;
  };
  warning: string;
  archive?: { files: number; expandedBytes: number };
}

export interface UnavailableVideoIndex {
  schema: number;
  generatedAt: string;
  count: number;
  items: Array<{
    bvid: string;
    title: string;
    upperName: string;
    cover?: string;
    coverLocalPath?: string;
    backupStatus?: string;
    remotePath?: string;
    remoteFiles?: Array<{ name: string; path: string; size?: number }>;
    folderTitle?: string;
    mediaId?: number;
    lastSeenAt?: string;
  }>;
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeExportOptions(options: MigrationExportOptions = {}): Required<MigrationExportOptions> {
  return {
    mode: options.mode === "complete" ? "complete" : "lightweight",
    includeConfig: options.includeConfig !== false,
    includeUsers: options.includeUsers !== false,
    includeState: options.includeState !== false,
    includeLogs: Boolean(options.includeLogs),
    includeDebug: Boolean(options.includeDebug),
    includeCovers: options.includeCovers !== false,
  };
}

function packageVersion() {
  try {
    const pkg = readJsonFile<{ version?: string }>(path.join(appRoot, "package.json"), {});
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

async function pathExists(targetPath: string) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source: string, target: string) {
  if (!(await pathExists(source))) return false;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target);
  return true;
}

async function copyDirIfExists(source: string, target: string) {
  if (!(await pathExists(source))) return false;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.cp(source, target, { recursive: true });
  return true;
}

async function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function videoDisplayTitle(video: any) {
  return String(video?.originalMeta?.title || video?.title || video?.bvid || "");
}

function videoDisplayUpperName(video: any) {
  return String(video?.originalMeta?.upperName || video?.upperName || "Unknown");
}

function videoDisplayCover(video: any) {
  return video?.originalMeta?.cover || video?.cover;
}

function buildUnavailableIndex(state: any): UnavailableVideoIndex {
  const videos = state?.videos && typeof state.videos === "object" ? state.videos : {};
  const relations = state?.relations && typeof state.relations === "object" ? Object.values<any>(state.relations) : [];
  const byBvid = new Map<string, any[]>();
  for (const relation of relations) {
    if (!relation?.bvid) continue;
    const list = byBvid.get(relation.bvid) || [];
    list.push(relation);
    byBvid.set(relation.bvid, list);
  }
  const items = Object.values<any>(videos)
    .filter((video) => video?.biliStatus === "unavailable")
    .map((video) => {
      const relation = byBvid.get(video.bvid)?.[0];
      return {
        bvid: String(video.bvid || ""),
        title: videoDisplayTitle(video),
        upperName: videoDisplayUpperName(video),
        cover: videoDisplayCover(video),
        coverLocalPath: video?.originalMeta?.coverLocalPath,
        backupStatus: relation?.backupStatus || video.backupStatus,
        remotePath: relation?.remotePath || video.remotePath,
        remoteFiles: relation?.remoteFiles || video.remoteFiles,
        folderTitle: relation?.folderTitle,
        mediaId: relation?.mediaId,
        lastSeenAt: relation?.lastSeenAt || video.lastSeenAt,
      };
    });
  return {
    schema: exportSchema,
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

function buildCounts(state: any, users: any[]) {
  const videos = state?.videos && typeof state.videos === "object" ? Object.values<any>(state.videos) : [];
  const relations = state?.relations && typeof state.relations === "object" ? Object.values<any>(state.relations) : [];
  return {
    users: Array.isArray(users) ? users.length : 0,
    videos: videos.length,
    relations: relations.length,
    unavailableVideos: videos.filter((video) => video?.biliStatus === "unavailable").length,
  };
}

async function rmWithRetry(targetPath: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`[Migration] Failed to cleanup temp path ${targetPath}: ${safeErrorSummary(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function makeMigrationTempDir(prefix: string) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createMigrationExport(options: MigrationExportOptions = {}, stateAccess?: MigrationStateAccess) {
  const includes = normalizeExportOptions(options);
  await fs.promises.mkdir(exportsDir, { recursive: true });

  const stamp = safeStamp();
  const staging = await makeMigrationTempDir("bfb-migration-export-");
  const outputPath = path.join(exportsDir, `bili-favorites-backup-export-${stamp}.zip`);
  try {
    const usersPath = path.join(dataDir, "users.json");
    const state = stateAccess?.getStateSnapshot() || { videos: {}, relations: {} };
    const users = readJsonFile<any[]>(usersPath, []);

    if (includes.includeConfig) await copyIfExists(path.join(dataDir, "config.json"), path.join(staging, "data", "config.json"));
    if (includes.includeUsers) await copyIfExists(usersPath, path.join(staging, "data", "users.json"));
    if (includes.includeState) {
      await fs.promises.mkdir(path.join(staging, "data"), { recursive: true });
      if (stateAccess) {
        await stateAccess.backupDatabase(path.join(staging, "data", "bfb.sqlite"));
      } else {
        await copyIfExists(databasePath, path.join(staging, "data", "bfb.sqlite"));
      }
      await fs.promises.rm(path.join(staging, "data", "bfb.sqlite-wal"), { force: true });
      await fs.promises.rm(path.join(staging, "data", "bfb.sqlite-shm"), { force: true });
      await fs.promises.writeFile(path.join(staging, "data", "state.json"), JSON.stringify(state, null, 2), "utf8");
    }
    if (includes.includeLogs) await copyIfExists(logsPath, path.join(staging, "data", "logs.json"));
    if (includes.includeDebug) await copyDirIfExists(path.join(dataDir, "debug"), path.join(staging, "data", "debug"));
    if (includes.includeCovers) await copyDirIfExists(coversDir, path.join(staging, "data", "covers"));

    const unavailableIndex = buildUnavailableIndex(state);
    await fs.promises.mkdir(path.join(staging, "indexes"), { recursive: true });
    await fs.promises.writeFile(
      path.join(staging, "indexes", "unavailable-videos.json"),
      JSON.stringify(unavailableIndex, null, 2),
      "utf8"
    );

    const stagingFiles = await listFilesRecursive(staging);
    let expandedBytes = 0;
    const checksums: Record<string, { size: number; sha256: string }> = {};
    for (const relative of stagingFiles) {
      const fullPath = path.join(staging, relative);
      const size = (await fs.promises.stat(fullPath)).size;
      expandedBytes += size;
      checksums[relative] = { size, sha256: await sha256File(fullPath) };
    }
    let tempFiles: string[] = [];
    if (includes.mode === "complete" && await pathExists(tempDir)) {
      tempFiles = await listFilesRecursive(tempDir);
      for (const relative of tempFiles) {
        const fullPath = path.join(tempDir, relative);
        const size = (await fs.promises.stat(fullPath)).size;
        expandedBytes += size;
        checksums[`temp/${relative}`] = { size, sha256: await sha256File(fullPath) };
      }
    }
    await fs.promises.writeFile(path.join(staging, "checksums.json"), JSON.stringify(checksums), "utf8");
    const manifest: MigrationManifest = {
      schema: exportSchema,
      app: appName,
      version: packageVersion(),
      exportedAt: new Date().toISOString(),
      mode: includes.mode,
      includes,
      counts: buildCounts(state, users),
      warning: "users.json contains Bilibili login cookies if included. Do not share this package.",
      archive: { files: stagingFiles.length + tempFiles.length + 2, expandedBytes },
    };
    await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await createZipFromSources([
      { root: staging, prefix: false },
      ...(includes.mode === "complete" ? [{ root: tempDir, prefix: "temp" }] : []),
    ], outputPath);
    return { outputPath, manifest };
  } finally {
    await rmWithRetry(staging);
  }
}

async function listFilesRecursive(root: string) {
  const files: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      files.push(relative);
    }
  }
  await walk(root);
  return files;
}

export async function estimateMigrationExport(options: MigrationExportOptions = {}, stateAccess?: MigrationStateAccess) {
  const includes = normalizeExportOptions(options);
  const roots: string[] = [];
  if (includes.includeConfig) roots.push(path.join(dataDir, "config.json"));
  if (includes.includeUsers) roots.push(path.join(dataDir, "users.json"));
  if (includes.includeState) roots.push(databasePath);
  if (includes.includeLogs) roots.push(logsPath);
  if (includes.includeDebug) roots.push(path.join(dataDir, "debug"));
  if (includes.includeCovers) roots.push(coversDir);
  if (includes.mode === "complete") roots.push(tempDir);
  let files = 0;
  let expandedBytes = 0;
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const stat = await fs.promises.stat(root);
    if (stat.isFile()) {
      files += 1;
      expandedBytes += stat.size;
      continue;
    }
    for (const relative of await listFilesRecursive(root)) {
      files += 1;
      expandedBytes += (await fs.promises.stat(path.join(root, relative))).size;
    }
  }
  const recovery = includes.mode === "complete"
    ? (await import("./download-session.js")).inspectDownloadRecoverySync(tempDir)
    : undefined;
  return {
    mode: includes.mode,
    files,
    expandedBytes,
    resumableItems: recovery?.resumableSessions || 0,
    retainedBytes: recovery?.retainedBytes || 0,
    pendingUploadItems: stateAccess?.getMigrationPendingUploadCount?.() || 0,
  };
}

function safeImportFile(relativePath: string) {
  if (allowedImportFiles.has(relativePath)) return true;
  if (relativePath.startsWith("data/covers/") && !relativePath.includes("..")) return true;
  if (relativePath.startsWith("data/debug/") && !relativePath.includes("..")) return true;
  if (relativePath.startsWith("temp/") && !relativePath.includes("..")) return true;
  return false;
}

async function validateExtractedMigration(root: string, extractedFiles?: string[], extractedHashes?: Record<string, string>) {
  const files = extractedFiles || await listFilesRecursive(root);
  if (files.some((file) => file.includes("..") || path.isAbsolute(file))) throw new Error("导入包包含不安全路径");
  const manifestPath = path.join(root, "manifest.json");
  if (!(await pathExists(manifestPath))) throw new Error("导入包缺少 manifest.json");
  const manifest = readJsonFile<MigrationManifest>(manifestPath, {} as MigrationManifest);
  if (manifest.app !== appName || ![1, 2, exportSchema].includes(Number(manifest.schema))) {
    throw new Error("导入包不是当前项目支持的数据包");
  }
  if (!manifest.mode) manifest.mode = "lightweight";
  const unsafe = files.filter((file) => file !== "manifest.json" && file !== "checksums.json" && !file.startsWith("indexes/") && !safeImportFile(file));
  if (unsafe.length > 0) throw new Error(`导入包包含不支持的文件：${unsafe.slice(0, 3).join(", ")}`);
  if (Number(manifest.schema) >= 3) {
    const checksums = readJsonFile<Record<string, { size: number; sha256: string }>>(path.join(root, "checksums.json"), {});
    if (Object.keys(checksums).length === 0) throw new Error("schema 3迁移包缺少文件校验清单");
    const businessFiles = files.filter((name) => name !== "manifest.json" && name !== "checksums.json").sort();
    const listedFiles = Object.keys(checksums).sort();
    if (businessFiles.length !== listedFiles.length || businessFiles.some((name, index) => name !== listedFiles[index])) {
      throw new Error("schema 3迁移包文件与校验清单不一致");
    }
    for (const [name, expected] of Object.entries(checksums)) {
      if (!files.includes(name)) throw new Error(`迁移包缺少文件：${name}`);
      const actualHash = extractedHashes?.[name] || await sha256File(path.join(root, name));
      const actualSize = (await fs.promises.stat(path.join(root, name))).size;
      if (actualSize !== Number(expected.size) || actualHash !== expected.sha256) throw new Error(`迁移文件校验失败：${name}`);
    }
  }
  return { files, manifest };
}

export async function extractMigrationPackageFile(archivePath: string) {
  const root = await makeMigrationTempDir("bfb-migration-import-");
  const extractDir = path.join(root, "extract");
  await fs.promises.mkdir(extractDir, { recursive: true });
  try {
    const extracted = await extractZipFile(archivePath, extractDir);
    const validated = await validateExtractedMigration(extractDir, extracted.files, extracted.sha256);
    return { root, extractDir, ...validated, expandedBytes: extracted.expandedBytes };
  } catch (error) {
    await rmWithRetry(root);
    throw error;
  }
}

export async function previewMigrationPackageFile(archivePath: string) {
  const extracted = await extractMigrationPackageFile(archivePath);
  try {
    const sqlitePath = path.join(extracted.extractDir, "data", "bfb.sqlite");
    if (await pathExists(sqlitePath)) {
      const database = new StateDatabase(sqlitePath);
      try { database.integrityCheck(); } finally { database.close(); }
    }
    const tempConflicts = extracted.manifest.mode === "complete"
      ? await fs.promises.readdir(tempDir).catch(() => [])
      : [];
    return {
      manifest: extracted.manifest,
      files: extracted.files,
      expandedBytes: extracted.expandedBytes,
      conflicts: { tempItems: tempConflicts.slice(0, 20), tempItemCount: tempConflicts.length },
    };
  } finally {
    await rmWithRetry(extracted.root);
  }
}

export async function backupCurrentData(stateAccess?: MigrationStateAccess) {
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const staging = await makeMigrationTempDir("bfb-migration-current-");
  const outputPath = path.join(backupsDir, `before-import-${safeStamp()}.zip`);
  try {
    await copyIfExists(path.join(dataDir, "config.json"), path.join(staging, "data", "config.json"));
    await copyIfExists(path.join(dataDir, "users.json"), path.join(staging, "data", "users.json"));
    const state = stateAccess?.getStateSnapshot() || { videos: {}, relations: {} };
    await fs.promises.mkdir(path.join(staging, "data"), { recursive: true });
    if (stateAccess) await stateAccess.backupDatabase(path.join(staging, "data", "bfb.sqlite"));
    else await copyIfExists(databasePath, path.join(staging, "data", "bfb.sqlite"));
    await fs.promises.rm(path.join(staging, "data", "bfb.sqlite-wal"), { force: true });
    await fs.promises.rm(path.join(staging, "data", "bfb.sqlite-shm"), { force: true });
    await fs.promises.writeFile(path.join(staging, "data", "state.json"), JSON.stringify(state, null, 2), "utf8");
    await copyIfExists(logsPath, path.join(staging, "data", "logs.json"));
    await copyDirIfExists(coversDir, path.join(staging, "data", "covers"));
    await copyDirIfExists(path.join(dataDir, "debug"), path.join(staging, "data", "debug"));
    const manifest: MigrationManifest = {
      schema: exportSchema,
      app: appName,
      version: packageVersion(),
      exportedAt: new Date().toISOString(),
      mode: "lightweight",
      includes: {
        mode: "lightweight",
        includeConfig: true,
        includeUsers: true,
        includeState: true,
        includeLogs: true,
        includeDebug: await pathExists(path.join(dataDir, "debug")),
        includeCovers: await pathExists(coversDir),
      },
      counts: buildCounts(
        state,
        readJsonFile<any[]>(path.join(dataDir, "users.json"), [])
      ),
      warning: "Automatic backup created before importing a migration package.",
    };
    await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await createZipFromDirectory(staging, outputPath);
    return outputPath;
  } finally {
    await rmWithRetry(staging);
  }
}

export async function applyMigrationPackageFile(archivePath: string, options: {
  restoreConfig?: boolean;
  restoreUsers?: boolean;
  restoreState?: boolean;
  restoreCovers?: boolean;
  restoreLogs?: boolean;
  restoreDebug?: boolean;
} = {}, stateAccess?: MigrationStateAccess) {
  const extracted = await extractMigrationPackageFile(archivePath);
  try {
    const complete = extracted.manifest.mode === "complete" && await pathExists(path.join(extracted.extractDir, "temp"));
    if (complete) {
      const currentTemp = await fs.promises.readdir(tempDir).catch(() => []);
      if (currentTemp.length > 0) {
        throw new MigrationConflictError(`完整迁移要求目标temp为空；当前占用：${currentTemp.slice(0, 10).join("、")}${currentTemp.length > 10 ? ` 等${currentTemp.length}项` : ""}`);
      }
    }
    const backupPath = await backupCurrentData(stateAccess);
    const operationId = crypto.randomUUID().replace(/-/g, "");
    const prepared: Array<{ name: string; target: string; staged: string; backup: string }> = [];
    const switched: typeof prepared = [];
    const prepare = async (name: string, source: string, target: string) => {
      if (!(await pathExists(source))) return false;
      const staged = `${target}.migration-${operationId}`;
      const backup = `${target}.before-migration-${operationId}`;
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.rm(staged, { recursive: true, force: true });
      await fs.promises.rm(backup, { recursive: true, force: true });
      const stat = await fs.promises.stat(source);
      if (stat.isDirectory()) await fs.promises.cp(source, staged, { recursive: true, force: false, errorOnExist: true });
      else await fs.promises.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
      prepared.push({ name, target, staged, backup });
      return true;
    };
    const restored: string[] = [];
    try {
      if (options.restoreConfig !== false) await prepare("config", path.join(extracted.extractDir, "data", "config.json"), path.join(dataDir, "config.json"));
      if (options.restoreUsers !== false) await prepare("users", path.join(extracted.extractDir, "data", "users.json"), path.join(dataDir, "users.json"));
      if (options.restoreLogs) await prepare("logs", path.join(extracted.extractDir, "data", "logs.json"), logsPath);
      if (options.restoreCovers !== false) await prepare("covers", path.join(extracted.extractDir, "data", "covers"), coversDir);
      if (options.restoreDebug) await prepare("debug", path.join(extracted.extractDir, "data", "debug"), path.join(dataDir, "debug"));
      if (complete) await prepare("temp", path.join(extracted.extractDir, "temp"), tempDir);

      for (const item of prepared) {
        if (await pathExists(item.target)) await fs.promises.rename(item.target, item.backup);
        try {
          await fs.promises.rename(item.staged, item.target);
        } catch (error) {
          if (await pathExists(item.backup)) await fs.promises.rename(item.backup, item.target);
          throw error;
        }
        switched.push(item);
        restored.push(item.name);
      }

      if (options.restoreState !== false) {
        const sqliteSource = path.join(extracted.extractDir, "data", "bfb.sqlite");
        const jsonSource = path.join(extracted.extractDir, "data", "state.json");
        if (stateAccess && await pathExists(sqliteSource)) {
          await stateAccess.replaceDatabaseFile(sqliteSource);
          restored.push("state");
        } else if (stateAccess && await pathExists(jsonSource)) {
          stateAccess.replaceStateSnapshot(readJsonFile<any>(jsonSource, { videos: {}, relations: {} }));
          restored.push("state");
        } else if (!stateAccess && await pathExists(sqliteSource)) {
          await prepare("state", sqliteSource, databasePath);
          const item = prepared[prepared.length - 1];
          if (await pathExists(item.target)) await fs.promises.rename(item.target, item.backup);
          await fs.promises.rename(item.staged, item.target);
          switched.push(item);
          restored.push("state");
        }
      }

      for (const item of switched) await rmWithRetry(item.backup);
      return { manifest: extracted.manifest, backupPath, restored };
    } catch (error) {
      for (const item of [...switched].reverse()) {
        await fs.promises.rm(item.target, { recursive: true, force: true }).catch(() => undefined);
        if (await pathExists(item.backup)) await fs.promises.rename(item.backup, item.target).catch(() => undefined);
      }
      throw error;
    } finally {
      for (const item of prepared) {
        await rmWithRetry(item.staged);
        await rmWithRetry(item.backup);
      }
    }
  } finally {
    await rmWithRetry(extracted.root);
  }
}
