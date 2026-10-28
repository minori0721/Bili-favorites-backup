export function archiveDeletionProgressText(operation: {
  status: string; completedCount?: number; fileCount?: number; retainedCount?: number;
  deletedCount?: number; missingCount?: number; lastError?: string|null;
}) {
  const labels: Record<string,string> = { preview:'等待确认', preparing:'正在停止账号任务', config_removing:'正在移除账号配置', pending:'等待清理', running:'正在清理', retry_wait:'等待自动重试', failed:'清理失败', completed:'清理完成', stopped:'已停止剩余清理，剩余文件保留', expired:'预览已过期', superseded:'来源已重新加入，旧任务结束' };
  const outcome = operation.deletedCount === undefined || operation.missingCount === undefined
    ? '' : ` · 已删除 ${operation.deletedCount} 个文件` + (operation.missingCount ? ` · 原本不存在 ${operation.missingCount} 个` : '');
  return (labels[operation.status] || operation.status) + ' · 已处理 ' + (operation.completedCount ?? 0) + '/' + (operation.fileCount ?? 0) + outcome +
    (operation.retainedCount ? ' · 共享保留 ' + operation.retainedCount + ' 个文件' : '') +
    (operation.lastError ? ' · ' + operation.lastError : '');
}
