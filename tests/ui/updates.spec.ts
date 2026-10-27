import {chooseSetting,revealControl} from './workspace-navigation.js';
import { test, expect } from '@playwright/test';
import { renderReleaseNotes } from '../../src/release-notes.js';
import { updatesFixture } from '../fixtures/updates.js';

async function fonts(page: import('@playwright/test').Page) {
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
}

test('updates announce once, retain a badge, switch notes and channels, and restore focus', async ({ page }) => {
  await page.request.post('/__test/reset', { data: { updatesMode: 'both' } });
  await fonts(page);
  await page.goto('/?page=accounts');
  await page.bringToFront();
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
  await expect(page.locator('.toast-message')).toContainText('有新的版本');
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesLicenseLink')).toHaveAttribute('href', /^https:\/\/github\.com\/minori0721\/Bili-favorites-backup\/blob\/(?:dev|[a-f0-9]{7,40})\/THIRD_PARTY_NOTICES\.md$/);
  await expect(page.locator('#updatesLicenseLink')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('#updatesNotes')).toContainText('更新提示仅出现一次');
  await expect(page.locator('#updatesNotes')).toContainText('累计范围：v2.6.5');
  await expect(page.locator('#updatesNotes')).toContainText('只归档选中的视频');
  await expect(page.locator('#updatesNotes')).toContainText('统一主题');
  await expect(page.locator('#updatesNotes')).toContainText('旧请求不能覆盖新账号');
  await expect(page.locator('#updatesLatestVersion')).toContainText('bbbbbbb');
  await (await revealControl(page,page.locator('#updatesCurrentTab'))).click();
  await expect(page.locator('#updatesNotes')).toContainText('当前镜像保留自己的说明');
  await expect(page.locator('#updatesStatus')).not.toContainText('正在检查');
  await page.keyboard.press('Home');
  await expect(page.locator('#updatesLatestTab')).toBeFocused();
  await expect(page.locator('#updatesLatestTab')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.locator('#updatesCurrentTab')).toBeFocused();
  await expect(page.locator('#updatesCurrentTab')).toHaveAttribute('aria-selected', 'true');
  await (await revealControl(page,page.locator('#updatesLatestTab'))).click();
  await page.locator('#updatesChannel').selectOption('stable');
  await expect(page.locator('#updatesStatus')).toContainText('更新 dev 镜像不会自动切换');
  await expect(page.locator('#updatesNotes')).toContainText('正式版发布摘要');
  await page.locator('#updatesChannel').selectOption('dev');
  await expect(page.locator('#updatesNotes')).toContainText('更新提示仅出现一次');
  const layout = await page.locator('#updatesModal').evaluate(modal => {
    const body = modal.querySelector('.updates-body')!.getBoundingClientRect();
    const title = modal.querySelector('#updatesModalTitle')!.getBoundingClientRect();
    const footer = modal.querySelector('.modal-actions')!.getBoundingClientRect();
    const style = (selector: string) => getComputedStyle(modal.querySelector(selector)!);
    return { top: body.top, bottom: body.bottom, title: title.bottom, footer: footer.top, overflow: document.documentElement.scrollWidth - innerWidth,
      background: style('.panel').backgroundColor, titleBackground: style('#updatesModalTitle').backgroundColor,
      footerBackground: style('.modal-actions').backgroundColor, closeBackground: style('#closeUpdatesBtn').backgroundColor,
      linkBackground: style('#updatesReleaseLink').backgroundColor, titleColor: style('#updatesModalTitle').color };
  });
  expect(layout.top).toBeGreaterThanOrEqual(layout.title - 1);
  expect(layout.bottom).toBeLessThanOrEqual(layout.footer + 1);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.background).toBe('rgb(238, 250, 248)');
  expect(layout.titleBackground).toBe('rgb(249, 253, 253)');
  expect(layout.footerBackground).toBe(layout.titleBackground);
  expect(layout.closeBackground).toBe('rgb(255, 255, 255)');
  expect(layout.linkBackground).toBe(layout.closeBackground);
  expect(layout.titleColor).toBe('rgb(36, 118, 111)');
  await page.screenshot({ path: `work/updates-${test.info().project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(page.locator('#versionInfoBtn')).toBeFocused();
  await page.reload();
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
  await expect(page.locator('.toast-message')).toHaveCount(0);
});

test('cooldown survives reopening without duplicate checks or late timers', { tag: '@desktop-only' }, async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await fonts(page);
  let calls = 0;
  await page.route('**/api/updates*', r => {
    calls++;
    return r.fulfill({ json: { success: true, data: { ...updatesFixture('current', now), nextRefreshAt: new Date(now + 60000).toISOString() } } });
  });
  await page.goto('/?page=accounts');
  await expect.poll(() => calls).toBe(1);
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  const button = page.locator('#checkUpdatesBtn');
  await expect(button).toContainText('秒后可重新检查');
  await button.dispatchEvent('click');
  expect(calls).toBe(1);
  await (await revealControl(page,page.locator('#closeUpdatesBtn'))).click();
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(button).toBeDisabled();
  await page.clock.fastForward(60000);
  await expect(button).toBeEnabled();
  await (await revealControl(page,button)).click();
  await expect.poll(() => calls).toBe(2);
});

test('cooldown still expires after a failed refresh and failure survives reopening', { tag: '@desktop-only' }, async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await fonts(page);
  let calls = 0;
  await page.route('**/api/updates*', r => ++calls === 1
    ? r.fulfill({ json: { success: true, data: { ...updatesFixture('current', now), nextRefreshAt: new Date(now + 60000).toISOString() } } })
    : r.fulfill({ status: 503, body: 'offline' }));
  await page.goto('/?page=accounts');
  await expect.poll(() => calls).toBe(1);
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await page.clock.fastForward(60000);
  await (await revealControl(page,page.locator('#checkUpdatesBtn'))).click();
  await expect(page.locator('#updatesStatus')).toContainText('暂时无法');
  await (await revealControl(page,page.locator('#closeUpdatesBtn'))).click();
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesStatus')).toContainText('暂时无法');
  await expect(page.locator('#checkUpdatesBtn')).toBeEnabled();
});

test('release Markdown remains safe, empty notes and cached failures remain distinct', { tag: '@desktop-only' }, async ({ page }) => {
  await fonts(page);
  let calls = 0;
  await page.route('**/api/updates*', r => {
    const data = updatesFixture('dev-update');
    const release = data.channels.dev!.release!;
    release.notes = '<img src=x onerror="alert(1)">';
    release.notesHtml = renderReleaseNotes('### 修复说明\n\n- **状态修复**\n\n<img src=x onerror="alert(1)">\n\n![图片](https://example.invalid/not-loaded.png)\n\n[危险](javascript:alert(1))');
    if (++calls > 1) {
      release.notes = ''; release.notesHtml = ''; release.truncated = true;
      data.channels.dev!.error = 'GitHub查询已限流，请稍后重试';
      data.channels.dev!.comparison = 'unknown';
    }
    return r.fulfill({ json: { success: true, data } });
  });
  await page.goto('/?page=accounts');
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesNotes img')).toHaveCount(0);
  await expect(page.locator('#updatesNotes strong')).toHaveText('状态修复');
  await expect(page.locator('#updatesNotes')).toContainText('<img');
  await (await revealControl(page,page.locator('#checkUpdatesBtn'))).click();
  await expect(page.locator('#updatesNotes')).toContainText('未填写发布说明');
  await expect(page.locator('#updatesTime')).toContainText('缓存结果');
  await expect(page.locator('#updatesStatus')).toContainText('已限流');
  await expect(page.locator('#updatesTruncated')).toBeVisible();
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
});

test('failed checks allow closing and reopening, and malformed DTOs do not become no-update claims', { tag: '@desktop-only' }, async ({ page }) => {
  await fonts(page);
  await page.route('**/api/updates*', r => r.fulfill({ json: { success: true, data: { channels: {} } } }));
  await page.goto('/?page=accounts');
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesStatus')).toContainText('暂时无法');
  await expect(page.locator('#updateAvailableBtn')).toBeHidden();
  await (await revealControl(page,page.locator('#closeUpdatesBtn'))).click();
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#checkUpdatesBtn')).toBeEnabled();
});

test('aborted responses cannot overwrite a reopened version dialog', { tag: '@desktop-only' }, async ({ page }) => {
  let releaseOld!: () => void, finishOld!: () => void;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  const completed = new Promise<void>(resolve => { finishOld = resolve; });
  let calls = 0;
  await fonts(page);
  await page.route('**/api/updates*', async r => {
    const first = ++calls === 1;
    if (first) await gate;
    const data = updatesFixture('current');
    data.channels.dev!.error = first ? '旧响应' : '新响应';
    try { await r.fulfill({ json: { success: true, data } }); }
    catch (error) { if (!first) throw error; }
    finally { if (first) finishOld(); }
  });
  await page.goto('/?page=accounts');
  await expect.poll(() => calls).toBe(1);
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await page.keyboard.press('Escape');
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesStatus')).toHaveText('新响应');
  releaseOld(); await completed;
  await expect(page.locator('#updatesStatus')).toHaveText('新响应');
});

test('automatic checks pause while hidden and notify only for the latest new build', { tag: '@desktop-only' }, async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await fonts(page);
  let calls = 0;
  await page.route('**/api/updates*', r => {
    const data = updatesFixture('dev-update', now);
    if (++calls > 1) {
      data.notification!.id = 'dev:' + 'c'.repeat(40);
      data.channels.dev!.release!.revision = 'c'.repeat(40);
    }
    return r.fulfill({ json: { success: true, data } });
  });
  await page.goto('/?page=accounts');
  await page.bringToFront();
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(31 * 60000);
  expect(calls).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => calls).toBe(2);
  await (await revealControl(page,page.locator('#versionInfoBtn'))).click();
  await expect(page.locator('#updatesLatestVersion')).toContainText('ccccccc');
});

test('formal availability is distinct from stable updates and checking never installs anything', { tag: '@desktop-only' }, async ({ page }) => {
  await fonts(page);
  await page.request.post('/__test/reset', { data: { updatesMode: 'stable-available' } });
  await page.goto('/?page=accounts');
  await expect(page.locator('#updateAvailableBtn')).toHaveAttribute('data-kind', 'stable_available');
  await (await revealControl(page,page.locator('#updateAvailableBtn'))).click();
  await expect(page.locator('#updatesChannel')).toHaveValue('stable');
  await expect(page.locator('#updatesStatus')).toContainText('切换镜像标签');
  await (await revealControl(page,page.locator('#closeUpdatesBtn'))).click();
  await page.request.post('/__test/reset', { data: { updatesMode: 'stable-update' } });
  await page.reload();
  await (await revealControl(page,page.locator('#updateAvailableBtn'))).click();
  await expect(page.locator('#updatesChannelRow')).toBeHidden();
  await expect(page.locator('#updatesStatus')).toContainText('有新的正式版');
  const response = await page.request.get('/__test/state');
  const state = await response.json();
  expect(state.syncNowCount).toBe(0);
  expect(state.manualArchiveCount).toBe(0);
});

test('after an installed update current notes open once and newer-release controls remain available', async ({ page }) => {
  await page.request.post('/__test/reset',{data:{installedVersionChanged:true,updatesMode:'both'}});
  await fonts(page);await page.goto('/?page=overview');await page.bringToFront();
  await expect(page.locator('#updatesModal')).toBeVisible();
  await expect(page.locator('#updatesCurrentTab')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#updatesNotes')).toContainText('当前镜像保留自己的说明');
  await expect(page.locator('#updatesStatus')).not.toContainText('正在检查');
  await expect(page.locator('#updateAvailableBtn')).toBeVisible();
  await expect.poll(async()=>(await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(1);
  await page.locator('#closeUpdatesBtn').click();await expect(page.locator('#updatesModal')).toBeHidden();
  await page.reload();await expect(page.locator('#updatesRunning')).toContainText(updatesFixture().current.version);
  await expect(page.locator('#updatesModal')).toBeHidden();
  await page.locator('#versionInfoBtn').click();await expect(page.locator('#updatesModal')).toBeVisible();
  expect((await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(1);
});

test('first installation gets the interface guide without an installed-version popup', async ({ page }) => {
  await page.request.post('/__test/reset',{data:{onboardingNewInstall:true,installedVersionChanged:true}});
  await fonts(page);await page.goto('/?page=overview');await page.bringToFront();
  await expect(page.locator('.driver-popover-title')).toHaveText('账号与收藏夹');
  await expect(page.locator('#updatesModal')).toBeHidden();
  await page.getByRole('button',{name:'退出引导',exact:true}).click();
  await expect.poll(async()=>(await(await page.request.get('/__test/state')).json()).onboardingSeenCount).toBe(1);
  await page.reload();await expect(page.locator('#updatesRunning')).toContainText(updatesFixture().current.version);
  await expect(page.locator('#updatesModal')).toBeHidden();
  expect((await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(0);
});

test('a slow update response does not interrupt an existing settings draft and manual reading acknowledges it', async ({ page }) => {
  await page.request.post('/__test/reset',{data:{installedVersionChanged:true}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/updates',async route=>{await gate;await route.continue();});
  await fonts(page);await page.goto('/?page=overview');
  await chooseSetting(page,'同步节奏');await page.locator('#pollInterval').fill('19');
  const response=page.waitForResponse('**/api/updates');release();await(await response).finished();
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page.locator('#updatesModal')).toBeHidden();
  expect((await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(0);
  await page.locator('#versionInfoBtn').click();await expect(page.locator('#updatesCurrentTab')).toHaveAttribute('aria-selected','true');
  await expect.poll(async()=>(await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(1);
  await page.locator('#closeUpdatesBtn').click();await expect(page.locator('#pollInterval')).toHaveValue('19');
});

test('opening the version window before its data arrives still acknowledges displayed current notes', async ({ page }) => {
  await page.request.post('/__test/reset',{data:{installedVersionChanged:true}});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/updates',async route=>{await gate;await route.continue();});
  await fonts(page);await page.goto('/?view=updates');await expect(page.locator('#updatesModal')).toBeVisible();
  release();await expect(page.locator('#updatesNotes')).toContainText('当前镜像保留自己的说明');
  await expect.poll(async()=>(await(await page.request.get('/__test/state')).json()).installedNoticeSeenCount).toBe(1);
});
