import type { StateManager } from '../state.js';
import { isRecord } from '../shared/api/value.js';

/** Resolve the current connection for each synchronous read; never retain one across an await. */
export function createLocalCleanupStorage(state: Pick<StateManager, 'getDatabase'>) {
  return {
    video(bvid: string) { return state.getDatabase().getVideo(bvid); },
    sessionStamp(bvid: string) {
      return JSON.stringify(state.getDatabase().db.prepare(
        'SELECT id, generation, phase FROM transfer_sessions WHERE bvid=? ORDER BY id',
      ).all(bvid));
    },
    trackedDirectories(bvid: string) {
      const database = state.getDatabase();
      const directories = new Set<string>([database.getVideo(bvid)?.localDir || '']);
      for (const row of database.db.prepare('SELECT local_dir FROM transfer_sessions WHERE bvid=?').all(bvid)) {
        if (isRecord(row) && typeof row.local_dir === 'string') directories.add(row.local_dir);
      }
      for (const row of database.db.prepare('SELECT payload_json FROM jobs WHERE bvid=?').all(bvid)) {
        if (!isRecord(row) || typeof row.payload_json !== 'string') continue;
        const payload: unknown = JSON.parse(row.payload_json);
        if (!isRecord(payload)) continue;
        const retry = isRecord(payload.encodingRetry) ? payload.encodingRetry : {};
        for (const directory of [payload.localDir, payload.downloadDir, retry.candidateLocalDir, retry.originalLocalDir]) {
          if (typeof directory === 'string') directories.add(directory);
        }
      }
      return [...directories];
    },
  };
}
