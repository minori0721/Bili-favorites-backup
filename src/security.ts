import { rateLimit } from "express-rate-limit";
import { isIP } from 'node:net';

/** Ignore forwarding headers by default; only explicitly configured peers are trusted. */
export function parseTrustedProxies(value: string | undefined): false | string[] {
  if (!value?.trim() || value.trim() === 'false') return false;
  const addresses = value.split(',').map(address => address.trim());
  for (const address of addresses) {
    const parts = address.split('/');
    const family = isIP(parts[0]);
    const prefix = parts[1];
    if (!family || parts.length > 2 || (prefix !== undefined
      && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUST_PROXY 必须为空、false，或逗号分隔的代理 IP/CIDR；不接受 true、跳数或信任全部地址。');
    }
  }
  return [...new Set(addresses)];
}

export function describeProxyTrust(trustedProxies: false | readonly string[], secureCookie: boolean): string {
  const mode = trustedProxies === false
    ? 'TRUST_PROXY 未启用：按直连处理，不接受代理转发的 IP 和协议；HTTPS 反代需配置 BFB 实际看到的代理来源 IP/CIDR。'
    : `TRUST_PROXY 已启用（${trustedProxies.length} 项）：代理须覆盖转发的 IP、域名和协议，BFB 端口应只向代理开放。`;
  return `${mode} 域名无需单独填写；Docker 下代理来源可能是桥接网关。COOKIE_SECURE=${secureCookie}；仅 HTTPS 访问使用 true。`;
}

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
