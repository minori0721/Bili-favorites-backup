import { isRecord } from './value.js';

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}
function text(value: unknown, message: string, optional = true): string | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string') throw new Error(message);
  return value;
}
function count(value: unknown, message: string, optional = true): number | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(message);
  return value;
}
function integer(value: unknown, message: string, optional = true, minimum = 0): number | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(message);
  return value;
}
function flag(value: unknown, message: string, optional = true): boolean | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}
function optionalString(value: unknown, message: string) {
  return text(value, message, true);
}

function parsePlaybackPart(value: unknown) {
  const data = record(value, '播放分P格式错误');
  return {
    fileId: integer(data.fileId, '播放文件标识格式错误', false, 1)!,
    pageIndex: integer(data.pageIndex, '播放分P序号格式错误', false, 1)!,
    cid: integer(data.cid, '播放 CID 格式错误'),
    label: text(data.label, '播放分P名称格式错误', false)!,
    size: count(data.size, '播放文件大小格式错误'),
    requestedQuality: optionalString(data.requestedQuality, '播放请求画质格式错误'),
    requestedCodec: optionalString(data.requestedCodec, '播放请求编码格式错误'),
    bilibiliQuality: optionalString(data.bilibiliQuality, '播放来源画质格式错误'),
    actualQuality: optionalString(data.actualQuality, '播放实际画质格式错误'),
    actualWidth: count(data.actualWidth, '播放宽度格式错误'),
    actualHeight: count(data.actualHeight, '播放高度格式错误'),
    actualFps: count(data.actualFps, '播放帧率格式错误'),
    mediaMetadataSource: optionalString(data.mediaMetadataSource, '播放元数据来源格式错误'),
    quality: optionalString(data.quality, '播放画质格式错误'),
    codec: optionalString(data.codec, '播放编码格式错误'),
    fingerprint: text(data.fingerprint, '播放文件指纹格式错误', false)!,
    streamUrl: text(data.streamUrl, '播放流地址格式错误', false)!,
  };
}

function parsePlaybackItem(value: unknown) {
  const data = record(value, '播放队列项目格式错误');
  if (!Array.isArray(data.parts) || !data.parts.every(isRecord)) throw new Error('播放分P列表格式错误');
  const source = record(data.source, '播放来源格式错误');
  return {
    bvid: text(data.bvid, '播放项目缺少标识', false)!,
    queuePosition: integer(data.queuePosition, '播放队列位置格式错误', false)!,
    title: optionalString(data.title, '播放标题格式错误'),
    upperName: optionalString(data.upperName, '播放 UP 格式错误'),
    cover: optionalString(data.cover, '播放封面格式错误'),
    coverLocalPath: optionalString(data.coverLocalPath, '播放本地封面格式错误'),
    favoriteOrder: integer(data.favoriteOrder, '播放收藏顺序格式错误'),
    partial: flag(data.partial, '播放部分状态格式错误') ?? false,
    activeInFavorite: flag(data.activeInFavorite, '播放关系格式错误') ?? false,
    source: {
      userId: text(source.userId, '播放来源账号格式错误', false)!,
      mediaId: integer(source.mediaId, '播放来源 mediaId 格式错误', false, -1)!,
      folderTitle: optionalString(source.folderTitle, '播放来源目录格式错误'),
    },
    parts: data.parts.map(parsePlaybackPart),
  };
}

function parsePlaybackPageBase(value: unknown, message: string) {
  const data = record(value, message);
  if (!Array.isArray(data.items) || !data.items.every(isRecord)) throw new Error(message);
  return { data, items: data.items.map(parsePlaybackItem) };
}

function playbackMode(value: unknown): 'favorite' | 'single' | 'library' {
  if (value !== 'favorite' && value !== 'single' && value !== 'library') throw new Error('播放队列模式格式错误');
  return value;
}

export function parsePlaybackQueuePage(value: unknown) {
  const { data, items } = parsePlaybackPageBase(value, '播放队列响应格式错误');
  const mode = playbackMode(data.mode);
  return {
    mode,
    page: integer(data.page, '播放队列页码格式错误', false, 1)!,
    pageSize: integer(data.pageSize, '播放队列页大小格式错误', false, 1)!,
    total: count(data.total, '播放队列总数格式错误', false)!,
    focusIndex: integer(data.focusIndex, '播放队列焦点格式错误', false, -1)!,
    hasPrevious: flag(data.hasPrevious, '播放队列前页状态格式错误'),
    hasMore: flag(data.hasMore, '播放队列后页状态格式错误', false)!,
    previousCursor: data.previousCursor == null ? null : text(data.previousCursor, '播放队列游标格式错误', false)!,
    nextCursor: data.nextCursor == null ? null : text(data.nextCursor, '播放队列游标格式错误', false)!,
    items,
  };
}

export function parsePlaybackSearchPage(value: unknown) {
  const { data, items } = parsePlaybackPageBase(value, '播放搜索响应格式错误');
  return {
    query: text(data.query, '播放搜索词格式错误', false)!,
    page: integer(data.page, '播放搜索页码格式错误', false, 1)!,
    pageSize: integer(data.pageSize, '播放搜索页大小格式错误', false, 1)!,
    total: count(data.total, '播放搜索总数格式错误', false)!,
    hasMore: flag(data.hasMore, '播放搜索后页状态格式错误', false)!,
    items,
  };
}

export function parsePlaybackDelivery(value: unknown) {
  const data = record(value, '播放传输状态格式错误');
  const status = data.status;
  if (status !== 'pending' && status !== 'direct' && status !== 'proxy' && status !== 'failed' && status !== 'unknown') throw new Error('播放传输状态格式错误');
  return {status};
}

export function parsePlaybackMetadata(value: unknown) {
  const data = record(value, '播放元数据格式错误');
  const metadata = data.mediaMetadata == null ? undefined : record(data.mediaMetadata, '播放元数据格式错误');
  return { actualQuality: text(data.actualQuality, '播放画质格式错误'), mediaMetadata: metadata ? {
    width: count(metadata.width, '播放宽度格式错误'), height: count(metadata.height, '播放高度格式错误'),
    source: text(metadata.source, '播放元数据来源格式错误'),
  } : undefined };
}
