import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { testConfig } from "./helpers.js";

const runtimeDir = path.resolve(process.env.BFB_PREVIEW_RUNTIME || path.join(process.cwd(), ".test-runtime", "browser-preview"));
const requestedMode = process.env.BFB_PREVIEW_MODE;
const mode = requestedMode === "degraded" || requestedMode === "risk" || requestedMode === "confirm" ? requestedMode : "healthy";
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
  await fs.promises.writeFile(path.join(localDir, ".bfb-download.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId: "preview-upload-session",
    kind: "backup",
    bvid,
    accountUid: 1,
    bbdownCommit: "259a5558cee0a349a7ebb60bd31e40c88e5bc1ed",
    configFingerprint: "preview",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: now,
    updatedAt: now,
    snapshotAt: now,
    status: "complete",
    pages: [{ index: 1, cid: 1, title: "P1", duration: 1 }],
    outputs: [{ pageIndex: 1, cid: 1, relativePath: "preview.mp4", size: 22, duration: 1, videoCodec: "preview", quickHash: "preview", verifiedAt: now }],
    history: [],
  }, null, 2));
  const retainedDir = path.join(runtimeDir, "temp", "BVRETAINEDPREVIEW");
  await fs.promises.mkdir(retainedDir, { recursive: true });
  await fs.promises.writeFile(path.join(retainedDir, ".bfb-retained.json"), JSON.stringify({ schemaVersion: 1, retainedAt: now }));
  await fs.promises.writeFile(path.join(retainedDir, "unknown.part"), Buffer.alloc(128 * 1024));
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
    schemaVersion: 11,
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

if (mode === "risk") {
  const now = new Date();
  const config = testConfig({ startupRecoveryBatchSize: 5, bbdownApiMode: "web" });
  const state = {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    videos: {},
    relations: {},
    folderScans: {},
    userCooldowns: {},
    downloadApiCooldown: {
      until: now.getTime() + 180_000,
      reason: "B站返回播放接口风控响应",
      probeBvid: "BV1RISKPREVIEW",
      probeUserId: "preview-user",
      probeMode: "app",
      setAt: now.toISOString(),
    },
  };
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(config, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), "[]\n");
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

if (mode === "confirm") {
  const now = new Date().toISOString();
  const users = [{
    id: "preview-user",
    uid: 1,
    name: "预览账号",
    cookie: { SESSDATA: "preview", bili_jct: "preview", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "确认中状态预览" }],
    enabled: true,
    lastLoginAt: now,
  }];
  const makeVideo = (bvid: string, title: string, unavailable: boolean) => ({
    bvid,
    title,
    upperName: "预览 UP",
    firstSeenAt: now,
    lastSeenAt: now,
    biliStatus: unavailable ? "unavailable" : "available",
    favoriteUnavailable: unavailable || undefined,
    backupStatus: "uploaded",
  });
  const makeRelation = (bvid: string, unavailable: boolean) => ({
    userId: "preview-user",
    mediaId: 1,
    bvid,
    folderTitle: "确认中状态预览",
    firstSeenAt: now,
    lastSeenAt: now,
    activeInFavorite: true,
    favoriteUnavailable: unavailable || undefined,
    backupStatus: "uploaded",
    remotePath: "/backup/preview",
    remoteFiles: [{ name: `${bvid}.mp4`, path: `/backup/preview/${bvid}.mp4`, size: 1024, verificationStatus: "awaiting_verification", putCompletedAt: now, nextVerifyAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
  });
  const state = {
    schemaVersion: 11,
    processedByUser: {},
    failedByUser: {},
    videos: {
      BVCONFIRMVISIBLE: makeVideo("BVCONFIRMVISIBLE", "已上传但远端仍在确认的视频", false),
      BVCONFIRMREMOVED: makeVideo("BVCONFIRMREMOVED", "已下架但远端仍在确认的视频", true),
    },
    relations: {
      "preview-user:1:BVCONFIRMVISIBLE": makeRelation("BVCONFIRMVISIBLE", false),
      "preview-user:1:BVCONFIRMREMOVED": makeRelation("BVCONFIRMREMOVED", true),
    },
    folderScans: { "preview-user:1": { userId: "preview-user", mediaId: 1, folderTitle: "确认中状态预览", initStatus: "complete", nextHistoryPage: 1, catchupPage: 1, total: 2 } },
    userCooldowns: {},
  };
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(testConfig({ startupRecoveryBatchSize: 5 }), null, 2));
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
