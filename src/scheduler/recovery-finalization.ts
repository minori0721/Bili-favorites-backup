import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { TransferSessionRepository } from '../repositories/transfer-sessions.js';
import type { StateManager, FavoriteRelation, RemoteFileRecord, LocalCleanupPlan } from '../state.js';
import type { BiliUser } from '../users.js';
import type { ExistingArchiveProof } from '../upload-preflight.js';
import type { RecoveryAssessment } from './recovery-contracts.js';
import type { createBackupEnqueue } from './backup-enqueue.js';
import { commitRetainedRecovery, commitVerifiedRecovery } from './recovery-commit.js';
import { markHistoryGroupUploaded } from '../download-session.js';
import { logManager } from '../logger.js';
import { AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT } from './retry-policy.js';
interface Dependencies {
  stateManager: Parameters<typeof commitRetainedRecovery>[0]['state'] & Pick<StateManager, 'getRelationStatus' | 'resetRelationForRetry'>;
  jobStore: Pick<JobRepository, 'findById' | 'complete'>;
  transferSessions: Parameters<typeof commitVerifiedRecovery>[0]['sessions'];
  resolveRelation(relation: FavoriteRelation): { user: BiliUser; folderTitle: string } | null;
  prepareDownload: ReturnType<typeof createBackupEnqueue>['prepareRecoveryDownload'];
  verifiedFilesFromRecovery(job: PersistentJobRecord, files: ReturnType<TransferSessionRepository['listFiles']>): RemoteFileRecord[];
  buildLocalCleanupPlan(bvid: string, dir: string, files: RemoteFileRecord[], reason: LocalCleanupPlan['reason'], options: { id: string; transferSessionId: string; transferGeneration: number }): LocalCleanupPlan | null;
  cleanup(bvid: string, dir: string): unknown;
  now(): number;
  dispatchPersistentJobs(): void;
}
class RecoveryRejected extends Error {}
export function createRecoveryFinalization(deps: Dependencies) {
  function finalizeRetainedArchiveRecovery(
    job: PersistentJobRecord,
    proof: ExistingArchiveProof,
    options: { allowResumeOnly?: boolean } = {},
  ) {
    const committed = commitRetainedRecovery({ state: deps.stateManager, jobs: deps.jobStore, sessions: deps.transferSessions }, job.id, proof, options.allowResumeOnly);
    if (!committed) return false;
    const current = committed.job;
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "upload",
      level: "info",
      summary: `已确认并保留旧归档 ${current.bvid || ""}`,
      raw: `[Recovery] retained existing archive proof; files=${proof.files.length}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    void deps.cleanup(String(current.bvid || ""), committed.localDir);
    deps.dispatchPersistentJobs();
    return true;
  }

  function finalizeVerifiedRecovery(job: PersistentJobRecord, session: NonNullable<ReturnType<TransferSessionRepository["get"]>>, files: ReturnType<TransferSessionRepository["listFiles"]>) {
    const current = deps.jobStore.findById(job.id);
    if (!current || !current.payload.awaitingManualRecovery) return false;
    const payload = current.payload;
    const expectedGeneration = Number.isInteger(payload.sessionGeneration)
      ? Number(payload.sessionGeneration)
      : session.generation;
    if (session.generation !== expectedGeneration) return false;
    if (files.length === 0 || !files.every((file) => Boolean(file.putAcceptedAt))) return false;
    const now = deps.now();
    const verifiedFiles = deps.verifiedFilesFromRecovery(current, files);
    const cleanupPlan = deps.buildLocalCleanupPlan(
      String(current.bvid || session.bvid || ""), String(payload.localDir || session.localDir || ""), verifiedFiles,
      "upload_verified", { id: `upload:${session.id}:${expectedGeneration}:${session.remotePath}`, transferSessionId: session.id, transferGeneration: expectedGeneration },
    );
    commitVerifiedRecovery({ state: deps.stateManager, jobs: deps.jobStore, sessions: deps.transferSessions }, {
      job: current, session, files, verifiedFiles, cleanupPlan, expectedGeneration, now,
    });
    if (payload.historyOnly && payload.historySnapshotAt) {
      markHistoryGroupUploaded(String(payload.localDir || session.localDir || ""), String(payload.historySnapshotAt), `${current.userId || "video"}:${current.mediaId || 0}`);
    }
    logManager.push({
      timestamp: new Date(now).toISOString(),
      type: "upload",
      level: "info",
      summary: `自动确认远端文件已就绪 ${current.bvid || ""}`,
      raw: `[Recovery] remote files verified without another PUT; files=${files.length}`,
      bvid: current.bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
    return true;
  }

  function queueFreshDownloadForRecovery(job: PersistentJobRecord, localStatus: RecoveryAssessment["localStatus"], userInitiated = false) {
    const current = deps.jobStore.findById(job.id);
    if (!current || !current.payload.awaitingManualRecovery || current.payload.historyOnly) return false;
    const userId = String(current.userId || "");
    const mediaId = Number(current.mediaId);
    const bvid = String(current.bvid || "");
    const relation = userId && Number.isInteger(mediaId)
      ? deps.stateManager.getRelationStatus(userId, mediaId, bvid)
      : null;
    const resolved = relation ? deps.resolveRelation(relation) : null;
    if (!relation?.activeInFavorite || relation.favoriteUnavailable || !resolved) return false;
    const payload = current.payload;
    const previousAttempts = Math.max(0, Number(payload.automaticRecoveryAttempts || 0));
    if (!userInitiated && previousAttempts >= AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT) return false;
    const prepared = deps.prepareDownload(resolved.user, mediaId, resolved.folderTitle, bvid, {
      persisted: true, downloadUserId: resolved.user.id, recoveryAttempt: previousAttempts + 1,
    });
    if (!prepared || prepared.kind !== 'download') return false;
    try {
      deps.stateManager.runAtomic(() => {
        const live = deps.jobStore.findById(current.id);
        if (!live || JSON.stringify(live.payload) !== JSON.stringify(current.payload)) throw new RecoveryRejected();
        const session = payload.sessionId ? deps.transferSessions.get(String(payload.sessionId)) : null;
        if (payload.sessionId && !session) throw new RecoveryRejected();
        if (session) {
          const generation = Number.isInteger(payload.sessionGeneration) ? Number(payload.sessionGeneration) : session.generation;
          if (session.generation !== generation || !deps.transferSessions.supersede(session.id, generation)) throw new RecoveryRejected();
        }
        deps.stateManager.resetRelationForRetry(bvid, userId, mediaId, `Local upload files were ${localStatus}; queued a fresh download.`);
        if (!prepared.commit() || !deps.jobStore.complete(current.id)) throw new RecoveryRejected();
      });
    } catch (error) {
      if (error instanceof RecoveryRejected) return false;
      throw error;
    }
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "download",
      level: "warn",
      summary: `本地补传文件失效，已自动重新下载 ${bvid}`,
      raw: `[Recovery] stale upload replaced with fresh download; local=${localStatus}; attempt=${previousAttempts + 1}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
    deps.dispatchPersistentJobs();
    return true;
  }

  return { finalizeRetainedArchiveRecovery, finalizeVerifiedRecovery, queueFreshDownloadForRecovery };
}
