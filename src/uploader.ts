import { spawn } from "node:child_process";
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

import { createClient } from "webdav";
import fs from "node:fs";
import path from "node:path";
import { AppConfig } from "./config.js";

export async function uploadWithAList(localDir: string, remotePath: string, config: AppConfig) {
  const davUrl = config.alistUrl.replace(/\/$/, "") + "/dav";
  const client = createClient(davUrl, {
    username: config.alistUsername,
    password: config.alistPassword,
  });

  // Ensure remote directory exists recursively
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

  const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const localFile = path.join(localDir, entry.name);
      // Join using posix style for webdav
      const remoteFile = remotePath.replace(/\/$/, "") + "/" + entry.name;
      
      const fileStream = fs.createReadStream(localFile);
      const stat = await fs.promises.stat(localFile);
      console.log(`[AList] Uploading ${entry.name} to ${remoteFile} (${stat.size} bytes)`);
      
      let uploadSuccessful = false;
      try {
        await client.putFileContents(remoteFile, fileStream as any, {
          contentLength: false, // Don't send content length for streams to avoid issues
          onUploadProgress: (progress) => {
            // Optional: log progress
          }
        });
        uploadSuccessful = true;
      } catch (err) {
        console.error(`[AList] Failed to upload ${entry.name}`, err);
        throw err;
      }
      
      if (uploadSuccessful) {
        await fs.promises.rm(localFile);
      }
    }
  }

  // Cleanup local dir
  await fs.promises.rm(localDir, { recursive: true, force: true });
}
