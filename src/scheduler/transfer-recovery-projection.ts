import type { JobRepository, EnqueuePersistentJob } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { StateManager, RemoteFileRecord } from '../state.js';
import type { ConfigStore } from '../config.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { RecoveryIssueKind } from '../recovery-policy.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import { classifyUploadError, REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE, sanitizeUploadText } from '../upload-health.js';
import { buildUploadFileMetadataFromSession } from '../download-session.js';
import { logManager } from '../logger.js';
import { safeErrorSummary } from '../diagnostics.js';
interface Dependencies {
  jobStore: Pick<JobRepository, 'normalizeStoppedRecovery' | 'listActiveTransferSessionKeys' | 'enqueueBatch'>;
  transferSessions: Pick<TransferSessionRepository, 'listRecoverablePage' | 'listFiles'>;
  stateManager: Pick<StateManager, 'getVideoMeta' | 'getRelationStatus'>;
  configStore: Pick<ConfigStore, 'get'>;
  now(): number;
  captureExistingArchiveProof(userId: string, mediaId: number | undefined, bvid: string): ExistingArchiveProof | undefined;
}
export function createTransferRecoveryProjection(deps: Dependencies) {
  let reconciledAt = 0;
  function reconcile(force = false) {
    const now = deps.now();
    if (!force && now - reconciledAt < 30_000) return 0;
    deps.jobStore.normalizeStoppedRecovery();

    const activeKeys = deps.jobStore.listActiveTransferSessionKeys();
    const inputs: EnqueuePersistentJob[] = [];
    const pageSize = 100;
    const maxProjected = 100;
    let offset = 0;
    for (;;) {
      const page = deps.transferSessions.listRecoverablePage(pageSize, offset);
      if (page.length === 0) break;
      offset += page.length;
      for (const session of page) {
        const generation = Math.max(1, Number(session.generation || 1));
        const attemptKey = `${session.id}:g${generation}`;
        if (activeKeys.has(attemptKey)) continue;

        const files = deps.transferSessions.listFiles(session.id, generation);
        const emptyAttempt = files.length === 0;
        const verifiedPages = files.filter((file) => file.status === "verified").length;
        // Do not stat every output while serving the recovery HTTP endpoint.
        // The worker performs the authoritative local-file check before any
        // upload or candidate operation.
        const localStatus = "unknown" as const;
        const allVerified = files.length > 0 && verifiedPages === files.length;
        const waitingRemote = allVerified || session.phase === "awaiting_remote"
          || files.some((file) => file.status === "awaiting_remote");
        const partialUpload = verifiedPages > 0 && verifiedPages < files.length;
        const failed = (session.phase === "failed" && !allVerified) || emptyAttempt;
        const classified = session.lastError
          ? classifyUploadError({ message: session.lastError }, "<remote>")
          : null;
        const errorText = String(session.lastError || "");
        const kind: RecoveryIssueKind = classified?.code === REMOTE_SINGLE_FILE_SIZE_LIMIT_CODE
          ? "remote_size_limit"
          : /编码|画质|BFB_ENCODING/i.test(errorText)
            ? "encoding_retry_failed"
            : /远端拒绝|写入结果|WebDAV|\b405\b/i.test(errorText)
              ? "remote_write_rejected"
            : "manual_review";
        const lifecycleState = failed
          ? "manual_required"
          : partialUpload
            ? "partial_upload"
            : waitingRemote
              ? "remote_visibility_wait"
              : "uploading";
        const assessment: RecoveryAssessment = {
          kind,
          checkedAt: now,
          localStatus,
          remoteStatus: waitingRemote ? "unknown" : "error",
          verifiedPages,
          summary: failed
            ? sanitizeUploadText(emptyAttempt ? "当前传输代次缺少分P清单，等待核对已有归档；不会重新上传。" : session.lastError || "上传候选没有对应的恢复任务，已安全暂停。", 300)
            : `上传候选已恢复到${verifiedPages}/${files.length}个分P；本地文件将在实际恢复前检查。`,
          ...(waitingRemote || emptyAttempt || verifiedPages === files.length ? { nextCheckAt: now + 2_000 } : {}),
        };
        let filenameMetadataByPath: Record<string, NonNullable<RemoteFileRecord["filenameMetadata"]>> | undefined;
        // A malformed session is recovery evidence failure, not an empty
        // metadata set. Abort projection so the persisted session remains
        // visible for manual repair instead of creating a partial job.
        filenameMetadataByPath = buildUploadFileMetadataFromSession(session.localDir, files.map((file) => file.relativePath));
        const meta = deps.stateManager.getVideoMeta(session.bvid);
        const relation = session.userId && session.mediaId !== undefined && Number.isInteger(session.mediaId)
          ? deps.stateManager.getRelationStatus(session.userId, session.mediaId, session.bvid)
          : null;
        let existingArchiveProof: ExistingArchiveProof | undefined;
        if (!session.historyOnly && session.userId && Number.isInteger(session.mediaId)) {
          // A failed proof read must stop projection; undefined means there is
          // no proof, while an exception means the recovery store is unhealthy.
          existingArchiveProof = deps.captureExistingArchiveProof(session.userId, session.mediaId, session.bvid);
        }
        inputs.push({
          kind: session.historyOnly ? "history_upload" : "upload",
          dedupeKey: `upload-session:${attemptKey}`,
          bvid: session.bvid,
          userId: session.userId,
          mediaId: session.mediaId,
          priority: failed ? 20 : 25,
          maxAttempts: deps.configStore.get().maxRetries + 1,
          initialStatus: failed ? "manual_wait" : "pending",
          payload: {
            bvid: session.bvid,
            localDir: session.localDir,
            remotePath: session.remotePath,
            userId: session.userId,
            mediaId: session.mediaId,
            files: files.map((file) => file.relativePath),
            filenameMetadataByPath,
            folderTitle: relation?.folderTitle || "",
            videoTitle: meta?.title || session.bvid,
            upperName: meta?.upperName || "",
            cover: meta?.cover || "",
            historyOnly: session.historyOnly,
            historySnapshotAt: session.historySnapshotAt,
            uploadIntent: session.historyOnly ? "history_upload" : "normal_backup",
            existingArchiveProof,
            sessionId: session.id,
            sessionGeneration: generation,
            sessionDedupeKey: session.dedupeKey,
            attemptKey,
            recoveryProjection: true,
            emptyAttempt,
            lifecycleState,
            recoveryReason: session.lastError || undefined,
            recoveryAssessment: assessment,
            awaitingManualRecovery: failed,
            resumeOnly: waitingRemote,
            partialBackup: partialUpload,
            verifiedPages,
            totalPages: files.length,
          },
        });
        activeKeys.add(attemptKey);
        if (inputs.length >= maxProjected) break;
      }
      if (inputs.length >= maxProjected || page.length < pageSize) break;
    }
    if (inputs.length === 0) { reconciledAt = now; return 0; }
    try {
      deps.jobStore.enqueueBatch(inputs);
      reconciledAt = now;
      logManager.push({
        timestamp: new Date(now).toISOString(),
        type: "system",
        level: "info",
        summary: `已补齐 ${inputs.length} 个上传候选恢复入口`,
        raw: `[Recovery] transfer session projection repaired count=${inputs.length}`,
        simpleVisible: true,
        debugVisible: true,
      });
      return inputs.length;
    } catch (error) {
      console.warn(`[Recovery] Failed to project transfer sessions: ${safeErrorSummary(error)}`);
      throw error;
    }
  }

  return { reconcile, reset: () => { reconciledAt = 0; } };
}
