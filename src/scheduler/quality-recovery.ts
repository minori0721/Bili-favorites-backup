import crypto from 'node:crypto';
import { isValidBBDownEncodingPriority, normalizeBBDownEncodingPriority, type BBDownEncoding, type ConfigStore } from '../config.js';
import type { UserStore, BiliUser } from '../users.js';
import type { PersistentJobStore } from '../job-store.js';
import type { PersistentJobRecord } from '../database.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig, buildQualityArtifactKey } from '../quality-artifact.js';
import { isSelectableBilibiliQuality } from '../media-metadata.js';
import { qualityTargetsFromPayload, resolveQualityUpgradeTarget } from './quality-rules.js';
import type { RecoveryIssue } from './recovery-contracts.js';
import { logManager } from '../logger.js';
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'findById' | 'restartFailedQualityAsDownload'>;
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  qualityQualityRetryEligibility(job: PersistentJobRecord): { eligible: boolean; reason: string };
  qualityEncodingRetryEligibility(job: PersistentJobRecord): { eligible: boolean; reason: string };
  isUserSyncEligible(user: BiliUser | null | undefined): user is BiliUser;
  now(): number;
  dispatchPersistentJobs(): void;
  getRecoveryIssueSnapshot(): { issues: RecoveryIssue[] };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createQualityRecovery(deps: Dependencies) {
  function restart(
    jobId: string,
    options: { priority?: BBDownEncoding[]; strictEncoding?: boolean; quality?: string },
  ) {
    const job = deps.jobStore.findById(jobId);
    if (!job) return { ok: false as const, status: 404, message: "画质重调任务不存在或已恢复" };
    const qualityRetry = String(options.quality || "").trim().toUpperCase();
    const priority = options.priority && isValidBBDownEncodingPriority(options.priority)
      ? normalizeBBDownEncodingPriority(options.priority)
      : undefined;
    if (qualityRetry && !isSelectableBilibiliQuality(qualityRetry)) {
      return { ok: false as const, status: 400, message: "不支持的画质档位" };
    }
    if (!qualityRetry && !priority) {
      return { ok: false as const, status: 400, message: "请选择画质或编码" };
    }
    const payload = job.payload;
    const encodingOverride = record(payload.qualityEncodingOverride);
    const bvid = String(job.bvid || payload.bvid || "");
    const allTargets = qualityTargetsFromPayload(payload);
    const selectedTarget = resolveQualityUpgradeTarget(job, payload, allTargets);
    const targets = job.kind === "quality_upload" && selectedTarget ? [selectedTarget] : allTargets;
    if (!bvid || targets.length === 0) {
      return { ok: false as const, status: 409, message: "画质重调目标已经变化，请刷新后重试" };
    }
    const generation = Math.max(
      0,
      Number(encodingOverride.generation || 0),
      Number(payload.qualityRetryGeneration || 0),
    ) + 1;
    const currentProfile = normalizeQualityArtifactProfile(record(payload.qualityProfile || qualityArtifactProfileFromConfig(deps.configStore.get())));
    const currentEncoding = String((Array.isArray(encodingOverride.priority) ? encodingOverride.priority[0] : undefined) || currentProfile.encoding || "").toUpperCase();
    if (qualityRetry && qualityRetry !== currentProfile.quality) {
      const eligibility = deps.qualityQualityRetryEligibility(job);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能换分辨率重调：${eligibility.reason}` };
      }
    }
    if (priority && priority[0] !== currentEncoding) {
      const eligibility = deps.qualityEncodingRetryEligibility(job);
      if (!eligibility.eligible) {
        return { ok: false as const, status: 409, message: `当前不能换编码重调：${eligibility.reason}` };
      }
    }
    const qualityProfile = {
      ...currentProfile,
      ...(qualityRetry ? { quality: qualityRetry } : {}),
      ...(priority ? { encoding: priority[0] } : {}),
    };
    const strictEncoding = Boolean(priority && options.strictEncoding);
    const artifactKey = crypto.createHash("sha256").update(JSON.stringify({
      sourceArtifactKey: String(payload.artifactKey || buildQualityArtifactKey(bvid, qualityProfile)),
      generation,
      priority,
      strictEncoding,
      quality: qualityRetry || undefined,
      jobId,
    })).digest("hex");
    const target = targets[0];
    const nextPayload: Record<string, unknown> = {
      ...payload,
      bvid,
      userId: target.userId,
      mediaId: target.mediaId,
      folderTitle: target.folderTitle,
      target,
      targets,
      targetCount: targets.length,
      artifactKey,
      qualityProfile,
      qualityStrict: Boolean(qualityRetry) || Boolean(payload.qualityStrict),
      qualityEncodingOverride: priority
        ? { generation, priority, strict: strictEncoding }
        : payload.qualityEncodingOverride,
      qualityRetryGeneration: generation,
      qualityStageLabel: `等待按 ${[qualityRetry, priority?.[0]].filter(Boolean).join(" / ")}${qualityRetry && priority ? "（仅此组合）" : qualityRetry ? "（仅此画质）" : "（仅此编码）"}下载新版`,
      awaitingManualRecovery: false,
      automaticQualityRecoveryAttempts: 0,
      supersededQualityArtifactKey: payload.artifactKey,
      supersededQualityLocalDir: payload.downloadDir,
    };
    for (const key of [
      "runId",
      "downloadDir",
      "outputFiles",
      "uploadResult",
      "backupFiles",
      "finalFiles",
      "stageRemotePath",
      "backupRemotePath",
      "qualityFailure",
      "error",
      "qualityTargetResolution",
    ]) {
      delete nextPayload[key];
    }
    const downloadUserId = String(payload.downloadUserId || target.userId || "");
    const downloadUser = deps.userStore.getById(downloadUserId);
    if (!deps.isUserSyncEligible(downloadUser)) {
      return { ok: false as const, status: 409, message: "原下载账号当前不可用，请先恢复账号后再重调" };
    }
    nextPayload.downloadUserId = downloadUser.id;
    const replacement = deps.jobStore.restartFailedQualityAsDownload(job.id, {
      kind: "quality_download",
      dedupeKey: `quality-download:${bvid}:${artifactKey}`,
      bvid,
      userId: downloadUser.id,
      mediaId: target.mediaId,
      priority: 35,
      maxAttempts: deps.configStore.get().maxRetries + 1,
      payload: nextPayload,
    });
    if (!replacement.ok) {
      return { ok: false as const, status: 409, message: "画质重调任务状态已经变化，请刷新后重试" };
    }
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "download",
      level: "info",
      summary: `已按 ${[qualityRetry, priority?.[0]].filter(Boolean).join(" / ")} 重新建立画质重调 ${bvid}`,
      raw: `[QualityRecovery] restart mode=profile generation=${generation} strictQuality=${Boolean(qualityRetry)} strictEncoding=${strictEncoding} targets=${targets.length}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
    return { ok: true as const, jobId: replacement.job.id, issues: deps.getRecoveryIssueSnapshot().issues };
  }
  return { restart };
}
