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
  allVerified: boolean;
}

export interface RemoteConflictArchiveFile {
  name: string;
  oldPath: string;
  archivedPath: string;
  size?: number;
}

export interface RemoteConflictArchiveResult {
  remotePath: string;
  archivePath: string;
  files: RemoteConflictArchiveFile[];
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

export function hasFourByteCharacters(value: string) {
  return Array.from(value).some((character) => Buffer.byteLength(character, "utf-8") === 4);
}

function stripFourByteCharacters(value: string) {
  return Array.from(value)
    .filter((character) => Buffer.byteLength(character, "utf-8") !== 4)
    .join("");
}

export function buildCompatibilityUploadName(fileName: string, reservedNames: ReadonlySet<string> = new Set()) {
  if (!hasFourByteCharacters(fileName)) return undefined;
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  const safeStem = stripFourByteCharacters(stem) || "file";
  const safeExtension = stripFourByteCharacters(extension);
  const baseCandidate = `${safeStem}${safeExtension}`;
  if (!reservedNames.has(baseCandidate)) return baseCandidate;

  let suffix = 2;
  let candidate = `${safeStem}-compat-${suffix}${safeExtension}`;
  while (reservedNames.has(candidate)) {
    suffix += 1;
    candidate = `${safeStem}-compat-${suffix}${safeExtension}`;
  }
  return candidate;
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

async function inspectExpectedRemoteFile(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number
) {
  try {
    const remoteStat = await client.stat(remoteFile) as any;
    const remoteSize = Number(remoteStat?.size);
    if (Number.isFinite(remoteSize) && remoteSize === expectedSize) return "verified" as const;
    const mismatch: any = new Error(`Remote size conflict: expected ${expectedSize}, received ${Number.isFinite(remoteSize) ? remoteSize : "unknown"}`);
    mismatch.status = 409;
    throw mismatch;
  } catch (error) {
    if (isRemoteNotFoundError(error)) return "missing" as const;
    throw error;
  }
}

async function inspectRemoteFile(client: WebDAVClient, remoteFile: string) {
  try {
    const remoteStat = await client.stat(remoteFile) as any;
    const size = Number(remoteStat?.size);
    return {
      status: "exists" as const,
      size: Number.isFinite(size) ? size : undefined,
    };
  } catch (error) {
    if (isRemoteNotFoundError(error)) return { status: "missing" as const };
    throw error;
  }
}

interface PreparedUploadEntry {
  relativePath: string;
  name: string;
  localFile: string;
  remoteFile: string;
  stat: fs.Stats;
}

async function archiveConflictingRemoteSet(
  client: WebDAVClient,
  remotePath: string,
  archiveSegment: string,
  entries: PreparedUploadEntry[]
): Promise<RemoteConflictArchiveResult> {
  const safeSegment = sanitizeSegment(archiveSegment) || "conflict";
  const archivePath = joinRemotePath(remotePath, "_history", safeSegment);
  await ensureRemoteDir(client, archivePath);
  const files: RemoteConflictArchiveFile[] = [];

  for (const entry of entries) {
    const archivedPath = joinRemotePath(archivePath, entry.name);
    const [source, archived] = await Promise.all([
      inspectRemoteFile(client, entry.remoteFile),
      inspectRemoteFile(client, archivedPath),
    ]);

    if (archived.status === "exists") {
      if (source.status === "missing" || source.size === entry.stat.size) {
        files.push({ name: entry.name, oldPath: entry.remoteFile, archivedPath, size: archived.size });
        continue;
      }
      const collision: any = new Error(`Remote conflict archive target already exists: ${archivedPath}`);
      collision.status = 409;
      throw collision;
    }
    if (source.status === "missing") continue;

    await client.moveFile(entry.remoteFile, archivedPath, { overwrite: false });
    const sourceAfterMove = await inspectRemoteFile(client, entry.remoteFile);
    if (sourceAfterMove.status !== "missing") {
      const incompleteMove: any = new Error(`Remote conflict archive did not clear source path: ${entry.remoteFile}`);
      incompleteMove.status = 409;
      throw incompleteMove;
    }
    files.push({ name: entry.name, oldPath: entry.remoteFile, archivedPath, size: source.size });
  }

  return { remotePath, archivePath, files };
}

async function putAndVerifyLocalFile(
  client: WebDAVClient,
  localFile: string,
  remoteFile: string,
  stat: fs.Stats,
  verificationDelaysMs?: number[]
) {
  const preflight = await inspectExpectedRemoteFile(client, remoteFile, stat.size);
  if (preflight === "verified") {
    return { verificationStatus: "verified" as const, skippedUpload: true };
  }
  const fileStream = fs.createReadStream(localFile);
  try {
    await client.putFileContents(remoteFile, fileStream as any, {
      contentLength: false,
      overwrite: true,
      headers: buildUploadHeaders(localFile, stat),
    });
    try {
      await verifyUploadedFile(client, remoteFile, stat.size, verificationDelaysMs || [0]);
      return { verificationStatus: "verified" as const, skippedUpload: false };
    } catch (error) {
      if (isRemoteNotFoundError((error as any)?.cause || error)
        || isRemoteNotFoundError((error as any)?.uploadFailure?.summary || error)) {
        return { verificationStatus: "awaiting_verification" as const, skippedUpload: false };
      }
      const summary = String((error as any)?.message || error || "");
      if (/404|not found|object not found/i.test(summary)) {
        return { verificationStatus: "awaiting_verification" as const, skippedUpload: false };
      }
      throw error;
    }
  } finally {
    fileStream.destroy();
  }
}

function shouldRetryWithCompatibilityName(error: UploadOperationError, fileName: string) {
  const status = error.uploadFailure.status;
  return hasFourByteCharacters(fileName)
    && error.uploadFailure.category === "deterministic"
    && status !== undefined
    && [400, 405, 422].includes(status);
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
    files?: string[];
    conflictArchiveSegment?: string;
    onConflictArchived?: (result: RemoteConflictArchiveResult) => void | Promise<void>;
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

  const localRoot = path.resolve(localDir);
  const uploadEntries = options.files
    ? options.files.map((relativePath) => ({ relativePath, name: path.basename(relativePath) }))
    : (await fs.promises.readdir(localDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => ({ relativePath: entry.name, name: entry.name }));
  const preparedEntries: PreparedUploadEntry[] = [];
  for (const entry of uploadEntries) {
    const localFile = path.resolve(localDir, entry.relativePath);
    if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
      const localError: any = new Error(`Local upload path escapes the download directory: ${entry.relativePath}`);
      localError.status = 422;
      throw new UploadOperationError(classifyUploadError(localError, remotePath));
    }
    const remoteFile = remotePath.replace(/\/$/, "") + "/" + entry.name;
    const stat = await fs.promises.stat(localFile);
    if (!stat.isFile() || stat.size <= 0) {
      const localError: any = new Error(`Local upload file is empty or invalid: ${localFile}`);
      localError.status = 422;
      throw new UploadOperationError(classifyUploadError(localError, remoteFile));
    }
    preparedEntries.push({ ...entry, localFile, remoteFile, stat });
  }

  if (options.conflictArchiveSegment) {
    try {
      const preflight = [] as Array<Awaited<ReturnType<typeof inspectRemoteFile>>>;
      for (const entry of preparedEntries) preflight.push(await inspectRemoteFile(client, entry.remoteFile));
      const hasConflict = preflight.some((remote, index) => remote.status === "exists" && remote.size !== preparedEntries[index].stat.size);
      if (hasConflict) {
        const archived = await archiveConflictingRemoteSet(client, remotePath, options.conflictArchiveSegment, preparedEntries);
        logger.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `远端旧版已归档，共 ${archived.files.length} 个文件`,
          raw: `[AList] Archived remote conflict set ${remotePath} -> ${archived.archivePath} files=${archived.files.length}`,
          simpleVisible: true,
        });
        await options.onConflictArchived?.(archived);
      }
    } catch (error) {
      throw await toUploadOperationError(error, remotePath);
    }
  }

  const reservedRemoteNames = new Set(uploadEntries.map((entry) => entry.name));
  for (const entry of preparedEntries) {
      const localFile = entry.localFile;
      // Join using posix style for webdav
      const originalRemoteFile = entry.remoteFile;
      const stat = entry.stat;
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`[AList] Uploading ${entry.name} to ${originalRemoteFile} (${stat.size} bytes)`);
      
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: `正在上传: ${entry.name} (${sizeKB} KB) → ${remotePath}`,
        raw: `[AList] Uploading ${entry.name} to ${originalRemoteFile} (${stat.size} bytes)`,
        simpleVisible: true,
      });

      let uploadedName = entry.name;
      let uploadedRemoteFile = originalRemoteFile;
      let transferResult: Awaited<ReturnType<typeof putAndVerifyLocalFile>>;
      try {
        transferResult = await putAndVerifyLocalFile(client, localFile, originalRemoteFile, stat, options.verificationDelaysMs);
      } catch (error) {
        const uploadError = await toUploadOperationError(error, originalRemoteFile);
        const compatibilityName = shouldRetryWithCompatibilityName(uploadError, entry.name)
          ? buildCompatibilityUploadName(entry.name, reservedRemoteNames)
          : undefined;
        if (!compatibilityName) {
          const info = uploadError.uploadFailure;
          console.error(`[AList] Upload failed status=${info.status || "unknown"} category=${info.category} path=${originalRemoteFile}: ${info.summary}`);
          logger.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "error",
            summary: `上传失败: ${entry.name} - ${info.summary}`,
            raw: `[AList] Failed status=${info.status || "unknown"} category=${info.category} retryable=${info.retryable} path=${originalRemoteFile}: ${info.summary}`,
            simpleVisible: true,
          });
          throw uploadError;
        }

        uploadedName = compatibilityName;
        uploadedRemoteFile = remotePath.replace(/\/$/, "") + "/" + compatibilityName;
        console.warn(`[AList] Retrying with compatible remote name ${entry.name} -> ${compatibilityName}`);
        logger.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `文件名兼容重试: ${entry.name} → ${compatibilityName}`,
          raw: `[AList] Retrying with compatible remote name ${entry.name} -> ${compatibilityName}`,
          simpleVisible: true,
        });
        try {
          transferResult = await putAndVerifyLocalFile(client, localFile, uploadedRemoteFile, stat, options.verificationDelaysMs);
        } catch (compatibilityError) {
          const finalError = await toUploadOperationError(compatibilityError, uploadedRemoteFile);
          const info = finalError.uploadFailure;
          console.error(`[AList] Compatible-name upload failed status=${info.status || "unknown"} category=${info.category} path=${uploadedRemoteFile}: ${info.summary}`);
          logger.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "error",
            summary: `兼容文件名上传失败: ${compatibilityName} - ${info.summary}`,
            raw: `[AList] Compatible-name upload failed status=${info.status || "unknown"} category=${info.category} retryable=${info.retryable} path=${uploadedRemoteFile}: ${info.summary}`,
            simpleVisible: true,
          });
          throw finalError;
        }
      }

      reservedRemoteNames.add(uploadedName);
      const awaitingVerification = transferResult.verificationStatus === "awaiting_verification";
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: awaitingVerification
          ? `上传已接受，等待远端确认: ${entry.name}`
          : (transferResult.skippedUpload
            ? `远端文件已存在，跳过重复上传: ${entry.name}`
            : (uploadedName === entry.name ? `上传完成: ${entry.name}` : `上传完成: ${entry.name}（远端 ${uploadedName}）`)),
        raw: awaitingVerification
          ? `[AList] PUT accepted; awaiting remote visibility for ${uploadedName}`
          : `[AList] Upload verified for ${entry.name} as ${uploadedName}${transferResult.skippedUpload ? " (preflight)" : ""}`,
        simpleVisible: true,
      });

      uploadedFiles.push({
        name: uploadedName,
        path: uploadedRemoteFile,
        size: stat.size,
        qualityProfile,
        localRelativePath: entry.relativePath,
        verificationStatus: transferResult.verificationStatus,
        putCompletedAt: transferResult.skippedUpload ? undefined : new Date().toISOString(),
        verifyAttempts: transferResult.verificationStatus === "verified" ? 1 : 0,
        nextVerifyAt: transferResult.verificationStatus === "awaiting_verification"
          ? new Date(Date.now() + 2_000).toISOString()
          : undefined,
      });
  }

  if (uploadedFiles.length === 0) {
    const emptyError: any = new Error(`Local upload directory contains no files: ${localDir}`);
    emptyError.status = 422;
    throw new UploadOperationError(classifyUploadError(emptyError, remotePath));
  }

  const allVerified = uploadedFiles.every((file) => file.verificationStatus === "verified");
  if (options.cleanupLocal !== false && allVerified) {
    await fs.promises.rm(localDir, { recursive: true, force: true });
  }
  return { remotePath, files: uploadedFiles, allVerified };
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

export async function inspectRemoteFileSize(
  config: AppConfig,
  remotePath: string,
  expectedSize: number
): Promise<{ status: "verified" | "missing" | "mismatch"; remoteSize?: number }> {
  const client = buildDavClient(config);
  try {
    const remoteStat = await client.stat(remotePath) as any;
    const remoteSize = Number(remoteStat?.size);
    if (Number.isFinite(remoteSize) && remoteSize === expectedSize) {
      return { status: "verified", remoteSize };
    }
    return { status: "mismatch", remoteSize: Number.isFinite(remoteSize) ? remoteSize : undefined };
  } catch (error) {
    if (isRemoteNotFoundError(error)) return { status: "missing" };
    throw error;
  }
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
