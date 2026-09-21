import type { ApiClient } from './api.js';
import { requireElement } from './dom.js';

/** Page-level controls share the page lifecycle and cannot outlive a suspended page. */
export function createShell(options: {
  root: Document;
  api: ApiClient;
  closeHelp(id: string): void;
  escape(): boolean;
  loggedOut(): void;
}) {
  let lifetime: AbortController | null = null;
  let loggingOut = false;
  const logout = requireElement(options.root, '#logoutBtn', HTMLButtonElement);
  return {
    init() {
      if (lifetime) return;
      const controller = new AbortController();
      lifetime = controller;
      const { signal } = controller;
      for (const [button, modal] of [['closeSyncHelpBtn', 'syncHelpModal'], ['closeSettingsHelpBtn', 'settingsHelpModal']]) {
        requireElement(options.root, '#' + button, HTMLButtonElement).addEventListener('click', () => options.closeHelp(modal), { signal });
      }
      options.root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && options.escape()) event.preventDefault();
      }, { signal });
      logout.addEventListener('click', async () => {
        if (loggingOut) return;
        loggingOut = true;
        logout.disabled = true;
        try {
          await options.api.request('/api/logout', { method: 'POST', signal });
          if (!signal.aborted && lifetime === controller) options.loggedOut();
        } catch (error) { console.debug('[Shell] logout request failed; keeping the current page usable', error); }
        finally {
          if (lifetime === controller) { loggingOut = false; logout.disabled = false; }
        }
      }, { signal });
    },
    destroy() {
      lifetime?.abort();
      lifetime = null;
      loggingOut = false;
      logout.disabled = false;
    },
  };
}
