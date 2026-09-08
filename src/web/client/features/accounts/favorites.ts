import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseFavoriteFolders, type FavoriteFolder } from '../../../../shared/api/accounts.js';

export function createFavorites(dependencies: {
  root: Document; api: ApiClient;
  openModal(id: string, trigger?: HTMLElement): void; closeModal(id: string): void;
  loadUsers(): Promise<void>; detail(userId: string, mediaId: number, title: string): void;
  status(message: string, type?: string): void;
}) {
  const {root:document, api, openModal, closeModal, loadUsers} = dependencies;
  const modal = requireElement(document, '#favoritesModal', HTMLElement);
  const list = requireElement(document, '#favoritesList', HTMLElement);
  const saveButton = requireElement(document, '#saveFavoritesBtn', HTMLButtonElement);
  const closeButton = requireElement(document, '#closeFavoritesBtn', HTMLButtonElement);
  const coverFolders = new WeakMap<Element, FavoriteFolder>();
  const safeText = (value: string, fallback: string) => value || fallback;
  const setStatus = (_id: string, message: string, type = '') => dependencies.status(message, type);
  const favoritesState: {userId:string|null;token:number;controller:AbortController|null;coverObserver:IntersectionObserver|null;loaded:boolean} = {
    userId:null,token:0,controller:null,coverObserver:null,loaded:false,
  };
  let saveController: AbortController | null = null;
  let initialized = false;
    // ---- Favorites (with thumbnails) ----
    function cleanupFavorites() {
      favoritesState.token += 1;
      saveController?.abort();
      saveController = null;
      saveButton.textContent = '保存选择';
      favoritesState.controller?.abort();
      favoritesState.controller = null;
      favoritesState.coverObserver?.disconnect();
      favoritesState.coverObserver = null;
      favoritesState.userId = null;
      favoritesState.loaded = false;
    }

    function favoritesRequestCurrent(token: number, userId: string) {
      return token === favoritesState.token && favoritesState.userId === userId
        && modal.classList.contains('active');
    }

    function favoriteFolderCoverUrl(userId: string, mediaId: number) {
      return '/api/users/' + encodeURIComponent(userId) + '/favorites/' + encodeURIComponent(String(mediaId)) + '/cover';
    }

    function createFavoriteFolderCoverPlaceholder() {
      const cover = document.createElement('div');
      cover.className = 'fav-cover fav-cover-placeholder';
      cover.textContent = '封面';
      cover.setAttribute('aria-hidden', 'true');
      return cover;
    }

    function loadFavoriteFolderCover(placeholder: Element, userId: string, folder: FavoriteFolder, token: number) {
      if (!favoritesRequestCurrent(token, userId) || !placeholder.isConnected) return;
      const image = document.createElement('img');
      image.className = 'fav-cover';
      image.alt = safeText(folder.title, '收藏夹封面');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'same-origin';
      image.addEventListener('error', () => {
        if (favoritesRequestCurrent(token, userId) && image.isConnected) {
          image.replaceWith(createFavoriteFolderCoverPlaceholder());
        }
      }, { once:true });
      placeholder.replaceWith(image);
      image.src = favoriteFolderCoverUrl(userId, folder.mediaId);
    }

    async function openFavorites(userId: string, trigger?: HTMLElement) {
      cleanupFavorites();
      favoritesState.coverObserver = null;
      const controller = new AbortController();
      const token = ++favoritesState.token;
      favoritesState.controller = controller;
      favoritesState.userId = userId;
      favoritesState.loaded = false;
      setStatus('favoritesStatus', '');
      saveButton.disabled = true;

      list.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'empty-state loading-state';
      loading.textContent = '加载中...';
      list.appendChild(loading);
      openModal('favoritesModal', trigger);
      try {
      const data = parseFavoriteFolders(await api.silent('/api/users/'+encodeURIComponent(userId)+'/favorites', { signal:controller.signal }));
      if (!favoritesRequestCurrent(token, userId)) return;
      list.innerHTML = '';
      const coverObserver: IntersectionObserver | null = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            coverObserver?.unobserve(entry.target);
            const placeholder = entry.target;
            const folder = coverFolders.get(placeholder);
            if (folder) loadFavoriteFolderCover(placeholder, userId, folder, token);
          }
        }, { root:list, rootMargin:'120px' })
        : null;
      favoritesState.coverObserver = coverObserver;
      data.forEach(folder => {
        const lbl = document.createElement('label');
        lbl.className = 'fav-label';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = String(folder.mediaId);
        checkbox.checked = Boolean(folder.selected);
        lbl.appendChild(checkbox);

        const cover = createFavoriteFolderCoverPlaceholder();
        coverFolders.set(cover, folder);
        lbl.appendChild(cover);

        const content = document.createElement('div');
        content.className = 'fav-content';

        const title = document.createElement('div');
        title.className = 'fav-title';
        title.textContent = safeText(folder.title, '未命名收藏夹');

        const count = document.createElement('div');
        count.className = 'fav-count';
        count.textContent = String(folder.mediaCount || 0) + ' 个视频';

        content.appendChild(title);
        content.appendChild(count);
        lbl.appendChild(content);

        const detail = document.createElement('button');
        detail.className = 'ghost compact-button';
        detail.dataset.detailMedia = String(folder.mediaId);
        detail.dataset.detailTitle = folder.title || '';
        detail.textContent = '查看详情';
        lbl.appendChild(detail);
        list.appendChild(lbl);
        if (coverObserver) coverObserver.observe(cover);
        else loadFavoriteFolderCover(cover, userId, folder, token);
      });
      favoritesState.loaded = true;
      saveButton.disabled = false;
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || !favoritesRequestCurrent(token, userId)) return;
        list.replaceChildren();
        const failure = document.createElement('div');
        failure.className = 'empty-state video-detail-status error';
        failure.appendChild(document.createTextNode('收藏夹加载失败：' + (error instanceof Error ? error.message : String(error)) + ' '));
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry-button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => void openFavorites(userId, trigger));
        failure.appendChild(retry);
        list.appendChild(failure);
      } finally {
        if (favoritesState.controller === controller) favoritesState.controller = null;
      }
    }


  async function saveFavorites() {
    const userId = favoritesState.userId;
    const token = favoritesState.token;
    if (!userId || !favoritesState.loaded || saveController) return;
    const controller = new AbortController();
    saveController = controller;
    saveButton.disabled = true;
    saveButton.textContent = '保存中...';
    dependencies.status('');
    const selected = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(input => Number(input.value));
    try {
      await api.request('/api/users/' + encodeURIComponent(userId) + '/favorites', {
        method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({mediaIds:selected}),signal:controller.signal,
      });
      if (!favoritesRequestCurrent(token,userId)) return;
      dependencies.status('已保存','success');
      closeModal('favoritesModal');
      await loadUsers();
    } catch(error) {
      if (favoritesRequestCurrent(token,userId)) dependencies.status('保存失败：' + (error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      if (saveController === controller) {saveController=null;saveButton.disabled=false;saveButton.textContent='保存选择';}
    }
  }
  function onDetail(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.detailMedia || !favoritesState.userId || !favoritesState.loaded) return;
    event.preventDefault(); event.stopPropagation();
    dependencies.detail(favoritesState.userId, Number(target.dataset.detailMedia), target.dataset.detailTitle || '');
  }
  const onSave = () => { void saveFavorites(); };
  const onClose = () => closeModal('favoritesModal');
  return {open:openFavorites,deactivate:cleanupFavorites,
    init() {if(initialized)return;initialized=true;list.addEventListener('click',onDetail);saveButton.addEventListener('click',onSave);closeButton.addEventListener('click',onClose);},
    destroy() {initialized=false;cleanupFavorites();list.removeEventListener('click',onDetail);saveButton.removeEventListener('click',onSave);closeButton.removeEventListener('click',onClose);},
  };
}
