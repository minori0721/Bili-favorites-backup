import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { isRecord } from '../shared/api/value.js';
import { shouldArchiveUpVideo } from '../up-subscriptions/policy.js';
import type { UpCatalogItem, UpCatalogPage, UpIdentity, UpSubmission, UpSubscription, UpSubscriptionInput, UpVideoDecision } from '../shared/up-subscriptions.js';
import { parseUpSubscription,parseUpSubmission } from '../shared/api/up-subscriptions.js';

export const UP_SUBSCRIPTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS up_subscriptions (
  id TEXT PRIMARY KEY, uid INTEGER NOT NULL UNIQUE, routing_key INTEGER NOT NULL UNIQUE CHECK(routing_key <= -2),
  name TEXT NOT NULL, avatar TEXT NOT NULL, user_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  removed INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL, since_at INTEGER, anchor_bvid TEXT, revision INTEGER NOT NULL DEFAULT 1,
  next_page INTEGER NOT NULL DEFAULT 1, history_complete INTEGER NOT NULL DEFAULT 0,
  watermark INTEGER NOT NULL DEFAULT 0, pending_watermark INTEGER NOT NULL DEFAULT 0,
  next_scan_at INTEGER NOT NULL DEFAULT 0, last_scan_at INTEGER, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS up_catalog (
  source_id TEXT NOT NULL REFERENCES up_subscriptions(id), bvid TEXT NOT NULL,
  published_at INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(source_id,bvid)
);
CREATE INDEX IF NOT EXISTS idx_up_catalog_order ON up_catalog(source_id,published_at DESC,bvid DESC);
CREATE TABLE IF NOT EXISTS archive_video_decisions (
  source_id TEXT NOT NULL, bvid TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('include','exclude')),
  updated_at INTEGER NOT NULL, PRIMARY KEY(source_id,bvid)
);
CREATE TABLE IF NOT EXISTS archive_global_exclusions (bvid TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`;

interface SubscriptionRow {
  id: string; uid: number; routing_key: number; name: string; avatar: string; user_id: string;
  enabled: number; removed: number; mode: string; since_at: number | null; anchor_bvid: string | null; revision: number;
  next_page: number; history_complete: number; watermark: number; pending_watermark: number; next_scan_at: number;
  last_scan_at: number | null; last_error: string | null;
  discovered_count: number; selected_count: number; excluded_count: number; archived_count: number;
}
export interface StoredUpSubscription extends UpSubscription { routingKey: number; }
export interface UpSubscriptionSnapshot {
  sources:Array<{subscription:StoredUpSubscription;createdAt:number;updatedAt:number;items:UpSubmission[]}>;
  decisions:Array<{sourceId:string;bvid:string;decision:'include'|'exclude';updatedAt:number}>;
  globalExclusions:Array<{bvid:string;createdAt:number}>;
}
interface CatalogRow { bvid: string; published_at: number; payload_json: string; decision: string | null; global_excluded: number; archive_status: string | null; playable: number; other_available: number; }
interface CatalogCursor { at: number; bvid: string; }
const modes = new Set(['all','from_now','from_date','from_video','selected']);
function validInteger(value: number, field: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`UP 存储字段损坏：${field}`);
  return value;
}
function boolean(value: number, field: string) { if (value !== 0 && value !== 1) throw new Error(`UP 存储字段损坏：${field}`); return value === 1; }
function decode(row: SubscriptionRow): StoredUpSubscription {
  if (!modes.has(row.mode)) throw new Error('UP 存储字段损坏：mode');
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.name !== 'string' || typeof row.avatar !== 'string' || typeof row.user_id !== 'string' || !row.user_id.trim()) throw new Error('UP 存储身份损坏');
  if (!Number.isSafeInteger(row.routing_key) || row.routing_key > -2) throw new Error('UP 存储字段损坏：routing_key');
  const mode = row.mode;
  if (mode !== 'all' && mode !== 'from_now' && mode !== 'from_date' && mode !== 'from_video' && mode !== 'selected') throw new Error('UP 归档方式损坏');
  if(mode!=='all'&&mode!=='selected'&&row.since_at===null)throw new Error('UP 存储字段损坏：since_at');
  if(row.anchor_bvid!==null && (typeof row.anchor_bvid!=='string'||!/^BV[0-9A-Za-z]+$/.test(row.anchor_bvid)))throw new Error('UP 存储字段损坏：anchor_bvid');
  if(mode==='from_video'&&row.anchor_bvid===null)throw new Error('UP 存储字段损坏：anchor_bvid');
  if(row.last_error!==null&&typeof row.last_error!=='string')throw new Error('UP 存储字段损坏：last_error');
  if(row.last_scan_at!==null)validInteger(row.last_scan_at,'last_scan_at');
  return { id: row.id, uid: validInteger(row.uid,'uid',1), routingKey: row.routing_key, name: row.name, avatar: row.avatar,
    userId: row.user_id, enabled: boolean(row.enabled,'enabled'), removed: boolean(row.removed,'removed'), mode,
    since: row.since_at === null ? null : validInteger(row.since_at,'since_at'), anchorBvid: row.anchor_bvid,
    revision: validInteger(row.revision,'revision',1), nextPage: validInteger(row.next_page,'next_page',1),
    historyComplete: boolean(row.history_complete,'history_complete'), watermark: validInteger(row.watermark,'watermark'),
    pendingWatermark: validInteger(row.pending_watermark,'pending_watermark'), nextScanAt: validInteger(row.next_scan_at,'next_scan_at'),
    lastScanAt: row.last_scan_at, lastError: row.last_error, discoveredCount: validInteger(row.discovered_count,'discovered_count'),
    selectedCount: validInteger(row.selected_count,'selected_count'), excludedCount: validInteger(row.excluded_count,'excluded_count'),
    archivedCount: validInteger(row.archived_count,'archived_count') };
}
export function decodeStoredUpSubmission(json: string, context: string): UpSubmission {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error(`UP 投稿记录 JSON 损坏：${context}`); }
  if (!isRecord(value) || typeof value.bvid !== 'string' || !/^BV[0-9A-Za-z]+$/.test(value.bvid)
    || typeof value.title !== 'string' || typeof value.cover !== 'string' || typeof value.ownerName !== 'string'
    || typeof value.publishedAt !== 'number' || typeof value.ownerUid !== 'number' || typeof value.joint !== 'boolean'
    || (value.duration !== null && typeof value.duration !== 'number')) throw new Error(`UP 投稿记录字段损坏：${context}`);
  validInteger(value.publishedAt,'publishedAt'); validInteger(value.ownerUid,'ownerUid',1);
  if (value.duration !== null) validInteger(value.duration,'duration');
  return { bvid: value.bvid, title: value.title, cover: value.cover, ownerUid: value.ownerUid, ownerName: value.ownerName,
    publishedAt: value.publishedAt, duration: value.duration, joint: value.joint };
}
export const legacyArchiveSourceId = (userId: string, mediaId: number) => `legacy:${encodeURIComponent(userId)}:${mediaId}`;

const projection = `SELECT s.*,
 (SELECT COUNT(*) FROM up_catalog c WHERE c.source_id=s.id) discovered_count,
 (SELECT COUNT(*) FROM archive_video_decisions d WHERE d.source_id=s.id AND d.decision='include') selected_count,
 (SELECT COUNT(*) FROM up_catalog c WHERE c.source_id=s.id AND (EXISTS(SELECT 1 FROM archive_global_exclusions g WHERE g.bvid=c.bvid)
    OR EXISTS(SELECT 1 FROM archive_video_decisions d WHERE d.source_id=s.id AND d.bvid=c.bvid AND d.decision='exclude'))) excluded_count,
 (SELECT COUNT(*) FROM favorite_relations r WHERE r.media_id=s.routing_key AND r.source_kind='up'
    AND r.backup_status IN ('uploaded','verified','partial_verified')) archived_count
 FROM up_subscriptions s`;

/** Negative routing keys belong only to the legacy task adapter. Public identity is always source ID + UID. */
export class SqliteUpSubscriptionRepository {
  constructor(private readonly connection: () => Database.Database) {}
  snapshot():UpSubscriptionSnapshot|undefined {
    const sources=this.list(true).map(subscription=> {
      const stamp=this.connection().prepare<unknown[],{created_at:number;updated_at:number}>('SELECT created_at,updated_at FROM up_subscriptions WHERE id=?').get(subscription.id);
      if(!stamp)throw new Error('UP 订阅快照身份缺失');
      const rows=this.connection().prepare<unknown[],{payload_json:string}>('SELECT payload_json FROM up_catalog WHERE source_id=? ORDER BY published_at DESC,bvid DESC').all(subscription.id);
      return {subscription,createdAt:validInteger(stamp.created_at,'created_at'),updatedAt:validInteger(stamp.updated_at,'updated_at'),items:rows.map(row=>decodeStoredUpSubmission(row.payload_json,subscription.id))};
    });
    const decisions=this.connection().prepare<[],{source_id:string;bvid:string;decision:string;updated_at:number}>('SELECT source_id,bvid,decision,updated_at FROM archive_video_decisions ORDER BY source_id,bvid').all().map(row=> {
      if(row.decision!=='include'&&row.decision!=='exclude')throw new Error('UP 排除快照损坏');
      return {sourceId:row.source_id,bvid:row.bvid,decision:row.decision,updatedAt:validInteger(row.updated_at,'decision.updated_at')} satisfies UpSubscriptionSnapshot['decisions'][number];
    });
    const globalExclusions=this.connection().prepare<[],{bvid:string;created_at:number}>('SELECT bvid,created_at FROM archive_global_exclusions ORDER BY bvid').all().map(row=>({bvid:row.bvid,createdAt:validInteger(row.created_at,'global.created_at')}));
    return sources.length||decisions.length||globalExclusions.length?{sources,decisions,globalExclusions}:undefined;
  }
  restoreSnapshot(value:unknown) {
    let sourceValues:unknown[]=[],decisionValues:unknown[]=[],globalValues:unknown[]=[];
    if(value!==undefined) {
      if(!isRecord(value)||!Array.isArray(value.sources)||!Array.isArray(value.decisions)||!Array.isArray(value.globalExclusions))throw new Error('UP 订阅快照格式损坏');
      sourceValues=value.sources;decisionValues=value.decisions;globalValues=value.globalExclusions;
    }
    const number=(value:unknown,field:string)=>{if(typeof value!=='number')throw new Error(`UP 快照字段损坏：${field}`);return validInteger(value,field);};
    const text=(value:unknown,field:string)=>{if(typeof value!=='string'||!value)throw new Error(`UP 快照字段损坏：${field}`);return value;};
    const bv=(value:unknown)=>{const result=text(value,'bvid');if(!/^BV[0-9A-Za-z]+$/.test(result))throw new Error('UP 快照 BV 无效');return result;};
    const sources=sourceValues.map((entry:unknown)=> {
      if(!isRecord(entry)||!isRecord(entry.subscription)||!Array.isArray(entry.items))throw new Error('UP 快照来源格式损坏');
      const parsed=parseUpSubscription(entry.subscription),route=entry.subscription.routingKey;
      if(typeof route!=='number'||!Number.isSafeInteger(route)||route>-2)throw new Error('UP 快照来源映射损坏');
      const subscription:StoredUpSubscription={...parsed,routingKey:route};
      const items=entry.items.map(parseUpSubmission);
      if(new Set(items.map(item=>item.bvid)).size!==items.length)throw new Error('UP 快照投稿重复');
      return {subscription,items,createdAt:number(entry.createdAt,'createdAt'),updatedAt:number(entry.updatedAt,'updatedAt')};
    });
    if(new Set(sources.map(item=>item.subscription.id)).size!==sources.length||new Set(sources.map(item=>item.subscription.uid)).size!==sources.length||new Set(sources.map(item=>item.subscription.routingKey)).size!==sources.length)throw new Error('UP 快照来源身份重复');
    const decisions=decisionValues.map((entry:unknown):UpSubscriptionSnapshot['decisions'][number]=>{if(!isRecord(entry)||(entry.decision!=='include'&&entry.decision!=='exclude'))throw new Error('UP 快照选择记录损坏');return {sourceId:text(entry.sourceId,'sourceId'),bvid:bv(entry.bvid),decision:entry.decision,updatedAt:number(entry.updatedAt,'updatedAt')};});
    const globals=globalValues.map((entry:unknown)=>{if(!isRecord(entry))throw new Error('UP 快照全局排除损坏');return {bvid:bv(entry.bvid),createdAt:number(entry.createdAt,'createdAt')};});
    if(new Set(decisions.map(item=>`${item.sourceId}:${item.bvid}`)).size!==decisions.length||new Set(globals.map(item=>item.bvid)).size!==globals.length)throw new Error('UP 快照排除记录重复');
    this.connection().exec('DELETE FROM up_catalog;DELETE FROM up_subscriptions;DELETE FROM archive_video_decisions;DELETE FROM archive_global_exclusions;');
    const insert=this.connection().prepare(`INSERT INTO up_subscriptions(id,uid,routing_key,name,avatar,user_id,enabled,removed,mode,since_at,anchor_bvid,revision,next_page,history_complete,watermark,pending_watermark,next_scan_at,last_scan_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const {subscription:s,createdAt,updatedAt,items}of sources){insert.run(s.id,s.uid,s.routingKey,s.name,s.avatar,s.userId,s.enabled?1:0,s.removed?1:0,s.mode,s.since,s.anchorBvid,s.revision,s.nextPage,s.historyComplete?1:0,s.watermark,s.pendingWatermark,s.nextScanAt,s.lastScanAt,s.lastError,createdAt,updatedAt);this.recordPage(s.id,items);}
    for(const entry of decisions)this.setDecision(entry.sourceId,entry.bvid,entry.decision,entry.updatedAt);
    for(const entry of globals)this.setGlobalExclusion(entry.bvid,true,entry.createdAt);
  }
  list(includeRemoved = false) { return this.connection().prepare<unknown[], SubscriptionRow>(projection + (includeRemoved ? '' : ' WHERE s.removed=0') + ' ORDER BY s.created_at DESC,s.id').all().map(decode); }
  get(id: string) { const row = this.connection().prepare<unknown[], SubscriptionRow>(projection + ' WHERE s.id=?').get(id); return row ? decode(row) : null; }
  getByUid(uid: number) { const row = this.connection().prepare<unknown[], SubscriptionRow>(projection + ' WHERE s.uid=?').get(uid); return row ? decode(row) : null; }
  getByRoute(route: number) { const row = this.connection().prepare<unknown[], SubscriptionRow>(`SELECT s.*,0 discovered_count,0 selected_count,0 excluded_count,0 archived_count FROM up_subscriptions s WHERE s.routing_key=?`).get(route); return row ? decode(row) : null; }
  create(profile: UpIdentity, input: UpSubscriptionInput, since: number | null, now: number) {
    const existing = this.getByUid(profile.uid);
    if (existing && !existing.removed) return existing;
    if (existing) {
      this.connection().prepare('UPDATE up_subscriptions SET removed=0,enabled=1,user_id=?,mode=?,since_at=?,anchor_bvid=?,revision=revision+1,next_scan_at=0,next_page=1,history_complete=0,watermark=0,pending_watermark=0,last_error=NULL,updated_at=? WHERE id=?')
        .run(input.userId,input.mode,since,input.anchorBvid??null,now,existing.id);
      const restored = this.get(existing.id); if (!restored) throw new Error('UP 订阅恢复失败'); return restored;
    }
    const id = crypto.randomUUID();
    const row = this.connection().prepare<[],{routing_key:number}>('SELECT COALESCE(MIN(routing_key),-1)-1 AS routing_key FROM up_subscriptions').get();
    if (!row || !Number.isSafeInteger(row.routing_key) || row.routing_key > -2) throw new Error('UP 来源映射分配失败');
    this.connection().prepare(`INSERT INTO up_subscriptions(id,uid,routing_key,name,avatar,user_id,mode,since_at,anchor_bvid,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,profile.uid,row.routing_key,profile.name,profile.avatar,input.userId,input.mode,since,input.anchorBvid||null,now,now);
    const saved = this.get(id); if (!saved) throw new Error('UP 订阅保存失败'); return saved;
  }
  update(id: string, expectedRevision: number, input: { userId: string; enabled: boolean; mode: UpSubscription['mode']; since: number | null; anchorBvid: string | null }, now: number) {
    const current=this.get(id);
    if(!current || current.removed || current.revision!==expectedRevision)throw Object.assign(new Error('订阅已发生变化，请刷新后重试'),{statusCode:409});
    const changedRange=current.mode!==input.mode || current.since!==input.since || current.anchorBvid!==input.anchorBvid;
    const changed = this.connection().prepare(`UPDATE up_subscriptions SET user_id=?,enabled=?,mode=?,since_at=?,anchor_bvid=?,
      revision=revision+1,next_scan_at=0,next_page=?,history_complete=?,watermark=?,pending_watermark=?,last_error=NULL,updated_at=? WHERE id=? AND revision=? AND removed=0`)
      .run(input.userId,input.enabled?1:0,input.mode,input.since,input.anchorBvid,
        changedRange?1:current.nextPage,changedRange?0:current.historyComplete?1:0,
        changedRange?0:current.watermark,changedRange?0:current.pendingWatermark,now,id,expectedRevision).changes;
    if (!changed) throw Object.assign(new Error('订阅已发生变化，请刷新后重试'),{statusCode:409});
  }
  remove(id: string, revision: number, now: number) {
    const changed=this.connection().prepare('UPDATE up_subscriptions SET removed=1,enabled=0,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(now,id,revision).changes;
    if (!changed) throw Object.assign(new Error('订阅已发生变化，请刷新后重试'),{statusCode:409});
  }
  removeAndExclude(id: string, revision: number, now: number) {
    const source = this.get(id);
    if (!source || source.revision !== revision) throw Object.assign(new Error('订阅已发生变化，请刷新后重试'), {statusCode:409});
    this.connection().transaction(() => {
      this.remove(id, revision, now);
      // Keep known candidates and archived relations excluded on re-add, including
      // historical relations no longer present in the local submission catalog.
      this.connection().prepare(`
        INSERT INTO archive_video_decisions(source_id,bvid,decision,updated_at)
        SELECT ?, bvid, 'exclude', ? FROM (
          SELECT bvid FROM up_catalog WHERE source_id=?
          UNION SELECT bvid FROM favorite_relations WHERE user_id=? AND media_id=?
        ) WHERE 1
        ON CONFLICT(source_id,bvid) DO UPDATE SET decision='exclude',updated_at=excluded.updated_at
      `).run(id, now, id, source.userId, source.routingKey);
    })();
  }
  decision(sourceId: string, bvid: string): UpVideoDecision {
    const row=this.connection().prepare<unknown[],{decision:string}>('SELECT decision FROM archive_video_decisions WHERE source_id=? AND bvid=?').get(sourceId,bvid);
    if (!row) return 'inherit';
    if (row.decision !== 'include' && row.decision !== 'exclude') throw new Error('归档选择记录损坏');
    return row.decision;
  }
  setDecision(sourceId: string, bvid: string, decision: UpVideoDecision, now: number) {
    if (decision === 'inherit') this.connection().prepare('DELETE FROM archive_video_decisions WHERE source_id=? AND bvid=?').run(sourceId,bvid);
    else this.connection().prepare('INSERT INTO archive_video_decisions(source_id,bvid,decision,updated_at) VALUES(?,?,?,?) ON CONFLICT(source_id,bvid) DO UPDATE SET decision=excluded.decision,updated_at=excluded.updated_at').run(sourceId,bvid,decision,now);
  }
  globallyExcluded(bvid: string) { return Boolean(this.connection().prepare('SELECT 1 FROM archive_global_exclusions WHERE bvid=?').get(bvid)); }
  setGlobalExclusion(bvid: string, excluded: boolean, now: number) {
    if (excluded) this.connection().prepare('INSERT OR IGNORE INTO archive_global_exclusions(bvid,created_at) VALUES(?,?)').run(bvid,now);
    else this.connection().prepare('DELETE FROM archive_global_exclusions WHERE bvid=?').run(bvid);
  }
  isBlocked(userId: string, route: number, bvid: string) {
    if (this.globallyExcluded(bvid)) return true;
    const subscription = route <= -2 ? this.getByRoute(route) : null;
    const sourceId=subscription?.id || legacyArchiveSourceId(userId,route);
    const decision=this.decision(sourceId,bvid);
    if (!subscription) return route <= -2 || decision === 'exclude';
    if (subscription.userId !== userId) return true;
    const item=this.item(subscription.id,bvid);
    return !item || !shouldArchiveUpVideo(subscription,item,decision,false);
  }
  item(sourceId: string, bvid: string) {
    const row=this.connection().prepare<unknown[],{payload_json:string}>('SELECT payload_json FROM up_catalog WHERE source_id=? AND bvid=?').get(sourceId,bvid);
    return row ? decodeStoredUpSubmission(row.payload_json,`${sourceId}/${bvid}`) : null;
  }
  recordPage(sourceId: string, items: UpSubmission[]) {
    const save=this.connection().prepare('INSERT INTO up_catalog(source_id,bvid,published_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(source_id,bvid) DO UPDATE SET published_at=excluded.published_at,payload_json=excluded.payload_json');
    for (const item of items) save.run(sourceId,item.bvid,item.publishedAt,JSON.stringify(item));
  }
  saveScan(sourceId: string, revision: number, scan: { nextPage: number; historyComplete: boolean; watermark: number; pendingWatermark: number; nextScanAt: number; lastError: string | null }, now: number) {
    return this.connection().prepare(`UPDATE up_subscriptions SET next_page=?,history_complete=?,watermark=?,pending_watermark=?,
      next_scan_at=?,last_scan_at=?,last_error=?,updated_at=? WHERE id=? AND revision=? AND enabled=1 AND removed=0`)
      .run(scan.nextPage,scan.historyComplete?1:0,scan.watermark,scan.pendingWatermark,scan.nextScanAt,now,scan.lastError,now,sourceId,revision).changes === 1;
  }
  requestScan(sourceId: string) { this.connection().prepare('UPDATE up_subscriptions SET next_scan_at=0 WHERE id=? AND removed=0').run(sourceId); }
  bumpRevision(sourceId: string, revision: number, now: number) {
    const changed=this.connection().prepare('UPDATE up_subscriptions SET revision=revision+1,next_scan_at=0,updated_at=? WHERE id=? AND revision=?').run(now,sourceId,revision).changes;
    if (!changed) throw Object.assign(new Error('订阅已发生变化，请刷新后重试'),{statusCode:409});
  }
  catalog(source: StoredUpSubscription, options: { query?: string; filter?: string; cursor?: string; limit?: number }): UpCatalogPage {
    const limit=options.limit??30;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('投稿分页数量无效');
    let cursor: CatalogCursor | null=null;
    if (options.cursor) {
      if(options.cursor.length>512)throw Object.assign(new Error('投稿分页位置无效'),{statusCode:400});
      let value: unknown;
      try { value=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')); } catch { throw Object.assign(new Error('投稿分页位置无效'),{statusCode:400}); }
      if (!isRecord(value) || typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at<0 || typeof value.bvid!=='string' || !/^BV[0-9A-Za-z]+$/.test(value.bvid)) throw Object.assign(new Error('投稿分页位置无效'),{statusCode:400});
      cursor={at:value.at,bvid:value.bvid};
    }
    const decisionExpr=`COALESCE(d.decision,'inherit')`;
    const selectedExpr=`${source.enabled&&!source.removed?1:0}=1 AND g.bvid IS NULL AND ${decisionExpr}<>'exclude' AND (${decisionExpr}='include' OR (?<>'selected' AND (?='all' OR c.published_at>=?)))`;
    const extra=options.filter==='excluded' ? ` AND (g.bvid IS NOT NULL OR d.decision='exclude')`
      : options.filter==='selected' ? ` AND (${selectedExpr})` : '';
    const join=`FROM up_catalog c LEFT JOIN archive_video_decisions d ON d.source_id=c.source_id AND d.bvid=c.bvid
      LEFT JOIN archive_global_exclusions g ON g.bvid=c.bvid WHERE c.source_id=? AND (?='' OR json_extract(c.payload_json,'$.title') LIKE ? ESCAPE '\\' OR c.bvid LIKE ? ESCAPE '\\')`;
    const query=options.query||''; const pattern=`%${query.replace(/[\\%_]/g,char=>'\\'+char)}%`;
    const parameters: Array<string|number>=[source.id,query,pattern,pattern];
    if (options.filter==='selected') parameters.push(source.mode,source.mode,source.since??0);
    const countRow=this.connection().prepare<unknown[],{count:number}>('SELECT COUNT(*) count '+join+extra).get(...parameters);
    if (!countRow) throw new Error('投稿数量查询失败'); validInteger(countRow.count,'catalog.count');
    const pageParameters=[...parameters];
    const keyset=cursor?' AND (c.published_at<? OR (c.published_at=? AND c.bvid<?))':'';
    if(cursor) pageParameters.push(cursor.at,cursor.at,cursor.bvid);
    const rows=this.connection().prepare<unknown[],CatalogRow>(`SELECT c.bvid,c.published_at,c.payload_json,d.decision,
      (g.bvid IS NOT NULL) global_excluded,
      (SELECT r.backup_status FROM favorite_relations r WHERE r.media_id=${source.routingKey} AND r.bvid=c.bvid ORDER BY r.updated_at DESC LIMIT 1) archive_status,
      EXISTS(SELECT 1 FROM remote_files f WHERE f.bvid=c.bvid AND f.media_id=${source.routingKey} AND f.status='verified' AND f.kind='main') playable,
      EXISTS(SELECT 1 FROM remote_files f WHERE f.bvid=c.bvid AND f.media_id<>${source.routingKey} AND f.status='verified' AND f.kind='main') other_available
      ${join}${extra}${keyset} ORDER BY c.published_at DESC,c.bvid DESC LIMIT ?`).all(...pageParameters,limit+1);
    const items=rows.slice(0,limit).map((row): UpCatalogItem=> {
      const item=decodeStoredUpSubmission(row.payload_json,`${source.id}/${row.bvid}`);
      const decision=row.decision===null?'inherit':row.decision;
      if(decision!=='inherit'&&decision!=='include'&&decision!=='exclude') throw new Error('归档选择记录损坏');
      const globalExcluded=boolean(row.global_excluded,'global_excluded');
      return {...item,decision,globalExcluded,selected:shouldArchiveUpVideo(source,item,decision,globalExcluded),
        archiveStatus:row.archive_status,playable:boolean(row.playable,'playable'),otherArchiveAvailable:boolean(row.other_available,'other_available')};
    });
    const last=items[items.length-1];
    return {items,total:countRow.count,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.publishedAt,bvid:last.bvid})).toString('base64url'):null};
  }
}
export type UpSubscriptionRepository = Pick<SqliteUpSubscriptionRepository,
 'list'|'get'|'getByUid'|'getByRoute'|'create'|'update'|'remove'|'removeAndExclude'|'decision'|'setDecision'|'globallyExcluded'|'setGlobalExclusion'|
 'isBlocked'|'item'|'recordPage'|'saveScan'|'requestScan'|'bumpRevision'|'catalog'>;
