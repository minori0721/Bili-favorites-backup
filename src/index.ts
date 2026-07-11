import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TvQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode";
import { backupsDir, coversDir, dataDir, databasePath, ensureAppDirs, exportsDir, tempDir } from "./paths.js";
import { type AppConfig, ConfigStore, validateBBDownRuntimeConfig, validateConfig } from "./config.js";
import { type BiliUser, UserStore } from "./users.js";
import { FolderDetailFilter, type RemoteFileRecord, StateManager, relationKey } from "./state.js";
import {
  BiliRiskOrLoginError,
  getUserInfo,
  listFavoriteFolders,
  listFavoriteItemsPage,
  normalizeTvAuthResult,
  refreshUserAuth,
  resolveSelfVisibleFavoriteItem,
} from "./bili.js";
import { normalizeEncodingPriority, normalizeQualityPriority, shutdownActiveDownloads } from "./downloader.js";
import { BBDOWN_SOURCE_COMMIT, DOWNLOAD_RETAINED_FILE, inspectDownloadRecoverySync, readDownloadSession } from "./download-session.js";
import { renderLoginPage, renderAppPage } from "./web.js";
import { SyncScheduler } from "./scheduler.js";
import { logManager, logsPath } from "./logger.js";
import { QualityUpgradeTask } from "./tasks.js";
import {
  batchRenameRemote,
  batchRenameRemotePaths,
  deleteRemoteFiles,
  listRemoteDir,
  listRemoteFilesRecursive,
  isRemoteNotFoundError,
  moveRemoteFile,
  remotePathExists,
} from "./uploader.js";
import { joinRemotePath, sanitizeSegment } from "./utils.js";
import { sanitizeUploadText } from "./upload-health.js";
import { sqlitePaths } from "./database.js";
import {
  applyMigrationPackage,
  createMigrationExport,
  previewMigrationPackage,
} from "./migration.js";

ensureAppDirs();

const configStore = new ConfigStore();
const userStore = new UserStore();
const stateManager = new StateManager();
const scheduler = new SyncScheduler(configStore, userStore, stateManager);

const favoriteItemsCache = new Map<
  string,
  {
    expiresAt: number;
    data: Awaited<ReturnType<typeof listFavoriteItemsPage>>;
  }
>();
const favoriteItemsCacheTtlMs = 60 * 1000;
const loginSessionTtlMs = 10 * 60 * 1000;

type CleanupItem = "memory-cache" | "temp" | "orphan-fragments" | "logs" | "debug-logs" | "covers" | "exports" | "backups" | "state" | "users" | "config";

const cleanupItems: Record<CleanupItem, { label: string; important: boolean; path?: string }> = {
  "memory-cache": { label: "页面缓存", important: false },
  temp: { label: "全部临时下载文件", important: true, path: tempDir },
  "orphan-fragments": { label: "无法续传的下载残片", important: true },
  logs: { label: "网页日志", important: false, path: logsPath },
  "debug-logs": { label: "Debug 日志", important: false, path: path.join(dataDir, "debug") },
  covers: { label: "封面缓存", important: false, path: coversDir },
  exports: { label: "导出压缩包", important: false, path: exportsDir },
  backups: { label: "导入前备份", important: false, path: backupsDir },
  state: { label: "备份状态与持久化任务", important: true, path: databasePath },
  users: { label: "账号登录信息", important: true, path: path.join(dataDir, "users.json") },
  config: { label: "全局配置", important: true, path: path.join(dataDir, "config.json") },
};

const allCleanupKeys = Object.keys(cleanupItems) as CleanupItem[];

if (process.env.NODE_ENV !== "test") {
  startAfterRecovery();
}

async function startAfterRecovery() {
  await recoverInterruptedQualityUpgrades();
  await recoverInterruptedQualityDownloads();
  scheduler.resumePersistedWorkOnStartup();
  scheduler.start();
}

async function recoverInterruptedQualityDownloads() {
  const remoteRecoveryBlocked = new Set(
    stateManager.listInterruptedQualityUpgrades().map((relation) => relationKey(relation.userId, relation.mediaId, relation.bvid))
  );
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(tempDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("quality-upgrade-")) continue;
    const downloadDir = path.join(tempDir, entry.name);
    const manifest = readDownloadSession(downloadDir);
    const target = manifest?.qualityUpgrade;
    if (!manifest || manifest.kind !== "quality_upgrade" || !target || manifest.status === "partial") continue;
    const key = relationKey(target.userId, target.mediaId, manifest.bvid);
    if (remoteRecoveryBlocked.has(key)) continue;
    const user = userStore.getById(target.userId);
    if (!user || !user.enabled) continue;
    const meta = stateManager.getVideoMeta(manifest.bvid);
    const task = new QualityUpgradeTask(manifest.bvid, { ...user.cookie, accessToken: user.accessToken || "" }, configStore.get(), {
      userId: target.userId,
      mediaId: target.mediaId,
      folderTitle: target.folderTitle,
      remotePath: target.remotePath,
      oldFiles: target.oldFiles,
    });
    task.downloadDir = downloadDir;
    task.runId = `resume-${manifest.sessionId}`;
    task.videoTitle = meta?.title || manifest.bvid;
    task.folderTitle = target.folderTitle;
    task.userId = target.userId;
    task.mediaId = target.mediaId;
    scheduler.enqueueQualityUpgrade(task);
  }
}

function formatExpiresText(expires?: number) {
  if (!expires || expires <= 0) {
    return "未知过期时间";
  }
  const diff = expires - Date.now();
  if (diff <= 0) {
    return "已过期";
  }
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  return `${days}天后过期`;
}

function buildAuthHealth(user: BiliUser) {
  const autoRefreshEnabled = Boolean(user.accessToken && user.refreshToken);
  const lastError = user.lastAuthRefreshError || "";
  const expired = Boolean(user.expires && user.expires <= Date.now());
  const expiringSoon = Boolean(user.expires && user.expires > Date.now() && user.expires - Date.now() < 10 * 24 * 60 * 60 * 1000);
  const needsManualLogin = !autoRefreshEnabled || Boolean(lastError);
  let level: "ok" | "warn" | "error" = "ok";
  let summary = "自动刷新已启用";
  let detail = "普通登录过期会自动刷新，无需人工处理。";

  if (!autoRefreshEnabled) {
    level = "error";
    summary = "需要重新扫码登录";
    detail = "当前账号缺少自动刷新凭据，无法无人值守续期。";
  } else if (lastError) {
    level = "error";
    summary = "自动刷新失败，需要人工确认";
    detail = lastError;
  } else if (expired) {
    level = "warn";
    summary = "登录态已过期，等待自动刷新";
    detail = "账号保留了 refreshToken，后台会自动尝试恢复。";
  } else if (expiringSoon) {
    level = "warn";
    summary = "登录态临近过期，将自动刷新";
    detail = "后台会在任务空闲时刷新授权。";
  }

  return {
    level,
    summary,
    detail,
    autoRefreshEnabled,
    needsManualLogin,
    lastSuccessAt: user.lastAuthRefreshAt || "",
    lastError,
  };
}

async function refreshUserAuthForStore(userId: string, reason: "manual" | "auto" | "on_error") {
  const user = userStore.getById(userId);
  if (!user) {
    throw new Error("User not found");
  }
  if (!user.accessToken || !user.refreshToken) {
    throw new Error("当前账号缺少 accessToken 或 refreshToken，请重新扫码登录。");
  }

  const refreshed = await refreshUserAuth(user.accessToken, user.refreshToken);
  if (!refreshed) {
    throw new Error("当前登录会话已经失效，请重新登录!");
  }

  const info = await getUserInfo(refreshed.cookie);
  const nowIso = new Date().toISOString();
  userStore.updatePartial(user.id, {
    name: info.name,
    avatar: info.avatar,
    cookie: refreshed.cookie,
    rawAuth: refreshed.rawAuth,
    accessToken: refreshed.accessToken || user.accessToken,
    refreshToken: refreshed.refreshToken || user.refreshToken,
    expires: refreshed.expires || user.expires,
    lastAuthRefreshAt: nowIso,
    lastAuthRefreshError: "",
    lastLoginAt: reason === "manual" ? nowIso : user.lastLoginAt,
  });
}

// ---------- auto token refresh (biliLive-tools pattern) ----------
function startTokenRefreshLoop() {
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  const RETRY_INTERVAL_ON_BUSY = 60 * 60 * 1000; // 1 hour

  async function checkAndRefresh() {
    let nextInterval = CHECK_INTERVAL;
    try {
      if (scheduler.hasRunningTransferTasks()) {
        console.warn("[Auth] Skip auto refresh because transfer tasks are running; retry in 1 hour.");
        nextInterval = RETRY_INTERVAL_ON_BUSY;
        return;
      }

      const users = userStore.list();
      for (const user of users) {
        // Refresh if expires in less than 10 days, or if we have refreshToken
        const tenDays = 10 * 24 * 60 * 60 * 1000;
        if (user.refreshToken && user.accessToken) {
          if (!user.expires || user.expires - Date.now() < tenDays) {
            console.log(`[Auth] Refreshing token for user ${user.name} (${user.id})`);
            try {
              await refreshUserAuthForStore(user.id, "auto");
              console.log(`[Auth] Token refreshed for user ${user.name}`);
            } catch (error: any) {
              userStore.updatePartial(user.id, {
                lastAuthRefreshError: error?.message || String(error),
              });
              console.warn(`[Auth] Token refresh failed for user ${user.name}:`, error?.message || error);
            }
          }
        }
      }
    } catch (error: any) {
      console.error("[Auth] Token refresh check failed:", error.message || error);
      nextInterval = RETRY_INTERVAL_ON_BUSY;
    } finally {
      setTimeout(checkAndRefresh, nextInterval);
    }
  }

  // Start first check after 1 minute (let server settle)
  setTimeout(checkAndRefresh, 60_000);
}
if (process.env.NODE_ENV !== "test") {
  startTokenRefreshLoop();
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET || "dev-secret";
const adminUser = process.env.ADMIN_USER || "admin";
const adminPass = process.env.ADMIN_PASS || "admin";
const cookieExportEnabled = process.env.ALLOW_COOKIE_EXPORT !== "false";
const secureSessionCookie = process.env.COOKIE_SECURE === "true";

app.set("trust proxy", 1);

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureSessionCookie,
    },
  })
);

declare module "express-session" {
  interface SessionData {
    user?: { name: string };
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.session.user) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}

function requireSameOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const source = req.get("origin") || req.get("referer") || "";
  if (!source) {
    res.status(403).json({ success: false, message: "Missing request origin" });
    return;
  }
  try {
    const sourceUrl = new URL(source);
    if (sourceUrl.host === req.get("host")) {
      return next();
    }
  } catch {
    res.status(403).json({ success: false, message: "Invalid request origin" });
    return;
  }
  res.status(403).json({ success: false, message: "Invalid request origin" });
}

app.use("/covers", requireAuth, express.static(coversDir, {
  maxAge: "30d",
  immutable: true,
}));

function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function normalizePageSize(value: unknown) {
  return Math.min(parsePositiveInteger(value, 20), 50);
}

function parseFolderDetailFilter(value: unknown): FolderDetailFilter {
  const raw = String(value || "all");
  if (
    raw === "all" ||
    raw === "uploaded" ||
    raw === "pending" ||
    raw === "pending_unavailable" ||
    raw === "uploaded_unavailable"
  ) {
    return raw;
  }
  return "all";
}

async function resolveFavoritePageSelfVisibleItems(
  user: BiliUser,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  const nextItems = [];
  for (const item of pageResult.items) {
    nextItems.push(await resolveSelfVisibleFavoriteItem(user.cookie, user.uid, item));
  }
  return {
    ...pageResult,
    items: nextItems,
  };
}

function markFavoriteItemProcessed(
  userId: string,
  mediaId: number,
  item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]
) {
  return {
    ...item,
    processed: stateManager.isProcessed(userId, item.bvid, mediaId),
    failed: stateManager.isFailed(userId, item.bvid, mediaId),
  };
}

function withProcessedStatus(
  userId: string,
  mediaId: number,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  return {
    ...pageResult,
    items: pageResult.items.map((item) => markFavoriteItemProcessed(userId, mediaId, item)),
  };
}

async function recordFavoritePageMetadata(
  user: BiliUser,
  mediaId: number,
  folderTitle: string,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  const resolvedPage = await resolveFavoritePageSelfVisibleItems(user, pageResult);
  resolvedPage.items.forEach((item, indexInPage) => {
    const favOrder = (Math.max(1, pageResult.page) - 1) * Math.max(1, pageResult.pageSize) + indexInPage + 1;
    stateManager.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
      favOrder,
      favPage: pageResult.page,
      favIndexInPage: indexInPage,
    });
  });
  return resolvedPage;
}

function getBiliListErrorMessage(error: unknown) {
  if (error instanceof BiliRiskOrLoginError) {
    return "B 站返回了风控/登录异常响应，请稍后重试；如持续失败请重新扫码登录。";
  }
  return error instanceof Error && error.message ? error.message : "Failed to list items";
}

function parseUnavailableCursor(value: unknown) {
  if (!value) {
    return { offset: 0 };
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { offset: 0 };
    }
    const offset = Math.max(0, Number(parsed.offset) || 0);
    if (offset > 1_000_000) {
      return { offset: 0 };
    }
    return { offset };
  } catch {
    return { offset: 0 };
  }
}

function encodeUnavailableCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

const loginSessions = new Map<
  string,
  {
    status: "pending" | "completed" | "error";
    qrDataUrl?: string;
    message?: string;
    userId?: string;
    createdAt: number;
    updatedAt: number;
  }
>();

function pruneFavoriteItemsCache(now = Date.now()) {
  for (const [key, value] of favoriteItemsCache) {
    if (value.expiresAt <= now) {
      favoriteItemsCache.delete(key);
    }
  }
}

function pruneLoginSessions(now = Date.now()) {
  for (const [key, value] of loginSessions) {
    if (now - value.updatedAt > loginSessionTtlMs) {
      loginSessions.delete(key);
    }
  }
}

function setLoginSession(
  loginId: string,
  patch: Partial<{
    status: "pending" | "completed" | "error";
    qrDataUrl?: string;
    message?: string;
    userId?: string;
  }>
) {
  const now = Date.now();
  const previous = loginSessions.get(loginId);
  if (!previous) {
    loginSessions.set(loginId, {
      status: patch.status || "pending",
      qrDataUrl: patch.qrDataUrl,
      message: patch.message,
      userId: patch.userId,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  loginSessions.set(loginId, {
    ...previous,
    ...patch,
    updatedAt: now,
  });
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

class BadRequestError extends Error {
  statusCode = 400;
}

function badRequest(message: string) {
  return new BadRequestError(message);
}

app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/");
    return;
  }
  res.send(renderLoginPage());
});

app.get("/", (req, res) => {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  res.send(renderAppPage());
});

app.post("/api/login", requireSameOrigin, (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (username === adminUser && password === adminPass) {
    req.session.regenerate((error) => {
      if (error) {
        res.status(500).json({ success: false, message: "Failed to create session" });
        return;
      }
      req.session.user = { name: username };
      res.json({ success: true });
    });
    return;
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.use("/api", requireAuth, requireSameOrigin);

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/config", (req, res) => {
  res.json({ success: true, data: configStore.get() });
});

app.put("/api/config", (req, res) => {
  const error = validateConfig(req.body);
  if (error) {
    res.status(400).json({ success: false, message: error });
    return;
  }
  const previous = configStore.get();
  const candidate = { ...previous, ...req.body };
  const runtimeError = validateBBDownRuntimeConfig(candidate, userStore.list());
  if (runtimeError) {
    res.status(400).json({ success: false, message: runtimeError });
    return;
  }
  const updated = configStore.update(req.body);
  scheduler.applyConfigUpdate(previous, updated);
  res.json({ success: true, data: updated });
});

app.get("/api/users", (req, res) => {
  const users = userStore.list().map((user) => ({
    id: user.id,
    uid: user.uid,
    name: user.name,
    favoritesCount: user.favorites.length,
    favorites: user.favorites,
    enabled: user.enabled,
    lastLoginAt: user.lastLoginAt,
    avatar: user.avatar || "",
    expires: user.expires || 0,
    expiresText: formatExpiresText(user.expires),
    lastAuthRefreshAt: user.lastAuthRefreshAt || "",
    lastAuthRefreshError: user.lastAuthRefreshError || "",
    authHealth: buildAuthHealth(user),
  }));
  res.json({ success: true, data: users });
});

app.post("/api/users/login/start", asyncHandler(async (req, res) => {
  try {
    pruneLoginSessions();
    const loginId = crypto.randomUUID();
    const login = new TvQrcodeLogin();
    const url = await login.login();
    const qrDataUrl = await QRCode.toDataURL(url);

    setLoginSession(loginId, { status: "pending", qrDataUrl });

    login.emitter.on("completed", async (result: any) => {
      try {
        const authData = normalizeTvAuthResult(result);
        const info = await getUserInfo(authData.cookie);
        const userId = String(info.uid);

        userStore.upsert({
          id: userId,
          uid: info.uid,
          name: info.name,
          avatar: info.avatar,
          cookie: authData.cookie,
          favorites: [],
          enabled: true,
          lastLoginAt: new Date().toISOString(),
          rawAuth: authData.rawAuth,
          accessToken: authData.accessToken,
          refreshToken: authData.refreshToken,
          expires: authData.expires,
          lastAuthRefreshAt: new Date().toISOString(),
          lastAuthRefreshError: "",
        });
        setLoginSession(loginId, { status: "completed", qrDataUrl, userId });
      } catch (error: any) {
        setLoginSession(loginId, { status: "error", qrDataUrl, message: error?.message || "Failed to save user" });
      }
    });

    login.emitter.on("error", (error: any) => {
      const msg = error?.data?.message || error?.message || "Login failed";
      setLoginSession(loginId, { status: "error", qrDataUrl, message: msg });
    });

    res.json({ success: true, data: { loginId, qrDataUrl } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to start login" });
  }
}));

app.post("/api/users/:id/refresh-info", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const info = await getUserInfo(user.cookie);
  userStore.updatePartial(user.id, {
    name: info.name,
    avatar: info.avatar,
  });
  res.json({ success: true, data: { name: info.name, avatar: info.avatar } });
}));

app.post("/api/users/:id/refresh-auth", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  await refreshUserAuthForStore(user.id, "manual");
  const updated = userStore.getById(user.id);
  res.json({
    success: true,
    data: {
      expires: updated?.expires || 0,
      expiresText: formatExpiresText(updated?.expires),
      lastAuthRefreshAt: updated?.lastAuthRefreshAt || "",
      lastAuthRefreshError: updated?.lastAuthRefreshError || "",
      authHealth: updated ? buildAuthHealth(updated) : null,
    },
  });
}));

app.post("/api/users/:id/cookie/export", (req, res) => {
  if (!cookieExportEnabled) {
    res.status(403).json({ success: false, message: "Cookie export is disabled" });
    return;
  }
  if (req.body.confirm !== "EXPORT_COOKIE") {
    res.status(400).json({ success: false, message: "Cookie export confirmation required" });
    return;
  }
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const entries = Object.entries(user.cookie || {}).filter(([key, value]) => {
    if (key === "accessToken" || key === "refreshToken") return false;
    return value !== undefined && value !== null && String(value).length > 0;
  });
  const cookie = entries.map(([key, value]) => `${key}=${value}`).join("; ");
  logManager.push({
    timestamp: new Date().toISOString(),
    type: "system",
    level: "warn",
    summary: `Cookie 已导出: ${user.name}`,
    raw: `[Security] Cookie exported for user ${user.id}`,
    simpleVisible: true,
  });
  res.json({ success: true, data: { cookie } });
});

app.get("/api/users/login/status", (req, res) => {
  pruneLoginSessions();
  const loginId = String(req.query.loginId || "");
  const current = loginSessions.get(loginId);
  if (!current) {
    res.status(404).json({ success: false, message: "Login session not found" });
    return;
  }
  res.json({ success: true, data: { status: current.status, message: current.message } });
});

app.get("/api/users/:id/favorites", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const folders = await listFavoriteFolders(user.cookie);
  const selected = new Set(user.favorites.map((fav) => fav.mediaId));
  const data = folders.map((folder) => ({
    ...folder,
    selected: selected.has(folder.mediaId),
  }));
  res.json({ success: true, data });
}));

app.get("/api/users/:id/favorites/:mediaId/items", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  try {
    pruneFavoriteItemsCache();
    const mediaId = Number(req.params.mediaId);
    if (!Number.isFinite(mediaId) || mediaId < 1) {
      res.status(400).json({ success: false, message: "Invalid mediaId" });
      return;
    }

    const page = parsePositiveInteger(req.query.page, 1);
    const pageSize = 20;
    const cacheKey = `${user.id}:${mediaId}:${page}:${pageSize}`;
    const cached = favoriteItemsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ success: true, data: withProcessedStatus(user.id, mediaId, cached.data) });
      return;
    }
    if (cached) {
      favoriteItemsCache.delete(cacheKey);
    }

    const pageResult = await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
    favoriteItemsCache.set(cacheKey, {
      expiresAt: Date.now() + favoriteItemsCacheTtlMs,
      data: pageResult,
    });
    res.json({ success: true, data: withProcessedStatus(user.id, mediaId, pageResult) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

app.get("/api/users/:id/favorites/:mediaId/detail-items", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  try {
    pruneFavoriteItemsCache();
    const mediaId = Number(req.params.mediaId);
    if (!Number.isFinite(mediaId) || mediaId < 1) {
      res.status(400).json({ success: false, message: "Invalid mediaId" });
      return;
    }

    const page = parsePositiveInteger(req.query.page, 1);
    const pageSize = normalizePageSize(req.query.pageSize);
    const folderTitle = String(req.query.folderTitle || "favorites");
    const cacheKey = `${user.id}:${mediaId}:${page}:${pageSize}`;
    const cached = favoriteItemsCache.get(cacheKey);
    let pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>;
    if (cached && cached.expiresAt > Date.now()) {
      pageResult = cached.data;
    } else {
      if (cached) {
        favoriteItemsCache.delete(cacheKey);
      }
      pageResult = await listFavoriteItemsPage(user.cookie, mediaId, page, pageSize);
      favoriteItemsCache.set(cacheKey, {
        expiresAt: Date.now() + favoriteItemsCacheTtlMs,
        data: pageResult,
      });
    }

    pageResult = await recordFavoritePageMetadata(user, mediaId, folderTitle, pageResult);
    const withStatus = withProcessedStatus(user.id, mediaId, pageResult);
    const indexSummary = stateManager.getFolderIndexSummary(user.id, mediaId, pageResult.total);
    res.json({
      success: true,
      data: {
        ...withStatus,
        summary: {
          total: pageResult.total ?? withStatus.items.length,
          uploaded: indexSummary.uploaded,
          pending: indexSummary.pending,
          pendingUnavailable: indexSummary.pendingUnavailable,
          uploadedUnavailable: indexSummary.uploadedUnavailable,
        },
        indexSummary,
        source: "bili",
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

app.get("/api/users/:id/favorites/:mediaId/state-items", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaId = Number(req.params.mediaId);
  if (!Number.isFinite(mediaId) || mediaId < 1) {
    res.status(400).json({ success: false, message: "Invalid mediaId" });
    return;
  }

  const pageSize = normalizePageSize(req.query.pageSize);
  const page = parsePositiveInteger(req.query.page, 1);
  const filter = parseFolderDetailFilter(req.query.filter);
  const offset = (page - 1) * pageSize;
  const result = stateManager.listFolderItemsForUser(user.id, mediaId, offset, pageSize, filter);
  const folderTitle = String(req.query.folderTitle || "favorites");
  const scan = stateManager.getFolderScan(user.id, mediaId, folderTitle);
  const indexSummary = stateManager.getFolderIndexSummary(user.id, mediaId, scan.total);
  res.json({
    success: true,
    data: {
      items: result.items,
      summary: result.summary,
      indexSummary,
      page,
      pageSize,
      hasMore: result.hasMore,
      total: result.totalFiltered,
    },
  });
}));

app.get("/api/users/:id/unavailable", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  try {
    const pageSize = normalizePageSize(req.query.pageSize);
    const cursor = parseUnavailableCursor(req.query.cursor);
    const page = stateManager.listUnavailableForUser(user.id, cursor.offset, pageSize);
    res.json({
      success: true,
      data: {
        items: page.items,
        hasMore: page.hasMore,
        nextCursor: page.hasMore && page.nextOffset !== null ? encodeUnavailableCursor(page.nextOffset) : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

app.get("/api/state", (req, res) => {
  res.json({
    success: true,
    data: {
      processed: stateManager.getAllProcessed(),
      failed: stateManager.getAllFailed(),
      cooldowns: stateManager.getAllCooldowns(),
    },
  });
});

app.put("/api/users/:id/favorites", asyncHandler(async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaIds = Array.isArray(req.body.mediaIds)
    ? req.body.mediaIds
        .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0)
    : [];
  const folders = await listFavoriteFolders(user.cookie);
  const selected = folders.filter((folder) => mediaIds.includes(folder.mediaId));
  userStore.updateFavorites(user.id, selected.map((folder) => ({ mediaId: folder.mediaId, title: folder.title })));
  res.json({ success: true, data: selected });
}));

app.patch("/api/users/:id", (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  if (req.body.toggle) {
    const updated = userStore.updatePartial(user.id, { enabled: !user.enabled });
    res.json({ success: true, data: updated });
    return;
  }
  res.json({ success: true, data: user });
});

app.delete("/api/users/:id", (req, res) => {
  userStore.remove(req.params.id);
  res.json({ success: true });
});

app.post("/api/sync/now", asyncHandler(async (req, res) => {
  try {
    const result = scheduler.runNow();
    if (result.started) {
      res.json({ success: true, data: { message: "Sync triggered", queued: false } });
      return;
    }
    if (result.queued) {
      res.json({ success: true, data: { message: "Sync queued", queued: true } });
      return;
    }
    res.status(409).json({ success: false, message: "A sync task is already running" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Sync failed" });
  }
}));

app.post("/api/sync/reconcile", asyncHandler(async (_req, res) => {
  try {
    const result = scheduler.runReconcileNow();
    if (result.started) {
      res.json({ success: true, data: { message: "Reconcile triggered", queued: false } });
      return;
    }
    if (result.queued) {
      res.json({ success: true, data: { message: "Reconcile queued", queued: true } });
      return;
    }
    res.status(409).json({ success: false, message: "A sync task is already running" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Reconcile failed" });
  }
}));

app.post("/api/sync/reconcile-remote", asyncHandler(async (_req, res) => {
  try {
    const result = scheduler.runRemoteReconcileNow();
    if (result.started) {
      res.json({ success: true, data: { message: "Remote-only reconcile triggered", queued: false } });
      return;
    }
    if (result.queued) {
      res.json({ success: true, data: { message: "Remote-only reconcile queued", queued: true } });
      return;
    }
    res.status(409).json({ success: false, message: "A sync task is already running" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Remote reconcile failed" });
  }
}));

app.get("/api/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const existing = logManager.getAll();
  for (const entry of existing) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const onLog = (entry: any) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  logManager.on("log", onLog);

  req.on("close", () => {
    logManager.removeListener("log", onLog);
  });
});

app.get("/api/logs", (req, res) => {
  res.json({ success: true, data: logManager.getAll() });
});

app.get("/api/queue/state", (_req, res) => {
  res.json({ success: true, data: scheduler.getQueueSnapshot() });
});

app.post("/api/cache/clear", (req, res) => {
  favoriteItemsCache.clear();
  res.json({ success: true, message: "Favorite items cache cleared" });
});

async function pathSize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path.join(targetPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function normalizeCleanupItems(value: unknown): CleanupItem[] {
  if (!Array.isArray(value)) return [];
  const picked = new Set<CleanupItem>();
  for (const item of value) {
    if (typeof item === "string" && allCleanupKeys.includes(item as CleanupItem)) {
      picked.add(item as CleanupItem);
    }
  }
  return [...picked];
}

function cleanupRequiresIdle(items: CleanupItem[]) {
  return items.some((item) => item !== "memory-cache" && item !== "logs" && item !== "debug-logs" && item !== "covers" && item !== "exports" && item !== "backups");
}

function cleanupConfirmationRequired(items: CleanupItem[]) {
  const important = items.some((item) => cleanupItems[item].important);
  const full = allCleanupKeys.every((key) => items.includes(key));
  if (full) return "DELETE ALL PROJECT DATA";
  if (important) return "DELETE";
  return "";
}

async function removeCleanupTarget(item: CleanupItem) {
  if (item === "memory-cache") {
    favoriteItemsCache.clear();
    return;
  }
  if (item === "logs") {
    logManager.clear();
    return;
  }
  if (item === "orphan-fragments") {
    const roots = await fs.promises.readdir(tempDir, { withFileTypes: true });
    const removeFragments = async (target: string): Promise<void> => {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(target, entry.name);
        const stat = await fs.promises.lstat(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          await removeFragments(fullPath);
          continue;
        }
        if (stat.isFile() && /\.(aria2|tmp|vclip|aclip|part|download)$/i.test(entry.name)) {
          await fs.promises.unlink(fullPath);
        }
      }
    };
    for (const root of roots) {
      if (!root.isDirectory()) continue;
      const downloadDir = path.join(tempDir, root.name);
      if (fs.existsSync(path.join(downloadDir, DOWNLOAD_RETAINED_FILE))) {
        await fs.promises.rm(downloadDir, { recursive: true, force: true });
        continue;
      }
      if (!/^BV[0-9A-Za-z]+$/i.test(root.name)) continue;
      if (readDownloadSession(downloadDir)) continue;
      await removeFragments(downloadDir);
    }
    scheduler.refreshLocalCacheState();
    return;
  }
  if (item === "state") {
    stateManager.clear();
    return;
  }
  const targetPath = cleanupItems[item].path;
  if (!targetPath) return;
  await fs.promises.rm(targetPath, { recursive: true, force: true });
  if (item === "temp") {
    await fs.promises.mkdir(tempDir, { recursive: true });
    scheduler.refreshLocalCacheState();
  } else if (item === "covers") {
    await fs.promises.mkdir(coversDir, { recursive: true });
  } else if (item === "exports") {
    await fs.promises.mkdir(exportsDir, { recursive: true });
  } else if (item === "backups") {
    await fs.promises.mkdir(backupsDir, { recursive: true });
  } else if (item === "users") {
    userStore.clear();
  } else if (item === "config") {
    configStore.reset();
    scheduler.updateInterval();
  }
}

app.get("/api/storage/cleanup", asyncHandler(async (_req, res) => {
  const downloadRecovery = inspectDownloadRecoverySync(tempDir);
  const items = await Promise.all(allCleanupKeys.map(async (key) => ({
    key,
    label: cleanupItems[key].label,
    important: cleanupItems[key].important,
    bytes: key === "orphan-fragments"
      ? downloadRecovery.cleanupEligibleBytes
      : key === "state"
        ? (await Promise.all(sqlitePaths(databasePath).map((file) => pathSize(file)))).reduce((sum, value) => sum + value, 0)
      : cleanupItems[key].path ? await pathSize(cleanupItems[key].path) : 0,
  })));
  res.json({
    success: true,
    data: {
      items,
      runningTransfers: scheduler.hasRunningTransferTasks(),
      activeScheduler: scheduler.hasActiveOrQueuedSchedulerWork(),
      downloadRecovery,
    },
  });
}));

app.post("/api/storage/cleanup", asyncHandler(async (req, res) => {
  const items = normalizeCleanupItems(req.body?.items);
  if (items.length === 0) {
    res.status(400).json({ success: false, message: "请选择要清理的内容" });
    return;
  }
  const requiresIdle = cleanupRequiresIdle(items);
  if (requiresIdle && (scheduler.hasRunningTransferTasks() || scheduler.hasActiveOrQueuedSchedulerWork())) {
    res.status(409).json({ success: false, message: "当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再清理重要数据。" });
    return;
  }
  const required = cleanupConfirmationRequired(items);
  if (required && String(req.body?.confirmation || "") !== required) {
    res.status(400).json({ success: false, message: `请输入 ${required} 确认清理` });
    return;
  }
  const runCleanup = async () => {
    const results: Array<{ key: CleanupItem; label: string; ok: boolean; error?: string }> = [];
    for (const item of items) {
      try {
        await removeCleanupTarget(item);
        results.push({ key: item, label: cleanupItems[item].label, ok: true });
      } catch (error: any) {
        results.push({ key: item, label: cleanupItems[item].label, ok: false, error: error?.message || String(error) });
      }
    }
    return results;
  };
  const results = requiresIdle ? await scheduler.withCleanupLock(runCleanup) : await runCleanup();
  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    res.status(500).json({ success: false, message: `有 ${failed.length} 项清理失败`, data: { results } });
    return;
  }
  res.json({ success: true, data: { results } });
}));

function parseMigrationOptions(value: any) {
  return {
    includeConfig: value?.includeConfig !== false,
    includeUsers: value?.includeUsers !== false,
    includeState: value?.includeState !== false,
    includeLogs: Boolean(value?.includeLogs),
    includeDebug: Boolean(value?.includeDebug),
    includeCovers: value?.includeCovers !== false,
  };
}

const migrationZipBody = express.raw({ type: "application/zip", limit: "512mb" });

function parseBooleanOption(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function reloadStoresAfterImport() {
  configStore.reload();
  userStore.reload();
  stateManager.reload();
  scheduler.reloadStateDatabase();
  logManager.reload();
  scheduler.updateInterval();
}

app.post("/api/migration/export", asyncHandler(async (req, res) => {
  const result = await createMigrationExport(parseMigrationOptions(req.body), stateManager);
  const fileName = path.basename(result.outputPath);
  res.download(result.outputPath, fileName, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}));

app.post("/api/migration/import-preview", migrationZipBody, asyncHandler(async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.length === 0) {
    res.status(400).json({ success: false, message: "请选择导入压缩包" });
    return;
  }
  let preview: Awaited<ReturnType<typeof previewMigrationPackage>>;
  try {
    preview = await previewMigrationPackage(body);
  } catch (error: any) {
    throw badRequest(error?.message || "导入包无法解析");
  }
  res.json({ success: true, data: preview });
}));

app.post("/api/migration/import", migrationZipBody, asyncHandler(async (req, res) => {
  const archive = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (archive.length === 0) {
    res.status(400).json({ success: false, message: "导入压缩包为空" });
    return;
  }
  if (scheduler.hasRunningTransferTasks() || scheduler.hasActiveOrQueuedSchedulerWork()) {
    res.status(409).json({ success: false, message: "当前有同步/扫描/对账或下载/上传任务正在运行，请等任务完成后再导入。" });
    return;
  }
  let result: Awaited<ReturnType<typeof applyMigrationPackage>>;
  try {
    result = await scheduler.withCleanupLock(async () => applyMigrationPackage(archive, {
      restoreConfig: parseBooleanOption(req.query.restoreConfig, true),
      restoreUsers: parseBooleanOption(req.query.restoreUsers, true),
      restoreState: parseBooleanOption(req.query.restoreState, true),
      restoreCovers: parseBooleanOption(req.query.restoreCovers, true),
      restoreLogs: parseBooleanOption(req.query.restoreLogs, false),
      restoreDebug: parseBooleanOption(req.query.restoreDebug, false),
    }, stateManager));
  } catch (error: any) {
    throw badRequest(error?.message || "导入包无法解析");
  }
  reloadStoresAfterImport();
  res.json({ success: true, data: result });
}));

function normalizeRemotePath(value: string) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.startsWith("/") ? normalized || "/" : `/${normalized}`;
}

function remoteBasename(value: string) {
  const parts = normalizeRemotePath(value).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function remoteDirname(value: string) {
  const normalized = normalizeRemotePath(value);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function isRemotePathUnder(root: string, target: string) {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedTarget = normalizeRemotePath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function extractBvid(value: string) {
  return String(value || "").match(/BV[0-9A-Za-z]+/)?.[0] || "";
}

async function restoreInterruptedQualityUpgrade(relation: ReturnType<StateManager["listInterruptedQualityUpgrades"]>[number]) {
  const operation = relation.qualityUpgrade;
  const config = configStore.get();
  if (operation.finalizedAt && operation.newFiles?.length) {
    const cleanup = await deleteRemoteFiles(config, operation.oldFiles.map((file) => ({
      ...file,
      path: joinRemotePath(operation.backupRemotePath, file.name),
    })));
    if (cleanup.failed > 0) {
      throw new Error(`Failed to clean interrupted quality-upgrade backups for ${relation.bvid}`);
    }
    stateManager.completeQualityUpgrade(relation.bvid, relation.userId, relation.mediaId, operation.oldRemotePath, operation.newFiles);
    return;
  }
  for (const newFile of operation.newFiles || []) {
    await moveRemoteFile(config, newFile.path, joinRemotePath(operation.stageRemotePath, newFile.name));
  }
  for (let i = (operation.backupFiles || []).length - 1; i >= 0; i -= 1) {
    const backupFile = operation.backupFiles![i];
    const oldFile = operation.oldFiles.find((file) => file.name === backupFile.name);
    if (oldFile) {
      await moveRemoteFile(config, backupFile.path, oldFile.path);
    }
  }
  const cleanup = await deleteRemoteFiles(config, operation.oldFiles.map((file) => ({
    ...file,
    path: joinRemotePath(operation.stageRemotePath, file.name),
  })));
  if (cleanup.failed > 0) {
    throw new Error(`Failed to clean interrupted quality-upgrade stage files for ${relation.bvid}`);
  }
  stateManager.resetRelationForRetry(relation.bvid, relation.userId, relation.mediaId, "Interrupted quality upgrade was restored for retry.");
  logManager.push({
    timestamp: new Date().toISOString(),
    type: "system",
    level: "warn",
    summary: `已恢复中断的画质重调任务 ${relation.bvid}`,
    raw: `[QualityUpgrade] restored interrupted upgrade ${relation.userId}/${relation.mediaId}/${relation.bvid}`,
    bvid: relation.bvid,
    simpleVisible: true,
    debugVisible: true,
  });
}

async function recoverInterruptedQualityUpgrades() {
  const interrupted = stateManager.listInterruptedQualityUpgrades();
  for (const relation of interrupted) {
    try {
      await restoreInterruptedQualityUpgrade(relation);
    } catch (error: any) {
      const safeError = sanitizeUploadText(error?.message || error);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `恢复中断的画质重调失败 ${relation.bvid}: ${safeError}`,
        raw: `[QualityUpgrade] interrupted restore failed ${relation.userId}/${relation.mediaId}/${relation.bvid}: ${safeError}`,
        bvid: relation.bvid,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }
}

function fillFilenameTemplate(template: string, record: { bvid: string; title: string; upperName: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const name = String(template || "<videoTitle>-<bvid>")
    .replace(/<videoTitle>/g, record.title || record.bvid)
    .replace(/<ownerName>/g, record.upperName || "Unknown")
    .replace(/<bvid>/g, record.bvid)
    .replace(/<publishDate>/g, today)
    .replace(/<videoDate>/g, today)
    .replace(/<dfn>/g, "")
    .replace(/<videoCodecs>/g, "");
  return sanitizeSegment(name).replace(/\.+$/g, "").trim();
}

function describeUpgradeReason(config: ReturnType<ConfigStore["get"]>) {
  const parts: string[] = [];
  if (config.bbdownQuality) parts.push(`目标清晰度 ${config.bbdownQuality}`);
  if (config.bbdownEncoding) parts.push(`编码优先 ${config.bbdownEncoding}`);
  if (config.bbdownHiRes) parts.push("Hi-Res 音频");
  if (config.bbdownDolby) parts.push("杜比音效");
  return parts.length ? parts.join(" / ") : "按当前 BBDown 画质设置重新下载";
}

function getQualityProfile(config: AppConfig) {
  return {
    quality: String(config.bbdownQuality || ""),
    encoding: String(config.bbdownEncoding || ""),
    hiRes: Boolean(config.bbdownHiRes),
    dolby: Boolean(config.bbdownDolby),
  };
}

function isMediaRemoteFile(file: RemoteFileRecord) {
  return /\.(mp4|mkv|flv|mov|m4v)$/i.test(file.name);
}

function qualityProfilesMatch(files: RemoteFileRecord[], config: AppConfig) {
  const mediaFiles = files.filter(isMediaRemoteFile);
  if (mediaFiles.length === 0 || mediaFiles.some((file) => !file.qualityProfile)) {
    return "unknown" as const;
  }
  const target = getQualityProfile(config);
  return mediaFiles.every((file) =>
    file.qualityProfile?.quality === target.quality &&
    file.qualityProfile?.encoding === target.encoding &&
    file.qualityProfile?.hiRes === target.hiRes &&
    file.qualityProfile?.dolby === target.dolby
  ) ? "same" as const : "different" as const;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplateMetadataRegex(template: string, bvid: string) {
  const tokenPattern = /<videoTitle>|<ownerName>|<bvid>|<publishDate>|<videoDate>|<dfn>|<videoCodecs>/g;
  let output = "^";
  let lastIndex = 0;
  let hasQuality = false;
  let hasEncoding = false;
  for (const match of template.matchAll(tokenPattern)) {
    output += escapeRegExp(template.slice(lastIndex, match.index));
    switch (match[0]) {
      case "<bvid>":
        output += escapeRegExp(bvid);
        break;
      case "<dfn>":
        output += "(?<dfn>[^\\/\\.]+?)";
        hasQuality = true;
        break;
      case "<videoCodecs>":
        output += "(?<videoCodecs>[^\\/\\.]+?)";
        hasEncoding = true;
        break;
      default:
        output += ".+?";
        break;
    }
    lastIndex = (match.index || 0) + match[0].length;
  }
  output += escapeRegExp(template.slice(lastIndex));
  output += "(?:_P\\d+)?$";
  if (!hasQuality && !hasEncoding) {
    return null;
  }
  return { regex: new RegExp(output, "i"), hasQuality, hasEncoding };
}

function textMatchesQuality(value: string, target: string) {
  return value.trim().toLowerCase() === normalizeQualityPriority(target).toLowerCase();
}

function textMatchesEncoding(value: string, target: string) {
  return value.trim().toLowerCase() === normalizeEncodingPriority(target).toLowerCase();
}

function qualityFilenameMatchStatus(files: RemoteFileRecord[], bvid: string, config: AppConfig) {
  const needsQuality = Boolean(config.bbdownQuality);
  const needsEncoding = Boolean(config.bbdownEncoding);
  if (!needsQuality && !needsEncoding) {
    return "unknown" as const;
  }
  const mediaFiles = files.filter(isMediaRemoteFile);
  if (mediaFiles.length === 0) {
    return "unknown" as const;
  }
  const templateRegex = buildTemplateMetadataRegex(config.filenameTemplate || "<videoTitle>-<bvid>", bvid);
  if (!templateRegex) {
    return "unknown" as const;
  }
  if ((needsQuality && !templateRegex.hasQuality) || (needsEncoding && !templateRegex.hasEncoding)) {
    return "unknown" as const;
  }
  let matched = false;
  for (const file of mediaFiles) {
    const parsed = templateRegex.regex.exec(file.name.replace(/\.[^.]+$/, ""));
    if (!parsed?.groups) {
      return "unknown" as const;
    }
    if (needsQuality && !textMatchesQuality(parsed.groups.dfn || "", config.bbdownQuality)) {
      return "different" as const;
    }
    if (needsEncoding && !textMatchesEncoding(parsed.groups.videoCodecs || "", config.bbdownEncoding)) {
      return "different" as const;
    }
    matched = true;
  }
  return matched ? "same" as const : "unknown" as const;
}

function getQualityUpgradeMatchStatus(files: RemoteFileRecord[], bvid: string, config: AppConfig) {
  const profileStatus = qualityProfilesMatch(files, config);
  if (profileStatus !== "unknown") {
    return profileStatus;
  }
  if (config.bbdownHiRes || config.bbdownDolby) {
    return "unknown" as const;
  }
  return qualityFilenameMatchStatus(files, bvid, config);
}

function buildQualityUpgradePreview() {
  const config = configStore.get();
  const reason = describeUpgradeReason(config);
  const records = stateManager.getRemoteFilePreviewRecords();
  const candidates: Array<{
    key: string;
    bvid: string;
    title: string;
    ownerName: string;
    userId: string;
    mediaId: number;
    folderTitle: string;
    remotePath: string;
    oldFiles: RemoteFileRecord[];
    reason: string;
  }> = [];
  const skipped: Array<{ bvid?: string; title?: string; folderTitle?: string; reason: string }> = [];

  for (const record of records) {
    for (const relation of record.relations) {
      const oldFiles = relation.remoteFiles?.length ? relation.remoteFiles : [];
      const remotePath = relation.remotePath || remoteDirname(oldFiles[0]?.path || "");
      if (relation.hasInterruptedQualityUpgrade) {
        skipped.push({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "上一次画质重调正在恢复中" });
        continue;
      }
      if (relation.backupStatus !== "verified" && relation.backupStatus !== "partial_verified") {
        skipped.push({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: relation.backupStatus === "uploaded" ? "远端文件仍在确认中" : "只有最终确认的视频才能重调画质" });
        continue;
      }
      if (!oldFiles.length || !remotePath) {
        skipped.push({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "没有可替换的远端文件记录" });
        continue;
      }
      const key = relationKey(relation.userId, relation.mediaId, record.bvid);
      if (scheduler.hasQualityUpgrade(relation.userId, relation.mediaId, record.bvid)) {
        skipped.push({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "已在画质重调队列中" });
        continue;
      }
      if (getQualityUpgradeMatchStatus(oldFiles, record.bvid, config) === "same") {
        skipped.push({ bvid: record.bvid, title: record.title, folderTitle: relation.folderTitle, reason: "远端文件已符合当前画质设置" });
        continue;
      }
      candidates.push({
        key,
        bvid: record.bvid,
        title: record.title,
        ownerName: record.upperName,
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
        remotePath,
        oldFiles,
        reason,
      });
    }
  }

  return { candidates, skipped, target: {
    quality: config.bbdownQuality,
    encoding: config.bbdownEncoding,
    hiRes: config.bbdownHiRes,
    dolby: config.bbdownDolby,
  } };
}

app.post("/api/quality-upgrade/preview", asyncHandler(async (_req, res) => {
  res.json({ success: true, data: buildQualityUpgradePreview() });
}));

app.post("/api/quality-upgrade", asyncHandler(async (req, res) => {
  const { items } = req.body as { items?: Array<{ key?: string; userId?: string; mediaId?: number; bvid?: string }> };
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    res.status(400).json({ success: false, message: "items must contain 1-50 entries" });
    return;
  }
  const preview = buildQualityUpgradePreview();
  const candidates = new Map(preview.candidates.map((item) => [item.key, item]));
  const config = configStore.get();
  const queued: Array<{ key: string; bvid: string; title: string }> = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const requestedKeys = new Set<string>();

  for (const item of items) {
    const key = item.key || (item.userId && item.mediaId && item.bvid ? relationKey(item.userId, Number(item.mediaId), item.bvid) : "");
    if (!key || requestedKeys.has(key)) {
      skipped.push({ key, reason: key ? "重复提交" : "缺少任务标识" });
      continue;
    }
    requestedKeys.add(key);
    const candidate = candidates.get(key);
    if (!candidate) {
      skipped.push({ key, reason: "预览候选不存在或已在队列中" });
      continue;
    }
    const user = userStore.getById(candidate.userId);
    if (!user || !user.enabled) {
      skipped.push({ key, reason: "账号不存在或未启用" });
      continue;
    }
    const task = new QualityUpgradeTask(candidate.bvid, { ...user.cookie, accessToken: user.accessToken || "" }, config, {
      userId: candidate.userId,
      mediaId: candidate.mediaId,
      folderTitle: candidate.folderTitle,
      remotePath: candidate.remotePath,
      oldFiles: candidate.oldFiles,
    });
    task.videoTitle = candidate.title;
    task.folderTitle = candidate.folderTitle;
    task.userId = candidate.userId;
    task.mediaId = candidate.mediaId;
    if (!scheduler.enqueueQualityUpgrade(task)) {
      skipped.push({ key, reason: "该任务已在持久化队列中" });
      continue;
    }
    queued.push({ key, bvid: candidate.bvid, title: candidate.title });
  }

  res.json({ success: true, data: { queued, skipped } });
}));

app.get("/api/quality-upgrade/state", (_req, res) => {
  res.json({ success: true, data: scheduler.getQualityUpgradeState() });
});

app.post("/api/rename/preview", asyncHandler(async (_req, res) => {
  const config = configStore.get();
  const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos");
  const records = new Map(stateManager.getRemoteFilePreviewRecords().map((record) => [record.bvid, record]));
  const scanned = await listRemoteFilesRecursive(config, root, { maxDepth: 4, maxFiles: 2000 });
  const candidates: Array<{
    bvid: string;
    title: string;
    ownerName: string;
    remoteDir: string;
    oldName: string;
    newName: string;
    oldPath: string;
    newPath: string;
    reason: string;
  }> = [];
  const skipped = [...scanned.skipped];
  const namesByDir = new Map<string, Set<string>>();

  for (const file of scanned.files) {
    const set = namesByDir.get(file.dir) || new Set<string>();
    set.add(file.name);
    namesByDir.set(file.dir, set);
  }

  for (const file of scanned.files) {
    if (!isRemotePathUnder(root, file.path)) {
      skipped.push({ path: file.path, reason: "路径不在当前 AList 目标路径下" });
      continue;
    }
    const bvid = extractBvid(file.name);
    if (!bvid) {
      skipped.push({ path: file.path, reason: "文件名没有 BV 号" });
      continue;
    }
    const record = records.get(bvid);
    if (!record) {
      skipped.push({ path: file.path, reason: "BV 号在本地状态中找不到" });
      continue;
    }
    const baseName = fillFilenameTemplate(config.filenameTemplate, record);
    if (!baseName) {
      skipped.push({ path: file.path, reason: "无法根据当前模板生成目标文件名" });
      continue;
    }
    const ext = file.name.match(/\.[^.]+$/)?.[0] || ".mp4";
    const newName = `${baseName}${ext}`;
    if (newName === file.name) {
      skipped.push({ path: file.path, reason: "当前文件名已经符合模板" });
      continue;
    }
    const dirNames = namesByDir.get(file.dir) || new Set<string>();
    if (dirNames.has(newName)) {
      skipped.push({ path: file.path, reason: `目标文件已存在：${newName}` });
      continue;
    }
    dirNames.add(newName);
    namesByDir.set(file.dir, dirNames);
    candidates.push({
      bvid,
      title: record.title,
      ownerName: record.upperName,
      remoteDir: file.dir,
      oldName: file.name,
      newName,
      oldPath: file.path,
      newPath: `${file.dir.replace(/\/$/, "")}/${newName}`,
      reason: "同目录内按当前命名模板重命名",
    });
  }

  res.json({ success: true, data: { candidates, skipped } });
}));

app.post("/api/rename", asyncHandler(async (req, res) => {
  const { remotePath, renameMap, items } = req.body as {
    remotePath?: string;
    renameMap?: Array<{ oldName: string; newName: string }>;
    items?: Array<{ bvid?: string; oldPath: string; newPath: string }>;
  };
  const config = configStore.get();
  if (Array.isArray(items)) {
    if (items.length === 0 || items.length > 200) {
      res.status(400).json({ success: false, message: "items must contain 1-200 entries" });
      return;
    }
    const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos");
    const records = new Map(stateManager.getRemoteFilePreviewRecords().map((record) => [record.bvid, record]));
    const requestedTargets = new Set<string>();
    const safeItems: Array<{ bvid?: string; oldPath: string; newPath: string }> = [];
    for (const item of items) {
      const oldPath = normalizeRemotePath(item.oldPath);
      const newPath = normalizeRemotePath(item.newPath);
      if (!isRemotePathUnder(root, oldPath) || !isRemotePathUnder(root, newPath)) {
        res.status(400).json({ success: false, message: "rename path must stay under current alistDest" });
        return;
      }
      if (remoteDirname(oldPath) !== remoteDirname(newPath)) {
        res.status(400).json({ success: false, message: "rename cannot move files across directories" });
        return;
      }
      if (oldPath === newPath) {
        res.status(400).json({ success: false, message: "oldPath and newPath must be different" });
        return;
      }
      const bvid = extractBvid(item.bvid || oldPath);
      if (!bvid) {
        res.status(400).json({ success: false, message: "each rename item must include a BV id" });
        return;
      }
      if (!records.has(bvid)) {
        res.status(400).json({ success: false, message: `local state does not contain ${bvid}` });
        return;
      }
      if (requestedTargets.has(newPath)) {
        res.status(400).json({ success: false, message: `duplicate target path: ${newPath}` });
        return;
      }
      requestedTargets.add(newPath);
      if (await remotePathExists(config, newPath)) {
        res.status(400).json({ success: false, message: `target exists: ${newPath}` });
        return;
      }
      safeItems.push({ bvid, oldPath, newPath });
    }
    const result = await batchRenameRemotePaths(config, safeItems);
    for (const item of result.results) {
      if (!item.ok) continue;
      const source = safeItems.find((candidate) => candidate.oldPath === item.oldPath && candidate.newPath === item.newPath);
      const bvid = source?.bvid || extractBvid(item.oldPath) || extractBvid(item.newPath);
      if (bvid) {
        stateManager.renameRemoteFile(bvid, item.oldPath, item.newPath);
      }
    }
    res.json({ success: true, data: result });
    return;
  }
  if (!remotePath || !renameMap || !Array.isArray(renameMap)) {
    res.status(400).json({ success: false, message: "items or remotePath and renameMap required" });
    return;
  }
  try {
    const result = await batchRenameRemote(config, remotePath, renameMap);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Rename failed" });
  }
}));

app.get("/api/remote/list", asyncHandler(async (req, res) => {
  const remotePath = String(req.query.path || "/");
  try {
    const config = configStore.get();
    const files = await listRemoteDir(config, remotePath);
    res.json({ success: true, data: files });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to list" });
  }
}));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[HTTP] Unhandled route error:", err?.message || err);
  if (res.headersSent) {
    return;
  }
  const statusCode = Number(err?.statusCode || err?.status);
  const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  res.status(safeStatus).json({ success: false, message: err?.message || "Internal server error" });
});



export async function closeAppResources() {
  scheduler.beginShutdown();
  await scheduler.shutdown(5_000);
}

export { app };

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    console.log(`[Runtime] BBDown release ${process.env.BBDOWN_RELEASE || "local"}; source commit ${process.env.BBDOWN_COMMIT || BBDOWN_SOURCE_COMMIT}; FFmpeg ${process.env.FFMPEG_VERSION || "system"}; aria2 resume enabled`);
  });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal}: stopping scheduler and active downloads`);
    scheduler.beginShutdown();
    server.close();
    await shutdownActiveDownloads(20_000).catch((error) => {
      console.warn("[Shutdown] Failed to stop active downloads cleanly:", error?.message || error);
    });
    await scheduler.shutdown(20_000).catch((error) => {
      console.warn("[Shutdown] Failed to checkpoint state database cleanly:", error?.message || error);
    });
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
