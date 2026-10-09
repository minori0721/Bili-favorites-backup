import type { ApiClient } from '../../shared/api.js';
import { requireElement } from '../../shared/dom.js';
import type { ConfirmAction } from '../../shared/confirmation.js';
import { isRecord } from '../../../../shared/api/value.js';
import { parseUpList,parseUpIdentity,parseUpDiscovery,parseUpSubscription,parseUpCatalog,parseUpActionPreview,parseUpPosts,parseUpRemovalPreview,parseUpRemovalResult } from '../../../../shared/api/up-subscriptions.js';
import type { UpSubscription,UpIdentity,UpCatalogItem,UpSubscriptionMode,UpVideoDecision,UpRemovalPreview } from '../../../../shared/up-subscriptions.js';
import { archiveDeletionProgressText } from '../../shared/archive-deletion.js';

const modeText:Record<UpSubscriptionMode,string>={all:'全部投稿',from_now:'从订阅时起',from_date:'从日期开始',from_video:'从视频开始',selected:'只归档选中的'};
const date=(time:number|null)=>time===null?'尚未扫描':new Date(time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const day=(time:number)=>{const value=new Date(time);return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;};
function errorText(error:unknown){return error instanceof Error?error.message:'请求失败，请重试';}
function mode(value:string):UpSubscriptionMode {if(value==='all'||value==='from_now'||value==='from_date'||value==='from_video'||value==='selected')return value;throw new Error('归档方式无效');}
export function createUpSubscriptions(deps:{
  root:Document;api:ApiClient;confirm:ConfirmAction;
  openModal(id:string,trigger?:HTMLElement|null):void;closeModal(id:string):unknown;
  notify(message:string,kind?:'success'|'error'):void;
  openArchive(sourceId:string,trigger:HTMLElement|null):void;
  play(bvid:string,trigger:HTMLElement):void;
}) {
  const root=deps.root;
  const element=(id:string)=>requireElement(root,'#'+id,HTMLElement);
  const input=(id:string)=>requireElement(root,'#'+id,HTMLInputElement);
  const select=(id:string)=>requireElement(root,'#'+id,HTMLSelectElement);
  const button=(id:string)=>requireElement(root,'#'+id,HTMLButtonElement);
  const requests=new Map<string,AbortController>();
  const picked=new Map<number,UpIdentity>();
  const selected=new Set<string>();
  const pageItems=new Map<string,UpCatalogItem>();
  let events:AbortController|null=null;
  let generation=0;
  let list:ReturnType<typeof parseUpList>={items:[],accounts:[],operations:[]};
  let tab='followings';
  let discoveryPage=1;
  let discoveryMore=false;
  let catalogCursor:string|null=null;
  let filter='all';
  let current:UpSubscription|null=null;
  let actionItem:UpCatalogItem|null=null;
  let anchorPage=1;
  let mutation=false;
  let poll:ReturnType<typeof setTimeout>|null=null;
  let operationId:string|null=null;
  let removalSource:UpSubscription|null=null;
  let homePoll:ReturnType<typeof setTimeout>|null=null;

  function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string) {
    const result=root.createElement(tag);if(text!==undefined)result.textContent=text;if(className)result.className=className;return result;
  }
  function avatar(host:HTMLElement,name:string,url:string) {
    host.replaceChildren();host.textContent=name.slice(0,1)||'UP';
    if(!url)return;
    let safe:string;try{const parsed=new URL(url,location.origin);if(!['http:','https:'].includes(parsed.protocol))return;safe=parsed.href;}catch{return;}
    const image=node('img');image.src=safe;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';image.addEventListener('error',()=>{image.remove();host.textContent=name.slice(0,1)||'UP';},{once:true});host.replaceChildren(image);
  }
  function notice(id:string,message='',error=false){const host=element(id);host.textContent=message;host.classList.toggle('error',error);}
  function visible(id:string){return element(id).classList.contains('active');}
  function cancel(prefix:string){for(const [key,controller]of requests)if(key.startsWith(prefix)){controller.abort();requests.delete(key);}}
  async function request(channel:string,url:string,options:RequestInit={}):Promise<{kind:'ok';data:unknown}|{kind:'cancelled'}> {
    requests.get(channel)?.abort();const controller=new AbortController();requests.set(channel,controller);const epoch=generation;
    try {const data=await deps.api.silent(url,{...options,signal:controller.signal});
      return epoch===generation&&!controller.signal.aborted&&requests.get(channel)===controller?{kind:'ok',data}:{kind:'cancelled'};
    } catch(error){if(controller.signal.aborted||epoch!==generation)return {kind:'cancelled'};throw error;}
    finally{if(requests.get(channel)===controller)requests.delete(channel);}
  }
  const json=(body:unknown,method='POST'):RequestInit=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  function options(host:HTMLSelectElement,values:{value:string;label:string}[],chosen?:string){host.replaceChildren(...values.map(item=>{const option=node('option',item.label);option.value=item.value;return option;}));if(chosen)host.value=chosen;}
  function accounts(host:HTMLSelectElement,chosen?:string){options(host,list.accounts.map(account=>({value:account.id,label:account.name})),chosen);
    if(chosen&&!list.accounts.some(account=>account.id===chosen)){const option=node('option','当前授权账号不可用，请选择新账号');option.value=chosen;option.disabled=true;option.selected=true;host.prepend(option);}}
  function home() {
    const host=element('upHomeList');host.replaceChildren();
    if(!list.items.length){host.append(node('div','还没有订阅。添加一位 UP，让新投稿自动归档。','up-empty'));return;}
    for(const source of list.items){
      const card=node('article',undefined,'up-subscription-card'),heading=node('div',undefined,'up-profile-heading'),picture=node('span',undefined,'up-avatar');avatar(picture,source.name,source.avatar);
      const copy=node('div');copy.append(node('h3',source.name),node('p',`UID ${source.uid} · ${modeText[source.mode]}`,'muted'));heading.append(picture,copy);
      const bar=node('div',undefined,'up-card-heading'),remove=node('button','×','up-card-remove');remove.type='button';remove.dataset.upRemove=source.id;remove.title='移除订阅';remove.setAttribute('aria-label',`移除 ${source.name} 的订阅`);remove.setAttribute('aria-haspopup','dialog');bar.append(heading,remove);card.append(bar);
      const stats=node('div',undefined,'up-card-stats');for(const [label,count]of [['已归档',source.archivedCount],['发现投稿',source.discoveredCount],['已排除',source.excludedCount]] as const){const item=node('span',label);item.prepend(node('strong',String(count)));stats.append(item);}card.append(stats);
      const unavailable=source.accountAvailable===false;
      const badge=node('span',unavailable?'授权账号不可用':source.enabled?'持续订阅':'已暂停','up-badge'+(unavailable?' warning':source.enabled?'':' paused'));
      const status=node('p',` · ${source.historyComplete?'历史扫描完成':`历史扫描至第 ${source.nextPage} 页`} · ${date(source.lastScanAt)}`,'muted');status.style.fontSize='12px';status.prepend(badge);card.append(status);
      if(source.lastError)card.append(node('p',source.lastError,'up-notice error'));
      const actions=node('div',undefined,'row'),manage=node('button','投稿选择','ghost'),archive=node('button','归档库 ↗','ghost');manage.type=archive.type='button';manage.dataset.upManage=source.id;archive.dataset.upArchive=source.id;actions.append(manage,archive);card.append(actions);host.append(card);
    }
  }
  function removalOperations(){
    const host=element('upRemovalOperations');host.replaceChildren();host.hidden=list.operations.length===0;
    if(host.hidden)return;host.append(node('h3','订阅归档清理'));
    for(const operation of list.operations){
      const row=node('div',undefined,'up-removal-operation');row.dataset.state=operation.status;row.dataset.upRemovalOperation=operation.id;
      const copy=node('div');copy.append(node('strong',operation.sourceName),node('p',archiveDeletionProgressText(operation)));row.append(copy);
      if(operation.status==='failed'){
        const actions=node('div',undefined,'row'),retry=node('button','重试清理','ghost'),review=node('button','重新核对','ghost');retry.type=review.type='button';retry.dataset.upRemovalRetry=operation.id;review.dataset.upRemovalReview=operation.id;actions.append(retry,review);row.append(actions);
      }
      host.append(row);
    }
  }
  function scheduleHomePoll(){
    if(homePoll)clearTimeout(homePoll);homePoll=null;
    if(!events||visible('upWorkspaceModal')||!list.operations.some(item=>item.status!=='completed'&&item.status!=='failed'))return;
    homePoll=setTimeout(()=>{homePoll=null;void loadList().catch(error=>notice('upHomeStatus',errorText(error),true)).finally(scheduleHomePoll);},5000);
  }
  async function loadList() {
    const response=await request('home','/api/up-subscriptions');if(response.kind==='cancelled')return false;
    list=parseUpList(response.data);home();removalOperations();scheduleHomePoll();notice('upHomeStatus');
    if(current){const latest=list.items.find(item=>item.id===current?.id);if(latest)current=latest;}
    return true;
  }
  function syncPicked(){element('upPickedCount').textContent=`已选 ${picked.size} 位 UP`;button('upToRulesBtn').disabled=picked.size===0;}
  async function discover(pageNumber=1) {
    discoveryPage=pageNumber;const account=select('upDiscoveryAccount').value;if(!account){notice('upDiscoveryStatus','请先添加 B站账号',true);return;}
    const query=input('upDiscoveryQuery').value.trim();if(tab!=='followings'&&!query){notice('upDiscoveryStatus',tab==='resolve'?'输入 UID 或 B站主页链接':'输入 UP 名称或关键词');element('upDiscoveryList').replaceChildren();return;}
    notice('upDiscoveryStatus','正在查找…');button('upDiscoverySearchBtn').disabled=true;
    try {
      const params=new URLSearchParams({userId:account,page:String(pageNumber),q:query,value:query});
      const response=await request('add-discovery',`/api/up-discovery/${tab}?${params}`);if(response.kind==='cancelled')return;
      const data=tab==='resolve'?{items:[parseUpIdentity(response.data)],page:1,hasMore:false,total:1}:parseUpDiscovery(response.data);
      discoveryMore=data.hasMore;const host=element('upDiscoveryList');host.replaceChildren();
      if(!data.items.length)host.append(node('div','没有找到 UP，换个关键词试试。','up-empty'));
      for(const identity of data.items){
        const existing=list.items.find(item=>item.uid===identity.uid);const row=node('label',undefined,'up-person'),check=node('input');check.type='checkbox';check.checked=picked.has(identity.uid);check.disabled=Boolean(existing);check.setAttribute('aria-label',`选择 ${identity.name}`);
        check.addEventListener('change',()=>{if(check.checked)picked.set(identity.uid,identity);else picked.delete(identity.uid);syncPicked();});
        const picture=node('span',undefined,'up-avatar');avatar(picture,identity.name,identity.avatar);const copy=node('span',undefined,'up-person-copy');copy.append(node('strong',identity.name),node('small',identity.signature||`UID ${identity.uid}`));row.append(check,picture,copy);
        if(existing){const manage=node('button','已订阅','ghost');manage.type='button';manage.dataset.upManage=existing.id;row.append(manage);}
        else if(identity.followed===true)row.append(node('span','已关注','up-badge'));
        host.append(row);
      }
      notice('upDiscoveryStatus',`${data.total} 位 UP · 第 ${data.page} 页`);element('upDiscoveryPage').textContent=`第 ${data.page} 页`;
      button('upDiscoveryPrev').disabled=pageNumber<=1;button('upDiscoveryNext').disabled=!discoveryMore;
    } catch(error){notice('upDiscoveryStatus',errorText(error),true);}finally{button('upDiscoverySearchBtn').disabled=false;}
  }
  async function openAdd(trigger:HTMLElement){
    element('upStepOne').classList.add('active');element('upStepTwo').classList.remove('active');
    const initialMode=root.querySelector<HTMLInputElement>('input[name=upMode][value=all]');if(initialMode)initialMode.checked=true;
    picked.clear();tab='followings';discoveryPage=1;syncPicked();element('upDiscoverStep').hidden=false;element('upRulesStep').hidden=true;
    button('upToRulesBtn').hidden=false;button('upBackBtn').hidden=true;button('upCreateBtn').hidden=true;notice('upRulesStatus');
    deps.openModal('upAddModal',trigger);await loadList();if(!visible('upAddModal'))return;accounts(select('upDiscoveryAccount'));input('upDiscoveryQuery').value='';syncTab();await discover();
  }
  function syncTab(){root.querySelectorAll<HTMLElement>('[data-up-tab]').forEach(item=>item.setAttribute('aria-selected',String(item.dataset.upTab===tab)));input('upDiscoveryQuery').placeholder=tab==='followings'?'搜索我的关注':tab==='search'?'UP 名称或关键词（无需关注）':'例如 946974 或 https://space.bilibili.com/946974';}
  function chosenMode(){const choice=root.querySelector<HTMLInputElement>('input[name=upMode]:checked');return mode(choice?.value??'all');}
  async function anchors(append=false){
    if(picked.size!==1){notice('upRulesStatus','从视频开始时，请只选择一位 UP。',true);return;}
    const identity=picked.values().next().value;if(!identity)return;
    const response=await request('add-anchor',`/api/up-discovery/posts?${new URLSearchParams({userId:select('upDiscoveryAccount').value,uid:String(identity.uid),page:String(anchorPage)})}`);if(response.kind==='cancelled')return;
    const data=parseUpPosts(response.data);if(!append)select('upAnchorVideo').replaceChildren();
    for(const item of data.items){const option=node('option',`${day(item.publishedAt)} · ${item.title}`);option.value=item.bvid;select('upAnchorVideo').append(option);}
    button('upAnchorMore').hidden=!data.hasMore;
  }
  function rulesVisible(){const value=chosenMode();element('upSinceField').hidden=value!=='from_date';element('upAnchorField').hidden=value!=='from_video';if(value==='from_video'){anchorPage=1;void anchors().catch(error=>notice('upRulesStatus',errorText(error),true));}}
  function timestamp(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('请选择起始日期');const time=new Date(`${value}T00:00:00`).getTime();if(!Number.isFinite(time))throw new Error('起始日期无效');return time;}
  async function mutate(buttonId:string|HTMLButtonElement,work:()=>Promise<void>,status='upWorkspaceStatus'){
    const control=typeof buttonId==='string'?button(buttonId):buttonId;
    if(mutation)return;mutation=true;control.disabled=true;
    try{await work();}catch(error){notice(status,errorText(error),true);deps.notify(errorText(error),'error');}
    finally{mutation=false;control.disabled=status==='upWorkspaceStatus'&&current?.removed===true;syncSelection();}
  }
  async function create(){await mutate('upCreateBtn',async()=>{
    const value=chosenMode();if(value==='from_video'&&picked.size!==1)throw new Error('从视频开始时，请只选择一位 UP');
    const completed:UpSubscription[]=[];const userId=select('upDiscoveryAccount').value;
    const range=value==='from_date'?{since:timestamp(input('upSinceDate').value)}:value==='from_video'?{anchorBvid:select('upAnchorVideo').value}:{};
    for(const identity of [...picked.values()]){
      const response=await request('add-create','/api/up-subscriptions',json({userId,uid:identity.uid,mode:value,
        ...range}));
      if(response.kind==='cancelled')return;completed.push(parseUpSubscription(response.data));picked.delete(identity.uid);
    }
    await loadList();deps.closeModal('upAddModal');deps.notify(`已建立 ${completed.length} 个订阅`,'success');
    if(completed.length===1)await openWorkspace(completed[0].id,button('upAddBtn'));
  },'upRulesStatus');}
  function workspaceHeading(syncForm=true){if(!current)return;avatar(element('upWorkspaceAvatar'),current.name,current.avatar);element('upWorkspaceTitle').textContent=current.name;
    element('upWorkspaceMeta').textContent=`UID ${current.uid} · ${modeText[current.mode]} · 已归档 ${current.archivedCount} · ${current.enabled?'订阅中':'已暂停'}`;
    button('upPauseBtn').textContent=current.enabled?'暂停订阅':'恢复订阅';
    for(const id of ['upPauseBtn','upScanBtn','upUpdateBtn','upRemoveBtn'])button(id).disabled=current.removed;
    if(syncForm){accounts(select('upUpdateAccount'),current.userId);select('upUpdateMode').value=current.mode;input('upUpdateDate').value=current.since===null?'':day(current.since);select('upUpdateAnchor').value=current.anchorBvid??'';updateRuleFields();}
    if(current.lastError)notice('upWorkspaceStatus',current.lastError,true);
  }
  function updateRuleFields(){const value=select('upUpdateMode').value;element('upUpdateDateField').hidden=value!=='from_date';element('upUpdateAnchorField').hidden=value!=='from_video';
    const anchor=select('upUpdateAnchor'),chosen=anchor.value||current?.anchorBvid||undefined;
    const values=[...pageItems.values()].map(item=>({value:item.bvid,label:`${day(item.publishedAt)} · ${item.title}`}));
    if(chosen&&!values.some(item=>item.value===chosen))values.unshift({value:chosen,label:[...anchor.options].find(item=>item.value===chosen)?.textContent||`当前起点 · ${chosen}`});
    options(anchor,values,chosen);}
  function syncSelection(){element('upCatalogPicked').textContent=`已选 ${selected.size} 个`;button('upIncludeBtn').disabled=selected.size===0||mutation;button('upClearChoiceBtn').disabled=selected.size===0||mutation;
    const boxes=[...element('upCatalogList').querySelectorAll<HTMLInputElement>('input[data-up-video]')];const checked=boxes.filter(item=>selected.has(item.dataset.upVideo??''));input('upSelectPage').checked=boxes.length>0&&checked.length===boxes.length;input('upSelectPage').indeterminate=checked.length>0&&checked.length<boxes.length;
    boxes.forEach(item=>{item.checked=selected.has(item.dataset.upVideo??'');item.closest('.up-video')?.classList.toggle('up-video-selected',item.checked);});}
  function catalogCards(items:UpCatalogItem[],append:boolean){const host=element('upCatalogList');if(!append)host.replaceChildren();
    for(const item of items){const card=node('article',undefined,'up-video');card.dataset.upCard=item.bvid;const cover=node('div',undefined,'up-video-cover');cover.textContent='B';
      if(item.cover){const image=node('img');image.src=item.cover;image.alt='';image.loading='lazy';image.referrerPolicy='no-referrer';image.addEventListener('error',()=>image.remove(),{once:true});cover.append(image);}
      const label=node('label'),check=node('input');check.type='checkbox';check.dataset.upVideo=item.bvid;check.setAttribute('aria-label',`选择 ${item.title}`);label.append(check);cover.append(label);
      const excluded=item.globalExcluded||item.decision==='exclude';const badge=node('span',excluded?(item.globalExcluded?'所有来源已排除':'当前订阅已排除'):item.playable?'可播放':item.selected?'将要归档':'未选择','up-badge'+(excluded?' excluded':''));cover.append(badge);
      const copy=node('div',undefined,'up-video-copy');copy.append(node('h4',item.title),node('p',`${day(item.publishedAt)} · ${item.joint?'联合投稿 · ':''}${item.ownerName}\n${item.bvid}`));
      const actions=node('div',undefined,'up-video-actions');if(item.playable||item.otherArchiveAvailable){const play=node('button',item.playable?'播放':'已有归档','ghost');play.type='button';play.dataset.upPlay=item.bvid;actions.append(play);}
      const manage=node('button',excluded?'解除排除':'管理视频','ghost');manage.type='button';manage.dataset[excluded?'upUnblock':'upAction']=item.bvid;actions.append(manage);copy.append(actions);card.append(cover,copy);host.append(card);
    }
    if(!host.children.length)host.append(node('div',filter==='excluded'?'这个订阅还没有排除的视频。':'暂无投稿。点击“刷新投稿”安排扫描；浏览列表不会向 B站发请求。','up-empty'));
    syncSelection();updateRuleFields();
  }
  async function catalog(append=false){if(!current)return;const sourceId=current.id;notice('upWorkspaceStatus','正在读取投稿目录…');button('upCatalogMore').disabled=true;
    try{const params=new URLSearchParams({filter,q:input('upCatalogQuery').value.trim()});if(append&&catalogCursor)params.set('cursor',catalogCursor);
      const response=await request('workspace-catalog',`/api/up-subscriptions/${encodeURIComponent(sourceId)}/items?${params}`);if(response.kind==='cancelled'||current?.id!==sourceId)return;
      const data=parseUpCatalog(response.data);if(!append)pageItems.clear();for(const item of data.items)pageItems.set(item.bvid,item);catalogCursor=data.nextCursor;
      catalogCards(data.items,append);element('upCatalogTotal').textContent=`已显示 ${pageItems.size} / ${data.total} 个投稿`;button('upCatalogMore').hidden=!catalogCursor;
      notice('upWorkspaceStatus',current.lastError??(current.historyComplete?'':`历史投稿继续分批扫描，目前已发现 ${current.discoveredCount} 个。`),Boolean(current.lastError));
    }catch(error){notice('upWorkspaceStatus',errorText(error),true);}finally{button('upCatalogMore').disabled=false;}}
  function schedulePoll(){if(poll)clearTimeout(poll);if(!visible('upWorkspaceModal'))return;poll=setTimeout(()=>{poll=null;void refreshWorkspace().finally(schedulePoll);},operationId?2500:10_000);}
  async function refreshWorkspace(){try{if(!await loadList()||!visible('upWorkspaceModal'))return;workspaceHeading(false);
    if(operationId){const response=await request('workspace-operation',`/api/up-subscriptions/operations/${encodeURIComponent(operationId)}`);if(response.kind==='ok'&&isRecord(response.data)){
      const status=response.data.status;if(status==='completed'){operationId=null;notice('upWorkspaceStatus','归档清理完成；排除规则继续生效。');await catalog();}
      else if(status==='failed'){notice('upWorkspaceStatus',`归档清理未完成：${typeof response.data.lastError==='string'?response.data.lastError:'请重试'}。排除规则仍然有效。`,true);
        const retry=node('button','重试清理','ghost');retry.type='button';retry.dataset.upRetry=operationId;element('upWorkspaceStatus').append(retry);}
      else notice('upWorkspaceStatus','归档清理正在执行，排除规则已经保存。');}}
  }catch(error){if(visible('upWorkspaceModal'))notice('upWorkspaceStatus',errorText(error),true);}}
  async function openWorkspace(id:string,trigger:HTMLElement){cancel('workspace');selected.clear();pageItems.clear();filter='all';operationId=null;input('upCatalogQuery').value='';
    current=list.items.find(item=>item.id===id)??null;if(!current){const response=await request('workspace-source',`/api/up-subscriptions/${encodeURIComponent(id)}`);if(response.kind==='ok')current=parseUpSubscription(response.data);}if(!current)return;
    root.querySelectorAll<HTMLElement>('[data-up-filter]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.upFilter===filter)));
    deps.openModal('upWorkspaceModal',trigger);scheduleHomePoll();workspaceHeading();await catalog();schedulePoll();}
  async function saveRule(){if(!current)return;await mutate('upUpdateBtn',async()=>{const value=mode(select('upUpdateMode').value);
    const response=await request('workspace-update',`/api/up-subscriptions/${encodeURIComponent(current!.id)}`,json({revision:current!.revision,userId:select('upUpdateAccount').value,mode:value,
      ...(value==='from_date'?{since:timestamp(input('upUpdateDate').value)}:{}),...(value==='from_video'?{anchorBvid:select('upUpdateAnchor').value}:{})},'PATCH'));
    if(response.kind==='ok'){current=parseUpSubscription(response.data);workspaceHeading();await loadList();await catalog();deps.notify('订阅规则已保存','success');}});}
  async function selections(value:UpVideoDecision,id:string){if(!current||!selected.size)return;await mutate(id,async()=>{
    const response=await request('workspace-selection',`/api/up-subscriptions/${encodeURIComponent(current!.id)}/selection`,json({revision:current!.revision,items:[...selected].map(bvid=>({bvid,decision:value}))}));
    if(response.kind==='ok'){current=parseUpSubscription(response.data);selected.clear();await loadList();workspaceHeading();await catalog();deps.notify(value==='include'?'已安排选中视频归档':'已取消单独选择，现有文件保留','success');}});}
  function openAction(item:UpCatalogItem,trigger:HTMLElement){actionItem=item;element('upActionTitle').textContent=item.title;const scope=root.querySelector<HTMLInputElement>('input[name=upScope][value=source]');if(scope)scope.checked=true;const effect=root.querySelector<HTMLInputElement>('input[name=upEffect][value=retain]');if(effect)effect.checked=true;notice('upActionStatus');deps.openModal('upActionModal',trigger);}
  async function action(){if(!current||!actionItem)return;await mutate('upActionPreviewBtn',async()=>{
    const id=current!.id,bv=actionItem!.bvid;const scope=root.querySelector<HTMLInputElement>('input[name=upScope]:checked')?.value,effect=root.querySelector<HTMLInputElement>('input[name=upEffect]:checked')?.value;
    const response=await request('action-preview',`/api/up-subscriptions/${encodeURIComponent(id)}/items/${bv}/action-preview`,json({revision:current!.revision,scope,effect}));if(response.kind==='cancelled')return;
    const preview=parseUpActionPreview(response.data);const approved=await deps.confirm({title:effect==='delete'?'删除归档，并不再归档':'不再自动归档',message:actionItem!.title,
      detail:`${scope==='global'?'所有来源':'仅当前 UP 订阅'} · 涉及 ${preview.sources.length} 个归档来源。${effect==='delete'?`远端文件 ${preview.fileCount} 个；其他来源仍使用的 ${preview.sharedCount} 个文件将保留。`:'已有文件保留，可继续播放。'}`,
      requiredText:effect==='delete'?preview.confirmation:undefined,confirmText:effect==='delete'?'确认删除':'确认排除',danger:effect==='delete',trigger:button('upActionPreviewBtn')});
    if(!approved)return;
    const completed=await request('action-commit',`/api/up-subscriptions/${encodeURIComponent(id)}/items/${bv}/actions`,json({previewId:preview.previewId,confirmation:preview.confirmation}));
    if(completed.kind==='ok'&&isRecord(completed.data)){
      if(isRecord(completed.data.operation)&&typeof completed.data.operation.id==='string')operationId=completed.data.operation.id;
      current=parseUpSubscription(completed.data.subscription);deps.closeModal('upActionModal');await loadList();workspaceHeading();await catalog();schedulePoll();deps.notify('排除规则已保存','success');
    }
  },'upActionStatus');}
  async function unblock(item:UpCatalogItem,trigger:HTMLElement){if(!current)return;const scope=item.globalExcluded?'global':'source';
    if(!await deps.confirm({title:'解除排除',message:scope==='global'?'解除这个 BV 的全局排除？各来源自己的排除仍然保留。':'解除当前订阅的排除，重新按照归档规则处理？',danger:false,trigger}))return;
    await mutate('upIncludeBtn',async()=>{const response=await request('workspace-unblock',`/api/up-subscriptions/${encodeURIComponent(current!.id)}/items/${item.bvid}/unblock`,json({revision:current!.revision,scope}));if(response.kind==='ok'){current=parseUpSubscription(response.data);await loadList();workspaceHeading();await catalog();}});}
  function openRemoval(source:UpSubscription,trigger:HTMLElement){
    cancel('removal');removalSource=source;element('upRemovalName').textContent=`${source.name} · UID ${source.uid}`;
    const retain=root.querySelector<HTMLInputElement>('input[name=upRemovalEffect][value=retain]');if(retain)retain.checked=true;
    button('upRemovalReviewBtn').textContent='确认移除';notice('upRemovalStatus');deps.openModal('upRemovalModal',trigger);
  }
  const bytes=(value:number)=>value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:value>=1024**2?`${(value/1024**2).toFixed(1)} MB`:value>=1024?`${(value/1024).toFixed(1)} KB`:`${value} B`;
  async function confirmRemovalPreview(preview:UpRemovalPreview,name:string,trigger:HTMLElement){
    const epoch=generation;
    if(!await deps.confirm({title:'移除订阅，并删除本订阅的归档',message:name,
      detail:`涉及 ${preview.videoCount} 个视频、${preview.fileCount} 个远端文件，预计释放 ${bytes(preview.reclaimableBytes)}。其中 ${preview.sharedCount} 个文件被其他来源使用，会保留。${preview.activeTasks?`将先处理 ${preview.activeTasks} 个未完成任务，再执行清理。`:''}发现投稿数量不等于已归档数量。`,
      requiredText:preview.confirmation,confirmText:'确认删除',danger:true,trigger}))return false;
    if(!events||epoch!==generation||(trigger.id==='upRemovalReviewBtn'&&removalSource?.id!==preview.sourceId))return false;
    const response=await request('removal-commit',`/api/up-subscriptions/${encodeURIComponent(preview.sourceId)}`,json({revision:preview.revision,effect:'delete',previewId:preview.previewId,confirmation:preview.confirmation},'DELETE'));
    if(response.kind==='cancelled')return false;
    parseUpRemovalResult(response.data);return true;
  }
  async function removeSubscription(){if(!removalSource)return;
    const source=removalSource;
    await mutate('upRemovalReviewBtn',async()=>{
      const effect=root.querySelector<HTMLInputElement>('input[name=upRemovalEffect]:checked')?.value;
      if(effect==='delete'){
        notice('upRemovalStatus','正在核对归档、共享引用和预计释放空间…');
        const response=await request('removal-preview',`/api/up-subscriptions/${encodeURIComponent(source.id)}/removal-preview`,json({revision:source.revision}));
        if(response.kind==='cancelled'||removalSource?.id!==source.id)return;
        const preview=parseUpRemovalPreview(response.data);if(!await confirmRemovalPreview(preview,source.name,button('upRemovalReviewBtn')))return;
      }else{
        const response=await request('removal-commit',`/api/up-subscriptions/${encodeURIComponent(source.id)}`,json({revision:source.revision,effect:'retain'},'DELETE'));if(response.kind==='cancelled')return;parseUpRemovalResult(response.data);
      }
      deps.closeModal('upRemovalModal');if(current?.id===source.id)deps.closeModal('upWorkspaceModal');await loadList();
      deps.notify(effect==='delete'?'订阅已移除，归档清理进度显示在首页':'订阅已移除，已有归档保留','success');
    },'upRemovalStatus');
  }
  async function retryRemoval(id:string,trigger:HTMLButtonElement,review:boolean){await mutate(trigger,async()=>{
    const response=await request('removal-operation',`/api/up-subscriptions/operations/${encodeURIComponent(id)}/${review?'removal-repreview':'removal-retry'}`,json({}));if(response.kind==='cancelled')return;
    if(review){const preview=parseUpRemovalPreview(response.data);const name=list.operations.find(item=>item.id===id)?.sourceName??'UP 订阅';if(!await confirmRemovalPreview(preview,name,trigger))return;}
    await loadList();
  },'upHomeStatus');}
  function deactivate(id:string){
    if(id==='upAddModal'){cancel('add');picked.clear();}
    if(id==='upActionModal'){cancel('action');actionItem=null;}
    if(id==='upWorkspaceModal'){cancel('workspace');if(poll)clearTimeout(poll);poll=null;current=null;selected.clear();pageItems.clear();scheduleHomePoll();}
    if(id==='upRemovalModal'){cancel('removal');removalSource=null;notice('upRemovalStatus');}
  }
  function init(){if(events)return;events=new AbortController();const signal=events.signal;
    const on=(id:string,event:string,callback:(event:Event)=>void)=>element(id).addEventListener(event,callback,{signal});
    on('upHelpBtn','click',()=>deps.openModal('upHelpModal',button('upHelpBtn')));
    on('upAddBtn','click',()=>void openAdd(button('upAddBtn')).catch(error=>notice('upHomeStatus',errorText(error),true)));
    on('upRefreshBtn','click',()=>void loadList().catch(error=>notice('upHomeStatus',errorText(error),true)));
    on('upSearchForm','submit',event=>{event.preventDefault();void discover();});on('upDiscoveryAccount','change',()=>{picked.clear();syncPicked();void discover();});
    on('upDiscoveryPrev','click',()=>void discover(Math.max(1,discoveryPage-1)));on('upDiscoveryNext','click',()=>void discover(discoveryPage+1));
    on('upToRulesBtn','click',()=>{element('upDiscoverStep').hidden=true;element('upRulesStep').hidden=false;button('upToRulesBtn').hidden=true;button('upBackBtn').hidden=false;button('upCreateBtn').hidden=false;element('upStepOne').classList.remove('active');element('upStepTwo').classList.add('active');element('upPickedSummary').textContent=[...picked.values()].map(item=>item.name).join('、');rulesVisible();});
    on('upBackBtn','click',()=>{element('upDiscoverStep').hidden=false;element('upRulesStep').hidden=true;button('upToRulesBtn').hidden=false;button('upBackBtn').hidden=true;button('upCreateBtn').hidden=true;element('upStepOne').classList.add('active');element('upStepTwo').classList.remove('active');});
    on('upRulesStep','submit',event=>{event.preventDefault();void create();});on('upRulesStep','change',event=>{if(event.target instanceof HTMLInputElement&&event.target.name==='upMode')rulesVisible();});
    on('upAnchorMore','click',()=>{anchorPage++;void anchors(true).catch(error=>notice('upRulesStatus',errorText(error),true));});
    on('upCatalogSearchForm','submit',event=>{event.preventDefault();void catalog();});on('upCatalogMore','click',()=>void catalog(true));
    on('upSelectPage','change',()=>{for(const bv of pageItems.keys()){if(input('upSelectPage').checked)selected.add(bv);else selected.delete(bv);}syncSelection();});
    on('upIncludeBtn','click',()=>void selections('include','upIncludeBtn'));on('upClearChoiceBtn','click',()=>void selections('inherit','upClearChoiceBtn'));on('upClearPickedBtn','click',()=>{selected.clear();syncSelection();});
    on('upUpdateForm','submit',event=>{event.preventDefault();void saveRule();});on('upUpdateMode','change',updateRuleFields);
    on('upOpenArchiveBtn','click',()=>{if(current)deps.openArchive(current.id,button('upOpenArchiveBtn'));});
    on('upScanBtn','click',()=>void mutate('upScanBtn',async()=>{if(!current)return;await request('workspace-scan',`/api/up-subscriptions/${encodeURIComponent(current.id)}/scan`,json({}));notice('upWorkspaceStatus','已安排投稿扫描。B站请求串行执行，结果会分批出现。');}));
    on('upPauseBtn','click',()=>void mutate('upPauseBtn',async()=>{if(!current)return;const response=await request('workspace-pause',`/api/up-subscriptions/${encodeURIComponent(current.id)}`,json({revision:current.revision,enabled:!current.enabled},'PATCH'));if(response.kind==='ok'){current=parseUpSubscription(response.data);await loadList();workspaceHeading();await catalog();}}));
    on('upRemoveBtn','click',()=>{if(current)openRemoval(current,button('upRemoveBtn'));});
    on('upRemovalReviewBtn','click',()=>void removeSubscription());
    on('upRemovalModal','change',()=>{button('upRemovalReviewBtn').textContent=root.querySelector<HTMLInputElement>('input[name=upRemovalEffect]:checked')?.value==='delete'?'核对并确认删除':'确认移除';notice('upRemovalStatus');});
    on('upActionPreviewBtn','click',()=>void action());
    root.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest<HTMLElement>('button'):null;if(!target)return;
      if(target.dataset.upClose)deps.closeModal(target.dataset.upClose);
      else if(target.dataset.upTab){tab=target.dataset.upTab;cancel('add');input('upDiscoveryQuery').value='';syncTab();void discover();}
      else if(target.dataset.upManage){void openWorkspace(target.dataset.upManage,target).catch(error=>deps.notify(errorText(error),'error'));}
      else if(target.dataset.upArchive)deps.openArchive(target.dataset.upArchive,target);
      else if(target.dataset.upRemove){const source=list.items.find(item=>item.id===target.dataset.upRemove);if(source)openRemoval(source,target);}
      else if(target instanceof HTMLButtonElement&&target.dataset.upRemovalRetry)void retryRemoval(target.dataset.upRemovalRetry,target,false);
      else if(target instanceof HTMLButtonElement&&target.dataset.upRemovalReview)void retryRemoval(target.dataset.upRemovalReview,target,true);
      else if(target.dataset.upFilter){filter=target.dataset.upFilter;root.querySelectorAll<HTMLElement>('[data-up-filter]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.upFilter===filter)));void catalog();}
      else if(target.dataset.upPlay)deps.play(target.dataset.upPlay,target);
      else if(target.dataset.upAction){const item=pageItems.get(target.dataset.upAction);if(item)openAction(item,target);}
      else if(target.dataset.upUnblock){const item=pageItems.get(target.dataset.upUnblock);if(item)void unblock(item,target);}
      else if(target.dataset.upRetry)void request('workspace-retry',`/api/up-subscriptions/operations/${encodeURIComponent(target.dataset.upRetry)}/retry`,json({})).then(refreshWorkspace).catch(error=>notice('upWorkspaceStatus',errorText(error),true));
    },{signal});
    root.addEventListener('change',event=>{const target=event.target;if(target instanceof HTMLInputElement&&target.dataset.upVideo){if(target.checked)selected.add(target.dataset.upVideo);else selected.delete(target.dataset.upVideo);syncSelection();}},{signal});
    void loadList().catch(error=>notice('upHomeStatus',errorText(error),true));
  }
  async function manageVideo(sourceId:string,bvid:string,trigger:HTMLElement) {
    await openWorkspace(sourceId,trigger);
    if(!current || current.id!==sourceId) return;
    input('upCatalogQuery').value=bvid;
    await catalog();
    const item=pageItems.get(bvid);
    if(item)openAction(item,trigger);
  }
  return {init,deactivate,manageVideo,destroy(){events?.abort();events=null;generation++;for(const controller of requests.values())controller.abort();requests.clear();if(poll)clearTimeout(poll);poll=null;if(homePoll)clearTimeout(homePoll);homePoll=null;picked.clear();selected.clear();pageItems.clear();current=null;removalSource=null;}};
}
