import express, { Router, type RequestHandler } from 'express';
import session from 'express-session';
import { ADMIN_REMEMBER_TTL_MS, ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_TTL_MS, buildAdminAuthFingerprint } from '../admin-session.js';

declare module "express-session" {
  interface SessionData {
    user?: { name: string };
    authFingerprint?: string;
    absoluteExpiresAt?: number;
    remember?: boolean;
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
interface AuthenticationOptions {
  secret: string;
  username: string;
  password: string;
  secure: boolean;
  store: session.Store;
  rateLimit: RequestHandler;
  now(): number;
}

export { requireAuth, requireSameOrigin };

export function createAuthentication(options: AuthenticationOptions) {
  const sessionCookieOptions = {httpOnly: true, sameSite: 'lax' as const, secure: options.secure, path: '/'};
  const adminAuthFingerprint = buildAdminAuthFingerprint(options.secret, options.username, options.password);
  const login = Router();
login.post("/api/login", requireSameOrigin, options.rateLimit, (req, res) => {
  const body: unknown = req.body;
  const fields = body !== null && typeof body === 'object' ? body : {};
  const username = 'username' in fields ? fields.username : undefined;
  const password = 'password' in fields ? fields.password : undefined;
  const remember = 'remember' in fields ? fields.remember : undefined;
  if (username === options.username && password === options.password) {
    req.session.regenerate((error) => {
      if (error) {
        res.status(500).json({ success: false, message: "Failed to create session" });
        return;
      }
      const keepSignedIn = remember === true;
      const sessionTtlMs = keepSignedIn ? ADMIN_REMEMBER_TTL_MS : ADMIN_SESSION_TTL_MS;
      req.session.user = { name: username };
      req.session.authFingerprint = adminAuthFingerprint;
      req.session.absoluteExpiresAt = options.now() + sessionTtlMs;
      req.session.remember = keepSignedIn;
      if (keepSignedIn) req.session.cookie.maxAge = ADMIN_REMEMBER_TTL_MS;
      req.session.save((saveError) => {
        if (saveError) {
          res.status(500).json({ success: false, message: "Failed to save session" });
          return;
        }
        res.json({ success: true });
      });
    });
    return;
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

  const logout = Router();
logout.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, sessionCookieOptions);
    if (error) {
      res.status(500).json({ success: false, message: "Failed to destroy session" });
      return;
    }
    res.json({ success: true });
  });
});

  return {
    session: session({name: ADMIN_SESSION_COOKIE_NAME, secret: options.secret, store: options.store,
      resave: false, saveUninitialized: false, rolling: false, cookie: sessionCookieOptions}),
    login, logout,
  };
}
