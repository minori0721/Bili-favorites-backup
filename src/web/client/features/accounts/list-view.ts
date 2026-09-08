import type { PublicAccount } from '../../../../shared/api/accounts.js';

export function renderAccountList(document: Document, el: HTMLElement, users: readonly PublicAccount[], formatDateTime: (value: string) => string) {
  const safeText = (value: unknown, fallback: string) => value == null || value === '' ? fallback : String(value);
      const fragment = document.createDocumentFragment();
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
        toggleBtn.dataset.enabled = String(Boolean(user.enabled));
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
        const health = user.authHealth;
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
        fragment.appendChild(item);
      });
      el.replaceChildren(fragment);

}
