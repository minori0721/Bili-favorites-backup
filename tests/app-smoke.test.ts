import { readField, required, readArray, readString } from './contract-values.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createTestDir, removeTestDir } from "./helpers.js";
import { createZipFromDirectory, extractZipFile } from "../src/zip.js";
import { ADMIN_REMEMBER_TTL_MS, ADMIN_SESSION_TTL_MS } from "../src/admin-session.js";

test("real app supports login, queue state, config update and migration preview in isolation", { timeout: 60_000 }, async () => {
  const runtime = await createTestDir("app-smoke");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdminPass = process.env.ADMIN_PASS;
  const previousTestAppRoot = process.env.BFB_TEST_APP_ROOT;
  let server: import("node:http").Server | undefined;
  let closeAppResources: (() => Promise<void>) | undefined;
  try {
    const retainedDir = path.join(runtime, "temp", "BV1RETAINEDTEST");
    await fs.promises.mkdir(retainedDir, { recursive: true });
    await fs.promises.writeFile(path.join(retainedDir, ".bfb-retained.json"), JSON.stringify({ schemaVersion: 1 }));
    await fs.promises.writeFile(path.join(retainedDir, "unknown.bin"), Buffer.alloc(64));
    process.env.NODE_ENV = "test";
    process.env.BFB_TEST_APP_ROOT = runtime;
    process.env.ADMIN_PASS = "smoke-pass";
    const appModule = await import("../src/index.js");
    const { app } = appModule;
    closeAppResources = appModule.closeAppResources;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const loginPage = await fetch(`${base}/login`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /B站收藏夹同步/);
    assert.match(loginHtml, /rel="icon" type="image\/svg\+xml"/);
    assert.match(loginHtml, /class="login-meta"/);
    assert.match(loginHtml, /class="github-link login-link"/);
    assert.match(loginHtml, /id="rememberLogin" type="checkbox"/);
    assert.doesNotMatch(loginHtml, /id="rememberLogin"[^>]*checked/);

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "smoke-pass" }),
    });
    assert.equal(login.status, 200);
    const sessionCookieHeader = login.headers.get("set-cookie") || "";
    assert.match(sessionCookieHeader, /^bfb\.sid=/);
    assert.doesNotMatch(sessionCookieHeader, /Max-Age|Expires=/i);
    assert.match(sessionCookieHeader, /HttpOnly/i);
    assert.match(sessionCookieHeader, /SameSite=Lax/i);
    const cookie = sessionCookieHeader.split(";", 1)[0];
    assert.ok(cookie);

    const root = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /任务预取上限/);
    assert.match(html, /rel="icon" type="image\/svg\+xml"/);
    assert.match(html, /网页接口/);
    assert.match(html, /class="app-brand"/);
    assert.match(html, /class="version-link header-meta"/);
    assert.match(html, /class="github-link header-meta"/);
    assert.match(html, /id="archiveLibraryModal"/);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    const scriptPath = html.match(/<script defer src="([^\"]+)"/)?.[1];
    const stylePath = html.match(/<link rel="stylesheet" href="([^\"]+)"/)?.[1];
    assert.ok(scriptPath && stylePath);
    for (const asset of [scriptPath, stylePath]) {
      const unauthenticated = await fetch(base + asset, {redirect:'manual'});
      assert.notEqual(unauthenticated.status, 200);
      const resource = await fetch(base + asset, {headers:{Cookie:cookie}});
      assert.equal(resource.status,200);
      assert.equal(resource.headers.get('cache-control'),'private, max-age=31536000, immutable');
      assert.ok((await resource.arrayBuffer()).byteLength > 0);
    }

    const invalidPremiumAudio = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ bbdownApiMode: "web", bbdownHiRes: true }),
    });
    assert.equal(invalidPremiumAudio.status, 400);

    const configUpdate = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ queuePrefetchLimit: 30 }),
    });
    assert.equal(configUpdate.status, 200);
    const configJson: unknown = await configUpdate.json();
    assert.equal(readField(readField(configJson, 'data'), 'queuePrefetchLimit'), 30);

    const sessionDatabasePath = path.join(runtime, "data", "auth-sessions.sqlite");
    const sessionDatabaseBefore = new Database(sessionDatabasePath, { readonly: true });
    const sessionRowBefore = sessionDatabaseBefore.prepare("SELECT created_at, updated_at, expires_at FROM admin_sessions").get() as { created_at: number; updated_at: number; expires_at: number };
    sessionDatabaseBefore.close();
    const regularSessionTtl = sessionRowBefore.expires_at - sessionRowBefore.created_at;
    assert.ok(regularSessionTtl >= ADMIN_SESSION_TTL_MS - 1_000 && regularSessionTtl <= ADMIN_SESSION_TTL_MS);
    let queueResponse!: Response;
    for (let request = 0; request < 100; request += 1) {
      queueResponse = await fetch(`${base}/api/queue/state`, { headers: { Cookie: cookie } });
      assert.equal(queueResponse.headers.has("set-cookie"), false);
    }
    assert.equal(queueResponse.status, 200);
    const queueJson: unknown = await queueResponse.json();
    assert.equal(readField(readField(readField(queueJson, 'data'), 'uploadHealth'), 'state'), "closed");
    assert.equal(readField(readField(readField(queueJson, 'data'), 'downloadApiHealth'), 'state'), "healthy");
    assert.equal(readField(readField(readField(queueJson, 'data'), 'downloadApiHealth'), 'configuredMode'), "web");
    assert.equal(readField(readField(readField(queueJson, 'data'), 'recovery'), 'prefetchLimit'), 30);
    assert.equal(typeof readField(readField(readField(queueJson, 'data'), 'localCache'), 'reserveBytes'), "number");
    assert.equal(typeof readField(readField(readField(queueJson, 'data'), 'downloadRecovery'), 'resumableSessions'), "number");
    const sessionDatabaseAfter = new Database(sessionDatabasePath, { readonly: true });
    const sessionRowAfter = sessionDatabaseAfter.prepare("SELECT updated_at FROM admin_sessions").get() as { updated_at: number };
    sessionDatabaseAfter.close();
    assert.equal(sessionRowAfter.updated_at, sessionRowBefore.updated_at);

    const guessedSession = await fetch(`${base}/api/queue/state`, { headers: { Cookie: "bfb.sid=guessed-session-id" } });
    assert.equal(guessedSession.status, 401);

    const rawRename = await fetch(`${base}/api/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ items: [{ bvid: "BVRAWPATH", oldPath: "/backup/old.mp4", newPath: "/backup/new.mp4" }] }),
    });
    assert.equal(rawRename.status, 400);
    const missingPreviewRename = await fetch(`${base}/api/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ oldPath: "/backup/old.mp4", newPath: "/backup/new.mp4" }),
    });
    assert.equal(missingPreviewRename.status, 400);

    const estimate = await fetch(`${base}/api/migration/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ includeConfig: false, includeUsers: false, includeState: false, includeLogs: false, includeCovers: false }),
    });
    assert.equal(estimate.status, 200);
    const estimateJson: unknown = await estimate.json();
    assert.equal(readField(readField(estimateJson, 'data'), 'files'), 0);
    assert.equal(readField(readField(estimateJson, 'data'), 'expandedBytes'), 0);

    const cleanupPreview = await fetch(`${base}/api/storage/cleanup`, { headers: { Cookie: cookie } });
    assert.equal(cleanupPreview.status, 200);
    const cleanupPreviewJson: unknown = await cleanupPreview.json();
    const orphanItem = readArray(readField(readField(cleanupPreviewJson, 'data'), 'items')).find((item: unknown) => readField(item, 'key') === "orphan-fragments");
    assert.equal(readField(orphanItem, 'bytes'), 0);

    const cleanup = await fetch(`${base}/api/storage/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ items: ["orphan-fragments"], confirmation: "DELETE" }),
    });
    assert.equal(cleanup.status, 200);
    assert.equal(fs.existsSync(path.join(retainedDir, "unknown.bin")), true);

    const tempRoot = path.join(runtime, "temp");
    await fs.promises.mkdir(path.join(tempRoot, "BV1TEMPCLEAR", "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(tempRoot, "BV1TEMPCLEAR", "nested", "fragment.tmp"), "fragment");
    const cleanupAllTemp = await fetch(`${base}/api/storage/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ items: ["temp", "orphan-fragments"], confirmation: "DELETE" }),
    });
    assert.equal(cleanupAllTemp.status, 200);
    const cleanupAllTempJson: unknown = await cleanupAllTemp.json();
    assert.equal(readField(readArray(readField(readField(cleanupAllTempJson, 'data'), 'results')).find((item: unknown) => readField(item, 'key') === "temp"), 'ok'), true);
    assert.equal(readField(readArray(readField(readField(cleanupAllTempJson, 'data'), 'results')).find((item: unknown) => readField(item, 'key') === "orphan-fragments"), 'skipped'), true);
    assert.equal(fs.existsSync(tempRoot), true);
    assert.deepEqual(await fs.promises.readdir(tempRoot), []);

    const migrationRuntimeDb = new Database(path.join(runtime, "data", "bfb.sqlite"));
    const runtimeNow = Date.now();
    migrationRuntimeDb.prepare(`
      INSERT INTO videos(bvid, backup_status, bili_status, local_dir, payload_json, updated_at)
      VALUES('BVLIGHTWEIGHT', 'queued', 'available', '/old/app/temp/BVLIGHTWEIGHT', ?, ?)
    `).run(JSON.stringify({
      bvid: "BVLIGHTWEIGHT", title: "Lightweight runtime", upperName: "Tester",
      firstSeenAt: new Date(runtimeNow).toISOString(), lastSeenAt: new Date(runtimeNow).toISOString(),
      biliStatus: "available" as const, backupStatus: "queued" as const, localDir: "/old/app/temp/BVLIGHTWEIGHT",
      downloadSession: { id: "download-session-old", localDir: "/old/app/temp/BVLIGHTWEIGHT", kind: "main" as const, status: "partial" as const, completedPages: 1, totalPages: 2, updatedAt: new Date(runtimeNow).toISOString() },
    }), runtimeNow);
    migrationRuntimeDb.prepare(`
      INSERT INTO download_sessions(bvid, session_id, local_dir, kind, status, completed_pages, total_pages, updated_at, payload_json)
      VALUES('BVLIGHTWEIGHT', 'download-session-old', '/old/app/temp/BVLIGHTWEIGHT', 'main', 'partial', 1, 2, ?, '{}')
    `).run(runtimeNow);
    migrationRuntimeDb.prepare(`
      INSERT INTO jobs(id, kind, dedupe_key, bvid, status, priority, payload_json, not_before, created_at, updated_at)
      VALUES('job-lightweight', 'upload', 'upload:lightweight-runtime', 'BVLIGHTWEIGHT', 'retry_wait', 20, ?, ?, ?, ?)
    `).run(JSON.stringify({ localDir: "/old/app/temp/BVLIGHTWEIGHT", allowReupload: true }), runtimeNow + 86_400_000, runtimeNow, runtimeNow);
    migrationRuntimeDb.prepare(`
      INSERT INTO transfer_sessions(id, dedupe_key, kind, bvid, local_dir, remote_path, staging_path, phase, generation, created_at, updated_at)
      VALUES('session-lightweight', 'upload:session-lightweight', 'upload', 'BVLIGHTWEIGHT', '/old/app/temp/BVLIGHTWEIGHT', '/backup/BVLIGHTWEIGHT', '/backup/BVLIGHTWEIGHT', 'awaiting_remote', 1, ?, ?)
    `).run(runtimeNow, runtimeNow);
    migrationRuntimeDb.prepare(`
      INSERT INTO transfer_session_files(session_id, generation, relative_path, name, staging_path, final_path, expected_size, status, created_at, updated_at)
      VALUES('session-lightweight', 1, 'video.mp4', 'video.mp4', '/backup/BVLIGHTWEIGHT/video.mp4', '/backup/BVLIGHTWEIGHT/video.mp4', 12, 'awaiting_remote', ?, ?)
    `).run(runtimeNow, runtimeNow);
    migrationRuntimeDb.close();

    const exported = await fetch(`${base}/api/migration/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ includeConfig: true, includeUsers: true, includeState: true }),
    });
    assert.equal(exported.status, 200);
    const archive = Buffer.from(await exported.arrayBuffer());
    assert.ok(archive.length > 100);

    const lightweightArchivePath = path.join(runtime, "lightweight-runtime.zip");
    await fs.promises.writeFile(lightweightArchivePath, archive);
    const lightweightExtractDir = path.join(runtime, "lightweight-runtime-extract");
    await extractZipFile(lightweightArchivePath, lightweightExtractDir);
    const lightweightDb = new Database(path.join(lightweightExtractDir, "data", "bfb.sqlite"), { readonly: true });
    assert.equal(Number(required((lightweightDb.prepare<unknown[], { "count": number }>("SELECT COUNT(*) AS count FROM jobs").get())).count), 0);
    assert.equal(Number(required((lightweightDb.prepare<unknown[], { "count": number }>("SELECT COUNT(*) AS count FROM transfer_sessions").get())).count), 0);
    assert.equal(Number(required((lightweightDb.prepare<unknown[], { "count": number }>("SELECT COUNT(*) AS count FROM transfer_session_files").get())).count), 0);
    assert.equal(Number(required((lightweightDb.prepare<unknown[], { "count": number }>("SELECT COUNT(*) AS count FROM download_sessions").get())).count), 0);
    const lightweightVideo = lightweightDb.prepare<unknown[], { "local_dir": string | null; "payload_json": string; "backup_status": string }>("SELECT local_dir, payload_json, backup_status FROM videos WHERE bvid='BVLIGHTWEIGHT'").get();
    assert.ok(lightweightVideo);
    assert.equal(lightweightVideo.local_dir, null);
    assert.ok(lightweightVideo);
    assert.equal(lightweightVideo.backup_status, "queued");
    assert.ok(lightweightVideo);
    assert.doesNotMatch(String(lightweightVideo.payload_json), /old\/app\/temp|downloadSession/);
    lightweightDb.close();
    await fs.promises.rm(lightweightExtractDir, { recursive: true, force: true });

    const preview = await fetch(`${base}/api/migration/import-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: archive,
    });
    assert.equal(preview.status, 200);
    const previewJson: unknown = await preview.json();
    assert.equal(readField(previewJson, 'success'), true);
    assert.equal(readField(readField(readField(previewJson, 'data'), 'manifest'), 'schema'), 3);
    assert.ok(readArray(readField(previewJson, 'data', 'files')).includes("data/bfb.sqlite"));
    assert.ok(readArray(readField(previewJson, 'data', 'files')).includes("data/state.json"));
    assert.ok(readArray(readField(previewJson, 'data', 'files')).includes("indexes/unavailable-videos.json"));
    assert.equal(readArray(readField(readField(previewJson, 'data'), 'files')).some((name) => readString(name).includes("auth-sessions")), false);

    const importSchema2 = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: archive,
    });
    assert.equal(importSchema2.status, 409);
    const clearMigrationRuntimeJob = new Database(path.join(runtime, "data", "bfb.sqlite"));
    clearMigrationRuntimeJob.prepare("DELETE FROM jobs WHERE id='job-lightweight'").run();
    clearMigrationRuntimeJob.close();
    const importAfterQueueIdle = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: archive,
    });
    assert.equal(importAfterQueueIdle.status, 200);

    const resumableDir = path.join(tempRoot, "BVCOMPLETE");
    await fs.promises.mkdir(resumableDir, { recursive: true });
    await fs.promises.writeFile(path.join(resumableDir, "track.aria2"), Buffer.alloc(128, 1));
    const completeExport = await fetch(`${base}/api/migration/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ mode: "complete" as const, includeConfig: false, includeUsers: false, includeState: true, includeCovers: false }),
    });
    assert.equal(completeExport.status, 200);
    const completeArchive = Buffer.from(await completeExport.arrayBuffer());
    await fs.promises.rm(resumableDir, { recursive: true, force: true });
    const originalRename = fs.promises.rename;
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const atSwitch = new Promise<void>(resolve => { entered = resolve; });
    fs.promises.rename = (async (from: unknown, to: unknown) => {
      if (String(from).startsWith(`${tempRoot}.migration-`) && String(to) === tempRoot) {
        entered();
        await blocked;
      }
      return originalRename(String(from), String(to));
    }) as typeof originalRename;
    let completeImport: Response;
    try {
    const pendingCompleteImport = fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreState=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: completeArchive,
    });
      await Promise.race([atSwitch, new Promise((_, reject) => setTimeout(() => reject(new Error("import did not reach switch")), 5000).unref())]);
      for (const route of ["/api/config", "/api/path-migration/preview", "/api/users/u1/refresh-auth", "/api/migration/import"]) {
        const conflict = await fetch(`${base}${route}`, { method: route === "/api/config" ? "PUT" : "POST", headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
        assert.equal(conflict.status, 409, route);
      }
      unblock();
      completeImport = await pendingCompleteImport;
    } finally { unblock(); fs.promises.rename = originalRename; }
    assert.equal(completeImport.status, 200);
    assert.equal(fs.existsSync(path.join(tempRoot, "BVCOMPLETE", "track.aria2")), true);
    const refusedCompleteImport = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreState=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: completeArchive,
    });
    assert.equal(refusedCompleteImport.status, 409);
    await fs.promises.rm(path.join(tempRoot, "BVCOMPLETE"), { recursive: true, force: true });

    const legacyStaging = path.join(runtime, "legacy-package");
    await fs.promises.mkdir(path.join(legacyStaging, "data"), { recursive: true });
    const legacyState = {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: { BVLEGACYIMPORT: { bvid: "BVLEGACYIMPORT", title: "Legacy import", upperName: "Tester", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), biliStatus: "available" as const, backupStatus: "discovered" as const } },
      relations: { "u1:1:BVLEGACYIMPORT": { userId: "u1", mediaId: 1, bvid: "BVLEGACYIMPORT", folderTitle: "Legacy", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeInFavorite: true, backupStatus: "discovered" as const } },
      folderScans: {},
      userCooldowns: {},
    };
    await fs.promises.writeFile(path.join(legacyStaging, "data", "state.json"), JSON.stringify(legacyState), "utf8");
    await fs.promises.writeFile(path.join(legacyStaging, "manifest.json"), JSON.stringify({
      schema: 1,
      app: "Bili-favorites-backup",
      version: "2.3.3",
      exportedAt: new Date().toISOString(),
      includes: { includeConfig: false, includeUsers: false, includeState: true, includeLogs: false, includeDebug: false, includeCovers: false },
      counts: { users: 0, videos: 1, relations: 1, unavailableVideos: 0 },
      warning: "test",
    }), "utf8");
    const legacyZip = path.join(runtime, "legacy.zip");
    await createZipFromDirectory(legacyStaging, legacyZip);
    const importSchema1 = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: await fs.promises.readFile(legacyZip),
    });
    assert.equal(importSchema1.status, 200);

    const reexported = await fetch(`${base}/api/migration/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ includeConfig: false, includeUsers: false, includeState: true }),
    });
    assert.equal(reexported.status, 200);
    const reexportPreview = await fetch(`${base}/api/migration/import-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: Buffer.from(await reexported.arrayBuffer()),
    });
    const reexportJson: unknown = await reexportPreview.json();
    assert.equal(readField(readField(readField(readField(reexportJson, 'data'), 'manifest'), 'counts'), 'videos'), 1);

    const automaticBackups = (await fs.promises.readdir(path.join(runtime, "data", "backups")))
      .filter((name) => name.startsWith("before-import-") && name.endsWith(".zip"));
    assert.ok(automaticBackups.length > 0);
    const automaticBackupPreview = await fetch(`${base}/api/migration/import-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: await fs.promises.readFile(path.join(runtime, "data", "backups", automaticBackups[0])),
    });
    assert.equal(automaticBackupPreview.status, 200);
    const automaticBackupJson: unknown = await automaticBackupPreview.json();
    assert.equal(readArray(readField(readField(automaticBackupJson, 'data'), 'files')).some((name) => readString(name).includes("auth-sessions")), false);

    const rememberedLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "smoke-pass", remember: true }),
    });
    assert.equal(rememberedLogin.status, 200);
    const rememberedHeader = rememberedLogin.headers.get("set-cookie") || "";
    const rememberedExpiry = /Expires=([^;]+)/i.exec(rememberedHeader);
    assert.ok(rememberedExpiry);
    const rememberedRemainingMs = Date.parse(rememberedExpiry[1]) - Date.now();
    assert.ok(rememberedRemainingMs >= 30 * 24 * 60 * 60 * 1000 - 5_000);
    const rememberedCookie = rememberedHeader.split(";", 1)[0];
    const rememberedDatabase = new Database(sessionDatabasePath, { readonly: true });
    const rememberedRow = rememberedDatabase.prepare("SELECT created_at, expires_at FROM admin_sessions ORDER BY created_at DESC LIMIT 1").get() as { created_at: number; expires_at: number };
    rememberedDatabase.close();
    const rememberedSessionTtl = rememberedRow.expires_at - rememberedRow.created_at;
    assert.ok(rememberedSessionTtl >= ADMIN_REMEMBER_TTL_MS - 1_000 && rememberedSessionTtl <= ADMIN_REMEMBER_TTL_MS);
    const rememberedAccess = await fetch(`${base}/api/queue/state`, { headers: { Cookie: rememberedCookie } });
    assert.equal(rememberedAccess.status, 200);
    const logout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { Origin: base, Cookie: rememberedCookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") || "", /^bfb\.sid=;/);
    const revokedAccess = await fetch(`${base}/api/queue/state`, { headers: { Cookie: rememberedCookie } });
    assert.equal(revokedAccess.status, 401);

    assert.equal(fs.existsSync(path.join(runtime, "data", "bfb.sqlite")), true);
    assert.equal(fs.existsSync(path.join(runtime, "data", "state.json")), false);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (closeAppResources) await closeAppResources();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdminPass === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = previousAdminPass;
    if (previousTestAppRoot === undefined) delete process.env.BFB_TEST_APP_ROOT;
    else process.env.BFB_TEST_APP_ROOT = previousTestAppRoot;
    await removeTestDir(runtime);
  }
});
