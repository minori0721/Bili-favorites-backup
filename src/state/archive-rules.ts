import type { BackupStatus, ObservedFavoriteItem, VideoArchiveEntry, FavoriteRelation, SourceAvailabilityState } from '../state.js';

export const BACKED_UP_STATUSES = new Set<BackupStatus>(["uploaded", "verified", "partial_verified"]);

export function isPlaceholderTitle(value: string | undefined) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(Untitled|Unknown|已失效视频|已删除视频|视频已失效|视频不存在)$/i.test(text);
}
export function isPlaceholderUpperName(value: string | undefined) {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(Unknown|未知UP|未知)$/i.test(text);
}
export function hasUsableFavoriteMeta(item: ObservedFavoriteItem) {
  if (item.unavailable && !item.selfVisible) return false;
  return !isPlaceholderTitle(item.title) || !isPlaceholderUpperName(item.upperName) || Boolean(item.cover);
}
export function displayTitle(entry: VideoArchiveEntry) {
  return entry.originalMeta?.title || entry.title || entry.bvid;
}

export function displayUpperName(entry: VideoArchiveEntry) {
  return entry.originalMeta?.upperName || entry.upperName || "Unknown";
}

export function displayCover(entry: VideoArchiveEntry) {
  return entry.originalMeta?.cover || entry.cover;
}

export function displayCoverLocalPath(entry: VideoArchiveEntry) {
  return entry.originalMeta?.coverLocalPath;
}

export function displayDescription(entry: VideoArchiveEntry) {
  return entry.originalMeta?.description || entry.description;
}

const CONFIRMED_SOURCE_AVAILABILITY_STATES = new Set<SourceAvailabilityState>([
  "confirmed_unavailable",
  "dormant",
]);
const TRACKED_SOURCE_AVAILABILITY_STATES = new Set<SourceAvailabilityState>([
  "pending_confirmation",
  "unknown",
  "confirmed_unavailable",
  "dormant",
]);

const SOURCE_AVAILABILITY_ERROR_MESSAGES = new Set([
  "Video became unavailable before a verified backup was found.",
  "Video is currently unavailable on Bilibili.",
  "Video unavailable while resuming backup.",
]);

export function isSourceAvailabilityError(value: unknown) {
  const message = String(value || "").trim();
  if (SOURCE_AVAILABILITY_ERROR_MESSAGES.has(message)) return true;
  if (message.startsWith("视频不可用（已删除、下架或不可见）:")) return true;
  return message.startsWith("BBDown reported failure:")
    && /(视频不存在|稿件不可见|已失效|资源不可用)/.test(message);
}

export function sourceIsConfirmedUnavailable(entry: VideoArchiveEntry) {
  if (entry.selfVisible) return false;
  const state = entry.sourceAvailability?.state;
  if (state) return CONFIRMED_SOURCE_AVAILABILITY_STATES.has(state);
  // Legacy state files predate sourceAvailability. Only retain their old
  // unavailable meaning when the favorite endpoint explicitly said so.
  return entry.biliStatus === "unavailable" && Boolean(entry.favoriteUnavailable);
}

export function sourceBlocksBackup(relation: FavoriteRelation | undefined | null, entry: VideoArchiveEntry) {
  if (relation?.sourceKind === "manual" || relation?.selfVisible || entry.selfVisible) return false;
  if (entry.sourceAvailability) return TRACKED_SOURCE_AVAILABILITY_STATES.has(entry.sourceAvailability.state);
  return entry.biliStatus === "unavailable"
    && Boolean(entry.favoriteUnavailable || relation?.favoriteUnavailable);
}

export function relationTreatsUnavailable(relation: FavoriteRelation | undefined | null, entry: VideoArchiveEntry) {
  if (relation?.sourceKind === "manual" || relation?.selfVisible || entry.selfVisible) return false;
  return sourceIsConfirmedUnavailable(entry)
    || (entry.biliStatus === "unavailable" && Boolean(entry.favoriteUnavailable || relation?.favoriteUnavailable));
}

// Display-only evidence: never use a favorite flag to authorize download/recovery decisions.
export function archivedSourceUnavailable(relation: FavoriteRelation, video: VideoArchiveEntry) {
  return BACKED_UP_STATUSES.has(relation.backupStatus || video.backupStatus)
    && relation.sourceKind !== "manual" && !relation.selfVisible
    && (Boolean(relation.favoriteUnavailable) || video.biliStatus === "unavailable");
}
