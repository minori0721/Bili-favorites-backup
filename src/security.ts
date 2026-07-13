import { rateLimit } from "express-rate-limit";

export interface SecurityConfiguration {
  adminPassword: string;
  sessionSecret: string;
  secureSessionCookie: boolean;
  cookieExportEnabled: boolean;
}

export function collectSecurityConfigurationWarnings(config: SecurityConfiguration) {
  const warnings: string[] = [];
  if (["admin", "please-change-admin-pass"].includes(config.adminPassword)) {
    warnings.push("管理员仍在使用默认密码，请通过 ADMIN_PASS 设置强密码。");
  }
  if (["dev-secret", "please-change-session-secret"].includes(config.sessionSecret)) {
    warnings.push("SESSION_SECRET 仍为默认值，请设置独立随机密钥。");
  }
  if (!config.secureSessionCookie) warnings.push("会话 Cookie 未启用 Secure；HTTPS 部署应设置 COOKIE_SECURE=true。");
  if (config.cookieExportEnabled) warnings.push("账号 Cookie 导出功能已启用；不需要时请设置 ALLOW_COOKIE_EXPORT=false。");
  return warnings;
}

export function createLoginRateLimiter(options: { windowMs?: number; limit?: number } = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    limit: options.limit ?? 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res, _next, limiterOptions) => {
      res.status(limiterOptions.statusCode).json({ success: false, message: "登录失败次数过多，请稍后再试。" });
    },
  });
}
