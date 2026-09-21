import { isoToMs, optionalIsoToMs } from './values.js';
import type Database from 'better-sqlite3';
import type { FavoriteRelation } from '../state.js';

/** Source membership reads are distinct from video identity and remote file identity. */
export interface ArchiveRepository {
  upsert(relation: FavoriteRelation, now: number, parts?: Pick<FavoriteRelation, "userId" | "mediaId" | "bvid">): void;
  remove(userId: string, mediaId: number, bvid: string): void;
  listInterruptedQualityRelations(): FavoriteRelation[];

  listStaleRelations(statuses: string[], before: number): FavoriteRelation[];

  getRelation(key: string): FavoriteRelation | undefined;
  listRelations(): FavoriteRelation[];
  listActiveRelations(): FavoriteRelation[];
  listRelationsForBvid(bvid: string): FavoriteRelation[];
  listRelationsForBvids(bvids: string[]): FavoriteRelation[];
  listRelationsByStatuses(statuses: string[]): FavoriteRelation[];
  listRelationsForFolder(userId: string, mediaId: number): FavoriteRelation[];
  listRelationsForUser(userId: string, unavailableOnly?: boolean): FavoriteRelation[];
  listRelationsForRemoteVerify(limit?: number, includeDeferred?: boolean, now?: number): FavoriteRelation[];
}
export class SqliteArchiveRepository implements ArchiveRepository {
  constructor(private readonly connection: () => Database.Database, private readonly decode: (json: string) => FavoriteRelation) { }
  getRelation(key: string) {
    const parts = key.split(":");
    const userId = parts.shift() || "";
    const mediaId = Number(parts.shift() || 0);
    const bvid = parts.join(":");
    const row = this.connection().prepare<unknown[], { payload_json: string }>("SELECT payload_json FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?")
      .get(userId, mediaId, bvid);
    return row ? this.decode(row.payload_json) : undefined;
  }

  listRelations() {
    return (this.connection().prepare<unknown[], { payload_json: string }>("SELECT payload_json FROM favorite_relations").all())
      .map((row) => this.decode(row.payload_json));
  }

  listActiveRelations() {
    return this.connection().prepare<[], {payload_json: string}>("SELECT payload_json FROM favorite_relations WHERE active_in_favorite=1").all()
      .map(row => this.decode(row.payload_json));
  }

  listRelationsForBvid(bvid: string) {
    return (this.connection().prepare<unknown[], { payload_json: string }>("SELECT payload_json FROM favorite_relations WHERE bvid=?").all(bvid))
      .map((row) => this.decode(row.payload_json));
  }

  listRelationsForBvids(bvids: string[]) {
    if (bvids.length === 0) return [];
    const placeholders = bvids.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], { payload_json: string }>(`SELECT payload_json FROM favorite_relations WHERE bvid IN (${placeholders})`).all(...bvids))
      .map((row) => this.decode(row.payload_json));
  }

  listRelationsByStatuses(statuses: string[]) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], { payload_json: string }>(`SELECT payload_json FROM favorite_relations WHERE backup_status IN (${placeholders})`).all(...statuses))
      .map((row) => this.decode(row.payload_json));
  }

  listRelationsForFolder(userId: string, mediaId: number) {
    return (this.connection().prepare<unknown[], { payload_json: string }>(`
      SELECT payload_json FROM favorite_relations
      WHERE user_id=? AND media_id=?
      ORDER BY active_in_favorite DESC,
        CASE WHEN active_in_favorite=1 AND fav_order IS NULL THEN 1 ELSE 0 END,
        CASE WHEN active_in_favorite=1 THEN fav_order END ASC,
        last_seen_at DESC,
        bvid ASC
    `).all(userId, mediaId))
      .map((row) => this.decode(row.payload_json));
  }

  listRelationsForUser(userId: string, unavailableOnly = false) {
    const sql = unavailableOnly
      ? "SELECT payload_json FROM favorite_relations WHERE user_id=? AND favorite_unavailable=1 ORDER BY last_seen_at DESC"
      : "SELECT payload_json FROM favorite_relations WHERE user_id=? ORDER BY last_seen_at DESC";
    return (this.connection().prepare<unknown[], { payload_json: string }>(sql).all(userId))
      .map((row) => this.decode(row.payload_json));
  }

  listRelationsForRemoteVerify(limit?: number, includeDeferred = false, now = Date.now()) {
    const conditions = ["backup_status IN ('verified','partial_verified')"];
    const params: number[] = [];
    if (!includeDeferred) {
      conditions.push("COALESCE(next_remote_check_at, last_remote_check_at, 0) <= ?");
      params.push(now);
    }
    const limitSql = typeof limit === "number" ? " LIMIT ?" : "";
    if (typeof limit === "number") params.push(Math.max(1, Math.floor(limit)));
    const orderSql = includeDeferred
      ? "COALESCE(last_remote_check_at, 0) ASC, bvid ASC"
      : "COALESCE(next_remote_check_at, last_remote_check_at, 0) ASC, bvid ASC";
    return (this.connection().prepare<unknown[], { payload_json: string }>(`
      SELECT payload_json FROM favorite_relations WHERE ${conditions.join(" AND ")}
      ORDER BY ${orderSql}${limitSql}
    `).all(...params))
      .map((row) => this.decode(row.payload_json));
  }
  listStaleRelations(statuses: string[], before: number) {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.connection().prepare<unknown[], {payload_json: string}>(`SELECT payload_json FROM favorite_relations WHERE backup_status IN (${placeholders}) AND updated_at <= ?`).all(...statuses, before))
      .map(row => this.decode(row.payload_json));
  }
  listInterruptedQualityRelations() {
    return (this.connection().prepare<unknown[], {payload_json: string}>(`
      SELECT r.payload_json FROM favorite_relations r JOIN quality_upgrades q
      ON q.user_id=r.user_id AND q.media_id=r.media_id AND q.bvid=r.bvid
    `).all()).map(row => this.decode(row.payload_json));
  }
  upsert(relation: FavoriteRelation, now: number, parts: Pick<FavoriteRelation, "userId" | "mediaId" | "bvid"> = relation) { this.createWriter().upsert(relation, now, parts); }
  remove(userId: string, mediaId: number, bvid: string) { this.createWriter().remove(userId, mediaId, bvid); }
  /** Scoped to one synchronous flush; prepared statements never survive a rebind. */
  createWriter(): Pick<ArchiveRepository, 'upsert' | 'remove'> {
    const connection = this.connection();
    const save = connection.prepare(`
      INSERT INTO favorite_relations(user_id, media_id, source_kind, bvid, backup_status, active_in_favorite, folder_title,
        fav_order, last_seen_at, favorite_unavailable, self_visible, last_remote_check_at,
        next_remote_check_at, account_detached_at, payload_json, updated_at)
      VALUES(@userId, @mediaId, @sourceKind, @bvid, @backupStatus, @active, @folderTitle, @favOrder, @lastSeenAt,
        @favoriteUnavailable, @selfVisible, @lastRemoteCheckAt, @nextRemoteCheckAt, @accountDetachedAt,
        @payload, @updatedAt)
      ON CONFLICT(user_id, media_id, bvid) DO UPDATE SET source_kind=excluded.source_kind, backup_status=excluded.backup_status,
        active_in_favorite=excluded.active_in_favorite, folder_title=excluded.folder_title,
        fav_order=excluded.fav_order, last_seen_at=excluded.last_seen_at,
        favorite_unavailable=excluded.favorite_unavailable, self_visible=excluded.self_visible,
        last_remote_check_at=excluded.last_remote_check_at, next_remote_check_at=excluded.next_remote_check_at,
        account_detached_at=excluded.account_detached_at, payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `);
    const remove = connection.prepare('DELETE FROM favorite_relations WHERE user_id=? AND media_id=? AND bvid=?');
    return {
      upsert(relation: FavoriteRelation, now: number, parts: Pick<FavoriteRelation, "userId" | "mediaId" | "bvid"> = relation) { save.run({
          ...parts,
          sourceKind: relation.sourceKind === "manual" ? "manual" : "favorite",
          backupStatus: relation.backupStatus || "discovered",
          active: relation.activeInFavorite ? 1 : 0,
          folderTitle: relation.folderTitle || "",
          favOrder: Number.isInteger(relation.favOrder) ? relation.favOrder : null,
          lastSeenAt: isoToMs(relation.lastSeenAt, now),
          favoriteUnavailable: relation.favoriteUnavailable ? 1 : 0,
          selfVisible: relation.selfVisible ? 1 : 0,
          lastRemoteCheckAt: optionalIsoToMs(relation.lastRemoteCheckAt),
          nextRemoteCheckAt: optionalIsoToMs(relation.nextRemoteCheckAt),
          accountDetachedAt: relation.accountDetachedAt ? isoToMs(relation.accountDetachedAt, now) : null,
          payload: JSON.stringify(relation),
          updatedAt: isoToMs(relation.statusUpdatedAt || relation.lastSeenAt, now),
        }); },
      remove(userId: string, mediaId: number, bvid: string) { remove.run(userId, mediaId, bvid); },
    };
  }

}
