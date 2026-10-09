import type { UpSubscriptionRepository, StoredUpSubscription } from '../repositories/up-subscriptions.js';
import type { UpSubmission } from '../shared/up-subscriptions.js';
import type { UserStore } from '../users.js';
import type { UpBiliPort } from './bili-adapter.js';
import { safeErrorSummary } from '../diagnostics.js';

export interface UpScanContext {
  force?: boolean;
  canRun(): boolean;
  enterUser(id:string):void;
  leaveUser(id:string):void;
  progress(patch:{title:string;detail:string;userName?:string;folderTitle?:string;page?:number}):void;
  counts(fresh:number,queued:number):void;
}
export interface UpScanPort {
  run(context:UpScanContext):Promise<void>;
  start():void; stop():void; resetAfterRebind():void;
}
/** Uses the existing sync cycle and its admission; there is no independent polling timer. */
export function createUpScan(deps:{
  repository():UpSubscriptionRepository;
  users:Pick<UserStore,'captureAccount'|'isAuthorizationCurrent'>;
  bili:Pick<UpBiliPort,'submissions'>;
  atomic<T>(commit:()=>T):T;
  ingest(source:StoredUpSubscription,item:UpSubmission):{fresh:boolean;queued:boolean};
  now():number;
  interval():number;
  accountCooling(userId:string):boolean;
}):UpScanPort {
  let stopped=false;
  let generation=0;
  let running=false;
  function current(source:StoredUpSubscription,epoch:number,context:UpScanContext) {
    const latest=deps.repository().get(source.id);
    return !stopped && epoch===generation && context.canRun() && latest?.revision===source.revision && latest.enabled && !latest.removed;
  }
  async function scan(source:StoredUpSubscription,epoch:number,context:UpScanContext) {
    const account=deps.users.captureAccount(source.userId);
    if (!account?.user.enabled || deps.accountCooling(source.userId)) return;
    context.enterUser(source.userId);
    const seen=new Set<string>();
    try {
      // Always refresh the newest page, then resume historical pagination with an overlapping page.
      const pages=[1];
      if(!source.historyComplete) {
        const resume=Math.max(2,source.nextPage-1);
        for(let page=resume;page<resume+3;page++) pages.push(page);
      }
      let nextPage=source.nextPage;
      let complete=source.historyComplete;
      let watermark=source.watermark;
      let pending=source.pendingWatermark;
      for(const page of pages) {
        if(!current(source,epoch,context) || !deps.users.isAuthorizationCurrent(account.identity)) return;
        context.progress({title:'正在扫描 UP 投稿',detail:`第 ${page} 页 · 低频串行请求`,folderTitle:source.name,userName:account.user.name,page});
        let result:Awaited<ReturnType<UpBiliPort['submissions']>>;
        try {
          result=await deps.bili.submissions(source.userId,source.uid,page);
          if(page>1 && result.items.length>0 && result.items.every(item=>seen.has(item.bvid))) {
            throw new Error(`UP ${source.uid} 投稿接口重复页面，扫描未完成`);
          }
        }
        catch(error) {
          if(current(source,epoch,context) && deps.users.isAuthorizationCurrent(account.identity)) {
            deps.repository().saveScan(source.id,source.revision,{nextPage,historyComplete:complete,watermark,pendingWatermark:pending,
              nextScanAt:deps.now()+Math.max(deps.interval(),30*60_000),lastError:safeErrorSummary(error)},deps.now());
            console.warn(`[UP] ${source.uid} 第 ${page} 页失败：${safeErrorSummary(error)}`);
          }
          return;
        }
        if(!current(source,epoch,context) || !deps.users.isAuthorizationCurrent(account.identity)) return;
        result.items.forEach(item=>seen.add(item.bvid));
        deps.atomic(()=> {
          const repository=deps.repository();
          repository.recordPage(source.id,result.items);
          for(const item of result.items) {
            if(repository.isBlocked(source.userId,source.routingKey,item.bvid)) continue;
            const outcome=deps.ingest(source,item);
            context.counts(outcome.fresh?1:0,outcome.queued?1:0);
          }
          // Freeze the round's head watermark. Posts inserted while paginating
          // must remain newer than the completed watermark and be revisited.
          if(page===1 && pending<=watermark) pending=Math.max(watermark,...result.items.map(item=>item.publishedAt));
          const oldest=result.items.length?Math.min(...result.items.map(item=>item.publishedAt)):null;
          const cutoff=source.watermark>0 ? source.watermark : source.mode!=='all'&&source.mode!=='selected' ? source.since : null;
          const reachedCutoff=oldest!==null&&cutoff!==null&&oldest<cutoff;
          if(!result.hasMore || reachedCutoff) {complete=true;watermark=pending;nextPage=1;}
          else {
            complete=false;
            nextPage=Math.max(nextPage,page+1);
            if(source.historyComplete && page===1) for(let next=2;next<=4;next++)pages.push(next);
          }
          if(!repository.saveScan(source.id,source.revision,{nextPage,historyComplete:complete,watermark,pendingWatermark:pending,
            nextScanAt:deps.now()+deps.interval(),lastError:null},deps.now())) throw new Error('UP 订阅在提交时发生变化');
        });
        if(complete) break;
      }
    } finally {context.leaveUser(source.userId);}
  }
  return {
    async run(context) {
      if(stopped || running) return;
      const epoch=generation;
      running=true;
      try {
        for(const source of deps.repository().list()) {
          if(stopped || epoch!==generation || !context.canRun()) break;
          if(source.enabled && (context.force || source.nextScanAt<=deps.now())) await scan(source,epoch,context);
        }
      } finally {running=false;}
    },
    start(){stopped=false;},
    stop(){stopped=true;generation++;},
    resetAfterRebind(){if(running) throw new Error('UP 扫描未排空');generation++;},
  };
}
