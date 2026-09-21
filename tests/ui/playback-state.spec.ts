import { expect, test } from '@playwright/test';

// Exercise the application through the vendor and DOM boundaries; no internal app functions are exposed.
const playerAdapter = `window.Artplayer = class {
  constructor(options) {
    this.video = document.createElement('video');
    this.video.dataset.url = options.url;
    options.container.appendChild(this.video);
    this.currentTime = 15; this.duration = 120; this.volume = 0.5; this.muted = false; this.playbackRate = 1;
  }
  on(name, callback) { this.video.addEventListener('fixture:' + name, callback); return this; }
  destroy() { this.video.dataset.destroyed = 'true'; this.video.remove(); }
  play() { return Promise.resolve(); }
  pause() {}
};`;

test('player falls back once and ignores events from a released instance', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/assets/vendor/artplayer-5.4.0.js', route => route.fulfill({ contentType: 'application/javascript', body: playerAdapter }));
  const items = ['BV1ALPHA001', 'BV1BETA002'].map((bvid, index) => ({
    bvid, title: 'Fixture ' + (index ? 'B' : 'A'), upperName: 'UP', queuePosition: index + 1,
    source: { userId: 'user-1', mediaId: 101 },
    parts: [{ fileId: index + 1, pageIndex: 1, label: '正片', fingerprint: bvid, streamUrl: '/fixture-media/' + bvid, codec: 'avc1' }],
  }));
  await page.route('**/api/archive-library/playback-queue?**', route => route.fulfill({ json: { success: true, data: {
    mode: 'library' as const, page: 1, pageSize: 50, total: 2, focusIndex: 0, hasMore: false, items,
  } } }));
  await page.route('**/playback/delivery/**', route => route.fulfill({ json: { success: true, data: { status: 'direct' as const } } }));
  await page.goto('/');
  await page.locator('#archiveLibraryBtn').click();
  if (info.project.name !== 'desktop') await page.locator('.archive-nav-item[data-archive-scope="global"]').click();
  const open = page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main');
  await open.click();
  const video = page.locator('#playbackArt video');
  await expect(video).toHaveCount(1);
  const original = await video.elementHandle();
  expect(original).not.toBeNull();
  await original!.evaluate(element => {
    Object.defineProperty(element, 'error', { value: { code: 2 } });
    element.dispatchEvent(new Event('fixture:video:error'));
    element.dispatchEvent(new Event('fixture:video:error'));
  });
  await expect(video).toHaveAttribute('data-url', /delivery=proxy/);
  expect(await original!.getAttribute('data-destroyed')).toBe('true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#playbackModal')).not.toHaveClass(/active/);
  await open.click();
  await expect(video).toHaveCount(1);
  const currentUrl = await video.getAttribute('data-url');
  await original!.evaluate(element => {
    element.dispatchEvent(new Event('fixture:video:ended'));
    element.dispatchEvent(new Event('fixture:video:error'));
    element.dispatchEvent(new Event('fixture:video:volumechange'));
  });
  await expect(video).toHaveAttribute('data-url', currentUrl!);
  await expect(page.locator('#playbackNowTitle')).toHaveText('Fixture A');
  await page.keyboard.press('Escape');
  await expect(video).toHaveCount(0);
  expect(errors).toEqual([]);
});
