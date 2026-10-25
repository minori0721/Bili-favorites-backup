import { parseArchiveDeletion, parseArchiveDeletionPreview } from '../../../shared/api/archive-library.js';
import type { ApiClient } from './api.js';
import type { ConfirmAction } from './confirmation.js';
import { archiveDeletionImpactText } from './archive-deletion-impact.js';

export async function stopArchiveDeletion(options:{id:string;trigger:HTMLElement;request:ApiClient['request'];confirm:ConfirmAction;current():boolean}) {
  const confirmed=await options.confirm({title:'停止剩余清理',message:'保留尚未删除的文件，结束这次失败的清理。',
    detail:'已经删除的文件不会恢复。现有排除规则继续保留；如需重新归档，请在停止后另行恢复。',requiredText:'STOP ARCHIVE CLEANUP',confirmText:'停止剩余清理',danger:false,trigger:options.trigger});
  if(!confirmed||!options.current())return null;
  return parseArchiveDeletion(await options.request('/api/archive-deletions/'+encodeURIComponent(options.id)+'/stop',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:'STOP ARCHIVE CLEANUP'}),
  }));
}

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
    message:'请核对新的清理范围。只重试本次已确认来源，不扩大到其他来源。',
    detail:archiveDeletionImpactText(preview,formatBytes),
    requiredText, confirmText:'开始清理', trigger,
  });
  if (!confirmed || !current()) return null;
  return parseArchiveDeletion(await request('/api/archive-deletions/' + encodeURIComponent(preview.previewId) + '/start', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirmation:requiredText}),
  }));
}
