import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { buildUploadFileMetadataFromSession, readDownloadSession } from '../download-session.js';
import { PersistedDomainDecodeError } from '../repositories/domain-decoders.js';
import { decodeRecoveryFiles, isVerifiedArchiveProofForRecovery, parseExistingArchiveProof, verifiedFilesFromRecovery, repairRecoveryDescriptions } from './recovery-projection.js';
import { protectRecoveryDirectory } from '../recovery-file-protection.js';
import { logManager } from '../logger.js';

export type RecoveryEvidenceResult =
  | { kind: 'unchanged' | 'repaired'; job: PersistentJobRecord }
  | { kind: 'stale' }
  | { kind: 'blocked'; reason: string; canReprobe: boolean };

export class RecoveryEvidencePreservationError extends Error {
  constructor(cause: unknown) {
    super('无法保存损坏恢复记录，原记录和媒体文件保持不变');
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

interface Dependencies {
  jobs: Pick<JobRepository, 'findById' | 'updatePayload'>;
  sessions: Pick<TransferSessionRepository, 'get' | 'listFiles' | 'ensurePrepared' | 'ensureFile'>;
  atomic<T>(work: () => T): T;
  captureProof(userId: string, mediaId: number, bvid: string): ExistingArchiveProof | undefined;
  canRun(): boolean;
  generation(): number;
  now(): number;
  preserve(job: PersistentJobRecord): Promise<string>;
}

/** The original payload is written exclusively before replacing any damaged evidence. */
export function preserveRecoveryEvidence(directory: string, job: PersistentJobRecord) {
  const identity = createHash('sha256').update(job.id).digest('hex').slice(0, 24);
  const target = path.join(directory, '_recovery-evidence', `${identity}-${randomUUID()}.json`);
  return fs.mkdir(path.dirname(target), { recursive: true }).then(async () => {
    await fs.writeFile(target, JSON.stringify({ jobId: job.id, payload: job.payload }), { flag: 'wx', mode: 0o600 });
    return target;
  });
}

/** Rebuilds derived evidence, never PUT acknowledgements or unknown file identities. */
export function createRecoveryEvidenceRebuild(deps: Dependencies) {
  async function preserveForReprobe(job: PersistentJobRecord): Promise<RecoveryEvidenceResult> {
    const epoch = deps.generation();
    if (!deps.canRun()) return { kind: 'stale' };
    const repair = job.payload.recoveryEvidenceRepair;
    if (repair && typeof repair === 'object' && Reflect.get(repair, 'source') === 'reprobe') return { kind: 'unchanged', job };
    let backupPath: string;
    try {
      backupPath = await deps.preserve(job);
      if (!deps.canRun() || epoch !== deps.generation()) return { kind: 'stale' };
      if (typeof job.payload.localDir === 'string') protectRecoveryDirectory(job.payload.localDir);
    } catch (error) { throw new RecoveryEvidencePreservationError(error); }
    return deps.atomic(() => {
      const current = deps.jobs.findById(job.id);
      if (!deps.canRun() || epoch !== deps.generation() || !current
        || JSON.stringify(current.payload) !== JSON.stringify(job.payload) || current.status !== job.status
        || current.attempts !== job.attempts || current.leaseOwner !== job.leaseOwner) return { kind: 'stale' as const };
      if (!deps.jobs.updatePayload(job.id, { ...job.payload,
        recoveryEvidenceRepair: { backupPath, repairedAt: deps.now(), source: 'reprobe', protectLocal: true } })) throw new Error('Recovery evidence preservation commit failed');
      const updated = deps.jobs.findById(job.id);
      if (!updated) throw new Error('Recovery job disappeared during preservation');
      return { kind: 'repaired' as const, job: updated };
    });
  }
  async function rebuild(job: PersistentJobRecord): Promise<RecoveryEvidenceResult> {
    const epoch = deps.generation();
    const active = () => deps.canRun() && epoch === deps.generation();
    if (!active()) return { kind: 'stale' };
    const payload = job.payload;
    // Candidate paths may already contain a different version. They cannot be
    // reconstructed from the ordinary transfer file list.
    if (payload.conflictCandidate != null) {
      if (typeof payload.conflictCandidate !== 'object' || Array.isArray(payload.conflictCandidate)) {
        return { kind: 'blocked', reason: '冲突候选身份损坏，不能推测候选路径', canReprobe: false };
      }
      try {
        decodeRecoveryFiles(Reflect.get(payload.conflictCandidate, 'files'), 'recovery.conflictCandidate.files');
        parseExistingArchiveProof(payload.conflictCandidate);
      }
      catch (error) {
        if (error instanceof PersistedDomainDecodeError) return { kind: 'blocked', reason: '冲突候选清单损坏，已有文件继续保留', canReprobe: false };
        throw error;
      }
    }
    const damagedProof = (() => {
      try { parseExistingArchiveProof(payload); return false; }
      catch (error) {
        if (error instanceof PersistedDomainDecodeError) return true;
        throw error;
      }
    })();
    const session = typeof payload.sessionId === 'string' ? deps.sessions.get(payload.sessionId) : null;
    if (payload.sessionId !== undefined && (!session || typeof payload.sessionId !== 'string')) {
      return { kind: 'blocked', reason: '原传输身份缺失，不能创建新代次冒充旧传输', canReprobe: false };
    }
    if (session && ((payload.sessionGeneration !== undefined && session.generation !== payload.sessionGeneration) || session.phase === 'superseded'
      || session.bvid !== job.bvid || (session.userId !== undefined && session.userId !== job.userId)
      || (session.mediaId !== undefined && session.mediaId !== job.mediaId))) {
      return { kind: 'blocked', reason: '任务与当前传输身份不一致，不能自动接管其他尝试', canReprobe: false };
    }
    const files = session ? deps.sessions.listFiles(session.id, session.generation) : [];
    const damagedMetadata = (() => {
      try { verifiedFilesFromRecovery(payload, files); return false; }
      catch (error) {
        if (error instanceof PersistedDomainDecodeError) return true;
        throw error;
      }
    })();
    const missingFiles = !session || files.length === 0;
    const damagedFileList = files.length > 0 && (!Array.isArray(payload.files) || payload.files.length !== files.length
      || new Set(payload.files).size !== files.length || payload.files.some(name => !files.some(file => file.relativePath === name)));
    const localDir = session?.localDir || (typeof payload.localDir === 'string' ? payload.localDir : '');
    const remotePath = session?.remotePath || (typeof payload.remotePath === 'string' ? payload.remotePath : '');
    if (session && ((payload.localDir !== undefined && payload.localDir !== session.localDir)
      || (payload.remotePath !== undefined && payload.remotePath !== session.remotePath))) {
      return { kind: 'blocked', reason: '恢复路径与传输记录不一致', canReprobe: false };
    }
    if (!damagedProof && !damagedMetadata && !damagedFileList && !missingFiles) return { kind: 'unchanged', job };
    const manifestRead = localDir ? readDownloadSession(localDir) : { kind: 'missing' as const };
    const manifest = manifestRead.kind === 'valid' ? manifestRead.manifest : null;
    const descriptions = !manifest && damagedMetadata && files.length > 0 && files.every(file => Boolean(file.putAcceptedAt))
      ? repairRecoveryDescriptions(payload, files) : null;
    const needsMetadata = damagedMetadata && !descriptions;

    if (manifest && manifest.bvid !== job.bvid) {
      return { kind: 'blocked', reason: '下载清单属于其他视频，不能自动采用', canReprobe: false };
    }
    let proof: ExistingArchiveProof | undefined;
    if (damagedProof && job.userId && job.mediaId !== undefined && job.bvid) {
      proof = deps.captureProof(job.userId, job.mediaId, job.bvid);
      if (proof) {
        proof = parseExistingArchiveProof({ existingArchiveProof: proof }) || undefined;
        const names = files.length ? files.map(file => file.relativePath) : payload.files;
        if (!proof || !isVerifiedArchiveProofForRecovery({ ...payload, remotePath, files: names }, proof)) proof = undefined;
      }
    }
    // Current, complete transfer rows suffice for read-only confirmation even
    // when the old archive proof is lost. The original local data stays protected.
    if (damagedProof && !proof && files.length === 0) {
      return { kind: 'blocked', reason: '缺少独立的完整归档或传输证明，需要独立下载恢复', canReprobe: true };
    }
    const needsTransfer = missingFiles && !(damagedProof && proof && !payload.sessionId);
    if ((needsMetadata || needsTransfer) && !manifest) {
      if (!damagedProof && !damagedMetadata && manifestRead.kind === 'missing') return { kind: 'unchanged', job };
      return { kind: 'blocked', reason: '下载清单不足以重建文件记录，需要重新探测', canReprobe: true };
    }
    const outputs = manifest?.outputs || [];
    const expectedPaths = files.length ? files.map(file => file.relativePath)
      : (Array.isArray(payload.files) && payload.files.length > 0 ? payload.files : outputs.map(file => file.relativePath));
    if (!Array.isArray(expectedPaths) || expectedPaths.length === 0
      || expectedPaths.some(name => typeof name !== 'string') || new Set(expectedPaths).size !== expectedPaths.length
      || ((needsMetadata || needsTransfer) && expectedPaths.some(name => !outputs.some(file => file.relativePath === name)))) {
      return { kind: 'blocked', reason: '文件清单不完整，不能把部分记录当作完整恢复', canReprobe: true };
    }
    if ((needsMetadata || needsTransfer) && files.some(file => !outputs.some(output => output.relativePath === file.relativePath && output.size === file.expectedSize))) {
      return { kind: 'blocked', reason: '下载输出与传输文件身份不一致', canReprobe: false };
    }
    if (needsTransfer && manifest && payload.partialBackup !== true
      && (expectedPaths.length !== outputs.length || !manifest.pages.every(page => outputs.some(output => output.cid === page.cid && output.pageIndex === page.index)))) {
      return { kind: 'blocked', reason: '当前下载仅有部分分P，不能把不完整清单重建为完整传输', canReprobe: true };
    }
    if (needsTransfer && (!job.bvid || !localDir || !remotePath || payload.historyOnly || payload.encodingRetry || payload.conflictCandidate)) {
      return { kind: 'blocked', reason: '缺少建立传输所需的任务身份', canReprobe: false };
    }
    const metadata = descriptions?.metadata ?? (needsMetadata || needsTransfer
      ? buildUploadFileMetadataFromSession(localDir, expectedPaths, { requireVerifiedMediaMetadata: payload.strictMediaTarget != null })
      : payload.filenameMetadataByPath);
    let backupPath: string;
    try {
      backupPath = await deps.preserve(job);
      if (!active()) return { kind: 'stale' };
      if (damagedProof && !proof) protectRecoveryDirectory(localDir);
    }
    catch (error) { throw new RecoveryEvidencePreservationError(error); }
    if (!active()) return { kind: 'stale' };
    return deps.atomic(() => {
      const current = deps.jobs.findById(job.id);
      if (!current || !active() || current.status !== job.status || current.attempts !== job.attempts
        || current.leaseOwner !== job.leaseOwner || JSON.stringify(current.payload) !== JSON.stringify(payload)) return { kind: 'stale' as const };
      const live = session ? deps.sessions.get(session.id) : null;
      if (session && (!live || live.generation !== session.generation
        || live.phase === 'superseded'
        || JSON.stringify(deps.sessions.listFiles(session.id, session.generation)) !== JSON.stringify(files))) return { kind: 'stale' as const };
      let rebuilt = live;
      if (needsTransfer) {
        const selected = outputs.filter(output => expectedPaths.includes(output.relativePath));
        if (selected.length !== expectedPaths.length) throw new Error('Recovery output list changed before commit');
        rebuilt = deps.sessions.ensurePrepared({ sessionId: session?.id, expectedGeneration: session?.generation,
          dedupeKey: session?.dedupeKey || `evidence-rebuild:${job.id}`, bvid: job.bvid!, userId: job.userId, mediaId: job.mediaId,
          localDir, remotePath }, selected.map(output => ({ relativePath: output.relativePath, name: path.basename(output.relativePath), expectedSize: output.size })));
      }
      const patched = { ...payload, files: expectedPaths, localDir, remotePath,
        ...(rebuilt ? { sessionId: rebuilt.id, sessionGeneration: rebuilt.generation, emptyAttempt: false } : {}),
        ...(damagedProof ? { existingArchiveProof: proof } : {}),
        filenameMetadataByPath: metadata,
        recoveryEvidenceRepair: { backupPath, repairedAt: deps.now(), source: proof ? 'archive' : 'transfer', protectLocal: damagedProof && !proof },
      };
      if (!deps.jobs.updatePayload(job.id, patched)) throw new Error('Recovery evidence commit failed');
      const updated = deps.jobs.findById(job.id);
      if (!updated) throw new Error('Recovery job disappeared during evidence commit');
      if (descriptions) logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: 'system', level: 'warn',
        summary: `已保存并重建非关键描述信息 ${job.bvid || ''}`,
        raw: `[Recovery] damaged optional metadata preserved; fields=${descriptions.dropped.join(',')}`,
        bvid: job.bvid, simpleVisible: true, debugVisible: true });
      return { kind: 'repaired' as const, job: updated };
    });
  }
  return { rebuild, preserveForReprobe };
}
