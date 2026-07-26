import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import session from "express-session";
import {
  ADMIN_REMEMBER_TTL_MS,
  ADMIN_SESSION_COOKIE_NAME,
  AdminSessionStore,
  buildAdminAuthFingerprint,
} from "../src/admin-session.js";
import { createTestDir, removeTestDir } from "./helpers.js";

function storeSet(store: AdminSessionStore, id: string, value: session.SessionData) {
  return new Promise<void>((resolve, reject) => store.set(id, value, (error) => error ? reject(error) : resolve()));
}

function storeGet(store: AdminSessionStore, id: string) {
  return new Promise<session.SessionData | null>((resolve, reject) => {
    store.get(id, (error, value) => error ? reject(error) : resolve(value || null));
  });
}

function storedSession(authFingerprint: string, expiresAt: number, name = "admin") {
  return {
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: "/", sameSite: "lax", secure: false },
    user: { name },
    authFingerprint,
    absoluteExpiresAt: expiresAt,
    remember: false,
  } as unknown as session.SessionData;
}

test("admin sessions persist without storing raw session ids and enforce a ten-session limit", async () => {
  const runtime = await createTestDir("admin-session-persist");
  const dbPath = path.join(runtime, "auth-sessions.sqlite");
  const secret = "session-test-secret";
  const fingerprint = buildAdminAuthFingerprint(secret, "admin", "password");
  let now = 1_000_000;
  let store = new AdminSessionStore({
    filePath: dbPath,
    sessionSecret: secret,
    adminUser: "admin",
    adminPassword: "password",
    now: () => now,
    cleanupIntervalMs: 0,
  });
  try {
    for (let index = 0; index < 11; index += 1) {
      await storeSet(store, `raw-session-${index}`, storedSession(fingerprint, now + 60_000));
    }

    const inspection = new Database(dbPath, { readonly: true });
    const rows = inspection.prepare("SELECT session_key, payload_json FROM admin_sessions ORDER BY rowid").all() as Array<{ session_key: string; payload_json: string }>;
    inspection.close();
    assert.equal(rows.length, 10);
    assert.equal(rows.some((row) => row.session_key.includes("raw-session")), false);
    assert.equal(rows.some((row) => row.payload_json.includes("raw-session")), false);
    assert.equal(await storeGet(store, "raw-session-0"), null);
    assert.equal((await storeGet(store, "raw-session-10") as any)?.user?.name, "admin");

    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    assert.equal((await storeGet(store, "raw-session-10") as any)?.user?.name, "admin");

    const database = new Database(dbPath, { readonly: true });
    const before = database.prepare("SELECT updated_at FROM admin_sessions WHERE session_key = ?").get(rows.at(-1)!.session_key) as { updated_at: number };
    database.close();
    for (let count = 0; count < 100; count += 1) await storeGet(store, "raw-session-10");
    const afterDatabase = new Database(dbPath, { readonly: true });
    const after = afterDatabase.prepare("SELECT updated_at FROM admin_sessions WHERE session_key = ?").get(rows.at(-1)!.session_key) as { updated_at: number };
    afterDatabase.close();
    assert.equal(after.updated_at, before.updated_at);
    assert.equal((store as any).touch, undefined);
  } finally {
    store.close();
    await removeTestDir(runtime);
  }
});

test("admin sessions expire exactly and credential changes revoke existing records", async () => {
  const runtime = await createTestDir("admin-session-expiry");
  const dbPath = path.join(runtime, "auth-sessions.sqlite");
  const secret = "session-test-secret";
  const fingerprint = buildAdminAuthFingerprint(secret, "admin", "old-password");
  let now = 5_000;
  let store = new AdminSessionStore({
    filePath: dbPath,
    sessionSecret: secret,
    adminUser: "admin",
    adminPassword: "old-password",
    now: () => now,
    cleanupIntervalMs: 0,
  });
  try {
    await storeSet(store, "expires", storedSession(fingerprint, now + 1_000));
    assert.ok(await storeGet(store, "expires"));
    now += 1_000;
    assert.equal(await storeGet(store, "expires"), null);

    await storeSet(store, "credential-change", storedSession(fingerprint, now + 10_000));
    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "new-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    assert.equal(await storeGet(store, "credential-change"), null);
    const database = new Database(dbPath, { readonly: true });
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get() as any).count, 0);
    database.close();

    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "old-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    await storeSet(store, "username-change", storedSession(fingerprint, now + 10_000));
    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "renamed-admin",
      adminPassword: "old-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    assert.equal(await storeGet(store, "username-change"), null);

    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "old-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    await storeSet(store, "secret-change", storedSession(fingerprint, now + 10_000));
    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: "new-session-secret",
      adminUser: "admin",
      adminPassword: "old-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    assert.equal(await storeGet(store, "secret-change"), null);

    store.close();
    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "old-password",
      now: () => now,
      cleanupIntervalMs: 0,
    });
    await storeSet(store, "malformed", storedSession(fingerprint, now + 10_000));
    const malformedDatabase = new Database(dbPath);
    malformedDatabase.prepare("UPDATE admin_sessions SET payload_json='not-json'").run();
    malformedDatabase.close();
    assert.equal(await storeGet(store, "malformed"), null);
  } finally {
    store.close();
    await removeTestDir(runtime);
  }
});

test("startup cleanup removes structurally invalid admin session rows", async () => {
  const runtime = await createTestDir("admin-session-startup-cleanup");
  const dbPath = path.join(runtime, "auth-sessions.sqlite");
  const secret = "session-cleanup-secret";
  const fingerprint = buildAdminAuthFingerprint(secret, "admin", "password");
  const expiresAt = Date.now() + 60_000;
  let store = new AdminSessionStore({
    filePath: dbPath,
    sessionSecret: secret,
    adminUser: "admin",
    adminPassword: "password",
    cleanupIntervalMs: 0,
  });
  const ids = ["valid", "missing-user", "wrong-subject", "missing-cookie", "expiry-mismatch", "bad-json", "wrong-fingerprint"];
  try {
    for (const id of ids) await storeSet(store, id, storedSession(fingerprint, expiresAt));
    store.close();

    const database = new Database(dbPath);
    const rows = database.prepare("SELECT session_key FROM admin_sessions ORDER BY rowid").all() as Array<{ session_key: string }>;
    assert.equal(rows.length, ids.length);
    database.prepare("UPDATE admin_sessions SET payload_json=json_remove(payload_json, '$.user') WHERE session_key=?").run(rows[1].session_key);
    database.prepare("UPDATE admin_sessions SET subject='other-admin' WHERE session_key=?").run(rows[2].session_key);
    database.prepare("UPDATE admin_sessions SET payload_json=json_remove(payload_json, '$.cookie') WHERE session_key=?").run(rows[3].session_key);
    database.prepare("UPDATE admin_sessions SET payload_json=json_set(payload_json, '$.absoluteExpiresAt', expires_at + 1) WHERE session_key=?").run(rows[4].session_key);
    database.prepare("UPDATE admin_sessions SET payload_json='not-json' WHERE session_key=?").run(rows[5].session_key);
    database.prepare("UPDATE admin_sessions SET auth_fingerprint='invalid' WHERE session_key=?").run(rows[6].session_key);
    database.close();

    store = new AdminSessionStore({
      filePath: dbPath,
      sessionSecret: secret,
      adminUser: "admin",
      adminPassword: "password",
      cleanupIntervalMs: 0,
    });
    const inspection = new Database(dbPath, { readonly: true });
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get() as { count: number }).count, 1);
    inspection.close();
    assert.ok(await storeGet(store, "valid"));
    for (const id of ids.slice(1)) assert.equal(await storeGet(store, id), null);
  } finally {
    store.close();
    await removeTestDir(runtime);
  }
});

test("admin session storage failure does not silently fall back to memory", async () => {
  const runtime = await createTestDir("admin-session-unavailable");
  const blockingFile = path.join(runtime, "not-a-directory");
  await fs.promises.writeFile(blockingFile, "blocked", "utf8");
  try {
    assert.throws(() => new AdminSessionStore({
      filePath: path.join(blockingFile, "auth-sessions.sqlite"),
      sessionSecret: "secret",
      adminUser: "admin",
      adminPassword: "password",
      cleanupIntervalMs: 0,
    }));
  } finally {
    await removeTestDir(runtime);
  }
});

test("a corrupt admin session database is quarantined without exposing session content", async () => {
  const runtime = await createTestDir("admin-session-corrupt");
  const dbPath = path.join(runtime, "auth-sessions.sqlite");
  const warnings: string[] = [];
  await fs.promises.writeFile(dbPath, "not a sqlite database", "utf8");
  const store = new AdminSessionStore({
    filePath: dbPath,
    sessionSecret: "secret",
    adminUser: "admin",
    adminPassword: "password",
    cleanupIntervalMs: 0,
    warn: (message) => warnings.push(message),
  });
  try {
    assert.equal(await storeGet(store, "unknown"), null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /not a sqlite database|auth-sessions|secret|password/i);
    const files = await fs.promises.readdir(runtime);
    assert.ok(files.some((name) => name.startsWith("auth-sessions.sqlite.corrupt-")));
  } finally {
    store.close();
    await removeTestDir(runtime);
  }
});

test("secure remembered login cookies are fixed for thirty days", async () => {
  const runtime = await createTestDir("admin-session-cookie");
  const dbPath = path.join(runtime, "auth-sessions.sqlite");
  const secret = "secure-cookie-secret";
  const fingerprint = buildAdminAuthFingerprint(secret, "admin", "password");
  const store = new AdminSessionStore({
    filePath: dbPath,
    sessionSecret: secret,
    adminUser: "admin",
    adminPassword: "password",
    cleanupIntervalMs: 0,
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use(session({
    name: ADMIN_SESSION_COOKIE_NAME,
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: true, path: "/" },
  }));
  app.post("/login", (req, res) => {
    req.session.user = { name: "admin" };
    req.session.authFingerprint = fingerprint;
    req.session.absoluteExpiresAt = Date.now() + ADMIN_REMEMBER_TTL_MS;
    req.session.remember = true;
    req.session.cookie.maxAge = ADMIN_REMEMBER_TTL_MS;
    res.json({ success: true });
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/login`, {
      method: "POST",
      headers: { "X-Forwarded-Proto": "https" },
    });
    const cookie = response.headers.get("set-cookie") || "";
    assert.match(cookie, /^bfb\.sid=/);
    const expiresMatch = /Expires=([^;]+)/i.exec(cookie);
    assert.ok(expiresMatch);
    const remainingMs = Date.parse(expiresMatch[1]) - Date.now();
    assert.ok(remainingMs >= ADMIN_REMEMBER_TTL_MS - 5_000 && remainingMs <= ADMIN_REMEMBER_TTL_MS + 5_000);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Secure/i);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await removeTestDir(runtime);
  }
});

declare module "express-session" {
  interface SessionData {
    user?: { name: string };
    authFingerprint?: string;
    absoluteExpiresAt?: number;
    remember?: boolean;
  }
}
