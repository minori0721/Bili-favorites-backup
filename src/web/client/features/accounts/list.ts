import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parsePublicAccounts } from '../../../../shared/api/accounts.js';
import { renderAccountList } from './list-view.js';

export function createAccountList(dependencies: {
  root: Document;
  api: ApiClient;
  formatDateTime(value: string): string;
  status(message: string, type: string, retry?: () => void): void;
}) {
  const host = requireElement(dependencies.root, '#userList', HTMLElement);
  let controller: AbortController | null = null;
  let generation = 0;
  let loaded = false;
  let disposed = false;
  async function load() {
    if (disposed) return;
    controller?.abort();
    const request = new AbortController();
    const current = ++generation;
    controller = request;
    if (!loaded) dependencies.status('正在读取账号...', 'muted');
    try {
      const accounts = parsePublicAccounts(await dependencies.api.silent('/api/users', {signal:request.signal}));
      if (generation !== current) return;
      renderAccountList(dependencies.root, host, accounts, dependencies.formatDateTime);
      loaded = true;
      dependencies.status(accounts.length ? '' : '暂无账号，请先添加 B站账号。', accounts.length ? '' : 'muted');
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || current !== generation) return;
      const prefix = loaded ? '账号刷新失败，已保留当前列表：' : '账号加载失败：';
      dependencies.status(prefix + (error instanceof Error ? error.message : String(error)), 'error', () => { void load(); });
    } finally { if (controller === request) controller = null; }
  }
  return {load, init() {disposed=false;}, destroy() {disposed=true;generation+=1;controller?.abort();controller=null;}};
}
