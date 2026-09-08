export class SessionExpiredError extends Error {
  constructor() { super('登录已失效，请重新登录'); this.name = 'SessionExpiredError'; }
}

/** One application session; expiry is terminal until a full authenticated page load. */
export function createProtectedTransport(deps: { fetch: typeof fetch; expired(): void }) {
  let expired = false;
  const lifetime = new AbortController();
  const request: typeof fetch = async (input, options) => {
    if (expired) throw new SessionExpiredError();
    const caller = options?.signal || (input instanceof Request ? input.signal : undefined);
    const signal = caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal;
    try {
      const response = await deps.fetch(input, { ...options, signal });
      if (expired) throw new SessionExpiredError();
      if (signal.aborted) throw signal.reason;
      if (response.status === 401) {
        expired = true;
        lifetime.abort(new SessionExpiredError());
        deps.expired();
        throw new SessionExpiredError();
      }
      return response;
    } catch (error) {
      if (expired) throw new SessionExpiredError();
      throw error;
    }
  };
  return { request, get expired() { return expired; } };
}

export function showSessionExpired(document: Document) {
  if (document.getElementById('sessionExpiredDialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'sessionExpiredDialog';
  dialog.className = 'session-expired-dialog';
  dialog.setAttribute('aria-labelledby', 'sessionExpiredTitle');
  const title = document.createElement('h2');
  title.id = 'sessionExpiredTitle';
  title.textContent = '登录已失效';
  const message = document.createElement('p');
  message.textContent = '请重新登录。已提交的后台任务可能仍在运行，登录后请先查看任务状态。';
  const login = document.createElement('a');
  login.href = '/login';
  login.className = 'btn btn-primary';
  login.textContent = '重新登录';
  dialog.append(title, message, login);
  dialog.addEventListener('cancel', event => event.preventDefault());
  document.body.append(dialog);
  dialog.showModal();
  login.focus();
}
