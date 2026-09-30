import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
});

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await expect(page.locator('.user-item')).toHaveCount(1);
}

async function openArchive(page: Page) {
  await page.locator('#archiveLibraryBtn').click();
  const directory = page.locator('.archive-nav-item[data-archive-scope="global"]');
  await directory.waitFor();
  // On phones the directory layer is the entry point; desktop already exposes the list.
  if (await directory.isVisible()) await directory.click();
  await expect(page.locator('#archiveLibraryGrid .archive-library-card')).toHaveCount(2);
}

test('settings keep dirty state accurate for fields, template tags and encoding order', async ({ page }) => {
  await boot(page);
  await page.locator('#pollInterval').fill('6');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await page.locator('#pollInterval').fill('5');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await page.locator('#namingSettings > summary').click();
  await page.locator('#templateTags .template-tag').filter({hasText:'UP主'}).click();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await page.locator('#selectedTags .template-tag').filter({hasText:'UP主'}).locator('.remove-x').click();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await page.locator('#downloadSettings > summary').click();
  await page.locator('#bbdownEncodingPriorityEditor').getByRole('button', {name:'下移 HEVC',exact:true}).click();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await page.locator('#bbdownEncodingPriorityEditor').getByRole('button', {name:'上移 HEVC',exact:true}).click();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
});

test('first settings read blocks edits until the current response is applied', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/config', async route => { await gate; await route.continue(); });
  await page.goto('/');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('正在读取…');
  await expect(page.locator('#saveConfigBtn')).toBeDisabled();
  await expect(page.locator('.settings-fold').first()).toHaveAttribute('inert','');
  release();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await expect(page.locator('.settings-fold').first()).not.toHaveAttribute('inert','');
});

test('field focus stays inside clipped settings groups without changing control size', async ({ page }) => {
  await boot(page);
  await page.locator('#storageSettings > summary').click();
  for (const selector of ['#pollInterval', '#alistUrl', '#playbackDeliveryMode']) {
    const control = page.locator(selector);
    const before = await control.boundingBox();
    await control.focus();
    await control.press('ArrowLeft');
    await expect(control).toBeFocused();
    const style = await control.evaluate(element => {
      const computed = getComputedStyle(element);
      return {
        visible: element.matches(':focus-visible'),
        outlineWidth: parseFloat(computed.outlineWidth),
        outlineOffset: parseFloat(computed.outlineOffset),
        shadows: computed.boxShadow.split(/,(?![^(]*\))/).map(shadow => shadow.trim()),
      };
    });
    expect(style.visible).toBe(true);
    expect(style.outlineWidth).toBeGreaterThan(0);
    expect(style.outlineOffset).toBeLessThanOrEqual(-style.outlineWidth);
    expect(style.shadows.every(shadow => shadow.includes('inset'))).toBe(true);
    const after = await control.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
  }
});

test('save acknowledges only submitted values, deduplicates clicks and keeps confirmation visible', async ({ page }) => {
  await boot(page);
  let writes = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/config', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    await gate;
    await route.fulfill({json:{success:true,data:{}}});
  });
  await page.locator('#pollInterval').fill('6');
  const save = page.locator('#saveConfigBtn');
  const width = await save.evaluate(button => button.getBoundingClientRect().width);
  await save.click();
  await expect(save).toHaveAttribute('aria-busy','true');
  expect(await save.evaluate(button => button.getBoundingClientRect().width)).toBeCloseTo(width, 0);
  await save.dispatchEvent('click');
  await page.locator('#pollInterval').fill('7');
  release();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await expect(page.locator('#configStatus')).toContainText('还有新的修改未保存');
  expect(writes).toBe(1);
  await save.click();
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await expect(page.locator('#configStatus')).toHaveText('设置已保存。');
  await page.waitForTimeout(3300);
  await expect(page.locator('#configStatus')).toHaveText('设置已保存。');
  await page.locator('#pollInterval').fill('8');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await expect(page.locator('#configStatus')).toBeEmpty();
});

test('failed save retains edits and does not expand unrelated settings groups', async ({ page }) => {
  await boot(page);
  await page.route('**/api/config', route => route.request().method() === 'PUT'
    ? route.fulfill({status:503,json:{success:false,message:'模拟保存暂不可用'}}) : route.continue());
  await page.locator('#pollInterval').fill('6');
  await page.locator('#saveConfigBtn').click();
  await expect(page.locator('#configStatus')).toContainText('保存失败');
  await expect(page.locator('#settingsDraftStatus')).toHaveText('有未保存修改');
  await expect(page.locator('#pollInterval')).toHaveValue('6');
  await expect(page.locator('#storageSettings')).not.toHaveAttribute('open');
  await expect(page.locator('#queueSettings')).not.toHaveAttribute('open');
  await expect(page.locator('#saveConfigBtn')).toBeEnabled();
});

test('account refresh preserves width and focus while respecting a later focus change', async ({ page }) => {
  await boot(page);
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/users/user-1/refresh-info', async route => { await gate; await route.continue(); });
  const refresh = page.locator('button[data-action="refresh_info"]');
  const width = await refresh.evaluate(button => button.getBoundingClientRect().width);
  await refresh.click();
  await expect(refresh).toHaveText('刷新中…');
  expect(await refresh.evaluate(button => button.getBoundingClientRect().width)).toBeCloseTo(width, 0);
  release();
  await expect(refresh).toHaveText('刷新信息');
  await expect(refresh).toBeFocused();
  gate = new Promise<void>(resolve => { release = resolve; });
  await refresh.click();
  await expect(refresh).toHaveText('刷新中…');
  await page.locator('#pollInterval').focus();
  release();
  await expect(refresh).toHaveText('刷新信息');
  await expect(page.locator('#pollInterval')).toBeFocused();
});

test('archive refresh reports progress at the top, retains old cards and retries the failed query', async ({ page }) => {
  await boot(page);
  await openArchive(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/archive-library/items?**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query !== 'retry-example') return route.continue();
    requests++;
    if (requests === 1) {
      await gate;
      await route.fulfill({json:{success:false,message:'模拟读取失败'}});
    } else await route.continue();
  });
  await page.locator('#archiveLibrarySearchInput').fill('retry-example');
  await expect(page.locator('#archiveLibraryNotice')).toContainText('正在更新');
  await expect(page.locator('#archiveLibraryResults')).toHaveAttribute('inert','');
  await expect(page.locator('#archiveLibraryGrid .archive-library-card')).toHaveCount(2);
  release();
  await expect(page.locator('#archiveLibraryNotice')).toContainText('加载失败');
  await expect(page.locator('#archiveLibraryResults')).not.toHaveAttribute('inert','');
  await page.locator('#archiveLibraryNotice').getByRole('button',{name:'重试'}).click();
  await expect(page.locator('#archiveLibraryNotice')).toBeHidden();
  await expect(page.locator('#archiveLibrarySearchInput')).toHaveValue('retry-example');
  expect(requests).toBe(2);
});

test('online first load uses placeholders and exposes retry above the results', async ({ page }) => {
  await boot(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/online-content/items?**', async route => {
    requests++;
    if (requests === 1) {
      await gate;
      await route.fulfill({json:{success:false,message:'模拟在线内容读取失败'}});
    } else await route.continue();
  });
  await page.locator('#onlineContentBtn').click();
  await expect(page.locator('#onlineContentNotice')).toContainText('正在更新');
  await expect(page.locator('#onlineContentGrid .content-skeleton-card')).toHaveCount(4);
  release();
  await expect(page.locator('#onlineContentNotice')).toContainText('模拟在线内容读取失败');
  await expect(page.locator('#onlineContentGrid .content-skeleton-card')).toHaveCount(0);
  await page.locator('#onlineContentNotice').getByRole('button',{name:'重试'}).click();
  await expect(page.locator('#onlineContentGrid .online-content-card')).toHaveCount(1);
  await expect(page.locator('#onlineContentNotice')).toBeHidden();
});

test('phone controls provide full touch targets and keep retained filtering usable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'touch-device coverage');
  await boot(page);
  const helpRect = await page.locator('#settingsHelpBtn').boundingBox();
  expect(helpRect?.width).toBeGreaterThanOrEqual(44);
  expect(helpRect?.height).toBeGreaterThanOrEqual(44);
  await openArchive(page);
  const moreRect = await page.locator('.archive-library-card-more').first().boundingBox();
  expect(moreRect?.width).toBeGreaterThanOrEqual(44);
  expect(moreRect?.height).toBeGreaterThanOrEqual(44);
  const retained = page.getByRole('button',{name:'「留存」',exact:true});
  const filterRect = await retained.boundingBox();
  expect(filterRect?.height).toBeGreaterThanOrEqual(44);
  await retained.tap();
  await expect(retained).toHaveAttribute('aria-pressed','true');
  await expect(retained).not.toHaveAttribute('title');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
