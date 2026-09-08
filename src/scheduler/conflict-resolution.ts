import path from 'node:path';
import type { PersistentJobStore } from '../job-store.js';
import type { StateManager, RemoteFileRecord } from '../state.js';
import type { TransferSessionStore } from '../transfer-session.js';
import type { ConfigStore } from '../config.js';
import type { inspectRemoteFileSize } from '../uploader.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { logManager } from '../logger.js';
import { sanitizeUploadText } from '../upload-health.js';
import { readTaskFailure } from './task-failure.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import type { RecoveryIssue } from './recovery-contracts.js';
import type { RecoveryActionResult } from './recovery-action-contracts.js';

interface Dependencies {
  jobs: Pick<PersistentJobStore, 'findById' | 'complete'>;
  state: Pick<StateManager, 'runAtomic' | 'getRelationStatus' | 'restoreExistingArchiveProof' | 'markVerifiedUpload' | 'resolveRemoteConflictCandidate'>;
  sessions: Pick<TransferSessionStore, 'get' | 'supersede'>;
  config: Pick<ConfigStore, 'get'>;
  locks: RecoveryLockAccess;
  inspect: typeof inspectRemoteFileSize;
  proof(payload: unknown): ExistingArchiveProof | null;
  generation(): number;
  now(): number;
  cleanup(bvid: string, localDir: string): unknown;
  dispatch(): void;
  snapshot(): { issues: RecoveryIssue[] };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
function filesKey(files: unknown[]): string {
  return JSON.stringify(files.map(value => {
    const file = record(value);
    return `${String(file.path || '').replace(/\\/g, '/')}:${Number(file.size)}`;
  }).sort());
}
class ConflictChanged extends Error {}

/** Remote evidence is collected first; all persistent and in-memory changes commit together. */
export function createConflictResolution(deps: Dependencies) {
  async function resolve(jobId: string, resolution: 'keep_existing' | 'use_candidate'): Promise<RecoveryActionResult> {
    if (deps.locks.has(jobId)) return { ok: false, status: 409, message: '该冲突候选正在被处理，请稍后刷新' };
    deps.locks.add(jobId);
    try {
      const epoch = deps.generation();
      const job = deps.jobs.findById(jobId);
      if (!job || job.kind !== 'upload' || !job.payload.awaitingManualRecovery) {
        return { ok: false, status: 404, message: '冲突候选不存在或已处理' };
      }
      const payload = job.payload;
      const candidate = record(payload.conflictCandidate);
      if (!Array.isArray(candidate.files) || !candidate.files.length) {
        return { ok: false, status: 409, message: '当前任务没有可选择的已验证候选' };
      }
      const relation = deps.state.getRelationStatus(String(job.userId || ''), Number(job.mediaId), String(job.bvid || ''));
      const recorded = relation?.remoteConflictCandidates?.find(item => item.id === String(candidate.id) && !item.resolution);
      if (!recorded) return { ok: false, status: 409, message: '收藏来源中的候选记录缺失或已经处理，请刷新待处理列表' };
      const expectedCandidate = JSON.stringify(recorded);
      const expectedPayload = JSON.stringify(payload);
      if (String(candidate.candidateRemotePath || '') !== recorded.candidateRemotePath || filesKey(candidate.files) !== filesKey(recorded.files)) {
        return { ok: false, status: 409, message: '任务候选与收藏来源记录不一致，请重新检查' };
      }
      let retainedProof: ExistingArchiveProof | null = null;
      const verify = async (files: RemoteFileRecord[]) => {
        for (const file of files) {
          if (!file.path || !Number.isFinite(Number(file.size)) || Number(file.size) <= 0) return false;
          if ((await deps.inspect(deps.config.get(), file.path, Number(file.size))).status !== 'verified') return false;
          if (epoch !== deps.generation()) return false;
        }
        return true;
      };
      try {
        if (!await verify(recorded.files)) return { ok: false, status: 409, message: '候选文件状态已经变化，请重新检查' };
        if (resolution === 'keep_existing') {
          retainedProof = deps.proof(payload)
            || deps.proof({ existingArchiveProof: recorded.existingArchiveProof })
            || deps.proof({ existingArchiveProof: candidate.existingArchiveProof });
          if (!retainedProof) return { ok: false, status: 409, message: '现有归档缺少可恢复证明，不能将未知文件设为当前归档' };
          if (!await verify(retainedProof.files)) return { ok: false, status: 409, message: '现有归档已经变化，不能安全保留为当前来源' };
        }
      } catch (error) {
        return { ok: false, status: 503, message: `暂时无法连接 AList / OpenList 复核候选：${sanitizeUploadText(readTaskFailure(error).message || error, 180)}` };
      }
      try {
        deps.state.runAtomic(() => {
          const current = deps.jobs.findById(jobId);
          const currentRelation = deps.state.getRelationStatus(String(job.userId || ''), Number(job.mediaId), String(job.bvid || ''));
          const currentCandidate = currentRelation?.remoteConflictCandidates?.find(item => item.id === recorded.id && !item.resolution);
          if (epoch !== deps.generation() || !current || current.kind !== job.kind
            || current.status !== job.status || current.attempts !== job.attempts || current.leaseOwner !== job.leaseOwner
            || current.userId !== job.userId || current.mediaId !== job.mediaId || current.bvid !== job.bvid
            || JSON.stringify(current.payload) !== expectedPayload || JSON.stringify(currentCandidate) !== expectedCandidate) {
            throw new ConflictChanged('候选状态已变化，请刷新待处理列表');
          }
          const session = payload.sessionId ? deps.sessions.get(String(payload.sessionId)) : null;
          if (payload.sessionId && !session) throw new ConflictChanged('传输会话已经变化，请重新检查');
          if (session) {
            const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
            if (session.generation !== generation) throw new ConflictChanged('当前候选已经产生新的代次，请刷新待处理项');
            if (!['completed', 'superseded'].includes(session.phase) && !deps.sessions.supersede(session.id, generation)) {
              throw new ConflictChanged('传输会话已经变化，请重新检查');
            }
          }
          if (resolution === 'keep_existing') {
            if (!retainedProof || !deps.state.restoreExistingArchiveProof(String(job.bvid || ''), job.userId, job.mediaId, retainedProof)) {
              throw new ConflictChanged('现有归档证明无法恢复到当前收藏来源');
            }
          } else {
            deps.state.markVerifiedUpload(String(job.bvid || ''), recorded.candidateRemotePath || path.posix.dirname(recorded.files[0].path),
              recorded.files.map(file => ({ ...file, verificationStatus: 'verified', nextVerifyAt: undefined, lastError: undefined })),
              job.userId, job.mediaId, false);
          }
          if (!deps.state.resolveRemoteConflictCandidate(String(job.bvid || ''), job.userId, job.mediaId, recorded.id,
            resolution === 'keep_existing' ? 'kept_existing' : 'selected_candidate') || !deps.jobs.complete(jobId)) {
            throw new ConflictChanged('候选状态已变化，请刷新待处理列表');
          }
        });
      } catch (error) {
        if (error instanceof ConflictChanged) return { ok: false, status: 409, message: error.message };
        throw error;
      }
      void deps.cleanup(String(job.bvid || ''), String(payload.localDir || ''));
      logManager.push({ timestamp: new Date(deps.now()).toISOString(), type: 'upload', level: 'info',
        summary: resolution === 'keep_existing' ? `已保留现有归档 ${job.bvid || ''}，冲突候选仍在独立目录` : `已采用冲突候选 ${job.bvid || ''}，正式旧路径仍未删除`,
        raw: `[Recovery] conflict candidate resolved action=${resolution}; files=${recorded.files.length}`,
        bvid: job.bvid, simpleVisible: true, debugVisible: true });
      deps.dispatch();
      return { ok: true, issues: deps.snapshot().issues };
    } finally {
      deps.locks.delete(jobId);
    }
  }
  return { resolve };
}
