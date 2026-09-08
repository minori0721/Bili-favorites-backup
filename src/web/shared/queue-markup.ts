export function getQueueLoadingMarkup() {
  return `<div class="queue-board">${[
    ['downloadPending', '待下载'], ['downloadRunning', '下载中'],
    ['uploadPending', '待上传'], ['uploadRunning', '上传中'],
  ].map(([id, title]) => `<div class="queue-col" data-queue-column="${id}"><div class="queue-col-title"><span>${title}</span><span class="queue-col-count">—</span></div><div class="queue-list"><div class="queue-empty" data-queue-loading="1">正在加载…</div></div></div>`).join('')}</div>`;
}
