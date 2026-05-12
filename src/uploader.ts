import { sanitizeSegment, joinRemotePath } from "./utils.js";
import { UploadLayout } from "./config.js";

export interface UploadContext {
  destination: string;
  layout: UploadLayout;
  userName: string;
  folderName: string;
}

export function resolveRemotePath(context: UploadContext) {
  const userSegment = sanitizeSegment(context.userName) || "user";
  const folderSegment = sanitizeSegment(context.folderName) || "favorites";

  switch (context.layout) {
    case "user-folder-video":
      return joinRemotePath(context.destination, userSegment, folderSegment);
    case "folder-video":
      return joinRemotePath(context.destination, folderSegment);
    case "video-only":
    default:
      return joinRemotePath(context.destination);
  }
}

import { createClient, WebDAVClient } from "webdav";
import fs from "node:fs";
import path from "node:path";
import { AppConfig } from "./config.js";
import { logManager } from "./logger.js";
import { RemoteFileRecord } from "./state.js";

function buildDavClient(config: AppConfig): WebDAVClient {
  const davUrl = config.alistUrl.replace(/\/$/, "") + "/dav";
  return createClient(davUrl, {
    username: config.alistUsername,
    password: config.alistPassword,
  });
}

async function ensureRemoteDir(client: WebDAVClient, remotePath: string) {
  const segments = remotePath.split('/').filter(s => s.length > 0);
  let currentPath = '';
  for (const segment of segments) {
    currentPath += '/' + segment;
    try {
      if (await client.exists(currentPath) === false) {
        await client.createDirectory(currentPath);
      }
    } catch (e) {
      // Ignore errors that might occur if created concurrently
    }
  }
}

export interface UploadResult {
  remotePath: string;
  files: RemoteFileRecord[];
}

export async function uploadWithAList(
  localDir: string,
  remotePath: string,
  config: AppConfig,
  options: { cleanupLocal?: boolean } = {}
): Promise<UploadResult> {
  const client = buildDavClient(config);
  const uploadedFiles: RemoteFileRecord[] = [];

  await ensureRemoteDir(client, remotePath);

  const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const localFile = path.join(localDir, entry.name);
      // Join using posix style for webdav
      const remoteFile = remotePath.replace(/\/$/, "") + "/" + entry.name;
      
      const fileStream = fs.createReadStream(localFile);
      const stat = await fs.promises.stat(localFile);
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`[AList] Uploading ${entry.name} to ${remoteFile} (${stat.size} bytes)`);
      
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: `正在上传: ${entry.name} (${sizeKB} KB) → ${remotePath}`,
        raw: `[AList] Uploading ${entry.name} to ${remoteFile} (${stat.size} bytes)`,
        simpleVisible: true,
      });
      
      let uploadSuccessful = false;
      try {
        await client.putFileContents(remoteFile, fileStream as any, {
          contentLength: false, // Don't send content length for streams to avoid issues
          onUploadProgress: (progress) => {
            // Optional: log progress
          }
        });
        uploadSuccessful = true;
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "info",
          summary: `上传完成: ${entry.name}`,
          raw: `[AList] Upload completed for ${entry.name}`,
          simpleVisible: true,
        });
      } catch (err) {
        console.error(`[AList] Failed to upload ${entry.name}`, err);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "error",
          summary: `上传失败: ${entry.name} - ${(err as Error).message}`,
          raw: `[AList] Failed to upload ${entry.name}: ${(err as Error).message}`,
          simpleVisible: true,
        });
        throw err;
      }
      
      if (uploadSuccessful) {
        uploadedFiles.push({
          name: entry.name,
          path: remoteFile,
          size: stat.size,
        });
      }
    }
  }

  if (uploadedFiles.length === 0) {
    const err = new Error(`No files were uploaded from ${localDir}`);
    (err as any).deferToNextCycle = true;
    throw err;
  }

  if (options.cleanupLocal !== false) {
    await fs.promises.rm(localDir, { recursive: true, force: true });
  }
  return { remotePath, files: uploadedFiles };
}

export async function verifyRemoteFiles(
  config: AppConfig,
  files: RemoteFileRecord[]
): Promise<{ ok: boolean; missing: string[] }> {
  if (files.length === 0) {
    return { ok: false, missing: ["<no uploaded files recorded>"] };
  }
  const client = buildDavClient(config);
  const missing: string[] = [];
  for (const file of files) {
    try {
      if ((await client.exists(file.path)) === false) {
        missing.push(file.path);
      }
    } catch {
      missing.push(file.path);
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Batch rename files on remote storage via WebDAV MOVE */
export interface RemoteListedFile {
  name: string;
  path: string;
  dir: string;
  size?: number;
}

export interface RenameRemoteItem {
  bvid?: string;
  oldPath: string;
  newPath: string;
}

export async function batchRenameRemote(
  config: AppConfig,
  remotePath: string,
  renameMap: Array<{ oldName: string; newName: string }>
): Promise<{ success: number; failed: number; errors: string[] }> {
  const client = buildDavClient(config);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const { oldName, newName } of renameMap) {
    if (oldName === newName) {
      success++;
      continue;
    }
    const oldPath = remotePath.replace(/\/$/, "") + "/" + oldName;
    const newPath = remotePath.replace(/\/$/, "") + "/" + newName;
    try {
      await client.moveFile(oldPath, newPath);
      success++;
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `重命名: ${oldName} → ${newName}`,
        raw: `[Rename] ${oldPath} -> ${newPath}`,
        simpleVisible: true,
      });
    } catch (err) {
      failed++;
      const msg = `${oldName}: ${(err as Error).message}`;
      errors.push(msg);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `重命名失败: ${msg}`,
        raw: `[Rename] Failed: ${oldPath} -> ${newPath}: ${(err as Error).message}`,
        simpleVisible: true,
      });
    }
  }

  return { success, failed, errors };
}

/** List remote directory contents */
export async function listRemoteDir(config: AppConfig, remotePath: string): Promise<string[]> {
  const client = buildDavClient(config);
  const items = await client.getDirectoryContents(remotePath) as any[];
  return items
    .filter((item: any) => item && item.type !== "directory")
    .map((item: any) => item?.basename)
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
}

function normalizeRemotePath(value: string) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.startsWith("/") ? normalized || "/" : `/${normalized}`;
}

function remoteBasename(value: string) {
  const normalized = normalizeRemotePath(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function remoteDirname(value: string) {
  const normalized = normalizeRemotePath(value);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export async function listRemoteFilesRecursive(
  config: AppConfig,
  rootPath: string,
  options: { maxDepth?: number; maxFiles?: number } = {}
): Promise<{ files: RemoteListedFile[]; skipped: Array<{ path: string; reason: string }> }> {
  const client = buildDavClient(config);
  const root = normalizeRemotePath(rootPath);
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 4));
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 2000));
  const files: RemoteListedFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const videoExt = /\.(mp4|mkv|flv|mov|m4v)$/i;
  const tempExt = /\.(part|tmp|download)$/i;

  async function walk(dir: string, depth: number) {
    if (files.length >= maxFiles) return;
    let items: any[];
    try {
      items = await client.getDirectoryContents(dir) as any[];
    } catch (error: any) {
      skipped.push({ path: dir, reason: `远端目录读取失败：${error?.message || error}` });
      return;
    }
    for (const item of items) {
      if (files.length >= maxFiles) {
        skipped.push({ path: dir, reason: `扫描数量超过上限 ${maxFiles}` });
        return;
      }
      const itemPath = normalizeRemotePath(String(item?.filename || item?.path || `${dir.replace(/\/$/, "")}/${item?.basename || ""}`));
      const name = String(item?.basename || remoteBasename(itemPath));
      if (!name) continue;
      if (item?.type === "directory") {
        if (depth >= maxDepth) {
          skipped.push({ path: itemPath, reason: `超过最大扫描深度 ${maxDepth}` });
          continue;
        }
        await walk(itemPath, depth + 1);
        continue;
      }
      if (!videoExt.test(name)) {
        skipped.push({ path: itemPath, reason: "不是支持的视频文件" });
        continue;
      }
      if (tempExt.test(name)) {
        skipped.push({ path: itemPath, reason: "临时下载文件" });
        continue;
      }
      files.push({
        name,
        path: itemPath,
        dir: remoteDirname(itemPath),
        size: Number.isFinite(Number(item?.size)) ? Number(item.size) : undefined,
      });
    }
  }

  await walk(root, 0);
  return { files, skipped };
}

export async function batchRenameRemotePaths(
  config: AppConfig,
  items: RenameRemoteItem[]
): Promise<{ success: number; failed: number; results: Array<{ oldPath: string; newPath: string; ok: boolean; error?: string }> }> {
  const client = buildDavClient(config);
  let success = 0;
  let failed = 0;
  const results: Array<{ oldPath: string; newPath: string; ok: boolean; error?: string }> = [];

  for (const item of items) {
    const oldPath = normalizeRemotePath(item.oldPath);
    const newPath = normalizeRemotePath(item.newPath);
    try {
      await client.moveFile(oldPath, newPath);
      success++;
      results.push({ oldPath, newPath, ok: true });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `重命名: ${remoteBasename(oldPath)} → ${remoteBasename(newPath)}`,
        raw: `[Rename] ${oldPath} -> ${newPath}`,
        simpleVisible: true,
      });
    } catch (error: any) {
      failed++;
      const message = error?.message || String(error);
      results.push({ oldPath, newPath, ok: false, error: message });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `重命名失败: ${remoteBasename(oldPath)} - ${message}`,
        raw: `[Rename] Failed: ${oldPath} -> ${newPath}: ${message}`,
        simpleVisible: true,
      });
    }
  }

  return { success, failed, results };
}

export async function remotePathExists(config: AppConfig, remotePath: string) {
  const client = buildDavClient(config);
  return client.exists(normalizeRemotePath(remotePath));
}
