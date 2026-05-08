import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import { TvQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode";
import { ensureAppDirs } from "./paths.js";
import { ConfigStore, validateConfig } from "./config.js";
import { UserStore, buildCookieString } from "./users.js";
import { StateManager } from "./state.js";
import {
  BiliRiskOrLoginError,
  getUserInfo,
  listFavoriteFolders,
  listFavoriteItemsPage,
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

scheduler.start();

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
    return "B 站返回了非 JSON 页面，可能是登录失效或触发风控。请稍后重试，必要时重新扫码登录。";
  }
  return error instanceof Error && error.message ? error.message : "Failed to list items";
}

function parseUnavailableCursor(value: unknown) {
  if (!value) {
    return { folderIndex: 0, page: 1 };
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { folderIndex: 0, page: 1 };
    }
    const folderIndex = Math.max(0, parsePositiveInteger(parsed.folderIndex, 0));
    const page = parsePositiveInteger(parsed.page, 1);
    // Validate bounds: prevent malicious cursors from causing excessive API calls
    if (folderIndex > 10000 || page > 10000) {
      return { folderIndex: 0, page: 1 };
    }
    return { folderIndex, page };
  } catch {
    return { folderIndex: 0, page: 1 };
  }
}

function encodeUnavailableCursor(folderIndex: number, page: number) {
  return Buffer.from(JSON.stringify({ folderIndex, page }), "utf8").toString("base64url");
}

const loginSessions = new Map<
  string,
  { status: "pending" | "completed" | "error"; qrDataUrl?: string; message?: string; userId?: string }
>();

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

app.post("/api/users/login/start", requireAuth, async (req, res) => {
  try {
    const loginId = crypto.randomUUID();
    const login = new TvQrcodeLogin();
    const url = await login.login();
    const qrDataUrl = await QRCode.toDataURL(url);

    loginSessions.set(loginId, { status: "pending", qrDataUrl });

    login.emitter.on("completed", async (result: any) => {
      try {
        const cookieArray = result?.data?.cookie_info?.cookies || [];
        const accessToken = result?.data?.token_info?.access_token;
        const cookie = {
          SESSDATA: cookieArray.find((c: any) => c.name === "SESSDATA")?.value || "",
          bili_jct: cookieArray.find((c: any) => c.name === "bili_jct")?.value || "",
          DedeUserID: cookieArray.find((c: any) => c.name === "DedeUserID")?.value || "",
          accessToken: accessToken || "",
        };
        const info = await getUserInfo(cookie);
        const userId = String(info.uid);
        userStore.upsert({
          id: userId,
          uid: info.uid,
          name: info.name,
          cookie,
          favorites: [],
          enabled: true,
          lastLoginAt: new Date().toISOString(),
        });
        loginSessions.set(loginId, { status: "completed", qrDataUrl, userId });
      } catch (error: any) {
        loginSessions.set(loginId, { status: "error", qrDataUrl, message: error?.message || "Failed to save user" });
      }
    });

    login.emitter.on("error", (error: any) => {
      const msg = error?.data?.message || error?.message || "Login failed";
      loginSessions.set(loginId, { status: "error", qrDataUrl, message: msg });
    });

    res.json({ success: true, data: { loginId, qrDataUrl } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to start login" });
  }
});

app.get("/api/users/login/status", requireAuth, (req, res) => {
  const loginId = String(req.query.loginId || "");
  const current = loginSessions.get(loginId);
  if (!current) {
    res.status(404).json({ success: false, message: "Login session not found" });
    return;
  }
  res.json({ success: true, data: { status: current.status, message: current.message } });
});

app.get("/api/users/:id/favorites", requireAuth, async (req, res) => {
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
});

app.get("/api/users/:id/favorites/:mediaId/items", requireAuth, async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  try {
    const cookieString = buildCookieString(user.cookie);
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

    const pageResult = await listFavoriteItemsPage(cookieString, mediaId, page, pageSize);
    favoriteItemsCache.set(cacheKey, {
      expiresAt: Date.now() + favoriteItemsCacheTtlMs,
      data: pageResult,
    });
    res.json({ success: true, data: withProcessedStatus(user.id, pageResult) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
});

app.get("/api/users/:id/unavailable", requireAuth, async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }

  try {
    const cookieString = buildCookieString(user.cookie);
    const pageSize = normalizePageSize(req.query.pageSize);
    const cursor = parseUnavailableCursor(req.query.cursor);
    const results: Array<{
      bvid: string;
      title: string;
      upperName: string;
      cover?: string;
      unavailable?: boolean;
      processed: boolean;
      failed: boolean;
      mediaId: number;
      folderTitle: string;
    }> = [];

    let folderIndex = cursor.folderIndex;
    let page = cursor.page;
    while (folderIndex < user.favorites.length && results.length < pageSize) {
      const folder = user.favorites[folderIndex];
      const pageResult = await listFavoriteItemsPage(cookieString, folder.mediaId, page, 20);
      for (const item of pageResult.items) {
        if (!item.unavailable) continue;
        results.push({
          ...item,
          processed: stateManager.isProcessed(user.id, item.bvid),
          failed: stateManager.isFailed(user.id, item.bvid),
          mediaId: folder.mediaId,
          folderTitle: folder.title,
        });
        if (results.length >= pageSize) {
          break;
        }
      }

      if (pageResult.hasMore) {
        page += 1;
      } else {
        folderIndex += 1;
        page = 1;
      }
    }

    const hasMore = folderIndex < user.favorites.length;
    res.json({
      success: true,
      data: {
        items: results,
        hasMore,
        nextCursor: hasMore ? encodeUnavailableCursor(folderIndex, page) : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: getBiliListErrorMessage(err) });
  }
});

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      processed: stateManager.getAllProcessed(),
      failed: stateManager.getAllFailed(),
    },
  });
});

app.put("/api/users/:id/favorites", requireAuth, async (req, res) => {
  const user = userStore.getById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found" });
    return;
  }
  const mediaIds = (req.body.mediaIds || []) as number[];
  const folders = await listFavoriteFolders(user.cookie);
  const selected = folders.filter((folder) => mediaIds.includes(folder.mediaId));
  userStore.updateFavorites(user.id, selected.map((folder) => ({ mediaId: folder.mediaId, title: folder.title })));
  res.json({ success: true, data: selected });
});

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

app.post("/api/sync/now", requireAuth, async (req, res) => {
  try {
    scheduler.runNow();
    res.json({ success: true, data: { message: "Sync triggered" } });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Sync failed" });
  }
});

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

app.post("/api/rename", requireAuth, async (req, res) => {
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
});

app.get("/api/remote/list", requireAuth, async (req, res) => {
  const remotePath = String(req.query.path || "/");
  try {
    const config = configStore.get();
    const files = await listRemoteDir(config, remotePath);
    res.json({ success: true, data: files });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to list" });
  }
});



const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
