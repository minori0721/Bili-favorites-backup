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
        await fs.promises.rm(localFile);
      }
    }
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
  try {
    const items = await client.getDirectoryContents(remotePath) as any[];
    return items
      .filter((item: any) => item && item.type !== "directory")
      .map((item: any) => item?.basename)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}
