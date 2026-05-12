import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import { TvQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode";
import { ensureAppDirs } from "./paths.js";
import { ConfigStore, validateConfig } from "./config.js";
import { UserStore } from "./users.js";
import { FolderDetailFilter, StateManager } from "./state.js";
import {
  BiliRiskOrLoginError,
  getUserInfo,
  listFavoriteFolders,
  listFavoriteItemsPage,
  normalizeTvAuthResult,
  refreshUserAuth,
} from "./bili.js";
import { renderLoginPage, renderAppPage } from "./web.js";
import { SyncScheduler } from "./scheduler.js";
import { logManager } from "./logger.js";
import { batchRenameRemote, listRemoteDir } from "./uploader.js";

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

scheduler.start();

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
startTokenRefreshLoop();

const app = express();
app.use(express.json());
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

function recordFavoritePageMetadata(
  userId: string,
  mediaId: number,
  folderTitle: string,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  pageResult.items.forEach((item, indexInPage) => {
    const favOrder = (Math.max(1, pageResult.page) - 1) * Math.max(1, pageResult.pageSize) + indexInPage + 1;
    stateManager.recordFavoriteItem(userId, mediaId, folderTitle, item, {
      favOrder,
      favPage: pageResult.page,
      favIndexInPage: indexInPage,
    });
  });
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
  const updated = configStore.update(req.body);
  scheduler.updateInterval();
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

    recordFavoritePageMetadata(user.id, mediaId, folderTitle, pageResult);
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

app.post("/api/rename", asyncHandler(async (req, res) => {
  const { remotePath, renameMap } = req.body as {
    remotePath: string;
    renameMap: Array<{ oldName: string; newName: string }>;
  };
  if (!remotePath || !renameMap || !Array.isArray(renameMap)) {
    res.status(400).json({ success: false, message: "remotePath and renameMap required" });
    return;
  }
  try {
    const config = configStore.get();
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
  res.status(500).json({ success: false, message: err?.message || "Internal server error" });
});



const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
