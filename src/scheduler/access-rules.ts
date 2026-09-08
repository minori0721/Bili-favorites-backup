import type { VideoPageSnapshotResult } from '../bili.js';
import type { SourceAvailabilityReason } from '../state.js';
import { isRecord } from '../shared/api/value.js';

export type AccessProbeIntent = "charging" | "availability" | "legacy_classification";

export function normalizeAccessProbeIntents(payload: Record<string, unknown> | undefined): AccessProbeIntent[] {
  const explicit = Array.isArray(payload?.intents)
    ? payload.intents.map(String).filter((value): value is AccessProbeIntent =>
      value === "charging" || value === "availability" || value === "legacy_classification")
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];
  if (payload?.purpose === "legacy_failure_classification") return ["legacy_classification", "availability"];
  if (payload?.purpose === "availability_recheck") return ["availability"];
  return ["charging"];
}

export function snapshotAvailability(snapshot: VideoPageSnapshotResult): "available" | "unavailable" | "unknown" {
  if (snapshot.availability === "available" || snapshot.availability === "unavailable" || snapshot.availability === "unknown") {
    return snapshot.availability;
  }
  return snapshot.available ? "available" : "unavailable";
}

export function isSourceUnavailableFailure(error: unknown) {
  if (!isRecord(error)) return false;
  return error.code === "BILI_VIDEO_UNAVAILABLE"
    || error.downloadFailureCategory === "source_unavailable";
}

export function normalizeSourceAvailabilityReason(value: unknown): SourceAvailabilityReason {
  if (value === "under_review" || value === "uploader_only") return value;
  if (value === "submission_invisible") return "submission_invisible";
  if (value === "temporary_error" || value === "empty_response") return "temporary_error";
  if (value === "favorite_unavailable") return "favorite_flag";
  return "api_not_found";
}
