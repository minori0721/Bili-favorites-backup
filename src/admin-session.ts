import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import session from "express-session";
import type { AdminSessionInvalidationPort } from './ports/admin-session.js';

export const ADMIN_SESSION_COOKIE_NAME = "bfb.sid";
export const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ADMIN_SESSION_LIMIT = 10;

interface StoredAdminSession extends session.SessionData {
  user?: { name: string };
  authFingerprint?: string;
  absoluteExpiresAt?: number;
  remember?: boolean;
}

interface ValidAdminSession extends StoredAdminSession {
  absoluteExpiresAt: number;
}

interface SessionObservation {
  expiresAt: number;
  listeners: Set<() => void>;
  cancelExpiry?: () => void;
}

interface SessionRow {
  payload_json: string;
  subject: string;
  auth_fingerprint: string;
  expires_at: number;
}

interface AdminSessionStoreOptions {
  filePath: string;
  sessionSecret: string;
  adminUser: string;
  adminPassword: string;
  now?: () => number;
  cleanupIntervalMs?: number;
  sessionLimit?: number;
  warn?: (message: string) => void;
  scheduleExpiry?: (callback: () => void, delayMs: number) => () => void;
}

function scheduleSessionExpiry(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

class CorruptSessionDatabaseError extends Error {}

function isCorruptDatabaseError(error: unknown) {
  if (error instanceof CorruptSessionDatabaseError) return true;
  const code = String((error as { code?: unknown })?.code || "");
  const message = String((error as { message?: unknown })?.message || "");
  return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB"
    || /database disk image is malformed|file is not a database|malformed database schema/i.test(message);
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hmacHex(secret: string, purpose: string, value: string) {
  return crypto.createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

export function buildAdminAuthFingerprint(sessionSecret: string, adminUser: string, adminPassword: string) {
  return hmacHex(sessionSecret, "bfb-admin-auth-v1", `${adminUser}\0${adminPassword}`);
}

function buildSessionKey(sessionSecret: string, sessionId: string) {
  return hmacHex(sessionSecret, "bfb-admin-session-v1", sessionId);
}

function chmodPrivateDatabase(filePath: string, warn: (message: string) => void) {
  let failed = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${filePath}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    try {
      fs.chmodSync(candidate, 0o600);
    } catch {
      failed = true;
    }
  }
  if (failed) warn("管理员会话数据库权限收紧失败，请检查数据目录权限。");
}

function quarantineDatabase(filePath: string) {
  const quarantined = `${filePath}.corrupt-${safeTimestamp()}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${filePath}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${quarantined}${suffix}`);
  }
}

export class AdminSessionStore extends session.Store implements AdminSessionInvalidationPort {
  private db!: Database.Database;
  private readonly filePath: string;
  private readonly sessionSecret: string;
  private readonly adminUser: string;
  private readonly authFingerprint: string;
  private readonly now: () => number;
  private readonly cleanupIntervalMs: number;
  private readonly sessionLimit: number;
  private readonly warn: (message: string) => void;
  private cleanupTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly observations = new Map<string, SessionObservation>();
  private readonly scheduleExpiry: (callback: () => void, delayMs: number) => () => void;

  constructor(options: AdminSessionStoreOptions) {
    super();
    this.filePath = options.filePath;
    this.sessionSecret = options.sessionSecret;
    this.adminUser = options.adminUser;
    this.authFingerprint = buildAdminAuthFingerprint(options.sessionSecret, options.adminUser, options.adminPassword);
    this.now = options.now || Date.now;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? ADMIN_SESSION_CLEANUP_INTERVAL_MS;
    this.sessionLimit = Math.max(1, Math.floor(options.sessionLimit ?? ADMIN_SESSION_LIMIT));
    this.warn = options.warn || ((message) => console.warn(`[Security] ${message}`));
    this.scheduleExpiry = options.scheduleExpiry ?? scheduleSessionExpiry;
    this.openWithRecovery();
    this.cleanup();
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.cleanup();
        } catch {
          this.warn("管理员会话过期清理失败，将在下个周期重试。");
        }
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  private openDatabase() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const database = new Database(this.filePath);
    try {
      database.pragma("busy_timeout = 5000");
      database.pragma("synchronous = NORMAL");
      database.pragma("journal_mode = WAL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          session_key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          subject TEXT NOT NULL,
          auth_fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
          ON admin_sessions(expires_at);
      `);
      const integrity = database.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new CorruptSessionDatabaseError("Session database integrity check failed");
      chmodPrivateDatabase(this.filePath, this.warn);
      return database;
    } catch (error) {
      try { if (database.open) database.close(); } catch (closeError) {
        console.warn(`[AdminSession] failed to close newly opened database: ${String(closeError)}`);
      }
      throw error;
    }
  }

  private openWithRecovery() {
    const existed = fs.existsSync(this.filePath);
    try {
      this.db = this.openDatabase();
      return;
    } catch (error) {
      if (!existed || !isCorruptDatabaseError(error)) throw error;
      try {
        if (this.db?.open) this.db.close();
      } catch (closeError) {
        console.warn(`[AdminSession] failed to close corrupt session database: ${String(closeError)}`);
      }
      try {
        quarantineDatabase(this.filePath);
      } catch {
        throw error;
      }
      this.warn("管理员会话数据库损坏，已保留损坏副本并注销现有会话。");
      this.db = this.openDatabase();
    }
  }

  private key(sessionId: string) {
    return buildSessionKey(this.sessionSecret, sessionId);
  }

  private isValidStoredSession(parsed: StoredAdminSession, row: SessionRow): parsed is ValidAdminSession {
    const expiresAt = parsed?.absoluteExpiresAt;
    return Boolean(parsed && typeof parsed === "object")
      && parsed.authFingerprint === this.authFingerprint
      && parsed.user?.name === this.adminUser
      && row.subject === this.adminUser
      && typeof expiresAt === 'number' && Number.isInteger(expiresAt)
      && expiresAt === row.expires_at
      && Boolean(parsed.cookie && typeof parsed.cookie === "object")
      && typeof parsed.remember === "boolean";
  }

  private invalidateObservedSession(key: string) {
    const observation = this.observations.get(key);
    if (!observation) return;
    this.observations.delete(key);
    observation.cancelExpiry?.();
    for (const listener of observation.listeners) {
      try { listener(); } catch {
        this.warn('管理员会话已失效，但释放实时连接失败，请检查 HTTP 连接状态。');
      }
    }
    observation.listeners.clear();
  }

  private scheduleObservedExpiry(key: string, observation: SessionObservation) {
    const remaining = observation.expiresAt - this.now();
    if (remaining <= 0) {
      this.invalidateObservedSession(key);
      return;
    }
    // Thirty days exceeds Node's maximum timeout. Recheck the same fixed
    // deadline in bounded slices; this never renews the session.
    observation.cancelExpiry = this.scheduleExpiry(() => {
      if (this.observations.get(key) !== observation) return;
      this.scheduleObservedExpiry(key, observation);
    }, Math.min(remaining, 2_147_483_647));
  }

  observe(sessionId: string, invalidated: () => void): () => void {
    const stored = this.readSession(sessionId);
    if (!stored) { invalidated(); return () => {}; }
    const key = this.key(sessionId);
    const listener = () => invalidated();
    let observation = this.observations.get(key);
    if (!observation) {
      observation = {expiresAt: stored.absoluteExpiresAt, listeners: new Set()};
      this.observations.set(key, observation);
      observation.listeners.add(listener);
      this.scheduleObservedExpiry(key, observation);
    } else {
      observation.listeners.add(listener);
    }
    const owned = observation;
    return () => {
      owned.listeners.delete(listener);
      if (!owned.listeners.size && this.observations.get(key) === owned) {
        this.observations.delete(key);
        owned.cancelExpiry?.();
      }
    };
  }

  cleanup(now = this.now()) {
    if (this.closed) return 0;
    const invalidRows = this.db.prepare(`
      SELECT session_key, payload_json, subject, auth_fingerprint, expires_at
      FROM admin_sessions
      WHERE expires_at > ? AND auth_fingerprint = ?
    `).all(now, this.authFingerprint) as Array<SessionRow & { session_key: string }>;
    const malformedKeys: string[] = [];
    for (const row of invalidRows) {
      try {
        const parsed = JSON.parse(row.payload_json) as StoredAdminSession;
        if (!this.isValidStoredSession(parsed, row)) {
          malformedKeys.push(row.session_key);
        }
      } catch {
        malformedKeys.push(row.session_key);
      }
    }
    const transaction = this.db.transaction(() => {
      const expiredKeys = this.db.prepare<[number, string], {session_key: string}>(
        'SELECT session_key FROM admin_sessions WHERE expires_at <= ? OR auth_fingerprint <> ?',
      ).all(now, this.authFingerprint).map(row => row.session_key);
      let changes = this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR auth_fingerprint <> ?")
        .run(now, this.authFingerprint).changes;
      const removeMalformed = this.db.prepare("DELETE FROM admin_sessions WHERE session_key = ?");
      for (const key of malformedKeys) changes += removeMalformed.run(key).changes;
      return {changes, removedKeys: [...expiredKeys, ...malformedKeys]};
    });
    const result = transaction();
    for (const key of result.removedKeys) this.invalidateObservedSession(key);
    return result.changes;
  }

  private readSession(sessionId: string): ValidAdminSession | null {
    if (this.closed) throw new Error("Admin session store is closed");
    const key = this.key(sessionId);
    const row = this.db.prepare(`
      SELECT payload_json, subject, auth_fingerprint, expires_at
      FROM admin_sessions
      WHERE session_key = ?
    `).get(key) as SessionRow | undefined;
    if (!row) {
      this.invalidateObservedSession(key);
      return null;
    }
    if (row.expires_at <= this.now() || row.auth_fingerprint !== this.authFingerprint) {
      this.db.prepare("DELETE FROM admin_sessions WHERE session_key = ?").run(key);
      this.invalidateObservedSession(key);
      return null;
    }
    let parsed: StoredAdminSession;
    try {
      parsed = JSON.parse(row.payload_json) as StoredAdminSession;
    } catch {
      this.db.prepare("DELETE FROM admin_sessions WHERE session_key = ?").run(key);
      this.invalidateObservedSession(key);
      return null;
    }
    if (!this.isValidStoredSession(parsed, row)) {
      this.db.prepare("DELETE FROM admin_sessions WHERE session_key = ?").run(key);
      this.invalidateObservedSession(key);
      return null;
    }
    return parsed;
  }

  override get(sessionId: string, callback: (err: unknown, session?: session.SessionData | null) => void) {
    let stored: ValidAdminSession | null;
    try {
      stored = this.readSession(sessionId);
    } catch (error) {
      callback(error);
      return;
    }
    callback(null, stored);
  }

  override set(sessionId: string, sessionData: session.SessionData, callback?: (err?: unknown) => void) {
    try {
      if (this.closed) throw new Error("Admin session store is closed");
      const stored = sessionData as StoredAdminSession;
      const expiresAt = stored.absoluteExpiresAt;
      const subject = stored.user?.name;
      if (subject !== this.adminUser
        || stored.authFingerprint !== this.authFingerprint
        || typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)
        || expiresAt <= this.now()
        || !stored.cookie || typeof stored.cookie !== "object"
        || typeof stored.remember !== "boolean") {
        throw new Error("Invalid admin session payload");
      }
      const now = this.now();
      const key = this.key(sessionId);
      const payload = JSON.stringify(stored);
      const transaction = this.db.transaction(() => {
        const expiredKeys = this.db.prepare<[number, string], {session_key: string}>(
          'SELECT session_key FROM admin_sessions WHERE expires_at <= ? OR auth_fingerprint <> ?',
        ).all(now, this.authFingerprint).map(row => row.session_key);
        this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR auth_fingerprint <> ?")
          .run(now, this.authFingerprint);
        this.db.prepare(`
          INSERT INTO admin_sessions(session_key, payload_json, subject, auth_fingerprint, created_at, updated_at, expires_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(session_key) DO UPDATE SET
            payload_json=excluded.payload_json,
            subject=excluded.subject,
            auth_fingerprint=excluded.auth_fingerprint,
            updated_at=excluded.updated_at,
            expires_at=excluded.expires_at
        `).run(key, payload, subject, this.authFingerprint, now, now, expiresAt);
        const evictedKeys = this.db.prepare<[string, string, number], {session_key: string}>(`
          SELECT session_key FROM admin_sessions
          WHERE subject = ? AND auth_fingerprint = ?
          ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
        `).all(subject, this.authFingerprint, this.sessionLimit).map(row => row.session_key);
        this.db.prepare(`
          DELETE FROM admin_sessions
          WHERE session_key IN (
            SELECT session_key
            FROM admin_sessions
            WHERE subject = ? AND auth_fingerprint = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT -1 OFFSET ?
          )
        `).run(subject, this.authFingerprint, this.sessionLimit);
        return [...expiredKeys, ...evictedKeys];
      });
      const removedKeys = transaction();
      for (const key of removedKeys) this.invalidateObservedSession(key);
      chmodPrivateDatabase(this.filePath, this.warn);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  override destroy(sessionId: string, callback?: (err?: unknown) => void) {
    try {
      if (this.closed) throw new Error("Admin session store is closed");
      const key = this.key(sessionId);
      this.db.prepare("DELETE FROM admin_sessions WHERE session_key = ?").run(key);
      this.invalidateObservedSession(key);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const key of this.observations.keys()) this.invalidateObservedSession(key);
    if (this.db.open) {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        this.warn("管理员会话数据库关闭检查点失败，SQLite将在下次启动时恢复。");
      } finally {
        this.db.close();
      }
    }
  }
}
