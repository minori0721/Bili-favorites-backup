import { buildAuthHealth, formatExpiresText } from './account-auth-projection.js';
import { sanitizeDiagnosticText } from './diagnostics.js';
import type { getUserInfo } from './bili.js';
import type { UserStore } from './users.js';
import type { logManager } from './logger.js';
export function createAccountService(deps: {
  users: Pick<UserStore, 'list' | 'getById' | 'updatePartial'>;
  info: typeof getUserInfo;
  refresh(id: string): Promise<void>;
  cookieExportEnabled: boolean;
  log: typeof logManager.push;
  wake(id: string): void;
  now(): number;
}) {
function list() {
  const users = deps.users.list().map((user) => ({
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
    lastAuthRefreshError: sanitizeDiagnosticText(user.lastAuthRefreshError || "", 500),
    authHealth: buildAuthHealth(user),
  }));
  return {status: 200, body: { success: true, data: users }};
}
async function refreshInfo(id: string) {
  const user = deps.users.getById(id);
  if (!user) {
    return {status: 404, body: { success: false, message: "User not found" }};
  }
  const info = await deps.info(user.cookie);
  deps.users.updatePartial(user.id, {
    name: info.name,
    avatar: info.avatar,
  });
  return {status: 200, body: { success: true, data: { name: info.name, avatar: info.avatar } }};
}
async function refreshAuth(id: string) {
  const user = deps.users.getById(id);
  if (!user) {
    return {status: 404, body: { success: false, message: "User not found" }};
  }
  await deps.refresh(user.id);
  const updated = deps.users.getById(user.id);
  return {status: 200, body: {
    success: true,
    data: {
      expires: updated?.expires || 0,
      expiresText: formatExpiresText(updated?.expires),
      lastAuthRefreshAt: updated?.lastAuthRefreshAt || "",
      lastAuthRefreshError: sanitizeDiagnosticText(updated?.lastAuthRefreshError || "", 500),
      authHealth: updated ? buildAuthHealth(updated) : null,
    },
  }};
}
function exportCookie(id: string, confirmation: unknown) {
  if (!deps.cookieExportEnabled) {
    return {status: 403, body: { success: false, message: "Cookie export is disabled" }};
  }
  if (confirmation !== "EXPORT_COOKIE") {
    return {status: 400, body: { success: false, message: "Cookie export confirmation required" }};
  }
  const user = deps.users.getById(id);
  if (!user) {
    return {status: 404, body: { success: false, message: "User not found" }};
  }
  const entries = Object.entries(user.cookie || {}).filter(([key, value]) => {
    if (key === "accessToken" || key === "refreshToken") return false;
    return value !== undefined && value !== null && String(value).length > 0;
  });
  const cookie = entries.map(([key, value]) => `${key}=${value}`).join("; ");
  deps.log({
    timestamp: new Date(deps.now()).toISOString(),
    type: "system",
    level: "warn",
    summary: `Cookie 已导出: ${user.name}`,
    raw: `[Security] Cookie exported for user ${user.id}`,
    simpleVisible: true,
  });
  return {status: 200, body: { success: true, data: { cookie } }};
}
function update(id: string, body: {enabled?: unknown; toggle?: unknown}) {
  const user = deps.users.getById(id);
  if (!user) {
    return {status: 404, body: { success: false, message: "User not found" }};
  }
  const requestedEnabled = typeof body.enabled === "boolean"
    ? body.enabled
    : body.toggle
      ? !user.enabled
      : null;
  if (requestedEnabled !== null) {
    const updated = deps.users.updatePartial(user.id, { enabled: requestedEnabled });
    if (updated?.enabled) deps.wake(user.id);
    return {status: 200, body: { success: true, data: updated }};
  }
  return {status: 200, body: { success: true, data: user }};
}
return {list, refreshInfo, refreshAuth, exportCookie, update};
}
