import { DownloadTask, QualityUpgradeDownloadTask, type QualityUpgradeTask, type QualityUpgradeTarget, type UploadTarget, type EncodingRetryContext, type StrictMediaTarget } from '../tasks.js';
import { assessStrictEncoding, assessStrictQuality, createStrictEncodingValidationError, StrictQualityValidationError, markDownloadSessionStatus, strictEncodingDiagnosticPatch, strictQualityDiagnosticPatch, readDownloadSession, writeDownloadSession, historySessionGroups, buildUploadFileMetadataFromSession } from '../download-session.js';
import type { PersistentJobStore, EnqueuePersistentJob } from '../job-store.js';
import type { ConfigStore } from '../config.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { serializeQualityUpgrade, qualityTargetsFromPayload } from './quality-rules.js';
import { joinRemotePath } from '../utils.js';

interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'complete' | 'findById' | 'parkManualRecovery' | 'completeAndEnqueue' | 'enqueueBatch' | 'transitionEncodingRetryChildren'>;
  configStore: Pick<ConfigStore, 'get'>;
  leaseOwner: string;
  now(): number;
  handleSourceUnavailableTask(task: DownloadTask | QualityUpgradeDownloadTask, error: { availabilityReason?: unknown }): unknown;
  isEncodingRetryParentActive(context: EncodingRetryContext): boolean;
  dispatchPersistentJobs(): void;
  refreshLocalCacheState(): void;
  syncQualityUpgradeControl(task: QualityUpgradeDownloadTask, status: 'error'): void;
  filterArchiveDeletionTargets(bvid: string, targets: QualityUpgradeTarget[]): QualityUpgradeTarget[];
  collectUploadTargets(bvid: string, fallback: UploadTarget[]): UploadTarget[];
  makeSingleTarget(task: DownloadTask): UploadTarget[];
  finishEncodingRetryFailure(bvid: string, context: EncodingRetryContext, reason: string, remoteStatus?: RecoveryAssessment['remoteStatus'], childJobId?: string, kind?: RecoveryAssessment['kind'], patch?: Record<string, unknown>): void;
  buildPersistentUploadJob(item: RecoveryUploadItem): EnqueuePersistentJob;
  queueUploadWork(item: RecoveryUploadItem, dispatch: boolean): unknown;
  historySnapshotSegment(value: string): string;
  localCleanup: { request(bvid: string, dir: string): unknown };
}

/** Download-to-upload transitions, including strict candidate evidence, have one owner. */
export function createDownloadCompletionHandler(dependencies: Dependencies) {
  const deps = { ...dependencies, serializeQualityUpgrade, qualityTargetsFromPayload };
  return (task: DownloadTask | QualityUpgradeDownloadTask) => {
      if ((task instanceof DownloadTask && task.sourceUnavailable)
        || (task instanceof QualityUpgradeDownloadTask && task.control.sourceUnavailable)) {
        deps.handleSourceUnavailableTask(
          task,
          { availabilityReason: task instanceof DownloadTask
            ? task.availabilityReason
            : task.control.availabilityReason },
        );
        return;
      }
      if (task instanceof DownloadTask && task.encodingRetry && !deps.isEncodingRetryParentActive(task.encodingRetry)) {
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        deps.dispatchPersistentJobs();
        return;
      }
      deps.refreshLocalCacheState();
      if (task instanceof QualityUpgradeDownloadTask) {
        const strictEncoding = task.control.qualityEncodingOverride?.strict
          ? task.control.qualityEncodingOverride.priority[0]
          : undefined;
        if (strictEncoding && task.control.downloadDir) {
          const assessment = assessStrictEncoding(task.control.downloadDir, strictEncoding, task.control.outputFiles);
          if (assessment.status !== "matched") {
            const error = createStrictEncodingValidationError(assessment, "upload_preflight");
            markDownloadSessionStatus(task.control.downloadDir, "failed", error.message);
            task.control.error = error;
            const qualityPayload = {
              ...deps.serializeQualityUpgrade(task.control),
              awaitingManualRecovery: true,
              qualityFailure: {
                stage: "download",
                category: "tool",
                code: error.code,
                summary: assessment.summary,
                encodingEligible: true,
                occurredAt: deps.now(),
                ...strictEncodingDiagnosticPatch(assessment),
              },
            };
            if (task.persistentJobId) {
              deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, assessment.summary, qualityPayload);
            }
            task.control.qualityStageLabel = "编码不可用，等待选择";
            deps.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
            deps.dispatchPersistentJobs();
            return;
          }
        }
        const strictQuality = task.control.qualityStrict ? task.control.qualityProfile.quality : undefined;
        if (strictQuality && task.control.downloadDir) {
          const assessment = assessStrictQuality(task.control.downloadDir, strictQuality, task.control.outputFiles);
          if (assessment.status !== "matched") {
            const error = new StrictQualityValidationError(assessment, "upload_preflight");
            markDownloadSessionStatus(task.control.downloadDir, "failed", error.message);
            task.control.error = error;
            const qualityPayload = {
              ...deps.serializeQualityUpgrade(task.control),
              awaitingManualRecovery: true,
              qualityFailure: {
                stage: "download",
                category: "tool",
                code: error.code,
                summary: assessment.summary,
                qualityEligible: true,
                occurredAt: deps.now(),
                ...strictQualityDiagnosticPatch(assessment),
              },
            };
            if (task.persistentJobId) {
              deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, assessment.summary, qualityPayload);
            }
            task.control.qualityStageLabel = "画质不可用，等待选择";
            deps.syncQualityUpgradeControl(task, "error");
            task.control.onFailed?.(task.control, error);
            deps.dispatchPersistentJobs();
            return;
          }
        }
        task.control.qualityStage = "upload";
        task.control.qualityStageLabel = "等待上传替换";
        const persisted = task.persistentJobId ? deps.jobStore.findById(task.persistentJobId) : null;
        const targets = deps.filterArchiveDeletionTargets(
          task.bvid,
          deps.qualityTargetsFromPayload(persisted?.payload, task.control.targets),
        );
        task.control.setTargets(targets);
        if (task.control.downloadDir) {
          const manifest = readDownloadSession(task.control.downloadDir);
          if (manifest?.qualityUpgrade && manifest.bvid === task.bvid) {
            manifest.qualityUpgrade = {
              ...manifest.qualityUpgrade,
              ...targets[0],
              artifactKey: task.control.artifactKey,
              qualityProfile: task.control.qualityProfile,
              downloadUserId: task.control.downloadUserId,
              targets,
            };
            writeDownloadSession(task.control.downloadDir, manifest);
          }
        }
        const nextJobs: EnqueuePersistentJob[] = targets.map((target) => ({
          kind: "quality_upload",
          dedupeKey: `quality-upload:${target.userId}:${target.mediaId}:${task.bvid}`,
          bvid: task.bvid, userId: target.userId, mediaId: target.mediaId, priority: 30,
          maxAttempts: deps.configStore.get().maxRetries + 1,
          payload: deps.serializeQualityUpgrade(task.control, target, task.control.targets),
        }));
        if (task.persistentJobId) {
          const transitioned = deps.jobStore.completeAndEnqueue(task.persistentJobId, deps.leaseOwner, nextJobs);
          if (!transitioned) throw new Error("Quality download execution ownership changed before transition");
        } else deps.jobStore.enqueueBatch(nextJobs);
        deps.dispatchPersistentJobs();
        return;
      }
      if (!task.downloadDir) {
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        return;
      }
      const targets = deps.collectUploadTargets(task.bvid, task.targets || deps.makeSingleTarget(task));
      const encodingRetry = task.encodingRetry;
      if (encodingRetry?.strict) {
        const assessment = assessStrictEncoding(task.downloadDir, encodingRetry.priority[0], task.outputFiles);
        if (assessment.status !== "matched") {
          const error = createStrictEncodingValidationError(assessment, "upload_preflight");
          markDownloadSessionStatus(task.downloadDir, "failed", error.message);
          deps.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            assessment.summary,
            assessment.status === "mismatch" ? "mismatch" : "unknown",
            task.persistentJobId,
            "encoding_retry_failed",
            strictEncodingDiagnosticPatch(assessment),
          );
          return;
        }
      }
      if (encodingRetry?.quality) {
        const assessment = assessStrictQuality(task.downloadDir, encodingRetry.quality, task.outputFiles);
        if (assessment.status !== "matched") {
          const error = new StrictQualityValidationError(assessment, "upload_preflight");
          markDownloadSessionStatus(task.downloadDir, "failed", error.message);
          deps.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            assessment.summary,
            assessment.status === "mismatch" ? "mismatch" : "unknown",
            task.persistentJobId,
            "encoding_retry_failed",
            strictQualityDiagnosticPatch(assessment),
          );
          return;
        }
      }
      const historyGroups = encodingRetry ? [] : historySessionGroups(task.downloadDir);
      const strictMediaTarget: StrictMediaTarget = {
        quality: task.qualityStrict ? task.qualityProfile?.quality : undefined,
        encoding: task.qualityEncodingOverride?.strict ? task.qualityEncodingOverride.priority[0] : undefined,
      };
      const persistedStrictMediaTarget = strictMediaTarget.quality || strictMediaTarget.encoding
        ? strictMediaTarget
        : undefined;
      if (encodingRetry) {
        if (!task.persistentJobId) throw new Error("Encoding retry download transition requires a persistent child job");
        const uploadInputs = targets.map((target) => deps.buildPersistentUploadJob({
          bvid: task.bvid,
          localDir: task.downloadDir!,
          remotePath: target.remotePath,
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: task.videoTitle || "",
          upperName: task.upperName || "",
          cover: task.cover || "",
          files: task.outputFiles,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(task.downloadDir!, task.outputFiles),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          encodingRetry,
          strictMediaTarget: persistedStrictMediaTarget,
        }));
        if (uploadInputs.length === 0) {
          deps.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "候选下载已完成，但当前收藏来源无法建立替换上传任务；未执行归档替换。",
            "unknown", task.persistentJobId);
          return;
        }
        const transitioned = deps.jobStore.transitionEncodingRetryChildren(
          encodingRetry.parentJobId,
          encodingRetry.generation,
          task.persistentJobId,
          deps.leaseOwner,
          "uploading",
          uploadInputs,
        );
        if (!transitioned) {
          deps.dispatchPersistentJobs();
          return;
        }
        deps.dispatchPersistentJobs();
        return;
      }
      for (const target of targets) {
        deps.queueUploadWork({
          bvid: task.bvid,
          localDir: task.downloadDir!,
          remotePath: target.remotePath,
          userId: target.userId,
          mediaId: target.mediaId,
          folderTitle: target.folderTitle,
          videoTitle: task.videoTitle || "",
          upperName: task.upperName || "",
          cover: task.cover || "",
          files: task.outputFiles,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(task.downloadDir!, task.outputFiles),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          strictMediaTarget: persistedStrictMediaTarget,
        }, false);
        for (const history of historyGroups) {
          deps.queueUploadWork({
            bvid: task.bvid,
            localDir: task.downloadDir!,
            remotePath: joinRemotePath(target.remotePath, "_history", deps.historySnapshotSegment(history.snapshotAt)),
            userId: target.userId,
            mediaId: target.mediaId,
            folderTitle: target.folderTitle,
            videoTitle: task.videoTitle || "",
            upperName: task.upperName || "",
            cover: task.cover || "",
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
            automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          }, false);
        }
      }
      if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      if (targets.length === 0) void deps.localCleanup.request(task.bvid, task.downloadDir);
      deps.dispatchPersistentJobs();
    };
}
