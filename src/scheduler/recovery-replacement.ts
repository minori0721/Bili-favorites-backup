import { PersistedDomainDecodeError } from '../repositories/domain-decoders.js';
import { isRecord } from '../shared/api/value.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DOWNLOAD_SESSION_FILE, readDownloadSession } from '../download-session.js';
import type { PersistentJobRecord } from '../database.js';
import type { LocalCleanupPlan, RemoteFileRecord } from '../state.js';

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

export interface RecoverySource {
  jobId: string;
  localDir: string;
  manifestStamp: string;
  files: Array<Omit<LocalCleanupPlan['files'][number], 'remotePaths'> & { cid: number }>;
}

export function recoveryManifestStamp(directory: string) {
  try { return createHash('sha256').update(fs.readFileSync(path.join(directory, DOWNLOAD_SESSION_FILE))).digest('hex'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function decodeRecoverySources(value: unknown): RecoverySource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PersistedDomainDecodeError('recoverySources', 'Invalid recovery source list');
  return value.map(item => {
    if (!isRecord(item) || typeof item.jobId !== 'string' || !item.jobId || typeof item.localDir !== 'string' || !path.isAbsolute(item.localDir)
      || typeof item.manifestStamp !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(item.manifestStamp) || !Array.isArray(item.files)) throw new PersistedDomainDecodeError('recoverySources', 'Invalid recovery source identity');
    const files = item.files.map((file: unknown) => {
      if (!isRecord(file)) throw new PersistedDomainDecodeError('recoverySources', 'Invalid recovery source file');
      const name = file.relativePath, size = file.expectedSize, cid = file.cid;
      const identity = file.expectedIdentity;
      if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')
        || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
        || typeof cid !== 'number' || !Number.isSafeInteger(cid) || cid <= 0
        || !isRecord(identity)) throw new PersistedDomainDecodeError('recoverySources', 'Invalid recovery source file identity');
      const dev = identity.dev, ino = identity.ino;
      const mtimeMs = identity.mtimeMs, ctimeMs = identity.ctimeMs;
      if (typeof dev !== 'number' || typeof ino !== 'number' || typeof mtimeMs !== 'number' || typeof ctimeMs !== 'number'
        || [dev, ino, mtimeMs, ctimeMs].some(v => !Number.isFinite(v))) throw new PersistedDomainDecodeError('recoverySources', 'Invalid recovery source file stat');
      return { relativePath: name, expectedSize: size, cid, expectedIdentity: { dev, ino, mtimeMs, ctimeMs } };
    });
    return { jobId: item.jobId, localDir: item.localDir, manifestStamp: item.manifestStamp, files };
  });
}

/** Only identified current outputs are superseded. Historical/unknown files never enter this inventory. */
export function captureRecoverySource(job: PersistentJobRecord): RecoverySource | null {
  if (typeof job.payload.localDir !== 'string' || job.payload.historyOnly) return null;
  const localDir = job.payload.localDir;
  if (!fs.existsSync(localDir)) return null;
  if (fs.lstatSync(localDir).isSymbolicLink()) return null;
  const read = readDownloadSession(localDir);
  if (read.kind === 'valid' && read.manifest.bvid !== job.bvid) return null;
  const names = read.kind === 'valid' ? read.manifest.outputs.map(file => ({ relativePath: file.relativePath, cid: file.cid }))
    : Array.isArray(job.payload.files) ? job.payload.files.map((name: unknown) => {
      const metadata = job.payload.filenameMetadataByPath;
      const item = typeof name === 'string' && metadata && typeof metadata === 'object' ? Reflect.get(metadata, name) : undefined;
      const cid: unknown = item && typeof item === 'object' ? Reflect.get(item, 'cid') : undefined;
      return { relativePath: name, cid };
    }) : [];
  const root = fs.realpathSync(localDir);
  const files: RecoverySource['files'] = [];
  for (const file of names) {
    if (typeof file.relativePath !== 'string' || typeof file.cid !== 'number' || !Number.isSafeInteger(file.cid) || file.cid <= 0) continue;
    const target = path.resolve(localDir, file.relativePath);
    if (!target.startsWith(`${path.resolve(localDir)}${path.sep}`)) continue;
    try {
      if (!fs.realpathSync(target).startsWith(`${root}${path.sep}`)) continue;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const output = read.kind === 'valid' ? read.manifest.outputs.find(item => item.relativePath === file.relativePath) : undefined;
      const observedAt = output ? Date.parse(output.verifiedAt) : job.createdAt;
      if (!Number.isFinite(observedAt) || stat.mtimeMs > observedAt + 1 || stat.ctimeMs > observedAt + 1
        || (output && output.size !== stat.size)) continue;
      files.push({ relativePath: file.relativePath, cid: file.cid, expectedSize: stat.size,
        expectedIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return { jobId: job.id, localDir, manifestStamp: recoveryManifestStamp(localDir), files };
}

export function buildRecoveryReplacementPlans(sources: RecoverySource[], files: RemoteFileRecord[],
  transfer: { id: string; generation: number }, now: number): LocalCleanupPlan[] {
  const plans: LocalCleanupPlan[] = [];
  for (const source of sources) {
    const covered = source.files.filter(file => files.some(remote => remote.verificationStatus === 'verified'
      && remote.filenameMetadata?.cid === file.cid && remote.size !== undefined));
    if (!covered.length) continue;
    const proof = files.filter(remote => covered.some(file => remote.filenameMetadata?.cid === file.cid));
    plans.push({ id: `recovery:${source.jobId}:${transfer.id}:g${transfer.generation}`,
      localDir: source.localDir, manifestSessionId: `recovery:${source.jobId}`, reason: 'recovery_replaced',
      replacementManifestStamp: source.manifestStamp, replacementFiles: proof,
      transferSessionId: transfer.id, transferGeneration: transfer.generation, createdAt: new Date(now).toISOString(),
      files: covered.map(file => ({ ...file, remotePaths: proof.filter(remote => remote.filenameMetadata?.cid === file.cid).map(remote => remote.path) })) });
  }
  return plans;
}
