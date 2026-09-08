import { requireElement } from '../../shared/dom.js';
import type { ApiClient } from '../../shared/api.js';
import { parseOnlinePage, parseOnlineNavigation, type OnlineItem } from '../../../../shared/api/online-content.js';
import { createManualArchive, type ManualArchiveContext as Context } from './manual-archive.js';
interface OnlineState extends Context {navigation:ReturnType<typeof parseOnlineNavigation>|null;draftQuery:string;items:OnlineItem[];total:number|null;page:number;cursor:string|null;hasMore:boolean;loading:boolean;token:number;controller:AbortController|null;searchTimer:ReturnType<typeof setTimeout>|null;navigationToken:number;navigationController:AbortController|null;sessionToken:number;appliedContext:Context|null;pendingContext:Context|null;trigger:HTMLElement|null}
export function createOnlineContent(dependencies:{root:Document;api:ApiClient;layout:MediaQueryList;formatBytes(bytes:number):string;open(modal:HTMLElement,trigger:HTMLElement):void;close(modal:HTMLElement):void;openArchive():void;openExternal(url:string):void;notify(message:string):void;status(message:string,type?:string,retry?:()=>void):void}) {
  const {root:document,api,layout}=dependencies;
  const element=(id:string)=>requireElement(document,'#'+id,HTMLElement);
  const search=requireElement(document,'#onlineContentSearchInput',HTMLInputElement);
  const modal=element('onlineContentModal');
  const shell=requireElement(document,'.online-content-shell',HTMLElement);
  const sidebar=requireElement(shell,'.online-content-sidebar',HTMLElement);
  const main=requireElement(shell,'.online-content-main',HTMLElement);
  function setPanel(element:HTMLElement,available:boolean){element.inert=!available;if(available)element.removeAttribute('aria-hidden');else element.setAttribute('aria-hidden','true');}
  const safeText=(value:unknown,fallback:string)=>String(value||fallback);
  function appendUniqueItems(target:OnlineItem[],incoming:OnlineItem[],keyOf:(item:OnlineItem)=>string){const known=new Set(target.map(keyOf));return incoming.filter(item=>{const key=keyOf(item);if(known.has(key))return false;known.add(key);return true;});}
  let initialized=false;
    const onlineContentState: OnlineState = {
      navigation:null,
      userId:null,
      kind:'favorite',
      mediaId:null,
      title:'在线收藏夹',
      query:'',
      draftQuery:'',
      items:[],
      total:null,
      page:0,
      cursor:null,
      hasMore:false,
      loading:false,
      token:0,
      controller:null,
      searchTimer:null,
      navigationToken:0,
      navigationController:null,
      sessionToken:0,
      appliedContext:null,
      pendingContext:null,
      trigger:null
    };
    function onlineContentContextSnapshot(source:Context = onlineContentState) {
      return {
        userId:source.userId || null,
        kind:source.kind || 'favorite',
        mediaId:Number(source.mediaId || 0) || null,
        title:source.title || '在线内容',
        query:String(source.query || '').trim().slice(0, 80)
      };
    }

    function onlineContentContextsEqual(left:Context|null, right:Context|null) {
      return left !== null && right !== null
        && left.userId === right.userId
        && left.kind === right.kind
        && Number(left.mediaId || 0) === Number(right.mediaId || 0)
        && left.query === right.query;
    }

    function onlineContentCount(value:unknown) {
      if (value === null || value === undefined || value === '') return null;
      const count = Number(value);
      return Number.isInteger(count) && count >= 0 ? count : null;
    }

    function applyOnlineContentContext(context:Context|null) {
      if (!context) return;
      onlineContentState.userId = context.userId;
      onlineContentState.kind = context.kind;
      onlineContentState.mediaId = context.mediaId;
      onlineContentState.title = context.title;
      onlineContentState.query = context.query;
      onlineContentState.draftQuery = context.query;
      element('onlineContentTitle').textContent = context.title;
      search.value = context.query;
    }

    function setOnlineContentResultsBusy(busy:boolean) {
      const results = element('onlineContentResults');
      if (!results) return;
      results.inert = Boolean(busy);
      if (busy) results.setAttribute('aria-busy', 'true');
      else results.removeAttribute('aria-busy');
    }

    function setOnlineContentFooter(text:string, type = '', retry?:()=>void) {
      dependencies.status(text,type,retry);
    }

    function cancelOnlineContentItems() {
      onlineContentState.token += 1;
      onlineContentState.controller?.abort();
      onlineContentState.controller = null;
      onlineContentState.loading = false;
      onlineContentState.pendingContext = null;
      setOnlineContentResultsBusy(false);
    }

    function cleanupOnlineContent() {
      cancelOnlineContentItems();
      onlineContentState.sessionToken += 1;
      onlineContentState.navigationToken += 1;
      if (onlineContentState.navigationController) onlineContentState.navigationController.abort();
      if (onlineContentState.searchTimer) clearTimeout(onlineContentState.searchTimer);
      onlineContentState.navigationController = null;
      onlineContentState.searchTimer = null;
      onlineContentState.navigation = null;
      onlineContentState.userId = null;
      onlineContentState.mediaId = null;
      onlineContentState.query = '';
      onlineContentState.draftQuery = '';
      onlineContentState.items = [];
      onlineContentState.total = null;
      onlineContentState.page = 0;
      onlineContentState.cursor = null;
      onlineContentState.hasMore = false;
      onlineContentState.appliedContext = null;
      onlineContentState.pendingContext = null;
      element('onlineContentNav')?.replaceChildren();
      element('onlineContentGrid')?.replaceChildren();
      search.value = '';
      shell?.classList.remove('show-content');
      setOnlineContentFooter('');
      manualArchive.deactivate();
    }

    function openManualArchiveOptions(item:OnlineItem,trigger:HTMLElement) {
      manualArchive.open(item,onlineContentState.appliedContext||onlineContentContextSnapshot(),trigger);
    }

    function onlineContentCurrent(token:number, sessionToken = onlineContentState.sessionToken) {
      return token === onlineContentState.token && sessionToken === onlineContentState.sessionToken
        && element('onlineContentModal')?.classList.contains('active');
    }

    function renderOnlineNavigation() {
      const host = element('onlineContentNav');
      if (!host) return;
      host.replaceChildren();
      const accounts = onlineContentState.navigation?.accounts || [];
      if (!accounts.length) { host.textContent = '暂无可用账号'; return; }
      const active = onlineContentState.pendingContext || onlineContentState.appliedContext;
      accounts.forEach((account) => {
        const group = document.createElement('div');
        group.className = 'archive-nav-group';
        const heading = document.createElement('div');
        heading.className = 'archive-nav-group-title';
        heading.textContent = safeText(account.name, account.userId);
        group.appendChild(heading);
        (account.sources || []).forEach((source) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'archive-nav-item';
          button.dataset.onlineUserId = account.userId;
          button.dataset.onlineKind = source.kind;
          button.dataset.onlineMediaId = String(source.mediaId || '');
          const selected = active !== null
            && account.userId === active.userId
            && source.kind === active.kind
            && Number(source.mediaId || 0) === Number(active.mediaId || 0);
          const loadedCount = selected ? onlineContentCount(onlineContentState.total) : null;
          const navigationCount = onlineContentCount(source.count);
          const count = navigationCount ?? loadedCount;
          const countLabel = source.countLabel || (source.kind === 'favorite' ? '个视频' : '项');
          const title = document.createElement('strong');
          title.textContent = safeText(source.title, '在线内容');
          const meta = document.createElement('span');
          meta.textContent = count === null ? '打开时加载' : count + ' ' + countLabel;
          button.append(title, meta);
          button.addEventListener('click', () => selectOnlineSource({ userId:account.userId, kind:source.kind, mediaId:source.mediaId || null, title:source.title }));
          group.appendChild(button);
        });
        host.appendChild(group);
      });
      host.querySelectorAll<HTMLElement>('.archive-nav-item').forEach((button) => {
        const selected = active !== null
          && button.dataset.onlineUserId === active.userId
          && button.dataset.onlineKind === active.kind
          && Number(button.dataset.onlineMediaId || 0) === Number(active.mediaId || 0);
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    function renderOnlineCards(append:boolean) {
      const grid = element('onlineContentGrid');
      if (!grid) return;
      if (!append) grid.replaceChildren();
      const existing = new Set(Array.from(grid.children).map((node) => node instanceof HTMLElement ? node.dataset.onlineId : undefined));
      onlineContentState.items.forEach((item) => {
        if (existing.has(item.id)) return;
        existing.add(item.id);
        const card = document.createElement('article');
        card.className = 'archive-library-card online-content-card';
        card.dataset.onlineId = item.id;
        const cover = document.createElement('div');
        cover.className = 'archive-library-cover';
        if (item.coverUrl) {
          const image = document.createElement('img');
          image.src = item.coverUrl;
          image.alt = '';
          image.loading = 'lazy';
          image.referrerPolicy = 'same-origin';
          image.addEventListener('error', () => { image.remove(); cover.insertAdjacentHTML('beforeend','<span class="archive-library-placeholder">B</span>'); }, { once:true });
          cover.appendChild(image);
        } else cover.innerHTML = '<span class="archive-library-placeholder">B</span>';
        const copy = document.createElement('div');
        copy.className = 'archive-library-card-copy';
        const title = document.createElement('div');
        title.className = 'archive-library-title';
        title.textContent = safeText(item.title, '未命名条目');
        copy.appendChild(title);
        const meta = document.createElement('div');
        meta.className = 'archive-library-meta';
        meta.textContent = [item.upperName || '未知UP主', item.bvid || '非视频条目'].join(' · ');
        copy.appendChild(meta);
        const status = document.createElement('span');
        status.className = 'archive-library-status ' + (item.archiveState === 'archived' ? 'playable' : item.archiveState === 'processing' ? 'pending' : 'issue');
        status.textContent = item.archiveState === 'archived' ? '已归档' : item.archiveState === 'processing' ? '处理中' : item.archiveState === 'unavailable' ? '不可归档' : '未归档';
        copy.appendChild(status);
        const actions = document.createElement('div');
        actions.className = 'archive-library-source-actions';
        if (item.bvid && item.archiveState === 'unarchived') {
          const archiveButton = document.createElement('button');
          archiveButton.type = 'button';
          archiveButton.textContent = '手动归档';
          archiveButton.addEventListener('click', () => openManualArchiveOptions(item, archiveButton));
          actions.appendChild(archiveButton);
        }
        if (item.bvid || item.openUrl) {
          const openButton = document.createElement('button');
          openButton.type = 'button';
          openButton.textContent = item.archiveState === 'archived' && item.bvid ? '打开归档库' : '打开 B 站';
          openButton.addEventListener('click', () => {
            if (item.archiveState === 'archived' && item.bvid) { dependencies.close(modal); dependencies.openArchive(); return; }
            if (item.openUrl) dependencies.openExternal(item.openUrl);
          });
          actions.appendChild(openButton);
        }
        copy.appendChild(actions);
        card.append(cover, copy);
        grid.appendChild(card);
      });
      const total = onlineContentCount(onlineContentState.total);
      element('onlineContentSummary').textContent = total === null
        ? onlineContentState.items.length + ' 项'
        : '共 ' + total + ' 项';
    }

    async function loadOnlineContentItems(append = false, requestedContext:Context|null = null) {
      const context = requestedContext || (append
        ? onlineContentState.appliedContext
        : onlineContentState.pendingContext || onlineContentState.appliedContext || onlineContentContextSnapshot());
      if (!context?.userId || (append && (onlineContentState.loading || !onlineContentState.hasMore))) return;
      if (!append) {
        onlineContentState.controller?.abort();
        onlineContentState.total = null;
        onlineContentState.pendingContext = { ...context };
        setOnlineContentResultsBusy(true);
        renderOnlineNavigation();
      }
      onlineContentState.loading = true;
      const token = ++onlineContentState.token;
      const sessionToken = onlineContentState.sessionToken;
      const controller = new AbortController();
      onlineContentState.controller = controller;
      const requestedPage = append ? onlineContentState.page + 1 : 1;
      const params = new URLSearchParams({ userId:context.userId, kind:context.kind, pageSize:'50', page:String(requestedPage) });
      if (context.mediaId) params.set('mediaId', String(context.mediaId));
      if (context.query) params.set('q', context.query);
      if (append && onlineContentState.cursor) params.set('cursor', onlineContentState.cursor);
      setOnlineContentFooter(append ? '正在加载更多...' : '正在读取在线内容...', 'muted');
      try {
        const data = parseOnlinePage(await api.silent('/api/online-content/items?' + params.toString(), { signal:controller.signal }));
        if (!onlineContentCurrent(token, sessionToken)) return;
        const incoming = data.items;
        const responseTotal = data.page.total;
        const parsedTotal = onlineContentCount(responseTotal);
        if (parsedTotal !== null) onlineContentState.total = parsedTotal;
        else if (!append) onlineContentState.total = null;
        if (append) {
          if (!onlineContentContextsEqual(onlineContentState.appliedContext, context)) return;
          onlineContentState.items.push(...appendUniqueItems(onlineContentState.items, incoming, (item) => item?.id));
        } else {
          onlineContentState.items = appendUniqueItems([], incoming, (item) => item?.id);
          applyOnlineContentContext(context);
          onlineContentState.appliedContext = { ...context };
          onlineContentState.pendingContext = null;
        }
        onlineContentState.page = Number(data.page?.page || requestedPage);
        onlineContentState.cursor = data.page.nextCursor;
        onlineContentState.hasMore = Boolean(data.page.hasMore);
        renderOnlineCards(append);
        renderOnlineNavigation();
        setOnlineContentFooter(onlineContentState.hasMore ? '继续滚动加载更多' : (onlineContentState.items.length ? '已加载全部' : '当前分类没有内容'));
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || !onlineContentCurrent(token, sessionToken)) return;
        if (!append) {
          onlineContentState.pendingContext = null;
          if (onlineContentState.appliedContext) applyOnlineContentContext(onlineContentState.appliedContext);
          renderOnlineNavigation();
        }
        setOnlineContentFooter('在线内容读取失败：' + (error instanceof Error ? error.message : String(error)), 'error', () => void loadOnlineContentItems(false, context));
      } finally {
        if (onlineContentState.controller === controller) onlineContentState.controller = null;
        if (onlineContentCurrent(token, sessionToken)) {
          onlineContentState.loading = false;
          setOnlineContentResultsBusy(false);
        }
      }
    }

    async function selectOnlineSource(context:Omit<Context,'query'> & {query?:string}) {
      if (onlineContentState.searchTimer) clearTimeout(onlineContentState.searchTimer);
      onlineContentState.searchTimer = null;
      const query = String(context.query || '').trim().slice(0, 80);
      const requested = {
        userId:context.userId,
        kind:context.kind,
        mediaId:Number(context.mediaId || 0) || null,
        title:context.title || '在线内容',
        query
      };
      onlineContentState.draftQuery = query;
      search.value = query;
      element('onlineContentTitle').textContent = requested.title;
      shell.classList.add('show-content');
      syncOnlineContentPanels();
      await loadOnlineContentItems(false, requested);
    }

    function syncOnlineContentPanels() {



      if (!layout.matches) { setPanel(sidebar, true); setPanel(main, true); return; }
      const show = Boolean(shell?.classList.contains('show-content'));
      setPanel(sidebar, !show);
      setPanel(main, show);
    }

    async function openOnlineContent(trigger:HTMLElement) {
      cleanupOnlineContent();
      dependencies.open(modal,trigger);
      const sessionToken = onlineContentState.sessionToken;
      const navigationToken = ++onlineContentState.navigationToken;
      const navigationController = new AbortController();
      onlineContentState.navigationController = navigationController;
      try {
        const navigation = parseOnlineNavigation(await api.silent('/api/online-content/navigation', { signal:navigationController.signal }));
        if (navigationToken !== onlineContentState.navigationToken || sessionToken !== onlineContentState.sessionToken || !element('onlineContentModal').classList.contains('active')) return;
        onlineContentState.navigation=navigation;
        renderOnlineNavigation();
        const firstAccount = onlineContentState.navigation?.accounts?.[0];
        const first = firstAccount?.sources?.[0];
        if (first) await selectOnlineSource({
          userId:firstAccount.userId,
          kind:first.kind,
          mediaId:first.mediaId,
          title:first.title,
          query:onlineContentState.draftQuery
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && navigationToken === onlineContentState.navigationToken && sessionToken === onlineContentState.sessionToken) {
          setOnlineContentFooter('在线目录读取失败：' + (error instanceof Error ? error.message : String(error)), 'error', () => void openOnlineContent(trigger));
        }
      } finally {
        if (onlineContentState.navigationController === navigationController) onlineContentState.navigationController = null;
      }
    }

  const manualArchive=createManualArchive({...dependencies,committed:(item,context)=>{if(onlineContentState.items.includes(item)&&onlineContentContextsEqual(onlineContentState.appliedContext,context))renderOnlineCards(false);dependencies.status(item.archiveState==='archived'?'该视频已经在归档库中。':'已进入手动归档队列。','success');}});
  const bindings:Array<[HTMLElement,string,EventListener]>=[
    [element('onlineContentBtn'),'click',()=>{void openOnlineContent(element('onlineContentBtn'));}],
    [element('closeOnlineContentBtn'),'click',()=>dependencies.close(modal)],
    [element('onlineContentCloseMainBtn'),'click',()=>dependencies.close(modal)],
    [element('onlineContentMobileBackBtn'),'click',()=>{shell.classList.remove('show-content');syncOnlineContentPanels();element('onlineContentNav').querySelector('button')?.focus({preventScroll:true});}],
    [element('onlineContentRefreshBtn'),'click',()=>{if(onlineContentState.appliedContext)void loadOnlineContentItems(false,onlineContentState.appliedContext);}],
    [search,'input',()=>{const value=search.value.trim().slice(0,80);onlineContentState.draftQuery=value;if(onlineContentState.searchTimer)clearTimeout(onlineContentState.searchTimer);const session=onlineContentState.sessionToken;onlineContentState.searchTimer=setTimeout(()=>{onlineContentState.searchTimer=null;if(session!==onlineContentState.sessionToken||!modal.classList.contains('active'))return;const base=onlineContentState.pendingContext||onlineContentState.appliedContext;if(base&&base.query!==value)void loadOnlineContentItems(false,{...base,query:value});},300);}],
    [element('onlineContentResults'),'scroll',()=>{const node=element('onlineContentResults');if(node.scrollTop+node.clientHeight>=node.scrollHeight-500)void loadOnlineContentItems(true);}],
  ];
  return {deactivate:cleanupOnlineContent,deactivateManual:manualArchive.deactivate,init(){if(initialized)return;initialized=true;manualArchive.init();for(const [node,event,listener]of bindings)node.addEventListener(event,listener);layout.addEventListener('change',syncOnlineContentPanels);},destroy(){if(!initialized)return;initialized=false;cleanupOnlineContent();manualArchive.destroy();for(const [node,event,listener]of bindings)node.removeEventListener(event,listener);layout.removeEventListener('change',syncOnlineContentPanels);}};
}
