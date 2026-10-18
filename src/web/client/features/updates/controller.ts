import { requireElement } from '../../shared/dom.js';
import { decodeUpdatesResponse, type ReleaseNotes, type UpdateChannel, type UpdatesResponse } from '../../../../shared/api/updates.js';

type UpdatesDependencies = {
  root: ParentNode;
  request: typeof fetch;
  openModal: (id: string, trigger: HTMLElement) => unknown;
  closeModal: (id: string) => unknown;
  notify: (message: string) => void;
};

export function createUpdatesController(dependencies: UpdatesDependencies) {
  const { root, request, openModal, closeModal, notify } = dependencies;
  const button = requireElement(root, '#checkUpdatesBtn', HTMLButtonElement);
  const opener = requireElement(root, '#versionInfoBtn', HTMLButtonElement);
  const badge = requireElement(root, '#updateAvailableBtn', HTMLButtonElement);
  const closer = requireElement(root, '#closeUpdatesBtn', HTMLButtonElement);
  const status = requireElement(root, '#updatesStatus', HTMLElement);
  const currentTab = requireElement(root, '#updatesCurrentTab', HTMLButtonElement);
  const latestTab = requireElement(root, '#updatesLatestTab', HTMLButtonElement);
  const select = requireElement(root, '#updatesChannel', HTMLSelectElement);
  const modal = requireElement(root, '#updatesModal', HTMLElement);
  const document = button.ownerDocument;
  const window = document.defaultView;
  if (!window) throw new Error('Updates require a browser document');
  const notified = new Set<string>();
  let active: AbortController | null = null;
  let listeners: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshAfter = 0;
  let autoDue = 0;
  let snapshot: UpdatesResponse | null = null;
  let view: 'current' | 'latest' = 'current';
  let selected: UpdateChannel = 'stable';
  let failure: string | null = null;

  function clearCountdown() { if (timer !== null) clearInterval(timer); timer = null; }
  function updateButton() {
    const seconds = Math.max(0, Math.ceil((refreshAfter - Date.now()) / 1000));
    button.disabled = Boolean(active) || seconds > 0;
    button.textContent = active ? '正在检查…' : seconds > 0 ? seconds + '秒后可重新检查' : '检查更新';
    if (!seconds) clearCountdown();
  }
  function countdown() {
    clearCountdown();
    if (refreshAfter > Date.now() && !document.hidden && modal.classList.contains('active')) timer = setInterval(updateButton, 1000);
    updateButton();
  }
  function announce() {
    const notice = snapshot?.notification;
    if (!notice || !listeners || document.hidden || !document.hasFocus() || notified.has(notice.id)) return;
    const key = 'bfb:update-seen:v1:' + notice.channel;
    try {
      if (window!.localStorage.getItem(key) === notice.id) { notified.add(notice.id); return; }
      window!.localStorage.setItem(key, notice.id);
    } catch (error) { console.debug('[Update] Reminder storage unavailable', error instanceof Error ? error.name : 'storage'); }
    notified.add(notice.id);
    notify(notice.label + '，点击版本旁的提示查看说明。');
  }
  function schedule() {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null;
    if (!listeners || document.hidden) return;
    autoTimer = setTimeout(() => { autoTimer = null; void load(); }, Math.max(1000, autoDue - Date.now()));
  }
  function label(release: ReleaseNotes | null) {
    return release ? release.version + (release.channel === 'dev' && release.revision ? ' · ' + release.revision.slice(0, 7) : '') : '暂无发布记录';
  }
  function render() {
    if (!snapshot) return;
    const data = snapshot;
    const channel = selected === 'dev' ? data.channels.dev : data.channels.stable;
    const release = view === 'current' ? data.currentRelease : channel?.release || null;
    requireElement(root, '#updatesRunning', HTMLElement).textContent = data.current.versionLabel;
    requireElement(root, '#updatesRevision', HTMLElement).textContent = data.current.revision || '未提供';
    requireElement(root, '#updatesLatestVersion', HTMLElement).textContent = label(channel?.release || null);
    requireElement(root, '#updatesChannelRow', HTMLElement).hidden = data.channel !== 'dev';
    select.value = selected;
    currentTab.setAttribute('aria-selected', String(view === 'current'));
    latestTab.setAttribute('aria-selected', String(view === 'latest'));
    currentTab.tabIndex = view === 'current' ? 0 : -1;
    latestTab.tabIndex = view === 'latest' ? 0 : -1;
    requireElement(root, '#updatesNotesPanel', HTMLElement).setAttribute('aria-labelledby', view === 'current' ? currentTab.id : latestTab.id);
    const channelName = selected === 'dev' ? '开发版' : '正式版';
    const comparisons = {
      update_available: '有新的' + channelName + '可用', up_to_date: '已是最新' + channelName,
      ahead: '当前构建领先于已发布的' + channelName, reference: '当前构建仅供版本参考', unknown: '暂时无法确认更新状态',
    };
    let message = channel?.error || (!channel?.release ? '暂无已发布的' + channelName : comparisons[channel.comparison]);
    if (data.channel === 'dev' && selected === 'stable' && !channel?.error && channel?.release) {
      message = channel.comparison === 'update_available' ? '正式版已发布，可在宝塔中切换镜像标签。更新 dev 镜像不会自动切换为正式版。'
        : '当前开发构建领先于此正式版；这里可查看正式版说明。';
    }
    status.textContent = failure || message;
    requireElement(root, '#updatesTime', HTMLElement).textContent = channel?.checkedAt
      ? '上次成功检查：' + new Date(channel.checkedAt).toLocaleString() + (channel.error ? '（缓存结果）' : '') : '';
    requireElement(root, '#updatesReleaseTitle', HTMLElement).textContent = view === 'current'
      ? '当前版本 · ' + data.current.versionLabel : label(release);
    requireElement(root, '#updatesReleaseDate', HTMLElement).textContent = release?.publishedAt
      ? '发布于 ' + new Date(release.publishedAt).toLocaleString() : '';
    const notes = requireElement(root, '#updatesNotes', HTMLElement);
    if (release?.notesHtml) notes.innerHTML = release.notesHtml;
    else notes.textContent = release ? release.notes || '该版本未填写发布说明，可查看对应版本记录。'
      : view === 'current' ? '此构建未附带版本说明，可通过构建提交查看对应记录。' : '暂无发布说明。';
    requireElement(root, '#updatesTruncated', HTMLElement).hidden = !release?.truncated;
    const revisionRef = data.current.revision || data.current.buildRef;
    requireElement(root, '#updatesChangelogLink', HTMLAnchorElement).href = release?.changelogUrl
      || 'https://github.com/minori0721/Bili-favorites-backup/blob/' + encodeURIComponent(revisionRef) + '/CHANGELOG.md';
    const releaseLink = requireElement(root, '#updatesReleaseLink', HTMLAnchorElement);
    releaseLink.href = release?.url || data.releasesUrl;
    releaseLink.textContent = view === 'current' && data.channel !== 'stable' ? '查看当前构建 ↗' : '前往发布页面 ↗';
    badge.hidden = !data.notification;
    if (data.notification) {
      requireElement(root, '#updateAvailableText', HTMLElement).textContent = data.notification.label;
      badge.title = data.notification.label;
      badge.setAttribute('aria-label', data.notification.label + '，查看发布说明');
      badge.dataset.kind = data.notification.kind;
    }
  }
  async function load(refresh = false, foreground = false) {
    if (!listeners || active || (refresh && Date.now() < refreshAfter)) return;
    const controller = new AbortController();
    active = controller;
    updateButton();
    if (foreground) status.textContent = '正在检查更新…';
    try {
      const response = await request('/api/updates' + (refresh ? '?refresh=1' : ''), { signal: controller.signal });
      if (!response.ok) throw new Error('request');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true || !('data' in result)) throw new Error('response');
      const data = decodeUpdatesResponse(result.data);
      if (active !== controller || !listeners) return;
      const first = snapshot === null;
      snapshot = data;
      failure = null;
      refreshAfter = Date.parse(data.nextRefreshAt) || 0;
      autoDue = Date.parse(data.checkAfter) || Date.now() + 60000;
      if (first) {
        selected = data.channel === 'dev' ? data.notification?.channel || 'dev' : 'stable';
        view = data.notification ? 'latest' : 'current';
      }
      render();
      announce();
    } catch {
      if (!controller.signal.aborted && active === controller) {
        failure = '暂时无法连接更新源，请稍后重试';
        status.textContent = failure;
        autoDue = Date.now() + 60000;
      }
    } finally {
      if (active === controller) {
        active = null;
        countdown();
        schedule();
      }
    }
  }
  function show(trigger: HTMLElement, preferUpdate = false) {
    if (preferUpdate && snapshot?.notification) { selected = snapshot.notification.channel; view = 'latest'; }
    render();
    openModal('updatesModal', trigger);
    countdown();
    if (active) status.textContent = '正在检查更新…';
    if (!snapshot || Date.now() >= autoDue) void load(false, true);
  }
  function deactivate() {
    active?.abort(); active = null; clearCountdown();
    if (!snapshot) autoDue = Date.now() + 60000;
    schedule();
  }
  return {
    init() {
      if (listeners) return;
      listeners = new AbortController();
      const options = { signal: listeners.signal };
      opener.addEventListener('click', () => show(opener), options);
      badge.addEventListener('click', () => show(badge, true), options);
      button.addEventListener('click', () => { void load(true, true); }, options);
      closer.addEventListener('click', () => { closeModal('updatesModal'); }, options);
      for (const [tab, name] of [[currentTab, 'current'], [latestTab, 'latest']] as const) {
        tab.addEventListener('click', () => { view = name; render(); }, options);
        tab.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          view = event.key === 'Home' ? 'latest' : event.key === 'End' ? 'current' : view === 'current' ? 'latest' : 'current';
          render(); (view === 'current' ? currentTab : latestTab).focus();
        }, options);
      }
      select.addEventListener('change', () => { selected = select.value === 'dev' ? 'dev' : 'stable'; view = 'latest'; render(); }, options);
      document.addEventListener('visibilitychange', () => {
        countdown();
        if (!document.hidden && Date.now() >= autoDue) void load(); else schedule();
        announce();
      }, options);
      window!.addEventListener('focus', announce, options);
      void load();
    },
    deactivate,
    destroy() {
      listeners?.abort(); listeners = null;
      deactivate();
      if (autoTimer !== null) clearTimeout(autoTimer);
      autoTimer = null;
    },
  };
}
