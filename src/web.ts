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
    <p>欢迎回来 · 登录以管理您的同步任务。</p>
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
  <div id="toastContainer" class="toast-container"></div>
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
    .modal .panel { background:white; padding:32px; border-radius:24px; max-width:700px; width:100%; box-shadow:0 24px 80px rgba(0,0,0,0.1); border:1px solid var(--border); max-height:90vh; overflow-y:auto; overflow-x:hidden; }
    .favorites-list { max-height:400px; overflow:auto; border:2px solid var(--border); border-radius:16px; padding:12px; background:#fafdfc; }
    .fav-label { font-weight:500; display:flex; gap:12px; align-items:center; margin:0; padding:12px; border-radius:12px; transition:background 0.2s; cursor:pointer; }
    .fav-label:hover { background:rgba(57,197,187,0.1); }
    .fav-cover { width:64px; height:40px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    /* Video items in detail modal */
    .video-grid { display:grid; gap:12px; max-height:500px; overflow-y:auto; overflow-x:hidden; }
    .video-item { display:flex; gap:12px; padding:12px; border-radius:12px; border:1px solid var(--border); align-items:center; transition:all 0.2s; }
    .video-detail-status { text-align:center; padding:10px; color:var(--muted); font-size:13px; }
    .video-detail-status.error { color:#E57373; }
    .video-detail-hint { color:var(--muted); font-size:12px; margin:-4px 0 10px; line-height:1.6; }
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
    .filter-toggle { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
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
    .queue-board { display:grid; grid-template-columns:repeat(4,minmax(260px,1fr)); gap:12px; max-height:430px; overflow-x:auto; overflow-y:hidden; padding-bottom:4px; align-items:stretch; }
    .queue-col { min-width:0; border:1px solid var(--border); border-radius:12px; background:#fafdfc; padding:10px; height:420px; display:flex; flex-direction:column; overflow:hidden; }
    .queue-col-title { font-size:13px; font-weight:700; color:var(--accent); margin:0 0 8px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
    .queue-col-count { min-width:28px; text-align:right; }
    .queue-list { display:grid; gap:8px; overflow-y:auto; padding-right:4px; min-height:0; align-content:start; flex:1; }
    .queue-more { color:var(--muted); font-size:12px; text-align:center; padding:8px 4px; border:1px dashed var(--border); border-radius:10px; background:rgba(57,197,187,0.04); }
    .queue-empty { color:var(--muted); font-size:12px; text-align:center; padding:24px 4px; align-self:center; opacity:0.72; }
    .queue-card { min-width:0; max-width:100%; display:flex; gap:8px; padding:8px; border-radius:10px; border:1px solid var(--border); background:white; transition:box-shadow .18s ease, opacity .2s ease, border-color .2s ease; will-change:transform; }
    .queue-card.entering { animation:queueCardIn .22s cubic-bezier(0.16,1,0.3,1); }
    .queue-card.leaving { opacity:0; transform:scale(.98); }
    .queue-card:hover { box-shadow:0 6px 16px rgba(57,197,187,0.12); border-color:var(--accent); }
    .queue-cover { width:64px; height:44px; object-fit:cover; border-radius:6px; background:#eee; flex-shrink:0; }
    .queue-info { min-width:0; flex:1; }
    .queue-title { font-size:12px; font-weight:700; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .queue-meta { font-size:11px; color:var(--muted); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .queue-extra { font-size:11px; color:var(--muted); margin-top:4px; display:flex; gap:6px; flex-wrap:wrap; }
    .queue-pill { border-radius:999px; background:rgba(57,197,187,0.1); color:var(--accent); padding:1px 6px; line-height:1.5; }
    @keyframes queueCardIn { from{opacity:0;transform:translateY(6px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
    .help-icon-btn { width:32px; height:32px; border-radius:50%; border:2px solid var(--accent); background:white; color:var(--accent); font-weight:800; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; line-height:1; transition:all .2s; flex:0 0 auto; }
    .help-icon-btn:hover { background:rgba(57,197,187,0.1); transform:translateY(-1px); }
    .section-title-row { display:flex; align-items:center; gap:8px; margin:0 0 16px; }
    .section-title-row h2 { margin:0; }
    .section-title-row .help-icon-btn { width:28px; height:28px; font-size:14px; }
    .help-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0 16px; }
    .help-tabs button { padding:7px 14px; border-radius:999px; border:2px solid var(--border); background:white; color:var(--ink); cursor:pointer; font-weight:700; }
    .help-tabs button.active { border-color:var(--accent); background:rgba(57,197,187,0.12); color:var(--accent); }
    .help-card-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
    .help-card { border:1px solid var(--border); border-radius:16px; padding:14px; background:#fafdfc; }
    .help-card strong { color:var(--accent); display:block; margin-bottom:6px; }
    .help-card ul { margin:8px 0 0 18px; padding:0; color:var(--muted); font-size:13px; line-height:1.7; }
    .flow-visual { display:grid; gap:10px; margin:12px 0; }
    .flow-step { display:grid; grid-template-columns:92px 1fr; gap:12px; align-items:center; border:1px solid var(--border); border-radius:18px; padding:12px; background:linear-gradient(135deg,#ffffff,#f2fbfa); }
    .flow-step .badge { border-radius:999px; padding:8px 10px; background:var(--accent); color:white; text-align:center; font-weight:800; font-size:12px; }
    .flow-step .desc { color:var(--ink); font-size:14px; line-height:1.6; }
    .effect-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-top:14px; }
    .effect-group { border:1px solid var(--border); border-radius:14px; padding:12px; background:#fafdfc; }
    .effect-group strong { color:var(--accent); display:block; margin-bottom:6px; }
    .effect-group div { color:var(--muted); font-size:13px; line-height:1.7; }
    .rename-btn { background:#FF7043!important; }
    .rename-btn:hover { background:#F4511E!important; }
    .rename-list { display:grid; gap:10px; max-height:360px; overflow:auto; padding-right:4px; }
    .rename-item { display:grid; grid-template-columns:auto 1fr; gap:10px; border:1px solid var(--border); border-radius:14px; padding:12px; background:#fafdfc; }
    .rename-item input { margin-top:4px; }
    .rename-title { font-weight:700; color:var(--ink); word-break:break-word; }
    .rename-path { color:var(--muted); font-size:12px; line-height:1.6; word-break:break-all; }
    .rename-arrow { color:var(--accent); font-weight:800; }
    .rename-skip-list { max-height:180px; overflow:auto; border:1px dashed var(--border); border-radius:12px; padding:10px; background:#fffaf5; color:var(--muted); font-size:12px; line-height:1.7; word-break:break-all; }
    .rename-result { border-radius:12px; padding:10px; background:#f5fbfa; border:1px solid var(--border); color:var(--muted); font-size:13px; line-height:1.7; max-height:160px; overflow:auto; }
    .toast-container { position:fixed; bottom:24px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:12px; pointer-events:none; }
    .toast { background:white; color:var(--ink); padding:16px 20px; border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.1); border-left:4px solid #E57373; display:flex; align-items:center; gap:12px; animation:toastIn 0.3s cubic-bezier(0.16,1,0.3,1); max-width:400px; word-break:break-word; pointer-events:auto; }
    .toast.success { border-left-color:var(--success); }
    .toast.info { border-left-color:var(--accent); }
    .toast.fade-out { animation:toastOut 0.3s cubic-bezier(0.16,1,0.3,1) forwards; }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
    @keyframes toastIn { from{opacity:0;transform:translateX(40px) scale(0.9)} to{opacity:1;transform:translateX(0) scale(1)} }
    @keyframes toastOut { from{opacity:1;transform:translateX(0) scale(1)} to{opacity:0;transform:translateX(40px) scale(0.9)} }
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
      <p class="muted">管理 Bilibili 账号及需同步的收藏夹。点击“立即同步”会唤起后台任务队列。</p>
      <div class="row" style="margin-bottom:20px;align-items:center;">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">立即同步</button>
        <button class="ghost" id="reconcileRemoteBtn">状态对账（仅AList）</button>
        <button class="ghost" id="reconcileBtn">全量扫描并对账</button>
        <button class="help-icon-btn" id="syncHelpBtn" type="button" title="查看同步按钮说明">?</button>
      </div>
      <div class="user-list" id="userList"></div>
    </section>`;
}

function getSettingsSection() {
  return `<section class="card">
      <div class="section-title-row">
        <h2>全局设置</h2>
        <button class="help-icon-btn" id="settingsHelpBtn" type="button" title="查看当前设置如何执行">?</button>
      </div>
      <div class="settings-grid">
        <div><label>轮询间隔 (分钟)</label><input id="pollInterval" type="number" min="1" /></div>
        <div><label>BBDown 分P延迟（秒）</label><input id="delaySeconds" type="number" min="0" /><p class="muted" style="margin:6px 0 0;font-size:12px;">用于 BBDown 的 --delay-per-page，只影响新下载任务。</p></div>

        <div class="settings-group"><div class="settings-group-title">AList 云盘设置</div></div>
        <div class="field-full"><label>AList 内部通信地址</label><input id="alistUrl" type="text" placeholder="例如: http://alist:5244" autocomplete="off" /></div>
        <div><label>AList 账号 (WebDAV 用户名)</label><input id="alistUsername" type="text" placeholder="例如: admin" autocomplete="off" /></div>
        <div><label>AList 密码 (WebDAV 密码)</label><input id="alistPassword" type="password" placeholder="密码" autocomplete="new-password" /></div>
        <div class="field-full"><label>目标存储路径</label><input id="alistDest" type="text" placeholder="例如: /阿里云盘/bili-backup/videos" /><p class="muted" style="margin:6px 0 0;font-size:12px;">修改目标路径只影响后续新上传，已有网盘文件不会自动迁移。修改后建议执行 AList 状态对账。</p></div>
        <div class="field-full"><label>上传目录结构</label>
          <select id="uploadLayout">
            <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
            <option value="folder-video">收藏夹名 / 视频</option>
            <option value="video-only">仅视频文件</option>
          </select>
          <p class="muted" style="margin:6px 0 0;font-size:12px;">目录结构变化只影响新任务，不会移动已有远端文件。</p>
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
          <p class="muted" style="width:100%;margin:0;font-size:12px;">Hi-Res / Dolby 需要扫码登录获得 APP token；旧账号如果没有 token，请重新登录后再启用。</p>
        </div>

        <div class="settings-group"><div class="settings-group-title">📌 视频命名模板</div></div>
        <div class="field-full">
          <p class="muted" style="margin-bottom:8px;">点击下方标签添加，拖拽已选标签可调整顺序，点击已选标签可移除。</p>
          <label>可用变量</label>
          <div class="template-tags" id="templateTags"></div>
          <label style="margin-top:12px;">已选变量（可拖拽排序）</label>
          <div class="template-tags" id="selectedTags" style="min-height:40px;border:2px dashed var(--border);border-radius:12px;padding:8px;"></div>
          <label style="margin-top:12px;">当前模板预览</label>
          <div class="template-preview" id="templatePreview"></div>
          <label style="margin-top:12px;">自定义模板（高级）</label>
          <input id="filenameTemplate" type="text" placeholder="例如: <videoTitle>-<ownerName>-<bvid>" />
        </div>

        <div class="settings-group"><div class="settings-group-title">任务队列与重试</div></div>
        <div><label>失败重试次数</label><input id="maxRetries" type="number" min="0" /></div>
        <div><label>重试间隔 (秒)</label><input id="retryDelaySeconds" type="number" min="1" /></div>
        <div><label>同时下载并发数</label><input id="concurrentDownloads" type="number" min="1" max="5" /></div>
        <div><label>同时上传并发数</label><input id="concurrentUploads" type="number" min="1" max="10" /></div>
        <div><label>AList 对账并发数</label><input id="remoteVerifyConcurrency" type="number" min="1" max="10" /></div>
        <div><label>AList 对账限速 (次/秒)</label><input id="remoteVerifyRateLimitPerSecond" type="number" min="0.5" max="20" step="0.5" /></div>
        <div class="field-full"><label>每轮最多补传数量</label><input id="remoteRequeueLimitPerCycle" type="number" min="1" max="500" /></div>
      </div>
      <div class="row" style="margin-top:24px;">
        <button id="saveConfigBtn">保存设置并生效</button>
        <button id="renameBtn" class="rename-btn" style="border:none;color:white;padding:10px 16px;border-radius:12px;cursor:pointer;font-weight:600;transition:all 0.2s;">检查旧命名文件</button>
        <button id="qualityUpgradeBtn" class="ghost" type="button">检查可升级画质</button>
      </div>
      <div class="muted" id="configStatus" style="margin-top:12px;color:var(--accent);"></div>
      <div class="muted" id="renameStatus" style="margin-top:8px;"></div>
      <div class="muted" id="qualityUpgradeStatus" style="margin-top:8px;"></div>
    </section>`;
}

function getLogSection() {
  return `<section class="card">
      <h2>任务日志</h2>
      <div class="log-toggle">
        <button id="logSimpleBtn" class="active">精简模式</button>
        <button id="logRawBtn">原始输出</button>
        <button id="logDebugBtn">调试模式</button>
      </div>
      <div class="log-console" id="logConsole"><span class="log-info">等待日志...</span></div>
    </section>`;
}

function getModals() {
  return `
  <div class="modal" id="loginModal">
    <div class="panel">
      <h2>扫码登录</h2>
      <p class="muted">请使用B站APP扫码登录（TV端接口）。</p>
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
      <div class="filter-toggle" id="videoDetailFilterBar">
        <button id="vdFilterAllBtn" class="active">全部 (0)</button>
        <button id="vdFilterUploadedBtn">已上传 (0)</button>
        <button id="vdFilterPendingBtn">未上传 (0)</button>
        <button id="vdFilterPendingUnavailableBtn">未上传并失效 (0)</button>
        <button id="vdFilterUploadedUnavailableBtn">已上传且失效 (0)</button>
      </div>
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
  </div>

  <div class="modal" id="syncHelpModal">
    <div class="panel" style="max-width:860px;">
      <h2>同步与对账说明</h2>
      <div class="help-tabs">
        <button id="syncHelpSimpleBtn" class="active" type="button">简要介绍</button>
        <button id="syncHelpDetailBtn" type="button">详细介绍</button>
      </div>
      <div id="syncHelpContent"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="closeSyncHelpBtn" class="ghost" style="width:100%;">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="settingsHelpModal">
    <div class="panel" style="max-width:920px;">
      <h2>当前设置执行流程</h2>
      <p class="muted">这里不会保存设置，也不会触发同步，只按当前表单里的值生成说明。</p>
      <div id="settingsFlowContent"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="closeSettingsHelpBtn" class="ghost" style="width:100%;">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="renamePreviewModal">
    <div class="panel" style="max-width:980px;">
      <h2>检查旧命名文件</h2>
      <p class="muted">先预览会改哪些远端文件。只有勾选并二次确认后，才会真正修改 AList 网盘文件名。</p>
      <div id="renamePreviewSummary" class="muted"></div>
      <div class="row" style="margin:8px 0 12px;">
        <button id="renameSelectAllBtn" class="ghost" type="button">全选</button>
        <button id="renameSelectNoneBtn" class="ghost" type="button">取消全选</button>
        <button id="refreshRenamePreviewBtn" class="ghost" type="button">重新预览</button>
      </div>
      <div class="rename-list" id="renamePreviewList"></div>
      <div id="renameSkippedBlock" style="display:none;margin-top:14px;">
        <strong style="color:var(--ink);display:block;margin-bottom:8px;">跳过的文件</strong>
        <div class="rename-skip-list" id="renameSkippedList"></div>
      </div>
      <div id="renameResultBlock" class="rename-result" style="display:none;margin-top:14px;"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="executeRenameBtn" type="button" style="flex:1;">确认重命名所选文件</button>
        <button id="closeRenamePreviewBtn" class="ghost" type="button" style="flex:1;">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="qualityUpgradeModal">
    <div class="panel" style="max-width:980px;">
      <h2>检查可升级画质</h2>
      <p class="muted">按当前 BBDown 画质、编码、Hi-Res、杜比设置重新下载。新版文件上传并验证成功后，才会删除旧远端文件。</p>
      <div id="qualityUpgradeSummary" class="muted"></div>
      <div class="row" style="margin:8px 0 12px;">
        <button id="qualityUpgradeSelectAllBtn" class="ghost" type="button">全选</button>
        <button id="qualityUpgradeSelectNoneBtn" class="ghost" type="button">取消全选</button>
        <button id="refreshQualityUpgradeBtn" class="ghost" type="button">重新预览</button>
      </div>
      <div class="rename-list" id="qualityUpgradeList"></div>
      <div id="qualityUpgradeSkippedBlock" style="display:none;margin-top:14px;">
        <strong style="color:var(--ink);display:block;margin-bottom:8px;">跳过的项目</strong>
        <div class="rename-skip-list" id="qualityUpgradeSkippedList"></div>
      </div>
      <div id="qualityUpgradeResultBlock" class="rename-result" style="display:none;margin-top:14px;"></div>
      <div class="row" style="margin-top:24px;justify-content:center;">
        <button id="executeQualityUpgradeBtn" type="button" style="flex:1;">确认重调所选视频</button>
        <button id="closeQualityUpgradeBtn" class="ghost" type="button" style="flex:1;">关闭</button>
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
    let queueBoardPollTimer = null;
    const queueBoardState = {
      columns: {},
      cards: new Map(),
      renderLimit: 80,
    };
    let unavailableItems = [];
    let unavailableUserId = null;
    let unavailableFilter = 'missing';
    let unavailableCursor = null;
    let unavailableHasMore = true;
    let unavailableLoading = false;
    let videoDetailState = {
      userId: null,
      mediaId: null,
      filter: 'all',
      summary: null,
      page: 0,
      pageSize: 20,
      hasMore: true,
      loading: false,
      token: 0
    };
    let syncHelpMode = 'simple';
    let renamePreviewState = { candidates: [], skipped: [] };
    let qualityUpgradePreviewState = { candidates: [], skipped: [], target: {} };

    function showToast(message, type = 'error') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      const text = document.createElement('div');
      text.textContent = String(message || '');
      toast.appendChild(text);
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', () => toast.remove());
      }, 3500);
    }

    async function fetchJson(url, options) {
      try {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '请求失败');
        return data.data;
      } catch (e) {
        showToast(e.message || String(e), 'error');
        throw e;
      }
    }

    async function fetchJsonSilent(url, options) {
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
      document.getElementById('remoteVerifyConcurrency').value = d.remoteVerifyConcurrency ?? 3;
      document.getElementById('remoteVerifyRateLimitPerSecond').value = d.remoteVerifyRateLimitPerSecond ?? 2;
      document.getElementById('remoteRequeueLimitPerCycle').value = d.remoteRequeueLimitPerCycle ?? 20;
      document.getElementById('filenameTemplate').value = d.filenameTemplate || '<videoTitle>-<bvid>';
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
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        maxRetries: Number(document.getElementById('maxRetries').value),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value),
        remoteVerifyConcurrency: Number(document.getElementById('remoteVerifyConcurrency').value),
        remoteVerifyRateLimitPerSecond: Number(document.getElementById('remoteVerifyRateLimitPerSecond').value),
        remoteRequeueLimitPerCycle: Number(document.getElementById('remoteRequeueLimitPerCycle').value),
      };
      try {
        await fetchJson('/api/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        st.textContent = '设置已保存。轮询间隔和并发数立即生效；画质、编码、命名模板、重试次数、AList 路径等对新任务生效，正在运行的任务不会中途切换。'; st.style.color = 'var(--accent)';
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
      const init = document.getElementById('filenameTemplate').value || '<videoTitle>-<bvid>';
      selectedKeys = TEMPLATE_VARS.filter(v => init.includes(v.key)).map(v => v.key);
      selectedKeys.sort((a,b) => init.indexOf(a) - init.indexOf(b));
      renderSelected();
      document.getElementById('filenameTemplate').addEventListener('input', updateTemplatePreview);
    }

    function renderSelected() {
      const box = document.getElementById('selectedTags');
      box.innerHTML = '';
      if (!selectedKeys.length) {
        const hint = document.createElement('span');
        hint.style.color = 'var(--muted)';
        hint.style.fontSize = '13px';
        hint.style.padding = '4px';
        hint.textContent = '点击上方标签添加到此处';
        box.appendChild(hint);
        return;
      }
      selectedKeys.forEach((key, i) => {
        const v = TEMPLATE_VARS.find(t => t.key === key);
        if (!v) return;
        const t = document.createElement('span');
        t.className = 'template-tag selected';
        t.draggable = true;
        t.textContent = v.label;
        const remove = document.createElement('span');
        remove.className = 'remove-x';
        remove.textContent = '\u00d7';
        t.appendChild(remove);
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
        remove.addEventListener('click', (e) => {
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
      const tpl = document.getElementById('filenameTemplate').value || '<videoTitle>-<bvid>';
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

    function readCurrentConfigForm() {
      return {
        pollIntervalMinutes: Number(document.getElementById('pollInterval').value || 10),
        perVideoDelaySeconds: Number(document.getElementById('delaySeconds').value || 0),
        uploadLayout: document.getElementById('uploadLayout').value,
        alistDest: document.getElementById('alistDest').value.trim() || '/bili-backup/videos',
        bbdownEncoding: document.getElementById('bbdownEncoding').value || '\u81ea\u52a8',
        bbdownQuality: document.getElementById('bbdownQuality').value || '\u81ea\u52a8\u6700\u9ad8',
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        maxRetries: Number(document.getElementById('maxRetries').value || 3),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value || 5),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value || 1),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value || 2),
        remoteVerifyConcurrency: Number(document.getElementById('remoteVerifyConcurrency').value || 3),
        remoteVerifyRateLimitPerSecond: Number(document.getElementById('remoteVerifyRateLimitPerSecond').value || 2),
        remoteRequeueLimitPerCycle: Number(document.getElementById('remoteRequeueLimitPerCycle').value || 20),
      };
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    }

    function renderSyncHelp() {
      const content = document.getElementById('syncHelpContent');
      document.getElementById('syncHelpSimpleBtn').classList.toggle('active', syncHelpMode === 'simple');
      document.getElementById('syncHelpDetailBtn').classList.toggle('active', syncHelpMode === 'detail');
      if (syncHelpMode === 'simple') {
        content.innerHTML = '<div class="help-card-grid">' +
          '<div class="help-card"><strong>\u7acb\u5373\u540c\u6b65</strong><div>\u73b0\u5728\u5c31\u770b\u4e00\u773c\u4f60\u9009\u4e2d\u7684\u6536\u85cf\u5939\uff0c\u6709\u65b0\u89c6\u9891\u5c31\u653e\u8fdb\u4e0b\u8f7d\u548c\u4e0a\u4f20\u961f\u5217\u3002\u9002\u5408\u5e73\u65f6\u65e5\u5e38\u66f4\u65b0\u3002</div></div>' +
          '<div class="help-card"><strong>\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5 AList\uff09</strong><div>\u4e0d\u91cd\u65b0\u7ffb B \u7ad9\u6536\u85cf\u5939\uff0c\u4e3b\u8981\u68c0\u67e5\u7a0b\u5e8f\u8bb0\u5f55\u8fc7\u7684\u7f51\u76d8\u6587\u4ef6\u8fd8\u5728\u4e0d\u5728\u3002\u9002\u5408\u6000\u7591\u7f51\u76d8\u6587\u4ef6\u88ab\u79fb\u52a8\u6216\u5220\u9664\u65f6\u4f7f\u7528\u3002</div></div>' +
          '<div class="help-card"><strong>\u5168\u91cf\u626b\u63cf\u5e76\u5bf9\u8d26</strong><div>\u4ece\u5934\u66f4\u5b8c\u6574\u5730\u626b\u63cf\u6536\u85cf\u5939\uff0c\u5e76\u68c0\u67e5 AList \u8fdc\u7aef\u72b6\u6001\u3002\u6700\u5168\u9762\u4f46\u66f4\u6162\uff0c\u8bf7\u6c42\u4e5f\u66f4\u591a\u3002</div></div>' +
          '</div>';
        return;
      }
      content.innerHTML = '<div class="help-card-grid">' +
        '<div class="help-card"><strong>\u7acb\u5373\u540c\u6b65</strong><ul><li>\u6309\u5f53\u524d\u8c03\u5ea6\u7b56\u7565\u626b\u63cf\u70ed\u95e8\u9875\u548c\u90e8\u5206\u5386\u53f2\u9875\u3002</li><li>\u53d1\u73b0\u672a\u5907\u4efd\u89c6\u9891\u540e\u8fdb\u5165\u4e0b\u8f7d\u961f\u5217\u3002</li><li>\u9002\u5408\u65e5\u5e38\u589e\u91cf\u540c\u6b65\uff0c\u6210\u672c\u6700\u4f4e\u3002</li></ul></div>' +
        '<div class="help-card"><strong>\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5 AList\uff09</strong><ul><li>\u8df3\u8fc7 B \u7ad9\u6536\u85cf\u5939\u5168\u91cf\u626b\u63cf\u3002</li><li>\u6839\u636e\u672c\u5730 state.json \u4e2d\u7684 remoteFiles \u68c0\u67e5\u8fdc\u7aef\u6587\u4ef6\u662f\u5426\u5b58\u5728\u3002</li><li>\u53d1\u73b0\u7f3a\u5931\u540e\u6309\u8865\u4f20\u4e0a\u9650\u91cd\u65b0\u6392\u961f\u3002</li></ul></div>' +
        '<div class="help-card"><strong>\u5168\u91cf\u626b\u63cf\u5e76\u5bf9\u8d26</strong><ul><li>\u5c3d\u53ef\u80fd\u91cd\u65b0\u626b\u63cf\u6536\u85cf\u5939\u6240\u6709\u9875\u9762\u3002</li><li>\u540c\u65f6\u6267\u884c\u8fdc\u7aef\u6587\u4ef6\u6821\u9a8c\uff0c\u9002\u5408\u9996\u6b21\u8865\u9f50\u6216\u8fc1\u79fb\u76ee\u5f55\u540e\u4f7f\u7528\u3002</li><li>\u8bf7\u6c42\u91cf\u66f4\u5927\uff0c\u53ef\u80fd\u89e6\u53d1 412\u3001\u767b\u5f55\u6821\u9a8c\u6216\u98ce\u63a7\u3002</li></ul></div>' +
        '</div>';
    }

    function openSyncHelp() {
      syncHelpMode = 'simple';
      renderSyncHelp();
      document.getElementById('syncHelpModal').classList.add('active');
    }

    function renderSettingsFlow() {
      const c = readCurrentConfigForm();
      const layoutText = c.uploadLayout === 'user-folder-video' ? '\u7528\u6237\u540d / \u6536\u85cf\u5939\u540d / \u89c6\u9891' : (c.uploadLayout === 'folder-video' ? '\u6536\u85cf\u5939\u540d / \u89c6\u9891' : '\u4ec5\u89c6\u9891\u6587\u4ef6');
      const audioText = [c.bbdownHiRes ? 'Hi-Res' : '', c.bbdownDolby ? 'Dolby' : ''].filter(Boolean).join(' + ') || '\u666e\u901a\u97f3\u9891';
      document.getElementById('settingsFlowContent').innerHTML =
        '<div class="flow-visual">' +
          '<div class="flow-step"><div class="badge">\u81ea\u52a8\u8f6e\u8be2</div><div class="desc">\u7a0b\u5e8f\u6bcf <strong>' + escapeHtml(c.pollIntervalMinutes) + ' \u5206\u949f</strong>\u81ea\u52a8\u68c0\u67e5\u4e00\u6b21\uff1b\u624b\u52a8\u6309\u94ae\u4f1a\u989d\u5916\u63d2\u961f\u89e6\u53d1\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u626b\u63cf\u6536\u85cf\u5939</div><div class="desc">\u53d1\u73b0\u65b0\u89c6\u9891\u540e\u6309\u5f53\u524d\u547d\u540d\u6a21\u677f\u51c6\u5907\u4efb\u52a1\uff1a<code>' + escapeHtml(c.filenameTemplate) + '</code></div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0b\u8f7d\u961f\u5217</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0b\u8f7d <strong>' + escapeHtml(c.concurrentDownloads) + '</strong> \u4e2a\uff1b\u753b\u8d28\u4e3a <strong>' + escapeHtml(c.bbdownQuality) + '</strong>\uff0c\u7f16\u7801\u4e3a <strong>' + escapeHtml(c.bbdownEncoding) + '</strong>\uff0c\u97f3\u9891\u9009\u9879\u4e3a <strong>' + escapeHtml(audioText) + '</strong>\uff1b\u5206P\u4e4b\u95f4\u5ef6\u8fdf <strong>' + escapeHtml(c.perVideoDelaySeconds) + ' \u79d2</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u5931\u8d25\u91cd\u8bd5</div><div class="desc">\u4e0b\u8f7d\u6216\u4e0a\u4f20\u5931\u8d25\u540e\u6700\u591a\u91cd\u8bd5 <strong>' + escapeHtml(c.maxRetries) + '</strong> \u6b21\uff0c\u6bcf\u6b21\u95f4\u9694 <strong>' + escapeHtml(c.retryDelaySeconds) + ' \u79d2</strong>\uff1b\u4e0b\u8f7d\u5361\u4f4f\u8d85\u8fc7 30 \u5206\u949f\u4e14\u6700\u8fd1 10 \u5206\u949f\u4f4e\u4e8e 10KB/s \u4f1a\u81ea\u52a8\u8fdb\u5165\u91cd\u8bd5\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0a\u4f20 AList</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0a\u4f20 <strong>' + escapeHtml(c.concurrentUploads) + '</strong> \u4e2a\uff1b\u76ee\u6807\u8def\u5f84\u662f <code>' + escapeHtml(c.alistDest) + '</code>\uff0c\u76ee\u5f55\u7ed3\u6784\u662f <strong>' + escapeHtml(layoutText) + '</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u72b6\u6001\u5bf9\u8d26</div><div class="desc">AList \u5bf9\u8d26\u5e76\u53d1 <strong>' + escapeHtml(c.remoteVerifyConcurrency) + '</strong>\uff0c\u9650\u901f <strong>' + escapeHtml(c.remoteVerifyRateLimitPerSecond) + ' \u6b21/\u79d2</strong>\uff0c\u6bcf\u8f6e\u6700\u591a\u8865\u4f20 <strong>' + escapeHtml(c.remoteRequeueLimitPerCycle) + '</strong> \u4e2a\u7f3a\u5931\u89c6\u9891\u3002</div></div>' +
        '</div>' +
        '<div class="effect-groups">' +
          '<div class="effect-group"><strong>\u7acb\u5373\u751f\u6548</strong><div>\u8f6e\u8be2\u95f4\u9694\u3001\u540c\u65f6\u4e0b\u8f7d\u5e76\u53d1\u6570\u3001\u540c\u65f6\u4e0a\u4f20\u5e76\u53d1\u6570\u3002</div></div>' +
          '<div class="effect-group"><strong>\u65b0\u4efb\u52a1\u751f\u6548</strong><div>\u753b\u8d28\u3001\u7f16\u7801\u3001Hi-Res / Dolby\u3001\u547d\u540d\u6a21\u677f\u3001AList \u8def\u5f84\u3001\u4e0a\u4f20\u76ee\u5f55\u7ed3\u6784\u3001\u5931\u8d25\u91cd\u8bd5\u6b21\u6570\u3001\u91cd\u8bd5\u95f4\u9694\u3002</div></div>' +
          '<div class="effect-group"><strong>\u5bf9\u8d26\u65f6\u751f\u6548</strong><div>AList \u5bf9\u8d26\u5e76\u53d1\u6570\u3001AList \u5bf9\u8d26\u9650\u901f\u3001\u6bcf\u8f6e\u6700\u591a\u8865\u4f20\u6570\u91cf\u3002</div></div>' +
        '</div>' +
        '<p class="muted" style="margin-top:14px;">\u4fee\u6539 AList \u8def\u5f84\u6216\u76ee\u5f55\u7ed3\u6784\u4e0d\u4f1a\u642c\u52a8\u65e7\u6587\u4ef6\uff1b\u547d\u540d\u6a21\u677f\u53ea\u5f71\u54cd\u65b0\u4e0b\u8f7d\uff0c\u65e7\u6587\u4ef6\u8bf7\u901a\u8fc7\u201c\u68c0\u67e5\u65e7\u547d\u540d\u6587\u4ef6\u201d\u9884\u89c8\u540e\u518d\u786e\u8ba4\u91cd\u547d\u540d\u3002</p>';
    }

    function openSettingsHelp() {
      renderSettingsFlow();
      document.getElementById('settingsHelpModal').classList.add('active');
    }

    async function openRenamePreview() {
      document.getElementById('renamePreviewModal').classList.add('active');
      await loadRenamePreview();
    }

    async function loadRenamePreview() {
      const btn = document.getElementById('renameBtn');
      const st = document.getElementById('renameStatus');
      const summary = document.getElementById('renamePreviewSummary');
      const list = document.getElementById('renamePreviewList');
      const resultBlock = document.getElementById('renameResultBlock');
      btn.textContent = '检查中...';
      st.textContent = '';
      summary.textContent = '正在扫描 AList 远端文件...';
      list.innerHTML = '';
      resultBlock.style.display = 'none';
      try {
        renamePreviewState = await fetchJson('/api/rename/preview', { method:'POST' });
        renderRenamePreview();
        st.textContent = '已生成重命名预览：' + renamePreviewState.candidates.length + ' 个可处理，' + renamePreviewState.skipped.length + ' 个跳过。';
        st.style.color = 'var(--muted)';
      } catch(e) {
        summary.textContent = '预览失败：' + e.message;
        st.textContent = '预览失败: ' + e.message;
        st.style.color = '#E57373';
      } finally {
        btn.textContent = '检查旧命名文件';
      }
    }

    function renderRenamePreview() {
      const candidates = Array.isArray(renamePreviewState.candidates) ? renamePreviewState.candidates : [];
      const skipped = Array.isArray(renamePreviewState.skipped) ? renamePreviewState.skipped : [];
      const summary = document.getElementById('renamePreviewSummary');
      const list = document.getElementById('renamePreviewList');
      const skippedBlock = document.getElementById('renameSkippedBlock');
      const skippedList = document.getElementById('renameSkippedList');
      summary.textContent = '发现 ' + candidates.length + ' 个可安全重命名的远端文件，' + skipped.length + ' 个文件已跳过。';
      list.innerHTML = '';
      if (!candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = '没有找到可安全重命名的旧命名文件。';
        list.appendChild(empty);
      }
      candidates.forEach((item, index) => {
        const row = document.createElement('label');
        row.className = 'rename-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.renameIndex = String(index);
        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'rename-title';
        title.textContent = (item.title || item.bvid || '未知视频') + ' · ' + (item.ownerName || '未知UP');
        const name = document.createElement('div');
        name.className = 'rename-path';
        name.innerHTML = '<strong>旧文件：</strong>' + escapeHtml(item.oldName || '') + '<br><span class="rename-arrow">→</span> <strong>新文件：</strong>' + escapeHtml(item.newName || '');
        const path = document.createElement('div');
        path.className = 'rename-path';
        path.textContent = '目录：' + (item.remoteDir || '');
        const reason = document.createElement('div');
        reason.className = 'rename-path';
        reason.textContent = item.reason || '文件名和本地状态匹配，可重命名。';
        body.appendChild(title);
        body.appendChild(name);
        body.appendChild(path);
        body.appendChild(reason);
        row.appendChild(checkbox);
        row.appendChild(body);
        list.appendChild(row);
      });
      if (skipped.length) {
        skippedBlock.style.display = 'block';
        skippedList.innerHTML = '';
        skipped.forEach((item) => {
          const div = document.createElement('div');
          div.textContent = (item.path || '<未知路径>') + '：' + (item.reason || '已跳过');
          skippedList.appendChild(div);
        });
      } else {
        skippedBlock.style.display = 'none';
        skippedList.innerHTML = '';
      }
    }

    function setRenameSelection(checked) {
      document.querySelectorAll('#renamePreviewList input[type="checkbox"]').forEach((input) => {
        input.checked = checked;
      });
    }

    async function executeSelectedRename() {
      const candidates = Array.isArray(renamePreviewState.candidates) ? renamePreviewState.candidates : [];
      const selected = [];
      document.querySelectorAll('#renamePreviewList input[type="checkbox"]').forEach((input) => {
        const index = Number(input.dataset.renameIndex);
        if (input.checked && Number.isInteger(index) && candidates[index]) {
          selected.push(candidates[index]);
        }
      });
      if (!selected.length) {
        showToast('请先勾选需要重命名的文件', 'info');
        return;
      }
      if (!confirm('将重命名 ' + selected.length + ' 个远端文件。此操作会修改 AList 网盘文件名，是否继续？')) {
        return;
      }
      const btn = document.getElementById('executeRenameBtn');
      const resultBlock = document.getElementById('renameResultBlock');
      btn.textContent = '重命名中...';
      btn.disabled = true;
      resultBlock.style.display = 'block';
      resultBlock.textContent = '正在执行远端重命名...';
      try {
        const payload = selected.map((item) => ({ bvid:item.bvid, oldPath:item.oldPath, newPath:item.newPath }));
        const chunkSize = 100;
        const allResults = [];
        let success = 0;
        let failed = 0;
        for (let start = 0; start < payload.length; start += chunkSize) {
          const chunk = payload.slice(start, start + chunkSize);
          const batchIndex = Math.floor(start / chunkSize) + 1;
          const batchTotal = Math.ceil(payload.length / chunkSize);
          resultBlock.textContent = '正在执行远端重命名：第 ' + batchIndex + '/' + batchTotal + ' 批（已处理 ' + start + '/' + payload.length + '）...';
          const result = await fetchJson('/api/rename', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ items:chunk })
          });
          success += Number(result.success || 0);
          failed += Number(result.failed || 0);
          if (Array.isArray(result.results)) {
            allResults.push(...result.results);
          }
        }
        const lines = ['完成：成功 ' + success + ' 个，失败 ' + failed + ' 个。'];
        allResults.forEach((item) => {
          lines.push((item.ok ? '成功：' : '失败：') + item.oldPath + ' → ' + item.newPath + (item.error ? '，原因：' + item.error : ''));
        });
        resultBlock.textContent = lines.join('\\n');
        showToast('远端重命名完成', failed ? 'info' : 'success');
      } catch(e) {
        resultBlock.textContent = '重命名失败：' + e.message;
      } finally {
        btn.textContent = '确认重命名所选文件';
        btn.disabled = false;
      }
    }

    async function openQualityUpgradePreview() {
      document.getElementById('qualityUpgradeModal').classList.add('active');
      await loadQualityUpgradePreview();
    }

    async function loadQualityUpgradePreview() {
      const btn = document.getElementById('qualityUpgradeBtn');
      const st = document.getElementById('qualityUpgradeStatus');
      const summary = document.getElementById('qualityUpgradeSummary');
      const list = document.getElementById('qualityUpgradeList');
      const resultBlock = document.getElementById('qualityUpgradeResultBlock');
      btn.textContent = '检查中...';
      st.textContent = '';
      summary.textContent = '正在读取本地远端记录...';
      list.innerHTML = '';
      resultBlock.style.display = 'none';
      try {
        qualityUpgradePreviewState = await fetchJson('/api/quality-upgrade/preview', { method:'POST' });
        renderQualityUpgradePreview();
        st.textContent = '已生成画质重调预览：' + qualityUpgradePreviewState.candidates.length + ' 个可处理，' + qualityUpgradePreviewState.skipped.length + ' 个跳过。';
        st.style.color = 'var(--muted)';
      } catch(e) {
        summary.textContent = '预览失败：' + e.message;
        st.textContent = '预览失败: ' + e.message;
        st.style.color = '#E57373';
      } finally {
        btn.textContent = '检查可升级画质';
      }
    }

    function renderQualityUpgradePreview() {
      const candidates = Array.isArray(qualityUpgradePreviewState.candidates) ? qualityUpgradePreviewState.candidates : [];
      const skipped = Array.isArray(qualityUpgradePreviewState.skipped) ? qualityUpgradePreviewState.skipped : [];
      const target = qualityUpgradePreviewState.target || {};
      const summary = document.getElementById('qualityUpgradeSummary');
      const list = document.getElementById('qualityUpgradeList');
      const skippedBlock = document.getElementById('qualityUpgradeSkippedBlock');
      const skippedList = document.getElementById('qualityUpgradeSkippedList');
      const targetText = [target.quality ? '清晰度 ' + target.quality : '', target.encoding ? '编码 ' + target.encoding : '', target.hiRes ? 'Hi-Res' : '', target.dolby ? '杜比' : ''].filter(Boolean).join(' / ') || '当前默认画质设置';
      summary.textContent = '目标：' + targetText + '。发现 ' + candidates.length + ' 个可重新下载并替换的远端记录，' + skipped.length + ' 个项目已跳过。';
      list.innerHTML = '';
      if (!candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = '没有找到可重调画质的已上传视频记录。';
        list.appendChild(empty);
      }
      candidates.forEach((item, index) => {
        const row = document.createElement('label');
        row.className = 'rename-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.dataset.qualityUpgradeIndex = String(index);
        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'rename-title';
        title.textContent = (item.title || item.bvid || '未知视频') + ' · ' + (item.ownerName || '未知UP');
        const folder = document.createElement('div');
        folder.className = 'rename-path';
        folder.textContent = '收藏夹：' + (item.folderTitle || 'favorites') + '；目录：' + (item.remotePath || '');
        const files = document.createElement('div');
        files.className = 'rename-path';
        files.textContent = '将替换旧文件：' + (item.oldFiles || []).map((file) => file.name || file.path).join('，');
        const reason = document.createElement('div');
        reason.className = 'rename-path';
        reason.textContent = item.reason || '按当前画质设置重新下载，上传验证成功后删除旧文件。';
        body.appendChild(title);
        body.appendChild(folder);
        body.appendChild(files);
        body.appendChild(reason);
        row.appendChild(checkbox);
        row.appendChild(body);
        list.appendChild(row);
      });
      if (skipped.length) {
        skippedBlock.style.display = 'block';
        skippedList.innerHTML = '';
        skipped.forEach((item) => {
          const div = document.createElement('div');
          div.textContent = (item.title || item.bvid || item.folderTitle || '<未知项目>') + '：' + (item.reason || '已跳过');
          skippedList.appendChild(div);
        });
      } else {
        skippedBlock.style.display = 'none';
        skippedList.innerHTML = '';
      }
    }

    function setQualityUpgradeSelection(checked) {
      document.querySelectorAll('#qualityUpgradeList input[type="checkbox"]').forEach((input) => {
        input.checked = checked;
      });
    }

    async function executeSelectedQualityUpgrade() {
      const candidates = Array.isArray(qualityUpgradePreviewState.candidates) ? qualityUpgradePreviewState.candidates : [];
      const selected = [];
      document.querySelectorAll('#qualityUpgradeList input[type="checkbox"]').forEach((input) => {
        const index = Number(input.dataset.qualityUpgradeIndex);
        if (input.checked && Number.isInteger(index) && candidates[index]) {
          selected.push(candidates[index]);
        }
      });
      if (!selected.length) {
        showToast('请先勾选需要重调画质的视频', 'info');
        return;
      }
      if (!confirm('将为 ' + selected.length + ' 个视频重新下载并上传新版文件。新版验证成功后会删除旧远端文件，是否继续？')) {
        return;
      }
      const btn = document.getElementById('executeQualityUpgradeBtn');
      const resultBlock = document.getElementById('qualityUpgradeResultBlock');
      btn.textContent = '提交中...';
      btn.disabled = true;
      resultBlock.style.display = 'block';
      resultBlock.textContent = '正在提交画质重调任务...';
      try {
        const result = await fetchJson('/api/quality-upgrade', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ items:selected.map((item) => ({ key:item.key })) })
        });
        const queued = Array.isArray(result.queued) ? result.queued : [];
        const skipped = Array.isArray(result.skipped) ? result.skipped : [];
        const lines = ['已提交：' + queued.length + ' 个；跳过：' + skipped.length + ' 个。任务会在后台逐个执行，可在日志中查看进度。'];
        queued.forEach((item) => lines.push('已提交：' + item.bvid + ' ' + (item.title || '')));
        skipped.forEach((item) => lines.push('跳过：' + (item.key || '<未知>') + '，原因：' + (item.reason || '未知')));
        resultBlock.textContent = lines.join('\\n');
        showToast('画质重调任务已提交', 'success');
        await loadQualityUpgradeState();
      } catch(e) {
        resultBlock.textContent = '提交失败：' + e.message;
      } finally {
        btn.textContent = '确认重调所选视频';
        btn.disabled = false;
      }
    }

    async function loadQualityUpgradeState() {
      const st = document.getElementById('qualityUpgradeStatus');
      try {
        const data = await fetchJsonSilent('/api/quality-upgrade/state');
        const running = Array.isArray(data.running) ? data.running : [];
        const completed = Array.isArray(data.completed) ? data.completed : [];
        if (!running.length && !completed.length) return;
        st.textContent = '画质重调：运行中 ' + running.length + ' 个；最近完成/失败 ' + completed.length + ' 个。';
        st.style.color = 'var(--muted)';
      } catch(e) {
        st.textContent = '画质重调状态读取失败: ' + e.message;
        st.style.color = '#E57373';
      }
    }

    // ---- Users ----
    async function loadUsers() {
      const users = await fetchJson('/api/users');
      const el = document.getElementById('userList');
      el.innerHTML = '';
      users.forEach(user => {
        const item = document.createElement('div');
        item.className = 'user-item';

        const name = document.createElement('strong');
        name.style.fontSize = '16px';
        name.style.color = 'var(--accent)';
        name.textContent = user.name || '';

        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.style.margin = '0';
        meta.textContent = 'UID: ' + user.uid + ' | 收藏夹: ' + user.favoritesCount + ' | ' + (user.expiresText || '未知过期时间');

        const favoritesWrap = document.createElement('div');
        favoritesWrap.style.margin = '4px 0';
        for (const favorite of (user.favorites || [])) {
          const chip = document.createElement('span');
          chip.style.display = 'inline-block';
          chip.style.padding = '4px 10px';
          chip.style.background = 'rgba(57,197,187,0.1)';
          chip.style.borderRadius = '8px';
          chip.style.fontSize = '12px';
          chip.style.margin = '2px';
          chip.textContent = favorite.title || '';
          favoritesWrap.appendChild(chip);
        }

        const actions = document.createElement('div');
        actions.className = 'row';
        actions.style.marginTop = '4px';

        const favoritesBtn = document.createElement('button');
        favoritesBtn.dataset.action = 'favorites';
        favoritesBtn.dataset.id = String(user.id || '');
        favoritesBtn.textContent = '选择同步收藏夹';

        const unavailableBtn = document.createElement('button');
        unavailableBtn.className = 'ghost';
        unavailableBtn.dataset.action = 'unavailable';
        unavailableBtn.dataset.id = String(user.id || '');
        unavailableBtn.textContent = '下架清单';

        const refreshInfoBtn = document.createElement('button');
        refreshInfoBtn.className = 'ghost';
        refreshInfoBtn.dataset.action = 'refresh_info';
        refreshInfoBtn.dataset.id = String(user.id || '');
        refreshInfoBtn.textContent = '刷新信息';

        const refreshAuthBtn = document.createElement('button');
        refreshAuthBtn.className = 'ghost';
        refreshAuthBtn.dataset.action = 'refresh_auth';
        refreshAuthBtn.dataset.id = String(user.id || '');
        refreshAuthBtn.textContent = '更新授权';

        const copyCookieBtn = document.createElement('button');
        copyCookieBtn.className = 'ghost';
        copyCookieBtn.dataset.action = 'copy_cookie';
        copyCookieBtn.dataset.id = String(user.id || '');
        copyCookieBtn.textContent = '复制Cookie';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ghost';
        toggleBtn.dataset.action = 'toggle';
        toggleBtn.dataset.id = String(user.id || '');
        toggleBtn.textContent = user.enabled ? '暂停同步' : '启用同步';

        const removeBtn = document.createElement('button');
        removeBtn.className = 'ghost';
        removeBtn.style.borderColor = '#E57373';
        removeBtn.style.color = '#E57373';
        removeBtn.dataset.action = 'remove';
        removeBtn.dataset.id = String(user.id || '');
        removeBtn.textContent = '删除账号';

        actions.appendChild(favoritesBtn);
        actions.appendChild(unavailableBtn);
        actions.appendChild(refreshInfoBtn);
        actions.appendChild(refreshAuthBtn);
        actions.appendChild(copyCookieBtn);
        actions.appendChild(toggleBtn);
        actions.appendChild(removeBtn);

        item.appendChild(name);
        item.appendChild(meta);
        if (user.lastAuthRefreshError) {
          const authErr = document.createElement('div');
          authErr.className = 'muted';
          authErr.style.margin = '0';
          authErr.style.color = '#E57373';
          authErr.style.fontSize = '12px';
          authErr.textContent = '授权刷新失败: ' + user.lastAuthRefreshError;
          item.appendChild(authErr);
        }
        item.appendChild(favoritesWrap);
        item.appendChild(actions);
        el.appendChild(item);
      });
    }

    // ---- Login ----
    async function startLogin() {
      document.getElementById('loginStatus').textContent = '正在生成二维码...';
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
          document.getElementById('loginStatus').textContent = '登录成功';
          currentLoginId=null;
          setTimeout(()=>{ document.getElementById('loginModal').classList.remove('active'); loadUsers(); },1000);
        } else if (d.status==='error') {
          document.getElementById('loginStatus').textContent = d.message||'异常'; currentLoginId=null;
        } else {
          document.getElementById('loginStatus').textContent = '等待扫码中...';
          setTimeout(pollLoginStatus, 1500);
        }
      } catch(e) { document.getElementById('loginStatus').textContent = e.message; currentLoginId=null; }
    }

    // ---- Favorites (with thumbnails) ----
    async function openFavorites(userId) {
      favoritesUserId = userId;
      document.getElementById('favoritesStatus').textContent = '';
      const list = document.getElementById('favoritesList');
      list.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'muted';
      loading.style.textAlign = 'center';
      loading.textContent = '加载中...';
      list.appendChild(loading);
      document.getElementById('favoritesModal').classList.add('active');
      const data = await fetchJson('/api/users/'+userId+'/favorites');
      list.innerHTML = '';
      data.forEach(folder => {
        const lbl = document.createElement('label');
        lbl.className = 'fav-label';
        const coverUrl = folder.cover ? folder.cover.replace('http://','https://') : '';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = String(folder.mediaId);
        checkbox.checked = Boolean(folder.selected);
        lbl.appendChild(checkbox);

        if (coverUrl) {
          const img = document.createElement('img');
          img.className = 'fav-cover';
          img.src = coverUrl;
          img.referrerPolicy = 'no-referrer';
          img.loading = 'lazy';
          lbl.appendChild(img);
        } else {
          const cover = document.createElement('div');
          cover.className = 'fav-cover';
          lbl.appendChild(cover);
        }

        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.minWidth = '0';

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent = folder.title || '';

        const count = document.createElement('div');
        count.style.fontSize = '12px';
        count.style.color = 'var(--muted)';
        count.textContent = String(folder.mediaCount || 0) + ' 个视频';

        content.appendChild(title);
        content.appendChild(count);
        lbl.appendChild(content);

        const detail = document.createElement('button');
        detail.className = 'ghost';
        detail.style.padding = '4px 12px';
        detail.style.fontSize = '12px';
        detail.style.flexShrink = '0';
        detail.dataset.detailMedia = String(folder.mediaId);
        detail.dataset.detailTitle = folder.title || '';
        detail.textContent = '查看详情';
        lbl.appendChild(detail);
        list.appendChild(lbl);
      });
    }

    // ---- Video Detail Modal ----
    function renderVideoDetailItem(item) {
      const div = document.createElement('div');
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
        badgeText = '已备份';
      } else if (item.failed) {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = '下载失败';
      } else {
        stateClass = '';
        badgeClass = 'pending';
        badgeText = '待备份';
      }

      div.className = 'video-item ' + stateClass;
      const coverUrl = item.cover ? item.cover.replace('http://','https://') : '';
      if (coverUrl) {
        const img = document.createElement('img');
        img.className = 'video-cover';
        img.src = coverUrl;
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        div.appendChild(img);
      } else {
        const cover = document.createElement('div');
        cover.className = 'video-cover';
        div.appendChild(cover);
      }

      const info = document.createElement('div');
      info.className = 'video-info';
      const titleEl = document.createElement('div');
      titleEl.className = 'video-title';
      titleEl.title = item.title || '';
      titleEl.textContent = item.title || '';
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.textContent = 'UP: ' + (item.upperName || 'Unknown') + ' | ' + item.bvid;
      info.appendChild(titleEl);
      info.appendChild(meta);
      div.appendChild(info);

      const badge = document.createElement('span');
      badge.className = 'video-badge ' + badgeClass;
      badge.textContent = badgeText;
      div.appendChild(badge);
      return div;
    }

    function setGridStatus(gridId, marker, text, isError) {
      const grid = document.getElementById(gridId);
      let status = grid.querySelector('[data-status-marker="' + marker + '"]');
      if (!status) {
        status = document.createElement('div');
        status.dataset.statusMarker = marker;
        grid.appendChild(status);
      }
      status.className = 'video-detail-status' + (isError ? ' error' : '');
      status.textContent = text || '';
      if (!text) status.remove();
    }

    function setVideoDetailStatus(text, isError) {
      setGridStatus('videoGrid', 'video-detail', text, isError);
    }

    const videoDetailFilterButtons = [
      { id: 'vdFilterAllBtn', filter: 'all' },
      { id: 'vdFilterUploadedBtn', filter: 'uploaded' },
      { id: 'vdFilterPendingBtn', filter: 'pending' },
      { id: 'vdFilterPendingUnavailableBtn', filter: 'pending_unavailable' },
      { id: 'vdFilterUploadedUnavailableBtn', filter: 'uploaded_unavailable' },
    ];

    function setVideoDetailFilterActive(filter) {
      videoDetailFilterButtons.forEach(({ id, filter: value }) => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.classList.toggle('active', value === filter);
        }
      });
    }

    function updateVideoDetailFilterCounts(summary) {
      const s = summary || {
        total: 0,
        uploaded: 0,
        pending: 0,
        pendingUnavailable: 0,
        uploadedUnavailable: 0,
      };
      document.getElementById('vdFilterAllBtn').textContent = '全部 (' + (s.total || 0) + ')';
      document.getElementById('vdFilterUploadedBtn').textContent = '已上传 (' + (s.uploaded || 0) + ')';
      document.getElementById('vdFilterPendingBtn').textContent = '未上传 (' + (s.pending || 0) + ')';
      document.getElementById('vdFilterPendingUnavailableBtn').textContent = '未上传并失效 (' + (s.pendingUnavailable || 0) + ')';
      document.getElementById('vdFilterUploadedUnavailableBtn').textContent = '已上传且失效 (' + (s.uploadedUnavailable || 0) + ')';
    }

    function updateVideoDetailIndexHint(indexSummary, filter) {
      let hint = document.getElementById('videoDetailIndexHint');
      const grid = document.getElementById('videoGrid');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'videoDetailIndexHint';
        hint.className = 'video-detail-hint';
        grid.parentElement.insertBefore(hint, grid);
      }
      const indexed = Number(indexSummary && indexSummary.indexed || 0);
      const biliTotal = Number(indexSummary && indexSummary.biliTotal || 0);
      const scanComplete = Boolean(indexSummary && indexSummary.scanComplete);
      const unreturnedCount = Number(indexSummary && indexSummary.unreturnedCount || 0);
      if (!indexSummary || !biliTotal || indexed >= biliTotal) {
        hint.textContent = '';
        hint.style.display = 'none';
        return;
      }
      hint.style.display = 'block';
      if (scanComplete && unreturnedCount > 0) {
        hint.textContent = 'B 站报告收藏夹总数 ' + biliTotal + ' 条；当前接口可索引到 ' + indexed + ' 条视频。全量扫描已完成，剩余 ' + unreturnedCount + ' 条未返回具体视频信息，可能是隐藏、失效、非视频或接口过滤项，不会再提示“继续扫描后补齐”。';
      } else if (filter === 'all') {
        hint.textContent = '全部列表来自 B 站实时数据；状态计数基于已索引 ' + indexed + '/' + biliTotal + ' 条，当前全量扫描尚未完成，继续滚动浏览或执行全量扫描并对账后会补齐。';
      } else {
        hint.textContent = '当前筛选基于已索引 ' + indexed + '/' + biliTotal + ' 条；全量扫描完成前不代表整个收藏夹的最终数量。';
      }
    }

    async function applyVideoDetailFilter(filter) {
      if (!videoDetailState.userId || !videoDetailState.mediaId) return;
      if (videoDetailState.loading) return;
      videoDetailState.token += 1;
      videoDetailState.filter = filter;
      videoDetailState.page = 0;
      videoDetailState.hasMore = true;
      videoDetailState.loading = false;
      setVideoDetailFilterActive(filter);
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '';
      grid.scrollTop = 0;
      await loadNextVideoDetailPage();
    }

    let videoDetailThrottleTimer = null;
    async function loadNextVideoDetailPage() {
      if (videoDetailState.loading || !videoDetailState.hasMore) return;
      const token = videoDetailState.token;
      const nextPage = videoDetailState.page + 1;
      const grid = document.getElementById('videoGrid');
      videoDetailState.loading = true;
      setVideoDetailStatus(nextPage === 1 ? '加载视频列表...' : '加载更多...');
      try {
        const usingLiveSource = (videoDetailState.filter || 'all') === 'all';
        const endpoint = usingLiveSource ? '/detail-items' : '/state-items';
        let url =
          '/api/users/' + videoDetailState.userId +
          '/favorites/' + videoDetailState.mediaId +
          endpoint + '?page=' + nextPage +
          '&pageSize=' + videoDetailState.pageSize +
          '&filter=' + encodeURIComponent(videoDetailState.filter || 'all');
        url += '&folderTitle=' + encodeURIComponent(videoDetailState.title || 'favorites');
        const data = await fetchJson(url);
        if (token !== videoDetailState.token) return;
        videoDetailState.summary = data.summary || null;
        videoDetailState.indexSummary = data.indexSummary || videoDetailState.indexSummary || null;
        updateVideoDetailFilterCounts(videoDetailState.summary);
        updateVideoDetailIndexHint(videoDetailState.indexSummary, videoDetailState.filter || 'all');
        const items = Array.isArray(data.items) ? data.items : [];
        if (nextPage === 1 && items.length === 0) {
          grid.innerHTML = '';
          videoDetailState.page = data.page || nextPage;
          videoDetailState.hasMore = false;
          setVideoDetailStatus(usingLiveSource ? '此收藏夹为空' : '已索引范围内没有匹配视频');
        } else if (Array.isArray(data.items)) {
          const oldStatus = grid.querySelector('[data-status-marker="video-detail"]');
          if (oldStatus) oldStatus.remove();
          items.forEach(item => grid.appendChild(renderVideoDetailItem(item)));
          videoDetailState.page = data.page || nextPage;
          videoDetailState.hasMore = Boolean(data.hasMore);
          setVideoDetailStatus(videoDetailState.hasMore ? '' : '已加载全部');
        } else {
          setVideoDetailStatus('服务器返回数据格式错误', true);
          videoDetailState.hasMore = false;
        }
      } catch(e) {
        if (token !== videoDetailState.token) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/412|风控|risk/i.test(msg)) {
          setVideoDetailStatus('触发B站风控，请等待几分钟后再试', true);
        } else {
          setVideoDetailStatus('加载失败: ' + msg, true);
        }
        videoDetailState.hasMore = false;
      } finally {
        if (token === videoDetailState.token) {
          videoDetailState.loading = false;
        }
      }
    }

    async function openVideoDetail(userId, mediaId, title) {
      videoDetailState.token += 1;
      videoDetailState = {
        userId,
        mediaId,
        title,
        filter: 'all',
        summary: null,
        indexSummary: null,
        page: 0,
        pageSize: 20,
        hasMore: true,
        loading: false,
        token: videoDetailState.token
      };
      document.getElementById('videoDetailTitle').textContent = '📁 ' + title;
      setVideoDetailFilterActive('all');
      updateVideoDetailFilterCounts(null);
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '';
      grid.scrollTop = 0;
      document.getElementById('videoDetailModal').classList.add('active');
      await loadNextVideoDetailPage();
    }

    // ---- Unavailable Videos Modal ----
    async function openUnavailable(userId) {
      unavailableUserId = userId;
      unavailableFilter = 'missing';
      unavailableItems = [];
      unavailableCursor = null;
      unavailableHasMore = true;
      unavailableLoading = false;
      document.getElementById('filterMissingBtn').classList.add('active');
      document.getElementById('filterUploadedBtn').classList.remove('active');
      const grid = document.getElementById('unavailableGrid');
      grid.innerHTML = '';
      document.getElementById('unavailableModal').classList.add('active');
      await loadMoreUnavailable();
    }

    async function loadMoreUnavailable() {
      if (unavailableLoading || !unavailableHasMore || !unavailableUserId) return;
      unavailableLoading = true;
      setGridStatus('unavailableGrid', 'unavailable', unavailableItems.length ? '加载更多...' : '加载中...');
      try {
        const url = '/api/users/' + unavailableUserId + '/unavailable?pageSize=20' +
          (unavailableCursor ? '&cursor=' + encodeURIComponent(unavailableCursor) : '');
        const data = await fetchJson(url);
        unavailableItems.push(...(data.items || []));
        unavailableCursor = data.nextCursor || null;
        unavailableHasMore = !!data.hasMore;
        renderUnavailableList();
      } catch (e) {
        setGridStatus('unavailableGrid', 'unavailable', '加载失败: ' + e.message, true);
        unavailableHasMore = false;
      } finally {
        unavailableLoading = false;
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
      const oldStatus = grid.querySelector('[data-status-marker="unavailable"]');
      if (oldStatus) oldStatus.remove();
      const filtered = (unavailableItems || []).filter(item =>
        item.processed ? unavailableFilter === 'uploaded' : unavailableFilter === 'missing'
      );

      grid.innerHTML = '';
      filtered.forEach(item => {
        const div = renderVideoDetailItem(item);
        const meta = document.createElement('div');
        meta.className = 'video-meta';
        meta.textContent = '收藏夹: ' + (item.folderTitle || '未知');
        const info = div.querySelector('.video-info');
        if (info) info.appendChild(meta);
        grid.appendChild(div);
      });

      if (filtered.length === 0 && !unavailableHasMore) {
        setGridStatus('unavailableGrid', 'unavailable', '暂无符合条件的视频');
      } else if (!unavailableHasMore) {
        setGridStatus('unavailableGrid', 'unavailable', '已加载全部');
      } else {
        setGridStatus('unavailableGrid', 'unavailable', '');
      }
    }

    async function saveFavorites() {
      document.getElementById('saveFavoritesBtn').textContent = '保存中...';
      const selected = Array.from(document.getElementById('favoritesList').querySelectorAll('input:checked')).map(i=>Number(i.value));
      await fetchJson('/api/users/'+favoritesUserId+'/favorites', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mediaIds:selected})
      });
      document.getElementById('saveFavoritesBtn').textContent = '保存选择';
      document.getElementById('favoritesStatus').textContent = '已保存';
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
        if (entry.simpleVisible === false) return;
        div.className = cls;
        div.textContent = time + ' ' + (entry.summary || entry.raw || '');
      } else if (logMode === 'debug') {
        if (entry.debugVisible !== true && entry.level !== 'error' && entry.level !== 'warn') return;
        div.className = cls;
        div.textContent = time + ' ' + (entry.raw || entry.summary || '');
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

    function ensureQueueBoardHost() {
      const logConsole = document.getElementById('logConsole');
      let board = document.getElementById('queueBoard');
      if (!board) {
        board = document.createElement('div');
        board.id = 'queueBoard';
        board.style.display = 'none';
        if (logConsole && logConsole.parentElement) {
          logConsole.parentElement.appendChild(board);
        }
      }
      return board;
    }

    function ensureQueueModeButton() {
      let btn = document.getElementById('logQueueBtn');
      if (btn) return btn;
      const simpleBtn = document.getElementById('logSimpleBtn');
      const wrap = simpleBtn ? simpleBtn.parentElement : null;
      if (!wrap) return null;
      btn = document.createElement('button');
      btn.id = 'logQueueBtn';
      btn.textContent = '队列看板';
      wrap.insertBefore(btn, simpleBtn);
      return btn;
    }

    function formatElapsed(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '0s';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + 'm ' + s + 's';
    }

    function queueElapsedLabel(item) {
      const stage = item.stage || '';
      if (stage === 'download_running') return '运行';
      if (stage === 'upload_running') return '上传';
      return '等待';
    }

    function makeQueueCardKey(item) {
      const userId = item.userId || '';
      const mediaId = item.mediaId || '';
      const bvid = item.bvid || item.id || '';
      const remotePath = item.remotePath || '';
      return [userId, mediaId, bvid, remotePath].join(':');
    }

    function updateQueueCard(card, item, nowMs) {
      card.dataset.queueStage = item.stage || '';
      const titleEl = card.querySelector('.queue-title');
      const metaEl = card.querySelector('.queue-meta');
      const extraEl = card.querySelector('.queue-extra');
      const coverEl = card.querySelector('.queue-cover');
      const coverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      if (coverEl instanceof HTMLImageElement) {
        if (coverUrl && coverEl.src !== coverUrl) coverEl.src = coverUrl;
      } else if (coverUrl && coverEl) {
        const img = document.createElement('img');
        img.className = 'queue-cover';
        img.src = coverUrl;
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        coverEl.replaceWith(img);
      }
      if (titleEl) {
        titleEl.textContent = item.title || item.bvid || 'Unknown';
        titleEl.title = item.title || item.bvid || '';
      }
      if (metaEl) {
        metaEl.textContent = 'UP: ' + (item.upperName || 'Unknown') + ' | ' + (item.bvid || '');
      }
      if (extraEl) {
        const t0 = Number(item.startedAt || item.queuedAt || 0);
        const elapsed = t0 > 0 ? formatElapsed(nowMs - t0) : '0s';
        extraEl.innerHTML = '';
        const retry = document.createElement('span');
        retry.className = 'queue-pill';
        retry.textContent = '重试 ' + Number(item.retries || 0) + '/' + Number(item.maxRetries || 0);
        const time = document.createElement('span');
        time.className = 'queue-pill';
        time.textContent = queueElapsedLabel(item) + ' ' + elapsed;
        extraEl.appendChild(retry);
        extraEl.appendChild(time);
      }
    }

    function renderQueueCard(item, nowMs) {
      const card = document.createElement('div');
      card.className = 'queue-card';
      card.dataset.queueKey = makeQueueCardKey(item);
      const coverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      if (coverUrl) {
        const img = document.createElement('img');
        img.className = 'queue-cover';
        img.src = coverUrl;
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        const cover = document.createElement('div');
        cover.className = 'queue-cover';
        card.appendChild(cover);
      }
      const info = document.createElement('div');
      info.className = 'queue-info';
      const title = document.createElement('div');
      title.className = 'queue-title';
      title.textContent = item.title || item.bvid || 'Unknown';
      title.title = item.title || item.bvid || '';
      const meta = document.createElement('div');
      meta.className = 'queue-meta';
      const extra = document.createElement('div');
      extra.className = 'queue-extra';
      info.appendChild(title);
      info.appendChild(meta);
      info.appendChild(extra);
      card.appendChild(info);
      updateQueueCard(card, item, nowMs);
      return card;
    }

    function ensureQueueColumn(parent, id, title) {
      const existing = queueBoardState.columns[id];
      if (existing && existing.root && existing.root.parentElement === parent) {
        return existing;
      }
      const col = document.createElement('div');
      col.className = 'queue-col';
      col.dataset.queueColumn = id;
      const h = document.createElement('div');
      h.className = 'queue-col-title';
      const left = document.createElement('span');
      left.textContent = title;
      const right = document.createElement('span');
      right.className = 'queue-col-count';
      right.textContent = '0';
      h.appendChild(left);
      h.appendChild(right);
      col.appendChild(h);
      const list = document.createElement('div');
      list.className = 'queue-list';
      col.appendChild(list);
      parent.appendChild(col);
      queueBoardState.columns[id] = { root: col, list, count: right };
      return queueBoardState.columns[id];
    }

    function setQueueEmptyState(column, isEmpty) {
      let empty = column.list.querySelector('[data-queue-empty="1"]');
      if (isEmpty) {
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'queue-empty';
          empty.dataset.queueEmpty = '1';
          empty.textContent = '空队列';
          column.list.appendChild(empty);
        }
      } else if (empty) {
        empty.remove();
      }
    }

    function renderQueueColumn(parent, id, title, items, nowMs, seenKeys) {
      const column = ensureQueueColumn(parent, id, title);
      const allItems = Array.isArray(items) ? items : [];
      const visibleItems = allItems.slice(0, queueBoardState.renderLimit);
      column.count.textContent = String(allItems.length);
      setQueueEmptyState(column, visibleItems.length === 0);
      const oldMore = column.list.querySelector('[data-queue-more="1"]');
      if (oldMore) oldMore.remove();
      visibleItems.forEach((item) => {
        const key = makeQueueCardKey(item);
        seenKeys.add(key);
        let card = queueBoardState.cards.get(key);
        if (!card) {
          card = renderQueueCard(item, nowMs);
          card.classList.add('entering');
          queueBoardState.cards.set(key, card);
          setTimeout(() => card.classList.remove('entering'), 260);
        } else {
          updateQueueCard(card, item, nowMs);
        }
        column.list.appendChild(card);
      });
      if (allItems.length > visibleItems.length) {
        const more = document.createElement('div');
        more.className = 'queue-more';
        more.dataset.queueMore = '1';
        more.textContent = '还有 ' + (allItems.length - visibleItems.length) + ' 个任务未展开';
        column.list.appendChild(more);
      }
    }

    function animateQueueBoard(firstRects) {
      for (const [key, card] of queueBoardState.cards.entries()) {
        const first = firstRects.get(key);
        if (!first || !card.isConnected) continue;
        const last = card.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate(
          [
            { transform: 'translate(' + dx + 'px,' + dy + 'px)' },
            { transform: 'translate(0,0)' }
          ],
          { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        );
      }
    }

    async function refreshQueueBoard() {
      if (logMode !== 'queue') return;
      const board = ensureQueueBoardHost();
      if (!board) return;
      try {
        const data = await fetchJsonSilent('/api/queue/state');
        if (logMode !== 'queue') return;
        const snapshot = data || {};
        const nowMs = Date.now();
        let grid = board.querySelector('.queue-board');
        if (!grid) {
          board.innerHTML = '';
          grid = document.createElement('div');
          grid.className = 'queue-board';
          board.appendChild(grid);
          queueBoardState.columns = {};
        }
        const firstRects = new Map();
        for (const [key, card] of queueBoardState.cards.entries()) {
          if (card.isConnected) firstRects.set(key, card.getBoundingClientRect());
        }
        const seenKeys = new Set();
        renderQueueColumn(grid, 'downloadPending', '待下载', snapshot.downloadPending || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'downloadRunning', '下载中', snapshot.downloadRunning || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'uploadPending', '待上传', snapshot.uploadPending || [], nowMs, seenKeys);
        renderQueueColumn(grid, 'uploadRunning', '上传中', snapshot.uploadRunning || [], nowMs, seenKeys);
        for (const [key, card] of Array.from(queueBoardState.cards.entries())) {
          if (seenKeys.has(key)) continue;
          queueBoardState.cards.delete(key);
          if (card.isConnected) {
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 220);
          }
        }
        requestAnimationFrame(() => animateQueueBoard(firstRects));
      } catch (e) {
        board.innerHTML = '<div class="queue-empty">队列看板加载失败</div>';
        queueBoardState.columns = {};
        queueBoardState.cards.clear();
      }
    }

    function stopQueueBoardPolling() {
      if (queueBoardPollTimer) {
        clearInterval(queueBoardPollTimer);
        queueBoardPollTimer = null;
      }
    }

    function resetQueueBoardState() {
      queueBoardState.columns = {};
      queueBoardState.cards.clear();
      const board = document.getElementById('queueBoard');
      if (board) board.innerHTML = '';
    }

    function startQueueBoardPolling() {
      stopQueueBoardPolling();
      void refreshQueueBoard();
      queueBoardPollTimer = setInterval(() => {
        void refreshQueueBoard();
      }, 1000);
    }

    function setLogMode(mode) {
      logMode = mode;
      const simpleBtn = document.getElementById('logSimpleBtn');
      const rawBtn = document.getElementById('logRawBtn');
      const debugBtn = document.getElementById('logDebugBtn');
      const queueBtn = document.getElementById('logQueueBtn');
      if (simpleBtn) simpleBtn.classList.toggle('active', mode === 'simple');
      if (rawBtn) rawBtn.classList.toggle('active', mode === 'raw');
      if (debugBtn) debugBtn.classList.toggle('active', mode === 'debug');
      if (queueBtn) queueBtn.classList.toggle('active', mode === 'queue');
      const logConsole = document.getElementById('logConsole');
      const queueBoard = ensureQueueBoardHost();
      if (mode === 'queue') {
        if (logConsole) logConsole.style.display = 'none';
        if (queueBoard) queueBoard.style.display = 'block';
        startQueueBoardPolling();
        return;
      }
      stopQueueBoardPolling();
      if (queueBoard) queueBoard.style.display = 'none';
      resetQueueBoardState();
      if (logConsole) logConsole.style.display = 'block';
      rebuildLog();
    }

    // ---- Event Bindings ----
    document.getElementById('addUserBtn').addEventListener('click', startLogin);
    document.getElementById('closeLoginBtn').addEventListener('click', () => {
      document.getElementById('loginModal').classList.remove('active'); currentLoginId = null;
    });
    document.getElementById('saveFavoritesBtn').addEventListener('click', saveFavorites);
    document.getElementById('closeFavoritesBtn').addEventListener('click', () => document.getElementById('favoritesModal').classList.remove('active'));
    document.getElementById('closeVideoDetailBtn').addEventListener('click', () => {
      videoDetailState.token += 1;
      videoDetailState.loading = false;
      videoDetailState.hasMore = false;
      document.getElementById('videoDetailModal').classList.remove('active');
    });
    document.getElementById('closeUnavailableBtn').addEventListener('click', () => {
      unavailableHasMore = false;
      unavailableLoading = false;
      document.getElementById('unavailableModal').classList.remove('active');
    });
    document.getElementById('syncHelpBtn').addEventListener('click', openSyncHelp);
    document.getElementById('settingsHelpBtn').addEventListener('click', openSettingsHelp);
    document.getElementById('closeSyncHelpBtn').addEventListener('click', () => document.getElementById('syncHelpModal').classList.remove('active'));
    document.getElementById('closeSettingsHelpBtn').addEventListener('click', () => document.getElementById('settingsHelpModal').classList.remove('active'));
    document.getElementById('syncHelpSimpleBtn').addEventListener('click', () => { syncHelpMode = 'simple'; renderSyncHelp(); });
    document.getElementById('syncHelpDetailBtn').addEventListener('click', () => { syncHelpMode = 'detail'; renderSyncHelp(); });
    document.getElementById('closeRenamePreviewBtn').addEventListener('click', () => document.getElementById('renamePreviewModal').classList.remove('active'));
    document.getElementById('renameSelectAllBtn').addEventListener('click', () => setRenameSelection(true));
    document.getElementById('renameSelectNoneBtn').addEventListener('click', () => setRenameSelection(false));
    document.getElementById('refreshRenamePreviewBtn').addEventListener('click', loadRenamePreview);
    document.getElementById('executeRenameBtn').addEventListener('click', executeSelectedRename);
    document.getElementById('closeQualityUpgradeBtn').addEventListener('click', () => document.getElementById('qualityUpgradeModal').classList.remove('active'));
    document.getElementById('qualityUpgradeSelectAllBtn').addEventListener('click', () => setQualityUpgradeSelection(true));
    document.getElementById('qualityUpgradeSelectNoneBtn').addEventListener('click', () => setQualityUpgradeSelection(false));
    document.getElementById('refreshQualityUpgradeBtn').addEventListener('click', loadQualityUpgradePreview);
    document.getElementById('executeQualityUpgradeBtn').addEventListener('click', executeSelectedQualityUpgrade);
    document.getElementById('filterMissingBtn').addEventListener('click', () => setUnavailableFilter('missing'));
    document.getElementById('filterUploadedBtn').addEventListener('click', () => setUnavailableFilter('uploaded'));
    document.getElementById('vdFilterAllBtn').addEventListener('click', () => applyVideoDetailFilter('all'));
    document.getElementById('vdFilterUploadedBtn').addEventListener('click', () => applyVideoDetailFilter('uploaded'));
    document.getElementById('vdFilterPendingBtn').addEventListener('click', () => applyVideoDetailFilter('pending'));
    document.getElementById('vdFilterPendingUnavailableBtn').addEventListener('click', () => applyVideoDetailFilter('pending_unavailable'));
    document.getElementById('vdFilterUploadedUnavailableBtn').addEventListener('click', () => applyVideoDetailFilter('uploaded_unavailable'));
    document.getElementById('videoGrid').addEventListener('scroll', () => {
      const grid = document.getElementById('videoGrid');
      if (grid.scrollHeight - grid.scrollTop - grid.clientHeight < 120) {
        if (videoDetailThrottleTimer) return;
        videoDetailThrottleTimer = setTimeout(() => {
          videoDetailThrottleTimer = null;
          loadNextVideoDetailPage();
        }, 800);
      }
    });
    let unavailableThrottleTimer = null;
    document.getElementById('unavailableGrid').addEventListener('scroll', () => {
      const grid = document.getElementById('unavailableGrid');
      if (grid.scrollHeight - grid.scrollTop - grid.clientHeight < 120) {
        if (unavailableThrottleTimer) return;
        unavailableThrottleTimer = setTimeout(() => {
          unavailableThrottleTimer = null;
          loadMoreUnavailable();
        }, 800);
      }
    });

    document.getElementById('userList').addEventListener('click', async (event) => {
      const t = event.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action, userId = t.dataset.id;
      if (action === 'favorites') await openFavorites(userId);
      if (action === 'unavailable') await openUnavailable(userId);
      if (action === 'remove' && confirm('确定要删除这个账号吗？')) { await fetchJson('/api/users/'+userId,{method:'DELETE'}); await loadUsers(); }
      if (action === 'toggle') { await fetchJson('/api/users/'+userId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({toggle:true})}); await loadUsers(); }
      if (action === 'refresh_info') {
        await fetchJson('/api/users/'+userId+'/refresh-info',{method:'POST'});
        showToast('账号信息已刷新', 'success');
        await loadUsers();
      }
      if (action === 'refresh_auth') {
        await fetchJson('/api/users/'+userId+'/refresh-auth',{method:'POST'});
        showToast('授权已更新', 'success');
        await loadUsers();
      }
      if (action === 'copy_cookie') {
        const confirmed = prompt('Cookie 等同于 B 站登录凭据。确认导出请输入 EXPORT_COOKIE');
        if (confirmed !== 'EXPORT_COOKIE') return;
        const resp = await fetchJson('/api/users/'+userId+'/cookie/export', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({confirm:'EXPORT_COOKIE'})
        });
        const text = String(resp.cookie || '');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showToast('Cookie 已复制', 'success');
        } else {
          const input = document.createElement('textarea');
          input.value = text;
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
          showToast('Cookie 已复制', 'success');
        }
      }
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

    document.getElementById('syncNowBtn').textContent = '\u7acb\u5373\u540c\u6b65';
    document.getElementById('reconcileRemoteBtn').textContent = '\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5AList\uff09';
    document.getElementById('reconcileBtn').textContent = '\u5168\u91cf\u626b\u63cf\u5e76\u5bf9\u8d26';

    document.getElementById('syncNowBtn').addEventListener('click', async () => {
      const btn = document.getElementById('syncNowBtn');
      const defaultText = btn.dataset.defaultText || btn.textContent || '\u7acb\u5373\u540c\u6b65';
      btn.dataset.defaultText = defaultText;
      btn.textContent = '\u540c\u6b65\u4e2d...';
      try {
        const data = await fetchJson('/api/sync/now', { method:'POST' });
        btn.textContent = data && data.queued ? '\u5df2\u6392\u961f' : '\u5df2\u89e6\u53d1';
      } catch(e) {
        btn.textContent = '\u89e6\u53d1\u5931\u8d25';
      }
      setTimeout(() => btn.textContent = defaultText, 2000);
    });
    document.getElementById('reconcileRemoteBtn').addEventListener('click', async () => {
      const btn = document.getElementById('reconcileRemoteBtn');
      const defaultText = btn.dataset.defaultText || btn.textContent || '\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5AList\uff09';
      btn.dataset.defaultText = defaultText;
      btn.textContent = '\u5bf9\u8d26\u4e2d...';
      try {
        const data = await fetchJson('/api/sync/reconcile-remote', { method:'POST' });
        btn.textContent = data && data.queued ? '\u5df2\u6392\u961f' : '\u5df2\u89e6\u53d1';
      } catch(e) {
        btn.textContent = '\u89e6\u53d1\u5931\u8d25';
      }
      setTimeout(() => btn.textContent = defaultText, 2000);
    });
    document.getElementById('reconcileBtn').addEventListener('click', async () => {
      const ok = confirm('\u9ad8\u98ce\u9669\u64cd\u4f5c\uff1a\u5c06\u5168\u91cf\u626b\u63cfB\u7ad9\u6536\u85cf\u5939\u6240\u6709\u9875\uff0c\u53ef\u80fd\u89e6\u53d1\u98ce\u63a7\uff08\u5982412/\u767b\u5f55\u6821\u9a8c\uff09\u3002\u5efa\u8bae\u4ec5\u5728\u5fc5\u8981\u65f6\u4f7f\u7528\u3002\u662f\u5426\u7ee7\u7eed\uff1f');
      if (!ok) return;
      const btn = document.getElementById('reconcileBtn');
      const defaultText = btn.dataset.defaultText || btn.textContent || '\u5168\u91cf\u626b\u63cf\u5e76\u5bf9\u8d26';
      btn.dataset.defaultText = defaultText;
      btn.textContent = '\u5168\u91cf\u626b\u63cf\u4e2d...';
      try {
        const data = await fetchJson('/api/sync/reconcile', { method:'POST' });
        btn.textContent = data && data.queued ? '\u5df2\u6392\u961f' : '\u5df2\u89e6\u53d1';
      } catch(e) {
        btn.textContent = '\u89e6\u53d1\u5931\u8d25';
      }
      setTimeout(() => btn.textContent = defaultText, 2000);
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await fetchJson('/api/logout', { method:'POST' });
      window.location.href = '/login';
    });
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    ensureQueueBoardHost();

    // Log mode toggle
    const queueBtn = ensureQueueModeButton();
    if (queueBtn) {
      queueBtn.addEventListener('click', () => setLogMode('queue'));
    }
    document.getElementById('logSimpleBtn').addEventListener('click', () => setLogMode('simple'));
    document.getElementById('logRawBtn').addEventListener('click', () => setLogMode('raw'));
    document.getElementById('logDebugBtn').addEventListener('click', () => setLogMode('debug'));

    // Rename and quality upgrade buttons
    document.getElementById('renameBtn').addEventListener('click', openRenamePreview);
    document.getElementById('qualityUpgradeBtn').addEventListener('click', openQualityUpgradePreview);

    // Init
    loadConfig();
    loadUsers();
    initTemplateEditor();
    initLogStream();
    loadQualityUpgradeState();
  `;
}
