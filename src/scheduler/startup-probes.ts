import type { StateManager, SourceAvailabilityReason } from '../state.js';
import type { StateDatabase } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import { normalizeAccessProbeIntents } from './access-rules.js';
import { availabilityJitter, computeAvailabilityUnavailableDelayMs, computeAvailabilityUnknownDelayMs } from './retry-policy.js';
import { logManager } from '../logger.js';
interface Dependencies {
  stateManager: Pick<StateManager, 'listLegacyFailureClassificationCandidates' | 'listChargingRestrictedVideos' | 'listAvailabilityCheckVideos' | 'markAvailabilityConfirmedUnavailable' | 'getSourceAvailability' | 'markAvailabilityUnknown' | 'listRelationsForBvid'>;
  database(): Pick<StateDatabase, 'getMeta' | 'setMeta'>;
  jobStore: Pick<JobRepository, 'findByDedupeKey' | 'rescheduleByBvid'>;
  now(): number;
  enqueueChargingAccessProbe(bvid: string, input: { preferredUserId?: string; checkedAccountUids?: string[]; previewAvailable?: boolean; notBefore?: number; purpose?: 'legacy_failure_classification' }): unknown;
  enqueueAvailabilityProbe(bvid: string, input: { preferredUserId?: string; notBefore?: number; availabilityRound?: number; availabilityUnknownRound?: number; availabilityReason?: SourceAvailabilityReason }): unknown;
}
export function createStartupProbes(deps: Dependencies) {
  function bootstrapLegacyFailureClassification() {
    const database = deps.database();
    if (database.getMeta("legacy_failure_classification_v1") === "complete") return;
    const candidates = deps.stateManager.listLegacyFailureClassificationCandidates(100_000);
    for (const item of candidates) {
      deps.enqueueChargingAccessProbe(item.relation.bvid, {
        preferredUserId: item.relation.userId,
        purpose: "legacy_failure_classification",
      });
    }
    database.setMeta("legacy_failure_classification_v1", "complete");
    if (candidates.length > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `已安排 ${candidates.length} 个旧永久失败视频重新分类`,
        raw: `[Recovery] legacy permanent failures queued for access classification count=${candidates.length}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }


  function ensurePersistedChargingAccessProbes() {
    for (const video of deps.stateManager.listChargingRestrictedVideos()) {
      const nextAt = Date.parse(video.accessRestriction?.nextCheckAt || "");
      deps.enqueueChargingAccessProbe(video.bvid, {
        checkedAccountUids: video.accessRestriction?.checkedAccountUids || [],
        previewAvailable: video.accessRestriction?.previewAvailable,
        notBefore: Number.isFinite(nextAt) ? nextAt : deps.now(),
      });
    }
  }


  function ensurePersistedAvailabilityProbes() {
    for (const video of deps.stateManager.listAvailabilityCheckVideos()) {
      let source = video.sourceAvailability;
      if (!source) {
        const checkedAt = new Date(deps.now()).toISOString();
        const nextAt = deps.now() + computeAvailabilityUnavailableDelayMs(0, video.bvid);
        deps.stateManager.markAvailabilityConfirmedUnavailable(
          video.bvid,
          "api_not_found",
          checkedAt,
          new Date(nextAt).toISOString(),
          1,
        );
        source = deps.stateManager.getSourceAvailability(video.bvid);
      }
      if (!source || source.state === "dormant") continue;

      let nextAt = Date.parse(source.nextCheckAt || "");
      const existingJob = deps.jobStore.findByDedupeKey(`access_probe:${video.bvid}`);
      const existingPayload = (existingJob?.payload || {}) as Record<string, unknown>;
      const existingIntents = existingJob ? normalizeAccessProbeIntents(existingPayload) : ["availability"];
      const existingScheduleLooksFixed = !existingJob || Math.abs(existingJob.notBefore - nextAt) <= 1_000;
      const canMigrateFixedSchedule = ["unknown", "confirmed_unavailable"].includes(source.state)
        && existingScheduleLooksFixed
        && (!existingJob || (
          ["pending", "retry_wait"].includes(existingJob.status)
          && existingPayload.manual !== true
          && existingIntents.length === 1
          && existingIntents[0] === "availability"
        ));
      const checkedAtMs = Date.parse(source.lastCheckedAt || "");
      if (canMigrateFixedSchedule && Number.isFinite(nextAt) && Number.isFinite(checkedAtMs)) {
        const round = Math.max(0, Number(source.checkRound || 0) - 1);
        const baseDelay = source.state === "unknown"
          ? computeAvailabilityUnknownDelayMs(round)
          : computeAvailabilityUnavailableDelayMs(round);
        const staggeredDelay = source.state === "unknown"
          ? computeAvailabilityUnknownDelayMs(round, video.bvid)
          : computeAvailabilityUnavailableDelayMs(round, video.bvid);
        const legacyFixedAt = checkedAtMs + baseDelay;
        if (Math.abs(nextAt - legacyFixedAt) <= 1_000 && staggeredDelay > baseDelay) {
          const staggeredAt = checkedAtMs + staggeredDelay;
          const catchUpDelay = Math.max(1_000, availabilityJitter(video.bvid));
          const migratedAt = staggeredAt > deps.now() + 1_000 ? staggeredAt : deps.now() + catchUpDelay;
          const migratedIso = new Date(migratedAt).toISOString();
          if (source.state === "unknown") {
            deps.stateManager.markAvailabilityUnknown(video.bvid, source.reason, source.lastCheckedAt, migratedIso, source.checkRound);
          } else {
            deps.stateManager.markAvailabilityConfirmedUnavailable(video.bvid, source.reason, source.lastCheckedAt, migratedIso, source.checkRound);
          }
          if (existingJob) deps.jobStore.rescheduleByBvid(video.bvid, ["access_probe"], migratedAt, deps.now());
          source = deps.stateManager.getSourceAvailability(video.bvid) || source;
          nextAt = migratedAt;
        }
      }

      const relation = deps.stateManager.listRelationsForBvid(video.bvid)
        .find((item) => item.activeInFavorite
          && item.sourceKind !== "manual"
          && !item.selfVisible
          && !["uploaded", "verified", "partial_verified"].includes(item.backupStatus || ""));
      if (!relation) continue;
      deps.enqueueAvailabilityProbe(video.bvid, {
        preferredUserId: relation.userId,
        notBefore: Number.isFinite(nextAt) ? Math.max(deps.now(), nextAt) : deps.now() + availabilityJitter(video.bvid),
        availabilityRound: source.state === "confirmed_unavailable" ? source.checkRound : 0,
        availabilityUnknownRound: source.state === "unknown" ? source.checkRound : 0,
        availabilityReason: source.reason,
      });
    }
  }

  return { bootstrapLegacyFailureClassification, ensurePersistedChargingAccessProbes, ensurePersistedAvailabilityProbes };
}
