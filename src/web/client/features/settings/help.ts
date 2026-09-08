import { requireElement } from '../../shared/dom.js';

export function createSettingsHelp(dependencies:{root:ParentNode;priority():string[];apiMode():string;open(modal:HTMLElement,trigger:HTMLElement):void}) {
  const {root}=dependencies;
  const button=requireElement(root,'#settingsHelpBtn',HTMLButtonElement);
  const modal=requireElement(root,'#settingsHelpModal',HTMLElement);
  const content=requireElement(root,'#settingsFlowContent',HTMLElement);
  const input=(id:string)=>requireElement(root,'#'+id,HTMLInputElement);
  function field(id:string):HTMLInputElement|HTMLSelectElement {const item=root.querySelector('#'+id);if(!(item instanceof HTMLInputElement)&&!(item instanceof HTMLSelectElement))throw new Error('Missing field: '+id);return item;}
  function escapeHtml(value:unknown) {const entities:Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};return String(value??'').replace(/[&<>"']/g,ch=>entities[ch]);}
  let initialized=false;
    function readCurrentConfigForm() {
      return {
        pollIntervalMinutes: Number(field('pollInterval').value || 10),
        perVideoDelaySeconds: Number(field('delaySeconds').value || 0),
        uploadLayout: field('uploadLayout').value,
        alistDest: field('alistDest').value.trim() || '/bili-backup/videos',
        bbdownEncoding: field('bbdownEncoding').value || '自动',
        bbdownEncodingPriority: dependencies.priority(),
        bbdownEncodingStrict: input('bbdownEncodingStrict').checked === true,
        bbdownQuality: field('bbdownQuality').value || '自动最高',
        bbdownApiMode: dependencies.apiMode(),
        bbdownHiRes: input('bbdownHiRes').checked,
        bbdownDolby: input('bbdownDolby').checked,
        filenameTemplate: field('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        renameScanMaxFiles: Number(field('renameScanMaxFiles').value || 10000),
        maxRetries: Number(field('maxRetries').value || 3),
        retryDelaySeconds: Number(field('retryDelaySeconds').value || 5),
        concurrentDownloads: Number(field('concurrentDownloads').value || 1),
        concurrentUploads: Number(field('concurrentUploads').value || 2),
        uploadFileIntervalSeconds: Number(field('uploadFileIntervalSeconds').value || 0),
        localCacheLimitGB: Number(field('localCacheLimitGB').value || 0),
        onlineCoverCacheLimitMB: Number(field('onlineCoverCacheLimitMB').value || 256),
        queuePrefetchLimit: Number(field('queuePrefetchLimit').value || 25),
        remoteVerifyConcurrency: Number(field('remoteVerifyConcurrency').value || 3),
        remoteVerifyRateLimitPerSecond: Number(field('remoteVerifyRateLimitPerSecond').value || 2),
        remoteRequeueLimitPerCycle: Number(field('remoteRequeueLimitPerCycle').value || 20),
      };
    }

    function renderSettingsFlow() {
      const c = readCurrentConfigForm();
      const layoutText = c.uploadLayout === 'user-folder-video' ? '用户名 / 收藏夹名 / 视频' : (c.uploadLayout === 'folder-video' ? '收藏夹名 / 视频' : '仅视频文件');
      const audioText = [c.bbdownHiRes ? 'Hi-Res' : '', c.bbdownDolby ? 'Dolby' : ''].filter(Boolean).join(' + ') || '普通音频';
      const encodingText = c.bbdownEncodingStrict
        ? '严格 ' + c.bbdownEncodingPriority[0]
        : c.bbdownEncodingPriority.join(' → ');
      content.innerHTML =
        '<div class="flow-visual">' +
          '<div class="flow-step"><div class="badge">自动轮询</div><div class="desc">程序每 <strong>' + escapeHtml(c.pollIntervalMinutes) + ' 分钟</strong>自动检查一次；手动按钮会额外插队触发。</div></div>' +
          '<div class="flow-step"><div class="badge">扫描收藏夹</div><div class="desc">发现新视频后按当前命名模板准备任务：<code>' + escapeHtml(c.filenameTemplate) + '</code></div></div>' +
          '<div class="flow-step"><div class="badge">下载队列</div><div class="desc">最多同时下载 <strong>' + escapeHtml(c.concurrentDownloads) + '</strong> 个；本地 temp 达到 <strong>' + escapeHtml(c.localCacheLimitGB || 0) + 'GB</strong> 软上限时不再启动新下载；画质为 <strong>' + escapeHtml(c.bbdownQuality) + '</strong>，编码偏好为 <strong>' + escapeHtml(encodingText) + '</strong>，音频选项为 <strong>' + escapeHtml(audioText) + '</strong>；分P之间延迟 <strong>' + escapeHtml(c.perVideoDelaySeconds) + ' 秒</strong>。</div></div>' +
          '<div class="flow-step"><div class="badge">失败重试</div><div class="desc">下载或上传失败后最多重试 <strong>' + escapeHtml(c.maxRetries) + '</strong> 次，每次间隔 <strong>' + escapeHtml(c.retryDelaySeconds) + ' 秒</strong>；下载卡住超过 30 分钟且最近 10 分钟低于 10KB/s 会自动进入重试。</div></div>' +
          '<div class="flow-step"><div class="badge">上传远端存储</div><div class="desc">最多同时上传 <strong>' + escapeHtml(c.concurrentUploads) + '</strong> 个；实际 PUT 全局间隔 <strong>' + escapeHtml(c.uploadFileIntervalSeconds || 0) + ' 秒</strong>；目标路径是 <code>' + escapeHtml(c.alistDest) + '</code>，目录结构是 <strong>' + escapeHtml(layoutText) + '</strong>。</div></div>' +
          '<div class="flow-step"><div class="badge">状态对账</div><div class="desc">远端存储对账并发 <strong>' + escapeHtml(c.remoteVerifyConcurrency) + '</strong>，限速 <strong>' + escapeHtml(c.remoteVerifyRateLimitPerSecond) + ' 次/秒</strong>，每轮最多补传 <strong>' + escapeHtml(c.remoteRequeueLimitPerCycle) + '</strong> 个缺失视频。</div></div>' +
        '</div>' +
        '<div class="effect-groups">' +
          '<div class="effect-group"><strong>立即生效</strong><div>轮询间隔、同时下载并发数、同时上传并发数、远端文件上传间隔、本地缓存软上限；画质重调的下载阶段共享下载队列，上传替换阶段共享上传队列。</div></div>' +
          '<div class="effect-group"><strong>新任务生效</strong><div>画质、编码、Hi-Res / Dolby、命名模板、远端路径、上传目录结构、失败重试次数、重试间隔。</div></div>' +
          '<div class="effect-group"><strong>对账时生效</strong><div>远端存储对账并发数、对账限速、每轮最多补传数量。</div></div>' +
        '</div>' +
        '<p class="muted help-note">修改远端路径或目录结构不会搬动旧文件；命名模板只影响新下载，旧文件请通过“检查旧命名文件”预览后再确认重命名。远端对账高并发/高限速会增加后端压力，建议逐步调高。</p>';
    }

    function openSettingsHelp() {
      renderSettingsFlow();
      dependencies.open(modal, button);
    }

  return {init(){if(initialized)return;initialized=true;button.addEventListener('click',openSettingsHelp);},destroy(){if(!initialized)return;initialized=false;button.removeEventListener('click',openSettingsHelp);}};
}
