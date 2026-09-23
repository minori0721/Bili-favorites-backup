import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore, AppConfig } from '../config.js';
import type { BiliUser } from '../users.js';
import type { StateManager, FavoriteRelation } from '../state.js';
import type { JobRepository, EnqueuePersistentJob } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import { readDownloadSession, groupDownloadSessionHistory, buildUploadFileMetadataFromSession } from '../download-session.js';
import { joinRemotePath } from '../utils.js';
import { logManager } from '../logger.js';
import { UPLOAD_VERIFY_SCHEDULE_MS } from './retry-policy.js';
import type { RecoveryUploadItem } from './upload-work.js';
type ResolvedRelation = { user: BiliUser; mediaId: number; folderTitle: string };
type VerificationCandidate = {
  notBefore: number; sessionId: string; sessionGeneration: number; bvid: string; userId: string; mediaId: number;
  historySegment: string; historyOnly?: boolean;
} & Record<string, unknown>;

function readRecoveryManifest(localDir: string, verified = false) {
  const session = readDownloadSession(localDir);
  if (session.kind === 'invalid') {
    const identity = path.basename(localDir);
    logManager.push({
      timestamp: new Date().toISOString(), type: 'system', level: 'warn',
      summary: verified
        ? `本地清单损坏，远端归档状态已保留；历史文件身份无法确认，请人工处理：${identity}`
        : `下载清单损坏，已保留并等待重新探测：${identity}`,
      raw: `[Recovery] corrupt download manifest retained id=${identity} reason=${session.reason}${session.field ? ` field=${session.field}` : ''}`,
      simpleVisible: true, debugVisible: true,
    });
    return null;
  }
  return session.kind === 'valid' ? session.manifest : null;
}

interface Dependencies {
  stateManager: Pick<StateManager, 'listStaleActiveBackups' | 'runBatch' | 'markDownloadInterrupted' | 'markUploadFailed' | 'resetRelationForRetry' | 'hasPersistentJobBootstrap' | 'normalizePersistedWorkForRecovery' | 'listBackupsToResume' | 'listPendingUploadVerifications' | 'getRelationStatus' | 'getVideoMeta' | 'markPersistentJobBootstrapComplete' | 'listUploadFailuresForRecoveryPage'>;
  jobStore: Pick<JobRepository, 'hasJobsForBvid' | 'enqueue' | 'countRecoverable' | 'enqueueBatch'>;
  transferSessions: Pick<TransferSessionRepository, 'listFiles' | 'findForTarget'>;
  configStore: Pick<ConfigStore, 'get'>;
  staleActiveBackupMs: number;
  resolveRelation(relation: FavoriteRelation): ResolvedRelation | null;
  findBestRelationForBvid(bvid: string): ResolvedRelation | null;
  resolveRelationRemotePath(user: BiliUser, mediaId: number, title: string, config?: AppConfig): string;
  enqueueIfNeeded(user: BiliUser, mediaId: number, title: string, bvid: string, options?: { persisted?: boolean }): boolean;
  queueUploadWork(item: RecoveryUploadItem): unknown;
  buildPersistentUploadJob(item: RecoveryUploadItem): EnqueuePersistentJob;
  historySnapshotSegment(snapshotAt: string): string;
  ensurePersistedAvailabilityProbes(): void;
  ensurePersistedChargingAccessProbes(): void;
  dispatchPersistentJobs(): void;
  recordQueued(): void;
}
export function createStartupRecovery(deps: Dependencies) {
  function recoverStaleActiveBackups() {
    const items = deps.stateManager.listStaleActiveBackups(deps.staleActiveBackupMs);
    deps.stateManager.runBatch(() => {
      for (const item of items) {
        const relation = item.relation;
        if (deps.jobStore.hasJobsForBvid(relation.bvid)) continue;
        const resolved = deps.resolveRelation(relation);
        if (!resolved) continue;

        const localDir = item.video.localDir;
        if (localDir && fs.existsSync(localDir)) {
          const manifest = readRecoveryManifest(localDir);
          if (!manifest || (manifest.status !== "complete" && manifest.status !== "partial")) {
            deps.stateManager.markDownloadInterrupted(relation.bvid, localDir, "Stale download session queued for resume.", [{ userId: relation.userId, mediaId: relation.mediaId }]);
            deps.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid, { persisted: true });
            continue;
          }
          const remotePath = relation.remotePath || item.video.remotePath || deps.resolveRelationRemotePath(resolved.user, relation.mediaId, resolved.folderTitle);
          deps.stateManager.markUploadFailed(relation.bvid, localDir, relation.userId, relation.mediaId, "Stale upload retained locally and queued for upload retry.");
          const historyTargetKey = `${relation.userId}:${relation.mediaId}`;
          const historyGroups = groupDownloadSessionHistory(manifest)
            .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
            .filter((group) => group.files.length > 0);
          const baseUpload: RecoveryUploadItem = {
            bvid: relation.bvid,
            localDir,
            remotePath,
            userId: relation.userId,
            mediaId: relation.mediaId,
            folderTitle: resolved.folderTitle,
            videoTitle: item.video.title,
            upperName: item.video.upperName,
            cover: item.video.cover,
            files: manifest?.outputs.map((output) => output.relativePath),
            filenameMetadataByPath: manifest ? buildUploadFileMetadataFromSession(localDir, manifest.outputs.map((output) => output.relativePath)) : undefined,
            partialBackup: manifest?.status === "partial",
            priority: true,
          };
          deps.queueUploadWork(baseUpload);
          for (const history of historyGroups) {
            deps.queueUploadWork({
              ...baseUpload,
              remotePath: joinRemotePath(remotePath, "_history", deps.historySnapshotSegment(history.snapshotAt)),
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
          continue;
        }

        deps.stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Active backup state became stale and was re-queued.");
        const queued = deps.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, relation.bvid);
        if (queued) deps.recordQueued();
      }
    });
  }


  function resumePersistedWork() {
    deps.ensurePersistedAvailabilityProbes();
    deps.ensurePersistedChargingAccessProbes();
    // Verified local evidence must be inspected on every startup, independently
    // of the one-time persistent queue bootstrap and legacy cache migration.
    for (const item of deps.stateManager.listBackupsToResume()) {
      const status = item.relation?.backupStatus || item.video.backupStatus;
      if (['verified', 'partial_verified'].includes(status) && item.video.localDir) {
        readRecoveryManifest(item.video.localDir, true);
      }
    }
    if (deps.stateManager.hasPersistentJobBootstrap()) {
      recoverOrphanedUploadFailures();
      return;
    }
    deps.stateManager.normalizePersistedWorkForRecovery();
    const statusPriority: Record<string, number> = {
      upload_failed: 0,
      uploading: 1,
      downloaded: 2,
      queued: 3,
      downloading: 4,
      missing: 5,
    };
    const items = deps.stateManager.listBackupsToResume().sort((left, right) => {
      const leftStatus = left.relation?.backupStatus || left.video.backupStatus;
      const rightStatus = right.relation?.backupStatus || right.video.backupStatus;
      return (statusPriority[leftStatus] ?? 99) - (statusPriority[rightStatus] ?? 99);
    });
    for (const item of items) {
      const entry = item.video;
      const relation = item.relation;
      const resolved = relation ? deps.resolveRelation(relation) : deps.findBestRelationForBvid(entry.bvid);
      const status = relation?.backupStatus || entry.backupStatus;
      const localDir = entry.localDir;
      const hasLocalDir = Boolean(localDir && fs.existsSync(localDir));
      if (!resolved) continue;
      const config = deps.configStore.get();
      const remotePath = relation?.remotePath || entry.remotePath || deps.resolveRelationRemotePath(resolved.user, relation?.mediaId || 0, resolved.folderTitle, config);
      if (["verified", "partial_verified"].includes(status) && hasLocalDir && localDir && relation) {
        const session = readDownloadSession(localDir);
        if (session.kind !== 'valid') continue;
        const manifest = session.manifest;
        const targetKey = `${relation.userId}:${relation.mediaId}`;
        const pendingHistory = groupDownloadSessionHistory(manifest)
          .map((group) => ({
            ...group,
            files: group.files.filter((file) => !(file.uploadedTargets || []).includes(targetKey)),
          }))
          .filter((group) => group.files.length > 0);
        if (pendingHistory.length > 0) {
          for (const history of pendingHistory) {
            deps.queueUploadWork({
              bvid: entry.bvid,
              localDir,
              remotePath: joinRemotePath(remotePath, "_history", deps.historySnapshotSegment(history.snapshotAt)),
              userId: relation.userId,
              mediaId: relation.mediaId,
              folderTitle: resolved.folderTitle,
              videoTitle: entry.title,
              upperName: entry.upperName,
              cover: entry.cover,
              files: history.files.map((file) => file.relativePath),
              historyOnly: true,
              historySnapshotAt: history.snapshotAt,
              priority: false,
            });
          }
        }
        continue;
      }
      if (["downloaded", "uploading", "upload_failed"].includes(status) && hasLocalDir && localDir) {
        const manifest = readRecoveryManifest(localDir);
        if (!manifest || !["complete", "partial"].includes(manifest.status)) {
          deps.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
          continue;
        }
        const uploadItem: RecoveryUploadItem = {
          bvid: entry.bvid,
          localDir,
          remotePath,
          userId: resolved.user.id,
          mediaId: resolved.mediaId,
          folderTitle: resolved.folderTitle,
          videoTitle: entry.title,
          upperName: entry.upperName,
          cover: entry.cover,
          files: manifest.outputs.map((output) => output.relativePath),
          filenameMetadataByPath: buildUploadFileMetadataFromSession(localDir, manifest.outputs.map((output) => output.relativePath)),
          partialBackup: manifest.status === "partial",
          priority: true,
        };
        deps.queueUploadWork(uploadItem);
        const historyTargetKey = `${resolved.user.id}:${resolved.mediaId}`;
        const historyGroups = groupDownloadSessionHistory(manifest)
          .map((group) => ({ ...group, files: group.files.filter((file) => !(file.uploadedTargets || []).includes(historyTargetKey)) }))
          .filter((group) => group.files.length > 0);
        for (const history of historyGroups) {
          deps.queueUploadWork({
            ...uploadItem,
            remotePath: joinRemotePath(remotePath, "_history", deps.historySnapshotSegment(history.snapshotAt)),
            files: history.files.map((file) => file.relativePath),
            historyOnly: true,
            historySnapshotAt: history.snapshotAt,
            priority: false,
          });
        }
        continue;
      }
      deps.enqueueIfNeeded(resolved.user, resolved.mediaId, resolved.folderTitle, entry.bvid, { persisted: true });
    }

    const sessionFilesCache = new Map<string, ReturnType<TransferSessionRepository["listFiles"]>>();
    const sessionVerificationJobs = new Map<string, VerificationCandidate>();
    // Bootstrap is synchronous: enqueuing jobs does not mutate these source rows,
    // so stable ordered offset pages traverse the same set without a hard cap.
    function* pendingVerifications() {
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const page = deps.stateManager.listPendingUploadVerifications(pageSize, offset);
        yield* page;
        if (page.length < pageSize) return;
      }
    }
    for (const pending of pendingVerifications()) {
      const relation = deps.stateManager.getRelationStatus(pending.userId, pending.mediaId, pending.bvid);
      const resolved = relation ? deps.resolveRelation(relation) : null;
      const manifest = pending.localDir ? readRecoveryManifest(pending.localDir) : null;
      for (const file of pending.files) {
        if (typeof file.size !== "number") continue;
        const transferSession = deps.transferSessions.findForTarget(pending.userId, pending.mediaId, pending.bvid, file.path);
        const transferSessionKey = transferSession ? `${transferSession.id}:g${transferSession.generation}` : "";
        const transferFiles = transferSession
          ? (sessionFilesCache.get(transferSessionKey) || (() => {
            const listed = deps.transferSessions.listFiles(transferSession.id, transferSession.generation);
            sessionFilesCache.set(transferSessionKey, listed);
            return listed;
          })())
          : [];
        const transferFile = transferSession
          ? transferFiles.find((candidate) => candidate.finalPath === file.path)
          : undefined;
        const verificationPath = transferFile?.finalPath || file.path;
        if (transferSession) {
          const historySegment = transferSession.historyOnly ? `history:${transferSession.historySnapshotAt || "unknown"}` : "main";
          const candidate = {
            sessionId: transferSession.id,
            sessionGeneration: transferSession.generation,
            bvid: pending.bvid,
            userId: pending.userId,
            mediaId: pending.mediaId,
            remoteFile: verificationPath,
            finalFile: file.path,
            expectedSize: file.size,
            localDir: pending.localDir || transferSession.localDir,
            remotePath: pending.remotePath || transferSession.remotePath,
            files: manifest?.outputs.map((output) => output.relativePath) || transferFiles.map((entry) => entry.relativePath),
            filenameMetadataByPath: manifest
              ? buildUploadFileMetadataFromSession(pending.localDir || transferSession.localDir, manifest.outputs.map((output) => output.relativePath))
              : undefined,
            partialBackup: Boolean(pending.partialBackup),
            localRelativePath: file.localRelativePath,
            putCompletedAt: file.putCompletedAt || (transferFile?.putAcceptedAt ? new Date(transferFile.putAcceptedAt).toISOString() : new Date().toISOString()),
            notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now(),
            folderTitle: resolved?.folderTitle || "",
            videoTitle: deps.stateManager.getVideoMeta(pending.bvid)?.title || pending.bvid,
            historyOnly: transferSession.historyOnly,
            historySnapshotAt: transferSession.historySnapshotAt,
            historySegment,
          };
          const existing = sessionVerificationJobs.get(transferSessionKey);
          if (!existing || candidate.notBefore < existing.notBefore) sessionVerificationJobs.set(transferSessionKey, candidate);
          continue;
        }

        deps.jobStore.enqueue({
          kind: "verify_upload",
          dedupeKey: `verify:${pending.userId}:${pending.mediaId}:${pending.bvid}:main:${verificationPath}`,
          bvid: pending.bvid,
          userId: pending.userId,
          mediaId: pending.mediaId,
          priority: 10,
          maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
          notBefore: file.nextVerifyAt ? Date.parse(file.nextVerifyAt) : Date.now(),
          payload: {
            remoteFile: verificationPath,
            finalFile: file.path,
            expectedSize: file.size,
            localDir: pending.localDir || "",
            remotePath: pending.remotePath,
            files: manifest?.outputs.map((output) => output.relativePath) || [],
            filenameMetadataByPath: manifest
              ? buildUploadFileMetadataFromSession(pending.localDir || "", manifest.outputs.map((output) => output.relativePath))
              : undefined,
            partialBackup: Boolean(pending.partialBackup),
            localRelativePath: file.localRelativePath,
            putCompletedAt: file.putCompletedAt || new Date().toISOString(),
            folderTitle: resolved?.folderTitle || "",
            videoTitle: deps.stateManager.getVideoMeta(pending.bvid)?.title || pending.bvid,
          },
        });
      }
    }
    for (const candidate of sessionVerificationJobs.values()) {
      deps.jobStore.enqueue({
        kind: "verify_upload",
        dedupeKey: `verify-session:${candidate.userId}:${candidate.mediaId}:${candidate.bvid}:${candidate.historySegment}:${candidate.sessionId}:g${candidate.sessionGeneration || 1}`,
        bvid: candidate.bvid,
        userId: candidate.userId,
        mediaId: candidate.mediaId,
        priority: candidate.historyOnly ? 80 : 10,
        maxAttempts: UPLOAD_VERIFY_SCHEDULE_MS.length + 2,
        notBefore: candidate.notBefore,
        payload: {
          ...candidate,
          sessionVerification: true,
        },
      });
    }
    deps.stateManager.markPersistentJobBootstrapComplete();
    const pendingUploads = deps.jobStore.countRecoverable(['upload', 'history_upload', 'quality_upload']);
    const pendingDownloads = deps.jobStore.countRecoverable(['download', 'quality_download']);
    const pendingVerificationCount = deps.jobStore.countRecoverable(['verify_upload']);
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "info",
      summary: `启动恢复初始化完成，当前待处理：待补传 ${pendingUploads}，待下载 ${pendingDownloads}，待确认 ${pendingVerificationCount}`,
      raw: `[Recovery] current recoverable sqlite jobs uploads=${pendingUploads} downloads=${pendingDownloads} verify=${pendingVerificationCount}`,
      simpleVisible: true,
      debugVisible: true,
    });
  }


  function recoverOrphanedUploadFailures() {
    const prefetchLimit = Math.max(5, Math.min(100, Math.floor(deps.configStore.get().queuePrefetchLimit || 25)));
    const pageSize = Math.min(500, Math.max(100, prefetchLimit * 4));
    let cursor: { updatedAt: number; userId: string; mediaId: number; bvid: string } | null = null;
    let recovered = 0;
    const skipped = { local: 0, manifest: 0, account: 0 };
    do {
      const page = deps.stateManager.listUploadFailuresForRecoveryPage(cursor, pageSize);
      const jobs: EnqueuePersistentJob[] = [];
      for (const item of page.items) {
        const localDir = item.video.localDir;
        if (!localDir || !fs.existsSync(localDir)) {
          skipped.local += 1;
          continue;
        }
        const manifest = readRecoveryManifest(localDir);
        if (!manifest || !["complete", "partial"].includes(manifest.status) || manifest.outputs.length === 0) {
          skipped.manifest += 1;
          continue;
        }
        const resolved = deps.resolveRelation(item.relation);
        if (!resolved) {
          skipped.account += 1;
          continue;
        }
        const remotePath = item.relation.remotePath || item.video.remotePath || deps.resolveRelationRemotePath(resolved.user, item.relation.mediaId, resolved.folderTitle);
        const files = manifest.outputs.map((output) => output.relativePath);
        jobs.push(deps.buildPersistentUploadJob({
          bvid: item.video.bvid,
          localDir,
          remotePath,
          userId: item.relation.userId,
          mediaId: item.relation.mediaId,
          folderTitle: resolved.folderTitle,
          videoTitle: item.video.title,
          upperName: item.video.upperName,
          cover: item.video.cover,
          files,
          filenameMetadataByPath: buildUploadFileMetadataFromSession(localDir, files),
          partialBackup: manifest.status === "partial",
          priority: true,
        }));
      }
      deps.jobStore.enqueueBatch(jobs);
      recovered += jobs.length;
      cursor = page.nextCursor;
    } while (cursor);
    if (recovered > 0) deps.dispatchPersistentJobs();
    if (recovered > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `启动时找回 ${recovered} 个缺少可运行任务的待补传记录`,
        raw: `[Recovery] restored orphaned upload jobs=${recovered}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    const skippedTotal = skipped.local + skipped.manifest + skipped.account;
    if (skippedTotal > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "warn",
        summary: `有 ${skippedTotal} 个待补传记录暂不能恢复，已保留原状态`,
        raw: `[Recovery] orphaned upload jobs skipped local=${skipped.local} manifest=${skipped.manifest} account=${skipped.account}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }

  return { recoverStaleActiveBackups, resumePersistedWork, recoverOrphanedUploadFailures };
}
