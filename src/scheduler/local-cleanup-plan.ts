import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalCleanupPlan, RemoteFileRecord } from '../state.js';
import { readDownloadSession } from '../download-session.js';

export function buildLocalCleanupPlan(
  bvid: string,
  localDir: string,
  remoteFiles: RemoteFileRecord[],
  reason: LocalCleanupPlan['reason'],
  now: () => number,
  options: { id?: string; transferSessionId?: string; transferGeneration?: number; verifiedCandidateId?: string } = {},
): LocalCleanupPlan | null {
  if (!localDir || remoteFiles.length === 0) return null;
  const session = readDownloadSession(localDir);
  if (session.kind !== 'valid') return null;
  const manifest = session.manifest;
  if (manifest.bvid !== bvid || !manifest.sessionId) return null;
  const manifestFiles = [...manifest.outputs, ...(manifest.history || [])];
  const files: LocalCleanupPlan['files'] = [];
  for (const remoteFile of remoteFiles) {
    const relativePath = (remoteFile.localRelativePath || '').replace(/\\/g, '/');
    if (!relativePath || !remoteFile.path) return null;
    const manifestFile = manifestFiles.find(file => file.relativePath.replace(/\\/g, '/') === relativePath);
    if (!manifestFile) return null;
    if (remoteFile.size === undefined || remoteFile.size !== manifestFile.size) return null;
    let identity: fs.Stats;
    try {
      const root = fs.realpathSync(localDir);
      const target = path.resolve(localDir, relativePath);
      if (!fs.realpathSync(target).startsWith(`${root}${path.sep}`)) return null;
      identity = fs.lstatSync(target);
      const verifiedAt = Date.parse(manifestFile.verifiedAt);
      if (!identity.isFile() || identity.size !== manifestFile.size || !Number.isFinite(verifiedAt)
        || identity.mtimeMs > verifiedAt + 1 || identity.ctimeMs > verifiedAt + 1) return null;
    // boundary-fail-closed: a file identity error cannot authorize deletion.
    } catch { return null; }
    const previous = files.find(file => file.relativePath === relativePath);
    if (previous) {
      previous.remotePaths = [...new Set([...previous.remotePaths, remoteFile.path])];
      continue;
    }
    files.push({
      relativePath,
      expectedSize: manifestFile.size,
      expectedIdentity: { dev: identity.dev, ino: identity.ino, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs },
      remotePaths: [remoteFile.path],
    });
  }
  if (files.length === 0) return null;
  const derivedId = crypto.createHash('sha256').update(JSON.stringify({
    reason, sessionId: manifest.sessionId, transferSessionId: options.transferSessionId || '', transferGeneration: options.transferGeneration || 0,
    files: files.map(file => ({ relativePath: file.relativePath, expectedSize: file.expectedSize, remotePaths: file.remotePaths })),
  })).digest('hex').slice(0, 32);
  return {
    id: String(options.id || `${reason}:${derivedId}`), localDir, manifestSessionId: manifest.sessionId,
    transferSessionId: options.transferSessionId, transferGeneration: options.transferGeneration,
    reason, files, createdAt: new Date(now()).toISOString(),
    verifiedCandidateId: options.verifiedCandidateId,
  };
}
