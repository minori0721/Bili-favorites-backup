import crypto from 'node:crypto';
import type { UpSubscriptionRepository, StoredUpSubscription } from '../repositories/up-subscriptions.js';
import type { UpSubscriptionInput, UpSubmission, UpVideoActionPreview, UpVideoDecision, UpRemovalPreview, UpRemovalOperation } from '../shared/up-subscriptions.js';
import type { UserStore } from '../users.js';
import type { FavoriteRelation } from '../state.js';
import type { ArchiveDeletionService } from '../archive-deletion.js';
import type { UpBiliPort } from './bili-adapter.js';
import { isRecord } from '../shared/api/value.js';
import { parseUpUid } from './policy.js';

function fail(message:string,statusCode=400):never {throw Object.assign(new Error(message),{statusCode});}
function text(value:unknown,name:string) {if(typeof value!=='string'||!value.trim()) fail(`${name} 无效`);return value.trim();}
function integer(value:unknown,name:string,min=1) {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min) fail(`${name} 无效`);return value;}
function revision(value:unknown) {return integer(value,'订阅版本');}
function bvid(value:unknown) {const result=text(value,'BV号');if(!/^BV[0-9A-Za-z]+$/.test(result)) fail('BV号无效');return result;}
function page(value:unknown) {if(value===undefined)return 1; const result=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;return integer(result,'页码');}
function rule(value:unknown):UpSubscriptionInput['mode'] {if(value!=='all'&&value!=='from_now'&&value!=='from_date'&&value!=='from_video'&&value!=='selected') fail('归档范围无效');return value;}
function decision(value:unknown):UpVideoDecision {if(value!=='inherit'&&value!=='include'&&value!=='exclude')fail('选择方式无效');return value;}
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
  relations(bvid:string):FavoriteRelation[];
  deletion:Pick<ArchiveDeletionService,'previewSource'|'previewVideo'|'start'|'get'|'retry'|'previewSubscription'|'startSubscriptionRemoval'|'hasUnfinishedSubscriptionRemoval'|'listSubscriptionRemovals'>;
  now():number;
}) {
  const previewItems=new Map<string,{items:UpSubmission[];expires:number}>();
  const previews=new Map<string,{preview:UpVideoActionPreview;revision:number;expires:number;deletionId?:string}>();
  function ready(){if(deps.blocked())fail('维护期间暂时不能修改订阅',409);}
  function account(value:unknown) {const id=text(value,'账号');const user=deps.users.getById(id);if(!user?.enabled)fail('请选择启用的 B站账号');return id;}
  function source(id:unknown,includeRemoved=false) {const found=deps.repository().get(text(id,'订阅'));if(!found||(!includeRemoved&&found.removed))fail('订阅不存在',404);return found;}
  function expect(current:StoredUpSubscription,value:unknown) {if(current.revision!==revision(value))fail('订阅已变化，请刷新后重试',409);}
  function prune(){for(const [key,value]of previewItems)if(value.expires<=deps.now())previewItems.delete(key);for(const[key,value]of previews)if(value.expires<=deps.now())previews.delete(key);}
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
    if(status!=='pending'&&status!=='running'&&status!=='retry_wait'&&status!=='failed'&&status!=='completed')fail('订阅清理状态无效',409);
    return {id:operation.id,sourceId:current.id,sourceName:current.name,status,fileCount:operation.fileCount,
      completedCount:operation.completedCount,retainedCount:operation.retainedCount,lastError:operation.lastError??null};
  }
  function removalPreview(current:StoredUpSubscription):UpRemovalPreview {
    const preview=deps.deletion.previewSubscription(current.userId,current.routingKey);
    return {previewId:preview.id,sourceId:current.id,revision:current.revision,videoCount:preview.sourceCount,
      fileCount:preview.fileCount,sharedCount:preview.sharedCount,totalBytes:preview.totalBytes,
      reclaimableBytes:preview.reclaimableBytes,activeTasks:preview.activeTasks,confirmation:'DELETE ARCHIVE'};
  }
  function requireRemoval(id:unknown) {
    const operation=deps.deletion.get(text(id,'清理任务'))??fail('清理任务不存在',404);
    if(operation.scope!=='source'||operation.bvid!==undefined||operation.mediaId===undefined)fail('不是整订阅清理任务',400);
    const current=deps.repository().getByRoute(operation.mediaId)??fail('订阅不存在',404);
    return {operation,current};
  }
  return {
    list(){return {accounts:deps.users.list().filter(user=>user.enabled).map(user=>({id:user.id,name:user.name})),items:deps.repository().list().map(publicSource),
      operations:deps.deletion.listSubscriptionRemovals().map(operation=>removalOperation(operation,source(operation.sourceId,true)))};},
    get(id:unknown){return publicSource(source(id,true));},
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
      if(previous&&deps.deletion.hasUnfinishedSubscriptionRemoval(previous.routingKey))fail('请先完成这个 UP 的归档清理，再重新添加订阅',409);
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
        deps.repository().remove(current.id,current.revision,deps.now());return {retained:true,operation:null};
      }
      const preview=deps.deletion.get(text(value.previewId,'操作预览'));
      if(!preview||preview.scope!=='source'||preview.bvid!==undefined||preview.userId!==current.userId||preview.mediaId!==current.routingKey)fail('清理预览不属于该订阅',409);
      const operation=deps.deletion.startSubscriptionRemoval(preview.id,text(value.confirmation,'确认文字'),()=>{
        expect(source(id,true),value.revision);
        deps.repository().removeAndExclude(current.id,current.revision,deps.now());
      });
      return {retained:false,operation:removalOperation(operation,source(id,true))};
    },
    repreviewRemoval(id:unknown){ready();const {operation,current}=requireRemoval(id);if(operation.status!=='failed')fail('只有失败的清理任务可以重新核对',409);return removalPreview(current);},
    retryRemoval(id:unknown){ready();const {operation,current}=requireRemoval(id);return removalOperation(deps.deletion.retry(operation.id),current);},
    catalog(id:unknown,input:Record<string,unknown>){const current=source(id,true);const filter=input.filter??'all';if(filter!=='all'&&filter!=='selected'&&filter!=='excluded')fail('投稿筛选无效');return deps.repository().catalog(current,{filter,query:typeof input.q==='string'?input.q.trim():'',cursor:typeof input.cursor==='string'?input.cursor:undefined});},
    select(id:unknown,value:unknown){
      ready();if(!isRecord(value)||!Array.isArray(value.items)||value.items.length===0||value.items.length>300)fail('请选择 1–300 个投稿');
      const current=source(id);expect(current,value.revision);
      const changes=value.items.map(item=>{if(!isRecord(item))fail('选择条目无效');const bv=bvid(item.bvid);if(!deps.repository().item(current.id,bv))fail('投稿未在该订阅中');return {bvid:bv,decision:decision(item.decision)};});
      deps.atomic(()=>{deps.repository().bumpRevision(current.id,current.revision,deps.now());for(const change of changes)deps.repository().setDecision(current.id,change.bvid,change.decision,deps.now());
        const updated=source(id);for(const change of changes){const item=deps.repository().item(updated.id,change.bvid);if(item&&!deps.repository().isBlocked(updated.userId,updated.routingKey,item.bvid))deps.ingest(updated,item);}});
      deps.scan();return publicSource(source(id));
    },
    scan(id:unknown){ready();const current=source(id);if(!current.enabled)fail('请先启用订阅');deps.repository().requestScan(current.id);return deps.scan();},
    previewAction(id:unknown,bv:unknown,value:unknown){
      ready();prune();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);const video=bvid(bv);
      if(!deps.repository().item(current.id,video))fail('投稿不存在',404);
      if(value.scope!=='source'&&value.scope!=='global')fail('操作范围无效');if(value.effect!=='retain'&&value.effect!=='delete')fail('操作方式无效');
      const relations=deps.relations(video).filter(relation=>value.scope==='global'||relation.sourceId===current.id);
      const hasProof=relations.some(relation=>relation.remoteFiles?.some(file=>file.verificationStatus==='verified'));
      const deletion=value.effect==='delete'&&hasProof ? (value.scope==='global'?deps.deletion.previewVideo(video):deps.deletion.previewSource(current.userId,current.routingKey,video,{allowActive:true})) : undefined;
      const preview:UpVideoActionPreview={previewId:crypto.randomUUID(),sourceId:current.id,bvid:video,scope:value.scope,effect:value.effect,
        sources:relations.map(relation=>({userId:relation.userId,mediaId:relation.mediaId,title:relation.folderTitle})),
        fileCount:deletion?.fileCount??0,totalBytes:deletion?.totalBytes??0,sharedCount:deletion?.sharedCount??0,
        confirmation:value.effect==='delete'?'DELETE ARCHIVE':'不再归档'};
      previews.set(preview.previewId,{preview,revision:current.revision,expires:deps.now()+10*60_000,deletionId:deletion?.id});return preview;
    },
    action(id:unknown,bv:unknown,value:unknown){
      ready();prune();if(!isRecord(value))fail('操作参数无效');const current=source(id,true);const video=bvid(bv);const cached=previews.get(text(value.previewId,'操作预览'));
      if(!cached||cached.preview.sourceId!==current.id||cached.preview.bvid!==video||cached.revision!==current.revision)fail('预览已变化，请重新确认',409);
      if(value.confirmation!==cached.preview.confirmation)fail('确认文字不匹配');
      // Exclusion survives deletion failure; it is committed before scheduling destructive work.
      deps.atomic(()=>{if(cached.preview.scope==='global')deps.repository().setGlobalExclusion(video,true,deps.now());else deps.repository().setDecision(current.id,video,'exclude',deps.now());deps.repository().bumpRevision(current.id,current.revision,deps.now());});
      previews.delete(cached.preview.previewId);
      const operation=cached.deletionId?deps.deletion.start(cached.deletionId,'DELETE ARCHIVE'):null;
      return {subscription:publicSource(source(id,true)),operation,retained:cached.preview.effect==='retain'};
    },
    unblock(id:unknown,bv:unknown,value:unknown){ready();if(!isRecord(value))fail('参数无效');const current=source(id,true);expect(current,value.revision);const video=bvid(bv);
      if(deps.deletion.hasUnfinishedSubscriptionRemoval(current.routingKey))fail('请先完成该订阅的归档清理，再解除排除',409);
      if(value.scope!=='global'&&value.scope!=='source')fail('恢复范围无效');
      deps.atomic(()=>{if(value.scope==='global')deps.repository().setGlobalExclusion(video,false,deps.now());else deps.repository().setDecision(current.id,video,'inherit',deps.now());deps.repository().bumpRevision(current.id,current.revision,deps.now());
        const updated=source(id,true),item=deps.repository().item(current.id,video);if(item)deps.ingest(updated,item);});deps.scan();return publicSource(source(id,true));},
    operation(id:unknown){return deps.deletion.get(text(id,'清理任务'))??fail('清理任务不存在',404);},
    retry(id:unknown){ready();return deps.deletion.retry(text(id,'清理任务'));},
    reset(){previewItems.clear();previews.clear();},
  };
}
