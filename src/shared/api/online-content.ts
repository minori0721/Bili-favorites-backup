import { isRecord } from './value.js';

export interface OnlineItem {
  id:string; bvid?:string; title?:string; upperName?:string; coverUrl?:string; coverToken?:string;
  openUrl?:string; archiveState:'archived'|'processing'|'unarchived'|'unavailable';
}
export interface OnlineNavigationDTO {
  accounts:Array<{userId:string;uid?:number;name:string;avatar?:string;sources:Array<{
    kind:string;mediaId?:number;title:string;count?:number;countLabel?:string;
  }>}>
}
function text(value:Record<string,unknown>,key:string,fallback=''):string {
  const item=value[key];
  if(item===undefined||item===null)return fallback;
  if(typeof item!=='string')throw new Error('在线内容字段格式错误: '+key);
  return item;
}
function count(value:unknown):number|null {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='number'||!Number.isInteger(value)||value<0)throw new Error('在线内容计数格式错误');
  return value;
}
function link(value:string,relative=false):string {
  if(!value)return '';
  if(relative&&value.startsWith('/')&&!value.startsWith('//'))return value;
  if(!/^https?:\/\//i.test(value))throw new Error('在线内容链接格式错误');
  return value;
}
export function parseOnlineItem(value:unknown):OnlineItem {
  if(!isRecord(value)||typeof value.id!=='string'||!value.id)throw new Error('在线条目格式错误');
  const archiveState=(['archived','processing','unarchived','unavailable'] as const).find(state=>state===value.archiveState);
  if(!archiveState)throw new Error('在线归档状态格式错误');
  return {id:value.id,bvid:text(value,'bvid'),title:text(value,'title'),upperName:text(value,'upperName'),
    coverUrl:link(text(value,'coverUrl'),true),coverToken:text(value,'coverToken'),openUrl:link(text(value,'openUrl')),archiveState};
}
export function parseOnlinePage(value:unknown) {
  if(!isRecord(value))throw new Error('在线分页格式错误');
  const page=isRecord(value.page)?value.page:{};
  const items=value.items??page.items;
  if(!Array.isArray(items))throw new Error('在线条目列表格式错误');
  const hasMore=page.hasMore??value.hasMore??false;
  if(typeof hasMore!=='boolean')throw new Error('在线分页状态格式错误');
  const cursor=page.nextCursor??value.nextCursor;
  if(cursor!==undefined&&cursor!==null&&typeof cursor!=='string')throw new Error('在线分页游标格式错误');
  return {items:items.map(parseOnlineItem),page:{page:count(page.page),total:count(page.total??value.total),nextCursor:cursor||null,hasMore}};
}
export function parseOnlineNavigation(value:unknown) {
  if(!isRecord(value)||!Array.isArray(value.accounts))throw new Error('在线目录格式错误');
  return {accounts:value.accounts.map((account:unknown)=>{
    if(!isRecord(account)||typeof account.userId!=='string'||!account.userId||!Array.isArray(account.sources))throw new Error('在线账号目录格式错误');
    return {userId:account.userId,name:text(account,'name'),sources:account.sources.map((source:unknown)=>{
      if(!isRecord(source)||typeof source.kind!=='string')throw new Error('在线来源目录格式错误');
      return {kind:source.kind,mediaId:count(source.mediaId),title:text(source,'title','在线内容'),count:count(source.count),countLabel:text(source,'countLabel')};
    })};
  })};
}
