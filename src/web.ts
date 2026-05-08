export function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站收藏夹同步 - 登录</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
    :root {
      color-scheme: light;
      --bg: #F4FDFB;
      --panel: #ffffff;
      --accent: #39C5BB;
      --accent-hover: #2BA9A0;
      --ink: #1A2F2D;
      --muted: #6A7A78;
      --shadow: 0 20px 60px rgba(57, 197, 187, 0.15);
      --border: #D6F0ED;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans SC", sans-serif;
      background: radial-gradient(circle at top, #E0F7FA 0%, var(--bg) 60%);
      color: var(--ink);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(420px, 100%);
      background: var(--panel);
      border-radius: 20px;
      padding: 36px;
      box-shadow: var(--shadow);
      animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      border: 1px solid var(--border);
    }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 700; color: var(--accent); }
    p { margin: 0 0 28px; color: var(--muted); font-size: 15px; }
    label { display: block; font-weight: 500; margin: 0 0 8px; color: var(--ink); }
    input {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 2px solid var(--border);
      margin-bottom: 20px;
      font-size: 15px;
      transition: all 0.2s;
      outline: none;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(57, 197, 187, 0.2);
    }
    button {
      width: 100%;
      padding: 14px 16px;
      border: none;
      border-radius: 12px;
      background: var(--accent);
      color: white;
      font-weight: 700;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(57, 197, 187, 0.3);
    }
    button:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(57, 197, 187, 0.4);
    }
    button:active {
      transform: translateY(1px);
      box-shadow: 0 2px 8px rgba(57, 197, 187, 0.3);
    }
    .error { color: #E57373; margin-top: 16px; min-height: 20px; text-align: center; font-weight: 500; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>B站收藏夹同步</h1>
    <p>初音绿主题 · 登录以管理您的同步任务。</p>
    <label>管理员用户名</label>
    <input id="username" type="text" autocomplete="username" placeholder="输入用户名" />
    <label>密码</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="输入密码" />
    <button id="loginBtn">进入系统</button>
    <div class="error" id="error"></div>
  </div>
  <script>
    const loginBtn = document.getElementById('loginBtn');
    const errorEl = document.getElementById('error');
    loginBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value.trim();
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) {
        window.location.href = '/';
      } else {
        errorEl.textContent = data.message || '登录失败，请检查账号密码';
      }
    });
  </script>
</body>
</html>`;
}

export function renderAppPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站收藏夹同步</title>
  ${getAppStyles()}
</head>
<body>
  ${getAppHeader()}
  <main>
    ${getAccountSection()}
    ${getSettingsSection()}
    ${getLogSection()}
  </main>
  ${getModals()}
  <script>
    ${getAppScript()}
  </script>
</body>
</html>`;
}

function getAppStyles() {
  return `<style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
    :root {
      --bg: #F4FDFB; --panel: #ffffff; --accent: #39C5BB; --accent-hover: #2BA9A0;
      --ink: #1A2F2D; --muted: #6A7A78; --border: #D6F0ED;
      --shadow: 0 18px 45px rgba(57,197,187,0.08);
      --success: #4CAF50; --success-bg: #E8F5E9;
    }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at top left,#E0F7FA 0%,var(--bg) 45%); color:var(--ink); }
    header { display:flex; justify-content:space-between; align-items:center; padding:24px 32px; background:rgba(255,255,255,0.6); backdrop-filter:blur(10px); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:10; }
    header h1 { margin:0; font-size:24px; color:var(--accent); font-weight:700; }
    header button { background:white; border:2px solid var(--border); border-radius:999px; padding:8px 20px; cursor:pointer; font-weight:600; color:var(--ink); transition:all 0.2s; }
    header button:hover { border-color:var(--accent); color:var(--accent); }
    main { padding:32px; display:grid; gap:24px; grid-template-columns:1fr; max-width:1200px; margin:0 auto; }
    .card { background:var(--panel); border-radius:20px; padding:24px; box-shadow:var(--shadow); border:1px solid var(--border); animation:fadeUp 0.6s cubic-bezier(0.16,1,0.3,1); }
    .card h2 { margin:0 0 16px; font-size:20px; color:var(--accent); display:flex; align-items:center; gap:8px; }
    .card h2::before { content:''; display:block; width:4px; height:18px; background:var(--accent); border-radius:4px; }
    .muted { color:var(--muted); font-size:14px; margin-bottom:16px; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .row button { border:none; background:var(--accent); color:white; padding:10px 16px; border-radius:12px; cursor:pointer; font-weight:600; transition:all 0.2s; }
    .row button:hover { background:var(--accent-hover); transform:translateY(-1px); }
    .row .ghost { background:transparent; color:var(--accent); border:2px solid var(--accent); }
    .row .ghost:hover { background:rgba(57,197,187,0.1); }
    .user-list { display:grid; gap:16px; }
    .user-item { border:1px solid var(--border); border-radius:16px; padding:16px; display:grid; gap:12px; background:#fafdfc; }
    .settings-grid { display:grid; gap:16px; grid-template-columns:1fr 1fr; }
    .settings-group { grid-column:1/-1; padding-top:16px; border-top:1px dashed var(--border); margin-top:8px; }
    .settings-group-title { font-weight:700; color:var(--ink); margin-bottom:12px; }
    .field-full { grid-column:1/-1; }
    label { display:block; font-weight:500; margin:0 0 8px; color:var(--ink); font-size:14px; }
    input[type="text"],input[type="number"],input[type="password"],select { width:100%; padding:12px 14px; border-radius:12px; border:2px solid var(--border); font-size:14px; outline:none; transition:all 0.2s; background:white; }
    input:focus,select:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(57,197,187,0.2); }
    .checkbox-label { display:flex; align-items:center; gap:8px; font-weight:500; cursor:pointer; margin:0; }
    .checkbox-label input { width:auto; margin:0; }
    .modal { position:fixed; inset:0; background:rgba(26,47,45,0.6); backdrop-filter:blur(4px); display:none; align-items:center; justify-content:center; padding:16px; z-index:100; }
    .modal.active { display:flex; }
    .modal .panel { background:white; padding:32px; border-radius:24px; max-width:700px; width:100%; box-shadow:0 24px 80px rgba(0,0,0,0.1); border:1px solid var(--border); max-height:90vh; overflow-y:auto; }
    .favorites-list { max-height:400px; overflow:auto; border:2px solid var(--border); border-radius:16px; padding:12px; background:#fafdfc; }
    .fav-label { font-weight:500; display:flex; gap:12px; align-items:center; margin:0; padding:12px; border-radius:12px; transition:background 0.2s; cursor:pointer; }
    .fav-label:hover { background:rgba(57,197,187,0.1); }
    .fav-cover { width:64px; height:40px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    /* Video items in detail modal */
    .video-grid { display:grid; gap:12px; max-height:500px; overflow-y:auto; }
    .video-item { display:flex; gap:12px; padding:12px; border-radius:12px; border:1px solid var(--border); align-items:center; transition:all 0.2s; }
    .video-item.processed { background:var(--success-bg); border-color:var(--success); }
    .video-item.unavailable-uploaded { background:#FFF8E1; border-color:#FFC107; box-shadow:0 0 0 1px #FFC107; }
    .video-item.unavailable-missing { background:#FFEBEE; border-color:#FFCDD2; }
    .video-cover { width:120px; height:75px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    .video-info { flex:1; min-width:0; }
    .video-title { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .video-meta { font-size:12px; color:var(--muted); margin-top:4px; }
    .video-badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:600; }
    .video-badge.done { background:var(--success); color:white; }
    .video-badge.pending { background:var(--border); color:var(--muted); }
    .video-badge.removed-uploaded { background:#FFC107; color:#1A2F2D; }
    .video-badge.removed-missing { background:#EF9A9A; color:white; }
    .filter-toggle { display:flex; gap:8px; margin-bottom:12px; }
    .filter-toggle button { padding:6px 16px; border-radius:8px; border:2px solid var(--border); background:white; color:var(--ink); cursor:pointer; font-weight:600; font-size:13px; transition:all 0.2s; }
    .filter-toggle button.active { background:var(--accent); color:white; border-color:var(--accent); }
    /* Template tags */
    .template-tags { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .template-tag { display:inline-flex; align-items:center; gap:4px; padding:6px 12px; border-radius:8px; background:rgba(57,197,187,0.1); color:var(--accent); font-size:13px; font-weight:600; cursor:pointer; border:2px solid transparent; transition:all 0.2s; user-select:none; }
    .template-tag:hover { border-color:var(--accent); }
    .template-tag.active { background:var(--accent); color:white; }
    .template-tag.selected { background:var(--accent); color:white; cursor:grab; }
    .template-tag.selected:active { cursor:grabbing; }
    .template-tag.dragging { opacity:0.4; }
    .template-tag.drag-over { border-color:var(--accent); transform:scale(1.05); }
    .template-tag .remove-x { margin-left:4px; font-size:14px; opacity:0.7; }
    .template-tag .remove-x:hover { opacity:1; }
    .template-preview { padding:12px; background:#f5f5f5; border-radius:8px; font-family:monospace; font-size:13px; color:var(--ink); margin:8px 0; min-height:36px; word-break:break-all; }
    /* Log console */
    .log-console { background:#1a1a2e; color:#eee; border-radius:12px; padding:16px; font-family:'Courier New',monospace; font-size:12px; max-height:400px; overflow-y:auto; line-height:1.8; }
    .log-console .log-info { color:#39C5BB; }
    .log-console .log-error { color:#E57373; }
    .log-console .log-warn { color:#FFB74D; }
    .log-toggle { display:flex; gap:8px; margin-bottom:12px; }
    .log-toggle button { padding:6px 16px; border-radius:8px; border:2px solid var(--border); background:white; color:var(--ink); cursor:pointer; font-weight:600; font-size:13px; transition:all 0.2s; }
    .log-toggle button.active { background:var(--accent); color:white; border-color:var(--accent); }
    .rename-btn { background:#FF7043!important; }
    .rename-btn:hover { background:#F4511E!important; }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  </style>`;
}

function getAppHeader() {
  return `<header>
    <h1>B站收藏夹同步</h1>
    <button id="logoutBtn">退出系统</button>
  </header>`;
}

function getAccountSection() {
  return `<section class="card">
      <h2>账号与同步</h2>
      <p class="muted">管理 Bilibili 账号及需同步的收藏夹。点击立即同步可唤醒后台任务队列。</p>
      <div class="row" style="margin-bottom:20px;">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">触发立即同步</button>
      </div>
      <div class="user-list" id="userList"></div>
    </section>`;
}

function getSettingsSection() {
  return `<section class="card">
      <h2>全局设置</h2>
      <div class="settings-grid">
        <div><label>轮询间隔 (分钟)</label><input id="pollInterval" type="number" min="1" /></div>
        <div><label>视频间延迟 (秒)</label><input id="delaySeconds" type="number" min="0" /></div>

        <div class="settings-group"><div class="settings-group-title">AList 云盘设置</div></div>
        <div class="field-full"><label>AList 内部通信地址</label><input id="alistUrl" type="text" placeholder="例如: http://alist:5244" autocomplete="off" /></div>
        <div><label>AList 账号 (WebDAV 用户名)</label><input id="alistUsername" type="text" placeholder="例如: admin" autocomplete="off" /></div>
        <div><label>AList 密码 (WebDAV 密码)</label><input id="alistPassword" type="password" placeholder="密码" autocomplete="new-password" /></div>
        <div class="field-full"><label>目标存储路径</label><input id="alistDest" type="text" placeholder="例如: /阿里云盘/bili-backup/videos" /></div>
        <div class="field-full"><label>上传目录结构</label>
          <select id="uploadLayout">
            <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
            <option value="folder-video">收藏夹名 / 视频</option>
            <option value="video-only">仅视频文件</option>
          </select>
        </div>

        <div class="settings-group"><div class="settings-group-title">下载控制 (BBDown)</div></div>
        <div><label>视频编码</label>
          <select id="bbdownEncoding">
            <option value="">自动 (默认)</option>
            <option value="HEVC">HEVC (H.265)</option>
            <option value="AVC">AVC (H.264)</option>
            <option value="AV1">AV1</option>
          </select>
        </div>
        <div><label>最高画质</label>
          <select id="bbdownQuality">
            <option value="">自动 (最高)</option>
            <option value="8K">8K</option>
            <option value="4K">4K</option>
            <option value="1080P60">1080P 60帧</option>
            <option value="1080P">1080P 高清</option>
            <option value="720P">720P 高清</option>
          </select>
        </div>
        <div class="field-full row">
          <label class="checkbox-label"><input type="checkbox" id="bbdownHiRes" /> 下载 Hi-Res 音质</label>
          <label class="checkbox-label"><input type="checkbox" id="bbdownDolby" /> 下载 杜比音效 (Dolby)</label>
        </div>

        <div class="settings-group"><div class="settings-group-title">📁 视频命名模板</div></div>
        <div class="field-full">
          <p class="muted" style="margin-bottom:8px;">点击下方标签添加，拖拽已选标签可调整顺序，点击已选标签可移除。</p>
          <label>可用变量</label>
          <div class="template-tags" id="templateTags"></div>
          <label style="margin-top:12px;">已选变量（可拖拽排序）</label>
          <div class="template-tags" id="selectedTags" style="min-height:40px;border:2px dashed var(--border);border-radius:12px;padding:8px;"></div>
          <label style="margin-top:12px;">当前模板预览</label>
          <div class="template-preview" id="templatePreview"></div>
          <label style="margin-top:12px;">自定义模板 (高级)</label>
          <input id="filenameTemplate" type="text" placeholder="例如: <videoTitle>-<ownerName>-<bvid>" />
        </div>

        <div class="settings-group"><div class="settings-group-title">任务队列与重试</div></div>
        <div><label>失败重试次数</label><input id="maxRetries" type="number" min="0" /></div>
        <div><label>重试间隔 (秒)</label><input id="retryDelaySeconds" type="number" min="1" /></div>
        <div><label>同时下载并发数</label><input id="concurrentDownloads" type="number" min="1" max="5" /></div>
        <div><label>同时上传并发数</label><input id="concurrentUploads" type="number" min="1" max="10" /></div>
      </div>
      <div class="row" style="margin-top:24px;">
        <button id="saveConfigBtn">保存设置并生效</button>
        <button id="renameBtn" class="rename-btn" style="border:none;color:white;padding:10px 16px;border-radius:12px;cursor:pointer;font-weight:600;transition:all 0.2s;">🔄 一键重命名网盘文件</button>
      </div>
      <div class="muted" id="configStatus" style="margin-top:12px;color:var(--accent);"></div>
      <div class="muted" id="renameStatus" style="margin-top:8px;"></div>
    </section>`;
}

function getLogSection() {
  return `<section class="card">
      <h2>任务日志</h2>
      <div class="log-toggle">
        <button id="logSimpleBtn" class="active">精简模式</button>
        <button id="logRawBtn">原始输出</button>
      </div>
      <div class="log-console" id="logConsole"><span class="log-info">等待日志...</span></div>
    </section>`;
}

function getModals() {
  return `
  <div class="modal" id="loginModal">
    <div class="panel">
      <h2>扫码登录</h2>
      <p class="muted">请使用B站APP扫描二维码登录（TV端接口）。</p>
      <div style="text-align:center;margin:24px 0;">
        <img id="loginQr" alt="QR" style="width:200px;height:200px;border-radius:16px;border:4px solid var(--border);" />
      </div>
      <div id="loginStatus" class="muted" style="text-align:center;font-weight:500;font-size:16px;"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="closeLoginBtn" class="ghost" style="width:100%;">取消登录</button>
      </div>
    </div>
  </div>

  <div class="modal" id="favoritesModal">
    <div class="panel">
      <h2>选择同步收藏夹</h2>
      <p class="muted">勾选你需要自动备份的收藏夹。点击收藏夹名称可查看内部视频详情。</p>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="row" style="margin-top:24px;">
        <button id="saveFavoritesBtn" style="flex:1;">保存选择</button>
        <button id="closeFavoritesBtn" class="ghost" style="flex:1;">取消</button>
      </div>
      <div class="muted" id="favoritesStatus" style="margin-top:12px;text-align:center;"></div>
    </div>
  </div>

  <div class="modal" id="videoDetailModal">
    <div class="panel" style="max-width:800px;">
      <h2 id="videoDetailTitle">收藏夹详情</h2>
      <div class="video-grid" id="videoGrid"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="closeVideoDetailBtn" class="ghost" style="width:100%;">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="unavailableModal">
    <div class="panel" style="max-width:900px;">
      <h2>下架视频清单</h2>
      <div class="filter-toggle">
        <button id="filterMissingBtn" class="active">下架未上传</button>
        <button id="filterUploadedBtn">下架已上传</button>
      </div>
      <div class="video-grid" id="unavailableGrid"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="closeUnavailableBtn" class="ghost" style="width:100%;">关闭</button>
      </div>
    </div>
  </div>`;
}

function getAppScript() {
  return `
    const TEMPLATE_VARS = [
      { key: '<videoTitle>', label: '视频标题' },
      { key: '<ownerName>', label: 'UP主' },
      { key: '<bvid>', label: 'BV号' },
      { key: '<publishDate>', label: '发布日期' },
      { key: '<videoDate>', label: '视频日期' },
      { key: '<dfn>', label: '清晰度' },
      { key: '<videoCodecs>', label: '编码' },
    ];
    const SEP = '-';

    let currentLoginId = null;
    let favoritesUserId = null;
    let logMode = 'simple';
    let logEntries = [];
    let unavailableItems = [];
    let unavailableUserId = null;
    let unavailableFilter = 'missing';

    async function fetchJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '请求失败');
      return data.data;
    }

    // ---- Config ----
    async function loadConfig() {
      const d = await fetchJson('/api/config');
      document.getElementById('pollInterval').value = d.pollIntervalMinutes;
      document.getElementById('delaySeconds').value = d.perVideoDelaySeconds;
      document.getElementById('uploadLayout').value = d.uploadLayout;
      document.getElementById('alistUrl').value = d.alistUrl || '';
      document.getElementById('alistUsername').value = d.alistUsername || '';
      document.getElementById('alistPassword').value = d.alistPassword || '';
      document.getElementById('alistDest').value = d.alistDest || '';
      document.getElementById('bbdownEncoding').value = d.bbdownEncoding || '';
      document.getElementById('bbdownQuality').value = d.bbdownQuality || '';
      document.getElementById('bbdownHiRes').checked = !!d.bbdownHiRes;
      document.getElementById('bbdownDolby').checked = !!d.bbdownDolby;
      document.getElementById('maxRetries').value = d.maxRetries ?? 3;
      document.getElementById('retryDelaySeconds').value = d.retryDelaySeconds ?? 5;
      document.getElementById('concurrentDownloads').value = d.concurrentDownloads ?? 1;
      document.getElementById('concurrentUploads').value = d.concurrentUploads ?? 2;
      document.getElementById('filenameTemplate').value = d.filenameTemplate || '<videoTitle>';
      updateTemplatePreview();
    }

    async function saveConfig() {
      const btn = document.getElementById('saveConfigBtn');
      const st = document.getElementById('configStatus');
      btn.textContent = '保存中...'; st.textContent = '';
      const payload = {
        pollIntervalMinutes: Number(document.getElementById('pollInterval').value),
        perVideoDelaySeconds: Number(document.getElementById('delaySeconds').value),
        uploadLayout: document.getElementById('uploadLayout').value,
        alistUrl: document.getElementById('alistUrl').value.trim() || 'http://alist:5244',
        alistUsername: document.getElementById('alistUsername').value.trim(),
        alistPassword: document.getElementById('alistPassword').value.trim(),
        alistDest: document.getElementById('alistDest').value.trim(),
        bbdownEncoding: document.getElementById('bbdownEncoding').value,
        bbdownQuality: document.getElementById('bbdownQuality').value,
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>',
        maxRetries: Number(document.getElementById('maxRetries').value),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value),
      };
      try {
        await fetchJson('/api/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        st.textContent = '设置已保存并生效！'; st.style.color = 'var(--accent)';
      } catch(e) {
        st.textContent = '保存失败: '+e.message; st.style.color = '#E57373';
      } finally {
        btn.textContent = '保存设置并生效';
        setTimeout(()=>{ if(st.style.color!=='rgb(229, 115, 115)') st.textContent=''; },3000);
      }
    }

    // ---- Template Editor (Drag & Drop) ----
    let selectedKeys = [];
    let dragSrcIdx = null;

    function initTemplateEditor() {
      const avail = document.getElementById('templateTags');
      TEMPLATE_VARS.forEach(v => {
        const tag = document.createElement('span');
        tag.className = 'template-tag';
        tag.textContent = v.label;
        tag.addEventListener('click', () => {
          if (selectedKeys.includes(v.key)) return;
          selectedKeys.push(v.key);
          syncFromSelected();
          renderSelected();
        });
        avail.appendChild(tag);
      });
      const init = document.getElementById('filenameTemplate').value || '<videoTitle>';
      selectedKeys = TEMPLATE_VARS.filter(v => init.includes(v.key)).map(v => v.key);
      selectedKeys.sort((a,b) => init.indexOf(a) - init.indexOf(b));
      renderSelected();
      document.getElementById('filenameTemplate').addEventListener('input', updateTemplatePreview);
    }

    function renderSelected() {
      const box = document.getElementById('selectedTags');
      box.innerHTML = '';
      if (!selectedKeys.length) {
        box.innerHTML = '<span style="color:var(--muted);font-size:13px;padding:4px;">点击上方标签添加到此处</span>';
        return;
      }
      selectedKeys.forEach((key, i) => {
        const v = TEMPLATE_VARS.find(t => t.key === key);
        if (!v) return;
        const t = document.createElement('span');
        t.className = 'template-tag selected';
        t.draggable = true;
        t.innerHTML = v.label + '<span class="remove-x">\u00d7</span>';
        t.addEventListener('dragstart', () => { dragSrcIdx = i; t.classList.add('dragging'); });
        t.addEventListener('dragend', () => { t.classList.remove('dragging'); dragSrcIdx = null; box.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over')); });
        t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('drag-over'); });
        t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
        t.addEventListener('drop', (e) => {
          e.preventDefault(); t.classList.remove('drag-over');
          if (dragSrcIdx === null || dragSrcIdx === i) return;
          const moved = selectedKeys.splice(dragSrcIdx, 1)[0];
          selectedKeys.splice(i, 0, moved);
          syncFromSelected(); renderSelected();
        });
        t.querySelector('.remove-x').addEventListener('click', (e) => {
          e.stopPropagation();
          selectedKeys.splice(i, 1);
          syncFromSelected(); renderSelected();
        });
        box.appendChild(t);
      });
    }

    function syncFromSelected() {
      document.getElementById('filenameTemplate').value = selectedKeys.join(SEP);
      updateTemplatePreview();
    }

    function updateTemplatePreview() {
      const tpl = document.getElementById('filenameTemplate').value || '<videoTitle>';
      const preview = tpl
        .replace(/<videoTitle>/g, '\u89c6\u9891\u6807\u9898\u793a\u4f8b')
        .replace(/<ownerName>/g, 'UP\u4e3b\u540d')
        .replace(/<bvid>/g, 'BV1xxxxx')
        .replace(/<publishDate>/g, '2026-05-08')
        .replace(/<videoDate>/g, '2026-05-08')
        .replace(/<dfn>/g, '1080P')
        .replace(/<videoCodecs>/g, 'HEVC');
      document.getElementById('templatePreview').textContent = preview + '.mp4';
    }

    // ---- Users ----
    async function loadUsers() {
      const users = await fetchJson('/api/users');
      const el = document.getElementById('userList');
      el.innerHTML = '';
      users.forEach(user => {
        const favHtml = (user.favorites||[]).map(f =>
          '<span style="display:inline-block;padding:4px 10px;background:rgba(57,197,187,0.1);border-radius:8px;font-size:12px;margin:2px;">' +
          f.title + '</span>'
        ).join('');
        const item = document.createElement('div');
        item.className = 'user-item';
        item.innerHTML =
          '<strong style="font-size:16px;color:var(--accent);">' + user.name + '</strong>' +
          '<div class="muted" style="margin:0;">UID: ' + user.uid + ' | 已选 ' + user.favoritesCount + ' 个收藏夹</div>' +
          '<div style="margin:4px 0;">' + favHtml + '</div>' +
          '<div class="row" style="margin-top:4px;">' +
            '<button data-action="favorites" data-id="'+user.id+'">选择收藏夹</button>' +
            '<button class="ghost" data-action="unavailable" data-id="'+user.id+'">下架清单</button>' +
            '<button class="ghost" data-action="toggle" data-id="'+user.id+'">' + (user.enabled?'暂停同步':'恢复同步') + '</button>' +
            '<button class="ghost" style="border-color:#E57373;color:#E57373;" data-action="remove" data-id="'+user.id+'">删除账号</button>' +
          '</div>';
        el.appendChild(item);
      });
    }

    // ---- Login ----
    async function startLogin() {
      document.getElementById('loginStatus').textContent = '等待扫码...';
      const data = await fetchJson('/api/users/login/start', { method:'POST' });
      currentLoginId = data.loginId;
      document.getElementById('loginQr').src = data.qrDataUrl;
      document.getElementById('loginModal').classList.add('active');
      pollLoginStatus();
    }
    async function pollLoginStatus() {
      if (!currentLoginId) return;
      try {
        const res = await fetch('/api/users/login/status?loginId=' + currentLoginId);
        const json = await res.json();
        if (!res.ok || !json.success) { document.getElementById('loginStatus').textContent = json.message||'失败'; currentLoginId=null; return; }
        const d = json.data;
        if (d.status==='completed') {
          document.getElementById('loginStatus').textContent = '登录成功！';
          currentLoginId=null;
          setTimeout(()=>{ document.getElementById('loginModal').classList.remove('active'); loadUsers(); },1000);
        } else if (d.status==='error') {
          document.getElementById('loginStatus').textContent = d.message||'异常'; currentLoginId=null;
        } else {
          document.getElementById('loginStatus').textContent = '等待扫码并确认...';
          setTimeout(pollLoginStatus, 1500);
        }
      } catch(e) { document.getElementById('loginStatus').textContent = e.message; currentLoginId=null; }
    }

    // ---- Favorites (with thumbnails) ----
    async function openFavorites(userId) {
      favoritesUserId = userId;
      document.getElementById('favoritesStatus').textContent = '';
      const list = document.getElementById('favoritesList');
      list.innerHTML = '<div class="muted" style="text-align:center;">加载中...</div>';
      document.getElementById('favoritesModal').classList.add('active');
      const data = await fetchJson('/api/users/'+userId+'/favorites');
      list.innerHTML = '';
      data.forEach(folder => {
        const lbl = document.createElement('label');
        lbl.className = 'fav-label';
        const coverUrl = folder.cover ? folder.cover.replace('http://','https://') : '';
        lbl.innerHTML =
          '<input type="checkbox" value="'+folder.mediaId+'" '+(folder.selected?'checked':'')+' />' +
          (coverUrl ? '<img class="fav-cover" src="'+coverUrl+'" referrerpolicy="no-referrer" loading="lazy" />' : '<div class="fav-cover"></div>') +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;">'+folder.title+'</div>' +
            '<div style="font-size:12px;color:var(--muted);">'+folder.mediaCount+' 个视频</div>' +
          '</div>' +
          '<button class="ghost" style="padding:4px 12px;font-size:12px;flex-shrink:0;" data-detail-media="'+folder.mediaId+'" data-detail-title="'+folder.title+'">查看详情</button>';
        list.appendChild(lbl);
      });
    }

    // ---- Video Detail Modal ----
    async function openVideoDetail(userId, mediaId, title) {
      document.getElementById('videoDetailTitle').textContent = '📁 ' + title;
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '<div class="muted" style="text-align:center;">加载视频列表...</div>';
      document.getElementById('videoDetailModal').classList.add('active');
      try {
        const items = await fetchJson('/api/users/'+userId+'/favorites/'+mediaId+'/items');
        grid.innerHTML = '';
        if (items.length === 0) { grid.innerHTML = '<div class="muted">此收藏夹为空</div>'; return; }
        items.forEach(item => {
          const div = document.createElement('div');
          // 4-state logic
          let stateClass = '';
          let badgeClass = '';
          let badgeText = '';
          if (item.unavailable && item.processed) {
            stateClass = 'unavailable-uploaded';
            badgeClass = 'removed-uploaded';
            badgeText = '已下架（已上传）';
          } else if (item.unavailable && !item.processed) {
            stateClass = 'unavailable-missing';
            badgeClass = 'removed-missing';
            badgeText = '已下架（未上传）';
          } else if (item.processed) {
            stateClass = 'processed';
            badgeClass = 'done';
            badgeText = '✓ 已备份';
          } else {
            stateClass = '';
            badgeClass = 'pending';
            badgeText = '待备份';
          }
          div.className = 'video-item ' + stateClass;
          const coverUrl = item.cover ? item.cover.replace('http://','https://') : '';
          div.innerHTML =
            (coverUrl ? '<img class="video-cover" src="'+coverUrl+'" referrerpolicy="no-referrer" loading="lazy" />' : '<div class="video-cover"></div>') +
            '<div class="video-info">' +
              '<div class="video-title" title="'+item.title+'">'+item.title+'</div>' +
              '<div class="video-meta">UP: '+item.upperName+' | '+item.bvid+'</div>' +
            '</div>' +
            '<span class="video-badge '+badgeClass+'">'+badgeText+'</span>';
          grid.appendChild(div);
        });
      } catch(e) {
        grid.innerHTML = '<div style="color:#E57373;">加载失败: '+e.message+'</div>';
      }
    }

    // ---- Unavailable Videos Modal ----
    async function openUnavailable(userId) {
      unavailableUserId = userId;
      unavailableFilter = 'missing';
      document.getElementById('filterMissingBtn').classList.add('active');
      document.getElementById('filterUploadedBtn').classList.remove('active');
      const grid = document.getElementById('unavailableGrid');
      grid.innerHTML = '<div class="muted" style="text-align:center;">加载中...</div>';
      document.getElementById('unavailableModal').classList.add('active');
      try {
        const data = await fetchJson('/api/users/' + userId + '/unavailable');
        unavailableItems = data || [];
        renderUnavailableList();
      } catch (e) {
        grid.innerHTML = '<div style="color:#E57373;">加载失败: ' + e.message + '</div>';
      }
    }

    function setUnavailableFilter(filter) {
      unavailableFilter = filter;
      document.getElementById('filterMissingBtn').classList.toggle('active', filter === 'missing');
      document.getElementById('filterUploadedBtn').classList.toggle('active', filter === 'uploaded');
      renderUnavailableList();
    }

    function renderUnavailableList() {
      const grid = document.getElementById('unavailableGrid');
      const filtered = (unavailableItems || []).filter(item =>
        item.processed ? unavailableFilter === 'uploaded' : unavailableFilter === 'missing'
      );

      if (filtered.length === 0) {
        grid.innerHTML = '<div class="muted" style="text-align:center;">暂无符合条件的视频</div>';
        return;
      }

      grid.innerHTML = '';
      filtered.forEach(item => {
        const div = document.createElement('div');
        const stateClass = item.processed ? 'unavailable-uploaded' : 'unavailable-missing';
        const badgeClass = item.processed ? 'removed-uploaded' : 'removed-missing';
        const badgeText = item.processed ? '已下架（已上传）' : '已下架（未上传）';
        const coverUrl = item.cover ? item.cover.replace('http://','https://') : '';
        div.className = 'video-item ' + stateClass;
        div.innerHTML =
          (coverUrl ? '<img class="video-cover" src="'+coverUrl+'" referrerpolicy="no-referrer" loading="lazy" />' : '<div class="video-cover"></div>') +
          '<div class="video-info">' +
            '<div class="video-title" title="'+item.title+'">'+item.title+'</div>' +
            '<div class="video-meta">UP: '+item.upperName+' | '+item.bvid+'</div>' +
            '<div class="video-meta">收藏夹: '+(item.folderTitle || '未知')+'</div>' +
          '</div>' +
          '<span class="video-badge '+badgeClass+'">'+badgeText+'</span>';
        grid.appendChild(div);
      });
    }

    async function saveFavorites() {
      document.getElementById('saveFavoritesBtn').textContent = '保存中...';
      const selected = Array.from(document.getElementById('favoritesList').querySelectorAll('input:checked')).map(i=>Number(i.value));
      await fetchJson('/api/users/'+favoritesUserId+'/favorites', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mediaIds:selected})
      });
      document.getElementById('saveFavoritesBtn').textContent = '保存选择';
      document.getElementById('favoritesStatus').textContent = '已保存！';
      setTimeout(()=>document.getElementById('favoritesModal').classList.remove('active'),500);
      await loadUsers();
    }

    // ---- Dual-Mode Log ----
    function initLogStream() {
      const evtSource = new EventSource('/api/logs/stream');
      evtSource.onmessage = (event) => {
        try {
          const entry = JSON.parse(event.data);
          logEntries.push(entry);
          if (logEntries.length > 500) logEntries.splice(0, logEntries.length - 500);
          appendLogEntry(entry);
        } catch(e) {}
      };
      evtSource.onerror = () => {
        setTimeout(initLogStream, 3000);
        evtSource.close();
      };
    }

    function appendLogEntry(entry) {
      const console = document.getElementById('logConsole');
      const div = document.createElement('div');
      const cls = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN') : '';

      if (logMode === 'simple') {
        // Show only structured summaries, skip raw duplicates
        if (entry.raw && !entry.summary) return;
        div.className = cls;
        div.textContent = time + ' ' + (entry.summary || entry.raw || '');
      } else {
        div.className = cls;
        div.textContent = time + ' ' + (entry.raw || entry.summary || '');
      }
      console.appendChild(div);
      // Keep max 200 visible lines
      while (console.children.length > 200) console.removeChild(console.firstChild);
      console.scrollTop = console.scrollHeight;
    }

    function rebuildLog() {
      const console = document.getElementById('logConsole');
      console.innerHTML = '';
      const recent = logEntries.slice(-200);
      recent.forEach(e => appendLogEntry(e));
    }

    // ---- Event Bindings ----
    document.getElementById('addUserBtn').addEventListener('click', startLogin);
    document.getElementById('closeLoginBtn').addEventListener('click', () => {
      document.getElementById('loginModal').classList.remove('active'); currentLoginId = null;
    });
    document.getElementById('saveFavoritesBtn').addEventListener('click', saveFavorites);
    document.getElementById('closeFavoritesBtn').addEventListener('click', () => document.getElementById('favoritesModal').classList.remove('active'));
    document.getElementById('closeVideoDetailBtn').addEventListener('click', () => document.getElementById('videoDetailModal').classList.remove('active'));
    document.getElementById('closeUnavailableBtn').addEventListener('click', () => document.getElementById('unavailableModal').classList.remove('active'));
    document.getElementById('filterMissingBtn').addEventListener('click', () => setUnavailableFilter('missing'));
    document.getElementById('filterUploadedBtn').addEventListener('click', () => setUnavailableFilter('uploaded'));

    document.getElementById('userList').addEventListener('click', async (event) => {
      const t = event.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action, userId = t.dataset.id;
      if (action === 'favorites') await openFavorites(userId);
      if (action === 'unavailable') await openUnavailable(userId);
      if (action === 'remove' && confirm('确定要删除这个账号吗？')) { await fetchJson('/api/users/'+userId,{method:'DELETE'}); await loadUsers(); }
      if (action === 'toggle') { await fetchJson('/api/users/'+userId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({toggle:true})}); await loadUsers(); }
    });

    // Favorites list: handle detail button clicks
    document.getElementById('favoritesList').addEventListener('click', (event) => {
      const t = event.target;
      if (!(t instanceof HTMLElement)) return;
      const mediaId = t.dataset.detailMedia;
      const title = t.dataset.detailTitle;
      if (mediaId && favoritesUserId) {
        event.preventDefault();
        event.stopPropagation();
        openVideoDetail(favoritesUserId, mediaId, title);
      }
    });

    document.getElementById('syncNowBtn').addEventListener('click', async () => {
      const btn = document.getElementById('syncNowBtn');
      btn.textContent = '同步中...';
      try { await fetchJson('/api/sync/now', { method:'POST' }); } catch(e) {}
      btn.textContent = '已触发';
      setTimeout(() => btn.textContent = '触发立即同步', 2000);
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await fetchJson('/api/logout', { method:'POST' });
      window.location.href = '/login';
    });
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);

    // Log mode toggle
    document.getElementById('logSimpleBtn').addEventListener('click', () => {
      logMode = 'simple';
      document.getElementById('logSimpleBtn').classList.add('active');
      document.getElementById('logRawBtn').classList.remove('active');
      rebuildLog();
    });
    document.getElementById('logRawBtn').addEventListener('click', () => {
      logMode = 'raw';
      document.getElementById('logRawBtn').classList.add('active');
      document.getElementById('logSimpleBtn').classList.remove('active');
      rebuildLog();
    });

    // Rename button
    document.getElementById('renameBtn').addEventListener('click', async () => {
      const btn = document.getElementById('renameBtn');
      const st = document.getElementById('renameStatus');
      if (!confirm('此操作会将网盘中已有的视频文件按当前模板重新命名。确认继续？')) return;
      btn.textContent = '重命名中...';
      st.textContent = '';
      try {
        const config = await fetchJson('/api/config');
        const remotePath = config.alistDest || '/bili-backup';
        const files = await fetchJson('/api/remote/list?path=' + encodeURIComponent(remotePath));
        // Find .mp4 files that look like BV IDs
        const bvFiles = files.filter(f => /^BV[A-Za-z0-9]+\.mp4$/.test(f));
        if (bvFiles.length === 0) {
          st.textContent = '未找到需要重命名的 BV 号文件';
          st.style.color = 'var(--muted)';
          btn.textContent = '🔄 一键重命名网盘文件';
          return;
        }
        // For now, we can't resolve titles from BV locally, just inform user
        st.textContent = '发现 ' + bvFiles.length + ' 个 BV 号命名的文件。注意：一键重命名仅对未来下载生效（使用新模板），已有文件需要手动在 AList 中重命名。';
        st.style.color = 'var(--muted)';
      } catch(e) {
        st.textContent = '操作失败: ' + e.message;
        st.style.color = '#E57373';
      } finally {
        btn.textContent = '🔄 一键重命名网盘文件';
      }
    });

    // Init
    loadConfig();
    loadUsers();
    initTemplateEditor();
    initLogStream();
  `;
}
