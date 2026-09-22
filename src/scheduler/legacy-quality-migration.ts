import type { ConfigStore } from '../config.js';
import type { UserStore } from '../users.js';
import { LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER, type StateDatabase } from '../database.js';
import type { JobRepository, QualityDownloadMigrationPlan } from '../repositories/jobs.js';
import { qualityUpgradeTargetKey, type QualityUpgradeTarget } from '../tasks.js';
import { normalizeQualityArtifactProfile, qualityArtifactProfileFromConfig, buildQualityArtifactKey, type QualityArtifactProfile } from '../quality-artifact.js';
import { readDownloadSession } from '../download-session.js';
import { logManager } from '../logger.js';
import { qualityTargetsFromPayload } from './quality-rules.js';
interface Dependencies {
  configStore: Pick<ConfigStore, 'get'>;
  userStore: Pick<UserStore, 'getById'>;
  jobStore: Pick<JobRepository, 'countLegacyQualityDownloadJobs' | 'listLegacyQualityDownloadJobs' | 'applyQualityDownloadMigration' | 'findByDedupeKey'>;
  database(): Pick<StateDatabase, 'getMeta'>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {};
}
export function createLegacyQualityMigration(deps: Dependencies) {
  function migrate() {
    const database = deps.database();
    if (database.getMeta(LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER) === "complete") return 0;
    const candidateCount = deps.jobStore.countLegacyQualityDownloadJobs();
    if (candidateCount > 100_000) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "warn",
        summary: `旧画质下载任务超过安全上限，已保留待下次处理`,
        raw: `[QualityUpgrade] legacy migration candidate limit exceeded count=${candidateCount}`,
        simpleVisible: true,
        debugVisible: true,
      });
      return 0;
    }
    const jobs = deps.jobStore.listLegacyQualityDownloadJobs(100_001);
    if (jobs.length !== candidateCount) {
      throw new Error(`Legacy quality migration changed while preparing: expected=${candidateCount}; actual=${jobs.length}`);
    }
    if (jobs.length === 0) {
      deps.jobStore.applyQualityDownloadMigration([], LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
      return 0;
    }
    const currentProfile = qualityArtifactProfileFromConfig(deps.configStore.get());
    const groups = new Map<string, { artifactKey: string; profile: QualityArtifactProfile; jobs: typeof jobs }>();
    for (const job of jobs) {
      const payload = job.payload;
      const session = typeof payload.downloadDir === "string" ? readDownloadSession(payload.downloadDir) : null;
      if (session?.kind === 'invalid') throw new Error(`Legacy quality download ${job.id} has an invalid download manifest`);
      const manifest = session?.kind === 'valid' ? session.manifest : null;
      const profile = normalizeQualityArtifactProfile(
        (payload.qualityProfile ? record(payload.qualityProfile) : null)
        || manifest?.qualityUpgrade?.qualityProfile
        || manifest?.configSnapshot
        || currentProfile
      );
      const bvid = String(job.bvid || payload.bvid || manifest?.bvid || "");
      if (!bvid) throw new Error(`Legacy quality download ${job.id} is missing its BVID`);
      const artifactKey = String(payload.artifactKey || manifest?.qualityUpgrade?.artifactKey || buildQualityArtifactKey(bvid, profile));
      const groupKey = `${bvid}:${artifactKey}`;
      const group = groups.get(groupKey) || { artifactKey, profile, jobs: [] };
      group.jobs.push(job);
      groups.set(groupKey, group);
    }

    const plans: QualityDownloadMigrationPlan[] = [];
    for (const group of groups.values()) {
      const bvid = String(group.jobs[0].bvid || (group.jobs[0].payload).bvid || "");
      if (!bvid) throw new Error("Legacy quality download is missing its BVID");
      const dedupeKey = `quality-download:${bvid}:${group.artifactKey}`;
      const existingShared = deps.jobStore.findByDedupeKey(dedupeKey);
      if (existingShared && !group.jobs.some((job) => job.id === existingShared.id)) {
        group.jobs.push(existingShared);
      }
      const targets = new Map<string, QualityUpgradeTarget>();
      for (const job of group.jobs) {
        for (const target of qualityTargetsFromPayload(job.payload)) {
          targets.set(qualityUpgradeTargetKey(target), target);
        }
      }
      const mergedTargets = [...targets.values()];
      if (mergedTargets.length === 0) throw new Error(`Legacy quality download ${bvid} has no recoverable target`);
      const base = [...group.jobs].sort((left, right) => {
        const leftPayload = left.payload;
        const rightPayload = right.payload;
        const leftScore = (leftPayload.downloadDir ? 2 : 0) + (Array.isArray(leftPayload.outputFiles) && leftPayload.outputFiles.length > 0 ? 1 : 0);
        const rightScore = (rightPayload.downloadDir ? 2 : 0) + (Array.isArray(rightPayload.outputFiles) && rightPayload.outputFiles.length > 0 ? 1 : 0);
        return rightScore - leftScore || right.updatedAt - left.updatedAt;
      })[0];
      const enabledDownloadUser = group.jobs
        .map((job) => String((job.payload).downloadUserId || job.userId || ""))
        .find((id) => Boolean(deps.userStore.getById(id)?.enabled));
      const payload = {
        ...(base.payload),
        bvid,
        userId: mergedTargets[0].userId,
        mediaId: mergedTargets[0].mediaId,
        folderTitle: mergedTargets.length > 1 ? `${mergedTargets.length}个目标` : mergedTargets[0].folderTitle,
        downloadUserId: String(enabledDownloadUser || (base.payload).downloadUserId || base.userId || mergedTargets[0].userId),
        target: mergedTargets[0],
        targets: mergedTargets,
        targetCount: mergedTargets.length,
        artifactKey: group.artifactKey,
        qualityProfile: group.profile,
        qualityStageLabel: `等待下载新版${mergedTargets.length > 1 ? ` · ${mergedTargets.length}个目标` : ""}`,
      };
      plans.push({
        jobs: group.jobs,
        replacement: {
          kind: "quality_download",
          dedupeKey,
          bvid,
          userId: payload.downloadUserId,
          mediaId: mergedTargets[0].mediaId,
          priority: Math.min(...group.jobs.map((job) => job.priority)),
          maxAttempts: Math.max(...group.jobs.map((job) => job.maxAttempts)),
          notBefore: Math.max(...group.jobs.map((job) => job.notBefore)),
          payload,
        },
      });
    }
    deps.jobStore.applyQualityDownloadMigration(plans, LEGACY_QUALITY_DOWNLOAD_JOBS_MARKER);
    if (candidateCount > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `已合并 ${candidateCount} 个旧画质下载任务`,
        raw: `[QualityUpgrade] consolidated legacy download jobs=${candidateCount}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
    return candidateCount;
  }

  return { migrate };
}
