import { isRecord } from './value.js';

function record(value: unknown) {
  if (!isRecord(value)) throw new Error('视频列表响应格式错误');
  return value;
}
function text(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error('视频文字字段格式错误');
  return value;
}
function flag(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') throw new Error('视频状态字段格式错误');
  return value;
}
function count(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('视频计数字段格式错误');
  return value;
}
export function parseVideoDetailItem(value: unknown) {
  const item=record(value); const bvid=text(item.bvid);
  if (!bvid) throw new Error('视频缺少标识');
  const source=item.sourceAvailability == null ? undefined : record(item.sourceAvailability);
  const access=item.accessRestriction == null ? undefined : record(item.accessRestriction);
  const playback=item.playback == null ? undefined : record(item.playback);
  return {bvid,mediaId:count(item.mediaId),title:text(item.title),folderTitle:text(item.folderTitle),upperName:text(item.upperName),ownerName:text(item.ownerName),
    cover:text(item.cover),coverLocalPath:text(item.coverLocalPath),backupStatus:text(item.backupStatus),processed:flag(item.processed),unavailable:flag(item.unavailable),
    archivedSourceUnavailable:flag(item.archivedSourceUnavailable),failed:flag(item.failed),activeInFavorite:flag(item.activeInFavorite),
    sourceAvailability:source ? {state:text(source.state),reason:text(source.reason)} : undefined,
    accessRestriction:access ? {nextCheckAt:text(access.nextCheckAt)} : undefined,
    playback:playback ? {available:flag(playback.available),partCount:count(playback.partCount),reason:text(playback.reason)} : undefined};
}
export type VideoDetailItem = ReturnType<typeof parseVideoDetailItem>;
function parseSummary(value: unknown) {
  const data=record(value);
  return {total:count(data.total)??0,uploaded:count(data.uploaded)??0,pending:count(data.pending)??0,pendingUnavailable:count(data.pendingUnavailable)??0,
    uploadedUnavailable:count(data.uploadedUnavailable)??0,activeTotal:count(data.activeTotal)??0,historicalTotal:count(data.historicalTotal)??0};
}
export function parseVideoDetailPage(value: unknown) {
  const data=record(value);
  if (!Array.isArray(data.items) || typeof data.hasMore !== 'boolean') throw new Error('视频分页格式错误');
  const index=data.indexSummary == null ? null : record(data.indexSummary);
  return {items:data.items.map(parseVideoDetailItem),page:count(data.page),hasMore:data.hasMore,
    summary:data.summary == null ? null : parseSummary(data.summary),
    indexSummary:index ? {...parseSummary(index),indexed:count(index.indexed)??0,biliTotal:count(index.biliTotal)??0,scanComplete:flag(index.scanComplete)??false,unreturnedCount:count(index.unreturnedCount)??0} : null,
    source:text(data.source),lastSyncedAt:text(data.lastSyncedAt),coverage:text(data.coverage)};
}
export type VideoDetailPage = ReturnType<typeof parseVideoDetailPage>;
export function parseUnavailablePage(value: unknown) {
  const data=record(value);
  if (!Array.isArray(data.items) || typeof data.hasMore !== 'boolean') throw new Error('视频分页格式错误');
  const nextCursor=text(data.nextCursor) || null;
  if (data.hasMore && !nextCursor) throw new Error('视频分页缺少后续游标');
  return {items:data.items.map(parseVideoDetailItem),hasMore:data.hasMore,nextCursor};
}
