export interface DownloadRecoveryTarget {
  userId: string;
  mediaId: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Collects legacy and current relation identities without touching scheduler state. */
export function downloadRecoveryTargets(job: unknown): DownloadRecoveryTarget[] {
  const item = record(job);
  const payload = record(item.payload);
  const candidates: unknown[] = [
    ...(Array.isArray(record(payload.downloadRecovery).targets) ? record(payload.downloadRecovery).targets as unknown[] : []),
    ...(Array.isArray(payload.detachedTargets) ? payload.detachedTargets : []),
    ...(payload.primaryUserId && Number.isInteger(Number(payload.primaryMediaId))
      ? [{ userId: payload.primaryUserId, mediaId: Number(payload.primaryMediaId) }]
      : []),
    ...(item.userId && Number.isInteger(Number(item.mediaId))
      ? [{ userId: item.userId, mediaId: Number(item.mediaId) }]
      : []),
  ];
  const targets = new Map<string, DownloadRecoveryTarget>();
  for (const candidateValue of candidates) {
    const candidate = record(candidateValue);
    const userId = String(candidate.userId || '');
    const mediaId = Number(candidate.mediaId);
    if (!userId || !Number.isInteger(mediaId)) continue;
    targets.set(`${userId}:${mediaId}`, { userId, mediaId });
  }
  return [...targets.values()];
}

export function parseLegacyDownloadFailureKey(value: unknown) {
  const parts = String(value || '').split(':');
  if (parts.length < 3) return null;
  const userId = String(parts.shift() || '');
  const mediaId = Number(parts.shift());
  const bvid = parts.join(':');
  if (!userId || !Number.isInteger(mediaId) || mediaId <= 0 || !bvid) return null;
  return { userId, mediaId, bvid };
}
