import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTestDir, removeTestDir } from "./helpers.js";

test("real app supports login, queue state, config update and migration preview in isolation", { timeout: 10_000 }, async () => {
  const runtime = await createTestDir("app-smoke");
  const originalCwd = process.cwd();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAdminPass = process.env.ADMIN_PASS;
  let server: import("node:http").Server | undefined;
  try {
    const retainedDir = path.join(runtime, "temp", "BV1RETAINEDTEST");
    await fs.promises.mkdir(retainedDir, { recursive: true });
    await fs.promises.writeFile(path.join(retainedDir, ".bfb-retained.json"), JSON.stringify({ schemaVersion: 1 }));
    await fs.promises.writeFile(path.join(retainedDir, "unknown.bin"), Buffer.alloc(64));
    process.chdir(runtime);
    process.env.NODE_ENV = "test";
    process.env.ADMIN_PASS = "smoke-pass";
    const { app } = await import("../src/index.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const loginPage = await fetch(`${base}/login`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /B站收藏夹同步/);

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
    assert.match(html, /启动恢复每批数量/);
    assert.match(html, /upload-health-status/);

    const configUpdate = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie },
      body: JSON.stringify({ startupRecoveryBatchSize: 30 }),
    });
    assert.equal(configUpdate.status, 200);
    const configJson: any = await configUpdate.json();
    assert.equal(configJson.data.startupRecoveryBatchSize, 30);

    const queueResponse = await fetch(`${base}/api/queue/state`, { headers: { Cookie: cookie } });
    assert.equal(queueResponse.status, 200);
    const queueJson: any = await queueResponse.json();
    assert.equal(queueJson.data.uploadHealth.state, "closed");
    assert.equal(queueJson.data.recovery.batchSize, 30);
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
    assert.equal(typeof previewJson.data, "object");

    assert.equal(fs.existsSync(path.join(runtime, "data", "state.json")), true);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    process.chdir(originalCwd);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAdminPass === undefined) delete process.env.ADMIN_PASS;
    else process.env.ADMIN_PASS = previousAdminPass;
    await removeTestDir(runtime);
  }
});
