import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseUnavailablePage, type VideoDetailItem } from '../../../../shared/api/video-detail.js';

export function createUnavailable(dependencies: {
  root: Document; api: ApiClient; renderItem(item: VideoDetailItem): HTMLElement;
  open(modal: HTMLElement): void; close(modal: HTMLElement): void;
  notify(message: string): void;
  releaseItems(owner: HTMLElement): void;
}) {
  const {root:document,api,renderItem:renderVideoDetailItem}=dependencies;
  const element=(id: string)=>requireElement(document,'#'+id,HTMLElement);
  const modal=element('unavailableModal'); const grid=element('unavailableGrid');
  type Filter='missing'|'uploaded';
  interface PageState {items:VideoDetailItem[];keys:Set<string>;nodes:Map<string,HTMLElement>;cursor:string|null;hasMore:boolean;loading:boolean;error:string|null}
  const empty=():PageState=>({items:[],keys:new Set(),nodes:new Map(),cursor:null,hasMore:true,loading:false,error:null});
  const unavailableStates:Record<Filter,PageState>={missing:empty(),uploaded:empty()};
  let unavailableUserId:string|null=null;let unavailableFilter:Filter='missing';let unavailableController:AbortController|null=null;
  let unavailableToken=0;let unavailableThrottleTimer:ReturnType<typeof setTimeout>|null=null;let initialized=false;
  const safeText=(value:unknown,fallback:string)=>String(value??'').trim()||fallback;
  function deactivate(){
    dependencies.releaseItems(grid);
    if(unavailableThrottleTimer!==null)clearTimeout(unavailableThrottleTimer);unavailableThrottleTimer=null;
    unavailableController?.abort();unavailableController=null;unavailableUserId=null;unavailableToken++;
    unavailableStates.missing=empty();unavailableStates.uploaded=empty();grid.replaceChildren();
  }
    async function openUnavailable(userId: string) {
      if (!initialized) return;
      if (unavailableThrottleTimer) {
        clearTimeout(unavailableThrottleTimer);
        unavailableThrottleTimer = null;
      }
      dependencies.releaseItems(grid);
      unavailableUserId = userId;
      unavailableFilter = 'missing';
      if (unavailableController) unavailableController.abort();
      unavailableController = null;
      unavailableToken += 1;
      Object.values(unavailableStates).forEach((state) => {
        state.items = [];
        state.keys = new Set();
        state.nodes = new Map();
        state.cursor = null;
        state.hasMore = true;
        state.loading = false;
        state.error = null;
      });
      element('filterMissingBtn').classList.add('active');
      element('filterUploadedBtn').classList.remove('active');
      grid.innerHTML = '';
      dependencies.open(modal);
      await loadMoreUnavailable();
    }

    async function loadMoreUnavailable(options: {retry?: boolean} = {}) {
      const filter = unavailableFilter;
      const state = unavailableStates[filter];
      if (!state || state.loading || !state.hasMore || !unavailableUserId || (state.error && !options.retry)) return;
      if (unavailableController) unavailableController.abort();
      const controller = new AbortController();
      unavailableController = controller;
      const token = ++unavailableToken;
      state.loading = true;
      state.error = null;
      renderUnavailableStatus(state.items.length ? '加载更多...' : '加载中...');
      try {
        const url = '/api/users/' + encodeURIComponent(unavailableUserId) + '/unavailable?pageSize=20&filter=' + filter +
          (state.cursor ? '&cursor=' + encodeURIComponent(state.cursor) : '');
        const data = parseUnavailablePage(await api.silent(url, { signal:controller.signal }));
        if (token !== unavailableToken || filter !== unavailableFilter) return;
        const added = [];
        for (const item of data.items || []) {
          const key = String(item.mediaId || 0) + ':' + String(item.bvid || '');
          if (!item.bvid || state.keys.has(key)) continue;
          state.keys.add(key);
          state.items.push(item);
          const node = renderUnavailableItem(item);
          state.nodes.set(key, node);
          added.push(node);
        }
        state.cursor = data.nextCursor || null;
        state.hasMore = Boolean(data.hasMore);
        if (added.length) {
              const status = grid.querySelector('[data-status-marker="unavailable"]');
          added.forEach((node) => grid.insertBefore(node, status));
        }
        renderUnavailableStatus('');
      } catch (e) {
        if (controller.signal.aborted) return;
        if (token !== unavailableToken || filter !== unavailableFilter) return;
        state.error = e instanceof Error ? e.message : String(e);
        dependencies.notify(state.error);
        renderUnavailableStatus('加载失败: ' + state.error, true);
      } finally {
        if (token === unavailableToken) state.loading = false;
        if (token === unavailableToken) unavailableController = null;
        if (token === unavailableToken && filter === unavailableFilter && !state.error) renderUnavailableStatus('');
      }
    }

    function setUnavailableFilter(filter: Filter) {
      if (!unavailableStates[filter] || filter === unavailableFilter) return;
      if (unavailableThrottleTimer !== null) clearTimeout(unavailableThrottleTimer);
      unavailableThrottleTimer = null;
      if (unavailableController) unavailableController.abort();
      unavailableController = null;
      unavailableToken += 1;
      unavailableStates[unavailableFilter].loading = false;
      unavailableFilter = filter;
      element('filterMissingBtn').classList.toggle('active', filter === 'missing');
      element('filterUploadedBtn').classList.toggle('active', filter === 'uploaded');
      renderUnavailableList();
      const state = unavailableStates[filter];
      if (state.items.length === 0 && state.hasMore) void loadMoreUnavailable();
    }

    function renderUnavailableItem(item: VideoDetailItem) {
      const div = renderVideoDetailItem(item);
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.textContent = '收藏夹: ' + safeText(item.folderTitle, '未知');
      const info = div.querySelector('.video-info');
      if (info) info.appendChild(meta);
      return div;
    }

    function renderUnavailableList() {
      const state = unavailableStates[unavailableFilter];
      grid.replaceChildren(...state.nodes.values());
      renderUnavailableStatus(state.error ? '加载失败: ' + state.error : '', Boolean(state.error));
    }

    function renderUnavailableStatus(text: string, isError = false) {
      const state = unavailableStates[unavailableFilter];
      const old = grid.querySelector('[data-status-marker="unavailable"]');
      if (old) old.remove();
      let message = text;
      if (!message && !state.loading) {
        if (state.items.length === 0 && !state.hasMore) message = '暂无符合条件的视频';
        else if (!state.hasMore) message = '已加载全部';
      }
      if (!message) return;
      const status = document.createElement('div');
      status.dataset.statusMarker = 'unavailable';
      status.className = (/加载|正在/.test(message) ? 'empty-state loading-state' : 'empty-state') +
        (isError ? ' video-detail-status error' : ' video-detail-status');
      status.appendChild(document.createTextNode(message));
      if (isError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry-button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => loadMoreUnavailable({ retry:true }));
        status.appendChild(retry);
      }
      grid.appendChild(status);
    }


  function scroll(){
    if(!unavailableUserId||!modal.classList.contains('active')||grid.scrollHeight-grid.scrollTop-grid.clientHeight>=120||unavailableThrottleTimer!==null)return;
    unavailableThrottleTimer=setTimeout(()=>{unavailableThrottleTimer=null;void loadMoreUnavailable();},800);
  }
  const missing=()=>setUnavailableFilter('missing');const uploaded=()=>setUnavailableFilter('uploaded');const close=()=>dependencies.close(modal);
  return {open:openUnavailable,deactivate,init(){if(initialized)return;initialized=true;element('filterMissingBtn').addEventListener('click',missing);element('filterUploadedBtn').addEventListener('click',uploaded);element('closeUnavailableBtn').addEventListener('click',close);grid.addEventListener('scroll',scroll);},
    destroy(){if(!initialized)return;initialized=false;element('filterMissingBtn').removeEventListener('click',missing);element('filterUploadedBtn').removeEventListener('click',uploaded);element('closeUnavailableBtn').removeEventListener('click',close);grid.removeEventListener('scroll',scroll);deactivate();}};
}
