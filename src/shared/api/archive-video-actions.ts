import { isRecord, ResponseFormatError, requireUnique } from './value.js';
import type { ArchiveVideoActionContext, ArchiveVideoActionPreview, ArchiveVideoSource } from '../archive-video-actions.js';

function record(value: unknown) {if(!isRecord(value)) throw new ResponseFormatError('归档操作响应格式错误');return value;}
function text(value: unknown) {if(typeof value !== 'string' || !value) throw new ResponseFormatError('归档操作文字字段错误');return value;}
function flag(value: unknown) {if(typeof value !== 'boolean') throw new ResponseFormatError('归档操作状态字段错误');return value;}
function count(value: unknown) {if(typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ResponseFormatError('归档操作计数字段错误');return value;}
function source(value: unknown): ArchiveVideoSource {
  const item=record(value),kind=item.sourceKind;
  if(typeof item.mediaId !== 'number' || !Number.isSafeInteger(item.mediaId) || item.mediaId === 0
    || (kind !== 'favorite' && kind !== 'up' && kind !== 'manual')) throw new ResponseFormatError('归档来源格式错误');
  return {userId:text(item.userId),mediaId:item.mediaId,sourceId:text(item.sourceId),title:text(item.title),accountName:text(item.accountName),sourceKind:kind,excluded:flag(item.excluded)};
}
function sources(value: unknown) {
  if(!Array.isArray(value)) throw new ResponseFormatError('归档来源列表格式错误');
  return requireUnique(value.map(source),item=>JSON.stringify([item.userId,item.mediaId]),'归档来源重复');
}
export function parseArchiveVideoContext(value: unknown): ArchiveVideoActionContext {
  const item=record(value),current=source(item.current),list=sources(item.sources),bvid=text(item.bvid);
  if(!/^BV[0-9A-Za-z]+$/.test(bvid) || !list.some(source=>source.userId===current.userId && source.mediaId===current.mediaId)) throw new ResponseFormatError('当前归档来源不存在');
  const row=item.cleanup===undefined?undefined:record(item.cleanup);
  const cleanup=row?{id:text(row.id),status:text(row.status),fileCount:count(row.fileCount),completedCount:count(row.completedCount),retainedCount:count(row.retainedCount),
    deletedCount:row.deletedCount===undefined?undefined:count(row.deletedCount),missingCount:row.missingCount===undefined?undefined:count(row.missingCount),lastError:row.lastError===undefined?undefined:text(row.lastError)}:undefined;
  if(cleanup && !['preparing','config_removing','pending','running','retry_wait','failed','completed','stopped'].includes(cleanup.status))throw new ResponseFormatError('清理状态错误');
  return {bvid,title:text(item.title),current,sources:list,globalExcluded:flag(item.globalExcluded),cleanup};
}
export function parseArchiveVideoPreview(value: unknown): ArchiveVideoActionPreview {
  const item=record(value),scope=item.scope,effect=item.effect;
  if((scope!=='source' && scope!=='selected' && scope!=='global') || (effect!=='retain' && effect!=='delete')) throw new ResponseFormatError('归档操作范围错误');
  const result:ArchiveVideoActionPreview={previewId:text(item.previewId),bvid:text(item.bvid),scope,effect,sources:sources(item.sources),retainedSources:sources(item.retainedSources),
    fileCount:count(item.fileCount),sharedCount:count(item.sharedCount),totalBytes:count(item.totalBytes),deleteCount:count(item.deleteCount),reclaimableBytes:count(item.reclaimableBytes),confirmation:text(item.confirmation)};
  if(!/^BV[0-9A-Za-z]+$/.test(result.bvid) || !result.sources.length || result.deleteCount+result.sharedCount>result.fileCount || result.reclaimableBytes>result.totalBytes) throw new ResponseFormatError('归档清理数量不一致');
  return result;
}
