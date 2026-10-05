import type { BiliUser, UserStore } from '../users.js';
import type { StateManager, FavoriteRelation, SourceAvailabilityReason } from '../state.js';
import type { PersistentJobRecord } from '../database.js';
import type { JobRepository } from '../repositories/jobs.js';
import { BiliRiskOrLoginError, type VideoPageSnapshotOptions, type VideoPageSnapshotResult } from '../bili.js';
import { AccessProbeStateError, type AccessProbeRequestGate } from './access-probe-workflow.js';
import { logManager } from '../logger.js';
import { sanitizeUploadText } from '../upload-health.js';
import { isRecord } from '../shared/api/value.js';
import { accessProbeRequestRevision, normalizeAccessProbeIntents, snapshotAvailability, normalizeSourceAvailabilityReason } from './access-rules.js';
import { CHARGING_NO_ACCOUNT_DELAY_MS, AVAILABILITY_UNKNOWN_DELAYS_MS, AVAILABILITY_UNAVAILABLE_DELAYS_MS, computeChargingRecheckDelayMs, computeChargingTransientDelayMs, computeAvailabilityUnknownDelayMs, computeAvailabilityUnavailableDelayMs } from './retry-policy.js';

interface AccessProbeDependencies {
  users: Pick<UserStore, 'list'>;
  state: Pick<StateManager, 'runAtomic' | 'listRelationsForBvid' | 'getVideoMeta' | 'getChargingRestriction' | 'markChargingRestricted' | 'markAvailabilityPending' | 'markAvailabilityUnknown' | 'markAvailabilityConfirmedUnavailable' | 'getSourceAvailability' | 'markAvailabilityDormant' | 'markAvailabilityRecovered' | 'markLegacyAccessClassification' | 'shouldEnqueueBackup' | 'clearChargingRestriction'>;
  jobs: Pick<JobRepository, 'updatePayload' | 'defer' | 'findById' | 'complete' | 'hasJobsForBvid' | 'list' | 'wakeByBvid'>;
  owner: string;
  now(): number;
  random(): number;
  generation(): number;
  canContinue(): boolean;
  eligible(user: BiliUser): boolean;
  inspect(cookie: BiliUser['cookie'], bvid: string, options?: VideoPageSnapshotOptions): Promise<VideoPageSnapshotResult>;
  resolve(relation: FavoriteRelation): {user: BiliUser; mediaId: number; folderTitle: string} | null;
  prepareAfterAccessCheck(user: BiliUser, mediaId: number, folderTitle: string, bvid: string, options: {persisted: boolean; downloadUserId: string}): {commit(): boolean} | null;
}

class AccessProbeSuperseded extends Error {
  constructor() { super('Access probe has a newer request'); }
}

/** A claimed probe runs inside scheduling control's tracked promise and lease. */
export function createAccessProbes(deps: AccessProbeDependencies) {
function checkpoint(job: PersistentJobRecord) {
  const generation = deps.generation();
  const revision = accessProbeRequestRevision(job.payload);
  return () => {
    const current = deps.jobs.findById(job.id);
    if (generation !== deps.generation() || !deps.canContinue() || !current || current.leaseOwner !== deps.owner
      || current.attempts !== job.attempts || !['leased', 'running'].includes(current.status)) {
      throw new Error('Access probe interrupted by lifecycle or lease change');
    }
    if (accessProbeRequestRevision(current.payload) !== revision) throw new AccessProbeSuperseded();
  };
}

function rescheduleNewRequest(job: PersistentJobRecord) {
  deps.state.runAtomic(() => {
    const current = deps.jobs.findById(job.id);
    if (!current || current.leaseOwner !== deps.owner || current.attempts !== job.attempts
      || !['leased', 'running'].includes(current.status)) throw new Error('Access probe reschedule lost its lease');
    // Keep the latest payload, including manual intent and account selection.
    if (!deps.jobs.defer(job.id, deps.owner, '收到新的复核要求，等待重新检查', deps.now())) {
      throw new Error('Access probe reschedule lost its lease');
    }
  });
}

async function inspect(user: BiliUser, bvid: string, assertCurrent: () => void, beforeRequest: AccessProbeRequestGate) {
  await beforeRequest(assertCurrent);
  let firstRequest = true;
  const result = await deps.inspect({ ...user.cookie, accessToken: user.accessToken || '' }, bvid, {
    beforeRequest: async () => {
      // Reserve the first request above so injected single-request adapters use
      // the same pacing contract. The real adapter gates its fallback requests.
      if (firstRequest) { firstRequest = false; assertCurrent(); }
      else await beforeRequest(assertCurrent);
    },
  });
  assertCurrent();
  return result;
}

function commitRecoveredAccess(job: PersistentJobRecord, user: BiliUser, checkedAt: string,
  options: { availability: boolean; charging: boolean; legacy: boolean }, assertCurrent: () => void) {
  assertCurrent();
  const bvid = String(job.bvid || '');
  const replacements = deps.state.listRelationsForBvid(bvid)
    .filter(relation => relation.activeInFavorite
      && (relation.sourceKind !== 'manual' || (options.charging && relation.backupStatus === 'charging_restricted'))
      && !['uploaded', 'verified', 'partial_verified'].includes(relation.backupStatus || ''))
    .map(relation => {
      const resolved = deps.resolve(relation);
      return { relation, resolved, replacement: resolved && deps.prepareAfterAccessCheck(
        resolved.user, relation.mediaId, resolved.folderTitle, bvid, { persisted: true, downloadUserId: user.id }) };
    });
  assertCurrent();
  return deps.state.runAtomic(() => {
    assertCurrent();
    const changed = options.availability && deps.state.markAvailabilityRecovered(bvid, checkedAt);
    if (options.charging) deps.state.clearChargingRestriction(bvid, checkedAt);
    if (options.legacy) deps.state.markLegacyAccessClassification(bvid, { result: 'available', classifiedAt: checkedAt });
    for (const { relation, resolved, replacement } of replacements) {
      if (!resolved || !deps.state.shouldEnqueueBackup(bvid, relation.userId, relation.mediaId, undefined, true)) continue;
      if (!replacement || !replacement.commit()) throw new Error('Access recovered but the replacement task was not accepted');
    }
    for (const qualityJob of deps.jobs.list(['quality_download'], 10_000)) {
      if (qualityJob.bvid !== bvid) continue;
      if (!deps.jobs.updatePayload(qualityJob.id, { ...qualityJob.payload, downloadUserId: user.id })) {
        throw new Error('Access recovered but the quality task changed before commit');
      }
    }
    deps.jobs.wakeByBvid(bvid, ['quality_download'], deps.now());
    if (!deps.jobs.complete(job.id, deps.owner)) throw new Error('Access probe completion lost its lease');
    return changed;
  });
}
function orderedEnabledUsers(preferredUserId: string, skipped: Set<string>) {
    return deps.users.list()
      .filter((user) => deps.eligible(user) && !skipped.has(user.id))
      .sort((left, right) => {
        if (left.id === preferredUserId) return -1;
        if (right.id === preferredUserId) return 1;
        return left.id.localeCompare(right.id);
      });
  }

function availabilityProbeUsers(bvid: string, preferredUserId: string, skipped: Set<string>, charging: boolean) {
    const related = new Set(deps.state.listRelationsForBvid(bvid)
      .filter((relation) => relation.activeInFavorite && relation.sourceKind !== "manual")
      .map((relation) => relation.userId));
    const ownerUid = Number(deps.state.getVideoMeta(bvid)?.upperMid || 0);
    return orderedEnabledUsers(preferredUserId, skipped).filter((user) => charging
      || related.has(user.id)
      || (ownerUid > 0 && Number(user.uid || user.cookie.DedeUserID || 0) === ownerUid));
  }

function deferChargingAccessProbe(
    job: PersistentJobRecord,
    value: {
      nextAt: number;
      checkedAccountUids: string[];
      previewAvailable?: boolean;
      reason?: string;
    }
  ) {
    const checkedAt = new Date(deps.now()).toISOString();
    const nextCheckAt = new Date(value.nextAt).toISOString();
    deps.state.runAtomic(() => {
      deps.state.markChargingRestricted(String(job.bvid || ""), {
        checkedAt,
        nextCheckAt,
        previewAvailable: value.previewAvailable,
        checkedAccountUids: value.checkedAccountUids,
        lastError: value.reason,
      });
      deps.jobs.updatePayload(job.id, {
        ...(job.payload || {}),
        skipUserIds: [],
        checkedAccountUids: value.checkedAccountUids,
        previewAvailable: value.previewAvailable,
      });
      if (!deps.jobs.defer(job.id, deps.owner, value.reason || "Charging access is not available", value.nextAt)) {
        throw new Error('Access probe reschedule lost its lease');
      }
    });
  }

function deferAvailabilityProbe(
    job: PersistentJobRecord,
    value: {
      nextAt: number;
      state: "pending_confirmation" | "unknown" | "confirmed_unavailable";
      reason: SourceAvailabilityReason;
      checkRound?: number;
      unknownRound?: number;
      message: string;
    }
  ) {
    const checkedAt = new Date(deps.now()).toISOString();
    const nextCheckAt = new Date(value.nextAt).toISOString();
    deps.state.runAtomic(() => {
      const current = deps.jobs.findById(job.id);
      if (!current || current.leaseOwner !== deps.owner || current.attempts !== job.attempts
        || !['leased', 'running'].includes(current.status)) {
        throw new Error('Access probe reschedule lost its lease');
      }
      if (value.state === "pending_confirmation") {
        deps.state.markAvailabilityPending(String(job.bvid || ""), value.reason, checkedAt, nextCheckAt);
      } else if (value.state === "unknown") {
        deps.state.markAvailabilityUnknown(String(job.bvid || ""), value.reason, checkedAt, nextCheckAt, value.unknownRound);
      } else {
        deps.state.markAvailabilityConfirmedUnavailable(String(job.bvid || ""), value.reason, checkedAt, nextCheckAt, value.checkRound);
      }
      deps.jobs.updatePayload(job.id, {
        ...(current.payload || job.payload || {}),
        intents: normalizeAccessProbeIntents(current.payload || job.payload || {}),
        manual: false,
        availabilityRound: value.checkRound ?? Number(current.payload?.availabilityRound || 0),
        availabilityUnknownRound: value.unknownRound ?? Number(current.payload?.availabilityUnknownRound || 0),
        availabilityReason: value.reason,
      });
      if (!deps.jobs.defer(job.id, deps.owner, value.message, value.nextAt)) {
        throw new Error('Access probe reschedule lost its lease');
      }
    });
  }

async function runAvailabilityProbe(job: PersistentJobRecord, beforeRequest: AccessProbeRequestGate) {
    const assertCurrent = checkpoint(job);
    assertCurrent();
    const bvid = String(job.bvid || "");
    if (!bvid) {
      deps.jobs.complete(job.id, deps.owner);
      return;
    }
    const payload = (job.payload || {});
    const intents = normalizeAccessProbeIntents(payload);
    const wantsCharging = intents.includes("charging") || Boolean(deps.state.getChargingRestriction(bvid));
    const wantsLegacyClassification = intents.includes("legacy_classification");
    const manualProbe = payload.manual === true;
    const relations = deps.state.listRelationsForBvid(bvid);
    const hasUnbackedRelation = relations.some((relation) => relation.activeInFavorite
      && ((relation.sourceKind !== "manual" && !relation.selfVisible)
        || (wantsCharging && relation.backupStatus === "charging_restricted"))
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const previousAvailability = deps.state.getSourceAvailability(bvid);
    if (!manualProbe && !hasUnbackedRelation
      && !deps.jobs.hasJobsForBvid(bvid, ["quality_download"])) {
      deps.jobs.complete(job.id, deps.owner);
      return;
    }

    const preferredUserId = String(payload.preferredUserId || "");
    const relatedUsers = new Set(relations
      .filter((relation) => relation.activeInFavorite && relation.sourceKind !== "manual")
      .map((relation) => relation.userId));
    const skipped = new Set<string>(Array.isArray(payload.skipUserIds) ? payload.skipUserIds.map(String) : []);
    const ownerUid = Number(deps.state.getVideoMeta(bvid)?.upperMid || 0);
    const seenAccountUids = new Set<string>();
    const users = availabilityProbeUsers(bvid, preferredUserId, skipped, wantsCharging)
      .sort((left, right) => {
        const leftOwner = ownerUid > 0 && Number(left.uid || left.cookie.DedeUserID || 0) === ownerUid;
        const rightOwner = ownerUid > 0 && Number(right.uid || right.cookie.DedeUserID || 0) === ownerUid;
        if (leftOwner !== rightOwner) return leftOwner ? -1 : 1;
        const leftPreferred = left.id === preferredUserId;
        const rightPreferred = right.id === preferredUserId;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        const leftRelated = relatedUsers.has(left.id);
        const rightRelated = relatedUsers.has(right.id);
        if (leftRelated !== rightRelated) return leftRelated ? -1 : 1;
        return 0;
      })
      .filter((user) => {
        const uid = String(user.uid || user.cookie.DedeUserID || user.id);
        if (seenAccountUids.has(uid)) return false;
        seenAccountUids.add(uid);
        return true;
      });
    const checkedUids = new Set<string>(Array.isArray(payload.checkedAccountUids) ? payload.checkedAccountUids.map(String) : []);
    let unavailableCount = 0;
    let unknownCount = 0;
    let accountBlockedCount = 0;
    let chargingRestrictedCount = 0;
    let recoveredUser: BiliUser | null = null;
    let chargingUser: BiliUser | null = null;
    let availabilityReason: SourceAvailabilityReason =
      payload.availabilityReason === "submission_invisible" ? "submission_invisible" : "api_not_found";
    let transientReason = "";
    let previewAvailable = typeof payload.previewAvailable === "boolean" ? payload.previewAvailable : undefined;

    const preserveManualSchedule = (message: string) => {
      if (!manualProbe || !previousAvailability) return false;
      const checkedAt = new Date(deps.now()).toISOString();
      if (previousAvailability.state === "dormant") {
        deps.state.markAvailabilityDormant(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.checkRound,
        );
        deps.jobs.complete(job.id, deps.owner);
        return true;
      }
      const scheduledAt = Date.parse(previousAvailability.nextCheckAt || "");
      if (!Number.isFinite(scheduledAt) || scheduledAt <= deps.now() + 1_000) return false;
      if (previousAvailability.state === "confirmed_unavailable") {
        deps.state.markAvailabilityConfirmedUnavailable(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
          previousAvailability.checkRound,
        );
      } else if (previousAvailability.state === "unknown") {
        deps.state.markAvailabilityUnknown(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
          previousAvailability.checkRound,
        );
      } else {
        deps.state.markAvailabilityPending(
          bvid,
          previousAvailability.reason,
          checkedAt,
          previousAvailability.nextCheckAt,
        );
      }
      deps.jobs.updatePayload(job.id, { ...payload, intents, manual: false });
      deps.jobs.defer(job.id, deps.owner, message, scheduledAt);
      return true;
    };

    if (users.length === 0) {
      if (preserveManualSchedule("手动复核未发现可用账号，保留原复核计划")) return;
      const nextAt = deps.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      deps.jobs.updatePayload(job.id, { ...payload, intents, manual: false });
      deps.jobs.defer(job.id, deps.owner, "没有已启用的B站账号，等待账号恢复", nextAt);
      return;
    }

    for (const user of users) {
      checkedUids.add(String(user.uid || user.cookie.DedeUserID || user.id));
      try {
        const snapshot = await inspect(user, bvid, assertCurrent, beforeRequest);
        const availability = snapshotAvailability(snapshot);
        if (availability === "available") {
          recoveredUser ||= user;
          previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
          if (snapshot.access.classification === "charging_restricted") {
            chargingRestrictedCount += 1;
            previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
          } else if (["normal", "charging_allowed"].includes(snapshot.access.classification)) {
            chargingUser ||= user;
          }
          if (chargingUser) break;
          continue;
        }
        if (availability === "unavailable") {
          unavailableCount += 1;
          if (unknownCount === 0 && snapshot.availabilityReason === "submission_invisible") availabilityReason = "submission_invisible";
          continue;
        }
        const unknownReason = normalizeSourceAvailabilityReason(snapshot.availabilityReason || "temporary_error");
        availabilityReason = unknownCount === 0 || availabilityReason === unknownReason
          ? unknownReason : "temporary_error";
        unknownCount += 1;
        transientReason = snapshot.availabilityReason === "empty_response"
          ? "B站详情返回空响应"
          : "B站详情暂时无法确认";
      } catch (error: unknown) {
        assertCurrent();
        if (error instanceof BiliRiskOrLoginError || (isRecord(error) && (error.biliRiskControl || error.biliLoginRequired))) {
          accountBlockedCount += 1;
        } else {
          unknownCount += 1;
        }
        availabilityReason = "temporary_error";
        transientReason = sanitizeUploadText(error instanceof Error ? error.message : error).slice(0, 300);
      }
    }

    const checkedAt = new Date(deps.now()).toISOString();
    if (recoveredUser) {
      if (chargingUser) {
        const recovered = commitRecoveredAccess(job, chargingUser, checkedAt,
          { availability: true, charging: wantsCharging || Boolean(deps.state.getChargingRestriction(bvid)), legacy: wantsLegacyClassification }, assertCurrent);
        if (recovered || previousAvailability) logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "info",
          summary: `B站视频已恢复可用 ${bvid}`,
          raw: `[Availability] recovered bvid=${bvid} checkedAccounts=${checkedUids.size}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        return;
      }
      if (chargingRestrictedCount === 0) {
        const unknownRound = Number(payload.availabilityUnknownRound || 0);
        deferAvailabilityProbe(job, { nextAt: deps.now() + computeAvailabilityUnknownDelayMs(unknownRound, bvid),
          state: 'unknown', reason: 'temporary_error', unknownRound: Math.min(unknownRound + 1, AVAILABILITY_UNKNOWN_DELAYS_MS.length),
          message: '视频详情可见，但完整观看权限暂时无法确认' });
        return;
      }
      const nextAt = deps.now() + computeChargingRecheckDelayMs(deps.random);
      deps.state.runAtomic(() => {
        assertCurrent();
        deps.state.markAvailabilityRecovered(bvid, checkedAt);
        if (wantsLegacyClassification) deps.state.markLegacyAccessClassification(bvid, { result: "available", classifiedAt: checkedAt });
        deps.state.markChargingRestricted(bvid, {
          checkedAt, nextCheckAt: new Date(nextAt).toISOString(), previewAvailable, checkedAccountUids: [...checkedUids],
        });
        if (!deps.jobs.updatePayload(job.id, {
          ...payload, intents: ["charging"], manual: false, checkedAccountUids: [...checkedUids], previewAvailable,
        })) throw new Error('Access probe payload changed before commit');
        if (!deps.jobs.defer(job.id, deps.owner, "视频已恢复，但仍需要充电权限", nextAt)) throw new Error('Access probe reschedule lost its lease');
      });
      return;
    }

    if (accountBlockedCount > 0) {
      if (preserveManualSchedule("手动复核遇到账号登录或风控限制，保留原复核计划")) return;
      const nextAt = deps.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      deps.state.markAvailabilityUnknown(
        bvid,
        "temporary_error",
        checkedAt,
        new Date(nextAt).toISOString(),
        Number(payload.availabilityUnknownRound || 0),
      );
      deps.jobs.updatePayload(job.id, { ...payload, intents, manual: false });
      deps.jobs.defer(job.id, deps.owner, transientReason || "账号登录或风控限制，等待账号恢复", nextAt);
      return;
    }

    if (unknownCount > 0) {
      if (preserveManualSchedule("手动复核暂时无法确认，保留原复核计划")) return;
      const unknownRound = Number(payload.availabilityUnknownRound || 0);
      const nextAt = deps.now() + computeAvailabilityUnknownDelayMs(unknownRound, bvid);
      deferAvailabilityProbe(job, {
        nextAt,
        state: "unknown",
        reason: availabilityReason,
        unknownRound: Math.min(unknownRound + 1, AVAILABILITY_UNKNOWN_DELAYS_MS.length),
        message: transientReason || "B站视频状态暂时无法确认，稍后复核",
      });
      return;
    }

    if (unavailableCount > 0) {
      if (preserveManualSchedule("手动复核仍不可用，保留原复核计划")) return;
      const unavailableRound = Number(payload.availabilityRound || 0);
      const nextAt = deps.now() + computeAvailabilityUnavailableDelayMs(unavailableRound, bvid);
      const previous = deps.state.getSourceAvailability(bvid);
      deferAvailabilityProbe(job, {
        nextAt,
        state: "confirmed_unavailable",
        reason: availabilityReason,
        checkRound: Math.min(unavailableRound + 1, AVAILABILITY_UNAVAILABLE_DELAYS_MS.length),
        message: "B站视频当前不可用，系统将在低频复核，不再重复下载",
      });
      if (previous?.state !== "confirmed_unavailable") {
        logManager.push({
          timestamp: checkedAt,
          type: "download",
          level: "warn",
          summary: `B站视频当前不可用，已停止重复下载 ${bvid}`,
          raw: `[Availability] confirmed_unavailable bvid=${bvid} round=${unavailableRound + 1}`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
      }
      if (wantsLegacyClassification) {
        deps.state.markLegacyAccessClassification(bvid, { result: "unavailable", classifiedAt: checkedAt });
      }
      return;
    }

    if (wantsCharging && chargingRestrictedCount > 0) {
      const nextAt = deps.now() + computeChargingRecheckDelayMs(deps.random);
      deps.state.markChargingRestricted(bvid, {
        checkedAt,
        nextCheckAt: new Date(nextAt).toISOString(),
        previewAvailable,
        checkedAccountUids: [...checkedUids],
      });
      deps.jobs.updatePayload(job.id, { ...payload, intents, manual: false, checkedAccountUids: [...checkedUids], previewAvailable });
      deps.jobs.defer(job.id, deps.owner, "视频仍受充电权限限制", nextAt);
      return;
    }

    deferAvailabilityProbe(job, {
      nextAt: deps.now() + computeAvailabilityUnknownDelayMs(Number(payload.availabilityUnknownRound || 0), bvid),
      state: "unknown",
      reason: "temporary_error",
      unknownRound: Number(payload.availabilityUnknownRound || 0) + 1,
      message: "B站视频状态暂时无法确认，稍后复核",
    });
  }

async function runChargingAccessProbe(job: PersistentJobRecord, beforeRequest: AccessProbeRequestGate) {
    const assertCurrent = checkpoint(job);
    assertCurrent();
    const intents = normalizeAccessProbeIntents(job.payload || {});
    if (intents.includes("availability")) {
      await runAvailabilityProbe(job, beforeRequest);
      return;
    }
    const bvid = String(job.bvid || "");
    if (!bvid) {
      deps.jobs.complete(job.id, deps.owner);
      return;
    }
    const relations = deps.state.listRelationsForBvid(bvid);
    const hasUnbackedRelation = relations.some((relation) => relation.activeInFavorite
      && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
    const hasQualityDownload = deps.jobs.hasJobsForBvid(bvid, ["quality_download"]);
    if (!hasUnbackedRelation && !hasQualityDownload) {
      deps.jobs.complete(job.id, deps.owner);
      return;
    }

    const payload = job.payload || {};
    const skipped = new Set<string>(Array.isArray(payload.skipUserIds) ? payload.skipUserIds.map(String) : []);
    const users = orderedEnabledUsers(String(payload.preferredUserId || ""), skipped);
    const checkedUids = new Set<string>(Array.isArray(payload.checkedAccountUids) ? payload.checkedAccountUids.map(String) : []);
    let previewAvailable = typeof payload.previewAvailable === "boolean" ? payload.previewAvailable : undefined;
    let allowedUser: BiliUser | null = null;
    let restrictedCount = skipped.size > 0 ? 1 : 0;
    let unavailableCount = 0;
    let unknownCount = 0;
    let lastTransientError = "";

    if (users.length === 0 && skipped.size === 0) {
      const nextAt = deps.now() + CHARGING_NO_ACCOUNT_DELAY_MS;
      deferChargingAccessProbe(job, {
        nextAt,
        checkedAccountUids: [...checkedUids],
        previewAvailable,
        reason: "没有已启用的B站账号，等待账号恢复",
      });
      return;
    }

    for (const user of users) {
      checkedUids.add(String(user.uid || user.cookie.DedeUserID || user.id));
      try {
        const snapshot = await inspect(user, bvid, assertCurrent, beforeRequest);
        const availability = snapshotAvailability(snapshot);
        if (availability === "unavailable") {
          unavailableCount += 1;
          continue;
        }
        if (availability === "unknown") {
          unknownCount += 1;
          lastTransientError = "B站详情暂时无法确认视频状态";
          continue;
        }
        if (["normal", "charging_allowed"].includes(snapshot.access.classification)) {
          allowedUser = user;
          break;
        }
        if (snapshot.access.classification === "charging_restricted") {
          restrictedCount += 1;
          previewAvailable = snapshot.access.previewAvailable ?? snapshot.access.isUgcPayPreview ?? previewAvailable;
        } else {
          unknownCount += 1;
          lastTransientError = "B站未返回可确认的充电权限字段";
        }
      } catch (error: unknown) {
        assertCurrent();
        unknownCount += 1;
        lastTransientError = sanitizeUploadText(error instanceof Error ? error.message : error).slice(0, 300);
      }
    }

    if (allowedUser) {
      const downloadUser = allowedUser;
      const checkedAt = new Date(deps.now()).toISOString();
      commitRecoveredAccess(job, downloadUser, checkedAt, { availability: Boolean(deps.state.getSourceAvailability(bvid)), charging: true,
        legacy: intents.includes('legacy_classification') }, assertCurrent);
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "info",
        summary: `充电视频权限已恢复 ${bvid}，已恢复符合条件的备份任务`,
        raw: `[ChargingAccess] allowed bvid=${bvid} checkedAccounts=${checkedUids.size}`,
        bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      return;
    }

    if (restrictedCount === 0 && unavailableCount > 0 && unknownCount === 0) {
      const checkedAt = new Date(deps.now()).toISOString();
      const nextAt = deps.now() + computeAvailabilityUnavailableDelayMs(0, bvid);
      deps.state.markAvailabilityConfirmedUnavailable(
        bvid,
        "api_not_found",
        checkedAt,
        new Date(nextAt).toISOString(),
        1,
      );
      deps.jobs.updatePayload(job.id, {
        ...payload,
        purpose: "availability_recheck",
        intents: ["availability"],
        manual: false,
        availabilityRound: 1,
        availabilityReason: "api_not_found",
      });
      deps.jobs.defer(job.id, deps.owner, "充电视频源当前不可用，转为低频可用性复核", nextAt);
      logManager.push({
        timestamp: checkedAt,
        type: "download",
        level: "warn",
        summary: `充电视频源当前不可用，已停止重复下载 ${bvid}`,
        raw: `[ChargingAccess] unavailable bvid=${bvid} checkedAccounts=${checkedUids.size} next=availability_probe`,
        bvid,
        simpleVisible: true,
      });
      return;
    }

    const transient = unknownCount > 0;
    const nextAt = deps.now() + (transient
      ? computeChargingTransientDelayMs(deps.random)
      : computeChargingRecheckDelayMs(deps.random));
    if (payload.purpose === "legacy_failure_classification" && transient) {
      deps.state.markLegacyAccessClassification(bvid, {
        nextCheckAt: new Date(nextAt).toISOString(),
      });
    }
    deferChargingAccessProbe(job, {
      nextAt,
      checkedAccountUids: [...checkedUids],
      previewAvailable,
      reason: transient ? (lastTransientError || "充电权限检查暂时失败") : undefined,
    });
    logManager.push({
      timestamp: new Date(deps.now()).toISOString(),
      type: "download",
      level: transient ? "warn" : "info",
      summary: `${transient ? "充电权限检查暂时失败" : "充电视频仍无观看权限"} ${bvid}，下次检查 ${new Date(nextAt).toISOString()}`,
      raw: `[ChargingAccess] ${transient ? "transient" : "restricted"} bvid=${bvid} checkedAccounts=${checkedUids.size} next=${new Date(nextAt).toISOString()}`,
      bvid,
      simpleVisible: true,
      debugVisible: true,
    });
  }
function failed(job: PersistentJobRecord, error: unknown) {
      const current = deps.jobs.findById(job.id);
      if (!deps.canContinue() || !current || current.leaseOwner !== deps.owner || current.attempts !== job.attempts
        || !['leased', 'running'].includes(current.status)) return;
      if (accessProbeRequestRevision(current.payload) !== accessProbeRequestRevision(job.payload)) {
        rescheduleNewRequest(job);
        return;
      }
      const reason = sanitizeUploadText(error instanceof Error ? error.message : error).slice(0, 300);
      const intents = normalizeAccessProbeIntents(job.payload || {});
      if (intents.includes("availability")) {
        const source = deps.state.getSourceAvailability(String(job.bvid || ""));
        const scheduledAt = Date.parse(source?.nextCheckAt || "");
        if (job.payload?.manual === true && source?.state === "dormant") {
          deps.jobs.complete(job.id, deps.owner);
          return;
        }
        if (job.payload?.manual === true && Number.isFinite(scheduledAt) && scheduledAt > deps.now() + 1_000) {
          deps.jobs.updatePayload(job.id, { ...job.payload, intents, manual: false });
          deps.jobs.defer(job.id, deps.owner, reason, scheduledAt);
          return;
        }
        const unknownRound = Number(job.payload?.availabilityUnknownRound || 0);
        const nextAt = deps.now() + computeAvailabilityUnknownDelayMs(unknownRound, String(job.bvid || ""));
        deferAvailabilityProbe(job, {
          nextAt,
          state: "unknown",
          reason: "temporary_error",
          unknownRound: unknownRound + 1,
          message: reason,
        });
      } else {
        const nextAt = deps.now() + computeChargingTransientDelayMs(deps.random);
        deferChargingAccessProbe(job, {
          nextAt,
          checkedAccountUids: Array.isArray(job.payload?.checkedAccountUids) ? job.payload.checkedAccountUids.map(String) : [],
          previewAvailable: typeof job.payload?.previewAvailable === "boolean" ? job.payload.previewAvailable : undefined,
          reason,
        });
      }

}
async function runCurrent(job: PersistentJobRecord, run: typeof runAvailabilityProbe, beforeRequest: AccessProbeRequestGate) {
  try {
    try { await run(job, beforeRequest); }
    catch (error: unknown) {
      if (!(error instanceof AccessProbeSuperseded)) throw error;
      rescheduleNewRequest(job);
    }
  } catch (error: unknown) {
    // The per-account request boundary already converts external failures to
    // scheduled retries. Failures escaping that boundary must not be retried
    // as if the external service were unavailable.
    throw new AccessProbeStateError(error);
  }
}
const immediateRequest: AccessProbeRequestGate = async check => { check(); };
return {
  availability: (job: PersistentJobRecord, beforeRequest = immediateRequest) => runCurrent(job, runAvailabilityProbe, beforeRequest),
  charging: (job: PersistentJobRecord, beforeRequest = immediateRequest) => runCurrent(job, runChargingAccessProbe, beforeRequest),
  users: availabilityProbeUsers, failed,
};
}
