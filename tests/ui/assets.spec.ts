import { expect, test } from '@playwright/test';

test('production scripts and styles arrive as gzip and initialize the existing UI', {tag:'@desktop-only'}, async ({page}) => {
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route => route.fulfill({body:''}));
  const encodings = new Map<string,string|undefined>();
  page.on('response', response => {
    if (/\/assets\/app\/app-[A-Z0-9]+\.(js|css)$/.test(new URL(response.url()).pathname)) {
      encodings.set(response.url().endsWith('.js') ? 'script' : 'style',response.headers()['content-encoding']);
    }
  });
  await page.goto('/');
  await expect(page.locator('#upHomeList .up-subscription-card')).toHaveCount(3);
  await expect(page.locator('#appAssetError')).not.toBeVisible();
  expect(encodings.get('script')).toBe('gzip');expect(encodings.get('style')).toBe('gzip');
});

test('slow application script preserves the board first paint without exposing logs', async ({page},testInfo) => {
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**',route => route.fulfill({body:''}));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/app/*.js',async route => { await pending; await route.continue(); });
  await page.goto('/',{waitUntil:'commit'});
  try {
    await expect(page.locator('#queueBoard')).toBeVisible();
    await expect(page.locator('#queueBoard [data-queue-column]')).toHaveCount(4);
    await expect(page.locator('#logConsole')).not.toBeVisible();
    await expect(page.locator('#logQueueBtn')).toHaveClass(/active/);
  } finally { release(); }
  await expect(page.locator('.user-item')).toHaveCount(1);
  await expect(page.locator('#appAssetError')).not.toBeVisible();
  await page.screenshot({path:testInfo.outputPath('first-viewport.png')});
});

for (const extension of ['js','css']) {
  test(`failed application ${extension} exposes a manual refresh without a reload loop`, async ({page}) => {
    let requests = 0;
    await page.route(`**/assets/app/*.${extension}`,route => { requests += 1; return route.abort(); });
    await page.goto('/');
    await expect(page.locator('#appAssetError')).toBeVisible();
    await expect(page.locator('#appAssetError button')).toHaveText('刷新页面');
    await page.waitForTimeout(200);
    expect(requests).toBe(1);
  });
}
