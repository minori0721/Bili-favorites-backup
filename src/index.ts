import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import { WebQrcodeLogin } from "@renmu/bili-api";
import QRCode from "qrcode";
import { ensureAppDirs } from "./paths.js";
import { ConfigStore, validateConfig } from "./config.js";
import { UserStore } from "./users.js";
import { StateManager } from "./state.js";
import { getUserInfo, listFavoriteFolders } from "./bili.js";
import { renderLoginPage, renderAppPage } from "./web.js";
import { SyncScheduler } from "./scheduler.js";

ensureAppDirs();

const configStore = new ConfigStore();
const userStore = new UserStore();
const stateManager = new StateManager();
const scheduler = new SyncScheduler(configStore, userStore, stateManager);

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
    enabled: user.enabled,
    lastLoginAt: user.lastLoginAt,
  }));
  res.json({ success: true, data: users });
});

app.post("/api/users/login/start", requireAuth, async (req, res) => {
  const loginId = crypto.randomUUID();
  const login = new WebQrcodeLogin();
  const url = await login.login();
  const qrDataUrl = await QRCode.toDataURL(url);

  loginSessions.set(loginId, { status: "pending", qrDataUrl });

  login.on("completed", async (result: any) => {
    try {
      const cookie = result as { SESSDATA: string; bili_jct: string; DedeUserID: string };
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
    } catch (error) {
      loginSessions.set(loginId, { status: "error", qrDataUrl, message: "Failed to save user" });
    }
  });

  login.on("error", (error: any) => {
    loginSessions.set(loginId, { status: "error", qrDataUrl, message: error?.message || "Login failed" });
  });

  res.json({ success: true, data: { loginId, qrDataUrl } });
});

app.get("/api/users/login/status", requireAuth, (req, res) => {
  const loginId = String(req.query.loginId || "");
  const session = loginSessions.get(loginId);
  if (!session) {
    res.status(404).json({ success: false, message: "Login session not found" });
    return;
  }
  res.json({ success: true, data: { status: session.status, message: session.message } });
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
  await scheduler.tick();
  res.json({ success: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
