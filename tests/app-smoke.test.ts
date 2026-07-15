import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTestDir, removeTestDir } from "./helpers.js";
import { createZipFromDirectory } from "../src/zip.js";

test("real app supports login, queue state, config update and migration preview in isolation", { timeout: 20_000 }, async () => {
  const runtime = await createTestDir("app-smoke");
  const originalCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdminPass = process.env.ADMIN_PASS;
  let server: import("node:http").Server | undefined;
  let closeAppResources: (() => Promise<void>) | undefined;
  try {
    const retainedDir = path.join(runtime, "temp", "BV1RETAINEDTEST");
    await fs.promises.mkdir(retainedDir, { recursive: true });
    await fs.promises.writeFile(path.join(retainedDir, ".bfb-retained.json"), JSON.stringify({ schemaVersion: 1 }));
    await fs.promises.writeFile(path.join(retainedDir, "unknown.bin"), Buffer.alloc(64));
    process.chdir(runtime);
    process.env.NODE_ENV = "test";
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

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "admin", password: "smoke-pass" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
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

    const queueResponse = await fetch(`${base}/api/queue/state`, { headers: { Cookie: cookie } });
    assert.equal(queueResponse.status, 200);
    const queueJson: any = await queueResponse.json();
    assert.equal(queueJson.data.uploadHealth.state, "closed");
    assert.equal(queueJson.data.downloadApiHealth.state, "healthy");
    assert.equal(queueJson.data.downloadApiHealth.configuredMode, "web");
    assert.equal(queueJson.data.recovery.prefetchLimit, 30);
    assert.equal(typeof queueJson.data.localCache.reserveBytes, "number");
    assert.equal(typeof queueJson.data.downloadRecovery.resumableSessions, "number");

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

    const exported = await fetch(`${base}/api/migration/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ includeConfig: true, includeUsers: true, includeState: true }),
    });
    assert.equal(exported.status, 200);
    const archive = Buffer.from(await exported.arrayBuffer());
    assert.ok(archive.length > 100);

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

    const importSchema2 = await fetch(`${base}/api/migration/import?restoreConfig=false&restoreUsers=false&restoreCovers=false`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", Origin: base, Cookie: cookie },
      body: archive,
    });
    assert.equal(importSchema2.status, 200);

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

    assert.equal(fs.existsSync(path.join(runtime, "data", "bfb.sqlite")), true);
    assert.equal(fs.existsSync(path.join(runtime, "data", "state.json")), false);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (closeAppResources) await closeAppResources();
    process.chdir(originalCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdminPass === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = previousAdminPass;
    await removeTestDir(runtime);
  }
});
