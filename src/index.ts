import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import { TvQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode";
import { ensureAppDirs } from "./paths.js";
import { ConfigStore, validateConfig } from "./config.js";
import { UserStore, BiliCookie } from "./users.js";
import { StateManager } from "./state.js";
import {
  BiliRiskOrLoginError,
  getUserInfo,
  listFavoriteFolders,
  listFavoriteItemsPage,
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

// ---------- auto token refresh (biliLive-tools pattern) ----------
function startTokenRefreshLoop() {
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  async function checkAndRefresh() {
    try {
      const users = userStore.list();
      for (const user of users) {
        // Refresh if expires in less than 10 days, or if we have refreshToken
        const tenDays = 10 * 24 * 60 * 60 * 1000;
        if (user.refreshToken && user.accessToken) {
          if (!user.expires || user.expires - Date.now() < tenDays) {
            console.log(`[Auth] Refreshing token for user ${user.name} (${user.id})`);
            const newCookie = await refreshUserAuth(user.accessToken, user.refreshToken);
            if (newCookie) {
              // Parse new expiry
              const sessdataExpires = (newCookie as any)._sessdata_expires;
              userStore.updatePartial(user.id, {
                cookie: newCookie,
                accessToken: newCookie.accessToken || user.accessToken,
                refreshToken: (newCookie as any).refreshToken || user.refreshToken,
                expires: sessdataExpires ? sessdataExpires * 1000 : user.expires,
              } as any);
              console.log(`[Auth] Token refreshed for user ${user.name}`);
            }
          }
        }
      }
    } catch (error: any) {
      console.error("[Auth] Token refresh check failed:", error.message || error);
    } finally {
      setTimeout(checkAndRefresh, CHECK_INTERVAL);
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

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
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

function markFavoriteItemProcessed(userId: string, item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]) {
  return {
    ...item,
    processed: stateManager.isProcessed(userId, item.bvid),
    failed: stateManager.isFailed(userId, item.bvid),
  };
}

function withProcessedStatus(userId: string, pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>) {
  return {
    ...pageResult,
    items: pageResult.items.map((item) => markFavoriteItemProcessed(userId, item)),
  };
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

app.post("/api/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (username === adminUser && password === adminPass) {
    req.session.user = { name: username };
    res.json({ success: true });
    return;
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/config", requireAuth, (req, res) => {
  res.json({ success: true, data: configStore.get() });
});

app.put("/api/config", requireAuth, (req, res) => {
  const error = validateConfig(req.body);
  if (error) {
    res.status(400).json({ success: false, message: error });
    return;
  }
  const updated = configStore.update(req.body);
  scheduler.updateInterval();
  res.json({ success: true, data: updated });
});

app.get("/api/users", requireAuth, (req, res) => {
  const users = userStore.list().map((user) => ({
    id: user.id,
    uid: user.uid,
    name: user.name,
    favoritesCount: user.favorites.length,
    favorites: user.favorites,
    enabled: user.enabled,
    lastLoginAt: user.lastLoginAt,
  }));
  res.json({ success: true, data: users });
});

app.post("/api/users/login/start", requireAuth, asyncHandler(async (req, res) => {
  try {
    pruneLoginSessions();
    const loginId = crypto.randomUUID();
    const login = new TvQrcodeLogin();
    const url = await login.login();
    const qrDataUrl = await QRCode.toDataURL(url);

    setLoginSession(loginId, { status: "pending", qrDataUrl });

    login.emitter.on("completed", async (result: any) => {
      try {
        const rawData = result?.data || {};
        const cookieArray = rawData?.cookie_info?.cookies || [];
        const tokenInfo = rawData?.token_info || {};

        // Build full cookie object from ALL returned cookies (like biliLive-tools)
        const cookie: BiliCookie = {
          SESSDATA: "",
          bili_jct: "",
          DedeUserID: "",
        };
        for (const c of cookieArray) {
          cookie[c.name] = c.value;
        }
        // Also store accessToken at top level for convenience
        cookie.accessToken = tokenInfo.access_token || "";

        const info = await getUserInfo(cookie);
        const userId = String(info.uid);

        // Parse SESSDATA expiry
        const sessdataExpires = cookieArray.find((c: any) => c.name === "SESSDATA")?.expires;
        const expires = sessdataExpires ? sessdataExpires * 1000 : 0;

        userStore.upsert({
          id: userId,
          uid: info.uid,
          name: info.name,
          cookie,
          favorites: [],
          enabled: true,
          lastLoginAt: new Date().toISOString(),
          rawAuth: JSON.stringify(rawData),
          accessToken: tokenInfo.access_token || "",
          refreshToken: tokenInfo.refresh_token || "",
          expires,
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

app.get("/api/users/login/status", requireAuth, (req, res) => {
  pruneLoginSessions();
  const loginId = String(req.query.loginId || "");
  const current = loginSessions.get(loginId);
  if (!current) {
    res.status(404).json({ success: false, message: "Login session not found" });
    return;
  }
  res.json({ success: true, data: { status: current.status, message: current.message } });
});

app.get("/api/users/:id/favorites", requireAuth, asyncHandler(async (req, res) => {
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

app.get("/api/users/:id/favorites/:mediaId/items", requireAuth, asyncHandler(async (req, res) => {
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
      res.json({ success: true, data: withProcessedStatus(user.id, cached.data) });
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
    res.json({ success: true, data: withProcessedStatus(user.id, pageResult) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
}));

app.get("/api/users/:id/unavailable", requireAuth, asyncHandler(async (req, res) => {
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

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      processed: stateManager.getAllProcessed(),
      failed: stateManager.getAllFailed(),
      cooldowns: stateManager.getAllCooldowns(),
    },
  });
});

app.put("/api/users/:id/favorites", requireAuth, asyncHandler(async (req, res) => {
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

app.patch("/api/users/:id", requireAuth, (req, res) => {
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

app.delete("/api/users/:id", requireAuth, (req, res) => {
  userStore.remove(req.params.id);
  res.json({ success: true });
});

app.post("/api/sync/now", requireAuth, asyncHandler(async (req, res) => {
  try {
    scheduler.runNow();
    res.json({ success: true, data: { message: "Sync triggered" } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Sync failed" });
  }
}));

app.get("/api/logs/stream", requireAuth, (req, res) => {
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

app.get("/api/logs", requireAuth, (req, res) => {
  res.json({ success: true, data: logManager.getAll() });
});

app.post("/api/cache/clear", requireAuth, (req, res) => {
  favoriteItemsCache.clear();
  res.json({ success: true, message: "Favorite items cache cleared" });
});

app.post("/api/rename", requireAuth, asyncHandler(async (req, res) => {
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

app.get("/api/remote/list", requireAuth, asyncHandler(async (req, res) => {
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
