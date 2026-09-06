import { test, expect } from "@playwright/test";

test("version dialog safely renders release notes, checks on demand and restores focus", async ({ page }) => {
  let calls = 0;
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await page.route("**/api/updates*", async r => {
    calls++;
    await r.fulfill({ json: { success: true, data: { comparison: "reference", checkedAt: new Date().toISOString(),
      release: { version: "v2.10.0", publishedAt: new Date().toISOString(), notes: '<img src=x onerror="alert(1)">\n修复说明\n' + "说明内容\n".repeat(30),
        url: "https://github.com/minori0721/Bili-favorites-backup/releases/tag/v2.10.0" } } } });
  });
  await page.goto("/");
  expect(calls).toBe(0);
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator("#updatesStatus")).toContainText("仅供参考");
  await expect(page.locator("#updatesNotes img")).toHaveCount(0);
  await expect(page.locator("#updatesNotes")).toContainText("<img");
  await page.locator("#checkUpdatesBtn").click();
  await expect.poll(() => calls).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const body = await page.locator('.updates-body').boundingBox();
  const title = await page.locator('#updatesModalTitle').boundingBox();
  const footer = await page.locator('#updatesModal .modal-actions').boundingBox();
  expect(body!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
  expect(body!.y + body!.height).toBeLessThanOrEqual(footer!.y + 1);
  await page.screenshot({ path: `output/updates-${test.info().project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("#versionInfoBtn")).toBeFocused();
});

test("failed version checks allow closing and reopening", async ({ page }) => {
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

test("an aborted update response cannot overwrite a reopened dialog", async ({ page }) => {
  let releaseOld!: () => void;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  let calls = 0;
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "" }));
  await page.route("**/api/updates*", async r => {
    const first = ++calls === 1;
    if (first) await gate;
    await r.fulfill({ json: { success: true, data: { error: first ? "旧响应" : "新响应", release: null } } }).catch(() => {});
  });
  await page.goto("/");
  await page.locator("#versionInfoBtn").click();
  await expect.poll(() => calls).toBe(1);
  await page.keyboard.press("Escape");
  await page.locator("#versionInfoBtn").click();
  await expect(page.locator("#updatesStatus")).toHaveText("新响应");
  releaseOld();
  await page.waitForTimeout(100);
  await expect(page.locator("#updatesStatus")).toHaveText("新响应");
});
