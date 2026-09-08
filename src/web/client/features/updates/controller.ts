import { requireElement } from '../../shared/dom.js';

type UpdatesDependencies = {
  root: ParentNode;
  request: typeof fetch;
  openModal: (id: string, trigger: HTMLElement) => unknown;
  closeModal: (id: string) => unknown;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const releasesUrl = 'https://github.com/minori0721/Bili-favorites-backup/releases';

export function createUpdatesController(dependencies: UpdatesDependencies) {
  const {root, request, openModal, closeModal} = dependencies;
  const button = requireElement(root, '#checkUpdatesBtn', HTMLButtonElement);
  const opener = requireElement(root, '#versionInfoBtn', HTMLButtonElement);
  const closer = requireElement(root, '#closeUpdatesBtn', HTMLButtonElement);
  const status = requireElement(root, '#updatesStatus', HTMLElement);
  let active: AbortController | null = null;
  let refreshAfter = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let listeners: AbortController | null = null;

  function clearTimer() { if (timer !== null) clearInterval(timer); timer = null; }
  function updateButton() {
    const seconds = Math.max(0, Math.ceil((refreshAfter - Date.now()) / 1000));
    button.disabled = Boolean(active) || seconds > 0;
    button.textContent = active ? '正在检查…' : seconds > 0 ? seconds + '秒后可重新检查' : '检查更新';
    if (!seconds) clearTimer();
  }
  async function load(refresh = false) {
    if (!listeners || active || (refresh && Date.now() < refreshAfter)) return;
    const controller = new AbortController();
    active = controller;
    button.disabled = true;
    status.textContent = '正在检查更新…';
    try {
      const response = await request('/api/updates' + (refresh ? '?refresh=1' : ''), {signal:controller.signal});
      if (!response.ok) throw new Error('request');
      const result = record(await response.json());
      if (result.success !== true || !result.data || typeof result.data !== 'object') throw new Error('response');
      if (active !== controller) return;
      const data = record(result.data);
      const release = data.release ? record(data.release) : null;
      const next = Date.parse(text(data.nextRefreshAt));
      refreshAfter = Number.isFinite(next) ? next : 0;
      const comparisons: Record<string,string> = {
        update_available:'有新的正式版本可用', up_to_date:'当前已是最新正式版', ahead:'当前版本高于最新正式版',
        reference:'当前为开发或本地构建，以下正式版仅供参考，不代表 dev 镜像有更新',
      };
      status.textContent = text(data.error) || (!release ? '暂时没有正式发布版本' : comparisons[text(data.comparison)] || '无法判断版本');
      requireElement(root, '#updatesTime', HTMLElement).textContent = data.checkedAt
        ? '上次成功检查：' + new Date(text(data.checkedAt)).toLocaleString() + (data.error ? '（缓存结果）' : '') : '';
      requireElement(root, '#updatesReleaseTitle', HTMLElement).textContent = release
        ? text(release.version) + ' · ' + new Date(text(release.publishedAt)).toLocaleDateString() : '正式版发布说明';
      const notes = requireElement(root, '#updatesNotes', HTMLElement);
      // Only the same-origin server's sanitized Markdown output is accepted here.
      if (text(release?.notesHtml)) notes.innerHTML = text(release?.notesHtml);
      else notes.textContent = text(release?.notes) || (release ? '该版本未填写发布说明，可查看对应版本记录。' : '暂无应用发布说明');
      requireElement(root, '#updatesTruncated', HTMLElement).hidden = !release?.truncated;
      const changelog = text(release?.changelogUrl);
      requireElement(root, '#updatesChangelogLink', HTMLAnchorElement).href = changelog.startsWith('https://github.com/minori0721/Bili-favorites-backup/blob/v') && changelog.endsWith('/CHANGELOG.md')
        ? changelog : 'https://github.com/minori0721/Bili-favorites-backup/blob/main/CHANGELOG.md';
      const url = text(release?.url) || text(data.releasesUrl);
      requireElement(root, '#updatesReleaseLink', HTMLAnchorElement).href = url.startsWith(releasesUrl) ? url : releasesUrl;
    } catch {
      if (!controller.signal.aborted && active === controller) status.textContent = '暂时无法连接更新源，请稍后重试';
    } finally {
      if (active === controller) {
        active = null;
        clearTimer();
        timer = refreshAfter > Date.now() ? setInterval(updateButton, 1000) : null;
        updateButton();
      }
    }
  }
  function deactivate() { active?.abort(); active = null; clearTimer(); }
  return {
    init() {
      if (listeners) return;
      listeners = new AbortController();
      const options = {signal:listeners.signal};
      opener.addEventListener('click', () => { openModal('updatesModal', opener); void load(); }, options);
      button.addEventListener('click', () => { void load(true); }, options);
      closer.addEventListener('click', () => { closeModal('updatesModal'); }, options);
    },
    deactivate,
    destroy() { deactivate(); listeners?.abort(); listeners = null; },
  };
}
