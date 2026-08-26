import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

const test = base.extend<{ browserProblems: string[] }>({
  browserProblems: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      if (response.status() === 404) problems.push(`404: ${response.url()}`);
    });
    await use(problems);
    expect(problems).toEqual([]);
  },
});

async function resetFixture(
  page: Page,
  sourceCompletionMode: "pending" | "complete" = "pending",
  delays: { accountDeleteDelayMs?: number; sourceStartDelayMs?: number } = {}
) {
  await page.request.post("/__test/reset", { data: { sourceCompletionMode, ...delays } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator("#archiveLibraryBtn")).toBeVisible();
  await expect(page.locator(".user-item")).toHaveCount(1);
}

async function openLibrary(page: Page, testInfo: TestInfo) {
  await page.locator("#archiveLibraryBtn").click();
  await expect(page.locator("#archiveLibraryModal")).toHaveClass(/active/);
  await expect(page.locator(".archive-library-card")).toHaveCount(2);
  if (testInfo.project.name !== "desktop") {
    await page.locator('.archive-nav-item[data-archive-scope="global"]').tap();
    await expect(page.locator(".archive-library-shell")).toHaveClass(/show-content/);
    await page.waitForTimeout(220);
  }
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-cover')).toBeVisible();
  const cardGeometry = await page.locator('[data-archive-bvid="BV1ALPHA001"]').evaluate((card) => {
    const cover = card.querySelector<HTMLElement>(".archive-library-cover")!;
    const title = card.querySelector<HTMLElement>(".archive-library-title")!;
    const coverRect = cover.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      coverWidth: Math.round(coverRect.width),
      coverHeight: Math.round(coverRect.height),
      titleTop: Math.round(titleRect.top),
      coverBottom: Math.round(coverRect.bottom),
    };
  });
  expect(cardGeometry.coverWidth).toBeGreaterThan(0);
  expect(cardGeometry.coverHeight).toBeGreaterThan(0);
  expect(cardGeometry.titleTop).toBeGreaterThanOrEqual(cardGeometry.coverBottom);
}

async function openAlphaDetail(page: Page) {
  const card = page.locator('[data-archive-bvid="BV1ALPHA001"]');
  await card.locator(".archive-library-card-more").click();
  await expect(page.locator("#archiveLibraryDetail")).toHaveClass(/open/);
  await expect(page.locator("#archiveLibraryDetailTitle")).toContainText("Alpha");
}

async function openSourceConfirmation(page: Page) {
  const button = page.getByRole("button", { name: "删除此来源归档" });
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  return button;
}

test("desktop modal stack traps focus and restores each interaction layer", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop interaction coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);

  await expect(page.locator("#archiveLibraryDetailCloseBtn")).toBeFocused();
  await expect(page.locator(".archive-library-main")).toHaveAttribute("inert", "");
  const deleteButton = await openSourceConfirmation(page);

  const layers = await page.evaluate(() => ({
    archive: Number(getComputedStyle(document.getElementById("archiveLibraryModal")!).zIndex),
    confirm: Number(getComputedStyle(document.getElementById("confirmActionModal")!).zIndex),
  }));
  expect(layers.confirm).toBeGreaterThan(layers.archive);
  await expect(page.locator("#archiveLibraryModal")).toHaveAttribute("inert", "");
  await expect(page.locator("#archiveLibraryModal")).toHaveAttribute("aria-hidden", "true");

  await page.locator("#confirmActionInput").fill("DELETE ARCHIVE");
  await page.locator("#confirmActionCancelBtn").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#confirmActionInput")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#confirmActionCancelBtn")).toBeFocused();
  await page.evaluate(() => document.getElementById("logDebugBtn")!.focus());
  await expect(page.locator("#confirmActionCancelBtn")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#confirmActionModal")).not.toHaveClass(/active/);
  await expect(deleteButton).toBeEnabled();
  await expect(deleteButton).toBeFocused();
  await expect(page.locator("#archiveLibraryDetail")).toHaveClass(/open/);

  await page.keyboard.press("Escape");
  await expect(page.locator("#archiveLibraryDetail")).not.toHaveClass(/open/);
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-more')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#archiveLibraryModal")).not.toHaveClass(/active/);
  await expect(page.locator("#archiveLibraryBtn")).toBeFocused();
});

test("rapid source deletion clicks create one preview and one start", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop deletion coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);
  await openSourceConfirmation(page);
  await page.locator("#confirmActionInput").fill("DELETE ARCHIVE");
  await page.locator("#confirmActionOkBtn").click();
  await expect(page.locator(".archive-deletion-progress").filter({ hasText: /正在清理|等待清理/ })).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.previewCount).toBe(1);
  expect(state.startCount).toBe(1);
});

test("completed deletion closes stale detail and focuses the results region", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop deletion completion coverage");
  await resetFixture(page, "complete");
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);
  await openSourceConfirmation(page);
  await page.locator("#confirmActionInput").fill("DELETE ARCHIVE");
  await page.locator("#confirmActionOkBtn").click();
  await expect(page.locator("#archiveLibraryDetail")).not.toHaveClass(/open/, { timeout: 8_000 });
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"]')).toHaveCount(0);
  await expect(page.locator("#archiveLibraryResults")).toBeFocused();
});

test("failed account cleanup reconfirmation stays above its parent modal", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop account cleanup coverage");
  await resetFixture(page);
  const removeAccount = page.getByRole("button", { name: "删除账号" });
  await removeAccount.click();
  await page.locator("#accountRemovalRemote").check();
  await expect(page.locator("#accountRemovalPreview")).toContainText("2 个已追踪文件");
  await page.locator("#accountRemovalConfirmInput").fill("DELETE REMOTE ARCHIVE");
  await page.locator("#accountRemovalSubmitBtn").click();
  const reconfirm = page.getByRole("button", { name: "重新预览并确认" });
  await expect(reconfirm).toBeVisible();
  await reconfirm.click();
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  const layers = await page.evaluate(() => ({
    account: Number(getComputedStyle(document.getElementById("accountRemovalModal")!).zIndex),
    confirm: Number(getComputedStyle(document.getElementById("confirmActionModal")!).zIndex),
  }));
  expect(layers.confirm).toBeGreaterThan(layers.account);
  await page.keyboard.press("Escape");
  await expect(reconfirm).toBeEnabled();
  await expect(reconfirm).toBeFocused();
});

test("a delayed account deletion response cannot overwrite a reopened dialog", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop account request isolation coverage");
  await resetFixture(page, "pending", { accountDeleteDelayMs: 650 });
  const removeAccount = page.getByRole("button", { name: "删除账号" });
  await removeAccount.click();
  await page.locator("#accountRemovalRemote").check();
  await expect(page.locator("#accountRemovalPreview")).toContainText("2 个已追踪文件");
  await page.locator("#accountRemovalConfirmInput").fill("DELETE REMOTE ARCHIVE");
  await page.locator("#accountRemovalSubmitBtn").click();
  await page.locator("#accountRemovalCancelBtn").click();
  await removeAccount.click();
  await expect(page.locator("#accountRemovalOnly")).toBeChecked();
  await expect(page.locator("#accountRemovalPreview")).toContainText("仅移除账号登录");
  await page.waitForTimeout(850);
  await expect(page.locator("#accountRemovalModal")).toHaveClass(/active/);
  await expect(page.locator("#accountRemovalOnly")).toBeChecked();
  await expect(page.locator("#accountRemovalSubmitBtn")).toBeVisible();
  await expect(page.locator("#accountRemovalProgress")).toBeHidden();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.accountDeleteCount).toBe(1);
});

test("a delayed source start response cannot write progress into a new detail", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop source request isolation coverage");
  await resetFixture(page, "pending", { sourceStartDelayMs: 650 });
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);
  await openSourceConfirmation(page);
  await page.locator("#confirmActionInput").fill("DELETE ARCHIVE");
  await page.locator("#confirmActionOkBtn").click();
  await page.keyboard.press("Escape");
  await page.locator('[data-archive-bvid="BV1BETA0002"] .archive-library-card-more').click();
  await expect(page.locator("#archiveLibraryDetailTitle")).toContainText("Beta");
  await page.waitForTimeout(850);
  await expect(page.locator("#archiveLibraryDetailTitle")).toContainText("Beta");
  await expect(page.locator("#archiveLibraryDetail .archive-deletion-progress:not(.is-hidden)")).toHaveCount(0);
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.previewCount).toBe(1);
  expect(state.startCount).toBe(1);
});

test("archive search applies atomically and ignores slow obsolete responses", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop search coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  const search = page.locator("#archiveLibrarySearchInput");
  await search.evaluate((input) => {
    const field = input as HTMLInputElement;
    field.value = "alpha";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector('[data-archive-bvid="BV1BETA0002"] .archive-library-card-more') as HTMLButtonElement).click();
  });
  await expect(page.locator("#archiveLibraryDetail")).toHaveClass(/open/);
  const duringDebounce = await page.request.get("/__test/state").then((response) => response.json());
  expect(duringDebounce.detailQueries.at(-1)).toBe("");
  await expect(page.locator("#archiveLibraryDetail")).not.toHaveClass(/open/);
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"]')).toBeVisible();
  await expect(page.locator('[data-archive-bvid="BV1BETA0002"]')).toHaveCount(0);

  await search.fill("slow");
  await page.waitForTimeout(360);
  await search.fill("fast");
  await expect(page.locator('[data-archive-bvid="BV1FAST0003"]')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-archive-bvid="BV1SLOW0004"]')).toHaveCount(0);
  await page.locator("#archiveLibrarySearchClearBtn").click();
  await expect(page.locator(".archive-library-card")).toHaveCount(2);

  await search.fill("late");
  await page.locator("#closeArchiveLibraryBtn").click();
  await page.waitForTimeout(450);
  const finalState = await page.request.get("/__test/state").then((response) => response.json());
  expect(finalState.itemQueries).not.toContain("late");
});

test("mobile detail and directory return preserve viewport and avoid overflow", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "mobile viewport coverage");
  await resetFixture(page);
  const initialScroll = await page.evaluate(() => window.scrollY);
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);
  const more = page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-more');
  await page.locator("#archiveLibraryDetailCloseBtn").tap();
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.locator("#archiveLibraryMobileBackBtn").tap();
  await expect(page.locator(".archive-library-shell")).not.toHaveClass(/show-content/);
  await expect(page.locator('.archive-nav-item[data-archive-scope="global"]')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.locator(".archive-library-shell").evaluate((shell) => {
    const sidebar = shell.querySelector<HTMLElement>(".archive-library-sidebar")!;
    const modal = document.getElementById("archiveLibraryModal")!;
    return {
      modalPadding: getComputedStyle(modal).padding,
      scrollLeft: shell.scrollLeft,
      shellLeft: Math.round(shell.getBoundingClientRect().left),
      sidebarLeft: Math.round(sidebar.getBoundingClientRect().left),
    };
  })).toEqual({
    modalPadding: "0px",
    scrollLeft: 0,
    shellLeft: 0,
    sidebarLeft: 0,
  });
});

test("mobile Escape closes the playback drawer before the player", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "mobile playback drawer coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main').tap();
  await expect(page.locator("#playbackModal")).toHaveClass(/active/);
  if (testInfo.project.name === "mobile-landscape") {
    await expect(page.locator("#playbackImmersiveQueueBtn")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#playbackModal")).not.toHaveClass(/active/);
    await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main')).toBeFocused();
    return;
  }
  await page.locator("#playbackImmersiveQueueBtn").tap();
  await expect(page.locator(".playback-shell")).toHaveClass(/queue-open/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".playback-shell")).not.toHaveClass(/queue-open/);
  await expect(page.locator("#playbackModal")).toHaveClass(/active/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#playbackModal")).not.toHaveClass(/active/);
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main')).toBeFocused();
});
