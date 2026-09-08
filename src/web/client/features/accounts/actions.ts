import type { ApiClient } from '../../shared/api.js';
import { isRecord } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';

export function createAccountActions(dependencies: {
  root: HTMLElement; api: ApiClient; confirm: ConfirmAction;
  favorites(id: string, trigger: HTMLElement): Promise<void>;
  detail(id: string, mediaId: number, title: string): Promise<void>;
  unavailable(id: string): Promise<void>;
  remove(id: string, name: string, trigger: HTMLElement): void;
  reload(): Promise<void>;
  copy(value: string): Promise<boolean>;
  notify(message: string, type?: string): void;
}) {
  let generation = 0;
  let initialized = false;
  const requests = new Map<string, AbortController>();
  async function act(event: Event) {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!(button instanceof HTMLButtonElement) || !dependencies.root.contains(button)) return;
    const id = button.dataset.id, action = button.dataset.action;
    if (!id || !action) return;
    const key = id + ':' + action;
    if (requests.has(key)) return;
    const controller = new AbortController();
    const current = generation;
    const alive = () => current === generation && !controller.signal.aborted;
    requests.set(key,controller);
    const disabled = button.disabled;
    button.disabled = true;
    button.setAttribute('aria-busy','true');
    const request = (suffix: string, options: RequestInit) => dependencies.api.silent('/api/users/' + encodeURIComponent(id) + suffix, {...options,signal:controller.signal});
    try {
      if (action === 'favorites') await dependencies.favorites(id,button);
      else if (action === 'favorite_detail' && button.dataset.mediaId) await dependencies.detail(id, Number(button.dataset.mediaId), button.dataset.title || '收藏夹详情');
      else if (action === 'unavailable') await dependencies.unavailable(id);
      else if (action === 'remove') dependencies.remove(id,button.dataset.name || id,button);
      else if (action === 'toggle') {
        await request('', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:button.dataset.enabled !== 'true'})});
        if (alive()) await dependencies.reload();
      } else if (action === 'refresh_info' || action === 'refresh_auth') {
        await request(action === 'refresh_info' ? '/refresh-info' : '/refresh-auth', {method:'POST'});
        if (!alive()) return;
        dependencies.notify(action === 'refresh_info' ? '账号信息已刷新' : '授权已更新','success');
        await dependencies.reload();
      } else if (action === 'copy_cookie') {
        const confirmed = await dependencies.confirm({title:'导出 Cookie',message:'Cookie 等同于 B 站登录凭据。',
          detail:'导出后请只在可信环境使用，不要发送给不可信的人或服务。',requiredText:'EXPORT_COOKIE',
          inputLabel:'输入 EXPORT_COOKIE 确认导出',confirmText:'导出 Cookie',trigger:button});
        if (!confirmed || !alive()) return;
        const response = await request('/cookie/export', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'EXPORT_COOKIE'})});
        if (!alive()) return;
        if (!isRecord(response) || typeof response.cookie !== 'string') throw new Error('Cookie 导出响应格式错误');
        const copied = await dependencies.copy(response.cookie);
        if (!alive()) return;
        dependencies.notify(copied ? 'Cookie 已复制' : 'Cookie 导出成功，但浏览器阻止了自动复制',copied ? 'success' : 'info');
      }
    } catch(error) {
      if (alive() && !(error instanceof Error && error.name === 'AbortError')) dependencies.notify(error instanceof Error ? error.message : String(error),'error');
    } finally {
      if (requests.get(key) === controller) {
        requests.delete(key);
        button.disabled = disabled;
        button.removeAttribute('aria-busy');
      }
    }
  }
  const onClick = (event: Event) => { void act(event); };
  return {
    init() {if(initialized)return;initialized=true;dependencies.root.addEventListener('click',onClick);},
    destroy() {
      initialized=false;generation+=1;
      dependencies.root.removeEventListener('click',onClick);
      for (const request of requests.values()) request.abort();
      requests.clear();
      for (const button of dependencies.root.querySelectorAll<HTMLButtonElement>('button[aria-busy="true"]')) {button.disabled=false;button.removeAttribute('aria-busy');}
    },
  };
}
