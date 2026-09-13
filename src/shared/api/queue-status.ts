import { isRecord, ResponseFormatError } from './value.js';

function object(value: unknown) {
  if (!isRecord(value)) throw new ResponseFormatError('任务中心状态格式错误');
  return value;
}
function text(value: unknown) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new ResponseFormatError('任务中心状态说明格式错误');
  return value;
}
function count(value: unknown) {
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResponseFormatError('任务中心状态计数格式错误');
  return value;
}
function time(value: unknown): string | number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new ResponseFormatError('任务中心状态时间格式错误');
}
function flag(value: unknown) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new ResponseFormatError('任务中心状态标记格式错误');
  return value;
}
export function parseQueueStatus(value: unknown) {
  const data=object(value);
  const scheduler=object(data.scheduler);const recovery=object(data.recovery);
  if (typeof scheduler.status !== 'string' || !scheduler.status) throw new ResponseFormatError('任务中心缺少调度状态');
  const cache=data.localCache == null ? null : object(data.localCache);
  const downloads=data.downloadRecovery == null ? null : object(data.downloadRecovery);
  const charging=data.chargingAccess == null ? null : object(data.chargingAccess);
  const upload=data.uploadHealth == null ? null : object(data.uploadHealth);
  const api=data.downloadApiHealth == null ? null : object(data.downloadApiHealth);
  const maintenance=data.maintenance == null ? null : object(data.maintenance);
  const actions=scheduler.queuedActions ?? [];
  if (!Array.isArray(actions) || !actions.every((item):item is string=>typeof item==='string')) throw new ResponseFormatError('调度操作列表格式错误');
  return {
    scheduler:{status:text(scheduler.status),title:text(scheduler.title),detail:text(scheduler.detail),userName:text(scheduler.userName),folderTitle:text(scheduler.folderTitle),
      lastError:text(scheduler.lastError),nextRunAt:time(scheduler.nextRunAt),startedAt:time(scheduler.startedAt),page:count(scheduler.page),total:count(scheduler.total),checked:count(scheduler.checked),biliTotal:count(scheduler.biliTotal),indexed:count(scheduler.indexed),queuedActions:actions,
      recovery:{pendingUploads:count(recovery.pendingUploads),pendingDownloads:count(recovery.pendingDownloads),pendingVerifications:count(recovery.pendingVerifications),chargingRestricted:count(recovery.chargingRestricted),leasedJobs:count(recovery.leasedJobs),retryJobs:count(recovery.retryJobs)},
      maintenance:maintenance ? {kind:text(maintenance.kind),status:text(maintenance.status)} : null},
    localCache:cache ? {limitBytes:count(cache.limitBytes),usedBytes:count(cache.usedBytes),reserveBytes:count(cache.reserveBytes),paused:flag(cache.paused)} : null,
    downloadRecovery:downloads ? {resumableSessions:count(downloads.resumableSessions),legacyDirectories:count(downloads.legacyDirectories),cleanupEligibleBytes:count(downloads.cleanupEligibleBytes),retainedBytes:count(downloads.retainedBytes)} : null,
    chargingAccess:charging ? {pending:count(charging.pending),nextCheckAt:time(charging.nextCheckAt)} : null,
    uploadHealth:upload ? {state:text(upload.state),reason:text(upload.reason),retryAt:time(upload.retryAt)} : null,
    downloadApiHealth:api ? {state:text(api.state),activeMode:text(api.activeMode),probeBvid:text(api.probeBvid),retryAt:time(api.retryAt)} : null,
  };
}
export type QueueStatus = ReturnType<typeof parseQueueStatus>;
