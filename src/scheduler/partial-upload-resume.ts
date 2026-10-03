import fs from 'node:fs';
import path from 'node:path';
import type { PersistentJobRecord } from '../database.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import { readDownloadSession } from '../download-session.js';

/** A visible owned PUT is retained; only never-started files may enter the normal upload queue. */
export function canResumePartialUpload(job: PersistentJobRecord,
  session: NonNullable<ReturnType<TransferSessionRepository['get']>>,
  observations: Array<{ file: ReturnType<TransferSessionRepository['listFiles']>[number]; status: string; parentStatus?: string }>) {
  if (job.payload.historyOnly || job.payload.conflictCandidateOnly || job.payload.encodingRetry) return false;
  if (!observations.every(item => item.status === 'verified' ? Boolean(item.file.putAcceptedAt)
    : item.status === 'missing' && item.parentStatus === 'visible' && !item.file.putAcceptedAt && item.file.attempts === 0)) return false;
  const read = readDownloadSession(session.localDir);
  if (read.kind !== 'valid' || read.manifest.bvid !== session.bvid
    || !['complete', 'partial'].includes(read.manifest.status)) return false;
  const manifest = read.manifest;
  if (manifest.outputs.length !== observations.length) return false;
  try {
  const root = fs.realpathSync(session.localDir);
  if (fs.lstatSync(session.localDir).isSymbolicLink()) return false;
  for (const { file } of observations) {
    const output = manifest.outputs.find(item => item.relativePath === file.relativePath && item.size === file.expectedSize);
    if (!output || !manifest.pages.some(page => page.cid === output.cid && page.index === output.pageIndex)) return false;
    // A replacement manifest, or a local file modified after its probe, cannot be reused.
    const verifiedAt = Date.parse(output.verifiedAt);
    if (verifiedAt > session.createdAt) return false;
    const target = path.resolve(session.localDir, file.relativePath);
    if (!fs.realpathSync(target).startsWith(`${root}${path.sep}`)) return false;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== output.size
      || stat.mtimeMs > verifiedAt + 1 || stat.ctimeMs > verifiedAt + 1) return false;
  }
  return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
