import { parseQueueStatus, type QueueStatus } from '../../../../shared/api/queue-status.js';
export function createQueueStatusView(dependencies:{root:Document;formatDateTime(value:string|number):string;formatBytes(value:number):string}) {
  const {root:document,formatDateTime,formatBytes}=dependencies;
    function renderSchedulerStatus(parent: HTMLElement, scheduler: QueueStatus['scheduler']) {
      let box = document.getElementById('schedulerStatusBox');
      if (!box) {
        box = document.createElement('details');
        box.id = 'schedulerStatusBox';
        (parent.parentElement || parent).insertBefore(box, parent);
      }
      const status = scheduler;
      box.className = 'scheduler-status ' + (status.status || 'idle');
      const queued = Array.isArray(status.queuedActions) && status.queuedActions.length ? status.queuedActions.join('、') : '无';
      const nextRun = status.nextRunAt ? formatDateTime(status.nextRunAt) : '未知';
      const started = status.startedAt ? formatDateTime(status.startedAt) : '未运行';
      const progress = status.total ? String(status.checked || 0) + '/' + String(status.total) : (status.biliTotal ? String(status.indexed || 0) + '/' + String(status.biliTotal) : '无');
      const recovery = status.recovery;
      const statusLabels: Record<string,string> = { idle:'空闲', running:'运行中', queued:'排队中', paused:'已暂停', error:'异常' };
      const statusLabel = statusLabels[status.status] || status.status || '空闲';
      const hasPendingBackgroundWork = Number(recovery.pendingUploads || 0) > 0 || Number(recovery.pendingDownloads || 0) > 0 || Number(recovery.pendingVerifications || 0) > 0;
      const titleText = status.status === 'idle' && hasPendingBackgroundWork
        ? '同步空闲，后台队列待处理'
        : (status.title || '同步调度空闲');
      const recoveryText = '下载 ' + Number(recovery.pendingDownloads || 0) +
        ' / 上传 ' + Number(recovery.pendingUploads || 0) +
        ' / 确认 ' + Number(recovery.pendingVerifications || 0) +
        ' / 充电待检查 ' + Number(recovery.chargingRestricted || 0) +
        '；租约中 ' + Number(recovery.leasedJobs || 0) +
        '，到期重试 ' + Number(recovery.retryJobs || 0);
      box.innerHTML = '';
      const summary = document.createElement('summary');
      summary.className = 'scheduler-status-main';
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'scheduler-status-title';
      title.textContent = titleText;
      const detail = document.createElement('div');
      detail.className = 'scheduler-status-detail';
      detail.textContent = status.detail || '当前没有正在运行的同步、扫描或对账任务。';
      left.appendChild(title);
      left.appendChild(detail);
      const right = document.createElement('div');
      right.className = 'scheduler-status-detail';
      right.textContent = status.status === 'idle' ? '下次自动同步：' + nextRun : '排队：' + queued;
      summary.appendChild(left);
      summary.appendChild(right);
      box.appendChild(summary);
      const grid = document.createElement('div');
      grid.className = 'scheduler-status-grid';
      const rows = [
        ['任务状态', statusLabel],
        ...(status.maintenance ? [['维护锁', (status.maintenance.kind === 'archive_delete' ? '归档清理：' : '归档路径迁移：') + (status.maintenance.status || '进行中')]] : []),
        ['账号', status.userName || '无'],
        ['收藏夹', status.folderTitle || '无'],
        ['页码', status.page ? String(status.page) : '无'],
        ['进度', progress],
        ['待恢复任务', recoveryText],
        ['已排队操作', queued],
        ['开始时间', started],
        ['下次自动同步', nextRun],
        ['最近错误', status.lastError || '无']
      ];
      rows.forEach(([label, value]) => {
        const item = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = label + '：';
        item.appendChild(name);
        item.appendChild(document.createTextNode(String(value || '无')));
        grid.appendChild(item);
      });
      box.appendChild(grid);
    }

    function renderLocalCacheStatus(parent: HTMLElement, localCache: QueueStatus['localCache'], recovery: QueueStatus['downloadRecovery'], chargingAccess: QueueStatus['chargingAccess']) {
      const host = parent.parentElement || parent;
      let el = host.querySelector<HTMLElement>('[data-local-cache-status="1"]');
      const hasRecovery = recovery && (
        Number(recovery.resumableSessions || 0) > 0 ||
        Number(recovery.legacyDirectories || 0) > 0 ||
        Number(recovery.cleanupEligibleBytes || 0) > 0
      ) || Number(chargingAccess?.pending || 0) > 0;
      if ((!localCache || !Number(localCache.limitBytes || 0)) && !hasRecovery) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'local-cache-status';
        el.dataset.localCacheStatus = '1';
        host.insertBefore(el, parent);
      }
      const used = formatBytes(Number(localCache?.usedBytes || 0));
      const limitBytes = Number(localCache?.limitBytes || 0);
      const limit = limitBytes > 0 ? formatBytes(limitBytes) : '未设置上限';
      const resumeText = recovery
        ? ' 可续传 ' + Number(recovery.resumableSessions || 0) + ' 项，已保留 ' + formatBytes(Number(recovery.retainedBytes || 0)) +
          '；旧缓存 ' + Number(recovery.legacyDirectories || 0) + ' 项，待清理残片 ' + formatBytes(Number(recovery.cleanupEligibleBytes || 0)) + '。'
        : '';
      const chargingText = Number(chargingAccess?.pending || 0) > 0
        ? ' 充电待检查 ' + Number(chargingAccess?.pending || 0) + ' 项' +
          (chargingAccess?.nextCheckAt ? '，下次检查 ' + formatDateTime(chargingAccess.nextCheckAt) : '') + '。'
        : '';
      el.classList.toggle('paused', !!localCache?.paused);
      el.textContent = localCache?.paused
        ? '下载暂停：本地缓存 ' + used + ' / ' + limit + '，已预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) + ' 安全空间；上传队列不受影响。' + resumeText + chargingText
        : '本地缓存：' + used + ' / ' + limit + (limitBytes > 0 ? '，安全预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) : '') + '。' + resumeText + chargingText;
    }

    function renderUploadHealthStatus(parent: HTMLElement, uploadHealth: QueueStatus['uploadHealth']) {
      const host = parent.parentElement || parent;
      let el = host.querySelector<HTMLElement>('[data-upload-health-status="1"]');
      if (!uploadHealth || uploadHealth.state === 'closed') {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'upload-health-status';
        el.dataset.uploadHealthStatus = '1';
        host.insertBefore(el, parent);
      }
      const retryText = uploadHealth.retryAt ? formatDateTime(uploadHealth.retryAt) : '等待调度';
      const modeText = uploadHealth.state === 'half_open' ? '正在进行单任务探测' : '将在 ' + retryText + ' 探测恢复';
      el.textContent = '上传后端异常，下载已暂停：' + (uploadHealth.reason || 'AList / OpenList 上传暂不可用') + '；' + modeText + '。认证异常不会自动清理待补传本地文件。';
    }

    function renderDownloadApiHealthStatus(parent: HTMLElement, downloadApiHealth: QueueStatus['downloadApiHealth']) {
      const host = parent.parentElement || parent;
      let el = host.querySelector<HTMLElement>('[data-download-api-health-status="1"]');
      if (!downloadApiHealth || downloadApiHealth.state === 'healthy') {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'download-api-health-status';
        el.dataset.downloadApiHealthStatus = '1';
        host.insertBefore(el, parent);
      }
      const retryText = downloadApiHealth.retryAt ? formatDateTime(downloadApiHealth.retryAt) : '等待调度';
      const probeText = downloadApiHealth.state === 'half_open'
        ? '正在用' + (downloadApiHealth.activeMode === 'app' ? 'APP' : '网页') + '接口进行单任务探测'
        : '将在 ' + retryText + ' 进行单任务探测';
      el.textContent = 'B站触发风控，下载已暂停；' + probeText + (downloadApiHealth.probeBvid ? '（' + downloadApiHealth.probeBvid + '）' : '') + '。已取得地址的下载不受影响。';
    }

return {render(parent:HTMLElement,snapshot:unknown){const status=parseQueueStatus(snapshot);renderSchedulerStatus(parent,status.scheduler);renderLocalCacheStatus(parent,status.localCache,status.downloadRecovery,status.chargingAccess);renderDownloadApiHealthStatus(parent,status.downloadApiHealth);renderUploadHealthStatus(parent,status.uploadHealth);}};
}
