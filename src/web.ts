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
      background:
        radial-gradient(circle at 18% 0%, rgba(57, 197, 187, 0.16), transparent 34%),
        radial-gradient(circle at 86% 10%, rgba(224, 247, 250, 0.72), transparent 30%),
        linear-gradient(180deg, #ffffff 0%, var(--bg) 66%);
      color: var(--ink);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(420px, 100%);
      background: rgba(255, 255, 255, 0.82);
      backdrop-filter: blur(18px);
      border-radius: 20px;
      padding: 36px;
      box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, 0.8);
      animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      border: 1px solid rgba(214, 240, 237, 0.82);
    }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 700; color: var(--accent); }
    p { margin: 0 0 28px; color: var(--muted); font-size: 15px; }
    label { display: block; font-weight: 500; margin: 0 0 8px; color: var(--ink); }
    input {
      width: 100%;
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(214, 240, 237, 0.95);
      margin-bottom: 20px;
      font-size: 15px;
      transition: all 0.2s;
      outline: none;
      background: rgba(255, 255, 255, 0.9);
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(57, 197, 187, 0.16);
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
      box-shadow: 0 10px 22px rgba(57, 197, 187, 0.24);
    }
    button:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
      box-shadow: 0 12px 28px rgba(57, 197, 187, 0.30);
    }
    button:active {
      transform: translateY(1px);
      box-shadow: 0 5px 14px rgba(57, 197, 187, 0.22);
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
      --glass-panel: rgba(255,255,255,0.80);
      --glass-panel-strong: rgba(255,255,255,0.88);
      --glass-surface: rgba(250,253,252,0.72);
      --glass-input: rgba(255,255,255,0.78);
      --glass-border: rgba(214,240,237,0.84);
      --glass-border-strong: rgba(214,240,237,0.95);
      --glass-blur: blur(18px);
      --glass-shadow: 0 18px 48px rgba(57,197,187,0.09), inset 0 1px 0 rgba(255,255,255,0.78);
      --success: #4CAF50; --success-bg: #E8F5E9;
    }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 10% -10%,rgba(57,197,187,0.18) 0%,transparent 30%),radial-gradient(circle at 86% 4%,rgba(224,247,250,0.68) 0%,transparent 28%),linear-gradient(180deg,#ffffff 0%,var(--bg) 52%); color:var(--ink); }
    header { display:flex; justify-content:space-between; align-items:center; padding:20px 32px; background:rgba(255,255,255,0.72); backdrop-filter:var(--glass-blur); border-bottom:1px solid rgba(214,240,237,0.76); position:sticky; top:0; z-index:10; box-shadow:0 8px 30px rgba(57,197,187,0.05); }
    header h1 { margin:0; font-size:24px; color:var(--accent); font-weight:700; }
    header button { background:rgba(255,255,255,0.82); border:1px solid rgba(214,240,237,0.95); border-radius:999px; padding:8px 20px; cursor:pointer; font-weight:600; color:var(--ink); transition:all 0.2s; box-shadow:0 4px 16px rgba(57,197,187,0.08); }
    header button:hover { border-color:var(--accent); color:var(--accent); box-shadow:0 6px 20px rgba(57,197,187,0.12); }
    main { padding:28px 32px 40px; display:grid; gap:22px; grid-template-columns:1fr; max-width:1200px; min-width:0; margin:0 auto; }
    .card { min-width:0; background:var(--glass-panel); backdrop-filter:var(--glass-blur); border-radius:20px; padding:24px; box-shadow:var(--glass-shadow); border:1px solid var(--glass-border); animation:fadeUp 0.6s cubic-bezier(0.16,1,0.3,1); }
    .card h2 { margin:0 0 14px; font-size:20px; color:var(--accent); display:flex; align-items:center; gap:8px; }
    .card h2::before { content:''; display:block; width:4px; height:18px; background:var(--accent); border-radius:4px; }
    .muted { color:var(--muted); font-size:14px; margin-bottom:14px; line-height:1.65; }
    .row { display:flex; gap:10px; flex-wrap:wrap; }
    .account-actions { margin-bottom:20px; align-items:center; }
    .settings-actions,.modal-actions { margin-top:24px; }
    .modal-actions { justify-content:center; }
    .preview-actions { margin:8px 0 12px; }
    .split-actions button { flex:1; }
    .row button { border:none; background:var(--accent); color:white; padding:9px 15px; border-radius:14px; cursor:pointer; font-weight:600; transition:all 0.2s; box-shadow:0 8px 20px rgba(57,197,187,0.18); }
    .row button:hover { background:var(--accent-hover); transform:translateY(-1px); box-shadow:0 10px 24px rgba(57,197,187,0.24); }
    .row button:disabled { opacity:.56; cursor:not-allowed; transform:none; box-shadow:none; }
    .row button:disabled:hover { transform:none; box-shadow:none; }
    .row .ghost { background:rgba(255,255,255,0.66); color:var(--accent); border:1px solid rgba(57,197,187,0.45); box-shadow:none; }
    .row .ghost:hover { background:rgba(57,197,187,0.08); border-color:var(--accent); }
    .row .danger-ghost { border-color:#E57373; color:#E57373; }
    .row button.danger-action { background:#E57373; box-shadow:0 8px 20px rgba(229,115,115,0.20); }
    .row button.danger-action:hover { background:#D85C5C; box-shadow:0 10px 24px rgba(229,115,115,0.26); }
    .row .compact-button { padding:4px 12px; font-size:12px; flex-shrink:0; }
    .user-list { display:grid; gap:16px; }
    .user-item { border:1px solid var(--glass-border); border-radius:16px; padding:15px; display:grid; gap:12px; background:var(--glass-surface); box-shadow:inset 0 1px 0 rgba(255,255,255,0.72); }
    .user-name { font-size:16px; color:var(--accent); }
    .user-meta { margin:0; }
    .user-actions { margin-top:4px; }
    .favorite-chip-list { margin:4px 0; }
    .favorite-chip { display:inline-block; padding:4px 10px; background:rgba(57,197,187,0.1); border-radius:999px; font-size:12px; margin:2px; }
    .auth-health { border:1px solid var(--glass-border); border-radius:12px; padding:10px 12px; background:rgba(255,255,255,0.76); font-size:12px; line-height:1.7; }
    .auth-health.ok { border-color:var(--success); background:var(--success-bg); }
    .auth-health.warn { border-color:#FFB74D; background:#FFF8E1; }
    .auth-health.error { border-color:#E57373; background:#FFEBEE; }
    .auth-health-title { font-weight:800; color:var(--ink); }
    .auth-health-detail { color:var(--muted); }
    .auth-health.error .auth-health-detail { color:#C62828; }
    .settings-grid { display:grid; gap:14px 16px; grid-template-columns:1fr 1fr; }
    .settings-group { grid-column:1/-1; padding-top:14px; border-top:1px solid rgba(214,240,237,0.78); margin-top:8px; }
    .settings-group-title { font-weight:700; color:var(--ink); margin-bottom:12px; }
    .field-full { grid-column:1/-1; }
    label { display:block; font-weight:500; margin:0 0 8px; color:var(--ink); font-size:14px; }
    .field-hint { margin:6px 0 0; font-size:12px; }
    .row .field-hint { width:100%; margin-bottom:0; }
    .template-note { margin-bottom:8px; }
    .template-label { margin-top:12px; }
    input[type="text"],input[type="number"],input[type="password"],select { width:100%; padding:11px 13px; border-radius:12px; border:1px solid var(--glass-border-strong); font-size:14px; outline:none; transition:all 0.2s; background:var(--glass-input); box-shadow:inset 0 1px 0 rgba(255,255,255,0.72); }
    input:focus,select:focus { border-color:var(--accent); box-shadow:0 0 0 4px rgba(57,197,187,0.14), inset 0 1px 0 rgba(255,255,255,0.8); background:white; }
    .checkbox-label { display:flex; align-items:center; gap:8px; font-weight:500; cursor:pointer; margin:0; }
    .checkbox-label input { width:auto; margin:0; }
    .modal { position:fixed; inset:0; background:rgba(26,47,45,0.50); backdrop-filter:blur(8px); display:none; align-items:center; justify-content:center; padding:16px; z-index:100; }
    .modal.active { display:flex; }
    .modal .panel { background:var(--glass-panel-strong); backdrop-filter:var(--glass-blur); padding:30px; border-radius:24px; max-width:700px; width:100%; box-shadow:0 24px 80px rgba(26,47,45,0.14), inset 0 1px 0 rgba(255,255,255,0.82); border:1px solid var(--glass-border); max-height:90vh; overflow-y:auto; overflow-x:hidden; }
    .modal .panel.panel-narrow { max-width:760px; }
    .modal .panel.panel-medium { max-width:800px; }
    .modal .panel.panel-large { max-width:860px; }
    .modal .panel.panel-wide { max-width:900px; }
    .modal .panel.panel-wider { max-width:920px; }
    .modal .panel.panel-max { max-width:980px; }
    .favorites-list { max-height:400px; overflow:auto; border:1px solid var(--glass-border); border-radius:16px; padding:10px; background:var(--glass-surface); }
    .fav-label { font-weight:500; display:flex; gap:12px; align-items:center; margin:0; padding:12px; border-radius:12px; transition:background 0.2s; cursor:pointer; }
    .fav-label:hover { background:rgba(57,197,187,0.1); }
    .fav-cover { width:64px; height:40px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    .fav-content { flex:1; min-width:0; }
    .fav-title { font-weight:600; }
    .fav-count { font-size:12px; color:var(--muted); }
    /* Video items in detail modal */
    .video-grid { display:grid; gap:12px; max-height:500px; overflow-y:auto; overflow-x:hidden; }
    .video-item { min-width:0; max-width:100%; overflow:hidden; display:flex; gap:12px; padding:11px; border-radius:12px; border:1px solid var(--glass-border); align-items:center; transition:all 0.2s; background:rgba(255,255,255,0.62); }
    .video-detail-status { text-align:center; padding:10px; color:var(--muted); font-size:13px; }
    .video-detail-status.error { color:#E57373; }
    .video-detail-hint { color:var(--muted); font-size:12px; margin:-4px 0 10px; line-height:1.6; }
    .video-item.processed { background:var(--success-bg); border-color:var(--success); }
    .video-item.unavailable-uploaded { background:#FFF8E1; border-color:#FFC107; box-shadow:0 0 0 1px #FFC107; }
    .video-item.unavailable-missing { background:#FFEBEE; border-color:#FFCDD2; }
    .video-cover { width:120px; height:75px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    .video-info { flex:1 1 auto; min-width:0; overflow:hidden; }
    .video-title { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .video-meta { font-size:12px; color:var(--muted); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .video-badge { flex:0 0 auto; display:inline-block; white-space:nowrap; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:600; }
    .video-badge.done { background:var(--success); color:white; }
    .video-badge.pending { background:var(--border); color:var(--muted); }
    .video-badge.upload-pending { background:#FFB74D; color:#5D4300; }
    .video-badge.partial { background:#42A5F5; color:white; }
    .video-badge.removed-uploaded { background:#FFC107; color:#1A2F2D; }
    .video-badge.removed-missing { background:#EF9A9A; color:white; }
    .filter-toggle { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    .filter-toggle button { padding:6px 16px; border-radius:999px; border:1px solid var(--glass-border-strong); background:rgba(255,255,255,0.74); color:var(--ink); cursor:pointer; font-weight:600; font-size:13px; transition:all 0.2s; }
    .filter-toggle button.active { background:var(--accent); color:white; border-color:var(--accent); }
    /* Template tags */
    .template-tags { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .selected-tags { min-height:40px; border:1px dashed var(--glass-border-strong); border-radius:12px; padding:8px; background:rgba(255,255,255,0.42); }
    .template-empty-hint { color:var(--muted); font-size:13px; padding:4px; }
    .template-tag { display:inline-flex; align-items:center; gap:4px; padding:6px 12px; border-radius:999px; background:rgba(57,197,187,0.1); color:var(--accent); font-size:13px; font-weight:600; cursor:pointer; border:1px solid transparent; transition:all 0.2s; user-select:none; }
    .template-tag:hover { border-color:var(--accent); }
    .template-tag.active { background:var(--accent); color:white; }
    .template-tag.selected { background:var(--accent); color:white; cursor:grab; }
    .template-tag.selected:active { cursor:grabbing; }
    .template-tag.dragging { opacity:0.4; }
    .template-tag.drag-over { border-color:var(--accent); transform:scale(1.05); }
    .template-tag .remove-x { margin-left:4px; font-size:14px; opacity:0.7; }
    .template-tag .remove-x:hover { opacity:1; }
    .template-preview { padding:11px 12px; background:rgba(255,255,255,0.64); border:1px solid rgba(214,240,237,0.72); border-radius:12px; font-family:monospace; font-size:13px; color:var(--ink); margin:8px 0; min-height:36px; word-break:break-all; }
    .segmented-control { display:inline-grid; grid-template-columns:repeat(2,minmax(110px,1fr)); gap:3px; padding:3px; border:1px solid var(--glass-border); border-radius:10px; background:rgba(255,255,255,0.56); }
    .segmented-control label { margin:0; cursor:pointer; }
    .segmented-control input { position:absolute; opacity:0; pointer-events:none; }
    .segmented-control span { display:block; min-height:34px; padding:8px 14px; border-radius:7px; text-align:center; color:var(--muted); font-size:13px; font-weight:700; }
    .segmented-control input:checked + span { background:var(--accent); color:white; box-shadow:0 1px 4px rgba(57,197,187,0.22); }
    /* Log console */
    .log-console { background:#1a1a2e; color:#eee; border-radius:12px; padding:16px; font-family:'Courier New',monospace; font-size:12px; max-height:400px; overflow-y:auto; line-height:1.8; }
    .log-console .log-info { color:#39C5BB; }
    .log-console .log-error { color:#E57373; }
    .log-console .log-warn { color:#FFB74D; }
    .log-toggle { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    .log-toggle button { padding:6px 16px; border-radius:999px; border:1px solid rgba(214,240,237,0.95); background:rgba(255,255,255,0.74); color:var(--ink); cursor:pointer; font-weight:600; font-size:13px; transition:all 0.2s; }
    .log-toggle button.active { background:var(--accent); color:white; border-color:var(--accent); }
    .scheduler-status { border:1px solid var(--glass-border); border-radius:14px; background:var(--glass-surface); padding:11px 12px; margin-bottom:12px; font-size:13px; }
    .scheduler-status-main { display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap; }
    .scheduler-status-title { font-weight:800; color:var(--accent); }
    .scheduler-status-detail { color:var(--muted); margin-top:4px; }
    .scheduler-status.running { border-color:var(--accent); background:rgba(57,197,187,0.08); }
    .scheduler-status.queued,.scheduler-status.cooldown { border-color:#FFB74D; background:#FFF8E1; }
    .scheduler-status-grid { display:grid; gap:6px 14px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin-top:10px; color:var(--muted); }
    .scheduler-status-grid strong { color:var(--ink); }
    .local-cache-status { border:1px solid var(--glass-border); border-radius:14px; padding:10px 12px; margin:0 0 10px; background:rgba(248,251,250,0.76); font-size:12px; color:var(--muted); }
    .local-cache-status.paused { border-color:#FFB74D; background:#FFF8E1; color:#8D6E00; }
    .upload-health-status { border:1px solid #E57373; border-radius:14px; padding:10px 12px; margin:0 0 10px; background:#FFF1F1; font-size:12px; color:#9B2C2C; }
    .download-api-health-status { border:1px solid #FFB74D; border-radius:14px; padding:10px 12px; margin:0 0 10px; background:#FFF8E1; font-size:12px; color:#8D6E00; }
    .queue-board { display:grid; grid-template-columns:repeat(4,minmax(260px,1fr)); gap:12px; width:100%; max-width:100%; min-width:0; max-height:430px; overflow-x:auto; overflow-y:hidden; padding-bottom:4px; align-items:stretch; }
    .queue-col { min-width:0; border:1px solid var(--glass-border); border-radius:16px; background:var(--glass-surface); padding:10px; height:420px; display:flex; flex-direction:column; overflow:hidden; box-shadow:inset 0 1px 0 rgba(255,255,255,0.7); }
    .queue-col-title { font-size:13px; font-weight:700; color:var(--accent); margin:0 0 8px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
    .queue-col-count { min-width:28px; text-align:right; }
    .queue-list { display:grid; gap:8px; overflow-y:auto; padding-right:4px; min-height:0; align-content:start; flex:1; }
    .queue-more { color:var(--muted); font-size:12px; text-align:center; padding:8px 4px; border:1px dashed var(--border); border-radius:10px; background:rgba(57,197,187,0.04); }
    .queue-empty,.empty-state { color:var(--muted); font-size:12px; text-align:center; padding:24px 4px; align-self:center; opacity:0.72; }
    .empty-state { border:1px dashed var(--glass-border); border-radius:14px; background:rgba(255,255,255,0.46); }
    .loading-state { color:var(--accent); opacity:1; }
    .queue-card { min-width:0; max-width:100%; display:flex; gap:8px; padding:8px; border-radius:12px; border:1px solid var(--glass-border); background:var(--glass-input); transition:box-shadow .18s ease, opacity .2s ease, border-color .2s ease; will-change:transform; }
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
    .help-icon-btn { width:32px; height:32px; border-radius:50%; border:1px solid rgba(57,197,187,0.55); background:linear-gradient(180deg,rgba(255,255,255,0.86),rgba(244,253,251,0.72)); color:var(--accent); font-size:15px; font-weight:900; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; line-height:1; transition:all .2s; flex:0 0 auto; box-shadow:inset 0 1px 0 rgba(255,255,255,0.9),0 5px 14px rgba(57,197,187,0.10); }
    .help-icon-btn:hover,.help-icon-btn:focus-visible { background:rgba(57,197,187,0.1); border-color:var(--accent); transform:translateY(-1px); box-shadow:0 8px 18px rgba(57,197,187,0.18); outline:none; }
    .section-title-row { display:flex; align-items:center; gap:8px; margin:0 0 16px; }
    .section-title-row h2 { margin:0; }
    .section-title-row .help-icon-btn { width:28px; height:28px; font-size:14px; }
    .help-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:12px 0 16px; }
    .help-tabs button { padding:7px 14px; border-radius:999px; border:1px solid rgba(214,240,237,0.95); background:rgba(255,255,255,0.74); color:var(--ink); cursor:pointer; font-weight:700; }
    .help-tabs button.active { border-color:var(--accent); background:rgba(57,197,187,0.12); color:var(--accent); }
    .help-card-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
    .help-card { border:1px solid var(--glass-border); border-radius:16px; padding:14px; background:var(--glass-surface); }
    .help-card strong { color:var(--accent); display:block; margin-bottom:6px; }
    .help-card ul { margin:8px 0 0 18px; padding:0; color:var(--muted); font-size:13px; line-height:1.7; }
    .flow-visual { display:grid; gap:10px; margin:12px 0; }
    .flow-step { display:grid; grid-template-columns:92px 1fr; gap:12px; align-items:center; border:1px solid var(--glass-border); border-radius:18px; padding:12px; background:linear-gradient(135deg,rgba(255,255,255,0.82),rgba(242,251,250,0.78)); }
    .flow-step .badge { border-radius:999px; padding:8px 10px; background:var(--accent); color:white; text-align:center; font-weight:800; font-size:12px; }
    .flow-step .desc { color:var(--ink); font-size:14px; line-height:1.6; }
    .effect-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-top:14px; }
    .effect-group { border:1px solid var(--glass-border); border-radius:14px; padding:12px; background:var(--glass-surface); }
    .effect-group strong { color:var(--accent); display:block; margin-bottom:6px; }
    .effect-group div { color:var(--muted); font-size:13px; line-height:1.7; }
    .row button.rename-btn { background:#FF7043; }
    .row button.rename-btn:hover { background:#F4511E; }
    .rename-list { display:grid; gap:10px; max-height:360px; overflow:auto; padding-right:4px; }
    .rename-item { display:grid; grid-template-columns:auto 1fr; gap:10px; border:1px solid var(--glass-border); border-radius:14px; padding:12px; background:var(--glass-surface); }
    .rename-item input { margin-top:4px; }
    .rename-title { font-weight:700; color:var(--ink); word-break:break-word; }
    .rename-path { color:var(--muted); font-size:12px; line-height:1.6; word-break:break-all; }
    .rename-arrow { color:var(--accent); font-weight:800; }
    .rename-skip-list { max-height:180px; overflow:auto; border:1px dashed var(--border); border-radius:12px; padding:10px; background:#fffaf5; color:var(--muted); font-size:12px; line-height:1.7; word-break:break-all; }
    .rename-result { border-radius:12px; padding:10px; background:rgba(245,251,250,0.78); border:1px solid var(--glass-border); color:var(--muted); font-size:13px; line-height:1.7; max-height:160px; overflow:auto; }
    .cleanup-list { display:grid; gap:10px; margin:12px 0; }
    .cleanup-item { display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:start; border:1px solid var(--glass-border); border-radius:14px; padding:12px; background:var(--glass-surface); }
    .cleanup-item.important { border-color:#FFB74D; background:#FFF8E1; }
    .cleanup-item.disabled { opacity:.58; cursor:not-allowed; }
    .cleanup-item-title { font-weight:800; color:var(--ink); }
    .cleanup-item-desc { color:var(--muted); font-size:12px; line-height:1.6; margin-top:3px; }
    .cleanup-size { color:var(--accent); font-size:12px; font-weight:800; white-space:nowrap; }
    .cleanup-confirm { border:1px dashed #FFB74D; border-radius:14px; padding:12px; background:#FFFDF5; margin-top:12px; }
    .cleanup-help-list { display:grid; gap:10px; margin-top:12px; }
    .cleanup-help-item { border:1px solid var(--glass-border); border-radius:14px; padding:12px; background:linear-gradient(135deg,rgba(255,255,255,0.84),rgba(246,255,253,0.78)); color:var(--muted); font-size:13px; line-height:1.7; }
    .cleanup-help-item strong { color:var(--accent); display:block; margin-bottom:4px; }
    .status-line { margin-top:8px; }
    .status-line.primary { margin-top:12px; color:var(--accent); }
    .center-status { text-align:center; }
    .login-status { text-align:center; font-weight:500; font-size:16px; }
    .qr-wrap { text-align:center; margin:24px 0; }
    .login-qr { width:200px; height:200px; border-radius:16px; border:1px solid var(--glass-border-strong); background:white; padding:3px; }
    .full-width { width:100%; }
    .skipped-block { margin-top:14px; }
    .block-title { color:var(--ink); display:block; margin-bottom:8px; }
    .result-block { margin-top:14px; }
    .confirm-hint { margin-bottom:8px; }
    .help-note { margin-top:14px; }
    .is-hidden { display:none!important; }
    .status-success { color:var(--accent)!important; }
    .status-muted { color:var(--muted)!important; }
    .status-error { color:#E57373!important; }
    .confirm-action-message { color:var(--ink); line-height:1.7; margin:10px 0 0; }
    .confirm-action-detail { border:1px solid var(--glass-border); border-radius:14px; background:rgba(255,255,255,0.62); color:var(--muted); line-height:1.7; padding:12px; margin-top:12px; font-size:13px; }
    .confirm-action-input-wrap { margin-top:14px; }
    .confirm-action-input-wrap label { color:var(--ink); }
    .confirm-action-input-hint { margin-top:6px; font-size:12px; }
    .clipboard-fallback-input { position:fixed; left:-9999px; top:0; width:1px; height:1px; opacity:0; }
    .toast-container { position:fixed; bottom:24px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:12px; pointer-events:none; }
    .toast { background:white; color:var(--ink); padding:14px 14px 14px 18px; border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.1); border-left:4px solid #E57373; display:flex; align-items:flex-start; gap:12px; animation:toastIn 0.3s cubic-bezier(0.16,1,0.3,1); max-width:420px; word-break:break-word; pointer-events:auto; }
    .toast-message { flex:1; min-width:0; line-height:1.55; }
    .toast-close { width:26px; height:26px; border:1px solid var(--glass-border); border-radius:50%; background:rgba(255,255,255,0.72); color:var(--muted); cursor:pointer; font-size:16px; line-height:1; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
    .toast-close:hover { border-color:var(--accent); color:var(--accent); }
    .toast.success { border-left-color:var(--success); }
    .toast.info { border-left-color:var(--accent); }
    .toast.fade-out { animation:toastOut 0.3s cubic-bezier(0.16,1,0.3,1) forwards; }
    @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
    @keyframes toastIn { from{opacity:0;transform:translateX(40px) scale(0.9)} to{opacity:1;transform:translateX(0) scale(1)} }
    @keyframes toastOut { from{opacity:1;transform:translateX(0) scale(1)} to{opacity:0;transform:translateX(40px) scale(0.9)} }
    @supports not ((backdrop-filter: blur(1px))) {
      header,.card,.modal .panel { background:var(--panel); }
      .modal { background:rgba(26,47,45,0.58); }
    }
    @media (max-width: 760px) {
      header { padding:16px 18px; gap:12px; }
      header h1 { font-size:20px; }
      header button { padding:7px 14px; }
      main { padding:18px 12px 28px; gap:16px; }
      .card { padding:18px; border-radius:18px; }
      .settings-grid { grid-template-columns:1fr; gap:13px; }
      .row { gap:8px; }
      .account-actions,.settings-actions,.modal-actions,.preview-actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
      .account-actions button,.settings-actions button,.modal-actions button,.preview-actions button { min-height:40px; }
      .modal-actions .full-width { grid-column:1/-1; }
      .modal { padding:10px; align-items:flex-start; }
      .modal .panel { padding:20px; border-radius:20px; max-height:calc(100vh - 20px); }
      .video-item { align-items:flex-start; flex-wrap:wrap; }
      .video-cover { width:96px; height:60px; }
      .video-info { flex:1 1 calc(100% - 108px); }
      .video-badge { margin-left:auto; }
      .log-toggle { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); width:100%; }
      .log-toggle button { min-height:36px; padding:6px 10px; }
      .queue-board { display:block; width:100%; max-width:100%; min-width:0; max-height:430px; overflow-x:auto; overflow-y:hidden; white-space:nowrap; scroll-snap-type:x proximity; }
      .scheduler-status,.local-cache-status,.upload-health-status,.download-api-health-status { white-space:normal; width:100%; }
      .queue-col { display:inline-flex; width:82vw; min-width:82vw; max-width:82vw; margin-right:12px; white-space:normal; vertical-align:top; scroll-snap-align:start; }
      .toast-container { left:12px; right:12px; bottom:12px; }
      .toast { max-width:none; }
    }
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
      <div class="row account-actions">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">立即同步</button>
        <button class="ghost" id="reconcileRemoteBtn">状态对账（仅AList）</button>
        <button class="ghost" id="reconcileBtn">全量扫描并对账</button>
        <button class="help-icon-btn" id="syncHelpBtn" type="button" title="查看同步按钮说明" aria-label="查看同步按钮说明">?</button>
      </div>
      <div class="user-list" id="userList"></div>
    </section>`;
}

function getSettingsSection() {
  return `<section class="card">
      <div class="section-title-row">
        <h2>全局设置</h2>
        <button class="help-icon-btn" id="settingsHelpBtn" type="button" title="查看当前设置如何执行" aria-label="查看当前设置如何执行">?</button>
      </div>
      <div class="settings-grid">
        <div><label>轮询间隔 (分钟)</label><input id="pollInterval" type="number" min="1" /></div>
        <div><label>BBDown 分P延迟（秒）</label><input id="delaySeconds" type="number" min="0" /><p class="muted field-hint">用于 BBDown 的 --delay-per-page，只影响新下载任务。</p></div>

        <div class="settings-group"><div class="settings-group-title">AList 云盘设置</div></div>
        <div class="field-full"><label>AList 内部通信地址</label><input id="alistUrl" type="text" placeholder="例如: http://alist:5244" autocomplete="off" /></div>
        <div><label>AList 账号 (WebDAV 用户名)</label><input id="alistUsername" type="text" placeholder="例如: admin" autocomplete="off" /></div>
        <div><label>AList 密码 (WebDAV 密码)</label><input id="alistPassword" type="password" placeholder="密码" autocomplete="new-password" /></div>
        <div class="field-full"><label>目标存储路径</label><input id="alistDest" type="text" placeholder="例如: /阿里云盘/bili-backup/videos" /><p class="muted field-hint">修改目标路径只影响后续新上传，已有网盘文件不会自动迁移。修改后建议执行 AList 状态对账。</p></div>
        <div class="field-full"><label>上传目录结构</label>
          <select id="uploadLayout">
            <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
            <option value="folder-video">收藏夹名 / 视频</option>
            <option value="video-only">仅视频文件</option>
          </select>
          <p class="muted field-hint">目录结构变化只影响新任务，不会移动已有远端文件。</p>
        </div>

        <div class="settings-group"><div class="settings-group-title">下载控制 (BBDown)</div></div>
        <div class="field-full"><label>播放接口</label>
          <div class="segmented-control" id="bbdownApiModeControl">
            <label><input type="radio" name="bbdownApiMode" value="web" checked /><span>网页接口</span></label>
            <label><input type="radio" name="bbdownApiMode" value="app" /><span>APP接口</span></label>
          </div>
          <p class="muted field-hint">网页接口遇到播放风控会暂停 3 分钟并自动单任务探测；APP 接口需要所有启用账号具有扫码登录 token。</p>
        </div>
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
          <p class="muted field-hint">Hi-Res / Dolby 需要扫码登录获得 APP token；旧账号如果没有 token，请重新登录后再启用。</p>
        </div>

        <div class="settings-group"><div class="settings-group-title">📌 视频命名模板</div></div>
        <div class="field-full">
          <p class="muted template-note">点击下方标签添加，拖拽已选标签可调整顺序，点击已选标签可移除。</p>
          <label>可用变量</label>
          <div class="template-tags" id="templateTags"></div>
          <label class="template-label">已选变量（可拖拽排序）</label>
          <div class="template-tags selected-tags" id="selectedTags"></div>
          <label class="template-label">当前模板预览</label>
          <div class="template-preview" id="templatePreview"></div>
          <label class="template-label">自定义模板（高级）</label>
          <input id="filenameTemplate" type="text" placeholder="例如: <videoTitle>-<ownerName>-<bvid>" />
        </div>

        <div class="settings-group"><div class="settings-group-title">任务队列与重试</div></div>
        <div><label>失败重试次数</label><input id="maxRetries" type="number" min="0" /></div>
        <div><label>重试间隔 (秒)</label><input id="retryDelaySeconds" type="number" min="1" /></div>
        <div><label>同时下载并发数</label><input id="concurrentDownloads" type="number" min="1" max="5" /></div>
        <div><label>同时上传并发数</label><input id="concurrentUploads" type="number" min="1" max="10" /></div>
        <div class="field-full"><label>本地缓存软上限 (GB，0 表示不限制)</label><input id="localCacheLimitGB" type="number" min="0" max="1024" step="0.5" /></div>
        <div class="field-full"><label>启动恢复每批数量</label><input id="startupRecoveryBatchSize" type="number" min="5" max="100" /></div>
        <div><label>AList 对账并发数</label><input id="remoteVerifyConcurrency" type="number" min="1" max="100" /></div>
        <div><label>AList 对账限速 (次/秒)</label><input id="remoteVerifyRateLimitPerSecond" type="number" min="0.5" max="100" step="0.5" /></div>
        <div class="field-full"><label>每轮最多补传数量</label><input id="remoteRequeueLimitPerCycle" type="number" min="1" max="1000" /></div>
      </div>
      <div class="row settings-actions">
        <button id="saveConfigBtn">保存设置并生效</button>
        <button id="renameBtn" class="rename-btn">检查旧命名文件</button>
        <button id="qualityUpgradeBtn" class="ghost" type="button">检查可升级画质</button>
        <button id="migrationBtn" class="ghost" type="button">数据迁移</button>
        <button id="cleanupDataBtn" class="ghost" type="button">清理数据</button>
      </div>
      <div class="muted status-line primary" id="configStatus"></div>
      <div class="muted status-line" id="renameStatus"></div>
      <div class="muted status-line" id="qualityUpgradeStatus"></div>
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
      <div class="qr-wrap">
        <img id="loginQr" class="login-qr" alt="QR" />
      </div>
      <div id="loginStatus" class="muted login-status"></div>
      <div class="row modal-actions">
        <button id="closeLoginBtn" class="ghost full-width">取消登录</button>
      </div>
    </div>
  </div>

  <div class="modal" id="favoritesModal">
    <div class="panel">
      <h2>选择同步收藏夹</h2>
      <p class="muted">勾选你需要自动备份的收藏夹。点击收藏夹名称可查看内部视频详情。</p>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="row modal-actions split-actions">
        <button id="saveFavoritesBtn">保存选择</button>
        <button id="closeFavoritesBtn" class="ghost">取消</button>
      </div>
      <div class="muted status-line center-status" id="favoritesStatus"></div>
    </div>
  </div>

  <div class="modal" id="videoDetailModal">
    <div class="panel panel-medium">
      <h2 id="videoDetailTitle">收藏夹详情</h2>
      <div class="filter-toggle" id="videoDetailFilterBar">
        <button id="vdFilterAllBtn" class="active">全部 (0)</button>
        <button id="vdFilterUploadedBtn">已上传 (0)</button>
        <button id="vdFilterPendingBtn">未上传 (0)</button>
        <button id="vdFilterPendingUnavailableBtn">未上传并失效 (0)</button>
        <button id="vdFilterUploadedUnavailableBtn">已上传且失效 (0)</button>
      </div>
      <div class="video-grid" id="videoGrid"></div>
      <div class="row modal-actions">
        <button id="closeVideoDetailBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="unavailableModal">
    <div class="panel panel-wide">
      <h2>下架视频清单</h2>
      <div class="filter-toggle">
        <button id="filterMissingBtn" class="active">下架未上传</button>
        <button id="filterUploadedBtn">下架已上传</button>
      </div>
      <div class="video-grid" id="unavailableGrid"></div>
      <div class="row modal-actions">
        <button id="closeUnavailableBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="syncHelpModal">
    <div class="panel panel-large">
      <h2>同步与对账说明</h2>
      <div class="help-tabs">
        <button id="syncHelpSimpleBtn" class="active" type="button">简要介绍</button>
        <button id="syncHelpDetailBtn" type="button">详细介绍</button>
      </div>
      <div id="syncHelpContent"></div>
      <div class="row modal-actions">
        <button id="closeSyncHelpBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="settingsHelpModal">
    <div class="panel panel-wider">
      <h2>当前设置执行流程</h2>
      <p class="muted">这里不会保存设置，也不会触发同步，只按当前表单里的值生成说明。</p>
      <div id="settingsFlowContent"></div>
      <div class="row modal-actions">
        <button id="closeSettingsHelpBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="renamePreviewModal">
    <div class="panel panel-max">
      <h2>检查旧命名文件</h2>
      <p class="muted">先预览会改哪些远端文件。只有勾选并二次确认后，才会真正修改 AList 网盘文件名。</p>
      <div id="renamePreviewSummary" class="muted"></div>
      <div class="row preview-actions">
        <button id="renameSelectAllBtn" class="ghost" type="button">全选</button>
        <button id="renameSelectNoneBtn" class="ghost" type="button">取消全选</button>
        <button id="refreshRenamePreviewBtn" class="ghost" type="button">重新预览</button>
      </div>
      <div class="rename-list" id="renamePreviewList"></div>
      <div id="renameSkippedBlock" class="skipped-block is-hidden">
        <strong class="block-title">跳过的文件</strong>
        <div class="rename-skip-list" id="renameSkippedList"></div>
      </div>
      <div id="renameResultBlock" class="rename-result result-block is-hidden"></div>
      <div class="row modal-actions split-actions">
        <button id="executeRenameBtn" type="button">确认重命名所选文件</button>
        <button id="closeRenamePreviewBtn" class="ghost" type="button">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="qualityUpgradeModal">
    <div class="panel panel-max">
      <h2>检查可升级画质</h2>
      <p class="muted">按当前 BBDown 画质、编码、Hi-Res、杜比设置重新下载。新版文件上传并验证成功后，才会删除旧远端文件。</p>
      <div id="qualityUpgradeSummary" class="muted"></div>
      <div class="row preview-actions">
        <button id="qualityUpgradeSelectAllBtn" class="ghost" type="button">全选</button>
        <button id="qualityUpgradeSelectNoneBtn" class="ghost" type="button">取消全选</button>
        <button id="refreshQualityUpgradeBtn" class="ghost" type="button">重新预览</button>
      </div>
      <div class="rename-list" id="qualityUpgradeList"></div>
      <div id="qualityUpgradeSkippedBlock" class="skipped-block is-hidden">
        <strong class="block-title">跳过的项目</strong>
        <div class="rename-skip-list" id="qualityUpgradeSkippedList"></div>
      </div>
      <div id="qualityUpgradeResultBlock" class="rename-result result-block is-hidden"></div>
      <div class="row modal-actions split-actions">
        <button id="executeQualityUpgradeBtn" type="button">确认重调所选视频</button>
        <button id="closeQualityUpgradeBtn" class="ghost" type="button">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="cleanupDataModal">
    <div class="panel panel-large">
      <div class="section-title-row">
        <h2>清理数据</h2>
        <button class="help-icon-btn" id="cleanupHelpBtn" type="button" title="看看清理后会发生什么" aria-label="查看清理项目说明">?</button>
      </div>
      <p class="muted">勾选要清理的小抽屉。清理只会碰本项目的 <code>data</code> 和 <code>temp</code>，不会乱动别的地方。</p>
      <div class="row preview-actions">
        <button id="cleanupSelectAllBtn" class="ghost" type="button">全选：完全清除</button>
        <button id="cleanupSelectNoneBtn" class="ghost" type="button">取消全选</button>
        <button id="refreshCleanupBtn" class="ghost" type="button">刷新占用</button>
      </div>
      <div id="cleanupStatus" class="muted"></div>
      <div class="cleanup-list" id="cleanupList"></div>
      <div id="cleanupConfirmBlock" class="cleanup-confirm is-hidden">
        <div class="muted confirm-hint" id="cleanupConfirmHint"></div>
        <input id="cleanupConfirmInput" type="text" autocomplete="off" placeholder="按提示输入确认文字" />
      </div>
      <div id="cleanupResultBlock" class="rename-result result-block is-hidden"></div>
      <div class="row modal-actions split-actions">
        <button id="executeCleanupBtn" type="button">确认清理</button>
        <button id="closeCleanupDataBtn" class="ghost" type="button">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="migrationModal">
    <div class="panel panel-large">
      <h2>数据迁移</h2>
      <p class="muted">导出会打包本地持久化数据；包含账号登录信息时，请把压缩包当作敏感文件保管。</p>
      <div class="cleanup-list">
        <label class="cleanup-item"><input id="migConfig" type="checkbox" checked /><div><div class="cleanup-item-title">全局配置</div><div class="cleanup-item-desc">AList 地址、画质、并发、命名模板等设置。</div></div></label>
        <label class="cleanup-item important"><input id="migUsers" type="checkbox" checked /><div><div class="cleanup-item-title">账号登录信息</div><div class="cleanup-item-desc">包含 B 站 Cookie / token，请勿分享导出包。</div></div></label>
        <label class="cleanup-item important"><input id="migState" type="checkbox" checked /><div><div class="cleanup-item-title">备份状态与下架记录</div><div class="cleanup-item-desc">包含已备份、远端文件、失效视频标题与封面快照。</div></div></label>
        <label class="cleanup-item"><input id="migCovers" type="checkbox" checked /><div><div class="cleanup-item-title">本地封面缓存</div><div class="cleanup-item-desc">半尺寸 WebP q70 封面，用于下架后继续显示。</div></div></label>
        <label class="cleanup-item"><input id="migLogs" type="checkbox" /><div><div class="cleanup-item-title">网页日志</div><div class="cleanup-item-desc">迁移排查线索，通常不必带走。</div></div></label>
        <label class="cleanup-item"><input id="migDebug" type="checkbox" /><div><div class="cleanup-item-title">Debug 日志</div><div class="cleanup-item-desc">BBDown 调试文件，体积可能较大。</div></div></label>
      </div>
      <div class="row preview-actions">
        <button id="exportDataBtn" type="button">导出压缩包</button>
        <button id="chooseImportBtn" class="ghost" type="button">选择导入包</button>
        <input id="migrationFileInput" type="file" accept=".zip,application/zip" class="is-hidden" />
      </div>
      <div id="migrationPreviewBlock" class="cleanup-confirm is-hidden">
        <div class="cleanup-item-title">导入预览</div>
        <div id="migrationPreviewText" class="cleanup-item-desc"></div>
        <div class="row preview-actions">
          <button id="executeImportBtn" type="button">确认导入并自动备份当前数据</button>
        </div>
      </div>
      <div id="migrationStatus" class="rename-result result-block is-hidden"></div>
      <div class="row modal-actions">
        <button id="closeMigrationBtn" class="ghost full-width" type="button">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="cleanupHelpModal">
    <div class="panel panel-narrow">
      <h2>清理小贴士</h2>
      <p class="muted">这里是小扫帚的说明书：有些灰尘可以放心扫，有些是小仓库的钥匙，要确认后再动。</p>
      <div id="cleanupHelpContent" class="cleanup-help-list"></div>
      <p class="muted help-note">如果你准备删容器，先在“清理数据”里全选并确认；如果还要连 AList 也清掉，请停容器后手动删除宿主机的 <code>alist</code> 目录。</p>
      <div class="row modal-actions">
        <button id="closeCleanupHelpBtn" class="ghost full-width" type="button">知道啦</button>
      </div>
    </div>
  </div>

  <div class="modal" id="confirmActionModal">
    <div class="panel panel-narrow">
      <h2 id="confirmActionTitle">确认操作</h2>
      <div id="confirmActionMessage" class="confirm-action-message"></div>
      <div id="confirmActionDetail" class="confirm-action-detail is-hidden"></div>
      <div id="confirmActionInputWrap" class="confirm-action-input-wrap is-hidden">
        <label id="confirmActionInputLabel" for="confirmActionInput">确认文字</label>
        <input id="confirmActionInput" type="text" autocomplete="off" />
        <div id="confirmActionInputHint" class="muted confirm-action-input-hint"></div>
      </div>
      <div class="row modal-actions split-actions">
        <button id="confirmActionOkBtn" type="button">确认</button>
        <button id="confirmActionCancelBtn" class="ghost" type="button">取消</button>
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
    let queueBoardRequestInFlight = false;
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
    let cleanupState = { items: [], runningTransfers: false, activeScheduler: false };
    let migrationSelectedFile = null;
    let lastModalTrigger = null;
    let pendingConfirmAction = null;

    function safeText(value, fallback = '未知') {
      const text = String(value ?? '').trim();
      return text || fallback;
    }

    function localCoverUrl(item) {
      const coverPath = String(item?.coverLocalPath || '').trim();
      return coverPath ? '/' + coverPath.split('/').filter(Boolean).join('/') : '';
    }

    function setHidden(elOrId, hidden) {
      const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
      if (!el) return;
      el.classList.toggle('is-hidden', Boolean(hidden));
    }

    function setStatus(elOrId, text, type = '') {
      const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
      if (!el) return;
      el.textContent = text || '';
      el.classList.remove('status-success', 'status-muted', 'status-error');
      if (type) el.classList.add('status-' + type);
    }

    async function copyTextToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (_) {
          // Fall through to the textarea method when browser clipboard permission is blocked.
        }
      }
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', 'readonly');
      input.className = 'clipboard-fallback-input';
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(input);
      return copied;
    }

    function closeModal(modalOrId) {
      const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
      if (!modal) return;
      if (modal.id === 'loginModal') {
        currentLoginId = null;
      }
      if (modal.id === 'videoDetailModal') {
        videoDetailState.token += 1;
        videoDetailState.loading = false;
        videoDetailState.hasMore = false;
      }
      if (modal.id === 'unavailableModal') {
        unavailableHasMore = false;
        unavailableLoading = false;
      }
      if (modal.id === 'confirmActionModal' && pendingConfirmAction) {
        pendingConfirmAction(false);
        return;
      }
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      if (lastModalTrigger && typeof lastModalTrigger.focus === 'function' && document.contains(lastModalTrigger)) {
        lastModalTrigger.focus();
      }
    }

    function openModal(modalId, trigger) {
      const modal = document.getElementById(modalId);
      if (!modal) return;
      lastModalTrigger = trigger || document.activeElement;
      modal.classList.add('active');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-hidden', 'false');
      const firstButton = modal.querySelector('button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if (firstButton && typeof firstButton.focus === 'function') {
        setTimeout(() => firstButton.focus(), 0);
      }
    }

    function activeModal() {
      const modals = Array.from(document.querySelectorAll('.modal.active'));
      return modals[modals.length - 1] || null;
    }

    function confirmAction(options) {
      return new Promise((resolve) => {
        const modal = document.getElementById('confirmActionModal');
        const okBtn = document.getElementById('confirmActionOkBtn');
        const cancelBtn = document.getElementById('confirmActionCancelBtn');
        const input = document.getElementById('confirmActionInput');
        const inputWrap = document.getElementById('confirmActionInputWrap');
        const detail = document.getElementById('confirmActionDetail');
        const requiredText = String(options.requiredText || '');
        const danger = options.danger !== false;
        const previousModalTrigger = lastModalTrigger;
        document.getElementById('confirmActionTitle').textContent = options.title || '确认操作';
        document.getElementById('confirmActionMessage').textContent = options.message || '确认继续吗？';
        detail.textContent = options.detail || '';
        setHidden(detail, !options.detail);
        document.getElementById('confirmActionInputLabel').textContent = options.inputLabel || '确认文字';
        input.value = '';
        input.placeholder = requiredText || '';
        document.getElementById('confirmActionInputHint').textContent = requiredText ? '请输入 ' + requiredText + ' 后继续。' : '';
        setHidden(inputWrap, !requiredText);
        okBtn.textContent = options.confirmText || '确认';
        cancelBtn.textContent = options.cancelText || '取消';
        okBtn.classList.toggle('danger-action', danger);
        okBtn.disabled = Boolean(requiredText);

        const cleanup = (result) => {
          input.removeEventListener('input', onInput);
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          pendingConfirmAction = null;
          modal.classList.remove('active');
          modal.setAttribute('aria-hidden', 'true');
          if (options.trigger && typeof options.trigger.focus === 'function' && document.contains(options.trigger)) {
            options.trigger.focus();
          }
          lastModalTrigger = previousModalTrigger;
          resolve(result);
        };
        const onInput = () => {
          okBtn.disabled = requiredText ? input.value.trim() !== requiredText : false;
        };
        const onOk = () => {
          if (requiredText && input.value.trim() !== requiredText) return;
          cleanup(true);
        };
        const onCancel = () => cleanup(false);
        input.addEventListener('input', onInput);
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        pendingConfirmAction = cleanup;
        openModal('confirmActionModal', options.trigger);
        setTimeout(() => (requiredText ? input : okBtn).focus(), 0);
      });
    }

    function showToast(message, type = 'error') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      const text = document.createElement('div');
      text.className = 'toast-message';
      text.textContent = String(message || '');
      const close = document.createElement('button');
      close.className = 'toast-close';
      close.type = 'button';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '\u00d7';
      close.addEventListener('click', () => toast.remove());
      toast.appendChild(text);
      toast.appendChild(close);
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

    function formatDateTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString('zh-CN', { hour12: false });
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = bytes;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return (unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 10 ? 1 : 2)) + ' ' + units[unit];
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
      setBBDownApiMode(d.bbdownApiMode || 'web');
      document.getElementById('bbdownHiRes').checked = !!d.bbdownHiRes;
      document.getElementById('bbdownDolby').checked = !!d.bbdownDolby;
      document.getElementById('maxRetries').value = d.maxRetries ?? 3;
      document.getElementById('retryDelaySeconds').value = d.retryDelaySeconds ?? 5;
      document.getElementById('concurrentDownloads').value = d.concurrentDownloads ?? 1;
      document.getElementById('concurrentUploads').value = d.concurrentUploads ?? 2;
      document.getElementById('localCacheLimitGB').value = d.localCacheLimitGB ?? 10;
      document.getElementById('startupRecoveryBatchSize').value = d.startupRecoveryBatchSize ?? 25;
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
        bbdownApiMode: getBBDownApiMode(),
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        maxRetries: Number(document.getElementById('maxRetries').value),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value),
        localCacheLimitGB: Number(document.getElementById('localCacheLimitGB').value),
        startupRecoveryBatchSize: Number(document.getElementById('startupRecoveryBatchSize').value),
        remoteVerifyConcurrency: Number(document.getElementById('remoteVerifyConcurrency').value),
        remoteVerifyRateLimitPerSecond: Number(document.getElementById('remoteVerifyRateLimitPerSecond').value),
        remoteRequeueLimitPerCycle: Number(document.getElementById('remoteRequeueLimitPerCycle').value),
      };
      try {
        await fetchJson('/api/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        setStatus(st, '设置已保存。轮询间隔和并发数立即生效；画质、编码、命名模板、重试次数、AList 路径等对新任务生效，正在运行的任务不会中途切换。', 'success');
      } catch(e) {
        setStatus(st, '保存失败: '+e.message, 'error');
      } finally {
        btn.textContent = '保存设置并生效';
        setTimeout(()=>{ if(!st.classList.contains('status-error')) setStatus(st, ''); },3000);
      }
    }

    function getBBDownApiMode() {
      return document.querySelector('input[name="bbdownApiMode"]:checked')?.value || 'web';
    }

    function setBBDownApiMode(mode) {
      const value = mode === 'app' ? 'app' : 'web';
      const input = document.querySelector('input[name="bbdownApiMode"][value="' + value + '"]');
      if (input) input.checked = true;
    }

    function requireAppModeForPremiumAudio() {
      if (document.getElementById('bbdownHiRes').checked || document.getElementById('bbdownDolby').checked) {
        setBBDownApiMode('app');
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
        hint.className = 'template-empty-hint';
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
        bbdownApiMode: getBBDownApiMode(),
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        maxRetries: Number(document.getElementById('maxRetries').value || 3),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value || 5),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value || 1),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value || 2),
        localCacheLimitGB: Number(document.getElementById('localCacheLimitGB').value || 0),
        startupRecoveryBatchSize: Number(document.getElementById('startupRecoveryBatchSize').value || 25),
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
      openModal('syncHelpModal', document.getElementById('syncHelpBtn'));
    }

    function renderSettingsFlow() {
      const c = readCurrentConfigForm();
      const layoutText = c.uploadLayout === 'user-folder-video' ? '\u7528\u6237\u540d / \u6536\u85cf\u5939\u540d / \u89c6\u9891' : (c.uploadLayout === 'folder-video' ? '\u6536\u85cf\u5939\u540d / \u89c6\u9891' : '\u4ec5\u89c6\u9891\u6587\u4ef6');
      const audioText = [c.bbdownHiRes ? 'Hi-Res' : '', c.bbdownDolby ? 'Dolby' : ''].filter(Boolean).join(' + ') || '\u666e\u901a\u97f3\u9891';
      document.getElementById('settingsFlowContent').innerHTML =
        '<div class="flow-visual">' +
          '<div class="flow-step"><div class="badge">\u81ea\u52a8\u8f6e\u8be2</div><div class="desc">\u7a0b\u5e8f\u6bcf <strong>' + escapeHtml(c.pollIntervalMinutes) + ' \u5206\u949f</strong>\u81ea\u52a8\u68c0\u67e5\u4e00\u6b21\uff1b\u624b\u52a8\u6309\u94ae\u4f1a\u989d\u5916\u63d2\u961f\u89e6\u53d1\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u626b\u63cf\u6536\u85cf\u5939</div><div class="desc">\u53d1\u73b0\u65b0\u89c6\u9891\u540e\u6309\u5f53\u524d\u547d\u540d\u6a21\u677f\u51c6\u5907\u4efb\u52a1\uff1a<code>' + escapeHtml(c.filenameTemplate) + '</code></div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0b\u8f7d\u961f\u5217</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0b\u8f7d <strong>' + escapeHtml(c.concurrentDownloads) + '</strong> \u4e2a\uff1b\u672c\u5730 temp \u8fbe\u5230 <strong>' + escapeHtml(c.localCacheLimitGB || 0) + 'GB</strong> \u8f6f\u4e0a\u9650\u65f6\u4e0d\u518d\u542f\u52a8\u65b0\u4e0b\u8f7d\uff1b\u753b\u8d28\u4e3a <strong>' + escapeHtml(c.bbdownQuality) + '</strong>\uff0c\u7f16\u7801\u4e3a <strong>' + escapeHtml(c.bbdownEncoding) + '</strong>\uff0c\u97f3\u9891\u9009\u9879\u4e3a <strong>' + escapeHtml(audioText) + '</strong>\uff1b\u5206P\u4e4b\u95f4\u5ef6\u8fdf <strong>' + escapeHtml(c.perVideoDelaySeconds) + ' \u79d2</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u5931\u8d25\u91cd\u8bd5</div><div class="desc">\u4e0b\u8f7d\u6216\u4e0a\u4f20\u5931\u8d25\u540e\u6700\u591a\u91cd\u8bd5 <strong>' + escapeHtml(c.maxRetries) + '</strong> \u6b21\uff0c\u6bcf\u6b21\u95f4\u9694 <strong>' + escapeHtml(c.retryDelaySeconds) + ' \u79d2</strong>\uff1b\u4e0b\u8f7d\u5361\u4f4f\u8d85\u8fc7 30 \u5206\u949f\u4e14\u6700\u8fd1 10 \u5206\u949f\u4f4e\u4e8e 10KB/s \u4f1a\u81ea\u52a8\u8fdb\u5165\u91cd\u8bd5\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0a\u4f20 AList</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0a\u4f20 <strong>' + escapeHtml(c.concurrentUploads) + '</strong> \u4e2a\uff1b\u76ee\u6807\u8def\u5f84\u662f <code>' + escapeHtml(c.alistDest) + '</code>\uff0c\u76ee\u5f55\u7ed3\u6784\u662f <strong>' + escapeHtml(layoutText) + '</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u72b6\u6001\u5bf9\u8d26</div><div class="desc">AList \u5bf9\u8d26\u5e76\u53d1 <strong>' + escapeHtml(c.remoteVerifyConcurrency) + '</strong>\uff0c\u9650\u901f <strong>' + escapeHtml(c.remoteVerifyRateLimitPerSecond) + ' \u6b21/\u79d2</strong>\uff0c\u6bcf\u8f6e\u6700\u591a\u8865\u4f20 <strong>' + escapeHtml(c.remoteRequeueLimitPerCycle) + '</strong> \u4e2a\u7f3a\u5931\u89c6\u9891\u3002</div></div>' +
        '</div>' +
        '<div class="effect-groups">' +
          '<div class="effect-group"><strong>\u7acb\u5373\u751f\u6548</strong><div>\u8f6e\u8be2\u95f4\u9694\u3001\u540c\u65f6\u4e0b\u8f7d\u5e76\u53d1\u6570\u3001\u540c\u65f6\u4e0a\u4f20\u5e76\u53d1\u6570\u3001\u672c\u5730\u7f13\u5b58\u8f6f\u4e0a\u9650\uff1b\u753b\u8d28\u91cd\u8c03\u7684\u4e0b\u8f7d\u9636\u6bb5\u5171\u4eab\u4e0b\u8f7d\u961f\u5217\uff0c\u4e0a\u4f20\u66ff\u6362\u9636\u6bb5\u5171\u4eab\u4e0a\u4f20\u961f\u5217\u3002</div></div>' +
          '<div class="effect-group"><strong>\u65b0\u4efb\u52a1\u751f\u6548</strong><div>\u753b\u8d28\u3001\u7f16\u7801\u3001Hi-Res / Dolby\u3001\u547d\u540d\u6a21\u677f\u3001AList \u8def\u5f84\u3001\u4e0a\u4f20\u76ee\u5f55\u7ed3\u6784\u3001\u5931\u8d25\u91cd\u8bd5\u6b21\u6570\u3001\u91cd\u8bd5\u95f4\u9694\u3002</div></div>' +
          '<div class="effect-group"><strong>\u5bf9\u8d26\u65f6\u751f\u6548</strong><div>AList \u5bf9\u8d26\u5e76\u53d1\u6570\u3001AList \u5bf9\u8d26\u9650\u901f\u3001\u6bcf\u8f6e\u6700\u591a\u8865\u4f20\u6570\u91cf\u3002</div></div>' +
        '</div>' +
        '<p class="muted help-note">\u4fee\u6539 AList \u8def\u5f84\u6216\u76ee\u5f55\u7ed3\u6784\u4e0d\u4f1a\u642c\u52a8\u65e7\u6587\u4ef6\uff1b\u547d\u540d\u6a21\u677f\u53ea\u5f71\u54cd\u65b0\u4e0b\u8f7d\uff0c\u65e7\u6587\u4ef6\u8bf7\u901a\u8fc7\u201c\u68c0\u67e5\u65e7\u547d\u540d\u6587\u4ef6\u201d\u9884\u89c8\u540e\u518d\u786e\u8ba4\u91cd\u547d\u540d\u3002AList \u5bf9\u8d26\u9ad8\u5e76\u53d1/\u9ad8\u9650\u901f\u4f1a\u589e\u52a0 AList \u4e0e\u7f51\u76d8\u540e\u7aef\u538b\u529b\uff0c\u5efa\u8bae\u9010\u6b65\u8c03\u9ad8\u3002</p>';
    }

    function openSettingsHelp() {
      renderSettingsFlow();
      openModal('settingsHelpModal', document.getElementById('settingsHelpBtn'));
    }

    const cleanupDescriptions = {
      'memory-cache': '只清掉页面临时记住的收藏夹分页，刷新一下就会重新拿，像擦掉便签纸。',
      temp: '清掉全部临时下载目录，包括可续传会话和已验证旧成品，需要输入 DELETE。',
      'orphan-fragments': '只清掉没有会话清单、无法确认来源的 aria2/tmp/vclip/aclip 等残片，不会删除已接管成品。',
      logs: '清掉网页任务日志。不会影响备份，只是小本本翻到空白页。',
      'debug-logs': '清掉 BBDown 调试日志。排查线索会少一点，但备份状态不受影响。',
      covers: '清掉本地压缩封面缓存。视频下架后可能只能显示占位封面，但备份状态不受影响。',
      exports: '清掉已经生成过的数据迁移导出压缩包。不影响当前项目运行。',
      backups: '清掉导入前自动保存的本地备份包。导入回滚余地会少一点。',
      state: '清掉备份状态、收藏夹索引、远端文件记录和重试记录。项目会忘记自己备份过什么。',
      users: '清掉 B 站账号登录信息。下次需要重新扫码登录。',
      config: '清掉全局配置。AList 地址、画质、并发等会回到默认值。',
    };

    function cleanupRequiredConfirmation(selected) {
      const all = cleanupState.items.length > 0 && cleanupState.items.every((item) => selected.includes(item.key));
      if (all) return 'DELETE ALL PROJECT DATA';
      if (cleanupState.items.some((item) => selected.includes(item.key) && item.important)) return 'DELETE';
      return '';
    }

    function selectedCleanupItems() {
      return Array.from(document.querySelectorAll('.cleanup-check:checked')).map((item) => item.value);
    }

    function cleanupItemRequiresIdle(key) {
      return key !== 'memory-cache' && key !== 'logs' && key !== 'debug-logs' && key !== 'covers' && key !== 'exports' && key !== 'backups';
    }

    function cleanupBusy() {
      return Boolean(cleanupState.runningTransfers || cleanupState.activeScheduler);
    }

    function migrationOptionsFromForm(prefix) {
      return {
        includeConfig: document.getElementById(prefix + 'Config').checked,
        includeUsers: document.getElementById(prefix + 'Users').checked,
        includeState: document.getElementById(prefix + 'State').checked,
        includeCovers: document.getElementById(prefix + 'Covers').checked,
        includeLogs: document.getElementById(prefix + 'Logs').checked,
        includeDebug: document.getElementById(prefix + 'Debug').checked,
      };
    }

    function restoreOptionsFromForm() {
      const opts = migrationOptionsFromForm('mig');
      return {
        restoreConfig: opts.includeConfig,
        restoreUsers: opts.includeUsers,
        restoreState: opts.includeState,
        restoreCovers: opts.includeCovers,
        restoreLogs: opts.includeLogs,
        restoreDebug: opts.includeDebug,
      };
    }

    function setMigrationStatus(text, type) {
      const block = document.getElementById('migrationStatus');
      setHidden(block, !text);
      block.textContent = text || '';
      block.classList.toggle('success', type === 'success');
      block.classList.toggle('error', type === 'error');
    }

    async function openMigration() {
      migrationSelectedFile = null;
      document.getElementById('migrationFileInput').value = '';
      setHidden('migrationPreviewBlock', true);
      setMigrationStatus('', '');
      openModal('migrationModal', document.getElementById('migrationBtn'));
    }

    async function exportMigrationData() {
      const btn = document.getElementById('exportDataBtn');
      btn.disabled = true;
      btn.textContent = '导出中...';
      setMigrationStatus('正在生成压缩包...', '');
      try {
        const res = await fetch('/api/migration/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(migrationOptionsFromForm('mig')),
        });
        if (!res.ok) {
          let message = '导出失败';
          try {
            const data = await res.json();
            message = data.message || message;
          } catch {}
          throw new Error(message);
        }
        const blob = await res.blob();
        const disposition = res.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/i);
        const filename = match ? decodeURIComponent(match[1]) : 'bili-favorites-backup-export.zip';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setMigrationStatus('导出完成。包含账号登录信息的压缩包请妥善保管。', 'success');
      } catch (e) {
        setMigrationStatus(e.message || String(e), 'error');
        showToast(e.message || String(e), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '导出压缩包';
      }
    }

    async function previewMigrationFile(file) {
      if (!file) return;
      const buffer = await file.arrayBuffer();
      migrationSelectedFile = file;
      setMigrationStatus('正在读取导入包...', '');
      const res = await fetch('/api/migration/import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: buffer,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '导入预览失败');
      const manifest = data.data.manifest || {};
      const counts = manifest.counts || {};
      document.getElementById('migrationPreviewText').textContent =
        '版本 ' + safeText(manifest.version, '-') +
        '，导出时间 ' + safeText(formatDateTime(manifest.exportedAt), '-') +
        '；账号 ' + (counts.users || 0) +
        '，视频 ' + (counts.videos || 0) +
        '，关系 ' + (counts.relations || 0) +
        '，已失效视频 ' + (counts.unavailableVideos || 0) +
        '。导入前会自动备份当前 data。';
      setHidden('migrationPreviewBlock', false);
      setMigrationStatus('预览完成，确认后才会写入本地数据。', 'success');
    }

    async function executeMigrationImport() {
      if (!migrationSelectedFile) {
        showToast('先选择导入包并完成预览', 'error');
        return;
      }
      const confirmed = await confirmAction({
        title: '确认导入数据',
        message: '导入会替换你勾选的数据，并在导入前自动备份当前 data。',
        detail: '包含账号登录信息时会恢复 Cookie / token；导入期间不能有同步、下载、上传或对账任务运行。',
        requiredText: 'IMPORT DATA',
        trigger: document.getElementById('executeImportBtn')
      });
      if (!confirmed) return;
      const btn = document.getElementById('executeImportBtn');
      btn.disabled = true;
      btn.textContent = '导入中...';
      setMigrationStatus('正在导入并备份当前数据...', '');
      try {
        const params = new URLSearchParams();
        const restoreOptions = restoreOptionsFromForm();
        Object.entries(restoreOptions).forEach(([key, value]) => {
          params.set(key, value ? 'true' : 'false');
        });
        const res = await fetch('/api/migration/import?' + params.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: migrationSelectedFile,
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.message || '导入失败');
        }
        const data = json.data || {};
        setMigrationStatus('导入完成。已恢复：' + (data.restored || []).join('、') + '；导入前备份：' + safeText(data.backupPath, '-'), 'success');
        await Promise.all([loadConfig(), loadUsers()]);
      } catch (e) {
        setMigrationStatus(e.message || String(e), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '确认导入并自动备份当前数据';
      }
    }

    function renderCleanupConfirm() {
      const selected = selectedCleanupItems();
      const required = cleanupRequiredConfirmation(selected);
      const block = document.getElementById('cleanupConfirmBlock');
      const hint = document.getElementById('cleanupConfirmHint');
      if (!required) {
        setHidden(block, true);
        hint.textContent = '';
        document.getElementById('cleanupConfirmInput').value = '';
        return;
      }
      setHidden(block, false);
      hint.textContent = required === 'DELETE ALL PROJECT DATA'
        ? '你选择了完全清除。请输入 DELETE ALL PROJECT DATA，小扫帚才会认真开工。'
        : '你选择了重要数据。请输入 DELETE 确认，避免手滑把小仓库钥匙丢掉。';
    }

    function renderCleanupList() {
      const list = document.getElementById('cleanupList');
      const st = document.getElementById('cleanupStatus');
      list.innerHTML = '';
      if (cleanupState.runningTransfers || cleanupState.activeScheduler) {
        st.textContent = '当前有同步/扫描/对账或下载/上传任务在跑，临时文件和重要数据先保护起来，不让清理。';
      } else {
        st.textContent = '选择要清理的内容。重要项目会要求二次确认。';
      }
      cleanupState.items.forEach((item) => {
        const disabled = cleanupBusy() && cleanupItemRequiresIdle(item.key);
        const label = document.createElement('label');
        label.className = 'cleanup-item' + (item.important ? ' important' : '') + (disabled ? ' disabled' : '');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = item.key;
        check.className = 'cleanup-check';
        check.disabled = disabled;
        check.addEventListener('change', renderCleanupConfirm);
        const body = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'cleanup-item-title';
        title.textContent = item.label + (item.important ? '（重要）' : '');
        const desc = document.createElement('div');
        desc.className = 'cleanup-item-desc';
        desc.textContent = (cleanupDescriptions[item.key] || '') + (disabled ? ' 现在有任务在忙，这个小抽屉先上锁。' : '');
        body.appendChild(title);
        body.appendChild(desc);
        const size = document.createElement('div');
        size.className = 'cleanup-size';
        size.textContent = formatBytes(item.bytes);
        label.appendChild(check);
        label.appendChild(body);
        label.appendChild(size);
        list.appendChild(label);
      });
      renderCleanupConfirm();
    }

    function renderCleanupHelp() {
      const content = document.getElementById('cleanupHelpContent');
      content.innerHTML = '';
      cleanupState.items.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'cleanup-help-item';
        const title = document.createElement('strong');
        title.textContent = item.label + (item.important ? '：这是重要小抽屉' : '：这是普通小灰尘');
        const text = document.createElement('div');
        text.textContent = cleanupDescriptions[item.key] || '';
        div.appendChild(title);
        div.appendChild(text);
        content.appendChild(div);
      });
    }

    async function loadCleanupState() {
      cleanupState = await fetchJson('/api/storage/cleanup');
      renderCleanupList();
      renderCleanupHelp();
    }

    async function openCleanupData() {
      openModal('cleanupDataModal', document.getElementById('cleanupDataBtn'));
      setHidden('cleanupResultBlock', true);
      await loadCleanupState();
    }

    function setCleanupSelection(value) {
      document.querySelectorAll('.cleanup-check').forEach((item) => {
        if (!item.disabled) item.checked = value;
      });
      renderCleanupConfirm();
    }

    async function executeCleanup() {
      const selected = selectedCleanupItems();
      const resultBlock = document.getElementById('cleanupResultBlock');
      if (!selected.length) {
        showToast('先勾选要清理的小抽屉', 'info');
        return;
      }
      const required = cleanupRequiredConfirmation(selected);
      const confirmation = document.getElementById('cleanupConfirmInput').value.trim();
      if (required && confirmation !== required) {
        showToast('确认文字不对，小扫帚先不动。', 'error');
        return;
      }
      const btn = document.getElementById('executeCleanupBtn');
      btn.disabled = true;
      btn.textContent = '清理中...';
      setHidden(resultBlock, false);
      resultBlock.textContent = '正在清理，请稍等...';
      try {
        const data = await fetchJson('/api/storage/cleanup', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ items: selected, confirmation })
        });
        const lines = ['清理完成：'];
        (data.results || []).forEach((item) => lines.push('已清理：' + item.label));
        resultBlock.textContent = lines.join('\\n');
        showToast('清理完成，小扫帚收工啦', 'success');
        await loadCleanupState();
      } catch(e) {
        resultBlock.textContent = '清理失败：' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '确认清理';
      }
    }

    async function openRenamePreview() {
      openModal('renamePreviewModal', document.getElementById('renameBtn'));
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
      setHidden(resultBlock, true);
      try {
        renamePreviewState = await fetchJson('/api/rename/preview', { method:'POST' });
        renderRenamePreview();
        setStatus(st, '已生成重命名预览：' + renamePreviewState.candidates.length + ' 个可处理，' + renamePreviewState.skipped.length + ' 个跳过。', 'muted');
      } catch(e) {
        summary.textContent = '预览失败：' + e.message;
        setStatus(st, '预览失败: ' + e.message, 'error');
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
        empty.className = 'empty-state';
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
        title.textContent = safeText(item.title || item.bvid, '未知视频') + ' · ' + safeText(item.ownerName, '未知UP');
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
        setHidden(skippedBlock, false);
        skippedList.innerHTML = '';
        skipped.forEach((item) => {
          const div = document.createElement('div');
          div.textContent = safeText(item.path, '<未知路径>') + '：' + safeText(item.reason, '已跳过');
          skippedList.appendChild(div);
        });
      } else {
        setHidden(skippedBlock, true);
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
      const confirmed = await confirmAction({
        title: '确认远端重命名',
        message: '将重命名 ' + selected.length + ' 个远端文件。',
        detail: '此操作会修改 AList 网盘文件名。建议确认预览列表无误后再继续。',
        confirmText: '确认重命名',
        trigger: document.getElementById('executeRenameBtn')
      });
      if (!confirmed) {
        return;
      }
      const btn = document.getElementById('executeRenameBtn');
      const resultBlock = document.getElementById('renameResultBlock');
      btn.textContent = '重命名中...';
      btn.disabled = true;
      setHidden(resultBlock, false);
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
      openModal('qualityUpgradeModal', document.getElementById('qualityUpgradeBtn'));
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
      setHidden(resultBlock, true);
      try {
        qualityUpgradePreviewState = await fetchJson('/api/quality-upgrade/preview', { method:'POST' });
        renderQualityUpgradePreview();
        setStatus(st, '已生成画质重调预览：' + qualityUpgradePreviewState.candidates.length + ' 个可处理，' + qualityUpgradePreviewState.skipped.length + ' 个跳过。', 'muted');
      } catch(e) {
        summary.textContent = '预览失败：' + e.message;
        setStatus(st, '预览失败: ' + e.message, 'error');
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
        empty.className = 'empty-state';
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
        title.textContent = safeText(item.title || item.bvid, '未知视频') + ' · ' + safeText(item.ownerName, '未知UP');
        const folder = document.createElement('div');
        folder.className = 'rename-path';
        folder.textContent = '收藏夹：' + safeText(item.folderTitle, 'favorites') + '；目录：' + safeText(item.remotePath, '-');
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
        setHidden(skippedBlock, false);
        skippedList.innerHTML = '';
        skipped.forEach((item) => {
          const div = document.createElement('div');
          div.textContent = safeText(item.title || item.bvid || item.folderTitle, '<未知项目>') + '：' + safeText(item.reason, '已跳过');
          skippedList.appendChild(div);
        });
      } else {
        setHidden(skippedBlock, true);
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
      const confirmed = await confirmAction({
        title: '确认画质重调',
        message: '将为 ' + selected.length + ' 个视频重新下载并上传新版文件。',
        detail: '新版文件上传并验证成功后，才会删除旧远端文件。运行期间会占用下载和上传队列。',
        confirmText: '确认重调',
        trigger: document.getElementById('executeQualityUpgradeBtn')
      });
      if (!confirmed) {
        return;
      }
      const btn = document.getElementById('executeQualityUpgradeBtn');
      const resultBlock = document.getElementById('qualityUpgradeResultBlock');
      btn.textContent = '提交中...';
      btn.disabled = true;
      setHidden(resultBlock, false);
      resultBlock.textContent = '正在提交画质重调任务...';
      try {
        const payload = selected.map((item) => ({ key:item.key }));
        const chunkSize = 50;
        const queued = [];
        const skipped = [];
        for (let start = 0; start < payload.length; start += chunkSize) {
          const chunk = payload.slice(start, start + chunkSize);
          const batchIndex = Math.floor(start / chunkSize) + 1;
          const batchTotal = Math.ceil(payload.length / chunkSize);
          resultBlock.textContent = '正在提交画质重调任务：第 ' + batchIndex + '/' + batchTotal + ' 批（已处理 ' + start + '/' + payload.length + '）...';
          const result = await fetchJson('/api/quality-upgrade', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ items:chunk })
          });
          if (Array.isArray(result.queued)) queued.push(...result.queued);
          if (Array.isArray(result.skipped)) skipped.push(...result.skipped);
        }
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
        setStatus(st, '画质重调：运行中 ' + running.length + ' 个；最近完成/失败 ' + completed.length + ' 个。', 'muted');
      } catch(e) {
        setStatus(st, '画质重调状态读取失败: ' + e.message, 'error');
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
        name.className = 'user-name';
        name.textContent = safeText(user.name, '未命名账号');

        const meta = document.createElement('div');
        meta.className = 'muted user-meta';
        meta.textContent = 'UID: ' + safeText(user.uid, '-') + ' | 收藏夹: ' + safeText(user.favoritesCount, '-') + ' | ' + safeText(user.expiresText, '未知过期时间');

        const favoritesWrap = document.createElement('div');
        favoritesWrap.className = 'favorite-chip-list';
        for (const favorite of (user.favorites || [])) {
          const chip = document.createElement('span');
          chip.className = 'favorite-chip';
          chip.textContent = safeText(favorite.title, '未命名收藏夹');
          favoritesWrap.appendChild(chip);
        }

        const actions = document.createElement('div');
        actions.className = 'row user-actions';

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
        removeBtn.className = 'ghost danger-ghost';
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
        const health = user.authHealth || {};
        const authHealth = document.createElement('div');
        authHealth.className = 'auth-health ' + (health.level || 'warn');
        const authTitle = document.createElement('div');
        authTitle.className = 'auth-health-title';
        authTitle.textContent = health.summary || '授权状态未知';
        const authDetail = document.createElement('div');
        authDetail.className = 'auth-health-detail';
        authDetail.textContent = health.detail || '无法判断当前账号是否支持自动刷新。';
        authHealth.appendChild(authTitle);
        authHealth.appendChild(authDetail);
        if (health.lastSuccessAt) {
          const lastSuccess = document.createElement('div');
          lastSuccess.className = 'auth-health-detail';
          lastSuccess.textContent = '最近刷新成功：' + formatDateTime(health.lastSuccessAt);
          authHealth.appendChild(lastSuccess);
        }
        if (health.autoRefreshEnabled) {
          const autoRefresh = document.createElement('div');
          autoRefresh.className = 'auth-health-detail';
          autoRefresh.textContent = health.needsManualLogin ? '自动刷新凭据存在，但当前失败需要处理。' : '自动刷新凭据完整，适合无人值守运行。';
          authHealth.appendChild(autoRefresh);
        }
        item.appendChild(authHealth);
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
      openModal('loginModal', document.getElementById('addUserBtn'));
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
          setTimeout(()=>{ closeModal('loginModal'); loadUsers(); },1000);
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
      loading.className = 'empty-state loading-state';
      loading.textContent = '加载中...';
      list.appendChild(loading);
      openModal('favoritesModal');
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
        content.className = 'fav-content';

        const title = document.createElement('div');
        title.className = 'fav-title';
        title.textContent = safeText(folder.title, '未命名收藏夹');

        const count = document.createElement('div');
        count.className = 'fav-count';
        count.textContent = String(folder.mediaCount || 0) + ' 个视频';

        content.appendChild(title);
        content.appendChild(count);
        lbl.appendChild(content);

        const detail = document.createElement('button');
        detail.className = 'ghost compact-button';
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
      if (item.backupStatus === 'partial_verified') {
        stateClass = 'processed';
        badgeClass = 'partial';
        badgeText = '部分备份';
      } else if (item.unavailable && item.processed) {
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
      } else if (item.backupStatus === 'upload_failed') {
        stateClass = '';
        badgeClass = 'upload-pending';
        badgeText = '待补传';
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
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = item.cover ? item.cover.replace('http://','https://') : '';
      const coverUrl = (!remoteCoverUrl || item.unavailable) && cachedCoverUrl ? cachedCoverUrl : remoteCoverUrl;
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
      titleEl.title = safeText(item.title || item.bvid, '未知视频');
      titleEl.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.textContent = 'UP: ' + safeText(item.upperName || item.ownerName, '未知UP') + ' | ' + safeText(item.bvid, '-');
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
      const loading = /加载|正在/.test(String(text || ''));
      status.className = (loading ? 'empty-state loading-state' : 'empty-state') + (isError ? ' video-detail-status error' : ' video-detail-status');
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
        setHidden(hint, true);
        return;
      }
      setHidden(hint, false);
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
      openModal('videoDetailModal');
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
      openModal('unavailableModal');
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
        meta.textContent = '收藏夹: ' + safeText(item.folderTitle, '未知');
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
      setTimeout(()=>closeModal('favoritesModal'),500);
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
        setHidden(board, true);
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
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const coverUrl = (!remoteCoverUrl || item.unavailable) && cachedCoverUrl ? cachedCoverUrl : remoteCoverUrl;
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
        titleEl.textContent = safeText(item.title || item.bvid, '未知任务');
        titleEl.title = safeText(item.title || item.bvid, '未知任务');
      }
      if (metaEl) {
        metaEl.textContent = 'UP: ' + safeText(item.upperName || item.ownerName, '未知UP') + ' | ' + safeText(item.bvid, '-');
      }
      if (extraEl) {
        const retryAt = Number(item.retryAt || 0);
        const retryWaiting = retryAt > nowMs;
        const t0 = Number((retryWaiting ? retryAt : 0) || item.startedAt || item.queuedAt || 0);
        const elapsed = t0 > 0 ? formatElapsed(Math.abs(nowMs - t0)) : '0s';
        extraEl.innerHTML = '';
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'queue-pill';
          detail.textContent = String(item.detail);
          extraEl.appendChild(detail);
        }
        const retry = document.createElement('span');
        retry.className = 'queue-pill';
        retry.textContent = '重试 ' + Number(item.retries || 0) + '/' + Number(item.maxRetries || 0);
        const time = document.createElement('span');
        time.className = 'queue-pill';
        time.textContent = retryWaiting ? '等待重试 ' + elapsed : queueElapsedLabel(item) + ' ' + elapsed;
        extraEl.appendChild(retry);
        extraEl.appendChild(time);
      }
    }

    function renderQueueCard(item, nowMs) {
      const card = document.createElement('div');
      card.className = 'queue-card';
      card.dataset.queueKey = makeQueueCardKey(item);
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const coverUrl = (!remoteCoverUrl || item.unavailable) && cachedCoverUrl ? cachedCoverUrl : remoteCoverUrl;
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
      title.textContent = safeText(item.title || item.bvid, '未知任务');
      title.title = safeText(item.title || item.bvid, '未知任务');
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

    function renderSchedulerStatus(parent, scheduler) {
      let box = document.getElementById('schedulerStatusBox');
      if (!box) {
        box = document.createElement('details');
        box.id = 'schedulerStatusBox';
        parent.parentElement.insertBefore(box, parent);
      }
      const status = scheduler || {};
      box.className = 'scheduler-status ' + (status.status || 'idle');
      const queued = Array.isArray(status.queuedActions) && status.queuedActions.length ? status.queuedActions.join('、') : '无';
      const nextRun = status.nextRunAt ? formatDateTime(status.nextRunAt) : '未知';
      const started = status.startedAt ? formatDateTime(status.startedAt) : '未运行';
      const progress = status.total ? String(status.checked || 0) + '/' + String(status.total) : (status.biliTotal ? String(status.indexed || 0) + '/' + String(status.biliTotal) : '无');
      const recovery = status.recovery || {};
      const recoveryText = '上传 ' + Number(recovery.pendingUploads || 0) + ' / 下载 ' + Number(recovery.pendingDownloads || 0) + '（每批 ' + Number(recovery.batchSize || 25) + '）';
      box.innerHTML = '';
      const summary = document.createElement('summary');
      summary.className = 'scheduler-status-main';
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'scheduler-status-title';
      title.textContent = status.title || '当前调度空闲';
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
        ['任务状态', status.status || 'idle'],
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

    function renderLocalCacheStatus(parent, localCache, recovery) {
      const host = parent.parentElement || parent;
      let el = host.querySelector('[data-local-cache-status="1"]');
      const hasRecovery = recovery && (
        Number(recovery.resumableSessions || 0) > 0 ||
        Number(recovery.legacyDirectories || 0) > 0 ||
        Number(recovery.cleanupEligibleBytes || 0) > 0
      );
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
      el.classList.toggle('paused', !!localCache?.paused);
      el.textContent = localCache?.paused
        ? '下载暂停：本地缓存 ' + used + ' / ' + limit + '，已预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) + ' 安全空间；上传队列不受影响。' + resumeText
        : '本地缓存：' + used + ' / ' + limit + (limitBytes > 0 ? '，安全预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) : '') + '。' + resumeText;
    }

    function renderUploadHealthStatus(parent, uploadHealth) {
      const host = parent.parentElement || parent;
      let el = host.querySelector('[data-upload-health-status="1"]');
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
      el.textContent = '上传后端异常，下载已暂停：' + (uploadHealth.reason || 'AList 上传暂不可用') + '；' + modeText + '。本地文件已保留为“待补传”。';
    }

    function renderDownloadApiHealthStatus(parent, downloadApiHealth) {
      const host = parent.parentElement || parent;
      let el = host.querySelector('[data-download-api-health-status="1"]');
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
      if (logMode !== 'queue' || queueBoardRequestInFlight) return;
      const board = ensureQueueBoardHost();
      if (!board) return;
      queueBoardRequestInFlight = true;
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
        renderSchedulerStatus(grid, { ...(snapshot.scheduler || {}), recovery: snapshot.recovery || {} });
        renderLocalCacheStatus(grid, snapshot.localCache || null, snapshot.downloadRecovery || null);
        renderDownloadApiHealthStatus(grid, snapshot.downloadApiHealth || null);
        renderUploadHealthStatus(grid, snapshot.uploadHealth || null);
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
        board.innerHTML = '<div class="empty-state video-detail-status error">队列看板加载失败</div>';
        queueBoardState.columns = {};
        queueBoardState.cards.clear();
      } finally {
        queueBoardRequestInFlight = false;
      }
    }

    function stopQueueBoardPolling() {
      if (queueBoardPollTimer) {
        clearInterval(queueBoardPollTimer);
        queueBoardPollTimer = null;
      }
      queueBoardRequestInFlight = false;
    }

    function resetQueueBoardState() {
      queueBoardState.columns = {};
      queueBoardState.cards.clear();
      const board = document.getElementById('queueBoard');
      if (board) {
        board.parentElement?.querySelector('[data-local-cache-status="1"]')?.remove();
        board.parentElement?.querySelector('[data-download-api-health-status="1"]')?.remove();
        board.parentElement?.querySelector('[data-upload-health-status="1"]')?.remove();
        board.innerHTML = '';
      }
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
        setHidden(logConsole, true);
        setHidden(queueBoard, false);
        startQueueBoardPolling();
        return;
      }
      stopQueueBoardPolling();
      setHidden(queueBoard, true);
      resetQueueBoardState();
      setHidden(logConsole, false);
      rebuildLog();
    }

    // ---- Event Bindings ----
    document.getElementById('addUserBtn').addEventListener('click', startLogin);
    document.getElementById('closeLoginBtn').addEventListener('click', () => closeModal('loginModal'));
    document.getElementById('saveFavoritesBtn').addEventListener('click', saveFavorites);
    document.getElementById('closeFavoritesBtn').addEventListener('click', () => closeModal('favoritesModal'));
    document.getElementById('closeVideoDetailBtn').addEventListener('click', () => closeModal('videoDetailModal'));
    document.getElementById('closeUnavailableBtn').addEventListener('click', () => closeModal('unavailableModal'));
    document.getElementById('syncHelpBtn').addEventListener('click', openSyncHelp);
    document.getElementById('settingsHelpBtn').addEventListener('click', openSettingsHelp);
    document.getElementById('closeSyncHelpBtn').addEventListener('click', () => closeModal('syncHelpModal'));
    document.getElementById('closeSettingsHelpBtn').addEventListener('click', () => closeModal('settingsHelpModal'));
    document.getElementById('syncHelpSimpleBtn').addEventListener('click', () => { syncHelpMode = 'simple'; renderSyncHelp(); });
    document.getElementById('syncHelpDetailBtn').addEventListener('click', () => { syncHelpMode = 'detail'; renderSyncHelp(); });
    document.getElementById('closeRenamePreviewBtn').addEventListener('click', () => closeModal('renamePreviewModal'));
    document.getElementById('renameSelectAllBtn').addEventListener('click', () => setRenameSelection(true));
    document.getElementById('renameSelectNoneBtn').addEventListener('click', () => setRenameSelection(false));
    document.getElementById('refreshRenamePreviewBtn').addEventListener('click', loadRenamePreview);
    document.getElementById('executeRenameBtn').addEventListener('click', executeSelectedRename);
    document.getElementById('closeQualityUpgradeBtn').addEventListener('click', () => closeModal('qualityUpgradeModal'));
    document.getElementById('migrationBtn').addEventListener('click', openMigration);
    document.getElementById('closeMigrationBtn').addEventListener('click', () => closeModal('migrationModal'));
    document.getElementById('exportDataBtn').addEventListener('click', exportMigrationData);
    document.getElementById('chooseImportBtn').addEventListener('click', () => document.getElementById('migrationFileInput').click());
    document.getElementById('migrationFileInput').addEventListener('change', async (event) => {
      try {
        const file = event.target.files && event.target.files[0];
        await previewMigrationFile(file);
      } catch (e) {
        migrationSelectedFile = null;
        setHidden('migrationPreviewBlock', true);
        setMigrationStatus(e.message || String(e), 'error');
        showToast(e.message || String(e), 'error');
      }
    });
    document.getElementById('executeImportBtn').addEventListener('click', executeMigrationImport);
    document.getElementById('cleanupDataBtn').addEventListener('click', openCleanupData);
    document.getElementById('closeCleanupDataBtn').addEventListener('click', () => closeModal('cleanupDataModal'));
    document.getElementById('cleanupHelpBtn').addEventListener('click', () => openModal('cleanupHelpModal', document.getElementById('cleanupHelpBtn')));
    document.getElementById('closeCleanupHelpBtn').addEventListener('click', () => closeModal('cleanupHelpModal'));
    document.getElementById('cleanupSelectAllBtn').addEventListener('click', () => setCleanupSelection(true));
    document.getElementById('cleanupSelectNoneBtn').addEventListener('click', () => setCleanupSelection(false));
    document.getElementById('refreshCleanupBtn').addEventListener('click', loadCleanupState);
    document.getElementById('executeCleanupBtn').addEventListener('click', executeCleanup);
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
    document.querySelectorAll('.modal').forEach((modal) => {
      modal.setAttribute('aria-hidden', 'true');
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const modal = activeModal();
        if (modal) closeModal(modal);
      }
    });
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
      if (action === 'remove') {
        const confirmed = await confirmAction({
          title: '删除账号',
          message: '确定要删除这个账号吗？',
          detail: '账号登录信息会从本项目中移除，后续需要重新扫码登录。',
          confirmText: '删除账号',
          trigger: t
        });
        if (confirmed) { await fetchJson('/api/users/'+userId,{method:'DELETE'}); await loadUsers(); }
      }
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
        const confirmed = await confirmAction({
          title: '导出 Cookie',
          message: 'Cookie 等同于 B 站登录凭据。',
          detail: '导出后请只在可信环境使用，不要发送给不可信的人或服务。',
          requiredText: 'EXPORT_COOKIE',
          inputLabel: '输入 EXPORT_COOKIE 确认导出',
          confirmText: '导出 Cookie',
          trigger: t
        });
        if (!confirmed) return;
        const resp = await fetchJson('/api/users/'+userId+'/cookie/export', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({confirm:'EXPORT_COOKIE'})
        });
        const text = String(resp.cookie || '');
        if (await copyTextToClipboard(text)) {
          showToast('Cookie 已复制', 'success');
        } else {
          showToast('Cookie 导出成功，但浏览器阻止了自动复制', 'info');
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
      const ok = await confirmAction({
        title: '确认全量扫描并对账',
        message: '将全量扫描 B 站收藏夹所有页，并执行对账。',
        detail: '这个操作请求量较大，可能触发 412、登录校验或风控。建议仅在首轮补齐、迁移目录后或确实需要时使用。',
        confirmText: '继续扫描',
        trigger: document.getElementById('reconcileBtn')
      });
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
    document.getElementById('bbdownHiRes').addEventListener('change', requireAppModeForPremiumAudio);
    document.getElementById('bbdownDolby').addEventListener('change', requireAppModeForPremiumAudio);
    document.getElementById('bbdownApiModeControl').addEventListener('change', (event) => {
      if (event.target?.value === 'web' && (document.getElementById('bbdownHiRes').checked || document.getElementById('bbdownDolby').checked)) {
        setBBDownApiMode('app');
        setStatus(document.getElementById('configStatus'), 'Hi-Res / Dolby 需要 APP 接口。', 'error');
      }
    });
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
