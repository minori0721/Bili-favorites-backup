import { appInfo } from "./app-info.js";
import { decidePlaybackMediaError, resolvePlaybackDeliveryViewStatus } from "./playback-policy.js";

const appFaviconHref = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#39C5BB"/>
  <path d="M22 16l10 8 10-8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="23" width="36" height="27" rx="7" fill="none" stroke="#fff" stroke-width="4"/>
  <rect x="24" y="33" width="5" height="4" rx="1.5" fill="#fff"/>
  <rect x="35" y="33" width="5" height="4" rx="1.5" fill="#fff"/>
</svg>
`)}`;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function getLinkClass(baseClass: string, className: string) {
  return className ? `${baseClass} ${className}` : baseClass;
}

function getVersionLink(className = "") {
  return `<a class="${getLinkClass("version-link", className)}" href="${escapeHtml(appInfo.versionUrl)}" target="_blank" rel="noopener noreferrer" title="查看当前构建">${escapeHtml(appInfo.versionLabel)}</a>`;
}

function getGithubLink(className = "") {
  return `<a class="${getLinkClass("github-link", className)}" href="${escapeHtml(appInfo.repositoryUrl)}" target="_blank" rel="noopener noreferrer" aria-label="打开 GitHub 项目" title="打开 GitHub 项目">GitHub <span aria-hidden="true">↗</span></a>`;
}

function getVersionLinks(className = "") {
  return `${getVersionLink(className)}\n    ${getGithubLink(className)}`;
}

function getFaviconLink() {
  return `<link rel="icon" type="image/svg+xml" href="${appFaviconHref}" />`;
}

export function renderLoginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${getFaviconLink()}
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
    input:not([type="checkbox"]) {
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
    input:not([type="checkbox"]):focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(57, 197, 187, 0.16);
    }
    .remember-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin: -2px 0 20px;
      cursor: pointer;
      font-weight: 500;
    }
    .remember-option input {
      width: 17px;
      height: 17px;
      margin: 2px 0 0;
      accent-color: var(--accent);
      flex: 0 0 auto;
    }
    .remember-option input:focus-visible {
      outline: 3px solid rgba(57, 197, 187, 0.24);
      outline-offset: 2px;
    }
    .remember-copy { display: grid; gap: 3px; line-height: 1.35; }
    .remember-hint { color: var(--muted); font-size: 12px; font-weight: 400; }
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
    .login-meta { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:8px 12px; margin-top:20px; font-size:12px; }
    .login-meta a { color:var(--muted); text-decoration:none; border-radius:6px; }
    .login-meta a:hover,.login-meta a:focus-visible { color:var(--accent); outline:none; text-decoration:underline; text-underline-offset:3px; }
    @media (prefers-reduced-motion: reduce) {
      *,*::before,*::after { animation-duration:0.01ms!important; animation-iteration-count:1!important; transition-duration:0.01ms!important; scroll-behavior:auto!important; }
    }
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
    <form id="loginForm">
      <label for="username">管理员用户名</label>
      <input id="username" type="text" autocomplete="username" placeholder="输入用户名" />
      <label for="password">密码</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="输入密码" />
      <label class="remember-option" for="rememberLogin">
        <input id="rememberLogin" type="checkbox" />
        <span class="remember-copy">
          <span>保持登录30天</span>
          <span class="remember-hint">未勾选时为浏览器会话，服务端最长保留24小时</span>
        </span>
      </label>
      <button id="loginBtn" type="submit">进入系统</button>
    </form>
    <div class="error" id="error" aria-live="polite"></div>
    <div class="login-meta">${getVersionLinks("login-link")}</div>
  </div>
  <script>
    const loginForm = document.getElementById('loginForm');
    const errorEl = document.getElementById('error');
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value.trim();
      const remember = document.getElementById('rememberLogin').checked;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember })
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
  ${getFaviconLink()}
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
  <div id="toastContainer" class="toast-container" aria-live="polite" aria-atomic="false"></div>
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
      --archive-muted: #526B66; --archive-muted-soft: #5A716D;
    }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Noto Sans SC",sans-serif; background:radial-gradient(circle at 10% -10%,rgba(57,197,187,0.18) 0%,transparent 30%),radial-gradient(circle at 86% 4%,rgba(224,247,250,0.68) 0%,transparent 28%),linear-gradient(180deg,#ffffff 0%,var(--bg) 52%); color:var(--ink); }
    html.modal-open,body.modal-open { overflow:hidden; overscroll-behavior:none; }
    header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px 20px; padding:20px 32px; background:rgba(255,255,255,0.72); backdrop-filter:var(--glass-blur); border-bottom:1px solid rgba(214,240,237,0.76); position:sticky; top:0; z-index:10; box-shadow:0 8px 30px rgba(57,197,187,0.05); }
    header h1 { margin:0; font-size:24px; color:var(--accent); font-weight:700; }
    .app-brand,.header-actions { display:flex; align-items:center; min-width:0; }
    .app-brand { gap:10px; flex:1 1 260px; }
    .header-actions { gap:10px; flex:0 0 auto; }
    .version-link,.github-link { color:var(--muted); text-decoration:none; white-space:nowrap; transition:color .2s,border-color .2s,background .2s; }
    .version-link { max-width:220px; overflow:hidden; text-overflow:ellipsis; padding:4px 7px; border:1px solid rgba(214,240,237,0.95); border-radius:7px; background:rgba(255,255,255,0.66); font-size:12px; font-weight:600; }
    .github-link { padding:7px 4px; font-size:14px; font-weight:600; }
    .version-link:hover,.version-link:focus-visible,.github-link:hover,.github-link:focus-visible { color:var(--accent); border-color:var(--accent); outline:none; }
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
    .favorite-chip { display:inline-block; padding:4px 10px; background:rgba(57,197,187,0.1); color:var(--ink); border:1px solid transparent; border-radius:999px; font:inherit; font-size:12px; margin:2px; }
    button.favorite-chip { cursor:pointer; }
    button.favorite-chip:hover,button.favorite-chip:focus-visible { border-color:var(--accent); color:var(--accent); outline:none; background:rgba(57,197,187,0.16); }
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
    input[type="text"],input[type="url"],input[type="number"],input[type="password"],select { width:100%; padding:11px 13px; border-radius:12px; border:1px solid var(--glass-border-strong); font-size:14px; outline:none; transition:all 0.2s; background:var(--glass-input); box-shadow:inset 0 1px 0 rgba(255,255,255,0.72); }
    input:focus,select:focus { border-color:var(--accent); box-shadow:0 0 0 4px rgba(57,197,187,0.14), inset 0 1px 0 rgba(255,255,255,0.8); background:white; }
    .checkbox-label { display:flex; align-items:center; gap:8px; font-weight:500; cursor:pointer; margin:0; }
    .checkbox-label input { width:auto; margin:0; }
    .encoding-priority-editor { display:grid; gap:7px; padding:8px; border:1px solid var(--glass-border-strong); border-radius:12px; background:rgba(255,255,255,0.62); }
    .encoding-priority-item { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:9px; align-items:center; min-height:46px; padding:7px 9px; border:1px solid rgba(214,240,237,0.95); border-radius:9px; background:#fff; cursor:grab; }
    .encoding-priority-item:active { cursor:grabbing; }
    .encoding-priority-item.dragging { opacity:.55; border-color:var(--accent); }
    .encoding-priority-rank { display:grid; place-items:center; width:24px; height:24px; border-radius:50%; background:rgba(57,197,187,.12); color:#24766F; font-size:11px; font-weight:800; }
    .encoding-priority-copy { min-width:0; display:grid; gap:2px; }
    .encoding-priority-name { color:var(--ink); font-weight:800; }
    .encoding-priority-hint { color:var(--muted); font-size:11px; }
    .encoding-priority-actions { display:flex; gap:4px; }
    .encoding-priority-actions button { width:30px; height:30px; padding:0; border:1px solid rgba(57,197,187,.36); border-radius:7px; background:#fff; color:var(--accent); cursor:pointer; font-weight:800; }
    .encoding-priority-actions button:hover,.encoding-priority-actions button:focus-visible { background:rgba(57,197,187,.1); outline:2px solid rgba(57,197,187,.18); outline-offset:1px; }
    .encoding-priority-actions button:disabled { opacity:.35; cursor:not-allowed; }
    .encoding-strict-option { margin-top:10px; }
    .encoding-retry-copy { margin:0 0 14px; color:#4D6862; line-height:1.65; }
    .encoding-retry-status { min-height:22px; margin-top:8px; color:#A53838; font-size:12px; }
    .modal { position:fixed; inset:0; background:rgba(26,47,45,0.50); backdrop-filter:blur(8px); display:flex; align-items:center; justify-content:center; padding:16px; z-index:100; opacity:0; pointer-events:none; transition:opacity .16s ease; }
    .modal.active { opacity:1; pointer-events:auto; }
    .modal.is-closing { opacity:0; pointer-events:none; }
    .modal > .panel,
    .modal > .archive-library-shell,
    .modal > .playback-shell,
    .modal > .recovery-issues-shell { opacity:0; transform:translateY(6px) scale(.995); transition:opacity .18s cubic-bezier(.16,1,.3,1),transform .18s cubic-bezier(.16,1,.3,1); }
    .modal.active:not(.is-closing) > .panel,
    .modal.active:not(.is-closing) > .archive-library-shell,
    .modal.active:not(.is-closing) > .playback-shell,
    .modal.active:not(.is-closing) > .recovery-issues-shell { opacity:1; transform:none; }
    .modal.active.is-closing > .panel,
    .modal.active.is-closing > .archive-library-shell,
    .modal.active.is-closing > .playback-shell,
    .modal.active.is-closing > .recovery-issues-shell { opacity:0; transform:translateY(3px) scale(.998); transition-duration:.13s; }
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
    .video-grid { display:grid; gap:12px; max-height:min(500px, calc(90vh - 250px)); overflow-y:auto; overflow-x:hidden; }
    .video-item { min-width:0; max-width:100%; overflow:hidden; display:flex; gap:12px; padding:11px; border-radius:12px; border:1px solid var(--glass-border); align-items:center; transition:all 0.2s; background:rgba(255,255,255,0.62); }
    .video-detail-status { text-align:center; padding:10px; color:var(--muted); font-size:13px; }
    .video-detail-status.error { color:#E57373; }
    .video-detail-status .retry-button { margin-left:8px; padding:5px 10px; min-height:30px; border:1px solid rgba(57,197,187,0.45); border-radius:8px; background:rgba(255,255,255,0.78); color:var(--accent); cursor:pointer; font-weight:650; }
    .video-detail-status .retry-button:hover,.video-detail-status .retry-button:focus-visible { border-color:var(--accent); background:rgba(57,197,187,0.08); outline:2px solid rgba(57,197,187,0.2); outline-offset:2px; }
    .video-detail-status .retry-button:disabled { opacity:.55; cursor:not-allowed; }
    .video-detail-hint { color:var(--muted); font-size:12px; margin:-4px 0 10px; line-height:1.6; }
    .video-item.processed { background:var(--success-bg); border-color:var(--success); }
    .video-item.unavailable-uploaded { background:#FFF8E1; border-color:#FFC107; box-shadow:0 0 0 1px #FFC107; }
    .video-item.unavailable-missing { background:#FFEBEE; border-color:#FFCDD2; }
    .video-cover { width:120px; height:75px; object-fit:cover; border-radius:8px; background:#eee; flex-shrink:0; }
    .video-info { flex:1 1 auto; min-width:0; overflow:hidden; }
    .video-title { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .video-meta { font-size:12px; color:var(--muted); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .video-badges { flex:0 0 auto; display:flex; align-items:center; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
    .video-badge { flex:0 0 auto; display:inline-block; white-space:nowrap; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:600; }
    .video-badge.done { background:var(--success); color:white; }
    .video-badge.pending { background:var(--border); color:var(--muted); }
    .video-badge.upload-pending { background:#FFB74D; color:#5D4300; }
    .video-badge.partial { background:#42A5F5; color:white; }
    .video-badge.removed-uploaded { background:#FFC107; color:#1A2F2D; }
    .video-badge.removed-missing { background:#EF9A9A; color:white; }
    .video-badge.history { background:rgba(77,94,92,0.12); color:var(--muted); border:1px solid var(--glass-border-strong); }
    .video-item.playable { cursor:pointer; }
    .video-item.playable:hover { border-color:var(--accent); box-shadow:0 8px 22px rgba(57,197,187,0.13); transform:translateY(-1px); }
    .video-item.playable:focus-visible { outline:3px solid rgba(57,197,187,0.30); outline-offset:2px; border-color:var(--accent); }
    .video-cover-wrap { position:relative; flex:0 0 auto; width:120px; height:75px; border-radius:8px; overflow:hidden; background:#eee; }
    .video-cover-wrap .video-cover { width:100%; height:100%; border-radius:0; }
    .video-play-affordance { position:absolute; inset:0; display:none; place-items:center; opacity:0; pointer-events:none; background:transparent; color:white; font-size:24px; text-shadow:0 2px 8px rgba(0,0,0,0.35); transform:scale(0.96); transition:opacity .16s ease,background-color .16s ease,transform .16s ease; }
    @media (hover:hover) and (pointer:fine) {
      .video-play-affordance { display:grid; }
      .video-item.playable:hover .video-play-affordance,
      .video-item.playable:focus-visible .video-play-affordance { opacity:1; background:rgba(18,28,27,0.42); transform:scale(1); }
    }
    @media (max-width:720px), (hover:none), (pointer:coarse) {
      .video-play-affordance { display:none!important; }
    }
    .video-play-reason { display:block; color:var(--muted); font-size:11px; margin-top:5px; }
    .archive-library-modal { padding:0; align-items:stretch; background:rgba(20,35,33,0.58); backdrop-filter:blur(10px); }
    .archive-library-shell { position:relative; width:100%; height:100dvh; min-width:0; overflow:hidden; display:grid; grid-template-columns:280px minmax(0,1fr); background:#F5F9F8; color:var(--ink); }
    .archive-library-sidebar { min-width:0; min-height:0; display:flex; flex-direction:column; border-right:1px solid #DCE8E6; background:#EEF5F3; }
    .archive-library-brand { min-height:72px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid #DCE8E6; }
    .archive-library-brand h2 { margin:0; font-size:18px; color:#21413D; letter-spacing:0; }
    .archive-library-close,.archive-library-mobile-back,.archive-library-detail-close { width:36px; height:36px; display:inline-grid; place-items:center; border:1px solid #CADAD7; border-radius:50%; background:#FFFFFF; color:#38534F; padding:0; font-size:21px; cursor:pointer; }
    .archive-library-close:hover,.archive-library-close:focus-visible,.archive-library-mobile-back:hover,.archive-library-mobile-back:focus-visible,.archive-library-detail-close:hover,.archive-library-detail-close:focus-visible { border-color:var(--accent); color:var(--accent); outline:2px solid rgba(57,197,187,0.18); outline-offset:2px; }
    .archive-library-nav { min-height:0; flex:1 1 auto; overflow:auto; padding:10px; overscroll-behavior:contain; }
    .archive-nav-account { margin-top:12px; }
    .archive-nav-account:first-child { margin-top:0; }
    .archive-nav-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; color:#667D79; font-size:11px; font-weight:750; }
    .archive-nav-heading strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#375550; font-size:12px; }
    .archive-nav-list { display:grid; gap:3px; }
    .archive-nav-item { width:100%; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; border:0; border-left:3px solid transparent; border-radius:5px; background:transparent; color:#395550; padding:9px 9px 9px 8px; text-align:left; cursor:pointer; }
    .archive-nav-preview { display:none; position:relative; width:100%; aspect-ratio:16/9; overflow:hidden; border-radius:5px; background:#DFE9E7; }
    .archive-nav-preview img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
    .archive-nav-item:hover { background:#E4EFEC; }
    .archive-nav-item:focus-visible { outline:2px solid rgba(57,197,187,0.35); outline-offset:1px; }
    .archive-nav-item.active { border-left-color:var(--accent); background:#DDF1ED; color:#183F3A; }
    .archive-nav-copy { min-width:0; }
    .archive-nav-title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:680; }
    .archive-nav-meta { display:block; margin-top:2px; color:var(--archive-muted); font-size:10px; }
    .archive-nav-count { color:var(--archive-muted); font-size:11px; font-variant-numeric:tabular-nums; }
    .archive-nav-empty { padding:18px 10px; color:var(--archive-muted); font-size:12px; text-align:center; }
    .archive-nav-inactive { margin-top:7px; border-top:1px solid #DCE8E6; padding-top:7px; }
    .archive-nav-inactive summary { cursor:pointer; color:var(--archive-muted); font-size:11px; font-weight:700; padding:7px 8px; }
    .archive-nav-deletion { margin:7px 8px 3px; border-left:3px solid #39C5BB; background:#F0F8F6; padding:8px 9px; color:#526B66; font-size:10px; line-height:1.55; }
    .archive-nav-deletion button { margin-top:6px; border:1px solid #D6E2DF; border-radius:5px; background:#FFFFFF; color:#526B66; padding:5px 8px; font:inherit; font-weight:700; cursor:pointer; }
    .archive-nav-deletion button:focus-visible { outline:2px solid rgba(57,197,187,.30); outline-offset:2px; }
    .archive-library-main { min-width:0; min-height:0; display:flex; flex-direction:column; background:#F8FBFA; }
    .archive-library-topbar { flex:0 0 auto; min-height:72px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid #E0EAE8; background:rgba(255,255,255,0.92); }
    .archive-library-heading { min-width:0; }
    .archive-library-heading h2 { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#21413D; font-size:18px; letter-spacing:0; }
    .archive-library-heading span { display:block; margin-top:3px; color:var(--archive-muted); font-size:11px; }
    .archive-library-mobile-back { display:none; flex:0 0 auto; font-size:19px; }
    .archive-library-toolbar { flex:0 0 auto; display:grid; grid-template-columns:minmax(220px,1fr) auto auto; gap:10px; align-items:center; padding:12px 20px; border-bottom:1px solid #E5EDEA; background:#FFFFFF; }
    .archive-library-search { position:relative; min-width:0; }
    .archive-library-search input { width:100%; height:40px; border:1px solid #CCDAD7; border-radius:6px; background:#F8FBFA; padding:8px 38px 8px 12px; font:inherit; font-size:13px; }
    .archive-library-search input:focus { border-color:var(--accent); outline:none; box-shadow:0 0 0 3px rgba(57,197,187,0.13); }
    .archive-library-search-clear { position:absolute; top:5px; right:5px; width:30px; height:30px; border:0; border-radius:4px; background:transparent; color:#6D817D; padding:0; font-size:18px; cursor:pointer; }
    .archive-library-search-clear:hover,.archive-library-search-clear:focus-visible { background:#E8F1EF; outline:none; color:#244B46; }
    .archive-library-segment { display:flex; min-width:0; gap:2px; padding:3px; border:1px solid #D7E2E0; border-radius:6px; background:#F2F7F6; }
    .archive-library-segment button { min-height:30px; border:0; border-radius:4px; background:transparent; color:#667D79; padding:5px 10px; font:inherit; font-size:11px; font-weight:680; cursor:pointer; white-space:nowrap; }
    .archive-library-segment button.active { background:#FFFFFF; color:#176E66; box-shadow:0 1px 4px rgba(31,65,61,0.10); }
    .archive-library-segment button:focus-visible { outline:2px solid rgba(57,197,187,0.30); outline-offset:1px; }
    .archive-library-sort { width:auto; min-width:118px; height:38px; border-radius:6px; padding:7px 28px 7px 10px; font-size:12px; background:#FFFFFF; }
    .archive-library-filterbar { flex:0 0 auto; display:flex; align-items:center; gap:7px; padding:10px 20px; overflow-x:auto; border-bottom:1px solid #E7EFED; background:#F8FBFA; scrollbar-width:thin; }
    .archive-library-filterbar button { flex:0 0 auto; border:1px solid #D6E2DF; border-radius:5px; background:#FFFFFF; color:#607672; padding:6px 11px; font:inherit; font-size:11px; font-weight:680; cursor:pointer; }
    .archive-library-filterbar button.active { border-color:#52BDB4; background:#E4F5F2; color:#176E66; }
    .archive-library-filterbar button:focus-visible { outline:2px solid rgba(57,197,187,0.28); outline-offset:2px; }
    .archive-library-results { min-height:0; flex:1 1 auto; overflow:auto; overscroll-behavior:contain; padding:18px 20px 28px; scrollbar-gutter:stable; }
    .archive-library-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:18px 14px; align-items:start; }
    .archive-library-card { position:relative; min-width:0; overflow:hidden; border:1px solid transparent; border-radius:7px; background:transparent; color:inherit; }
    .archive-library-card:hover { background:#FFFFFF; border-color:#DCE7E5; box-shadow:0 8px 22px rgba(36,72,67,0.09); }
    .archive-library-card-main { display:block; width:100%; border:0; background:transparent; color:inherit; padding:0; text-align:left; cursor:pointer; }
    .archive-library-card-main:focus-visible { outline:3px solid rgba(57,197,187,0.28); outline-offset:-3px; }
    .archive-library-card-more { position:absolute; z-index:2; top:7px; right:7px; width:32px; height:32px; display:grid; place-items:center; border:1px solid rgba(255,255,255,.55); border-radius:50%; background:rgba(23,39,36,.78); color:#FFFFFF; padding:0; font-size:19px; line-height:1; cursor:pointer; }
    .archive-library-card-more:hover,.archive-library-card-more:focus-visible { background:#176E66; outline:2px solid rgba(57,197,187,.30); outline-offset:2px; }
    .archive-library-cover { position:relative; display:block; width:100%; aspect-ratio:16/9; overflow:hidden; border-radius:6px; background:#E3EBE9; }
    .archive-library-cover img { display:block; width:100%; height:100%; object-fit:cover; }
    .archive-library-placeholder { position:absolute; inset:0; display:grid; place-items:center; color:#82938F; font-size:22px; font-weight:800; background:#E5ECEA; }
    .archive-library-cover-badges { position:absolute; left:7px; right:7px; bottom:7px; display:flex; justify-content:space-between; gap:6px; align-items:flex-end; pointer-events:none; }
    .archive-library-cover-badge { max-width:75%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:4px; background:rgba(18,28,27,0.80); color:#F4F7F6; padding:3px 6px; font-size:10px; }
    .archive-library-card-copy { display:block; padding:9px 7px 10px; }
    .archive-library-title { display:-webkit-box; min-height:39px; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; color:#263F3B; font-size:13px; font-weight:720; line-height:1.48; }
    .archive-library-meta { display:block; margin-top:6px; overflow:hidden; color:var(--archive-muted); font-size:10px; line-height:1.55; text-overflow:ellipsis; white-space:nowrap; }
    .archive-library-memberships { display:block; margin-top:5px; overflow:hidden; color:var(--archive-muted-soft); font-size:10px; line-height:1.5; text-overflow:ellipsis; white-space:nowrap; }
    .archive-library-status { display:inline-flex; flex:0 0 auto; align-items:center; max-width:100%; border-radius:4px; padding:3px 6px; font-size:10px; font-weight:750; white-space:nowrap; }
    .archive-library-status.playable { background:#DDF4E7; color:#267047; }
    .archive-library-status.pending { background:#FFF0CF; color:#8A6111; }
    .archive-library-status.issue { background:#FDE4E2; color:#A0433C; }
    .archive-library-status.deleted { background:#E8ECEB; color:#52615E; }
    .archive-library-footer { min-height:38px; display:flex; justify-content:center; align-items:center; padding:10px; color:var(--archive-muted); font-size:11px; text-align:center; }
    .archive-library-footer button { margin-left:7px; border:0; background:transparent; color:#16877D; padding:4px; font:inherit; font-weight:700; cursor:pointer; }
    .archive-library-empty { grid-column:1/-1; min-height:220px; display:grid; place-items:center; color:var(--archive-muted); font-size:13px; text-align:center; }
    .archive-library-detail { position:absolute; z-index:4; top:0; right:0; bottom:0; width:min(440px,100%); display:flex; flex-direction:column; border-left:1px solid #D8E3E0; background:#FFFFFF; box-shadow:-20px 0 50px rgba(25,52,48,0.14); transform:translateX(102%); visibility:hidden; transition:transform .16s ease,visibility 0s linear .16s; }
    .archive-library-detail.open { transform:translateX(0); visibility:visible; transition-delay:0s; }
    .archive-library-detail-head { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:64px; padding:12px 16px; border-bottom:1px solid #E0EAE8; }
    .archive-library-detail-head h3 { margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#21413D; font-size:16px; }
    .archive-library-detail-body { min-height:0; overflow:auto; padding:16px; }
    .archive-library-detail-cover { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:6px; background:#E5ECEA; }
    .archive-library-detail-meta { margin:10px 0 14px; color:var(--archive-muted-soft); font-size:12px; line-height:1.65; }
    .archive-library-source { border-top:1px solid #E5ECEA; padding:12px 0; }
    .archive-library-source:first-child { border-top:0; }
    .archive-library-source strong { display:block; color:#2D4B46; font-size:13px; }
    .archive-library-source span { display:block; margin-top:4px; color:var(--archive-muted); font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
    .archive-library-source-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:9px; }
    .archive-library-source-actions button { border:1px solid #D6E2DF; border-radius:5px; background:#FFFFFF; color:#526B66; padding:6px 10px; font:inherit; font-size:11px; font-weight:700; cursor:pointer; }
    .archive-library-source-actions button.danger-action { border-color:#E5AAA4; background:#FFF3F2; color:#A13D35; }
    .archive-library-source-actions button:disabled { cursor:not-allowed; opacity:.58; }
    .archive-library-source-actions button:focus-visible { outline:2px solid rgba(57,197,187,.30); outline-offset:2px; }
    .archive-library-source-reason { color:var(--archive-muted)!important; font-size:10px!important; }
    .archive-deletion-progress { margin-top:10px; border-left:3px solid #39C5BB; background:#F0F8F6; padding:9px 10px; color:#526B66; font-size:11px; line-height:1.65; }
    .archive-library-detail-retry { margin-top:12px; border:1px solid #63BFB7; border-radius:5px; background:#EDF8F6; color:#176E66; padding:7px 12px; font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
    .archive-library-detail-retry:focus-visible { outline:2px solid rgba(57,197,187,0.30); outline-offset:2px; }
    @media (max-width:720px), (max-height:480px) and (pointer:coarse) {
      .archive-library-shell { display:block; }
      .archive-library-sidebar,.archive-library-main { position:absolute; inset:0; width:100%; height:100%; border:0; transition:transform .16s ease; }
      .archive-library-sidebar { z-index:2; background:#F4F8F7; }
      .archive-library-main { z-index:3; transform:translateX(100%); }
      .archive-library-shell.show-content .archive-library-sidebar { transform:translateX(-22%); visibility:hidden; }
      .archive-library-shell.show-content .archive-library-main { transform:translateX(0); }
      .archive-library-brand { min-height:62px; }
      .archive-library-nav { padding:10px 12px 24px; }
      .archive-nav-account { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; margin-top:14px; }
      .archive-nav-heading,.archive-nav-inactive { grid-column:1/-1; }
      .archive-nav-list { display:contents; }
      .archive-nav-item { min-height:104px; display:flex; flex-direction:column; justify-content:flex-end; align-items:stretch; border:1px solid #D7E3E0; border-left-width:1px; border-radius:7px; padding:8px; background:#FFFFFF; }
      .archive-nav-item.active { border-color:#62C7BE; }
      .archive-nav-preview { display:block; margin-bottom:7px; }
      .archive-nav-copy { width:100%; }
      .archive-nav-count { margin-top:5px; }
      .archive-library-topbar { min-height:62px; justify-content:flex-start; padding:9px 12px; }
      .archive-library-mobile-back { display:inline-grid; }
      .archive-library-heading { flex:1 1 auto; }
      .archive-library-heading h2 { font-size:16px; }
      .archive-library-toolbar { grid-template-columns:minmax(0,1fr) auto; padding:10px 12px; }
      .archive-library-segment { grid-column:1/-1; order:3; }
      .archive-library-segment button { flex:1; }
      .archive-library-sort { min-width:106px; }
      .archive-library-filterbar { padding:8px 12px; }
      .archive-library-results { padding:12px 10px 22px; scrollbar-gutter:auto; }
      .archive-library-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 8px; }
      .archive-library-card-copy { padding:8px 4px; }
      .archive-library-title { min-height:37px; font-size:12px; }
      .archive-library-memberships { display:none; }
      .archive-library-detail { top:auto; width:100%; height:min(72dvh,620px); border-left:0; border-top:1px solid #D8E3E0; transform:translateY(102%); }
      .archive-library-detail.open { transform:translateY(0); }
    }
    @media (max-width:380px) {
      .archive-library-grid { grid-template-columns:1fr; }
    }
    @media (pointer:coarse) {
      .archive-library-close,.archive-library-mobile-back,.archive-library-detail-close,.archive-library-card-more { width:44px; height:44px; }
      .archive-library-search-clear { top:0; right:0; width:44px; height:44px; }
      .archive-library-segment button,.archive-library-filterbar button,.archive-library-source-actions button,.archive-library-detail-retry,
      .video-detail-status .retry-button,.playback-message-actions button,.playback-tool-button,.playback-part-button,
      .recovery-issues-status button,.log-toggle button { min-height:44px; }
      .playback-close,.playback-search-clear,.playback-shell.is-mobile-immersive .playback-queue-close,
      .help-icon-btn,.section-title-row .help-icon-btn,.toast-close { width:44px; height:44px; min-width:44px; min-height:44px; }
      .playback-immersive-control { min-width:44px; height:44px; min-height:44px; }
      .playback-search-clear { top:0; right:0; }
    }
    @media (prefers-reduced-motion:reduce) {
      .archive-library-card,.archive-library-detail,.archive-library-sidebar,.archive-library-main { transition:none!important; }
    }
    .account-removal-options { display:grid; gap:9px; margin:14px 0; }
    .account-removal-option { display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; align-items:start; border:1px solid #D8E3E0; border-radius:7px; background:#F8FBFA; padding:11px; cursor:pointer; }
    .account-removal-option:focus-within { border-color:#39C5BB; box-shadow:0 0 0 3px rgba(57,197,187,.12); }
    .account-removal-option input { width:17px; height:17px; margin:2px 0 0; }
    .account-removal-option strong { display:block; color:#294943; font-size:13px; }
    .account-removal-option span { display:block; margin-top:3px; color:#718581; font-size:11px; line-height:1.55; }
    .account-removal-preview { border:1px solid #E2EAE8; border-radius:6px; background:#FFFFFF; padding:10px 12px; color:#526B66; font-size:12px; line-height:1.7; }
    .playback-modal { padding:18px; align-items:stretch; background:rgba(11,16,16,0.88); backdrop-filter:blur(12px); }
    .playback-shell { width:min(1480px,100%); min-width:0; height:calc(100dvh - 36px); margin:auto; overflow:hidden; display:flex; flex-direction:column; color:#F4F7F6; background:#151B1A; border:1px solid #34413F; border-radius:8px; box-shadow:0 28px 80px rgba(0,0,0,0.38); animation:playbackEnter .18s ease-out; }
    .playback-header { flex:0 0 auto; min-width:0; display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:68px; padding:13px 16px 13px 20px; border-bottom:1px solid #2D3836; background:#19201F; }
    .playback-heading { min-width:0; }
    .playback-eyebrow { color:#69D9D0; font-size:11px; font-weight:700; }
    .playback-heading h2 { margin:3px 0 0; color:#F4F7F6; font-size:17px; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; letter-spacing:0; }
    .playback-close { width:38px; height:38px; flex:0 0 auto; border:1px solid #465451; border-radius:50%; background:#222B29; color:#F4F7F6; font-size:22px; line-height:1; cursor:pointer; }
    .playback-close:hover,.playback-close:focus-visible { border-color:#39C5BB; color:#69D9D0; outline:none; }
    .playback-layout { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) clamp(320px,27vw,380px); }
    .playback-main { min-width:0; min-height:0; display:flex; flex-direction:column; background:#0F1413; }
    .playback-stage { position:relative; min-width:0; flex:1 1 auto; min-height:260px; display:grid; place-items:center; overflow:hidden; background:#090C0B; }
    .playback-stage.is-portrait .art-video-player video { object-fit:contain!important; }
    .playback-art { width:100%; height:100%; min-height:0; }
    .playback-art .art-video-player { width:100%; height:100%; }
    .playback-stage-message { position:absolute; inset:0; z-index:999; display:flex; align-items:center; justify-content:center; padding:28px; background:#090C0B; }
    .playback-message-inner { max-width:520px; text-align:center; }
    .playback-message-inner strong { display:block; color:#F4F7F6; font-size:18px; margin-bottom:8px; }
    .playback-message-inner p { margin:0; color:#A9B5B2; line-height:1.7; font-size:13px; }
    .playback-message-actions { margin-top:18px; display:flex; justify-content:center; gap:10px; flex-wrap:wrap; }
    .playback-message-actions button,.playback-tool-button { min-height:36px; border:1px solid #475653; border-radius:6px; background:#202927; color:#F4F7F6; padding:7px 12px; cursor:pointer; font-weight:600; }
    .playback-tool-button:disabled { opacity:.38; cursor:not-allowed; }
    .playback-message-actions button.primary,.playback-tool-button.active { border-color:#39C5BB; background:#39C5BB; color:#0B1B19; }
    .playback-now { flex:0 0 auto; min-width:0; padding:14px 18px 15px; border-top:1px solid #293331; background:#171E1D; }
    .playback-now-line { min-width:0; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .playback-now-copy { min-width:0; }
    .playback-now-title { margin:0; color:#F4F7F6; font-size:16px; line-height:1.45; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .playback-now-meta { color:#98A6A3; font-size:12px; line-height:1.55; margin-top:4px; white-space:normal; overflow-wrap:anywhere; }
    .playback-now-meta a { color:#69D9D0; text-decoration:none; }
    .playback-now-meta a:hover,.playback-now-meta a:focus-visible { color:#9BECE6; text-decoration:underline; outline:none; }
    .playback-tools { flex:0 0 auto; display:flex; gap:8px; align-items:center; }
    .playback-tool-button { width:38px; padding:0; font-size:18px; }
    .playback-continuous { width:auto; min-width:82px; padding:0 10px; font-size:12px; }
    .playback-part-list { display:flex; gap:7px; min-width:0; margin-top:11px; overflow-x:auto; padding-bottom:2px; }
    .playback-part-button { flex:0 0 auto; min-width:42px; min-height:30px; border:1px solid #3E4B49; border-radius:5px; background:#202725; color:#C5CECC; padding:5px 9px; cursor:pointer; font-size:12px; }
    .playback-part-button.active { border-color:#39C5BB; background:rgba(57,197,187,0.16); color:#7FE4DC; }
    .playback-mobile-mode-toggle { display:none; width:auto; min-width:94px; padding:0 10px; font-size:12px; }
    .playback-immersive-topbar,.playback-immersive-meta,.playback-drawer-backdrop,.playback-queue-close { display:none; }
    .playback-immersive-alist { display:inline-block; margin-top:6px; color:#9BECE6; font-size:11px; text-decoration:none; pointer-events:auto; }
    .playback-queue { min-width:0; min-height:0; display:flex; flex-direction:column; border-left:1px solid #2D3836; background:#171E1D; }
    .playback-queue-head { flex:0 0 auto; display:flex; flex-direction:column; gap:11px; padding:14px 14px 12px; border-bottom:1px solid #2D3836; }
    .playback-queue-heading { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .playback-queue-heading strong { color:#F4F7F6; font-size:14px; }
    .playback-queue-heading span,.playback-search-status { color:#899794; font-size:11px; }
    .playback-search-controls { min-width:0; }
    .playback-search-box { position:relative; display:block; }
    .playback-search-input { width:100%; height:36px; border:1px solid #394744; border-radius:6px; background:#101615; color:#EFF5F3; padding:7px 35px 7px 11px; font:inherit; font-size:12px; outline:none; }
    .playback-search-input::placeholder { color:#71807C; }
    .playback-search-input:focus { border-color:#39C5BB; box-shadow:0 0 0 2px rgba(57,197,187,0.12); }
    .playback-search-clear { position:absolute; top:4px; right:4px; width:28px; height:28px; border:0; border-radius:4px; background:transparent; color:#93A19E; font-size:18px; line-height:1; cursor:pointer; }
    .playback-search-clear:hover,.playback-search-clear:focus-visible { background:#27312F; color:#F4F7F6; outline:none; }
    .playback-search-status { display:block; min-height:16px; margin-top:5px; }
    .playback-search-status button { border:0; background:transparent; color:#69D9D0; padding:0 0 0 6px; cursor:pointer; font:inherit; font-weight:650; }
    .playback-queue-list { min-height:0; flex:1 1 auto; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:7px 8px; }
    .playback-queue-item { width:100%; min-width:0; display:grid; grid-template-columns:26px 72px minmax(0,1fr); gap:8px; align-items:center; overflow:hidden; border:0; border-left:3px solid transparent; border-radius:4px; background:transparent; color:#DCE3E1; padding:8px 7px 8px 4px; text-align:left; cursor:pointer; overflow-anchor:auto; transition:background-color .15s ease,border-color .15s ease,color .15s ease; }
    .playback-queue-item:hover { background:#202927; }
    .playback-queue-item:focus-visible { background:#202927; outline:1px solid #52605E; outline-offset:-1px; }
    .playback-queue-item.active { background:rgba(57,197,187,0.10); border-left-color:#39C5BB; color:#F2FAF8; }
    .playback-queue-number { color:#6E7E7A; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:10px; text-align:right; }
    .playback-queue-item.active .playback-queue-number { color:#69D9D0; }
    .playback-queue-item.active .playback-queue-title { color:#F2FAF8; }
    .playback-queue-thumb { position:relative; width:72px; height:45px; overflow:hidden; border-radius:4px; background:#222A28; }
    .playback-queue-thumb img { display:block; width:100%; height:100%; object-fit:cover; }
    .playback-queue-placeholder { position:absolute; inset:0; display:grid; place-items:center; color:#65736F; font-size:15px; font-weight:750; background:#202725; }
    .playback-queue-copy { min-width:0; }
    .playback-queue-title { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; font-size:12px; font-weight:650; line-height:1.45; }
    .playback-queue-meta { color:#85938F; font-size:11px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .playback-queue-empty { color:#82908D; font-size:12px; text-align:center; padding:28px 12px; }
    .playback-queue-sentinel { min-height:1px; overflow-anchor:none; }
    .playback-queue-feedback { display:flex; justify-content:center; align-items:center; min-height:28px; padding:4px 8px; color:#82908D; font-size:11px; text-align:center; overflow-anchor:none; }
    .playback-queue-feedback button { border:0; background:transparent; color:#69D9D0; padding:4px 6px; cursor:pointer; font:inherit; font-weight:650; }
    @keyframes playbackEnter { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
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
    .queue-board-notice { border:1px solid rgba(255,183,77,0.75); border-radius:10px; background:#FFF8E1; color:#8D6E00; padding:8px 10px; margin:0 0 10px; font-size:12px; }
    .queue-board-notice.error { border-color:rgba(214,90,90,0.5); background:#FFF1F1; color:#9B2C2C; }
    .queue-board { display:grid; grid-template-columns:repeat(4,minmax(260px,1fr)); gap:12px; width:100%; max-width:100%; min-width:0; max-height:430px; overflow-x:auto; overflow-y:hidden; padding-bottom:4px; align-items:stretch; }
    .queue-col { min-width:0; border:1px solid var(--glass-border); border-radius:16px; background:var(--glass-surface); padding:10px; height:clamp(280px,42vh,420px); display:flex; flex-direction:column; overflow:hidden; box-shadow:inset 0 1px 0 rgba(255,255,255,0.7); }
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
    .queue-cover { width:64px; height:44px; object-fit:cover; display:flex; align-items:center; justify-content:center; border-radius:6px; background:#eee; color:#9aa8a6; font-size:10px; flex-shrink:0; }
    .queue-info { min-width:0; flex:1; }
    .queue-title { font-size:12px; font-weight:700; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .queue-meta { font-size:11px; color:var(--muted); margin-top:3px; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .queue-extra { font-size:11px; color:var(--muted); margin-top:4px; display:flex; gap:6px; flex-wrap:wrap; }
    .queue-status { flex:1 1 100%; min-width:0; color:var(--ink); line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .queue-pill { border-radius:999px; background:rgba(57,197,187,0.1); color:var(--accent); padding:1px 6px; line-height:1.5; }
    .queue-recovery-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:7px; }
    .queue-recovery-actions button { border:1px solid var(--accent); border-radius:8px; padding:4px 8px; background:rgba(57,197,187,0.08); color:var(--accent); cursor:pointer; font-size:11px; font-weight:700; }
    .queue-recovery-actions button:hover,.queue-recovery-actions button:focus-visible { background:rgba(57,197,187,0.18); outline:2px solid rgba(57,197,187,0.24); outline-offset:1px; }
    .queue-recovery-actions button.danger-action { border-color:#D65A5A; color:#A83232; background:rgba(214,90,90,0.08); }
    .queue-recovery-actions button:disabled { cursor:wait; opacity:.58; }
    .recovery-issues-entry { position:relative; }
    .recovery-issues-entry.has-issues { border-color:#D98B36; color:#8D4D08; background:#FFF7EA; }
    .recovery-issues-entry.has-danger { border-color:#C94F4F; color:#9B2C2C; background:#FFF0F0; }
    .recovery-issues-modal { padding:0; align-items:stretch; }
    .recovery-issues-shell { width:min(1220px,100%); height:min(820px,100dvh); margin:auto; display:grid; grid-template-rows:auto auto minmax(0,1fr); overflow:hidden; background:#F4F8F7; border:1px solid #D8E3E0; border-radius:10px; box-shadow:0 24px 80px rgba(18,38,35,.22); }
    .recovery-issues-shell.is-empty { height:min(520px,100dvh); }
    .recovery-issues-header { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 18px; border-bottom:1px solid #D8E3E0; background:#FFF; }
    .recovery-issues-heading { min-width:0; }
    .recovery-issues-heading h2 { margin:0; font-size:18px; }
    .recovery-issues-heading p { margin:4px 0 0; color:#60736F; font-size:12px; line-height:1.45; }
    .recovery-issues-summary { min-width:132px; padding:7px 10px; border:1px solid #D7E5E1; border-radius:7px; background:#F4F9F7; color:#3D5D57; font-size:12px; font-weight:800; text-align:center; }
    .recovery-issues-summary:empty { visibility:hidden; }
    .recovery-issues-close,.recovery-issues-back { width:44px; height:44px; border:1px solid #C9D8D5; border-radius:50%; background:#FFF; color:#28443F; font-size:21px; cursor:pointer; flex:0 0 auto; }
    .recovery-issues-back { display:none; font-size:18px; }
    .recovery-issues-status { display:flex; align-items:center; gap:12px; min-height:48px; padding:9px 18px; border-bottom:1px solid #E8D6B8; background:#FFF7EA; color:#8D4D08; font-size:13px; line-height:1.45; }
    .recovery-issues-status[hidden] { display:none; }
    .recovery-issues-status-message { min-width:0; flex:1; overflow-wrap:anywhere; }
    .recovery-issues-status button { min-height:34px; padding:6px 12px; border:1px solid #B86F1B; border-radius:7px; background:#FFF; color:#8D4D08; font-weight:800; cursor:pointer; flex:0 0 auto; }
    .recovery-issues-status button:hover,.recovery-issues-status button:focus-visible { background:#FFF0D8; outline:2px solid rgba(184,111,27,.22); outline-offset:1px; }
    .recovery-issues-status button:disabled { cursor:wait; opacity:.58; }
    .recovery-issues-layout { min-height:0; display:grid; grid-template-columns:minmax(280px,350px) minmax(0,1fr); }
    .recovery-issues-layout.is-empty { grid-template-columns:minmax(0,1fr); }
    .recovery-issues-list-pane { min-height:0; overflow:auto; border-right:1px solid #D8E3E0; background:#EEF4F2; padding:14px; }
    .recovery-issues-list-pane[hidden],.recovery-issues-detail[hidden] { display:none!important; }
    .recovery-issues-list-header { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:0 2px 9px; color:#28443F; font-size:13px; }
    .recovery-issues-list-header span { color:#6B817B; font-size:11px; font-weight:700; }
    .recovery-issues-list { display:grid; gap:9px; }
    .recovery-issue-row { width:100%; min-height:92px; display:grid; grid-template-columns:8px minmax(0,1fr) auto; gap:10px; align-items:start; padding:12px; border:1px solid #D7E2DF; border-radius:8px; background:#FFF; color:#233E39; text-align:left; cursor:pointer; }
    .recovery-issue-row:hover,.recovery-issue-row:focus-visible,.recovery-issue-row.active { border-color:#39AFA5; outline:none; box-shadow:0 0 0 3px rgba(57,197,187,.12); }
    .recovery-issue-marker { width:8px; height:8px; margin-top:7px; border-radius:50%; background:#5C8F88; }
    .recovery-issue-row.warning .recovery-issue-marker { background:#D98B36; }
    .recovery-issue-row.danger .recovery-issue-marker { background:#C94F4F; }
    .recovery-issue-row-copy { min-width:0; display:grid; gap:5px; }
    .recovery-issue-row-status { width:max-content; max-width:100%; padding:2px 7px; border-radius:999px; background:#EAF5F2; color:#27736A; font-size:10px; font-weight:800; line-height:1.35; }
    .recovery-issue-row.warning .recovery-issue-row-status { background:#FFF3DF; color:#99601C; }
    .recovery-issue-row.danger .recovery-issue-row-status { background:#FCE9E9; color:#A53838; }
    .recovery-issue-row-title { display:block; overflow:hidden; font-size:13px; font-weight:800; line-height:1.4; text-overflow:ellipsis; white-space:nowrap; }
    .recovery-issue-row-problem { display:block; overflow:hidden; color:#4D6862; font-size:11px; line-height:1.4; text-overflow:ellipsis; white-space:nowrap; }
    .recovery-issue-row-meta { display:block; overflow:hidden; color:#71837F; font-size:11px; line-height:1.4; text-overflow:ellipsis; white-space:nowrap; }
    .recovery-issue-row-arrow { align-self:center; color:#6B817B; font-size:18px; line-height:1; }
    .recovery-issues-detail { min-width:0; min-height:0; overflow:auto; background:#FFF; padding:24px clamp(18px,3vw,38px) 36px; }
    .recovery-issues-detail:focus { outline:none; }
    .recovery-detail-kicker { width:max-content; max-width:100%; padding:3px 8px; border-radius:999px; background:#EAF5F2; color:#27736A; font-size:11px; font-weight:800; }
    .recovery-detail-kicker.warning { background:#FFF3DF; color:#99601C; }
    .recovery-detail-kicker.danger { background:#FCE9E9; color:#A53838; }
    .recovery-detail-title { margin:10px 0 3px; font-size:22px; line-height:1.3; color:#183A34; overflow-wrap:anywhere; }
    .recovery-detail-problem { margin:0; color:#4D6862; font-size:13px; font-weight:700; line-height:1.5; }
    .recovery-detail-meta { margin-top:7px; color:#687B77; font-size:12px; overflow-wrap:anywhere; }
    .recovery-target-card { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:18px; padding:12px; border:1px solid #DCE9E6; border-radius:8px; background:#F7FBFA; }
    .recovery-target-field { min-width:0; display:grid; gap:3px; }
    .recovery-target-field-label { color:#71837F; font-size:10px; font-weight:700; }
    .recovery-target-field-value { overflow-wrap:anywhere; color:#28443F; font-size:12px; font-weight:800; line-height:1.45; }
    .recovery-detail-section { padding:16px 0; border-bottom:1px solid #E4ECEA; }
    .recovery-detail-section h3 { margin:0 0 8px; font-size:13px; color:#3D5D57; }
    .recovery-detail-section p { margin:0; color:#263E3A; line-height:1.7; }
    .recovery-protected-list { margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px 8px; list-style:none; }
    .recovery-protected-list li { position:relative; padding:6px 9px 6px 24px; border:1px solid #DCE9E6; border-radius:7px; background:#F7FBFA; color:#3E5D57; line-height:1.4; }
    .recovery-protected-list li::before { content:'✓'; position:absolute; left:8px; color:#17877C; font-weight:900; }
    .recovery-primary-action { min-height:44px; padding:10px 16px; border:1px solid #198E84; border-radius:8px; background:#198E84; color:#FFF; font-weight:800; cursor:pointer; }
    .recovery-primary-action.danger-action { border-color:#B94747; background:#B94747; }
    .recovery-secondary-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .recovery-secondary-actions button,.recovery-copy-diagnostic { min-height:44px; padding:9px 13px; border:1px solid #BFD2CE; border-radius:8px; background:#FFF; color:#2B5D56; font-weight:700; cursor:pointer; }
    .recovery-safety-note { margin:0; padding:10px 12px; border:1px solid #DCE9E6; border-radius:8px; background:#F7FBFA; color:#3E5D57; font-size:12px; line-height:1.55; }
    .recovery-safety-note strong { color:#28443F; }
    .recovery-technical { margin-top:14px; color:#5B716C; }
    .recovery-technical summary { min-height:44px; display:flex; align-items:center; cursor:pointer; font-weight:700; }
    .recovery-technical-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 18px; padding:8px 0 12px; font-size:12px; }
    .recovery-technical-grid div { overflow-wrap:anywhere; }
    .recovery-issues-empty { min-height:260px; display:grid; place-items:center; text-align:center; color:#60736F; padding:30px; }
    .recovery-issues-empty-state { grid-column:1/-1; min-height:0; height:100%; display:grid; place-items:center; align-content:center; gap:12px; padding:42px 30px; text-align:center; color:#60736F; background:#F8FBFA; }
    .recovery-issues-empty-state[hidden] { display:none; }
    .recovery-issues-empty-mark { width:54px; height:54px; display:grid; place-items:center; border:1px solid #BFD8D3; border-radius:50%; color:#17877C; background:#FFF; font-size:26px; font-weight:800; }
    .recovery-issues-empty-copy { max-width:520px; }
    .recovery-issues-empty-copy h3 { margin:0; color:#28443F; font-size:18px; line-height:1.4; }
    .recovery-issues-empty-copy p { margin:8px 0 0; color:#60736F; line-height:1.7; }
    .recovery-issues-empty-state.is-error { background:#FFF9F0; color:#8D4D08; }
    .recovery-issues-empty-state.is-error .recovery-issues-empty-mark { border-color:#E8C58D; color:#B86F1B; }
    .recovery-issues-empty-state.is-error .recovery-issues-empty-copy h3 { color:#8D4D08; }
    .recovery-issues-empty-retry { min-height:40px; margin-top:16px; padding:8px 16px; border:1px solid #198E84; border-radius:8px; background:#198E84; color:#FFF; font-weight:800; cursor:pointer; }
    .recovery-issues-empty-retry:hover,.recovery-issues-empty-retry:focus-visible { background:#147A72; outline:2px solid rgba(25,142,132,.24); outline-offset:2px; }
    .recovery-issues-empty-retry:disabled { cursor:wait; opacity:.58; }
    .recovery-issues-live { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
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
    .toast-container[aria-hidden="true"] { visibility:hidden; }
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
    @media (prefers-reduced-motion: reduce) {
      *,*::before,*::after { animation-duration:0.01ms!important; animation-iteration-count:1!important; transition-duration:0.01ms!important; scroll-behavior:auto!important; }
    }
    @supports not ((backdrop-filter: blur(1px))) {
      header,.card,.modal .panel { background:var(--panel); }
      .modal { background:rgba(26,47,45,0.58); }
    }
    @media (max-width: 760px) {
      header { padding:16px 18px; gap:12px; }
      header h1 { font-size:20px; }
      header button { padding:7px 14px; }
      .app-brand { flex-basis:100%; }
      .header-actions { width:100%; justify-content:flex-end; }
      .version-link { max-width:min(210px,calc(100vw - 190px)); }
      main { padding:18px 12px 28px; gap:16px; }
      .card { padding:18px; border-radius:18px; }
      .settings-grid { grid-template-columns:1fr; gap:13px; }
      .row { gap:8px; }
      .account-actions,.settings-actions,.modal-actions,.preview-actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
      .account-actions button,.settings-actions button,.modal-actions button,.preview-actions button { min-height:40px; }
      .modal-actions .full-width { grid-column:1/-1; }
      .modal { padding:10px; align-items:flex-start; }
      .archive-library-modal { padding:0; align-items:stretch; }
      .modal .panel { padding:20px; border-radius:20px; max-height:calc(100vh - 20px); }
      .video-item { align-items:flex-start; flex-wrap:wrap; }
      .video-cover { width:96px; height:60px; }
      .video-cover-wrap { width:96px; height:60px; }
      .video-info { flex:1 1 calc(100% - 108px); }
      .video-badges { width:100%; justify-content:flex-end; }
      .log-toggle { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); width:100%; }
      .log-toggle button { min-height:36px; padding:6px 10px; }
      .queue-board { display:block; width:100%; max-width:100%; min-width:0; max-height:430px; overflow-x:auto; overflow-y:hidden; white-space:nowrap; scroll-snap-type:x proximity; }
      .scheduler-status,.local-cache-status,.upload-health-status,.download-api-health-status { white-space:normal; width:100%; }
      .queue-col { display:inline-flex; width:82vw; min-width:82vw; max-width:82vw; margin-right:12px; white-space:normal; vertical-align:top; scroll-snap-align:start; }
      .toast-container { left:12px; right:12px; bottom:12px; }
      .toast { max-width:none; }
      .recovery-issues-shell { width:100%; height:100dvh; border:0; border-radius:0; display:flex; flex-direction:column; }
      .recovery-issues-shell.is-empty { height:min(460px,100dvh); }
      .recovery-issues-header { min-height:58px; padding:8px 10px; }
      .recovery-issues-summary { display:none; }
      .recovery-issues-status { flex:0 0 auto; padding:9px 10px; }
      .recovery-issues-layout { position:relative; display:block; flex:1 1 auto; min-height:0; height:auto; overflow:hidden; }
      .recovery-issues-layout.is-empty { display:block; }
      .recovery-issues-list-pane,.recovery-issues-detail { position:absolute; inset:0; width:100%; height:100%; border:0; transition:transform .16s ease; }
      .recovery-issues-empty-state { position:absolute; inset:0; height:100%; padding:34px 20px; }
      .recovery-issues-list-pane { transform:translateX(0); padding:10px; }
      .recovery-issues-detail { transform:translateX(100%); padding:18px 16px 28px; }
      .recovery-issue-row-title,.recovery-issue-row-problem,.recovery-issue-row-meta { white-space:normal; }
      .recovery-target-card { grid-template-columns:1fr; margin-top:16px; }
      .recovery-detail-title { font-size:20px; }
      .recovery-issues-shell.show-detail .recovery-issues-list-pane { transform:translateX(-24%); }
      .recovery-issues-shell.show-detail .recovery-issues-detail { transform:translateX(0); }
      .recovery-issues-shell.show-detail .recovery-issues-back { display:block; }
      .recovery-issues-shell.show-detail .recovery-issues-heading { display:none; }
      .recovery-technical-grid { grid-template-columns:1fr; }
    }
    @media (max-width: 720px) {
      .playback-modal { padding:0; background:#0F1413; }
      .playback-shell { width:100%; height:100dvh; border:0; border-radius:0; box-shadow:none; }
      .playback-header { min-height:58px; padding:10px 10px 10px 14px; }
      .playback-heading h2 { font-size:14px; }
      .playback-layout { display:block; overflow-y:auto; }
      .playback-main { min-height:auto; }
      .playback-stage { width:100%; min-height:0; height:56.25vw; max-height:62dvh; flex:none; }
      .playback-stage.is-portrait { height:62dvh; }
      .playback-now { padding:12px; }
      .playback-now-line { display:block; }
      .playback-now-title { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
      .playback-tools { margin-top:11px; }
      .playback-part-list { margin-top:10px; }
      .playback-queue { min-height:260px; border-left:0; border-top:1px solid #2D3836; }
      .playback-queue-list { max-height:none; overflow:visible; }
      .playback-queue-head { position:sticky; top:0; z-index:4; background:#171E1D; }
      .playback-mobile-mode-toggle { display:inline-flex; align-items:center; justify-content:center; }
      .playback-shell.is-mobile-immersive { position:relative; height:100dvh; background:#090C0B; }
      .playback-shell.is-mobile-immersive .playback-header { display:none; }
      .playback-shell.is-mobile-immersive .playback-layout { position:relative; display:block; width:100%; height:100%; overflow:hidden; }
      .playback-shell.is-mobile-immersive .playback-main { width:100%; height:100%; min-height:0; }
      .playback-shell.is-mobile-immersive .playback-stage { width:100%; height:100%; max-height:none; flex:1 1 auto; touch-action:pan-x; }
      .playback-shell.is-mobile-immersive .playback-stage.is-portrait { height:100%; }
      .playback-shell.is-mobile-immersive .playback-art { min-height:100%; transform:translate3d(0,var(--playback-swipe-offset,0),0); transition:transform .15s ease; }
      .playback-shell.is-mobile-immersive .playback-stage.is-swiping .playback-art { transition:none; }
      .playback-shell.is-mobile-immersive .playback-art .art-video-player video { object-fit:contain!important; }
      .playback-shell.is-mobile-immersive .playback-now { display:none; }
      .playback-shell.is-mobile-immersive .playback-immersive-topbar { position:absolute; z-index:1100; top:0; left:0; right:0; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:10px; min-height:58px; padding:max(10px,env(safe-area-inset-top)) 10px 8px; pointer-events:none; }
      .playback-immersive-actions { display:flex; align-items:center; gap:7px; pointer-events:auto; }
      .playback-immersive-control { min-width:38px; height:38px; display:inline-flex; align-items:center; justify-content:center; border:1px solid rgba(222,236,232,0.28); border-radius:6px; background:rgba(11,16,15,0.78); color:#F4F7F6; padding:0 10px; font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
      .playback-immersive-back { width:38px; padding:0; border-radius:50%; font-size:22px; pointer-events:auto; }
      .playback-immersive-control:focus-visible { border-color:#69D9D0; outline:2px solid rgba(57,197,187,0.35); outline-offset:2px; }
      .playback-immersive-position { min-width:0; color:#E5ECEA; font-size:12px; font-weight:700; text-align:center; text-shadow:0 1px 3px rgba(0,0,0,0.85); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .playback-shell.is-mobile-immersive .playback-immersive-meta { position:absolute; z-index:1090; left:12px; right:12px; bottom:max(68px,calc(54px + env(safe-area-inset-bottom))); display:block; width:max-content; max-width:calc(100% - 24px); padding:8px 10px; border-radius:6px; background:rgba(11,16,15,0.76); color:#F4F7F6; pointer-events:none; }
      .playback-immersive-title { display:-webkit-box; margin:0; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; font-size:14px; line-height:1.45; }
      .playback-immersive-detail { margin-top:4px; color:#B8C4C1; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .playback-shell.is-mobile-immersive .playback-drawer-backdrop { position:absolute; z-index:1140; inset:0; display:block; border:0; background:rgba(0,0,0,0.52); opacity:0; pointer-events:none; transition:opacity .15s ease; }
      .playback-shell.is-mobile-immersive .playback-queue { position:absolute; z-index:1150; left:0; right:0; bottom:0; height:min(72dvh,620px); min-height:280px; max-height:calc(100dvh - max(58px,env(safe-area-inset-top))); overflow:hidden; border:0; border-top:1px solid #3A4744; border-radius:8px 8px 0 0; box-shadow:0 -18px 46px rgba(0,0,0,0.42); transform:translateY(100%); visibility:hidden; transition:transform .16s ease,visibility 0s linear .16s; }
      .playback-shell.is-mobile-immersive.queue-open .playback-drawer-backdrop { opacity:1; pointer-events:auto; }
      .playback-shell.is-mobile-immersive.queue-open .playback-queue { transform:translateY(0); visibility:visible; transition-delay:0s; }
      .playback-shell.is-mobile-immersive .playback-queue-head { position:relative; top:auto; padding-top:14px; }
      .playback-shell.is-mobile-immersive .playback-queue-list { min-height:0; max-height:none; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; }
      .playback-shell.is-mobile-immersive .playback-queue-close { display:inline-flex; width:30px; height:30px; align-items:center; justify-content:center; border:0; border-radius:50%; background:#27312F; color:#DDE5E3; padding:0; font-size:19px; cursor:pointer; }
    }
    @media (max-width: 420px) {
      .playback-art .art-video-player { --art-control-icon-size:28px; --art-control-height:34px; --art-padding:10px; }
      .playback-art .art-control-volume { display:none!important; }
      .playback-art .art-control-time { font-size:12px; }
    }
    @media (min-width: 721px) and (max-height: 500px) and (orientation: landscape) {
      .playback-modal { padding:0; }
      .playback-shell { width:100%; height:100dvh; border:0; border-radius:0; }
      .playback-header { min-height:52px; padding:7px 10px 7px 14px; }
      .playback-layout { grid-template-columns:minmax(0,1fr) 270px; }
      .playback-now { padding:8px 12px; }
      .playback-part-list { margin-top:7px; }
      .playback-stage { min-height:160px; }
      .playback-queue-head { padding:11px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .modal,.modal > .panel,.modal > .archive-library-shell,.modal > .playback-shell,.modal > .recovery-issues-shell,
      .playback-shell,.video-item.playable,.video-play-affordance,.playback-queue-item,.playback-art,.playback-queue,.playback-drawer-backdrop { animation:none; transition:none!important; }
      .modal > .panel,.modal > .archive-library-shell,.modal > .playback-shell,.modal > .recovery-issues-shell { transform:none!important; }
    }
  </style>`;
}

function getAppHeader() {
  return `<header>
    <div class="app-brand">
      <h1>B站收藏夹同步</h1>
      ${getVersionLink("header-meta")}
    </div>
    <div class="header-actions">
      ${getGithubLink("header-meta")}
      <button id="logoutBtn">退出系统</button>
    </div>
  </header>`;
}

function getAccountSection() {
  return `<section class="card">
      <h2>账号与同步</h2>
      <p class="muted">管理 Bilibili 账号及需同步的收藏夹。点击“立即同步”会唤起后台任务队列。</p>
      <div class="row account-actions">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">立即同步</button>
        <button class="ghost" id="reconcileRemoteBtn">状态对账（仅远端存储）</button>
        <button class="ghost" id="reconcileBtn">全量扫描并对账</button>
        <button class="ghost" id="archiveLibraryBtn">归档库</button>
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
        <div><label for="pollInterval">轮询间隔 (分钟)</label><input id="pollInterval" type="number" min="1" /></div>
        <div><label for="delaySeconds">BBDown 分P延迟（秒）</label><input id="delaySeconds" type="number" min="0" aria-describedby="delaySecondsHint" /><p class="muted field-hint" id="delaySecondsHint">用于 BBDown 的 --delay-per-page，只影响新下载任务。</p></div>

        <div class="settings-group"><div class="settings-group-title">远端存储（AList / OpenList WebDAV）</div></div>
        <div class="field-full"><label for="alistUrl">远端内部通信地址</label><input id="alistUrl" type="text" placeholder="例如: http://alist:5244 或 http://openlist:5244" autocomplete="off" aria-describedby="alistUrlHint" /><p class="muted field-hint" id="alistUrlHint">兼容字段名保持为 alistUrl；这里可以填写 AList 或 OpenList 的 WebDAV 服务地址。</p></div>
        <div class="field-full"><label for="alistBrowserUrl">远端网页访问地址</label><input id="alistBrowserUrl" type="url" placeholder="例如: https://alist.example.com 或 https://openlist.example.com" autocomplete="off" aria-describedby="alistBrowserUrlHint" /><p class="muted field-hint" id="alistBrowserUrlHint">用于播放器中的“在网盘中查看”入口；留空则不显示。支持 AList 和 OpenList 的网页地址。</p></div>
        <div><label for="alistUsername">远端账号（WebDAV 用户名）</label><input id="alistUsername" type="text" placeholder="例如: admin" autocomplete="off" /></div>
        <div><label for="alistPassword">远端密码（WebDAV 密码）</label><input id="alistPassword" type="password" placeholder="密码" autocomplete="new-password" /></div>
        <div class="field-full"><label for="alistDest">目标存储路径</label><input id="alistDest" type="text" placeholder="例如: /阿里云盘/bili-backup/videos" aria-describedby="alistDestHint" /><p class="muted field-hint" id="alistDestHint">已有归档时请使用“迁移归档路径”，系统会先探测 COPY/MOVE 能力、复制并确认新目录，旧目录不会自动删除。</p></div>
        <div class="field-full"><label for="uploadLayout">上传目录结构</label>
          <select id="uploadLayout" aria-describedby="uploadLayoutHint">
            <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
            <option value="folder-video">收藏夹名 / 视频</option>
            <option value="video-only">仅视频文件</option>
          </select>
          <p class="muted field-hint" id="uploadLayoutHint">目录结构变化只影响新任务，不会移动已有远端文件。</p>
        </div>
        <div class="field-full"><label for="playbackDeliveryMode">归档播放传输方式</label>
          <select id="playbackDeliveryMode" aria-describedby="playbackDeliveryModeHint">
            <option value="auto">优先网盘直连，失败自动代理</option>
            <option value="proxy">始终由 BFB 代理</option>
          </select>
          <p class="muted field-hint" id="playbackDeliveryModeHint">直连可节省 BFB 服务器流量，但网盘临时签名地址会在当前浏览器的网络请求中可见。</p>
        </div>

        <div class="settings-group"><div class="settings-group-title">下载控制 (BBDown)</div></div>
        <div class="field-full"><label id="bbdownApiModeLabel">播放接口</label>
          <div class="segmented-control" id="bbdownApiModeControl" role="radiogroup" aria-labelledby="bbdownApiModeLabel" aria-describedby="bbdownApiModeHint">
            <label><input type="radio" name="bbdownApiMode" value="web" checked /><span>网页接口</span></label>
            <label><input type="radio" name="bbdownApiMode" value="app" /><span>APP接口</span></label>
          </div>
          <p class="muted field-hint" id="bbdownApiModeHint">网页接口遇到播放风控会暂停 3 分钟并自动单任务探测；APP 接口需要扫码登录 token，极少数 APP 空响应会仅对当前视频回退网页接口。</p>
        </div>
        <div class="field-full">
          <label>视频编码偏好（从上到下）</label>
          <div id="bbdownEncodingPriorityEditor" class="encoding-priority-editor" role="listbox" aria-label="视频编码偏好顺序"></div>
          <label class="checkbox-label encoding-strict-option"><input type="checkbox" id="bbdownEncodingStrict" /> 只使用第一项，不自动回退</label>
          <select id="bbdownEncoding" hidden aria-hidden="true">
            <option value="">自动回退</option>
            <option value="HEVC">HEVC</option>
            <option value="AVC">AVC</option>
            <option value="AV1">AV1</option>
          </select>
          <p class="muted field-hint">新任务按此顺序选择编码；默认 HEVC → AVC → AV1。修改不会重下载或改变已有归档。严格模式适合你明确只想要某一种编码的场景。</p>
        </div>
        <div><label for="bbdownQuality">最高画质</label>
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
          <label class="template-label" for="filenameTemplate">自定义模板（高级）</label>
          <input id="filenameTemplate" type="text" placeholder="例如: <videoTitle>-<ownerName>-<bvid>" />
        </div>
        <div class="field-full"><label for="renameScanMaxFiles">远端重命名扫描上限</label><input id="renameScanMaxFiles" type="number" min="100" max="100000" /></div>

        <div class="settings-group"><div class="settings-group-title">任务队列与重试</div></div>
        <div><label for="maxRetries">失败重试次数</label><input id="maxRetries" type="number" min="0" /></div>
        <div><label for="retryDelaySeconds">重试间隔 (秒)</label><input id="retryDelaySeconds" type="number" min="1" /></div>
        <div><label for="concurrentDownloads">同时下载并发数</label><input id="concurrentDownloads" type="number" min="1" max="5" /></div>
        <div><label for="concurrentUploads">同时上传并发数</label><input id="concurrentUploads" type="number" min="1" max="10" /></div>
        <div class="field-full"><label for="uploadFileIntervalSeconds">远端文件上传间隔（秒）</label><input id="uploadFileIntervalSeconds" type="number" min="0" max="120" step="1" aria-describedby="uploadFileIntervalHint" /><p class="muted field-hint" id="uploadFileIntervalHint">全局限制实际 PUT 的启动频率；远端预检和已存在文件跳过不等待，0 表示关闭。</p></div>
        <div class="field-full"><label for="localCacheLimitGB">本地缓存软上限 (GB，0 表示不限制)</label><input id="localCacheLimitGB" type="number" min="0" max="1024" step="0.5" /></div>
        <div class="field-full"><label for="queuePrefetchLimit">任务预取上限</label><input id="queuePrefetchLimit" type="number" min="5" max="100" /></div>
        <div><label for="remoteVerifyConcurrency">远端对账并发数</label><input id="remoteVerifyConcurrency" type="number" min="1" max="100" /></div>
        <div><label for="remoteVerifyRateLimitPerSecond">远端对账限速 (次/秒)</label><input id="remoteVerifyRateLimitPerSecond" type="number" min="0.5" max="100" step="0.5" /></div>
        <div class="field-full"><label for="remoteRequeueLimitPerCycle">每轮最多补传数量</label><input id="remoteRequeueLimitPerCycle" type="number" min="1" max="1000" /></div>
      </div>
      <div class="row settings-actions">
        <button id="saveConfigBtn">保存设置并生效</button>
        <button id="renameBtn" class="rename-btn">检查旧命名文件</button>
        <button id="qualityUpgradeBtn" class="ghost" type="button">检查可升级画质</button>
        <button id="pathMigrationBtn" class="ghost" type="button">迁移归档路径</button>
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
      <h2>任务中心</h2>
      <div class="log-toggle">
        <button id="recoveryIssuesBtn" class="recovery-issues-entry" type="button" aria-haspopup="dialog">待处理 0</button>
        <button id="logQueueBtn" class="active" type="button">队列看板</button>
        <button id="logSimpleBtn" type="button">精简日志</button>
        <button id="logRawBtn">原始输出</button>
        <button id="logDebugBtn">调试模式</button>
      </div>
      <div class="log-console" id="logConsole"><span class="log-info">等待日志...</span></div>
    </section>`;
}

function getModals() {
  return `
  <div class="modal" id="loginModal" aria-labelledby="loginModalTitle">
    <div class="panel">
      <h2 id="loginModalTitle">扫码登录</h2>
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

  <div class="modal" id="favoritesModal" aria-labelledby="favoritesModalTitle">
    <div class="panel">
      <h2 id="favoritesModalTitle">选择同步收藏夹</h2>
      <p class="muted">勾选你需要自动备份的收藏夹。点击收藏夹名称可查看内部视频详情。</p>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="row modal-actions split-actions">
        <button id="saveFavoritesBtn">保存选择</button>
        <button id="closeFavoritesBtn" class="ghost">取消</button>
      </div>
      <div class="muted status-line center-status" id="favoritesStatus"></div>
    </div>
  </div>

  <div class="modal archive-library-modal" id="archiveLibraryModal" aria-labelledby="archiveLibraryDialogTitle">
    <section class="archive-library-shell" aria-labelledby="archiveLibraryTitle">
      <aside class="archive-library-sidebar" aria-label="归档目录">
        <div class="archive-library-brand">
          <h2 id="archiveLibraryDialogTitle">归档库</h2>
          <button id="closeArchiveLibraryBtn" class="archive-library-close" type="button" aria-label="关闭归档库" title="关闭">×</button>
        </div>
        <nav class="archive-library-nav" id="archiveLibraryNav"></nav>
      </aside>
      <section class="archive-library-main">
        <div class="archive-library-topbar">
          <button id="archiveLibraryMobileBackBtn" class="archive-library-mobile-back" type="button" aria-label="返回归档目录" title="返回">←</button>
          <div class="archive-library-heading">
            <h2 id="archiveLibraryTitle">全部归档</h2>
            <span id="archiveLibrarySummary">0 个视频</span>
          </div>
        </div>
        <div class="archive-library-toolbar">
          <label class="archive-library-search">
            <input id="archiveLibrarySearchInput" type="search" maxlength="80" autocomplete="off" placeholder="搜索标题、UP主或BV号" aria-label="搜索归档库">
            <button id="archiveLibrarySearchClearBtn" class="archive-library-search-clear is-hidden" type="button" aria-label="清除搜索" title="清除">×</button>
          </label>
          <div class="archive-library-segment" aria-label="搜索范围">
            <button id="archiveSearchCurrentBtn" class="active" type="button">当前目录</button>
            <button id="archiveSearchGlobalBtn" type="button">全部归档</button>
          </div>
          <select id="archiveLibrarySort" class="archive-library-sort" aria-label="归档排序">
            <option value="context">默认顺序</option>
            <option value="title_asc">标题正序</option>
            <option value="title_desc">标题倒序</option>
          </select>
        </div>
        <div class="archive-library-filterbar" id="archiveLibraryFilterbar" aria-label="归档状态筛选">
          <button class="active" type="button" data-archive-filter="all">全部</button>
          <button type="button" data-archive-filter="playable">可播放</button>
          <button type="button" data-archive-filter="pending">待处理</button>
          <button type="button" data-archive-filter="issue">异常</button>
          <button type="button" data-archive-filter="deleted">已删除</button>
        </div>
        <div class="archive-library-results" id="archiveLibraryResults" tabindex="-1">
          <div class="archive-library-grid" id="archiveLibraryGrid"></div>
          <div class="archive-library-footer" id="archiveLibraryFooter" aria-live="polite"></div>
        </div>
      </section>
      <aside class="archive-library-detail" id="archiveLibraryDetail" role="dialog" aria-labelledby="archiveLibraryDetailTitle" aria-hidden="true">
        <div class="archive-library-detail-head">
          <h3 id="archiveLibraryDetailTitle">归档详情</h3>
          <button id="archiveLibraryDetailCloseBtn" class="archive-library-detail-close" type="button" aria-label="关闭详情" title="关闭">×</button>
        </div>
        <div class="archive-library-detail-body" id="archiveLibraryDetailBody"></div>
      </aside>
    </section>
  </div>

  <div class="modal" id="videoDetailModal" aria-labelledby="videoDetailTitle">
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

  <div class="modal playback-modal" id="playbackModal" aria-labelledby="playbackDialogTitle">
    <section class="playback-shell" aria-labelledby="playbackDialogTitle">
      <div class="playback-header">
        <div class="playback-heading">
          <div class="playback-eyebrow">远端存储已验证归档</div>
          <h2 id="playbackDialogTitle">收藏夹播放器</h2>
        </div>
        <button id="closePlaybackBtn" class="playback-close" type="button" aria-label="关闭播放器" title="关闭播放器">×</button>
      </div>
      <div class="playback-layout">
        <section class="playback-main">
          <div class="playback-stage" id="playbackStage">
            <div class="playback-art" id="playbackArt"></div>
            <div class="playback-immersive-topbar" aria-label="沉浸竖屏控制栏">
              <button id="closePlaybackImmersiveBtn" class="playback-immersive-control playback-immersive-back" type="button" aria-label="关闭播放器" title="关闭播放器">←</button>
              <span class="playback-immersive-position" id="playbackImmersivePosition">收藏夹播放器</span>
              <div class="playback-immersive-actions">
                <button id="playbackImmersiveQueueBtn" class="playback-immersive-control" type="button" aria-expanded="false">列表</button>
                <button id="playbackImmersiveExitBtn" class="playback-immersive-control" type="button">普通</button>
              </div>
            </div>
            <div class="playback-immersive-meta">
              <h3 class="playback-immersive-title" id="playbackImmersiveTitle">未选择视频</h3>
              <div class="playback-immersive-detail" id="playbackImmersiveDetail"></div>
              <a class="playback-immersive-alist is-hidden" id="playbackImmersiveAlistLink" target="_blank" rel="noopener noreferrer">在网盘中查看 ↗</a>
            </div>
            <div class="playback-stage-message is-hidden" id="playbackStageMessage">
              <div class="playback-message-inner">
                <strong id="playbackMessageTitle">正在准备播放器</strong>
                <p id="playbackMessageDetail">正在读取远端已验证文件。</p>
                <div class="playback-message-actions">
                  <button id="playbackRetryBtn" class="primary" type="button">重试</button>
                  <button id="playbackSkipBtn" type="button">跳过此视频</button>
                </div>
              </div>
            </div>
          </div>
          <div class="playback-now">
            <div class="playback-now-line">
              <div class="playback-now-copy">
                <h3 class="playback-now-title" id="playbackNowTitle">未选择视频</h3>
                <div class="playback-now-meta" id="playbackNowMeta"></div>
              </div>
              <div class="playback-tools">
                <button id="playbackPreviousBtn" class="playback-tool-button" type="button" aria-label="上一项" title="上一项">←</button>
                <button id="playbackNextBtn" class="playback-tool-button" type="button" aria-label="下一项" title="下一项">→</button>
                <button id="playbackContinuousBtn" class="playback-tool-button playback-continuous active" type="button" aria-pressed="true">连续播放</button>
                <button id="playbackMobilePortraitBtn" class="playback-tool-button playback-mobile-mode-toggle active" type="button" aria-pressed="true">沉浸竖屏</button>
              </div>
            </div>
            <div class="playback-part-list" id="playbackPartList" aria-label="分P列表"></div>
          </div>
        </section>
        <button id="playbackDrawerBackdrop" class="playback-drawer-backdrop" type="button" aria-label="关闭播放列表" tabindex="-1"></button>
        <aside class="playback-queue" aria-label="收藏夹播放队列">
          <div class="playback-queue-head">
            <div class="playback-queue-heading">
              <strong id="playbackQueueHeading">收藏夹顺序</strong>
              <span id="playbackQueueCount">0 项</span>
              <button id="playbackQueueCloseBtn" class="playback-queue-close" type="button" aria-label="关闭播放列表" title="关闭播放列表">×</button>
            </div>
            <div class="playback-search-controls" id="playbackSearchControls">
              <label class="playback-search-box">
                <input class="playback-search-input" id="playbackSearchInput" type="search" maxlength="80" autocomplete="off" placeholder="搜索标题、UP主或BV号" aria-label="搜索可播放归档">
                <button class="playback-search-clear is-hidden" id="playbackSearchClearBtn" type="button" aria-label="清除搜索" title="清除搜索">×</button>
              </label>
              <span class="playback-search-status" id="playbackSearchStatus" aria-live="polite"></span>
            </div>
          </div>
          <div class="playback-queue-list" id="playbackQueueList"></div>
        </aside>
      </div>
    </section>
  </div>

  <div class="modal" id="unavailableModal" aria-labelledby="unavailableModalTitle">
    <div class="panel panel-wide">
      <h2 id="unavailableModalTitle">下架视频清单</h2>
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

  <div class="modal" id="syncHelpModal" aria-labelledby="syncHelpModalTitle">
    <div class="panel panel-large">
      <h2 id="syncHelpModalTitle">同步与对账说明</h2>
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

  <div class="modal" id="settingsHelpModal" aria-labelledby="settingsHelpModalTitle">
    <div class="panel panel-wider">
      <h2 id="settingsHelpModalTitle">当前设置执行流程</h2>
      <p class="muted">这里不会保存设置，也不会触发同步，只按当前表单里的值生成说明。</p>
      <div id="settingsFlowContent"></div>
      <div class="row modal-actions">
        <button id="closeSettingsHelpBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="renamePreviewModal" aria-labelledby="renamePreviewModalTitle">
    <div class="panel panel-max">
      <h2 id="renamePreviewModalTitle">检查旧命名文件</h2>
      <p class="muted">先预览会改哪些远端文件。只有勾选并二次确认后，才会真正修改 AList / OpenList 网盘文件名。</p>
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

  <div class="modal" id="qualityUpgradeModal" aria-labelledby="qualityUpgradeModalTitle">
    <div class="panel panel-max">
      <h2 id="qualityUpgradeModalTitle">检查可升级画质</h2>
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

  <div class="modal" id="cleanupDataModal" aria-labelledby="cleanupDataModalTitle">
    <div class="panel panel-large">
      <div class="section-title-row">
        <h2 id="cleanupDataModalTitle">清理数据</h2>
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

  <div class="modal" id="migrationModal" aria-labelledby="migrationModalTitle">
    <div class="panel panel-large">
      <h2 id="migrationModalTitle">数据迁移</h2>
      <p class="muted">导出会打包本地持久化数据；包含账号登录信息时，请把压缩包当作敏感文件保管。</p>
      <div class="segmented-control" id="migrationModeControl">
        <label><input type="radio" name="migrationMode" value="lightweight" checked /><span>轻量迁移</span></label>
        <label><input type="radio" name="migrationMode" value="complete" /><span>完整迁移</span></label>
      </div>
      <p class="muted" id="migrationEstimate">正在估算迁移包内容...</p>
      <div class="cleanup-list">
        <label class="cleanup-item"><input id="migConfig" type="checkbox" checked /><div><div class="cleanup-item-title">全局配置</div><div class="cleanup-item-desc">远端存储地址、画质、并发、命名模板等设置。</div></div></label>
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

  <div class="modal" id="pathMigrationModal" aria-labelledby="pathMigrationModalTitle">
    <div class="panel panel-large">
      <h2 id="pathMigrationModalTitle">迁移归档路径</h2>
      <p class="muted">系统会在同一 AList / OpenList 挂载存储内复制整个旧目录，包括空目录、<code>_history</code> 和未登记文件。开始前会用隔离临时文件探测 COPY 和 MOVE；复制使用 COPY，不覆盖目标；切换后旧目录仍保留。</p>
      <div class="settings-grid">
        <div><label for="pathMigrationSource">当前归档路径</label><input id="pathMigrationSource" type="text" readonly /></div>
        <div><label for="pathMigrationDestination">新归档路径</label><input id="pathMigrationDestination" type="text" placeholder="例如: /阿里云盘/bili-backup-2" /></div>
      </div>
      <div id="pathMigrationSummary" class="cleanup-list"></div>
      <div id="pathMigrationItems" class="rename-skip-list"></div>
      <div id="pathMigrationStatus" class="rename-result result-block is-hidden"></div>
      <div class="row modal-actions split-actions">
        <button id="pathMigrationPreviewBtn" type="button">扫描并生成预览</button>
        <button id="pathMigrationStartBtn" type="button" class="ghost">开始迁移</button>
        <button id="pathMigrationPauseBtn" type="button" class="ghost">暂停</button>
        <button id="pathMigrationResumeBtn" type="button" class="ghost">继续</button>
        <button id="pathMigrationCancelBtn" type="button" class="ghost">取消（切换前）</button>
        <button id="pathMigrationKeepBtn" type="button" class="ghost">保留旧目录并结束</button>
        <button id="pathMigrationCleanupBtn" type="button" class="ghost">清理旧目录</button>
        <button id="closePathMigrationBtn" class="ghost full-width" type="button">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="cleanupHelpModal" aria-labelledby="cleanupHelpModalTitle">
    <div class="panel panel-narrow">
      <h2 id="cleanupHelpModalTitle">清理小贴士</h2>
      <p class="muted">这里是小扫帚的说明书：有些灰尘可以放心扫，有些是小仓库的钥匙，要确认后再动。</p>
      <div id="cleanupHelpContent" class="cleanup-help-list"></div>
      <p class="muted help-note">如果你准备删容器，先在“清理数据”里全选并确认；如果还要连内置 AList 也清掉，请停容器后手动删除宿主机的 <code>alist</code> 目录。外接 OpenList 的数据目录由 OpenList 自己管理。</p>
      <div class="row modal-actions">
        <button id="closeCleanupHelpBtn" class="ghost full-width" type="button">知道啦</button>
      </div>
    </div>
  </div>

  <div class="modal recovery-issues-modal" id="recoveryIssuesModal" aria-hidden="true" aria-labelledby="recoveryIssuesTitle">
    <section class="recovery-issues-shell" aria-labelledby="recoveryIssuesTitle">
      <header class="recovery-issues-header">
        <button id="recoveryIssuesBackBtn" class="recovery-issues-back" type="button" aria-label="返回待处理列表" title="返回">←</button>
        <div class="recovery-issues-heading">
          <h2 id="recoveryIssuesTitle">待处理问题</h2>
          <p>只显示需要你决定的事项；其他异常会在后台自动复核。</p>
        </div>
        <div id="recoveryIssuesSummary" class="recovery-issues-summary" aria-live="polite"></div>
        <button id="closeRecoveryIssuesBtn" class="recovery-issues-close" type="button" aria-label="关闭待处理问题" title="关闭">×</button>
      </header>
      <div id="recoveryIssuesStatus" class="recovery-issues-status" role="alert" hidden>
        <span id="recoveryIssuesStatusMessage" class="recovery-issues-status-message"></span>
        <button id="recoveryIssuesRetryBtn" type="button">重试</button>
      </div>
      <div class="recovery-issues-layout">
        <div id="recoveryIssuesEmptyState" class="recovery-issues-empty-state" role="status" hidden>
          <div class="recovery-issues-empty-mark" aria-hidden="true">✓</div>
          <div class="recovery-issues-empty-copy">
            <h3 id="recoveryIssuesEmptyTitle">当前没有需要处理的问题</h3>
            <p id="recoveryIssuesEmptyMessage">系统会继续在后台自动复核，新的异常会出现在这里。</p>
            <button id="recoveryIssuesEmptyRetryBtn" class="recovery-issues-empty-retry" type="button" hidden>重试</button>
          </div>
        </div>
        <aside class="recovery-issues-list-pane" aria-label="待处理问题列表">
          <div class="recovery-issues-list-header">
            <strong>需要你处理</strong>
            <span id="recoveryIssuesListCount"></span>
          </div>
          <div id="recoveryIssuesList" class="recovery-issues-list"></div>
        </aside>
        <main id="recoveryIssuesDetail" class="recovery-issues-detail" tabindex="-1"></main>
      </div>
      <div id="recoveryIssuesLive" class="recovery-issues-live" aria-live="polite"></div>
    </section>
  </div>

  <div class="modal" id="confirmActionModal" aria-labelledby="confirmActionTitle">
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
  </div>

  <div class="modal" id="encodingRetryModal" aria-labelledby="encodingRetryTitle">
    <div class="panel panel-narrow">
      <h2 id="encodingRetryTitle">换编码重新下载</h2>
      <p id="encodingRetryCopy" class="encoding-retry-copy">系统会在隔离目录重新下载并上传。原文件会保留到新文件完成远端确认。</p>
      <label>本次重试的编码顺序</label>
      <div id="encodingRetryPriorityEditor" class="encoding-priority-editor" role="listbox" aria-label="本次重试编码顺序"></div>
      <label class="checkbox-label encoding-strict-option"><input type="checkbox" id="encodingRetryStrict" checked /> 只使用第一项（推荐用于远端单文件限制）</label>
      <div id="encodingRetryStatus" class="encoding-retry-status" role="alert" aria-live="polite"></div>
      <div class="row modal-actions split-actions">
        <button id="encodingRetrySubmitBtn" type="button">开始替换下载</button>
        <button id="encodingRetryCancelBtn" class="ghost" type="button">取消</button>
      </div>
    </div>
  </div>

  <div class="modal" id="accountRemovalModal" aria-labelledby="accountRemovalTitle">
    <div class="panel panel-narrow">
      <h2 id="accountRemovalTitle">删除账号</h2>
      <p class="muted">请选择账号登录信息和远端归档的处理方式。</p>
      <div class="account-removal-options" role="radiogroup" aria-label="账号删除方式">
        <label class="account-removal-option">
          <input id="accountRemovalOnly" type="radio" name="accountRemovalMode" value="account_only" checked>
          <span><strong>仅移除账号登录（推荐）</strong><span>保留远端归档、封面和本地索引，之后用同一UID登录可恢复关联。</span></span>
        </label>
        <label class="account-removal-option">
          <input id="accountRemovalRemote" type="radio" name="accountRemovalMode" value="account_and_remote">
          <span><strong>删除账号并清理远端归档</strong><span>只删除SQLite已追踪且重新核验一致的文件；未知文件和共享文件会保留。</span></span>
        </label>
      </div>
      <div id="accountRemovalPreview" class="account-removal-preview">正在计算账号影响范围...</div>
      <div id="accountRemovalConfirmWrap" class="confirm-action-input-wrap is-hidden">
        <label for="accountRemovalConfirmInput">确认文字</label>
        <input id="accountRemovalConfirmInput" type="text" autocomplete="off" placeholder="DELETE REMOTE ARCHIVE">
        <div class="muted confirm-action-input-hint">请输入 DELETE REMOTE ARCHIVE 后继续。</div>
      </div>
      <div id="accountRemovalProgress" class="archive-deletion-progress is-hidden" aria-live="polite"></div>
      <div class="row modal-actions split-actions">
        <button id="accountRemovalSubmitBtn" type="button" class="danger-action">删除账号</button>
        <button id="accountRemovalCancelBtn" type="button" class="ghost">取消</button>
      </div>
    </div>
  </div>`;
}

function getAppScript() {
  return `
    const decidePlaybackMediaError = ${decidePlaybackMediaError.toString()};
    const resolvePlaybackDeliveryViewStatus = ${resolvePlaybackDeliveryViewStatus.toString()};
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
    let logMode = 'queue';
    let logEntries = [];
    let queueBoardPollTimer = null;
    let queueBoardClockTimer = null;
    let queueBoardRequestInFlight = false;
    let queueBoardRequestController = null;
    let queueBoardRequestToken = 0;
    let recoveryIssuePollTimer = null;
    let recoveryIssueRequestInFlight = false;
    const recoveryIssueState = {
      items: [],
      selectedId: null,
      focusId: null,
      controller: null,
      token: 0,
      error: null,
      summary: null,
    };
    let pathMigrationPollTimer = null;
    const queueBoardState = {
      columns: {},
      cards: new Map(),
      renderLimit: 80,
      lastSnapshot: null,
      lastUpdatedAt: 0,
      lastError: null,
    };
    let unavailableUserId = null;
    let unavailableFilter = 'missing';
    let unavailableController = null;
    let unavailableToken = 0;
    let unavailableThrottleTimer = null;
    const unavailableStates = {
      missing: { items:[], keys:new Set(), nodes:new Map(), cursor:null, hasMore:true, loading:false, error:null },
      uploaded: { items:[], keys:new Set(), nodes:new Map(), cursor:null, hasMore:true, loading:false, error:null }
    };
    let videoDetailState = {
      userId: null,
      mediaId: null,
      filter: 'all',
      summary: null,
      indexSummary: null,
      source: null,
      tracked: false,
      lastSyncedAt: null,
      coverage: null,
      page: 0,
      pageSize: 20,
      hasMore: true,
      loading: false,
      token: 0,
      controller: null
    };
    const ARCHIVE_LIBRARY_STORAGE_KEY = 'bfb-archive-library-v1';
    let archiveLibraryState = {
      navigation: null,
      scope: 'global',
      userId: null,
      mediaId: null,
      title: '全部归档',
      draftQuery: '',
      query: '',
      searchScope: 'current',
      filter: 'all',
      sort: 'context',
      items: [],
      nodes: new Map(),
      nextCursor: null,
      hasMore: true,
      summary: null,
      loading: false,
      error: null,
      token: 0,
      sessionToken: 0,
      controller: null,
      searchTimer: null,
      scrollTimer: null,
      detailController: null,
      detailToken: 0,
      detailTrigger: null,
      detailBvid: null,
      navigationTimer: null,
      navigationToken: 0,
      navigationController: null,
      scrollPositions: {},
      trigger: null
    };
    let accountRemovalToken = 0;
    let accountRemovalState = { userId:null, preview:null, operationId:null, pollTimer:null, trigger:null, controller:null, token:0, loading:false };
    const PLAYBACK_STORAGE_KEY = 'bfb-playback-v1';
    let artplayerLoader = null;
    let playbackState = {
      art: null,
      userId: null,
      mediaId: null,
      mode: 'favorite',
      page: 1,
      pageSize: 50,
      total: 0,
      focusIndex: -1,
      items: [],
      pages: new Map(),
      pageCursors: new Map(),
      queueNodes: new Map(),
      queueObserver: null,
      queueController: null,
      queuePromise: null,
      queueToken: 0,
      queueLoading: false,
      queueLoadingDirection: null,
      queueError: null,
      itemIndex: 0,
      partIndex: 0,
      loadingToken: 0,
      deliveryMode: 'auto',
      alistBrowserConfigured: false,
      deliveryAttemptId: null,
      deliveryStatus: 'pending',
      deliveryController: null,
      metadataReported: new Set(),
      metadataReporting: new Set(),
      metadataControllers: new Map(),
      metadataRetryTimers: new Map(),
      progressTimer: null,
      continuous: true,
      preferences: null,
      drawerOpen: false,
      swipeChanging: false,
      swipe: {
        pointerId: null,
        startX: 0,
        startY: 0,
        deltaX: 0,
        deltaY: 0,
        tracking: false
      },
      trigger: null,
      focusBvid: null,
      libraryContext: null,
      search: {
        query: '',
        shownQuery: '',
        page: 0,
        total: 0,
        hasMore: false,
        items: [],
        nodes: new Map(),
        timer: null,
        controller: null,
        token: 0,
        loading: false,
        error: null
      }
    };
    let syncHelpMode = 'simple';
    let renamePreviewState = { candidates: [], skipped: [] };
    let qualityUpgradePreviewState = { candidates: [], uncertain: [], skipped: [], target: {} };
    let cleanupState = { items: [], runningTransfers: false, activeScheduler: false };
    let migrationSelectedFile = null;
    let migrationImportBlocked = false;
    const modalStack = [];
    const modalAnimationState = new Map();
    const modalBackgroundState = new Map();
    const archiveLibraryLayoutMedia = window.matchMedia('(max-width:720px), (max-height:480px) and (pointer:coarse)');
    let modalScrollState = null;
    let pendingConfirmAction = null;
    let bbdownEncodingPriorityState = ['HEVC', 'AVC', 'AV1'];
    let encodingRetryDialogState = null;
    const MODAL_ENTER_FOCUS_DELAY_MS = 190;

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

    const FOCUSABLE_SELECTOR = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

    function focusableElements(root) {
      if (!root) return [];
      return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
        if (!(element instanceof HTMLElement) || element.closest('[inert]')) return false;
        if (element.getAttribute('aria-hidden') === 'true' || element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
    }

    function restoreFocusAfterModal(entry) {
      setTimeout(() => {
        const candidates = [entry?.trigger, entry?.previousFocus];
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement) || !candidate.isConnected || candidate.closest('[inert]') || candidate.disabled) continue;
          candidate.focus({ preventScroll:true });
          return;
        }
        const parent = activeModal();
        const fallback = focusableElements(parent)[0] || parent;
        if (fallback && typeof fallback.focus === 'function') fallback.focus({ preventScroll:true });
      }, 0);
    }

    function focusModalControlWhenReady(modal, target) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const delay = reducedMotion ? 0 : MODAL_ENTER_FOCUS_DELAY_MS;
      setTimeout(() => {
        if (activeModal() !== modal) return;
        const currentFocus = document.activeElement;
        if (currentFocus instanceof HTMLElement && modal.contains(currentFocus)) return;
        const focusTarget = target instanceof HTMLElement && target.isConnected
          ? target
          : focusableElements(modal)[0] || modal;
        if (typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll:true });
      }, delay);
    }

    function syncModalScrollLock(locked) {
      const root = document.documentElement;
      const body = document.body;
      if (locked && !modalScrollState) {
        const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
        modalScrollState = {
          rootHadClass:root.classList.contains('modal-open'),
          bodyHadClass:body.classList.contains('modal-open'),
          bodyPaddingRight:body.style.paddingRight
        };
        if (scrollbarWidth > 0) {
          const paddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
          body.style.paddingRight = (paddingRight + scrollbarWidth) + 'px';
        }
        root.classList.add('modal-open');
        body.classList.add('modal-open');
        return;
      }
      if (!locked && modalScrollState) {
        root.classList.toggle('modal-open', modalScrollState.rootHadClass);
        body.classList.toggle('modal-open', modalScrollState.bodyHadClass);
        body.style.paddingRight = modalScrollState.bodyPaddingRight;
        modalScrollState = null;
      }
    }

    function syncModalBackground(hidden) {
      syncModalScrollLock(hidden);
      const roots = [
        document.querySelector('header'),
        document.querySelector('main'),
        document.getElementById('toastContainer')
      ].filter(Boolean);
      roots.forEach((root) => {
        if (hidden) {
          if (!modalBackgroundState.has(root)) {
            modalBackgroundState.set(root, {
              inert:Boolean(root.inert),
              ariaHidden:root.hasAttribute('aria-hidden') ? root.getAttribute('aria-hidden') : null
            });
          }
          root.inert = true;
          root.setAttribute('aria-hidden', 'true');
          return;
        }
        const previous = modalBackgroundState.get(root);
        if (!previous) return;
        root.inert = previous.inert;
        if (previous.ariaHidden === null) root.removeAttribute('aria-hidden');
        else root.setAttribute('aria-hidden', previous.ariaHidden);
        modalBackgroundState.delete(root);
      });
    }

    function ensureModalAccessibleName(modal) {
      if (modal.hasAttribute('aria-label') || modal.hasAttribute('aria-labelledby')) return;
      const heading = modal.querySelector('h1,h2,h3');
      if (!heading) return;
      if (!heading.id) heading.id = modal.id + 'Title';
      modal.setAttribute('aria-labelledby', heading.id);
    }

    function syncModalStack() {
      const top = modalStack[modalStack.length - 1] || null;
      const hasClosingModal = modalAnimationState.size > 0;
      syncModalBackground(Boolean(top || hasClosingModal));
      document.querySelectorAll('.modal').forEach((modal) => {
        const index = modalStack.findIndex((entry) => entry.modal === modal);
        if (index < 0) {
          const isClosing = modalAnimationState.has(modal);
          if (!isClosing) modal.style.removeProperty('z-index');
          modal.inert = isClosing;
          modal.setAttribute('aria-hidden', 'true');
          modal.setAttribute('aria-modal', 'false');
          return;
        }
        const isTop = modalStack[index] === top;
        modal.style.zIndex = String(100 + index * 20);
        modal.inert = !isTop;
        modal.setAttribute('aria-hidden', String(!isTop));
        modal.setAttribute('aria-modal', String(isTop));
      });
    }

    function closeModal(modalOrId, options = {}) {
      const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
      if (!modal) return false;
      const index = modalStack.findIndex((entry) => entry.modal === modal);
      if (index < 0 || index !== modalStack.length - 1) return false;
      if (modal.id === 'confirmActionModal' && pendingConfirmAction && !options.skipConfirm) {
        finishConfirmAction(false);
        return true;
      }
      if (modal.id === 'encodingRetryModal' && encodingRetryDialogState) {
        const pending = encodingRetryDialogState;
        encodingRetryDialogState = null;
        pending.resolve(null);
      }
      if (modal.id === 'loginModal') {
        currentLoginId = null;
      }
      if (modal.id === 'videoDetailModal') {
        if (videoDetailState.controller) videoDetailState.controller.abort();
        videoDetailState.controller = null;
        videoDetailState.token += 1;
        videoDetailState.loading = false;
        videoDetailState.hasMore = false;
        if (videoDetailThrottleTimer) {
          clearTimeout(videoDetailThrottleTimer);
          videoDetailThrottleTimer = null;
        }
      }
      if (modal.id === 'playbackModal') destroyPlaybackSession();
      if (modal.id === 'archiveLibraryModal') {
        cleanupArchiveLibrary();
      }
      if (modal.id === 'recoveryIssuesModal') {
        if (recoveryIssueState.controller) recoveryIssueState.controller.abort();
        recoveryIssueState.controller = null;
        recoveryIssueState.token += 1;
        document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
      }
      if (modal.id === 'unavailableModal') {
        if (unavailableThrottleTimer) {
          clearTimeout(unavailableThrottleTimer);
          unavailableThrottleTimer = null;
        }
        if (unavailableController) unavailableController.abort();
        unavailableController = null;
        unavailableUserId = null;
        unavailableToken += 1;
        Object.values(unavailableStates).forEach((state) => { state.loading = false; });
      }
      if (modal.id === 'pathMigrationModal') stopPathMigrationPolling();
      if (modal.id === 'accountRemovalModal') {
        if (accountRemovalState.pollTimer) clearTimeout(accountRemovalState.pollTimer);
        if (accountRemovalState.controller) accountRemovalState.controller.abort();
        accountRemovalToken += 1;
        accountRemovalState = { userId:null, preview:null, operationId:null, pollTimer:null, trigger:null, controller:null, token:accountRemovalToken, loading:false };
      }
      const [entry] = modalStack.splice(index, 1);
      const closingZIndex = modal.style.zIndex || String(100 + index * 20);
      const motionReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const closeDuration = motionReduced ? 0 : 170;
      const closingState = { timer:null };
      modalAnimationState.set(modal, closingState);
      modal.classList.add('is-closing');
      modal.style.zIndex = closingZIndex;
      modal.setAttribute('aria-hidden', 'true');
      modal.inert = true;
      syncModalStack();

      const finishClose = () => {
        if (modalAnimationState.get(modal) !== closingState) return;
        modalAnimationState.delete(modal);
        modal.classList.remove('active', 'is-closing');
        modal.setAttribute('aria-hidden', 'true');
        modal.inert = false;
        modal.style.removeProperty('z-index');
        syncModalStack();
        if (options.restoreFocus !== false) restoreFocusAfterModal(entry);
      };
      closingState.timer = window.setTimeout(finishClose, closeDuration);
      return true;
    }

    function openModal(modalId, trigger) {
      const modal = document.getElementById(modalId);
      if (!modal) return false;
      const closingState = modalAnimationState.get(modal);
      if (closingState) {
        window.clearTimeout(closingState.timer);
        modalAnimationState.delete(modal);
        modal.classList.remove('is-closing', 'active');
        void modal.offsetWidth;
      }
      const existingIndex = modalStack.findIndex((entry) => entry.modal === modal);
      if (existingIndex >= 0) return existingIndex === modalStack.length - 1;
      ensureModalAccessibleName(modal);
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modalStack.push({ modal, trigger:trigger instanceof HTMLElement ? trigger : previousFocus, previousFocus });
      modal.classList.add('active');
      modal.setAttribute('role', 'dialog');
      if (!modal.hasAttribute('tabindex')) modal.tabIndex = -1;
      syncModalStack();
      focusModalControlWhenReady(modal, null);
      return true;
    }

    function activeModal() {
      return modalStack[modalStack.length - 1]?.modal || null;
    }

    function confirmAction(options) {
      if (pendingConfirmAction) {
        const modal = document.getElementById('confirmActionModal');
        const focusTarget = focusableElements(modal)[0] || modal;
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll:true });
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        const okBtn = document.getElementById('confirmActionOkBtn');
        const cancelBtn = document.getElementById('confirmActionCancelBtn');
        const input = document.getElementById('confirmActionInput');
        const inputWrap = document.getElementById('confirmActionInputWrap');
        const detail = document.getElementById('confirmActionDetail');
        const requiredText = String(options.requiredText || '');
        const danger = options.danger !== false;
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
        pendingConfirmAction = { resolve, requiredText };
        const modal = document.getElementById('confirmActionModal');
        openModal('confirmActionModal', options.trigger);
        focusModalControlWhenReady(modal, requiredText ? input : okBtn);
      });
    }

    function finishConfirmAction(result) {
      const pending = pendingConfirmAction;
      if (!pending) return;
      if (result && pending.requiredText && document.getElementById('confirmActionInput').value.trim() !== pending.requiredText) return;
      pendingConfirmAction = null;
      closeModal('confirmActionModal', { skipConfirm:true });
      pending.resolve(Boolean(result));
    }

    function syncConfirmActionInput() {
      const pending = pendingConfirmAction;
      const okBtn = document.getElementById('confirmActionOkBtn');
      okBtn.disabled = Boolean(pending?.requiredText) && document.getElementById('confirmActionInput').value.trim() !== pending.requiredText;
    }

    function showToast(message, type = 'error') {
      const modal = activeModal();
      let container = modal?.querySelector('[data-modal-toast-host="true"]') || null;
      if (!container && modal) {
        container = document.createElement('div');
        container.className = 'toast-container modal-toast-container';
        container.dataset.modalToastHost = 'true';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'false');
        modal.appendChild(container);
      }
      if (!container) container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      const text = document.createElement('div');
      text.className = 'toast-message';
      text.textContent = String(message || '');
      const close = document.createElement('button');
      close.className = 'toast-close';
      close.type = 'button';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '\u00d7';
      const removeToast = () => {
        toast.remove();
        if (container?.matches('[data-modal-toast-host="true"]') && !container.childElementCount) container.remove();
      };
      close.addEventListener('click', removeToast);
      toast.appendChild(text);
      toast.appendChild(close);
      container.appendChild(toast);
      setTimeout(() => {
        if (!toast.isConnected) return;
        toast.classList.add('fade-out');
        toast.addEventListener('animationend', removeToast, { once:true });
        setTimeout(removeToast, 400);
      }, 3500);
    }

    async function fetchJson(url, options) {
      try {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!data.success) {
          const error = new Error(data.message || '请求失败');
          error.code = data.code;
          error.details = data.data;
          throw error;
        }
        return data.data;
      } catch (e) {
        if (e && e.name !== 'AbortError' && e.code !== 'ARCHIVE_CURSOR_STALE') showToast(e.message || String(e), 'error');
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
      document.getElementById('alistBrowserUrl').value = d.alistBrowserUrl || '';
      document.getElementById('alistUsername').value = d.alistUsername || '';
      document.getElementById('alistPassword').value = d.alistPassword || '';
      document.getElementById('alistDest').value = d.alistDest || '';
      document.getElementById('playbackDeliveryMode').value = d.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto';
      playbackState.deliveryMode = d.playbackDeliveryMode === 'proxy' ? 'proxy' : 'auto';
      playbackState.alistBrowserConfigured = Boolean(String(d.alistBrowserUrl || '').trim());
      const browserUrlHint = document.getElementById('alistBrowserUrlHint');
      if (browserUrlHint) {
        const insecure = /^http:\/\//i.test(String(d.alistBrowserUrl || '').trim());
        browserUrlHint.textContent = insecure
          ? '当前使用 HTTP，登录信息和访问路径可能被同网络中的设备看到，建议改为 HTTPS。'
          : '用于播放器中的“在网盘中查看”入口；留空则不显示。';
        browserUrlHint.classList.toggle('status-error', insecure);
      }
      bbdownEncodingPriorityState = normalizeClientEncodingPriority(d.bbdownEncodingPriority, d.bbdownEncoding);
      document.getElementById('bbdownEncoding').value = d.bbdownEncoding || '';
      document.getElementById('bbdownEncodingStrict').checked = Boolean(d.bbdownEncoding);
      renderBBDownEncodingPriority();
      document.getElementById('bbdownQuality').value = d.bbdownQuality || '';
      setBBDownApiMode(d.bbdownApiMode || 'web');
      document.getElementById('bbdownHiRes').checked = !!d.bbdownHiRes;
      document.getElementById('bbdownDolby').checked = !!d.bbdownDolby;
      document.getElementById('maxRetries').value = d.maxRetries ?? 3;
      document.getElementById('retryDelaySeconds').value = d.retryDelaySeconds ?? 5;
      document.getElementById('concurrentDownloads').value = d.concurrentDownloads ?? 1;
      document.getElementById('concurrentUploads').value = d.concurrentUploads ?? 2;
      document.getElementById('uploadFileIntervalSeconds').value = d.uploadFileIntervalSeconds ?? 10;
      document.getElementById('localCacheLimitGB').value = d.localCacheLimitGB ?? 10;
      document.getElementById('queuePrefetchLimit').value = d.queuePrefetchLimit ?? 25;
      document.getElementById('remoteVerifyConcurrency').value = d.remoteVerifyConcurrency ?? 3;
      document.getElementById('remoteVerifyRateLimitPerSecond').value = d.remoteVerifyRateLimitPerSecond ?? 2;
      document.getElementById('remoteRequeueLimitPerCycle').value = d.remoteRequeueLimitPerCycle ?? 20;
      document.getElementById('filenameTemplate').value = d.filenameTemplate || '<videoTitle>-<bvid>';
      document.getElementById('renameScanMaxFiles').value = d.renameScanMaxFiles ?? 10000;
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
        alistBrowserUrl: document.getElementById('alistBrowserUrl').value.trim(),
        alistUsername: document.getElementById('alistUsername').value.trim(),
        alistPassword: document.getElementById('alistPassword').value.trim(),
        alistDest: document.getElementById('alistDest').value.trim(),
        playbackDeliveryMode: document.getElementById('playbackDeliveryMode').value === 'proxy' ? 'proxy' : 'auto',
        bbdownEncoding: document.getElementById('bbdownEncodingStrict').checked ? bbdownEncodingPriorityState[0] : '',
        bbdownEncodingPriority: bbdownEncodingPriorityState.slice(),
        bbdownQuality: document.getElementById('bbdownQuality').value,
        bbdownApiMode: getBBDownApiMode(),
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        renameScanMaxFiles: Number(document.getElementById('renameScanMaxFiles').value || 10000),
        maxRetries: Number(document.getElementById('maxRetries').value),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value),
        uploadFileIntervalSeconds: Number(document.getElementById('uploadFileIntervalSeconds').value),
        localCacheLimitGB: Number(document.getElementById('localCacheLimitGB').value),
        queuePrefetchLimit: Number(document.getElementById('queuePrefetchLimit').value),
        remoteVerifyConcurrency: Number(document.getElementById('remoteVerifyConcurrency').value),
        remoteVerifyRateLimitPerSecond: Number(document.getElementById('remoteVerifyRateLimitPerSecond').value),
        remoteRequeueLimitPerCycle: Number(document.getElementById('remoteRequeueLimitPerCycle').value),
      };
      try {
        await fetchJson('/api/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        playbackState.deliveryMode = payload.playbackDeliveryMode;
        playbackState.alistBrowserConfigured = Boolean(payload.alistBrowserUrl);
        setStatus(st, '设置已保存。轮询间隔和并发数立即生效；画质、编码、命名模板、重试次数、远端路径等对新任务生效，正在运行的任务不会中途切换。', 'success');
      } catch(e) {
        setStatus(st, '保存失败: '+e.message, 'error');
        if (e.code === 'PATH_MIGRATION_REQUIRED') {
          await openPathMigration();
          document.getElementById('pathMigrationDestination').value = payload.alistDest;
          setStatus('pathMigrationStatus', '已有归档数据，请先完成新路径迁移。', 'muted');
        }
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

    const ENCODING_PRIORITY_LABELS = {
      HEVC: { name:'HEVC (H.265)', hint:'体积通常更小，兼容性取决于播放器' },
      AVC: { name:'AVC (H.264)', hint:'兼容性最好，文件通常更大' },
      AV1: { name:'AV1', hint:'压缩效率高，部分设备不支持解码' }
    };

    function normalizeClientEncodingPriority(value, legacy) {
      const supported = ['HEVC','AVC','AV1'];
      const candidate = Array.isArray(value) ? value.map(v => String(v || '').trim().toUpperCase()) : [];
      if (candidate.length === supported.length && candidate.every(v => supported.includes(v)) && new Set(candidate).size === supported.length) return candidate;
      const old = String(legacy || '').trim().toUpperCase();
      return supported.includes(old) ? [old, ...supported.filter(v => v !== old)] : supported.slice();
    }

    function renderEncodingPriorityEditor(hostId, priority, onChange) {
      const host = document.getElementById(hostId);
      if (!host) return;
      const values = normalizeClientEncodingPriority(priority);
      host.innerHTML = '';
      let dragIndex = null;
      values.forEach((encoding, index) => {
        const item = document.createElement('div');
        item.className = 'encoding-priority-item';
        item.draggable = true;
        item.dataset.encoding = encoding;
        item.dataset.index = String(index);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-label', (index + 1) + '：' + (ENCODING_PRIORITY_LABELS[encoding]?.name || encoding));
        item.tabIndex = 0;
        const rank = document.createElement('span');
        rank.className = 'encoding-priority-rank';
        rank.textContent = String(index + 1);
        const copy = document.createElement('span');
        copy.className = 'encoding-priority-copy';
        const name = document.createElement('strong');
        name.className = 'encoding-priority-name';
        name.textContent = ENCODING_PRIORITY_LABELS[encoding]?.name || encoding;
        const hint = document.createElement('span');
        hint.className = 'encoding-priority-hint';
        hint.textContent = ENCODING_PRIORITY_LABELS[encoding]?.hint || '';
        copy.append(name, hint);
        const actions = document.createElement('span');
        actions.className = 'encoding-priority-actions';
        const move = (delta) => {
          const nextIndex = index + delta;
          if (nextIndex < 0 || nextIndex >= values.length) return;
          const next = values.slice();
          [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
          onChange(next);
        };
        const up = document.createElement('button');
        up.type = 'button'; up.textContent = '↑'; up.title = '上移'; up.setAttribute('aria-label', '上移 ' + encoding); up.disabled = index === 0;
        up.addEventListener('click', () => move(-1));
        const down = document.createElement('button');
        down.type = 'button'; down.textContent = '↓'; down.title = '下移'; down.setAttribute('aria-label', '下移 ' + encoding); down.disabled = index === values.length - 1;
        down.addEventListener('click', () => move(1));
        actions.append(up, down);
        item.append(rank, copy, actions);
        item.addEventListener('dragstart', (event) => { dragIndex = index; item.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; });
        item.addEventListener('dragend', () => { dragIndex = null; item.classList.remove('dragging'); });
        item.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          if (dragIndex === null || dragIndex === index) return;
          const next = values.slice();
          const [picked] = next.splice(dragIndex, 1);
          next.splice(index, 0, picked);
          onChange(next);
        });
        item.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          move(event.key === 'ArrowUp' ? -1 : 1);
        });
        host.appendChild(item);
      });
    }

    function renderBBDownEncodingPriority() {
      renderEncodingPriorityEditor('bbdownEncodingPriorityEditor', bbdownEncodingPriorityState, (next) => {
        bbdownEncodingPriorityState = next;
        renderBBDownEncodingPriority();
      });
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
        bbdownEncodingPriority: bbdownEncodingPriorityState.slice(),
        bbdownEncodingStrict: document.getElementById('bbdownEncodingStrict')?.checked === true,
        bbdownQuality: document.getElementById('bbdownQuality').value || '\u81ea\u52a8\u6700\u9ad8',
        bbdownApiMode: getBBDownApiMode(),
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,
        filenameTemplate: document.getElementById('filenameTemplate').value.trim() || '<videoTitle>-<bvid>',
        renameScanMaxFiles: Number(document.getElementById('renameScanMaxFiles').value || 10000),
        maxRetries: Number(document.getElementById('maxRetries').value || 3),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value || 5),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value || 1),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value || 2),
        uploadFileIntervalSeconds: Number(document.getElementById('uploadFileIntervalSeconds').value || 0),
        localCacheLimitGB: Number(document.getElementById('localCacheLimitGB').value || 0),
        queuePrefetchLimit: Number(document.getElementById('queuePrefetchLimit').value || 25),
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
          '<div class="help-card"><strong>\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5\u8fdc\u7aef\u5b58\u50a8\uff09</strong><div>\u4e0d\u91cd\u65b0\u7ffb B \u7ad9\u6536\u85cf\u5939\uff0c\u4e3b\u8981\u68c0\u67e5\u7a0b\u5e8f\u8bb0\u5f55\u8fc7\u7684\u7f51\u76d8\u6587\u4ef6\u8fd8\u5728\u4e0d\u5728\u3002\u9002\u5408\u6000\u7591\u7f51\u76d8\u6587\u4ef6\u88ab\u79fb\u52a8\u6216\u5220\u9664\u65f6\u4f7f\u7528\u3002</div></div>' +
          '<div class="help-card"><strong>\u5168\u91cf\u626b\u63cf\u5e76\u5bf9\u8d26</strong><div>\u4ece\u5934\u66f4\u5b8c\u6574\u5730\u626b\u63cf\u6536\u85cf\u5939\uff0c\u5e76\u68c0\u67e5 AList / OpenList \u8fdc\u7aef\u72b6\u6001\u3002\u6700\u5168\u9762\u4f46\u66f4\u6162\uff0c\u8bf7\u6c42\u4e5f\u66f4\u591a\u3002</div></div>' +
          '</div>';
        return;
      }
      content.innerHTML = '<div class="help-card-grid">' +
        '<div class="help-card"><strong>\u7acb\u5373\u540c\u6b65</strong><ul><li>\u6309\u5f53\u524d\u8c03\u5ea6\u7b56\u7565\u626b\u63cf\u70ed\u95e8\u9875\u548c\u90e8\u5206\u5386\u53f2\u9875\u3002</li><li>\u53d1\u73b0\u672a\u5907\u4efd\u89c6\u9891\u540e\u8fdb\u5165\u4e0b\u8f7d\u961f\u5217\u3002</li><li>\u9002\u5408\u65e5\u5e38\u589e\u91cf\u540c\u6b65\uff0c\u6210\u672c\u6700\u4f4e\u3002</li></ul></div>' +
         '<div class="help-card"><strong>\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5\u8fdc\u7aef\u5b58\u50a8\uff09</strong><ul><li>\u8df3\u8fc7 B \u7ad9\u6536\u85cf\u5939\u5168\u91cf\u626b\u63cf\u3002</li><li>\u6839\u636e\u672c\u5730 SQLite \u4e2d\u7684\u8fdc\u7aef\u6587\u4ef6\u8bb0\u5f55\u68c0\u67e5\u5b9e\u9645\u6587\u4ef6\u3002</li><li>\u53d1\u73b0\u7f3a\u5931\u540e\u6309\u8865\u4f20\u4e0a\u9650\u91cd\u65b0\u6392\u961f\u3002</li></ul></div>' +
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
      const encodingText = c.bbdownEncodingStrict
        ? '\u4e25\u683c ' + c.bbdownEncodingPriority[0]
        : c.bbdownEncodingPriority.join(' \u2192 ');
      document.getElementById('settingsFlowContent').innerHTML =
        '<div class="flow-visual">' +
          '<div class="flow-step"><div class="badge">\u81ea\u52a8\u8f6e\u8be2</div><div class="desc">\u7a0b\u5e8f\u6bcf <strong>' + escapeHtml(c.pollIntervalMinutes) + ' \u5206\u949f</strong>\u81ea\u52a8\u68c0\u67e5\u4e00\u6b21\uff1b\u624b\u52a8\u6309\u94ae\u4f1a\u989d\u5916\u63d2\u961f\u89e6\u53d1\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u626b\u63cf\u6536\u85cf\u5939</div><div class="desc">\u53d1\u73b0\u65b0\u89c6\u9891\u540e\u6309\u5f53\u524d\u547d\u540d\u6a21\u677f\u51c6\u5907\u4efb\u52a1\uff1a<code>' + escapeHtml(c.filenameTemplate) + '</code></div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0b\u8f7d\u961f\u5217</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0b\u8f7d <strong>' + escapeHtml(c.concurrentDownloads) + '</strong> \u4e2a\uff1b\u672c\u5730 temp \u8fbe\u5230 <strong>' + escapeHtml(c.localCacheLimitGB || 0) + 'GB</strong> \u8f6f\u4e0a\u9650\u65f6\u4e0d\u518d\u542f\u52a8\u65b0\u4e0b\u8f7d\uff1b\u753b\u8d28\u4e3a <strong>' + escapeHtml(c.bbdownQuality) + '</strong>\uff0c\u7f16\u7801\u504f\u597d\u4e3a <strong>' + escapeHtml(encodingText) + '</strong>\uff0c\u97f3\u9891\u9009\u9879\u4e3a <strong>' + escapeHtml(audioText) + '</strong>\uff1b\u5206P\u4e4b\u95f4\u5ef6\u8fdf <strong>' + escapeHtml(c.perVideoDelaySeconds) + ' \u79d2</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u5931\u8d25\u91cd\u8bd5</div><div class="desc">\u4e0b\u8f7d\u6216\u4e0a\u4f20\u5931\u8d25\u540e\u6700\u591a\u91cd\u8bd5 <strong>' + escapeHtml(c.maxRetries) + '</strong> \u6b21\uff0c\u6bcf\u6b21\u95f4\u9694 <strong>' + escapeHtml(c.retryDelaySeconds) + ' \u79d2</strong>\uff1b\u4e0b\u8f7d\u5361\u4f4f\u8d85\u8fc7 30 \u5206\u949f\u4e14\u6700\u8fd1 10 \u5206\u949f\u4f4e\u4e8e 10KB/s \u4f1a\u81ea\u52a8\u8fdb\u5165\u91cd\u8bd5\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u4e0a\u4f20\u8fdc\u7aef\u5b58\u50a8</div><div class="desc">\u6700\u591a\u540c\u65f6\u4e0a\u4f20 <strong>' + escapeHtml(c.concurrentUploads) + '</strong> \u4e2a\uff1b\u5b9e\u9645 PUT \u5168\u5c40\u95f4\u9694 <strong>' + escapeHtml(c.uploadFileIntervalSeconds || 0) + ' \u79d2</strong>\uff1b\u76ee\u6807\u8def\u5f84\u662f <code>' + escapeHtml(c.alistDest) + '</code>\uff0c\u76ee\u5f55\u7ed3\u6784\u662f <strong>' + escapeHtml(layoutText) + '</strong>\u3002</div></div>' +
          '<div class="flow-step"><div class="badge">\u72b6\u6001\u5bf9\u8d26</div><div class="desc">\u8fdc\u7aef\u5b58\u50a8\u5bf9\u8d26\u5e76\u53d1 <strong>' + escapeHtml(c.remoteVerifyConcurrency) + '</strong>\uff0c\u9650\u901f <strong>' + escapeHtml(c.remoteVerifyRateLimitPerSecond) + ' \u6b21/\u79d2</strong>\uff0c\u6bcf\u8f6e\u6700\u591a\u8865\u4f20 <strong>' + escapeHtml(c.remoteRequeueLimitPerCycle) + '</strong> \u4e2a\u7f3a\u5931\u89c6\u9891\u3002</div></div>' +
        '</div>' +
        '<div class="effect-groups">' +
          '<div class="effect-group"><strong>\u7acb\u5373\u751f\u6548</strong><div>\u8f6e\u8be2\u95f4\u9694\u3001\u540c\u65f6\u4e0b\u8f7d\u5e76\u53d1\u6570\u3001\u540c\u65f6\u4e0a\u4f20\u5e76\u53d1\u6570\u3001\u8fdc\u7aef\u6587\u4ef6\u4e0a\u4f20\u95f4\u9694\u3001\u672c\u5730\u7f13\u5b58\u8f6f\u4e0a\u9650\uff1b\u753b\u8d28\u91cd\u8c03\u7684\u4e0b\u8f7d\u9636\u6bb5\u5171\u4eab\u4e0b\u8f7d\u961f\u5217\uff0c\u4e0a\u4f20\u66ff\u6362\u9636\u6bb5\u5171\u4eab\u4e0a\u4f20\u961f\u5217\u3002</div></div>' +
          '<div class="effect-group"><strong>\u65b0\u4efb\u52a1\u751f\u6548</strong><div>\u753b\u8d28\u3001\u7f16\u7801\u3001Hi-Res / Dolby\u3001\u547d\u540d\u6a21\u677f\u3001\u8fdc\u7aef\u8def\u5f84\u3001\u4e0a\u4f20\u76ee\u5f55\u7ed3\u6784\u3001\u5931\u8d25\u91cd\u8bd5\u6b21\u6570\u3001\u91cd\u8bd5\u95f4\u9694\u3002</div></div>' +
          '<div class="effect-group"><strong>\u5bf9\u8d26\u65f6\u751f\u6548</strong><div>\u8fdc\u7aef\u5b58\u50a8\u5bf9\u8d26\u5e76\u53d1\u6570\u3001\u5bf9\u8d26\u9650\u901f\u3001\u6bcf\u8f6e\u6700\u591a\u8865\u4f20\u6570\u91cf\u3002</div></div>' +
        '</div>' +
        '<p class="muted help-note">\u4fee\u6539\u8fdc\u7aef\u8def\u5f84\u6216\u76ee\u5f55\u7ed3\u6784\u4e0d\u4f1a\u642c\u52a8\u65e7\u6587\u4ef6\uff1b\u547d\u540d\u6a21\u677f\u53ea\u5f71\u54cd\u65b0\u4e0b\u8f7d\uff0c\u65e7\u6587\u4ef6\u8bf7\u901a\u8fc7\u201c\u68c0\u67e5\u65e7\u547d\u540d\u6587\u4ef6\u201d\u9884\u89c8\u540e\u518d\u786e\u8ba4\u91cd\u547d\u540d\u3002\u8fdc\u7aef\u5bf9\u8d26\u9ad8\u5e76\u53d1/\u9ad8\u9650\u901f\u4f1a\u589e\u52a0\u540e\u7aef\u538b\u529b\uff0c\u5efa\u8bae\u9010\u6b65\u8c03\u9ad8\u3002</p>';
    }

    function openSettingsHelp() {
      renderSettingsFlow();
      openModal('settingsHelpModal', document.getElementById('settingsHelpBtn'));
    }

    const cleanupDescriptions = {
      'memory-cache': '只清掉页面临时记住的收藏夹分页，刷新一下就会重新拿，像擦掉便签纸。',
      temp: '清掉全部临时下载目录，包括可续传会话和已验证旧成品，需要输入 DELETE。',
      'orphan-fragments': '清掉会话中已确认无效的 _invalid/_incompatible 内容，以及没有会话清单、无法确认来源的 aria2/tmp/vclip/aclip 等残片；不会删除已验证成品或可续传轨道。此项已包含在“全部临时下载文件”中。',
      logs: '清掉网页任务日志。不会影响备份，只是小本本翻到空白页。',
      'debug-logs': '清掉 BBDown 调试日志。排查线索会少一点，但备份状态不受影响。',
      covers: '清掉本地压缩封面缓存。视频下架后可能只能显示占位封面，但备份状态不受影响。',
      exports: '清掉已经生成过的数据迁移导出压缩包。不影响当前项目运行。',
      backups: '清掉导入前自动保存的本地备份包。导入回滚余地会少一点。',
      state: '清掉备份状态、收藏夹索引、远端文件记录和重试记录。项目会忘记自己备份过什么。',
      users: '清掉 B 站账号登录信息。下次需要重新扫码登录。',
      config: '清掉全局配置。远端存储地址、画质、并发等会回到默认值。',
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
        mode: document.querySelector('input[name="migrationMode"]:checked')?.value || 'lightweight',
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
      migrationImportBlocked = false;
      document.getElementById('migrationFileInput').value = '';
      setHidden('migrationPreviewBlock', true);
      setMigrationStatus('', '');
      openModal('migrationModal', document.getElementById('migrationBtn'));
      await refreshMigrationEstimate();
    }

    async function refreshMigrationEstimate() {
      const el = document.getElementById('migrationEstimate');
      try {
        const data = await fetchJson('/api/migration/estimate', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(migrationOptionsFromForm('mig'))
        });
        const details = data.mode === 'complete'
          ? '，可续传 ' + Number(data.resumableItems || 0) + ' 项（' + formatBytes(Number(data.retainedBytes || 0)) + '），待补传 ' + Number(data.pendingUploadItems || 0) + ' 项'
          : '';
        el.textContent = (data.mode === 'complete' ? '完整迁移' : '轻量迁移') + '预计包含 ' + Number(data.files || 0) + ' 个文件，原始大小 ' + formatBytes(Number(data.expandedBytes || 0)) + details + '。';
      } catch (error) {
        el.textContent = '暂时无法估算：' + (error.message || String(error));
      }
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
      migrationSelectedFile = file;
      setMigrationStatus('正在读取导入包...', '');
      const res = await fetch('/api/migration/import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '导入预览失败');
      const manifest = data.data.manifest || {};
      const counts = manifest.counts || {};
      const conflicts = data.data.conflicts || {};
      migrationImportBlocked = Number(conflicts.tempItemCount || 0) > 0;
      document.getElementById('migrationPreviewText').textContent =
        '版本 ' + safeText(manifest.version, '-') +
        '，导出时间 ' + safeText(formatDateTime(manifest.exportedAt), '-') +
        '；账号 ' + (counts.users || 0) +
        '，视频 ' + (counts.videos || 0) +
        '，关系 ' + (counts.relations || 0) +
        '，已失效视频 ' + (counts.unavailableVideos || 0) +
        '；模式 ' + (manifest.mode === 'complete' ? '完整迁移（包含temp与断点）' : '轻量迁移') +
        (migrationImportBlocked ? '；目标temp当前有 ' + Number(conflicts.tempItemCount || 0) + ' 项占用，需先处理后才能导入' : '') +
        '。导入前会自动备份当前 data。';
      setHidden('migrationPreviewBlock', false);
      setMigrationStatus(migrationImportBlocked ? '预览发现temp冲突，当前不会执行导入。' : '预览完成，确认后才会写入本地数据。', migrationImportBlocked ? 'error' : 'success');
    }

    async function executeMigrationImport() {
      if (!migrationSelectedFile) {
        showToast('先选择导入包并完成预览', 'error');
        return;
      }
      if (migrationImportBlocked) {
        showToast('完整迁移目标temp非空，请先处理冲突后重新预览', 'error');
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
      if (selected.includes('temp') && selected.includes('orphan-fragments')) {
        hint.textContent += ' 无法续传的残片已包含在全部临时下载文件中，不会重复清理。';
      }
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
        (data.results || []).forEach((item) => lines.push(item.skipped
          ? '已包含：' + item.label + (item.note ? '（' + item.note + '）' : '')
          : '已清理：' + item.label));
        resultBlock.textContent = lines.join('\\n');
        showToast('清理完成，小扫帚收工啦', 'success');
        await loadCleanupState();
      } catch(e) {
        const lines = ['清理失败：' + e.message];
        const results = e.details && Array.isArray(e.details.results) ? e.details.results : [];
        results.forEach((item) => lines.push(item.ok
          ? (item.skipped ? '已包含：' : '已清理：') + item.label
          : '失败：' + item.label + (item.error ? ' - ' + item.error : '')));
        resultBlock.textContent = lines.join('\\n');
      } finally {
        btn.disabled = false;
        btn.textContent = '确认清理';
      }
    }

    async function openRenamePreview() {
      openModal('renamePreviewModal', document.getElementById('renameBtn'));
      await loadRenamePreview();
    }

    function stopPathMigrationPolling() {
      if (pathMigrationPollTimer) {
        clearInterval(pathMigrationPollTimer);
        pathMigrationPollTimer = null;
      }
    }

    function renderPathMigrationState(state) {
      const summary = document.getElementById('pathMigrationSummary');
      const source = document.getElementById('pathMigrationSource');
      const destination = document.getElementById('pathMigrationDestination');
      const status = document.getElementById('pathMigrationStatus');
      const items = document.getElementById('pathMigrationItems');
      if (!summary || !status) return;
      source.value = state?.sourceRoot || source.value || '';
      if (state?.destinationRoot) destination.value = state.destinationRoot;
      if (!state) {
        summary.innerHTML = '<div class="cleanup-item"><div><div class="cleanup-item-title">还没有路径预览</div><div class="cleanup-item-desc">输入新路径后生成扫描预览。现有归档不会被移动或删除。</div></div></div>';
        items.innerHTML = '';
        setHidden(status, true);
        return;
      }
      const labels = { scanning:'扫描中', ready:'可以开始', copying:'复制中', verifying:'等待远端确认', paused:'已暂停', switching:'切换状态中', cleanup_pending:'等待清理旧目录', cleanup_running:'正在核验并处理旧目录', completed:'已完成', cancelled:'已取消', failed:'需要处理' };
      const toCopy = Math.max(0, Number(state.entryCount || 0) - Number(state.verifiedCount || 0));
      summary.innerHTML =
        '<div class="cleanup-item"><div><div class="cleanup-item-title">阶段：' + escapeHtml(labels[state.status] || state.status) + '</div><div class="cleanup-item-desc">' + escapeHtml(state.sourceRoot) + ' → ' + escapeHtml(state.destinationRoot) + '</div></div><strong>' + escapeHtml(String(state.progress?.completed || 0)) + ' / ' + escapeHtml(String(state.entryCount || 0)) + '</strong></div>' +
        '<div class="cleanup-item"><div><div class="cleanup-item-title">文件与目录</div><div class="cleanup-item-desc">文件 ' + escapeHtml(String(state.fileCount || 0)) + '，目录 ' + escapeHtml(String(state.directoryCount || 0)) + '，总大小 ' + escapeHtml(formatBytes(state.totalBytes)) + '</div></div><strong>待复制 ' + escapeHtml(String(toCopy)) + '</strong></div>' +
        '<div class="cleanup-item"><div><div class="cleanup-item-title">安全检查</div><div class="cleanup-item-desc">可复用 ' + escapeHtml(String(state.reusableCount || 0)) + '，冲突 ' + escapeHtml(String(state.conflictCount || 0)) + '，目标额外内容 ' + escapeHtml(String(state.extraCount || 0)) + '</div></div></div>';
      setHidden(status, false);
      status.textContent = state.lastError || ('当前阶段：' + (labels[state.status] || state.status));
      status.className = 'rename-result result-block ' + ((state.status === 'failed' || state.conflictCount > 0) ? 'status-error' : (state.status === 'completed' ? 'status-success' : 'status-muted'));
      const busy = ['scanning','copying','verifying','switching','cleanup_running'].includes(state.status);
      document.getElementById('pathMigrationStartBtn').disabled = state.status !== 'ready' || state.conflictCount > 0;
      document.getElementById('pathMigrationPauseBtn').disabled = !['copying','verifying'].includes(state.status);
      document.getElementById('pathMigrationResumeBtn').disabled = state.status !== 'paused';
      document.getElementById('pathMigrationCancelBtn').disabled = ['switching','cleanup_pending','cleanup_running','completed','cancelled'].includes(state.status);
      document.getElementById('pathMigrationCleanupBtn').disabled = state.status !== 'cleanup_pending';
      document.getElementById('pathMigrationKeepBtn').disabled = state.status !== 'cleanup_pending';
      if (items) {
        items.innerHTML = state.conflictCount || state.failedCount ? '<div class="muted">冲突/失败项目可在接口分页查看；为避免大清单阻塞页面，这里只显示计数。</div>' : '';
      }
      if (busy || state.status === 'paused' || state.status === 'cleanup_pending') startPathMigrationPolling();
    }

    async function refreshPathMigrationState() {
      try { renderPathMigrationState(await fetchJsonSilent('/api/path-migration/state')); } catch (error) { setStatus('pathMigrationStatus', '状态读取失败：' + error.message, 'error'); }
    }

    function startPathMigrationPolling() {
      if (pathMigrationPollTimer) return;
      pathMigrationPollTimer = setInterval(() => { void refreshPathMigrationState(); }, 1500);
    }

    async function openPathMigration() {
      openModal('pathMigrationModal', document.getElementById('pathMigrationBtn'));
      stopPathMigrationPolling();
      const config = await fetchJson('/api/config');
      document.getElementById('pathMigrationSource').value = config.alistDest || '';
      document.getElementById('pathMigrationDestination').value = '';
      await refreshPathMigrationState();
    }

    async function previewPathMigration() {
      const destinationRoot = document.getElementById('pathMigrationDestination').value.trim();
      if (!destinationRoot) { setStatus('pathMigrationStatus', '请填写新归档路径。', 'error'); return; }
      try {
        await fetchJson('/api/path-migration/preview', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ destinationRoot }) });
        startPathMigrationPolling();
        await refreshPathMigrationState();
      } catch (error) { setStatus('pathMigrationStatus', '预览失败：' + error.message, 'error'); }
    }

    async function pathMigrationAction(action, body = {}) {
      try {
        await fetchJson('/api/path-migration/' + action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        await refreshPathMigrationState();
      } catch (error) { setStatus('pathMigrationStatus', '操作失败：' + error.message, 'error'); }
    }

    async function cleanupOldPathMigration() {
      const ok = await confirmAction({ title:'确认清理旧归档目录', message:'系统会重新验证源目录与目标文件，确认一致后删除旧归档根目录。', detail:'删除后无法由本项目恢复旧目录，请只在确认新目录完整可用后执行。', requiredText:'DELETE OLD ARCHIVE', confirmText:'删除旧目录', trigger:document.getElementById('pathMigrationCleanupBtn') });
      if (ok) await pathMigrationAction('cleanup-old', { confirmation:'DELETE OLD ARCHIVE' });
    }

    async function loadRenamePreview() {
      const btn = document.getElementById('renameBtn');
      const st = document.getElementById('renameStatus');
      const summary = document.getElementById('renamePreviewSummary');
      const list = document.getElementById('renamePreviewList');
      const resultBlock = document.getElementById('renameResultBlock');
      btn.textContent = '检查中...';
      st.textContent = '';
      summary.textContent = '正在扫描 AList / OpenList 远端文件...';
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
        detail: '此操作会修改 AList / OpenList 网盘文件名。建议确认预览列表无误后再继续。',
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
        const result = await fetchJson('/api/rename', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ items:payload })
        });
        const success = Number(result.success || 0);
        const failed = Number(result.failed || 0);
        const allResults = Array.isArray(result.results) ? result.results : [];
        const lines = ['完成：成功 ' + success + ' 个，失败 ' + failed + ' 个。'];
        const statusLabels = {
          renamed: '已完成',
          rolled_back: '已回滚',
          stranded: '需人工处理（停在临时路径）',
          conflict: '需人工处理（多路径冲突）',
          missing: '需人工处理（文件缺失）'
        };
        allResults.forEach((item) => {
          const label = statusLabels[item.status] || (item.ok ? '已完成' : '失败');
          const actual = item.actualPath ? '，实际路径：' + item.actualPath : '';
          const observed = Array.isArray(item.observedPaths) && item.observedPaths.length > 1
            ? '，检测到：' + item.observedPaths.join('、')
            : '';
          lines.push(label + '：' + item.oldPath + ' → ' + item.newPath + actual + observed + (item.error ? '，原因：' + item.error : ''));
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
        setStatus(st, '已生成画质重调预览：' + qualityUpgradePreviewState.candidates.length + ' 个可处理，' + (qualityUpgradePreviewState.uncertain || []).length + ' 个需人工确认，' + qualityUpgradePreviewState.skipped.length + ' 个跳过。', 'muted');
      } catch(e) {
        summary.textContent = '预览失败：' + e.message;
        setStatus(st, '预览失败: ' + e.message, 'error');
      } finally {
        btn.textContent = '检查可升级画质';
      }
    }

    function renderQualityUpgradePreview() {
      const candidates = Array.isArray(qualityUpgradePreviewState.candidates) ? qualityUpgradePreviewState.candidates : [];
      const uncertain = Array.isArray(qualityUpgradePreviewState.uncertain) ? qualityUpgradePreviewState.uncertain : [];
      const displayItems = [...candidates, ...uncertain.map((item) => ({ ...item, forceUnknown: true }))];
      const skipped = Array.isArray(qualityUpgradePreviewState.skipped) ? qualityUpgradePreviewState.skipped : [];
      const target = qualityUpgradePreviewState.target || {};
      const summary = document.getElementById('qualityUpgradeSummary');
      const list = document.getElementById('qualityUpgradeList');
      const skippedBlock = document.getElementById('qualityUpgradeSkippedBlock');
      const skippedList = document.getElementById('qualityUpgradeSkippedList');
      const targetText = [target.quality ? '清晰度 ' + target.quality : '', target.encoding ? '编码 ' + target.encoding : '', target.hiRes ? 'Hi-Res' : '', target.dolby ? '杜比' : ''].filter(Boolean).join(' / ') || '当前默认画质设置';
      summary.textContent = '目标：' + targetText + '。明确需升级 ' + candidates.length + ' 个，无法判断 ' + uncertain.length + ' 个，跳过 ' + skipped.length + ' 个。';
      list.innerHTML = '';
      if (!displayItems.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '没有找到可重调画质的已上传视频记录。';
        list.appendChild(empty);
      }
      displayItems.forEach((item, index) => {
        const row = document.createElement('label');
        row.className = 'rename-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.dataset.qualityUpgradeIndex = String(index);
        if (item.forceUnknown) checkbox.dataset.qualityUnknown = '1';
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
        reason.textContent = item.forceUnknown ? '无法判断旧文件画质；勾选即表示仍要强制重新下载。' : (item.reason || '按当前画质设置重新下载，上传验证成功后删除旧文件。');
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
        input.checked = checked && input.dataset.qualityUnknown !== '1';
      });
    }

    async function executeSelectedQualityUpgrade() {
      const candidates = [
        ...(Array.isArray(qualityUpgradePreviewState.candidates) ? qualityUpgradePreviewState.candidates : []),
        ...(Array.isArray(qualityUpgradePreviewState.uncertain) ? qualityUpgradePreviewState.uncertain.map((item) => ({ ...item, forceUnknown: true })) : [])
      ];
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
        const payload = selected.map((item) => ({ key:item.key, forceUnknown:Boolean(item.forceUnknown) }));
        const chunkSize = 50;
        const queued = [];
        const skipped = [];
        const downloadGroupKeys = new Set();
        let reportedDownloadGroups = 0;
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
          if (Array.isArray(result.queued)) {
            queued.push(...result.queued);
            result.queued.forEach((item) => {
              if (item && item.artifactKey) downloadGroupKeys.add(item.artifactKey);
            });
          }
          if (Array.isArray(result.skipped)) skipped.push(...result.skipped);
          reportedDownloadGroups += Number(result.downloadGroups || 0);
        }
        const downloadGroups = downloadGroupKeys.size || reportedDownloadGroups;
        const lines = ['已提交：' + queued.length + ' 个目标，合并为 ' + downloadGroups + ' 个下载组；跳过：' + skipped.length + ' 个。任务会在后台执行，可在队列中查看进度。'];
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
        const cleanupRetrying = running.filter((item) => item.stageLabel === '旧文件清理重试中').length;
        const sharedDownloads = running.filter((item) => Number(item.targetCount || 0) > 1 && String(item.stageLabel || '').includes('下载新版')).length;
        setStatus(st, '画质重调：运行中 ' + running.length + ' 个；最近完成/失败 ' + completed.length + ' 个。' + (sharedDownloads ? ' 共享下载 ' + sharedDownloads + ' 组。' : '') + (cleanupRetrying ? ' 旧文件清理重试中 ' + cleanupRetrying + ' 个。' : ''), 'muted');
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
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'favorite-chip';
          chip.textContent = safeText(favorite.title, '未命名收藏夹');
          chip.dataset.action = 'favorite_detail';
          chip.dataset.id = String(user.id || '');
          chip.dataset.mediaId = String(favorite.mediaId || '');
          chip.dataset.title = safeText(favorite.title, '未命名收藏夹');
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
        removeBtn.dataset.name = String(user.name || '');
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

    // ---- Local Archive Library ----
    function loadArchiveLibraryPreference() {
      const fallback = { version:1, scope:'global', userId:null, mediaId:null, filter:'all', sort:'context', scrollPositions:{} };
      try {
        const parsed = JSON.parse(localStorage.getItem(ARCHIVE_LIBRARY_STORAGE_KEY) || 'null');
        if (!parsed || parsed.version !== 1) return fallback;
        return {
          version:1,
          scope:['global','account','folder'].includes(parsed.scope) ? parsed.scope : 'global',
          userId:parsed.userId || null,
          mediaId:Number(parsed.mediaId || 0) || null,
          filter:['all','playable','pending','issue','deleted'].includes(parsed.filter) ? parsed.filter : 'all',
          sort:['context','title_asc','title_desc'].includes(parsed.sort) ? parsed.sort : 'context',
          scrollPositions:parsed.scrollPositions && typeof parsed.scrollPositions === 'object' ? parsed.scrollPositions : {}
        };
      } catch (_) {
        return fallback;
      }
    }

    function archiveContextKey(state = archiveLibraryState) {
      return [state.scope, state.userId || '', state.mediaId || 0, state.filter, state.sort].join(':');
    }

    function persistArchiveLibraryPreference() {
      try {
        localStorage.setItem(ARCHIVE_LIBRARY_STORAGE_KEY, JSON.stringify({
          version:1,
          scope:archiveLibraryState.scope,
          userId:archiveLibraryState.userId,
          mediaId:archiveLibraryState.mediaId,
          filter:archiveLibraryState.filter,
          sort:archiveLibraryState.sort,
          scrollPositions:archiveLibraryState.scrollPositions
        }));
      } catch (_) {}
    }

    function saveArchiveLibraryScroll() {
      const results = document.getElementById('archiveLibraryResults');
      if (!results || archiveLibraryState.query) return;
      archiveLibraryState.scrollPositions[archiveContextKey()] = Math.max(0, Math.round(results.scrollTop));
      const entries = Object.entries(archiveLibraryState.scrollPositions).slice(-80);
      archiveLibraryState.scrollPositions = Object.fromEntries(entries);
      persistArchiveLibraryPreference();
    }

    function cleanupArchiveLibrary() {
      saveArchiveLibraryScroll();
      archiveLibraryState.token += 1;
      archiveLibraryState.sessionToken += 1;
      if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      if (archiveLibraryState.scrollTimer) clearTimeout(archiveLibraryState.scrollTimer);
      if (archiveLibraryState.navigationTimer) clearTimeout(archiveLibraryState.navigationTimer);
      archiveLibraryState.navigationToken += 1;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      archiveLibraryState.controller = null;
      archiveLibraryState.detailController = null;
      archiveLibraryState.detailToken += 1;
      archiveLibraryState.searchTimer = null;
      archiveLibraryState.scrollTimer = null;
      archiveLibraryState.navigationTimer = null;
      archiveLibraryState.navigationController = null;
      archiveLibraryState.loading = false;
      closeArchiveLibraryDetail({ restoreFocus:false });
    }

    function archiveLibrarySessionCurrent(token) {
      return token === archiveLibraryState.sessionToken && document.getElementById('archiveLibraryModal').classList.contains('active');
    }

    async function requestArchiveLibraryNavigation(sessionToken = archiveLibraryState.sessionToken) {
      if (!archiveLibrarySessionCurrent(sessionToken)) return null;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const controller = new AbortController();
      const requestToken = ++archiveLibraryState.navigationToken;
      archiveLibraryState.navigationController = controller;
      try {
        const navigation = await fetchJson('/api/archive-library/navigation', { signal:controller.signal });
        if (!archiveLibrarySessionCurrent(sessionToken) || requestToken !== archiveLibraryState.navigationToken) return null;
        archiveLibraryState.navigation = navigation;
        return navigation;
      } finally {
        if (archiveLibraryState.navigationController === controller) archiveLibraryState.navigationController = null;
      }
    }

    function archiveLibraryQueryParams(options = {}) {
      const params = new URLSearchParams({
        scope:archiveLibraryState.scope,
        q:archiveLibraryState.query,
        searchScope:archiveLibraryState.searchScope,
        filter:archiveLibraryState.filter,
        sort:archiveLibraryState.sort,
        pageSize:String(archiveLibraryState.pageSize || 50)
      });
      if (archiveLibraryState.userId) params.set('userId', archiveLibraryState.userId);
      if (archiveLibraryState.mediaId) params.set('mediaId', String(archiveLibraryState.mediaId));
      if (options.cursor) params.set('cursor', options.cursor);
      return params;
    }

    function archiveLibraryContextSnapshot() {
      return {
        scope:archiveLibraryState.scope,
        userId:archiveLibraryState.userId,
        mediaId:archiveLibraryState.mediaId,
        query:archiveLibraryState.query,
        searchScope:archiveLibraryState.searchScope,
        filter:archiveLibraryState.filter,
        sort:archiveLibraryState.sort
      };
    }

    function isArchiveLibraryMobileLayout() {
      return archiveLibraryLayoutMedia.matches;
    }

    function setArchiveLibraryLayerAvailability(element, available) {
      if (!element) return;
      element.inert = !available;
      if (available) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', 'true');
    }

    function syncArchiveLibraryPanels() {
      const shell = document.querySelector('.archive-library-shell');
      const sidebar = document.querySelector('.archive-library-sidebar');
      const main = document.querySelector('.archive-library-main');
      const detailOpen = document.getElementById('archiveLibraryDetail')?.classList.contains('open');
      if (detailOpen) {
        setArchiveLibraryLayerAvailability(sidebar, false);
        setArchiveLibraryLayerAvailability(main, false);
        return;
      }
      if (!isArchiveLibraryMobileLayout()) {
        setArchiveLibraryLayerAvailability(sidebar, true);
        setArchiveLibraryLayerAvailability(main, true);
        return;
      }
      const showContent = Boolean(shell?.classList.contains('show-content'));
      setArchiveLibraryLayerAvailability(sidebar, !showContent);
      setArchiveLibraryLayerAvailability(main, showContent);
    }

    function archiveSummaryText(summary) {
      if (!summary) return '正在读取本地归档';
      if (archiveLibraryState.filter === 'deleted') return Number(summary.total || 0) + ' 个删除记录';
      return Number(summary.total || 0) + ' 个视频 · 可播放 ' + Number(summary.playable || 0) +
        ' · 待处理 ' + Number(summary.pending || 0) + ' · 异常 ' + Number(summary.issue || 0);
    }

    function archiveNavMeta(entry) {
      const sync = entry.lastSyncedAt ? ' · 最近同步 ' + formatDateTime(entry.lastSyncedAt) : '';
      if (!Number(entry.total || 0)) return '暂无本地索引' + sync;
      return Number(entry.total || 0) + ' 项 · 可播 ' + Number(entry.playable || 0) + sync;
    }

    function createArchiveNavItem(entry, context) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'archive-nav-item';
      button.dataset.archiveScope = context.scope;
      button.dataset.archiveUserId = context.userId || '';
      button.dataset.archiveMediaId = context.mediaId || '';
      const preview = document.createElement('span');
      preview.className = 'archive-nav-preview';
      appendArchiveCover(preview, entry);
      const copy = document.createElement('span');
      copy.className = 'archive-nav-copy';
      const title = document.createElement('span');
      title.className = 'archive-nav-title';
      title.textContent = safeText(context.title, '归档目录');
      const meta = document.createElement('span');
      meta.className = 'archive-nav-meta';
      meta.textContent = archiveNavMeta(entry);
      copy.appendChild(title);
      copy.appendChild(meta);
      const count = document.createElement('span');
      count.className = 'archive-nav-count';
      count.textContent = String(Number(entry.total || 0));
      button.appendChild(preview);
      button.appendChild(copy);
      button.appendChild(count);
      button.addEventListener('click', () => selectArchiveLibraryDirectory(context, button));
      return button;
    }

    function renderArchiveLibraryNavigation() {
      if (archiveLibraryState.navigationTimer) clearTimeout(archiveLibraryState.navigationTimer);
      archiveLibraryState.navigationTimer = null;
      const host = document.getElementById('archiveLibraryNav');
      host.replaceChildren();
      const navigation = archiveLibraryState.navigation;
      if (!navigation) {
        const loading = document.createElement('div');
        loading.className = 'archive-nav-empty';
        loading.textContent = '加载中...';
        host.appendChild(loading);
        return;
      }
      const globalGroup = document.createElement('div');
      globalGroup.className = 'archive-nav-account';
      const globalList = document.createElement('div');
      globalList.className = 'archive-nav-list';
      globalList.appendChild(createArchiveNavItem(navigation.summary || {}, { scope:'global', title:'全部归档' }));
      globalGroup.appendChild(globalList);
      host.appendChild(globalGroup);

      const activeDeletions = [];
      (navigation.accounts || []).forEach((account) => {
        const group = document.createElement(account.removed ? 'details' : 'section');
        group.className = 'archive-nav-account' + (account.removed ? ' archive-nav-inactive' : '');
        const heading = document.createElement(account.removed ? 'summary' : 'div');
        heading.className = 'archive-nav-heading';
        const name = document.createElement('strong');
        name.textContent = safeText(account.name, '未知账号');
        const uid = document.createElement('span');
        uid.textContent = (account.removed ? '已移除 · ' : '') + 'UID ' + safeText(account.uid, '-');
        heading.appendChild(name);
        heading.appendChild(uid);
        group.appendChild(heading);
        if (account.deletion) {
          const deletion = document.createElement('div');
          deletion.className = 'archive-nav-deletion';
          deletion.appendChild(document.createTextNode(archiveDeletionProgressText(account.deletion)));
          if (account.deletion.status === 'failed') {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = '重试账号归档清理';
            retry.addEventListener('click', async () => {
              const sessionToken = archiveLibraryState.sessionToken;
              retry.disabled = true;
              try {
                await fetchJson('/api/archive-deletions/' + encodeURIComponent(account.deletion.id) + '/retry', { method:'POST' });
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                const navigation = await requestArchiveLibraryNavigation(sessionToken);
                if (!navigation) return;
                renderArchiveLibraryNavigation();
              } catch (error) {
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                retry.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            deletion.appendChild(retry);
            const repreview = document.createElement('button');
            repreview.type = 'button';
            repreview.textContent = '重新预览并确认';
            repreview.addEventListener('click', async () => {
              const sessionToken = archiveLibraryState.sessionToken;
              repreview.disabled = true;
              try {
                const replacement = await repreviewAndStartArchiveDeletion(account.deletion.id, repreview);
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                if (!replacement) repreview.disabled = false;
                const navigation = await requestArchiveLibraryNavigation(sessionToken);
                if (!navigation) return;
                renderArchiveLibraryNavigation();
              } catch (error) {
                if (!archiveLibrarySessionCurrent(sessionToken)) return;
                repreview.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            deletion.appendChild(repreview);
          } else if (['preparing','config_removing','pending','running','retry_wait'].includes(account.deletion.status)) {
            activeDeletions.push({ id:account.deletion.id, userId:account.id });
          }
          group.appendChild(deletion);
        }
        const list = document.createElement('div');
        list.className = 'archive-nav-list';
        list.appendChild(createArchiveNavItem(account.summary || {}, {
          scope:'account', userId:account.id, title:'该账号全部'
        }));
        (account.folders || []).forEach((folder) => list.appendChild(createArchiveNavItem(folder, {
          scope:'folder', userId:account.id, mediaId:folder.mediaId, title:folder.title
        })));
        group.appendChild(list);
        if (Array.isArray(account.inactiveFolders) && account.inactiveFolders.length) {
          const inactive = document.createElement('details');
          inactive.className = 'archive-nav-inactive';
          const summary = document.createElement('summary');
          summary.textContent = '已停用归档 · ' + account.inactiveFolders.length;
          inactive.appendChild(summary);
          const inactiveList = document.createElement('div');
          inactiveList.className = 'archive-nav-list';
          account.inactiveFolders.forEach((folder) => inactiveList.appendChild(createArchiveNavItem(folder, {
            scope:'folder', userId:account.id, mediaId:folder.mediaId, title:folder.title + ' · 已停用'
          })));
          inactive.appendChild(inactiveList);
          group.appendChild(inactive);
        }
        host.appendChild(group);
      });
      syncArchiveLibraryNavigationSelection();
      if (activeDeletions.length && document.getElementById('archiveLibraryModal').classList.contains('active')) {
        archiveLibraryState.navigationTimer = setTimeout(
          () => pollArchiveLibraryNavigationDeletions(activeDeletions),
          1500
        );
      }
    }

    async function pollArchiveLibraryNavigationDeletions(activeDeletions) {
      archiveLibraryState.navigationTimer = null;
      const sessionToken = archiveLibraryState.sessionToken;
      if (!archiveLibrarySessionCurrent(sessionToken)) return;
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const controller = new AbortController();
      const requestToken = ++archiveLibraryState.navigationToken;
      archiveLibraryState.navigationController = controller;
      const current = () => archiveLibrarySessionCurrent(sessionToken) && requestToken === archiveLibraryState.navigationToken;
      try {
        const operations = await Promise.all(activeDeletions.map((entry) =>
          fetchJson('/api/archive-deletions/' + encodeURIComponent(entry.id), { signal:controller.signal })
        ));
        if (!current()) return;
        let reachedTerminal = false;
        let completed = false;
        activeDeletions.forEach((entry, index) => {
          const operation = operations[index];
          const account = (archiveLibraryState.navigation?.accounts || []).find((candidate) => candidate.id === entry.userId);
          if (!account || account.deletion?.id !== entry.id) return;
          account.deletion = operation;
          if (['completed','failed'].includes(operation.status)) reachedTerminal = true;
          if (operation.status === 'completed') completed = true;
        });
        if (reachedTerminal) {
          saveArchiveLibraryScroll();
          const navigation = await requestArchiveLibraryNavigation(sessionToken);
          if (!navigation || !archiveLibrarySessionCurrent(sessionToken)) return;
          renderArchiveLibraryNavigation();
          if (completed) await loadArchiveLibraryItems(true);
          return;
        }
        renderArchiveLibraryNavigation();
      } catch (error) {
        if ((error && error.name === 'AbortError') || !current()) return;
        try {
          const navigation = await requestArchiveLibraryNavigation(sessionToken);
          if (!navigation || !archiveLibrarySessionCurrent(sessionToken)) return;
          renderArchiveLibraryNavigation();
        } catch (_) {
          if (!archiveLibrarySessionCurrent(sessionToken)) return;
          archiveLibraryState.navigationTimer = setTimeout(
            () => pollArchiveLibraryNavigationDeletions(activeDeletions),
            3000
          );
        }
      } finally {
        if (archiveLibraryState.navigationController === controller) archiveLibraryState.navigationController = null;
      }
    }

    function syncArchiveLibraryNavigationSelection() {
      document.querySelectorAll('.archive-nav-item').forEach((button) => {
        const active = button.dataset.archiveScope === archiveLibraryState.scope
          && String(button.dataset.archiveUserId || '') === String(archiveLibraryState.userId || '')
          && String(button.dataset.archiveMediaId || '') === String(archiveLibraryState.mediaId || '');
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }

    function archiveDirectoryExists(navigation, scope, userId, mediaId) {
      if (scope === 'global') return true;
      const account = (navigation.accounts || []).find((entry) => entry.id === userId);
      if (!account) return false;
      if (scope === 'account') return true;
      return [...(account.folders || []), ...(account.inactiveFolders || [])]
        .some((folder) => Number(folder.mediaId) === Number(mediaId));
    }

    function setArchiveLibraryHeading() {
      document.getElementById('archiveLibraryTitle').textContent = archiveLibraryState.title || '全部归档';
      document.getElementById('archiveLibrarySummary').textContent = archiveSummaryText(archiveLibraryState.summary);
      document.getElementById('archiveLibrarySort').value = archiveLibraryState.sort;
      document.getElementById('archiveSearchCurrentBtn').classList.toggle('active', archiveLibraryState.searchScope === 'current');
      document.getElementById('archiveSearchGlobalBtn').classList.toggle('active', archiveLibraryState.searchScope === 'global');
      document.getElementById('archiveSearchCurrentBtn').setAttribute('aria-pressed', String(archiveLibraryState.searchScope === 'current'));
      document.getElementById('archiveSearchGlobalBtn').setAttribute('aria-pressed', String(archiveLibraryState.searchScope === 'global'));
      document.querySelectorAll('[data-archive-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.archiveFilter === archiveLibraryState.filter);
        button.setAttribute('aria-pressed', String(button.dataset.archiveFilter === archiveLibraryState.filter));
      });
      setHidden('archiveLibrarySearchClearBtn', !archiveLibraryState.draftQuery);
    }

    async function selectArchiveLibraryDirectory(context, trigger) {
      const shouldFocusMobileBack = Boolean(trigger && isArchiveLibraryMobileLayout());
      saveArchiveLibraryScroll();
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = null;
      archiveLibraryState.scope = context.scope;
      archiveLibraryState.userId = context.userId || null;
      archiveLibraryState.mediaId = Number(context.mediaId || 0) || null;
      archiveLibraryState.title = context.title || '全部归档';
      archiveLibraryState.draftQuery = '';
      archiveLibraryState.query = '';
      archiveLibraryState.searchScope = 'current';
      document.getElementById('archiveLibrarySearchInput').value = '';
      closeArchiveLibraryDetail({ restoreFocus:false });
      persistArchiveLibraryPreference();
      syncArchiveLibraryNavigationSelection();
      setArchiveLibraryHeading();
      document.querySelector('.archive-library-shell').classList.add('show-content');
      syncArchiveLibraryPanels();
      await loadArchiveLibraryItems(true);
      if (shouldFocusMobileBack && document.getElementById('archiveLibraryModal').classList.contains('active')) {
        document.getElementById('archiveLibraryMobileBackBtn').focus({ preventScroll:true });
      }
    }

    function archiveStatusLabel(item) {
      const deletionStatuses = item?.memberships?.map((membership) => membership.deletionStatus).filter(Boolean) || [];
      if (item?.deletionStatus) deletionStatuses.push(item.deletionStatus);
      if (deletionStatuses.includes('completed')) return '已手动删除';
      if (deletionStatuses.includes('failed')) return '清理失败';
      if (deletionStatuses.some((status) => ['preparing','config_removing','pending','running','retry_wait'].includes(status))) return '清理中';
      if (item.playback && item.playback.available) {
        if (item.unavailable) return '已归档且失效';
        if (item.playback.partial) return '部分可播放';
        return '可播放';
      }
      const labels = {
        discovered:'待备份', queued:'已排队', downloading:'下载中', downloaded:'待上传', uploading:'上传中',
        uploaded:'远端确认中', upload_failed:'待补传', charging_restricted:'充电限制', missing:'远端缺失',
        lost:'已失效', failed:'失败', verified:'无兼容媒体', partial_verified:'无兼容媒体'
      };
      return labels[item.backupStatus] || (item.statusGroup === 'pending' ? '待处理' : '异常');
    }

    function archiveMembershipText(item) {
      const labels = (item.memberships || []).map((membership) => safeText(membership.folderTitle, '收藏夹'));
      const more = Math.max(0, Number(item.membershipCount || 0) - labels.length);
      return labels.join(' · ') + (more ? ' · +' + more : '');
    }

    function appendArchiveCover(container, item, className) {
      const local = localCoverUrl(item);
      const remote = item && item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const sources = [...new Set([local, remote].filter(Boolean))];
      const placeholder = document.createElement('span');
      placeholder.className = 'archive-library-placeholder';
      placeholder.textContent = 'B';
      placeholder.setAttribute('aria-hidden', 'true');
      container.appendChild(placeholder);
      if (!sources.length) return;
      const image = document.createElement('img');
      if (className) image.className = className;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let index = 0;
      image.addEventListener('load', () => placeholder.classList.add('is-hidden'));
      image.addEventListener('error', () => {
        index += 1;
        if (index < sources.length) image.src = sources[index];
        else image.remove();
      });
      image.src = sources[0];
      container.appendChild(image);
    }

    function createArchiveLibraryCard(item) {
      const card = document.createElement('div');
      card.className = 'archive-library-card';
      card.dataset.archiveBvid = item.bvid;
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'archive-library-card-main';
      main.setAttribute('aria-label', (item.playback?.available ? '播放 ' : '查看详情 ') + safeText(item.title || item.bvid, '归档视频'));
      const cover = document.createElement('span');
      cover.className = 'archive-library-cover';
      appendArchiveCover(cover, item);
      const coverBadges = document.createElement('span');
      coverBadges.className = 'archive-library-cover-badges';
      const status = document.createElement('span');
      status.className = 'archive-library-status ' + item.statusGroup;
      status.textContent = archiveStatusLabel(item);
      coverBadges.appendChild(status);
      if (item.playback?.partCount) {
        const media = document.createElement('span');
        media.className = 'archive-library-cover-badge';
        media.textContent = [item.playback.actualQuality, item.playback.partCount > 1 ? item.playback.partCount + 'P' : ''].filter(Boolean).join(' · ');
        if (media.textContent) coverBadges.appendChild(media);
      }
      cover.appendChild(coverBadges);
      const copy = document.createElement('span');
      copy.className = 'archive-library-card-copy';
      const title = document.createElement('span');
      title.className = 'archive-library-title';
      title.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('span');
      meta.className = 'archive-library-meta';
      meta.textContent = safeText(item.upperName, '未知UP') + ' · ' + safeText(item.bvid, '-');
      const memberships = document.createElement('span');
      memberships.className = 'archive-library-memberships';
      memberships.textContent = archiveMembershipText(item);
      copy.appendChild(title);
      copy.appendChild(meta);
      copy.appendChild(memberships);
      main.appendChild(cover);
      main.appendChild(copy);
      card.appendChild(main);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'archive-library-card-more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '查看归档来源与操作');
      more.title = '来源与操作';
      more.addEventListener('click', () => openArchiveLibraryDetail(item.bvid, more));
      card.appendChild(more);
      main.addEventListener('click', () => {
        if (item.playback?.available) openArchiveLibraryPlayback(item.bvid, main);
        else openArchiveLibraryDetail(item.bvid, main);
      });
      return card;
    }

    function setArchiveLibraryFooter(text, retry) {
      const footer = document.getElementById('archiveLibraryFooter');
      footer.replaceChildren();
      if (text) footer.appendChild(document.createTextNode(text));
      if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.addEventListener('click', retry);
        footer.appendChild(button);
      }
    }

    async function loadArchiveLibraryItems(reset = false) {
      if (archiveLibraryState.loading && !reset) return;
      if (reset) {
        archiveLibraryState.token += 1;
        if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
        archiveLibraryState.items = [];
        archiveLibraryState.nodes.clear();
        archiveLibraryState.nextCursor = null;
        archiveLibraryState.hasMore = true;
        archiveLibraryState.summary = null;
        archiveLibraryState.error = null;
        document.getElementById('archiveLibraryGrid').replaceChildren();
        document.getElementById('archiveLibraryResults').scrollTop = 0;
      }
      if (!archiveLibraryState.hasMore) return;
      const token = archiveLibraryState.token;
      const controller = new AbortController();
      archiveLibraryState.controller = controller;
      archiveLibraryState.loading = true;
      setArchiveLibraryFooter(reset ? '正在读取本地归档...' : '正在加载更多...', null);
      try {
        const params = archiveLibraryQueryParams({ cursor:archiveLibraryState.nextCursor });
        const data = await fetchJson('/api/archive-library/items?' + params.toString(), { signal:controller.signal });
        if (token !== archiveLibraryState.token) return;
        const incoming = Array.isArray(data.items) ? data.items : [];
        const known = new Set(archiveLibraryState.items.map((item) => item.bvid));
        const fresh = incoming.filter((item) => item && item.bvid && !known.has(item.bvid));
        archiveLibraryState.items.push(...fresh);
        archiveLibraryState.nextCursor = data.nextCursor || null;
        archiveLibraryState.hasMore = Boolean(data.hasMore);
        if (data.summary) archiveLibraryState.summary = data.summary;
        archiveLibraryState.error = null;
        const grid = document.getElementById('archiveLibraryGrid');
        const fragment = document.createDocumentFragment();
        fresh.forEach((item) => {
          const node = createArchiveLibraryCard(item);
          archiveLibraryState.nodes.set(item.bvid, node);
          fragment.appendChild(node);
        });
        grid.appendChild(fragment);
        if (!archiveLibraryState.items.length) {
          const empty = document.createElement('div');
          empty.className = 'archive-library-empty';
          empty.textContent = archiveLibraryState.query ? '没有匹配的本地归档' : '当前目录暂无本地归档';
          grid.appendChild(empty);
        }
        setArchiveLibraryHeading();
        setArchiveLibraryFooter(archiveLibraryState.hasMore ? '' : '已加载全部', null);
        if (reset) {
          const stored = Number(archiveLibraryState.scrollPositions[archiveContextKey()] || 0);
          requestAnimationFrame(() => { document.getElementById('archiveLibraryResults').scrollTop = stored; });
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (token !== archiveLibraryState.token) return;
        if (error && error.code === 'ARCHIVE_CURSOR_STALE' && archiveLibraryState.nextCursor) {
          return loadArchiveLibraryItems(true);
        }
        archiveLibraryState.error = error instanceof Error ? error.message : String(error);
        setArchiveLibraryFooter('加载失败，已保留现有内容', () => loadArchiveLibraryItems(false));
      } finally {
        if (token === archiveLibraryState.token) {
          archiveLibraryState.loading = false;
          if (archiveLibraryState.controller === controller) archiveLibraryState.controller = null;
        }
      }
    }

    function syncArchiveLibraryDetailLayer() {
      syncArchiveLibraryPanels();
    }

    function closeArchiveLibraryDetail(options = {}) {
      const detail = document.getElementById('archiveLibraryDetail');
      if (!detail) return;
      const wasOpen = detail.classList.contains('open');
      const trigger = archiveLibraryState.detailTrigger;
      archiveLibraryState.detailToken += 1;
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      archiveLibraryState.detailController = null;
      detail.classList.remove('open');
      detail.setAttribute('aria-hidden', 'true');
      document.getElementById('archiveLibraryDetailBody').replaceChildren();
      syncArchiveLibraryDetailLayer();
      archiveLibraryState.detailTrigger = null;
      archiveLibraryState.detailBvid = null;
      if (wasOpen && options.restoreFocus !== false) {
        setTimeout(() => {
          if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.closest('[inert]') && !trigger.disabled) {
            trigger.focus({ preventScroll:true });
            return;
          }
          const results = document.getElementById('archiveLibraryResults');
          if (results && results.isConnected && !results.closest('[inert]')) results.focus({ preventScroll:true });
        }, 0);
      }
    }

    function archiveDeletionProgressText(operation) {
      const labels = { preview:'等待确认', preparing:'正在停止账号任务', config_removing:'正在移除账号配置', pending:'等待清理', running:'正在清理', retry_wait:'等待自动重试', failed:'清理失败', completed:'清理完成', expired:'预览已过期', superseded:'来源已重新加入，旧任务结束' };
      return (labels[operation.status] || operation.status) + ' · ' + Number(operation.completedCount || 0) + '/' + Number(operation.fileCount || 0) +
        (operation.retainedCount ? ' · 共享保留 ' + Number(operation.retainedCount) : '') +
        (operation.lastError ? ' · ' + operation.lastError : '');
    }

    async function refreshArchiveLibraryAfterDeletion(detailToken) {
      const sessionToken = archiveLibraryState.sessionToken;
      if (!archiveLibrarySessionCurrent(sessionToken) || detailToken !== archiveLibraryState.detailToken) return false;
      try {
        const navigation = await requestArchiveLibraryNavigation(sessionToken);
        if (!navigation || detailToken !== archiveLibraryState.detailToken) return false;
        renderArchiveLibraryNavigation();
      } catch (_) {}
      if (!archiveLibrarySessionCurrent(sessionToken) || detailToken !== archiveLibraryState.detailToken) return false;
      await loadArchiveLibraryItems(true);
      return archiveLibrarySessionCurrent(sessionToken) && detailToken === archiveLibraryState.detailToken;
    }

    async function repreviewAndStartArchiveDeletion(operationId, trigger) {
      const preview = await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId) + '/repreview', { method:'POST' });
      const account = preview.scope === 'account';
      const requiredText = account ? 'DELETE REMOTE ARCHIVE' : 'DELETE ARCHIVE';
      const confirmed = await confirmAction({
        title:account ? '重新确认账号归档清理' : '重新确认来源归档清理',
        message:'新的预览包含 ' + Number(preview.fileCount || 0) + ' 个已追踪文件，共 ' + formatBytes(Number(preview.totalBytes || 0)) + '。',
        detail:(preview.sharedCount ? Number(preview.sharedCount) + ' 个共享文件只解除目标来源，不删除物理文件。' : '删除前会重新核验全部文件，未知文件不会被删除。'),
        requiredText, confirmText:'开始清理', trigger
      });
      if (!confirmed) return null;
      return fetchJson('/api/archive-deletions/' + encodeURIComponent(preview.previewId) + '/start', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ confirmation:requiredText })
      });
    }

    async function watchArchiveSourceDeletion(operationId, host, token) {
      if (!host || token !== archiveLibraryState.detailToken) return;
      try {
        const operation = await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId));
        if (token !== archiveLibraryState.detailToken || !document.contains(host)) return;
        host.replaceChildren(document.createTextNode(archiveDeletionProgressText(operation)));
        if (operation.status === 'completed') {
          if (!await refreshArchiveLibraryAfterDeletion(token)) return;
          closeArchiveLibraryDetail();
          showToast('远端归档已安全清理', 'success');
          return;
        }
        if (operation.status === 'failed') {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'ghost';
          retry.textContent = '重试清理';
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
              await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId) + '/retry', { method:'POST' });
              watchArchiveSourceDeletion(operationId, host, token);
            } catch (error) {
              retry.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(retry);
          const repreview = document.createElement('button');
          repreview.type = 'button';
          repreview.className = 'ghost';
          repreview.textContent = '重新预览';
          repreview.addEventListener('click', async () => {
            repreview.disabled = true;
            try {
              const replacement = await repreviewAndStartArchiveDeletion(operationId, repreview);
              if (replacement) watchArchiveSourceDeletion(replacement.id, host, token);
              else repreview.disabled = false;
            } catch (error) {
              repreview.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(repreview);
          return;
        }
        setTimeout(() => watchArchiveSourceDeletion(operationId, host, token), 1000);
      } catch (error) {
        if (token !== archiveLibraryState.detailToken || !document.contains(host)) return;
        host.textContent = '清理状态暂时无法读取：' + (error instanceof Error ? error.message : String(error));
        setTimeout(() => watchArchiveSourceDeletion(operationId, host, token), 3000);
      }
    }

    async function deleteArchiveLibrarySource(bvid, membership, trigger, host, token) {
      if (!(trigger instanceof HTMLButtonElement) || trigger.disabled || trigger.dataset.deleteBusy === 'true') return;
      trigger.dataset.deleteBusy = 'true';
      trigger.disabled = true;
      let started = false;
      try {
        const preview = await fetchJson('/api/archive-library/items/' + encodeURIComponent(bvid) + '/deletion-preview', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ userId:membership.userId, mediaId:membership.mediaId })
        });
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        const confirmed = await confirmAction({
          title:'删除此来源的远端归档',
          message:'将删除 ' + Number(preview.fileCount || 0) + ' 个已追踪文件，共 ' + formatBytes(Number(preview.totalBytes || 0)) + '。',
          detail:(preview.sharedCount ? Number(preview.sharedCount) + ' 个共享文件只解除当前来源，不删除物理文件。' : '删除前会重新核验全部文件，未知文件不会被删除。'),
          requiredText:'DELETE ARCHIVE', confirmText:'开始清理', trigger
        });
        if (!confirmed) return;
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        const operation = await fetchJson('/api/archive-deletions/' + encodeURIComponent(preview.previewId) + '/start', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ confirmation:'DELETE ARCHIVE' })
        });
        started = true;
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        host.classList.remove('is-hidden');
        watchArchiveSourceDeletion(operation.id, host, token);
      } catch (error) {
        if (token !== archiveLibraryState.detailToken || !host.isConnected) return;
        showToast(error instanceof Error ? error.message : String(error));
      } finally {
        delete trigger.dataset.deleteBusy;
        if (!started && trigger.isConnected) trigger.disabled = false;
      }
    }

    async function openArchiveLibraryDetail(bvid, trigger) {
      const detail = document.getElementById('archiveLibraryDetail');
      const body = document.getElementById('archiveLibraryDetailBody');
      if (archiveLibraryState.detailController) archiveLibraryState.detailController.abort();
      const controller = new AbortController();
      archiveLibraryState.detailController = controller;
      const token = ++archiveLibraryState.detailToken;
      archiveLibraryState.detailTrigger = trigger instanceof HTMLElement ? trigger : null;
      archiveLibraryState.detailBvid = bvid;
      detail.classList.add('open');
      detail.setAttribute('aria-hidden', 'false');
      syncArchiveLibraryDetailLayer();
      document.getElementById('archiveLibraryDetailTitle').textContent = '归档详情';
      body.textContent = '正在读取...';
      setTimeout(() => {
        if (token === archiveLibraryState.detailToken && detail.classList.contains('open')) {
          document.getElementById('archiveLibraryDetailCloseBtn').focus({ preventScroll:true });
        }
      }, 0);
      try {
        const params = archiveLibraryQueryParams();
        const data = await fetchJson('/api/archive-library/items/' + encodeURIComponent(bvid) + '?' + params.toString(), { signal:controller.signal });
        if (token !== archiveLibraryState.detailToken || !detail.classList.contains('open')) return;
        body.replaceChildren();
        document.getElementById('archiveLibraryDetailTitle').textContent = safeText(data.title || data.bvid, '归档详情');
        const cover = document.createElement('div');
        cover.className = 'archive-library-cover';
        appendArchiveCover(cover, data, 'archive-library-detail-cover');
        body.appendChild(cover);
        const meta = document.createElement('div');
        meta.className = 'archive-library-detail-meta';
        meta.textContent = safeText(data.upperName, '未知UP') + ' · ' + safeText(data.bvid, '-') + ' · ' + archiveStatusLabel(data);
        body.appendChild(meta);
        (data.memberships || []).forEach((membership) => {
          const source = document.createElement('div');
          source.className = 'archive-library-source';
          const title = document.createElement('strong');
          title.textContent = safeText(membership.userName, '未知账号') + ' · ' + safeText(membership.folderTitle, '收藏夹');
          const state = document.createElement('span');
          state.textContent = archiveStatusLabel({ backupStatus:membership.backupStatus, statusGroup:data.statusGroup, playback:{ available:false } }) +
            (membership.activeInFavorite ? ' · 当前关系' : ' · 历史记录') +
            (membership.selectedFolder ? '' : ' · 已停用') +
            (membership.ownerRemoved ? ' · 已移除账号' : '') +
            (membership.lastSeenAt ? ' · ' + formatDateTime(membership.lastSeenAt) : '');
          source.appendChild(title);
          source.appendChild(state);
          if (membership.error) {
            const error = document.createElement('span');
            error.textContent = membership.error;
            source.appendChild(error);
          }
          const size = document.createElement('span');
          size.textContent = Number(membership.fileCount || 0) + ' 个文件 · ' + formatBytes(Number(membership.totalBytes || 0));
          source.appendChild(size);
          const actions = document.createElement('div');
          actions.className = 'archive-library-source-actions';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'danger-action';
          const retryExisting = membership.deletionStatus === 'failed' && membership.deletionId;
          const deletionRunning = ['preparing','config_removing','pending','running','retry_wait'].includes(membership.deletionStatus);
          remove.textContent = membership.deletionStatus === 'completed'
            ? '已删除'
            : retryExisting
              ? '重试清理'
              : deletionRunning
                ? '清理中'
                : '删除此来源归档';
          remove.disabled = !(membership.deletable || retryExisting);
          if (membership.deletionReason) remove.title = membership.deletionReason;
          const progress = document.createElement('div');
          progress.className = 'archive-deletion-progress is-hidden';
          if (retryExisting) {
            remove.addEventListener('click', async () => {
              remove.disabled = true;
              try {
                await fetchJson('/api/archive-deletions/' + encodeURIComponent(membership.deletionId) + '/retry', { method:'POST' });
                progress.classList.remove('is-hidden');
                watchArchiveSourceDeletion(membership.deletionId, progress, token);
              } catch (error) {
                remove.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            const repreview = document.createElement('button');
            repreview.type = 'button';
            repreview.className = 'ghost';
            repreview.textContent = '重新预览';
            repreview.addEventListener('click', async () => {
              repreview.disabled = true;
              try {
                const replacement = await repreviewAndStartArchiveDeletion(membership.deletionId, repreview);
                if (replacement) {
                  progress.classList.remove('is-hidden');
                  watchArchiveSourceDeletion(replacement.id, progress, token);
                } else {
                  repreview.disabled = false;
                }
              } catch (error) {
                repreview.disabled = false;
                showToast(error instanceof Error ? error.message : String(error));
              }
            });
            actions.appendChild(repreview);
          } else if (membership.deletable) {
            remove.addEventListener('click', () => deleteArchiveLibrarySource(data.bvid, membership, remove, progress, token));
          }
          actions.appendChild(remove);
          source.appendChild(actions);
          if (membership.deletionReason) {
            const reason = document.createElement('span');
            reason.className = 'archive-library-source-reason';
            reason.textContent = membership.deletionReason;
            source.appendChild(reason);
          }
          source.appendChild(progress);
          body.appendChild(source);
          if (deletionRunning && membership.deletionId) {
            progress.classList.remove('is-hidden');
            watchArchiveSourceDeletion(membership.deletionId, progress, token);
          }
        });
      } catch (error) {
        if ((error && error.name === 'AbortError') || token !== archiveLibraryState.detailToken || !detail.classList.contains('open')) return;
        body.replaceChildren();
        const message = document.createElement('p');
        message.textContent = '详情加载失败：' + (error instanceof Error ? error.message : String(error));
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'archive-library-detail-retry';
        retry.textContent = '重试';
        retry.addEventListener('click', () => openArchiveLibraryDetail(bvid, trigger));
        body.appendChild(message);
        body.appendChild(retry);
      } finally {
        if (archiveLibraryState.detailController === controller) archiveLibraryState.detailController = null;
      }
    }

    function scheduleArchiveLibrarySearch() {
      const input = document.getElementById('archiveLibrarySearchInput');
      const nextQuery = String(input.value || '').trim().slice(0, 80);
      archiveLibraryState.draftQuery = nextQuery;
      setHidden('archiveLibrarySearchClearBtn', !archiveLibraryState.draftQuery);
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = setTimeout(() => {
        archiveLibraryState.searchTimer = null;
        if (!document.getElementById('archiveLibraryModal').classList.contains('active')) return;
        if (applyArchiveLibraryDraftQuery()) loadArchiveLibraryItems(true);
      }, 300);
    }

    function applyArchiveLibraryDraftQuery() {
      if (archiveLibraryState.searchTimer) clearTimeout(archiveLibraryState.searchTimer);
      archiveLibraryState.searchTimer = null;
      const nextQuery = String(archiveLibraryState.draftQuery || '').trim().slice(0, 80);
      if (nextQuery === archiveLibraryState.query) {
        setArchiveLibraryHeading();
        return false;
      }
      if (!archiveLibraryState.query && nextQuery) saveArchiveLibraryScroll();
      archiveLibraryState.query = nextQuery;
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      return true;
    }

    async function openArchiveLibrary(trigger) {
      archiveLibraryState.sessionToken += 1;
      archiveLibraryState.token += 1;
      if (archiveLibraryState.controller) archiveLibraryState.controller.abort();
      if (archiveLibraryState.navigationController) archiveLibraryState.navigationController.abort();
      const preference = loadArchiveLibraryPreference();
      archiveLibraryState.scope = preference.scope;
      archiveLibraryState.userId = preference.userId;
      archiveLibraryState.mediaId = preference.mediaId;
      archiveLibraryState.filter = preference.filter;
      archiveLibraryState.sort = preference.sort;
      archiveLibraryState.scrollPositions = preference.scrollPositions;
      archiveLibraryState.draftQuery = '';
      archiveLibraryState.query = '';
      archiveLibraryState.searchScope = 'current';
      archiveLibraryState.pageSize = 50;
      archiveLibraryState.trigger = trigger || null;
      archiveLibraryState.navigation = null;
      archiveLibraryState.title = '全部归档';
      document.getElementById('archiveLibrarySearchInput').value = '';
      document.querySelector('.archive-library-shell').classList.remove('show-content');
      syncArchiveLibraryPanels();
      renderArchiveLibraryNavigation();
      setArchiveLibraryHeading();
      openModal('archiveLibraryModal', trigger);
      const token = archiveLibraryState.sessionToken;
      try {
        const navigation = await requestArchiveLibraryNavigation(token);
        if (!navigation || !archiveLibrarySessionCurrent(token)) return;
        if (!archiveDirectoryExists(navigation, archiveLibraryState.scope, archiveLibraryState.userId, archiveLibraryState.mediaId)) {
          archiveLibraryState.scope = 'global';
          archiveLibraryState.userId = null;
          archiveLibraryState.mediaId = null;
        }
        if (archiveLibraryState.scope === 'account') {
          const account = navigation.accounts.find((entry) => entry.id === archiveLibraryState.userId);
          archiveLibraryState.title = account ? safeText(account.name, '账号') + ' · 全部归档' : '全部归档';
        } else if (archiveLibraryState.scope === 'folder') {
          const account = navigation.accounts.find((entry) => entry.id === archiveLibraryState.userId);
          const folder = account && [...(account.folders || []), ...(account.inactiveFolders || [])]
            .find((entry) => Number(entry.mediaId) === Number(archiveLibraryState.mediaId));
          archiveLibraryState.title = folder ? folder.title + (folder.inactive ? ' · 已停用' : '') : '收藏夹归档';
        }
        renderArchiveLibraryNavigation();
        setArchiveLibraryHeading();
        await loadArchiveLibraryItems(true);
      } catch (error) {
        if ((error && error.name === 'AbortError') || !archiveLibrarySessionCurrent(token)) return;
        setArchiveLibraryFooter('归档目录加载失败', () => openArchiveLibrary(trigger));
      }
    }

    // ---- Video Detail Modal ----
    function appendVideoDetailCover(container, item) {
      const wrap = document.createElement('div');
      wrap.className = 'video-cover-wrap';
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const candidates = (item.unavailable ? [cachedCoverUrl, remoteCoverUrl] : [remoteCoverUrl, cachedCoverUrl])
        .filter((value, index, all) => value && all.indexOf(value) === index);
      if (!candidates.length) {
        const placeholder = document.createElement('div');
        placeholder.className = 'video-cover';
        wrap.appendChild(placeholder);
      } else {
        const img = document.createElement('img');
        img.className = 'video-cover';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        let candidateIndex = 0;
        img.src = candidates[candidateIndex];
        img.addEventListener('error', () => {
          candidateIndex += 1;
          if (candidateIndex < candidates.length) {
            img.src = candidates[candidateIndex];
            return;
          }
          const placeholder = document.createElement('div');
          placeholder.className = 'video-cover';
          img.replaceWith(placeholder);
        });
        wrap.appendChild(img);
      }
      if (item.playback && item.playback.available) {
        const affordance = document.createElement('span');
        affordance.className = 'video-play-affordance';
        affordance.setAttribute('aria-hidden', 'true');
        affordance.textContent = '▶';
        wrap.appendChild(affordance);
      }
      container.appendChild(wrap);
    }

    function renderVideoDetailItem(item) {
      const div = document.createElement('div');
      let stateClass = '';
      let badgeClass = '';
      let badgeText = '';
      if (item.backupStatus === 'uploaded') {
        stateClass = item.unavailable ? 'unavailable-uploaded' : 'processed';
        badgeClass = 'upload-pending';
        badgeText = item.unavailable ? '失效·确认中' : '上传确认中';
      } else if (item.backupStatus === 'partial_verified') {
        stateClass = 'processed';
        badgeClass = 'partial';
        badgeText = '部分备份';
      } else if (item.unavailable && item.processed) {
        stateClass = 'unavailable-uploaded';
        badgeClass = 'removed-uploaded';
        badgeText = '已上传且失效';
      } else if (item.unavailable && !item.processed) {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = '未上传且失效';
      } else if (item.processed) {
        stateClass = 'processed';
        badgeClass = 'done';
        badgeText = '已备份';
      } else if (item.backupStatus === 'upload_failed') {
        stateClass = '';
        badgeClass = 'upload-pending';
        badgeText = '待补传';
      } else if (item.backupStatus === 'charging_restricted') {
        stateClass = '';
        badgeClass = 'pending';
        badgeText = '充电视频';
      } else if (item.backupStatus === 'downloading') {
        badgeClass = 'pending';
        badgeText = '下载中';
      } else if (item.backupStatus === 'downloaded') {
        badgeClass = 'pending';
        badgeText = '待上传';
      } else if (item.backupStatus === 'uploading') {
        badgeClass = 'upload-pending';
        badgeText = '上传中';
      } else if (item.backupStatus === 'queued') {
        badgeClass = 'pending';
        badgeText = '已排队';
      } else if (item.backupStatus === 'missing') {
        badgeClass = 'removed-missing';
        badgeText = '远端缺失';
      } else if (item.failed) {
        stateClass = 'unavailable-missing';
        badgeClass = 'removed-missing';
        badgeText = '下载失败';
      } else {
        stateClass = '';
        badgeClass = 'pending';
        badgeText = '待备份';
      }

      const canPlay = Boolean(item.playback && item.playback.available);
      div.className = 'video-item ' + stateClass + (canPlay ? ' playable' : '');
      if (canPlay) {
        div.tabIndex = 0;
        div.setAttribute('role', 'button');
        div.setAttribute('aria-label', '播放 ' + safeText(item.title || item.bvid, '归档视频'));
        div.dataset.playbackBvid = String(item.bvid || '');
      }
      appendVideoDetailCover(div, item);

      const info = document.createElement('div');
      info.className = 'video-info';
      const titleEl = document.createElement('div');
      titleEl.className = 'video-title';
      titleEl.title = safeText(item.title || item.bvid, '未知视频');
      titleEl.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      const chargingCheck = item.accessRestriction && item.accessRestriction.nextCheckAt
        ? ' | 下次检查：' + formatDateTime(item.accessRestriction.nextCheckAt)
        : '';
      const playbackMeta = canPlay ? ' | 可播放 ' + Number(item.playback.partCount || 1) + ' 个分P' : '';
      meta.textContent = 'UP: ' + safeText(item.upperName || item.ownerName, '未知UP') + ' | ' + safeText(item.bvid, '-') + chargingCheck + playbackMeta;
      info.appendChild(titleEl);
      info.appendChild(meta);
      if (!canPlay && item.playback && item.playback.reason) {
        const reason = document.createElement('span');
        reason.className = 'video-play-reason';
        reason.textContent = item.playback.reason === 'awaiting_verification'
          ? '远端仍在确认，确认完成后可播放'
          : item.playback.reason === 'no_playable_media'
            ? '归档容器暂不支持浏览器直接播放'
            : '尚未形成可播放的已验证归档';
        info.appendChild(reason);
      }
      div.appendChild(info);

      const badges = document.createElement('div');
      badges.className = 'video-badges';
      const badge = document.createElement('span');
      badge.className = 'video-badge ' + badgeClass;
      badge.textContent = badgeText;
      badges.appendChild(badge);
      if (item.activeInFavorite === false) {
        const historyBadge = document.createElement('span');
        historyBadge.className = 'video-badge history';
        historyBadge.textContent = '历史记录';
        badges.appendChild(historyBadge);
      }
      div.appendChild(badges);
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

    function setVideoDetailError(text) {
      const grid = document.getElementById('videoGrid');
      let status = grid.querySelector('[data-status-marker="video-detail"]');
      if (!status) {
        status = document.createElement('div');
        status.dataset.statusMarker = 'video-detail';
        grid.appendChild(status);
      }
      status.className = 'empty-state video-detail-status error';
      status.replaceChildren(document.createTextNode(text));
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost retry-button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => loadNextVideoDetailPage());
      status.appendChild(retry);
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

    function updateVideoDetailIndexHint(data, filter) {
      let hint = document.getElementById('videoDetailIndexHint');
      const grid = document.getElementById('videoGrid');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'videoDetailIndexHint';
        hint.className = 'video-detail-hint';
        grid.parentElement.insertBefore(hint, grid);
      }
      if (!data) {
        hint.textContent = '';
        setHidden(hint, true);
        return;
      }
      const indexSummary = data.indexSummary || {};
      const summary = data.summary || {};
      const indexed = Number(indexSummary.indexed || 0);
      const biliTotal = Number(indexSummary.biliTotal || 0);
      const scanComplete = Boolean(indexSummary.scanComplete);
      const unreturnedCount = Number(indexSummary.unreturnedCount || 0);
      const activeTotal = Number(summary.activeTotal || indexSummary.activeTotal || 0);
      const historicalTotal = Number(summary.historicalTotal || indexSummary.historicalTotal || 0);
      const parts = [];
      if (data.source === 'bili') {
        parts.push('列表来自 B 站实时数据；备份状态只基于已索引记录。');
      } else {
        parts.push('列表来自本地索引，不会因打开详情请求 B 站。');
        if (data.lastSyncedAt) parts.push('最近同步：' + formatDateTime(data.lastSyncedAt) + '。');
      }
      parts.push('当前记录 ' + activeTotal + ' 项，历史记录 ' + historicalTotal + ' 项。');
      setHidden(hint, false);
      if (scanComplete && unreturnedCount > 0) {
        parts.push('B 站报告 ' + biliTotal + ' 项，当前活动关系已索引 ' + indexed + ' 项；另有 ' + unreturnedCount + ' 项未返回具体视频信息。');
      } else if (data.coverage === 'partial' && biliTotal > indexed) {
        parts.push('当前索引覆盖 ' + indexed + '/' + biliTotal + ' 项，筛选数量尚不是最终结果。');
      } else if (data.source === 'bili' && filter !== 'all') {
        parts.push('当前筛选仅覆盖已索引记录。');
      }
      hint.textContent = parts.join('');
    }

    async function applyVideoDetailFilter(filter) {
      if (!videoDetailState.userId || !videoDetailState.mediaId) return;
      if (videoDetailState.controller) videoDetailState.controller.abort();
      videoDetailState.controller = null;
      if (videoDetailThrottleTimer) {
        clearTimeout(videoDetailThrottleTimer);
        videoDetailThrottleTimer = null;
      }
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
      const controller = new AbortController();
      videoDetailState.controller = controller;
      videoDetailState.loading = true;
      setVideoDetailStatus(nextPage === 1 ? '加载视频列表...' : '加载更多...');
      try {
        let url =
          '/api/users/' + videoDetailState.userId +
          '/favorites/' + videoDetailState.mediaId +
          '/detail-items?page=' + nextPage +
          '&pageSize=' + videoDetailState.pageSize +
          '&filter=' + encodeURIComponent(videoDetailState.filter || 'all');
        url += '&folderTitle=' + encodeURIComponent(videoDetailState.title || 'favorites');
        const data = await fetchJson(url, { signal: controller.signal });
        if (token !== videoDetailState.token) return;
        videoDetailState.summary = data.summary || null;
        videoDetailState.indexSummary = data.indexSummary || videoDetailState.indexSummary || null;
        videoDetailState.source = data.source || null;
        videoDetailState.tracked = Boolean(data.tracked);
        videoDetailState.lastSyncedAt = data.lastSyncedAt || null;
        videoDetailState.coverage = data.coverage || null;
        updateVideoDetailFilterCounts(videoDetailState.summary);
        updateVideoDetailIndexHint(data, videoDetailState.filter || 'all');
        const items = Array.isArray(data.items) ? data.items : [];
        if (nextPage === 1 && items.length === 0) {
          grid.innerHTML = '';
          videoDetailState.page = data.page || nextPage;
          videoDetailState.hasMore = false;
          setVideoDetailStatus(data.source === 'bili' ? '此收藏夹为空' : '已索引范围内没有匹配视频');
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
        if (e && e.name === 'AbortError') return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/412|风控|risk/i.test(msg)) {
          setVideoDetailError('触发B站风控，请等待几分钟后再试');
        } else {
          setVideoDetailError('加载失败: ' + msg);
        }
      } finally {
        if (token === videoDetailState.token) {
          videoDetailState.loading = false;
          if (videoDetailState.controller === controller) videoDetailState.controller = null;
        }
      }
    }

    async function openVideoDetail(userId, mediaId, title) {
      if (videoDetailState.controller) videoDetailState.controller.abort();
      videoDetailState.token += 1;
      videoDetailState = {
        userId,
        mediaId,
        title,
        filter: 'all',
        summary: null,
        indexSummary: null,
        source: null,
        tracked: false,
        lastSyncedAt: null,
        coverage: null,
        page: 0,
        pageSize: 20,
        hasMore: true,
        loading: false,
        token: videoDetailState.token,
        controller: null
      };
      document.getElementById('videoDetailTitle').textContent = '📁 ' + title;
      setVideoDetailFilterActive('all');
      updateVideoDetailFilterCounts(null);
      updateVideoDetailIndexHint(null, 'all');
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '';
      grid.scrollTop = 0;
      openModal('videoDetailModal');
      await loadNextVideoDetailPage();
    }

    // ---- Archive Playback ----
    function loadPlaybackPreferences() {
      const fallback = {
        version: 1,
        volume: 0.8,
        muted: false,
        rate: 1,
        continuous: true,
        mobilePortraitMode: true,
        progress: {}
      };
      try {
        const parsed = JSON.parse(localStorage.getItem(PLAYBACK_STORAGE_KEY) || 'null');
        if (!parsed || parsed.version !== 1 || typeof parsed !== 'object') return fallback;
        return {
          version: 1,
          volume: Number.isFinite(Number(parsed.volume)) ? Math.min(1, Math.max(0, Number(parsed.volume))) : fallback.volume,
          muted: Boolean(parsed.muted),
          rate: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(Number(parsed.rate)) ? Number(parsed.rate) : 1,
          continuous: parsed.continuous !== false,
          mobilePortraitMode: parsed.mobilePortraitMode !== false,
          progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {}
        };
      } catch (_) {
        return fallback;
      }
    }

    function persistPlaybackPreferences() {
      const prefs = playbackState.preferences;
      if (!prefs) return;
      const entries = Object.entries(prefs.progress || {})
        .filter((entry) => entry[1] && Number.isFinite(Number(entry[1].updatedAt)))
        .sort((left, right) => Number(right[1].updatedAt) - Number(left[1].updatedAt))
        .slice(0, 500);
      prefs.progress = Object.fromEntries(entries);
      try {
        localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(prefs));
      } catch (_) {
        // Playback continues when private browsing or storage quotas block persistence.
      }
    }

    function currentPlaybackItem() {
      return playbackState.items[playbackState.itemIndex] || null;
    }

    function currentPlaybackPart() {
      const item = currentPlaybackItem();
      return item && item.parts ? item.parts[playbackState.partIndex] || null : null;
    }

    function savePlaybackProgress() {
      const art = playbackState.art;
      const part = currentPlaybackPart();
      const prefs = playbackState.preferences;
      if (!art || !part || !prefs) return;
      const currentTime = Number(art.currentTime || 0);
      const duration = Number(art.duration || 0);
      if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return;
      if (currentTime < 10 || duration - currentTime < 15) {
        delete prefs.progress[part.fingerprint];
      } else {
        prefs.progress[part.fingerprint] = { time: currentTime, updatedAt: Date.now() };
      }
      prefs.volume = Number(art.volume || 0);
      prefs.muted = Boolean(art.muted);
      prefs.rate = Number(art.playbackRate || 1);
      persistPlaybackPreferences();
      updateMediaSessionPosition();
    }

    function destroyCurrentArt() {
      if (!playbackState.art) return;
      const art = playbackState.art;
      playbackState.art = null;
      try { art.destroy(true); } catch (_) {}
      document.getElementById('playbackArt').replaceChildren();
    }

    function clearMediaSession() {
      if (!('mediaSession' in navigator)) return;
      try {
        ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'].forEach((action) => {
          navigator.mediaSession.setActionHandler(action, null);
        });
        navigator.mediaSession.metadata = null;
      } catch (_) {}
    }

    function destroyPlaybackSession() {
      playbackState.loadingToken += 1;
      playbackState.queueToken += 1;
      playbackState.search.token += 1;
      if (playbackState.queueController) playbackState.queueController.abort();
      if (playbackState.search.controller) playbackState.search.controller.abort();
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      if (playbackState.search.timer) clearTimeout(playbackState.search.timer);
      if (playbackState.queueObserver) playbackState.queueObserver.disconnect();
      playbackState.queueController = null;
      playbackState.queuePromise = null;
      playbackState.search.controller = null;
      playbackState.search.timer = null;
      playbackState.queueObserver = null;
      playbackState.deliveryController = null;
      playbackState.deliveryAttemptId = null;
      playbackState.deliveryStatus = 'pending';
      playbackState.metadataReported.clear();
      playbackState.metadataReporting.clear();
      playbackState.metadataControllers.forEach((controller) => controller.abort());
      playbackState.metadataControllers.clear();
      playbackState.metadataRetryTimers.forEach((timer) => clearTimeout(timer));
      playbackState.metadataRetryTimers.clear();
      savePlaybackProgress();
      if (playbackState.progressTimer) clearInterval(playbackState.progressTimer);
      playbackState.progressTimer = null;
      destroyCurrentArt();
      clearMediaSession();
      const shell = document.querySelector('.playback-shell');
      shell.classList.remove('is-mobile-immersive', 'queue-open');
      const stage = document.getElementById('playbackStage');
      stage.classList.remove('is-portrait', 'is-swiping');
      stage.style.removeProperty('--playback-swipe-offset');
      const queue = document.querySelector('.playback-queue');
      queue.removeAttribute('inert');
      queue.setAttribute('aria-hidden', 'false');
      document.getElementById('playbackImmersiveQueueBtn').setAttribute('aria-expanded', 'false');
      document.getElementById('playbackDrawerBackdrop').tabIndex = -1;
      playbackState.drawerOpen = false;
      playbackState.swipeChanging = false;
      playbackState.swipe.pointerId = null;
      playbackState.swipe.tracking = false;
      playbackState.swipe.deltaX = 0;
      playbackState.swipe.deltaY = 0;
      playbackState.items = [];
      playbackState.pages.clear();
      playbackState.pageCursors.clear();
      playbackState.queueNodes.clear();
      playbackState.search.items = [];
      playbackState.search.nodes.clear();
      playbackState.search.query = '';
      playbackState.search.shownQuery = '';
      playbackState.search.page = 0;
      playbackState.search.total = 0;
      playbackState.search.hasMore = false;
      playbackState.search.loading = false;
      playbackState.search.error = null;
      playbackState.queueLoading = false;
      playbackState.queueLoadingDirection = null;
      playbackState.queueError = null;
      playbackState.userId = null;
      playbackState.mediaId = null;
      playbackState.trigger = null;
      playbackState.focusBvid = null;
      playbackState.libraryContext = null;
      const queueHost = document.getElementById('playbackQueueList');
      queueHost.replaceChildren();
      queueHost.scrollTop = 0;
      delete queueHost.dataset.queueKey;
      delete queueHost.dataset.queueView;
      const searchInput = document.getElementById('playbackSearchInput');
      if (searchInput) searchInput.value = '';
      setHidden('playbackSearchClearBtn', true);
      setStatus('playbackSearchStatus', '');
    }

    function loadArtplayer() {
      if (window.Artplayer) return Promise.resolve(window.Artplayer);
      if (artplayerLoader) return artplayerLoader;
      artplayerLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/assets/vendor/artplayer-5.4.0.js';
        script.async = true;
        script.dataset.bfbArtplayer = '5.4.0';
        script.addEventListener('load', () => {
          if (window.Artplayer) resolve(window.Artplayer);
          else reject(new Error('播放器脚本加载完成但未能初始化'));
        }, { once:true });
        script.addEventListener('error', () => {
          script.remove();
          reject(new Error('播放器脚本加载失败，请重新登录后再试'));
        }, { once:true });
        document.head.appendChild(script);
      }).catch((error) => {
        artplayerLoader = null;
        throw error;
      });
      return artplayerLoader;
    }

    function setPlaybackMessage(title, detail, options = {}) {
      document.getElementById('playbackMessageTitle').textContent = title || '无法播放';
      document.getElementById('playbackMessageDetail').textContent = detail || '';
      setHidden('playbackRetryBtn', options.retry === false);
      setHidden('playbackSkipBtn', options.skip === false);
      setHidden('playbackStageMessage', false);
    }

    function hidePlaybackMessage() {
      setHidden('playbackStageMessage', true);
    }

    function playbackCoverUrl(item) {
      return localCoverUrl(item) || (item && item.cover ? String(item.cover).replace('http://', 'https://') : '');
    }

    function updatePlaybackNavigation() {
      const item = currentPlaybackItem();
      const queuePosition = Number(item && item.queuePosition || 0);
      const hasPrevious = Boolean(item) && (playbackState.partIndex > 0
        || (playbackState.mode !== 'single' ? queuePosition > 1 : playbackState.itemIndex > 0));
      const hasNext = Boolean(item) && (playbackState.partIndex + 1 < item.parts.length
        || (playbackState.mode !== 'single' ? queuePosition < playbackState.total : playbackState.itemIndex + 1 < playbackState.items.length));
      document.getElementById('playbackPreviousBtn').disabled = !hasPrevious;
      document.getElementById('playbackNextBtn').disabled = !hasNext;
      const continuous = document.getElementById('playbackContinuousBtn');
      continuous.classList.toggle('active', playbackState.continuous);
      continuous.setAttribute('aria-pressed', String(playbackState.continuous));
    }

    function renderPlaybackParts() {
      const host = document.getElementById('playbackPartList');
      host.replaceChildren();
      const item = currentPlaybackItem();
      if (!item) return;
      item.parts.forEach((part, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'playback-part-button' + (index === playbackState.partIndex ? ' active' : '');
        button.setAttribute('aria-pressed', String(index === playbackState.partIndex));
        button.textContent = part.label || ('P' + (index + 1));
        const detail = [playbackQualityLabel(part), playbackCodecLabel(part)].filter(Boolean).join(' · ');
        button.title = detail || button.textContent;
        button.addEventListener('click', () => {
          if (index === playbackState.partIndex) return;
          savePlaybackProgress();
          playbackState.partIndex = index;
          playCurrentSelection(true);
        });
        host.appendChild(button);
      });
    }

    function playbackQueueRenderKey() {
      return [
        playbackState.userId || '',
        playbackState.mediaId || '',
        playbackState.mode,
        playbackState.libraryContext ? JSON.stringify(playbackState.libraryContext) : '',
        ...Array.from(playbackState.pages.keys()).sort((left, right) => left - right)
      ].join(':');
    }

    function isPlaybackMobileLayout() {
      return window.matchMedia('(max-width: 720px)').matches;
    }

    function isPlaybackPortraitViewport() {
      return window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches;
    }

    function isPlaybackImmersiveActive() {
      const modal = document.getElementById('playbackModal');
      const prefs = playbackState.preferences;
      return Boolean(
        modal.classList.contains('active')
        && prefs
        && prefs.mobilePortraitMode !== false
        && isPlaybackPortraitViewport()
      );
    }

    function syncPlaybackMobileModeButton() {
      const enabled = !playbackState.preferences || playbackState.preferences.mobilePortraitMode !== false;
      const button = document.getElementById('playbackMobilePortraitBtn');
      button.classList.toggle('active', enabled);
      button.setAttribute('aria-pressed', String(enabled));
      button.title = enabled ? '沉浸竖屏已开启，设备横屏时自动使用普通布局' : '开启沉浸竖屏';
    }

    function setPlaybackQueueDrawer(open) {
      const shell = document.querySelector('.playback-shell');
      const queue = document.querySelector('.playback-queue');
      const queueButton = document.getElementById('playbackImmersiveQueueBtn');
      const immersive = isPlaybackImmersiveActive();
      const nextOpen = Boolean(open && immersive);
      if (!nextOpen && queue.contains(document.activeElement) && immersive) {
        queueButton.focus({ preventScroll:true });
      }
      playbackState.drawerOpen = nextOpen;
      shell.classList.toggle('queue-open', nextOpen);
      queueButton.setAttribute('aria-expanded', String(nextOpen));
      if (immersive && !nextOpen) queue.setAttribute('inert', '');
      else queue.removeAttribute('inert');
      queue.setAttribute('aria-hidden', String(immersive && !nextOpen));
      document.getElementById('playbackDrawerBackdrop').tabIndex = nextOpen ? 0 : -1;
      setupPlaybackQueueObserver();
      if (nextOpen) {
        syncPlaybackQueueSelection({ forceQueue:true, alignDesktop:true, behavior:'auto' });
      }
    }

    function syncPlaybackImmersiveMode() {
      const shell = document.querySelector('.playback-shell');
      const active = isPlaybackImmersiveActive();
      shell.classList.toggle('is-mobile-immersive', active);
      syncPlaybackMobileModeButton();
      if (!active) {
        playbackState.drawerOpen = false;
        shell.classList.remove('queue-open');
        const queue = document.querySelector('.playback-queue');
        queue.removeAttribute('inert');
        queue.setAttribute('aria-hidden', 'false');
        document.getElementById('playbackImmersiveQueueBtn').setAttribute('aria-expanded', 'false');
        document.getElementById('playbackDrawerBackdrop').tabIndex = -1;
        resetPlaybackSwipe();
      } else if (!playbackState.drawerOpen) {
        const queue = document.querySelector('.playback-queue');
        queue.setAttribute('inert', '');
        queue.setAttribute('aria-hidden', 'true');
      }
      setupPlaybackQueueObserver();
      return active;
    }

    function setPlaybackMobilePortraitMode(enabled) {
      if (!playbackState.preferences) playbackState.preferences = loadPlaybackPreferences();
      playbackState.preferences.mobilePortraitMode = Boolean(enabled);
      persistPlaybackPreferences();
      const active = syncPlaybackImmersiveMode();
      if (active) {
        setTimeout(() => document.getElementById('closePlaybackImmersiveBtn').focus({ preventScroll:true }), 0);
      }
    }

    function resetPlaybackSwipe() {
      const swipe = playbackState.swipe;
      const stage = document.getElementById('playbackStage');
      swipe.pointerId = null;
      swipe.startX = 0;
      swipe.startY = 0;
      swipe.deltaX = 0;
      swipe.deltaY = 0;
      swipe.tracking = false;
      stage.classList.remove('is-swiping');
      stage.style.removeProperty('--playback-swipe-offset');
    }

    function playbackSwipeStartsOnControl(target) {
      if (!(target instanceof Element)) return true;
      return Boolean(target.closest([
        'button',
        'input',
        'select',
        'textarea',
        'a',
        '[role="button"]',
        '[contenteditable="true"]',
        '.art-controls',
        '.art-setting',
        '.art-selector',
        '.art-contextmenus',
        '.art-info',
        '.art-notice'
      ].join(',')));
    }

    function handlePlaybackSwipeStart(event) {
      if (!isPlaybackImmersiveActive() || playbackState.drawerOpen || playbackState.swipeChanging) return;
      if (!event.isPrimary || event.button !== 0 || playbackSwipeStartsOnControl(event.target)) return;
      const swipe = playbackState.swipe;
      swipe.pointerId = event.pointerId;
      swipe.startX = event.clientX;
      swipe.startY = event.clientY;
      swipe.deltaX = 0;
      swipe.deltaY = 0;
      swipe.tracking = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
    }

    function handlePlaybackSwipeMove(event) {
      const swipe = playbackState.swipe;
      if (!swipe.tracking || swipe.pointerId !== event.pointerId) return;
      swipe.deltaX = event.clientX - swipe.startX;
      swipe.deltaY = event.clientY - swipe.startY;
      const vertical = Math.abs(swipe.deltaY) > 10 && Math.abs(swipe.deltaY) > Math.abs(swipe.deltaX) * 1.2;
      if (!vertical) return;
      event.preventDefault();
      const stage = document.getElementById('playbackStage');
      stage.classList.add('is-swiping');
      const offset = Math.max(-48, Math.min(48, swipe.deltaY * 0.35));
      stage.style.setProperty('--playback-swipe-offset', offset + 'px');
    }

    function handlePlaybackSwipeEnd(event) {
      const swipe = playbackState.swipe;
      if (!swipe.tracking || swipe.pointerId !== event.pointerId) return;
      const deltaX = swipe.deltaX;
      const deltaY = swipe.deltaY;
      const shouldChange = Math.abs(deltaY) >= 72 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25;
      resetPlaybackSwipe();
      if (!shouldChange || playbackState.swipeChanging) return;
      playbackState.swipeChanging = true;
      void stepPlayback(deltaY < 0 ? 1 : -1).finally(() => {
        playbackState.swipeChanging = false;
      });
    }

    function handlePlaybackSwipeCancel(event) {
      if (playbackState.swipe.pointerId === event.pointerId) resetPlaybackSwipe();
    }

    function isPlaybackSearchView() {
      return playbackState.mode !== 'single' && Boolean(playbackState.search.shownQuery);
    }

    function playbackPageBounds() {
      const pages = Array.from(playbackState.pages.keys()).sort((left, right) => left - right);
      return {
        first: pages.length ? pages[0] : 1,
        last: pages.length ? pages[pages.length - 1] : 0
      };
    }

    function playbackPageCursor(page) {
      return playbackState.pageCursors.get(Number(page || 0)) || null;
    }

    function createPlaybackThumbnail(item) {
      const thumb = document.createElement('span');
      thumb.className = 'playback-queue-thumb';
      const placeholder = document.createElement('span');
      placeholder.className = 'playback-queue-placeholder';
      placeholder.textContent = 'B';
      placeholder.setAttribute('aria-hidden', 'true');
      thumb.appendChild(placeholder);
      const local = localCoverUrl(item);
      const remote = item && item.cover ? String(item.cover).replace('http://', 'https://') : '';
      const sources = [...new Set([local, remote].filter(Boolean))];
      if (!sources.length) return thumb;
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let sourceIndex = 0;
      image.addEventListener('load', () => placeholder.classList.add('is-hidden'));
      image.addEventListener('error', () => {
        sourceIndex += 1;
        if (sourceIndex < sources.length) {
          image.src = sources[sourceIndex];
          return;
        }
        image.remove();
        placeholder.classList.remove('is-hidden');
      });
      image.src = sources[0];
      thumb.appendChild(image);
      return thumb;
    }

    function createPlaybackQueueNode(item, view) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'playback-queue-item';
      button.dataset.playbackQueueBvid = item.bvid;
      button.dataset.playbackQueueView = view;
      const number = document.createElement('span');
      number.className = 'playback-queue-number';
      number.textContent = playbackState.mode === 'single' ? 'H' : String(Number(item.queuePosition || 0)).padStart(2, '0');
      const copy = document.createElement('span');
      copy.className = 'playback-queue-copy';
      const title = document.createElement('span');
      title.className = 'playback-queue-title';
      title.textContent = safeText(item.title || item.bvid, '未知视频');
      const meta = document.createElement('span');
      meta.className = 'playback-queue-meta';
      meta.textContent = item.parts.length + ' 个分P' + (item.partial ? ' · 部分备份' : '') + ' · ' + safeText(item.upperName, '未知UP');
      copy.appendChild(title);
      copy.appendChild(meta);
      button.appendChild(number);
      button.appendChild(createPlaybackThumbnail(item));
      button.appendChild(copy);
      button.addEventListener('click', async () => {
        if (view === 'search') {
          await selectPlaybackSearchResult(item, button);
          return;
        }
        const index = playbackState.items.findIndex((candidate) => candidate.bvid === item.bvid);
        if (index < 0) return;
        if (index === playbackState.itemIndex && playbackState.partIndex === 0) {
          setPlaybackQueueDrawer(false);
          return;
        }
        savePlaybackProgress();
        playbackState.itemIndex = index;
        playbackState.partIndex = 0;
        await playCurrentSelection(true);
        setPlaybackQueueDrawer(false);
      });
      return button;
    }

    function setPlaybackQueueFeedback(element, text, retry) {
      if (!element) return;
      element.replaceChildren();
      if (text) element.append(document.createTextNode(text));
      if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.addEventListener('click', retry);
        element.appendChild(button);
      }
    }

    function updatePlaybackSearchHeader() {
      const controls = document.getElementById('playbackSearchControls');
      setHidden(controls, playbackState.mode === 'single');
      const search = playbackState.search;
      setHidden('playbackSearchClearBtn', !String(search.query || '').trim());
      const status = document.getElementById('playbackSearchStatus');
      status.replaceChildren();
      if (playbackState.mode === 'single') {
        return;
      } else if (search.loading) {
        status.textContent = search.shownQuery ? '正在搜索，保留当前结果' : '正在搜索';
      } else if (search.error) {
        status.textContent = search.shownQuery ? '搜索失败，保留上次结果' : '搜索失败';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => runPlaybackSearch(search.query || search.shownQuery, 1, false));
        status.appendChild(retry);
      } else if (search.shownQuery) {
        status.textContent = search.total + ' 个结果';
      } else {
        status.textContent = '';
      }
    }

    function updatePlaybackQueueFeedback() {
      const host = document.getElementById('playbackQueueList');
      const top = host.querySelector('[data-playback-boundary="top"]');
      const bottom = host.querySelector('[data-playback-boundary="bottom"]');
      if (isPlaybackSearchView()) {
        setPlaybackQueueFeedback(top, '', null);
        const search = playbackState.search;
        if (search.loading && search.page > 0) setPlaybackQueueFeedback(bottom, '正在加载更多结果', null);
        else if (search.error && search.error.page > 1) {
          setPlaybackQueueFeedback(bottom, '更多结果加载失败', () => runPlaybackSearch(search.shownQuery, search.error.page, true));
        } else setPlaybackQueueFeedback(bottom, '', null);
        return;
      }
      const error = playbackState.queueError;
      const loadingDirection = playbackState.queueLoadingDirection;
      if (error && error.direction === 'prepend') {
        setPlaybackQueueFeedback(top, '前面的队列加载失败', () => loadPlaybackQueuePage(error.page, { direction:'prepend' }).catch(() => undefined));
      } else {
        setPlaybackQueueFeedback(top, loadingDirection === 'prepend' ? '正在加载前面的归档' : '', null);
      }
      if (error && error.direction === 'append') {
        setPlaybackQueueFeedback(bottom, '后面的队列加载失败', () => loadPlaybackQueuePage(error.page, { direction:'append' }).catch(() => undefined));
      } else {
        setPlaybackQueueFeedback(bottom, loadingDirection === 'append' ? '正在加载更多归档' : '', null);
      }
    }

    function createPlaybackQueueBoundary(direction) {
      const boundary = document.createElement('div');
      boundary.className = 'playback-queue-feedback';
      boundary.dataset.playbackBoundary = direction;
      return boundary;
    }

    function renderPlaybackQueueStructure(view) {
      const host = document.getElementById('playbackQueueList');
      host.replaceChildren();
      host.appendChild(createPlaybackQueueBoundary('top'));
      const items = view === 'search' ? playbackState.search.items : playbackState.items;
      const nodeMap = view === 'search' ? playbackState.search.nodes : playbackState.queueNodes;
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'playback-queue-empty';
        empty.textContent = view === 'search' ? '没有匹配的可播放归档' : '当前没有可播放归档';
        host.appendChild(empty);
      } else {
        for (const item of items) {
          let node = nodeMap.get(item.bvid);
          if (!node) {
            node = createPlaybackQueueNode(item, view);
            nodeMap.set(item.bvid, node);
          }
          host.appendChild(node);
        }
      }
      host.appendChild(createPlaybackQueueBoundary('bottom'));
      host.dataset.queueView = view;
      host.dataset.queueKey = view === 'search' ? 'search:' + playbackState.search.shownQuery : playbackQueueRenderKey();
      updatePlaybackQueueFeedback();
      setupPlaybackQueueObserver();
    }

    function syncPlaybackQueueSelection(options = {}) {
      const host = document.getElementById('playbackQueueList');
      const item = currentPlaybackItem();
      const activeBvid = item ? item.bvid : '';
      const buttons = host.querySelectorAll('.playback-queue-item');
      buttons.forEach((button) => {
        const active = button.dataset.playbackQueueBvid === activeBvid;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });

      if ((isPlaybackMobileLayout() && options.forceQueue !== true) || options.alignDesktop === false) return;
      requestAnimationFrame(() => {
        const active = host.querySelector('.playback-queue-item.active');
        if (!active || !host.isConnected) return;
        const hostRect = host.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const margin = 7;
        let delta = 0;
        if (activeRect.top < hostRect.top + margin) delta = activeRect.top - hostRect.top - margin;
        else if (activeRect.bottom > hostRect.bottom - margin) delta = activeRect.bottom - hostRect.bottom + margin;
        if (!delta) return;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        host.scrollTo({
          top: Math.max(0, host.scrollTop + delta),
          behavior: options.behavior || (reducedMotion ? 'auto' : 'smooth')
        });
      });
    }

    function setupPlaybackQueueObserver() {
      if (playbackState.queueObserver) playbackState.queueObserver.disconnect();
      playbackState.queueObserver = null;
      if (typeof IntersectionObserver !== 'function' || playbackState.mode === 'single') return;
      const host = document.getElementById('playbackQueueList');
      const root = isPlaybackImmersiveActive()
        ? host
        : (isPlaybackMobileLayout() ? document.querySelector('.playback-layout') : host);
      if (!root) return;
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const direction = entry.target.dataset.playbackBoundary;
          if (isPlaybackSearchView()) {
            const search = playbackState.search;
            if (direction === 'bottom' && search.hasMore && !search.loading && search.query === search.shownQuery) {
              runPlaybackSearch(search.shownQuery, search.page + 1, true);
            }
            continue;
          }
          if (playbackState.queueLoading) continue;
          const bounds = playbackPageBounds();
          const firstCursor = playbackPageCursor(bounds.first);
          const lastCursor = playbackPageCursor(bounds.last);
          const canLoadPrevious = playbackState.mode === 'library'
            ? Boolean(firstCursor?.hasPrevious && firstCursor.previousCursor)
            : bounds.first > 1;
          const canLoadMore = playbackState.mode === 'library'
            ? Boolean(lastCursor?.hasMore && lastCursor.nextCursor)
            : bounds.last * playbackState.pageSize < playbackState.total;
          if (direction === 'top' && canLoadPrevious) {
            loadPlaybackQueuePage(bounds.first - 1, { direction:'prepend' }).catch(() => undefined);
          } else if (direction === 'bottom' && canLoadMore) {
            loadPlaybackQueuePage(bounds.last + 1, { direction:'append' }).catch(() => undefined);
          }
        }
      }, { root, rootMargin:'140px 0px' });
      host.querySelectorAll('[data-playback-boundary]').forEach((boundary) => observer.observe(boundary));
      playbackState.queueObserver = observer;
    }

    function rebuildPlaybackItems(selectedBvid) {
      const current = selectedBvid || currentPlaybackItem()?.bvid;
      const seen = new Set();
      playbackState.items = Array.from(playbackState.pages.entries())
        .sort((left, right) => left[0] - right[0])
        .flatMap((entry) => entry[1])
        .filter((item) => {
          if (!item || seen.has(item.bvid)) return false;
          seen.add(item.bvid);
          return true;
        })
        .sort((left, right) => Number(left.queuePosition || 0) - Number(right.queuePosition || 0));
      const index = current ? playbackState.items.findIndex((item) => item.bvid === current) : -1;
      playbackState.itemIndex = index >= 0 ? index : Math.min(playbackState.itemIndex, Math.max(0, playbackState.items.length - 1));
      playbackState.items.forEach((item, itemIndex) => {
        const node = playbackState.queueNodes.get(item.bvid);
        if (node) node.dataset.playbackQueueIndex = String(itemIndex);
      });
    }

    function insertPlaybackQueueItems(items, direction) {
      const host = document.getElementById('playbackQueueList');
      if (host.dataset.queueView !== 'normal') return;
      const bottom = host.querySelector('[data-playback-boundary="bottom"]');
      if (!bottom) return;
      const beforeHeight = host.scrollHeight;
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        let node = playbackState.queueNodes.get(item.bvid);
        if (!node) {
          node = createPlaybackQueueNode(item, 'normal');
          playbackState.queueNodes.set(item.bvid, node);
        }
        if (!node.isConnected) fragment.appendChild(node);
      }
      if (!fragment.childNodes.length) return;
      if (direction === 'prepend') {
        const firstItem = host.querySelector('.playback-queue-item');
        host.insertBefore(fragment, firstItem || bottom);
        if (!isPlaybackMobileLayout() || isPlaybackImmersiveActive()) host.scrollTop += host.scrollHeight - beforeHeight;
      } else {
        host.insertBefore(fragment, bottom);
      }
    }

    function applyPlaybackQueuePage(data, options = {}) {
      const page = Number(data.page || options.page || 1);
      const pageItems = (Array.isArray(data.items) ? data.items : []).map((item, index) => ({
        ...item,
        queuePosition: Number(item.queuePosition || ((page - 1) * playbackState.pageSize + index + 1))
      }));
      const selectedBvid = options.selectedBvid || currentPlaybackItem()?.bvid;
      if (options.reset) {
        playbackState.pages.clear();
        playbackState.pageCursors.clear();
        playbackState.queueNodes.clear();
        playbackState.items = [];
      }
      playbackState.mode = data.mode || 'favorite';
      playbackState.page = page;
      playbackState.total = Number(data.total || 0);
      playbackState.focusIndex = Number(data.focusIndex ?? -1);
      playbackState.pages.set(page, pageItems);
      playbackState.pageCursors.set(page, {
        hasPrevious:Boolean(data.hasPrevious ?? page > 1),
        previousCursor:data.previousCursor || null,
        hasMore:Boolean(data.hasMore),
        nextCursor:data.nextCursor || null
      });
      rebuildPlaybackItems(selectedBvid);
      if (options.selectedBvid) {
        const selectedIndex = playbackState.items.findIndex((item) => item.bvid === options.selectedBvid);
        if (selectedIndex >= 0) playbackState.itemIndex = selectedIndex;
      }
      if (options.render === false) return;
      if (options.reset || document.getElementById('playbackQueueList').dataset.queueView !== 'normal') {
        renderPlaybackQueue(true);
      } else {
        insertPlaybackQueueItems(pageItems, options.direction || 'append');
        updatePlaybackQueueFeedback();
        setupPlaybackQueueObserver();
        syncPlaybackQueueSelection({ alignDesktop:false });
      }
    }

    function renderPlaybackQueue(force = false) {
      const host = document.getElementById('playbackQueueList');
      document.getElementById('playbackQueueHeading').textContent = playbackState.mode === 'library'
        ? '归档库顺序'
        : '收藏夹顺序';
      document.querySelector('.playback-queue').setAttribute(
        'aria-label',
        playbackState.mode === 'library' ? '归档库播放队列' : '收藏夹播放队列'
      );
      document.getElementById('playbackQueueCount').textContent = playbackState.mode === 'single'
        ? '历史记录 · 单独播放'
        : playbackState.total + ' 个视频';
      updatePlaybackSearchHeader();
      const view = isPlaybackSearchView() ? 'search' : 'normal';
      if (force || host.dataset.queueView !== view) renderPlaybackQueueStructure(view);
      else updatePlaybackQueueFeedback();
      syncPlaybackQueueSelection();
    }

    function playbackQualityLabel(part) {
      if (!part) return '';
      const labels = [];
      if (part.bilibiliQuality) labels.push('B站' + String(part.bilibiliQuality));
      const actualQuality = String(part.actualQuality || part.quality || '');
      labels.push(actualQuality ? '实际' + actualQuality : '实际画质未知');
      const width = Math.round(Number(part.actualWidth || 0));
      const height = Math.round(Number(part.actualHeight || 0));
      if (width > 0 && height > 0) {
        const orientation = height > width ? '竖屏' : (width > height ? '横屏' : '方形');
        labels.push(width + '×' + height + ' ' + orientation);
      }
      return labels.join(' · ');
    }

    function playbackCodecLabel(part) {
      if (!part) return '';
      return part.codec ? String(part.codec) : '';
    }

    function playbackDeliveryLabel() {
      if (playbackState.deliveryStatus === 'direct') return '网盘直连';
      if (playbackState.deliveryStatus === 'proxy') return 'BFB代理';
      if (playbackState.deliveryStatus === 'unknown') return '传输方式未知';
      return '检测传输中';
    }

    function playbackOpenInAlistUrl(part) {
      if (!part || !playbackState.alistBrowserConfigured) return '';
      return playbackFileApiPath(part, '/open-in-alist');
    }

    function renderPlaybackMetadata() {
      const item = currentPlaybackItem();
      const part = currentPlaybackPart();
      const meta = [];
      if (part) {
        meta.push(part.label || ('P' + (playbackState.partIndex + 1)));
        meta.push(playbackQualityLabel(part));
        const codecLabel = playbackCodecLabel(part);
        if (codecLabel) meta.push(codecLabel);
        meta.push(playbackDeliveryLabel());
      }
      if (item && item.partial) meta.push('部分备份');
      const nowMeta = document.getElementById('playbackNowMeta');
      nowMeta.replaceChildren(document.createTextNode(meta.join(' · ')));
      const alistUrl = playbackOpenInAlistUrl(part);
      if (alistUrl) {
        nowMeta.appendChild(document.createTextNode(' · '));
        const link = document.createElement('a');
        link.href = alistUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '在网盘中查看 ↗';
        nowMeta.appendChild(link);
      }
      const immersiveAlist = document.getElementById('playbackImmersiveAlistLink');
      if (alistUrl) immersiveAlist.href = alistUrl;
      else immersiveAlist.removeAttribute('href');
      setHidden(immersiveAlist, !alistUrl);
      document.getElementById('playbackImmersiveTitle').textContent = item ? safeText(item.title || item.bvid, '未知视频') : '未选择视频';
      document.getElementById('playbackImmersiveDetail').textContent = meta.join(' · ');
    }

    function updatePlaybackNow() {
      const item = currentPlaybackItem();
      document.getElementById('playbackDialogTitle').textContent = item ? safeText(item.title || item.bvid, '收藏夹播放器') : '收藏夹播放器';
      document.getElementById('playbackNowTitle').textContent = item ? safeText(item.title || item.bvid, '未知视频') : '未选择视频';
      renderPlaybackMetadata();
      const queuePosition = Number(item && item.queuePosition || 0);
      const position = playbackState.mode !== 'single' && queuePosition
        ? queuePosition + ' / ' + playbackState.total
        : '历史记录';
      const partPosition = item && item.parts && item.parts.length > 1
        ? ' · P' + (playbackState.partIndex + 1) + ' / ' + item.parts.length
        : '';
      document.getElementById('playbackImmersivePosition').textContent = position + partPosition;
      renderPlaybackParts();
      renderPlaybackQueue();
      updatePlaybackNavigation();
    }

    function updateMediaSessionPosition() {
      if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
      const art = playbackState.art;
      if (!art) return;
      const duration = Number(art.duration || 0);
      const position = Number(art.currentTime || 0);
      const rate = Number(art.playbackRate || 1);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: rate > 0 ? rate : 1,
          position: Math.min(duration, Math.max(0, position))
        });
      } catch (_) {}
    }

    function setupMediaSession(item, part) {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      try {
        const cover = playbackCoverUrl(item);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: safeText(item.title || item.bvid, '归档视频') + (item.parts.length > 1 ? ' · ' + part.label : ''),
          artist: safeText(item.upperName, '未知UP'),
          album: 'BFB 收藏夹归档',
          artwork: cover ? [{ src:cover }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => playbackState.art && playbackState.art.play());
        navigator.mediaSession.setActionHandler('pause', () => playbackState.art && playbackState.art.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => stepPlayback(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => stepPlayback(1));
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          if (playbackState.art) playbackState.art.currentTime = Math.max(0, playbackState.art.currentTime - Number(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          if (playbackState.art) playbackState.art.currentTime = Math.min(playbackState.art.duration || Infinity, playbackState.art.currentTime + Number(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
          if (playbackState.art && Number.isFinite(Number(details.seekTime))) playbackState.art.currentTime = Number(details.seekTime);
        });
      } catch (_) {}
    }

    function createPlaybackAttemptId() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }

    function playbackStreamUrl(part, forceProxy, attemptId) {
      const params = new URLSearchParams();
      if (forceProxy) params.set('delivery', 'proxy');
      if (attemptId) params.set('attempt', attemptId);
      const query = params.toString();
      return part.streamUrl + (query ? (part.streamUrl.includes('?') ? '&' : '?') + query : '');
    }

    async function pollPlaybackDelivery(attemptId, token) {
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      const controller = new AbortController();
      playbackState.deliveryController = controller;
      const delays = [250, 500, 1000, 2000, 2000, 2000, 2000];
      try {
        for (const delay of delays) {
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, delay);
            controller.signal.addEventListener('abort', onAbort, { once:true });
          });
          if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
          const data = await fetchJson(playbackSourceApiPath('/playback/delivery/' + attemptId), { signal:controller.signal });
          if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            data.status || 'pending',
            false
          );
          renderPlaybackMetadata();
          if (data.status && data.status !== 'pending') return;
        }
        if (token === playbackState.loadingToken && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } catch (error) {
        if ((!error || error.name !== 'AbortError') && token === playbackState.loadingToken
          && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } finally {
        if (playbackState.deliveryController === controller) playbackState.deliveryController = null;
      }
    }

    function browserSupportsHevc(video) {
      if (!video || typeof video.canPlayType !== 'function') return false;
      try {
        return Boolean(video.canPlayType('video/mp4; codecs="hvc1"')
          || video.canPlayType('video/mp4; codecs="hev1"'));
      } catch (_) {
        return false;
      }
    }

    async function finalizePlaybackDelivery(attemptId, token) {
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      const controller = new AbortController();
      playbackState.deliveryController = controller;
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
        playbackState.deliveryStatus,
        'unknown',
        true
      );
      renderPlaybackMetadata();
      try {
        const data = await fetchJson(playbackSourceApiPath('/playback/delivery/' + attemptId), { signal:controller.signal });
        if (token !== playbackState.loadingToken || attemptId !== playbackState.deliveryAttemptId) return;
        playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
          playbackState.deliveryStatus,
          data.status || 'pending',
          true
        );
        renderPlaybackMetadata();
      } catch (error) {
        if ((!error || error.name !== 'AbortError') && token === playbackState.loadingToken
          && attemptId === playbackState.deliveryAttemptId) {
          playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
            playbackState.deliveryStatus,
            'unknown',
            true
          );
          renderPlaybackMetadata();
        }
      } finally {
        if (playbackState.deliveryController === controller) playbackState.deliveryController = null;
      }
    }

    function showFinalPlaybackError(title, detail, attemptId, token) {
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(
        playbackState.deliveryStatus,
        'unknown',
        true
      );
      renderPlaybackMetadata();
      setPlaybackMessage(title, detail, { retry:true, skip:true });
      void finalizePlaybackDelivery(attemptId, token);
    }

    async function reportPlaybackMediaMetadata(part, art, token, retryAttempt = 0) {
      if (!part || part.actualWidth || part.actualHeight || playbackState.metadataReported.has(part.fingerprint)
        || playbackState.metadataReporting.has(part.fingerprint) || playbackState.metadataRetryTimers.has(part.fingerprint)) return;
      const width = Number(art.video && art.video.videoWidth || 0);
      const height = Number(art.video && art.video.videoHeight || 0);
      const duration = Number(art.duration || 0);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16
        || !Number.isFinite(duration) || duration <= 0) return;
      playbackState.metadataReporting.add(part.fingerprint);
      const controller = new AbortController();
      playbackState.metadataControllers.set(part.fingerprint, controller);
      try {
        const data = await fetchJsonSilent(playbackFileApiPath(part, '/media-metadata'), {
          method:'PUT',
          headers:{ 'Content-Type':'application/json' },
          body:JSON.stringify({ fingerprint:part.fingerprint, width, height, duration }),
          signal:controller.signal
        });
        if (token !== playbackState.loadingToken || currentPlaybackPart() !== part) return;
        const metadata = data.mediaMetadata || { width, height, duration, source:'browser' };
        part.actualWidth = Number(metadata.width || width);
        part.actualHeight = Number(metadata.height || height);
        part.actualQuality = String(data.actualQuality || '');
        part.quality = part.actualQuality;
        part.mediaMetadataSource = metadata.source || 'browser';
        playbackState.metadataReported.add(part.fingerprint);
        updatePlaybackNow();
      } catch (error) {
        if ((!error || error.name !== 'AbortError') && retryAttempt < 1
          && token === playbackState.loadingToken && currentPlaybackPart() === part) {
          const timer = setTimeout(() => {
            playbackState.metadataRetryTimers.delete(part.fingerprint);
            if (token === playbackState.loadingToken && currentPlaybackPart() === part) {
              void reportPlaybackMediaMetadata(part, art, token, retryAttempt + 1);
            }
          }, 3000);
          playbackState.metadataRetryTimers.set(part.fingerprint, timer);
        }
      } finally {
        if (playbackState.metadataControllers.get(part.fingerprint) === controller) {
          playbackState.metadataControllers.delete(part.fingerprint);
          playbackState.metadataReporting.delete(part.fingerprint);
        }
      }
    }

    async function playCurrentSelection(autoplay, options = {}) {
      const item = currentPlaybackItem();
      const part = currentPlaybackPart();
      if (!item || !part) {
        setPlaybackMessage('没有可播放文件', '该条目的远端文件状态可能已经变化。', { retry:false, skip:true });
        return;
      }
      const forceProxy = playbackState.deliveryMode === 'proxy' || options.forceProxy === true;
      const resumeTime = Number(options.resumeTime || 0);
      const attemptId = options.attemptId || createPlaybackAttemptId();
      const token = ++playbackState.loadingToken;
      playbackState.metadataControllers.forEach((controller) => controller.abort());
      playbackState.metadataControllers.clear();
      playbackState.metadataReporting.clear();
      playbackState.metadataRetryTimers.forEach((timer) => clearTimeout(timer));
      playbackState.metadataRetryTimers.clear();
      if (playbackState.deliveryController) playbackState.deliveryController.abort();
      playbackState.deliveryController = null;
      const previousDeliveryStatus = attemptId === playbackState.deliveryAttemptId
        ? playbackState.deliveryStatus
        : 'pending';
      playbackState.deliveryAttemptId = attemptId;
      playbackState.deliveryStatus = resolvePlaybackDeliveryViewStatus(previousDeliveryStatus, 'pending', false);
      destroyCurrentArt();
      updatePlaybackNow();
      void pollPlaybackDelivery(attemptId, token);
      setPlaybackMessage(
        '正在连接归档文件',
        forceProxy ? '正在通过 BFB 代理连接归档文件。' : '正在获取网盘直连，必要时将自动使用 BFB 代理。',
        { retry:false, skip:false }
      );
      try {
        const Artplayer = await loadArtplayer();
        if (token !== playbackState.loadingToken) return;
        const prefs = playbackState.preferences || loadPlaybackPreferences();
        const art = new Artplayer({
          container: document.getElementById('playbackArt'),
          url: playbackStreamUrl(part, forceProxy, attemptId),
          title: safeText(item.title || item.bvid, '归档视频'),
          poster: playbackCoverUrl(item),
          theme: '#39C5BB',
          volume: prefs.volume,
          muted: prefs.muted,
          autoplay: Boolean(autoplay),
          playbackRate: true,
          aspectRatio: true,
          setting: true,
          pip: true,
          fullscreen: true,
          fullscreenWeb: true,
          playsInline: true,
          autoOrientation: true,
          hotkey: true,
          mutex: true,
          moreVideoAttr: { preload:'metadata', playsinline:'', 'webkit-playsinline':'', referrerpolicy:'no-referrer' }
        });
        playbackState.art = art;
        art.playbackRate = prefs.rate;
        let fallbackStarted = false;
        art.on('video:loadedmetadata', () => {
          if (token !== playbackState.loadingToken) return;
          const isPortrait = Number(art.video.videoHeight || 0) > Number(art.video.videoWidth || 0);
          document.getElementById('playbackStage').classList.toggle('is-portrait', isPortrait);
          const saved = prefs.progress && prefs.progress[part.fingerprint];
          const savedTime = Number(saved && saved.time || 0);
          const duration = Number(art.duration || 0);
          if (resumeTime > 0 && duration - resumeTime > 1) art.currentTime = resumeTime;
          else if (savedTime >= 10 && duration - savedTime >= 15) art.currentTime = savedTime;
          hidePlaybackMessage();
          updateMediaSessionPosition();
          void reportPlaybackMediaMetadata(part, art, token);
        });
        art.on('video:canplay', hidePlaybackMessage);
        art.on('video:pause', savePlaybackProgress);
        art.on('video:volumechange', () => {
          prefs.volume = Number(art.volume || 0);
          prefs.muted = Boolean(art.muted);
          persistPlaybackPreferences();
        });
        art.on('video:ratechange', () => {
          prefs.rate = Number(art.playbackRate || 1);
          persistPlaybackPreferences();
          updateMediaSessionPosition();
        });
        art.on('video:play', () => {
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; } catch (_) {}
        });
        art.on('video:pause', () => {
          try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; } catch (_) {}
        });
        art.on('video:ended', () => {
          if (prefs.progress) delete prefs.progress[part.fingerprint];
          persistPlaybackPreferences();
          if (playbackState.continuous) stepPlayback(1, true);
        });
        art.on('video:error', () => {
          if (token !== playbackState.loadingToken) return;
          const mediaErrorCode = Number(art.video && art.video.error && art.video.error.code || 0);
          const action = decidePlaybackMediaError({
            mediaErrorCode,
            forceProxy,
            fallbackStarted,
            actualCodec:part.codec,
            requestedCodec:part.requestedCodec,
            browserSupportsHevc:browserSupportsHevc(art.video)
          });
          if (action === 'ignore') return;
          if (action === 'proxy') {
            fallbackStarted = true;
            const failedAt = Number(art.currentTime || 0);
            setPlaybackMessage('网盘直连暂时不可用', '正在切换为 BFB 代理播放。', { retry:false, skip:false });
            setTimeout(() => {
              if (token !== playbackState.loadingToken) return;
              void playCurrentSelection(true, { forceProxy:true, resumeTime:failedAt, attemptId });
            }, 0);
            return;
          }
          if (action === 'hevc') {
            const actualHevc = /hevc|h\.265|h265|hev1|hvc1/i.test(String(part.codec || ''));
            showFinalPlaybackError(
              actualHevc ? '当前浏览器无法解码HEVC' : '此旧归档可能使用HEVC',
              actualHevc
                ? '请使用支持HEVC的Edge、Safari、系统浏览器或远端存储客户端。本项目不会转码视频。'
                : '该文件的下载目标为HEVC，但旧记录尚无实际编码。当前浏览器未报告HEVC支持，切换代理也不会改变编码。',
              attemptId,
              token
            );
            return;
          }
          if (action === 'decode') {
            showFinalPlaybackError(
              '归档视频解码失败',
              '当前浏览器无法解码该媒体，或文件使用了尚未识别的编码。BFB代理不会转码视频。',
              attemptId,
              token
            );
            return;
          }
          showFinalPlaybackError(
            forceProxy ? '归档视频传输失败' : '归档视频无法直接播放',
            forceProxy
              ? '网盘直连和BFB代理均未能提供浏览器可播放的媒体数据。'
              : '文件可能暂时不可见、会话已过期，或当前浏览器不支持此媒体来源。',
            attemptId,
            token
          );
        });
        setupMediaSession(item, part);
      } catch (error) {
        if (token !== playbackState.loadingToken) return;
        setPlaybackMessage('播放器初始化失败', error instanceof Error ? error.message : String(error), { retry:true, skip:true });
      }
    }

    function playbackLibraryContextParams() {
      const context = playbackState.libraryContext || {};
      const params = new URLSearchParams({
        scope:String(context.scope || 'global'),
        q:String(context.query || ''),
        searchScope:String(context.searchScope || 'current'),
        filter:String(context.filter || 'all'),
        sort:String(context.sort || 'context')
      });
      if (context.userId) params.set('userId', String(context.userId));
      if (context.mediaId) params.set('mediaId', String(context.mediaId));
      return params;
    }

    function playbackQueueApiPath(suffix) {
      if (playbackState.mode === 'library') {
        const separator = suffix.indexOf('?');
        const pathname = separator >= 0 ? suffix.slice(0, separator) : suffix;
        const suffixParams = new URLSearchParams(separator >= 0 ? suffix.slice(separator + 1) : '');
        const params = playbackLibraryContextParams();
        suffixParams.forEach((value, key) => params.set(key, value));
        const query = params.toString();
        return '/api/archive-library' + pathname + (query ? '?' + query : '');
      }
      return '/api/users/' + encodeURIComponent(playbackState.userId) +
        '/favorites/' + playbackState.mediaId + suffix;
    }

    function playbackFileApiPath(part, suffix) {
      if (!part) return '';
      return playbackSourceApiPath('/playback/files/' + Number(part.fileId) + suffix);
    }

    function playbackSourceApiPath(suffix) {
      const item = currentPlaybackItem();
      const source = item && item.source;
      const userId = source?.userId || playbackState.userId;
      const mediaId = Number(source?.mediaId || playbackState.mediaId || 0);
      if (!userId || !mediaId) return '';
      return '/api/users/' + encodeURIComponent(userId) + '/favorites/' + mediaId + suffix;
    }

    async function loadPlaybackQueuePage(page, options = {}) {
      const normalizedPage = Math.max(1, Number(page || 1));
      if (playbackState.pages.has(normalizedPage) && !options.reset) return playbackState.pages.get(normalizedPage);
      if (playbackState.queueLoading) {
        const pending = playbackState.queuePromise;
        if (!pending) return null;
        await pending.catch(() => undefined);
        if (playbackState.pages.has(normalizedPage) && !options.reset) return playbackState.pages.get(normalizedPage);
        if (playbackState.queueLoading) return null;
        return loadPlaybackQueuePage(normalizedPage, options);
      }
      playbackState.queueLoading = true;
      playbackState.queueLoadingDirection = options.direction || 'append';
      playbackState.queueError = null;
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      updatePlaybackQueueFeedback();
      const operation = (async () => {
        try {
          const params = new URLSearchParams({ page:String(normalizedPage), pageSize:String(playbackState.pageSize) });
          if (playbackState.mode === 'library' && !options.reset) {
            const bounds = playbackPageBounds();
            if (normalizedPage === bounds.first - 1) {
              const boundary = playbackPageCursor(bounds.first);
              if (boundary?.previousCursor) {
                params.set('cursor', boundary.previousCursor);
                params.set('direction', 'before');
              }
            } else if (normalizedPage === bounds.last + 1) {
              const boundary = playbackPageCursor(bounds.last);
              if (boundary?.nextCursor) {
                params.set('cursor', boundary.nextCursor);
                params.set('direction', 'after');
              }
            }
          }
          const data = await fetchJson(
            playbackQueueApiPath('/playback-queue?' + params.toString()),
            { signal:controller.signal }
          );
          if (token !== playbackState.queueToken) return null;
          applyPlaybackQueuePage(data, {
            page: normalizedPage,
            direction: options.direction || 'append',
            reset: Boolean(options.reset),
            selectedBvid: options.selectedBvid
          });
          return data;
        } catch (error) {
          if (error && error.name === 'AbortError') return null;
          if (token === playbackState.queueToken) {
            playbackState.queueError = {
              page: normalizedPage,
              direction: options.direction || 'append',
              message: error instanceof Error ? error.message : String(error)
            };
            updatePlaybackQueueFeedback();
          }
          throw error;
        } finally {
          if (token === playbackState.queueToken) {
            playbackState.queueLoading = false;
            playbackState.queueLoadingDirection = null;
            playbackState.queueController = null;
            updatePlaybackQueueFeedback();
            setupPlaybackQueueObserver();
          }
        }
      })();
      playbackState.queuePromise = operation;
      try {
        return await operation;
      } finally {
        if (playbackState.queuePromise === operation) playbackState.queuePromise = null;
      }
    }

    async function selectPlaybackQueuePosition(queuePosition, partIndex, autoplay) {
      const position = Math.max(1, Number(queuePosition || 1));
      let index = playbackState.items.findIndex((item) => Number(item.queuePosition) === position);
      if (index < 0) {
        const currentPosition = Number(currentPlaybackItem()?.queuePosition || 0);
        const page = Math.floor((position - 1) / playbackState.pageSize) + 1;
        await loadPlaybackQueuePage(page, { direction:position < currentPosition ? 'prepend' : 'append' });
        index = playbackState.items.findIndex((item) => Number(item.queuePosition) === position);
      }
      if (index < 0) throw new Error('播放队列已变化，请重新打开播放器');
      playbackState.itemIndex = index;
      const item = currentPlaybackItem();
      playbackState.page = Math.floor((position - 1) / playbackState.pageSize) + 1;
      playbackState.partIndex = item ? Math.min(Math.max(0, Number(partIndex || 0)), item.parts.length - 1) : 0;
      await playCurrentSelection(autoplay);
    }

    function clearPlaybackSearch(options = {}) {
      const search = playbackState.search;
      search.token += 1;
      if (search.timer) clearTimeout(search.timer);
      if (search.controller) search.controller.abort();
      search.timer = null;
      search.controller = null;
      search.query = '';
      search.shownQuery = '';
      search.page = 0;
      search.total = 0;
      search.hasMore = false;
      search.items = [];
      search.nodes.clear();
      search.loading = false;
      search.error = null;
      const input = document.getElementById('playbackSearchInput');
      if (input) input.value = '';
      updatePlaybackSearchHeader();
      if (options.render !== false) renderPlaybackQueue(true);
    }

    function appendPlaybackSearchItems(items) {
      const host = document.getElementById('playbackQueueList');
      if (host.dataset.queueView !== 'search') return;
      const bottom = host.querySelector('[data-playback-boundary="bottom"]');
      if (!bottom) return;
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        let node = playbackState.search.nodes.get(item.bvid);
        if (!node) {
          node = createPlaybackQueueNode(item, 'search');
          playbackState.search.nodes.set(item.bvid, node);
        }
        if (!node.isConnected) fragment.appendChild(node);
      }
      host.insertBefore(fragment, bottom);
    }

    async function runPlaybackSearch(query, page = 1, append = false) {
      const normalizedQuery = String(query || '').trim().slice(0, 80);
      if (!normalizedQuery || playbackState.mode === 'single') {
        clearPlaybackSearch();
        return;
      }
      const search = playbackState.search;
      if (search.controller) search.controller.abort();
      const controller = new AbortController();
      search.controller = controller;
      const token = ++search.token;
      search.loading = true;
      search.error = null;
      updatePlaybackSearchHeader();
      updatePlaybackQueueFeedback();
      try {
        const data = await fetchJson(
          playbackQueueApiPath('/playback-search?' + (playbackState.mode === 'library' ? 'queueQ=' : 'q=') +
            encodeURIComponent(normalizedQuery) + '&page=' + page + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        );
        if (token !== search.token || search.query !== normalizedQuery) return;
        const incoming = Array.isArray(data.items) ? data.items : [];
        const canAppend = append && search.shownQuery === normalizedQuery;
        if (canAppend) {
          const known = new Set(search.items.map((item) => item.bvid));
          const fresh = incoming.filter((item) => !known.has(item.bvid));
          search.items.push(...fresh);
          appendPlaybackSearchItems(fresh);
        } else {
          search.items = incoming;
          search.nodes.clear();
        }
        search.shownQuery = normalizedQuery;
        search.page = Number(data.page || page);
        search.total = Number(data.total || 0);
        search.hasMore = Boolean(data.hasMore);
        search.error = null;
        if (canAppend) {
          updatePlaybackQueueFeedback();
          setupPlaybackQueueObserver();
          syncPlaybackQueueSelection({ alignDesktop:false });
        } else {
          renderPlaybackQueue(true);
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (token === search.token) {
          search.error = { page, message:error instanceof Error ? error.message : String(error) };
          updatePlaybackSearchHeader();
          updatePlaybackQueueFeedback();
        }
      } finally {
        if (token === search.token) {
          search.loading = false;
          search.controller = null;
          updatePlaybackSearchHeader();
          updatePlaybackQueueFeedback();
          if (isPlaybackSearchView()) setupPlaybackQueueObserver();
        }
      }
    }

    function schedulePlaybackSearch() {
      const search = playbackState.search;
      const input = document.getElementById('playbackSearchInput');
      const query = String(input.value || '').trim();
      search.query = query;
      if (search.timer) clearTimeout(search.timer);
      if (search.controller) search.controller.abort();
      search.token += 1;
      search.timer = null;
      search.controller = null;
      if (!query) {
        clearPlaybackSearch();
        return;
      }
      search.loading = true;
      search.error = null;
      updatePlaybackSearchHeader();
      search.timer = setTimeout(() => {
        search.timer = null;
        runPlaybackSearch(query, 1, false);
      }, 300);
    }

    async function selectPlaybackSearchResult(item, trigger) {
      if (!item || !item.bvid) return;
      if (playbackState.queueLoading) {
        const pending = playbackState.queuePromise;
        if (pending) await pending.catch(() => undefined);
        if (playbackState.queueLoading) return;
      }
      const previousBvid = currentPlaybackItem()?.bvid;
      const previousPart = playbackState.partIndex;
      playbackState.queueLoading = true;
      playbackState.search.loading = true;
      updatePlaybackSearchHeader();
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(item.bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        );
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:item.bvid, render:false });
        playbackState.partIndex = previousBvid === item.bvid
          ? Math.min(previousPart, Math.max(0, (currentPlaybackItem()?.parts.length || 1) - 1))
          : 0;
        clearPlaybackSearch({ render:false });
        renderPlaybackQueue(true);
        if (document.activeElement === trigger) {
          const normalNode = playbackState.queueNodes.get(item.bvid);
          if (normalNode) normalNode.focus({ preventScroll:true });
        }
        if (previousBvid === item.bvid) updatePlaybackNow();
        else await playCurrentSelection(true);
        setPlaybackQueueDrawer(false);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        playbackState.search.error = { page:1, message:error instanceof Error ? error.message : String(error) };
        updatePlaybackSearchHeader();
        updatePlaybackQueueFeedback();
      } finally {
        if (token === playbackState.queueToken) {
          playbackState.queueLoading = false;
          playbackState.search.loading = false;
          playbackState.queueController = null;
          updatePlaybackSearchHeader();
        }
      }
    }

    async function stepPlayback(direction, fromEnded = false) {
      const item = currentPlaybackItem();
      if (!item) return;
      try {
        savePlaybackProgress();
        if (direction > 0) {
          if (playbackState.partIndex + 1 < item.parts.length) {
            playbackState.partIndex += 1;
            await playCurrentSelection(true);
            return;
          }
          const nextPosition = Number(item.queuePosition || 0) + 1;
          if (playbackState.mode !== 'single' && nextPosition <= playbackState.total) {
            await selectPlaybackQueuePosition(nextPosition, 0, true);
            return;
          }
          if (fromEnded) setPlaybackMessage('已播放到收藏夹末尾', '你可以选择队列中的视频重新播放。', { retry:false, skip:false });
          return;
        }
        if (playbackState.partIndex > 0) {
          playbackState.partIndex -= 1;
          await playCurrentSelection(true);
          return;
        }
        const previousPosition = Number(item.queuePosition || 0) - 1;
        if (playbackState.mode !== 'single' && previousPosition >= 1) {
          await selectPlaybackQueuePosition(previousPosition, Number.MAX_SAFE_INTEGER, true);
        }
      } catch (error) {
        setPlaybackMessage('无法读取下一页队列', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      }
    }

    function skipCurrentPlaybackVideo() {
      const item = currentPlaybackItem();
      if (!item) return;
      savePlaybackProgress();
      const nextPosition = Number(item.queuePosition || 0) + 1;
      if (playbackState.mode !== 'single' && nextPosition <= playbackState.total) {
        selectPlaybackQueuePosition(nextPosition, 0, true).catch((error) => {
          setPlaybackMessage('无法读取下一页队列', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
        });
        return;
      }
      setPlaybackMessage('已到收藏夹末尾', '当前没有下一条可播放归档。', { retry:false, skip:false });
    }

    async function refreshLibraryPlaybackSelection(autoplay = true) {
      const current = currentPlaybackItem();
      const bvid = current?.bvid || playbackState.focusBvid;
      if (playbackState.mode !== 'library' || !bvid) throw new Error('归档库播放上下文已经失效');
      const previousFingerprint = currentPlaybackPart()?.fingerprint;
      if (playbackState.queueController) playbackState.queueController.abort();
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      playbackState.queueLoading = true;
      playbackState.queueLoadingDirection = null;
      playbackState.queueError = null;
      playbackState.queuePromise = null;
      try {
        const data = await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        );
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        const selected = currentPlaybackItem();
        const previousPartIndex = selected?.parts.findIndex((part) => part.fingerprint === previousFingerprint) ?? -1;
        playbackState.partIndex = previousPartIndex >= 0 ? previousPartIndex : 0;
        renderPlaybackQueue(true);
        await playCurrentSelection(autoplay);
      } finally {
        if (token === playbackState.queueToken) {
          playbackState.queueLoading = false;
          playbackState.queueLoadingDirection = null;
          if (playbackState.queueController === controller) playbackState.queueController = null;
          updatePlaybackQueueFeedback();
        }
      }
    }

    async function retryCurrentPlayback() {
      try {
        if (playbackState.mode === 'library') {
          await refreshLibraryPlaybackSelection(true);
          return;
        }
        if (currentPlaybackPart()) {
          await playCurrentSelection(true);
          return;
        }
        if (playbackState.focusBvid) await openArchivePlayback(playbackState.focusBvid, playbackState.trigger);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        setPlaybackMessage('无法重新读取播放来源', error instanceof Error ? error.message : String(error), { retry:true, skip:true });
      }
    }

    async function openArchiveLibraryPlayback(bvid, trigger) {
      if (!bvid) return;
      const libraryContext = archiveLibraryContextSnapshot();
      destroyPlaybackSession();
      playbackState.mode = 'library';
      playbackState.libraryContext = libraryContext;
      playbackState.pageSize = 50;
      playbackState.preferences = loadPlaybackPreferences();
      playbackState.continuous = playbackState.preferences.continuous;
      playbackState.trigger = trigger || null;
      playbackState.focusBvid = bvid;
      openModal('playbackModal', trigger);
      setPlaybackQueueDrawer(false);
      if (syncPlaybackImmersiveMode()) {
        setTimeout(() => document.getElementById('closePlaybackImmersiveBtn').focus({ preventScroll:true }), 0);
      }
      document.getElementById('playbackQueueHeading').textContent = '归档库顺序';
      setPlaybackMessage('正在准备归档库队列', '将按照当前目录、筛选、搜索和排序读取本地可播放归档。', { retry:false, skip:false });
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = await fetchJson(
          playbackQueueApiPath('/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize),
          { signal:controller.signal }
        );
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        playbackState.partIndex = 0;
        playbackState.progressTimer = setInterval(savePlaybackProgress, 5000);
        await playCurrentSelection(true);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (token !== playbackState.queueToken) return;
        setPlaybackMessage('无法打开归档库播放器', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      } finally {
        if (token === playbackState.queueToken) playbackState.queueController = null;
      }
    }

    async function openArchivePlayback(bvid, trigger) {
      if (!videoDetailState.userId || !videoDetailState.mediaId || !bvid) return;
      destroyPlaybackSession();
      playbackState.mode = 'favorite';
      playbackState.libraryContext = null;
      playbackState.userId = videoDetailState.userId;
      playbackState.mediaId = videoDetailState.mediaId;
      playbackState.pageSize = 50;
      playbackState.preferences = loadPlaybackPreferences();
      playbackState.continuous = playbackState.preferences.continuous;
      playbackState.trigger = trigger || null;
      playbackState.focusBvid = bvid;
      openModal('playbackModal', trigger);
      setPlaybackQueueDrawer(false);
      if (syncPlaybackImmersiveMode()) {
        setTimeout(() => document.getElementById('closePlaybackImmersiveBtn').focus({ preventScroll:true }), 0);
      }
      setPlaybackMessage('正在准备播放队列', '只会列出当前收藏夹中已通过远端确认的归档视频。', { retry:false, skip:false });
      const controller = new AbortController();
      playbackState.queueController = controller;
      const token = ++playbackState.queueToken;
      try {
        const data = await fetchJson(
          '/api/users/' + encodeURIComponent(playbackState.userId) +
          '/favorites/' + playbackState.mediaId +
          '/playback-queue?focusBvid=' + encodeURIComponent(bvid) + '&pageSize=' + playbackState.pageSize,
          { signal:controller.signal }
        );
        if (token !== playbackState.queueToken) return;
        applyPlaybackQueuePage(data, { reset:true, selectedBvid:bvid, render:false });
        const foundIndex = playbackState.items.findIndex((item) => item.bvid === bvid);
        playbackState.itemIndex = foundIndex >= 0 ? foundIndex : 0;
        playbackState.partIndex = 0;
        playbackState.progressTimer = setInterval(savePlaybackProgress, 5000);
        await playCurrentSelection(true);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        if (token !== playbackState.queueToken) return;
        setPlaybackMessage('无法打开归档播放器', error instanceof Error ? error.message : String(error), { retry:true, skip:false });
      } finally {
        if (token === playbackState.queueToken) playbackState.queueController = null;
      }
    }

    // ---- Unavailable Videos Modal ----
    async function openUnavailable(userId) {
      if (unavailableThrottleTimer) {
        clearTimeout(unavailableThrottleTimer);
        unavailableThrottleTimer = null;
      }
      unavailableUserId = userId;
      unavailableFilter = 'missing';
      if (unavailableController) unavailableController.abort();
      unavailableController = null;
      unavailableToken += 1;
      Object.values(unavailableStates).forEach((state) => {
        state.items = [];
        state.keys = new Set();
        state.nodes = new Map();
        state.cursor = null;
        state.hasMore = true;
        state.loading = false;
        state.error = null;
      });
      document.getElementById('filterMissingBtn').classList.add('active');
      document.getElementById('filterUploadedBtn').classList.remove('active');
      const grid = document.getElementById('unavailableGrid');
      grid.innerHTML = '';
      openModal('unavailableModal');
      await loadMoreUnavailable();
    }

    async function loadMoreUnavailable(options = {}) {
      const filter = unavailableFilter;
      const state = unavailableStates[filter];
      if (!state || state.loading || !state.hasMore || !unavailableUserId || (state.error && !options.retry)) return;
      if (unavailableController) unavailableController.abort();
      const controller = new AbortController();
      unavailableController = controller;
      const token = ++unavailableToken;
      state.loading = true;
      state.error = null;
      renderUnavailableStatus(state.items.length ? '加载更多...' : '加载中...');
      try {
        const url = '/api/users/' + encodeURIComponent(unavailableUserId) + '/unavailable?pageSize=20&filter=' + filter +
          (state.cursor ? '&cursor=' + encodeURIComponent(state.cursor) : '');
        const data = await fetchJson(url, { signal:controller.signal });
        if (token !== unavailableToken || filter !== unavailableFilter) return;
        const added = [];
        for (const item of data.items || []) {
          const key = String(item.mediaId || 0) + ':' + String(item.bvid || '');
          if (!item.bvid || state.keys.has(key)) continue;
          state.keys.add(key);
          state.items.push(item);
          const node = renderUnavailableItem(item);
          state.nodes.set(key, node);
          added.push(node);
        }
        state.cursor = data.nextCursor || null;
        state.hasMore = Boolean(data.hasMore);
        if (added.length) {
          const grid = document.getElementById('unavailableGrid');
          const status = grid.querySelector('[data-status-marker="unavailable"]');
          added.forEach((node) => grid.insertBefore(node, status));
        }
        renderUnavailableStatus('');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (token !== unavailableToken || filter !== unavailableFilter) return;
        state.error = e instanceof Error ? e.message : String(e);
        renderUnavailableStatus('加载失败: ' + state.error, true);
      } finally {
        if (token === unavailableToken) state.loading = false;
        if (token === unavailableToken) unavailableController = null;
        if (token === unavailableToken && filter === unavailableFilter && !state.error) renderUnavailableStatus('');
      }
    }

    function setUnavailableFilter(filter) {
      if (!unavailableStates[filter] || filter === unavailableFilter) return;
      if (unavailableController) unavailableController.abort();
      unavailableController = null;
      unavailableToken += 1;
      unavailableStates[unavailableFilter].loading = false;
      unavailableFilter = filter;
      document.getElementById('filterMissingBtn').classList.toggle('active', filter === 'missing');
      document.getElementById('filterUploadedBtn').classList.toggle('active', filter === 'uploaded');
      renderUnavailableList();
      const state = unavailableStates[filter];
      if (state.items.length === 0 && state.hasMore) void loadMoreUnavailable();
    }

    function renderUnavailableItem(item) {
      const div = renderVideoDetailItem(item);
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.textContent = '收藏夹: ' + safeText(item.folderTitle, '未知');
      const info = div.querySelector('.video-info');
      if (info) info.appendChild(meta);
      return div;
    }

    function renderUnavailableList() {
      const grid = document.getElementById('unavailableGrid');
      const state = unavailableStates[unavailableFilter];
      grid.replaceChildren(...state.nodes.values());
      renderUnavailableStatus(state.error ? '加载失败: ' + state.error : '', Boolean(state.error));
    }

    function renderUnavailableStatus(text, isError) {
      const state = unavailableStates[unavailableFilter];
      const grid = document.getElementById('unavailableGrid');
      const old = grid.querySelector('[data-status-marker="unavailable"]');
      if (old) old.remove();
      let message = text;
      if (!message && !state.loading) {
        if (state.items.length === 0 && !state.hasMore) message = '暂无符合条件的视频';
        else if (!state.hasMore) message = '已加载全部';
      }
      if (!message) return;
      const status = document.createElement('div');
      status.dataset.statusMarker = 'unavailable';
      status.className = (/加载|正在/.test(message) ? 'empty-state loading-state' : 'empty-state') +
        (isError ? ' video-detail-status error' : ' video-detail-status');
      status.appendChild(document.createTextNode(message));
      if (isError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry-button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => loadMoreUnavailable({ retry:true }));
        status.appendChild(retry);
      }
      grid.appendChild(status);
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

    function recoveryIssueCounts(items) {
      const list = Array.isArray(items) ? items : [];
      const actionRequired = list.filter((item) => (item.disposition || 'action_required') === 'action_required');
      const intentional = list.filter((item) => item.disposition === 'intentional_confirmation');
      return {
        total:actionRequired.length,
        danger:actionRequired.filter((item) => item.severity === 'danger').length,
        warning:actionRequired.filter((item) => item.severity === 'warning').length,
        info:actionRequired.filter((item) => item.severity === 'info').length,
        actionRequired:actionRequired.length,
        intentional:intentional.length,
      };
    }

    function updateRecoveryIssuesEntry(summary) {
      const button = document.getElementById('recoveryIssuesBtn');
      if (!button) return;
      const total = Number(summary?.total || 0);
      const danger = Number(summary?.danger || 0);
      const intentional = Number(summary?.intentional || 0);
      button.textContent = '待处理 ' + total + (intentional > 0 ? ' · 待确认 ' + intentional : '');
      button.classList.toggle('has-issues', total > 0);
      button.classList.toggle('has-danger', danger > 0);
      button.setAttribute('aria-label', total > 0 || intentional > 0
        ? '打开恢复中心，待处理 ' + total + ' 项，待确认 ' + intentional + ' 项'
        : '打开恢复中心，当前没有需要处理或确认的项目');
    }

    function renderRecoveryIssueStatus() {
      const shell = document.querySelector('.recovery-issues-shell');
      const layout = document.querySelector('.recovery-issues-layout');
      const listPane = document.querySelector('.recovery-issues-list-pane');
      const detail = document.getElementById('recoveryIssuesDetail');
      const status = document.getElementById('recoveryIssuesStatus');
      const message = document.getElementById('recoveryIssuesStatusMessage');
      const retry = document.getElementById('recoveryIssuesRetryBtn');
      const emptyState = document.getElementById('recoveryIssuesEmptyState');
      const emptyTitle = document.getElementById('recoveryIssuesEmptyTitle');
      const emptyMessage = document.getElementById('recoveryIssuesEmptyMessage');
      const emptyRetry = document.getElementById('recoveryIssuesEmptyRetryBtn');
      const summaryBadge = document.getElementById('recoveryIssuesSummary');
      const listCount = document.getElementById('recoveryIssuesListCount');
      const hasItems = recoveryIssueState.items.length > 0;
      const hasError = Boolean(recoveryIssueState.error);
      const actionCount = Number(recoveryIssueState.summary?.total || 0);
      const confirmationCount = Number(recoveryIssueState.summary?.intentional || 0);
      if (shell) {
        shell.classList.toggle('is-empty', !hasItems);
        if (!hasItems) shell.classList.remove('show-detail');
      }
      if (layout) layout.classList.toggle('is-empty', !hasItems);
      if (listPane) listPane.hidden = !hasItems;
      if (detail) detail.hidden = !hasItems;
      if (emptyState) {
        emptyState.hidden = hasItems;
        emptyState.classList.toggle('is-error', !hasItems && hasError);
        emptyState.setAttribute('role', hasError ? 'alert' : 'status');
      }
      const intentionalOnly = !hasItems && Number(recoveryIssueState.summary?.intentional || 0) > 0;
      if (emptyTitle) emptyTitle.textContent = hasError
        ? '待处理问题暂时无法加载'
        : (intentionalOnly ? '当前没有需要立即处理的问题' : '当前没有需要处理的问题');
      if (emptyMessage) emptyMessage.textContent = hasError
        ? '当前没有可用的问题列表，已有数据不会被清除。请重新加载。'
        : (intentionalOnly ? '仍有待确认项目，请打开恢复中心查看。' : '系统会继续在后台自动复核，新的异常会出现在这里。');
      if (emptyRetry) {
        emptyRetry.hidden = !hasError;
        emptyRetry.disabled = recoveryIssueRequestInFlight;
      }
      if (summaryBadge) {
        const summaryParts = [];
        if (actionCount > 0) summaryParts.push('待处理 ' + actionCount);
        if (confirmationCount > 0) summaryParts.push('待确认 ' + confirmationCount);
        summaryBadge.textContent = summaryParts.join(' · ') || '自动复核中';
      }
      if (listCount) listCount.textContent = hasItems ? recoveryIssueState.items.length + ' 项' : '';
      if (!status || !message || !retry) return;
      status.hidden = !hasItems || !hasError;
      message.textContent = recoveryIssueState.error || '';
      retry.disabled = recoveryIssueRequestInFlight;
    }

    function setRecoveryIssueItems(items, summary) {
      recoveryIssueState.error = null;
      recoveryIssueState.items = Array.isArray(items) ? items : [];
      recoveryIssueState.summary = summary || recoveryIssueCounts(recoveryIssueState.items);
      const focused = recoveryIssueState.focusId;
      if (focused && recoveryIssueState.items.some((item) => item.id === focused)) {
        recoveryIssueState.selectedId = focused;
        recoveryIssueState.focusId = null;
      } else if (!recoveryIssueState.items.some((item) => item.id === recoveryIssueState.selectedId)) {
        recoveryIssueState.selectedId = recoveryIssueState.items[0]?.id || null;
      }
      updateRecoveryIssuesEntry(recoveryIssueState.summary);
      if (document.getElementById('recoveryIssuesModal')?.classList.contains('active')) {
        renderRecoveryIssueCenter();
      }
    }

    function recoveryIssueStatusLabel(issue) {
      if (issue?.busy) return '处理中';
      if (issue?.disposition === 'intentional_confirmation') return '待确认';
      if (issue?.severity === 'danger') return '需要处理';
      if (issue?.severity === 'warning') return '建议处理';
      return '待处理';
    }

    function recoveryIssueTypeLabel(issue) {
      const labels = {
        remote_size_limit:'远端单文件超过限制',
        remote_write_rejected:'远端写入结果未确认',
        remote_size_conflict:'远端存在同名冲突',
        partial_remote_state:'多分P状态不一致',
        local_file_missing:'本地补传文件已丢失',
        local_file_changed:'本地补传文件已变化',
        remote_permission:'存储权限被拒绝',
        remote_connection:'存储连接暂时不可用',
        remote_unsupported:'存储不支持当前方法',
        remote_unknown:'存储返回未知错误',
        unknown_same_size:'远端证明还未确认',
        legacy_conflict_interrupted:'旧冲突归档待复核',
        conflict_candidate_ready:'新候选等待选择',
        encoding_retry_failed:'编码替换未完成',
        quality_failed:'画质重调已暂停',
        storage_backend:'存储设置需要检查',
        manual_review:'上传任务需要复核',
      };
      return labels[issue?.kind] || '任务需要复核';
    }

    function recoveryIssueTargetTitle(issue) {
      return issue?.videoTitle || (issue?.bvid ? '视频 ' + issue.bvid : '') || issue?.fileName || '存储后端';
    }

    function recoveryIssueTargetMeta(issue) {
      return [issue?.upperName, issue?.bvid].filter(Boolean).join(' · ') || (issue?.kind === 'storage_backend' ? 'AList / OpenList' : '系统级任务');
    }

    function recoveryIssueMeta(issue) {
      return [issue.bvid, issue.folderTitle, issue.fileName].filter(Boolean).join(' · ') || '系统级问题';
    }

    function renderRecoveryIssueList() {
      const host = document.getElementById('recoveryIssuesList');
      host.innerHTML = '';
      if (recoveryIssueState.items.length === 0) {
        return;
      }
      recoveryIssueState.items.forEach((issue) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'recovery-issue-row ' + (issue.severity || 'info');
        row.dataset.issueId = issue.id;
        row.classList.toggle('active', issue.id === recoveryIssueState.selectedId);
        row.setAttribute('aria-pressed', String(issue.id === recoveryIssueState.selectedId));
        row.setAttribute('aria-label', [recoveryIssueStatusLabel(issue), recoveryIssueTargetTitle(issue), recoveryIssueTypeLabel(issue), recoveryIssueTargetMeta(issue)].join(' · '));
        const marker = document.createElement('span');
        marker.className = 'recovery-issue-marker';
        marker.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'recovery-issue-row-copy';
        const status = document.createElement('span');
        status.className = 'recovery-issue-row-status';
        status.textContent = recoveryIssueStatusLabel(issue);
        const title = document.createElement('span');
        title.className = 'recovery-issue-row-title';
        title.textContent = recoveryIssueTargetTitle(issue);
        const problem = document.createElement('span');
        problem.className = 'recovery-issue-row-problem';
        problem.textContent = recoveryIssueTypeLabel(issue);
        const meta = document.createElement('span');
        meta.className = 'recovery-issue-row-meta';
        meta.textContent = recoveryIssueTargetMeta(issue) + (issue.fileName ? ' · ' + issue.fileName : '');
        text.append(status, title, problem, meta);
        const arrow = document.createElement('span');
        arrow.className = 'recovery-issue-row-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        row.append(marker, text, arrow);
        row.addEventListener('click', () => {
          recoveryIssueState.selectedId = issue.id;
          renderRecoveryIssueCenter();
          document.querySelector('.recovery-issues-shell')?.classList.add('show-detail');
          document.getElementById('recoveryIssuesDetail')?.focus({ preventScroll:true });
        });
        host.appendChild(row);
      });
    }

    function appendRecoveryDetailSection(host, titleText, content) {
      const section = document.createElement('section');
      section.className = 'recovery-detail-section';
      const title = document.createElement('h3');
      title.textContent = titleText;
      section.appendChild(title);
      if (content instanceof Node) section.appendChild(content);
      else {
        const text = document.createElement('p');
        text.textContent = String(content || '');
        section.appendChild(text);
      }
      host.appendChild(section);
    }

    function finishEncodingRetryDialog(result) {
      const pending = encodingRetryDialogState;
      if (!pending) return;
      encodingRetryDialogState = null;
      closeModal('encodingRetryModal', { restoreFocus:true });
      pending.resolve(result);
    }

    function openEncodingRetryDialog(issue, trigger) {
      if (encodingRetryDialogState) return Promise.resolve(null);
      return new Promise((resolve) => {
        const priority = ['AV1', 'HEVC', 'AVC'];
        encodingRetryDialogState = { resolve, issue, trigger, priority, strict:true };
        const copy = document.getElementById('encodingRetryCopy');
        if (copy) copy.textContent = '本次默认优先 AV1，以尽量避开单文件大小限制。原文件会保留到新文件完成远端确认。';
        const status = document.getElementById('encodingRetryStatus');
        if (status) status.textContent = '';
        const strict = document.getElementById('encodingRetryStrict');
        if (strict) strict.checked = true;
        const renderDialogPriority = () => renderEncodingPriorityEditor('encodingRetryPriorityEditor', encodingRetryDialogState?.priority || priority, (next) => {
          if (!encodingRetryDialogState) return;
          encodingRetryDialogState.priority = next;
          renderDialogPriority();
        });
        renderDialogPriority();
        openModal('encodingRetryModal', trigger);
      });
    }

    async function runRecoveryIssueAction(issue, action, trigger) {
      if (!issue || !action) return;
      if (action.id === 'open_settings') {
        closeModal('recoveryIssuesModal');
        const field = document.getElementById('alistUrl');
        field?.scrollIntoView({ behavior:'smooth', block:'center' });
        setTimeout(() => field?.focus({ preventScroll:true }), 260);
        return;
      }
      let actionBody = undefined;
      if (action.id === 'redownload_with_encoding') {
        const selected = await openEncodingRetryDialog(issue, trigger);
        if (!selected) return;
        actionBody = {
          encodingPriority: selected.priority,
          strict: selected.strict,
        };
      }
      if (action.id === 'reupload' || action.id === 'redownload') {
        const reupload = action.id === 'reupload';
        const confirmed = await confirmAction({
          title:reupload ? '确认继续上传' : '确认重新下载',
          message:reupload
            ? '系统会重新检查远端，只为当前任务授权一次上传。'
            : '系统会废弃失效的补传尝试并重新下载这个来源。',
          detail:reupload
            ? '发现同名异大小文件时仍会停止，不会直接覆盖。'
            : '不会删除远端文件；其他已验证来源和归档证明不受影响。',
          confirmText:reupload ? '继续上传' : '重新下载',
          danger:reupload,
          trigger,
        });
        if (!confirmed) return;
      }
      if (action.id === 'keep_existing' || action.id === 'use_candidate') {
        const useCandidate = action.id === 'use_candidate';
        const confirmed = await confirmAction({
          title:useCandidate ? '采用新候选' : '保留现有归档',
          message:useCandidate
            ? '将已验证的新候选设为这个收藏来源的当前可播放归档。'
            : '继续使用SQLite中记录的现有归档证明。',
          detail:useCandidate
            ? '正式旧路径不会移动或删除，候选文件也不会依赖MOVE。'
            : '独立候选目录仍会保留，系统不会自动删除其中的文件。',
          confirmText:useCandidate ? '采用候选' : '保留现有',
          danger:false,
          trigger,
        });
        if (!confirmed) return;
      }
      const buttons = Array.from(document.querySelectorAll('.recovery-issues-detail button'));
      buttons.forEach((button) => { button.disabled = true; });
      try {
        const data = await fetchJson('/api/recovery-issues/' + encodeURIComponent(issue.id) + '/actions/' + encodeURIComponent(action.id), {
          method:'POST',
          ...(actionBody ? { headers:{'Content-Type':'application/json'}, body:JSON.stringify(actionBody) } : {}),
        });
        setRecoveryIssueItems(data?.issues || []);
        document.getElementById('recoveryIssuesLive').textContent = action.label + '已执行，待处理列表已更新。';
        showToast(action.label + '已执行', 'success');
      } catch (error) {
        buttons.forEach((button) => { button.disabled = false; });
        if (error?.name !== 'AbortError') showToast(error?.message || '处理失败', 'error');
      }
    }

    function renderRecoveryIssueDetail() {
      const host = document.getElementById('recoveryIssuesDetail');
      host.innerHTML = '';
      if (recoveryIssueState.items.length === 0) return;
      const issue = recoveryIssueState.items.find((item) => item.id === recoveryIssueState.selectedId);
      if (!issue) {
        const empty = document.createElement('div');
        empty.className = 'recovery-issues-empty';
        empty.textContent = '从左侧选择一项查看详情。';
        host.appendChild(empty);
        return;
      }
      const kicker = document.createElement('div');
      kicker.className = 'recovery-detail-kicker ' + (issue.severity || 'info');
      kicker.textContent = recoveryIssueStatusLabel(issue);
      const heading = document.createElement('h2');
      heading.className = 'recovery-detail-title';
      heading.textContent = recoveryIssueTargetTitle(issue);
      const problem = document.createElement('p');
      problem.className = 'recovery-detail-problem';
      problem.textContent = recoveryIssueTypeLabel(issue);
      const meta = document.createElement('div');
      meta.className = 'recovery-detail-meta';
      meta.textContent = recoveryIssueMeta(issue) + (issue.occurredAt ? ' · ' + formatDateTime(issue.occurredAt) : '');
      host.append(kicker, heading, problem, meta);

      const targetCard = document.createElement('div');
      targetCard.className = 'recovery-target-card';
      const targetFields = [
        ['来源收藏夹', issue.folderTitle || '系统级任务'],
        ['UP主 / BV', recoveryIssueTargetMeta(issue)],
        ['文件', issue.fileName || '未指定'],
      ];
      if (Number.isFinite(Number(issue.expectedSize)) || Number.isFinite(Number(issue.observedSize))) {
        const expected = Number.isFinite(Number(issue.expectedSize)) ? formatBytes(Number(issue.expectedSize)) : '未知';
        const observed = Number.isFinite(Number(issue.observedSize)) ? formatBytes(Number(issue.observedSize)) : '未知';
        targetFields.push(['大小', expected + ' / 远端 ' + observed]);
      }
      targetFields.forEach(([label, value]) => {
        const field = document.createElement('div');
        field.className = 'recovery-target-field';
        const fieldLabel = document.createElement('span');
        fieldLabel.className = 'recovery-target-field-label';
        fieldLabel.textContent = label;
        const fieldValue = document.createElement('strong');
        fieldValue.className = 'recovery-target-field-value';
        fieldValue.textContent = String(value);
        field.append(fieldLabel, fieldValue);
        targetCard.appendChild(field);
      });
      host.appendChild(targetCard);

      const summary = document.createElement('p');
      summary.textContent = issue.summary || '任务已安全暂停。';
      if (issue.severity === 'danger') summary.setAttribute('role', 'alert');
      appendRecoveryDetailSection(host, '发生了什么', summary);

      const protectedList = document.createElement('ul');
      protectedList.className = 'recovery-protected-list';
      (issue.protectedFacts || []).forEach((fact) => {
        const item = document.createElement('li');
        item.textContent = String(fact);
        protectedList.appendChild(item);
      });
      if (issue.busy) {
        const busyNote = document.createElement('p');
        busyNote.className = 'recovery-safety-note';
        busyNote.textContent = '替换下载、上传或远端确认正在进行。原文件仍保留，期间不能重复启动另一种编码。';
        appendRecoveryDetailSection(host, '当前进度', busyNote);
      } else if (issue.recommendedAction) {
        const actions = document.createElement('div');
        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'recovery-primary-action' + (issue.recommendedAction.danger ? ' danger-action' : '');
        primary.textContent = issue.recommendedAction.label;
        primary.title = issue.recommendedAction.description || '';
        primary.addEventListener('click', () => void runRecoveryIssueAction(issue, issue.recommendedAction, primary));
        actions.appendChild(primary);
        const secondaryActions = (issue.availableActions || []).filter((action) => action.id !== issue.recommendedAction.id);
        if (secondaryActions.length > 0) {
          const secondary = document.createElement('div');
          secondary.className = 'recovery-secondary-actions';
          secondaryActions.forEach((action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.title = action.description || '';
            button.addEventListener('click', () => void runRecoveryIssueAction(issue, action, button));
            secondary.appendChild(button);
          });
          actions.appendChild(secondary);
        }
        const description = document.createElement('p');
        description.className = 'muted status-line recovery-action-note';
        description.textContent = issue.recommendedAction.description || '';
        actions.appendChild(description);
        appendRecoveryDetailSection(host, '下一步', actions);
      }

      appendRecoveryDetailSection(host, '系统保护了什么', protectedList);

      const technical = document.createElement('details');
      technical.className = 'recovery-technical';
      const technicalSummary = document.createElement('summary');
      technicalSummary.textContent = '技术详情';
      const grid = document.createElement('div');
      grid.className = 'recovery-technical-grid';
      const technicalRows = [
        ['问题类型', recoveryIssueTypeLabel(issue)],
        ['最近复核', issue.checkedAt ? formatDateTime(issue.checkedAt) : '尚未复核'],
        ['下次自动复核', issue.nextAutomaticCheckAt ? formatDateTime(issue.nextAutomaticCheckAt) : '按需复核'],
        ['文件', issue.fileName || '未指定'],
        ['期望大小', Number.isFinite(Number(issue.expectedSize)) ? formatBytes(Number(issue.expectedSize)) : '未知'],
        ['远端大小', Number.isFinite(Number(issue.observedSize)) ? formatBytes(Number(issue.observedSize)) : '未知'],
      ];
      technicalRows.forEach(([label, value]) => {
        const row = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = label + '：';
        row.append(strong, document.createTextNode(String(value)));
        grid.appendChild(row);
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'recovery-copy-diagnostic';
      copy.textContent = '复制诊断摘要';
      copy.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(issue.safeDiagnostic || '');
        showToast(copied ? '诊断摘要已复制' : '复制失败', copied ? 'success' : 'error');
      });
      technical.append(technicalSummary, grid, copy);
      host.appendChild(technical);
    }

    function renderRecoveryIssueCenter() {
      renderRecoveryIssueStatus();
      renderRecoveryIssueList();
      renderRecoveryIssueDetail();
    }

    async function refreshRecoveryIssues() {
      if (recoveryIssueRequestInFlight) return;
      recoveryIssueRequestInFlight = true;
      if (recoveryIssueState.controller) recoveryIssueState.controller.abort();
      const controller = new AbortController();
      const token = ++recoveryIssueState.token;
      recoveryIssueState.controller = controller;
      try {
        const snapshot = await fetchJsonSilent('/api/queue/state', { signal:controller.signal });
        if (token !== recoveryIssueState.token) return;
        setRecoveryIssueItems(
          snapshot?.issues || [...(snapshot?.actionRequiredIssues || []), ...(snapshot?.intentionalConfirmations || [])],
          snapshot?.issueSummary,
        );
      } catch (error) {
        if (error?.name !== 'AbortError' && document.getElementById('recoveryIssuesModal')?.classList.contains('active')) {
          recoveryIssueState.error = '待处理问题加载失败，已有列表会保留；请点击“重试”再次加载。';
          document.getElementById('recoveryIssuesLive').textContent = '待处理问题加载失败，请稍后重试。';
          renderRecoveryIssueCenter();
        } else if (error?.name !== 'AbortError') {
          recoveryIssueState.error = '待处理问题加载失败，已有列表会保留；请打开面板后重试。';
        }
      } finally {
        if (token === recoveryIssueState.token) recoveryIssueState.controller = null;
        recoveryIssueRequestInFlight = false;
        if (document.getElementById('recoveryIssuesModal')?.classList.contains('active')) {
          renderRecoveryIssueStatus();
        }
      }
    }

    function openRecoveryIssues(trigger, focusId = null) {
      recoveryIssueState.focusId = focusId || null;
      document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
      openModal('recoveryIssuesModal', trigger);
      renderRecoveryIssueCenter();
      void refreshRecoveryIssues();
    }

    function startRecoveryIssuePolling() {
      if (recoveryIssuePollTimer) clearInterval(recoveryIssuePollTimer);
      if (document.hidden) return;
      if (logMode !== 'queue') void refreshRecoveryIssues();
      recoveryIssuePollTimer = setInterval(() => {
        if (logMode !== 'queue') void refreshRecoveryIssues();
      }, 10_000);
    }

    function stopRecoveryIssuePolling() {
      if (recoveryIssuePollTimer) {
        clearInterval(recoveryIssuePollTimer);
        recoveryIssuePollTimer = null;
      }
    }

    function formatElapsed(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '0s';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + 'm ' + s + 's';
    }

    function queuePhaseLabel(item) {
      const phase = item.phase || '';
      if (phase === 'running') return item.stage === 'download_running' ? '正在下载' : '正在上传';
      if (phase === 'remote_verifying') return '正在确认远端';
      if (phase === 'retry_wait') return '等待重试';
      if (phase === 'background_wait') return '等待系统复核';
      if (phase === 'manual_action') return '等待处理';
      if (phase === 'leased') return '已领取，等待执行';
      return '排队等待';
    }

    function queueTimeLabel(item, nowMs) {
      const nextAt = Number(item.nextActionAt || 0);
      if (nextAt > 0) {
        if (nextAt > nowMs) {
          const prefix = item.nextAction === 'recheck' ? '约 ' : '';
          const action = item.nextAction === 'recheck'
            ? '后自动复核'
            : item.nextAction === 'verify' ? '后确认' : '后重试';
          return prefix + formatElapsed(nextAt - nowMs) + action;
        }
        if (item.nextAction === 'recheck') return '复核时间已到，等待调度';
        return item.nextAction === 'verify' ? '等待确认调度' : '等待重试调度';
      }
      if (item.phase === 'running' || item.phase === 'remote_verifying') {
        const startedAt = Number(item.startedAt || 0);
        return startedAt > 0 ? '已运行 ' + formatElapsed(Math.max(0, nowMs - startedAt)) : '正在处理';
      }
      if (item.phase === 'queued' && Number(item.queuedAt || 0) > 0) {
        return '已等待 ' + formatElapsed(Math.max(0, nowMs - Number(item.queuedAt)));
      }
      return item.phase === 'background_wait' ? '等待系统复核' : '等待处理';
    }

    function makeQueueCardKey(item) {
      const userId = item.userId || '';
      const mediaId = item.mediaId || '';
      const bvid = item.bvid || item.id || '';
      const remotePath = item.remotePath || '';
      return [userId, mediaId, bvid, remotePath].join(':');
    }

    async function recoverQueueUpload(jobId, allowReupload, trigger) {
      if (allowReupload) {
        const confirmed = await confirmAction({
          title: '确认继续上传',
          message: '会重新检查正式远端路径；只有目标不存在时才再次PUT。',
          detail: '如果远端已经存在不同大小的文件，系统仍会停在冲突状态，不会覆盖它。',
          confirmText: '继续上传',
          trigger,
        });
        if (!confirmed) return;
      }
      const card = trigger instanceof HTMLElement ? trigger.closest('.queue-card') : null;
      const buttons = card ? Array.from(card.querySelectorAll('.queue-recovery-actions button')) : [];
      buttons.forEach((button) => { button.disabled = true; });
      try {
        await fetchJson('/api/queue/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, allowReupload }),
        });
        showToast(allowReupload ? '已开始重新确认并允许一次重传' : '已开始重新确认远端文件', 'success');
        await refreshQueueBoard();
      } catch (error) {
        buttons.forEach((button) => { button.disabled = false; });
        if (error?.name !== 'AbortError') showToast(error?.message || '恢复上传失败', 'error');
      }
    }

    function updateQueueRecoveryActions(card, item) {
      const info = card.querySelector('.queue-info');
      if (!info) return;
      let actions = info.querySelector('.queue-recovery-actions');
      const shouldShow = Boolean(item.awaitingManualRecovery && item.recoveryJobId && item.recoveryDisposition !== 'background');
      if (!shouldShow) {
        if (actions) actions.remove();
        return;
      }
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'queue-recovery-actions';
        const confirmButton = document.createElement('button');
        confirmButton.type = 'button';
        confirmButton.textContent = '重新确认';
        confirmButton.title = '只检查正式远端文件，不重复上传';
        const uploadButton = document.createElement('button');
        uploadButton.type = 'button';
        uploadButton.className = 'danger-action';
        uploadButton.textContent = '继续上传';
        uploadButton.title = '允许本次缺失文件重新PUT一次';
        confirmButton.addEventListener('click', () => void recoverQueueUpload(String(item.recoveryJobId), false, confirmButton));
        uploadButton.addEventListener('click', () => void recoverQueueUpload(String(item.recoveryJobId), true, uploadButton));
        actions.append(confirmButton, uploadButton);
        info.appendChild(actions);
      }
      const supportsEncodingRetry = Array.isArray(item.recoveryActions)
        && item.recoveryActions.some((action) => action.id === 'redownload_with_encoding')
        && item.recoveryIssueId;
      const existingEncodingButton = actions.querySelector('[data-recovery-action="redownload_with_encoding"]');
      if (!supportsEncodingRetry) {
        existingEncodingButton?.remove();
        return;
      }
      const encodingButton = existingEncodingButton || document.createElement('button');
      encodingButton.type = 'button';
      encodingButton.dataset.recoveryAction = 'redownload_with_encoding';
      encodingButton.textContent = '换编码';
      encodingButton.title = '选择一次性编码顺序，隔离下载并确认新文件后再替换原文件';
      encodingButton.onclick = () => openRecoveryIssues(encodingButton, String(item.recoveryIssueId));
      if (!existingEncodingButton) actions.appendChild(encodingButton);
    }

    function updateQueueCard(card, item, nowMs) {
      card.__queueItem = item;
      card.dataset.queueStage = item.stage || '';
      card.dataset.queuePhase = item.phase || '';
      const titleEl = card.querySelector('.queue-title');
      const metaEl = card.querySelector('.queue-meta');
      const extraEl = card.querySelector('.queue-extra');
      const coverEl = card.querySelector('.queue-cover');
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = typeof item.cover === 'string' && item.cover.trim()
        ? item.cover.replace('http://', 'https://')
        : '';
      const coverUrl = (!remoteCoverUrl || item.unavailable) && cachedCoverUrl ? cachedCoverUrl : remoteCoverUrl;
      if (coverEl instanceof HTMLImageElement) {
        if (coverUrl) {
          if (coverEl.src !== coverUrl) coverEl.src = coverUrl;
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'queue-cover';
          placeholder.textContent = '封面';
          placeholder.setAttribute('aria-hidden', 'true');
          coverEl.replaceWith(placeholder);
        }
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
        const folder = item.folderTitle ? ' · 收藏夹：' + safeText(item.folderTitle, '') : '';
        metaEl.textContent = safeText(item.upperName || item.ownerName, '未知UP') + ' · ' + safeText(item.bvid, '-') + folder;
      }
      if (extraEl) {
        extraEl.innerHTML = '';
        if (item.detail || queuePhaseLabel(item)) {
          const detail = document.createElement('span');
          detail.className = 'queue-status';
          detail.textContent = String(item.detail || queuePhaseLabel(item));
          extraEl.appendChild(detail);
        }
        if (item.phase === 'retry_wait') {
          const retry = document.createElement('span');
          retry.className = 'queue-pill';
          retry.textContent = '重试 ' + Number(item.retries || 0) + '/' + Number(item.maxRetries || 0);
          extraEl.appendChild(retry);
        }
        const time = document.createElement('span');
        time.className = 'queue-pill';
        time.dataset.queueTime = '1';
        time.textContent = queueTimeLabel(item, nowMs);
        extraEl.appendChild(time);
      }
      updateQueueRecoveryActions(card, item);
    }

    function updateQueueBoardClock() {
      const nowMs = Date.now();
      for (const card of queueBoardState.cards.values()) {
        const item = card.__queueItem;
        const time = card.querySelector('[data-queue-time="1"]');
        if (item && time) time.textContent = queueTimeLabel(item, nowMs);
      }
    }

    function renderQueueCard(item, nowMs) {
      const card = document.createElement('div');
      card.className = 'queue-card';
      card.dataset.queueKey = makeQueueCardKey(item);
      const cachedCoverUrl = localCoverUrl(item);
      const remoteCoverUrl = typeof item.cover === 'string' && item.cover.trim()
        ? item.cover.replace('http://', 'https://')
        : '';
      const coverUrl = (!remoteCoverUrl || item.unavailable) && cachedCoverUrl ? cachedCoverUrl : remoteCoverUrl;
      if (coverUrl) {
        const img = document.createElement('img');
        img.className = 'queue-cover';
        img.src = coverUrl;
        img.alt = safeText(item.title || item.bvid, '视频封面');
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        const cover = document.createElement('div');
        cover.className = 'queue-cover';
        cover.textContent = '封面';
        cover.setAttribute('aria-hidden', 'true');
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
      const statusLabels = { idle:'空闲', running:'运行中', queued:'排队中', paused:'已暂停', error:'异常' };
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

    function renderLocalCacheStatus(parent, localCache, recovery, chargingAccess) {
      const host = parent.parentElement || parent;
      let el = host.querySelector('[data-local-cache-status="1"]');
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
        ? ' 充电待检查 ' + Number(chargingAccess.pending || 0) + ' 项' +
          (chargingAccess.nextCheckAt ? '，下次检查 ' + formatDateTime(chargingAccess.nextCheckAt) : '') + '。'
        : '';
      el.classList.toggle('paused', !!localCache?.paused);
      el.textContent = localCache?.paused
        ? '下载暂停：本地缓存 ' + used + ' / ' + limit + '，已预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) + ' 安全空间；上传队列不受影响。' + resumeText + chargingText
        : '本地缓存：' + used + ' / ' + limit + (limitBytes > 0 ? '，安全预留 ' + formatBytes(Number(localCache?.reserveBytes || 0)) : '') + '。' + resumeText + chargingText;
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
      el.textContent = '上传后端异常，下载已暂停：' + (uploadHealth.reason || 'AList / OpenList 上传暂不可用') + '；' + modeText + '。本地文件已保留为“待补传”。';
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

    function renderQueueBoardNotice(board, message, error = false) {
      let notice = board.querySelector('[data-queue-board-notice="1"]');
      if (!message) {
        if (notice) notice.remove();
        return;
      }
      if (!notice) {
        notice = document.createElement('div');
        notice.dataset.queueBoardNotice = '1';
        board.insertBefore(notice, board.firstChild);
      }
      notice.className = 'queue-board-notice' + (error ? ' error' : '');
      notice.textContent = message;
    }

    function queueBoardRefreshDelay(snapshot) {
      const items = [
        ...(snapshot.downloadPending || []),
        ...(snapshot.downloadRunning || []),
        ...(snapshot.uploadPending || []),
        ...(snapshot.uploadRunning || []),
      ];
      if (items.some((item) => ['running', 'remote_verifying'].includes(item.phase))) return 2_000;
      if (items.length > 0 || snapshot.maintenance) return 5_000;
      return 15_000;
    }

    function scheduleQueueBoardPoll(delayMs) {
      if (queueBoardPollTimer) clearTimeout(queueBoardPollTimer);
      if (document.hidden || logMode !== 'queue') {
        queueBoardPollTimer = null;
        return;
      }
      queueBoardPollTimer = setTimeout(() => {
        queueBoardPollTimer = null;
        void refreshQueueBoard();
      }, Math.max(1_000, Number(delayMs) || 5_000));
    }

    async function refreshQueueBoard() {
      if (logMode !== 'queue' || queueBoardRequestInFlight) return;
      const board = ensureQueueBoardHost();
      if (!board) return;
      const token = ++queueBoardRequestToken;
      const controller = new AbortController();
      queueBoardRequestController = controller;
      queueBoardRequestInFlight = true;
      try {
        const data = await fetchJsonSilent('/api/queue/state', { signal: controller.signal });
        if (token !== queueBoardRequestToken || logMode !== 'queue') return;
        const snapshot = data || {};
        queueBoardState.lastSnapshot = snapshot;
        queueBoardState.lastUpdatedAt = Date.now();
        queueBoardState.lastError = null;
        renderQueueBoardNotice(board, '');
        setRecoveryIssueItems(
          snapshot.issues || [...(snapshot.actionRequiredIssues || []), ...(snapshot.intentionalConfirmations || [])],
          snapshot.issueSummary,
        );
        const nowMs = Date.now();
        let grid = board.querySelector('.queue-board');
        if (!grid) {
          board.innerHTML = '';
          grid = document.createElement('div');
          grid.className = 'queue-board';
          board.appendChild(grid);
          queueBoardState.columns = {};
        }
        renderSchedulerStatus(grid, { ...(snapshot.scheduler || {}), recovery: snapshot.recovery || {}, maintenance: snapshot.maintenance || null });
        renderLocalCacheStatus(grid, snapshot.localCache || null, snapshot.downloadRecovery || null, snapshot.chargingAccess || null);
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
        scheduleQueueBoardPoll(queueBoardRefreshDelay(snapshot));
      } catch (e) {
        if (token !== queueBoardRequestToken || e?.name === 'AbortError') return;
        queueBoardState.lastError = e?.message || '队列看板暂时无法更新';
        if (queueBoardState.lastSnapshot) {
          const lastTime = queueBoardState.lastUpdatedAt ? formatDateTime(queueBoardState.lastUpdatedAt) : '未知时间';
          renderQueueBoardNotice(board, '更新失败，继续显示 ' + lastTime + ' 的状态；稍后自动重试。', true);
        } else {
          board.innerHTML = '<div class="empty-state video-detail-status error">队列看板暂时无法加载，请稍后重试。</div>';
        }
        scheduleQueueBoardPoll(10_000);
      } finally {
        if (token === queueBoardRequestToken) {
          queueBoardRequestInFlight = false;
          queueBoardRequestController = null;
        }
      }
    }

    function stopQueueBoardPolling() {
      if (queueBoardPollTimer) {
        clearTimeout(queueBoardPollTimer);
        queueBoardPollTimer = null;
      }
      if (queueBoardClockTimer) {
        clearInterval(queueBoardClockTimer);
        queueBoardClockTimer = null;
      }
      queueBoardRequestToken += 1;
      queueBoardRequestController?.abort();
      queueBoardRequestController = null;
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
      queueBoardState.lastSnapshot = null;
      queueBoardState.lastUpdatedAt = 0;
      queueBoardState.lastError = null;
    }

    function startQueueBoardPolling() {
      stopQueueBoardPolling();
      if (document.hidden) return;
      queueBoardClockTimer = setInterval(updateQueueBoardClock, 1_000);
      void refreshQueueBoard();
    }

    function setLogMode(mode) {
      stopQueueBoardPolling();
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
    document.getElementById('recoveryIssuesBtn').addEventListener('click', (event) => openRecoveryIssues(event.currentTarget));
    document.getElementById('recoveryIssuesRetryBtn').addEventListener('click', () => void refreshRecoveryIssues());
    document.getElementById('recoveryIssuesEmptyRetryBtn').addEventListener('click', () => void refreshRecoveryIssues());
    document.getElementById('closeRecoveryIssuesBtn').addEventListener('click', () => closeModal('recoveryIssuesModal'));
    document.getElementById('recoveryIssuesBackBtn').addEventListener('click', () => {
      document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
      const selected = document.querySelector('.recovery-issue-row.active');
      if (selected instanceof HTMLElement) setTimeout(() => selected.focus({ preventScroll:true }), 0);
    });
    document.getElementById('closeVideoDetailBtn').addEventListener('click', () => closeModal('videoDetailModal'));
    document.getElementById('archiveLibraryBtn').addEventListener('click', (event) => openArchiveLibrary(event.currentTarget));
    document.getElementById('closeArchiveLibraryBtn').addEventListener('click', () => closeModal('archiveLibraryModal'));
    document.getElementById('archiveLibraryMobileBackBtn').addEventListener('click', () => {
      saveArchiveLibraryScroll();
      closeArchiveLibraryDetail({ restoreFocus:false });
      const shell = document.querySelector('.archive-library-shell');
      shell.classList.remove('show-content');
      syncArchiveLibraryPanels();
      shell.scrollLeft = 0;
      const active = document.querySelector('.archive-nav-item.active');
      if (active) setTimeout(() => {
        active.focus({ preventScroll:true });
        shell.scrollLeft = 0;
      }, 0);
    });
    archiveLibraryLayoutMedia.addEventListener('change', syncArchiveLibraryPanels);
    document.getElementById('archiveLibraryDetailCloseBtn').addEventListener('click', closeArchiveLibraryDetail);
    document.getElementById('archiveLibrarySearchInput').addEventListener('input', scheduleArchiveLibrarySearch);
    document.getElementById('archiveLibrarySearchClearBtn').addEventListener('click', () => {
      const input = document.getElementById('archiveLibrarySearchInput');
      input.value = '';
      archiveLibraryState.draftQuery = '';
      const changed = applyArchiveLibraryDraftQuery();
      if (changed) loadArchiveLibraryItems(true);
      input.focus({ preventScroll:true });
    });
    document.getElementById('archiveSearchCurrentBtn').addEventListener('click', () => {
      if (archiveLibraryState.searchScope === 'current') return;
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.searchScope = 'current';
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      loadArchiveLibraryItems(true);
    });
    document.getElementById('archiveSearchGlobalBtn').addEventListener('click', () => {
      if (archiveLibraryState.searchScope === 'global') return;
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.searchScope = 'global';
      closeArchiveLibraryDetail({ restoreFocus:false });
      setArchiveLibraryHeading();
      loadArchiveLibraryItems(true);
    });
    document.getElementById('archiveLibrarySort').addEventListener('change', (event) => {
      applyArchiveLibraryDraftQuery();
      archiveLibraryState.sort = event.target.value;
      closeArchiveLibraryDetail({ restoreFocus:false });
      persistArchiveLibraryPreference();
      loadArchiveLibraryItems(true);
    });
    document.querySelectorAll('[data-archive-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        const filter = button.dataset.archiveFilter;
        if (!filter || filter === archiveLibraryState.filter) return;
        applyArchiveLibraryDraftQuery();
        archiveLibraryState.filter = filter;
        closeArchiveLibraryDetail({ restoreFocus:false });
        persistArchiveLibraryPreference();
        setArchiveLibraryHeading();
        loadArchiveLibraryItems(true);
      });
    });
    document.getElementById('archiveLibraryResults').addEventListener('scroll', () => {
      const results = document.getElementById('archiveLibraryResults');
      if (!document.getElementById('archiveLibraryModal').classList.contains('active')
        || results.scrollHeight - results.scrollTop - results.clientHeight >= 240
        || archiveLibraryState.loading || !archiveLibraryState.hasMore || archiveLibraryState.scrollTimer) return;
      archiveLibraryState.scrollTimer = setTimeout(() => {
        archiveLibraryState.scrollTimer = null;
        if (document.getElementById('archiveLibraryModal').classList.contains('active')) {
          loadArchiveLibraryItems(false);
        }
      }, 180);
    });
    document.getElementById('closePlaybackBtn').addEventListener('click', () => closeModal('playbackModal'));
    document.getElementById('closePlaybackImmersiveBtn').addEventListener('click', () => closeModal('playbackModal'));
    document.getElementById('playbackImmersiveQueueBtn').addEventListener('click', () => setPlaybackQueueDrawer(!playbackState.drawerOpen));
    document.getElementById('playbackImmersiveExitBtn').addEventListener('click', () => setPlaybackMobilePortraitMode(false));
    document.getElementById('playbackMobilePortraitBtn').addEventListener('click', () => {
      const enabled = !playbackState.preferences || playbackState.preferences.mobilePortraitMode !== false;
      setPlaybackMobilePortraitMode(!enabled);
    });
    document.getElementById('playbackDrawerBackdrop').addEventListener('click', () => setPlaybackQueueDrawer(false));
    document.getElementById('playbackQueueCloseBtn').addEventListener('click', () => setPlaybackQueueDrawer(false));
    const playbackStage = document.getElementById('playbackStage');
    playbackStage.addEventListener('pointerdown', handlePlaybackSwipeStart);
    playbackStage.addEventListener('pointermove', handlePlaybackSwipeMove);
    playbackStage.addEventListener('pointerup', handlePlaybackSwipeEnd);
    playbackStage.addEventListener('pointercancel', handlePlaybackSwipeCancel);
    playbackStage.addEventListener('lostpointercapture', handlePlaybackSwipeCancel);
    document.getElementById('playbackPreviousBtn').addEventListener('click', () => stepPlayback(-1));
    document.getElementById('playbackNextBtn').addEventListener('click', () => stepPlayback(1));
    document.getElementById('playbackSearchInput').addEventListener('input', schedulePlaybackSearch);
    document.getElementById('playbackSearchClearBtn').addEventListener('click', () => {
      clearPlaybackSearch();
      document.getElementById('playbackSearchInput').focus({ preventScroll:true });
    });
    const handlePlaybackViewportChange = () => {
      if (!document.getElementById('playbackModal').classList.contains('active')) return;
      syncPlaybackImmersiveMode();
    };
    window.matchMedia('(max-width: 720px)').addEventListener('change', handlePlaybackViewportChange);
    window.matchMedia('(orientation: portrait)').addEventListener('change', handlePlaybackViewportChange);
    document.getElementById('playbackContinuousBtn').addEventListener('click', () => {
      playbackState.continuous = !playbackState.continuous;
      if (playbackState.preferences) playbackState.preferences.continuous = playbackState.continuous;
      persistPlaybackPreferences();
      updatePlaybackNavigation();
    });
    document.getElementById('playbackRetryBtn').addEventListener('click', retryCurrentPlayback);
    document.getElementById('playbackSkipBtn').addEventListener('click', skipCurrentPlaybackVideo);
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
    document.getElementById('migrationModeControl').addEventListener('change', refreshMigrationEstimate);
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
      if (event.key === 'Tab') {
        const modal = activeModal();
        if (!modal) return;
        const controls = focusableElements(modal);
        if (!controls.length) {
          event.preventDefault();
          modal.focus({ preventScroll:true });
          return;
        }
        const activeIndex = controls.indexOf(document.activeElement);
        if (event.shiftKey && activeIndex <= 0) {
          event.preventDefault();
          controls[controls.length - 1].focus({ preventScroll:true });
        } else if (!event.shiftKey && (activeIndex < 0 || activeIndex === controls.length - 1)) {
          event.preventDefault();
          controls[0].focus({ preventScroll:true });
        }
        return;
      }
      if (event.key === 'Escape') {
        const modal = activeModal();
        if (modal && modal.id === 'playbackModal' && playbackState.drawerOpen) {
          event.preventDefault();
          setPlaybackQueueDrawer(false);
          return;
        }
        if (modal && modal.id === 'archiveLibraryModal' && document.getElementById('archiveLibraryDetail').classList.contains('open')) {
          event.preventDefault();
          closeArchiveLibraryDetail();
          return;
        }
        if (modal && modal.id === 'recoveryIssuesModal' && document.querySelector('.recovery-issues-shell')?.classList.contains('show-detail')) {
          event.preventDefault();
          document.querySelector('.recovery-issues-shell')?.classList.remove('show-detail');
          const selected = document.querySelector('.recovery-issue-row.active');
          if (selected instanceof HTMLElement) selected.focus({ preventScroll:true });
          return;
        }
        if (modal) closeModal(modal);
      }
    });

    document.getElementById('confirmActionInput').addEventListener('input', syncConfirmActionInput);
    document.getElementById('confirmActionOkBtn').addEventListener('click', () => finishConfirmAction(true));
    document.getElementById('confirmActionCancelBtn').addEventListener('click', () => finishConfirmAction(false));
    document.getElementById('encodingRetrySubmitBtn').addEventListener('click', () => {
      if (!encodingRetryDialogState) return;
      const priority = normalizeClientEncodingPriority(encodingRetryDialogState.priority);
      if (priority.length !== 3) {
        document.getElementById('encodingRetryStatus').textContent = '请保留 HEVC、AVC、AV1 三项，且每项只出现一次。';
        return;
      }
      finishEncodingRetryDialog({ priority, strict: document.getElementById('encodingRetryStrict').checked });
    });
    document.getElementById('encodingRetryCancelBtn').addEventListener('click', () => finishEncodingRetryDialog(null));
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
    document.getElementById('videoGrid').addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest('[data-playback-bvid]') : null;
      if (row && row.dataset.playbackBvid) openArchivePlayback(row.dataset.playbackBvid, row);
    });
    document.getElementById('videoGrid').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target instanceof Element ? event.target.closest('[data-playback-bvid]') : null;
      if (!row || !row.dataset.playbackBvid) return;
      event.preventDefault();
      openArchivePlayback(row.dataset.playbackBvid, row);
    });
    document.getElementById('unavailableGrid').addEventListener('scroll', () => {
      const grid = document.getElementById('unavailableGrid');
      if (unavailableUserId && document.getElementById('unavailableModal').classList.contains('active')
        && grid.scrollHeight - grid.scrollTop - grid.clientHeight < 120) {
        if (unavailableThrottleTimer) return;
        unavailableThrottleTimer = setTimeout(() => {
          unavailableThrottleTimer = null;
          loadMoreUnavailable();
        }, 800);
      }
    });

    function syncAccountRemovalControls() {
      const remote = document.getElementById('accountRemovalRemote').checked;
      const input = document.getElementById('accountRemovalConfirmInput');
      const submit = document.getElementById('accountRemovalSubmitBtn');
      setHidden('accountRemovalConfirmWrap', !remote);
      submit.textContent = remote ? '删除账号并开始清理' : '仅删除账号登录';
      submit.disabled = !accountRemovalState.userId || (remote && (accountRemovalState.loading || !accountRemovalState.preview || input.value.trim() !== 'DELETE REMOTE ARCHIVE'));
    }

    async function loadAccountRemovalPreview() {
      const userId = accountRemovalState.userId;
      if (!userId || accountRemovalState.loading || accountRemovalState.preview) return;
      if (accountRemovalState.controller) accountRemovalState.controller.abort();
      const controller = new AbortController();
      const token = accountRemovalState.token;
      accountRemovalState.controller = controller;
      accountRemovalState.loading = true;
      document.getElementById('accountRemovalPreview').textContent = '正在计算远端归档影响范围...';
      syncAccountRemovalControls();
      try {
        const preview = await fetchJson('/api/users/' + encodeURIComponent(userId) + '/removal-preview', { method:'POST', signal:controller.signal });
        if (accountRemovalState.token !== token || accountRemovalState.userId !== userId) return;
        accountRemovalState.preview = preview;
        document.getElementById('accountRemovalPreview').textContent =
          Number(preview.relationCount || 0) + ' 条收藏关系 · ' + Number(preview.sourceCount || 0) + ' 个归档来源 · ' +
          Number(preview.fileCount || 0) + ' 个已追踪文件 · ' + formatBytes(Number(preview.totalBytes || 0)) +
          (preview.sharedCount ? ' · 共享保留 ' + Number(preview.sharedCount) : '') +
          (preview.activeTasks ? ' · 将暂停或改派关联任务 ' + Number(preview.activeTasks) : '');
      } catch (error) {
        if ((error && error.name === 'AbortError') || accountRemovalState.token !== token || accountRemovalState.userId !== userId) return;
        document.getElementById('accountRemovalPreview').textContent = '影响范围读取失败：' + (error instanceof Error ? error.message : String(error));
      } finally {
        if (accountRemovalState.token === token) {
          accountRemovalState.loading = false;
          if (accountRemovalState.controller === controller) accountRemovalState.controller = null;
          syncAccountRemovalControls();
        }
      }
    }

    function handleAccountRemovalModeChange() {
      const remote = document.getElementById('accountRemovalRemote').checked;
      if (remote) {
        void loadAccountRemovalPreview();
      } else {
        if (accountRemovalState.controller) accountRemovalState.controller.abort();
        accountRemovalState.controller = null;
        accountRemovalState.loading = false;
        document.getElementById('accountRemovalPreview').textContent = '仅移除账号登录；远端归档、封面和本地索引都会保留。';
      }
      syncAccountRemovalControls();
    }

    function openAccountRemoval(userId, userName, trigger) {
      if (accountRemovalState.pollTimer) clearTimeout(accountRemovalState.pollTimer);
      if (accountRemovalState.controller) accountRemovalState.controller.abort();
      const token = ++accountRemovalToken;
      accountRemovalState = { userId, preview:null, operationId:null, pollTimer:null, trigger, controller:null, token, loading:false };
      document.getElementById('accountRemovalTitle').textContent = '删除账号 · ' + safeText(userName, userId);
      document.getElementById('accountRemovalOnly').checked = true;
      document.getElementById('accountRemovalRemote').checked = false;
      document.getElementById('accountRemovalConfirmInput').value = '';
      document.getElementById('accountRemovalPreview').textContent = '仅移除账号登录；远端归档、封面和本地索引都会保留。';
      document.querySelectorAll('.account-removal-option').forEach((option) => option.classList.remove('is-hidden'));
      setHidden('accountRemovalProgress', true);
      setHidden('accountRemovalSubmitBtn', false);
      document.getElementById('accountRemovalCancelBtn').textContent = '取消';
      syncAccountRemovalControls();
      openModal('accountRemovalModal', trigger);
    }

    function accountRemovalContextCurrent(token, userId, operationId) {
      return token === accountRemovalState.token
        && userId === accountRemovalState.userId
        && (!operationId || operationId === accountRemovalState.operationId)
        && document.getElementById('accountRemovalModal').classList.contains('active');
    }

    async function watchAccountArchiveDeletion(operationId, token = accountRemovalState.token, userId = accountRemovalState.userId) {
      if (!userId || !accountRemovalContextCurrent(token, userId, operationId)) return;
      const host = document.getElementById('accountRemovalProgress');
      try {
        const operation = await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId));
        if (!accountRemovalContextCurrent(token, userId, operationId)) return;
        host.textContent = archiveDeletionProgressText(operation);
        if (operation.status === 'completed') {
          document.getElementById('accountRemovalCancelBtn').textContent = '关闭';
          showToast('账号归档清理完成', 'success');
          return;
        }
        if (operation.status === 'failed') {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'ghost';
          retry.textContent = '重试清理';
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            try {
              await fetchJson('/api/archive-deletions/' + encodeURIComponent(operationId) + '/retry', { method:'POST' });
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              watchAccountArchiveDeletion(operationId, token, userId);
            } catch (error) {
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              retry.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(retry);
          const repreview = document.createElement('button');
          repreview.type = 'button';
          repreview.className = 'ghost';
          repreview.textContent = '重新预览并确认';
          repreview.addEventListener('click', async () => {
            repreview.disabled = true;
            try {
              const replacement = await repreviewAndStartArchiveDeletion(operationId, repreview);
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              if (replacement) {
                accountRemovalState.operationId = replacement.id;
                watchAccountArchiveDeletion(replacement.id, token, userId);
              }
              else repreview.disabled = false;
            } catch (error) {
              if (!accountRemovalContextCurrent(token, userId, operationId)) return;
              repreview.disabled = false;
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
          host.appendChild(document.createTextNode(' '));
          host.appendChild(repreview);
          return;
        }
        accountRemovalState.pollTimer = setTimeout(() => watchAccountArchiveDeletion(operationId, token, userId), 1000);
      } catch (error) {
        if (!accountRemovalContextCurrent(token, userId, operationId)) return;
        host.textContent = '清理状态暂时无法读取：' + (error instanceof Error ? error.message : String(error));
        accountRemovalState.pollTimer = setTimeout(() => watchAccountArchiveDeletion(operationId, token, userId), 3000);
      }
    }

    async function submitAccountRemoval() {
      const preview = accountRemovalState.preview;
      const remote = document.getElementById('accountRemovalRemote').checked;
      const userId = accountRemovalState.userId;
      const token = accountRemovalState.token;
      if (!userId || (remote && !preview)) return;
      const submit = document.getElementById('accountRemovalSubmitBtn');
      submit.disabled = true;
      try {
        const data = await fetchJson('/api/users/' + encodeURIComponent(userId), {
          method:'DELETE', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(remote ? {
            mode:'account_and_remote', previewId:preview.previewId, confirmation:'DELETE REMOTE ARCHIVE'
          } : { mode:'account_only' })
        });
        await loadUsers();
        if (!accountRemovalContextCurrent(token, userId)) return;
        if (!remote) {
          closeModal('accountRemovalModal');
          showToast('账号登录已移除，远端归档已保留', 'success');
          return;
        }
        setHidden('accountRemovalSubmitBtn', true);
        setHidden('accountRemovalConfirmWrap', true);
        document.querySelectorAll('.account-removal-option').forEach((option) => option.classList.add('is-hidden'));
        const progress = document.getElementById('accountRemovalProgress');
        setHidden(progress, false);
        document.getElementById('accountRemovalCancelBtn').textContent = '关闭';
        accountRemovalState.operationId = data.operation.id;
        watchAccountArchiveDeletion(data.operation.id, token, userId);
      } catch (error) {
        if (!accountRemovalContextCurrent(token, userId)) return;
        submit.disabled = false;
        showToast(error instanceof Error ? error.message : String(error));
      }
    }

    document.getElementById('accountRemovalOnly').addEventListener('change', handleAccountRemovalModeChange);
    document.getElementById('accountRemovalRemote').addEventListener('change', handleAccountRemovalModeChange);
    document.getElementById('accountRemovalConfirmInput').addEventListener('input', syncAccountRemovalControls);
    document.getElementById('accountRemovalSubmitBtn').addEventListener('click', submitAccountRemoval);
    document.getElementById('accountRemovalCancelBtn').addEventListener('click', () => closeModal('accountRemovalModal'));

    document.getElementById('userList').addEventListener('click', async (event) => {
      const t = event.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action, userId = t.dataset.id;
      if (action === 'favorites') await openFavorites(userId);
      if (action === 'favorite_detail' && t.dataset.mediaId) {
        await openVideoDetail(userId, t.dataset.mediaId, t.dataset.title || '收藏夹详情');
      }
      if (action === 'unavailable') await openUnavailable(userId);
      if (action === 'remove') {
        await openAccountRemoval(userId, t.dataset.name || userId, t);
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
    document.getElementById('reconcileRemoteBtn').textContent = '\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5\u8fdc\u7aef\u5b58\u50a8\uff09';
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
      const defaultText = btn.dataset.defaultText || btn.textContent || '\u72b6\u6001\u5bf9\u8d26\uff08\u4ec5\u8fdc\u7aef\u5b58\u50a8\uff09';
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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopQueueBoardPolling();
        stopRecoveryIssuePolling();
        return;
      }
      startRecoveryIssuePolling();
      if (logMode === 'queue') startQueueBoardPolling();
    });
    document.getElementById('logSimpleBtn').addEventListener('click', () => setLogMode('simple'));
    document.getElementById('logRawBtn').addEventListener('click', () => setLogMode('raw'));
    document.getElementById('logDebugBtn').addEventListener('click', () => setLogMode('debug'));

    // Rename and quality upgrade buttons
    document.getElementById('renameBtn').addEventListener('click', openRenamePreview);
    document.getElementById('qualityUpgradeBtn').addEventListener('click', openQualityUpgradePreview);
    document.getElementById('pathMigrationBtn').addEventListener('click', openPathMigration);
    document.getElementById('pathMigrationPreviewBtn').addEventListener('click', previewPathMigration);
    document.getElementById('pathMigrationStartBtn').addEventListener('click', () => pathMigrationAction('start', {}));
    document.getElementById('pathMigrationPauseBtn').addEventListener('click', () => pathMigrationAction('pause', {}));
    document.getElementById('pathMigrationResumeBtn').addEventListener('click', () => pathMigrationAction('resume', {}));
    document.getElementById('pathMigrationCancelBtn').addEventListener('click', async () => {
      const ok = await confirmAction({ title:'取消路径迁移', message:'会保留已经复制到新目录的文件，但不会切换配置；下次可重新预览。', confirmText:'确认取消', trigger:document.getElementById('pathMigrationCancelBtn') });
      if (ok) await pathMigrationAction('cancel', {});
    });
    document.getElementById('pathMigrationKeepBtn').addEventListener('click', () => pathMigrationAction('cleanup-old', { keepOld:true }));
    document.getElementById('pathMigrationCleanupBtn').addEventListener('click', cleanupOldPathMigration);
    document.getElementById('closePathMigrationBtn').addEventListener('click', () => { stopPathMigrationPolling(); closeModal('pathMigrationModal'); });

    // Init
    loadConfig();
    loadUsers();
    initTemplateEditor();
    initLogStream();
    loadQualityUpgradeState();
    setLogMode('queue');
    startRecoveryIssuePolling();
  `;
}
