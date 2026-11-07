import type { AppConfig } from './config.js';
import { parseStorageBaseUrl } from './storage-url.js';
import { isRecord } from './shared/api/value.js';

export interface RemoteFileContent { size: number; md5: string; }
export type RemoteContentReader = (remotePath: string) => Promise<RemoteFileContent | null>;

/** A recovery attempt owns its short-lived login; fresh uploads do not call this API. */
export function createRemoteContentReader(config: Pick<AppConfig, 'alistUrl' | 'alistUsername' | 'alistPassword'>,
  request: typeof fetch = fetch): RemoteContentReader {
  const base = parseStorageBaseUrl(config.alistUrl);
  const prefix = base.pathname.replace(/\/dav\/?$/i, '').replace(/\/+$/, '');
  let token: Promise<string> | undefined;
  const failure = (status: number) => Object.assign(new Error('存储文件内容校验查询失败'), { status });
  async function post(endpoint: string, body: object, authorization?: string): Promise<{ code: number; data?: unknown } | null> {
    const url = new URL(base); url.pathname = `${prefix}/api/${endpoint}`;
    let response: Response;
    try {
      response = await request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify(body) });
    } catch { throw failure(503); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([404, 405, 501].includes(response.status)) return null;
      if (endpoint === 'fs/get' && [401, 403].includes(response.status)) return { code: response.status };
      throw failure(response.status);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw failure(502); }
    if (!isRecord(value) || typeof value.code !== 'number' || !Number.isSafeInteger(value.code)) throw failure(502);
    return { code: value.code, data: value.data };
  }
  async function login() {
    const result = await post('auth/login', { username: config.alistUsername, password: config.alistPassword });
    if (!result || result.code !== 200 || !isRecord(result.data) || typeof result.data.token !== 'string' || !result.data.token) throw failure(401);
    return result.data.token;
  }
  return async remotePath => {
    let result = await post('fs/get', { path: remotePath, password: '' }, token ? await token : undefined);
    if (result && [401, 403].includes(result.code) && !token) {
      token = login();
      result = await post('fs/get', { path: remotePath, password: '' }, await token);
    }
    if (!result || [404, 405, 501].includes(result.code)) return null;
    if (result.code !== 200) throw failure(result.code >= 400 && result.code <= 599 ? result.code : 502);
    if (!isRecord(result.data)) throw failure(502);
    const data = result.data;
    if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size <= 0
      || typeof data.name !== 'string' || data.name !== remotePath.slice(remotePath.lastIndexOf('/') + 1) || data.is_dir !== false) throw failure(502);
    if (data.hash_info == null) return null;
    let hashes: unknown = data.hash_info;
    if (typeof hashes === 'string') { try { hashes = JSON.parse(hashes); } catch { throw failure(502); } }
    if (!isRecord(hashes)) throw failure(502);
    if (hashes.md5 === undefined || hashes.md5 === '') return null;
    if (typeof hashes.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(hashes.md5)) throw failure(502);
    return { size: data.size, md5: hashes.md5.toLowerCase() };
  };
}
