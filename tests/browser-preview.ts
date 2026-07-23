import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { testConfig } from "./helpers.js";

const runtimeDir = path.resolve(process.env.BFB_PREVIEW_RUNTIME || path.join(process.cwd(), ".test-runtime", "browser-preview"));
const requestedMode = process.env.BFB_PREVIEW_MODE;
const mode = requestedMode === "degraded" || requestedMode === "risk" || requestedMode === "confirm" || requestedMode === "charging" || requestedMode === "quality" || requestedMode === "detail" ? requestedMode : "healthy";
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
    queuePrefetchLimit: 5,
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
  const config = testConfig({ queuePrefetchLimit: 5, bbdownApiMode: "web" });
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
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(testConfig({ queuePrefetchLimit: 5 }), null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), JSON.stringify(users, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

if (mode === "charging") {
  const now = new Date();
  const nextCheckAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const bvid = "BV1gzF7zSEpo";
  const localDir = path.join(runtimeDir, "temp", bvid);
  await fs.promises.mkdir(path.join(localDir, "_invalid", "preview"), { recursive: true });
  await fs.promises.writeFile(path.join(localDir, "_invalid", "preview", "charging-preview.mp4"), Buffer.alloc(48 * 1024));
  await fs.promises.writeFile(path.join(localDir, ".bfb-download.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId: "charging-preview-session",
    kind: "backup",
    bvid,
    accountUid: 1,
    bbdownCommit: "test",
    configFingerprint: "test",
    configSnapshot: { quality: "", encoding: "", hiRes: false, dolby: false, filenameTemplate: "<bvid>" },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    snapshotAt: now.toISOString(),
    status: "failed",
    pages: [{ index: 1, cid: 1, title: "P1", duration: 60 }],
    outputs: [],
    history: [],
  }, null, 2));
  const restriction = {
    type: "charging",
    detectedAt: now.toISOString(),
    lastCheckedAt: now.toISOString(),
    nextCheckAt,
    previewAvailable: true,
    checkedAccountUids: ["1"],
  };
  const state = {
    schemaVersion: 12,
    processedByUser: {},
    failedByUser: {},
    videos: {
      [bvid]: {
        bvid,
        title: "紫色美拍～",
        upperName: "雾奈哟",
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        biliStatus: "available",
        backupStatus: "charging_restricted",
        localDir,
        accessRestriction: restriction,
      },
    },
    relations: {
      [`preview-user:1:${bvid}`]: {
        userId: "preview-user",
        mediaId: 1,
        bvid,
        folderTitle: "充电视频预览",
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        activeInFavorite: true,
        backupStatus: "charging_restricted",
      },
    },
    folderScans: { "preview-user:1": { userId: "preview-user", mediaId: 1, folderTitle: "充电视频预览", initStatus: "complete", nextHistoryPage: 1, catchupPage: 1, total: 1 } },
    userCooldowns: {},
  };
  const users = [{
    id: "preview-user",
    uid: 1,
    name: "预览账号",
    cookie: { SESSDATA: "preview", bili_jct: "preview", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "充电视频预览" }],
    enabled: true,
    lastLoginAt: now.toISOString(),
  }];
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(testConfig({ queuePrefetchLimit: 5 }), null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), JSON.stringify(users, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

if (mode === "quality") {
  const now = new Date();
  const bvid = "BVQUALITYSHARED";
  const users = [1, 2, 3].map((index) => ({
    id: `quality-user-${index}`,
    uid: index,
    name: `画质账号 ${index}`,
    cookie: { SESSDATA: `preview-${index}`, bili_jct: `preview-${index}`, DedeUserID: String(index) },
    favorites: [{ mediaId: index, title: `画质目标 ${index}` }],
    enabled: true,
    lastLoginAt: now.toISOString(),
  }));
  const remoteFile = (index: number) => ({
    name: `${bvid}-${index}.mp4`,
    path: `/backup/quality-${index}/${bvid}-${index}.mp4`,
    size: 1024,
    verificationStatus: "verified",
    qualityProfile: { quality: "1080P", encoding: "AVC", hiRes: false, dolby: false },
  });
  const state = {
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {},
    videos: {
      [bvid]: {
        bvid,
        title: "三个收藏夹共享一次新版下载",
        upperName: "预览 UP",
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        biliStatus: "available",
        backupStatus: "verified",
      },
    },
    relations: Object.fromEntries(users.map((item, offset) => {
      const index = offset + 1;
      return [`${item.id}:${index}:${bvid}`, {
        userId: item.id,
        mediaId: index,
        bvid,
        folderTitle: `画质目标 ${index}`,
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        activeInFavorite: true,
        backupStatus: "verified",
        remotePath: `/backup/quality-${index}`,
        remoteFiles: [remoteFile(index)],
      }];
    })),
    folderScans: {},
    userCooldowns: {},
    downloadApiCooldown: {
      until: now.getTime() + 30 * 60_000,
      reason: "隔离预览暂停下载",
      probeBvid: bvid,
      probeUserId: users[0].id,
      probeMode: "web",
      setAt: now.toISOString(),
    },
  };
  const config = testConfig({
    queuePrefetchLimit: 5,
    bbdownQuality: "4K",
    bbdownEncoding: "HEVC",
    bbdownApiMode: "web",
  });
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(config, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), JSON.stringify(users, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

if (mode === "detail") {
  const now = "2026-07-22T08:30:00.000Z";
  const coverDir = path.join(runtimeDir, "data", "covers");
  await fs.promises.mkdir(coverDir, { recursive: true });
  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAfbi8S8AAAAASUVORK5CYII=", "base64");
  const definitions = [
    { bvid: "BVDETAILLOST", title: "已上传后失效但仍应显示归档前完整标题与本地封面", status: "verified", unavailable: true, active: true, order: 1 },
    { bvid: "BVDETAILCONFIRM", title: "上传完成，正在等待远端最终确认", status: "uploaded", unavailable: false, active: true, order: 2 },
    { bvid: "BVDETAILPARTIAL", title: "多分P视频当前只完成了部分备份", status: "partial_verified", unavailable: false, active: true, order: 3 },
    { bvid: "BVDETAILCHARGE", title: "充电专属视频等待七日权限复查", status: "charging_restricted", unavailable: false, active: true, order: 4 },
    { bvid: "BVDETAILFAILED", title: "下载失败后保留诊断状态的视频", status: "failed", unavailable: false, active: true, order: 5 },
    { bvid: "BVDETAILHISTORY", title: "已经移出收藏夹但备份证据仍然保留的历史记录", status: "verified", unavailable: false, active: false, order: 0 },
  ] as const;
  for (const item of definitions) {
    await fs.promises.writeFile(path.join(coverDir, `${item.bvid}.png`), tinyPng);
  }
  const videos = Object.fromEntries(definitions.map((item) => [item.bvid, {
    bvid: item.bvid,
    title: item.unavailable ? "已失效视频" : item.title,
    upperName: item.unavailable ? "Unknown" : "脱敏预览 UP",
    cover: item.unavailable ? undefined : "/",
    firstSeenAt: "2026-07-10T00:00:00.000Z",
    lastSeenAt: item.active ? now : "2026-07-20T08:30:00.000Z",
    biliStatus: item.unavailable ? "unavailable" : "available",
    favoriteUnavailable: item.unavailable || undefined,
    backupStatus: item.status,
    originalMeta: {
      title: item.title,
      upperName: "脱敏预览 UP",
      cover: "/",
      coverLocalPath: `covers/${item.bvid}.png`,
      capturedAt: "2026-07-10T00:00:00.000Z",
    },
    accessRestriction: item.status === "charging_restricted" ? {
      type: "charging",
      detectedAt: now,
      lastCheckedAt: now,
      nextCheckAt: "2026-07-29T08:30:00.000Z",
      checkedAccountUids: ["1"],
    } : undefined,
    accessClassification: item.status === "failed" ? {
      purpose: "legacy_failure_classification",
      classifiedAt: now,
      result: "other_restricted",
    } : undefined,
  }]));
  const relations = Object.fromEntries(definitions.map((item) => [`preview-user:1:${item.bvid}`, {
    userId: "preview-user",
    mediaId: 1,
    bvid: item.bvid,
    folderTitle: "查看详情脱敏预览",
    firstSeenAt: "2026-07-10T00:00:00.000Z",
    lastSeenAt: item.active ? now : "2026-07-20T08:30:00.000Z",
    favOrder: item.order,
    activeInFavorite: item.active,
    favoriteUnavailable: item.unavailable || undefined,
    backupStatus: item.status,
  }]));
  const state = {
    schemaVersion: 13,
    processedByUser: {},
    failedByUser: {
      "preview-user": {
        "1:BVDETAILFAILED": {
          bvid: "BVDETAILFAILED", mediaId: 1, failedAt: now,
          reason: "脱敏预览中的固定下载失败", permanent: true,
        },
      },
    },
    videos,
    relations,
    folderScans: {
      "preview-user:1": {
        userId: "preview-user", mediaId: 1, folderTitle: "查看详情脱敏预览",
        initStatus: "complete", nextHistoryPage: 1, catchupPage: 1,
        total: 5, lastScannedAt: now,
      },
    },
    userCooldowns: {},
  };
  const users = [{
    id: "preview-user",
    uid: 1,
    name: "预览账号",
    cookie: { SESSDATA: "preview", bili_jct: "preview", DedeUserID: "1" },
    favorites: [{ mediaId: 1, title: "查看详情脱敏预览" }],
    enabled: false,
    lastLoginAt: now,
  }];
  await fs.promises.writeFile(path.join(runtimeDir, "data", "config.json"), JSON.stringify(testConfig({ queuePrefetchLimit: 5 }), null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "users.json"), JSON.stringify(users, null, 2));
  await fs.promises.writeFile(path.join(runtimeDir, "data", "state.json"), JSON.stringify(state, null, 2));
}

process.chdir(runtimeDir);
process.env.NODE_ENV = mode === "detail" ? "test" : "browser-preview";
process.env.ADMIN_PASS = process.env.ADMIN_PASS || "preview-pass";
process.env.PORT = String(port);
const appModule = await import("../src/index.js");
let previewServer: http.Server | undefined;
if (mode === "detail") {
  previewServer = appModule.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => previewServer!.once("listening", resolve));
}

console.log(`Browser preview (${mode}) listening on http://127.0.0.1:${port}`);

const shutdown = () => {
  fakeDav?.close();
  previewServer?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
