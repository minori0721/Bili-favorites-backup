import type Database from 'better-sqlite3';
import type { FailedEntry, StateFile } from '../state.js';
import { isoToMs } from './values.js';

export interface RecoveryRepository {
  replaceFailures(entries: Record<string, Record<string, FailedEntry>>): void;
  getFailure(userId: string, bvid: string, mediaId?: number): FailedEntry | undefined;
  upsertFailure(userId: string, entry: FailedEntry): void;
  deleteFailure(userId: string, mediaId: number, bvid: string): boolean;
  replaceCooldowns(state: Pick<StateFile, 'userCooldowns' | 'downloadApiCooldown'>): void;
  getCooldown(kind: string, scopeId?: string): Record<string, unknown> | null;
  listCooldowns(kind: string, activeAfter?: number): Array<{ scopeId: string; payload: Record<string, unknown> }>;
  setCooldown(kind: string, scopeId: string, untilAt: number, reason: string, payload: Record<string, unknown>): void;
  clearCooldown(kind: string, scopeId?: string): void;
}
function readPayload(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted recovery payload');
  return Object.fromEntries(Object.entries(value));
}
function readFailure(json: string): FailedEntry {
  const value = readPayload(json);
  if (typeof value.bvid !== 'string' || !value.bvid || typeof value.mediaId !== 'number' || !Number.isInteger(value.mediaId)
    || typeof value.failedAt !== 'string' || typeof value.reason !== 'string' || typeof value.permanent !== 'boolean'
    || (value.userDisposition !== undefined && value.userDisposition !== 'abandoned')
    || (value.abandonedAt !== undefined && typeof value.abandonedAt !== 'string')) throw new Error('Invalid persisted failure record');
  return {
    bvid: value.bvid, mediaId: value.mediaId, failedAt: value.failedAt, reason: value.reason, permanent: value.permanent,
    ...(value.userDisposition === 'abandoned' ? { userDisposition: value.userDisposition } : {}),
    ...(typeof value.abandonedAt === 'string' ? { abandonedAt: value.abandonedAt } : {})
  };
}
/** Uses the caller's active transaction; never commits or retains a bare connection. */
export class SqliteRecoveryRepository implements RecoveryRepository {
  constructor(private readonly connection: () => Database.Database) { }
  replaceFailures(failedByUser: Record<string, Record<string, FailedEntry>>) {
    this.connection().exec("DELETE FROM failures");
    const insert = this.connection().prepare(`
      INSERT INTO failures(user_id, media_id, bvid, failed_at, reason, permanent, payload_json)
      VALUES(?,?,?,?,?,?,?)
    `);
    for (const [userId, entries] of Object.entries(failedByUser)) {
      for (const entry of Object.values(entries || {})) {
        if (!entry?.bvid) continue;
        insert.run(userId, Number(entry.mediaId || 0), entry.bvid, isoToMs(entry.failedAt), entry.reason || "", entry.permanent ? 1 : 0, JSON.stringify(entry));
      }
    }
  }

  getFailure(userId: string, bvid: string, mediaId?: number) {
    const row = typeof mediaId === "number"
      ? this.connection().prepare<unknown[], { payload_json: string }>(`
          SELECT payload_json FROM failures
          WHERE user_id=? AND bvid=? AND media_id IN (?,0)
          ORDER BY CASE WHEN media_id=? THEN 0 ELSE 1 END, failed_at DESC LIMIT 1
        `).get(userId, bvid, mediaId, mediaId)
      : this.connection().prepare<unknown[], { payload_json: string }>(`
          SELECT payload_json FROM failures WHERE user_id=? AND bvid=? ORDER BY failed_at DESC LIMIT 1
        `).get(userId, bvid);
    return row ? readFailure(row.payload_json) : undefined;
  }

  upsertFailure(userId: string, entry: FailedEntry) {
    this.connection().prepare(`
      INSERT INTO failures(user_id,media_id,bvid,failed_at,reason,permanent,payload_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,media_id,bvid) DO UPDATE SET failed_at=excluded.failed_at,
        reason=excluded.reason, permanent=excluded.permanent, payload_json=excluded.payload_json
    `).run(
      userId,
      Number(entry.mediaId || 0),
      entry.bvid,
      isoToMs(entry.failedAt),
      entry.reason || "",
      entry.permanent ? 1 : 0,
      JSON.stringify(entry)
    );
  }

  deleteFailure(userId: string, mediaId: number, bvid: string) {
    return this.connection().prepare("DELETE FROM failures WHERE user_id=? AND bvid=? AND media_id IN (?,0)")
      .run(userId, bvid, mediaId).changes > 0;
  }

  replaceCooldowns(state: Pick<StateFile, "userCooldowns" | "downloadApiCooldown">) {
    this.connection().prepare("DELETE FROM cooldowns WHERE kind IN ('user','download_api')").run();
    const insert = this.connection().prepare(`
      INSERT INTO cooldowns(kind, scope_id, until_at, reason, payload_json, updated_at) VALUES(?,?,?,?,?,?)
    `);
    for (const [userId, cooldown] of Object.entries(state.userCooldowns || {})) {
      insert.run("user", userId, Number(cooldown.until || 0), cooldown.reason || "", JSON.stringify(cooldown), Date.now());
    }
    if (state.downloadApiCooldown) {
      insert.run(
        "download_api",
        "global",
        Number(state.downloadApiCooldown.until || 0),
        state.downloadApiCooldown.reason || "",
        JSON.stringify(state.downloadApiCooldown),
        Date.now()
      );
    }
  }

  getCooldown(kind: string, scopeId = "global") {
    const row = this.connection().prepare<[string, string], { payload_json: string }>("SELECT payload_json FROM cooldowns WHERE kind=? AND scope_id=?").get(kind, scopeId);
    return row ? readPayload(row.payload_json) : null;
  }

  listCooldowns(kind: string, activeAfter?: number) {
    const rows = typeof activeAfter === "number"
      ? this.connection().prepare<[string, number], { scope_id: string; payload_json: string }>("SELECT scope_id,payload_json FROM cooldowns WHERE kind=? AND until_at>?").all(kind, activeAfter)
      : this.connection().prepare<[string], { scope_id: string; payload_json: string }>("SELECT scope_id,payload_json FROM cooldowns WHERE kind=?").all(kind);
    return rows.map((row) => ({
      scopeId: String(row.scope_id || ""),
      payload: readPayload(row.payload_json),
    }));
  }

  setCooldown(kind: string, scopeId: string, untilAt: number, reason: string, payload: Record<string, unknown>) {
    this.connection().prepare(`
      INSERT INTO cooldowns(kind,scope_id,until_at,reason,payload_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,scope_id) DO UPDATE SET until_at=excluded.until_at, reason=excluded.reason,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(kind, scopeId, untilAt, reason, JSON.stringify(payload), Date.now());
  }

  clearCooldown(kind: string, scopeId = "global") {
    this.connection().prepare("DELETE FROM cooldowns WHERE kind=? AND scope_id=?").run(kind, scopeId);
  }
}
