import type { StateDatabase } from '../database.js';
import type { StateManager, FavoriteRelation } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import { downloadCredentialsForUser, type BiliUser, type UserStore } from '../users.js';
import type { getVideoPageSnapshot } from '../bili.js';
import type { RecoveryIssueActionId } from '../recovery-policy.js';
import { sanitizeUploadText } from '../upload-health.js';
import { logManager } from '../logger.js';
import { parseLegacyDownloadFailureKey } from './recovery-identifiers.js';
import { readTaskFailure } from './task-failure.js';
import type { RecoveryIssue } from './recovery-contracts.js';
import type { RecoveryLockAccess } from './recovery-work.js';
import type { createBackupEnqueue } from './backup-enqueue.js';
interface Dependencies {
  database(): Pick<StateDatabase, 'getFailure' | 'upsertFailure' | 'isArchiveSourceDeletionBlocked'>;
  stateManager: Pick<StateManager, 'getRelationStatus' | 'runAtomic' | 'resetRelationForRetry' | 'getChargingRestriction'>;
  jobStore: Pick<JobRepository, 'findByDedupeKey'>;
  userStore: Pick<UserStore, 'getById'>;
  recoveryWork: { locks: RecoveryLockAccess };
  videoAccessProbe: typeof getVideoPageSnapshot;
  generation(): number;
  now(): number;
  resolveRelation(relation: FavoriteRelation): { user: BiliUser; mediaId: number; folderTitle: string } | null;
  isUserSyncEligible(user: BiliUser | null | undefined): user is BiliUser;
  prepareBackup: ReturnType<typeof createBackupEnqueue>['prepareRecoveryDownload'];
  dispatchPersistentJobs(): void;
  getRecoveryIssueSnapshot(): { issues: RecoveryIssue[] };
}
export function createLegacyDownloadRecovery(deps: Dependencies) {
  async function resolve(
    issueKey: string,
    action: RecoveryIssueActionId,
    options: { userId?: unknown },
  ) {
    if (!["retry_download", "retry_download_with_account", "defer_download", "abandon_attempt"].includes(action)) {
      return { ok: false as const, status: 400, message: "该下载待处理项不支持此操作" };
    }
    const lockKey = `legacy-download.${issueKey}`;
    if (deps.recoveryWork.locks.has(lockKey)) {
      return { ok: false as const, status: 409, message: "该旧版下载记录正在被处理，请稍后刷新" };
    }
    deps.recoveryWork.locks.add(lockKey);
    try {
      const target = parseLegacyDownloadFailureKey(issueKey);
      if (!target) return { ok: false as const, status: 404, message: "旧版下载记录不存在或已自动解决" };
      const epoch = deps.generation();
      const failure = deps.database().getFailure(target.userId, target.bvid, target.mediaId);
      const relation = deps.stateManager.getRelationStatus(target.userId, target.mediaId, target.bvid);
      if (!failure?.permanent || !relation?.activeInFavorite || relation.accountDetachedAt) {
        return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (failure.userDisposition === "abandoned") {
        return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (action === "abandon_attempt") {
        deps.database().upsertFailure(target.userId, {
          ...failure,
          userDisposition: "abandoned",
          abandonedAt: new Date(deps.now()).toISOString(),
        });
        logManager.push({
          timestamp: new Date(deps.now()).toISOString(),
          type: "download",
          level: "info",
          summary: `用户已放弃旧版失败下载 ${target.bvid}`,
          raw: "[Recovery] legacy download abandoned",
          bvid: target.bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (relation.favoriteUnavailable && !relation.selfVisible) {
        return { ok: false as const, status: 409, message: "当前视频仍被确认不可用，暂不能重新下载" };
      }
      if (["uploaded", "verified", "partial_verified", "uploading", "downloaded", "queued", "downloading"].includes(String(relation.backupStatus || ""))) {
        return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      if (deps.database().isArchiveSourceDeletionBlocked(target.userId, target.mediaId, target.bvid)) {
        return { ok: false as const, status: 409, message: "该收藏来源正在清理，请等待清理结束后再重试" };
      }
      const existingJob = deps.jobStore.findByDedupeKey(`download:${target.bvid}`);
      if (existingJob) {
        return { ok: true as const, idempotent: true, issues: deps.getRecoveryIssueSnapshot().issues };
      }
      const resolved = deps.resolveRelation(relation);
      if (!resolved) {
        return { ok: false as const, status: 409, message: "原下载账号当前不可用，请先恢复账号或换一个可用账号" };
      }

      let selectedUserId = resolved.user.id;
      if (action === "retry_download_with_account") {
        const requestedUserId = String(options.userId || "");
        const user = requestedUserId ? deps.userStore.getById(requestedUserId) : null;
        if (!deps.isUserSyncEligible(user) || user.id === resolved.user.id) {
          return { ok: false as const, status: 400, message: "请选择另一个当前可用的登录账号" };
        }
        try {
          const snapshot = await deps.videoAccessProbe(downloadCredentialsForUser(user), target.bvid);
          if (!snapshot.available || snapshot.access.classification === "charging_restricted") {
            return { ok: false as const, status: 409, message: "所选账号当前无法访问这个视频，请换一个账号或稍后再试" };
          }
        } catch (error) {
          // boundary-critical: account validation failure is returned as an explicit client result.
          return {
            ok: false as const,
            status: 409,
            message: `所选账号访问检查失败：${sanitizeUploadText(readTaskFailure(error).message || error || "未知错误", 180)}`,
          };
        }
        selectedUserId = user.id;
      }

      if (epoch !== deps.generation()
        || JSON.stringify(deps.database().getFailure(target.userId, target.bvid, target.mediaId)) !== JSON.stringify(failure)
        || JSON.stringify(deps.stateManager.getRelationStatus(target.userId, target.mediaId, target.bvid)) !== JSON.stringify(relation)
        || deps.database().isArchiveSourceDeletionBlocked(target.userId, target.mediaId, target.bvid)) {
        return { ok: false as const, status: 409, message: "下载来源已经变化，请刷新后重试" };
      }
      const deferred = action === "defer_download";
      const notBefore = deferred ? deps.now() + 24 * 60 * 60_000 : deps.now();
      const prepared = deps.prepareBackup(resolved.user, target.mediaId, resolved.folderTitle, target.bvid, {
        persisted: true, notBefore, downloadUserId: selectedUserId,
      });
      if (!prepared) return { ok: false as const, status: 409, message: "下载任务未能重新排队，请刷新待处理列表后重试" };
      const rejected = new Error('Legacy recovery enqueue rejected');
      try {
        deps.stateManager.runAtomic(() => {
          deps.stateManager.resetRelationForRetry(
            target.bvid,
            target.userId,
            target.mediaId,
            deferred ? "用户已将旧版失败下载暂缓24小时。" : "用户已从待处理中心重新启动旧版失败下载。",
            { clearFailure: true },
          );
          const queued = prepared.commit();
          if (!queued) throw rejected;
        });
      } catch (error) {
        // boundary-critical: only the known rejected sentinel becomes a client result; all other errors propagate.
        if (error !== rejected) throw error;
        return { ok: false as const, status: 409, message: "下载任务未能重新排队，请刷新待处理列表后重试" };
      }
      logManager.push({
        timestamp: new Date(deps.now()).toISOString(),
        type: "download",
        level: "info",
        summary: deferred
          ? `旧版下载失败已暂缓24小时 ${target.bvid}`
          : `已从旧版失败记录重新启动下载 ${target.bvid}`,
        raw: `[Recovery] legacy download action=${action} accountChanged=${selectedUserId !== resolved.user.id}`,
        bvid: target.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      deps.dispatchPersistentJobs();
      return { ok: true as const, issues: deps.getRecoveryIssueSnapshot().issues };
    } finally {
      deps.recoveryWork.locks.delete(lockKey);
    }
  }

  return { resolve };
}
