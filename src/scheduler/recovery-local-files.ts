import fs from 'node:fs';
import path from 'node:path';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { PersistentJobRecord } from '../database.js';
import { inspectLocalArchiveDirectory } from './local-archive-evidence.js';

interface LocalFileInspection {
  stat(file: string): Pick<fs.Stats, 'isFile' | 'size'>;
  directory: typeof inspectLocalArchiveDirectory;
}
const localFiles: LocalFileInspection = { stat: file => fs.statSync(file), directory: inspectLocalArchiveDirectory };

export function inspectRecoveryLocalFiles(
  transfers: Pick<TransferSessionRepository, 'get' | 'listFiles'>,
  job: Pick<PersistentJobRecord, 'payload'>,
  local: LocalFileInspection = localFiles,
) {
    const payload = job.payload;
    const session = payload.sessionId ? transfers.get(String(payload.sessionId)) : null;
    if (payload.sessionId && !session) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
    }
    if (session) {
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration) {
        return { status: "changed" as const, session, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
      }
      const files = transfers.listFiles(session.id, expectedGeneration);
      if (files.length === 0) return { status: "missing" as const, session, files };
      const localRoot = path.resolve(session.localDir);
      for (const file of files) {
        const localFile = path.resolve(session.localDir, file.relativePath);
        if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
          return { status: "changed" as const, session, files };
        }
        try {
          const stat = local.stat(localFile);
          if (!stat.isFile() || stat.size !== file.expectedSize) {
            return { status: "changed" as const, session, files };
          }
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return { status: "missing" as const, session, files };
          }
          throw error;
        }
      }
      return { status: "available" as const, session, files };
    }

    const localDir = String(payload.localDir || "");
    const requestedFiles = Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : [];
    if (requestedFiles.length === 0) {
      const evidence = local.directory(localDir);
      return { ...evidence, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
    }
    if (!localDir) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
    }
    for (const relativePath of requestedFiles) {
      const localRoot = path.resolve(localDir);
      const localFile = path.resolve(localDir, relativePath);
      if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
        return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
      }
      try {
        const stat = local.stat(localFile);
        if (!stat.isFile() || stat.size <= 0) {
          return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
        }
        throw error;
      }
    }
    return { status: "available" as const, session: null, files: [] as ReturnType<TransferSessionRepository["listFiles"]> };
  }
