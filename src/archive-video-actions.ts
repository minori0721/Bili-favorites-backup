import crypto from 'node:crypto';
import type { ArchiveDeletionService } from './archive-deletion.js';
import type { FavoriteRelation } from './state.js';
import { legacyArchiveSourceId, type StoredUpSubscription, type UpSubscriptionRepository } from './repositories/up-subscriptions.js';
import type { UpSubmission, UpVideoDecision } from './shared/up-subscriptions.js';
import type { ArchiveVideoActionContext, ArchiveVideoActionPreview, ArchiveVideoSource } from './shared/archive-video-actions.js';
import { isRecord } from './shared/api/value.js';

export interface ArchiveVideoActions {
  context(bvid: unknown, input: unknown): ArchiveVideoActionContext;
  preview(bvid: unknown, input: unknown): ArchiveVideoActionPreview;
  commit(bvid: unknown, input: unknown): {operation: ReturnType<ArchiveDeletionService['start']> | null; retained: boolean};
  unblock(bvid: unknown, input: unknown): ArchiveVideoActionContext;
  select(sourceId: unknown, input: unknown): void;
  reset(): void;
}
type Repository = Pick<UpSubscriptionRepository, 'get' | 'getByRoute' | 'item' | 'decision' | 'setDecision' | 'globallyExcluded' | 'setGlobalExclusion' | 'bumpRevision' | 'isBlocked'>;
const sourceKey = (source: {userId: string; mediaId: number}) => JSON.stringify([source.userId,source.mediaId]);
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message),{statusCode}); }
function videoId(value: unknown) { if(typeof value !== 'string' || !/^BV[0-9A-Za-z]+$/.test(value)) fail('BV号无效'); return value; }
function inputObject(value: unknown) { if(!isRecord(value)) fail('归档操作参数无效'); return value; }

export function createArchiveVideoActions(deps: {
  repository(): Repository;
  relations(bvid: string): FavoriteRelation[];
  accountName(userId: string): string;
  title(bvid: string): string;
  atomic<T>(work: () => T): T;
  restoreSource(userId:string,mediaId:number,bvid:string,at:number): void;
  ingest(source:StoredUpSubscription,item:UpSubmission): unknown;
  blocked(): boolean;
  deletion: Pick<ArchiveDeletionService,'previewVideo' | 'startVideoRemoval' | 'sourceOperation' | 'hasUnfinishedSubscriptionRemoval' | 'hasUnfinishedVideoDeletion'>;
  now(): number;
}): ArchiveVideoActions {
  const previews = new Map<string,{preview: ArchiveVideoActionPreview; input: Record<string,unknown>; signature: string; expires: number; deletionId?: string}>();
  function ready() { if(deps.blocked()) fail('维护期间暂时不能修改归档范围',409); }
  function mutable(bvid:string,sources:ReadonlyArray<ArchiveVideoSource>) {
    if(sources.some(source=>source.sourceKind==='up' && deps.deletion.hasUnfinishedSubscriptionRemoval(source.mediaId))
      || deps.deletion.hasUnfinishedVideoDeletion(bvid,sources)) fail('请先完成或停止未结束的归档清理，再修改归档规则',409);
  }
  function resume(bvid:string,sources:ReadonlyArray<ArchiveVideoSource>) {
    for(const source of sources) {
      deps.restoreSource(source.userId,source.mediaId,bvid,deps.now());
      if(source.sourceKind==='up') {
        const up=deps.repository().get(source.sourceId),item=deps.repository().item(source.sourceId,bvid);
        if(up && item && !deps.repository().isBlocked(up.userId,up.routingKey,bvid))deps.ingest(up,item);
      }
    }
  }
  function resolveCurrent(bvid: string,input: Record<string,unknown>) {
    const repository = deps.repository();
    if(typeof input.sourceId === 'string') {
      const source = repository.get(input.sourceId);
      if(!source || !repository.item(source.id,bvid)) fail('订阅或投稿不存在',404);
      if(input.revision !== undefined && input.revision !== source.revision) fail('订阅已变化，请刷新后重试',409);
      return {userId:source.userId,mediaId:source.routingKey};
    }
    if(typeof input.userId !== 'string' || !input.userId || typeof input.mediaId !== 'number' || !Number.isSafeInteger(input.mediaId) || input.mediaId === 0) fail('归档来源参数无效');
    if(!deps.relations(bvid).some(source => source.userId === input.userId && source.mediaId === input.mediaId)) fail('归档来源不存在',404);
    return {userId:input.userId,mediaId:input.mediaId};
  }
  function describe(bvid: string,source: {userId: string; mediaId: number; folderTitle?: string}): ArchiveVideoSource {
    const repository = deps.repository();
    const up = source.mediaId <= -2 ? repository.getByRoute(source.mediaId) : null;
    if(source.mediaId <= -2 && (!up || up.userId !== source.userId)) fail('归档来源已变化，请刷新后重试',409);
    const sourceId = up?.id ?? legacyArchiveSourceId(source.userId,source.mediaId);
    return {userId:source.userId,mediaId:source.mediaId,sourceId,
      title:source.folderTitle || (up ? `UP · ${up.name}` : source.mediaId === -1 ? '手动归档' : `收藏夹 ${source.mediaId}`),
      accountName:deps.accountName(source.userId) || '已移除账号',sourceKind:up ? 'up' : source.mediaId === -1 ? 'manual' : 'favorite',
      excluded:repository.decision(sourceId,bvid) === 'exclude'};
  }
  function context(value: unknown,input: unknown): ArchiveVideoActionContext {
    const bvid = videoId(value), current = resolveCurrent(bvid,inputObject(input));
    const sources = deps.relations(bvid).map(source => describe(bvid,source));
    const found = sources.find(source => sourceKey(source) === sourceKey(current)) ?? describe(bvid,current);
    if(!sources.includes(found)) sources.push(found);
    sources.sort((a,b) => sourceKey(a).localeCompare(sourceKey(b)));
    const operation=deps.deletion.sourceOperation(current.userId,current.mediaId,bvid);
    const cleanup=operation?{id:operation.id,status:operation.status,fileCount:operation.fileCount,completedCount:operation.completedCount,retainedCount:operation.retainedCount,deletedCount:operation.deletedCount,missingCount:operation.missingCount,lastError:operation.lastError}:undefined;
    return {bvid,title:deps.title(bvid) || bvid,current:found,sources,globalExcluded:deps.repository().globallyExcluded(bvid),cleanup};
  }
  function signature(ctx: ArchiveVideoActionContext,sources: ArchiveVideoSource[],global: boolean) {
    return JSON.stringify({globalExcluded:ctx.globalExcluded,sources:(global ? ctx.sources : sources).map(source => {
      const up = source.sourceKind === 'up' ? deps.repository().get(source.sourceId) : null;
      return [sourceKey(source),deps.repository().decision(source.sourceId,ctx.bvid),up?.revision,up?.userId];
    })});
  }
  return {
    context,
    preview(value,input) {
      ready();
      for(const [id,item] of previews) if(item.expires <= deps.now()) previews.delete(id);
      const data = inputObject(input),ctx = context(value,data);
      const scope = data.scope,effect = data.effect;
      if(scope !== 'source' && scope !== 'selected' && scope !== 'global') fail('操作范围无效');
      if(effect !== 'retain' && effect !== 'delete') fail('操作方式无效');
      let sources = scope === 'global' ? ctx.sources : [ctx.current];
      if(scope === 'selected') {
        if(!Array.isArray(data.sources) || !data.sources.length || data.sources.length > ctx.sources.length) fail('请选择要处理的归档来源');
        sources = data.sources.map(value => {
          const item = inputObject(value);
          const found = ctx.sources.find(source => source.userId === item.userId && source.mediaId === item.mediaId);
          if(!found) fail('所选来源已变化，请重新核对',409);
          return found;
        });
        if(new Set(sources.map(sourceKey)).size !== sources.length) fail('归档来源不能重复');
      }
      const keys = new Set(sources.map(sourceKey));
      mutable(ctx.bvid,sources);
      const hasProof = deps.relations(ctx.bvid).some(source => keys.has(sourceKey(source)) && source.remoteFiles?.some(file => file.verificationStatus === 'verified'));
      const deletion = effect === 'delete' && hasProof ? deps.deletion.previewVideo(ctx.bvid,sources) : undefined;
      const preview: ArchiveVideoActionPreview = {previewId:crypto.randomUUID(),bvid:ctx.bvid,scope,effect,sources,
        retainedSources:ctx.sources.filter(source => !keys.has(sourceKey(source))),
        fileCount:deletion?.fileCount ?? 0,sharedCount:deletion?.sharedCount ?? 0,totalBytes:deletion?.totalBytes ?? 0,
        deleteCount:deletion?.deleteCount ?? 0,reclaimableBytes:deletion?.reclaimableBytes ?? 0,
        confirmation:effect === 'delete' ? 'DELETE ARCHIVE' : '不再归档'};
      previews.set(preview.previewId,{preview,input:{...data},signature:signature(ctx,sources,scope === 'global'),expires:deps.now()+10*60_000,deletionId:deletion?.id});
      return preview;
    },
    commit(value,input) {
      ready();
      const bvid = videoId(value),data = inputObject(input);
      const cached = typeof data.previewId === 'string' ? previews.get(data.previewId) : undefined;
      if(!cached || cached.expires <= deps.now() || cached.preview.bvid !== bvid) fail('操作预览已失效，请重新核对',409);
      const ctx = context(bvid,cached.input);
      if((data.sourceId !== undefined || data.userId !== undefined) && sourceKey(resolveCurrent(bvid,data)) !== sourceKey(ctx.current)) fail('操作预览不属于当前来源',409);
      if(signature(ctx,cached.preview.sources,cached.preview.scope === 'global') !== cached.signature) fail('归档来源或排除规则已变化，请重新核对',409);
      if(data.confirmation !== cached.preview.confirmation) fail('确认文字不匹配');
      mutable(bvid,cached.preview.sources);
      const applyRules=() => {
        const repository = deps.repository();
        if(cached.preview.scope === 'global') repository.setGlobalExclusion(bvid,true,deps.now());
        else for(const source of cached.preview.sources) repository.setDecision(source.sourceId,bvid,'exclude',deps.now());
        for(const source of cached.preview.sources) if(source.sourceKind === 'up') {
          const up = repository.get(source.sourceId);
          if(!up) fail('订阅已变化，请重新核对',409);
          repository.bumpRevision(up.id,up.revision,deps.now());
        }
      };
      const operation=cached.deletionId
        ? deps.deletion.startVideoRemoval(cached.deletionId,'DELETE ARCHIVE',applyRules)
        : (deps.atomic(applyRules),null);
      previews.delete(cached.preview.previewId);
      return {operation,retained:cached.preview.effect === 'retain'};
    },
    unblock(value,input) {
      ready();const data = inputObject(input),ctx = context(value,data);
      if(data.scope !== 'source' && data.scope !== 'global') fail('恢复范围无效');
      const mode=data.mode??'rule';
      if(mode!=='rule'&&mode!=='include')fail('恢复方式无效');
      if(mode==='include'&&(data.scope!=='source'||ctx.current.sourceKind!=='up'))fail('只有 UP 当前来源支持单独归档');
      if(mode==='include'&&ctx.globalExcluded)fail('请先解除全局排除，再归档这个视频',409);
      const restoring=data.scope==='global'?ctx.sources:[ctx.current];
      mutable(ctx.bvid,restoring);
      deps.atomic(() => {
        if(data.scope === 'global') deps.repository().setGlobalExclusion(ctx.bvid,false,deps.now());
        else deps.repository().setDecision(ctx.current.sourceId,ctx.bvid,mode==='include'?'include':'inherit',deps.now());
        for(const source of restoring.filter(source=>source.sourceKind==='up')) {
          const up = deps.repository().get(source.sourceId);
          if(!up) fail('订阅已变化',409);
          deps.repository().bumpRevision(up.id,up.revision,deps.now());
        }
        resume(ctx.bvid,restoring);
      });
      return context(ctx.bvid,ctx.current.sourceKind==='up'
        ? {sourceId:ctx.current.sourceId} : {userId:ctx.current.userId,mediaId:ctx.current.mediaId});
    },
    select(sourceId,input) {
      ready();const data=inputObject(input),repository=deps.repository();
      const up=typeof sourceId==='string'?repository.get(sourceId):null;
      if(!up||up.removed)fail('订阅不存在',404);
      if(data.revision!==up.revision)fail('订阅已变化，请刷新后重试',409);
      if(!Array.isArray(data.items)||!data.items.length||data.items.length>300)fail('请选择 1–300 个投稿');
      const changes=data.items.map(value=>{
        const item=inputObject(value),bvid=videoId(item.bvid),decision=item.decision;
        if(!repository.item(up.id,bvid))fail('投稿未在该订阅中');
        if(decision!=='include'&&decision!=='inherit'&&decision!=='exclude')fail('选择方式无效');
        const previous=repository.decision(up.id,bvid);
        // Canceling an extra selection must not silently erase an explicit exclusion.
        const next:UpVideoDecision=decision==='inherit'&&previous==='exclude'?'exclude':decision;
        return {bvid,decision:next,previous};
      });
      if(new Set(changes.map(change=>change.bvid)).size!==changes.length)fail('投稿不能重复');
      for(const change of changes)if(change.decision!=='exclude'||change.decision!==change.previous) {
        mutable(change.bvid,[describe(change.bvid,{userId:up.userId,mediaId:up.routingKey})]);
        if(change.decision==='include'&&repository.globallyExcluded(change.bvid))fail('请先解除全局排除，再归档选中的视频',409);
      }
      deps.atomic(()=>{
        repository.bumpRevision(up.id,up.revision,deps.now());
        for(const change of changes) {
          repository.setDecision(up.id,change.bvid,change.decision,deps.now());
          if(change.decision!=='exclude')resume(change.bvid,[describe(change.bvid,{userId:up.userId,mediaId:up.routingKey})]);
        }
      });
    },
    reset() {previews.clear();},
  };
}
