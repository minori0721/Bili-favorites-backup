export function renderLoginPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站收藏夹同步</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    :root {
      color-scheme: light;
      --bg: #f6f1e7;
      --panel: #ffffff;
      --accent: #007a6b;
      --accent-2: #ffb347;
      --ink: #1f2a26;
      --muted: #6a6f6c;
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", sans-serif;
      background: radial-gradient(circle at top, #ffe0b2 0%, var(--bg) 55%);
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
      border-radius: 16px;
      padding: 32px;
      box-shadow: var(--shadow);
      animation: fadeUp 0.6s ease;
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 24px; color: var(--muted); }
    label { display: block; font-weight: 600; margin: 0 0 6px; }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid #d4d1c9;
      margin-bottom: 16px;
      font-size: 14px;
    }
    button {
      width: 100%;
      padding: 12px 16px;
      border: none;
      border-radius: 12px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .error { color: #c13b2a; margin-top: 12px; min-height: 20px; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>B站收藏夹同步</h1>
    <p>请登录以管理您的B站同步任务。</p>
    <label>用户名</label>
    <input id="username" type="text" autocomplete="username" />
    <label>密码</label>
    <input id="password" type="password" autocomplete="current-password" />
    <button id="loginBtn">登录</button>
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
        errorEl.textContent = data.message || '登录失败';
      }
    });
  </script>
</body>
</html>`;
}

export function renderAppPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站收藏夹同步</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap');
    :root {
      color-scheme: light;
      --bg: #f0f4ef;
      --panel: #ffffff;
      --accent: #005f5a;
      --accent-2: #ffb347;
      --ink: #1b2624;
      --muted: #66736e;
      --border: #d9e0dc;
      --shadow: 0 18px 45px rgba(0, 0, 0, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", sans-serif;
      background: radial-gradient(circle at top left, #dff7f0 0%, var(--bg) 45%);
      color: var(--ink);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px 32px;
    }
    header h1 { margin: 0; font-size: 24px; }
    header button {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 8px 16px;
      cursor: pointer;
      font-weight: 600;
    }
    main {
      padding: 0 32px 40px;
      display: grid;
      gap: 24px;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    .card {
      background: var(--panel);
      border-radius: 18px;
      padding: 20px;
      box-shadow: var(--shadow);
      animation: fadeUp 0.6s ease;
    }
    .card h2 { margin: 0 0 12px; font-size: 18px; }
    .muted { color: var(--muted); }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row button, .row a {
      border: none;
      background: var(--accent);
      color: white;
      padding: 8px 14px;
      border-radius: 10px;
      cursor: pointer;
      text-decoration: none;
      font-weight: 600;
    }
    .row .ghost {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
    }
    .user-list { display: grid; gap: 12px; }
    .user-item {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      display: grid;
      gap: 6px;
    }
    label { display: block; font-weight: 600; margin: 12px 0 6px; }
    input, select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      font-size: 14px;
    }
    .modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal.active { display: flex; }
    .modal .panel {
      background: white;
      padding: 24px;
      border-radius: 16px;
      max-width: 420px;
      width: 100%;
      box-shadow: var(--shadow);
    }
    .favorites-list { max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
    .favorites-list label { font-weight: 400; display: flex; gap: 8px; align-items: center; margin: 8px 0; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <header>
  <header>
    <h1>B站收藏夹同步</h1>
    <button id="logoutBtn">退出登录</button>
  </header>
  <main>
    <section class="card">
      <h2>账号管理</h2>
      <p class="muted">管理B站账号及同步的收藏夹。</p>
      <div class="row">
        <button id="addUserBtn">添加B站账号</button>
        <button class="ghost" id="syncNowBtn">立即同步</button>
      </div>
      <div class="user-list" id="userList"></div>
    </section>

    <section class="card">
      <h2>设置</h2>
      <label>轮询间隔 (分钟)</label>
      <input id="pollInterval" type="number" min="1" />
      <label>视频间延迟 (秒)</label>
      <input id="delaySeconds" type="number" min="0" />
      <label>Rclone 目标路径</label>
      <input id="rcloneDest" type="text" placeholder="例如: my_s3:bili-backup/videos" />
      <label>上传目录结构</label>
      <select id="uploadLayout">
        <option value="user-folder-video">用户名 / 收藏夹名 / 视频</option>
        <option value="folder-video">收藏夹名 / 视频</option>
        <option value="video-only">仅视频文件</option>
      </select>
      <label>Rclone Web UI 地址</label>
      <input id="rcloneWebUrl" type="text" />
      <div class="row" style="margin-top: 12px;">
        <button id="saveConfigBtn">保存设置</button>
        <a id="openRcloneBtn" class="ghost" target="_blank">打开 Rclone UI</a>
      </div>
      <div class="muted" id="configStatus"></div>
    </section>
  </main>

  <div class="modal" id="loginModal">
    <div class="panel">
      <h2>扫码登录</h2>
      <p class="muted">请使用B站APP扫描二维码。</p>
      <img id="loginQr" alt="QR" style="width: 200px; height: 200px;" />
      <div id="loginStatus" class="muted"></div>
      <div class="row" style="margin-top: 12px;">
        <button id="closeLoginBtn" class="ghost">关闭</button>
      </div>
    </div>
  </div>

  <div class="modal" id="favoritesModal">
    <div class="panel">
      <h2>选择同步收藏夹</h2>
      <div class="favorites-list" id="favoritesList"></div>
      <div class="row" style="margin-top: 12px;">
        <button id="saveFavoritesBtn">保存</button>
        <button id="closeFavoritesBtn" class="ghost">取消</button>
      </div>
      <div class="muted" id="favoritesStatus"></div>
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

    async function loadConfig() {
      const data = await fetchJson('/api/config');
      document.getElementById('pollInterval').value = data.pollIntervalMinutes;
      document.getElementById('delaySeconds').value = data.perVideoDelaySeconds;
      document.getElementById('rcloneDest').value = data.rcloneDestination;
      document.getElementById('uploadLayout').value = data.uploadLayout;
      
      let webUrl = data.rcloneWebUrl;
      if (webUrl.includes('localhost') || webUrl.includes('127.0.0.1')) {
        const portMatch = webUrl.match(/:(\\d+)/);
        const port = portMatch ? portMatch[1] : '5572';
        webUrl = window.location.protocol + '//' + window.location.hostname + ':' + port;
      }
      
      document.getElementById('rcloneWebUrl').value = webUrl;
      openRcloneBtn.href = webUrl;
    }

    async function loadUsers() {
      const users = await fetchJson('/api/users');
      userListEl.innerHTML = '';
      users.forEach((user) => {
        const item = document.createElement('div');
        item.className = 'user-item';
        item.innerHTML =
          '<strong>' + user.name + '</strong>' +
          '<div class="muted">UID: ' + user.uid + ' | 已选收藏夹: ' + user.favoritesCount + '</div>' +
          '<div class="row">' +
            '<button data-action="favorites" data-id="' + user.id + '">选择收藏夹</button>' +
            '<button class="ghost" data-action="toggle" data-id="' + user.id + '">' +
              (user.enabled ? '停用' : '启用') +
            '</button>' +
            '<button class="ghost" data-action="remove" data-id="' + user.id + '">删除</button>' +
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
        
        // Handle server 404 or other errors gracefully
        if (!res.ok || !json.success) {
          loginStatus.textContent = json.message || '查询状态失败';
          currentLoginId = null;
          return;
        }

        const data = json.data;
        if (data.status === 'completed') {
          loginStatus.textContent = '登录成功！';
          currentLoginId = null;
          loginModal.classList.remove('active');
          await loadUsers();
        } else if (data.status === 'error') {
          loginStatus.textContent = data.message || '登录异常';
          currentLoginId = null;
        } else {
          loginStatus.textContent = data.status === 'pending' ? '等待扫码...' : data.status;
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
          folder.title + ' (' + folder.mediaCount + ')';
        favoritesList.appendChild(label);
      });
      favoritesModal.classList.add('active');
    }

    async function saveFavorites() {
      const selected = Array.from(favoritesList.querySelectorAll('input:checked')).map((input) => Number(input.value));
      await fetchJson('/api/users/' + favoritesUserId + '/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: selected })
      });
      favoritesStatus.textContent = '已保存';
      favoritesModal.classList.remove('active');
      await loadUsers();
    }

    async function saveConfig() {
      configStatus.textContent = '';
      const payload = {
        pollIntervalMinutes: Number(document.getElementById('pollInterval').value),
        perVideoDelaySeconds: Number(document.getElementById('delaySeconds').value),
        rcloneDestination: document.getElementById('rcloneDest').value.trim(),
        uploadLayout: document.getElementById('uploadLayout').value,
        rcloneWebUrl: document.getElementById('rcloneWebUrl').value.trim()
      };
      await fetchJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      configStatus.textContent = '已保存';
      openRcloneBtn.href = payload.rcloneWebUrl;
    }

    addUserBtn.addEventListener('click', startLogin);
    closeLoginBtn.addEventListener('click', () => {
      loginModal.classList.remove('active');
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
        await fetchJson('/api/users/' + userId, { method: 'DELETE' });
        await loadUsers();
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
      await fetchJson('/api/sync/now', { method: 'POST' });
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
