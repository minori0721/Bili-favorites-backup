import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore, BBDownEncoding } from '../config.js';
import type { UserStore } from '../users.js';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository, EnqueuePersistentJob } from '../repositories/jobs.js';
import type { StateManager } from '../state.js';
import type { EncodingRetryContext, UploadTarget } from '../tasks.js';
import { isSelectableBilibiliQuality } from '../media-metadata.js';
import { readDownloadSession } from '../download-session.js';
import { sanitizeSegment } from '../utils.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig, buildQualityArtifactKey } from '../quality-artifact.js';
import { parseEncodingRetryContext } from './recovery-context.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { inspectRecoveryLocalFiles } from './recovery-local-files.js';
import type { RecoveryLockAccess } from './recovery-work.js';
interface Dependencies {
  jobStore: Pick<JobRepository, 'findById' | 'startEncodingRetry'>;
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  stateManager: Pick<StateManager, 'getRelationStatus'>;
  locks: RecoveryLockAccess;
  legacyTempDir: string;
  recoveryAssessment(payload: unknown): RecoveryAssessment | null;
  inspectRecoveryLocalFiles(job: PersistentJobRecord): ReturnType<typeof inspectRecoveryLocalFiles>;
  isSafeEncodingRetryDirectory(directory: string): boolean;
  isArchiveSourceDeletionBlocked(userId: string, mediaId: number, bvid: string): boolean;
  dispatchPersistentJobs(): void;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createEncodingRecovery(deps: Dependencies) {
  async function startLocked(jobId: string, priority: BBDownEncoding[], strict: boolean, requestedQuality?: string) {
    const job = deps.jobStore.findById(jobId);
    if (!job || job.kind !== "upload" || job.payload.historyOnly) {
      return { ok: false as const, status: 404, message: "该任务不支持编码替换" };
    }
    const payload = job.payload;
    const retryState = record(payload.encodingRetry);
    if (retryState && ["running", "uploading", "verifying"].includes(String(retryState.state || ""))) {
      const activeChild = retryState.replacementJobId ? deps.jobStore.findById(String(retryState.replacementJobId)) : null;
      if (activeChild) return { ok: true as const, idempotent: true as const, childJobId: activeChild.id };
      return { ok: false as const, status: 409, message: "编码替换任务正在恢复，请刷新待处理项" };
    }
    if (payload.awaitingManualRecovery !== true) {
      return { ok: false as const, status: 404, message: "该任务不支持编码替换" };
    }
    const quality = String(requestedQuality || "").trim().toUpperCase();
    if (quality && !isSelectableBilibiliQuality(quality)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    const currentRetry = parseEncodingRetryContext(payload.encodingRetry);
    const assessment = deps.recoveryAssessment(payload);
    if (!assessment || !["remote_size_limit", "remote_write_rejected", "encoding_retry_failed"].includes(assessment.kind)) {
      return { ok: false as const, status: 409, message: "当前任务不是可更换编码的远端写入错误，请先重新检查" };
    }
    const local = deps.inspectRecoveryLocalFiles(job);
    if (local.status !== "available") {
      return { ok: false as const, status: 409, message: "原始下载文件已不可用，不能安全进行编码替换" };
    }
    const originalLocalDir = String(local.session?.localDir || payload.localDir || "");
    if (!deps.isSafeEncodingRetryDirectory(originalLocalDir)) {
      return { ok: false as const, status: 409, message: "原始下载目录不在受保护的临时目录内" };
    }
    const userId = String(job.userId || payload.userId || "");
    const mediaId = Number(job.mediaId ?? payload.mediaId);
    const bvid = String(job.bvid || payload.bvid || "");
    const relation = userId && Number.isInteger(mediaId)
      ? deps.stateManager.getRelationStatus(userId, mediaId, bvid)
      : null;
    const user = userId ? deps.userStore.getById(userId) : null;
    if (!user?.enabled || !relation) {
      return { ok: false as const, status: 409, message: "原收藏账号或来源已不可用于重新下载" };
    }
    if (deps.isArchiveSourceDeletionBlocked(userId, mediaId, bvid)) {
      return { ok: false as const, status: 409, message: "该收藏来源正在删除或清理，请稍后再试" };
    }
    const remotePath = String(payload.remotePath || relation.remotePath || "");
    if (!remotePath) return { ok: false as const, status: 409, message: "原归档路径缺失，不能建立安全替换任务" };
    const originalFiles: string[] = local.files.length > 0
      ? local.files.map((file) => file.relativePath)
      : (Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : []);
    if (originalFiles.length === 0) {
      const manifest = readDownloadSession(originalLocalDir);
      if (manifest) originalFiles.push(...manifest.outputs.map((output) => output.relativePath));
    }
    if (originalFiles.length === 0) return { ok: false as const, status: 409, message: "原始下载清单缺少文件列表" };
    const folderTitle = String(payload.folderTitle || relation.folderTitle || "favorites");
    const target: UploadTarget = { userId, mediaId, folderTitle, remotePath };
    const generation = Math.max(0, Number(currentRetry?.generation || retryState?.generation || 0)) + 1;
    const safeBvid = sanitizeSegment(bvid).slice(0, 80) || "video";
    const candidateLocalDir = path.join(
      path.resolve(deps.legacyTempDir),
      `${safeBvid}-encoding-retry-${job.id.slice(0, 12)}-g${generation}`,
    );
    if (!deps.isSafeEncodingRetryDirectory(candidateLocalDir) || fs.existsSync(candidateLocalDir)) {
      return { ok: false as const, status: 409, message: "替换任务目录已存在，请刷新待处理项后重试" };
    }
    const context: EncodingRetryContext = {
      parentJobId: job.id,
      generation,
      priority: [...priority],
      strict,
      quality: quality || undefined,
      candidateLocalDir,
      originalLocalDir,
      originalFiles: [...new Set(originalFiles.map((file: string) => String(file).split(String.fromCharCode(92)).join("/").replace(/^\/+/, "")))],
      target,
      state: "running",
    };
    const child: EnqueuePersistentJob = {
      kind: "download",
      dedupeKey: `encoding-retry-download:${job.id}:g${generation}`,
      bvid,
      userId,
      mediaId,
      priority: 5,
      maxAttempts: deps.configStore.get().maxRetries + 1,
      payload: {
        primaryUserId: userId,
        primaryMediaId: mediaId,
        primaryFolderTitle: folderTitle,
        downloadUserId: userId,
        detachedTargets: [target],
        encodingRetry: context,
        ...(quality ? (() => {
          const profile = normalizeQualityArtifactProfile({
            ...qualityArtifactProfileFromConfig(deps.configStore.get()),
            quality,
            encoding: priority[0],
          });
          return {
            qualityProfile: profile,
            qualityStrict: true,
            qualityArtifactKey: buildQualityArtifactKey(bvid, profile),
          };
        })() : {}),
      },
    };
    const started = deps.jobStore.startEncodingRetry(job.id, child, { ...context });
    if (!started) return { ok: false as const, status: 409, message: "该待处理任务正在被其他操作处理，请刷新后重试" };
    if (!started.idempotent) deps.dispatchPersistentJobs();
    return { ok: true as const, idempotent: Boolean(started.idempotent), childJobId: started.child.id };
  }

  async function start(jobId: string, priority: BBDownEncoding[], strict: boolean, requestedQuality?: string) {
    if (deps.locks.has(jobId)) return { ok: false as const, status: 409, message: "该待处理任务正在被其他操作处理，请刷新后重试" };
    deps.locks.add(jobId);
    try { return await startLocked(jobId, priority, strict, requestedQuality); }
    finally { deps.locks.delete(jobId); }
  }
  return { start };
}
