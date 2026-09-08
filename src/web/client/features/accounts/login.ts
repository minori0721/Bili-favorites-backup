import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseLoginStart, parseLoginStatus } from './login-contract.js';

interface Dependencies {
  root: Document;
  api: ApiClient;
  open(trigger: HTMLElement): void;
  close(): void;
  isActive(): boolean;
  authenticated(): void;
}

export function createAccountLogin(dependencies: Dependencies) {
  const button = requireElement(dependencies.root, '#addUserBtn', HTMLButtonElement);
  const closeButton = requireElement(dependencies.root, '#closeLoginBtn', HTMLButtonElement);
  const qr = requireElement(dependencies.root, '#loginQr', HTMLImageElement);
  const status = requireElement(dependencies.root, '#loginStatus', HTMLElement);
  let initialized = false;
  let generation = 0;
  let loginId: string | null = null;
  let startController: AbortController | null = null;
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
  const isAborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';

  function deactivate() {
    generation += 1;
    startController?.abort();
    pollController?.abort();
    clearTimeout(pollTimer);
    clearTimeout(closeTimer);
    loginId = startController = pollController = null;
    pollTimer = closeTimer = undefined;
    button.disabled = false;
  }

  async function poll(id: string, current: number) {
    if (current !== generation || loginId !== id) return;
    const controller = new AbortController();
    pollController?.abort();
    pollController = controller;
    try {
      const value = parseLoginStatus(await dependencies.api.silent('/api/users/login/status?loginId=' + encodeURIComponent(id), {signal: controller.signal}));
      if (current !== generation || loginId !== id) return;
      if (value.status === 'completed') {
        status.textContent = '登录成功';
        loginId = null;
        closeTimer = setTimeout(() => {
          closeTimer = undefined;
          if (current !== generation || !dependencies.isActive()) return;
          dependencies.close();
          dependencies.authenticated();
        }, 1000);
      } else if (value.status === 'error') {
        status.textContent = value.message || '登录异常';
        loginId = null;
      } else {
        status.textContent = '等待扫码中...';
        pollTimer = setTimeout(() => { pollTimer = undefined; void poll(id, current); }, 1500);
      }
    } catch (error) {
      if (!isAborted(error) && current === generation && loginId === id) {
        status.textContent = errorMessage(error);
        loginId = null;
      }
    } finally { if (pollController === controller) pollController = null; }
  }

  async function start() {
    if (!initialized || startController) return;
    deactivate();
    const current = generation;
    const controller = new AbortController();
    startController = controller;
    button.disabled = true;
    qr.removeAttribute('src');
    status.textContent = '正在生成二维码...';
    dependencies.open(button);
    try {
      const value = parseLoginStart(await dependencies.api.silent('/api/users/login/start', {method:'POST', signal:controller.signal}));
      if (current !== generation || !dependencies.isActive()) return;
      loginId = value.loginId;
      qr.src = value.qrDataUrl;
      void poll(loginId, current);
    } catch (error) {
      if (!isAborted(error) && current === generation) status.textContent = '二维码生成失败：' + errorMessage(error);
    } finally {
      if (startController === controller) { startController = null; button.disabled = false; }
    }
  }
  const onStart = () => { void start(); };
  const onClose = () => dependencies.close();
  return {
    deactivate,
    init() {
      if (initialized) return;
      initialized = true;
      button.addEventListener('click', onStart);
      closeButton.addEventListener('click', onClose);
    },
    destroy() {
      initialized = false;
      deactivate();
      button.removeEventListener('click', onStart);
      closeButton.removeEventListener('click', onClose);
    },
  };
}
