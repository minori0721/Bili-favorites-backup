import fs from 'node:fs';
import path from 'node:path';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { RecoveryLockAccess } from './recovery-work.js';

interface Dependencies {
  jobStore: Pick<JobRepository, 'findById' | 'wakeManualJob'>;
  transferSessions: Pick<TransferSessionRepository, 'get' | 'listFiles'>;
  recoveryWork: { locks: RecoveryLockAccess };
  isPlainObsoleteArchiveRecovery(job: PersistentJobRecord): boolean;
  captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string): ExistingArchiveProof | undefined;
  confirmVerifiedArchiveProofForRecovery(job: PersistentJobRecord, proof: ExistingArchiveProof): Promise<string>;
  finalizeRetainedArchiveRecovery(job: PersistentJobRecord, proof: ExistingArchiveProof, options: { allowResumeOnly: boolean }): boolean;
  dispatchPersistentJobs(): void;
  generation(): number;
}
export function createUploadResumeService(deps: Dependencies) {
  async function recover(jobId: string, allowReupload = false) {
    if (deps.recoveryWork.locks.has(jobId)) {
      return { ok: false as const, status: 409, message: "正在复核现有归档，请稍候" };
    }
    deps.recoveryWork.locks.add(jobId);
    try {
      return await recoverLocked(jobId, allowReupload);
    } finally {
      deps.recoveryWork.locks.delete(jobId);
    }
  }
  async function recoverLocked(jobId: string, allowReupload: boolean) {
    const epoch = deps.generation();
    const job = deps.jobStore.findById(String(jobId || ""));
    if (!job || !["upload", "history_upload"].includes(job.kind)) {
      return { ok: false as const, status: 404, message: "Upload recovery job not found" };
    }
    const payload = job.payload;

    // A legacy resume-only job can outlive its local candidate. If the
    // relation already contains a complete verified proof for the same
    // remote directory and file set, finish from that proof instead of
    // waking an upload that can only fail on a missing local file.
    if (!allowReupload && deps.isPlainObsoleteArchiveRecovery(job)) {
      const bvid = String(job.bvid || payload.bvid || "");
      const proof = deps.captureExistingArchiveProof(job.userId, job.mediaId, bvid);
      if (proof && await deps.confirmVerifiedArchiveProofForRecovery(job, proof) === "verified") {
        if (epoch !== deps.generation()) return { ok: false as const, status: 409, message: "恢复环境已经变化，请刷新后重试" };
        const resolved = deps.finalizeRetainedArchiveRecovery(job, proof, { allowResumeOnly: true });
        if (resolved) {
          return { ok: true as const, job, idempotent: true as const, resolved: "verified_archive" as const };
        }
      }
      const current = deps.jobStore.findById(job.id);
      if (epoch !== deps.generation() || !current || current.status !== job.status
        || current.attempts !== job.attempts || current.leaseOwner !== job.leaseOwner
        || JSON.stringify(current.payload) !== JSON.stringify(payload)) {
        return { ok: false as const, status: 409, message: "恢复任务已经变化，请刷新后重试" };
      }
    }

    if (!payload.awaitingManualRecovery) {
      if (["pending", "leased", "running", "retry_wait"].includes(job.status)) {
        return { ok: true as const, job, idempotent: true as const };
      }
      return { ok: false as const, status: 409, message: "This upload is not waiting for manual recovery" };
    }
    let recoveryFiles = Array.isArray(payload.files)
      ? payload.files.map((value: unknown) => String(value || "").replace(/\\/g, "/")).filter(Boolean)
      : [];
    if (payload.sessionId) {
      const session = deps.transferSessions.get(String(payload.sessionId));
      if (!session) return { ok: false as const, status: 409, message: "Upload session is no longer available" };
      const expectedGeneration = Number.isInteger(payload.sessionGeneration)
        ? Number(payload.sessionGeneration)
        : session.generation;
      if (session.generation !== expectedGeneration) {
        return { ok: false as const, status: 409, message: "Upload attempt is no longer current; please refresh the recovery item" };
      }
      const sessionFiles = deps.transferSessions.listFiles(session.id, expectedGeneration);
      if (recoveryFiles.length === 0) recoveryFiles = sessionFiles.map((file) => file.relativePath);
      const selectedFiles = new Set(recoveryFiles);
      for (const file of sessionFiles.filter((candidate) => selectedFiles.has(candidate.relativePath))) {
        const localFile = path.resolve(session.localDir, file.relativePath);
        if (localFile !== path.resolve(session.localDir) && !localFile.startsWith(`${path.resolve(session.localDir)}${path.sep}`)) {
          return { ok: false as const, status: 409, message: "Upload file path is invalid" };
        }
        try {
          const stat = fs.statSync(localFile);
          if (!stat.isFile() || stat.size !== file.expectedSize) {
            return { ok: false as const, status: 409, message: "Local upload files changed; a new upload is required" };
          }
        } catch {
          return { ok: false as const, status: 409, message: "Local upload files are no longer available" };
        }
      }
    } else {
      const localDirectory = String(payload.localDir || "").trim();
      if (!localDirectory) {
        return { ok: false as const, status: 409, message: "本地补传目录缺失，请重新下载后再上传" };
      }
      const localRoot = path.resolve(localDirectory);
      try {
        const rootInfo = fs.lstatSync(localRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          return { ok: false as const, status: 409, message: "本地补传目录已不可用，请重新下载后再上传" };
        }
      } catch {
        return { ok: false as const, status: 409, message: "本地补传目录已不存在，请重新下载后再上传" };
      }
      for (const relativePath of recoveryFiles) {
        const localFile = path.resolve(localRoot, relativePath);
        if (localFile === localRoot || !localFile.startsWith(`${localRoot}${path.sep}`)) {
          return { ok: false as const, status: 409, message: "本地补传文件路径无效" };
        }
        try {
          const fileInfo = fs.lstatSync(localFile);
          if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size <= 0) {
            return { ok: false as const, status: 409, message: "本地补传文件已不存在，请重新下载后再上传" };
          }
        } catch {
          return { ok: false as const, status: 409, message: "本地补传文件已不存在，请重新下载后再上传" };
        }
      }
    }

    const woken = deps.jobStore.wakeManualJob(job.id, {
      awaitingManualRecovery: false,
      allowReupload: false,
      reuploadAuthorizedFiles: allowReupload ? [...new Set(recoveryFiles)] : [],
      resumeOnly: true,
      ...(payload.sessionId && !Number.isInteger(payload.sessionGeneration)
        ? { sessionGeneration: deps.transferSessions.get(String(payload.sessionId))?.generation }
        : {}),
    });
    if (!woken) {
      const current = deps.jobStore.findById(job.id);
      return current
        ? { ok: true as const, job: current, idempotent: true as const }
        : { ok: false as const, status: 409, message: "Upload recovery is already being handled" };
    }
    // Per-file permissions remain on the leased job until the corresponding
    // PUT is about to start. Preflight and queue delays do not consume them.
    deps.dispatchPersistentJobs();
    return { ok: true as const, job: woken, idempotent: false as const };
  }
  return { recover };
}
