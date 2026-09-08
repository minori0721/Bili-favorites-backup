import type { QueueBoardDisplayItem } from '../../../../shared/api/queue-item.js';
import { isRecord } from '../../../../shared/api/value.js';
import type { ApiClient } from '../../shared/api.js';
import type { ConfirmAction } from '../../shared/confirmation.js';

interface Options {
  root: HTMLElement;
  api: ApiClient;
  confirm: ConfirmAction;
  refresh(): Promise<void>;
  notify(message: string, kind: 'success' | 'error'): void;
  openIssues(trigger: HTMLElement, issueId: string): void;
}

export function createQueueRecoveryActions({ root, api, confirm, refresh, notify, openIssues }: Options) {
  const document = root.ownerDocument;
  const pending = new Map<string, AbortController>();
  let generation = 0;

  async function recover(jobId: string, allowReupload: boolean, trigger: HTMLButtonElement) {
    if (pending.has(jobId) || !root.contains(trigger)) return;
    const token = generation;
    const controller = new AbortController();
    pending.set(jobId, controller);
    const buttons = Array.from(trigger.closest('.queue-card')?.querySelectorAll<HTMLButtonElement>('.queue-recovery-actions button') || []);
    buttons.forEach(button => { button.disabled = true; });
    try {
      if (allowReupload && !await confirm({
        title: '确认继续上传',
        message: '会重新检查正式远端路径；只有目标不存在时才再次PUT。',
        detail: '如果远端已经存在不同大小的文件，系统仍会停在冲突状态，不会覆盖它。',
        confirmText: '继续上传', trigger,
      })) return;
      if (generation !== token || controller.signal.aborted) return;
      const result = await api.request('/api/queue/recover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, allowReupload }), signal: controller.signal,
      });
      if (generation !== token || controller.signal.aborted) return;
      notify(!allowReupload && isRecord(result) && result.resolved === 'verified_archive'
        ? '已确认现有归档，未重复上传'
        : (allowReupload ? '已开始重新确认并允许一次重传' : '已开始重新确认远端文件'), 'success');
      await refresh();
    } catch (error) {
      if (generation === token && !controller.signal.aborted) notify(error instanceof Error ? error.message : '恢复上传失败', 'error');
    } finally {
      if (pending.get(jobId) === controller) pending.delete(jobId);
      if (generation === token) buttons.forEach(button => { button.disabled = false; });
    }
  }

    function render(card: HTMLElement, item: QueueBoardDisplayItem) {
      const info = card.querySelector('.queue-info');
      if (!info) return;
      let actions = info.querySelector<HTMLElement>('.queue-recovery-actions');
      const shouldShow = Boolean(item.awaitingManualRecovery && item.recoveryJobId && item.recoveryDisposition !== 'background');
      if (!shouldShow) {
        if (actions) actions.remove();
        return;
      }
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'queue-recovery-actions';
        info.appendChild(actions);
      }
      const mediaProfileRecovery = ['remote_size_limit', 'remote_write_rejected', 'encoding_retry_failed'].includes(String(item.recoveryKind || ''));
      let confirmButton = actions.querySelector<HTMLButtonElement>('[data-recovery-action="recheck"]');
      if (!confirmButton) {
        confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.dataset.recoveryAction = 'recheck';
        actions.appendChild(confirmButton);
      }
      confirmButton.textContent = '重新确认';
      confirmButton.title = '只检查正式远端文件，不重复上传';
      confirmButton.onclick = () => void recover(String(item.recoveryJobId), false, confirmButton);

      let uploadButton = actions.querySelector<HTMLButtonElement>('[data-recovery-action="reupload"]');
      if (!uploadButton) {
        uploadButton = document.createElement('button');
        uploadButton.type = 'button';
        uploadButton.className = 'danger-action';
        uploadButton.dataset.recoveryAction = 'reupload';
        actions.appendChild(uploadButton);
      }
      uploadButton.textContent = '继续上传';
      uploadButton.title = '允许本次缺失文件重新PUT一次';
      uploadButton.hidden = mediaProfileRecovery;
      uploadButton.onclick = () => void recover(String(item.recoveryJobId), true, uploadButton);

      const supportsEncodingRetry = Array.isArray(item.recoveryActions)
        && item.recoveryActions.some((action) => action.id === 'redownload_with_encoding')
        && item.recoveryIssueId;
      const existingEncodingButton = actions.querySelector<HTMLButtonElement>('[data-recovery-action="redownload_with_encoding"]');
      if (!supportsEncodingRetry) {
        existingEncodingButton?.remove();
        return;
      }
      const encodingButton = existingEncodingButton || document.createElement('button');
      encodingButton.type = 'button';
      encodingButton.dataset.recoveryAction = 'redownload_with_encoding';
      encodingButton.textContent = '换规格';
      encodingButton.title = '重新选择画质与编码，查看预计大小后在隔离目录严格下载';
      encodingButton.onclick = () => openIssues(encodingButton, String(item.recoveryIssueId));
      if (!existingEncodingButton) actions.appendChild(encodingButton);
    }


  function destroy() {
    generation += 1;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }
  return { render, destroy };
}
