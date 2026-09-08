export function archiveDeletionProgressText(operation: {
  status: string; completedCount?: unknown; fileCount?: unknown; retainedCount?: unknown; lastError?: unknown;
}) {
  const labels: Record<string,string> = { preview:'等待确认', preparing:'正在停止账号任务', config_removing:'正在移除账号配置', pending:'等待清理', running:'正在清理', retry_wait:'等待自动重试', failed:'清理失败', completed:'清理完成', expired:'预览已过期', superseded:'来源已重新加入，旧任务结束' };
  return (labels[operation.status] || operation.status) + ' · ' + Number(operation.completedCount || 0) + '/' + Number(operation.fileCount || 0) +
    (operation.retainedCount ? ' · 共享保留 ' + Number(operation.retainedCount) : '') +
    (operation.lastError ? ' · ' + operation.lastError : '');
}
