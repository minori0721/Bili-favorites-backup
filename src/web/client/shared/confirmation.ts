import { requireElement } from './dom.js';
import type { createModalManager } from './modals.js';

export interface ConfirmationOptions {
  title?: string; message?: string; detail?: string; requiredText?: string; inputLabel?: string;
  confirmText?: string; cancelText?: string; danger?: boolean; trigger?: HTMLElement | null;
}
export type ConfirmAction = (options: ConfirmationOptions) => Promise<boolean>;

export function createConfirmation(document: Document, modals: Pick<ReturnType<typeof createModalManager>, 'open' | 'close' | 'focusableElements' | 'focusWhenReady'>) {
  const modal = requireElement(document, '#confirmActionModal', HTMLElement);
  const input = requireElement(modal, '#confirmActionInput', HTMLInputElement);
  const ok = requireElement(modal, '#confirmActionOkBtn', HTMLButtonElement);
  const cancel = requireElement(modal, '#confirmActionCancelBtn', HTMLButtonElement);
  const inputWrap = requireElement(modal, '#confirmActionInputWrap', HTMLElement);
  const detail = requireElement(modal, '#confirmActionDetail', HTMLElement);
  const title = requireElement(modal, '#confirmActionTitle', HTMLElement);
  const message = requireElement(modal, '#confirmActionMessage', HTMLElement);
  const label = requireElement(modal, '#confirmActionInputLabel', HTMLElement);
  const hint = requireElement(modal, '#confirmActionInputHint', HTMLElement);
  let pending: {resolve(value: boolean): void; requiredText: string} | null = null;
  let initialized = false;

  function finish(result: boolean) {
    if (!pending || (result && pending.requiredText && input.value.trim() !== pending.requiredText)) return;
    const current = pending;
    pending = null;
    modals.close(modal, {skipConfirm:true});
    current.resolve(result);
  }
  // A dialog can appear under the second click of its trigger, especially on
  // mobile. Only a new click (or keyboard activation, detail=0) is a decision.
  const accept = (event: MouseEvent) => { if (event.detail <= 1) finish(true); };
  const reject = (event: MouseEvent) => { if (event.detail <= 1) finish(false); };
  const sync = () => { ok.disabled = Boolean(pending?.requiredText) && input.value.trim() !== pending?.requiredText; };
  const ask: ConfirmAction = options => {
    if (!initialized) return Promise.resolve(false);
    if (pending) { (modals.focusableElements(modal)[0] || modal).focus({preventScroll:true}); return Promise.resolve(false); }
    return new Promise(resolve => {
      const requiredText = options.requiredText || '';
      title.textContent = options.title || '确认操作';
      message.textContent = options.message || '确认继续吗？';
      detail.textContent = options.detail || '';
      detail.classList.toggle('is-hidden', !options.detail);
      label.textContent = options.inputLabel || '确认文字';
      input.value = '';
      input.placeholder = requiredText;
      hint.textContent = requiredText ? '请输入 ' + requiredText + ' 后继续。' : '';
      inputWrap.classList.toggle('is-hidden', !requiredText);
      ok.textContent = options.confirmText || '确认';
      cancel.textContent = options.cancelText || '取消';
      ok.classList.toggle('danger-action', options.danger !== false);
      ok.disabled = Boolean(requiredText);
      pending = {resolve, requiredText};
      modals.open('confirmActionModal', options.trigger);
      modals.focusWhenReady(modal, requiredText ? input : ok);
    });
  };
  return {
    ask, finish, get pending() { return pending !== null; },
    init() {if(initialized)return;initialized=true;input.addEventListener('input',sync);ok.addEventListener('click',accept);cancel.addEventListener('click',reject);},
    destroy() {initialized=false;finish(false);input.removeEventListener('input',sync);ok.removeEventListener('click',accept);cancel.removeEventListener('click',reject);},
  };
}
