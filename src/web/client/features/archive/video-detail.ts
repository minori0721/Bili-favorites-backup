import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseVideoDetailPage, type VideoDetailPage } from '../../../../shared/api/video-detail.js';
import type { createVideoCards } from './video-card.js';

export function createVideoDetail(dependencies:{root:Document;api:ApiClient;cards:Pick<ReturnType<typeof createVideoCards>,'render'|'release'>;formatDateTime(value:string):string;
  open(modal:HTMLElement):void;close(modal:HTMLElement):void;play(bvid:string,trigger:HTMLElement):void;notify(message:string):void;}) {
  const {root:document,api,formatDateTime,cards}=dependencies;
  const element=(id:string)=>requireElement(document,'#'+id,HTMLElement);
  const modal=element('videoDetailModal');const grid=element('videoGrid');
  const setHidden=(target:HTMLElement,hidden:boolean)=>target.classList.toggle('is-hidden',hidden);
  let initialized=false;let context:{userId:string;mediaId:number;title:string}|null=null;let filter='all';let page=0;let hasMore=false;
  let generation=0;let request:AbortController|null=null;let timer:ReturnType<typeof setTimeout>|null=null;const keys=new Set<string>();
  function cancel(){generation++;request?.abort();request=null;if(timer!==null)clearTimeout(timer);timer=null;}
  function deactivate(){cancel();hasMore=false;context=null;keys.clear();cards.release(grid);grid.replaceChildren();}
  function status(text:string,error=false,retry=false){
    grid.querySelector('[data-status-marker="video-detail"]')?.remove();if(!text)return;
    const host=document.createElement('div');host.dataset.statusMarker='video-detail';
    host.className=(/加载|正在/.test(text)?'empty-state loading-state':'empty-state')+(error?' video-detail-status error':' video-detail-status');
    host.textContent=text;
    if(retry){const button=document.createElement('button');button.type='button';button.className='ghost retry-button';button.textContent='重试';button.addEventListener('click',()=>{void load();});host.appendChild(button);}
    grid.appendChild(host);
  }
    const videoDetailFilterButtons = [
      { id: 'vdFilterAllBtn', filter: 'all' },
      { id: 'vdFilterUploadedBtn', filter: 'uploaded' },
      { id: 'vdFilterPendingBtn', filter: 'pending' },
      { id: 'vdFilterPendingUnavailableBtn', filter: 'pending_unavailable' },
      { id: 'vdFilterUploadedUnavailableBtn', filter: 'uploaded_unavailable' },
    ];

    function setVideoDetailFilterActive(filter: string) {
      videoDetailFilterButtons.forEach(({ id, filter: value }) => {
        const btn = element(id);
        if (btn) {
          btn.classList.toggle('active', value === filter);
        }
      });
    }

    function updateVideoDetailFilterCounts(summary: VideoDetailPage['summary']) {
      const s = summary || {
        total: 0,
        uploaded: 0,
        pending: 0,
        pendingUnavailable: 0,
        uploadedUnavailable: 0,
      };
      element('vdFilterAllBtn').textContent = '全部 (' + (s.total || 0) + ')';
      element('vdFilterUploadedBtn').textContent = '已上传 (' + (s.uploaded || 0) + ')';
      element('vdFilterPendingBtn').textContent = '未上传 (' + (s.pending || 0) + ')';
      element('vdFilterPendingUnavailableBtn').textContent = '未上传并失效 (' + (s.pendingUnavailable || 0) + ')';
      element('vdFilterUploadedUnavailableBtn').textContent = '已上传且失效 (' + (s.uploadedUnavailable || 0) + ')';
    }

    function updateVideoDetailIndexHint(data: VideoDetailPage | null, filter: string) {
      let hint = document.querySelector<HTMLElement>('#videoDetailIndexHint');
      const grid = element('videoGrid');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'videoDetailIndexHint';
        hint.className = 'video-detail-hint';
        grid.parentElement?.insertBefore(hint, grid);
      }
      if (!data) {
        hint.textContent = '';
        setHidden(hint, true);
        return;
      }
      const indexSummary = data.indexSummary;
      const summary = data.summary;
      const indexed = Number(indexSummary?.indexed || 0);
      const biliTotal = Number(indexSummary?.biliTotal || 0);
      const scanComplete = Boolean(indexSummary?.scanComplete);
      const unreturnedCount = Number(indexSummary?.unreturnedCount || 0);
      const activeTotal = Number(summary?.activeTotal || indexSummary?.activeTotal || 0);
      const historicalTotal = Number(summary?.historicalTotal || indexSummary?.historicalTotal || 0);
      const parts = [];
      if (data.source === 'bili') {
        parts.push('列表来自 B 站实时数据；备份状态只基于已索引记录。');
      } else {
        parts.push('列表来自本地索引，不会因打开详情请求 B 站。');
        if (data.lastSyncedAt) parts.push('最近同步：' + formatDateTime(data.lastSyncedAt) + '。');
      }
      parts.push('当前记录 ' + activeTotal + ' 项，历史记录 ' + historicalTotal + ' 项。');
      setHidden(hint, false);
      if (scanComplete && unreturnedCount > 0) {
        parts.push('B 站报告 ' + biliTotal + ' 项，当前活动关系已索引 ' + indexed + ' 项；另有 ' + unreturnedCount + ' 项未返回具体视频信息。');
      } else if (data.coverage === 'partial' && biliTotal > indexed) {
        parts.push('当前索引覆盖 ' + indexed + '/' + biliTotal + ' 项，筛选数量尚不是最终结果。');
      } else if (data.source === 'bili' && filter !== 'all') {
        parts.push('当前筛选仅覆盖已索引记录。');
      }
      hint.textContent = parts.join('');
    }


  async function load(){
    if(!initialized||!context||request||!hasMore)return;
    const token=generation;const nextPage=page+1;const controller=new AbortController();request=controller;
    status(nextPage===1?'加载视频列表...':'加载更多...');
    const url='/api/users/'+encodeURIComponent(context.userId)+'/favorites/'+context.mediaId+'/detail-items?page='+nextPage+'&pageSize=20&filter='+encodeURIComponent(filter)+'&folderTitle='+encodeURIComponent(context.title||'favorites');
    try{
      const data=parseVideoDetailPage(await api.silent(url,{signal:controller.signal}));
      if(token!==generation||controller.signal.aborted)return;
      updateVideoDetailFilterCounts(data.summary);updateVideoDetailIndexHint(data,filter);
      page=data.page||nextPage;hasMore=data.hasMore;
      if(nextPage===1&&!data.items.length){hasMore=false;grid.replaceChildren();status(data.source==='bili'?'此收藏夹为空':'已索引范围内没有匹配视频');return;}
      grid.querySelector('[data-status-marker="video-detail"]')?.remove();
      for(const item of data.items){if(keys.has(item.bvid))continue;keys.add(item.bvid);grid.appendChild(cards.render(item,grid));}
      status(hasMore?'':'已加载全部');
    }catch(error){
      if(token!==generation||controller.signal.aborted)return;
      const message=error instanceof Error?error.message:String(error);
      status(/412|风控|risk/i.test(message)?'触发B站风控，请等待几分钟后再试':'加载失败: '+message,true,true);dependencies.notify(message);
    }finally{if(request===controller)request=null;}
  }
  async function select(next:string){
    if(!context)return;cancel();filter=next;page=0;hasMore=true;keys.clear();cards.release(grid);grid.replaceChildren();grid.scrollTop=0;setVideoDetailFilterActive(filter);await load();
  }
  async function open(userId:string,mediaId:number,title:string){
    if(!initialized)return;cancel();context={userId,mediaId,title};filter='all';page=0;hasMore=true;keys.clear();cards.release(grid);
    element('videoDetailTitle').textContent='📁 '+title;setVideoDetailFilterActive(filter);updateVideoDetailFilterCounts(null);updateVideoDetailIndexHint(null,filter);grid.replaceChildren();grid.scrollTop=0;
    dependencies.open(modal);await load();
  }
  function scroll(){if(!context||!modal.classList.contains('active')||grid.scrollHeight-grid.scrollTop-grid.clientHeight>=120||timer!==null)return;timer=setTimeout(()=>{timer=null;void load();},800);}
  function play(event:MouseEvent|KeyboardEvent){
    if(event instanceof KeyboardEvent && event.key!=='Enter'&&event.key!==' ')return;
    const target=event.target;const row=target instanceof Element?target.closest<HTMLElement>('[data-playback-bvid]'):null;
    if(!row?.dataset.playbackBvid)return;
    if(event instanceof KeyboardEvent && target!==row)return;
    if(event instanceof MouseEvent && target instanceof Element && target.closest('button,a,input,select,textarea'))return;
    event.preventDefault();dependencies.play(row.dataset.playbackBvid,row);
  }
  const close=()=>dependencies.close(modal);
  const bindings=videoDetailFilterButtons.map(({id,filter})=>({target:element(id),handler:()=>{void select(filter);}}));
  return {open,deactivate,context:()=>context?{...context}:null,init(){if(initialized)return;initialized=true;bindings.forEach(({target,handler})=>target.addEventListener('click',handler));element('closeVideoDetailBtn').addEventListener('click',close);grid.addEventListener('scroll',scroll);grid.addEventListener('click',play);grid.addEventListener('keydown',play);},
    destroy(){if(!initialized)return;initialized=false;bindings.forEach(({target,handler})=>target.removeEventListener('click',handler));element('closeVideoDetailBtn').removeEventListener('click',close);grid.removeEventListener('scroll',scroll);grid.removeEventListener('click',play);grid.removeEventListener('keydown',play);deactivate();}};
}
