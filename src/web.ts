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
      --border: #D6F0ED;
      --shadow: 0 18px 45px rgba(57, 197, 187, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans SC", sans-serif;
      background: radial-gradient(circle at top left, #E0F7FA 0%, var(--bg) 45%);
      color: var(--ink);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px 32px;
      background: rgba(255, 255, 255, 0.6);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    header h1 { margin: 0; font-size: 24px; color: var(--accent); font-weight: 700; }
    header button {
      background: white;
      border: 2px solid var(--border);
      border-radius: 999px;
      padding: 8px 20px;
      cursor: pointer;
      font-weight: 600;
      color: var(--ink);
      transition: all 0.2s;
    }
    header button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    main {
      padding: 32px;
      display: grid;
      gap: 24px;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      max-width: 1400px;
      margin: 0 auto;
    }
    .card {
      background: var(--panel);
      border-radius: 20px;
      padding: 24px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card h2 { margin: 0 0 16px; font-size: 20px; color: var(--accent); display: flex; align-items: center; gap: 8px; }
    .card h2::before {
      content: ''; display: block; width: 4px; height: 18px; background: var(--accent); border-radius: 4px;
    }
    .muted { color: var(--muted); font-size: 14px; margin-bottom: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row button, .row a {
      border: none;
      background: var(--accent);
      color: white;
      padding: 10px 16px;
      border-radius: 12px;
      cursor: pointer;
      text-decoration: none;
      font-weight: 600;
      transition: all 0.2s;
    }
    .row button:hover, .row a:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }
    .row .ghost {
      background: transparent;
      color: var(--accent);
      border: 2px solid var(--accent);
    }
    .row .ghost:hover {
      background: rgba(57, 197, 187, 0.1);
    }
    .user-list { display: grid; gap: 16px; }
    .user-item {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      display: grid;
      gap: 12px;
      background: #fafdfc;
    }
    .settings-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: 1fr 1fr;
    }
    .settings-group {
      grid-column: 1 / -1;
      padding-top: 16px;
      border-top: 1px dashed var(--border);
      margin-top: 8px;
    }
    .settings-group-title {
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 12px;
    }
    .field-full { grid-column: 1 / -1; }
    label { display: block; font-weight: 500; margin: 0 0 8px; color: var(--ink); font-size: 14px; }
    input[type="text"], input[type="number"], select {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 2px solid var(--border);
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
      background: white;
    }
    input:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(57, 197, 187, 0.2);
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      cursor: pointer;
      margin: 0;
    }
    .checkbox-label input { width: auto; margin: 0; }
    .modal {
      position: fixed;
      inset: 0;
      background: rgba(26, 47, 45, 0.6);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      z-index: 100;
    }
    .modal.active { display: flex; }
    .modal .panel {
      background: white;
      padding: 32px;
      border-radius: 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 24px 80px rgba(0,0,0,0.1);
      border: 1px solid var(--border);
    }
    .favorites-list { 
      max-height: 400px; 
      overflow: auto; 
      border: 2px solid var(--border); 
      border-radius: 16px; 
      padding: 12px; 
      background: #fafdfc;
    }
    .favorites-list label { 
      font-weight: 500; 
      display: flex; 
      gap: 12px; 
      align-items: center; 
      margin: 0; 
      padding: 12px;
      border-radius: 12px;
      transition: background 0.2s;
    }
    .favorites-list label:hover { background: rgba(57, 197, 187, 0.1); }
    
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <header>
    <h1>B站收藏夹同步</h1>
    <button id="logoutBtn">退出系统</button>
  </header>
  <main>
    <section class="card">
      <h2>账号与同步</h2>
      <p class="muted">管理 Bilibili 账号及需同步的收藏夹。点击立即同步可唤醒后台任务队列。</p>
      <div class="row" style="margin-bottom: 20px;">
        <button id="addUserBtn">添加 B站账号</button>
        <button class="ghost" id="syncNowBtn">触发立即同步</button>
      </div>
      <div class="user-list" id="userList"></div>
    </section>

    <section class="card">
      <h2>全局设置</h2>
      <div class="settings-grid">
        <div>
          <label>轮询间隔 (分钟)</label>
          <input id="pollInterval" type="number" min="1" />
        </div>
        <div>
          <label>视频间延迟 (秒)</label>
          <input id="delaySeconds" type="number" min="0" />
        </div>
        
        <div class="settings-group">
          <div class="settings-group-title">Rclone 云盘设置</div>
        </div>
        <div class="field-full">
          <label>Rclone 目标节点 (Remote)</label>
          <select id="rcloneDest">
            <option value="">(手动输入或等待加载)</option>
          </select>
          <input id="rcloneDestManual" type="text" placeholder="如果下拉没找到，可手动输入，例如: my_s3:bili-backup" style="margin-top: 8px;" />
        </div>
        <div class="field-full">
          <label>上传目录结构</label>
          <select id="uploadLayout">
            <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
            <option value="folder-video">收藏夹名 / 视频</option>
            <option value="video-only">仅视频文件</option>
          </select>
        </div>
        <div class="field-full">
          <label>Rclone Web UI 地址</label>
          <input id="rcloneWebUrl" type="text" />
        </div>

        <div class="settings-group">
          <div class="settings-group-title">下载控制 (BBDown)</div>
        </div>
        <div>
          <label>视频编码</label>
          <select id="bbdownEncoding">
            <option value="">自动 (默认)</option>
            <option value="HEVC">HEVC (H.265)</option>
            <option value="AVC">AVC (H.264)</option>
            <option value="AV1">AV1</option>
          </select>
        </div>
        <div>
          <label>最高画质</label>
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

        <div class="settings-group">
          <div class="settings-group-title">任务队列与重试</div>
        </div>
        <div>
          <label>失败重试次数</label>
          <input id="maxRetries" type="number" min="0" />
        </div>
        <div>
          <label>重试间隔 (秒)</label>
          <input id="retryDelaySeconds" type="number" min="1" />
        </div>
        <div>
          <label>同时下载并发数</label>
          <input id="concurrentDownloads" type="number" min="1" max="5" />
        </div>
        <div>
          <label>同时上传并发数</label>
          <input id="concurrentUploads" type="number" min="1" max="10" />
        </div>
      </div>

      <div class="row" style="margin-top: 24px;">
        <button id="saveConfigBtn">保存设置并生效</button>
        <a id="openRcloneBtn" class="ghost" target="_blank">打开 Rclone 面板</a>
      </div>
      <div class="muted" id="configStatus" style="margin-top: 12px; color: var(--accent);"></div>
    </section>
  </main>

  <div class="modal" id="loginModal">
    <div class="panel">
      <h2>扫码登录</h2>
      <p class="muted">请使用B站APP扫描二维码登录（TV端接口）。</p>
      <div style="text-align: center; margin: 24px 0;">
        <img id="loginQr" alt="QR" style="width: 200px; height: 200px; border-radius: 16px; border: 4px solid var(--border);" />
      </div>
      <div id="loginStatus" class="muted" style="text-align: center; font-weight: 500; font-size: 16px;"></div>
      <div class="row" style="margin-top: 24px; justify-content: center;">
        <button id="closeLoginBtn" class="ghost" style="width: 100%;">取消登录</button>
      </div>
    </div>
  </div>

  <div class="modal" id="favoritesModal">
    <div class="panel">
      <h2>选择同步收藏夹</h2>
      <p class="muted">勾选你需要自动备份的收藏夹。</p>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="row" style="margin-top: 24px;">
        <button id="saveFavoritesBtn" style="flex: 1;">保存选择</button>
        <button id="closeFavoritesBtn" class="ghost" style="flex: 1;">取消</button>
      </div>
      <div class="muted" id="favoritesStatus" style="margin-top: 12px; text-align: center;"></div>
    </div>
  </div>

  <script>
    const userListEl = document.getElementById('userList');
    const addUserBtn = document.getElementById('addUserBtn');
    const syncNowBtn = document.getElementById('syncNowBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const configStatus = document.getElementById('configStatus');
    const openRcloneBtn = document.getElementById('openRcloneBtn');

    const loginModal = document.getElementById('loginModal');
    const loginQr = document.getElementById('loginQr');
    const loginStatus = document.getElementById('loginStatus');
    const closeLoginBtn = document.getElementById('closeLoginBtn');

    const favoritesModal = document.getElementById('favoritesModal');
    const favoritesList = document.getElementById('favoritesList');
    const saveFavoritesBtn = document.getElementById('saveFavoritesBtn');
    const closeFavoritesBtn = document.getElementById('closeFavoritesBtn');
    const favoritesStatus = document.getElementById('favoritesStatus');

    let currentLoginId = null;
    let favoritesUserId = null;

    async function fetchJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || '请求失败');
      }
      return data.data;
    }

    async function loadRemotes(currentDest) {
      const select = document.getElementById('rcloneDest');
      try {
        const remotes = await fetchJson('/api/rclone/remotes');
        select.innerHTML = '<option value="">(选择节点)</option>';
        let found = false;
        remotes.forEach(remote => {
          const opt = document.createElement('option');
          opt.value = remote;
          opt.textContent = remote;
          if (currentDest && currentDest.startsWith(remote)) {
            opt.selected = true;
            found = true;
          }
          select.appendChild(opt);
        });
        
        // If there's a destination but it doesn't match the remote exactly (e.g. it has a subfolder)
        // we put the whole thing in the manual input
        if (currentDest) {
          document.getElementById('rcloneDestManual').value = currentDest;
        }
      } catch (e) {
        console.error('Failed to load remotes:', e);
      }
    }

    // When dropdown changes, update manual input
    document.getElementById('rcloneDest').addEventListener('change', (e) => {
      if (e.target.value) {
        document.getElementById('rcloneDestManual').value = e.target.value + 'bili-backup/videos';
      }
    });

    async function loadConfig() {
      const data = await fetchJson('/api/config');
      document.getElementById('pollInterval').value = data.pollIntervalMinutes;
      document.getElementById('delaySeconds').value = data.perVideoDelaySeconds;
      document.getElementById('uploadLayout').value = data.uploadLayout;
      document.getElementById('rcloneWebUrl').value = data.rcloneWebUrl;
      
      document.getElementById('bbdownEncoding').value = data.bbdownEncoding || '';
      document.getElementById('bbdownQuality').value = data.bbdownQuality || '';
      document.getElementById('bbdownHiRes').checked = !!data.bbdownHiRes;
      document.getElementById('bbdownDolby').checked = !!data.bbdownDolby;
      
      document.getElementById('maxRetries').value = data.maxRetries ?? 3;
      document.getElementById('retryDelaySeconds').value = data.retryDelaySeconds ?? 5;
      document.getElementById('concurrentDownloads').value = data.concurrentDownloads ?? 1;
      document.getElementById('concurrentUploads').value = data.concurrentUploads ?? 2;

      openRcloneBtn.href = data.rcloneWebUrl;
      await loadRemotes(data.rcloneDestination);
    }

    async function loadUsers() {
      const users = await fetchJson('/api/users');
      userListEl.innerHTML = '';
      users.forEach((user) => {
        const item = document.createElement('div');
        item.className = 'user-item';
        item.innerHTML =
          '<strong style="font-size: 16px; color: var(--accent);">' + user.name + '</strong>' +
          '<div class="muted" style="margin:0;">UID: ' + user.uid + ' | 备份文件夹: ' + user.favoritesCount + '</div>' +
          '<div class="row" style="margin-top: 4px;">' +
            '<button data-action="favorites" data-id="' + user.id + '">选择收藏夹</button>' +
            '<button class="ghost" data-action="toggle" data-id="' + user.id + '">' +
              (user.enabled ? '暂停同步' : '恢复同步') +
            '</button>' +
            '<button class="ghost" style="border-color:#E57373; color:#E57373;" data-action="remove" data-id="' + user.id + '">删除账号</button>' +
          '</div>';
        userListEl.appendChild(item);
      });
    }

    async function startLogin() {
      loginStatus.textContent = '等待扫码...';
      const data = await fetchJson('/api/users/login/start', { method: 'POST' });
      currentLoginId = data.loginId;
      loginQr.src = data.qrDataUrl;
      loginModal.classList.add('active');
      pollLoginStatus();
    }

    async function pollLoginStatus() {
      if (!currentLoginId) return;
      try {
        const res = await fetch('/api/users/login/status?loginId=' + currentLoginId);
        const json = await res.json();
        
        if (!res.ok || !json.success) {
          loginStatus.textContent = json.message || '查询状态失败';
          currentLoginId = null;
          return;
        }

        const data = json.data;
        if (data.status === 'completed') {
          loginStatus.textContent = '登录成功！正在获取信息...';
          currentLoginId = null;
          setTimeout(() => {
            loginModal.classList.remove('active');
            loadUsers();
          }, 1000);
        } else if (data.status === 'error') {
          loginStatus.textContent = data.message || '登录异常';
          currentLoginId = null;
        } else {
          loginStatus.textContent = data.status === 'pending' ? '等待扫码并确认...' : data.status;
          setTimeout(pollLoginStatus, 1500);
        }
      } catch (error) {
        loginStatus.textContent = error.message;
        currentLoginId = null;
      }
    }

    async function openFavorites(userId) {
      favoritesUserId = userId;
      favoritesStatus.textContent = '';
      favoritesList.innerHTML = '';
      const data = await fetchJson('/api/users/' + userId + '/favorites');
      data.forEach((folder) => {
        const label = document.createElement('label');
        label.innerHTML =
          '<input type="checkbox" value="' + folder.mediaId + '" ' + (folder.selected ? 'checked' : '') + ' />' +
          folder.title + ' <span style="color:var(--muted);font-size:12px;">(' + folder.mediaCount + ' 视频)</span>';
        favoritesList.appendChild(label);
      });
      favoritesModal.classList.add('active');
    }

    async function saveFavorites() {
      saveFavoritesBtn.textContent = '保存中...';
      const selected = Array.from(favoritesList.querySelectorAll('input:checked')).map((input) => Number(input.value));
      await fetchJson('/api/users/' + favoritesUserId + '/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: selected })
      });
      saveFavoritesBtn.textContent = '保存选择';
      favoritesStatus.textContent = '已保存！';
      setTimeout(() => favoritesModal.classList.remove('active'), 500);
      await loadUsers();
    }

    async function saveConfig() {
      saveConfigBtn.textContent = '保存中...';
      configStatus.textContent = '';
      
      const rcloneDest = document.getElementById('rcloneDestManual').value.trim() 
                         || document.getElementById('rcloneDest').value.trim();

      const payload = {
        pollIntervalMinutes: Number(document.getElementById('pollInterval').value),
        perVideoDelaySeconds: Number(document.getElementById('delaySeconds').value),
        rcloneDestination: rcloneDest,
        uploadLayout: document.getElementById('uploadLayout').value,
        rcloneWebUrl: document.getElementById('rcloneWebUrl').value.trim(),
        
        bbdownEncoding: document.getElementById('bbdownEncoding').value,
        bbdownQuality: document.getElementById('bbdownQuality').value,
        bbdownHiRes: document.getElementById('bbdownHiRes').checked,
        bbdownDolby: document.getElementById('bbdownDolby').checked,

        maxRetries: Number(document.getElementById('maxRetries').value),
        retryDelaySeconds: Number(document.getElementById('retryDelaySeconds').value),
        concurrentDownloads: Number(document.getElementById('concurrentDownloads').value),
        concurrentUploads: Number(document.getElementById('concurrentUploads').value),
      };

      try {
        await fetchJson('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        configStatus.textContent = '设置已保存并生效！';
        openRcloneBtn.href = payload.rcloneWebUrl;
      } catch (e) {
        configStatus.textContent = '保存失败: ' + e.message;
        configStatus.style.color = '#E57373';
      } finally {
        saveConfigBtn.textContent = '保存设置并生效';
        setTimeout(() => {
          if(configStatus.style.color !== 'rgb(229, 115, 115)') configStatus.textContent = '';
        }, 3000);
      }
    }

    addUserBtn.addEventListener('click', startLogin);
    closeLoginBtn.addEventListener('click', () => {
      loginModal.classList.remove('active');
      currentLoginId = null;
    });

    saveFavoritesBtn.addEventListener('click', saveFavorites);
    closeFavoritesBtn.addEventListener('click', () => favoritesModal.classList.remove('active'));

    userListEl.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      const userId = target.dataset.id;
      if (!action || !userId) return;
      
      if (action === 'favorites') {
        await openFavorites(userId);
      }
      if (action === 'remove') {
        if(confirm('确定要删除这个账号吗？本地已经下载的视频不会被删除。')) {
          await fetchJson('/api/users/' + userId, { method: 'DELETE' });
          await loadUsers();
        }
      }
      if (action === 'toggle') {
        await fetchJson('/api/users/' + userId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toggle: true })
        });
        await loadUsers();
      }
    });

    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.textContent = '已触发';
      await fetchJson('/api/sync/now', { method: 'POST' });
      setTimeout(() => syncNowBtn.textContent = '触发立即同步', 2000);
    });

    logoutBtn.addEventListener('click', async () => {
      await fetchJson('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });

    saveConfigBtn.addEventListener('click', saveConfig);

    loadConfig();
    loadUsers();
  </script>
</body>
</html>`;
}
