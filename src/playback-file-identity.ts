import { createHash } from 'node:crypto';

/** A file incarnation, not a bookkeeping timestamp. Never expose storage paths. */
export function playbackFileFingerprint(file: {
  id: number;
  bvid: string;
  remotePath: string;
  size?: number | null;
  putCompletedAt?: number | null;
}): string {
  return createHash('sha256').update(JSON.stringify([
    file.id, file.bvid, file.remotePath, file.size ?? null, file.putCompletedAt ?? null,
  ])).digest('hex');
}
