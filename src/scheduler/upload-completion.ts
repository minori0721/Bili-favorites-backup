import { UploadTask, QualityUpgradeUploadReplaceTask, QualityUpgradeReplaceTask, QualityUpgradeCleanupTask, type EncodingRetryContext } from '../tasks.js';
import type { PersistentJobStore, EnqueuePersistentJob } from '../job-store.js';
import type { StateManager } from '../state.js';
import type { ConfigStore } from '../config.js';
import type { UploadCircuitBreaker } from '../upload-health.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import { serializeQualityUpgrade } from './quality-rules.js';
import { markHistoryGroupUploaded } from '../download-session.js';
import { logManager } from '../logger.js';

type QualityUploadPhaseTask = QualityUpgradeUploadReplaceTask | QualityUpgradeReplaceTask | QualityUpgradeCleanupTask;
type Result = NonNullable<UploadTask['result']>;
function isQualityUploadPhaseTask(task: unknown): task is QualityUploadPhaseTask {
  return task instanceof QualityUpgradeUploadReplaceTask || task instanceof QualityUpgradeReplaceTask || task instanceof QualityUpgradeCleanupTask;
}
interface Dependencies {
  jobStore: Pick<PersistentJobStore, 'complete' | 'completeAndEnqueue' | 'enqueue' | 'parkManualRecovery' | 'completeEncodingRetryCommit' | 'transitionEncodingRetryChildren'>;
  stateManager: Pick<StateManager, 'clearUploadCooldown' | 'restoreExistingArchiveProof' | 'markUploadFailed' | 'recordRemoteConflictCandidate' | 'runAtomic' | 'markVerifiedUpload' | 'resolveRemoteConflictCandidate' | 'markUploadedPendingVerification'>;
  configStore: Pick<ConfigStore, 'get'>;
  uploadCircuit: Pick<UploadCircuitBreaker, 'recordSuccess'>;
  downloadQueue: { poke(): void };
  localCleanup: { request(bvid: string, dir: string): unknown };
  leaseOwner: string;
  now(): number;
  isEncodingRetryParentActive(context: EncodingRetryContext): boolean;
  dispatchPersistentJobs(): void;
  uploadTaskKey(task: UploadTask | QualityUploadPhaseTask): string;
  clearUploadProbeTimer(): void;
  syncQualityUpgradeControl(task: QualityUploadPhaseTask, status: 'pending' | 'completed'): void;
  refreshLocalCacheState(): void;
  finishEncodingRetryFailure(bvid: string, context: EncodingRetryContext, reason: string, remoteStatus?: RecoveryAssessment['remoteStatus'], childJobId?: string, kind?: RecoveryAssessment['kind'], patch?: Record<string, unknown>): void;
  supersedeUploadTaskSession(task: UploadTask): void;
  afterEncodingRetryCommitted(bvid: string, context: EncodingRetryContext): void;
  restoreConflictCandidateExistingArchive(task: UploadTask): boolean;
  commitVerifiedTransfer(task: UploadTask, result: Result, partial: boolean, history?: boolean, retry?: EncodingRetryContext): void;
  buildUploadVerificationJobs(task: UploadTask, files: Result['files'], checks?: Result['pendingChecks']): EnqueuePersistentJob[];
  enqueueUploadVerificationJobs(task: UploadTask, files: Result['files'], checks?: Result['pendingChecks']): unknown;
}

/** Keeps archive decisions and each synchronous completion transaction together. */
export function createUploadCompletionHandler(dependencies: Dependencies) {
  const deps = { ...dependencies, serializeQualityUpgrade };
  return (task: UploadTask | QualityUploadPhaseTask) => {
      const encodingRetry = task instanceof UploadTask ? task.encodingRetry : undefined;
      if (encodingRetry && !deps.isEncodingRetryParentActive(encodingRetry)) {
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        deps.dispatchPersistentJobs();
        return;
      }
      const taskKey = deps.uploadTaskKey(task);
      if (deps.uploadCircuit.recordSuccess(taskKey)) {
        deps.stateManager.clearUploadCooldown();
        deps.clearUploadProbeTimer();
      }
      if (isQualityUploadPhaseTask(task)) {
        if (task instanceof QualityUpgradeUploadReplaceTask || task instanceof QualityUpgradeReplaceTask) {
          const nextJob: EnqueuePersistentJob = task instanceof QualityUpgradeUploadReplaceTask
            ? { kind: "quality_replace", dedupeKey: `quality-replace:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 30, maxAttempts: deps.configStore.get().maxRetries + 1, payload: deps.serializeQualityUpgrade(task.control, task.control.target, task.control.targets) }
            : { kind: "quality_cleanup", dedupeKey: `quality-cleanup:${task.control.target.userId}:${task.control.target.mediaId}:${task.bvid}`, bvid: task.bvid, userId: task.control.target.userId, mediaId: task.control.target.mediaId, priority: 60, maxAttempts: deps.configStore.get().maxRetries + 1, payload: deps.serializeQualityUpgrade(task.control, task.control.target, task.control.targets) };
          if (task.persistentJobId) {
            const transitioned = deps.jobStore.completeAndEnqueue(task.persistentJobId, deps.leaseOwner, [nextJob]);
            if (!transitioned) throw new Error("Quality phase execution ownership changed before transition");
          } else deps.jobStore.enqueue(nextJob);
          deps.syncQualityUpgradeControl(task, "pending");
        } else {
          // Cleanup commits archive proof, cleanup authorization and its job in
          // onCompletedUpgrade; do not complete the same job a second time.
          deps.syncQualityUpgradeControl(task, "completed");
          if (task.control.downloadDir) void deps.localCleanup.request(task.bvid, task.control.downloadDir);
          deps.refreshLocalCacheState();
        }
        deps.dispatchPersistentJobs();
        return;
      }
      if (task.result?.disposition === "retained_existing_archive" && task.result.retainedProof) {
        if (encodingRetry) {
          deps.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            "替换上传发现仍有可用的旧归档，未把未确认候选标记为成功。",
            "verified",
            task.persistentJobId,
          );
          return;
        }
        const restored = deps.stateManager.restoreExistingArchiveProof(
          task.bvid,
          task.userId,
          task.mediaId,
          task.result.retainedProof,
        );
        if (!restored) {
          deps.stateManager.markUploadFailed(
            task.bvid,
            task.downloadDir,
            task.userId,
            task.mediaId,
            "Existing archive proof was verified remotely but could not be restored to the relation.",
          );
        } else {
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `已保留旧归档，未上传或替换新版 ${task.bvid}`,
            raw: `[Upload] retained existing archive; local candidate superseded; files=${task.result.retainedProof.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
        }
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        if (restored) void deps.localCleanup.request(task.bvid, task.downloadDir);
        deps.dispatchPersistentJobs();
        return;
      }
      if (task.result?.disposition === "conflict_candidate" && task.result.conflictCandidate) {
        const candidate = {
          ...task.result.conflictCandidate,
          files: task.result.files.map((file) => ({ ...file })),
          verifiedAt: new Date().toISOString(),
        };
        const summary = `检测到远端冲突，新文件已安全上传到独立候选目录；正式旧路径未移动、覆盖或删除`;
        deps.stateManager.recordRemoteConflictCandidate(task.bvid, task.userId, task.mediaId, {
          id: candidate.id,
          originalRemotePath: candidate.originalRemotePath,
          candidateRemotePath: candidate.candidateRemotePath,
          reasonCode: candidate.reasonCode,
          reasonSummary: candidate.reasonSummary,
          files: candidate.files,
          existingArchiveProof: candidate.existingArchiveProof,
        });
        const completeExisting = candidate.existingArchiveProof?.status === "verified";
        const completeCandidate = !task.partialBackup;
        if (!completeExisting) {
          deps.stateManager.runAtomic(() => {
            deps.stateManager.markVerifiedUpload(
              task.bvid,
              candidate.candidateRemotePath,
              candidate.files,
              task.userId,
              task.mediaId,
              task.partialBackup,
            );
            deps.stateManager.resolveRemoteConflictCandidate(
              task.bvid,
              task.userId,
              task.mediaId,
              candidate.id,
              "selected_candidate",
            );
            deps.supersedeUploadTaskSession(task);
            if (encodingRetry) {
              if (!task.persistentJobId || !deps.jobStore.completeEncodingRetryCommit(
                encodingRetry.parentJobId,
                encodingRetry.generation,
                task.persistentJobId,
                deps.leaseOwner,
              )) throw new Error("Encoding retry conflict candidate changed before commit");
            } else if (task.persistentJobId && !deps.jobStore.complete(task.persistentJobId, deps.leaseOwner)) {
              throw new Error("Conflict candidate upload execution changed before commit");
            }
          });
          if (encodingRetry) deps.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          else {
            void deps.localCleanup.request(task.bvid, task.downloadDir);
            deps.dispatchPersistentJobs();
          }
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `冲突候选已验证并自动采用 ${task.bvid}，未删除其他远端文件`,
            raw: `[Upload] conflict candidate automatically selected; files=${candidate.files.length}; reason=${candidate.reasonCode}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }        const retainedExisting = deps.restoreConflictCandidateExistingArchive(task);
        if (!completeCandidate) {
          deps.stateManager.resolveRemoteConflictCandidate(
            task.bvid,
            task.userId,
            task.mediaId,
            candidate.id,
            "kept_existing",
          );
          deps.supersedeUploadTaskSession(task);
          const retainedSummary = "新候选仅包含部分可用内容，系统已继续保留完整旧归档；两份远端文件均未删除。";
          if (encodingRetry) {
            deps.finishEncodingRetryFailure(
              task.bvid,
              encodingRetry,
              retainedSummary,
              "verified",
              task.persistentJobId,
            );
          } else {
            if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
            void deps.localCleanup.request(task.bvid, task.downloadDir);
            deps.dispatchPersistentJobs();
          }
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "info",
            summary: `新候选不完整，已自动保留旧归档 ${task.bvid}`,
            raw: `[Upload] partial conflict candidate retained existing archive; files=${candidate.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }
        if (encodingRetry) {
          deps.finishEncodingRetryFailure(
            task.bvid,
            encodingRetry,
            "替换文件已安全放入冲突候选目录，正式归档未被覆盖；请选择现有归档或新候选。",
            "verified",
            task.persistentJobId,
            "conflict_candidate_ready",
            { conflictCandidate: candidate },
          );
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "warn",
            summary: `编码替换产生冲突候选 ${task.bvid}：请在待处理中心选择` ,
            raw: `[EncodingRetry] conflict candidate ready; files=${candidate.files.length}`,
            bvid: task.bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          return;
        }
        if (task.persistentJobId) {
          deps.jobStore.parkManualRecovery(task.persistentJobId, deps.leaseOwner, summary, {
            awaitingManualRecovery: true,
            allowReupload: false,
            resumeOnly: true,
            conflictCandidate: candidate,
            recoveryAssessment: {
              kind: "conflict_candidate_ready",
              checkedAt: deps.now(),
              localStatus: "available",
              remoteStatus: "verified",
              summary,
            },
          });
        }
        if (!retainedExisting) {
          deps.stateManager.markUploadFailed(task.bvid, task.downloadDir, task.userId, task.mediaId, summary);
        }
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `远端冲突候选已就绪 ${task.bvid}：请选择保留现有归档或采用候选`,
          raw: `[Upload] conflict candidate ready; files=${candidate.files.length}; reason=${candidate.reasonCode}`,
          bvid: task.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        deps.dispatchPersistentJobs();
        return;
      }
      if (encodingRetry) {
        if (!task.result?.files.length) {
          deps.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "替换下载文件未产生可验证的上传结果；未执行归档替换。", "error", task.persistentJobId);
          return;
        }
        if (task.result.allVerified) {
          deps.commitVerifiedTransfer(task, task.result, task.partialBackup, false, encodingRetry);
          deps.afterEncodingRetryCommitted(task.bvid, encodingRetry);
          return;
        }
        if (!task.persistentJobId) throw new Error("Encoding retry verification transition requires a persistent child job");
        const verificationInputs = deps.buildUploadVerificationJobs(task, task.result.files, task.result.pendingChecks);
        if (verificationInputs.length === 0) {
          deps.finishEncodingRetryFailure(task.bvid, encodingRetry,
            "替换上传完成，但没有建立远端确认任务；未将候选提交为正式归档。", "unknown", task.persistentJobId);
          return;
        }
        deps.stateManager.runAtomic(() => {
          deps.stateManager.markUploadedPendingVerification(task.bvid, task.result!.remotePath, task.result!.files,
            task.userId, task.mediaId, task.partialBackup);
          const transitioned = deps.jobStore.transitionEncodingRetryChildren(
            encodingRetry.parentJobId,
            encodingRetry.generation,
            task.persistentJobId!,
            deps.leaseOwner,
            "verifying",
            verificationInputs,
          );
          if (!transitioned) throw new Error("Encoding retry upload changed before verification transition");
        });
        deps.dispatchPersistentJobs();
        return;
      }
      if (task.historyOnly) {
        if (task.result?.files.length && task.historySnapshotAt && task.result.allVerified) {
          deps.commitVerifiedTransfer(task, task.result, task.partialBackup, true);
          markHistoryGroupUploaded(task.downloadDir, task.historySnapshotAt, `${task.userId || "video"}:${task.mediaId || 0}`);
        } else if (task.result?.files.length) {
          deps.enqueueUploadVerificationJobs(task, task.result.files, task.result.pendingChecks);
        }
        if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
        if (task.result?.allVerified) void deps.localCleanup.request(task.bvid, task.downloadDir);
        deps.dispatchPersistentJobs();
        return;
      }
      if (task.result?.files.length && task.result.allVerified) {
        deps.commitVerifiedTransfer(task, task.result, task.partialBackup);
      } else if (task.result?.files.length) {
        deps.stateManager.markUploadedPendingVerification(
          task.bvid,
          task.result.remotePath,
          task.result.files,
          task.userId,
          task.mediaId,
          task.partialBackup
        );
        deps.enqueueUploadVerificationJobs(task, task.result.files);
      } else {
        deps.stateManager.markUploadFailed(
          task.bvid,
          task.downloadDir,
          task.userId,
          task.mediaId,
          "Upload finished without verified remote metadata."
        );
      }
      if (task.persistentJobId) deps.jobStore.complete(task.persistentJobId, deps.leaseOwner);
      if (task.result?.files.length && task.result.allVerified) {
        void deps.localCleanup.request(task.bvid, task.downloadDir);
      }
      deps.downloadQueue.poke();
      deps.dispatchPersistentJobs();
    };
}
