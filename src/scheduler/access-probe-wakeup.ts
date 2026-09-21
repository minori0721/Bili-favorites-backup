import type {JobRepository} from '../repositories/jobs.js';
import type {StateManager, SourceAvailabilityReason} from '../state.js';
import type {UserStore, BiliUser} from '../users.js';
import {normalizeAccessProbeIntents} from './access-rules.js';
interface Dependencies {
 now(): number;
 userStore: Pick<UserStore, 'getById'>;
 isUserSyncEligible(user: BiliUser): boolean;
 jobStore: Pick<JobRepository, 'list' | 'wakeByBvid' | 'findByDedupeKey'>;
 stateManager: Pick<StateManager, 'listRelationsForBvid' | 'getVideoMeta' | 'listDormantAvailabilityVideos'>;
 enqueueAvailabilityProbe(bvid: string, options: {preferredUserId: string; notBefore: number; availabilityReason: SourceAvailabilityReason; manual: boolean}): unknown;
 dispatchPersistentJobs(): void;
}
export function createAccessProbeWakeup(deps: Dependencies) {
  function wake(userId?: string) {
    const now = deps.now();
    const candidateUser = userId ? deps.userStore.getById(userId) : null;
    const user = candidateUser && deps.isUserSyncEligible(candidateUser) ? candidateUser : null;
    const uid = user ? Number(user.uid || user.cookie.DedeUserID || 0) : 0;
    let changed = 0;
    for (const job of deps.jobStore.list(["access_probe"], 100_000)) {
      if (!["pending", "retry_wait"].includes(job.status)) continue;
      const bvid = String(job.bvid || "");
      if (!bvid) continue;
      const intents = normalizeAccessProbeIntents(job.payload);
      let shouldWake = intents.includes("charging");
      if (!shouldWake && user && userId && intents.includes("availability")) {
        const related = deps.stateManager.listRelationsForBvid(bvid).some((relation) =>
          relation.activeInFavorite && relation.sourceKind !== "manual" && relation.userId === userId);
        const owner = uid > 0 && Number(deps.stateManager.getVideoMeta(bvid)?.upperMid || 0) === uid;
        shouldWake = related || owner;
      }
      if (shouldWake) changed += deps.jobStore.wakeByBvid(bvid, ["access_probe"], now);
    }

    let dormantAwakened = 0;
    if (user && userId) {
      for (const video of deps.stateManager.listDormantAvailabilityVideos()) {
        const related = deps.stateManager.listRelationsForBvid(video.bvid).some((relation) =>
          relation.activeInFavorite && relation.sourceKind !== "manual" && relation.userId === userId);
        if (!related && !(uid > 0 && Number(video.upperMid || 0) === uid)) continue;
        const existing = deps.jobStore.findByDedupeKey(`access_probe:${video.bvid}`);
        deps.enqueueAvailabilityProbe(video.bvid, {
          preferredUserId: userId,
          notBefore: now,
          availabilityReason: video.sourceAvailability?.reason || "temporary_error",
          manual: true,
        });
        if (!existing) dormantAwakened += 1;
      }
    }
    if (changed > 0 || dormantAwakened > 0) deps.dispatchPersistentJobs();
    return changed + dormantAwakened;
  }
  return { wake };
}

export function wakeChargingAccessProbes(deps: Dependencies, userId?: string) {
  return createAccessProbeWakeup(deps).wake(userId);
}
