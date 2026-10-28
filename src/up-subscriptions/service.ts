import type { UpSubscriptionRepository, StoredUpSubscription } from '../repositories/up-subscriptions.js';
import type { UpSubscriptionInput, UpSubmission, UpRemovalPreview, UpRemovalOperation } from '../shared/up-subscriptions.js';
import type { UserStore } from '../users.js';
import type { ArchiveDeletionService } from '../archive-deletion.js';
import type { UpBiliPort } from './bili-adapter.js';
import { isRecord } from '../shared/api/value.js';
import { parseUpUid } from './policy.js';
import type { ArchiveVideoActions } from '../archive-video-actions.js';

function fail(message:string,statusCode=400):never {throw Object.assign(new Error(message),{statusCode});}
function text(value:unknown,name:string) {if(typeof value!=='string'||!value.trim()) fail(`${name} 无效`);return value.trim();}
function integer(value:unknown,name:string,min=1) {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min) fail(`${name} 无效`);return value;}
function revision(value:unknown) {return integer(value,'订阅版本');}
function bvid(value:unknown) {const result=text(value,'BV号');if(!/^BV[0-9A-Za-z]+$/.test(result)) fail('BV号无效');return result;}
function page(value:unknown) {if(value===undefined)return 1; const result=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;return integer(result,'页码');}
function rule(value:unknown):UpSubscriptionInput['mode'] {if(value!=='all'&&value!=='from_now'&&value!=='from_date'&&value!=='from_video'&&value!=='selected') fail('归档范围无效');return value;}
export function createUpSubscriptionService(deps:{
  repository():UpSubscriptionRepository;
  users:Pick<UserStore,'list'|'getById'>;
  bili:UpBiliPort;
  atomic<T>(work:()=>T):T;
  ingest(source:StoredUpSubscription,item:UpSubmission):unknown;
  scan():unknown;
  blocked():boolean;
  maintenance<T>(work:()=>Promise<T>):Promise<T>;
  canRebind():boolean;
  rebind(source:StoredUpSubscription,newUserId:string):void;
  videoActions: Pick<ArchiveVideoActions,'preview'|'commit'|'unblock'|'select'>;
  deletion:Pick<ArchiveDeletionService,'previewSource'|'start'|'get'|'retry'|'repreview'|'previewSubscription'|'previewHistory'|'startSubscriptionRemoval'|'startHistoryCleanup'|'hasUnfinishedSubscriptionRemoval'|'hasUnfinishedSourceDeletion'|'listSubscriptionRemovals'>;
  now():number;
}) {
  const previewItems=new Map<string,{items:UpSubmission[];expires:number}>();
  const historyPreviews=new Map<string,{sourceId:string;revision:number;cutoff:number;expires:number}>();
  function ready(){if(deps.blocked())fail('维护期间暂时不能修改订阅',409);}
  function account(value:unknown) {const id=text(value,'账号');const user=deps.users.getById(id);if(!user?.enabled)fail('请选择启用的 B站账号');return id;}
  function source(id:unknown,includeRemoved=false) {const found=deps.repository().get(text(id,'订阅'));if(!found||(!includeRemoved&&found.removed))fail('订阅不存在',404);return found;}
  function expect(current:StoredUpSubscription,value:unknown) {if(current.revision!==revision(value))fail('订阅已变化，请刷新后重试',409);}
  function prune(){for(const [key,value]of previewItems)if(value.expires<=deps.now())previewItems.delete(key);for(const [key,value]of historyPreviews)if(value.expires<=deps.now())historyPreviews.delete(key);}
  function since(mode:UpSubscriptionInput['mode'],input:Record<string,unknown>,userId:string,uid:number,current?:StoredUpSubscription) {
    if(mode==='all'||mode==='selected')return null;
    if(mode==='from_now')return current?.mode===mode?current.since:deps.now();
    if(mode==='from_date')return integer(input.since,'开始时间',0);
    const anchor=bvid(input.anchorBvid);
    const cached=previewItems.get(`${userId}:${uid}`);
    const item=deps.repository().getByUid(uid) ? deps.repository().item(deps.repository().getByUid(uid)!.id,anchor) : null;
    const found=item??(cached&&cached.expires>deps.now()?cached.items.find(item=>item.bvid===anchor):undefined);
    if(!found)fail('请先从该 UP 的投稿列表选择起始视频');
    return found.publishedAt;
  }
  function publicSource(item:StoredUpSubscription) {const {routingKey:_,...dto}=item;return {...dto,accountAvailable:Boolean(deps.users.getById(item.userId)?.enabled)};}
  function removalOperation(operation:NonNullable<ReturnType<ArchiveDeletionService['get']>>,current:StoredUpSubscription):UpRemovalOperation {
    const {status}=operation;
    if(status!=='pending'&&status!=='running'&&status!=='retry_wait'&&status!=='failed'&&status!=='completed'&&status!=='stopped')fail('订阅清理状态无效',409);
    return {id:operation.id,sourceId:current.id,sourceName:current.name,status,fileCount:operation.fileCount,
      completedCount:operation.completedCount,retainedCount:operation.retainedCount,deletedCount:operation.deletedCount,missingCount:operation.missingCount,lastError:operation.lastError??null,kind:operation.scope==='history'?'history':'removal'};
  }
  function removalPreview(current:StoredUpSubscription,exceptId=''):UpRemovalPreview {
    if(deps.deletion.hasUnfinishedSourceDeletion(current.userId,current.routingKey,exceptId))fail('请先完成或停止该订阅未结束的归档清理',409);
    const preview=deps.deletion.previewSubscription(current.userId,current.routingKey);
    return {previewId:preview.id,sourceId:current.id,revision:current.revision,videoCount:preview.sourceCount,
      fileCount:preview.fileCount,sharedCount:preview.sharedCount,totalBytes:preview.totalBytes,
      reclaimableBytes:preview.reclaimableBytes,deleteCount:preview.deleteCount,activeTasks:preview.activeTasks,confirmation:'DELETE ARCHIVE'};
  }
  function historyPreview(current:StoredUpSubscription,previous?:NonNullable<ReturnType<ArchiveDeletionService['get']>>):UpRemovalPreview {
    prune();
    if(deps.deletion.hasUnfinishedSourceDeletion(current.userId,current.routingKey,previous?.id))fail('请先完成或停止该订阅未结束的归档清理',409);
    const preview=previous?deps.deletion.repreview(previous.id):deps.deletion.previewHistory(current.userId,current.routingKey);
    const cutoff=previous?(current.since??fail('历史清理起点已变化',409)):deps.now();
    historyPreviews.set(preview.id,{sourceId:current.id,revision:current.revision,cutoff,expires:deps.now()+10*60_000});
    return {previewId:preview.id,sourceId:current.id,revision:current.revision,videoCount:preview.sourceCount,fileCount:preview.fileCount,
      sharedCount:preview.sharedCount,totalBytes:preview.totalBytes,reclaimableBytes:preview.reclaimableBytes,deleteCount:preview.deleteCount,
      activeTasks:preview.activeTasks,confirmation:'DELETE ARCHIVE',kind:'history',cutoff};
  }
  function requireRemoval(id:unknown) {
    const operation=deps.deletion.get(text(id,'清理任务'))??fail('清理任务不存在',404);
    if((operation.scope!=='source'&&operation.scope!=='history')||operation.bvid!==undefined||operation.mediaId===undefined)fail('不是整订阅清理任务',400);
    const current=deps.repository().getByRoute(operation.mediaId)??fail('订阅不存在',404);
    return {operation,current};
  }
  return {
    list(){return {accounts:deps.users.list().filter(user=>user.enabled).map(user=>({id:user.id,name:user.name})),items:deps.repository().list().map(publicSource),
      operations:deps.deletion.listSubscriptionRemovals().map(operation=>removalOperation(operation,source(operation.sourceId,true)))};},
    get(id:unknown){return publicSource(source(id,true));},
    archiveContext(id: unknown) {
      const current = source(id, true);
      return { sourceId: current.id, userId: current.userId, mediaId: current.routingKey, title: current.name };
    },
    async discover(kind:unknown,input:Record<string,unknown>) {
      ready();const userId=account(input.userId);const number=page(input.page);const query=typeof input.q==='string'?input.q.trim():'';
      if(query.length>100)fail('搜索词过长');
      if(kind==='followings')return deps.bili.followings(userId,number,query);
      if(kind==='search'){if(!query)fail('请输入 UP 名称或关键词');return deps.bili.search(userId,query,number);}
      if(kind==='resolve')return deps.bili.profile(userId,parseUpUid(input.value));
      if(kind==='posts'){
        const uid=parseUpUid(input.uid);const result=await deps.bili.submissions(userId,uid,number);
        prune();const key=`${userId}:${uid}`;const previous=previewItems.get(key);
        previewItems.set(key,{items:[...(previous?.items??[]).filter(item=>!result.items.some(next=>next.bvid===item.bvid)),...result.items].slice(-300),expires:deps.now()+10*60_000});
        return {...result,page:number};
      }
      fail('查找方式无效');
    },
    async create(value:unknown) {
      ready();if(!isRecord(value))fail('订阅参数无效');
      const userId=account(value.userId),uid=parseUpUid(value.uid),mode=rule(value.mode);
      const cutoff=since(mode,value,userId,uid);
      const profile=await deps.bili.profile(userId,uid);
      ready();account(userId);
      const previous=deps.repository().getByUid(uid);
      if(previous&&deps.deletion.hasUnfinishedSourceDeletion(previous.userId,previous.routingKey))fail('请先完成或停止这个 UP 的归档清理，再重新添加订阅',409);
      const commit=()=>deps.atomic(()=>{
        if(previous?.removed&&previous.userId!==userId)deps.rebind(previous,userId);
        return deps.repository().create(profile,{userId,uid,mode,anchorBvid:mode==='from_video'?bvid(value.anchorBvid):undefined},cutoff,deps.now());
      });
      if(previous?.removed&&previous.userId!==userId&&!deps.canRebind())fail('请等待现有任务完成，再更换授权账号',409);
      const saved=previous?.removed&&previous.userId!==userId?await deps.maintenance(async()=>commit()):commit();
      deps.scan();return publicSource(saved);
    },
    async update(id:unknown,value:unknown) {
      ready();if(!isRecord(value))fail('订阅参数无效');
      const current=source(id);expect(current,value.revision);
      if(deps.deletion.hasUnfinishedSourceDeletion(current.userId,current.routingKey))fail('请先完成或停止该订阅未结束的归档清理，再修改订阅规则',409);
      const userId=account(value.userId??current.userId);const mode=value.mode===undefined?current.mode:rule(value.mode);
      if(value.enabled!==undefined&&typeof value.enabled!=='boolean')fail('订阅启用状态无效');
      const cutoff=mode===current.mode && value.since===undefined && value.anchorBvid===undefined ? current.since : since(mode,value,userId,current.uid,current);
      const admit=()=>{
        // Already discovered candidates must be admitted immediately when a rule expands.
        let cursor:string|null=null;
        do {const updated=source(id);const items=deps.repository().catalog(updated,{cursor:cursor??undefined,filter:'selected',limit:100});
          for(const item of items.items)deps.ingest(updated,item);cursor=items.nextCursor;}while(cursor);
      };
      const save=()=>deps.atomic(()=> {
        expect(source(id),value.revision);
        if(userId!==current.userId)deps.rebind(current,userId);
        deps.repository().update(current.id,current.revision,{userId,enabled:value.enabled===undefined?current.enabled:value.enabled===true,
          mode,since:cutoff,anchorBvid:mode==='from_video'?(value.anchorBvid===undefined?current.anchorBvid:bvid(value.anchorBvid)):null},deps.now());
        if(userId===current.userId)admit();
      });
      if(userId!==current.userId){if(!deps.canRebind())fail('请等当前同步和传输任务完成，再更换授权账号',409);await deps.maintenance(async()=>save());}
      else save();
      if(userId!==current.userId)deps.atomic(admit);
      deps.scan();return publicSource(source(id));
    },
    previewRemoval(id:unknown,value:unknown){ready();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);return removalPreview(current);},
    remove(id:unknown,value:unknown){
      ready();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);
      const effect=value.effect??'retain';if(effect!=='retain'&&effect!=='delete')fail('移除方式无效');
      if(effect==='retain'){
        if(current.removed)fail('订阅已经移除',409);
        if(deps.deletion.hasUnfinishedSourceDeletion(current.userId,current.routingKey))fail('请先完成或停止该订阅未结束的归档清理',409);
        deps.repository().remove(current.id,current.revision,deps.now());return {retained:true,operation:null};
      }
      const preview=deps.deletion.get(text(value.previewId,'操作预览'));
      if(!preview||preview.scope!=='source'||preview.bvid!==undefined||preview.userId!==current.userId||preview.mediaId!==current.routingKey)fail('清理预览不属于该订阅',409);
      const operation=deps.deletion.startSubscriptionRemoval(preview.id,text(value.confirmation,'确认文字'),bvids=>{
        expect(source(id,true),value.revision);
        deps.repository().removeAndExclude(current.id,current.revision,deps.now(),bvids);
      });
      return {retained:false,operation:removalOperation(operation,source(id,true))};
    },
    repreviewRemoval(id:unknown){ready();const {operation,current}=requireRemoval(id);if(operation.status!=='failed')fail('只有失败的清理任务可以重新核对',409);return operation.scope==='history'?historyPreview(current,operation):removalPreview(current,operation.id);},
    retryRemoval(id:unknown){ready();const {operation,current}=requireRemoval(id);return removalOperation(deps.deletion.retry(operation.id),current);},
    catalog(id:unknown,input:Record<string,unknown>){const current=source(id,true);const filter=input.filter??'all';if(filter!=='all'&&filter!=='selected'&&filter!=='excluded')fail('投稿筛选无效');return deps.repository().catalog(current,{filter,query:typeof input.q==='string'?input.q.trim():'',cursor:typeof input.cursor==='string'?input.cursor:undefined});},
    select(id:unknown,value:unknown){
      ready();const current=source(id);deps.videoActions.select(current.id,value);
      deps.scan();return publicSource(source(id));
    },
    previewHistory(id:unknown,value:unknown){ready();if(!isRecord(value))fail('参数无效');const current=source(id);expect(current,value.revision);account(current.userId);return historyPreview(current);},
    historyCleanup(id:unknown,value:unknown){
      ready();if(!isRecord(value))fail('参数无效');const current=source(id);expect(current,value.revision);
      account(current.userId);
      const previewId=text(value.previewId,'操作预览'),cached=historyPreviews.get(previewId);
      if(!cached||cached.expires<=deps.now()||cached.sourceId!==current.id||cached.revision!==current.revision)fail('历史清理预览已失效，请重新核对',409);
      const operation=deps.deletion.startHistoryCleanup(previewId,text(value.confirmation,'确认文字'),bvids=>
        deps.repository().historyFromNow(current.id,current.revision,deps.now(),cached.cutoff,bvids));
      historyPreviews.delete(previewId);deps.scan();
      return {retained:false,operation:removalOperation(operation,source(id))};
    },
    scan(id:unknown){ready();const current=source(id);if(!current.enabled)fail('请先启用订阅');deps.repository().requestScan(current.id);return deps.scan();},
    previewAction(id:unknown,bv:unknown,value:unknown){
      ready();prune();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);const video=bvid(bv);
      if(!deps.repository().item(current.id,video))fail('投稿不存在',404);
      if(value.scope!=='source'&&value.scope!=='global')fail('操作范围无效');if(value.effect!=='retain'&&value.effect!=='delete')fail('操作方式无效');
      return {...deps.videoActions.preview(video,{...value,sourceId:current.id}),sourceId:current.id};
    },
    action(id:unknown,bv:unknown,value:unknown){
      ready();if(!isRecord(value))fail('操作参数无效');const current=source(id,true);const video=bvid(bv);
      return {...deps.videoActions.commit(video,{...value,sourceId:current.id}),subscription:publicSource(source(id,true))};
    },
    unblock(id:unknown,bv:unknown,value:unknown){ready();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);const video=bvid(bv);
      deps.videoActions.unblock(video,{...value,sourceId:current.id});
      deps.scan();return publicSource(source(id,true));},
    operation(id:unknown){return deps.deletion.get(text(id,'清理任务'))??fail('清理任务不存在',404);},
    retry(id:unknown){ready();return deps.deletion.retry(text(id,'清理任务'));},
    reset(){previewItems.clear();historyPreviews.clear();},
  };
}
