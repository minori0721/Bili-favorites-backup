import type ArtplayerInstance from 'artplayer';
import { parsePlaybackQueuePage, parsePlaybackSearchPage, parsePlaybackDelivery, parsePlaybackMetadata } from '../../../../shared/api/playback-queue.js';
import type { ArchiveContext } from '../../../../shared/api/archive-context.js';
import { isRecord } from '../../../../shared/api/value.js';
import { decidePlaybackMediaError, resolvePlaybackDeliveryViewStatus, type PlaybackDeliveryViewStatus } from '../../../../shared/playback-policy.js';
import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
declare global { interface Window { Artplayer?: typeof ArtplayerInstance } }
type QueuePage = ReturnType<typeof parsePlaybackQueuePage>;
type Item = QueuePage['items'][number];
type Part = Item['parts'][number];
interface Preferences {version: number; volume: number; muted: boolean; rate: number; continuous: boolean; mobilePortraitMode: boolean; progress: Record<string,{time: number; updatedAt:number}>}
interface PageCursor {hasPrevious: boolean; previousCursor: string | null; hasMore:boolean; nextCursor:string | null}
interface PlaybackState {
  art: ArtplayerInstance | null; userId: string | null; mediaId: number | null; mode: 'favorite'|'library'|'single';
  page:number;pageSize:number;total:number;focusIndex:number;items:Item[];pages:Map<number,Item[]>;pageCursors:Map<number,PageCursor>;
  queueNodes:Map<string,HTMLButtonElement>;queueObserver:IntersectionObserver|null;queueController:AbortController|null;
  queuePromise:Promise<QueuePage|null>|null;queueToken:number;queueLoading:boolean;queueLoadingDirection:string|null;
  queueError:{page:number;direction:string;message:string}|null;itemIndex:number;partIndex:number;loadingToken:number;
  deliveryMode:string;alistBrowserConfigured:boolean;deliveryAttemptId:string|null;deliveryStatus:PlaybackDeliveryViewStatus;deliveryController:AbortController|null;
  metadataReported:Set<string>;metadataReporting:Set<string>;metadataControllers:Map<string,AbortController>;metadataRetryTimers:Map<string,ReturnType<typeof setTimeout>>;
  progressTimer:ReturnType<typeof setInterval>|null;continuous:boolean;preferences:Preferences|null;drawerOpen:boolean;swipeChanging:boolean;
  swipe:{pointerId:number|null;startX:number;startY:number;deltaX:number;deltaY:number;tracking:boolean};
  trigger:HTMLElement|null;focusBvid:string|null;libraryContext:ArchiveContext|null;
  search:{query:string;shownQuery:string;page:number;total:number;hasMore:boolean;items:Item[];nodes:Map<string,HTMLButtonElement>;
    timer:ReturnType<typeof setTimeout>|null;controller:AbortController|null;token:number;loading:boolean;error:{page:number;message:string}|null};
}
interface Options {
  root: Document; api: ApiClient;
  openModal(id:string, trigger?:HTMLElement|null):void;closeModal(id:string):unknown;
  showToast(message:string,kind?:'success'|'error'):void;
  favoriteContext():{userId:string;mediaId:number}|null;
}
export function createPlayback({root:document,api,openModal,closeModal,showToast,favoriteContext}:Options) {
  const fetchJson=api.request;const fetchJsonSilent=api.silent;
  const elements = {
    playbackArt: requireElement(document, '#playbackArt', HTMLDivElement),
    playbackStage: requireElement(document, '#playbackStage', HTMLElement),
    playbackImmersiveQueueBtn: requireElement(document, '#playbackImmersiveQueueBtn', HTMLButtonElement),
    playbackDrawerBackdrop: requireElement(document, '#playbackDrawerBackdrop', HTMLElement),
    playbackQueueList: requireElement(document, '#playbackQueueList', HTMLElement),
    playbackSearchInput: requireElement(document, '#playbackSearchInput', HTMLInputElement),
    playbackMessageTitle: requireElement(document, '#playbackMessageTitle', HTMLElement),
    playbackMessageDetail: requireElement(document, '#playbackMessageDetail', HTMLElement),
    playbackPreviousBtn: requireElement(document, '#playbackPreviousBtn', HTMLButtonElement),
    playbackNextBtn: requireElement(document, '#playbackNextBtn', HTMLButtonElement),
    playbackContinuousBtn: requireElement(document, '#playbackContinuousBtn', HTMLButtonElement),
    playbackPartList: requireElement(document, '#playbackPartList', HTMLElement),
    playbackModal: requireElement(document, '#playbackModal', HTMLElement),
    playbackMobilePortraitBtn: requireElement(document, '#playbackMobilePortraitBtn', HTMLButtonElement),
    closePlaybackImmersiveBtn: requireElement(document, '#closePlaybackImmersiveBtn', HTMLButtonElement),
    playbackSearchControls: requireElement(document, '#playbackSearchControls', HTMLElement),
    playbackSearchStatus: requireElement(document, '#playbackSearchStatus', HTMLElement),
    playbackQueueHeading: requireElement(document, '#playbackQueueHeading', HTMLElement),
    playbackQueueCount: requireElement(document, '#playbackQueueCount', HTMLElement),
    playbackNowMeta: requireElement(document, '#playbackNowMeta', HTMLElement),
    playbackImmersiveAlistLink: requireElement(document, '#playbackImmersiveAlistLink', HTMLAnchorElement),
    playbackImmersiveTitle: requireElement(document, '#playbackImmersiveTitle', HTMLElement),
    playbackImmersiveDetail: requireElement(document, '#playbackImmersiveDetail', HTMLElement),
    playbackDialogTitle: requireElement(document, '#playbackDialogTitle', HTMLElement),
    playbackNowTitle: requireElement(document, '#playbackNowTitle', HTMLElement),
    playbackImmersivePosition: requireElement(document, '#playbackImmersivePosition', HTMLElement),
    closePlaybackBtn: requireElement(document, '#closePlaybackBtn', HTMLButtonElement),
    playbackImmersiveExitBtn: requireElement(document, '#playbackImmersiveExitBtn', HTMLButtonElement),
    playbackQueueCloseBtn: requireElement(document, '#playbackQueueCloseBtn', HTMLButtonElement),
    playbackSearchClearBtn: requireElement(document, '#playbackSearchClearBtn', HTMLButtonElement),
    playbackRetryBtn: requireElement(document, '#playbackRetryBtn', HTMLButtonElement),
    playbackSkipBtn: requireElement(document, '#playbackSkipBtn', HTMLButtonElement),
  };
  const PLAYBACK_STORAGE_KEY='bfb-playback-v1';
  let artplayerLoader: Promise<typeof ArtplayerInstance> | null = null;
    const playbackState: PlaybackState = {
      art: null,
      userId: null,
      mediaId: null,
      mode: 'favorite',
      page: 1,
      pageSize: 50,
      total: 0,
      focusIndex: -1,
      items: [],
      pages: new Map(),
      pageCursors: new Map(),
      queueNodes: new Map(),
      queueObserver: null,
      queueController: null,
      queuePromise: null,
      queueToken: 0,
      queueLoading: false,
      queueLoadingDirection: null,
      queueError: null,
      itemIndex: 0,
      partIndex: 0,
      loadingToken: 0,
      deliveryMode: 'auto',
      alistBrowserConfigured: false,
      deliveryAttemptId: null,
      deliveryStatus: 'pending',
      deliveryController: null,
      metadataReported: new Set(),
      metadataReporting: new Set(),
      metadataControllers: new Map(),
      metadataRetryTimers: new Map(),
      progressTimer: null,
      continuous: true,
      preferences: null,
      drawerOpen: false,
      swipeChanging: false,
      swipe: {
        pointerId: null,
        startX: 0,
        startY: 0,
        deltaX: 0,
        deltaY: 0,
        tracking: false
      },
      trigger: null,
      focusBvid: null,
      libraryContext: null,
      search: {
        query: '',
        shownQuery: '',
        page: 0,
        total: 0,
        hasMore: false,
        items: [],
        nodes: new Map(),
        timer: null,
        controller: null,
        token: 0,
        loading: false,
        error: null
      }
    };
  let events:AbortController|null=null;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const frames=new Set<number>();
  function later(callback:()=>void,delay:number) {const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);}
  function frame(callback:()=>void) {const id=requestAnimationFrame(()=>{frames.delete(id);callback();});frames.add(id);}
  function safeText(value:unknown,fallback='未知'){return String(value??'').trim()||fallback;}
  function localCoverUrl(item:{coverLocalPath?:string}|null){const path=(item?.coverLocalPath||'').trim();return path?'/'+path.split('/').filter(Boolean).join('/'):'';}
  function setHidden(target:string|HTMLElement|null,hidden:boolean){const el=typeof target==='string'?document.getElementById(target):target;el?.classList.toggle('is-hidden',hidden);}
  function appendUniqueItems<T>(target:T[],incoming:T[],keyOf:(item:T)=>string){const seen=new Set(target.map(keyOf));return incoming.filter(item=>{const key=keyOf(item);if(!key||seen.has(key))return false;seen.add(key);return true;});}
    function loadPlaybackPreferences(): Preferences {
      const fallback: Preferences = {
        version: 1,
        volume: 0.8,
        muted: false,
        rate: 1,
        continuous: true,
        mobilePortraitMode: true,
        progress: {}
      };
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(PLAYBACK_STORAGE_KEY) || 'null');
        if (!isRecord(parsed) || parsed.version !== 1) return fallback;
        const progress: Preferences['progress'] = {};
        if (isRecord(parsed.progress)) for (const [key, value] of Object.entries(parsed.progress)) {
          if (isRecord(value) && typeof value.time === 'number' && Number.isFinite(value.time) && value.time >= 0 && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) {
            progress[key] = {time:value.time, updatedAt:value.updatedAt};
          }
        }
        return {
          version: 1,
          volume: Number.isFinite(Number(parsed.volume)) ? Math.min(1, Math.max(0, Number(parsed.volume))) : fallback.volume,
          muted: Boolean(parsed.muted),
          rate: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(Number(parsed.rate)) ? Number(parsed.rate) : 1,
          continuous: parsed.continuous !== false,
          mobilePortraitMode: parsed.mobilePortraitMode !== false,
          progress
        };
      } catch (_) {
        return fallback;
      }
    }

    function persistPlaybackPreferences() {
      const prefs = playbackState.preferences;
      if (!prefs) return;
      const entries = Object.entries(prefs.progress || {})
        .filter((entry) => entry[1] && Number.isFinite(Number(entry[1].updatedAt)))
        .sort((left, right) => Number(right[1].updatedAt) - Number(left[1].updatedAt))
        .slice(0, 500);
      prefs.progress = Object.fromEntries(entries);
      try {
        localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(prefs));
      } catch (_) {
        // Playback continues when private browsing or storage quotas block persistence.
      }
    }

    function currentPlaybackItem() {
      return playbackState.items[playbackState.itemIndex] || null;
    }

    function currentPlaybackPart() {
      const item = currentPlaybackItem();
      return item && item.parts ? item.parts[playbackState.partIndex] || null : null;
    }

    function savePlaybackProgress() {
      const art = playbackState.art;
      const part = currentPlaybackPart();
      const prefs = playbackState.preferences;
      if (!art || !part || !prefs) return;
      const currentTime = Number(art.currentTime || 0);
      const duration = Number(art.duration || 0);
      if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return;
      if (currentTime < 10 || duration - currentTime < 15) {
        delete prefs.progress[part.fingerprint];
      } else {
        prefs.progress[part.fingerprint] = { time: currentTime, updatedAt: Date.now() };
      }
      prefs.volume = Number(art.volume || 0);
      prefs.muted = Boolean(art.muted);
      prefs.rate = Number(art.playbackRate || 1);
      persistPlaybackPreferences();
      updateMediaSessionPosition();
    }

    function destroyCurrentArt() {
      if (!playbackState.art) return;
      const art = playbackState.art;
      playbackState.art = null;
      try { art.destroy(true); } catch (_) {}
      elements.playbackArt.replaceChildren();
    }

    function clearMediaSession() {
      if (!('mediaSession' in navigator)) return;
      try {
        (['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] satisfies MediaSessionAction[]).forEach((action) => {
          navigator.mediaSession.setActionHandler(action, null);
        });
        navigator.mediaSession.metadata = null;
      } catch (_) {}
    }

    function destroyPlaybackSession() {
      for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const id of frames) cancelAnimationFrame(id); frames.clear();
      playbackState.loadingToken += 1;
      playbackState.queueToken += 1;
      playbackState.search.token += 1;
      if (playbackState.queueController) playbackState.queueController.abort();
      if (playbackState.search.controller) playbackState.search.controller.abort();
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      if (playbackState.search.timer) clearTimeout(playbackState.search.timer);
      if (playbackState.queueObserver) playbackState.queueObserver.disconnect();
      playbackState.queueController = null;
      playbackState.queuePromise = null;
      playbackState.search.controller = null;
      playbackState.search.timer = null;
      playbackState.queueObserver = null;
      playbackState.deliveryController = null;
      playbackState.deliveryAttemptId = null;
      playbackState.deliveryStatus = 'pending';
      playbackState.metadataReported.clear();
      playbackState.metadataReporting.clear();
      playbackState.metadataControllers.forEach((controller) => controller.abort());
      playbackState.metadataControllers.clear();
      playbackState.metadataRetryTimers.forEach((timer) => clearTimeout(timer));
      playbackState.metadataRetryTimers.clear();
      savePlaybackProgress();
      if (playbackState.progressTimer) clearInterval(playbackState.progressTimer);
      playbackState.progressTimer = null;
      destroyCurrentArt();
      clearMediaSession();
      const shell = requireElement(document, '.playback-shell', HTMLElement);
      shell.classList.remove('is-mobile-immersive', 'queue-open');
      const stage = elements.playbackStage;
      stage.classList.remove('is-portrait', 'is-swiping');
      stage.style.removeProperty('--playback-swipe-offset');
      const queue = requireElement(document, '.playback-queue', HTMLElement);
      queue.removeAttribute('inert');
      queue.setAttribute('aria-hidden', 'false');
      elements.playbackImmersiveQueueBtn.setAttribute('aria-expanded', 'false');
      elements.playbackDrawerBackdrop.tabIndex = -1;
      playbackState.drawerOpen = false;
      playbackState.swipeChanging = false;
      playbackState.swipe.pointerId = null;
      playbackState.swipe.tracking = false;
      playbackState.swipe.deltaX = 0;
      playbackState.swipe.deltaY = 0;
      playbackState.items = [];
      playbackState.pages.clear();
      playbackState.pageCursors.clear();
      playbackState.queueNodes.clear();
      playbackState.search.items = [];
      playbackState.search.nodes.clear();
      playbackState.search.query = '';
      playbackState.search.shownQuery = '';
      playbackState.search.page = 0;
      playbackState.search.total = 0;
      playbackState.search.hasMore = false;
      playbackState.search.loading = false;
      playbackState.search.error = null;
      playbackState.queueLoading = false;
      playbackState.queueLoadingDirection = null;
      playbackState.queueError = null;
      playbackState.userId = null;
      playbackState.mediaId = null;
      playbackState.trigger = null;
      playbackState.focusBvid = null;
      playbackState.libraryContext = null;
      const queueHost = elements.playbackQueueList;
      queueHost.replaceChildren();
      queueHost.scrollTop = 0;
      delete queueHost.dataset.queueKey;
      delete queueHost.dataset.queueView;
      const searchInput = elements.playbackSearchInput;
      if (searchInput) searchInput.value = '';
      setHidden('playbackSearchClearBtn', true);
      elements.playbackSearchStatus.textContent = '';
    }

    function loadArtplayer(): Promise<typeof ArtplayerInstance> {
      if (window.Artplayer) return Promise.resolve(window.Artplayer);
      if (artplayerLoader) return artplayerLoader;
      artplayerLoader = new Promise<typeof ArtplayerInstance>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/assets/vendor/artplayer-5.4.0.js';
        script.async = true;
        script.dataset.bfbArtplayer = '5.4.0';
        script.addEventListener('load', () => {
          if (window.Artplayer) resolve(window.Artplayer);
          else reject(new Error('播放器脚本加载完成但未能初始化'));
        }, { once:true });
        script.addEventListener('error', () => {
          script.remove();
          reject(new Error('播放器脚本加载失败，请重新登录后再试'));
        }, { once:true });
        document.head.appendChild(script);
      }).catch((error) => {
        artplayerLoader = null;
        throw error;
      });
      return artplayerLoader;
    }

    function setPlaybackMessage(title: string, detail: string, options: {retry?: boolean; skip?: boolean} = {}) {
      elements.playbackMessageTitle.textContent = title || '无法播放';
      elements.playbackMessageDetail.textContent = detail || '';
      setHidden('playbackRetryBtn', options.retry === false);
      setHidden('playbackSkipBtn', options.skip === false);
      setHidden('playbackStageMessage', false);
    }

    function hidePlaybackMessage() {
      setHidden('playbackStageMessage', true);
    }

    function playbackCoverUrl(item: Item | null) {
      return localCoverUrl(item) || (item && item.cover ? String(item.cover).replace('http://', 'https://') : '');
    }

    function updatePlaybackNavigation() {
      const item = currentPlaybackItem();
      const queuePosition = Number(item && item.queuePosition || 0);
      const hasPrevious = Boolean(item) && (playbackState.partIndex > 0
        || (playbackState.mode !== 'single' ? queuePosition > 1 : playbackState.itemIndex > 0));
      const hasNext = Boolean(item) && (playbackState.partIndex + 1 < item.parts.length
        || (playbackState.mode !== 'single' ? queuePosition < playbackState.total : playbackState.itemIndex + 1 < playbackState.items.length));
      elements.playbackPreviousBtn.disabled = !hasPrevious;
      elements.playbackNextBtn.disabled = !hasNext;
      const continuous = elements.playbackContinuousBtn;
      continuous.classList.toggle('active', playbackState.continuous);
      continuous.setAttribute('aria-pressed', String(playbackState.continuous));
    }

    function renderPlaybackParts() {
      const host = elements.playbackPartList;
      host.replaceChildren();
      const item = currentPlaybackItem();
      if (!item) return;
      item.parts.forEach((part, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'playback-part-button' + (index === playbackState.partIndex ? ' active' : '');
        button.setAttribute('aria-pressed', String(index === playbackState.partIndex));
        button.textContent = part.label || ('P' + (index + 1));
        const detail = [playbackQualityLabel(part), playbackCodecLabel(part)].filter(Boolean).join(' · ');
        button.title = detail || button.textContent;
        button.addEventListener('click', () => {
          if (index === playbackState.partIndex) return;
          savePlaybackProgress();
          playbackState.partIndex = index;
          playCurrentSelection(true);
        });
        host.appendChild(button);
      });
    }

    function playbackQueueRenderKey() {
      return [
        playbackState.userId || '',
        playbackState.mediaId || '',
        playbackState.mode,
        playbackState.libraryContext ? JSON.stringify(playbackState.libraryContext) : '',
        ...Array.from(playbackState.pages.keys()).sort((left, right) => left - right)
      ].join(':');
    }

    function isPlaybackMobileLayout() {
      return window.matchMedia('(max-width: 720px)').matches;
    }

    function isPlaybackPortraitViewport() {
      return window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
    }

    function isPlaybackImmersiveActive() {
      const modal = elements.playbackModal;
      const prefs = playbackState.preferences;
      return Boolean(
        modal.classList.contains('active')
        && prefs
        && prefs.mobilePortraitMode !== false
        && isPlaybackPortraitViewport()
      );
    }

    function syncPlaybackMobileModeButton() {
      const enabled = !playbackState.preferences || playbackState.preferences.mobilePortraitMode !== false;
      const button = elements.playbackMobilePortraitBtn;
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-pressed', String(enabled));
      button.title = enabled ? '沉浸竖屏已开启，设备横屏时自动使用普通布局' : '开启沉浸竖屏';
    }

    function setPlaybackQueueDrawer(open: boolean) {
      const shell = requireElement(document, '.playback-shell', HTMLElement);
      const queue = requireElement(document, '.playback-queue', HTMLElement);
      const queueButton = elements.playbackImmersiveQueueBtn;
      const immersive = isPlaybackImmersiveActive();
      const nextOpen = Boolean(open && immersive);
      if (!nextOpen && queue.contains(document.activeElement) && immersive) {
        queueButton.focus({ preventScroll:true });
      }
      playbackState.drawerOpen = nextOpen;
      shell.classList.toggle('queue-open', nextOpen);
      queueButton.setAttribute('aria-expanded', String(nextOpen));
      if (immersive && !nextOpen) queue.setAttribute('inert', '');
      else queue.removeAttribute('inert');
      queue.setAttribute('aria-hidden', String(immersive && !nextOpen));
      elements.playbackDrawerBackdrop.tabIndex = nextOpen ? 0 : -1;
      setupPlaybackQueueObserver();
      if (nextOpen) {
        syncPlaybackQueueSelection({ forceQueue:true, alignDesktop:true, behavior:'auto' });
      }
    }

    function syncPlaybackImmersiveMode() {
      const shell = requireElement(document, '.playback-shell', HTMLElement);
      const active = isPlaybackImmersiveActive();
      shell.classList.toggle('is-mobile-immersive', active);
      syncPlaybackMobileModeButton();
      if (!active) {
        playbackState.drawerOpen = false;
        shell.classList.remove('queue-open');
        const queue = requireElement(document, '.playback-queue', HTMLElement);
        queue.removeAttribute('inert');
        queue.setAttribute('aria-hidden', 'false');
        elements.playbackImmersiveQueueBtn.setAttribute('aria-expanded', 'false');
        elements.playbackDrawerBackdrop.tabIndex = -1;
        resetPlaybackSwipe();
      } else if (!playbackState.drawerOpen) {
        const queue = requireElement(document, '.playback-queue', HTMLElement);
        queue.setAttribute('inert', '');
        queue.setAttribute('aria-hidden', 'true');
      }
      setupPlaybackQueueObserver();
      return active;
    }

    function setPlaybackMobilePortraitMode(enabled: boolean) {
      if (!playbackState.preferences) playbackState.preferences = loadPlaybackPreferences();
      playbackState.preferences.mobilePortraitMode = Boolean(enabled);
      persistPlaybackPreferences();
      const active = syncPlaybackImmersiveMode();
      if (active) {
        later(() => elements.closePlaybackImmersiveBtn.focus({ preventScroll:true }), 0);
      }
    }

    function resetPlaybackSwipe() {
      const swipe = playbackState.swipe;
      const stage = elements.playbackStage;
      swipe.pointerId = null;
      swipe.startX = 0;
      swipe.startY = 0;
      swipe.deltaX = 0;
      swipe.deltaY = 0;
      swipe.tracking = false;
      stage.classList.remove('is-swiping');
      stage.style.removeProperty('--playback-swipe-offset');
    }

    function playbackSwipeStartsOnControl(target: EventTarget | null) {
      if (!(target instanceof Element)) return true;
      return Boolean(target.closest([
        'button',
        'input',
        'select',
        'textarea',
        'a',
        '[role="button"]',
        '[contenteditable="true"]',
        '.art-controls',
        '.art-setting',
        '.art-selector',
        '.art-contextmenus',
        '.art-info',
        '.art-notice'
      ].join(',')));
    }

    function handlePlaybackSwipeStart(event: PointerEvent) {
      if (!isPlaybackImmersiveActive() || playbackState.drawerOpen || playbackState.swipeChanging) return;
      if (!event.isPrimary || event.button !== 0 || playbackSwipeStartsOnControl(event.target)) return;
      const swipe = playbackState.swipe;
      swipe.pointerId = event.pointerId;
      swipe.startX = event.clientX;
      swipe.startY = event.clientY;
      swipe.deltaX = 0;
      swipe.deltaY = 0;
      swipe.tracking = true;
      try { (event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)); } catch (_) {}
    }

    function handlePlaybackSwipeMove(event: PointerEvent) {
      const swipe = playbackState.swipe;
      if (!swipe.tracking || swipe.pointerId !== event.pointerId) return;
      swipe.deltaX = event.clientX - swipe.startX;
      swipe.deltaY = event.clientY - swipe.startY;
      const vertical = Math.abs(swipe.deltaY) > 10 && Math.abs(swipe.deltaY) > Math.abs(swipe.deltaX) * 1.2;
      if (!vertical) return;
      event.preventDefault();
      const stage = elements.playbackStage;
      stage.classList.add('is-swiping');
      const offset = Math.max(-48, Math.min(48, swipe.deltaY * 0.35));
      stage.style.setProperty('--playback-swipe-offset', offset + 'px');
    }

    function handlePlaybackSwipeEnd(event: PointerEvent) {
      const swipe = playbackState.swipe;
      if (!swipe.tracking || swipe.pointerId !== event.pointerId) return;
      const deltaX = swipe.deltaX;
      const deltaY = swipe.deltaY;
      const shouldChange = Math.abs(deltaY) >= 72 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25;
      resetPlaybackSwipe();
      if (!shouldChange || playbackState.swipeChanging) return;
      playbackState.swipeChanging = true;
      void stepPlayback(deltaY < 0 ? 1 : -1).finally(() => {
        playbackState.swipeChanging = false;
      });
    }

    function handlePlaybackSwipeCancel(event: PointerEvent) {
      if (playbackState.swipe.pointerId === event.pointerId) resetPlaybackSwipe();
    }

    function isPlaybackSearchView() {
      return playbackState.mode !== 'single' && Boolean(playbackState.search.shownQuery);
    }

    function playbackPageBounds() {
      const pages = Array.from(playbackState.pages.keys()).sort((left, right) => left - right);
      return {
        first: pages.length ? pages[0] : 1,
        last: pages.length ? pages[pages.length - 1] : 0
      };
    }

    function playbackPageCursor(page: number) {
      return playbackState.pageCursors.get(Number(page || 0)) || null;
    }

    function createPlaybackThumbnail(item: Item) {
      const thumb = document.createElement('span');
      thumb.className = 'playback-queue-thumb';
      const placeholder = document.createElement('span');
      placeholder.className = 'playback-queue-placeholder';
      placeholder.textContent = 'B';
      placeholder.setAttribute('aria-hidden', 'true');
      thumb.appendChild(placeholder);
      const local = localCoverUrl(item);
      const remote = item && item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const sources = [...new Set([local, remote].filter(Boolean))];
      if (!sources.length) return thumb;
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let sourceIndex = 0;
      image.addEventListener('load', () => placeholder.classList.add('is-hidden'));
      image.addEventListener('error', () => {
        sourceIndex += 1;
        if (sourceIndex < sources.length) {
          image.src = sources[sourceIndex];
          return;
        }
        image.remove();
        placeholder.classList.remove('is-hidden');
      });
      image.src = sources[0];
      thumb.appendChild(image);
      return thumb;
    }

    function createPlaybackQueueNode(item: Item, view: string) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'playback-queue-item';
      button.dataset.playbackQueueBvid = item.bvid;
      button.dataset.playbackQueueView = view;
      const number = document.createElement('span');
      number.className = 'playback-queue-number';
      number.textContent = playbackState.mode === 'single' ? 'H' : String(Number(item.queuePosition || 0)).padStart(2, '0');
      const copy = document.createElement('span');
      copy.className = 'playback-queue-copy';
      const title = document.createElement('span');
      title.className = 'playback-queue-title';
      title.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('span');
      meta.className = 'playback-queue-meta';
      meta.textContent = item.parts.length + ' 个分P' + (item.partial ? ' · 部分备份' : '') + ' · ' + safeText(item.upperName, '未知UP');
      copy.appendChild(title);
      copy.appendChild(meta);
      button.appendChild(number);
      button.appendChild(createPlaybackThumbnail(item));
      button.appendChild(copy);
      button.addEventListener('click', async () => {
        if (view === 'search') {
          await selectPlaybackSearchResult(item, button);
          return;
        }
        const index = playbackState.items.findIndex((candidate) => candidate.bvid === item.bvid);
        if (index < 0) return;
        if (index === playbackState.itemIndex && playbackState.partIndex === 0) {
          setPlaybackQueueDrawer(false);
          return;
        }
        savePlaybackProgress();
        playbackState.itemIndex = index;
        playbackState.partIndex = 0;
        await playCurrentSelection(true);
        setPlaybackQueueDrawer(false);
      });
      return button;
    }

    function setPlaybackQueueFeedback(element: HTMLElement | null, text: string, retry?: (()=>void) | null) {
      if (!element) return;
      element.replaceChildren();
      if (text) element.append(document.createTextNode(text));
      if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.addEventListener('click', retry);
        element.appendChild(button);
      }
    }

    function updatePlaybackSearchHeader() {
      const controls = elements.playbackSearchControls;
      setHidden(controls, playbackState.mode === 'single');
      const search = playbackState.search;
      setHidden('playbackSearchClearBtn', !String(search.query || '').trim());
      const status = elements.playbackSearchStatus;
      status.replaceChildren();
      if (playbackState.mode === 'single') {
        return;
      } else if (search.loading) {
        status.textContent = search.shownQuery ? '正在搜索，保留当前结果' : '正在搜索';
      } else if (search.error) {
        status.textContent = search.shownQuery ? '搜索失败，保留上次结果' : '搜索失败';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => runPlaybackSearch(search.query || search.shownQuery, 1, false));
        status.appendChild(retry);
      } else if (search.shownQuery) {
        status.textContent = search.total + ' 个结果';
      } else {
        status.textContent = '';
      }
    }

    function updatePlaybackQueueFeedback() {
      const host = elements.playbackQueueList;
      const top = host.querySelector<HTMLElement>('[data-playback-boundary="top"]');
      const bottom = host.querySelector<HTMLElement>('[data-playback-boundary="bottom"]');
      if (isPlaybackSearchView()) {
        setPlaybackQueueFeedback(top, '', null);
        const search = playbackState.search;
        if (search.loading && search.page > 0) setPlaybackQueueFeedback(bottom, '正在加载更多结果', null);
        else if (search.error && search.error.page > 1) {
          const failedPage = search.error.page;
          setPlaybackQueueFeedback(bottom, '更多结果加载失败', () => runPlaybackSearch(search.shownQuery, failedPage, true));
        } else setPlaybackQueueFeedback(bottom, '', null);
        return;
      }
      const error = playbackState.queueError;
      const loadingDirection = playbackState.queueLoadingDirection;
      if (error && error.direction === 'prepend') {
        setPlaybackQueueFeedback(top, '前面的队列加载失败', () => loadPlaybackQueuePage(error.page, { direction:'prepend' }).catch(() => undefined));
      } else {
        setPlaybackQueueFeedback(top, loadingDirection === 'prepend' ? '正在加载前面的归档' : '', null);
      }
      if (error && error.direction === 'append') {
        setPlaybackQueueFeedback(bottom, '后面的队列加载失败', () => loadPlaybackQueuePage(error.page, { direction:'append' }).catch(() => undefined));
      } else {
        setPlaybackQueueFeedback(bottom, loadingDirection === 'append' ? '正在加载更多归档' : '', null);
      }
    }

    function createPlaybackQueueBoundary(direction: string) {
      const boundary = document.createElement('div');
      boundary.className = 'playback-queue-feedback';
      boundary.dataset.playbackBoundary = direction;
      return boundary;
    }

    function renderPlaybackQueueStructure(view: string) {
      const host = elements.playbackQueueList;
      host.replaceChildren();
      host.appendChild(createPlaybackQueueBoundary('top'));
      const items = view === 'search' ? playbackState.search.items : playbackState.items;
      const nodeMap = view === 'search' ? playbackState.search.nodes : playbackState.queueNodes;
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'playback-queue-empty';
        empty.textContent = view === 'search' ? '没有匹配的可播放归档' : '当前没有可播放归档';
        host.appendChild(empty);
      } else {
        for (const item of items) {
          let node = nodeMap.get(item.bvid);
          if (!node) {
            node = createPlaybackQueueNode(item, view);
            nodeMap.set(item.bvid, node);
          }
          host.appendChild(node);
        }
      }
      host.appendChild(createPlaybackQueueBoundary('bottom'));
      host.dataset.queueView = view;
      host.dataset.queueKey = view === 'search' ? 'search:' + playbackState.search.shownQuery : playbackQueueRenderKey();
      updatePlaybackQueueFeedback();
      setupPlaybackQueueObserver();
    }

    function syncPlaybackQueueSelection(options: {alignDesktop?: boolean; behavior?: ScrollBehavior; forceQueue?: boolean} = {}) {
      const host = elements.playbackQueueList;
      const item = currentPlaybackItem();
      const activeBvid = item ? item.bvid : '';
      const buttons = host.querySelectorAll<HTMLElement>('.playback-queue-item');
      buttons.forEach((button) => {
        const active = button.dataset.playbackQueueBvid === activeBvid;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });

      if ((isPlaybackMobileLayout() && options.forceQueue !== true) || options.alignDesktop === false) return;
      frame(() => {
        const active = host.querySelector<HTMLElement>('.playback-queue-item.active');
        if (!active || !host.isConnected) return;
        const hostRect = host.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const margin = 7;
        let delta = 0;
        if (activeRect.top < hostRect.top + margin) delta = activeRect.top - hostRect.top - margin;
        else if (activeRect.bottom > hostRect.bottom - margin) delta = activeRect.bottom - hostRect.bottom + margin;
        if (!delta) return;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        host.scrollTo({
          top: Math.max(0, host.scrollTop + delta),
          behavior: options.behavior || (reducedMotion ? 'auto' : 'smooth')
        });
      });
    }

    function setupPlaybackQueueObserver() {
      if (playbackState.queueObserver) playbackState.queueObserver.disconnect();
      playbackState.queueObserver = null;
      if (typeof IntersectionObserver !== 'function' || playbackState.mode === 'single') return;
      const host = elements.playbackQueueList;
      const root = isPlaybackImmersiveActive()
        ? host
        : (isPlaybackMobileLayout() ? document.querySelector<HTMLElement>('.playback-layout') : host);
      if (!root) return;
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const direction = entry.target instanceof HTMLElement ? entry.target.dataset.playbackBoundary : undefined;
          if (isPlaybackSearchView()) {
            const search = playbackState.search;
            if (direction === 'bottom' && search.hasMore && !search.loading && search.query === search.shownQuery) {
              runPlaybackSearch(search.shownQuery, search.page + 1, true);
            }
            continue;
          }
          if (playbackState.queueLoading) continue;
          const bounds = playbackPageBounds();
          const firstCursor = playbackPageCursor(bounds.first);
          const lastCursor = playbackPageCursor(bounds.last);
          const canLoadPrevious = playbackState.mode === 'library'
            ? Boolean(firstCursor?.hasPrevious && firstCursor.previousCursor)
            : bounds.first > 1;
          const canLoadMore = playbackState.mode === 'library'
            ? Boolean(lastCursor?.hasMore && lastCursor.nextCursor)
            : bounds.last * playbackState.pageSize < playbackState.total;
          if (direction === 'top' && canLoadPrevious) {
            loadPlaybackQueuePage(bounds.first - 1, { direction:'prepend' }).catch(() => undefined);
          } else if (direction === 'bottom' && canLoadMore) {
            loadPlaybackQueuePage(bounds.last + 1, { direction:'append' }).catch(() => undefined);
          }
        }
      }, { root, rootMargin:'140px 0px' });
      host.querySelectorAll('[data-playback-boundary]').forEach((boundary) => observer.observe(boundary));
      playbackState.queueObserver = observer;
    }

    function rebuildPlaybackItems(selectedBvid?: string) {
      const current = selectedBvid || currentPlaybackItem()?.bvid;
      const seen = new Set();
      playbackState.items = Array.from(playbackState.pages.entries())
        .sort((left, right) => left[0] - right[0])
        .flatMap((entry) => entry[1])
        .filter((item) => {
          if (!item || seen.has(item.bvid)) return false;
          seen.add(item.bvid);
          return true;
        })
        .sort((left, right) => Number(left.queuePosition || 0) - Number(right.queuePosition || 0));
      const index = current ? playbackState.items.findIndex((item) => item.bvid === current) : -1;
      playbackState.itemIndex = index >= 0 ? index : Math.min(playbackState.itemIndex, Math.max(0, playbackState.items.length - 1));
      playbackState.items.forEach((item, itemIndex) => {
        const node = playbackState.queueNodes.get(item.bvid);
        if (node) node.dataset.playbackQueueIndex = String(itemIndex);
      });
    }

    function insertPlaybackQueueItems(items: Item[], direction: string) {
      const host = elements.playbackQueueList;
      if (host.dataset.queueView !== 'normal') return;
      const bottom = host.querySelector<HTMLElement>('[data-playback-boundary="bottom"]');
      if (!bottom) return;
      const beforeHeight = host.scrollHeight;
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        let node = playbackState.queueNodes.get(item.bvid);
        if (!node) {
          node = createPlaybackQueueNode(item, 'normal');
          playbackState.queueNodes.set(item.bvid, node);
        }
        if (!node.isConnected) fragment.appendChild(node);
      }
      if (!fragment.childNodes.length) return;
      if (direction === 'prepend') {
        const firstItem = host.querySelector<HTMLElement>('.playback-queue-item');
        host.insertBefore(fragment, firstItem || bottom);
        if (!isPlaybackMobileLayout() || isPlaybackImmersiveActive()) host.scrollTop += host.scrollHeight - beforeHeight;
      } else {
        host.insertBefore(fragment, bottom);
      }
    }

    function applyPlaybackQueuePage(data: QueuePage, options: {page?: number; reset?: boolean; selectedBvid?: string; render?: boolean; direction?: string} = {}) {
      const page = Number(data.page || options.page || 1);
      const pageItems = (Array.isArray(data.items) ? data.items : []).map((item, index) => ({
        ...item,
        queuePosition: Number(item.queuePosition || ((page - 1) * playbackState.pageSize + index + 1))
      }));
      const selectedBvid = options.selectedBvid || currentPlaybackItem()?.bvid;
      if (options.reset) {
        playbackState.pages.clear();
        playbackState.pageCursors.clear();
        playbackState.queueNodes.clear();
        playbackState.items = [];
      }
      playbackState.mode = data.mode || 'favorite';
      playbackState.page = page;
      playbackState.total = Number(data.total || 0);
      playbackState.focusIndex = Number(data.focusIndex ?? -1);
      playbackState.pages.set(page, pageItems);
      playbackState.pageCursors.set(page, {
        hasPrevious:Boolean(data.hasPrevious ?? page > 1),
        previousCursor:data.previousCursor || null,
        hasMore:Boolean(data.hasMore),
        nextCursor:data.nextCursor || null
      });
      rebuildPlaybackItems(selectedBvid);
      if (options.selectedBvid) {
        const selectedIndex = playbackState.items.findIndex((item) => item.bvid === options.selectedBvid);
        if (selectedIndex >= 0) playbackState.itemIndex = selectedIndex;
      }
      if (options.render === false) return;
      if (options.reset || elements.playbackQueueList.dataset.queueView !== 'normal') {
        renderPlaybackQueue(true);
      } else {
        insertPlaybackQueueItems(pageItems, options.direction || 'append');
        updatePlaybackQueueFeedback();
        setupPlaybackQueueObserver();
        syncPlaybackQueueSelection({ alignDesktop:false });
      }
    }

    function renderPlaybackQueue(force = false) {
      const host = elements.playbackQueueList;
      elements.playbackQueueHeading.textContent = playbackState.mode === 'library'
        ? '归档库顺序'
        : '收藏夹顺序';
      requireElement(document, '.playback-queue', HTMLElement).setAttribute(
        'aria-label',
        playbackState.mode === 'library' ? '归档库播放队列' : '收藏夹播放队列'
      );
      elements.playbackQueueCount.textContent = playbackState.mode === 'single'
        ? '历史记录 · 单独播放'
        : playbackState.total + ' 个视频';
      updatePlaybackSearchHeader();
      const view = isPlaybackSearchView() ? 'search' : 'normal';
      if (force || host.dataset.queueView !== view) renderPlaybackQueueStructure(view);
      else updatePlaybackQueueFeedback();
      syncPlaybackQueueSelection();
    }

    function playbackQualityLabel(part: Part | null) {
      if (!part) return '';
      const labels = [];
      if (part.bilibiliQuality) labels.push('B站' + String(part.bilibiliQuality));
      const actualQuality = String(part.actualQuality || part.quality || '');
      labels.push(actualQuality ? '实际' + actualQuality : '实际画质未知');
      const width = Math.round(Number(part.actualWidth || 0));
      const height = Math.round(Number(part.actualHeight || 0));
      if (width > 0 && height > 0) {
        const orientation = height > width ? '竖屏' : (width > height ? '横屏' : '方形');
        labels.push(width + '×' + height + ' ' + orientation);
      }
      return labels.join(' · ');
    }

    function playbackCodecLabel(part: Part | null) {
      if (!part) return '';
      return part.codec ? String(part.codec) : '';
    }

    function playbackDeliveryLabel() {
      if (playbackState.deliveryStatus === 'direct') return '网盘直连';
      if (playbackState.deliveryStatus === 'proxy') return 'BFB代理';
      if (playbackState.deliveryStatus === 'unknown') return '传输方式未知';
      return '检测传输中';
    }

    function playbackOpenInAlistUrl(part: Part | null) {
      if (!part || !playbackState.alistBrowserConfigured) return '';
      return playbackFileApiPath(part, '/open-in-alist');
    }

    function renderPlaybackMetadata() {
      const item = currentPlaybackItem();
      const part = currentPlaybackPart();
      const meta = [];
      if (part) {
        meta.push(part.label || ('P' + (playbackState.partIndex + 1)));
        meta.push(playbackQualityLabel(part));
        const codecLabel = playbackCodecLabel(part);
        if (codecLabel) meta.push(codecLabel);
        meta.push(playbackDeliveryLabel());
      }
      if (item && item.partial) meta.push('部分备份');
      const nowMeta = elements.playbackNowMeta;
      nowMeta.replaceChildren(document.createTextNode(meta.join(' · ')));
      const alistUrl = playbackOpenInAlistUrl(part);
      if (alistUrl) {
        nowMeta.appendChild(document.createTextNode(' · '));
        const link = document.createElement('a');
        link.href = alistUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '在网盘中查看 ↗';
        nowMeta.appendChild(link);
      }
      const immersiveAlist = elements.playbackImmersiveAlistLink;
      if (alistUrl) immersiveAlist.href = alistUrl;
      else immersiveAlist.removeAttribute('href');
      setHidden(immersiveAlist, !alistUrl);
      elements.playbackImmersiveTitle.textContent = item ? safeText(item.title || item.bvid, '未知视频') : '未选择视频';
      elements.playbackImmersiveDetail.textContent = meta.join(' · ');
    }

    function updatePlaybackNow() {
      const item = currentPlaybackItem();
      elements.playbackDialogTitle.textContent = item ? safeText(item.title || item.bvid, '收藏夹播放器') : '收藏夹播放器';
      elements.playbackNowTitle.textContent = item ? safeText(item.title || item.bvid, '未知视频') : '未选择视频';
      renderPlaybackMetadata();
      const queuePosition = Number(item && item.queuePosition || 0);
      const position = playbackState.mode !== 'single' && queuePosition
        ? queuePosition + ' / ' + playbackState.total
        : '历史记录';
      const partPosition = item && item.parts && item.parts.length > 1
        ? ' · P' + (playbackState.partIndex + 1) + ' / ' + item.parts.length
        : '';
      elements.playbackImmersivePosition.textContent = position + partPosition;
      renderPlaybackParts();
      renderPlaybackQueue();
      updatePlaybackNavigation();
    }

    function updateMediaSessionPosition() {
      if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
      const art = playbackState.art;
      if (!art) return;
      const duration = Number(art.duration || 0);
      const position = Number(art.currentTime || 0);
      const rate = Number(art.playbackRate || 1);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: rate > 0 ? rate : 1,
          position: Math.min(duration, Math.max(0, position))
        });
      } catch (_) {}
    }

    function setupMediaSession(item: Item, part: Part) {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      try {
        const cover = playbackCoverUrl(item);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: safeText(item.title || item.bvid, '归档视频') + (item.parts.length > 1 ? ' · ' + part.label : ''),
          artist: safeText(item.upperName, '未知UP'),
          album: 'BFB 收藏夹归档',
          artwork: cover ? [{ src:cover }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => playbackState.art && playbackState.art.play());
        navigator.mediaSession.setActionHandler('pause', () => playbackState.art && playbackState.art.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => stepPlayback(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => stepPlayback(1));
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          if (playbackState.art) playbackState.art.currentTime = Math.max(0, playbackState.art.currentTime - Number(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          if (playbackState.art) playbackState.art.currentTime = Math.min(playbackState.art.duration || Infinity, playbackState.art.currentTime + Number(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (playbackState.art && Number.isFinite(Number(details.seekTime))) playbackState.art.currentTime = Number(details.seekTime);
        });
      } catch (_) {}
    }

    function createPlaybackAttemptId() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }

    function playbackStreamUrl(part: Part, forceProxy: boolean, attemptId: string) {
      const params = new URLSearchParams();
      if (forceProxy) params.set('delivery', 'proxy');
      if (attemptId) params.set('attempt', attemptId);
      const query = params.toString();
      return part.streamUrl + (query ? (part.streamUrl.includes('?') ? '&' : '?') + query : '');
    }

    async function pollPlaybackDelivery(attemptId: string, token: number) {
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      const controller = new AbortController();
      playbackState.deliveryController = controller;
      const delays = [250, 500, 1000, 2000, 2000, 2000, 2000];
      try {
        for (const delay of delays) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, delay);
            controller.signal.addEventListener('abort', onAbort, { once:true });
          });
          if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
          const data = parsePlaybackDelivery(await fetchJson(playbackSourceApiPath('/playback/delivery/' + attemptId), { signal:controller.signal }));
          if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            data.status || 'pending',
            false
          );
          renderPlaybackMetadata();
          if (data.status && data.status !== 'pending') return;
        }
        if (token === playbackState.loadingToken && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && token === playbackState.loadingToken
          && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } finally {
        if (playbackState.deliveryController === controller) playbackState.deliveryController = null;
      }
    }

    function browserSupportsHevc(video: HTMLVideoElement) {
      if (!video || typeof video.canPlayType !== 'function') return false;
      try {
        return Boolean(video.canPlayType('video/mp4; codecs="hvc1"')
          || video.canPlayType('video/mp4; codecs="hev1"'));
      } catch (_) {
        return false;
      }
    }

    async function finalizePlaybackDelivery(attemptId: string, token: number) {
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      const controller = new AbortController();
      playbackState.deliveryController = controller;
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
        playbackState.deliveryStatus,
        'unknown',
        true
      );
      renderPlaybackMetadata();
      try {
        const data = parsePlaybackDelivery(await fetchJson(playbackSourceApiPath('/playback/delivery/' + attemptId), { signal:controller.signal }));
        if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
        playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
          playbackState.deliveryStatus,
          data.status || 'pending',
          true
        );
        renderPlaybackMetadata();
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && token === playbackState.loadingToken
          && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } finally {
        if (playbackState.deliveryController === controller) playbackState.deliveryController = null;
      }
    }

    function showFinalPlaybackError(title: string, detail: string, attemptId: string, token: number) {
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
        playbackState.deliveryStatus,
        'unknown',
        true
      );
      renderPlaybackMetadata();
      setPlaybackMessage(title, detail, { retry:true, skip:true });
      void finalizePlaybackDelivery(attemptId, token);
    }

    async function reportPlaybackMediaMetadata(part: Part, art: ArtplayerInstance, token: number, retryAttempt = 0) {
      if (!part || part.actualWidth || part.actualHeight || playbackState.metadataReported.has(part.fingerprint)
        || playbackState.metadataReporting.has(part.fingerprint) || playbackState.metadataRetryTimers.has(part.fingerprint)) return;
      const width = Number(art.video && art.video.videoWidth || 0);
      const height = Number(art.video && art.video.videoHeight || 0);
      const duration = Number(art.duration || 0);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16
        || !Number.isFinite(duration) || duration <= 0) return;
      playbackState.metadataReporting.add(part.fingerprint);
      const controller = new AbortController();
      playbackState.metadataControllers.set(part.fingerprint, controller);
      try {
        const data = parsePlaybackMetadata(await fetchJsonSilent(playbackFileApiPath(part, '/media-metadata'), {
          method:'PUT',
          headers:{ 'Content-Type':'application/json' },
          body:JSON.stringify({ fingerprint:part.fingerprint, width, height, duration }),
          signal:controller.signal
        }));
        if (token !== playbackState.loadingToken || currentPlaybackPart() !== part) return;
        const metadata = data.mediaMetadata || { width, height, duration, source:'browser' };
        part.actualWidth = Number(metadata.width || width);
        part.actualHeight = Number(metadata.height || height);
        part.actualQuality = String(data.actualQuality || '');
        part.quality = part.actualQuality;
        part.mediaMetadataSource = metadata.source || 'browser';
        playbackState.metadataReported.add(part.fingerprint);
        updatePlaybackNow();
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && retryAttempt < 1
          && token === playbackState.loadingToken && currentPlaybackPart() === part) {
          const timer = setTimeout(() => {
            playbackState.metadataRetryTimers.delete(part.fingerprint);
            if (token === playbackState.loadingToken && currentPlaybackPart() === part) {
              void reportPlaybackMediaMetadata(part, art, token, retryAttempt + 1);
            }
          }, 3000);
          playbackState.metadataRetryTimers.set(part.fingerprint, timer);
        }
      } finally {
        if (playbackState.metadataControllers.get(part.fingerprint) === controller) {
          playbackState.metadataControllers.delete(part.fingerprint);
          playbackState.metadataReporting.delete(part.fingerprint);
        }
      }
    }

    async function playCurrentSelection(autoplay: boolean, options: {forceProxy?: boolean; resumeTime?: number; attemptId?: string} = {}) {
      const item = currentPlaybackItem();
      const part = currentPlaybackPart();
      if (!item || !part) {
        setPlaybackMessage('没有可播放文件', '该条目的远端文件状态可能已经变化。', { retry:false, skip:true });
        return;
      }
      const forceProxy = playbackState.deliveryMode === 'proxy' || options.forceProxy === true;
      const resumeTime = Number(options.resumeTime || 0);
      const attemptId = options.attemptId || createPlaybackAttemptId();
      const token = ++playbackState.loadingToken;
      playbackState.metadataControllers.forEach((controller) => controller.abort());
      playbackState.metadataControllers.clear();
      playbackState.metadataReporting.clear();
      playbackState.metadataRetryTimers.forEach((timer) => clearTimeout(timer));
      playbackState.metadataRetryTimers.clear();
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      playbackState.deliveryController = null;
      const previousDeliveryStatus = attemptId === playbackState.deliveryAttemptId
        ? playbackState.deliveryStatus
        : 'pending';
      playbackState.deliveryAttemptId = attemptId;
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(previousDeliveryStatus, 'pending', false);
      destroyCurrentArt();
      updatePlaybackNow();
      void pollPlaybackDelivery(attemptId, token);
      setPlaybackMessage(
        '正在连接归档文件',
        forceProxy ? '正在通过 BFB 代理连接归档文件。' : '正在获取网盘直连，必要时将自动使用 BFB 代理。',
        { retry:false, skip:false }
      );
      try {
        const Artplayer = await loadArtplayer();
        if (token !== playbackState.loadingToken) return;
        const prefs = playbackState.preferences || loadPlaybackPreferences();
        const videoAttributes: {preload:'metadata'; playsinline:string; 'webkit-playsinline':string; referrerpolicy:string} = {preload:'metadata', playsinline:'', 'webkit-playsinline':'', referrerpolicy:'no-referrer'};
        const playerOptions = {
          container: elements.playbackArt,
          url: playbackStreamUrl(part, forceProxy, attemptId),
          title: safeText(item.title || item.bvid, '归档视频'),
          poster: playbackCoverUrl(item),
          theme: '#39C5BB',
          volume: prefs.volume,
          muted: prefs.muted,
          autoplay: Boolean(autoplay),
          playbackRate: true,
          aspectRatio: true,
          setting: true,
          pip: true,
          fullscreen: true,
          fullscreenWeb: true,
          playsInline: true,
          autoOrientation: true,
          hotkey: true,
          mutex: true,
          moreVideoAttr: videoAttributes
        };
        const art = new Artplayer(playerOptions);
        playbackState.art = art;
        function listenToPlayer(event: string, handler: () => void) {
          art.on(event, () => {
            if (token === playbackState.loadingToken && playbackState.art === art) handler();
          });
        }
        art.playbackRate = prefs.rate;
        let fallbackStarted = false;
        listenToPlayer('video:loadedmetadata', () => {
          if (token !== playbackState.loadingToken) return;
          const isPortrait = Number(art.video.videoHeight || 0) > Number(art.video.videoWidth || 0);
          elements.playbackStage.classList.toggle('is-portrait', isPortrait);
          const saved = prefs.progress && prefs.progress[part.fingerprint];
          const savedTime = Number(saved && saved.time || 0);
          const duration = Number(art.duration || 0);
          if (resumeTime > 0 && duration - resumeTime > 1) art.currentTime = resumeTime;
          else if (savedTime >= 10 && duration - savedTime >= 15) art.currentTime = savedTime;
          hidePlaybackMessage();
          updateMediaSessionPosition();
          void reportPlaybackMediaMetadata(part, art, token);
        });
        listenToPlayer('video:canplay', hidePlaybackMessage);
        listenToPlayer('video:pause', savePlaybackProgress);
        listenToPlayer('video:volumechange', () => {
          prefs.volume = Number(art.volume || 0);
          prefs.muted = Boolean(art.muted);
          persistPlaybackPreferences();
        });
        listenToPlayer('video:ratechange', () => {
          prefs.rate = Number(art.playbackRate || 1);
          persistPlaybackPreferences();
          updateMediaSessionPosition();
        });
        listenToPlayer('video:play', () => {
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; } catch (_) {}
        });
        listenToPlayer('video:pause', () => {
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch (_) {}
        });
        listenToPlayer('video:ended', () => {
          if (prefs.progress) delete prefs.progress[part.fingerprint];
          persistPlaybackPreferences();
          if (playbackState.continuous) stepPlayback(1, true);
        });
        listenToPlayer('video:error', () => {
          if (token !== playbackState.loadingToken) return;
          const mediaErrorCode = Number(art.video && art.video.error && art.video.error.code || 0);
          const action = decidePlaybackMediaError({
            mediaErrorCode,
            forceProxy,
            fallbackStarted,
            actualCodec:part.codec,
            requestedCodec:part.requestedCodec,
            browserSupportsHevc:browserSupportsHevc(art.video)
          });
          if (action === 'ignore') return;
          if (action === 'proxy') {
            fallbackStarted = true;
            const failedAt = Number(art.currentTime || 0);
            setPlaybackMessage('网盘直连暂时不可用', '正在切换为 BFB 代理播放。', { retry:false, skip:false });
            later(() => {
              if (token !== playbackState.loadingToken) return;
              void playCurrentSelection(true, { forceProxy:true, resumeTime:failedAt, attemptId });
            }, 0);
            return;
          }
          if (action === 'hevc') {
            const actualHevc = /hevc|h.265|h265|hev1|hvc1/i.test(String(part.codec || ''));
            showFinalPlaybackError(
              actualHevc ? '当前浏览器无法解码HEVC' : '此旧归档可能使用HEVC',
              actualHevc
                ? '请使用支持HEVC的Edge、Safari、系统浏览器或远端存储客户端。本项目不会转码视频。'
                : '该文件的下载目标为HEVC，但旧记录尚无实际编码。当前浏览器未报告HEVC支持，切换代理也不会改变编码。',
              attemptId,
              token
            );
            return;
          }
          if (action === 'decode') {
            showFinalPlaybackError(
              '归档视频解码失败',
              '当前浏览器无法解码该媒体，或文件使用了尚未识别的编码。BFB代理不会转码视频。',
              attemptId,
              token
            );
            return;
          }
          showFinalPlaybackError(
            forceProxy ? '归档视频传输失败' : '归档视频无法直接播放',
            forceProxy
              ? '网盘直连和BFB代理均未能提供浏览器可播放的媒体数据。'
              : '文件可能暂时不可见、会话已过期，或当前浏览器不支持此媒体来源。',
            attemptId,
            token
          );
        });
        setupMediaSession(item, part);
      } catch (error) {
        if (token !== playbackState.loadingToken) return;
        setPlaybackMessage('播放器初始化失败', error instanceof Error ? error.message : String(error), { retry:true, skip:true });
      }
    }

    function playbackLibraryContextParams() {
      const context: Partial<ArchiveContext> = playbackState.libraryContext || {};
      const params = new URLSearchParams({
        scope:String(context.scope || 'global'),
        q:String(context.query || ''),
        searchScope:String(context.searchScope || 'current'),
        filter:String(context.filter || 'all'),
        sort:String(context.sort || 'context')
      });
      if (context.userId) params.set('userId', String(context.userId));
      if (context.mediaId) params.set('mediaId', String(context.mediaId));
      return params;
    }

    function playbackQueueApiPath(suffix: string) {
      if (playbackState.mode === 'library') {
        const separator = suffix.indexOf('?');
        const pathname = separator >= 0 ? suffix.slice(0, separator) : suffix;
        const suffixParams = new URLSearchParams(separator >= 0 ? suffix.slice(separator + 1) : '');
        const params = playbackLibraryContextParams();
        suffixParams.forEach((value, key) => params.set(key, value));
        const query = params.toString();
        return '/api/archive-library' + pathname + (query ? '?' + query : '');
      }
      return '/api/users/' + encodeURIComponent(playbackState.userId || '') +
        '/favorites/' + playbackState.mediaId + suffix;
    }

    function playbackFileApiPath(part: Part, suffix: string) {
      if (!part) return '';
      return playbackSourceApiPath('/playback/files/' + Number(part.fileId) + suffix);
    }

    function playbackSourceApiPath(suffix: string) {
      const item = currentPlaybackItem();
      const source = item && item.source;
      const userId = source?.userId || playbackState.userId;
      const mediaId = Number(source?.mediaId || playbackState.mediaId || 0);
      if (!userId || !mediaId) return '';
      return '/api/users/' + encodeURIComponent(userId) + '/favorites/' + mediaId + suffix;
    }

    async function loadPlaybackQueuePage(page: number, options: {reset?: boolean; direction?: string; selectedBvid?: string} = {}): Promise<QueuePage | Item[] | null | undefined> {
      const normalizedPage = Math.max(1, Number(page || 1));
      if (playbackState.pages.has(normalizedPage) && !options.reset) return playbackState.pages.get(normalizedPage);
      if (playbackState.queueLoading) {
        const pending = playbackState.queuePromise;
        if (!pending) return null;
        await pending.catch(() => undefined);
        if (playbackState.pages.has(normalizedPage) && !options.reset) return playbackState.pages.get(normalizedPage);
        if (playbackState.queueLoading) return null;
        return loadPlaybackQueuePage(normalizedPage, options);
      }
      playbackState.queueLoading = true;
      playbackState.queueLoadingDirection = options.direction || 'append';
      playbackState.queueError = null;
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      updatePlaybackQueueFeedback();
      const operation = (async () => {
        try {
          const params = new URLSearchParams({ page:String(normalizedPage), pageSize:String(playbackState.pageSize) });
          if (playbackState.mode === 'library' && !options.reset) {
            const bounds = playbackPageBounds();
            if (normalizedPage === bounds.first - 1) {
              const boundary = playbackPageCursor(bounds.first);
              if (boundary?.previousCursor) {
                params.set('cursor', boundary.previousCursor);
                params.set('direction', 'before');
              }
            } else if (normalizedPage === bounds.last + 1) {
              const boundary = playbackPageCursor(bounds.last);
              if (boundary?.nextCursor) {
                params.set('cursor', boundary.nextCursor);
                params.set('direction', 'after');
              }
            }
          }
          const data = parsePlaybackQueuePage(await fetchJson(
            playbackQueueApiPath('/playback-queue?' + params.toString()),
            { signal:controller.signal }
          ));
          if (token !== playbackState.queueToken) return null;
          applyPlaybackQueuePage(data, {
            page: normalizedPage,
            direction: options.direction || 'append',
            reset: Boolean(options.reset),
            selectedBvid: options.selectedBvid
          });
          return data;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return null;
          if (token === playbackState.queueToken) {
            playbackState.queueError = {
              page: normalizedPage,
              direction: options.direction || 'append',
              message: error instanceof Error ? error.message : String(error)
            };
            updatePlaybackQueueFeedback();
          }
          throw error;
        } finally {
          if (token === playbackState.queueToken) {
            playbackState.queueLoading = false;
            playbackState.queueLoadingDirection = null;
            playbackState.queueController = null;
            updatePlaybackQueueFeedback();
            setupPlaybackQueueObserver();
          }
        }
      })();
      playbackState.queuePromise = operation;
      try {
        return await operation;
      } finally {
        if (playbackState.queuePromise === operation) playbackState.queuePromise = null;
      }
    }

    async function selectPlaybackQueuePosition(queuePosition: number, partIndex: number, autoplay: boolean) {
      const position = Math.max(1, Number(queuePosition || 1));
      let index = playbackState.items.findIndex((item) => Number(item.queuePosition) === position);
      if (index < 0) {
        const currentPosition = Number(currentPlaybackItem()?.queuePosition || 0);
        const page = Math.floor((position - 1) / playbackState.pageSize) + 1;
        await loadPlaybackQueuePage(page, { direction:position < currentPosition ? 'prepend' : 'append' });
        index = playbackState.items.findIndex((item) => Number(item.queuePosition) === position);
      }
      if (index < 0) throw new Error('播放队列已变化，请重新打开播放器');
      playbackState.itemIndex = index;
      const item = currentPlaybackItem();
      playbackState.page = Math.floor((position - 1) / playbackState.pageSize) + 1;
      playbackState.partIndex = item ? Math.min(Math.max(0, Number(partIndex || 0)), item.parts.length - 1) : 0;
      await playCurrentSelection(autoplay);
    }

    function clearPlaybackSearch(options: {render?: boolean} = {}) {
      const search = playbackState.search;
      search.token += 1;
      if (search.timer) clearTimeout(search.timer);
      if (search.controller) search.controller.abort();
      search.timer = null;
      search.controller = null;
      search.query = '';
      search.shownQuery = '';
      search.page = 0;
      search.total = 0;
      search.hasMore = false;
      search.items = [];
      search.nodes.clear();
      search.loading = false;
      search.error = null;
      const input = elements.playbackSearchInput;
      if (input) input.value = '';
      updatePlaybackSearchHeader();
      if (options.render !== false) renderPlaybackQueue(true);
    }

    function appendPlaybackSearchItems(items: Item[]) {
      const host = elements.playbackQueueList;
      if (host.dataset.queueView !== 'search') return;
      const bottom = host.querySelector<HTMLElement>('[data-playback-boundary="bottom"]');
      if (!bottom) return;
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        let node = playbackState.search.nodes.get(item.bvid);
        if (!node) {
          node = createPlaybackQueueNode(item, 'search');
          playbackState.search.nodes.set(item.bvid, node);
        }
        if (!node.isConnected) fragment.appendChild(node);
      }
      host.insertBefore(fragment, bottom);
    }

    async function runPlaybackSearch(query: string, page = 1, append = false) {
      const normalizedQuery = String(query || '').trim().slice(0, 80);
      if (!normalizedQuery || playbackState.mode === 'single') {
        clearPlaybackSearch();
        return;
      }
      const search = playbackState.search;
      if (search.controller) search.controller.abort();
      const controller = new AbortController();
      search.controller = controller;
      const token = ++search.token;
      search.loading = true;
      search.error = null;
      updatePlaybackSearchHeader();
      updatePlaybackQueueFeedback();
      try {
        const data = parsePlaybackSearchPage(await fetchJson(
          playbackQueueApiPath('/playback-search?' + (playbackState.mode === 'library' ? 'queueQ=' : 'q=') +
            encodeURIComponent(normalizedQuery) + '&page=' + page + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        ));
        if (token !== search.token || search.query !== normalizedQuery) return;
        const incoming = Array.isArray(data.items) ? data.items : [];
        const canAppend = append && search.shownQuery === normalizedQuery;
        if (canAppend) {
          const fresh = appendUniqueItems(search.items, incoming, (item) => item?.bvid);
          search.items.push(...fresh);
          appendPlaybackSearchItems(fresh);
        } else {
          search.items = appendUniqueItems([], incoming, (item) => item?.bvid);
          search.nodes.clear();
        }
        search.shownQuery = normalizedQuery;
        search.page = Number(data.page || page);
        search.total = Number(data.total || 0);
        search.hasMore = Boolean(data.hasMore);
        search.error = null;
        if (canAppend) {
          updatePlaybackQueueFeedback();
          setupPlaybackQueueObserver();
          syncPlaybackQueueSelection({ alignDesktop:false });
        } else {
          renderPlaybackQueue(true);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (token === search.token) {
          search.error = { page, message:error instanceof Error ? error.message : String(error) };
          updatePlaybackSearchHeader();
          updatePlaybackQueueFeedback();
        }
      } finally {
        if (token === search.token) {
          search.loading = false;
          search.controller = null;
          updatePlaybackSearchHeader();
          updatePlaybackQueueFeedback();
          if (isPlaybackSearchView()) setupPlaybackQueueObserver();
        }
      }
    }

    function schedulePlaybackSearch() {
      const search = playbackState.search;
      const input = elements.playbackSearchInput;
      const query = String(input.value || '').trim();
      search.query = query;
      if (search.timer) clearTimeout(search.timer);
      if (search.controller) search.controller.abort();
      search.token += 1;
      search.timer = null;
      search.controller = null;
      if (!query) {
        clearPlaybackSearch();
        return;
      }
      search.loading = true;
      search.error = null;
      updatePlaybackSearchHeader();
      search.timer = setTimeout(() => {
        search.timer = null;
        runPlaybackSearch(query, 1, false);
      }, 300);
    }

    async function selectPlaybackSearchResult(item: Item, trigger: HTMLElement) {
      if (!item || !item.bvid) return;
      const contextToken = playbackState.loadingToken;
      if (playbackState.queueLoading) {
        const pending = playbackState.queuePromise;
        if (pending) await pending.catch(() => undefined);
        if (contextToken !== playbackState.loadingToken) return;
        if (playbackState.queueLoading) return;
      }
      const previousBvid = currentPlaybackItem()?.bvid;
      const previousPart = playbackState.partIndex;
      playbackState.queueLoading = true;
      playbackState.search.loading = true;
      updatePlaybackSearchHeader();
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = parsePlaybackQueuePage(await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(item.bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        ));
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:item.bvid, render:false });
        playbackState.partIndex = previousBvid === item.bvid
          ? Math.min(previousPart, Math.max(0, (currentPlaybackItem()?.parts.length || 1) - 1))
          : 0;
        clearPlaybackSearch({ render:false });
        renderPlaybackQueue(true);
        if (document.activeElement === trigger) {
          const normalNode = playbackState.queueNodes.get(item.bvid);
          if (normalNode) normalNode.focus({ preventScroll:true });
        }
        if (previousBvid === item.bvid) updatePlaybackNow();
        else await playCurrentSelection(true);
        if (token !== playbackState.queueToken) return;
        setPlaybackQueueDrawer(false);
      } catch (error) {
        if (token !== playbackState.queueToken) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        playbackState.search.error = { page:1, message:error instanceof Error ? error.message : String(error) };
        updatePlaybackSearchHeader();
        updatePlaybackQueueFeedback();
      } finally {
        if (token === playbackState.queueToken) {
          playbackState.queueLoading = false;
          playbackState.search.loading = false;
          playbackState.queueController = null;
          updatePlaybackSearchHeader();
        }
      }
    }

    async function stepPlayback(direction: number, fromEnded = false) {
      const token = playbackState.loadingToken;
      const item = currentPlaybackItem();
      if (!item) return;
      try {
        savePlaybackProgress();
        if (direction > 0) {
          if (playbackState.partIndex + 1 < item.parts.length) {
            playbackState.partIndex += 1;
            await playCurrentSelection(true);
            return;
          }
          const nextPosition = Number(item.queuePosition || 0) + 1;
          if (playbackState.mode !== 'single' && nextPosition <= playbackState.total) {
            await selectPlaybackQueuePosition(nextPosition, 0, true);
            return;
          }
          if (fromEnded) setPlaybackMessage('已播放到收藏夹末尾', '你可以选择队列中的视频重新播放。', { retry:false, skip:false });
          return;
        }
        if (playbackState.partIndex > 0) {
          playbackState.partIndex -= 1;
          await playCurrentSelection(true);
          return;
        }
        const previousPosition = Number(item.queuePosition || 0) - 1;
        if (playbackState.mode !== 'single' && previousPosition >= 1) {
          await selectPlaybackQueuePosition(previousPosition, Number.MAX_SAFE_INTEGER, true);
        }
      } catch (error) {
        if (token !== playbackState.loadingToken) return;
        setPlaybackMessage('无法读取下一页队列', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      }
    }

    function skipCurrentPlaybackVideo() {
      const token = playbackState.loadingToken;
      const item = currentPlaybackItem();
      if (!item) return;
      savePlaybackProgress();
      const nextPosition = Number(item.queuePosition || 0) + 1;
      if (playbackState.mode !== 'single' && nextPosition <= playbackState.total) {
        selectPlaybackQueuePosition(nextPosition, 0, true).catch((error) => {
          if (token !== playbackState.loadingToken) return;
          setPlaybackMessage('无法读取下一页队列', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
        });
        return;
      }
      setPlaybackMessage('已到收藏夹末尾', '当前没有下一条可播放归档。', { retry:false, skip:false });
    }

    async function refreshLibraryPlaybackSelection(autoplay = true) {
      const current = currentPlaybackItem();
      const bvid = current?.bvid || playbackState.focusBvid;
      if (playbackState.mode !== 'library' || !bvid) throw new Error('归档库播放上下文已经失效');
      const previousFingerprint = currentPlaybackPart()?.fingerprint;
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      playbackState.queueLoading = true;
      playbackState.queueLoadingDirection = null;
      playbackState.queueError = null;
      playbackState.queuePromise = null;
      try {
        const data = parsePlaybackQueuePage(await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        ));
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        const selected = currentPlaybackItem();
        const previousPartIndex = selected?.parts.findIndex((part) => part.fingerprint === previousFingerprint) ?? -1;
        playbackState.partIndex = previousPartIndex >= 0 ? previousPartIndex : 0;
        renderPlaybackQueue(true);
        await playCurrentSelection(autoplay);
      } finally {
        if (token === playbackState.queueToken) {
          playbackState.queueLoading = false;
          playbackState.queueLoadingDirection = null;
          if (playbackState.queueController === controller) playbackState.queueController = null;
          updatePlaybackQueueFeedback();
        }
      }
    }

    async function retryCurrentPlayback() {
      try {
        if (playbackState.mode === 'library') {
          await refreshLibraryPlaybackSelection(true);
          return;
        }
        if (currentPlaybackPart()) {
          await playCurrentSelection(true);
          return;
        }
        if (playbackState.focusBvid) await openArchivePlayback(playbackState.focusBvid, playbackState.trigger);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        setPlaybackMessage('无法重新读取播放来源', error instanceof Error ? error.message : String(error), { retry:true, skip:true });
      }
    }

    async function openArchiveLibraryPlayback(bvid: string, trigger: HTMLElement | null, libraryContext: ArchiveContext) {
      if (!bvid) return;
      destroyPlaybackSession();
      playbackState.mode = 'library';
      playbackState.libraryContext = libraryContext;
      playbackState.pageSize = 50;
      playbackState.preferences = loadPlaybackPreferences();
      playbackState.continuous = playbackState.preferences.continuous;
      playbackState.trigger = trigger || null;
      playbackState.focusBvid = bvid;
      openModal('playbackModal', trigger);
      setPlaybackQueueDrawer(false);
      if (syncPlaybackImmersiveMode()) {
        later(() => elements.closePlaybackImmersiveBtn.focus({ preventScroll:true }), 0);
      }
      elements.playbackQueueHeading.textContent = '归档库顺序';
      setPlaybackMessage('正在准备归档库队列', '将按照当前目录、筛选、搜索和排序读取本地可播放归档。', { retry:false, skip:false });
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = parsePlaybackQueuePage(await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        ));
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        playbackState.partIndex = 0;
        playbackState.progressTimer = setInterval(savePlaybackProgress, 5000);
        await playCurrentSelection(true);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (token !== playbackState.queueToken) return;
        setPlaybackMessage('无法打开归档库播放器', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      } finally {
        if (token === playbackState.queueToken) playbackState.queueController = null;
      }
    }

    async function openArchivePlayback(bvid: string, trigger: HTMLElement | null) {
      const context=favoriteContext();
      if (!context || !bvid) return;
      destroyPlaybackSession();
      playbackState.mode = 'favorite';
      playbackState.libraryContext = null;
      playbackState.userId = context.userId;
      playbackState.mediaId = context.mediaId;
      playbackState.pageSize = 50;
      playbackState.preferences = loadPlaybackPreferences();
      playbackState.continuous = playbackState.preferences.continuous;
      playbackState.trigger = trigger || null;
      playbackState.focusBvid = bvid;
      openModal('playbackModal', trigger);
      setPlaybackQueueDrawer(false);
      if (syncPlaybackImmersiveMode()) {
        later(() => elements.closePlaybackImmersiveBtn.focus({ preventScroll:true }), 0);
      }
      setPlaybackMessage('正在准备播放队列', '只会列出当前收藏夹中已通过远端确认的归档视频。', { retry:false, skip:false });
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = parsePlaybackQueuePage(await fetchJson(
          '/api/users/' + encodeURIComponent(playbackState.userId || '') +
          '/favorites/' + playbackState.mediaId +
          '/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize,
          { signal:controller.signal }
        ));
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        const foundIndex = playbackState.items.findIndex((item) => item.bvid === bvid);
        playbackState.itemIndex = foundIndex >= 0 ? foundIndex : 0;
        playbackState.partIndex = 0;
        playbackState.progressTimer = setInterval(savePlaybackProgress, 5000);
        await playCurrentSelection(true);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (token !== playbackState.queueToken) return;
        setPlaybackMessage('无法打开归档播放器', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      } finally {
        if (token === playbackState.queueToken) playbackState.queueController = null;
      }
    }


  function init() {
    if(events)return;events=new AbortController();const signal=events.signal;
    function listen<K extends keyof HTMLElementEventMap>(element:HTMLElement,type:K,callback:(event:HTMLElementEventMap[K])=>void){element.addEventListener(type,callback,{signal});}
    listen(elements.closePlaybackBtn, 'click', () => closeModal('playbackModal'));
    listen(elements.closePlaybackImmersiveBtn, 'click', () => closeModal('playbackModal'));
    listen(elements.playbackImmersiveQueueBtn, 'click', () => setPlaybackQueueDrawer(!playbackState.drawerOpen));
    listen(elements.playbackImmersiveExitBtn, 'click', () => setPlaybackMobilePortraitMode(false));
    listen(elements.playbackMobilePortraitBtn, 'click', () => {
      const enabled = !playbackState.preferences || playbackState.preferences.mobilePortraitMode !== false;
      setPlaybackMobilePortraitMode(!enabled);
    });
    listen(elements.playbackDrawerBackdrop, 'click', () => setPlaybackQueueDrawer(false));
    listen(elements.playbackQueueCloseBtn, 'click', () => setPlaybackQueueDrawer(false));
    const playbackStage = elements.playbackStage;
    listen(playbackStage, 'pointerdown', handlePlaybackSwipeStart);
    listen(playbackStage, 'pointermove', handlePlaybackSwipeMove);
    listen(playbackStage, 'pointerup', handlePlaybackSwipeEnd);
    listen(playbackStage, 'pointercancel', handlePlaybackSwipeCancel);
    listen(playbackStage, 'lostpointercapture', handlePlaybackSwipeCancel);
    listen(elements.playbackPreviousBtn, 'click', () => stepPlayback(-1));
    listen(elements.playbackNextBtn, 'click', () => stepPlayback(1));
    listen(elements.playbackSearchInput, 'input', schedulePlaybackSearch);
    listen(elements.playbackSearchClearBtn, 'click', () => {
      clearPlaybackSearch();
      elements.playbackSearchInput.focus({ preventScroll:true });
    });
    const handlePlaybackViewportChange = () => {
      if (!elements.playbackModal.classList.contains('active')) return;
      syncPlaybackImmersiveMode();
    };
    window.matchMedia('(max-width: 720px)').addEventListener('change', handlePlaybackViewportChange, {signal});
    window.matchMedia('(orientation: portrait)').addEventListener('change', handlePlaybackViewportChange, {signal});
    listen(elements.playbackContinuousBtn, 'click', () => {
      playbackState.continuous = !playbackState.continuous;
      if (playbackState.preferences) playbackState.preferences.continuous = playbackState.continuous;
      persistPlaybackPreferences();
      updatePlaybackNavigation();
    });
    listen(elements.playbackRetryBtn, 'click', retryCurrentPlayback);
    listen(elements.playbackSkipBtn, 'click', skipCurrentPlaybackVideo);

  }
  function destroy(){destroyPlaybackSession();events?.abort();events=null;for(const timer of timers)clearTimeout(timer);timers.clear();for(const id of frames)cancelAnimationFrame(id);frames.clear();}
  return {init,destroy,deactivate:destroyPlaybackSession,open:openArchivePlayback,openLibrary:openArchiveLibraryPlayback,
    closeDrawer:()=>setPlaybackQueueDrawer(false),get drawerOpen(){return playbackState.drawerOpen;},
    configure(value:{deliveryMode:string;alistBrowserConfigured:boolean}){playbackState.deliveryMode=value.deliveryMode;playbackState.alistBrowserConfigured=value.alistBrowserConfigured;}};
}
