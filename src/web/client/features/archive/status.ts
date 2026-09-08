export interface ArchiveStatusInput {
  memberships?: Array<{deletionStatus?: string}>;
  deletionStatus?: string;
  playback?: {available?: boolean; partial?: boolean};
  unavailable?: boolean;
  sourceAvailability?: {reason?: string; state?: string};
  backupStatus?: string;
  statusGroup?: string;
}

export function sourceAvailabilityReasonLabel(source: ArchiveStatusInput['sourceAvailability'], compact = false): string {
  const labels: Record<string, string> = {
    under_review:'B站稿件审核中',
    uploader_only:'仅UP主自己可见',
    submission_invisible:compact ? '稿件不可见' : 'B站稿件不可见，具体原因未公开',
    api_not_found:'B站未找到该视频',
  };
  return labels[source?.reason || ''] || '';
}

export function archiveStatusLabel(item: ArchiveStatusInput): string {
  const deletionStatuses = item.memberships?.map(membership => membership.deletionStatus).filter(Boolean) || [];
  if (item.deletionStatus) deletionStatuses.push(item.deletionStatus);
  if (deletionStatuses.includes('completed')) return '已手动删除';
  if (deletionStatuses.includes('failed')) return '清理失败';
  if (deletionStatuses.some(status => ['preparing','config_removing','pending','running','retry_wait'].includes(status || ''))) return '清理中';
  if (item.playback?.available) {
    if (item.unavailable || item.sourceAvailability?.reason === 'favorite_flag') return '已归档 · 收藏夹显示失效';
    if (item.playback.partial) return '部分可播放';
    return '可播放';
  }
  const sourceState = item.sourceAvailability?.state;
  if (sourceState === 'pending_confirmation') return 'B站状态待确认';
  if (sourceState === 'unknown') return sourceAvailabilityReasonLabel(item.sourceAvailability, true) || 'B站状态暂未确认';
  if (sourceState === 'confirmed_unavailable') return sourceAvailabilityReasonLabel(item.sourceAvailability, true) || 'B站源不可用';
  if (sourceState === 'dormant') return 'B站源长期不可用';
  const labels: Record<string,string> = {
    remote_visibility_timeout:'等待远端文件可见', remote_visibility_stalled:'远端文件长时间不可见',
    discovered:'待备份', queued:'已排队', downloading:'下载中', downloaded:'待上传', uploading:'上传中',
    uploaded:'远端确认中', upload_failed:'待补传', charging_restricted:'充电限制', missing:'远端缺失',
    lost:'已失效', failed:'失败', verified:'无兼容媒体', partial_verified:'无兼容媒体',
  };
  return labels[item.backupStatus || ''] || (item.statusGroup === 'pending' ? '待处理' : '异常');
}
