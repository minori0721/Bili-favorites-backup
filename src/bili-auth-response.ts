import type { NormalizedTvAuth } from './bili.js';
import type { BiliCookie } from './users.js';

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`B站登录响应字段无效: ${field}`);
  return Object.fromEntries(Object.entries(value));
}
function token(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`B站登录响应字段无效: ${field}`);
  return value;
}
export function normalizeTvAuthResult(result: unknown): NormalizedTvAuth {
  const envelope = record(result, 'response');
  const rawData = 'data' in envelope ? record(envelope.data, 'data') : envelope;
  const tokenInfo = rawData.token_info === undefined ? {} : record(rawData.token_info, 'token_info');
  const merged = {...rawData, ...tokenInfo};
  const cookieInfo = record(merged.cookie_info, 'cookie_info');
  if (!Array.isArray(cookieInfo.cookies)) throw new Error('B站登录响应字段无效: cookies');
  const cookie: BiliCookie = {SESSDATA: '', bili_jct: '', DedeUserID: ''};
  const names = new Set<string>();
  let expires = 0;
  for (const value of cookieInfo.cookies) {
    const item = record(value, 'cookie');
    if (typeof item.name !== 'string' || !item.name || names.has(item.name)
      || (typeof item.value !== 'string' && typeof item.value !== 'number')) throw new Error('B站登录 Cookie 字段无效或重复');
    names.add(item.name);
    cookie[item.name] = item.value;
    if (item.name === 'SESSDATA' && item.expires !== undefined) {
      const seconds = typeof item.expires === 'number' || typeof item.expires === 'string' ? Number(item.expires) : NaN;
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('B站登录 Cookie 过期时间无效');
      expires = seconds * 1000;
    }
  }
  const accessToken = token(merged.access_token, 'access_token');
  const refreshToken = token(merged.refresh_token, 'refresh_token');
  if (accessToken) cookie.accessToken = accessToken;
  const uidValue = merged.mid ?? cookie.DedeUserID;
  const uid = typeof uidValue === 'number' || typeof uidValue === 'string' ? Number(uidValue) : NaN;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !cookie.SESSDATA || !cookie.bili_jct) throw new Error('B站登录响应缺少有效账号或 Cookie');
  return {rawAuth: JSON.stringify(rawData), cookie, accessToken, refreshToken, expires, uid};
}
