import { parseArchiveDeletion, parseArchiveDeletionPreview } from '../../../shared/api/archive-library.js';
import type { ApiClient } from './api.js';
import type { ConfirmAction } from './confirmation.js';

export async function repreviewArchiveDeletion(options: {
  id: string; trigger: HTMLElement; request: ApiClient['request']; confirm: ConfirmAction;
  formatBytes(value: number): string; current(): boolean;
}) {
  const {id, trigger, request, confirm, formatBytes, current} = options;
  const preview = parseArchiveDeletionPreview(await request('/api/archive-deletions/' + encodeURIComponent(id) + '/repreview', {method:'POST'}));
  if (!current()) return null;
  const account = preview.scope === 'account';
  const requiredText = account ? 'DELETE REMOTE ARCHIVE' : 'DELETE ARCHIVE';
  const confirmed = await confirm({
    title:account ? '重新确认账号归档清理' : '重新确认来源归档清理',
    message:'新的预览包含 ' + preview.fileCount + ' 个已追踪文件，共 ' + formatBytes(preview.totalBytes) + '。',
    detail:preview.sharedCount ? preview.sharedCount + ' 个共享文件只解除目标来源，不删除物理文件。' : '删除前会重新核验全部文件，未知文件不会被删除。',
    requiredText, confirmText:'开始清理', trigger,
  });
  if (!confirmed || !current()) return null;
  return parseArchiveDeletion(await request('/api/archive-deletions/' + encodeURIComponent(preview.previewId) + '/start', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirmation:requiredText}),
  }));
}
