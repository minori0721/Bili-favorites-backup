import { requireElement } from './dom.js';

export function createNotifications(document:Document, activeModal:() => HTMLElement | null) {
  const active = new Map<HTMLElement,() => void>();
  let disposed = false;
  function show(message:unknown, type = 'error') {
    if (disposed) return;
    const modal = activeModal();
    let container = modal?.querySelector<HTMLElement>('[data-modal-toast-host="true"]') || null;
    if (!container && modal) {
      container = document.createElement('div');
      container.className = 'toast-container modal-toast-container';
      container.dataset.modalToastHost = 'true';
      container.setAttribute('aria-live','polite');
      container.setAttribute('aria-atomic','false');
      modal.appendChild(container);
    }
    if (!container) container = requireElement(document,'#toastContainer',HTMLElement);
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.setAttribute('role',type === 'error' ? 'alert' : 'status');
    const text = document.createElement('div');
    text.className = 'toast-message';
    text.textContent = String(message || '');
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label','关闭提示');
    close.textContent = '×';
    let deadline:ReturnType<typeof setTimeout> | null = null;
    let animation:ReturnType<typeof setTimeout> | null = null;
    const remove = () => {
      if (deadline !== null) clearTimeout(deadline);
      if (animation !== null) clearTimeout(animation);
      close.removeEventListener('click',remove);
      toast.removeEventListener('animationend',remove);
      toast.remove();
      active.delete(toast);
      if (container?.matches('[data-modal-toast-host="true"]') && !container.childElementCount) container.remove();
    };
    active.set(toast,remove);
    close.addEventListener('click',remove);
    toast.append(text,close);
    container.appendChild(toast);
    deadline = setTimeout(() => {
      deadline = null;
      if (!toast.isConnected) { remove(); return; }
      toast.classList.add('fade-out');
      toast.addEventListener('animationend',remove,{once:true});
      animation = setTimeout(remove,400);
    },3500);
  }
  return {
    show,
    init() { disposed = false; },
    destroy() { disposed = true; for (const remove of [...active.values()]) remove(); },
  };
}
