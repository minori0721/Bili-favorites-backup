import crypto from "node:crypto";
import type { StateDatabase } from "./database.js";
import { joinRemotePath } from "./utils.js";

export type TransferSessionPhase =
  | "uploading"
  | "awaiting_remote"
  | "completed"
  | "failed"
  | "superseded";

export type TransferSessionFileStatus =
  | "pending"
  | "uploading"
  | "awaiting_remote"
  | "verified"
  | "failed";

export interface TransferSessionRecord {
  id: string;
  dedupeKey: string;
  kind: "upload";
  bvid: string;
  userId?: string;
  mediaId?: number;
  localDir: string;
  remotePath: string;
  stagingPath: string;
  phase: TransferSessionPhase;
  generation: number;
  historyOnly: boolean;
  historySnapshotAt?: string;
  allowReupload: boolean;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TransferSessionFileRecord {
  sessionId: string;
  generation: number;
  relativePath: string;
  name: string;
  stagingPath: string;
  finalPath: string;
  expectedSize: number;
  status: TransferSessionFileStatus;
  putAcceptedAt?: number;
  stageVerifiedAt?: number;
  movedAt?: number;
  verifiedAt?: number;
  attempts: number;
  nextCheckAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

type TransferSessionPatch = Partial<Pick<TransferSessionRecord, "phase" | "allowReupload">> & {
  lastError?: string | null;
  completedAt?: number | null;
};

type TransferSessionFilePatch = Partial<Pick<TransferSessionFileRecord,
  "name" | "stagingPath" | "finalPath" | "status" | "attempts"
>> & {
  putAcceptedAt?: number | null;
  stageVerifiedAt?: number | null;
  movedAt?: number | null;
  verifiedAt?: number | null;
  nextCheckAt?: number | null;
  lastError?: string | null;
};

export class TransferSessionGenerationError extends Error {
  readonly code = "UPLOAD_SESSION_STALE";
  readonly status = 409;
  readonly uploadSessionStale = true;

  constructor(readonly sessionId: string, readonly expectedGeneration: number, readonly actualGeneration: number) {
    super("Upload session attempt is no longer current");
    this.name = "TransferSessionGenerationError";
  }
}

function sessionFromRow(row: any): TransferSessionRecord {
  const rawPhase = String(row.phase || "failed");
  const phase = rawPhase === "staging" || rawPhase === "promoting"
    ? "uploading"
    : rawPhase === "awaiting_stage" || rawPhase === "awaiting_final"
      ? "awaiting_remote"
      : rawPhase;
  const remotePath = String(row.remote_path);
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    kind: "upload",
    bvid: String(row.bvid),
    userId: row.user_id ? String(row.user_id) : undefined,
    mediaId: row.media_id === null || row.media_id === undefined ? undefined : Number(row.media_id),
    localDir: String(row.local_dir),
    remotePath,
    // Never expose the legacy temporary path to the direct-upload runtime.
    stagingPath: remotePath,
    phase: phase as TransferSessionPhase,
    generation: Math.max(1, Number(row.generation || 1)),
    historyOnly: Number(row.history_only || 0) === 1,
    historySnapshotAt: row.history_snapshot_at ? String(row.history_snapshot_at) : undefined,
    allowReupload: Number(row.allow_reupload || 0) === 1,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? undefined : Number(row.completed_at),
  };
}

function fileFromRow(row: any): TransferSessionFileRecord {
  const rawStatus = String(row.status || "failed");
  const status = rawStatus === "awaiting_stage" || rawStatus === "stage_verified" || rawStatus === "moving" || rawStatus === "awaiting_final"
    ? "awaiting_remote"
    : rawStatus;
  const finalPath = String(row.final_path);
  return {
    sessionId: String(row.session_id),
    generation: Math.max(1, Number(row.generation || 1)),
    relativePath: String(row.relative_path),
    name: String(row.name),
    // The column remains for schema compatibility; the runtime target is
    // always the persisted final path.
    stagingPath: finalPath,
    finalPath,
    expectedSize: Number(row.expected_size || 0),
    status: status as TransferSessionFileStatus,
    putAcceptedAt: row.put_accepted_at === null || row.put_accepted_at === undefined ? undefined : Number(row.put_accepted_at),
    stageVerifiedAt: row.stage_verified_at === null || row.stage_verified_at === undefined ? undefined : Number(row.stage_verified_at),
    movedAt: row.moved_at === null || row.moved_at === undefined ? undefined : Number(row.moved_at),
    verifiedAt: row.verified_at === null || row.verified_at === undefined ? undefined : Number(row.verified_at),
    attempts: Number(row.attempts || 0),
    nextCheckAt: row.next_check_at === null || row.next_check_at === undefined ? undefined : Number(row.next_check_at),
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  };
}

export interface EnsureTransferSessionInput {
  sessionId?: string;
  dedupeKey: string;
  bvid: string;
  userId?: string;
  mediaId?: number;
  localDir: string;
  remotePath: string;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  expectedGeneration?: number;
}

export class TransferSessionStore {
  constructor(private stateDatabase: StateDatabase) {}

  rebind(stateDatabase: StateDatabase) {
    this.stateDatabase = stateDatabase;
  }

  get(id: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM transfer_sessions WHERE id=?").get(String(id || ""));
    return row ? sessionFromRow(row) : null;
  }

  assertGeneration(id: string, expectedGeneration?: number) {
    const session = this.get(id);
    if (!session) throw new Error("Transfer session does not exist");
    if (expectedGeneration !== undefined && session.generation !== expectedGeneration) {
      throw new TransferSessionGenerationError(session.id, expectedGeneration, session.generation);
    }
    return session;
  }

  getByDedupeKey(dedupeKey: string) {
    const row = this.stateDatabase.db.prepare("SELECT * FROM transfer_sessions WHERE dedupe_key=?").get(String(dedupeKey || ""));
    return row ? sessionFromRow(row) : null;
  }

  findForTarget(userId: string | undefined, mediaId: number | undefined, bvid: string, finalPath?: string) {
    const row = this.stateDatabase.db.prepare(`
      SELECT s.* FROM transfer_sessions s
      LEFT JOIN transfer_session_files f ON f.session_id=s.id AND f.generation=s.generation
      WHERE s.bvid=? AND COALESCE(s.user_id,'')=COALESCE(?, '')
        AND COALESCE(s.media_id,0)=COALESCE(?,0)
        AND s.phase NOT IN ('completed','superseded')
        ${finalPath ? "AND f.final_path=?" : ""}
      ORDER BY s.updated_at DESC
      LIMIT 1
    `).get(...(finalPath ? [bvid, userId || "", mediaId ?? 0, finalPath] : [bvid, userId || "", mediaId ?? 0]));
    return row ? sessionFromRow(row) : null;
  }

  hasActiveForBvid(bvid: string) {
    const row = this.stateDatabase.db.prepare(`
      SELECT 1 FROM transfer_sessions
      WHERE bvid=? AND phase NOT IN ('completed','superseded')
      LIMIT 1
    `).get(String(bvid || ""));
    return Boolean(row);
  }

  listFiles(sessionId: string, generation?: number) {
    const session = this.get(sessionId);
    const targetGeneration = generation ?? session?.generation;
    if (!session || targetGeneration === undefined) return [];
    return (this.stateDatabase.db.prepare(`
      SELECT * FROM transfer_session_files
      WHERE session_id=? AND generation=?
      ORDER BY relative_path ASC
    `).all(String(sessionId || ""), targetGeneration) as any[]).map(fileFromRow);
  }

  getFile(sessionId: string, relativePath: string, generation?: number) {
    const session = this.get(sessionId);
    const targetGeneration = generation ?? session?.generation;
    if (!session || targetGeneration === undefined) return null;
    const row = this.stateDatabase.db.prepare(`
      SELECT * FROM transfer_session_files WHERE session_id=? AND generation=? AND relative_path=?
    `).get(String(sessionId || ""), targetGeneration, String(relativePath || ""));
    return row ? fileFromRow(row) : null;
  }

  ensure(input: EnsureTransferSessionInput) {
    const existingById = input.sessionId ? this.assertGeneration(input.sessionId, input.expectedGeneration) : null;
    if (existingById) return existingById;
    const existingByKey = this.getByDedupeKey(input.dedupeKey);
    if (existingByKey) {
      // A completed session is a historical upload attempt, not proof that a
      // future retry can skip PUT. Reopen it in place so the dedupe key still
      // prevents duplicate sessions while the per-file state is rebuilt.
      if (input.expectedGeneration !== undefined && existingByKey.generation !== input.expectedGeneration) {
        throw new TransferSessionGenerationError(existingByKey.id, input.expectedGeneration, existingByKey.generation);
      }
      if (!input.sessionId && ["completed", "superseded"].includes(existingByKey.phase)) {
        return this.reopenCompleted(existingByKey.id, input);
      }
      return existingByKey;
    }

    const id = input.sessionId || crypto.randomUUID();
    const now = Date.now();
    const remotePath = String(input.remotePath || "").replace(/\/+$/g, "") || "/";
    // Kept for schema compatibility with the first draft of persistent uploads.
    // Direct uploads use the final path and never create a staging directory.
    const stagingPath = remotePath;
    this.stateDatabase.db.prepare(`
      INSERT INTO transfer_sessions(
        id, dedupe_key, kind, bvid, user_id, media_id, local_dir, remote_path,
        staging_path, phase, generation, history_only, history_snapshot_at, allow_reupload,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'uploading',1,?,?,0,?,?)
    `).run(
      id,
      input.dedupeKey,
      "upload",
      String(input.bvid || ""),
      input.userId || null,
      input.mediaId ?? null,
      String(input.localDir || ""),
      remotePath,
      stagingPath,
      input.historyOnly ? 1 : 0,
      input.historySnapshotAt || null,
      now,
      now,
    );
    return this.get(id)!;
  }

  private reopenCompleted(id: string, input: EnsureTransferSessionInput) {
    const remotePath = String(input.remotePath || "").replace(/\/+$/g, "") || "/";
    const now = Date.now();
    this.stateDatabase.db.transaction(() => {
      const updated = this.stateDatabase.db.prepare(`
      UPDATE transfer_sessions
        SET local_dir=?, remote_path=?, staging_path=?, phase='uploading', generation=generation+1,
            allow_reupload=0, last_error=NULL, completed_at=NULL, updated_at=?
        WHERE id=? AND phase IN ('completed','superseded')
      `).run(String(input.localDir || ""), remotePath, remotePath, now, id);
      if (updated.changes !== 1) return;
      // Keep the previous generation as an audit trail. New files are written
      // under the incremented generation and can never collide with it.
    })();
    return this.get(id)!;
  }

  ensureFile(sessionId: string, input: { relativePath: string; name: string; expectedSize: number }, expectedGeneration?: number) {
    const session = this.assertGeneration(sessionId, expectedGeneration);
    const relativePath = String(input.relativePath || "").replace(/\\/g, "/");
    const name = String(input.name || "");
    const now = Date.now();
    const finalPath = joinRemotePath(session.remotePath, name);
    // `staging_path` remains in schema 9 for compatibility, but is now an alias
    // of the final path. No WebDAV MOVE is used by the direct-upload flow.
    const stagingPath = finalPath;
    this.stateDatabase.db.prepare(`
      INSERT INTO transfer_session_files(
        session_id, generation, relative_path, name, staging_path, final_path, expected_size,
        status, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(session_id, generation, relative_path) DO UPDATE SET
        name=excluded.name,
        staging_path=CASE WHEN transfer_session_files.status IN ('pending','failed') THEN excluded.staging_path ELSE transfer_session_files.staging_path END,
        final_path=CASE WHEN transfer_session_files.status IN ('pending','failed') THEN excluded.final_path ELSE transfer_session_files.final_path END,
        expected_size=excluded.expected_size,
        updated_at=excluded.updated_at
    `).run(sessionId, session.generation, relativePath, name, stagingPath, finalPath, Math.max(0, Math.floor(input.expectedSize)), now, now);
    return this.getFile(sessionId, relativePath, session.generation)!;
  }

  updateSession(id: string, patch: TransferSessionPatch, expectedGeneration?: number) {
    const session = this.assertGeneration(id, expectedGeneration);
    const now = Date.now();
    const phase = patch.phase ?? session.phase;
    const allowReupload = patch.allowReupload ?? session.allowReupload;
    const lastError = patch.lastError === undefined ? session.lastError || null : patch.lastError;
    const completedAt = patch.completedAt === undefined ? session.completedAt ?? null : patch.completedAt ?? null;
    this.stateDatabase.db.prepare(`
      UPDATE transfer_sessions
      SET phase=?, allow_reupload=?, last_error=?, completed_at=?, updated_at=?
      WHERE id=? AND generation=?
    `).run(phase, allowReupload ? 1 : 0, lastError, completedAt, now, id, session.generation);
    return this.get(id);
  }

  allowReupload(id: string, expectedGeneration?: number) {
    return this.updateSession(id, { allowReupload: true }, expectedGeneration);
  }

  updateFile(id: string, relativePath: string, patch: TransferSessionFilePatch, expectedGeneration?: number) {
    const session = this.assertGeneration(id, expectedGeneration);
    const file = this.getFile(id, relativePath, session.generation);
    if (!file) return null;
    const now = Date.now();
    const value = (key: keyof TransferSessionFileRecord, fallback: any) => (patch as any)[key] === undefined ? fallback : (patch as any)[key];
    this.stateDatabase.db.prepare(`
      UPDATE transfer_session_files SET
        name=?, staging_path=?, final_path=?, status=?, put_accepted_at=?, stage_verified_at=?,
        moved_at=?, verified_at=?, attempts=?, next_check_at=?, last_error=?, updated_at=?
      WHERE session_id=? AND generation=? AND relative_path=?
    `).run(
      value("name", file.name),
      value("stagingPath", file.stagingPath),
      value("finalPath", file.finalPath),
      value("status", file.status),
      value("putAcceptedAt", file.putAcceptedAt ?? null),
      value("stageVerifiedAt", file.stageVerifiedAt ?? null),
      value("movedAt", file.movedAt ?? null),
      value("verifiedAt", file.verifiedAt ?? null),
      value("attempts", file.attempts),
      value("nextCheckAt", file.nextCheckAt ?? null),
      value("lastError", file.lastError || null),
      now,
      id,
      session.generation,
      relativePath,
    );
    return this.getFile(id, relativePath, session.generation);
  }

  supersede(id: string, expectedGeneration?: number) {
    const session = this.assertGeneration(id, expectedGeneration);
    const now = Date.now();
    const result = this.stateDatabase.db.prepare(`
      UPDATE transfer_sessions
      SET phase='superseded', allow_reupload=0, last_error='Superseded by a fresh download',
          completed_at=?, updated_at=?
      WHERE id=? AND generation=?
        AND phase IN ('uploading','awaiting_remote','failed','staging','promoting','awaiting_stage','awaiting_final')
    `).run(now, now, id, session.generation);
    return result.changes === 1;
  }

  listRecoverable(limit = 100) {
    return this.listRecoverablePage(Math.max(1, Math.min(1000, Math.floor(limit))), 0);
  }

  listRecoverablePage(limit = 100, offset = 0) {
    return (this.stateDatabase.db.prepare(`
      SELECT * FROM transfer_sessions
      WHERE phase NOT IN ('completed','superseded')
      ORDER BY CASE phase
        WHEN 'uploading' THEN 1 WHEN 'awaiting_remote' THEN 2
        WHEN 'staging' THEN 3 WHEN 'promoting' THEN 4
        WHEN 'awaiting_stage' THEN 5 WHEN 'awaiting_final' THEN 6 ELSE 7 END, updated_at ASC
      LIMIT ? OFFSET ?
    `).all(
      Math.max(1, Math.min(100, Math.floor(limit))),
      Math.max(0, Math.floor(offset)),
    ) as any[]).map(sessionFromRow);
  }

  summary() {
    const rows = this.stateDatabase.db.prepare(`
      SELECT phase, COUNT(*) AS count FROM transfer_sessions
      WHERE phase NOT IN ('completed','superseded') GROUP BY phase
    `).all() as any[];
    const phases: Record<string, number> = {};
    for (const row of rows) phases[String(row.phase)] = Number(row.count || 0);
    return { count: Object.values(phases).reduce((sum, value) => sum + value, 0), phases };
  }
}
