import { test, expect } from "@playwright/test";
import { renderReleaseNotes } from '../../src/release-notes.js';
import { appInfo } from '../../src/app-info.js';

test('update refresh cooldown is visible, expires, and survives closing without late timers', { tag: '@desktop-only' }, async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  let calls = 0;
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await page.route('**/api/updates*', r => {
    calls++;
    return r.fulfill({ json: { success: true, data: { release: null, comparison: 'reference',
      nextRefreshAt: new Date(now + 60_000).toISOString() } } });
  });
  await page.goto('/');
  await page.locator('#versionInfoBtn').click();
  const button = page.locator('#checkUpdatesBtn');
  await expect(button).toBeDisabled();
  await expect(button).toContainText('秒后可重新检查');
  await button.dispatchEvent('click');
  expect(calls).toBe(1);
  await page.locator('#closeUpdatesBtn').click();
  await page.locator('#versionInfoBtn').click();
  await expect(button).toBeDisabled();
  await page.clock.fastForward(60_000);
  await expect(button).toBeEnabled({ timeout: 6000 });
  await expect(button).toHaveText('检查更新');
  await button.click();
  await expect.poll(() => calls).toBe(3);
});

test('reopening during cooldown after a network failure still enables refresh when due', { tag: '@desktop-only' }, async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  let calls = 0;
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await page.route('**/api/updates*', r => ++calls === 1
    ? r.fulfill({ json: { success: true, data: { release: null, nextRefreshAt: new Date(now + 60_000).toISOString() } } })
    : r.fulfill({ status: 503, body: 'offline' }));
  await page.goto('/');
  await page.locator('#versionInfoBtn').click();
  await expect(page.locator('#checkUpdatesBtn')).toContainText('秒后可重新检查');
  await page.locator('#closeUpdatesBtn').click();
  await page.locator('#versionInfoBtn').click();
  await expect(page.locator('#updatesStatus')).toContainText('暂时无法');
  await page.clock.fastForward(60_000);
  await expect(page.locator('#checkUpdatesBtn')).toBeEnabled({ timeout: 6000 });
});

test("version dialog safely renders release notes, checks on demand and restores focus", async ({ page }) => {
  let calls = 0;
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await page.route("**/api/updates*", async r => {
    calls++;
    await r.fulfill({ json: { success: true, data: { comparison: "reference", checkedAt: new Date().toISOString(),
      release: { version: "v2.10.0", publishedAt: new Date().toISOString(), notes: '<img src=x onerror="alert(1)">\n修复说明\n' + "说明内容\n".repeat(30),
        notesHtml: renderReleaseNotes('### 修复说明\n\n- **状态修复**\n- `配置不变`\n\n<img src=x onerror="alert(1)">\n\n![图片](https://example.invalid/should-not-load.png)\n\n[危险](javascript:alert(1))\n\n' + '说明内容\n'.repeat(30)),
        url: "https://github.com/minori0721/Bili-favorites-backup/releases/tag/v2.10.0" } } } });
  });
  await page.goto("/");
  expect(calls).toBe(0);
  await expect(page.locator('#versionInfoBtn')).toHaveText(appInfo.versionLabel);
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator('#updatesModal .updates-body')).toContainText('当前运行：' + appInfo.versionLabel);
  await expect(page.locator("#updatesStatus")).toContainText("仅供参考");
  await expect(page.locator("#updatesNotes img")).toHaveCount(0);
  await expect(page.locator('#updatesNotes h3')).toHaveText('修复说明');
  await expect(page.locator('#updatesNotes strong')).toHaveText('状态修复');
  await expect(page.locator("#updatesNotes")).toContainText("<img");
  await page.locator("#checkUpdatesBtn").click();
  await expect.poll(() => calls).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  // Read all three rectangles in one frame; the shared reveal animation must
  // not turn separately sampled positions into a false overlap.
  const layout = await page.locator('#updatesModal').evaluate(modal => {
    const body = modal.querySelector('.updates-body')?.getBoundingClientRect();
    const title = modal.querySelector('#updatesModalTitle')?.getBoundingClientRect();
    const footer = modal.querySelector('.modal-actions')?.getBoundingClientRect();
    if (!body || !title || !footer) throw new Error('updates layout is incomplete');
    return {bodyTop: body.top, bodyBottom: body.bottom, titleBottom: title.bottom, footerTop: footer.top};
  });
  expect(layout.bodyTop).toBeGreaterThanOrEqual(layout.titleBottom - 1);
  expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerTop + 1);
  await page.screenshot({ path: `output/updates-${test.info().project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("#versionInfoBtn")).toBeFocused();
});

test("failed version checks allow closing and reopening", { tag: '@desktop-only' }, async ({ page }) => {
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await page.route("**/api/updates*", r => r.fulfill({ status: 503, body: "offline" }));
  await page.goto("/");
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator("#updatesStatus")).toContainText("暂时无法");
  await page.locator("#closeUpdatesBtn").click();
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator("#checkUpdatesBtn")).toBeEnabled();
});

test("an aborted update response cannot overwrite a reopened dialog", { tag: '@desktop-only' }, async ({ page }) => {
  let releaseOld!: () => void;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  let finishOld!: () => void;
  const oldFinished = new Promise<void>(resolve => { finishOld = resolve; });
  let calls = 0;
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await page.route("**/api/updates*", async r => {
    const first = ++calls === 1;
    if (first) await gate;
    try {
      await r.fulfill({ json: { success: true, data: { error: first ? "旧响应" : "新响应", release: null } } });
    } catch (error) {
      if (!first) throw error; // Closing the first dialog intentionally cancels this route.
    } finally {
      if (first) finishOld();
    }
  });
  await page.goto("/");
  await page.locator("#versionInfoBtn").click();
  await expect.poll(() => calls).toBe(1);
  await page.keyboard.press("Escape");
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator("#updatesStatus")).toHaveText("新响应");
  releaseOld();
  await oldFinished;
  await expect(page.locator("#updatesStatus")).toHaveText("新响应");
});

test('empty notes, truncation and cached failures remain distinguishable', { tag: '@desktop-only' }, async ({ page }) => {
  let calls = 0;
  await page.request.post('/__test/reset');
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  await page.route('**/api/updates*', async r => {
    calls++;
    await r.fulfill({ json: { success: true, data: {
      error: calls > 1 ? 'GitHub查询已限流，请稍后重试' : null, comparison: 'reference', checkedAt: '2026-09-06T00:00:00Z',
      release: { version: 'v2.5.4', publishedAt: '2026-09-06T00:00:00Z', notes: '', notesHtml: '', truncated: calls > 1,
        changelogUrl: 'https://github.com/minori0721/Bili-favorites-backup/blob/v2.5.4/CHANGELOG.md' },
    } } });
  });
  await page.goto('/');
  await page.locator('#versionInfoBtn').click();
  await expect(page.locator('#updatesNotes')).toContainText('未填写发布说明');
  await expect(page.locator('#updatesTruncated')).toBeHidden();
  await expect(page.locator('#updatesChangelogLink')).toHaveAttribute('href', /blob\/v2.5.4\/CHANGELOG.md$/);
  await page.locator('#checkUpdatesBtn').click();
  await expect(page.locator('#updatesStatus')).toContainText('已限流');
  await expect(page.locator('#updatesTime')).toContainText('缓存结果');
  await expect(page.locator('#updatesTruncated')).toBeVisible();
});
