// Pure scheduling rules. Time and randomness are explicit inputs for deterministic tests.
export function computeDownloadStartDelayMs(random: () => number = Math.random) {
  return 3_000 + Math.min(3_000, Math.floor(Math.max(0, random()) * 3_001));
}

export const ISOLATED_DETERMINISTIC_UPLOAD_RETRY_MS = 6 * 60 * 60_000;

export const UPLOAD_SESSION_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000];

export const UPLOAD_VERIFY_SCHEDULE_MS = [2_000, 10_000, 30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

export const UPLOAD_VERIFY_REUPLOAD_DELAY_MS = 30 * 60_000;

export const CHARGING_RECHECK_BASE_MS = 7 * 24 * 60 * 60_000;

export const CHARGING_RECHECK_JITTER_MS = 12 * 60 * 60_000;

export const CHARGING_TRANSIENT_BASE_MS = 6 * 60 * 60_000;

export const CHARGING_TRANSIENT_JITTER_MS = 30 * 60_000;

export const CHARGING_NO_ACCOUNT_DELAY_MS = 24 * 60 * 60_000;

export const AVAILABILITY_UNKNOWN_DELAYS_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;

export const AVAILABILITY_UNAVAILABLE_DELAYS_MS = [24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000] as const;

export const LOCAL_CLEANUP_RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;

export const AUTOMATIC_RECOVERY_REDOWNLOAD_LIMIT = 3;

export const AUTOMATIC_QUALITY_RECOVERY_LIMIT = 2;

export const AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS = [15 * 60_000, 60 * 60_000] as const;

export function computeUploadVerificationTiming(putAcceptedAtValues: number[], now = Date.now()) {
  const acceptedAt = putAcceptedAtValues.filter((value) => Number.isFinite(value) && value > 0);
  if (acceptedAt.length === 0) return { timedOut: false, nextAt: undefined };
  const timeoutMs = UPLOAD_VERIFY_SCHEDULE_MS[UPLOAD_VERIFY_SCHEDULE_MS.length - 1];
  const timedOut = acceptedAt.every((value) => value + timeoutMs <= now);
  if (timedOut) return { timedOut: true, nextAt: undefined };
  const candidates = acceptedAt.flatMap((value) => UPLOAD_VERIFY_SCHEDULE_MS
    .map((delayMs) => value + delayMs)
    .filter((at) => at > now + 250));
  const nextAt = candidates.length > 0
    ? Math.min(...candidates)
    : Math.min(...acceptedAt.map((value) => value + timeoutMs).filter((at) => at > now));
  return { timedOut: false, nextAt: Number.isFinite(nextAt) ? nextAt : now + 1_000 };
}

function jitteredDelay(baseMs: number, jitterMs: number, random: () => number) {
  const normalized = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(1_000, Math.round(baseMs - jitterMs + normalized * jitterMs * 2));
}

export function computeChargingRecheckDelayMs(random: () => number = Math.random) {
  return jitteredDelay(CHARGING_RECHECK_BASE_MS, CHARGING_RECHECK_JITTER_MS, random);
}

export function computeChargingTransientDelayMs(random: () => number = Math.random) {
  return jitteredDelay(CHARGING_TRANSIENT_BASE_MS, CHARGING_TRANSIENT_JITTER_MS, random);
}

export function computeAvailabilityUnknownDelayMs(round: number, bvid = "") {
  const index = Math.max(0, Math.min(AVAILABILITY_UNKNOWN_DELAYS_MS.length - 1, Math.floor(Number(round) || 0)));
  return AVAILABILITY_UNKNOWN_DELAYS_MS[index] + availabilityJitter(bvid);
}

export function computeAvailabilityUnavailableDelayMs(round: number, bvid = "") {
  const index = Math.max(0, Math.min(AVAILABILITY_UNAVAILABLE_DELAYS_MS.length - 1, Math.floor(Number(round) || 0)));
  return AVAILABILITY_UNAVAILABLE_DELAYS_MS[index] + availabilityJitter(bvid);
}

export function availabilityJitter(bvid: string) {
  let hash = 0;
  for (const char of String(bvid || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return bvid ? hash % (15 * 60_000) : 0;
}

export function computeUploadSessionRetryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(UPLOAD_SESSION_RETRY_DELAYS_MS.length - 1, Math.floor(attempts || 0)));
  return UPLOAD_SESSION_RETRY_DELAYS_MS[index];
}

export function computeQualityCleanupRetryDelayMs(attempts: number, random: () => number = Math.random) {
  const minimum = 60_000;
  const maximum = 6 * 60 * 60_000;
  const base = Math.min(maximum, minimum * (2 ** Math.max(0, Math.min(20, Math.floor(attempts || 0)))));
  const normalized = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(minimum, Math.min(maximum, Math.round(base * (0.8 + normalized * 0.4))));
}

export function computeLocalCleanupRetryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(LOCAL_CLEANUP_RETRY_DELAYS_MS.length - 1, Math.floor(Number(attempts) || 0)));
  return LOCAL_CLEANUP_RETRY_DELAYS_MS[index];
}

export function computeAutomaticQualityRecoveryDelayMs(attempts: number) {
  const index = Math.max(0, Math.min(AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS.length - 1, Math.floor(Number(attempts) || 0)));
  return AUTOMATIC_QUALITY_RECOVERY_DELAYS_MS[index];
}
