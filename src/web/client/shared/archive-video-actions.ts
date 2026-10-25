import type { ApiClient } from './api.js';
import type { ConfirmAction } from './confirmation.js';
import { requireElement } from './dom.js';
import { isRecord } from '../../../shared/api/value.js';
import { parseArchiveVideoContext,parseArchiveVideoPreview } from '../../../shared/api/archive-video-actions.js';
import { parseArchiveDeletion } from '../../../shared/api/archive-library.js';
import type { ArchiveVideoActionContext } from '../../../shared/archive-video-actions.js';
import { archiveDeletionImpactText } from './archive-deletion-impact.js';
import { archiveDeletionProgressText } from './archive-deletion.js';
import { stopArchiveDeletion } from './archive-deletion-actions.js';

export type ArchiveVideoSelection = {sourceId: string} | {userId: string; mediaId: number};
export function createArchiveVideoActionController(deps: {
  root: Document; api: ApiClient; confirm: ConfirmAction;
  open(id: string,trigger: HTMLElement): void; close(id: string): unknown;
  notify(message: string,kind?: 'success'|'error'): void;
  formatBytes(bytes: number): string;
  changed(operationId?: string): Promise<void>;
}) {
  const element=(id:string)=>requireElement(deps.root,'#'+id,HTMLElement);
  const review=requireElement(deps.root,'#upActionPreviewBtn',HTMLButtonElement);
  const status=element('upActionStatus');
  let events:AbortController|undefined,read:AbortController|undefined,context:ArchiveVideoActionContext|undefined;
  let identity:ArchiveVideoSelection|undefined,epoch=0,busy=false,poll:ReturnType<typeof setTimeout>|undefined;
  const key=(source:{userId:string;mediaId:number})=>JSON.stringify([source.userId,source.mediaId]);
  const json=(body:unknown,signal?:AbortSignal):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const url=(bvid:string,action:string)=>`/api/archive-library/items/${encodeURIComponent(bvid)}/actions/${action}`;
  const choice=(name:string)=>deps.root.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)?.value;
  function notice(text:string,error=false) {status.textContent=text;status.classList.toggle('error',error);}
  function stopPoll() {if(poll)clearTimeout(poll);poll=undefined;}
  function cleanupBlocked() {return Boolean(context?.cleanup && !['completed','stopped'].includes(context.cleanup.status));}
  function syncActions() {
    review.disabled=busy||!context||cleanupBlocked();
    for(const id of ['archiveActionRestoreVideo','archiveActionUnblock','archiveActionUnblockGlobal'])requireElement(deps.root,'#'+id,HTMLButtonElement).disabled=busy||cleanupBlocked();
    for(const id of ['archiveActionRetry','archiveActionStop'])requireElement(deps.root,'#'+id,HTMLButtonElement).disabled=busy;
  }
  function render() {
    if(!context) return;
    element('upActionTitle').textContent=context.title;
    element('archiveActionCurrentSource').textContent=`当前来源：${context.current.accountName} · ${context.current.title}`;
    element('archiveActionRule').textContent=context.globalExcluded
      ? '此视频已设置全局排除。解除后，各来源自己的排除仍然有效。'
      : context.current.excluded ? '此视频已在当前来源中排除，其他视频和来源不受影响。' : '此视频未在当前来源中排除。是否自动归档仍由来源的启用状态和归档范围决定。';
    const host=element('archiveActionSources');host.replaceChildren();
    for(const source of context.sources) {
      const label=deps.root.createElement('label'),input=deps.root.createElement('input'),text=deps.root.createElement('span');
      input.type='checkbox';input.dataset.archiveActionSource=key(source);input.checked=key(source)===key(context.current);
      text.textContent=`${source.accountName} · ${source.title}${source.excluded?'（已排除）':''}`;
      label.append(input,text);host.append(label);
    }
    element('archiveActionUnblock').hidden=!context.current.excluded;
    element('archiveActionRestoreVideo').hidden=!context.current.excluded||context.current.sourceKind!=='up'||context.globalExcluded;
    element('archiveActionUnblockGlobal').hidden=!context.globalExcluded;
    element('archiveActionStop').hidden=context.cleanup?.status!=='failed';
    element('archiveActionRetry').hidden=context.cleanup?.status!=='failed';
    updateScope();syncActions();
  }
  function updateScope() {
    element('archiveActionSources').hidden=choice('upScope')!=='selected';
    const scope=choice('upScope');
    element('archiveActionScopeHint').textContent=scope==='global'
      ? '此视频会在所有来源（包括以后新发现的来源）中排除；其他视频不受影响。需要主动解除全局排除后才恢复。'
      : scope==='selected' ? '只在勾选的来源中排除此视频；其他视频和未勾选的来源不受影响。' : '只在当前来源中排除此视频，其他视频和来源不受影响。';
  }
  async function refreshChanged(operationId?:string) {
    try {await deps.changed(operationId);} catch {deps.notify('操作已提交，列表暂时刷新失败，请稍后刷新。','error');}
  }
  async function progress(id:string,token:number) {
    if(token!==epoch || !context)return;
    try {
      const operation=parseArchiveDeletion(await deps.api.silent('/api/archive-deletions/'+encodeURIComponent(id)));
      if(token!==epoch)return;
      context.cleanup=operation;render();
      notice(archiveDeletionProgressText(operation));
      if(operation.status==='completed') {await refreshChanged();return;}
      if(operation.status==='failed') {notice('归档清理未完成，排除规则仍然有效。'+(operation.lastError?`原因：${operation.lastError}。`:'')+'可以重试，或停止剩余清理后再恢复归档。',true);return;}
      if(operation.status==='stopped')return;
    } catch {if(token===epoch)notice('清理已提交，暂时无法读取进度。关闭窗口不会取消后台清理。',true);}
    if(token===epoch)poll=setTimeout(()=>void progress(id,token),1500);
  }
  async function submit() {
    if(!context || !identity || busy)return;
    stopPoll();
    const token=++epoch,ctx=context,selectedIdentity=identity;
    busy=true;review.disabled=true;
    try {
      notice('正在核对来源、共享文件和预计释放空间…');
      const selectedKeys=new Set(Array.from(deps.root.querySelectorAll<HTMLInputElement>('[data-archive-action-source]:checked')).map(input=>input.dataset.archiveActionSource));
      const selected=ctx.sources.filter(source=>selectedKeys.has(key(source))).map(source=>({userId:source.userId,mediaId:source.mediaId}));
      const preview=parseArchiveVideoPreview(await deps.api.silent(url(ctx.bvid,'preview'),json({...selectedIdentity,scope:choice('upScope'),effect:choice('upEffect'),sources:selected})));
      if(token!==epoch)return;
      const names=preview.sources.map(source=>`${source.accountName} · ${source.title}`).join('；');
      const kept=preview.retainedSources.map(source=>`${source.accountName} · ${source.title}`).join('；');
      const confirmed=await deps.confirm({title:preview.effect==='delete'?'删除归档，并排除此视频':'保留归档，排除此视频',message:`${ctx.title}\n影响来源：${names}`,
        detail:(preview.effect==='delete'?archiveDeletionImpactText(preview,deps.formatBytes):'已有文件与播放能力保留。')+(kept?`\n不受影响的来源：${kept}。`:'')+
          (preview.scope==='global'?'\n此视频会在所有来源（包括以后新发现的来源）中排除，其他视频不受影响。':'\n仅在所选来源中排除此视频，其他视频不受影响。'),
        requiredText:preview.effect==='delete'?preview.confirmation:undefined,confirmText:preview.effect==='delete'?'确认删除':'确认排除',danger:preview.effect==='delete',trigger:review});
      if(!confirmed || token!==epoch) {if(token===epoch)notice('尚未提交操作。');return;}
      notice('正在提交。关闭窗口不会撤销已提交的操作。');
      const result=await deps.api.silent(url(ctx.bvid,'commit'),json({...selectedIdentity,previewId:preview.previewId,confirmation:preview.confirmation}));
      if(token!==epoch)return;
      if(!isRecord(result) || typeof result.retained!=='boolean' || (result.operation!==null && (!isRecord(result.operation)||typeof result.operation.id!=='string')))throw new Error('归档操作结果格式错误');
      const operationId=isRecord(result.operation)?String(result.operation.id):undefined;
      const refreshed=parseArchiveVideoContext(await deps.api.silent(url(ctx.bvid,'context'),json(selectedIdentity)));
      if(token!==epoch)return;
      context=refreshed;render();
      await refreshChanged(operationId);
      if(token!==epoch)return;
      if(operationId){notice('排除规则已保存，后台归档清理已安排。关闭窗口不会取消清理。');void progress(operationId,token);}
      else notice(preview.effect==='delete'?'排除规则已保存，当前没有需要删除的已验证归档文件。':'此视频已从所选来源的自动归档中排除，已有文件保留。');
    }catch(error){if(token===epoch)notice(error instanceof Error?error.message:String(error),true);}
    finally{busy=false;if(token===epoch)syncActions();}
  }
  async function unblock(scope:'source'|'global',trigger:HTMLElement,mode:'rule'|'include'='rule') {
    if(!context || !identity || busy)return;
    const confirmationEpoch=epoch;
    if(!await deps.confirm({title:mode==='include'?'恢复归档此视频':'解除排除',message:scope==='global'?'解除这个视频的全局排除？各来源自己的排除仍然保留。':mode==='include'?'解除当前订阅的排除，并将这个视频加入单独选择。订阅启用后会安排缺失部分的归档。':'解除当前来源的排除，之后按来源规则决定是否归档。“只归档选中的”不会因此自动加入已选。',confirmText:mode==='include'?'恢复归档':'解除排除',danger:false,trigger}) || confirmationEpoch!==epoch)return;
    stopPoll();const token=++epoch;
    busy=true;review.disabled=true;
    try {const refreshed=parseArchiveVideoContext(await deps.api.silent(url(context.bvid,'unblock'),json({...identity,scope,mode})));if(token!==epoch)return;context=refreshed;render();notice(context.globalExcluded?'当前来源排除已解除，但全局排除仍然有效。':mode==='include'?'此视频已加入单独选择；订阅启用后会归档，现有有效文件会复用。':'排除已解除；是否归档仍由来源的启用状态和归档范围决定。');await refreshChanged();}
    catch(error){if(token===epoch)notice(error instanceof Error?error.message:String(error),true);}
    finally{busy=false;if(token===epoch)syncActions();}
  }
  async function cleanupAction(kind:'retry'|'stop',trigger:HTMLElement) {
    if(!context?.cleanup||!identity||busy)return;
    const id=context.cleanup.id,bvid=context.bvid,source=identity;stopPoll();const token=++epoch;busy=true;syncActions();
    try {
      const operation=kind==='stop'?await stopArchiveDeletion({id,trigger,request:deps.api.silent,confirm:deps.confirm,current:()=>token===epoch})
        : parseArchiveDeletion(await deps.api.silent('/api/archive-deletions/'+encodeURIComponent(id)+'/retry',json({})));
      if(!operation||token!==epoch)return;
      const refreshed=parseArchiveVideoContext(await deps.api.silent(url(bvid,'context'),json(source)));
      if(token!==epoch)return;context=refreshed;render();notice(archiveDeletionProgressText(operation));
      await refreshChanged(kind==='retry'?id:undefined);if(token!==epoch)return;
      if(kind==='retry')void progress(id,token);
    }catch(error){if(token===epoch)notice(error instanceof Error?error.message:String(error),true);}
    finally{busy=false;if(token===epoch)syncActions();}
  }
  function deactivate() {epoch++;read?.abort();read=undefined;stopPoll();context=undefined;identity=undefined;}
  return {
    async open(bvid:string,source:ArchiveVideoSelection,trigger:HTMLElement) {
      if(busy)return;
      deactivate();identity=source;const token=epoch;read=new AbortController();
      element('upActionTitle').textContent='管理归档';notice('正在读取归档来源…');review.disabled=true;
      for(const [name,value] of [['upScope','source'],['upEffect','retain']]) {const input=deps.root.querySelector<HTMLInputElement>(`input[name=${name}][value=${value}]`);if(input)input.checked=true;}
      deps.open('upActionModal',trigger);
      try{const ctx=parseArchiveVideoContext(await deps.api.silent(url(bvid,'context'),json(source,read.signal)));if(token!==epoch)return;context=ctx;render();notice(ctx.cleanup?archiveDeletionProgressText(ctx.cleanup):'先选择操作方式和影响范围，再核对确认。');if(ctx.cleanup&&!['failed','completed','stopped'].includes(ctx.cleanup.status))void progress(ctx.cleanup.id,token);}
      catch(error){if(token===epoch)notice(error instanceof Error?error.message:String(error),true);}
    },
    canClose(){if(busy){deps.notify('正在核对或提交操作，请稍候。','error');return false;}return true;},
    deactivate,
    init(){if(events)return;events=new AbortController();const signal=events.signal;review.addEventListener('click',()=>void submit(),{signal});
      deps.root.querySelectorAll<HTMLInputElement>('input[name=upScope]').forEach(input=>input.addEventListener('change',updateScope,{signal}));
      const local=element('archiveActionUnblock'),global=element('archiveActionUnblockGlobal');
      local.addEventListener('click',()=>void unblock('source',local),{signal});
      global.addEventListener('click',()=>void unblock('global',global),{signal});
      const restore=element('archiveActionRestoreVideo'),retry=element('archiveActionRetry'),stop=element('archiveActionStop');
      restore.addEventListener('click',()=>void unblock('source',restore,'include'),{signal});
      retry.addEventListener('click',()=>void cleanupAction('retry',retry),{signal});
      stop.addEventListener('click',()=>void cleanupAction('stop',stop),{signal});
      deps.root.querySelectorAll<HTMLElement>('[data-archive-action-close]').forEach(button=>button.addEventListener('click',()=>deps.close('upActionModal'),{signal}));},
    destroy(){events?.abort();events=undefined;deactivate();},
  };
}
