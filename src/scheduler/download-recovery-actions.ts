import crypto from 'node:crypto';
import { isValidBBDownEncodingPriority, normalizeBBDownEncodingPriority, type ConfigStore } from '../config.js';
import { downloadCredentialsForUser, type BiliUser, type UserStore } from '../users.js';
import type { getVideoPageSnapshot } from '../bili.js';
import type { PersistentJobStore } from '../job-store.js';
import type { PersistentJobRecord } from '../database.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig, buildQualityArtifactKey } from '../quality-artifact.js';
import { isSelectableBilibiliQuality } from '../media-metadata.js';
import { sanitizeUploadText } from '../upload-health.js';
import { logManager } from '../logger.js';
import type { RecoveryIssueActionId } from '../recovery-policy.js';
import type { RecoveryIssue } from './recovery-contracts.js';
import type { RecoveryActionOptions, RecoveryActionResult } from './recovery-action-contracts.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import { readTaskFailure } from './task-failure.js';
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'findById' | 'wakeManualJob' | 'complete'>;
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  recoveryWork: { locks: RecoveryLockAccess };
  videoAccessProbe: typeof getVideoPageSnapshot;
  isUserSyncEligible(user: BiliUser | null | undefined): user is BiliUser;
  resumeDownloadRecoveryRelations(job: PersistentJobRecord, reason: string): void;
  abandonRecoveryJob(id: string, kinds: string[]): RecoveryActionResult;
  resolveLegacyDownloadFailureIssue(id: string, action: RecoveryIssueActionId, options: RecoveryActionOptions): Promise<RecoveryActionResult>;
  getRecoveryIssueSnapshot(): { issues: RecoveryIssue[] };
  dispatchPersistentJobs(): void;
  now(): number;
  generation(): number;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
function encodingPriority(value: unknown): unknown {
  const priority = record(value).priority;
  return Array.isArray(priority) ? priority[0] : undefined;
}
export function createDownloadRecoveryActions(deps: Dependencies) {
  function restartStrict(
    jobId: string,
    action: RecoveryIssueActionId,
    options: { encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    const job = deps.jobStore.findById(jobId);
    if (!job || job.kind !== "download") {
      return { ok: false as const, status: 404, message: "下载待处理项不存在或已恢复" };
    }
    const payload = job.payload;
    if (!payload.awaitingManualRecovery) {
      return ["pending", "retry_wait", "leased", "running"].includes(job.status)
        ? { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues }
        : { ok: false as const, status: 409, message: "下载任务状态已经变化，请刷新后重试" };
    }
    const quality = String(options.quality || "").trim().toUpperCase();
    const priority = isValidBBDownEncodingPriority(options.encodingPriority)
      ? normalizeBBDownEncodingPriority(options.encodingPriority)
      : undefined;
    const qualityEligible = record(payload.qualityFailure).qualityEligible === true;
    const encodingEligible = record(payload.qualityFailure).encodingEligible === true;
    if (quality && !isSelectableBilibiliQuality(quality)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    if (!quality && !priority) {
      return { ok: false as const, status: 400, message: "请选择画质或编码" };
    }
    const bvid = String(job.bvid || payload.bvid || "");
    const currentProfile = normalizeQualityArtifactProfile(
      record(payload.qualityProfile || qualityArtifactProfileFromConfig(deps.configStore.get())),
    );
    const currentEncoding = String((Array.isArray(record(payload.qualityEncodingOverride).priority) ? encodingPriority(payload.qualityEncodingOverride) : undefined) || currentProfile.encoding || "").toUpperCase();
    if (quality && quality !== currentProfile.quality && !qualityEligible) {
      return { ok: false as const, status: 409, message: "当前失败证据不能安全更换画质档位" };
    }
    if (priority && priority[0] !== currentEncoding && !encodingEligible) {
      return { ok: false as const, status: 409, message: "当前失败证据不能安全更换编码" };
    }
    const nextProfile = {
      ...currentProfile,
      ...(quality ? { quality } : {}),
      ...(priority ? { encoding: priority[0] } : {}),
    };
    const generation = Math.max(0, Number(payload.qualityRetryGeneration || 0), Number(record(payload.qualityEncodingOverride).generation || 0)) + 1;
    const artifactKey = crypto.createHash("sha256").update(JSON.stringify({
      sourceArtifactKey: String(payload.qualityArtifactKey || buildQualityArtifactKey(bvid, currentProfile)),
      generation,
      quality: quality || undefined,
      priority,
    })).digest("hex");
    const nextPayload: Record<string, unknown> = {
      ...payload,
      bvid,
      qualityProfile: nextProfile,
      qualityStrict: Boolean(quality) || payload.qualityStrict === true,
      qualityEncodingOverride: priority
        ? { generation, priority, strict: options.strict !== false }
        : payload.qualityEncodingOverride,
      qualityArtifactKey: artifactKey,
      qualityRetryGeneration: generation,
      awaitingManualRecovery: false,
      downloadRecovery: undefined,
      qualityFailure: undefined,
      manualRecoveryReason: undefined,
      lastRecoveryAction: action,
    };
    for (const key of ["downloadDir", "outputFiles", "error"]) delete nextPayload[key];
    const woken = deps.jobStore.wakeManualJob(job.id, nextPayload);
    if (!woken) return { ok: false as const, status: 409, message: "下载任务正在被其他操作处理，请刷新后重试" };
    const targetLabel = [quality, priority?.[0]].filter(Boolean).join(" / ");
    deps.resumeDownloadRecoveryRelations(job, `已按 ${targetLabel} 严格重新下载。`);
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "download",
      level: "info",
      summary: `已按 ${targetLabel} 严格重新下载 ${bvid}`,
      raw: `[Recovery] strict-download action=${action} generation=${generation}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
    return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
  }

  async function resolve(
    jobId: string,
    action: RecoveryIssueActionId,
    options: { userId?: unknown; encodingPriority?: unknown; strict?: unknown; quality?: unknown },
  ) {
    if (action === "abandon_attempt") {
      return deps.abandonRecoveryJob(jobId, ["download"]);
    }
    if (["redownload_with_encoding", "redownload_with_quality"].includes(action)) {
      if (deps.recoveryWork.locks.has(jobId)) return { ok: false as const, status: 409, message: "该下载任务正在被处理，请稍后刷新" };
      deps.recoveryWork.locks.add(jobId);
      try { return restartStrict(jobId, action, options); }
      finally { deps.recoveryWork.locks.delete(jobId); }
    }
    if (!["retry_download", "retry_download_with_account", "defer_download"].includes(action)) {
      return { ok: false as const, status: 400, message: "该下载待处理项不支持此操作" };
    }
    if (deps.recoveryWork.locks.has(jobId)) {
      return { ok: false as const, status: 409, message: "该下载任务正在被处理，请稍后刷新" };
    }
    deps.recoveryWork.locks.add(jobId);
    try {
      const epoch = deps.generation();
      const job = deps.jobStore.findById(jobId);
      if (!job || job.kind !== "download") {
        return { ok: false as const, status: 404, message: "下载待处理项不存在或已恢复" };
      }
      if (!(job.payload)?.awaitingManualRecovery) {
        return ["pending", "retry_wait", "leased", "running"].includes(job.status)
          ? { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues }
          : { ok: false as const, status: 409, message: "下载任务状态已经变化，请刷新后重试" };
      }

      const payload = job.payload;
      const expectedPayload = JSON.stringify(payload);
      const legacyFailureKey = String(payload.legacyFailureKey || "");
      if (legacyFailureKey && ["retry_download", "retry_download_with_account", "defer_download"].includes(action)) {
        const migrated = await deps.resolveLegacyDownloadFailureIssue(legacyFailureKey, action, options);
        if (!migrated.ok) return migrated;
        if (epoch !== deps.generation()) return { ok: false as const, status: 409, message: "恢复环境已经变化，请刷新后重试" };
        deps.jobStore.complete(job.id);
        return { ...migrated, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      let selectedUserId = String(payload.downloadUserId || payload.primaryUserId || job.userId || "");
      if (action === "retry_download_with_account") {
        const requestedUserId = String(options.userId || "");
        const user = requestedUserId ? deps.userStore.getById(requestedUserId) : null;
        if (!deps.isUserSyncEligible(user) || user.id === selectedUserId) {
          return { ok: false as const, status: 400, message: "请选择另一个当前可用的登录账号" };
        }
        try {
          const snapshot = await deps.videoAccessProbe(downloadCredentialsForUser(user), String(job.bvid || ""));
          if (!snapshot.available || snapshot.access.classification === "charging_restricted") {
            return { ok: false as const, status: 409, message: "所选账号当前无法访问这个视频，请换一个账号或稍后再试" };
          }
        } catch (error) {
          return {
            ok: false as const,
            status: 409,
            message: `所选账号访问检查失败：${sanitizeUploadText(readTaskFailure(error).message || error || "未知错误", 180)}`,
          };
        }
        selectedUserId = user.id;
      }

      const current = deps.jobStore.findById(job.id);
      if (epoch !== deps.generation() || !current || current.status !== job.status
        || current.attempts !== job.attempts || current.leaseOwner !== job.leaseOwner
        || JSON.stringify(current.payload) !== expectedPayload) {
        return { ok: false as const, status: 409, message: "下载任务已经变化，请刷新后重试" };
      }
      const deferred = action === "defer_download";
      const notBefore = deferred ? deps.now() + 24 * 60 * 60_000 : deps.now();
      const woken = deps.jobStore.wakeManualJob(job.id, {
        awaitingManualRecovery: false,
        downloadRecovery: undefined,
        downloadUserId: selectedUserId || undefined,
        manualRecoveryDeferredAt: deferred ? deps.now() : undefined,
        manualRecoveryDeferredUntil: deferred ? notBefore : undefined,
      }, notBefore);
      if (!woken) {
        return { ok: false as const, status: 409, message: "下载任务正在被其他操作处理，请刷新后重试" };
      }
      if (!deferred) {
        deps.resumeDownloadRecoveryRelations(job, "用户已从待处理中心重新启动下载。");
      }
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
        type: "download",
        level: "info",
        summary: deferred
          ? `下载任务已暂缓24小时 ${job.bvid || ""}`
          : `${action === "retry_download_with_account" ? "已换账号重新下载" : "已重新启动下载"} ${job.bvid || ""}`,
        raw: `[Recovery] download action=${action} deferred=${deferred} accountChanged=${action === "retry_download_with_account"}`,
        bvid: job.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      deps.dispatchPersistentJobs();
      return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
    } finally {
      deps.recoveryWork.locks.delete(jobId);
    }
  }

  return { resolve };
}
