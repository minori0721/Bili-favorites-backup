import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { repreviewArchiveDeletion } from '../../shared/archive-deletion-actions.js';
import { requireElement } from '../../shared/dom.js';
import { parseRemovalPreview, parseRemovalOperation, parseRemovalResult, type RemovalOperation } from './removal-contract.js';

interface Dependencies {
  root: Document;
  api: ApiClient;
  openModal(id: string, trigger: HTMLElement): void;
  closeModal(id: string): void;
  loadUsers(): Promise<void>;
  showToast(message: string, type?: string): void;
  formatBytes(value: number): string;
  archiveDeletionProgressText(operation: RemovalOperation): string;
  confirmAction: ConfirmAction;
}
interface RemovalState {
  userId: string | null;
  preview: ReturnType<typeof parseRemovalPreview> | null;
  operationId: string | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  trigger: HTMLElement | null;
  controller: AbortController | null;
  token: number;
  loading: boolean;
}
export function createAccountRemoval(dependencies: Dependencies) {
  const {root: document, api, openModal, closeModal, loadUsers, showToast, formatBytes, archiveDeletionProgressText, confirmAction} = dependencies;
  const requests = new Set<AbortController>();
  async function fetchJson(url: string, options: RequestInit = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, {once:true});
    requests.add(controller);
    try { return await api.silent(url, {...options, signal:controller.signal}); }
    finally { requests.delete(controller); options.signal?.removeEventListener('abort', abort); }
  }
  const fetchJsonSilent = fetchJson;
  const elements = {
    accountRemovalRemote: requireElement(document, '#accountRemovalRemote', HTMLInputElement),
    accountRemovalConfirmInput: requireElement(document, '#accountRemovalConfirmInput', HTMLInputElement),
    accountRemovalSubmitBtn: requireElement(document, '#accountRemovalSubmitBtn', HTMLButtonElement),
    accountRemovalPreview: requireElement(document, '#accountRemovalPreview', HTMLElement),
    accountRemovalTitle: requireElement(document, '#accountRemovalTitle', HTMLElement),
    accountRemovalOnly: requireElement(document, '#accountRemovalOnly', HTMLInputElement),
    accountRemovalCancelBtn: requireElement(document, '#accountRemovalCancelBtn', HTMLButtonElement),
    accountRemovalModal: requireElement(document, '#accountRemovalModal', HTMLElement),
    accountRemovalProgress: requireElement(document, '#accountRemovalProgress', HTMLElement),
  };
  function setHidden(target: string | HTMLElement, hidden: boolean) {
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    element?.classList.toggle('is-hidden', hidden);
  }
  let accountRemovalToken = 0;
  const emptyState = (): RemovalState => ({userId:null,preview:null,operationId:null,pollTimer:null,trigger:null,controller:null,token:accountRemovalToken,loading:false});
  let accountRemovalState = emptyState();
  let initialized = false;
  let submitting = false;
  function deactivate() {
    if(accountRemovalState.pollTimer) clearTimeout(accountRemovalState.pollTimer);
    accountRemovalState.controller?.abort();
    accountRemovalToken += 1;
    accountRemovalState = emptyState();
    submitting = false;
    for (const request of requests) request.abort();
    requests.clear();
  }
    function syncAccountRemovalControls() {
      const remote = elements.accountRemovalRemote.checked;
      const input = elements.accountRemovalConfirmInput;
      const submit = elements.accountRemovalSubmitBtn;
      setHidden('accountRemovalConfirmWrap', !remote);
      submit.textContent = remote ? '删除账号并开始清理' : '仅删除账号登录';
      submit.disabled = submitting || !accountRemovalState.userId || (remote && (accountRemovalState.loading || !accountRemovalState.preview || input.value.trim() !== 'DELETE REMOTE ARCHIVE'));
    }

    async function loadAccountRemovalPreview() {
      const userId = accountRemovalState.userId;
      if (!userId || accountRemovalState.loading || accountRemovalState.preview) return;
      if (accountRemovalState.controller) accountRemovalState.controller.abort();
      const controller = new AbortController();
      const token = accountRemovalState.token;
      accountRemovalState.controller = controller;
      accountRemovalState.loading = true;
      elements.accountRemovalPreview.textContent = '正在计算远端归档影响范围...';
      syncAccountRemovalControls();
      try {
        const preview = parseRemovalPreview(await fetchJson('/api/users/' + encodeURIComponent(userId) + '/removal-preview', { method:'POST', signal:controller.signal }));
        if (accountRemovalState.token !== token || accountRemovalState.userId !== userId || accountRemovalState.controller !== controller) return;
        accountRemovalState.preview = preview;
        elements.accountRemovalPreview.textContent =
          Number(preview.relationCount || 0) + ' 条收藏关系 · ' + Number(preview.sourceCount || 0) + ' 个归档来源 · ' +
          Number(preview.fileCount || 0) + ' 个已追踪文件 · ' + formatBytes(Number(preview.totalBytes || 0)) +
          (preview.sharedCount ? ' · 共享保留 ' + Number(preview.sharedCount) : '') +
          (preview.activeTasks ? ' · 将暂停或改派关联任务 ' + Number(preview.activeTasks) : '');
      } catch (error) {
        if ((error instanceof Error && error.name === 'AbortError') || accountRemovalState.token !== token || accountRemovalState.userId !== userId) return;
        elements.accountRemovalPreview.textContent = '影响范围读取失败：' + (error instanceof Error ? error.message : String(error));
      } finally {
        if (accountRemovalState.token === token && accountRemovalState.controller === controller) {
          accountRemovalState.loading = false;
          if (accountRemovalState.controller === controller) accountRemovalState.controller = null;
          syncAccountRemovalControls();
        }
      }
    }

    function handleAccountRemovalModeChange() {
      const remote = elements.accountRemovalRemote.checked;
      if (remote) {
        void loadAccountRemovalPreview();
      } else {
        if (accountRemovalState.controller) accountRemovalState.controller.abort();
        accountRemovalState.controller = null;
        accountRemovalState.loading = false;
        elements.accountRemovalPreview.textContent = '仅移除账号登录；远端归档、封面和本地索引都会保留。';
      }
      syncAccountRemovalControls();
    }

    function openAccountRemoval(userId: string, userName: string, trigger: HTMLElement) {
      deactivate();
      const token = ++accountRemovalToken;
      accountRemovalState = { userId, preview:null, operationId:null, pollTimer:null, trigger, controller:null, token, loading:false };
      elements.accountRemovalTitle.textContent = '删除账号 · ' + (userName || userId);
      elements.accountRemovalOnly.checked = true;
      elements.accountRemovalRemote.checked = false;
      elements.accountRemovalConfirmInput.value = '';
      elements.accountRemovalPreview.textContent = '仅移除账号登录；远端归档、封面和本地索引都会保留。';
      document.querySelectorAll('.account-removal-option').forEach((option) => option.classList.remove('is-hidden'));
      setHidden('accountRemovalProgress', true);
      setHidden('accountRemovalSubmitBtn', false);
      elements.accountRemovalCancelBtn.textContent = '取消';
      syncAccountRemovalControls();
      openModal('accountRemovalModal', trigger);
    }

    function accountRemovalContextCurrent(token: number, userId: string, operationId?: string) {
      return token === accountRemovalState.token
        && userId === accountRemovalState.userId
        && (!operationId || operationId === accountRemovalState.operationId)
        && elements.accountRemovalModal.classList.contains('active');
    }

    async function watchAccountArchiveDeletion(operationId: string, token = accountRemovalState.token, userId = accountRemovalState.userId) {
      if (!userId || !accountRemovalContextCurrent(token, userId, operationId)) return;
      const host = elements.accountRemovalProgress;
      try {
        const operation = parseRemovalOperation(await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId)));
        if (!accountRemovalContextCurrent(token, userId, operationId)) return;
        host.textContent = archiveDeletionProgressText(operation);
        if (operation.status === 'completed') {
          elements.accountRemovalCancelBtn.textContent = '关闭';
          showToast('账号归档清理完成', 'success');
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
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              watchAccountArchiveDeletion(operationId, token, userId);
            } catch (error) {
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              retry.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(retry);
          const repreview = document.createElement('button');
          repreview.type = 'button';
          repreview.className = 'ghost';
          repreview.textContent = '重新预览并确认';
          repreview.addEventListener('click', async () => {
            repreview.disabled = true;
            try {
              const replacement = await repreviewArchiveDeletion({id:operationId, trigger:repreview, request:fetchJson, confirm:confirmAction, formatBytes, current:()=>token === accountRemovalState.token && repreview.isConnected});
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              if (replacement) {
                accountRemovalState.operationId = replacement.id;
                watchAccountArchiveDeletion(replacement.id, token, userId);
              }
              else repreview.disabled = false;
            } catch (error) {
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              repreview.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(repreview);
          return;
        }
        accountRemovalState.pollTimer = setTimeout(() => watchAccountArchiveDeletion(operationId, token, userId), 1000);
      } catch (error) {
        if (!accountRemovalContextCurrent(token, userId, operationId)) return;
        host.textContent = '清理状态暂时无法读取：' + (error instanceof Error ? error.message : String(error));
        accountRemovalState.pollTimer = setTimeout(() => watchAccountArchiveDeletion(operationId, token, userId), 3000);
      }
    }

    async function submitAccountRemoval() {
      const preview = accountRemovalState.preview;
      const remote = elements.accountRemovalRemote.checked;
      const userId = accountRemovalState.userId;
      const token = accountRemovalState.token;
      if (submitting || !userId || (remote && (!preview || elements.accountRemovalConfirmInput.value.trim() !== 'DELETE REMOTE ARCHIVE'))) return;
      submitting = true;
      const submit = elements.accountRemovalSubmitBtn;
      submit.disabled = true;
      try {
        const data = parseRemovalResult(await fetchJsonSilent('/api/users/' + encodeURIComponent(userId), {
          method:'DELETE', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(remote ? {
            mode:'account_and_remote', previewId:preview?.previewId, confirmation:'DELETE REMOTE ARCHIVE'
          } : { mode:'account_only' })
        }));
        await loadUsers();
        if (!accountRemovalContextCurrent(token, userId)) return;
        if (!remote) {
          closeModal('accountRemovalModal');
          showToast('账号登录已移除，远端归档已保留', 'success');
          return;
        }
        setHidden('accountRemovalSubmitBtn', true);
        setHidden('accountRemovalConfirmWrap', true);
        document.querySelectorAll('.account-removal-option').forEach((option) => option.classList.add('is-hidden'));
        const progress = elements.accountRemovalProgress;
        setHidden(progress, false);
        elements.accountRemovalCancelBtn.textContent = '关闭';
        if (!data.operation) throw new Error('缺少归档清理任务');
        accountRemovalState.operationId = data.operation.id;
        watchAccountArchiveDeletion(data.operation.id, token, userId);
      } catch (error) {
        if (!accountRemovalContextCurrent(token, userId)) return;
        submit.disabled = false;
        showToast(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        if (accountRemovalState.token === token) submitting = false;
      }
    }


  const close = () => closeModal('accountRemovalModal');
  const bindings: Array<[string,string,EventListener]> = [
    ['accountRemovalOnly','change',handleAccountRemovalModeChange],
    ['accountRemovalRemote','change',handleAccountRemovalModeChange],
    ['accountRemovalConfirmInput','input',syncAccountRemovalControls],
    ['accountRemovalSubmitBtn','click',() => { void submitAccountRemoval(); }],
    ['accountRemovalCancelBtn','click',close],
  ];
  return {
    open:openAccountRemoval, deactivate,
    init() { if(initialized) return; initialized=true; for(const [id,event,listener] of bindings) document.getElementById(id)?.addEventListener(event,listener); },
    destroy() { initialized=false; deactivate(); for(const [id,event,listener] of bindings) document.getElementById(id)?.removeEventListener(event,listener); },
  };
}
