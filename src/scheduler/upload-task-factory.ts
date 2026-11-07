import { UploadTask } from '../tasks.js';
import type { StateManager, FavoriteRelation } from '../state.js';
import type { ConfigStore } from '../config.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { parseStrictMediaTarget } from './recovery-context.js';
import type { RecoveryUploadItem } from './upload-work.js';
import { decodeUploadContentProof } from '../upload-content-proof.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'getRelationStatus' | 'markRemoteConflictArchived' | 'markUploading'>;
  configStore: Pick<ConfigStore, 'get'>;
  jobStore: Pick<JobRepository, 'findById' | 'updatePayload' | 'consumeUploadReuploadPermission'>;
  transferSessions: TransferSessionRepository;
  leaseOwner: string;
  generation(): number;
  captureExistingArchiveProof(userId: string | undefined, mediaId: number | undefined, bvid: string): ExistingArchiveProof | undefined;
  legacyConflictSideEffectsStarted(item: RecoveryUploadItem, relation: FavoriteRelation | null): boolean;
  restoreConflictCandidateExistingArchive(task: UploadTask): boolean;
}
export function createUploadTaskFactory(deps: Dependencies) {
  function build(item: RecoveryUploadItem) {
    const epoch = deps.generation();
    const assertCurrent = () => { if (epoch !== deps.generation()) throw new Error('Upload task belongs to an inactive runtime'); };
    const relationProof = item.userId && Number.isInteger(item.mediaId)
      ? deps.stateManager.getRelationStatus(item.userId, Number(item.mediaId), item.bvid)
      : null;
    const conflictArchiveOldFiles = item.conflictArchiveOldFiles || relationProof?.remoteFiles;
    const existingArchiveProof = item.encodingRetry
      ? item.existingArchiveProof
      : (item.existingArchiveProof || deps.captureExistingArchiveProof(item.userId, item.mediaId, item.bvid));
    const reuploadAuthorizedFiles = [...new Set((item.reuploadAuthorizedFiles
      || (item.allowReupload ? item.files || [] : []))
      .map((value) => String(value || "").replace(/\\/g, "/"))
      .filter(Boolean))];
    const uploadTask = new UploadTask(item.bvid, item.localDir, item.remotePath, deps.configStore.get(), {
      cleanupLocal: false,
      files: item.files,
      filenameMetadataByPath: item.filenameMetadataByPath,
      partialBackup: item.partialBackup,
      historyOnly: item.historyOnly,
      historySnapshotAt: item.historySnapshotAt,
      uploadIntent: item.uploadIntent || (item.historyOnly ? "history_upload" : "normal_backup"),
      existingArchiveProof,
      legacyConflictSideEffectsStarted: Boolean(
        item.legacyConflictSideEffectsStarted
        || deps.legacyConflictSideEffectsStarted(item, relationProof),
      ),
      conflictCandidateId: item.conflictCandidateId,
      conflictCandidateRemotePath: item.conflictCandidateRemotePath,
      conflictCandidateOnly: item.conflictCandidateOnly,
      conflictCandidateReasonCode: item.conflictCandidateReasonCode,
      conflictCandidateReasonSummary: item.conflictCandidateReasonSummary,
      transferSessionStore: deps.transferSessions,
      sessionId: item.sessionId,
      sessionGeneration: item.sessionGeneration,
      sessionDedupeKey: item.sessionDedupeKey,
      conflictArchiveSegment: item.conflictArchiveSegment,
      conflictArchiveRoot: item.remotePath,
      conflictArchiveOldFiles,
      conflictArchiveVerifiedPaths: item.conflictArchiveVerifiedPaths,
      allowReupload: item.allowReupload,
      reuploadAuthorizedFiles,
      resumeOnly: Boolean(item.resumeOnly || item.allowReupload || reuploadAuthorizedFiles.length > 0),
      encodingRetry: item.encodingRetry,
      strictMediaTarget: parseStrictMediaTarget(item.strictMediaTarget),
    });
    uploadTask.consumeReuploadPermission = (relativePath) => {
      assertCurrent();
      if (uploadTask.persistentJobId) {
        return deps.jobStore.consumeUploadReuploadPermission(uploadTask.persistentJobId, deps.leaseOwner, relativePath);
      }
      const normalized = String(relativePath || "").replace(/\\/g, "/");
      const index = uploadTask.reuploadAuthorizedFiles.indexOf(normalized);
      if (index < 0) return false;
      uploadTask.reuploadAuthorizedFiles.splice(index, 1);
      return true;
    };
    uploadTask.sharedDownloadDir = item.localDir;
    uploadTask.encodingRetry = item.encodingRetry;
    uploadTask.automaticRecoveryAttempts = item.automaticRecoveryAttempts;
    uploadTask.recoverySources = item.recoverySources;
    uploadTask.userId = item.userId;
    uploadTask.mediaId = item.mediaId;
    uploadTask.folderTitle = item.folderTitle;
    uploadTask.videoTitle = item.videoTitle || "";
    uploadTask.upperName = item.upperName || "";
    uploadTask.cover = item.cover || "";
    if (!item.historyOnly && item.userId && Number.isInteger(item.mediaId)) {
      uploadTask.onConflictArchiveTargetVerified = (file) => {
      assertCurrent();
        if (!uploadTask.conflictArchiveVerifiedPaths?.includes(file.archivedPath)) {
          uploadTask.conflictArchiveVerifiedPaths = [...(uploadTask.conflictArchiveVerifiedPaths || []), file.archivedPath];
        }
        if (!uploadTask.persistentJobId) return;
        const current = deps.jobStore.findById(uploadTask.persistentJobId);
        if (!current) return;
        deps.jobStore.updatePayload(uploadTask.persistentJobId, {
          ...current.payload,
          conflictArchiveVerifiedPaths: uploadTask.conflictArchiveVerifiedPaths,
        });
      };
      uploadTask.onConflictArchived = (archive) => {
      assertCurrent();
        deps.stateManager.markRemoteConflictArchived(item.bvid, item.userId, item.mediaId, archive);
      };
    }
    if (!item.historyOnly) {
      uploadTask.onUploading = () => {
      assertCurrent();
        deps.stateManager.markUploading(item.bvid, item.userId, item.mediaId);
        if (!uploadTask.persistentJobId) return;
        const current = deps.jobStore.findById(uploadTask.persistentJobId);
        if (!current) return;
        deps.jobStore.updatePayload(uploadTask.persistentJobId, {
          ...current.payload,
          lifecycleState: "uploading",
          userDisposition: undefined,
        });
      };
    }
    uploadTask.onTransferSession = (task, sessionId, sessionGeneration) => {
      assertCurrent();
      if (!task.persistentJobId) return;
      const live = deps.jobStore.findById(task.persistentJobId);
      if (!live || live.leaseOwner !== deps.leaseOwner || !["leased", "running"].includes(live.status)) {
        throw new Error("Upload task execution ownership changed before session binding");
      }
      const current = live.payload;
      if (!deps.jobStore.updatePayload(task.persistentJobId, {
        ...current,
        sessionId,
        sessionGeneration,
        attemptKey: `${sessionId}:g${sessionGeneration}`,
        uploadContentProof: current.sessionId === sessionId && current.sessionGeneration === sessionGeneration ? current.uploadContentProof : undefined,
        lifecycleState: current.conflictCandidateOnly ? "conflict_candidate" : "uploading",
      })) throw new Error("Upload task disappeared before session binding");
    };
    uploadTask.assertExecutionCurrent = () => {
      assertCurrent();
      if (!uploadTask.persistentJobId) return;
      const live = deps.jobStore.findById(uploadTask.persistentJobId);
      if (!live || live.leaseOwner !== deps.leaseOwner || !['leased', 'running'].includes(live.status)
        || (uploadTask.sessionId && (live.payload.sessionId !== uploadTask.sessionId
          || live.payload.sessionGeneration !== uploadTask.sessionGeneration))) throw new Error('Upload task execution ownership changed');
    };
    uploadTask.onTransferContent = (task, file) => {
      task.assertExecutionCurrent?.();
      if (!task.persistentJobId) return;
      const session = deps.transferSessions.assertGeneration(file.sessionId, file.generation);
      const expected = deps.transferSessions.getFile(session.id, file.relativePath, file.generation);
      if (!expected || session.phase === 'superseded' || expected.expectedSize !== file.size || expected.finalPath !== file.finalPath) throw new Error('Upload content no longer belongs to this file');
      const live = deps.jobStore.findById(task.persistentJobId)!;
      const previous = decodeUploadContentProof(live.payload.uploadContentProof);
      const files = previous?.sessionId === file.sessionId && previous.generation === file.generation ? previous.files : [];
      const { sessionId, generation, ...content } = file;
      if (!deps.jobStore.updatePayload(live.id, { ...live.payload, uploadContentProof: {
        sessionId, generation, files: [...files.filter(item => item.relativePath !== content.relativePath), content],
      } })) throw new Error('Upload task disappeared before content checkpoint');
    };
    uploadTask.onConflictCandidateUploading = (task) => {
      assertCurrent();
      deps.restoreConflictCandidateExistingArchive(task);
      if (!task.persistentJobId) return;
      const current = deps.jobStore.findById(task.persistentJobId);
      if (!current) return;
      deps.jobStore.updatePayload(task.persistentJobId, {
        ...current.payload,
        lifecycleState: "conflict_candidate",
      });
    };
    return uploadTask;
  }

  return { build };
}
