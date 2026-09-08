import { isRecord, type ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import { parseProbeReference, parseProbeSummary } from '../../../../shared/api/media-probe.js';
import type { OnlineItem } from '../../../../shared/api/online-content.js';

export type ManualArchiveItem = OnlineItem;
export interface ManualArchiveContext {userId:string|null;kind:string;mediaId:number|null;title:string;query:string}

export function createManualArchive(dependencies:{
  root:ParentNode;api:ApiClient;formatBytes(bytes:number):string;
  open(modal:HTMLElement,trigger:HTMLElement):void;close(modal:HTMLElement):void;
  committed(item:ManualArchiveItem,context:ManualArchiveContext):void;
  notify(message:string):void;
}) {
  const {root,api}=dependencies;
  const modal=requireElement(root,'#manualArchiveOptionsModal',HTMLElement);
  const title=requireElement(root,'#manualArchiveOptionsVideo',HTMLElement);
  const quality=requireElement(root,'#manualArchiveQuality',HTMLSelectElement);
  const encoding=requireElement(root,'#manualArchiveEncoding',HTMLSelectElement);
  const probeButton=requireElement(root,'#manualArchiveProbeBtn',HTMLButtonElement);
  const startButton=requireElement(root,'#manualArchiveStartBtn',HTMLButtonElement);
  const cancelButton=requireElement(root,'#manualArchiveCancelBtn',HTMLButtonElement);
  const output=requireElement(root,'#manualArchiveProbeResult',HTMLElement);
  let initialized=false;
  let generation=0;
  let probeGeneration=0;
  let item:ManualArchiveItem|null=null;
  let context:ManualArchiveContext|null=null;
  let probe:AbortController|null=null;
  let submit:AbortController|null=null;
  let timer:ReturnType<typeof setTimeout>|null=null;
  const selection=()=>({quality:quality.value||undefined,encoding:encoding.value||undefined,strict:Boolean(quality.value||encoding.value)});
  function message(text:string,error=false){output.textContent=text;output.classList.toggle('error',error);}
  function summary(result:ReturnType<typeof parseProbeSummary>) {
    if(result.status==='running')return '正在读取 B 站媒体组合，请稍候...';
    if(result.status==='failed')return result.error||'媒体探测失败；仍可严格尝试，但可能因源不存在而进入待处理。';
    const sources:Record<string,string>={api:'接口大小',bitrate_estimate:'码率估算',head:'HEAD 精确大小',range:'Range 精确大小',mixed:'混合来源'};
    const bytes=result.estimatedBytes||0;
    const size=bytes>0?' · '+(result.estimatedBytesKind==='final'?'预计成品':'预计视频流')+' '+dependencies.formatBytes(bytes)+'（'+(sources[result.estimatedBytesSource]||'未知来源')+'）':'';
    const peak=(result.estimatedPeakBytes||0)>0?' · 本地峰值约 '+dependencies.formatBytes(result.estimatedPeakBytes||0):'';
    const capacity=result.cacheAvailableBytes;
    const available=capacity!==undefined?' · 缓存可用 '+dependencies.formatBytes(capacity):'';
    const warning=capacity!==undefined&&(result.estimatedPeakBytes||0)>capacity?' · 空间可能不足':'';
    const legacy=result.estimatedBytesKind==='video_only'?' · 当前BBDown未提供音频大小':'';
    return '已探测 '+result.pageCount+' 个分P · 可用组合 '+result.combinations.filter(item=>item.available).length+'/'+result.combinations.length+size+peak+available+warning+legacy;
  }
  function deactivate(){
    generation++;probeGeneration++;
    probe?.abort();submit?.abort();probe=null;submit=null;
    if(timer!==null)clearTimeout(timer);timer=null;
    item=null;context=null;
    probeButton.disabled=false;startButton.disabled=false;
  }
  async function startProbe(){
    if(!initialized||!item?.bvid||!context?.userId||probe)return;
    const request=new AbortController();probe=request;
    const currentGeneration=generation;const currentProbe=++probeGeneration;
    const current=()=>initialized&&generation===currentGeneration&&probeGeneration===currentProbe&&!request.signal.aborted;
    probeButton.disabled=true;message('正在启动媒体探测...');
    async function poll(id:string){
      try{
        const result=parseProbeSummary(await api.silent('/api/media-probe/'+encodeURIComponent(id),{signal:request.signal}));
        if(!current())return;
        message(summary(result),result.status==='failed');
        if(result.status==='running')timer=setTimeout(()=>{timer=null;void poll(id);},700);
        else{probe=null;probeButton.disabled=false;}
      }catch(error){
        if(!current())return;
        probe=null;probeButton.disabled=false;
        message(error instanceof Error?error.message:'探测状态读取失败',true);
      }
    }
    try{
      const id=parseProbeReference(await api.silent('/api/media-probe',{method:'POST',headers:{'Content-Type':'application/json'},signal:request.signal,
        body:JSON.stringify({userId:context.userId,bvid:item.bvid,...selection()})}));
      if(current())await poll(id);
    }catch(error){
      if(!current())return;
      probe=null;probeButton.disabled=false;
      message(error instanceof Error?error.message:'媒体探测失败',true);
    }
  }
  async function start(){
    if(!initialized||submit||!item?.bvid||!context?.userId)return;
    const target=item;const source=context;const currentGeneration=generation;
    const request=new AbortController();submit=request;startButton.disabled=true;
    const current=()=>initialized&&generation===currentGeneration&&submit===request&&!request.signal.aborted;
    try{
      const result=await api.silent('/api/online-content/manual-archive',{method:'POST',headers:{'Content-Type':'application/json'},signal:request.signal,
        body:JSON.stringify({userId:source.userId,token:target.coverToken,...selection()})});
      if(!current())return;
      if(!isRecord(result)||typeof result.status!=='string')throw new Error('手动归档响应格式错误');
      target.archiveState=result.status==='already_archived'?'archived':'processing';
      dependencies.close(modal);
      dependencies.committed(target,source);
    }catch(error){
      if(!current())return;
      const text=error instanceof Error?error.message:String(error);
      message('归档提交失败：'+text,true);dependencies.notify(text);
    }finally{if(submit===request){submit=null;startButton.disabled=false;}}
  }
  const onProbe=()=>{void startProbe();};const onStart=()=>{void start();};const onCancel=()=>dependencies.close(modal);
  return {deactivate,
    open(target:ManualArchiveItem,source:ManualArchiveContext,trigger:HTMLElement){
      if(!initialized)return;
      deactivate();item=target;context={...source};
      title.textContent=(target.title||target.bvid||'在线条目')+(target.bvid?' · '+target.bvid:'');
      quality.value='';encoding.value='';
      message('默认偏好会允许正常回退。选择画质或编码后，可先探测可用组合和预计大小。');
      dependencies.open(modal,trigger);
    },
    init(){if(initialized)return;initialized=true;probeButton.addEventListener('click',onProbe);startButton.addEventListener('click',onStart);cancelButton.addEventListener('click',onCancel);},
    destroy(){if(!initialized)return;initialized=false;deactivate();probeButton.removeEventListener('click',onProbe);startButton.removeEventListener('click',onStart);cancelButton.removeEventListener('click',onCancel);},
  };
}
