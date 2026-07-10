import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { testConfig } from "./helpers.js";

const runtimeDir = path.resolve(process.env.BFB_PREVIEW_RUNTIME || path.join(process.cwd(), ".test-runtime", "browser-preview"));
const mode = process.env.BFB_PREVIEW_MODE === "degraded" ? "degraded" : "healthy";
const port = Number(process.env.PORT || 3188);

await fs.promises.mkdir(path.join(runtimeDir, "data"), { recursive: true });
await fs.promises.mkdir(path.join(runtimeDir, "temp"), { recursive: true });

let fakeDav: http.Server | undefined;
if (mode === "degraded") {
  fakeDav = http.createServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 401, message: "preview unauthorized token=preview-secret" }));
  });
  await new Promise<void>((resolve) => fakeDav!.listen(0, "127.0.0.1", resolve));
  const address = fakeDav.address();
  if (!address || typeof address === "string") throw new Error("Failed to start preview WebDAV server");

  const localDir = path.join(runtimeDir, "temp", "BVUPLOADFAILED");
  await fs.promises.mkdir(localDir, { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "preview.mp4"), "preview-upload-content");
  const now = new Date().toISOString();
  const bvid = "BVUPLOADFAILED";
  const config = testConfig({
    alistUrl: `http://127.0.0.1:${address.port}`,
    startupRecoveryBatchSize: 5,
  });
  const users = [{
    id: "preview-user",
    uid: 1,
    name: "预览账号",
    cookie: { SESSDATA: "preview", bili_jct: "preview", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "异常补传预览" }],
    enabled: true,
    lastLoginAt: now,
  }];
  const state = {
    schemaVersion: 9,
    processedByUser: {},
    failedByUser: {},
    videos: {
      [bvid]: {
        bvid,
        title: "上传失败后保留的本地视频",
        upperName: "预览 UP",
        firstSeenAt: now,
        lastSeenAt: now,
        biliStatus: "available",
        backupStatus: "upload_failed",
        localDir,
        remotePath: "/backup/preview",
      },
    },
    relations: {
      [`preview-user:1:${bvid}`]: {
        userId: "preview-user",
        mediaId: 1,
        bvid,
        folderTitle: "异常补传预览",
        firstSeenAt: now,
        lastSeenAt: now,
        activeInFavorite: true,
        backupStatus: "upload_failed",
        remotePath: "/backup/preview",
      },
    },
    folderScans: {},
    userCooldowns: {},
  };
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(config, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), JSON.stringify(users, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

process.chdir(runtimeDir);
process.env.NODE_ENV = "browser-preview";
process.env.ADMIN_PASS = process.env.ADMIN_PASS || "preview-pass";
process.env.PORT = String(port);
await import("../src/index.js");

console.log(`Browser preview (${mode}) listening on http://127.0.0.1:${port}`);

const shutdown = () => {
  fakeDav?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
