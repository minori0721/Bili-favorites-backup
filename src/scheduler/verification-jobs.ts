import type { UploadTask } from '../tasks.js';
import type { EnqueuePersistentJob } from '../repositories/jobs.js';
import { UPLOAD_VERIFY_SCHEDULE_MS } from './retry-policy.js';

type VerificationSource = Pick<UploadTask, 'automaticRecoveryAttempts' | 'bvid' | 'cover' | 'downloadDir' | 'encodingRetry' | 'filenameMetadataByPath' | 'files' | 'folderTitle' | 'historyOnly' | 'historySnapshotAt' | 'mediaId' | 'partialBackup' | 'remotePath' | 'result' | 'sessionGeneration' | 'sessionId' | 'strictMediaTarget' | 'upperName' | 'userId' | 'videoTitle'>;

export function buildUploadVerificationJobs(task: VerificationSource, files: Array<{
    path: string;
    size?: number;
    verificationStatus?: string;
    putCompletedAt?: string;
    localRelativePath?: string;
    nextVerifyAt?: string;
  }>, pendingChecks?: Array<{ remoteFile: string; expectedSize: number; finalFile: string; localRelativePath: string }>): EnqueuePersistentJob[] {
    const pendingFiles = files.filter((file) => file.verificationStatus === "awaiting_verification" && typeof file.size === "number");
    const historySegment = task.historyOnly ? `history:${task.historySnapshotAt || "unknown"}` : "main";
    const sessionGeneration = task.result?.sessionGeneration ?? task.sessionGeneration;
    const totalPages = Math.max(1, task.files?.length || files.length);
    const verifiedPages = files.filter((file) => file.verificationStatus === "verified").length;
    const recoveryLifecycleState = verifiedPages > 0 && verifiedPages < totalPages ? "partial_upload" : "remote_visibility_wait";
    const attemptKey = task.sessionId ? `${task.sessionId}:g${sessionGeneration || 1}` : undefined;
    if (task.sessionId && pendingFiles.length > 0) {
      const first = pendingFiles[0];
      const pending = pendingChecks?.find((item) => item.finalFile === first.path || item.localRelativePath === first.localRelativePath);
      const initialNextAt = Math.min(...pendingFiles.map((file) => {
        const parsed = file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : Date.now() + UPLOAD_VERIFY_SCHEDULE_MS[0];
      }));
      return [{
        kind: "verify_upload",
        dedupeKey: `verify-session:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${historySegment}:${task.sessionId}:g${sessionGeneration || 1}`,
        bvid: task.bvid,
        userId: task.userId,
        mediaId: task.mediaId,
        priority: task.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: initialNextAt,
        payload: {
          remoteFile: pending?.remoteFile || first.path,
          finalFile: first.path,
          expectedSize: first.size,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          files: task.files || [],
          filenameMetadataByPath: task.filenameMetadataByPath,
          localRelativePath: first.localRelativePath,
          putCompletedAt: first.putCompletedAt || new Date().toISOString(),
          partialBackup: task.partialBackup,
          automaticRecoveryAttempts: Math.max(0, Number(task.automaticRecoveryAttempts || 0)),
          historyOnly: task.historyOnly,
          historySnapshotAt: task.historySnapshotAt,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
          sessionId: task.sessionId,
          sessionGeneration,
          sessionVerification: true,
          encodingRetry: task.encodingRetry,
          strictMediaTarget: task.strictMediaTarget,
          lifecycleState: recoveryLifecycleState,
          verifiedPages,
          totalPages,
          attemptKey,
        },
      }];
    }
    const inputs: EnqueuePersistentJob[] = [];
    for (const file of pendingFiles) {
      const pending = pendingChecks?.find((item) => item.finalFile === file.path || item.localRelativePath === file.localRelativePath);
      const verificationPath = pending?.remoteFile || file.path;
      inputs.push({
        kind: "verify_upload",
        dedupeKey: `verify:${task.userId || "video"}:${task.mediaId || 0}:${task.bvid}:${historySegment}:${verificationPath}`,
        bvid: task.bvid,
        userId: task.userId,
        mediaId: task.mediaId,
        priority: task.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now() + UPLOAD_VERIFY_SCHEDULE_MS[0],
        payload: {
          remoteFile: verificationPath,
          finalFile: file.path,
          expectedSize: file.size,
          localDir: task.downloadDir,
          remotePath: task.remotePath,
          files: task.files || [],
          filenameMetadataByPath: task.filenameMetadataByPath,
          localRelativePath: file.localRelativePath,
          putCompletedAt: file.putCompletedAt || new Date().toISOString(),
          partialBackup: task.partialBackup,
          historyOnly: task.historyOnly,
          historySnapshotAt: task.historySnapshotAt,
          folderTitle: task.folderTitle,
          videoTitle: task.videoTitle,
          upperName: task.upperName,
          cover: task.cover,
          sessionId: task.sessionId,
          sessionGeneration,
          encodingRetry: task.encodingRetry,
          strictMediaTarget: task.strictMediaTarget,
          lifecycleState: recoveryLifecycleState,
          verifiedPages,
          totalPages,
          attemptKey,
        },
      });
    }
    return inputs;
  }
