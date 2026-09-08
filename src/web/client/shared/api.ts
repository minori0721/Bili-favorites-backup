import { isRecord } from '../../../shared/api/value.js';
import { SessionExpiredError } from './session.js';
export { isRecord } from '../../../shared/api/value.js';

export class ApiError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly details: unknown, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  request(url: string, options?: RequestInit): Promise<unknown>;
  silent(url: string, options?: RequestInit): Promise<unknown>;
}

export function createApiClient(dependencies: {
  fetch: typeof fetch;
  notifyError(message: string): void;
}): ApiClient {
  const request = dependencies.fetch;
  async function silent(url: string, options?: RequestInit): Promise<unknown> {
    const response = await request(url, options);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.success !== 'boolean') {
      throw new ApiError('服务器返回数据格式错误', undefined, undefined, response.status);
    }
    if (!response.ok || !body.success) {
      throw new ApiError(typeof body.message === 'string' && body.message ? body.message : '请求失败',
        typeof body.code === 'string' ? body.code : undefined, body.data, response.status);
    }
    return body.data;
  }
  return {
    silent,
    async request(url, options) {
      try { return await silent(url, options); }
      catch (error) {
        const aborted = isRecord(error) && error.name === 'AbortError';
        if (!aborted && !(error instanceof SessionExpiredError) && !(error instanceof ApiError && error.code === 'ARCHIVE_CURSOR_STALE')) {
          dependencies.notifyError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    },
  };
}
