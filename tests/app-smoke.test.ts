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
    assert.match(html, /upload-health-status/);
    assert.match(html, /网页接口/);
    assert.match(html, /download-api-health-status/);
    assert.match(html, /class="app-brand"/);
    assert.match(html, /class="version-link header-meta"/);
    assert.match(html, /class="github-link header-meta"/);
    assert.match(html, /input\[type="url"\]/);
    assert.match(html, /传输方式未知/);
    assert.match(html, /cleanup_running/);
    assert.match(html, /metadataRetryTimers/);

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
    const configJson: any = await configUpdate.json();
    assert.equal(configJson.data.queuePrefetchLimit, 30);

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
    const queueJson: any = await queueResponse.json();
    assert.equal(queueJson.data.uploadHealth.state, "closed");
    assert.equal(queueJson.data.downloadApiHealth.state, "healthy");
    assert.equal(queueJson.data.downloadApiHealth.configuredMode, "web");
    assert.equal(queueJson.data.recovery.prefetchLimit, 30);
    assert.equal(typeof queueJson.data.localCache.reserveBytes, "number");
    assert.equal(typeof queueJson.data.downloadRecovery.resumableSessions, "number");
    const sessionDatabaseAfter = new Database(sessionDatabasePath, { readonly: true });
    const sessionRowAfter = sessionDatabaseAfter.prepare("SELECT updated_at FROM admin_sessions").get() as { updated_at: number };
    sessionDatabaseAfter.close();
    assert.equal(sessionRowAfter.updated_at, sessionRowBefore.updated_at);

    const guessedSession = await fetch(`${base}/api/queue/state`, { headers: { Cookie: "bfb.sid=guessed-session-id" } });
    assert.equal(guessedSession.status, 401);

    const estimate = await fetch(`${base}/api/migration/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ includeConfig: false, includeUsers: false, includeState: false, includeLogs: false, includeCovers: false }),
    });
    assert.equal(estimate.status, 200);
    const estimateJson: any = await estimate.json();
    assert.equal(estimateJson.data.files, 0);
    assert.equal(estimateJson.data.expandedBytes, 0);

    const cleanupPreview = await fetch(`${base}/api/storage/cleanup`, { headers: { Cookie: cookie } });
    assert.equal(cleanupPreview.status, 200);
    const cleanupPreviewJson: any = await cleanupPreview.json();
    const orphanItem = cleanupPreviewJson.data.items.find((item: any) => item.key === "orphan-fragments");
    assert.ok(orphanItem?.bytes >= 64);

    const cleanup = await fetch(`${base}/api/storage/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ items: ["orphan-fragments"], confirmation: "DELETE" }),
    });
    assert.equal(cleanup.status, 200);
    assert.equal(fs.existsSync(retainedDir), false);

    const tempRoot = path.join(runtime, "temp");
    await fs.promises.mkdir(path.join(tempRoot, "BV1TEMPCLEAR", "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(tempRoot, "BV1TEMPCLEAR", "nested", "fragment.tmp"), "fragment");
    const cleanupAllTemp = await fetch(`${base}/api/storage/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ items: ["temp", "orphan-fragments"], confirmation: "DELETE" }),
    });
    assert.equal(cleanupAllTemp.status, 200);
    const cleanupAllTempJson: any = await cleanupAllTemp.json();
    assert.equal(cleanupAllTempJson.data.results.find((item: any) => item.key === "temp")?.ok, true);
    assert.equal(cleanupAllTempJson.data.results.find((item: any) => item.key === "orphan-fragments")?.skipped, true);
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
      biliStatus: "available", backupStatus: "queued", localDir: "/old/app/temp/BVLIGHTWEIGHT",
      downloadSession: { id: "download-session-old", localDir: "/old/app/temp/BVLIGHTWEIGHT", kind: "main", status: "partial", completedPages: 1, totalPages: 2, updatedAt: new Date(runtimeNow).toISOString() },
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
    assert.equal(Number((lightweightDb.prepare("SELECT COUNT(*) AS count FROM jobs").get() as any).count), 0);
    assert.equal(Number((lightweightDb.prepare("SELECT COUNT(*) AS count FROM transfer_sessions").get() as any).count), 0);
    assert.equal(Number((lightweightDb.prepare("SELECT COUNT(*) AS count FROM transfer_session_files").get() as any).count), 0);
    assert.equal(Number((lightweightDb.prepare("SELECT COUNT(*) AS count FROM download_sessions").get() as any).count), 0);
    const lightweightVideo = lightweightDb.prepare("SELECT local_dir, payload_json, backup_status FROM videos WHERE bvid='BVLIGHTWEIGHT'").get() as any;
    assert.equal(lightweightVideo.local_dir, null);
    assert.equal(lightweightVideo.backup_status, "queued");
    assert.doesNotMatch(String(lightweightVideo.payload_json), /old\/app\/temp|downloadSession/);
    lightweightDb.close();
    await fs.promises.rm(lightweightExtractDir, { recursive: true, force: true });

    const preview = await fetch(`${base}/api/migration/import-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: archive,
    });
    assert.equal(preview.status, 200);
    const previewJson: any = await preview.json();
    assert.equal(previewJson.success, true);
    assert.equal(previewJson.data.manifest.schema, 3);
    assert.ok(previewJson.data.files.includes("data/bfb.sqlite"));
    assert.ok(previewJson.data.files.includes("data/state.json"));
    assert.ok(previewJson.data.files.includes("indexes/unavailable-videos.json"));
    assert.equal(previewJson.data.files.some((name: string) => name.includes("auth-sessions")), false);

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
      body: JSON.stringify({ mode: "complete", includeConfig: false, includeUsers: false, includeState: true, includeCovers: false }),
    });
    assert.equal(completeExport.status, 200);
    const completeArchive = Buffer.from(await completeExport.arrayBuffer());
    await fs.promises.rm(resumableDir, { recursive: true, force: true });
    const completeImport = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreState=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: completeArchive,
    });
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
    const legacyState: any = {
      schemaVersion: 11,
      processedByUser: {},
      failedByUser: {},
      videos: { BVLEGACYIMPORT: { bvid: "BVLEGACYIMPORT", title: "Legacy import", upperName: "Tester", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), biliStatus: "available", backupStatus: "discovered" } },
      relations: { "u1:1:BVLEGACYIMPORT": { userId: "u1", mediaId: 1, bvid: "BVLEGACYIMPORT", folderTitle: "Legacy", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeInFavorite: true, backupStatus: "discovered" } },
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
    const reexportJson: any = await reexportPreview.json();
    assert.equal(reexportJson.data.manifest.counts.videos, 1);

    const automaticBackups = (await fs.promises.readdir(path.join(runtime, "data", "backups")))
      .filter((name) => name.startsWith("before-import-") && name.endsWith(".zip"));
    assert.ok(automaticBackups.length > 0);
    const automaticBackupPreview = await fetch(`${base}/api/migration/import-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: await fs.promises.readFile(path.join(runtime, "data", "backups", automaticBackups[0])),
    });
    assert.equal(automaticBackupPreview.status, 200);
    const automaticBackupJson: any = await automaticBackupPreview.json();
    assert.equal(automaticBackupJson.data.files.some((name: string) => name.includes("auth-sessions")), false);

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
