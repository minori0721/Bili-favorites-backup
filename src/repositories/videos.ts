import { isoToMs, optionalIsoToMs } from './values.js';
import type Database from 'better-sqlite3';
import type { VideoArchiveEntry } from '../state.js';

export interface VideoRow {
  payload_json: string;
  aggregate_status?: VideoArchiveEntry['backupStatus'] | null;
}
export interface VideoRepository {
  upsert(video: VideoArchiveEntry, now: number, bvid?: string): void;
  remove(bvid: string): void;
  listStaleVideos(statuses: string[], before: number): VideoArchiveEntry[];

  listVideosForResume(statuses: string[]): VideoArchiveEntry[];

  listVideosByStatuses(statuses: string[]): VideoArchiveEntry[];

  listDormantAvailabilityVideos(limit?: number): VideoArchiveEntry[];

  listAvailabilityCheckVideos(limit?: number): VideoArchiveEntry[];

  listChargingRestrictedVideos(): VideoArchiveEntry[];

  listRecoveryNormalizationVideos(afterBvid: string, statuses: string[], limit?: number): VideoArchiveEntry[];

  get(bvid: string): VideoArchiveEntry | undefined;
  listByIds(bvids: string[]): VideoArchiveEntry[];
  list(): VideoArchiveEntry[];
}

/** Database projection decoding is supplied separately from query/connection ownership. */
export class SqliteVideoRepository implements VideoRepository {
  constructor(
    private readonly connection: () => Database.Database,
    private readonly decode: (row: VideoRow) => VideoArchiveEntry,
  ) { }
  get(bvid: string) {
    const row = this.connection().prepare<[string], VideoRow>(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE v.bvid=?
    `).get(bvid);
    return row ? this.decode(row) : undefined;
  }
  listByIds(bvids: string[]) {
    const unique = [...new Set(bvids.map(bvid => String(bvid || '').trim()).filter(Boolean))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.connection().prepare<string[], VideoRow>(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE v.bvid IN (${placeholders})
    `).all(...unique);
    return this.decodeRows(rows);
  }
  list() {
    const rows = this.connection().prepare<[], VideoRow>(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
    `).all();
    return this.decodeRows(rows);
  }
  private decodeRows(rows: VideoRow[]): VideoArchiveEntry[] {
    return rows.map(row => this.decode(row));
  }
  listRecoveryNormalizationVideos(afterBvid: string, statuses: string[], limit = 500) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], VideoRow>(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v
      LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE v.bvid>?
        AND (
          v.local_dir IS NOT NULL
          OR v.backup_status IN (${placeholders})
          OR EXISTS (
            SELECT 1 FROM favorite_relations r
            WHERE r.bvid=v.bvid AND r.backup_status IN (${placeholders})
          )
        )
      ORDER BY v.bvid ASC
      LIMIT ?
    `).all(afterBvid, ...statuses, ...statuses, Math.max(1, Math.floor(limit))))
      .map(row => this.decode(row))
      ;
  }
  listChargingRestrictedVideos() {
    return (this.connection().prepare<unknown[], VideoRow>("SELECT payload_json FROM videos WHERE access_restriction_type='charging'").all())
      .map(row => this.decode(row))
      ;
  }
  listAvailabilityCheckVideos(limit = 10_000) {
    return (this.connection().prepare<unknown[], VideoRow>(`
      SELECT v.payload_json, summary.backup_status AS aggregate_status
      FROM videos v
      LEFT JOIN video_backup_summary summary ON summary.bvid=v.bvid
      WHERE (
          json_extract(v.payload_json, '$.sourceAvailability.state') IN ('pending_confirmation','unknown','confirmed_unavailable')
          OR (
            json_extract(v.payload_json, '$.sourceAvailability.state') IS NULL
            AND json_extract(v.payload_json, '$.biliStatus')='unavailable'
            AND COALESCE(json_extract(v.payload_json, '$.favoriteUnavailable'), 0)=1
          )
        )
        AND EXISTS (
          SELECT 1 FROM favorite_relations r
          WHERE r.bvid=v.bvid
            AND r.active_in_favorite=1
            AND COALESCE(r.source_kind, 'favorite')='favorite'
            AND COALESCE(r.backup_status, 'discovered') NOT IN ('uploaded','verified','partial_verified')
        )
      ORDER BY COALESCE(json_extract(v.payload_json, '$.sourceAvailability.nextCheckAt'), '') ASC, v.bvid ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(100_000, Math.floor(limit)))))
      .map(row => this.decode(row))
      ;
  }
  listDormantAvailabilityVideos(limit = 10_000) {
    return (this.connection().prepare<unknown[], VideoRow>(`
      SELECT v.payload_json
      FROM videos v
      WHERE json_extract(v.payload_json, '$.sourceAvailability.state')='dormant'
        AND EXISTS (
          SELECT 1 FROM favorite_relations r
          WHERE r.bvid=v.bvid
            AND r.active_in_favorite=1
            AND COALESCE(r.source_kind, 'favorite')='favorite'
            AND COALESCE(r.self_visible, 0)=0
            AND COALESCE(r.backup_status, 'discovered') NOT IN ('uploaded','verified','partial_verified')
        )
      ORDER BY v.bvid ASC
      LIMIT ?
    `).all(Math.max(1, Math.min(100_000, Math.floor(limit)))))
      .map(row => this.decode(row))
      ;
  }
  listVideosByStatuses(statuses: string[]) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], VideoRow>(`SELECT payload_json FROM videos WHERE backup_status IN (${placeholders})`).all(...statuses))
      .map(row => this.decode(row));
  }
  listVideosForResume(statuses: string[]) {
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], VideoRow>(`
      SELECT DISTINCT v.payload_json FROM videos v
      LEFT JOIN favorite_relations r ON r.bvid=v.bvid
      WHERE v.backup_status IN (${placeholders})
        OR (v.local_dir IS NOT NULL AND r.backup_status IN ('verified','partial_verified'))
    `).all(...statuses)).map(row => this.decode(row));
  }
  listStaleVideos(statuses: string[], before: number) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], VideoRow>(`SELECT payload_json FROM videos WHERE backup_status IN (${placeholders}) AND updated_at <= ?`).all(...statuses, before))
      .map(row => this.decode(row));
  }
  upsert(video: VideoArchiveEntry, now: number, bvid = video.bvid) { this.createWriter().upsert(video, now, bvid); }
  remove(bvid: string) { this.createWriter().remove(bvid); }
  /** Scoped to one synchronous flush; prepared statements never survive a rebind. */
  createWriter(): Pick<VideoRepository, 'upsert' | 'remove'> {
    const connection = this.connection();
    const save = connection.prepare(`
      INSERT INTO videos(bvid, backup_status, bili_status, local_dir, access_restriction_type,
        access_last_checked_at, payload_json, updated_at)
      VALUES(@bvid, @backupStatus, @biliStatus, @localDir, @accessRestrictionType,
        @accessLastCheckedAt, @payload, @updatedAt)
      ON CONFLICT(bvid) DO UPDATE SET backup_status=excluded.backup_status, bili_status=excluded.bili_status,
        local_dir=excluded.local_dir, access_restriction_type=excluded.access_restriction_type,
        access_last_checked_at=excluded.access_last_checked_at, payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `);
    const remove = connection.prepare('DELETE FROM videos WHERE bvid=?');
    return {
      upsert(video: VideoArchiveEntry, now: number, bvid = video.bvid) { save.run({
          bvid,
          backupStatus: video.backupStatus || "discovered",
          biliStatus: video.biliStatus || "unknown",
          localDir: video.localDir || null,
          accessRestrictionType: video.accessRestriction?.type || null,
          accessLastCheckedAt: optionalIsoToMs(video.accessRestriction?.lastCheckedAt),
          payload: JSON.stringify(video),
          updatedAt: isoToMs(video.statusUpdatedAt || video.lastSeenAt, now),
        }); },
      remove(bvid: string) { remove.run(bvid); },
    };
  }

}
