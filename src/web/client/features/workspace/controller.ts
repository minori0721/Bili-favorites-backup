import {requireElement} from '../../shared/dom.js';
import type {ModalCloseOptions} from '../../shared/modals.js';
import type {WorkspaceQueueState,WorkspaceSubscriptionState} from '../../shared/workspace-state.js';
import {queuePhaseLabel} from '../task-center/index.js';
export function createWorkspace(dependencies:{root:Document;active():HTMLElement|null;requestClose(modal:HTMLElement,options?:ModalCloseOptions):Promise<boolean>;openLibrary(trigger:HTMLElement|null):void|Promise<void>;openOnline(trigger:HTMLElement):void|Promise<void>}){
  const get=(id:string)=>requireElement(dependencies.root,'#'+id,HTMLElement);
  const document=dependencies.root;
  const window=(()=>{const view=document.defaultView;if(!view)throw new Error('Workspace requires a browser document');return view;})();
  const main=requireElement(document,'body > main',HTMLElement);
  const account=requireElement(main,'.account-section',HTMLElement);
  const subscriptions=get('upSubscriptionsSection');
  const tasks=requireElement(main,'#queueBoard',HTMLElement).closest('section')!;
  const settings=get('settingsSection');
  let events:AbortController|null=null;
  const updateGutter=()=>document.documentElement.style.setProperty('--workspace-viewport-gutter',Math.max(0,window.innerWidth-document.body.getBoundingClientRect().width)+'px');
  if(CSS.supports('scrollbar-gutter','stable'))document.documentElement.classList.add('workspace-document');
  const appHeader = requireElement(document,'body > header',HTMLElement);
  const headerHome = document.createComment('workspace app header home');
  appHeader.before(headerHome);
  appHeader.classList.add('workspace-app-header');
  document.body.classList.add('app-workspace');
  const icons:Record<string,string> = {
    overview:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    library:'<path d="M4 6h6l2 2h8v12H4z"/><path d="M4 6V4h7l2 2h7v2"/>',
    subscriptions:'<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 3h8M10 11l5 3-5 3z"/>',
    tasks:'<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',
    accounts:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  };
  const pages = [
    ['overview','概览','备份概览','查看队列状态，继续浏览和留存。'],
    ['library','归档库','归档库','浏览已经归档的视频。'],
    ['subscriptions','UP 订阅','UP 订阅','管理订阅，选择想留存的投稿。'],
    ['tasks','任务','任务中心','查看执行进度与需要处理的问题。'],
    ['accounts','账号','账号与收藏夹','管理授权和需要同步的收藏夹。'],
    ['settings','设置','全局设置','管理同步、存储和下载规则。'],
  ];
  const svg = (key:string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;
  function nav() {
    const rail = document.createElement('aside');
    rail.className = 'workspace-rail';
    rail.innerHTML = `<div class="workspace-rail-label">我的备份</div><nav aria-label="主导航">${pages.map(([key,label])=>`<button type="button" data-workspace-page="${key}">${svg(key)}<span>${label}</span><i data-workspace-dot="${key}" hidden></i></button>`).join('')}</nav>`;
    return rail;
  }
  const originalNodes = [account,subscriptions,tasks,settings];
  const canvas = document.createElement('div');
  canvas.className = 'workspace-canvas';
  const heading = document.createElement('div');
  heading.className = 'workspace-page-heading';
  heading.innerHTML = '<div><p class="workspace-eyebrow">收藏与留存</p><h2 id="workspacePageTitle" tabindex="-1">备份概览</h2><p id="workspacePageDescription">查看队列状态，继续浏览和留存。</p></div><div class="workspace-heading-actions"><button type="button" class="workspace-button workspace-primary" data-workspace-action="sync">立即同步</button><button type="button" class="workspace-button" data-workspace-page="library">打开归档库 ↗</button></div>';
  const stage = document.createElement('div');
  stage.className = 'workspace-stage';
  const overview = document.createElement('section');
  overview.className = 'workspace-overview';
  overview.setAttribute('aria-label','备份概览');
  overview.innerHTML = `<div class="workspace-metrics"><article><span>运行中</span><strong id="workspaceRunning">—</strong><small>下载、上传与核验任务</small></article><article><span>队列等待</span><strong id="workspaceWaiting">—</strong><small>等待开始或处理的任务</small></article><article><span>UP 订阅</span><strong id="workspaceSubscriptions">—</strong><small id="workspaceSubscriptionHint">正在读取订阅</small></article></div><section class="workspace-attention"><div class="workspace-attention-icon">!</div><div><h3 id="workspaceAttentionTitle">正在读取任务状态</h3><p id="workspaceAttentionDescription">队列状态会在此更新。</p></div><button type="button" class="workspace-button" data-workspace-action="issues">查看详情 ↗</button></section><div class="workspace-overview-grid"><section class="card workspace-activity"><div class="workspace-block-heading"><h3>任务动态</h3><button type="button" class="workspace-text-button" data-workspace-page="tasks">全部任务 ↗</button></div><div class="workspace-scheduler"><span class="workspace-dot"></span><strong id="workspaceSchedulerTitle">读取调度状态</strong><span id="workspaceSchedulerDetail"></span></div><div id="workspaceRecentTasks"></div></section><section class="card workspace-subscription-glance"><div class="workspace-block-heading"><h3>我的订阅</h3><button type="button" class="workspace-text-button" data-workspace-page="subscriptions">管理订阅 ↗</button></div><div id="workspaceRecentSubscriptions"></div></section></div><section class="workspace-entry-row"><div><h3>在线内容</h3><p>订阅会按规则持续检查投稿；在线内容支持选择后单独归档。</p></div><button type="button" class="workspace-button" data-workspace-action="online">浏览在线内容 ↗</button></section>`;
  const panels:Record<string,HTMLElement> = {overview,subscriptions,tasks,accounts:account,settings};
  canvas.append(heading,stage);
  main.replaceChildren(nav(),canvas);
  stage.append(overview,...originalNodes);
  originalNodes.forEach(node=>node.classList.add('workspace-page-panel'));
  requireElement(account,'h2',HTMLElement).textContent = '已登录的账号';
  requireElement(account,'p',HTMLElement).textContent = '选择收藏夹，管理账号授权与同步。';
  tasks.classList.add('workspace-task-panel');
  requireElement(tasks,'h2',HTMLElement).textContent='当前队列';
  subscriptions.classList.add('workspace-subscription-panel');
  requireElement(subscriptions,'.up-section-title h2',HTMLElement).textContent='订阅列表';
  requireElement(subscriptions,'.up-section-heading p',HTMLElement).textContent='按订阅规则归档 UP 投稿。';
  get('upAddTitle').textContent='添加 UP 订阅';
  settings.classList.add('workspace-settings-panel');
  requireElement(settings,'.section-title-row h2',HTMLElement).textContent='配置与偏好';
  get('addUserBtn').classList.add('ghost');
  get('syncNowBtn').classList.remove('ghost');
  for (const id of ['archiveLibraryBtn','onlineContentBtn']) get(id).hidden = true;
  function placeMenu(details:HTMLDetailsElement){
    const anchor=requireElement(details,'summary',HTMLElement).getBoundingClientRect();
    const menu=requireElement(details,'.workspace-more-list',HTMLElement);
    const below=window.innerHeight-anchor.bottom-12,above=anchor.top-90;
    const up=below<menu.scrollHeight&&above>below;
    details.dataset.workspacePlacement=up?'above':'below';
    menu.style.setProperty('--workspace-menu-space',`${Math.max(80,up?above:below)}px`);
  }
  function moreActions(buttons:HTMLElement[],label:string) {
    const details = document.createElement('details');
    details.className = 'workspace-more';
    const summary = document.createElement('summary');summary.textContent = label;summary.setAttribute('aria-label',label==='更多'?'更多账号操作':label);
    const menu = document.createElement('div');menu.className='workspace-more-list';
    const parent=buttons[0].parentElement!;
    details.append(summary,menu);
    buttons[0].before(details);
    menu.append(...buttons);
    parent.append(details);


    return details;
  }
  moreActions([get('reconcileRemoteBtn'),get('reconcileBtn')],'更多同步操作');
  const settingsActions = requireElement(settings,'.settings-actions',HTMLElement);
  const maintenance = [...settingsActions.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.id!=='saveConfigBtn');
  const maintenanceGroup = document.createElement('section');maintenanceGroup.className='workspace-maintenance-group';
  const maintenanceHint = document.createElement('p');maintenanceHint.className='muted';maintenanceHint.textContent='先检查，再按需要调整已有归档。';
  const maintenanceActions = document.createElement('div');maintenanceActions.className='workspace-maintenance-actions';
  const maintenanceCopy:Record<string,[string,string]>={
    renameBtn:['归档命名','扫描旧命名文件，查看可以调整的归档。'],
    qualityUpgradeBtn:['归档画质','检查可升级画质，再选择需要重下的视频。'],
    pathMigrationBtn:['归档路径','核对源目录和目标目录，再迁移已有归档。'],
    migrationBtn:['迁移数据','导出或导入配置、账号信息和备份状态。'],
    cleanupDataBtn:['本地清理','查看本地数据与缓存占用，选择要清理的项目。'],
  };
  for(const button of maintenance){
    const row=document.createElement('div');row.className='workspace-maintenance-row';
    const copy=document.createElement('div');const title=document.createElement('strong');const hint=document.createElement('p');
    [title.textContent,hint.textContent]=maintenanceCopy[button.id];copy.append(title,hint);
    button.classList.add('workspace-button');
    if(button.id==='cleanupDataBtn')button.classList.add('workspace-danger');
    row.append(copy,button);maintenanceActions.append(row);
  }
  maintenanceGroup.append(maintenanceHint,maintenanceActions,get('renameStatus'),get('qualityUpgradeStatus'));
  const settingsGroups = [...settings.querySelectorAll<HTMLElement>('.settings-fold'),maintenanceGroup];
  const settingsLayout = document.createElement('div');settingsLayout.className='workspace-settings-layout';
  const settingsNav = document.createElement('nav');settingsNav.className='workspace-settings-nav';settingsNav.setAttribute('aria-label','设置分类');
  const settingsPicker = document.createElement('label');settingsPicker.className='workspace-settings-picker';
  settingsPicker.textContent='设置分类';
  const settingsSelect=document.createElement('select');settingsSelect.setAttribute('aria-label','设置分类');settingsPicker.append(settingsSelect);
  const settingsBody = document.createElement('div');settingsBody.className='workspace-settings-body';
  const settingsTitle=document.createElement('h3');settingsTitle.className='workspace-setting-title';
  settingsGroups[0].before(settingsLayout);settingsLayout.append(settingsPicker,settingsNav,settingsBody);settingsBody.append(...settingsGroups);
  settingsBody.prepend(settingsTitle);
  settingsBody.append(settingsActions,get('configStatus'));
  settingsGroups.forEach((group,index)=>{
    const summary=group.querySelector<HTMLElement>('summary');
    const button = document.createElement('button');button.type='button';button.textContent=summary?.textContent||'维护与迁移';button.dataset.workspaceSetting=String(index);settingsNav.append(button);
    const option=document.createElement('option');option.value=String(index);option.textContent=button.textContent;settingsSelect.append(option);
    if(summary)summary.hidden=true;
  });
  function chooseSetting(index:number) {
    settingsGroups.forEach((group,current)=>{group.hidden=current!==index;if(group instanceof HTMLDetailsElement)group.open=current===index;});
    [...settingsNav.children].forEach((button,current)=>button.setAttribute('aria-pressed',String(current===index)));
    settingsSelect.value=String(index);
    settingsTitle.textContent=settingsNav.children[index].textContent;
    settingsActions.hidden=settingsGroups[index]===maintenanceGroup;
    settings.dataset.workspaceCategory=settingsGroups[index]===maintenanceGroup?'maintenance':'preferences';
  }

  chooseSetting(0);
  const configStatus=get('configStatus');
  let invalidSetting:HTMLInputElement|HTMLSelectElement|null=null;
  function invalid(event:Event){
    if(!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLSelectElement))return;
    const field=event.target;
    const index=settingsGroups.findIndex(group=>group===field.closest('.settings-fold'));
    if(index<0)return;
    chooseSetting(index);
    const label=document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent||'设置项';
    configStatus.textContent=`请检查“${settingsNav.children[index].textContent}”中的“${label}”：${field.validationMessage}`;
    configStatus.classList.remove('status-success','status-muted');configStatus.classList.add('status-error');
    invalidSetting=field;
    field.scrollIntoView({block:'center',behavior:'instant'});
  }
  function edited(){
    if(invalidSetting?.validity.valid){configStatus.textContent='';configStatus.classList.remove('status-error');invalidSetting=null;}
  }
  let currentPage = 'overview';
  let syncingHistory = false;
  let navigating = false;
  const workspaceContexts=new Map<string,{page:string;scroll:number;returnLabel:string}>();
  let taskKey='';
  let subscriptionKey='';
  const workspaceIds = ['archiveLibraryModal','upWorkspaceModal','onlineContentModal','recoveryIssuesModal'];
  const workspacePages:Record<string,string> = {archiveLibraryModal:'library',upWorkspaceModal:'subscriptions',onlineContentModal:'library',recoveryIssuesModal:'tasks'};
  const workspaceNames:Record<string,string> = {archiveLibraryModal:'归档库',upWorkspaceModal:'投稿选择',onlineContentModal:'在线内容',recoveryIssuesModal:'待处理列表'};
  const closeSelectors:Record<string,string> = {archiveLibraryModal:'#closeArchiveLibraryBtn',upWorkspaceModal:'[data-up-close="upWorkspaceModal"]',onlineContentModal:'#closeOnlineContentBtn',recoveryIssuesModal:'#closeRecoveryIssuesBtn'};
  function styleWorkspaceReturn(button:HTMLElement,label:string,context=false){
    if(button.dataset.workspaceReturnLabel===label)return;
    button.dataset.workspaceReturnLabel=label;
    button.classList.remove('up-close');button.classList.add('workspace-button',context?'workspace-context-return':'workspace-workspace-return');
    button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7"/></svg>';
    const copy=document.createElement('span');copy.textContent=label;button.append(copy);
    button.setAttribute('aria-label',label);button.title=label;
  }
  function syncNav(key:string) {
    document.querySelectorAll<HTMLElement>('[data-workspace-page]').forEach(button=>{
      if(!button.closest('.workspace-rail'))return;
      if(button.dataset.workspacePage===key)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });
  }
  function recordPage(key:string,{replace=false}={}) {
    if(syncingHistory)return;
    const url=new URL(location.href);url.searchParams.set('page',key);url.searchParams.delete('view');
    if(url.href!==location.href)history[replace?'replaceState':'pushState']({workspacePage:key},'',url);
  }
  function showPanel(key:string,{history:record=true,focus=false}={}) {
    if(!panels[key])return;
    currentPage=key;
    Object.entries(panels).forEach(([name,panel])=>panel.hidden=name!==key);
    const meta=pages.find(page=>page[0]===key);if(!meta)return;
    get('workspacePageTitle').textContent=meta[2];
    get('workspacePageDescription').textContent=meta[3];
    requireElement(heading,'.workspace-heading-actions',HTMLElement).hidden=key!=='overview';
    syncNav(key);
    document.body.dataset.workspaceCurrent=key;
    if(record)recordPage(key);
    if(focus)get('workspacePageTitle').focus({preventScroll:true});
  }
  function activeWorkspaces(){return workspaceIds.map(id=>get(id)).filter(modal=>modal.classList.contains('active')&&!modal.classList.contains('is-closing'));}
  async function go(key:string,trigger:HTMLElement|null=null,options:{preserveScroll?:boolean}={}) {
    if(navigating||!events)return false;
    const lifetime=events;
    navigating=true;
    try {
      const navigation=dependencies;
      for(let active=navigation.active();active;active=navigation.active()){
        if(!await navigation.requestClose(active,{restoreFocus:false}))return false;
      }
      if(events!==lifetime)return false;
      if(key==='library'){
        void dependencies.openLibrary(trigger&&main.contains(trigger)?trigger:requireElement(main,'[data-workspace-page=library]',HTMLElement));
        updateWorkspace(get('archiveLibraryModal'));
      }else{showPanel(key,{focus:true});if(!options.preserveScroll)window.scrollTo({top:0,behavior:'instant'});}
      return true;
    }finally{navigating=false;}
  }
  function enhanceAccounts() {
    document.querySelectorAll<HTMLElement>('.user-actions').forEach(actions=>{
      if(actions.dataset.workspaceOrganized)return;
      actions.dataset.workspaceOrganized='true';
      const secondary=[...actions.querySelectorAll<HTMLButtonElement>('button')].filter(button=>['unavailable','refresh_info','copy_cookie','remove'].includes(button.dataset.action||''));
      if(secondary.length){
        const active=document.activeElement;
        const menu=moreActions(secondary,'更多');
        if(active instanceof HTMLButtonElement&&secondary.includes(active)){
          menu.open=true;placeMenu(menu);active.focus({preventScroll:true});
        }
      }
    });
  }
  const text = (selector:string,fallback='')=>document.querySelector(selector)?.textContent.trim()||fallback;
  let queueState:WorkspaceQueueState={status:'loading'};
  let subscriptionState:WorkspaceSubscriptionState={status:'loading'};
  let subscriptionCounts:{total:number;enabled:number}|null=null;
  function updateOverview() {
    const sync=requireElement(document,'#syncNowBtn',HTMLButtonElement),syncWorkspace=requireElement(heading,'[data-workspace-action=sync]',HTMLButtonElement);
    if(sync.disabled&&!syncWorkspace.disabled)syncWorkspace.style.minWidth=syncWorkspace.getBoundingClientRect().width+'px';
    if(!sync.disabled)syncWorkspace.style.removeProperty('min-width');
    syncWorkspace.disabled=sync.disabled;syncWorkspace.textContent=sync.textContent;
    if(sync.hasAttribute('aria-busy'))syncWorkspace.setAttribute('aria-busy',sync.getAttribute('aria-busy')!);else syncWorkspace.removeAttribute('aria-busy');
    const snapshot=queueState?.status==='ready'?queueState.snapshot:null;
    const loading=queueState.status==='loading';
    const queueError=queueState?.status==='error'?'队列状态暂时无法读取，请稍后重试。':'';
    get('workspaceRunning').textContent=snapshot?.summary?String(snapshot.summary.running):'—';
    get('workspaceWaiting').textContent=snapshot?.summary?String(snapshot.summary.waiting):'—';
    const sources=[...document.querySelectorAll<HTMLElement>('#upHomeList .up-subscription-card')];
    const subscriptionError=subscriptionState.status==='error';
    const subscriptionsReady=subscriptionCounts!==null;
    const subscriptionPhase=subscriptionState.status;
    get('workspaceSubscriptions').textContent=subscriptionCounts?String(subscriptionCounts.total):'—';
    const enabled=subscriptionCounts?.enabled??0;
    get('workspaceSubscriptionHint').textContent=subscriptionError?(subscriptionsReady?'更新失败，显示上次读取结果':'订阅读取失败'):!subscriptionsReady?'正在读取订阅':`${enabled} 个持续订阅，${(subscriptionCounts?.total??sources.length)-enabled} 个已暂停`;
    const issues=/[1-9]/.test(text('#recoveryIssuesBtn'));
    get('workspaceAttentionTitle').textContent=queueError?'队列状态读取失败':loading?'正在读取任务状态':issues?`${text('#recoveryIssuesBtn')}，需要你看一下`:'暂时没有需要人工处理的问题';
    get('workspaceAttentionDescription').textContent=queueError|| (loading?'读取完成后会显示当前状态。':issues?'已有归档继续保留。先查看原因，再决定如何处理。':'可以继续浏览归档库，任务会按当前规则运行。');
    const attention=requireElement(overview,'.workspace-attention',HTMLElement);
    const attentionState=queueError?'error':loading?'loading':issues?'attention':'clear';
    attention.dataset.state=attentionState;attention.classList.toggle('is-clear',attentionState==='clear');
    const attentionIcon=requireElement(attention,'.workspace-attention-icon',HTMLElement);attentionIcon.textContent=attentionState==='loading'?'':attentionState==='clear'?'✓':'!';attentionIcon.setAttribute('aria-hidden','true');
    const attentionAction=requireElement(attention,'button',HTMLButtonElement);
    delete attentionAction.dataset.workspacePage;delete attentionAction.dataset.workspaceAction;
    attentionAction.hidden=attentionState==='clear'||attentionState==='loading';
    if(attentionState==='attention'){attentionAction.dataset.workspaceAction='issues';attentionAction.textContent='查看详情 ↗';}
    else if(attentionState==='error'){attentionAction.dataset.workspacePage='tasks';attentionAction.textContent='查看任务 ↗';}
    document.querySelectorAll<HTMLElement>('[data-workspace-dot="tasks"]').forEach(dot=>dot.hidden=!issues);
    const scheduler=snapshot?.statusView.scheduler;
    const recovery=snapshot?.statusView.scheduler.recovery;
    const hasBackground=recovery&&(recovery.pendingUploads+recovery.pendingDownloads+recovery.pendingVerifications+recovery.pendingQualityMaintenance)>0;
    get('workspaceSchedulerTitle').textContent=queueError?'队列状态暂不可用':!scheduler?'正在读取调度状态':scheduler.status==='idle'&&hasBackground?'同步空闲，后台队列待处理':scheduler.title||'同步调度空闲';
    get('workspaceSchedulerDetail').textContent=queueError||(scheduler?.detail||(!scheduler?'':'当前没有正在运行的同步、扫描或对账任务。'));
    const queueCards=snapshot?[...snapshot.downloadPending,...snapshot.downloadRunning,...snapshot.uploadPending,...snapshot.uploadRunning].slice(0,3):[];
    const nextTaskKey=JSON.stringify([loading,queueError,queueCards,queueCards.map(queuePhaseLabel)]);
    if(nextTaskKey!==taskKey){taskKey=nextTaskKey;
    const activity=get('workspaceRecentTasks');activity.replaceChildren();
    if(!queueCards.length){const empty=document.createElement('p');empty.className='workspace-empty';empty.textContent=queueError?'暂时无法读取任务':loading?'正在读取任务…':'队列暂时没有任务';activity.append(empty);}
    for(const card of queueCards){
      const row=document.createElement('button');row.type='button';row.className='workspace-task-row';row.dataset.workspacePage='tasks';
      const title=document.createElement('strong');title.textContent=card.title||card.bvid||'待处理任务';
      const detail=document.createElement('span');detail.textContent=card.detail||'查看队列详情';
      const phase=document.createElement('small');phase.textContent=card.recoveryKind==='encoding_retry_failed'&&card.phase==='manual_action'?'画质或编码待确认':queuePhaseLabel(card);row.append(title,detail,phase);activity.append(row);
    }
    }
    const nextSubscriptionKey=JSON.stringify([sources.length?'items':subscriptionPhase,sources.map(source=>[source.querySelector<HTMLElement>('h3')?.textContent,source.querySelector<HTMLElement>('.up-profile-heading p')?.textContent,source.querySelector<HTMLElement>('.up-badge')?.textContent])]);
    if(nextSubscriptionKey!==subscriptionKey){subscriptionKey=nextSubscriptionKey;
    const glance=get('workspaceRecentSubscriptions');glance.replaceChildren();
    if(!sources.length){const empty=document.createElement('p');empty.className='workspace-empty';empty.textContent=subscriptionPhase==='loading'?'正在读取订阅…':subscriptionPhase==='error'?'暂时无法读取订阅，可到 UP 订阅页面重试。':'还没有订阅，可以先添加一位 UP。';glance.append(empty);}
    for(const source of sources.slice(0,3)){
      const row=document.createElement('button');row.type='button';row.className='workspace-source-row';
      const avatar=source.querySelector<HTMLElement>('.up-avatar');if(avatar)row.append(avatar.cloneNode(true));
      const copy=document.createElement('span');const name=document.createElement('strong');name.textContent=source.querySelector<HTMLElement>('h3')?.textContent||'UP 订阅';
      const hint=document.createElement('small');hint.textContent=source.querySelector<HTMLElement>('.up-profile-heading p')?.textContent||'';copy.append(name,hint);
      const status=document.createElement('small');status.className='workspace-source-status';status.textContent=source.querySelector<HTMLElement>('.up-badge')?.textContent||'';
      const sourceId=source.querySelector<HTMLElement>('[data-up-manage]')?.dataset.upManage;
      row.append(copy,status);if(sourceId)row.dataset.workspaceSource=sourceId;glance.append(row);
    }
    }
  }
  function updateWorkspace(modal:HTMLElement) {
    const open=modal.classList.contains('active')&&!modal.classList.contains('is-closing');
    if(open){
      const entering=!workspaceContexts.has(modal.id);
      if(!workspaceContexts.has(modal.id)){
        const parent=[...workspaceContexts.keys()].reverse().find(id=>get(id).classList.contains('active'));
        const returnLabel='返回'+(parent?workspaceNames[parent]:currentPage==='subscriptions'?'订阅列表':pages.find(([key])=>key===currentPage)![1]);
        workspaceContexts.set(modal.id,{page:currentPage,scroll:window.scrollY,returnLabel});
        recordPage(workspacePages[modal.id]);
      }
      if(!modal.classList.contains('workspace-full-workspace'))modal.classList.add('workspace-full-workspace');
      if(!modal.querySelector<HTMLElement>(':scope > .workspace-rail'))modal.prepend(nav());
      if(modal.id==='archiveLibraryModal'){
        if(!modal.classList.contains('workspace-library-frame'))modal.classList.add('workspace-library-frame');
        if(entering){
          const contentTitle=get('archiveLibraryTitle');
          const title=contentTitle.closest('[inert]')?get('archiveLibraryDialogTitle'):contentTitle;
          title.tabIndex=-1;title.focus({preventScroll:true});
        }
      }else{
        if(!modal.classList.contains('workspace-common-frame'))modal.classList.add('workspace-common-frame');
        if(modal.id==='onlineContentModal'&&!modal.classList.contains('workspace-online-frame'))modal.classList.add('workspace-online-frame');
      }
      if(modal.getAttribute('aria-modal')==='true'){
        if(appHeader.parentElement!==modal)modal.prepend(appHeader);
        appHeader.inert=false;appHeader.removeAttribute('aria-hidden');
        syncNav(workspacePages[modal.id]);
      }
      const close=modal.querySelector<HTMLElement>(closeSelectors[modal.id]);
      const {returnLabel}=workspaceContexts.get(modal.id)!;
      if(close)styleWorkspaceReturn(close,returnLabel);
      if(modal.id==='archiveLibraryModal')styleWorkspaceReturn(get('archiveLibraryMobileBackBtn'),'返回目录',true);
      if(modal.id==='onlineContentModal'){
        styleWorkspaceReturn(get('onlineContentCloseMainBtn'),returnLabel);
        styleWorkspaceReturn(get('onlineContentMobileBackBtn'),'返回目录',true);
      }
      if(modal.id==='recoveryIssuesModal')styleWorkspaceReturn(get('recoveryIssuesBackBtn'),'返回列表',true);
    }else if(!modal.classList.contains('active')&&workspaceContexts.has(modal.id)){
      if(appHeader.parentElement===modal){
        const parent=activeWorkspaces().find(node=>node.getAttribute('aria-modal')==='true');
        if(parent){parent.prepend(appHeader);appHeader.inert=false;appHeader.removeAttribute('aria-hidden');}
        else headerHome.after(appHeader);
      }
      const context=workspaceContexts.get(modal.id)!;workspaceContexts.delete(modal.id);
      if(!navigating){
        const parent=activeWorkspaces().find(node=>node.getAttribute('aria-modal')==='true');
        if(parent){syncNav(workspacePages[parent.id]);recordPage(workspacePages[parent.id],{replace:true});}
        else{showPanel(context.page,{history:false});recordPage(context.page,{replace:true});window.scrollTo({top:context.scroll,behavior:'instant'});}
      }
    }
    if(modal.id==='upWorkspaceModal'){
      const picked=text('#upCatalogPicked');
      const selected=/[1-9]\d*/.test(picked);
      if(modal.classList.contains('workspace-has-selection')!==selected)modal.classList.toggle('workspace-has-selection',selected);
      const bar=document.querySelector<HTMLElement>('.up-selection-bar');
      if(bar){
        bar.dataset.workspaceSelection=String(selected);
        let actions=bar.querySelector<HTMLElement>('.workspace-selection-actions');
        if(!actions){
          actions=document.createElement('div');actions.className='workspace-selection-actions';
          const row=document.createElement('div');row.className='workspace-selection-action-row';row.append(...bar.querySelectorAll<HTMLButtonElement>('button'));actions.append(row);bar.append(actions);
        }
        if(!selected&&actions.contains(document.activeElement))requireElement(bar,'input',HTMLInputElement).focus({preventScroll:true});
        actions.inert=!selected;
      }
    }
  }
  let queued=false;
  function refresh(){if(!events||queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!events)return;enhanceAccounts();updateOverview();updateWorkspace(get('upWorkspaceModal'));});}
  const contentObserver=new MutationObserver(refresh);
  const workspaceObservers=workspaceIds.map(id=>{
    const modal=get(id);const observer=new MutationObserver(()=>updateWorkspace(modal));
    return {modal,observer};
  });
  function clicked(event:MouseEvent){
    if(!(event.target instanceof Element))return;
    const source=event.target.closest<HTMLElement>('[data-workspace-source]');
    if(source){showPanel('subscriptions');document.querySelector<HTMLButtonElement>(`[data-up-manage="${CSS.escape(source.dataset.workspaceSource||'')}"]`)?.click();}
    const button=event.target.closest<HTMLElement>('[data-workspace-page], [data-workspace-action], [data-workspace-setting]');
    if(button?.dataset.workspacePage){event.preventDefault();void go(button.dataset.workspacePage,button);}
    if(button?.dataset.workspaceSetting!==undefined)chooseSetting(Number(button.dataset.workspaceSetting));
    if(button?.dataset.workspaceAction){
      if(button.dataset.workspaceAction==='online')void dependencies.openOnline(button);
      else {const actions:Record<string,string>={sync:'syncNowBtn',issues:'recoveryIssuesBtn'};get(actions[button.dataset.workspaceAction]).click();}
    }
    const target=event.target;
    const menuAction=target.closest<HTMLButtonElement>('.workspace-more-list button');
    if(menuAction&&menuAction.dataset.action!=='refresh_info')menuAction.closest<HTMLDetailsElement>('.workspace-more')!.open=false;
    document.querySelectorAll<HTMLDetailsElement>('.workspace-more[open]').forEach(menu=>{if(!menu.contains(target))menu.open=false;});
  }
  function popped(){
    syncingHistory=true;
    const requested=new URL(location.href).searchParams.get('page')||'overview';
    void go(pages.some(([key])=>key===requested)?requested:'overview').then(changed=>{
      if(changed||!events)return;
      const active=activeWorkspaces().find(modal=>modal.getAttribute('aria-modal')==='true');
      const url=new URL(location.href);url.searchParams.set('page',active?workspacePages[active.id]:currentPage);
      history.replaceState({},'',url);
    }).finally(()=>syncingHistory=false);
  }
  function keyed(event:KeyboardEvent){
    if(!(event.target instanceof Element))return;
    const details=event.target.closest<HTMLDetailsElement>('.workspace-more');
    const open=details?.open?details:document.querySelector<HTMLDetailsElement>('.workspace-more[open]');
    if(event.key==='Escape'&&open){open.open=false;requireElement(open,'summary',HTMLElement).focus({preventScroll:true});event.preventDefault();event.stopPropagation();return;}
    if(!details||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    if(!details.open){details.open=true;placeMenu(details);}
    const buttons=[...details.querySelectorAll<HTMLButtonElement>('.workspace-more-list button:not(:disabled)')];
    if(!buttons.length)return;
    const index=buttons.findIndex(button=>button===document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowUp'?(index<=0?buttons.length-1:index-1):(index+1)%buttons.length;
    buttons[next].focus({preventScroll:true});event.preventDefault();event.stopPropagation();
  }
  function init(){
    if(events)return;events=new AbortController();const {signal}=events;
    updateGutter();window.addEventListener('resize',updateGutter,{signal});
    settingsSelect.addEventListener('change',()=>chooseSetting(Number(settingsSelect.value)),{signal});
    settings.addEventListener('invalid',invalid,{capture:true,signal});settings.addEventListener('input',edited,{signal});
    document.addEventListener('click',clicked,{signal});window.addEventListener('popstate',popped,{signal});
    document.addEventListener('keydown',keyed,{capture:true,signal});
    document.addEventListener('toggle',event=>{if(event.target instanceof HTMLDetailsElement&&event.target.matches('.workspace-more')&&event.target.open)placeMenu(event.target);},{capture:true,signal});
    document.addEventListener('focusout',event=>{if(!(event.target instanceof Element))return;const menu=event.target.closest<HTMLDetailsElement>('.workspace-more');if(menu&&!(event.relatedTarget instanceof Node&&menu.contains(event.relatedTarget)))menu.open=false;},{signal});
    for(const id of ['userList','upHomeList','upHomeStatus','queueBoard','upCatalogPicked','syncNowBtn']){
      contentObserver.observe(get(id),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','aria-busy','disabled']});
    }
    for(const {modal,observer}of workspaceObservers)observer.observe(modal,{attributes:true,attributeFilter:['class','aria-modal']});
      const requested=new URL(location.href).searchParams;
  const views:Record<string,string>={home:'overview',settings:'settings',queue:'tasks',up:'subscriptions',library:'library',issues:'tasks'};
  const requestedPage=views[requested.get('view')||'']||requested.get('page')||'overview';
  const initial=pages.some(([key])=>key===requestedPage)?requestedPage:'overview';
  showPanel(initial==='library'?'overview':initial,{history:false});
  refresh();
  if(requested.get('view')==='library'||requested.get('page')==='library')void dependencies.openLibrary(null);
  else if(requested.get('view')==='updates')get('versionInfoBtn').click();
  else if(requested.get('view')==='help')get('upHelpBtn').click();
  else if(requested.get('view')==='issues')get('recoveryIssuesBtn').click();

  }
  function destroy(){events?.abort();events=null;contentObserver.disconnect();workspaceObservers.forEach(({observer})=>observer.disconnect());headerHome.after(appHeader);workspaceContexts.clear();queued=false;}
  return {init,destroy,
    navigate:go,
    async openStorageSettings(options:{startAtFields?:boolean}={}){
      if(!await go('settings'))return;
      chooseSetting(settingsGroups.indexOf(get('storageSettings')));
      const target=get(options.startAtFields?'alistUrl':'storageCheckBtn');target.scrollIntoView({block:'center',behavior:'instant'});target.focus({preventScroll:true});
    },
    receiveQueue(state:WorkspaceQueueState){queueState=state;refresh();},
    receiveSubscriptions(state:WorkspaceSubscriptionState){subscriptionState=state;if(state.status==='ready')subscriptionCounts={total:state.total,enabled:state.enabled};refresh();},
  };
}
