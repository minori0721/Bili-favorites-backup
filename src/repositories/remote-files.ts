import type Database from 'better-sqlite3';
import path from 'node:path';
import type { RemoteFileRecord } from '../state.js';
import { isoToMs } from './values.js';

export interface RemoteFileRepository {
  replaceSource(bvid: string, userId: string, mediaId: number, files: RemoteFileRecord[], now: number): void;
}

/** Called inside the owner's state transaction; never caches a connection or commits independently. */
export class SqliteRemoteFileRepository implements RemoteFileRepository {
  constructor(private readonly connection: () => Database.Database) { }
  replaceSource(bvid: string, userId: string, mediaId: number, files: RemoteFileRecord[], now: number) {
    const db = this.connection();
    const existing = db.prepare<[string, string, number], {
      id: number; remote_path: string; expected_size: number | null; put_completed_at: number | null;
    }>("SELECT id, remote_path, expected_size, put_completed_at FROM remote_files WHERE bvid=? AND user_id=? AND media_id=?")
      .all(bvid, userId, mediaId);
    const byPath = new Map(existing.map(row => [row.remote_path, row]));
    const seen = new Set<string>();
    const remove = db.prepare('DELETE FROM remote_files WHERE id=?');
    const insert = db.prepare(`
      INSERT INTO remote_files(
        bvid, user_id, media_id, kind, local_relative_path, name, remote_path, expected_size,
        status, quality_json, actual_width, actual_height, actual_fps, actual_duration, actual_codec,
        actual_metadata_source, actual_metadata_at, put_completed_at, verify_attempts, next_verify_at,
        last_error, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, media_id, bvid, remote_path) DO UPDATE SET
        local_relative_path=excluded.local_relative_path, name=excluded.name,
        expected_size=excluded.expected_size, status=excluded.status, quality_json=excluded.quality_json,
        actual_width=excluded.actual_width, actual_height=excluded.actual_height,
        actual_fps=excluded.actual_fps, actual_duration=excluded.actual_duration,
        actual_codec=excluded.actual_codec, actual_metadata_source=excluded.actual_metadata_source,
        actual_metadata_at=excluded.actual_metadata_at,
        put_completed_at=COALESCE(excluded.put_completed_at,remote_files.put_completed_at),
        verify_attempts=excluded.verify_attempts, next_verify_at=excluded.next_verify_at,
        last_error=excluded.last_error, updated_at=excluded.updated_at
    `);
    for (const file of files) {
      if (seen.has(file.path)) throw new Error('Duplicate remote file path in source');
      seen.add(file.path);
      const previous = byPath.get(file.path);
      const putAt = file.putCompletedAt ? isoToMs(file.putCompletedAt, now) : null;
      // Bookkeeping preserves IDs; an explicit new upload or changed known size
      // invalidates URLs for the old file incarnation, even at the same path.
      if (previous && ((putAt !== null && putAt !== previous.put_completed_at)
        || (typeof file.size === 'number' && previous.expected_size !== null && file.size !== previous.expected_size))) {
        remove.run(previous.id);
      }
      insert.run(
        bvid,
        userId,
        mediaId,
        "main",
        file.localRelativePath || null,
        String(file.name || path.posix.basename(file.path || "file")),
        String(file.path || ""),
        typeof file.size === "number" ? file.size : null,
        file.verificationStatus || "verified",
        file.qualityProfile ? JSON.stringify(file.qualityProfile) : null,
        file.mediaMetadata && Number.isInteger(file.mediaMetadata.width) ? file.mediaMetadata.width : null,
        file.mediaMetadata && Number.isInteger(file.mediaMetadata.height) ? file.mediaMetadata.height : null,
        file.mediaMetadata && Number.isFinite(file.mediaMetadata.fps) ? file.mediaMetadata.fps : null,
        file.mediaMetadata && Number.isFinite(file.mediaMetadata.duration) ? file.mediaMetadata.duration : null,
        file.mediaMetadata?.codec || null,
        file.mediaMetadata?.source || null,
        file.mediaMetadata?.observedAt ? isoToMs(file.mediaMetadata.observedAt, now) : null,
        putAt,
        Number(file.verifyAttempts || 0),
        file.nextVerifyAt ? isoToMs(file.nextVerifyAt, now) : null,
        file.lastError || null,
        now
      );
    }
    for (const previous of existing) if (!seen.has(previous.remote_path)) remove.run(previous.id);
  }

}
