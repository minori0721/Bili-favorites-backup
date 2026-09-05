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
