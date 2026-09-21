import type { UserStore, BiliUser } from '../users.js';
import { MANUAL_ARCHIVE_MEDIA_ID, MANUAL_ARCHIVE_FOLDER_TITLE, type StateManager } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import { buildQualityArtifactKey, normalizeQualityArtifactProfile, type QualityArtifactProfile } from '../quality-artifact.js';
import type { QualityEncodingOverride } from '../tasks.js';
export function createManualArchive(deps: {
  users: Pick<UserStore, 'getById'>;
  state: Pick<StateManager, 'listRelationsForBvid' | 'getRelationStatus' | 'recordManualArchiveItem'>;
  jobs: Pick<JobRepository, 'findByDedupeKey'>;
  isEligible(user: BiliUser): boolean;
  enqueue(user: BiliUser, mediaId: number, title: string, bvid: string, options: {
    persisted: boolean; downloadUserId: string; dedupeKey: string; qualityProfile?: QualityArtifactProfile;
    qualityStrict?: boolean; qualityEncodingOverride?: QualityEncodingOverride;
  }): boolean;
}) {
  function enqueue(userId: string, item: {
    bvid: string;
    title: string;
    upperName: string;
    upperMid?: number;
    cover?: string;
    description?: string;
    qualityProfile?: QualityArtifactProfile;
    qualityStrict?: boolean;
    qualityEncodingOverride?: QualityEncodingOverride;
  }) {
    const user = deps.users.getById(userId);
    const bvid = String(item.bvid || "").trim();
    if (!user || !deps.isEligible(user)) {
      return { ok: false as const, status: 409, message: "该账号当前不可用于手动归档" };
    }
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
      return { ok: false as const, status: 400, message: "在线条目缺少有效BVID" };
    }
    const existing = deps.state.listRelationsForBvid(bvid)
      .find((relation) => ["verified", "partial_verified", "uploaded"].includes(String(relation.backupStatus || ""))
        && (relation.remoteFiles || []).some((file) => file.verificationStatus === "verified" || file.verificationStatus === undefined));
    if (existing) {
      return { ok: true as const, status: "already_archived" as const, bvid, relation: existing };
    }
    const exactTarget = Boolean(item.qualityProfile && (item.qualityStrict || item.qualityEncodingOverride?.strict));
    const artifactKey = exactTarget
      ? buildQualityArtifactKey(bvid, normalizeQualityArtifactProfile(item.qualityProfile!))
      : "";
    const dedupeKey = exactTarget ? `download:${bvid}:manual:${artifactKey}` : `download:${bvid}`;
    const existingJob = deps.jobs.findByDedupeKey(dedupeKey);
    if (existingJob && ["pending", "leased", "running", "retry_wait", "manual_wait"].includes(existingJob.status)) {
      return {
        ok: true as const,
        status: "already_pending" as const,
        bvid,
        userId,
        mediaId: MANUAL_ARCHIVE_MEDIA_ID,
        jobId: existingJob.id,
      };
    }
    const current = deps.state.getRelationStatus(userId, MANUAL_ARCHIVE_MEDIA_ID, bvid);
    if (!current) {
      deps.state.recordManualArchiveItem(userId, {
        bvid,
        title: String(item.title || bvid),
        upperName: String(item.upperName || "Unknown"),
        upperMid: item.upperMid,
        cover: item.cover,
        description: item.description,
      });
    }
    const queued = deps.enqueue(user, MANUAL_ARCHIVE_MEDIA_ID, MANUAL_ARCHIVE_FOLDER_TITLE, bvid, {
      persisted: true,
      downloadUserId: user.id,
      dedupeKey,
      qualityProfile: item.qualityProfile,
      qualityStrict: item.qualityStrict,
      qualityEncodingOverride: item.qualityEncodingOverride,
    });
    return {
      ok: true as const,
      status: queued ? "queued" as const : "already_pending" as const,
      bvid,
      userId,
      mediaId: MANUAL_ARCHIVE_MEDIA_ID,
      qualityProfile: item.qualityProfile,
      qualityStrict: item.qualityStrict === true,
      qualityEncoding: item.qualityEncodingOverride?.priority?.[0],
    };
  }

return {enqueue};
}
