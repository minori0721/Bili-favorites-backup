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
import { type RemoteFileQualityProfile, type RemoteFileRecord } from "./state.js";
import { captureUploadResponseBody, classifyUploadError, sanitizeUploadText, UploadOperationError } from "./upload-health.js";

export function buildDavClient(config: AppConfig): WebDAVClient {
  const davUrl = config.alistUrl.replace(/\/$/, "") + "/dav";
  return createClient(davUrl, {
    username: config.alistUsername,
    password: config.alistPassword,
  });
}

export async function ensureRemoteDir(client: WebDAVClient, remotePath: string) {
  const segments = remotePath.split('/').filter(s => s.length > 0);
  let currentPath = '';
  for (const segment of segments) {
    currentPath += '/' + segment;
    if (await client.exists(currentPath) === false) {
      try {
        await client.createDirectory(currentPath);
      } catch (error) {
        try {
          if (await client.exists(currentPath)) {
            continue;
          }
        } catch (checkError) {
          throw checkError;
        }
        throw error;
      }
    }
  }
}

export interface UploadResult {
  remotePath: string;
  files: RemoteFileRecord[];
}

function buildRemoteFileQualityProfile(config: AppConfig): RemoteFileQualityProfile {
  return {
    quality: String(config.bbdownQuality || ""),
    encoding: String(config.bbdownEncoding || ""),
    hiRes: Boolean(config.bbdownHiRes),
    dolby: Boolean(config.bbdownDolby),
  };
}

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".flv": "video/x-flv",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".ass": "text/x-ssa",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

export function detectUploadMimeType(filePath: string) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function buildUploadHeaders(filePath: string, stat: fs.Stats) {
  const modifiedSeconds = Math.max(0, Math.floor(stat.mtimeMs / 1000));
  return {
    "Content-Length": String(stat.size),
    "Content-Type": detectUploadMimeType(filePath),
    "X-OC-Mtime": String(modifiedSeconds),
    "X-OC-Ctime": String(modifiedSeconds),
  };
}

async function toUploadOperationError(error: unknown, remotePath: string) {
  await captureUploadResponseBody(error);
  return error instanceof UploadOperationError
    ? error
    : new UploadOperationError(classifyUploadError(error, remotePath));
}

export async function verifyUploadedFile(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number,
  delaysMs: number[] = [0, 500, 1500]
) {
  let lastSize: number | undefined;
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const remoteStat = await client.stat(remoteFile) as any;
      lastSize = Number(remoteStat?.size);
      if (Number.isFinite(lastSize) && lastSize === expectedSize) {
        return;
      }
      lastError = new Error(`Remote size mismatch: expected ${expectedSize}, received ${Number.isFinite(lastSize) ? lastSize : "unknown"}`);
    } catch (error) {
      lastError = error;
    }
  }
  const verificationError: any = new Error(
    `Remote upload verification failed for ${remoteFile}: ${(lastError as Error)?.message || "file not visible"}`
  );
  verificationError.status = 409;
  throw new UploadOperationError(classifyUploadError(verificationError, remoteFile));
}

export async function uploadWithAList(
  localDir: string,
  remotePath: string,
  config: AppConfig,
  options: {
    cleanupLocal?: boolean;
    client?: WebDAVClient;
    verificationDelaysMs?: number[];
    log?: Pick<typeof logManager, "push">;
  } = {}
): Promise<UploadResult> {
  const client = options.client || buildDavClient(config);
  const logger = options.log || logManager;
  const uploadedFiles: RemoteFileRecord[] = [];
  const qualityProfile = buildRemoteFileQualityProfile(config);

  try {
    await ensureRemoteDir(client, remotePath);
  } catch (error) {
    throw await toUploadOperationError(error, remotePath);
  }

  const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const localFile = path.join(localDir, entry.name);
      // Join using posix style for webdav
      const remoteFile = remotePath.replace(/\/$/, "") + "/" + entry.name;
      
      const stat = await fs.promises.stat(localFile);
      if (!stat.isFile() || stat.size <= 0) {
        const localError: any = new Error(`Local upload file is empty or invalid: ${localFile}`);
        localError.status = 422;
        throw new UploadOperationError(classifyUploadError(localError, remoteFile));
      }
      const fileStream = fs.createReadStream(localFile);
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`[AList] Uploading ${entry.name} to ${remoteFile} (${stat.size} bytes)`);
      
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: `正在上传: ${entry.name} (${sizeKB} KB) → ${remotePath}`,
        raw: `[AList] Uploading ${entry.name} to ${remoteFile} (${stat.size} bytes)`,
        simpleVisible: true,
      });
      
      try {
        await client.putFileContents(remoteFile, fileStream as any, {
          contentLength: false,
          overwrite: true,
          headers: buildUploadHeaders(localFile, stat),
        });
        await verifyUploadedFile(client, remoteFile, stat.size, options.verificationDelaysMs);
        logger.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "info",
          summary: `上传完成: ${entry.name}`,
          raw: `[AList] Upload completed for ${entry.name}`,
          simpleVisible: true,
        });
      } catch (error) {
        const uploadError = await toUploadOperationError(error, remoteFile);
        const info = uploadError.uploadFailure;
        console.error(`[AList] Upload failed status=${info.status || "unknown"} category=${info.category} path=${remoteFile}: ${info.summary}`);
        logger.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "error",
          summary: `上传失败: ${entry.name} - ${info.summary}`,
          raw: `[AList] Failed status=${info.status || "unknown"} category=${info.category} retryable=${info.retryable} path=${remoteFile}: ${info.summary}`,
          simpleVisible: true,
        });
        throw uploadError;
      } finally {
        fileStream.destroy();
      }

      uploadedFiles.push({
        name: entry.name,
        path: remoteFile,
        size: stat.size,
        qualityProfile,
      });
    }
  }

  if (uploadedFiles.length === 0) {
    const emptyError: any = new Error(`Local upload directory contains no files: ${localDir}`);
    emptyError.status = 422;
    throw new UploadOperationError(classifyUploadError(emptyError, remotePath));
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
      const remoteStat = await client.stat(file.path) as any;
      const remoteSize = Number(remoteStat?.size);
      if (typeof file.size === "number" && (!Number.isFinite(remoteSize) || remoteSize !== file.size)) {
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
      const safeError = sanitizeUploadText((err as Error)?.message || err);
      const msg = `${oldName}: ${safeError}`;
      errors.push(msg);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `重命名失败: ${msg}`,
        raw: `[Rename] Failed: ${oldPath} -> ${newPath}: ${safeError}`,
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

export async function moveRemoteFile(config: AppConfig, oldPath: string, newPath: string) {
  const client = buildDavClient(config);
  const targetPath = normalizeRemotePath(newPath);
  await ensureRemoteDir(client, remoteDirname(targetPath));
  await client.moveFile(normalizeRemotePath(oldPath), targetPath, { overwrite: false });
}

export function isRemoteNotFoundError(error: any) {
  const status = error?.status || error?.response?.status || error?.statusCode;
  const message = String(error?.message || error || "").toLowerCase();
  return status === 404 || message.includes("not found") || message.includes("enoent");
}

export async function deleteRemoteFiles(
  config: AppConfig,
  files: RemoteFileRecord[]
): Promise<{ success: number; failed: number; results: Array<{ path: string; ok: boolean; error?: string }> }> {
  const client = buildDavClient(config);
  let success = 0;
  let failed = 0;
  const results: Array<{ path: string; ok: boolean; error?: string }> = [];

  for (const file of files) {
    const targetPath = normalizeRemotePath(file.path);
    try {
      await client.deleteFile(targetPath);
      success++;
      results.push({ path: targetPath, ok: true });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `删除旧远端文件: ${remoteBasename(targetPath)}`,
        raw: `[Delete] ${targetPath}`,
        simpleVisible: true,
      });
    } catch (error: any) {
      if (isRemoteNotFoundError(error)) {
        success++;
        results.push({ path: targetPath, ok: true });
        continue;
      }
      failed++;
      const message = error?.message || String(error);
      results.push({ path: targetPath, ok: false, error: message });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `删除旧远端文件失败: ${remoteBasename(targetPath)} - ${message}`,
        raw: `[Delete] Failed: ${targetPath}: ${message}`,
        simpleVisible: true,
      });
    }
  }

  return { success, failed, results };
}
