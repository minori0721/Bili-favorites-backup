export interface ModalCloseOptions {restoreFocus?:boolean; skipConfirm?:boolean}
interface ModalEntry {modal:HTMLElement; trigger:HTMLElement | null; previousFocus:HTMLElement | null; openedAt:number}
export function createModalManager(document:Document, beforeClose:(modal:HTMLElement,options:ModalCloseOptions) => boolean) {
  const window = (() => {
    const view = document.defaultView;
    if (!view) throw new Error('Modal document must have a browser window');
    return view;
  })();
  const modalStack:ModalEntry[] = [];
  const modalAnimationState = new Map<HTMLElement,{timer:number | null}>();
  const modalBackgroundState = new Map<HTMLElement,{inert:boolean; ariaHidden:string | null}>();
  let modalScrollState:{rootHadClass:boolean; bodyHadClass:boolean; bodyPaddingRight:string} | null = null;
  const MODAL_ENTER_FOCUS_DELAY_MS = 260;
  const timers = new Set<number>();
  let disposed = false;
  let initialized = false;
  function backdropClick(event: MouseEvent) {
    const entry = modalStack[modalStack.length - 1];
    const modal = entry?.modal;
    // The second click that opened a dialog must not dismiss its new backdrop.
    // Touch browsers may report both clicks with detail=1 while it is entering.
    if (event.detail > 1 || !modal || event.target !== modal
      || window.performance.now() - entry.openedAt < MODAL_ENTER_FOCUS_DELAY_MS) return;
    closeModal(modal);
  }
  function trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const modal = activeModal();
    if (!modal) return;
    const controls = focusableElements(modal);
    if (!controls.length) { event.preventDefault(); modal.focus({preventScroll:true}); return; }
    const current = document.activeElement;
    const index = current instanceof HTMLElement ? controls.indexOf(current) : -1;
    if (event.shiftKey && index <= 0) {
      event.preventDefault(); controls[controls.length - 1].focus({preventScroll:true});
    } else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {
      event.preventDefault(); controls[0].focus({preventScroll:true});
    }
  }
  function schedule(callback:() => void, delay:number) {
    if (disposed) return 0;
    const timer = window.setTimeout(() => { timers.delete(timer); if (!disposed) callback(); },delay);
    timers.add(timer);
    return timer;
  }
    const FOCUSABLE_SELECTOR = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

    function focusableElements(root: ParentNode | null): HTMLElement[] {
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
        if (!(element instanceof HTMLElement) || element.closest('[inert]')) return false;
        if (element.getAttribute('aria-hidden') === 'true' || element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
    }

    function restoreFocusAfterModal(entry: ModalEntry | undefined) {
      schedule(() => {
        const candidates = [entry?.trigger, entry?.previousFocus];
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement) || !candidate.isConnected || candidate.closest('[inert]') || candidate.matches(':disabled')) continue;
          candidate.focus({ preventScroll:true });
          return;
        }
        const parent = activeModal();
        const fallback = focusableElements(parent)[0] || parent;
        if (fallback && typeof fallback.focus === 'function') fallback.focus({ preventScroll:true });
      }, 0);
    }

    function focusModalControlWhenReady(modal:HTMLElement, target:HTMLElement | null) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const delay = reducedMotion ? 0 : MODAL_ENTER_FOCUS_DELAY_MS;
      schedule(() => {
        if (activeModal() !== modal) return;
        const currentFocus = document.activeElement;
        if (currentFocus instanceof HTMLElement && modal.contains(currentFocus)) return;
        const focusTarget = target instanceof HTMLElement && target.isConnected
          ? target
          : focusableElements(modal)[0] || modal;
        if (typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll:true });
      }, delay);
    }

    function syncModalScrollLock(locked:boolean) {
      const root = document.documentElement;
      const body = document.body;
      if (locked && !modalScrollState) {
        const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
        modalScrollState = {
          rootHadClass:root.classList.contains('modal-open'),
          bodyHadClass:body.classList.contains('modal-open'),
          bodyPaddingRight:body.style.paddingRight
        };
        if (scrollbarWidth > 0) {
          const paddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
          body.style.paddingRight = (paddingRight + scrollbarWidth) + 'px';
        }
        root.classList.add('modal-open');
        body.classList.add('modal-open');
        return;
      }
      if (!locked && modalScrollState) {
        root.classList.toggle('modal-open', modalScrollState.rootHadClass);
        body.classList.toggle('modal-open', modalScrollState.bodyHadClass);
        body.style.paddingRight = modalScrollState.bodyPaddingRight;
        modalScrollState = null;
      }
    }

    function syncModalBackground(hidden:boolean) {
      syncModalScrollLock(hidden);
      const roots = [
        document.querySelector('header'),
        document.querySelector('main'),
        document.getElementById('toastContainer')
      ].filter((element): element is HTMLElement => element instanceof HTMLElement);
      roots.forEach((root) => {
        if (hidden) {
          if (!modalBackgroundState.has(root)) {
            modalBackgroundState.set(root, {
              inert:Boolean(root.inert),
              ariaHidden:root.hasAttribute('aria-hidden') ? root.getAttribute('aria-hidden') : null
            });
          }
          root.inert = true;
          root.setAttribute('aria-hidden', 'true');
          return;
        }
        const previous = modalBackgroundState.get(root);
        if (!previous) return;
        root.inert = previous.inert;
        if (previous.ariaHidden === null) root.removeAttribute('aria-hidden');
        else root.setAttribute('aria-hidden', previous.ariaHidden);
        modalBackgroundState.delete(root);
      });
    }

    function ensureModalAccessibleName(modal:HTMLElement) {
      if (modal.hasAttribute('aria-label') || modal.hasAttribute('aria-labelledby')) return;
      const heading = modal.querySelector('h1,h2,h3');
      if (!heading) return;
      if (!heading.id) heading.id = modal.id + 'Title';
      modal.setAttribute('aria-labelledby', heading.id);
    }

    function syncModalStack() {
      const top = modalStack[modalStack.length - 1] || null;
      const hasClosingModal = modalAnimationState.size > 0;
      syncModalBackground(Boolean(top || hasClosingModal));
      document.querySelectorAll<HTMLElement>('.modal').forEach((modal) => {
        const index = modalStack.findIndex((entry) => entry.modal === modal);
        if (index < 0) {
          const isClosing = modalAnimationState.has(modal);
          if (!isClosing) modal.style.removeProperty('z-index');
          modal.inert = true;
          modal.setAttribute('aria-hidden', 'true');
          modal.setAttribute('aria-modal', 'false');
          return;
        }
        const isTop = modalStack[index] === top;
        modal.style.zIndex = String(100 + index * 20);
        modal.inert = !isTop;
        modal.setAttribute('aria-hidden', String(!isTop));
        modal.setAttribute('aria-modal', String(isTop));
      });
    }

    function closeModal(modalOrId:HTMLElement | string, options:ModalCloseOptions = {}):boolean {
      if (disposed) return false;
      const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
      if (!modal) return false;
      const index = modalStack.findIndex((entry) => entry.modal === modal);
      if (index < 0 || index !== modalStack.length - 1) return false;
      if (beforeClose(modal,options) === false) return true;
      const [entry] = modalStack.splice(index, 1);
      const closingZIndex = modal.style.zIndex || String(100 + index * 20);
      const motionReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const closeDuration = motionReduced ? 0 : 190;
      const closingState: {timer:number | null} = {timer:null};
      modalAnimationState.set(modal, closingState);
      modal.classList.add('is-closing');
      modal.style.zIndex = closingZIndex;
      modal.setAttribute('aria-hidden', 'true');
      modal.inert = true;
      syncModalStack();

      const finishClose = () => {
        if (modalAnimationState.get(modal) !== closingState) return;
        modalAnimationState.delete(modal);
        modal.classList.remove('active', 'is-closing');
        modal.setAttribute('aria-hidden', 'true');
        modal.inert = true;
        modal.hidden = true;
        modal.style.removeProperty('z-index');
        syncModalStack();
        if (options.restoreFocus !== false) restoreFocusAfterModal(entry);
      };
      closingState.timer = schedule(finishClose, closeDuration);
      return true;
    }

    function openModal(modalId:string, trigger?:HTMLElement | null) {
      if (disposed) return false;
      const modal = document.getElementById(modalId);
      if (!modal) return false;
      const closingState = modalAnimationState.get(modal);
      if (closingState) {
        if (closingState.timer !== null) { window.clearTimeout(closingState.timer); timers.delete(closingState.timer); }
        modalAnimationState.delete(modal);
        modal.classList.remove('is-closing', 'active');
        void modal.offsetWidth;
      }
      const existingIndex = modalStack.findIndex((entry) => entry.modal === modal);
      if (existingIndex >= 0) return existingIndex === modalStack.length - 1;
      ensureModalAccessibleName(modal);
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modal.hidden = false;
      modal.inert = true;
      modal.classList.remove('active', 'is-closing');
      void modal.offsetWidth;
      modalStack.push({ modal, trigger:trigger instanceof HTMLElement ? trigger : previousFocus, previousFocus, openedAt:window.performance.now() });
      modal.classList.add('active');
      modal.setAttribute('role', 'dialog');
      if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
      syncModalStack();
      focusModalControlWhenReady(modal, null);
      return true;
    }

    function activeModal() {
      return modalStack[modalStack.length - 1]?.modal || null;
    }

  return {
    open:openModal,close:closeModal,active:activeModal,focusableElements,focusWhenReady:focusModalControlWhenReady,
    init() {
      if (initialized) return;
      initialized = true;
      disposed = false;
      document.querySelectorAll<HTMLElement>('.modal').forEach(modal => {
        modal.hidden = true; modal.inert = true;
        modal.setAttribute('aria-hidden', 'true'); modal.setAttribute('aria-modal', 'false');
      });
      document.addEventListener('click', backdropClick);
      document.addEventListener('keydown', trapFocus);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      initialized = false;
      document.removeEventListener('click', backdropClick);
      document.removeEventListener('keydown', trapFocus);
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      for (const modal of new Set([...modalStack.map(entry => entry.modal),...modalAnimationState.keys()])) {
        modal.hidden = true; modal.inert = true;
        modal.classList.remove('active','is-closing');
        modal.style.removeProperty('z-index');
        modal.setAttribute('aria-hidden','true');
        modal.setAttribute('aria-modal','false');
      }
      modalStack.length = 0;
      modalAnimationState.clear();
      syncModalBackground(false);
    },
  };
}
