import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, body: "" }));
  await page.goto("/");
  await expect(page.locator(".user-item")).toHaveCount(1);
});

test("archived unavailable cards do not claim background work and nested controls keep keyboard actions", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/videos/*/availability-recheck", async (route) => {
    requests += 1;
    await route.fulfill({ json: { success: true, data: {} } });
  });
  await page.evaluate(() => {
    const w = window as any;
    const item = { bvid: "BV1TEST00001", title: "已归档的失效视频", processed: true, unavailable: true,
      backupStatus: "verified", playback: { available: true, partCount: 1 },
      sourceAvailability: { state: "pending_confirmation", reason: "favorite_flag" } };
    document.getElementById("videoGrid")!.replaceChildren(w.renderVideoDetailItem(item));
    w.openModal("videoDetailModal");
    w.reviewPlaybackCount = 0;
    w.openArchivePlayback = () => { w.reviewPlaybackCount += 1; };
  });
  await expect(page.locator(".video-source-availability")).not.toContainText("正在后台复核");
  await expect(page.locator("#videoGrid .video-badge")).toHaveText("已归档 · 收藏夹显示失效");
  const button = page.locator(".video-source-availability button");
  for (const key of ["Enter", " "]) {
    await button.evaluate((el: HTMLButtonElement) => { el.disabled = false; });
    await button.focus();
    await button.press(key);
    await expect(button).toHaveText("已加入复核");
  }
  expect(requests).toBe(2);
  expect(await page.evaluate(() => (window as any).reviewPlaybackCount)).toBe(0);
  await page.locator("#videoGrid [data-playback-bvid]").focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).reviewPlaybackCount)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("source diagnostics name only explicit evidence and preserve archive playback", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [reason, label, state] of [
    ["under_review", "B站稿件审核中", "unknown"],
    ["uploader_only", "仅UP主自己可见", "unknown"],
    ["submission_invisible", "B站稿件不可见，具体原因未公开", "confirmed_unavailable"],
    ["api_not_found", "B站未找到该视频", "confirmed_unavailable"],
  ]) {
    await page.evaluate(({ reason, state }) => {
      const w = window as any;
      const item = { bvid: "BV1TEST00001", title: "源站状态测试", processed: true,
        backupStatus: "verified", playback: { available: true, partCount: 1 },
        sourceAvailability: { state, reason } };
      document.getElementById("videoGrid")!.replaceChildren(w.renderVideoDetailItem(item));
      w.openModal("videoDetailModal");
    }, { reason, state });
    await expect(page.locator(".video-source-availability")).toContainText(label);
    await expect(page.locator(".video-source-availability")).toContainText("已有归档和封面不受影响");
    await expect(page.locator(".video-source-availability")).not.toContainText("已删除");
    await expect(page.locator("#videoGrid [data-playback-bvid]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.evaluate(({ reason, state }) => (window as any).archiveStatusLabel({
      sourceAvailability: { reason, state }, playback: { available: false },
    }), { reason, state })).toBe(reason === "submission_invisible" ? "稿件不可见" : label);
  }
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 0");
  expect(errors).toEqual([]);
});

test("settings folds preserve unified save and reveal invalid hidden controls", async ({ page }) => {
  await expect(page.locator('#saveConfigBtn')).toBeEnabled();
  expect(await page.locator('body > main > .card h2').allTextContents()).toEqual(['账号与同步', '任务中心', '全局设置']);
  await expect(page.locator('.settings-fold')).toHaveCount(6);
  await expect(page.locator('#storageSettings')).not.toHaveAttribute('open');
  let writes = 0;
  let saved: any;
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes += 1;
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { success: true, data: {} } });
  });
  await page.locator('#concurrentDownloads').evaluate((el: HTMLInputElement) => { el.value = '0'; });
  await page.locator('#saveConfigBtn').click();
  await expect(page.locator('#queueSettings')).toHaveAttribute('open');
  await expect(page.locator('#concurrentDownloads')).toBeFocused();
  expect(writes).toBe(0);
  await page.locator('#concurrentDownloads').fill('2');
  await page.locator('#queueSettings > summary').click();
  await page.locator('#saveConfigBtn').click();
  await expect.poll(() => writes).toBe(1);
  expect(saved.concurrentDownloads).toBe(2);
  expect(saved.alistUrl).toBe('http://alist:5244');
  expect(saved.bbdownEncodingPriority).toHaveLength(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("a late migration response cannot restart polling after close", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.openModal("pathMigrationModal");
    w.reviewPollCount = 0;
    w.fetchJsonSilent = () => {
      w.reviewPollCount += 1;
      return new Promise((resolve) => { w.reviewRelease = resolve; });
    };
    w.reviewPending = w.refreshPathMigrationState();
    w.closeModal("pathMigrationModal");
  });
  await expect(page.locator("#pathMigrationModal")).not.toHaveClass(/active/);
  await page.evaluate(async () => {
    const w = window as any;
    w.reviewRelease({ id: "migration", status: "copying", entryCount: 2 });
    await w.reviewPending;
  });
  await page.waitForTimeout(1700);
  expect(await page.evaluate(() => (window as any).reviewPollCount)).toBe(1);
});

test("migration conflict details are paginated and recover from a failed page", async ({ page }) => {
  let fail = true;
  const offsets: number[] = [];
  await page.route("**/api/path-migration/items?**", async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 20 && fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { success: false, message: "暂时无法读取" } });
      return;
    }
    await route.fulfill({ json: { success: true, data: Array.from({ length: offset ? 1 : 21 }, (_, index) => ({
      migrationId: "migration", relativePath: "深层目录/" + "中文".repeat(30) + (offset + index) + ".mp4",
      itemType: "file", expectedSize: 1024, status: "conflict", lastError: "目标大小不一致",
    })) } });
  });
  await page.evaluate(() => {
    const w = window as any;
    w.openModal("pathMigrationModal");
    w.renderPathMigrationState({ id: "migration", status: "ready", conflictCount: 21, sourceRoot: "/old", destinationRoot: "/new" });
  });
  await page.getByRole("button", { name: "查看冲突与失败项目" }).click();
  await expect(page.locator("#pathMigrationItems .cleanup-item")).toHaveCount(20);
  expect(offsets).toEqual([0]);
  const bounds = await page.evaluate(() => {
    const body = document.querySelector("#pathMigrationModal .path-migration-body")!.getBoundingClientRect();
    const footer = document.querySelector("#pathMigrationModal .modal-actions")!.getBoundingClientRect();
    return { bodyBottom: body.bottom, footerTop: footer.top };
  });
  expect(bounds.bodyBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator("#pathMigrationItems")).toContainText("暂时无法读取");
  await page.locator("#pathMigrationItems").getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator("#pathMigrationItems .cleanup-item")).toHaveCount(1);
  await expect(page.locator("#pathMigrationItems")).toContainText("第 2 页");
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.locator("#pathMigrationItems .cleanup-item")).toHaveCount(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
