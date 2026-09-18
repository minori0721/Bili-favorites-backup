import type { StateDatabase } from "./database.js";

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

