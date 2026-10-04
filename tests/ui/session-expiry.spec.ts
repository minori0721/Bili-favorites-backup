import {test, expect} from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
});

test('update requests share session expiry while 503 remains a retryable failure', async ({page}) => {
  await page.request.post('/__test/reset');
  let status = 503;
  await page.route('**/api/updates*',route=>route.fulfill({status,contentType:'text/html',body:'unavailable'}));
  await page.goto('/');
  await page.locator('#versionInfoBtn').click();
  await expect(page.locator('#updatesStatus')).toContainText('暂时无法');
  await expect(page.locator('#sessionExpiredDialog')).toHaveCount(0);
  status = 401;
  await page.locator('#closeUpdatesBtn').click();
  await page.locator('#versionInfoBtn').click();
  await expect(page.locator('#sessionExpiredDialog')).toBeVisible();
  await expect(page.locator('#updatesModal')).not.toBeVisible();
});

test('log stream reconnects after an interrupted connection and a 503 session check', async ({page}) => {
  await page.request.post('/__test/reset');
  await page.clock.install();
  let release!: () => void;
  const interrupted = new Promise<void>(resolve => { release = resolve; });
  let streams = 0, checks = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/logs/stream', async route => {
    streams++;
    if (streams === 1) {
      await interrupted;
      await route.fulfill({status: 503, body: 'temporarily unavailable'});
      return;
    }
    await route.fulfill({status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({level: 'info', timestamp: '', summary: '隔离日志连接已恢复', raw: 'isolated reconnect', simpleVisible: true})}\n\n`});
  });
  await page.goto('/');
  await expect(page.locator('.user-item')).toHaveCount(1);
  await page.locator('#logSimpleBtn').click();
  // Board polling is stopped, so this is the log feed's protected session check.
  await page.route('**/api/queue/state', async route => {
    checks++;
    if (checks === 1) await route.fulfill({status: 503, json: {success: false, message: 'temporary session check failure'}});
    else await route.continue();
  });
  release();
  await expect.poll(() => checks).toBe(1);
  await expect(page.locator('#sessionExpiredDialog')).toHaveCount(0);
  await page.clock.fastForward(4000);
  await expect(page.locator('#logConsole')).toContainText('隔离日志连接已恢复');
  expect(streams).toBe(2);
  expect(errors).toEqual([]);
});

test('expired session stops application work and shows one accessible login entry', async ({page}) => {
  await page.request.post('/__test/reset');
  await page.goto('/');
  await expect(page.locator('.user-item')).toHaveCount(1);
  let requests = 0;
  await page.route('**/api/**', async route => {
    requests++;
    await route.fulfill({status:401,contentType:'text/html',body:'expired'});
  });
  // Start another protected request using existing page controls.
  await page.locator('#logSimpleBtn').click();
  await page.locator('#logQueueBtn').click();
  const dialog = page.locator('#sessionExpiredDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('link',{name:'重新登录'})).toBeFocused();
  await expect(dialog.getByRole('link')).toHaveAttribute('href','/login');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const settled = requests;
  await page.evaluate(() => {window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(11000);
  expect(requests).toBe(settled);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
