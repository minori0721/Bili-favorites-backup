import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appRoot, backupsDir, coversDir, dataDir, exportsDir } from "./paths.js";
import { logsPath } from "./logger.js";
import { readJsonFile } from "./storage.js";
import { createZipFromDirectory, extractZipBuffer } from "./zip.js";

const exportSchema = 1;
const appName = "Bili-favorites-backup";
const allowedImportFiles = new Set([
  "data/config.json",
  "data/users.json",
  "data/state.json",
  "data/logs.json",
]);

export interface MigrationExportOptions {
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
  includes: Required<MigrationExportOptions>;
  counts: {
    users: number;
    videos: number;
    relations: number;
    unavailableVideos: number;
  };
  warning: string;
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
        console.warn(`[Migration] Failed to cleanup temp path ${targetPath}:`, (error as Error)?.message || error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function makeMigrationTempDir(prefix: string) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createMigrationExport(options: MigrationExportOptions = {}) {
  const includes = normalizeExportOptions(options);
  await fs.promises.mkdir(exportsDir, { recursive: true });

  const stamp = safeStamp();
  const staging = await makeMigrationTempDir("bfb-migration-export-");
  const outputPath = path.join(exportsDir, `bili-favorites-backup-export-${stamp}.zip`);
  try {
    const statePath = path.join(dataDir, "state.json");
    const usersPath = path.join(dataDir, "users.json");
    const state = readJsonFile<any>(statePath, { videos: {}, relations: {} });
    const users = readJsonFile<any[]>(usersPath, []);

    if (includes.includeConfig) await copyIfExists(path.join(dataDir, "config.json"), path.join(staging, "data", "config.json"));
    if (includes.includeUsers) await copyIfExists(usersPath, path.join(staging, "data", "users.json"));
    if (includes.includeState) await copyIfExists(statePath, path.join(staging, "data", "state.json"));
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

    const manifest: MigrationManifest = {
      schema: exportSchema,
      app: appName,
      version: packageVersion(),
      exportedAt: new Date().toISOString(),
      includes,
      counts: buildCounts(state, users),
      warning: "users.json contains Bilibili login cookies if included. Do not share this package.",
    };
    await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await createZipFromDirectory(staging, outputPath);
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

function safeImportFile(relativePath: string) {
  if (allowedImportFiles.has(relativePath)) return true;
  if (relativePath.startsWith("data/covers/") && !relativePath.includes("..")) return true;
  if (relativePath.startsWith("data/debug/") && !relativePath.includes("..")) return true;
  return false;
}

export async function extractMigrationPackage(buffer: Buffer) {
  const root = await makeMigrationTempDir("bfb-migration-import-");
  const extractDir = path.join(root, "extract");
  await fs.promises.mkdir(extractDir, { recursive: true });
  await extractZipBuffer(buffer, extractDir);
  const files = await listFilesRecursive(extractDir);
  if (files.some((file) => file.includes("..") || path.isAbsolute(file))) {
    throw new Error("导入包包含不安全路径");
  }
  const manifestPath = path.join(extractDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error("导入包缺少 manifest.json");
  }
  const manifest = readJsonFile<MigrationManifest>(manifestPath, {} as MigrationManifest);
  if (manifest.app !== appName || Number(manifest.schema) !== exportSchema) {
    throw new Error("导入包不是当前项目支持的数据包");
  }
  const unsafe = files.filter((file) => file !== "manifest.json" && !file.startsWith("indexes/") && !safeImportFile(file));
  if (unsafe.length > 0) {
    throw new Error(`导入包包含不支持的文件：${unsafe.slice(0, 3).join(", ")}`);
  }
  return { root, extractDir, files, manifest };
}

export async function previewMigrationPackage(buffer: Buffer) {
  const extracted = await extractMigrationPackage(buffer);
  try {
    return {
      manifest: extracted.manifest,
      files: extracted.files,
    };
  } finally {
    await rmWithRetry(extracted.root);
  }
}

export async function backupCurrentData() {
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const staging = await makeMigrationTempDir("bfb-migration-current-");
  const outputPath = path.join(backupsDir, `before-import-${safeStamp()}.zip`);
  try {
    await copyIfExists(path.join(dataDir, "config.json"), path.join(staging, "data", "config.json"));
    await copyIfExists(path.join(dataDir, "users.json"), path.join(staging, "data", "users.json"));
    await copyIfExists(path.join(dataDir, "state.json"), path.join(staging, "data", "state.json"));
    await copyIfExists(logsPath, path.join(staging, "data", "logs.json"));
    await copyDirIfExists(coversDir, path.join(staging, "data", "covers"));
    await copyDirIfExists(path.join(dataDir, "debug"), path.join(staging, "data", "debug"));
    const manifest: MigrationManifest = {
      schema: exportSchema,
      app: appName,
      version: packageVersion(),
      exportedAt: new Date().toISOString(),
      includes: {
        includeConfig: true,
        includeUsers: true,
        includeState: true,
        includeLogs: true,
        includeDebug: await pathExists(path.join(dataDir, "debug")),
        includeCovers: await pathExists(coversDir),
      },
      counts: buildCounts(
        readJsonFile<any>(path.join(dataDir, "state.json"), { videos: {}, relations: {} }),
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

export async function applyMigrationPackage(buffer: Buffer, options: {
  restoreConfig?: boolean;
  restoreUsers?: boolean;
  restoreState?: boolean;
  restoreCovers?: boolean;
  restoreLogs?: boolean;
  restoreDebug?: boolean;
} = {}) {
  const extracted = await extractMigrationPackage(buffer);
  const backupPath = await backupCurrentData();
  try {
    const copyFile = async (relative: string) => {
      const source = path.join(extracted.extractDir, relative);
      if (!(await pathExists(source))) return false;
      const target = path.join(dataDir, relative.replace(/^data\//, ""));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(source, target);
      return true;
    };
    const restored: string[] = [];
    if (options.restoreConfig !== false && await copyFile("data/config.json")) restored.push("config");
    if (options.restoreUsers !== false && await copyFile("data/users.json")) restored.push("users");
    if (options.restoreState !== false && await copyFile("data/state.json")) restored.push("state");
    if (options.restoreLogs && await copyFile("data/logs.json")) restored.push("logs");
    if (options.restoreCovers !== false && await pathExists(path.join(extracted.extractDir, "data", "covers"))) {
      await fs.promises.rm(coversDir, { recursive: true, force: true });
      await fs.promises.cp(path.join(extracted.extractDir, "data", "covers"), coversDir, { recursive: true });
      restored.push("covers");
    }
    if (options.restoreDebug && await pathExists(path.join(extracted.extractDir, "data", "debug"))) {
      await fs.promises.rm(path.join(dataDir, "debug"), { recursive: true, force: true });
      await fs.promises.cp(path.join(extracted.extractDir, "data", "debug"), path.join(dataDir, "debug"), { recursive: true });
      restored.push("debug");
    }
    return { manifest: extracted.manifest, backupPath, restored };
  } finally {
    await rmWithRetry(extracted.root);
  }
}
