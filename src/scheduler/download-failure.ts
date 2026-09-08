import { DownloadTask, QualityUpgradeDownloadTask, type UploadTarget, type QualityUpgradeTask } from '../tasks.js';
import type { PersistentJobStore } from '../job-store.js';
import type { StateManager } from '../state.js';
import type { ConfigStore } from '../config.js';
import { computeTaskRetryDelayMs } from '../queue.js';
import { logManager } from '../logger.js';
import { sanitizeUploadText, type UploadFailureInfo } from '../upload-health.js';
import { classifyDownloadRecoveryFailure } from '../download-recovery.js';
import { readDownloadSession, strictEncodingDiagnosticPatch, strictQualityDiagnosticPatch } from '../download-session.js';
import { isSourceUnavailableFailure } from './access-rules.js';
import { serializeQualityUpgrade } from './quality-rules.js';
import { readTaskFailure, taskUploadFailure } from './task-failure.js';

type Download = DownloadTask | QualityUpgradeDownloadTask;
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'complete' | 'updatePayload' | 'parkManualRecovery' | 'defer' | 'retry' | 'retryDownloadWithManualFallback'>;
  stateManager: Pick<StateManager, 'markDownloadInterrupted' | 'markRelationRetryPending' | 'markFailed'>;
  configStore: Pick<ConfigStore, 'get'>;
  retirementAbortedJobIds: Pick<Set<string>, 'delete'>;
  leaseOwner: string;
  now(): number;
  dispatchPersistentJobs(): void;
  handleSourceUnavailableTask(task: Download, error: unknown): unknown;
  handleEncodingRetryDownloadError(task: DownloadTask, error: unknown): void;
  handleChargingRestrictedTask(task: Download, error: unknown): void;
  handleDownloadApiFailure(task: Download, error: unknown): number | undefined;
  syncQualityUpgradeControl(task: QualityUpgradeDownloadTask, status: QualityUpgradeTask['status']): void;
  queueAutomaticQualityRecovery(id: string, failure: UploadFailureInfo): boolean;
  collectUploadTargets(bvid: string, fallback: UploadTarget[]): UploadTarget[];
  makeSingleTarget(task: DownloadTask): UploadTarget[];
}

export function createDownloadFailureHandler(dependencies: Dependencies) {
  const deps = { ...dependencies, serializeQualityUpgrade };
  const logTaskError = (task: Download, error: ReturnType<typeof readTaskFailure>) =>
    console.error('[Queue] Task ' + task.name + ' ' + (error.deferToNextCycle ? 'deferred to next cycle' : 'permanently failed') + ': ' + sanitizeUploadText(error.message || error));
  return (task: DownloadTask | QualityUpgradeDownloadTask, rawError: unknown) => {
      const error = readTaskFailure(rawError);
      if (isSourceUnavailableFailure(rawError)) {
        deps.handleSourceUnavailableTask(task, rawError);
        return;
      }
      if (task instanceof DownloadTask && task.encodingRetry) {
        deps.handleEncodingRetryDownloadError(task, rawError);
        return;
      }
      if (error?.chargingRestricted) {
        deps.handleChargingRestrictedTask(task, rawError);
        return;
      }
      if (task.persistentJobId && deps.retirementAbortedJobIds.delete(task.persistentJobId)) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "system",
          level: "info",
          summary: `账号已退役，下载会话未执行自动清理 ${task.bvid}`,
          raw: `[Account] credential-dependent task stopped without recording a download failure: ${task.bvid}`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        deps.dispatchPersistentJobs();
        return;
      }
      const safeTaskError = sanitizeUploadText(error.message || rawError, 1_000);
      logTaskError(task, error);
      const apiRetryAt = deps.handleDownloadApiFailure(task, rawError);
      if (task instanceof QualityUpgradeDownloadTask) {
        task.control.error = rawError instanceof Error ? rawError : new Error(String(rawError));
        if (task.persistentJobId) {
          const downloadFailure = classifyDownloadRecoveryFailure(rawError);
          const qualityFailure = {
            stage: "download",
            category: downloadFailure.category,
            summary: downloadFailure.summary,
            encodingEligible: downloadFailure.recoverable
              && /(?:codec|encoding|编码|hevc|av1|avc|视频流|video\s*stream|no available video)/i.test(downloadFailure.summary),
            qualityEligible: Boolean(error?.qualityValidation),
            occurredAt: deps.now(),
            ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
            ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
          };
          const qualityPayload = { ...deps.serializeQualityUpgrade(task.control), qualityFailure };
          deps.jobStore.updatePayload(task.persistentJobId, qualityPayload);
          if (error?.permanent && !downloadFailure.recoverable) {
            deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
            deps.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, rawError);
          } else if (error?.permanent) {
            deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, downloadFailure.summary, {
              ...qualityPayload,
              awaitingManualRecovery: true,
            });
            deps.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, rawError);
          } else if (apiRetryAt) {
            task.control.qualityStageLabel = "B站风控冷却后重试下载新版";
            deps.syncQualityUpgradeControl(task, "retry_wait");
            deps.jobStore.defer(task.persistentJobId, deps.leaseOwner, sanitizeUploadText(error.message || rawError), apiRetryAt);
          } else {
            const job = task.persistentJob;
            const retryAt = Date.now() + computeTaskRetryDelayMs(deps.configStore.get().retryDelaySeconds, Number(job?.attempts || 0), error?.retryAfterMs);
            const result = deps.jobStore.retry(task.persistentJobId, deps.leaseOwner, sanitizeUploadText(error.message || rawError), retryAt);
            const automaticRecovery = result.exhausted
              ? deps.queueAutomaticQualityRecovery(task.persistentJobId, taskUploadFailure(rawError, task.bvid))
              : false;
            deps.syncQualityUpgradeControl(task, result.exhausted && !automaticRecovery ? "error" : "retry_wait");
            if (result.exhausted && !automaticRecovery) task.control.onFailed?.(task.control, rawError);
          }
          deps.dispatchPersistentJobs();
          return;
        }
        deps.syncQualityUpgradeControl(task, "error");
        task.control.error = rawError instanceof Error ? rawError : new Error(String(rawError));
        task.control.onFailed?.(task.control, rawError);
        return;
      }
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "error",
        summary: `下载失败 ${task.bvid}: ${safeTaskError}${error?.permanent ? "（已停止自动重试）" : (error?.deferToNextCycle ? "（下一轮再试）" : "")}`,
        raw: `[Queue] Task ${task.name} ${error?.deferToNextCycle ? "deferred to next cycle" : "permanently failed"}: ${safeTaskError}`,
        bvid: task.bvid,
        simpleVisible: true,
      });
      const downloadFailure = classifyDownloadRecoveryFailure(rawError);
      const targets = deps.collectUploadTargets(task.bvid, task.targets || deps.makeSingleTarget(task));
      const session = task.downloadDir ? readDownloadSession(task.downloadDir) : null;
      if (task.downloadDir && session && (!error?.permanent || downloadFailure.recoverable)) {
        deps.stateManager.markDownloadInterrupted(task.bvid, task.downloadDir, safeTaskError || "Download failure", targets);
      } else {
        for (const target of targets) {
          deps.stateManager.markRelationRetryPending(task.bvid, target.userId, target.mediaId, safeTaskError || "Download failure");
          deps.stateManager.markFailed(
            target.userId,
            task.bvid,
            target.mediaId,
            safeTaskError || "Download failure",
            Boolean(error?.permanent && !downloadFailure.recoverable),
          );
        }
      }
      if (task.persistentJobId) {
        const recoveryPayload = {
          awaitingManualRecovery: true,
          downloadRecovery: {
            category: downloadFailure.category,
            kind: downloadFailure.kind,
            summary: downloadFailure.summary,
            occurredAt: deps.now(),
            downloadUserId: task.downloadUserId || task.userId,
            targets: targets.map((target) => ({ ...target })),
          },
          ...(task.qualityStrict || task.qualityEncodingOverride?.strict
            ? {
              qualityFailure: {
                stage: "download",
                category: downloadFailure.category,
                summary: downloadFailure.summary,
                qualityEligible: Boolean(task.qualityStrict && error?.qualityValidation),
                encodingEligible: Boolean(task.qualityEncodingOverride?.strict && error?.encodingValidation),
                ...(error?.qualityAssessment ? strictQualityDiagnosticPatch(error.qualityAssessment) : {}),
                ...(error?.encodingAssessment ? strictEncodingDiagnosticPatch(error.encodingAssessment) : {}),
                occurredAt: deps.now(),
              },
            }
            : {}),
        };
        if (error?.permanent && !downloadFailure.recoverable) {
          deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        } else if (apiRetryAt) {
          deps.jobStore.defer(task.persistentJobId, deps.leaseOwner, sanitizeUploadText(error.message || rawError), apiRetryAt);
        } else if (error?.permanent) {
          deps.jobStore.parkManualRecovery(
            task.persistentJobId,
            deps.leaseOwner,
            sanitizeUploadText(error.message || rawError),
            recoveryPayload,
          );
        } else {
          const job = task.persistentJob;
          const retryIndex = Number(job?.attempts || 0);
          const retryAt = Date.now() + computeTaskRetryDelayMs(
            deps.configStore.get().retryDelaySeconds,
            retryIndex,
            error?.retryAfterMs
          );
          const result = deps.jobStore.retryDownloadWithManualFallback(
            task.persistentJobId,
            deps.leaseOwner,
            sanitizeUploadText(error.message || rawError),
            retryAt,
            recoveryPayload,
          );
          if (result.exhausted) {
            for (const target of targets) {
              deps.stateManager.markFailed(target.userId, task.bvid, target.mediaId, safeTaskError || "Download failure", false);
            }
          }
        }
      }
      deps.dispatchPersistentJobs();
    };
}
