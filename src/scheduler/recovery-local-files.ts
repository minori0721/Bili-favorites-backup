import fs from 'node:fs';
import path from 'node:path';
import type { TransferSessionStore } from '../transfer-session.js';
import type { PersistentJobRecord } from '../database.js';
import { inspectLocalArchiveDirectory } from './local-archive-evidence.js';

export function inspectRecoveryLocalFiles(transfers: Pick<TransferSessionStore, 'get' | 'listFiles'>, job: Pick<PersistentJobRecord, 'payload'>) {
    const payload = job.payload;
    const session = payload.sessionId ? transfers.get(String(payload.sessionId)) : null;
    if (payload.sessionId && !session) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    if (session) {
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration) {
        return { status: "changed" as const, session, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
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
          const stat = fs.statSync(localFile);
          if (!stat.isFile() || stat.size !== file.expectedSize) {
            return { status: "changed" as const, session, files };
          }
        } catch {
          return { status: "missing" as const, session, files };
        }
      }
      return { status: "available" as const, session, files };
    }

    const localDir = String(payload.localDir || "");
    const requestedFiles = Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : [];
    if (requestedFiles.length === 0) {
      const local = inspectLocalArchiveDirectory(localDir);
      return { ...local, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    if (!localDir || !fs.existsSync(localDir)) {
      return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
    }
    for (const relativePath of requestedFiles) {
      const localRoot = path.resolve(localDir);
      const localFile = path.resolve(localDir, relativePath);
      if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
        return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
      }
      try {
        const stat = fs.statSync(localFile);
        if (!stat.isFile() || stat.size <= 0) {
          return { status: "changed" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
        }
      } catch {
        return { status: "missing" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
      }
    }
    return { status: "available" as const, session: null, files: [] as ReturnType<TransferSessionStore["listFiles"]> };
  }
