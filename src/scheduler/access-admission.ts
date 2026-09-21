import type { StateManager } from '../state.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { SourceAvailabilityReason } from '../state.js';
import type { BiliUser } from '../users.js';
import { normalizeAccessProbeIntents, type AccessProbeIntent } from './access-rules.js';
interface Dependencies {
  state: Pick<StateManager, 'getChargingRestriction' | 'getVideoMeta' | 'getSourceAvailability'>;
  jobs: Pick<JobRepository, 'findByDedupeKey' | 'findById' | 'enqueue' | 'updatePayload'>;
  now(): number;
  users(bvid: string, charging: boolean): BiliUser[];
  wake(): void;
}
export function createAccessAdmission(deps: Dependencies) {
  function enqueueChargingAccessProbe(
    bvid: string,
    input: {
      preferredUserId?: string;
      skipUserIds?: string[];
      checkedAccountUids?: string[];
      previewAvailable?: boolean;
      notBefore?: number;
      purpose?: "charging_recheck" | "availability_recheck" | "legacy_failure_classification";
      intents?: AccessProbeIntent[];
      availabilityRound?: number;
      availabilityUnknownRound?: number;
      availabilityReason?: SourceAvailabilityReason;
      manual?: boolean;
    } = {}
  ) {
    const existing = deps.state.getChargingRestriction(bvid);
    const existingJob = deps.jobs.findByDedupeKey(`access_probe:${bvid}`);
    const existingPayload = existingJob?.payload || {};
    const incomingIntents: AccessProbeIntent[] = input.intents || (input.purpose === "legacy_failure_classification"
      ? ["legacy_classification", "availability"]
      : input.purpose === "availability_recheck"
        ? ["availability"]
        : ["charging"]);
    const intents = [...new Set([
      ...(existingJob ? normalizeAccessProbeIntents(existingPayload) : []),
      ...incomingIntents,
    ])];
    const checkedAccountUids = [...new Set([
      ...(Array.isArray(existing?.checkedAccountUids) ? existing.checkedAccountUids : []),
      ...(Array.isArray(existingPayload.checkedAccountUids) ? existingPayload.checkedAccountUids : []),
      ...(input.checkedAccountUids || []),
    ].map(String))];
    const existingAvailabilityRound = Math.max(0, Number(existingPayload.availabilityRound || 0));
    const incomingAvailabilityRound = Math.max(0, Number(input.availabilityRound ?? 0));
    const existingUnknownRound = Math.max(0, Number(existingPayload.availabilityUnknownRound || 0));
    const incomingUnknownRound = Math.max(0, Number(input.availabilityUnknownRound ?? 0));
    const purpose = input.purpose
      || existingPayload.purpose
      || (intents.includes("availability") && !intents.includes("charging") ? "availability_recheck" : "charging_recheck");
    const notBefore = Math.min(
      Number.isFinite(Number(existingJob?.notBefore)) && Number(existingJob?.notBefore) > 0 ? Number(existingJob!.notBefore) : Number.MAX_SAFE_INTEGER,
      input.notBefore ?? deps.now(),
    );
    const payload = {
      ...existingPayload,
      preferredUserId: input.preferredUserId || existingPayload.preferredUserId || "",
      skipUserIds: input.skipUserIds || existingPayload.skipUserIds || [],
      checkedAccountUids: checkedAccountUids.map(String),
      previewAvailable: input.previewAvailable ?? existing?.previewAvailable ?? existingPayload.previewAvailable,
      purpose,
      intents,
      availabilityRound: Math.max(existingAvailabilityRound, incomingAvailabilityRound),
      availabilityUnknownRound: Math.max(existingUnknownRound, incomingUnknownRound),
      availabilityReason: input.availabilityReason || existingPayload.availabilityReason,
      manual: input.manual === true || existingPayload.manual === true,
    };
    const job = deps.jobs.enqueue({
      kind: "access_probe",
      dedupeKey: `access_probe:${bvid}`,
      bvid,
      priority: 90,
      maxAttempts: 1,
      notBefore: Math.max(0, Number.isFinite(notBefore) ? notBefore : deps.now()),
      payload,
    });
    // enqueue intentionally preserves a leased/running payload. Merge a newly
    // discovered intent into that active job without touching its lease.
    if (existingJob && ["leased", "running"].includes(existingJob.status)) {
      deps.jobs.updatePayload(existingJob.id, payload);
      return deps.jobs.findById(existingJob.id) || job;
    }
    return job;
  }

  function enqueueAvailabilityProbe(
    bvid: string,
    input: {
      preferredUserId?: string;
      notBefore?: number;
      availabilityRound?: number;
      availabilityUnknownRound?: number;
      availabilityReason?: SourceAvailabilityReason;
      manual?: boolean;
    } = {}
  ) {
    return enqueueChargingAccessProbe(bvid, {
      preferredUserId: input.preferredUserId,
      notBefore: input.notBefore,
      availabilityRound: input.availabilityRound,
      availabilityUnknownRound: input.availabilityUnknownRound,
      availabilityReason: input.availabilityReason,
      manual: input.manual,
      intents: ["availability"],
    });
  }

  function requestAvailabilityRecheck(bvidValue: string) {
    const bvid = String(bvidValue || "").trim();
    if (!bvid || !deps.state.getVideoMeta(bvid)) {
      return { ok: false as const, status: 404 as const, message: "本地没有该视频记录" };
    }
    const existing = deps.jobs.findByDedupeKey(`access_probe:${bvid}`);
    const charging = Boolean(deps.state.getChargingRestriction(bvid))
      || Boolean(existing && normalizeAccessProbeIntents(existing.payload).includes("charging"));
    if (deps.users(bvid, charging).length === 0) {
      return { ok: false as const, status: 409 as const, message: "当前没有可用的相关账号，请登录并启用收藏所属账号或UP主账号" };
    }
    const current = deps.state.getSourceAvailability(bvid);
    const job = enqueueChargingAccessProbe(bvid, {
      intents: charging ? ["availability", "charging"] : ["availability"],
      notBefore: deps.now(),
      availabilityRound: current?.state === "confirmed_unavailable" ? current.checkRound : 0,
      availabilityUnknownRound: current?.state === "unknown" ? current.checkRound : 0,
      availabilityReason: current?.reason || "temporary_error",
      manual: true,
    });
    deps.wake();
    return { ok: true as const, status: 202 as const, jobId: job.id, bvid };
  }

  return {enqueueChargingAccessProbe, enqueueAvailabilityProbe, requestAvailabilityRecheck};
}
