import type { StateDatabase } from "./database.js";

export interface RemoteReferenceStats {sourceReferenceCount: number; uniqueRemotePathCount: number}

/** One directory at a time; keep the same source/deletion boundary as navigation. */
export function readDirectoryReferenceStats(database: StateDatabase, userIds: string[], mediaId?: number): RemoteReferenceStats {
  if (userIds.length === 0) return {sourceReferenceCount:0,uniqueRemotePathCount:0};
  const row=database.db.prepare<unknown[],{source_reference_count:number;unique_remote_path_count:number}>(`
    SELECT COUNT(*) AS source_reference_count, COUNT(DISTINCT rf.remote_path) AS unique_remote_path_count
    FROM remote_files rf
    JOIN favorite_relations r ON r.user_id=rf.user_id AND r.media_id=rf.media_id AND r.bvid=rf.bvid
    WHERE rf.user_id<>'' AND rf.user_id IN (${userIds.map(()=>'?').join(',')})
      ${mediaId === undefined ? '' : 'AND rf.media_id=?'}
      AND NOT EXISTS (
        SELECT 1 FROM archive_deleted_sources ads
        WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid AND ads.status='completed'
      )
  `).get(...userIds,...(mediaId === undefined ? [] : [mediaId]));
  if (!row || !Number.isSafeInteger(row.source_reference_count) || row.source_reference_count<0
    || !Number.isSafeInteger(row.unique_remote_path_count) || row.unique_remote_path_count<0
    || row.unique_remote_path_count>row.source_reference_count) throw new Error('Invalid directory reference counts');
  return {sourceReferenceCount:row.source_reference_count,uniqueRemotePathCount:row.unique_remote_path_count};
}

// Current source references only; video-level copies and completed deletions
// are not extra files. Counts describe the local index, not a remote scan.
export function readRemoteReferenceStats(database: StateDatabase, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, { sourceReferenceCount: number; uniqueRemotePathCount: number }>();
  const placeholders = userIds.map(() => "?").join(",");
  const rows = database.db.prepare<unknown[], {
    row_kind: "folder" | "account" | "global";
    user_id: string | null; media_id: number | null;
    source_reference_count: number; unique_remote_path_count: number;
  }>(`
    WITH scoped AS (
      SELECT rf.user_id, rf.media_id, rf.remote_path
      FROM remote_files rf
      JOIN favorite_relations r
        ON r.user_id=rf.user_id AND r.media_id=rf.media_id AND r.bvid=rf.bvid
      WHERE rf.user_id<>'' AND rf.user_id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM archive_deleted_sources ads
          WHERE ads.user_id=r.user_id AND ads.media_id=r.media_id AND ads.bvid=r.bvid
            AND ads.status='completed'
        )
    )
    SELECT 'folder' AS row_kind, user_id, media_id,
      COUNT(*) AS source_reference_count,
      COUNT(DISTINCT remote_path) AS unique_remote_path_count
    FROM scoped GROUP BY user_id, media_id
    UNION ALL
    SELECT 'account', user_id, NULL, COUNT(*), COUNT(DISTINCT remote_path)
    FROM scoped GROUP BY user_id
    UNION ALL
    SELECT 'global', NULL, NULL, COUNT(*), COUNT(DISTINCT remote_path)
    FROM scoped
  `).all(...userIds);
  return new Map(rows.map((row) => {
    const key = row.row_kind === "folder"
      ? `folder:${row.user_id}:${row.media_id}`
      : row.row_kind === "account" ? `account:${row.user_id}` : "global";
    return [key, {
      sourceReferenceCount: Number(row.source_reference_count || 0),
      uniqueRemotePathCount: Number(row.unique_remote_path_count || 0),
    }];
  }));
}

