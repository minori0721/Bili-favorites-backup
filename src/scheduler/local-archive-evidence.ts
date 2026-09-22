import fs from 'node:fs';
import path from 'node:path';
import { invalidDownloadSessionMessage, readDownloadSession } from '../download-session.js';

function retainedDirectoryBytes(directory: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) bytes += retainedDirectoryBytes(target);
    else if (stat.isFile()) bytes += stat.size;
  }
  return bytes;
}

export function inspectLocalArchiveDirectory(localDirValue: string, inspect: (target: string) => fs.Stats = fs.lstatSync) {
    const localDir = String(localDirValue || "");
    if (!localDir) return { status: "missing" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
    try {
      const rootStat = inspect(localDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { status: "changed" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { status: "missing" as const, retainedBytes: 0, expectedBytes: 0, verifiedFiles: 0, totalFiles: 0 };
      }
      throw error;
    }
    const session = readDownloadSession(localDir);
    if (session.kind === 'invalid') {
      console.warn(`[Recovery] retained archive ${path.basename(localDir)}: ${invalidDownloadSessionMessage(session)}`);
    }
    const manifest = session.kind === 'valid' ? session.manifest : null;
    const files = manifest?.outputs || [];
    if (!manifest || manifest.bvid.length === 0 || files.length === 0) {
      return { status: "unknown" as const, retainedBytes: retainedDirectoryBytes(localDir), expectedBytes: 0, verifiedFiles: 0, totalFiles: files.length, evidence: session.kind };
    }
    const root = path.resolve(localDir);
    let retainedBytes = 0;
    let expectedBytes = 0;
    let verifiedFiles = 0;
    let missingFiles = 0;
    for (const file of files) {
      const expectedSize = file.size;
      expectedBytes += expectedSize;
      const target = path.resolve(root, file.relativePath);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        return { status: "changed" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
      }
      try {
        const stat = inspect(target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedSize) {
          return { status: "changed" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
        }
        retainedBytes += stat.size;
        verifiedFiles += 1;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === "ENOENT") {
          missingFiles += 1;
          continue;
        }
        throw error;
      }
    }
    if (verifiedFiles === files.length) return { status: "available" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
    if (missingFiles === files.length) return { status: "missing" as const, retainedBytes: 0, expectedBytes, verifiedFiles: 0, totalFiles: files.length };
    return { status: "unknown" as const, retainedBytes, expectedBytes, verifiedFiles, totalFiles: files.length };
  }
