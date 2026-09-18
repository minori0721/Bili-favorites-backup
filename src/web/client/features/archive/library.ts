import { repreviewArchiveDeletion } from '../../shared/archive-deletion-actions.js';
import { parseArchiveLibraryDetail, parseArchiveLibraryPage, parseArchiveNavigation, parseArchiveDeletion, parseArchiveDeletionPreview, parseLocalReleasePreview } from '../../../../shared/api/archive-library.js';
import { isRecord } from '../../../../shared/api/value.js';
import { ApiError, type ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { requireElement } from '../../shared/dom.js';
import { archiveDeletionProgressText } from '../../shared/archive-deletion.js';
import { archiveStatusLabel, sourceAvailabilityReasonLabel } from './status.js';
type Navigation = ReturnType<typeof parseArchiveNavigation>;
type Summary = Navigation['summary'];
type ArchiveItem = ReturnType<typeof parseArchiveLibraryDetail>;
type Membership = ArchiveItem['memberships'][number];
type Deletion = ReturnType<typeof parseArchiveDeletion>;
import type { ArchiveContext } from '../../../../shared/api/archive-context.js';
interface Directory {scope: string; userId?: string | null; mediaId?: number | null; title: string}
interface Preference {version: number; scope: string; userId: string | null; mediaId: number | null; filter: string; sort: string; scrollPositions: Record<string, number>}
interface ArchiveState extends ArchiveContext {
  navigation: Navigation | null; draftQuery: string; items: ArchiveItem[]; nodes: Map<string, HTMLElement>; nextCursor: string | null;
  hasMore: boolean; summary: Summary | null; loading: boolean; error: string | null; token: number; sessionToken: number; controller: AbortController | null;
  searchTimer: ReturnType<typeof setTimeout> | null; scrollTimer: ReturnType<typeof setTimeout> | null; navigationTimer: ReturnType<typeof setTimeout> | null;
  detailController: AbortController | null; detailToken: number; detailTrigger: HTMLElement | null; detailBvid: string | null;
  navigationToken: number; navigationController: AbortController | null; pendingReset: boolean;
  appliedContext: ArchiveContext | null; pendingContext: ArchiveContext | null;
  pendingViewState: {nextCursor: string | null; hasMore: boolean; summary: Summary | null; error: string | null} | null;
  scrollPositions: Record<string,number>; trigger: HTMLElement | null; pageSize?: number;
}
interface Options {
  root: Document; api: ApiClient; confirmAction: ConfirmAction; layout: MediaQueryList;
  formatBytes(value: number): string; formatDateTime(value: string | number): string;
  openModal(id: string, trigger?: HTMLElement | null): void; closeModal(id: string, options?: {restoreFocus?: boolean}): unknown;
  showToast(message: string, kind?: 'success' | 'error'): void;
  play(bvid: string, trigger: HTMLElement, context: ArchiveContext): void;
}
export function createArchiveLibrary({root: document, api, confirmAction, layout: archiveLibraryLayoutMedia, formatBytes, formatDateTime, openModal, closeModal, showToast, play}: Options) {
  const requests = new Set<AbortController>();
  async function request(url: string, options: RequestInit = {}, silent = false) {
    const controller = new AbortController(); requests.add(controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try { return await (silent ? api.silent : api.request)(url, {...options, signal}); }
    finally { requests.delete(controller); }
  }
  const fetchJson = (url: string, options?: RequestInit) => request(url, options);
  const fetchJsonSilent = (url: string, options?: RequestInit) => request(url, options, true);
  const elements = {
    archiveLibraryResults: requireElement(document, '#archiveLibraryResults', HTMLElement),
    archiveLibraryModal: requireElement(document, '#archiveLibraryModal', HTMLElement),
    archiveLibrarySearchInput: requireElement(document, '#archiveLibrarySearchInput', HTMLInputElement),
    archiveLibraryDetail: requireElement(document, '#archiveLibraryDetail', HTMLElement),
    archiveLibraryNav: requireElement(document, '#archiveLibraryNav', HTMLElement),
    archiveLibraryTitle: requireElement(document, '#archiveLibraryTitle', HTMLElement),
    archiveLibrarySummary: requireElement(document, '#archiveLibrarySummary', HTMLElement),
    archiveLibrarySort: requireElement(document, '#archiveLibrarySort', HTMLSelectElement),
    archiveSearchCurrentBtn: requireElement(document, '#archiveSearchCurrentBtn', HTMLButtonElement),
    archiveSearchGlobalBtn: requireElement(document, '#archiveSearchGlobalBtn', HTMLButtonElement),
    archiveLibraryMobileBackBtn: requireElement(document, '#archiveLibraryMobileBackBtn', HTMLButtonElement),
    archiveMembershipTextPlaceholder: document.getElementById('archiveMembershipTextPlaceholder'),
    archiveLibraryFooter: requireElement(document, '#archiveLibraryFooter', HTMLElement),
    archiveLibraryGrid: requireElement(document, '#archiveLibraryGrid', HTMLElement),
    archiveLibraryDetailBody: requireElement(document, '#archiveLibraryDetailBody', HTMLElement),
    archiveLibraryDetailTitle: requireElement(document, '#archiveLibraryDetailTitle', HTMLElement),
    archiveLibraryDetailCloseBtn: requireElement(document, '#archiveLibraryDetailCloseBtn', HTMLButtonElement),
    archiveLibraryBtn: requireElement(document, '#archiveLibraryBtn', HTMLButtonElement),
    closeArchiveLibraryBtn: requireElement(document, '#closeArchiveLibraryBtn', HTMLButtonElement),
    archiveLibrarySearchClearBtn: requireElement(document, '#archiveLibrarySearchClearBtn', HTMLButtonElement),
  };
  const ARCHIVE_LIBRARY_STORAGE_KEY = 'bfb-archive-library-v1';
    const archiveLibraryState: ArchiveState = {
      navigation: null,
      scope: 'global',
      userId: null,
      mediaId: null,
      title: '全部归档',
      draftQuery: '',
      query: '',
      searchScope: 'current',
      filter: 'all',
      sort: 'context',
      items: [],
      nodes: new Map(),
      nextCursor: null,
      hasMore: true,
      summary: null,
      loading: false,
      error: null,
      token: 0,
      sessionToken: 0,
      controller: null,
      searchTimer: null,
      scrollTimer: null,
      detailController: null,
      detailToken: 0,
      detailTrigger: null,
      detailBvid: null,
      navigationTimer: null,
      navigationToken: 0,
      navigationController: null,
      pendingReset: false,
      appliedContext: null,
      pendingContext: null,
      pendingViewState: null,
      scrollPositions: {},
      trigger: null
    };

  let events: AbortController | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  function later(callback: () => void, delay: number) { const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer); }
  function frame(callback: () => void) { const id=requestAnimationFrame(()=>{frames.delete(id);callback();});frames.add(id); }
  function safeText(value: unknown, fallback='未知') { return String(value ?? '').trim() || fallback; }
  function localCoverUrl(item: {coverLocalPath?: string}) { const path=(item.coverLocalPath || '').trim();return path ? '/' + path.split('/').filter(Boolean).join('/') : ''; }
  function setHidden(id: string, hidden: boolean) { document.getElementById(id)?.classList.toggle('is-hidden', hidden); }
  function appendUniqueItems<T>(target: T[], incoming: T[], keyOf: (value:T)=>string) {
    const seen=new Set(target.map(keyOf));return incoming.filter(item=>{const key=keyOf(item);if(!key||seen.has(key))return false;seen.add(key);return true;});
  }
  function openArchiveLibraryPlayback(bvid: string, trigger: HTMLElement) { play(bvid, trigger, archiveLibraryContextSnapshot()); }
    function loadArchiveLibraryPreference(): Preference {
      const fallback: Preference = { version:1, scope:'global', userId:null, mediaId:null, filter:'all', sort:'context', scrollPositions:{} };
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(ARCHIVE_LIBRARY_STORAGE_KEY) || 'null');
        if (!isRecord(parsed) || parsed.version !== 1) return fallback;
        return {
          version:1,
          scope:typeof parsed.scope === 'string' && ['global','account','folder'].includes(parsed.scope) ? parsed.scope : 'global',
          userId:typeof parsed.userId === 'string' ? parsed.userId : null,
          mediaId:Number(parsed.mediaId || 0) || null,
          filter:typeof parsed.filter === 'string' && ['all','playable','pending','issue','deleted'].includes(parsed.filter) ? parsed.filter : 'all',
          sort:typeof parsed.sort === 'string' && ['context','title_asc','title_desc'].includes(parsed.sort) ? parsed.sort : 'context',
          scrollPositions:isRecord(parsed.scrollPositions) ? Object.fromEntries(Object.entries(parsed.scrollPositions).filter((entry): entry is [string,number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0)) : {}
        };
      } catch (_) {
        return fallback;
      }
    }

    function archiveContextKey(state: Pick<ArchiveContext, 'scope' | 'userId' | 'mediaId' | 'filter' | 'sort'> = archiveLibraryState) {
      return [state.scope, state.userId || '', state.mediaId || 0, state.filter, state.sort].join(':');
    }

    function persistArchiveLibraryPreference() {
      try {
        localStorage.setItem(ARCHIVE_LIBRARY_STORAGE_KEY, JSON.stringify({
          version:1,
          scope:archiveLibraryState.scope,
          userId:archiveLibraryState.userId,
          mediaId:archiveLibraryState.mediaId,
          filter:archiveLibraryState.filter,
          sort:archiveLibraryState.sort,
          scrollPositions:archiveLibraryState.scrollPositions
        }));
      } catch (_) {}
    }

    function saveArchiveLibraryScroll() {
      const results = elements.archiveLibraryResults;
      if (!results || archiveLibraryState.query) return;
      archiveLibraryState.scrollPositions[archiveContextKey()] = Math.max(0, Math.round(results.scrollTop));
      const entries = Object.entries(archiveLibraryState.scrollPositions).slice(-80);
      archiveLibraryState.scrollPositions = Object.fromEntries(entries);
      persistArchiveLibraryPreference();
    }

    function cleanupArchiveLibrary() {
      for (const controller of requests) controller.abort(); requests.clear();
      for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const id of frames) cancelAnimationFrame(id); frames.clear();
      saveArchiveLibraryScroll();
      archiveLibraryState.token += 1;
      archiveLibraryState.sessionToken += 1;
      if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      if (archiveLibraryState.scrollTimer) clearTimeout(archiveLibraryState.scrollTimer);
      if (archiveLibraryState.navigationTimer) clearTimeout(archiveLibraryState.navigationTimer);
      archiveLibraryState.navigationToken += 1;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      archiveLibraryState.controller = null;
      archiveLibraryState.detailController = null;
      archiveLibraryState.detailToken += 1;
      archiveLibraryState.searchTimer = null;
      archiveLibraryState.scrollTimer = null;
      archiveLibraryState.navigationTimer = null;
      archiveLibraryState.navigationController = null;
      archiveLibraryState.loading = false;
      archiveLibraryState.pendingReset = false;
      archiveLibraryState.pendingContext = null;
      archiveLibraryState.pendingViewState = null;
      setArchiveLibraryResultsBusy(false);
      closeArchiveLibraryDetail({ restoreFocus:false });
    }

    function archiveLibrarySessionCurrent(token: number) {
      return token === archiveLibraryState.sessionToken && elements.archiveLibraryModal.classList.contains('active');
    }

    async function requestArchiveLibraryNavigation(sessionToken = archiveLibraryState.sessionToken) {
      if (!archiveLibrarySessionCurrent(sessionToken)) return null;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const controller = new AbortController();
      const requestToken = ++archiveLibraryState.navigationToken;
      archiveLibraryState.navigationController = controller;
      try {
        const navigation = parseArchiveNavigation(await fetchJson('/api/archive-library/navigation', { signal:controller.signal }));
        if (!archiveLibrarySessionCurrent(sessionToken) || requestToken !== archiveLibraryState.navigationToken) return null;
        archiveLibraryState.navigation = navigation;
        return navigation;
      } finally {
        if (archiveLibraryState.navigationController === controller) archiveLibraryState.navigationController = null;
      }
    }

    function archiveLibraryQueryParams(options: {cursor?: string | null} = {}, context: ArchiveContext = archiveLibraryContextSnapshot()) {
      const params = new URLSearchParams({
        scope:context.scope,
        q:context.query,
        searchScope:context.searchScope,
        filter:context.filter,
        sort:context.sort,
        pageSize:String(archiveLibraryState.pageSize || 50)
      });
      if (context.userId) params.set('userId', context.userId);
      if (context.mediaId) params.set('mediaId', String(context.mediaId));
      if (options.cursor) params.set('cursor', options.cursor);
      return params;
    }

    function archiveLibraryContextSnapshot() {
      return {
        scope:archiveLibraryState.scope,
        userId:archiveLibraryState.userId,
        mediaId:archiveLibraryState.mediaId,
        title:archiveLibraryState.title,
        query:archiveLibraryState.query,
        searchScope:archiveLibraryState.searchScope,
        filter:archiveLibraryState.filter,
        sort:archiveLibraryState.sort
      };
    }

    function applyArchiveLibraryContext(context: ArchiveContext) {
      if (!context) return;
      archiveLibraryState.scope = context.scope;
      archiveLibraryState.userId = context.userId || null;
      archiveLibraryState.mediaId = Number(context.mediaId || 0) || null;
      archiveLibraryState.title = context.title || '全部归档';
      archiveLibraryState.query = context.query || '';
      archiveLibraryState.draftQuery = context.query || '';
      archiveLibraryState.searchScope = context.searchScope || 'current';
      archiveLibraryState.filter = context.filter || 'all';
      archiveLibraryState.sort = context.sort || 'context';
      elements.archiveLibrarySearchInput.value = archiveLibraryState.query;
      syncArchiveLibraryNavigationSelection();
      setArchiveLibraryHeading();
    }

    function setArchiveLibraryResultsBusy(busy: boolean) {
      const results = elements.archiveLibraryResults;
      if (!results) return;
      results.inert = Boolean(busy);
      if (busy) results.setAttribute('aria-busy', 'true');
      else results.removeAttribute('aria-busy');
    }

    function isArchiveLibraryMobileLayout() {
      return archiveLibraryLayoutMedia.matches;
    }

    function setArchiveLibraryLayerAvailability(element: HTMLElement | null, available: boolean) {
      if (!element) return;
      element.inert = !available;
      if (available) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', 'true');
    }

    function syncArchiveLibraryPanels() {
      const shell = document.querySelector<HTMLElement>('.archive-library-shell');
      const sidebar = document.querySelector<HTMLElement>('.archive-library-sidebar');
      const main = document.querySelector<HTMLElement>('.archive-library-main');
      const detailOpen = elements.archiveLibraryDetail?.classList.contains('open');
      if (detailOpen) {
        setArchiveLibraryLayerAvailability(sidebar, false);
        setArchiveLibraryLayerAvailability(main, false);
        return;
      }
      if (!isArchiveLibraryMobileLayout()) {
        setArchiveLibraryLayerAvailability(sidebar, true);
        setArchiveLibraryLayerAvailability(main, true);
        return;
      }
      const showContent = Boolean(shell?.classList.contains('show-content'));
      setArchiveLibraryLayerAvailability(sidebar, !showContent);
      setArchiveLibraryLayerAvailability(main, showContent);
    }

    function archiveSummaryText(summary: Summary | null) {
      if (!summary) return '正在读取本地归档';
      if (archiveLibraryState.filter === 'deleted') return Number(summary.total || 0) + ' 个删除记录';
      return Number(summary.total || 0) + ' 个视频 · 可播放 ' + Number(summary.playable || 0) +
        ' · 待处理 ' + Number(summary.pending || 0) + ' · 异常 ' + Number(summary.issue || 0);
    }

    function archiveNavMeta(entry: Partial<Summary>) {
      const sync = entry.lastSyncedAt ? ' · 最近同步 ' + formatDateTime(entry.lastSyncedAt) : '';
      if (!Number(entry.total || 0)) return '暂无本地索引' + sync;
      const remote = entry.sourceReferenceCount === undefined ? '' :
        ' · 来源引用 ' + entry.sourceReferenceCount + ' · 唯一路径 ' + entry.uniqueRemotePathCount;
      return Number(entry.total || 0) + ' 个视频 · 可播 ' + Number(entry.playable || 0) + remote + sync;
    }

    function createArchiveNavItem(entry: Partial<Summary>, context: Directory) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'archive-nav-item';
      button.title = '当前目录的本地索引统计；来源引用不含视频级副本，唯一路径不代表实时远端文件数。';
      button.dataset.archiveScope = context.scope;
      button.dataset.archiveUserId = context.userId || '';
      button.dataset.archiveMediaId = String(context.mediaId || '');
      const preview = document.createElement('span');
      preview.className = 'archive-nav-preview';
      appendArchiveCover(preview, entry);
      const copy = document.createElement('span');
      copy.className = 'archive-nav-copy';
      const title = document.createElement('span');
      title.className = 'archive-nav-title';
      title.textContent = safeText(context.title, '归档目录');
      const meta = document.createElement('span');
      meta.className = 'archive-nav-meta';
      meta.textContent = archiveNavMeta(entry);
      copy.appendChild(title);
      copy.appendChild(meta);
      const count = document.createElement('span');
      count.className = 'archive-nav-count';
      count.textContent = String(Number(entry.total || 0));
      button.appendChild(preview);
      button.appendChild(copy);
      button.appendChild(count);
      button.addEventListener('click', () => selectArchiveLibraryDirectory(context, button));
      return button;
    }

    function renderArchiveLibraryNavigation() {
      if (archiveLibraryState.navigationTimer) clearTimeout(archiveLibraryState.navigationTimer);
      archiveLibraryState.navigationTimer = null;
      const host = elements.archiveLibraryNav;
      host.replaceChildren();
      const navigation = archiveLibraryState.navigation;
      if (!navigation) {
        const loading = document.createElement('div');
        loading.className = 'archive-nav-empty';
        loading.textContent = '加载中...';
        host.appendChild(loading);
        return;
      }
      const globalGroup = document.createElement('div');
      globalGroup.className = 'archive-nav-account';
      const globalList = document.createElement('div');
      globalList.className = 'archive-nav-list';
      globalList.appendChild(createArchiveNavItem(navigation.summary || {}, { scope:'global', title:'全部归档' }));
      globalGroup.appendChild(globalList);
      host.appendChild(globalGroup);

      const activeDeletions: {id:string;userId:string}[] = [];
      (navigation.accounts || []).forEach((account) => {
        const group = document.createElement(account.removed ? 'details' : 'section');
        group.className = 'archive-nav-account' + (account.removed ? ' archive-nav-inactive' : '');
        const heading = document.createElement(account.removed ? 'summary' : 'div');
        heading.className = 'archive-nav-heading';
        const name = document.createElement('strong');
        name.textContent = safeText(account.name, '未知账号');
        const uid = document.createElement('span');
        uid.textContent = (account.removed ? '已移除 · ' : '') + 'UID ' + safeText(account.uid, '-');
        heading.appendChild(name);
        heading.appendChild(uid);
        group.appendChild(heading);
        if (account.deletion) {
          const deletion = document.createElement('div');
          deletion.className = 'archive-nav-deletion';
          deletion.appendChild(document.createTextNode(archiveDeletionProgressText(account.deletion)));
          if (account.deletion.status === 'failed') {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = '重试账号归档清理';
            retry.addEventListener('click', async () => {
              const sessionToken = archiveLibraryState.sessionToken;
              retry.disabled = true;
              try {
                await fetchJson('/api/archive-deletions/' + encodeURIComponent(account.deletion!.id) + '/retry', { method:'POST' });
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                const navigation = await requestArchiveLibraryNavigation(sessionToken);
                if (!navigation) return;
                renderArchiveLibraryNavigation();
              } catch (error) {
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                retry.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            deletion.appendChild(retry);
            const repreview = document.createElement('button');
            repreview.type = 'button';
            repreview.textContent = '重新预览并确认';
            repreview.addEventListener('click', async () => {
              const sessionToken = archiveLibraryState.sessionToken;
              repreview.disabled = true;
              try {
                const replacement = await repreviewAndStartArchiveDeletion(account.deletion!.id, repreview);
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                if (!replacement) repreview.disabled = false;
                const navigation = await requestArchiveLibraryNavigation(sessionToken);
                if (!navigation) return;
                renderArchiveLibraryNavigation();
              } catch (error) {
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                repreview.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            deletion.appendChild(repreview);
          } else if (['preparing','config_removing','pending','running','retry_wait'].includes(account.deletion.status)) {
            activeDeletions.push({ id:account.deletion!.id, userId:account.id });
          }
          group.appendChild(deletion);
        }
        const list = document.createElement('div');
        list.className = 'archive-nav-list';
        list.appendChild(createArchiveNavItem(account.summary || {}, {
          scope:'account', userId:account.id, title:'该账号全部'
        }));
        (account.folders || []).forEach((folder) => list.appendChild(createArchiveNavItem(folder, {
          scope:'folder', userId:account.id, mediaId:folder.mediaId, title:folder.title
        })));
        group.appendChild(list);
        if (Array.isArray(account.inactiveFolders) && account.inactiveFolders.length) {
          const inactive = document.createElement('details');
          inactive.className = 'archive-nav-inactive';
          const summary = document.createElement('summary');
          summary.textContent = '已停用归档 · ' + account.inactiveFolders.length;
          inactive.appendChild(summary);
          const inactiveList = document.createElement('div');
          inactiveList.className = 'archive-nav-list';
          account.inactiveFolders.forEach((folder) => inactiveList.appendChild(createArchiveNavItem(folder, {
            scope:'folder', userId:account.id, mediaId:folder.mediaId, title:folder.title + ' · 已停用'
          })));
          inactive.appendChild(inactiveList);
          group.appendChild(inactive);
        }
        host.appendChild(group);
      });
      syncArchiveLibraryNavigationSelection();
      if (activeDeletions.length && elements.archiveLibraryModal.classList.contains('active')) {
        archiveLibraryState.navigationTimer = setTimeout(
          () => pollArchiveLibraryNavigationDeletions(activeDeletions),
          1500
        );
      }
    }

    async function pollArchiveLibraryNavigationDeletions(activeDeletions: {id: string; userId: string}[]) {
      archiveLibraryState.navigationTimer = null;
      const sessionToken = archiveLibraryState.sessionToken;
      if (!archiveLibrarySessionCurrent(sessionToken)) return;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const controller = new AbortController();
      const requestToken = ++archiveLibraryState.navigationToken;
      archiveLibraryState.navigationController = controller;
      const current = () => archiveLibrarySessionCurrent(sessionToken) && requestToken === archiveLibraryState.navigationToken;
      try {
        const operations = await Promise.all(activeDeletions.map((entry) =>
          fetchJson('/api/archive-deletions/' + encodeURIComponent(entry.id), { signal:controller.signal }).then(parseArchiveDeletion)
        ));
        if (!current()) return;
        let reachedTerminal = false;
        let completed = false;
        activeDeletions.forEach((entry, index) => {
          const operation = operations[index];
          const account = (archiveLibraryState.navigation?.accounts || []).find((candidate) => candidate.id === entry.userId);
          if (!account || account.deletion?.id !== entry.id) return;
          account.deletion = operation;
          if (['completed','failed'].includes(operation.status)) reachedTerminal = true;
          if (operation.status === 'completed') completed = true;
        });
        if (reachedTerminal) {
          saveArchiveLibraryScroll();
          const navigation = await requestArchiveLibraryNavigation(sessionToken);
          if (!navigation || !archiveLibrarySessionCurrent(sessionToken)) return;
          renderArchiveLibraryNavigation();
          if (completed) await loadArchiveLibraryItems(true);
          return;
        }
        renderArchiveLibraryNavigation();
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || !current()) return;
        try {
          const navigation = await requestArchiveLibraryNavigation(sessionToken);
          if (!navigation || !archiveLibrarySessionCurrent(sessionToken)) return;
          renderArchiveLibraryNavigation();
        } catch (_) {
          if (!archiveLibrarySessionCurrent(sessionToken)) return;
          archiveLibraryState.navigationTimer = setTimeout(
            () => pollArchiveLibraryNavigationDeletions(activeDeletions),
            3000
          );
        }
      } finally {
        if (archiveLibraryState.navigationController === controller) archiveLibraryState.navigationController = null;
      }
    }

    function syncArchiveLibraryNavigationSelection() {
      document.querySelectorAll<HTMLElement>('.archive-nav-item').forEach((button) => {
        const active = button.dataset.archiveScope === archiveLibraryState.scope
          && String(button.dataset.archiveUserId || '') === String(archiveLibraryState.userId || '')
          && String(button.dataset.archiveMediaId || '') === String(archiveLibraryState.mediaId || '');
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    function archiveDirectoryExists(navigation: Navigation, scope: string, userId: string | null, mediaId: number | null) {
      if (scope === 'global') return true;
      const account = (navigation.accounts || []).find((entry) => entry.id === userId);
      if (!account) return false;
      if (scope === 'account') return true;
      return [...(account.folders || []), ...(account.inactiveFolders || [])]
        .some((folder) => Number(folder.mediaId) === Number(mediaId));
    }

    function setArchiveLibraryHeading() {
      elements.archiveLibraryTitle.textContent = archiveLibraryState.title || '全部归档';
      elements.archiveLibrarySummary.textContent = archiveSummaryText(archiveLibraryState.summary);
      elements.archiveLibrarySort.value = archiveLibraryState.sort;
      elements.archiveSearchCurrentBtn.classList.toggle('active', archiveLibraryState.searchScope === 'current');
      elements.archiveSearchGlobalBtn.classList.toggle('active', archiveLibraryState.searchScope === 'global');
      elements.archiveSearchCurrentBtn.setAttribute('aria-pressed', String(archiveLibraryState.searchScope === 'current'));
      elements.archiveSearchGlobalBtn.setAttribute('aria-pressed', String(archiveLibraryState.searchScope === 'global'));
      document.querySelectorAll<HTMLElement>('[data-archive-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.archiveFilter === archiveLibraryState.filter);
        button.setAttribute('aria-pressed', String(button.dataset.archiveFilter === archiveLibraryState.filter));
      });
      setHidden('archiveLibrarySearchClearBtn', !archiveLibraryState.draftQuery);
    }

    async function selectArchiveLibraryDirectory(context: Directory, trigger?: HTMLElement | null) {
      const shouldFocusMobileBack = Boolean(trigger && isArchiveLibraryMobileLayout());
      saveArchiveLibraryScroll();
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = null;
      archiveLibraryState.scope = context.scope;
      archiveLibraryState.userId = context.userId || null;
      archiveLibraryState.mediaId = Number(context.mediaId || 0) || null;
      archiveLibraryState.title = context.title || '全部归档';
      archiveLibraryState.draftQuery = '';
      archiveLibraryState.query = '';
      archiveLibraryState.searchScope = 'current';
      elements.archiveLibrarySearchInput.value = '';
      closeArchiveLibraryDetail({ restoreFocus:false });
      syncArchiveLibraryNavigationSelection();
      setArchiveLibraryHeading();
      document.querySelector<HTMLElement>('.archive-library-shell')?.classList.add('show-content');
      syncArchiveLibraryPanels();
      await loadArchiveLibraryItems(true);
      if (shouldFocusMobileBack && elements.archiveLibraryModal.classList.contains('active')) {
        elements.archiveLibraryMobileBackBtn.focus({ preventScroll:true });
      }
    }

    // ---- Online content workspace ----
    elements.archiveMembershipTextPlaceholder?.remove();
    function archiveMembershipText(item: ArchiveItem) {
      const labels = (item.memberships || []).map((membership) => safeText(membership.folderTitle, '收藏夹'));
      const more = Math.max(0, Number(item.membershipCount || 0) - labels.length);
      return labels.join(' · ') + (more ? ' · +' + more : '');
    }

    function appendArchiveCover(container: HTMLElement, item: {title?: string; bvid?: string; cover?: string; coverLocalPath?: string}, className?: string) {
      const local = localCoverUrl(item);
      const remote = item && item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const sources = [...new Set([local, remote].filter(Boolean))];
      const placeholder = document.createElement('span');
      placeholder.className = 'archive-library-placeholder';
      placeholder.textContent = 'B';
      placeholder.setAttribute('aria-hidden', 'true');
      container.appendChild(placeholder);
      if (!sources.length) return;
      const image = document.createElement('img');
      if (className) image.className = className;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let index = 0;
      image.addEventListener('load', () => placeholder.classList.add('is-hidden'));
      image.addEventListener('error', () => {
        index += 1;
        if (index < sources.length) image.src = sources[index];
        else image.remove();
      });
      image.src = sources[0];
      container.appendChild(image);
    }

    function createArchiveLibraryCard(item: ArchiveItem) {
      const card = document.createElement('div');
      card.className = 'archive-library-card';
      card.dataset.archiveBvid = item.bvid;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'archive-library-card-main';
      main.setAttribute('aria-label', (item.playback?.available ? '播放 ' : '查看详情 ') + safeText(item.title || item.bvid, '归档视频'));
      const cover = document.createElement('span');
      cover.className = 'archive-library-cover';
      appendArchiveCover(cover, item);
      const coverBadges = document.createElement('span');
      coverBadges.className = 'archive-library-cover-badges';
      const status = document.createElement('span');
      status.className = 'archive-library-status ' + item.statusGroup;
      status.textContent = archiveStatusLabel(item);
      coverBadges.appendChild(status);
      if (item.playback?.partCount) {
        const media = document.createElement('span');
        media.className = 'archive-library-cover-badge';
        media.textContent = [item.playback.actualQuality, item.playback.partCount > 1 ? item.playback.partCount + 'P' : ''].filter(Boolean).join(' · ');
        if (media.textContent) coverBadges.appendChild(media);
      }
      cover.appendChild(coverBadges);
      const copy = document.createElement('span');
      copy.className = 'archive-library-card-copy';
      const title = document.createElement('span');
      title.className = 'archive-library-title';
      title.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('span');
      meta.className = 'archive-library-meta';
      meta.textContent = safeText(item.upperName, '未知UP') + ' · ' + safeText(item.bvid, '-');
      const memberships = document.createElement('span');
      memberships.className = 'archive-library-memberships';
      memberships.textContent = archiveMembershipText(item);
      copy.appendChild(title);
      copy.appendChild(meta);
      copy.appendChild(memberships);
      main.appendChild(cover);
      main.appendChild(copy);
      card.appendChild(main);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'archive-library-card-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '查看归档来源与操作');
      more.title = '来源与操作';
      more.addEventListener('click', () => openArchiveLibraryDetail(item.bvid, more));
      card.appendChild(more);
      main.addEventListener('click', () => {
        if (item.playback?.available) openArchiveLibraryPlayback(item.bvid, main);
        else openArchiveLibraryDetail(item.bvid, main);
      });
      return card;
    }

    function setArchiveLibraryFooter(text: string, retry?: (() => void) | null) {
      const footer = elements.archiveLibraryFooter;
      footer.replaceChildren();
      if (text) footer.appendChild(document.createTextNode(text));
      if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.addEventListener('click', retry);
        footer.appendChild(button);
      }
    }

    async function loadArchiveLibraryItems(reset = false): Promise<void> {
      if (archiveLibraryState.pendingReset && !reset) reset = true;
      if (archiveLibraryState.loading && !reset) return;
      const requestedContext = archiveLibraryContextSnapshot();
      if (reset) {
        archiveLibraryState.token += 1;
        if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
        archiveLibraryState.pendingReset = true;
        archiveLibraryState.pendingContext = requestedContext;
        if (!archiveLibraryState.pendingViewState) {
          archiveLibraryState.pendingViewState = {
            nextCursor:archiveLibraryState.nextCursor,
            hasMore:archiveLibraryState.hasMore,
            summary:archiveLibraryState.summary,
            error:archiveLibraryState.error
          };
        }
        archiveLibraryState.nextCursor = null;
        archiveLibraryState.hasMore = true;
        archiveLibraryState.error = null;
        setArchiveLibraryResultsBusy(true);
      }
      if (!archiveLibraryState.hasMore) return;
      const token = archiveLibraryState.token;
      const controller = new AbortController();
      archiveLibraryState.controller = controller;
      archiveLibraryState.loading = true;
      setArchiveLibraryFooter(reset ? '正在读取本地归档...' : '正在加载更多...', null);
      try {
        const params = archiveLibraryQueryParams({ cursor:archiveLibraryState.nextCursor }, requestedContext);
        const data = parseArchiveLibraryPage(await fetchJsonSilent('/api/archive-library/items?' + params.toString(), { signal:controller.signal }));
        if (token !== archiveLibraryState.token) return;
        const incoming = Array.isArray(data.items) ? data.items : [];
        const replace = reset;
        const target = replace ? [] : archiveLibraryState.items;
        const fresh = appendUniqueItems(target, incoming, (item) => item?.bvid);
        if (replace) {
          archiveLibraryState.items = fresh.slice();
          archiveLibraryState.nodes.clear();
        } else {
          archiveLibraryState.items.push(...fresh);
        }
        archiveLibraryState.nextCursor = data.nextCursor || null;
        archiveLibraryState.hasMore = Boolean(data.hasMore);
        if (data.summary) archiveLibraryState.summary = data.summary;
        archiveLibraryState.error = null;
        const grid = elements.archiveLibraryGrid;
        const fragment = document.createDocumentFragment();
        fresh.forEach((item) => {
          const node = createArchiveLibraryCard(item);
          archiveLibraryState.nodes.set(item.bvid, node);
          fragment.appendChild(node);
        });
        if (replace) {
          grid.replaceChildren(fragment);
          elements.archiveLibraryResults.scrollTop = 0;
        } else {
          grid.appendChild(fragment);
        }
        if (!archiveLibraryState.items.length) {
          const empty = document.createElement('div');
          empty.className = 'archive-library-empty';
          empty.textContent = archiveLibraryState.query ? '没有匹配的本地归档' : '当前目录暂无本地归档';
          grid.appendChild(empty);
        }
        setArchiveLibraryHeading();
        setArchiveLibraryFooter(archiveLibraryState.hasMore ? '' : '已加载全部', null);
        archiveLibraryState.pendingReset = false;
        archiveLibraryState.pendingContext = null;
        archiveLibraryState.pendingViewState = null;
        archiveLibraryState.appliedContext = requestedContext;
        persistArchiveLibraryPreference();
        setArchiveLibraryResultsBusy(false);
        if (replace) {
          const stored = Number(archiveLibraryState.scrollPositions[archiveContextKey()] || 0);
          frame(() => { elements.archiveLibraryResults.scrollTop = stored; });
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (token !== archiveLibraryState.token) return;
        if (error instanceof ApiError && error.code === 'ARCHIVE_CURSOR_STALE' && archiveLibraryState.nextCursor) {
          return loadArchiveLibraryItems(true);
        }
        archiveLibraryState.error = error instanceof Error ? error.message : String(error);
        if (reset) {
          const previousView = archiveLibraryState.pendingViewState;
          archiveLibraryState.pendingReset = false;
          archiveLibraryState.pendingContext = null;
          archiveLibraryState.pendingViewState = null;
          if (previousView) {
            archiveLibraryState.nextCursor = previousView.nextCursor;
            archiveLibraryState.hasMore = previousView.hasMore;
            archiveLibraryState.summary = previousView.summary;
            archiveLibraryState.error = previousView.error;
          }
          if (archiveLibraryState.appliedContext) {
            applyArchiveLibraryContext(archiveLibraryState.appliedContext);
            persistArchiveLibraryPreference();
          }
          setArchiveLibraryResultsBusy(false);
        }
        setArchiveLibraryFooter('加载失败，已保留现有内容', () => loadArchiveLibraryItems(Boolean(reset)));
      } finally {
        if (token === archiveLibraryState.token) {
          archiveLibraryState.loading = false;
          if (archiveLibraryState.controller === controller) archiveLibraryState.controller = null;
          if (!archiveLibraryState.pendingReset) setArchiveLibraryResultsBusy(false);
        }
      }
    }

    function syncArchiveLibraryDetailLayer() {
      syncArchiveLibraryPanels();
    }

    function closeArchiveLibraryDetail(options: {restoreFocus?: boolean} = {}) {
      const detail = elements.archiveLibraryDetail;
      if (!detail) return;
      const wasOpen = detail.classList.contains('open');
      const trigger = archiveLibraryState.detailTrigger;
      archiveLibraryState.detailToken += 1;
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      archiveLibraryState.detailController = null;
      detail.classList.remove('open');
      detail.setAttribute('aria-hidden', 'true');
      elements.archiveLibraryDetailBody.replaceChildren();
      syncArchiveLibraryDetailLayer();
      archiveLibraryState.detailTrigger = null;
      archiveLibraryState.detailBvid = null;
      if (wasOpen && options.restoreFocus !== false) {
        later(() => {
          if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.closest('[inert]') && !(trigger instanceof HTMLButtonElement && trigger.disabled)) {
            trigger.focus({ preventScroll:true });
            return;
          }
          const results = elements.archiveLibraryResults;
          if (results && results.isConnected && !results.closest('[inert]')) results.focus({ preventScroll:true });
        }, 0);
      }
    }

    async function refreshArchiveLibraryAfterDeletion(detailToken: number) {
      const sessionToken = archiveLibraryState.sessionToken;
      if (!archiveLibrarySessionCurrent(sessionToken) || detailToken !== archiveLibraryState.detailToken) return false;
      try {
        const navigation = await requestArchiveLibraryNavigation(sessionToken);
        if (!navigation || detailToken !== archiveLibraryState.detailToken) return false;
        renderArchiveLibraryNavigation();
      } catch (_) {}
      if (!archiveLibrarySessionCurrent(sessionToken) || detailToken !== archiveLibraryState.detailToken) return false;
      await loadArchiveLibraryItems(true);
      return archiveLibrarySessionCurrent(sessionToken) && detailToken === archiveLibraryState.detailToken;
    }

    function repreviewAndStartArchiveDeletion(operationId: string, trigger: HTMLElement) {
      const sessionToken = archiveLibraryState.sessionToken;
      const detailToken = archiveLibraryState.detailToken;
      return repreviewArchiveDeletion({id:operationId, trigger, request:fetchJson, confirm:confirmAction, formatBytes,
        current:()=>archiveLibrarySessionCurrent(sessionToken) && detailToken === archiveLibraryState.detailToken && trigger.isConnected});
    }

    async function watchArchiveSourceDeletion(operationId: string, host: HTMLElement, token: number) {
      if (!host || token !== archiveLibraryState.detailToken) return;
      try {
        const operation = parseArchiveDeletion(await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId)));
        if (token !== archiveLibraryState.detailToken || !document.contains(host)) return;
        host.replaceChildren(document.createTextNode(archiveDeletionProgressText(operation)));
        if (operation.status === 'completed') {
          if (!await refreshArchiveLibraryAfterDeletion(token)) return;
          closeArchiveLibraryDetail();
          showToast('远端归档已安全清理', 'success');
          return;
        }
        if (operation.status === 'failed') {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'ghost';
          retry.textContent = '重试清理';
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
              await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId) + '/retry', { method:'POST' });
              watchArchiveSourceDeletion(operationId, host, token);
            } catch (error) {
              retry.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(retry);
          const repreview = document.createElement('button');
          repreview.type = 'button';
          repreview.className = 'ghost';
          repreview.textContent = '重新预览';
          repreview.addEventListener('click', async () => {
            repreview.disabled = true;
            try {
              const replacement = await repreviewAndStartArchiveDeletion(operationId, repreview);
              if (replacement) watchArchiveSourceDeletion(replacement.id, host, token);
              else repreview.disabled = false;
            } catch (error) {
              repreview.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(repreview);
          return;
        }
        later(() => watchArchiveSourceDeletion(operationId, host, token), 1000);
      } catch (error) {
        if (token !== archiveLibraryState.detailToken || !document.contains(host)) return;
        host.textContent = '清理状态暂时无法读取：' + (error instanceof Error ? error.message : String(error));
        later(() => watchArchiveSourceDeletion(operationId, host, token), 3000);
      }
    }

    async function deleteArchiveLibrarySource(bvid: string, membership: Membership, trigger: HTMLButtonElement, host: HTMLElement, token: number) {
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || trigger.dataset.deleteBusy === 'true') return;
      trigger.dataset.deleteBusy = 'true';
      trigger.disabled = true;
      let started = false;
      try {
        const preview = parseArchiveDeletionPreview(await fetchJson('/api/archive-library/items/' + encodeURIComponent(bvid) + '/deletion-preview', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ userId:membership.userId, mediaId:membership.mediaId })
        }));
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        const confirmed = await confirmAction({
          title:'删除此来源的远端归档',
          message:'将删除 ' + Number(preview.fileCount || 0) + ' 个已追踪文件，共 ' + formatBytes(Number(preview.totalBytes || 0)) + '。',
          detail:(preview.sharedCount ? Number(preview.sharedCount) + ' 个共享文件只解除当前来源，不删除物理文件。' : '删除前会重新核验全部文件，未知文件不会被删除。'),
          requiredText:'DELETE ARCHIVE', confirmText:'开始清理', trigger
        });
        if (!confirmed) return;
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        const operation = parseArchiveDeletion(await fetchJson('/api/archive-deletions/' + encodeURIComponent(preview.previewId) + '/start', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ confirmation:'DELETE ARCHIVE' })
        }));
        started = true;
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        host.classList.remove('is-hidden');
        watchArchiveSourceDeletion(operation.id, host, token);
      } catch (error) {
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        delete trigger.dataset.deleteBusy;
        if (!started && trigger.isConnected) trigger.disabled = false;
      }
    }

    async function releaseArchiveLocalFiles(bvid: string, trigger: HTMLButtonElement, token: number) {
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || trigger.dataset.releaseBusy === 'true') return;
      trigger.dataset.releaseBusy = 'true';
      trigger.disabled = true;
      try {
        const preview = parseLocalReleasePreview(await fetchJson('/api/videos/' + encodeURIComponent(bvid) + '/local-release-preview'));
        if (token !== archiveLibraryState.detailToken || !trigger.isConnected) return;
        const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
        if (candidates.length === 0 || Number(preview.fileCount || 0) <= 0) {
          showToast('当前没有可安全释放的已授权本地文件');
          return;
        }
        const candidate = candidates[0];
        const extraGroups = Math.max(0, candidates.length - 1);
        const confirmed = await confirmAction({
          title:'释放本地空间',
          message:'本次将安全释放 ' + Number(candidate.fileCount || 0) + ' 个本地文件，共 ' + formatBytes(Number(candidate.totalBytes || 0)) + '。',
          detail:(candidate.requiresExplicitDeletion
            ? (candidate.hasVerifiedArchive ? '存在已验证归档，但不能保证与这些本地文件是同一版本。' : '没有已验证归档，这可能是唯一副本。') + ' 删除后无法从本机恢复；请先停止本次尝试。'
            : '只删除已完成远端确认且具有清理授权的文件；执行前会再次核对远端大小。') + ' 文件或会话有变化时停止删除。' + (extraGroups ? ' 另有 ' + extraGroups + ' 组文件可在完成后再次检查。' : ''),
          requiredText:'DELETE LOCAL', confirmText:'释放本地空间', danger:true, trigger
        });
        if (!confirmed) return;
        if (token !== archiveLibraryState.detailToken || !trigger.isConnected) return;
        await fetchJson('/api/videos/' + encodeURIComponent(bvid) + '/local-release', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ releaseId:candidate.releaseId, confirmation:'DELETE LOCAL' })
        });
        if (token === archiveLibraryState.detailToken && trigger.isConnected) showToast('已开始安全释放本地文件', 'success');
      } catch (error) {
        if (token === archiveLibraryState.detailToken && trigger.isConnected) {
          showToast(error instanceof Error ? error.message : String(error));
        }
      } finally {
        delete trigger.dataset.releaseBusy;
        if (trigger.isConnected) trigger.disabled = false;
      }
    }
    async function openArchiveLibraryDetail(bvid: string, trigger: HTMLElement | null) {
      const detail = elements.archiveLibraryDetail;
      const body = elements.archiveLibraryDetailBody;
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      const controller = new AbortController();
      archiveLibraryState.detailController = controller;
      const token = ++archiveLibraryState.detailToken;
      archiveLibraryState.detailTrigger = trigger instanceof HTMLElement ? trigger : null;
      archiveLibraryState.detailBvid = bvid;
      detail.classList.add('open');
      detail.setAttribute('aria-hidden', 'false');
      syncArchiveLibraryDetailLayer();
      elements.archiveLibraryDetailTitle.textContent = '归档详情';
      body.textContent = '正在读取...';
      later(() => {
        if (token === archiveLibraryState.detailToken && detail.classList.contains('open')) {
          elements.archiveLibraryDetailCloseBtn.focus({ preventScroll:true });
        }
      }, 0);
      try {
        const params = archiveLibraryQueryParams();
        const data = parseArchiveLibraryDetail(await fetchJson('/api/archive-library/items/' + encodeURIComponent(bvid) + '?' + params.toString(), { signal:controller.signal }));
        if (token !== archiveLibraryState.detailToken || !detail.classList.contains('open')) return;
        body.replaceChildren();
        elements.archiveLibraryDetailTitle.textContent = safeText(data.title || data.bvid, '归档详情');
        const cover = document.createElement('div');
        cover.className = 'archive-library-cover';
        appendArchiveCover(cover, data, 'archive-library-detail-cover');
        body.appendChild(cover);
        const meta = document.createElement('div');
        meta.className = 'archive-library-detail-meta';
        meta.textContent = safeText(data.upperName, '未知UP') + ' · ' + safeText(data.bvid, '-') + ' · ' + archiveStatusLabel(data);
        body.appendChild(meta);
        const localActions = document.createElement('div');
        localActions.className = 'archive-library-source-actions';
        const releaseLocal = document.createElement('button');
        releaseLocal.type = 'button';
        releaseLocal.className = 'ghost';
        releaseLocal.textContent = '释放本地空间';
        releaseLocal.title = '查看本地文件并确认删除；运行中的任务必须先停止';
        releaseLocal.addEventListener('click', () => void releaseArchiveLocalFiles(data.bvid, releaseLocal, token));
        localActions.appendChild(releaseLocal);
        body.appendChild(localActions);
        (data.memberships || []).forEach((membership) => {
          const source = document.createElement('div');
          source.className = 'archive-library-source';
          const title = document.createElement('strong');
          title.textContent = safeText(membership.userName, '未知账号') + ' · ' + safeText(membership.folderTitle, '收藏夹');
          const state = document.createElement('span');
          state.textContent = archiveStatusLabel({ backupStatus:membership.backupStatus, statusGroup:data.statusGroup, playback:{ available:false } }) +
            (membership.activeInFavorite ? ' · 当前关系' : ' · 历史记录') +
            (membership.selectedFolder ? '' : ' · 已停用') +
            (membership.ownerRemoved ? ' · 已移除账号' : '') +
            (membership.lastSeenAt ? ' · ' + formatDateTime(membership.lastSeenAt) : '');
          source.appendChild(title);
          source.appendChild(state);
          if (membership.error) {
            const error = document.createElement('span');
            error.textContent = membership.error;
            source.appendChild(error);
          }
          const size = document.createElement('span');
          size.textContent = Number(membership.fileCount || 0) + ' 个文件 · ' + formatBytes(Number(membership.totalBytes || 0));
          source.appendChild(size);
          const actions = document.createElement('div');
          actions.className = 'archive-library-source-actions';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'danger-action';
          const retryExisting = membership.deletionStatus === 'failed' && membership.deletionId;
          const deletionRunning = ['preparing','config_removing','pending','running','retry_wait'].includes(membership.deletionStatus || '');
          remove.textContent = membership.deletionStatus === 'completed'
            ? '已删除'
            : retryExisting
              ? '重试清理'
              : deletionRunning
                ? '清理中'
                : '删除此来源归档';
          remove.disabled = !(membership.deletable || retryExisting);
          if (membership.deletionReason) remove.title = membership.deletionReason;
          const progress = document.createElement('div');
          progress.className = 'archive-deletion-progress is-hidden';
          if (retryExisting) {
            remove.addEventListener('click', async () => {
              remove.disabled = true;
              try {
                await fetchJson('/api/archive-deletions/' + encodeURIComponent(membership.deletionId!) + '/retry', { method:'POST' });
                progress.classList.remove('is-hidden');
                watchArchiveSourceDeletion(membership.deletionId!, progress, token);
              } catch (error) {
                remove.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            const repreview = document.createElement('button');
            repreview.type = 'button';
            repreview.className = 'ghost';
            repreview.textContent = '重新预览';
            repreview.addEventListener('click', async () => {
              repreview.disabled = true;
              try {
                const replacement = await repreviewAndStartArchiveDeletion(membership.deletionId!, repreview);
                if (replacement) {
                  progress.classList.remove('is-hidden');
                  watchArchiveSourceDeletion(replacement.id, progress, token);
                } else {
                  repreview.disabled = false;
                }
              } catch (error) {
                repreview.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            actions.appendChild(repreview);
          } else if (membership.deletable) {
            remove.addEventListener('click', () => deleteArchiveLibrarySource(data.bvid, membership, remove, progress, token));
          }
          actions.appendChild(remove);
          source.appendChild(actions);
          if (membership.deletionReason) {
            const reason = document.createElement('span');
            reason.className = 'archive-library-source-reason';
            reason.textContent = membership.deletionReason;
            source.appendChild(reason);
          }
          source.appendChild(progress);
          body.appendChild(source);
          if (deletionRunning && membership.deletionId!) {
            progress.classList.remove('is-hidden');
            watchArchiveSourceDeletion(membership.deletionId!, progress, token);
          }
        });
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || token !== archiveLibraryState.detailToken || !detail.classList.contains('open')) return;
        body.replaceChildren();
        const message = document.createElement('p');
        message.textContent = '详情加载失败：' + (error instanceof Error ? error.message : String(error));
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'archive-library-detail-retry';
        retry.textContent = '重试';
        retry.addEventListener('click', () => openArchiveLibraryDetail(bvid, trigger));
        body.appendChild(message);
        body.appendChild(retry);
      } finally {
        if (archiveLibraryState.detailController === controller) archiveLibraryState.detailController = null;
      }
    }

    function scheduleArchiveLibrarySearch() {
      const input = elements.archiveLibrarySearchInput;
      const nextQuery = String(input.value || '').trim().slice(0, 80);
      archiveLibraryState.draftQuery = nextQuery;
      setHidden('archiveLibrarySearchClearBtn', !archiveLibraryState.draftQuery);
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = setTimeout(() => {
        archiveLibraryState.searchTimer = null;
        if (!elements.archiveLibraryModal.classList.contains('active')) return;
        if (applyArchiveLibraryDraftQuery()) loadArchiveLibraryItems(true);
      }, 300);
    }

    function applyArchiveLibraryDraftQuery() {
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = null;
      const nextQuery = String(archiveLibraryState.draftQuery || '').trim().slice(0, 80);
      if (nextQuery === archiveLibraryState.query) {
        setArchiveLibraryHeading();
        return false;
      }
      if (!archiveLibraryState.query && nextQuery) saveArchiveLibraryScroll();
      archiveLibraryState.query = nextQuery;
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      return true;
    }

    async function openArchiveLibrary(trigger: HTMLElement | null) {
      archiveLibraryState.sessionToken += 1;
      archiveLibraryState.token += 1;
      if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const preference = loadArchiveLibraryPreference();
      archiveLibraryState.scope = preference.scope;
      archiveLibraryState.userId = preference.userId;
      archiveLibraryState.mediaId = preference.mediaId;
      archiveLibraryState.filter = preference.filter;
      archiveLibraryState.sort = preference.sort;
      archiveLibraryState.scrollPositions = preference.scrollPositions;
      archiveLibraryState.draftQuery = '';
      archiveLibraryState.query = '';
      archiveLibraryState.searchScope = 'current';
      archiveLibraryState.pageSize = 50;
      archiveLibraryState.trigger = trigger || null;
      archiveLibraryState.navigation = null;
      archiveLibraryState.title = '全部归档';
      elements.archiveLibrarySearchInput.value = '';
      document.querySelector<HTMLElement>('.archive-library-shell')?.classList.remove('show-content');
      syncArchiveLibraryPanels();
      renderArchiveLibraryNavigation();
      setArchiveLibraryHeading();
      openModal('archiveLibraryModal', trigger);
      const token = archiveLibraryState.sessionToken;
      try {
        const navigation = await requestArchiveLibraryNavigation(token);
        if (!navigation || !archiveLibrarySessionCurrent(token)) return;
        if (!archiveDirectoryExists(navigation, archiveLibraryState.scope, archiveLibraryState.userId, archiveLibraryState.mediaId)) {
          archiveLibraryState.scope = 'global';
          archiveLibraryState.userId = null;
          archiveLibraryState.mediaId = null;
        }
        if (archiveLibraryState.scope === 'account') {
          const account = navigation.accounts.find((entry) => entry.id === archiveLibraryState.userId);
          archiveLibraryState.title = account ? safeText(account.name, '账号') + ' · 全部归档' : '全部归档';
        } else if (archiveLibraryState.scope === 'folder') {
          const account = navigation.accounts.find((entry) => entry.id === archiveLibraryState.userId);
          const folder = account && [...(account.folders || []), ...(account.inactiveFolders || [])]
            .find((entry) => Number(entry.mediaId) === Number(archiveLibraryState.mediaId));
          archiveLibraryState.title = folder ? folder.title + (folder.inactive ? ' · 已停用' : '') : '收藏夹归档';
        }
        renderArchiveLibraryNavigation();
        setArchiveLibraryHeading();
        await loadArchiveLibraryItems(true);
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || !archiveLibrarySessionCurrent(token)) return;
        setArchiveLibraryFooter('归档目录加载失败', () => openArchiveLibrary(trigger));
      }
    }


  function init() {
    if (events) return;
    events=new AbortController(); const signal=events.signal;
    function listen(element: EventTarget, type: string, callback: (event: Event)=>void) { element.addEventListener(type, callback, {signal}); }
    listen(elements.archiveLibraryBtn, 'click', (event) => openArchiveLibrary(elements.archiveLibraryBtn));
    listen(elements.closeArchiveLibraryBtn, 'click', () => closeModal('archiveLibraryModal'));
    listen(elements.archiveLibraryMobileBackBtn, 'click', () => {
      saveArchiveLibraryScroll();
      closeArchiveLibraryDetail({ restoreFocus:false });
      const shell = document.querySelector<HTMLElement>('.archive-library-shell');
      if (!shell) return;
      shell.classList.remove('show-content');
      syncArchiveLibraryPanels();
      shell.scrollLeft = 0;
      const active = document.querySelector<HTMLElement>('.archive-nav-item.active');
      if (active) later(() => {
        active.focus({ preventScroll:true });
        shell.scrollLeft = 0;
      }, 0);
    });
    listen(elements.archiveLibraryDetailCloseBtn, 'click', () => closeArchiveLibraryDetail());
    listen(elements.archiveLibrarySearchInput, 'input', scheduleArchiveLibrarySearch);
    listen(elements.archiveLibrarySearchClearBtn, 'click', () => {
      const input = elements.archiveLibrarySearchInput;
      input.value = '';
      archiveLibraryState.draftQuery = '';
      const changed = applyArchiveLibraryDraftQuery();
      if (changed) loadArchiveLibraryItems(true);
      input.focus({ preventScroll:true });
    });
    listen(elements.archiveSearchCurrentBtn, 'click', () => {
      if (archiveLibraryState.searchScope === 'current') return;
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.searchScope = 'current';
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      loadArchiveLibraryItems(true);
    });
    listen(elements.archiveSearchGlobalBtn, 'click', () => {
      if (archiveLibraryState.searchScope === 'global') return;
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.searchScope = 'global';
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      loadArchiveLibraryItems(true);
    });
    listen(elements.archiveLibrarySort, 'change', (event) => {
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.sort = elements.archiveLibrarySort.value;
      closeArchiveLibraryDetail({ restoreFocus:false });
      persistArchiveLibraryPreference();
      loadArchiveLibraryItems(true);
    });
    document.querySelectorAll<HTMLElement>('[data-archive-filter]').forEach((button) => {
      listen(button, 'click', () => {
        const filter = button.dataset.archiveFilter;
        if (!filter || filter === archiveLibraryState.filter) return;
        applyArchiveLibraryDraftQuery();
        archiveLibraryState.filter = filter;
        closeArchiveLibraryDetail({ restoreFocus:false });
        persistArchiveLibraryPreference();
        setArchiveLibraryHeading();
        loadArchiveLibraryItems(true);
      });
    });
    listen(elements.archiveLibraryResults, 'scroll', () => {
      const results = elements.archiveLibraryResults;
      if (!elements.archiveLibraryModal.classList.contains('active')
        || results.scrollHeight - results.scrollTop - results.clientHeight >= 240
        || archiveLibraryState.loading || !archiveLibraryState.hasMore || archiveLibraryState.scrollTimer) return;
      archiveLibraryState.scrollTimer = setTimeout(() => {
        archiveLibraryState.scrollTimer = null;
        if (elements.archiveLibraryModal.classList.contains('active')) {
          loadArchiveLibraryItems(false);
        }
      }, 180);
    });

    archiveLibraryLayoutMedia.addEventListener('change', syncArchiveLibraryPanels, {signal});
  }
  function destroy() {
    cleanupArchiveLibrary();events?.abort();events=null;
    for(const timer of timers)clearTimeout(timer);timers.clear();
    for(const id of frames)cancelAnimationFrame(id);frames.clear();
  }
  return {init, destroy, deactivate: cleanupArchiveLibrary, open: openArchiveLibrary, context: archiveLibraryContextSnapshot,
    closeDetail: closeArchiveLibraryDetail, get detailOpen() { return elements.archiveLibraryDetail.classList.contains('open'); }};
}
