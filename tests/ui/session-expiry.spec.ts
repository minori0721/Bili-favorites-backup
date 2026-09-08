import {test, expect} from '@playwright/test';

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
