import { appInfo } from "../../app-info.js";
import { getQueueLoadingMarkup } from "../shared/queue-markup.js";
import { renderAppAssets } from "./assets.js";

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
      --panel: #FFFFFF;
      --surface: #F8FBFA;
      --accent: #39C5BB;
      --accent-hover: #2BA9A0;
      --accent-soft: rgba(57, 197, 187, 0.1);
      --ink: #1A2F2D;
      --muted: #6A7A78;
      --border: #D6F0ED;
      --focus: rgba(57, 197, 187, 0.22);
      --shadow: 0 20px 60px rgba(57, 197, 187, 0.15);
      --radius-control: 12px;
      --radius-panel: 20px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans SC", sans-serif;
      background:
        radial-gradient(circle at 10% -10%, rgba(57, 197, 187, 0.18) 0%, transparent 30%),
        radial-gradient(circle at 86% 4%, rgba(224, 247, 250, 0.68) 0%, transparent 28%),
        linear-gradient(180deg, #FFFFFF 0%, var(--bg) 52%);
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
      border-radius: var(--radius-panel);
      padding: 34px;
      box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, 0.82);
      animation: fadeUp 0.24s cubic-bezier(0.16, 1, 0.3, 1);
      border: 1px solid var(--border);
    }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 700; color: var(--accent); }
    p { margin: 0 0 28px; color: var(--muted); font-size: 15px; }
    label { display: block; font-weight: 500; margin: 0 0 8px; color: var(--ink); }
    input:not([type="checkbox"]) {
      width: 100%;
      padding: 14px 16px;
      border-radius: var(--radius-control);
      border: 1px solid var(--border);
      margin-bottom: 20px;
      font-size: 15px;
      transition: all 0.2s;
      outline: none;
      background: rgba(255, 255, 255, 0.78);
    }
    input:not([type="checkbox"]):focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--focus);
      background: rgba(255, 255, 255, 0.92);
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
      border-radius: var(--radius-control);
      background: var(--accent);
      color: white;
      font-weight: 700;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 8px 20px rgba(57, 197, 187, 0.18);
    }
    button:hover {
      background: var(--accent-hover);
      box-shadow: 0 10px 24px rgba(57, 197, 187, 0.24);
      transform: translateY(-1px);
    }
    button:active {
      box-shadow: inset 0 1px 2px rgba(11, 65, 59, 0.18);
      transform: translateY(0);
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
  ${renderAppAssets()}
</head>
<body>
  ${getAppHeader()}
  <main>
    ${getAccountSection()}
    ${getLogSection()}
    ${getSettingsSection()}
  </main>
  ${getModals()}
  <div id="toastContainer" class="toast-container" aria-live="polite" aria-atomic="false"></div>
  <div id="appAssetError" role="alert" hidden>页面资源未能加载，请刷新页面重试。<button type="button" onclick="location.reload()">刷新页面</button></div>
</body>
</html>`;
}

function getAppHeader() {
  return `<header>
    <div class="app-brand">
      <h1>B站收藏夹同步</h1>
      <button type="button" id="versionInfoBtn" class="version-link header-meta" title="版本与更新">${escapeHtml(appInfo.versionLabel)}</button>
    </div>
    <div class="header-actions">
      ${getGithubLink("header-meta")}
      <button id="logoutBtn">退出系统</button>
    </div>
  </header>`;
}

function getAccountSection() {
  return `<section class="card account-section">
      <h2>账号与同步</h2>
      <p class="muted">管理 Bilibili 账号及需同步的收藏夹。点击“立即同步”会唤起后台任务队列。</p>
      <div class="row account-actions">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">立即同步</button>
        <button class="ghost" id="reconcileRemoteBtn">状态对账（仅远端存储）</button>
        <button class="ghost" id="reconcileBtn">全量扫描并对账</button>
        <button class="ghost" id="archiveLibraryBtn">归档库</button>
        <button class="ghost" id="onlineContentBtn">在线内容</button>
        <button class="help-icon-btn" id="syncHelpBtn" type="button" title="查看同步按钮说明" aria-label="查看同步按钮说明">?</button>
      </div>
      <div class="muted status-line" id="userListStatus" aria-live="polite"></div>
      <div class="user-list" id="userList"></div>
    </section>`;
}

function getSettingsSection() {
  return `<section class="card" id="settingsSection">
      <div class="section-title-row">
        <h2>全局设置</h2>
        <button class="help-icon-btn" id="settingsHelpBtn" type="button" title="查看当前设置如何执行" aria-label="查看当前设置如何执行">?</button>
      </div>
      <details class="settings-fold" open><summary>同步节奏</summary><div class="settings-grid">
        <div><label for="pollInterval">轮询间隔 (分钟)</label><input id="pollInterval" type="number" min="1" /></div>
        <div><label for="delaySeconds">BBDown 分P延迟（秒）</label><input id="delaySeconds" type="number" min="0" aria-describedby="delaySecondsHint" /><p class="muted field-hint" id="delaySecondsHint">用于 BBDown 的 --delay-per-page，只影响新下载任务。</p></div>

      </div></details>
      <details class="settings-fold" id="storageSettings"><summary>远端存储与播放</summary><div class="settings-grid">
        <div class="field-full"><label for="alistUrl">远端内部通信地址</label><input id="alistUrl" type="text" placeholder="例如: http://alist:5244 或 http://openlist:5244" autocomplete="off" aria-describedby="alistUrlHint" /><p class="muted field-hint" id="alistUrlHint">兼容字段名保持为 alistUrl；这里可以填写 AList 或 OpenList 的 WebDAV 服务地址。</p></div>
        <div class="field-full"><label for="alistBrowserUrl">远端网页访问地址</label><input id="alistBrowserUrl" type="url" placeholder="例如: https://alist.example.com 或 https://openlist.example.com" autocomplete="off" aria-describedby="alistBrowserUrlHint" /><p class="muted field-hint" id="alistBrowserUrlHint">用于播放器中的“在网盘中查看”入口；留空则不显示。支持 AList 和 OpenList 的网页地址。</p></div>
        <div><label for="alistUsername">远端账号（WebDAV 用户名）</label><input id="alistUsername" type="text" placeholder="例如: admin" autocomplete="off" /></div>
        <div><label for="alistPassword">远端密码（WebDAV 密码）</label><input id="alistPassword" type="password" placeholder="密码" autocomplete="new-password" /></div>
        <div class="field-full"><label for="alistDest">目标存储路径</label><input id="alistDest" type="text" placeholder="例如: /阿里云盘/bili-backup/videos" aria-describedby="alistDestHint" /><p class="muted field-hint" id="alistDestHint">已有归档时请使用“迁移归档路径”，系统会先探测 COPY/MOVE 能力、复制并确认新目录，旧目录不会自动删除。</p></div>
        <div class="field-full storage-check-row">
          <button id="storageCheckBtn" class="ghost" type="button" aria-describedby="storageCheckHint storageCheckStatus">只读检查存储连接</button>
          <p class="muted field-hint" id="storageCheckHint">只检查 WebDAV 地址、认证和归档目录读取；不会上传、创建、移动或删除文件，也不代表写入能力已验证。</p>
          <div id="storageCheckStatus" class="status-line storage-check-status" role="status" aria-live="polite"></div>
        </div>
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

      </div></details>
      <details class="settings-fold" id="downloadSettings"><summary>下载画质与编码</summary><div class="settings-grid">
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

      </div></details>
      <details class="settings-fold" id="namingSettings"><summary>视频命名</summary><div class="settings-grid">
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

      </div></details>
      <details class="settings-fold" id="queueSettings"><summary>队列与重试</summary><div class="settings-grid">
        <div><label for="maxRetries">失败重试次数</label><input id="maxRetries" type="number" min="0" /></div>
        <div><label for="retryDelaySeconds">重试间隔 (秒)</label><input id="retryDelaySeconds" type="number" min="1" /></div>
        <div><label for="concurrentDownloads">同时下载并发数</label><input id="concurrentDownloads" type="number" min="1" max="5" /></div>
        <div><label for="concurrentUploads">同时上传并发数</label><input id="concurrentUploads" type="number" min="1" max="10" /></div>
        <div class="field-full"><label for="uploadFileIntervalSeconds">远端文件上传间隔（秒）</label><input id="uploadFileIntervalSeconds" type="number" min="0" max="120" step="1" aria-describedby="uploadFileIntervalHint" /><p class="muted field-hint" id="uploadFileIntervalHint">全局限制实际 PUT 的启动频率；远端预检和已存在文件跳过不等待，0 表示关闭。</p></div>
        <div class="field-full"><label for="queuePrefetchLimit">任务预取上限</label><input id="queuePrefetchLimit" type="number" min="5" max="100" /></div>
        <div><label for="remoteVerifyConcurrency">远端对账并发数</label><input id="remoteVerifyConcurrency" type="number" min="1" max="100" /></div>
        <div><label for="remoteVerifyRateLimitPerSecond">远端对账限速 (次/秒)</label><input id="remoteVerifyRateLimitPerSecond" type="number" min="0.5" max="100" step="0.5" /></div>
        <div class="field-full"><label for="remoteRequeueLimitPerCycle">每轮最多补传数量</label><input id="remoteRequeueLimitPerCycle" type="number" min="1" max="1000" /></div>
      </div></details>
      <details class="settings-fold" id="cacheSettings"><summary>本地缓存与缩略图</summary><div class="settings-grid">
        <div><label for="localCacheLimitGB">本地缓存软上限 (GB，0 表示不限制)</label><input id="localCacheLimitGB" type="number" min="0" max="1024" step="0.5" /></div>
        <div><label for="onlineCoverCacheLimitMB">在线缩略图缓存上限 (MB，64-2048)</label><input id="onlineCoverCacheLimitMB" type="number" min="64" max="2048" step="1" /></div>
      </div></details>
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
      <div class="log-console is-hidden" id="logConsole"><span class="log-info">等待日志...</span></div>
      <div id="queueBoard" aria-busy="true">${getQueueLoadingMarkup()}</div>
    </section>`;
}

function getModals() {
  return `
  <div class="modal" id="updatesModal" aria-labelledby="updatesModalTitle">
    <div class="panel panel-md">
      <h2 id="updatesModalTitle">版本与更新</h2>
      <div class="updates-body" tabindex="0" aria-label="版本信息与发布说明">
      <p>当前运行：${escapeHtml(appInfo.versionLabel)}</p>
      <p class="muted">构建提交：${escapeHtml(appInfo.revision || "未提供")}</p>
      <p id="updatesStatus" role="status" aria-live="polite"></p>
      <p id="updatesTime" class="muted"></p>
      <h3 id="updatesReleaseTitle">正式版发布说明</h3>
      <div id="updatesNotes"></div>
      <p id="updatesTruncated" class="muted" hidden>内容已截取，可前往发布页面阅读完整说明。</p>
      <p><a id="updatesChangelogLink" class="version-link" href="${escapeHtml(appInfo.repositoryUrl)}/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">查看版本记录 ↗</a></p>
      </div>
      <div class="row modal-actions">
        <button id="closeUpdatesBtn" class="ghost">关闭</button>
        <button id="checkUpdatesBtn" class="ghost">检查更新</button>
        <a id="updatesReleaseLink" class="version-link" href="${escapeHtml(appInfo.repositoryUrl)}/releases" target="_blank" rel="noopener noreferrer">前往发布页面 ↗</a>
      </div>
    </div>
  </div>
  <div class="modal" id="loginModal" aria-labelledby="loginModalTitle">
    <div class="panel panel-sm">
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
    <div class="panel panel-md">
      <h2 id="favoritesModalTitle">选择同步收藏夹</h2>
      <p class="muted">勾选你需要自动备份的收藏夹。点击收藏夹名称可查看内部视频详情。</p>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="muted status-line center-status" id="favoritesStatus"></div>
      <div class="row modal-actions split-actions">
        <button id="saveFavoritesBtn">保存选择</button>
        <button id="closeFavoritesBtn" class="ghost">取消</button>
      </div>
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
          <button type="button" data-archive-filter="retained" title="B站来源经复核不可用，但归档仍可播放；可能是下架、审核或权限变化">「留存」</button>
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
  <div class="modal archive-library-modal" id="onlineContentModal" aria-labelledby="onlineContentDialogTitle">
    <section class="online-content-shell" aria-labelledby="onlineContentTitle">
      <aside class="online-content-sidebar">
        <div class="archive-library-brand"><div><strong id="onlineContentDialogTitle">在线内容</strong></div>
          <button id="closeOnlineContentBtn" class="archive-library-close" type="button" aria-label="关闭在线内容" title="关闭">×</button>
        </div>
        <nav class="archive-library-nav" id="onlineContentNav"></nav>
      </aside>
      <section class="online-content-main">
        <div class="archive-library-topbar online-content-topbar">
          <button id="onlineContentMobileBackBtn" class="archive-library-mobile-back" type="button" aria-label="返回在线目录" title="返回">←</button>
          <div class="archive-library-heading"><h2 id="onlineContentTitle">在线收藏夹</h2><span id="onlineContentSummary">0 项</span></div>
          <button id="onlineContentRefreshBtn" class="archive-library-detail-close" type="button" aria-label="刷新当前分类" title="刷新">↻</button>
          <button id="onlineContentCloseMainBtn" class="archive-library-detail-close" type="button" aria-label="关闭在线内容" title="关闭">×</button>
        </div>
        <div class="archive-library-toolbar">
          <label class="archive-library-search"><span class="sr-only">搜索在线内容</span><input id="onlineContentSearchInput" type="search" maxlength="80" placeholder="搜索当前分类" /></label>
        </div>
        <div class="archive-library-results" id="onlineContentResults" tabindex="-1"><div class="archive-library-grid" id="onlineContentGrid"></div><div class="archive-library-footer" id="onlineContentFooter" aria-live="polite"></div></div>
      </section>
    </section>
  </div>
  <div class="modal" id="manualArchiveOptionsModal" aria-labelledby="manualArchiveOptionsTitle">
    <div class="panel panel-md manual-archive-options">
      <h2 id="manualArchiveOptionsTitle">手动归档选项</h2>
      <p id="manualArchiveOptionsVideo" class="muted">选择本次归档使用的 B 站画质和编码。</p>
      <div class="option-grid">
        <label for="manualArchiveQuality">画质档位
          <select id="manualArchiveQuality">
            <option value="">按默认偏好</option>
            <option value="8K">8K</option>
            <option value="4K">4K</option>
            <option value="1080P60">1080P 60帧</option>
            <option value="1080P">1080P</option>
            <option value="720P">720P</option>
          </select>
        </label>
        <label for="manualArchiveEncoding">编码
          <select id="manualArchiveEncoding">
            <option value="">按默认偏好</option>
            <option value="HEVC">HEVC</option>
            <option value="AVC">AVC</option>
            <option value="AV1">AV1</option>
          </select>
        </label>
      </div>
      <div id="manualArchiveProbeResult" class="probe-result" aria-live="polite">默认偏好会允许正常回退。选择画质或编码后，可先探测可用组合和预计大小。</div>
      <div class="row modal-actions">
        <button id="manualArchiveProbeBtn" class="ghost" type="button">探测可用组合</button>
        <button id="manualArchiveStartBtn" type="button">开始手动归档</button>
        <button id="manualArchiveCancelBtn" class="ghost" type="button">取消</button>
      </div>
    </div>
  </div>

  <div class="modal" id="videoDetailModal" aria-labelledby="videoDetailTitle">
    <div class="panel panel-lg">
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
    <div class="panel panel-xl">
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
    <div class="panel panel-lg">
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
    <div class="panel panel-xl">
      <h2 id="settingsHelpModalTitle">当前设置执行流程</h2>
      <p class="muted">这里不会保存设置，也不会触发同步，只按当前表单里的值生成说明。</p>
      <div id="settingsFlowContent"></div>
      <div class="row modal-actions">
        <button id="closeSettingsHelpBtn" class="ghost full-width">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="renamePreviewModal" aria-labelledby="renamePreviewModalTitle">
    <div class="panel panel-xl">
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
    <div class="panel panel-xl">
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
    <div class="panel panel-lg">
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
    <div class="panel panel-lg">
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
    <div class="panel panel-lg">
      <h2 id="pathMigrationModalTitle">迁移归档路径</h2>
      <div class="path-migration-body">
      <p class="muted">系统会在同一 AList / OpenList 挂载存储内复制整个旧目录，包括空目录、<code>_history</code> 和未登记文件。开始前会用隔离临时文件探测 COPY 和 MOVE；复制使用 COPY，不覆盖目标；切换后旧目录仍保留。</p>
      <div class="settings-grid">
        <div><label for="pathMigrationSource">当前归档路径</label><input id="pathMigrationSource" type="text" readonly /></div>
        <div><label for="pathMigrationDestination">新归档路径</label><input id="pathMigrationDestination" type="text" placeholder="例如: /阿里云盘/bili-backup-2" /></div>
      </div>
      <div id="pathMigrationSummary" class="cleanup-list"></div>
      <div id="pathMigrationItems" class="rename-skip-list"></div>
      <div id="pathMigrationStatus" class="rename-result result-block is-hidden"></div>
      </div>
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
    <div class="panel panel-md">
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
    <div class="panel panel-sm">
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
    <div class="panel panel-md">
      <h2 id="encodingRetryTitle">重新选择画质与编码</h2>
      <p id="encodingRetryCopy" class="encoding-retry-copy">系统会在隔离目录重新下载并上传。原文件会保留到新文件完成远端确认。</p>
      <div class="media-retry-probe">
        <div class="media-retry-probe-head">
          <div id="encodingRetryProbeSummary" class="media-retry-probe-summary" aria-live="polite">正在读取当前可用媒体组合...</div>
          <button id="encodingRetryProbeBtn" class="ghost" type="button" title="重新探测可用画质与编码"><span aria-hidden="true">↻</span>重新探测</button>
        </div>
        <div id="encodingRetryCombinations" class="media-retry-combinations" role="radiogroup" aria-label="可用画质与编码组合"></div>
        <div id="encodingRetryManual" class="media-retry-manual" hidden>
          <label id="encodingRetryQualityField">画质档位
            <select id="encodingRetryQuality">
              <option value="">不限定画质（沿用任务设置）</option>
              <option value="8K">8K</option><option value="杜比视界">杜比视界</option><option value="HDR">HDR</option>
              <option value="4K">4K</option><option value="1080P60">1080P 60帧</option><option value="1080P+">1080P 高码率</option>
              <option value="1080P">1080P</option><option value="720P60">720P 60帧</option><option value="720P">720P</option>
              <option value="480P">480P</option><option value="360P">360P</option>
            </select>
          </label>
          <label id="encodingRetryEncodingField">视频编码
            <select id="encodingRetryEncoding">
              <option value="">不限定编码（沿用当前偏好）</option>
              <option value="HEVC">HEVC</option><option value="AVC">AVC</option><option value="AV1">AV1</option>
            </select>
          </label>
        </div>
        <div id="encodingRetryEstimate" class="media-retry-estimate">尚未取得大小信息。</div>
        <p class="media-retry-strict-note">所选规格逐分P严格匹配；未指定项沿用任务设置。不匹配则停止上传，保留原归档。</p>
      </div>
      <div id="encodingRetryPriorityEditor" class="encoding-priority-editor" role="listbox" aria-label="本次重试编码顺序" hidden></div>
      <input type="checkbox" id="encodingRetryStrict" checked hidden />
      <div id="encodingRetryStatus" class="encoding-retry-status" role="alert" aria-live="polite"></div>
      <div class="row modal-actions split-actions">
        <button id="encodingRetrySubmitBtn" type="button" disabled>开始严格重试</button>
        <button id="encodingRetryCancelBtn" class="ghost" type="button">取消</button>
      </div>
    </div>
  </div>

  <div class="modal" id="recoveryChoiceModal" aria-labelledby="recoveryChoiceTitle">
    <div class="panel panel-sm">
      <h2 id="recoveryChoiceTitle">选择恢复方式</h2>
      <p id="recoveryChoiceCopy" class="muted"></p>
      <label id="recoveryChoiceLabel" for="recoveryChoiceSelect">可用选项</label>
      <select id="recoveryChoiceSelect"></select>
      <div id="recoveryChoiceStatus" class="status-line" role="alert" aria-live="polite"></div>
      <div class="row modal-actions split-actions">
        <button id="recoveryChoiceSubmitBtn" type="button">继续</button>
        <button id="recoveryChoiceCancelBtn" class="ghost" type="button">取消</button>
      </div>
    </div>
  </div>

  <div class="modal" id="accountRemovalModal" aria-labelledby="accountRemovalTitle">
    <div class="panel panel-md">
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
