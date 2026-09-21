import type { StateDatabase } from '../database.js';
import type { FavoriteRelation } from '../state.js';
import type { BiliUser, UserStore } from '../users.js';
import type { ConfigStore } from '../config.js';
import type { JobRepository } from '../repositories/jobs.js';
import { classifyDownloadRecoveryFailure } from '../download-recovery.js';
import type { DownloadRecoveryCategory } from '../recovery-policy.js';
import type { RecoveryIssueKind } from '../recovery-policy.js';
import { sanitizeUploadText } from '../upload-health.js';
interface Dependencies {
  jobStore: Pick<JobRepository, 'list' | 'listLegacyDownloadRecovery' | 'complete' | 'findLegacyDownloadRecovery' | 'updatePayload' | 'enqueue'>;
  userStore: Pick<UserStore, 'list'>;
  configStore: Pick<ConfigStore, 'get'>;
  database(): Pick<StateDatabase, 'listPermanentFailureRecoveryRelations' | 'isArchiveSourceDeletionBlocked'>;
  resolveRelation(relation: FavoriteRelation): unknown;
  isUserSyncEligible(user: BiliUser): boolean;
}
export function createLegacyRecoveryProjection(deps: Dependencies) {
  function legacyDownloadFailureIssueKey(userId: string, mediaId: number, bvid: string) {
    return `${userId}:${mediaId}:${bvid}`;
  }

  function eligibleLegacyDownloadFailures(limit = 1_000) {
    const jobsByBvid = new Set(
      deps.jobStore.list(["download"], 100_000)
        .filter((job) => !job.payload?.legacyFailureKey)
        .map((job) => String(job.bvid || ""))
        .filter(Boolean),
    );
    const legacyClassificationBvids = new Set(
      deps.jobStore.list(["access_probe"], 10_000)
        .filter((job) => job.payload?.purpose === "legacy_failure_classification")
        .map((job) => String(job.bvid || ""))
        .filter(Boolean),
    );
    const seen = new Set<string>();
    const eligible: Array<{
      record: ReturnType<StateDatabase['listPermanentFailureRecoveryRelations']>[number];
      relation: FavoriteRelation;
      bvid: string;
      issueKey: string;
      category: DownloadRecoveryCategory;
      kind: Extract<RecoveryIssueKind, "download_retry_exhausted" | "download_account_required" | "download_tool_failure">;
      alternateAccounts: Array<{ value: string; label: string }>;
    }> = [];
    for (const record of deps.database().listPermanentFailureRecoveryRelations(limit)) {
      const relation = record.relation;
      const bvid = String(relation.bvid || record.failure.bvid || "");
      if (!bvid || jobsByBvid.has(bvid) || legacyClassificationBvids.has(bvid)) continue;
      if (seen.has(legacyDownloadFailureIssueKey(relation.userId, relation.mediaId, bvid))) continue;
      if (!relation.activeInFavorite || relation.accountDetachedAt) continue;
      if (relation.favoriteUnavailable && !relation.selfVisible) continue;
      if (["uploaded", "verified", "partial_verified", "uploading", "downloaded", "queued", "downloading"].includes(String(relation.backupStatus || ""))) continue;
      if (deps.database().isArchiveSourceDeletionBlocked(relation.userId, relation.mediaId, bvid)) continue;
      const resolved = deps.resolveRelation(relation);
      if (!resolved) continue;

      const failure = classifyDownloadRecoveryFailure({ message: record.failure.reason || "" });
      if (record.failure.userDisposition === "abandoned") continue;
      if (failure.category === "source_unavailable") continue;
      const category: DownloadRecoveryCategory = failure.category;
      const alternateAccounts = deps.userStore.list()
        .filter((user) => user.id !== relation.userId && deps.isUserSyncEligible(user))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id))
        .map((user) => ({ value: user.id, label: `${user.name}（UID ${user.uid}）` }));
      const issueKey = legacyDownloadFailureIssueKey(relation.userId, relation.mediaId, bvid);
      seen.add(issueKey);
      eligible.push({
        record,
        relation,
        bvid,
        issueKey,
        category,
        kind: failure.kind || "download_retry_exhausted",
        alternateAccounts,
      });
    }
    return eligible;
  }

  function reconcileLegacyDownloadRecoveryJobs() {
    const eligible = eligibleLegacyDownloadFailures();
    const eligibleByKey = new Map(eligible.map((item) => [item.issueKey, item]));
    let changed = 0;
    for (const job of deps.jobStore.listLegacyDownloadRecovery()) {
      const key = String(job.payload?.legacyFailureKey || "");
      if (key && !eligibleByKey.has(key) && job.payload?.userDisposition !== "abandoned") {
        if (deps.jobStore.complete(job.id)) changed += 1;
      }
    }
    for (const item of eligible) {
      const existing = deps.jobStore.findLegacyDownloadRecovery(item.issueKey);
      const record = item.record;
      const payload = {
        legacyFailureKey: item.issueKey,
        legacyFailureAt: record.failure.failedAt,
        primaryUserId: item.relation.userId,
        primaryMediaId: item.relation.mediaId,
        downloadUserId: item.relation.userId,
        detachedTargets: [{
          userId: item.relation.userId,
          mediaId: item.relation.mediaId,
          folderTitle: item.relation.folderTitle,
          remotePath: item.relation.remotePath || "",
        }],
        downloadRecovery: {
          category: item.category,
          kind: item.kind,
          summary: `这是旧版下载失败记录，系统不会自动重复下载。${sanitizeUploadText(record.failure.reason || "可手动重新尝试一次。", 220)}`,
        },
      };
      if (existing) {
        if (existing.payload?.userDisposition !== "abandoned"
          && existing.payload?.legacyFailureAt !== record.failure.failedAt) {
          deps.jobStore.updatePayload(existing.id, { ...existing.payload, ...payload, awaitingManualRecovery: true });
          changed += 1;
        }
        continue;
      }
      deps.jobStore.enqueue({
        kind: "download",
        dedupeKey: `download-recovery:${item.issueKey}`,
        bvid: item.bvid,
        userId: item.relation.userId,
        mediaId: item.relation.mediaId,
        priority: 30,
        maxAttempts: deps.configStore.get().maxRetries + 1,
        initialStatus: "manual_wait",
        payload: {
          bvid: item.bvid,
          ...payload,
          awaitingManualRecovery: true,
          manualRecoveryReason: record.failure.reason || "旧版下载失败记录待处理",
        },
      });
      changed += 1;
    }
    return changed;
  }

  return { legacyDownloadFailureIssueKey, eligibleLegacyDownloadFailures, reconcileLegacyDownloadRecoveryJobs };
}
