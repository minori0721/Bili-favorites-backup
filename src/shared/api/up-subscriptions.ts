import { isRecord, ResponseFormatError, requireUnique } from './value.js';
import type { UpSubscription, UpSubmission, UpIdentity, UpDiscoveryPage, UpCatalogItem, UpCatalogPage, UpVideoActionPreview, UpRemovalPreview, UpRemovalOperation } from '../up-subscriptions.js';
function fail(field:string):never {throw new ResponseFormatError(`UP 响应格式错误：${field}`);}
function obj(value:unknown){return isRecord(value)?value:fail('对象');}
function text(value:unknown,field:string){return typeof value==='string'?value:fail(field);}
function identityText(value:unknown,field:string){const result=text(value,field);return result.trim()?result:fail(field);}
function number(value:unknown,field:string,min=0){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min?value:fail(field);}
function flag(value:unknown,field:string){return typeof value==='boolean'?value:fail(field);}
function nullableNumber(value:unknown,field:string){return value===null?null:number(value,field);}
function nullableText(value:unknown,field:string){return value===null?null:text(value,field);}
export function parseUpIdentity(value:unknown):UpIdentity {
  const item=obj(value);return {uid:number(item.uid,'uid',1),name:text(item.name,'name'),avatar:text(item.avatar,'avatar'),signature:text(item.signature,'signature'),
    ...(item.followed===undefined?{}:{followed:flag(item.followed,'followed')})};
}
export function parseUpSubscription(value:unknown):UpSubscription {
  const item=obj(value),mode=item.mode;
  if(mode!=='all'&&mode!=='from_now'&&mode!=='from_date'&&mode!=='from_video'&&mode!=='selected')fail('mode');
  const since=nullableNumber(item.since,'since'),anchorBvid=nullableText(item.anchorBvid,'anchorBvid');
  if(mode!=='all'&&mode!=='selected'&&since===null)fail('since');
  if(anchorBvid!==null&&!/^BV[0-9A-Za-z]+$/.test(anchorBvid))fail('anchorBvid');
  if(mode==='from_video'&&anchorBvid===null)fail('anchorBvid');
  return {id:identityText(item.id,'id'),uid:number(item.uid,'uid',1),name:text(item.name,'name'),avatar:text(item.avatar,'avatar'),userId:identityText(item.userId,'userId'),
    enabled:flag(item.enabled,'enabled'),removed:flag(item.removed,'removed'),mode,since,anchorBvid,
    revision:number(item.revision,'revision',1),nextPage:number(item.nextPage,'nextPage',1),historyComplete:flag(item.historyComplete,'historyComplete'),
    ...(item.accountAvailable===undefined?{}:{accountAvailable:flag(item.accountAvailable,'accountAvailable')}),
    watermark:number(item.watermark,'watermark'),pendingWatermark:number(item.pendingWatermark,'pendingWatermark'),nextScanAt:number(item.nextScanAt,'nextScanAt'),
    lastScanAt:nullableNumber(item.lastScanAt,'lastScanAt'),lastError:nullableText(item.lastError,'lastError'),discoveredCount:number(item.discoveredCount,'discoveredCount'),
    selectedCount:number(item.selectedCount,'selectedCount'),excludedCount:number(item.excludedCount,'excludedCount'),archivedCount:number(item.archivedCount,'archivedCount')};
}
export function parseUpList(value:unknown) {
  const data=obj(value);if(!Array.isArray(data.items)||!Array.isArray(data.accounts))fail('列表');
  if(data.operations!==undefined&&!Array.isArray(data.operations))fail('移除任务列表');
  return {items:requireUnique(data.items.map(parseUpSubscription),item=>item.id,'UP 订阅重复'),accounts:data.accounts.map(value=>{const item=obj(value);return {id:text(item.id,'account.id'),name:text(item.name,'account.name')};}),
    operations:requireUnique((data.operations??[]).map(parseUpRemovalOperation),item=>item.id,'移除任务重复')};
}
export function parseUpDiscovery(value:unknown):UpDiscoveryPage {
  const data=obj(value);if(!Array.isArray(data.items))fail('查找列表');return {items:requireUnique(data.items.map(parseUpIdentity),item=>String(item.uid),'UP 查找结果重复'),
    page:number(data.page,'page',1),pageSize:number(data.pageSize,'pageSize',1),total:number(data.total,'total'),hasMore:flag(data.hasMore,'hasMore')};
}
export function parseUpSubmission(value:unknown):UpSubmission {
  const item=obj(value),bvid=text(item.bvid,'bvid');if(!/^BV[0-9A-Za-z]+$/.test(bvid))fail('bvid');
  return {bvid,title:text(item.title,'title'),cover:text(item.cover,'cover'),publishedAt:number(item.publishedAt,'publishedAt'),ownerUid:number(item.ownerUid,'ownerUid',1),
    ownerName:text(item.ownerName,'ownerName'),duration:nullableNumber(item.duration,'duration'),joint:flag(item.joint,'joint')};
}
export function parseUpPosts(value:unknown) {const data=obj(value);if(!Array.isArray(data.items))fail('投稿列表');return {items:data.items.map(parseUpSubmission),hasMore:flag(data.hasMore,'hasMore'),total:number(data.total,'total'),page:number(data.page,'page',1)};}
export function parseUpCatalog(value:unknown):UpCatalogPage {
  const data=obj(value);if(!Array.isArray(data.items))fail('投稿列表');
  return {items:requireUnique(data.items.map((value):UpCatalogItem=>{const item=obj(value),decision=item.decision;
    if(decision!=='inherit'&&decision!=='include'&&decision!=='exclude')fail('decision');
    return {...parseUpSubmission(item),decision,globalExcluded:flag(item.globalExcluded,'globalExcluded'),selected:flag(item.selected,'selected'),
      archiveStatus:nullableText(item.archiveStatus,'archiveStatus'),playable:flag(item.playable,'playable'),otherArchiveAvailable:flag(item.otherArchiveAvailable,'otherArchiveAvailable')};}),item=>item.bvid,'投稿重复'),
    total:number(data.total,'total'),nextCursor:nullableText(data.nextCursor,'nextCursor')};
}
export function parseUpActionPreview(value:unknown):UpVideoActionPreview {
  const item=obj(value),scope=item.scope,effect=item.effect;if((scope!=='source'&&scope!=='global')||(effect!=='retain'&&effect!=='delete')||!Array.isArray(item.sources))fail('操作预览');
  return {previewId:text(item.previewId,'previewId'),sourceId:text(item.sourceId,'sourceId'),bvid:text(item.bvid,'bvid'),scope,effect,
    sources:item.sources.map(value=>{const source=obj(value);if(typeof source.mediaId!=='number'||!Number.isSafeInteger(source.mediaId))fail('mediaId');return {userId:text(source.userId,'userId'),mediaId:source.mediaId,title:text(source.title,'title')};}),
    fileCount:number(item.fileCount,'fileCount'),sharedCount:number(item.sharedCount,'sharedCount'),totalBytes:number(item.totalBytes,'totalBytes'),confirmation:text(item.confirmation,'confirmation')};
}
export function parseUpRemovalPreview(value:unknown):UpRemovalPreview {
  const item=obj(value);
  const fileCount=number(item.fileCount,'fileCount'),sharedCount=number(item.sharedCount,'sharedCount');
  const totalBytes=number(item.totalBytes,'totalBytes'),reclaimableBytes=number(item.reclaimableBytes,'reclaimableBytes');
  if(sharedCount>fileCount||reclaimableBytes>totalBytes)fail('清理数量');
  return {previewId:identityText(item.previewId,'previewId'),sourceId:identityText(item.sourceId,'sourceId'),revision:number(item.revision,'revision',1),
    videoCount:number(item.videoCount,'videoCount'),fileCount,sharedCount,totalBytes,reclaimableBytes,
    activeTasks:number(item.activeTasks,'activeTasks'),confirmation:identityText(item.confirmation,'confirmation')};
}
export function parseUpRemovalOperation(value:unknown):UpRemovalOperation {
  const item=obj(value),status=item.status;
  if(status!=='pending'&&status!=='running'&&status!=='retry_wait'&&status!=='failed'&&status!=='completed')fail('清理状态');
  return {id:identityText(item.id,'id'),sourceId:identityText(item.sourceId,'sourceId'),sourceName:text(item.sourceName,'sourceName'),status,
    fileCount:number(item.fileCount,'fileCount'),completedCount:number(item.completedCount,'completedCount'),retainedCount:number(item.retainedCount,'retainedCount'),lastError:nullableText(item.lastError,'lastError')};
}
export function parseUpRemovalResult(value:unknown) {
  const item=obj(value);return {retained:flag(item.retained,'retained'),operation:item.operation===null?null:parseUpRemovalOperation(item.operation)};
}
