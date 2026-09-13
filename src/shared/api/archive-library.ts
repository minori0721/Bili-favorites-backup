import { isRecord, ResponseFormatError, requireUnique } from './value.js';
export { parsePlaybackQueuePage, parsePlaybackSearchPage } from './playback-queue.js';

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ResponseFormatError(message);
  return value;
}

function text(value: unknown, message: string, optional = true): string | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string') throw new ResponseFormatError(message);
  return value;
}

function count(value: unknown, message: string, optional = true): number | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ResponseFormatError(message);
  return value;
}

function integer(value: unknown, message: string, optional = true): number | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1) throw new ResponseFormatError(message);
  return value;
}

function flag(value: unknown, message: string, optional = true): boolean | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== 'boolean') throw new ResponseFormatError(message);
  return value;
}

function optionalString(value: unknown, message: string) {
  return text(value, message, true);
}

function optionalUid(value: unknown): number | undefined {
  if (value == null) return undefined;
  // The server uses numeric UIDs, including 0 for historical accounts without a UID.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ResponseFormatError('归档账号 UID 格式错误');
  }
  return value;
}

function parseSummary(value: unknown) {
  const data = record(value, '归档导航汇总格式错误');
  return {
    total: count(data.total, '归档汇总计数字段格式错误') ?? 0,
    playable: count(data.playable, '归档汇总计数字段格式错误') ?? 0,
    pending: count(data.pending, '归档汇总计数字段格式错误') ?? 0,
    issue: count(data.issue, '归档汇总计数字段格式错误') ?? 0,
    deleted: count(data.deleted, '归档汇总计数字段格式错误') ?? 0,
    lastSyncedAt: optionalString(data.lastSyncedAt, '归档汇总时间字段格式错误'),
    coverLocalPath: optionalString(data.coverLocalPath, '归档汇总封面字段格式错误'),
    cover: optionalString(data.cover, '归档汇总封面字段格式错误'),
  };
}

function parseNavigationFolder(value: unknown) {
  const data = record(value, '归档目录格式错误');
  return {
    mediaId: integer(data.mediaId, '归档目录 mediaId 格式错误', false)!,
    title: text(data.title, '归档目录标题格式错误', false)!,
    selected: flag(data.selected, '归档目录选择状态格式错误') ?? false,
    inactive: flag(data.inactive, '归档目录停用状态格式错误') ?? false,
    total: count(data.total, '归档目录汇总格式错误') ?? 0,
    playable: count(data.playable, '归档目录汇总格式错误') ?? 0,
    pending: count(data.pending, '归档目录汇总格式错误') ?? 0,
    issue: count(data.issue, '归档目录汇总格式错误') ?? 0,
    deleted: count(data.deleted, '归档目录汇总格式错误') ?? 0,
    lastSyncedAt: optionalString(data.lastSyncedAt, '归档目录时间字段格式错误'),
    coverLocalPath: optionalString(data.coverLocalPath, '归档目录封面字段格式错误'),
    cover: optionalString(data.cover, '归档目录封面字段格式错误'),
    sourceKind: optionalString(data.sourceKind, '归档目录来源字段格式错误'),
  };
}

function parseDeletion(value: unknown) {
  if (value == null) return undefined;
  const data = record(value, '归档清理状态格式错误');
  return {
    id: text(data.id, '归档清理标识格式错误', false)!,
    status: text(data.status, '归档清理状态格式错误', false)!,
    fileCount: count(data.fileCount, '归档清理计数字段格式错误') ?? 0,
    totalBytes: count(data.totalBytes, '归档清理大小字段格式错误') ?? 0,
    completedCount: count(data.completedCount, '归档清理计数字段格式错误') ?? 0,
    retainedCount: count(data.retainedCount, '归档清理计数字段格式错误') ?? 0,
    conflictCount: count(data.conflictCount, '归档清理计数字段格式错误') ?? 0,
    failedCount: count(data.failedCount, '归档清理计数字段格式错误') ?? 0,
    lastError: optionalString(data.lastError, '归档清理错误字段格式错误'),
    updatedAt: optionalString(data.updatedAt, '归档清理时间字段格式错误'),
    completedAt: optionalString(data.completedAt, '归档清理时间字段格式错误'),
  };
}

function parseNavigationAccount(value: unknown) {
  const data = record(value, '归档账号目录格式错误');
  if (!Array.isArray(data.folders) || !data.folders.every((item) => isRecord(item))) {
    throw new ResponseFormatError('归档账号目录格式错误');
  }
  if (!Array.isArray(data.inactiveFolders) || !data.inactiveFolders.every((item) => isRecord(item))) {
    throw new ResponseFormatError('归档停用目录格式错误');
  }
  return {
    id: text(data.id, '归档账号标识格式错误', false)!,
    uid: optionalUid(data.uid),
    name: optionalString(data.name, '归档账号名称格式错误'),
    avatar: optionalString(data.avatar, '归档账号头像格式错误'),
    enabled: flag(data.enabled, '归档账号启用状态格式错误'),
    removed: flag(data.removed, '归档账号移除状态格式错误') ?? false,
    removedAt: optionalString(data.removedAt, '归档账号时间字段格式错误'),
    deletion: parseDeletion(data.deletion),
    summary: parseSummary(data.summary ?? {}),
    folders: data.folders.map(parseNavigationFolder),
    inactiveFolders: data.inactiveFolders.map(parseNavigationFolder),
  };
}

export function parseArchiveNavigation(value: unknown) {
  const data = record(value, '归档导航响应格式错误');
  if (!Array.isArray(data.accounts)) throw new ResponseFormatError('归档导航账号列表格式错误');
  return {
    summary: parseSummary(data.summary ?? {}),
    accounts: data.accounts.map(parseNavigationAccount),
  };
}

function parseSourceAvailability(value: unknown) {
  if (value == null) return undefined;
  const data = record(value, '视频来源状态格式错误');
  return {
    state: optionalString(data.state, '视频来源状态格式错误'),
    reason: optionalString(data.reason, '视频来源原因格式错误'),
  };
}

function parsePlaybackAvailability(value: unknown) {
  const data = record(value, '播放状态格式错误');
  return {
    available: flag(data.available, '播放可用状态格式错误', false)!,
    partCount: count(data.partCount, '播放分P数量格式错误') ?? 0,
    partial: flag(data.partial, '播放部分状态格式错误') ?? false,
    actualQuality: optionalString(data.actualQuality, '播放画质格式错误'),
    bilibiliQuality: optionalString(data.bilibiliQuality, 'B站画质格式错误'),
  };
}

function parseMembership(value: unknown) {
  const data = record(value, '归档来源格式错误');
  return {
    userId: text(data.userId, '归档来源账号格式错误', false)!,
    userName: optionalString(data.userName, '归档来源账号名称格式错误'),
    mediaId: integer(data.mediaId, '归档来源 mediaId 格式错误', false)!,
    folderTitle: optionalString(data.folderTitle, '归档来源目录名称格式错误'),
    activeInFavorite: flag(data.activeInFavorite, '归档来源关系格式错误') ?? false,
    selectedFolder: flag(data.selectedFolder, '归档来源目录状态格式错误') ?? false,
    backupStatus: optionalString(data.backupStatus, '归档来源备份状态格式错误'),
    lastSeenAt: optionalString(data.lastSeenAt, '归档来源时间字段格式错误'),
    unavailable: flag(data.unavailable, '归档来源可用状态格式错误') ?? false,
    ownerRemoved: flag(data.ownerRemoved, '归档来源账号状态格式错误'),
    deletionId: optionalString(data.deletionId, '归档来源清理标识格式错误'),
    deletionStatus: optionalString(data.deletionStatus, '归档来源清理状态格式错误'),
    deletedAt: optionalString(data.deletedAt, '归档来源清理时间格式错误'),
    deletable: flag(data.deletable, '归档来源可删除状态格式错误') ?? false,
    deletionReason: optionalString(data.deletionReason, '归档来源清理原因格式错误'),
    fileCount: count(data.fileCount, '归档来源文件数格式错误') ?? 0,
    totalBytes: count(data.totalBytes, '归档来源大小格式错误') ?? 0,
    error: optionalString(data.error, '归档来源错误字段格式错误'),
  };
}

export function parseArchiveLibraryItem(value: unknown) {
  const data = record(value, '归档项目格式错误');
  if (!Array.isArray(data.memberships) || !data.memberships.every(isRecord)) {
    throw new ResponseFormatError('归档来源列表格式错误');
  }
  return {
    bvid: text(data.bvid, '归档项目缺少标识', false)!,
    title: optionalString(data.title, '归档项目标题格式错误'),
    upperName: optionalString(data.upperName, '归档项目 UP 格式错误'),
    cover: optionalString(data.cover, '归档项目封面格式错误'),
    coverLocalPath: optionalString(data.coverLocalPath, '归档项目本地封面格式错误'),
    backupStatus: optionalString(data.backupStatus, '归档项目备份状态格式错误'),
    statusGroup: optionalString(data.statusGroup, '归档项目状态分组格式错误'),
    unavailable: flag(data.unavailable, '归档项目可用状态格式错误') ?? false,
    sourceAvailability: parseSourceAvailability(data.sourceAvailability),
    activeInFavorite: flag(data.activeInFavorite, '归档项目关系格式错误') ?? false,
    lastSeenAt: optionalString(data.lastSeenAt, '归档项目时间字段格式错误'),
    membershipCount: count(data.membershipCount, '归档项目来源数格式错误') ?? data.memberships.length,
    memberships: data.memberships.map(parseMembership),
    playback: parsePlaybackAvailability(data.playback),
  };
}

export function parseArchiveLibraryPage(value: unknown) {
  const data = record(value, '归档项目分页格式错误');
  if (!Array.isArray(data.items) || !data.items.every(isRecord) || typeof data.hasMore !== 'boolean') {
    throw new ResponseFormatError('归档项目分页格式错误');
  }
  const nextCursor = data.nextCursor == null ? null : text(data.nextCursor, '归档项目游标格式错误', false)!;
  if (data.hasMore && !nextCursor) throw new ResponseFormatError('归档项目分页缺少后续游标');
  return {
    context: data.context == null ? undefined : record(data.context, '归档项目上下文格式错误'),
    items: requireUnique(data.items.map(parseArchiveLibraryItem), item => item.bvid, '归档分页包含重复视频'),
    summary: data.summary == null ? undefined : parseSummary(data.summary),
    hasMore: data.hasMore,
    nextCursor,
  };
}

export function parseArchiveLibraryDetail(value: unknown) {
  return parseArchiveLibraryItem(value);
}

export function parseArchiveDeletion(value: unknown) {
  const parsed = parseDeletion(value);
  if (!parsed) throw new ResponseFormatError('缺少归档清理操作');
  return parsed;
}

export function parseArchiveDeletionPreview(value: unknown) {
  const data = record(value, '归档清理预览格式错误');
  const previewId = text(data.previewId, '归档清理预览标识格式错误', false)!;
  if (!previewId) throw new ResponseFormatError('归档清理预览缺少标识');
  return { previewId, scope: text(data.scope, '归档清理范围格式错误'),
    fileCount: count(data.fileCount, '归档清理文件数格式错误', false)!,
    totalBytes: count(data.totalBytes, '归档清理大小格式错误', false)!,
    sharedCount: count(data.sharedCount, '归档清理共享数格式错误') ?? 0 };
}

export function parseLocalReleasePreview(value: unknown) {
  const data = record(value, '本地释放预览格式错误');
  if (!Array.isArray(data.candidates)) throw new ResponseFormatError('本地释放候选格式错误');
  return { fileCount: count(data.fileCount, '本地释放文件数格式错误', false)!,
    candidates: data.candidates.map(value => {
      const item = record(value, '本地释放候选格式错误');
      const releaseId = text(item.releaseId, '本地释放授权格式错误', false)!;
      if (!releaseId) throw new ResponseFormatError('本地释放缺少授权');
      return { releaseId, fileCount: count(item.fileCount, '本地释放文件数格式错误', false)!,
        totalBytes: count(item.totalBytes, '本地释放大小格式错误', false)!,
        requiresExplicitDeletion: flag(item.requiresExplicitDeletion, '本地释放确认格式错误', false)!,
        hasVerifiedArchive: flag(item.hasVerifiedArchive, '本地释放归档证明格式错误') ?? false };
    }) };
}
