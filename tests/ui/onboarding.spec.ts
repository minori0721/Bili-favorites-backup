import { expect, test, type Page } from '@playwright/test';
import { chooseSetting, navigate } from './workspace-navigation.js';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.request.post('/__test/reset', { data: { archiveActionPreview: true } });
});
async function boot(page: Page) {
  await page.goto('/?page=overview');
  await expect(page.locator('#workspaceSubscriptions')).toHaveText('3');
}
async function openSetup(page: Page) {
  await page.getByRole('button', { name: '开始配置', exact: true }).click();
  await expect(page.locator('.onboarding-setup')).toBeVisible();
}
async function exitGuide(page:Page){
  await expect(page.locator('.bfb-onboarding-popover')).toBeVisible();
  await page.getByRole('button',{name:'退出引导',exact:true}).click();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await expect(page.locator('#onboardingHelpBtn')).toBeFocused();
}
async function assertPopoverFits(page: Page) {
  await expect.poll(async () => page.locator('.bfb-onboarding-popover').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('first-visit invitation is optional, remembered and available again from help', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.onboarding-welcome')).toBeVisible();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '稍后再说' }).click();
  await expect(page.locator('.onboarding-welcome')).toBeHidden();
  await page.reload();
  await expect(page.locator('#workspaceSubscriptions')).toHaveText('3');
  await expect(page.locator('.onboarding-welcome')).toBeHidden();
  await page.getByRole('button', { name: '使用引导', exact: true }).click();
  await expect(page.locator('.onboarding-welcome')).toBeVisible();
  await expect(page.locator('.onboarding-setup')).toBeVisible();
});

test('four-step guide fits the viewport, supports back and finish, and submits nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  await page.getByRole('button', { name: '认识界面' }).click();
  const popover = page.locator('.bfb-onboarding-popover');
  for (const [index, title] of ['账号与收藏夹', '按 UP 订阅投稿', '查看进度与待处理事项', '在归档库查看结果'].entries()) {
    await expect(popover.locator('.driver-popover-title')).toHaveText(title);
    await expect(popover.locator('.driver-popover-progress-text')).toHaveText(`${index + 1} / 4`);
    await assertPopoverFits(page);
    if (index === 1) {
      await popover.getByRole('button', { name: '上一步' }).click();
      await expect(popover.locator('.driver-popover-title')).toHaveText('账号与收藏夹');
      await popover.getByRole('button', { name: '下一步' }).click();
      await expect(popover.locator('.driver-popover-title')).toHaveText(title);
    }
    await popover.getByRole('button', { name: index === 3 ? '知道了' : '下一步' }).click();
  }
  await expect(popover).toHaveCount(0);
  await expect(page.locator('#onboardingHelpBtn')).toBeFocused();
  const state = await (await page.request.get('/__test/state')).json();
  expect(state.syncNowCount).toBe(0);
  expect(state.loginStartCount).toBe(0);
  expect(state.storageCheckCount).toBe(0);
  expect(state.savedConfig).toBeNull();
  expect(errors).toEqual([]);
});

test('escape restores normal navigation and the guide cannot activate the highlighted action', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('.bfb-onboarding-popover')).toBeVisible();
  const accounts = page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '账号', exact: true });
  await accounts.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-workspace-current', 'overview');
  await page.keyboard.press('Escape');
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await navigate(page, 'accounts');
  await expect(page.locator('#userList')).toBeVisible();
});

test('checklist reflects real reads, a read-only check and invalidation after editing', async ({ page }) => {
  await boot(page);
  await openSetup(page);
  expect((await page.getByRole('button', { name: '收起', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(44);
  await expect(page.locator('#onboardingAccountStatus')).toContainText('已添加 1 个账号');
  await expect(page.locator('#onboardingSourceStatus')).toHaveText('已启用 1 个收藏夹、2 个 UP 订阅');
  await expect(page.locator('#onboardingStorageStatus')).toHaveText('尚未检查当前连接');
  await page.getByRole('button', { name: '去设置', exact: true }).click();
  await expect(page.locator('.driver-popover-title')).toHaveText('填写内部通信地址');
  await exitGuide(page);
  await expect(page.locator('#storageCheckBtn')).toBeVisible();
  await page.locator('#storageCheckBtn').click();
  await expect(page.locator('#storageCheckStatus')).toContainText('只读连接正常');
  await navigate(page, 'overview');
  await expect(page.locator('#onboardingStorageStatus')).toHaveText('当前表单的只读连接检查通过');
  await expect(page.locator('#onboardingStorageStatus')).toHaveAttribute('data-tone', 'success');
  await page.getByRole('button', { name: '去设置', exact: true }).click();
  await exitGuide(page);
  await page.locator('#alistDest').fill('/changed-onboarding-draft');
  await navigate(page, 'overview');
  await expect(page.locator('#onboardingStorageStatus')).toHaveText('尚未检查当前连接');
  const state = await (await page.request.get('/__test/state')).json();
  expect(state.storageCheckCount).toBe(1);
  expect(state.savedConfig).toBeNull();
  expect(state.syncNowCount).toBe(0);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('/changed-onboarding-draft');
});

test('late storage result cannot validate a newly edited form', async ({ page }) => {
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/storage/check', async route => {
    await response;
    await route.fulfill({ json: { success: true, data: { ok: true, title: '旧检查', message: '旧结果' } } });
  });
  await boot(page); await openSetup(page);
  await page.getByRole('button', { name: '去设置', exact: true }).click();
  await exitGuide(page);
  await page.locator('#storageCheckBtn').click();
  await expect(page.locator('#storageCheckStatus')).toContainText('正在执行只读');
  await page.locator('#alistDest').fill('/new-draft');
  release();
  await navigate(page, 'overview');
  await expect(page.locator('#onboardingStorageStatus')).toHaveText('尚未检查当前连接');
  await page.getByRole('button', { name: '去设置', exact: true }).click();
  await exitGuide(page);
  await expect(page.locator('#storageCheckStatus')).not.toContainText('旧结果');
});

test('failed prerequisite reads stay unknown instead of reporting empty or complete', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { archiveActionPreview: true, usersErrorOnce: true, configErrorOnce: true } });
  await boot(page); await openSetup(page);
  await expect(page.locator('#onboardingAccountStatus')).toContainText('读取失败');
  await expect(page.locator('#onboardingSourceStatus')).toContainText('读取失败');
  await expect(page.locator('#onboardingStorageStatus')).toContainText('尚未读取');
  await page.getByRole('button', { name: '管理账号', exact: true }).click();
  await page.locator('#userListStatus').getByRole('button', { name: '重试' }).click();
  await expect(page.locator('#userList')).toContainText('测试账号');
  await navigate(page, 'overview');
  await expect(page.locator('#onboardingAccountStatus')).toContainText('已添加 1 个账号');
});

test('empty installation can still choose an initial source and add an account', async ({ page }) => {
  await page.route('**/api/users', route => route.fulfill({ json: { success: true, data: [] } }));
  await page.route('**/api/up-subscriptions', route => route.fulfill({ json: { success: true, data: { items: [], accounts: [] } } }));
  await page.goto('/?page=overview');
  await page.getByRole('button', { name: '开始配置', exact: true }).click();
  await expect(page.locator('#onboardingAccountStatus')).toHaveText('还没有添加账号');
  await expect(page.locator('#onboardingSourceStatus')).toHaveText('还没有启用收藏夹或 UP 订阅');
  await page.getByRole('button', { name: '选择来源', exact: true }).click();
  await page.locator('#onboardingSourceChoices [data-onboarding="subscriptions"]').click();
  await expect(page.locator('.driver-popover-title')).toHaveText('先添加 B站账号');
  await expect(page.locator('#addUserBtn')).toBeVisible();
  await exitGuide(page);
  await navigate(page, 'overview');
  await page.getByRole('button', { name: '管理账号', exact: true }).click();
  await expect(page.locator('#addUserBtn')).toBeVisible();
});

test('guide entry returns from the library without losing a settings draft', async ({ page }) => {
  await boot(page);
  await chooseSetting(page, '同步节奏');
  await page.locator('#pollInterval').fill('19');
  await navigate(page, 'library');
  await expect(page.locator('#archiveLibraryModal')).toBeVisible();
  await page.locator('#onboardingHelpBtn').click();
  await expect(page.locator('.onboarding-setup')).toBeVisible();
  await expect(page.locator('#archiveLibraryModal')).toBeHidden();
  await chooseSetting(page, '同步节奏');
  await expect(page.locator('#pollInterval')).toHaveValue('19');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
});

test('suspension releases the overlay and repeated restoration does not duplicate onboarding', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('.bfb-onboarding-popover')).toBeVisible();
  await page.evaluate(() => { dispatchEvent(new Event('pagehide')); dispatchEvent(new Event('pageshow')); dispatchEvent(new Event('pageshow')); });
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await expect(page.locator('.onboarding-welcome')).toHaveCount(1);
  await expect(page.locator('.onboarding-setup')).toHaveCount(1);
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('.bfb-onboarding-popover')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('reduced motion and unavailable browser storage keep the guide usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Unavailable', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Unavailable', 'SecurityError'); };
  });
  await boot(page);
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('body')).toHaveClass(/driver-simple/);
  await assertPopoverFits(page);
  await page.getByRole('button', { name: '退出引导', exact: true }).click();
  await expect(page.locator('.onboarding-welcome')).toBeHidden();
  await page.locator('#onboardingHelpBtn').click();
  await expect(page.locator('.onboarding-welcome')).toBeVisible();
});

test('a new installation starts once and completion applies to another browser', async ({ page, browser }) => {
  await page.request.post('/__test/reset', { data: { onboardingNewInstall: true } });
  await page.addInitScript(() => localStorage.setItem('bfb:onboarding:v1', 'seen'));
  await page.goto('/?page=overview');
  await expect(page.locator('.driver-popover-title')).toHaveText('账号与收藏夹');
  await exitGuide(page);
  await expect.poll(async () => (await (await page.request.get('/__test/state')).json()).onboardingSeenCount).toBe(1);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const second = await context.newPage();
    await second.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await second.goto('/?page=overview');
    await expect(second.locator('#onboardingAccountStatus')).toHaveText('还没有添加账号');
    await expect(second.locator('.driver-overlay')).toHaveCount(0);
    expect((await (await second.request.get('/api/onboarding')).json()).data.autoStart).toBe(false);
  } finally { await context.close(); }
});

test('a delayed installation check respects navigation and an early skip', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { onboardingNewInstall: true } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/onboarding', async route => { await gate; await route.continue(); });
  await page.goto('/?page=overview');
  await page.getByRole('button', { name: '稍后再说' }).click();
  await navigate(page, 'accounts');
  release();
  await expect.poll(async () => (await (await page.request.get('/__test/state')).json()).onboardingSeenCount).toBe(1);
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-workspace-current', 'accounts');
});

test('invalid installation status cannot trigger an automatic tour', async ({ page }) => {
  await page.route('**/api/onboarding', route => route.fulfill({ json: { success: true, data: { autoStart: 'true' } } }));
  await boot(page);
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('.driver-popover-title')).toHaveText('账号与收藏夹');
  await exitGuide(page);
});

test('late installation status does not interrupt keyboard navigation', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { onboardingNewInstall: true } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/onboarding', async route => { await gate; await route.continue(); });
  await page.goto('/?page=overview');
  await expect(page.locator('#onboardingAccountStatus')).toHaveText('还没有添加账号');
  await page.keyboard.press('Tab');
  const response = page.waitForResponse('**/api/onboarding');
  release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  expect((await (await page.request.get('/api/onboarding')).json()).data.autoStart).toBe(true);
  await page.locator('#onboardingHelpBtn').click();
  await page.getByRole('button', { name: '认识界面' }).click();
  await expect(page.locator('.driver-popover-title')).toHaveText('账号与收藏夹');
  await exitGuide(page);
});

test('help and setup headings stay below the app header with consistent spacing', async ({ page }) => {
  await boot(page);
  await page.locator('#onboardingHelpBtn').click();
  await expect.poll(async () => page.locator('.onboarding-welcome').evaluate(node => {
    const top = node.getBoundingClientRect().top;
    return top >= document.querySelector('.workspace-app-header')!.getBoundingClientRect().bottom && top < innerHeight;
  })).toBe(true);
  await openSetup(page);
  await expect.poll(async () => page.locator('.onboarding-setup').evaluate(node => {
    const top = node.getBoundingClientRect().top;
    return Math.abs(top - document.querySelector('.workspace-app-header')!.getBoundingClientRect().bottom - 16) < 3;
  })).toBe(true);
  await expect(page.locator('#onboardingSetupTitle')).toBeFocused();
  const gap = await page.locator('.onboarding-setup').evaluate(node => getComputedStyle(node).marginBottom);
  expect(gap).toBe(page.viewportSize()!.width <= 720 ? '16px' : '24px');
});

test('storage guide follows real controls and never checks or saves on next', async ({ page }) => {
  await boot(page); await openSetup(page);
  await page.getByRole('button', { name: '去设置', exact: true }).click();
  const fields = ['alistUrl','alistUsername','alistPassword','alistDest','storageCheckBtn','saveConfigBtn'];
  for (const [index, id] of fields.entries()) {
    await expect(page.locator('#'+id)).toHaveClass(/driver-active-element/);
    await assertPopoverFits(page);
    await page.locator('.driver-popover-next-btn').click();
    if(index === fields.length-1)await expect(page.locator('.driver-overlay')).toHaveCount(0);
  }
  const state = await (await page.request.get('/__test/state')).json();
  expect(state.storageCheckCount).toBe(0);
  expect(state.savedConfig).toBeNull();
  expect(state.syncNowCount).toBe(0);
});

test('account guide pauses for a real favorites dialog and resumes after closing', async ({ page }) => {
  await boot(page); await openSetup(page);
  await page.getByRole('button', { name: '管理账号', exact: true }).click();
  await expect(page.locator('.driver-popover-title')).toHaveText('检查账号授权');
  await page.locator('.driver-popover-next-btn').click();
  await page.locator('#userList [data-action="favorites"]').click();
  await expect(page.locator('#favoritesModal')).toBeVisible();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await page.locator('#closeFavoritesBtn').click();
  await expect(page.locator('.driver-popover-title')).toHaveText('检查账号授权');
  await exitGuide(page);
});

test('source choices explicitly open UP setup or single-video archiving', async ({ page }) => {
  await boot(page); await openSetup(page);
  await page.getByRole('button', { name: '选择来源', exact: true }).click();
  await page.locator('#onboardingSourceChoices [data-onboarding="subscriptions"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-workspace-current', 'subscriptions');
  await expect(page.locator('.driver-popover-title')).toHaveText('添加 UP 订阅');
  await page.locator('#upAddBtn').click();
  await expect(page.locator('#upAddModal')).toBeVisible();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await page.locator('#upAddModal [data-up-close="upAddModal"]').click();
  await expect(page.locator('.driver-popover-title')).toHaveText('添加 UP 订阅');
  await exitGuide(page); await navigate(page, 'overview');
  await page.locator('#onboardingSourceChoices [data-onboarding="manual"]').click();
  await expect(page.locator('.driver-popover-title')).toHaveText('选择单个视频归档');
  await exitGuide(page);
  await expect(page.locator('#onboardingSourceStatus')).toHaveAttribute('data-tone', 'muted');
  await expect(page.locator('#onboardingSourceStatus')).toContainText('不需要设置自动来源');
});

test('missing fields and accounts are red while unchecked connections are amber', async ({ page }) => {
  await page.route('**/api/users', route => route.fulfill({ json: { success: true, data: [] } }));
  await page.route('**/api/up-subscriptions', route => route.fulfill({ json: { success: true, data: { items: [], accounts: [] } } }));
  await page.goto('/?page=overview'); await openSetup(page);
  await expect(page.locator('#onboardingAccountStatus')).toHaveAttribute('data-tone', 'danger');
  await expect(page.locator('#onboardingSourceStatus')).toHaveAttribute('data-tone', 'danger');
  await expect(page.locator('#onboardingStorageStatus')).toHaveAttribute('data-tone', 'warning');
  await page.getByRole('button', { name: '去设置', exact: true }).click(); await exitGuide(page);
  await page.locator('#alistDest').fill('');
  await expect(page.locator('#alistDest')).toHaveValue('');
  await expect(page.locator('#onboardingStorageStatus')).toHaveAttribute('data-tone', 'danger');
  await navigate(page, 'overview');
  await expect(page.locator('#alistDest')).toHaveValue('');
  await expect(page.locator('#onboardingStorageStatus')).toHaveAttribute('data-tone', 'danger');
  await expect(page.locator('#onboardingStorageStatus')).toHaveText('请先填写远端地址和归档目录');
});

test('paused accounts are amber and expired authorization is red', async ({ page }) => {
  let expired = false;
  await page.route('**/api/users', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.forEach((account: {enabled:boolean;authHealth:{needsManualLogin:boolean}}) => {
      account.enabled = expired;
      account.authHealth.needsManualLogin = expired;
    });
    await route.fulfill({ json: body });
  });
  await boot(page); await openSetup(page);
  await expect(page.locator('#onboardingAccountStatus')).toHaveAttribute('data-tone', 'warning');
  await expect(page.locator('#onboardingAccountStatus')).toHaveText('账号已暂停，请按需要启用');
  expired = true;
  await page.reload(); await openSetup(page);
  await expect(page.locator('#onboardingAccountStatus')).toHaveAttribute('data-tone', 'danger');
  await expect(page.locator('#onboardingAccountStatus')).toHaveText('账号需要更新授权');
});

for (const first of ['welcome','setup'] as const) test(`closing both guides offers the reusable help entry once: ${first} first`, async ({ page }) => {
  await boot(page);await openSetup(page);
  const closeWelcome=()=>page.getByRole('button',{name:'稍后再说',exact:true}).click();
  const closeSetup=()=>page.getByRole('button',{name:'收起',exact:true}).click();
  if(first==='welcome')await closeWelcome();else await closeSetup();
  await expect(page.locator(first==='welcome'?'.onboarding-welcome':'.onboarding-setup')).toBeHidden();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  if(first==='welcome')await closeSetup();else await closeWelcome();
  await expect(page.locator('.driver-popover-title')).toHaveText('随时可以重看');
  await expect(page.locator('#onboardingHelpBtn')).toHaveClass(/driver-active-element/);
  await expect(page.locator('.driver-popover-description')).toContainText('想看几遍都可以');
  await expect(page.locator('.bfb-onboarding-popover').getByRole('button',{name:'上一步'})).toBeHidden();
  await expect(page.locator('.onboarding-welcome')).toBeHidden();
  await expect(page.locator('.onboarding-setup')).toBeHidden();
  await assertPopoverFits(page);
  if(first==='welcome')await page.screenshot({path:`work/onboarding-reopen-${test.info().project.name}.png`});
  await page.locator('#onboardingHelpBtn').click();
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await expect(page.locator('.onboarding-welcome')).toBeVisible();
  await expect(page.locator('.onboarding-setup')).toBeVisible();
  await closeWelcome();await closeSetup();
  await expect(page.locator('.onboarding-setup')).toBeHidden();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await page.reload();await page.locator('#onboardingHelpBtn').click();
  await closeWelcome();await closeSetup();await expect(page.locator('.onboarding-setup')).toBeHidden();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  const state=await(await page.request.get('/__test/state')).json();
  expect(state.syncNowCount).toBe(0);expect(state.savedConfig).toBeNull();expect(state.loginStartCount).toBe(0);
});

test('reopen hint works with reduced motion and failed prerequisite reads', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.request.post('/__test/reset',{data:{archiveActionPreview:true,usersErrorOnce:true,configErrorOnce:true}});
  await boot(page);await openSetup(page);
  await page.getByRole('button',{name:'稍后再说',exact:true}).click();
  await page.getByRole('button',{name:'收起',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'随时可以重看',exact:true})).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/driver-simple/);
  await assertPopoverFits(page);await page.keyboard.press('Escape');
  await expect(page.locator('.driver-overlay')).toHaveCount(0);
  await navigate(page,'accounts');await expect(page.locator('#userListStatus').getByRole('button',{name:'重试'})).toBeVisible();
});
