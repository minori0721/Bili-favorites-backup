import { UploadTask } from '../tasks.js';
import type { StateManager, FavoriteRelation } from '../state.js';
import type { ConfigStore } from '../config.js';
import type { PersistentJobStore } from '../job-store.js';
import type { TransferSessionStore } from '../transfer-session.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import { parseStrictMediaTarget } from './recovery-context.js';
import type { RecoveryUploadItem } from './upload-work.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'getRelationStatus' | 'markRemoteConflictArchived' | 'markUploading'>;
  configStore: Pick<ConfigStore, 'get'>;
  jobStore: Pick<PersistentJobStore, 'findById' | 'updatePayload' | 'consumeUploadReuploadPermission'>;
  transferSessions: TransferSessionStore;
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
        lifecycleState: current.conflictCandidateOnly ? "conflict_candidate" : "uploading",
      })) throw new Error("Upload task disappeared before session binding");
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
