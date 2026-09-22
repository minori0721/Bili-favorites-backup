import { DownloadTask, QualityUpgradeDownloadTask, type QualityUpgradeTask } from '../tasks.js';
import type { StateManager, SourceAvailabilityReason } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import { readDownloadSession, markDownloadSessionStatus } from '../download-session.js';
import { normalizeSourceAvailabilityReason } from './access-rules.js';
import { computeAvailabilityUnavailableDelayMs, computeChargingRecheckDelayMs } from './retry-policy.js';
import type { serializeQualityUpgrade } from './quality-rules.js';
import { logManager } from '../logger.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'listRelationsForBvid' | 'getSourceAvailability' | 'markAvailabilityConfirmedUnavailable' | 'markChargingRestricted'>;
  jobStore: Pick<JobRepository, 'complete' | 'completeEncodingRetryParent' | 'cancelEncodingRetryChildren' | 'updatePayload' | 'defer'>;
  leaseOwner: string;
  now(): number;
  random(): number;
  syncQualityUpgradeControl(task: QualityUpgradeDownloadTask, status: string): void;
  serializeQualityUpgrade(task: QualityUpgradeTask): ReturnType<typeof serializeQualityUpgrade>;
  enqueueAvailabilityProbe(bvid: string, input: { preferredUserId?: string; notBefore: number; availabilityRound: number; availabilityReason: SourceAvailabilityReason }): unknown;
  enqueueChargingAccessProbe(bvid: string, input: { preferredUserId: string; skipUserIds: string[]; checkedAccountUids: string[]; previewAvailable?: boolean; notBefore: number }): unknown;
  dispatchPersistentJobs(): void;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createAccessFailureHandlers(deps: Dependencies) {
  function handleSourceUnavailableTask(
    task: DownloadTask | QualityUpgradeDownloadTask,
    error: { availabilityReason?: unknown } = {},
  ) {
    const checkedAtMs = deps.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const reason = normalizeSourceAvailabilityReason(error.availabilityReason
      || (task instanceof DownloadTask ? task.availabilityReason : task.control.availabilityReason));

    if (task instanceof DownloadTask && task.encodingRetry) {
      if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      const completed = deps.jobStore.completeEncodingRetryParent(
        task.encodingRetry.parentJobId,
        task.encodingRetry.generation,
      );
      deps.jobStore.cancelEncodingRetryChildren(task.encodingRetry.parentJobId, task.encodingRetry.generation);
      if (completed) {
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站源当前不可用，已结束本次规格替换 ${task.bvid}`,
          raw: `[Availability] strict_candidate_ended bvid=${task.bvid} archiveReplacement=not_started`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
      }
      deps.dispatchPersistentJobs();
      return;
    }

    if (task instanceof QualityUpgradeDownloadTask) {
      if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      task.control.qualityStage = "download";
      task.control.qualityStageLabel = "B站源当前不可用，本次画质重调已停止；未执行归档替换";
      task.control.error = undefined;
      deps.syncQualityUpgradeControl(task, "completed");
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "info",
        summary: `B站源当前不可用，已结束本次画质重调 ${task.bvid}`,
        raw: `[Availability] quality_candidate_ended bvid=${task.bvid} archiveReplacement=not_started`,
        bvid: task.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      deps.dispatchPersistentJobs();
      return;
    }

    if (task.downloadDir) {
      const session = readDownloadSession(task.downloadDir);
      if (session.kind === "valid" && session.manifest.outputs.length === 0) {
        markDownloadSessionStatus(task.downloadDir, "failed", "B站源当前不可用，已停止重复下载。");
      }
    }
    if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
    const relations = deps.stateManager.listRelationsForBvid(task.bvid);
    const shouldProbe = relations.some((relation) => relation.activeInFavorite
      && relation.sourceKind !== "manual"
      && !relation.selfVisible
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const previous = deps.stateManager.getSourceAvailability(task.bvid);
    const nextAt = checkedAtMs + computeAvailabilityUnavailableDelayMs(0, task.bvid);
    deps.stateManager.markAvailabilityConfirmedUnavailable(
      task.bvid,
      reason,
      checkedAt,
      shouldProbe ? new Date(nextAt).toISOString() : undefined,
      shouldProbe ? 1 : 0,
    );
    if (shouldProbe) {
      deps.enqueueAvailabilityProbe(task.bvid, {
        preferredUserId: task.userId,
        notBefore: nextAt,
        availabilityRound: 1,
        availabilityReason: reason,
      });
    }
    if (previous?.state !== "confirmed_unavailable" && previous?.state !== "dormant") {
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "warn",
        summary: `B站视频当前不可用，已停止重复下载 ${task.bvid}`,
        raw: `[Availability] download_stopped bvid=${task.bvid} automaticProbe=${shouldProbe}`,
        bvid: task.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    deps.dispatchPersistentJobs();
  }

  function handleChargingRestrictedTask(task: DownloadTask | QualityUpgradeDownloadTask, rawError: unknown) {
    const checkedAtMs = deps.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const error = record(rawError);
    const access = record(error.access);
    const checkedUid = String(error?.accountUid || (task instanceof QualityUpgradeDownloadTask ? task.control.cookie : task.cookie)?.DedeUserID || "");
    const previewValue = access.previewAvailable ?? access.isUgcPayPreview;
    const previewAvailable = typeof previewValue === 'boolean' ? previewValue : undefined;
    deps.stateManager.markChargingRestricted(task.bvid, {
      checkedAt,
      nextCheckAt: checkedAt,
      previewAvailable,
      checkedAccountUids: checkedUid ? [checkedUid] : [],
    });

    if (task instanceof QualityUpgradeDownloadTask) {
      task.control.qualityStageLabel = "充电视频，等待权限检查";
      deps.syncQualityUpgradeControl(task, "retry_wait");
      if (task.persistentJobId) {
        deps.jobStore.updatePayload(task.persistentJobId, deps.serializeQualityUpgrade(task.control));
        deps.jobStore.defer(
          task.persistentJobId,
          deps.leaseOwner,
          "Charging-exclusive video requires access",
          checkedAtMs + computeChargingRecheckDelayMs(deps.random)
        );
      }
    } else if (task.persistentJobId) {
      deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
    }

    const preferredUserId = String(task.persistentJob?.payload?.primaryUserId || task.userId || "");
    deps.enqueueChargingAccessProbe(task.bvid, {
      preferredUserId,
      skipUserIds: task.userId ? [task.userId] : [],
      checkedAccountUids: checkedUid ? [checkedUid] : [],
      previewAvailable,
      notBefore: checkedAtMs,
    });
    logManager.push({
      timestamp: checkedAt,
      type: "download",
      level: "info",
      summary: `识别为充电视频 ${task.bvid}，已停止无效下载`,
      raw: `[ChargingAccess] restricted bvid=${task.bvid} checkedAccounts=${checkedUid ? 1 : 0} next=immediate-account-sweep`,
      bvid: task.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
  }

  return { handleSourceUnavailableTask, handleChargingRestrictedTask };
}
