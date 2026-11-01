import { test, expect } from '@playwright/test';
import { revealControl } from './workspace-navigation.js';

test('transfer speed settings save independently and remain inside the settings page', async ({ page }, testInfo) => {
  await page.request.post('/__test/reset', { data: {} });
  await page.goto('/?page=settings');
  const download = page.locator('#downloadLimitMBps');
  const upload = page.locator('#uploadLimitMBps');
  await revealControl(page, download);
  await expect(download).toHaveValue('0');
  await expect(upload).toHaveValue('0');
  await download.fill('2.5'); await upload.fill('0.75');
  await upload.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.screenshot({ path: `work/transfer-validation/settings-${testInfo.project.name}.png`, scale: 'css' });
  await expect(page.locator('#uploadLimitHint')).toContainText('存储服务的服务端上传限速');
  const request = page.waitForRequest(r => r.method() === 'PUT' && new URL(r.url()).pathname === '/api/config');
  await (await revealControl(page, page.locator('#saveConfigBtn'))).click();
  const payload = (await request).postDataJSON();
  expect(payload.downloadLimitMBps).toBe(2.5); expect(payload.uploadLimitMBps).toBe(0.75);
  await expect(page.locator('#settingsDraftStatus')).toHaveText('已保存');
  await page.reload(); await revealControl(page, download);
  await expect(download).toHaveValue('2.5'); await expect(upload).toHaveValue('0.75');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('old config responses default to unlimited and malformed rate fields fail visibly', async ({ page }) => {
  await page.request.post('/__test/reset', { data: {} });
  await page.route('**/api/config', async route => {
    const response = await route.fetch(), body = await response.json();
    delete body.data.downloadLimitMBps; delete body.data.uploadLimitMBps;
    await route.fulfill({ json: body });
  });
  await page.goto('/?page=settings');
  await revealControl(page, page.locator('#downloadLimitMBps'));
  await expect(page.locator('#downloadLimitMBps')).toHaveValue('0');
  await expect(page.locator('#uploadLimitMBps')).toHaveValue('0');
  await page.unroute('**/api/config');
  await page.route('**/api/config', async route => {
    const response = await route.fetch(), body = await response.json(); body.data.uploadLimitMBps = -1;
    await route.fulfill({ json: body });
  });
  await page.reload();
  await expect(page.locator('#configStatus')).toContainText('uploadLimitMBps');
  await expect(page.locator('#saveConfigBtn')).toBeDisabled();
});
