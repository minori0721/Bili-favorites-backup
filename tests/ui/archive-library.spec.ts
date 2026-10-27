import {revealControl} from './workspace-navigation.js';
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
  delays: { accountDeleteDelayMs?: number; sourceStartDelayMs?: number; retainedArchivePreview?: boolean } = {}
) {
  await page.request.post("/__test/reset", { data: { sourceCompletionMode, ...delays } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto('/?page=accounts');
  await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'归档库',exact:true})).toBeVisible();
  await expect(page.locator(".user-item")).toHaveCount(1);
}

async function openLibrary(page: Page, testInfo: TestInfo, expectedCount = 2) {
  await (await revealControl(page,page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'归档库',exact:true}))).click();
  await expect(page.locator("#archiveLibraryModal")).toHaveClass(/active/);
  await expect(page.locator(".archive-library-card")).toHaveCount(expectedCount);
  if (testInfo.project.name !== "desktop") {
    await (await revealControl(page,page.locator('.archive-nav-item[data-archive-scope="global"]'))).tap();
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
  await (await revealControl(page,card.locator(".archive-library-card-more"))).click();
  await expect(page.locator("#archiveLibraryDetail")).toHaveClass(/open/);
  await expect(page.locator("#archiveLibraryDetailTitle")).toContainText("Alpha");
}

async function openSourceConfirmation(page: Page) {
  const button = page.getByRole("button", { name: "删除本次归档" });
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  return button;
}

test("source availability uses a background status without creating a recovery badge", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await expect(page.locator('[data-archive-bvid="BV1BETA0002"] .archive-library-status')).toHaveText("B站源长期不可用");
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 0");
});

test("「留存」显示收藏夹失效但归档仍可播放的视频", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await resetFixture(page, "pending", { retainedArchivePreview: true });
  await openLibrary(page, testInfo, 3);
  const sourceFilter = page.locator('[data-archive-filter="retained"]');
  await expect(sourceFilter).toHaveText('「留存」');
  await expect(sourceFilter).not.toHaveAttribute('title');
  await (await revealControl(page,sourceFilter)).click();
  await expect(sourceFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.archive-library-card')).toHaveCount(1);
  await expect(page.locator('[data-archive-bvid="BV1GAMMA003"]')).toBeVisible();
  await expect(page.locator('[data-archive-bvid="BV1BETA0002"]')).toHaveCount(0);
  await expect(page.locator('#archiveLibrarySummary')).toContainText('1 个「留存」归档');
  await (await revealControl(page,page.locator('[data-archive-filter="all"]'))).click();
  await expect(page.locator('.archive-library-card')).toHaveCount(3);
});

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

  await (await revealControl(page,page.locator("#confirmActionInput"))).fill("DELETE ARCHIVE");
  await (await revealControl(page,page.locator("#confirmActionCancelBtn"))).focus();
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
  await expect(page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'归档库',exact:true})).toBeFocused();
});

test("rapid source deletion clicks create one preview and one start", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop deletion coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await openAlphaDetail(page);
  await openSourceConfirmation(page);
  await (await revealControl(page,page.locator("#confirmActionInput"))).fill("DELETE ARCHIVE");
  await (await revealControl(page,page.locator("#confirmActionOkBtn"))).click();
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
  await (await revealControl(page,page.locator("#confirmActionInput"))).fill("DELETE ARCHIVE");
  await (await revealControl(page,page.locator("#confirmActionOkBtn"))).click();
  await expect(page.locator("#archiveLibraryDetail")).not.toHaveClass(/open/, { timeout: 8_000 });
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"]')).toHaveCount(0);
  await expect(page.locator("#archiveLibraryResults")).toBeFocused();
});

test("failed account cleanup reconfirmation stays above its parent modal", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop account cleanup coverage");
  await resetFixture(page);
  const removeAccount = page.locator('#userList').getByRole("button", {includeHidden:true,name: "删除账号" });
  await (await revealControl(page,removeAccount)).click();
  await (await revealControl(page,page.locator("#accountRemovalRemote"))).check();
  await expect(page.locator("#accountRemovalPreview")).toContainText("2 个已追踪文件");
  await (await revealControl(page,page.locator("#accountRemovalConfirmInput"))).fill("DELETE REMOTE ARCHIVE");
  await (await revealControl(page,page.locator("#accountRemovalSubmitBtn"))).click();
  const reconfirm = page.getByRole("button", { name: "重新预览并确认" });
  await expect(reconfirm).toBeVisible();
  await (await revealControl(page,reconfirm)).click();
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
  const removeAccount = page.locator('#userList').getByRole("button", {includeHidden:true,name: "删除账号" });
  await (await revealControl(page,removeAccount)).click();
  await (await revealControl(page,page.locator("#accountRemovalRemote"))).check();
  await expect(page.locator("#accountRemovalPreview")).toContainText("2 个已追踪文件");
  await (await revealControl(page,page.locator("#accountRemovalConfirmInput"))).fill("DELETE REMOTE ARCHIVE");
  await (await revealControl(page,page.locator("#accountRemovalSubmitBtn"))).click();
  await (await revealControl(page,page.locator("#accountRemovalCancelBtn"))).click();
  await (await revealControl(page,removeAccount)).click();
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
  await (await revealControl(page,page.locator("#confirmActionInput"))).fill("DELETE ARCHIVE");
  await (await revealControl(page,page.locator("#confirmActionOkBtn"))).click();
  await page.keyboard.press("Escape");
  await (await revealControl(page,page.locator('[data-archive-bvid="BV1BETA0002"] .archive-library-card-more'))).click();
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

  await (await revealControl(page,search)).fill("slow");
  await page.waitForTimeout(360);
  await (await revealControl(page,search)).fill("fast");
  await expect(page.locator('[data-archive-bvid="BV1FAST0003"]')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-archive-bvid="BV1SLOW0004"]')).toHaveCount(0);
  await (await revealControl(page,page.locator("#archiveLibrarySearchClearBtn"))).click();
  await expect(page.locator(".archive-library-card")).toHaveCount(2);

  // Dispatch both events in one browser turn: locator actionability can take
  // longer than the 300ms debounce, allowing a valid request before closing.
  await search.evaluate((input) => {
    (input as HTMLInputElement).value = "late";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (document.getElementById("closeArchiveLibraryBtn") as HTMLButtonElement).click();
  });
  await expect(page.locator("#archiveLibraryModal")).not.toHaveClass(/active/);
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
  await (await revealControl(page,page.locator("#archiveLibraryDetailCloseBtn"))).tap();
  await expect(more).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await (await revealControl(page,page.locator("#archiveLibraryMobileBackBtn"))).tap();
  await expect(page.locator(".archive-library-shell")).not.toHaveClass(/show-content/);
  await expect(page.locator('.archive-nav-item[data-archive-scope="global"]')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(()=>page.locator('.archive-library-shell').evaluate(shell=>shell.scrollLeft)).toBe(0);
  const geometry=await page.locator(".archive-library-shell").evaluate((shell) => {
    const modal = document.getElementById("archiveLibraryModal")!;
    const style=getComputedStyle(modal),box=shell.getBoundingClientRect();
    return {
      paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight),
      shellLeft:box.left,shellRight:box.right,viewport:innerWidth,
    };
  });
  expect(geometry.shellLeft).toBeCloseTo(geometry.paddingLeft,0);
  await expect.poll(()=>page.locator('.archive-library-shell').evaluate(shell=>{
    const sidebar=shell.querySelector<HTMLElement>('.archive-library-sidebar')!;
    return Math.abs(sidebar.getBoundingClientRect().left-shell.getBoundingClientRect().left-parseFloat(getComputedStyle(shell).borderLeftWidth));
  })).toBeLessThan(1);
  expect(geometry.shellRight).toBeLessThanOrEqual(geometry.viewport-geometry.paddingRight+1);
});

test("mobile Escape closes the playback drawer before the player", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "mobile playback drawer coverage");
  await resetFixture(page);
  await openLibrary(page, testInfo);
  await (await revealControl(page,page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main'))).tap();
  await expect(page.locator("#playbackModal")).toHaveClass(/active/);
  if (testInfo.project.name === "mobile-landscape") {
    await expect(page.locator("#playbackImmersiveQueueBtn")).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#playbackModal")).not.toHaveClass(/active/);
    await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main')).toBeFocused();
    return;
  }
  await (await revealControl(page,page.locator("#playbackImmersiveQueueBtn"))).tap();
  await expect(page.locator(".playback-shell")).toHaveClass(/queue-open/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".playback-shell")).not.toHaveClass(/queue-open/);
  await expect(page.locator("#playbackModal")).toHaveClass(/active/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#playbackModal")).not.toHaveClass(/active/);
  await expect(page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-main')).toBeFocused();
});


test("directory reference counts remain separate from search results", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await resetFixture(page);
  await page.route('**/api/archive-library/navigation', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.summary.sourceReferenceCount = 4;
    body.data.summary.uniqueRemotePathCount = 3;
    body.data.summary.lastSyncedAt = '2026-10-28T04:09:21+08:00';
    body.data.accounts[0].folders[0].sourceReferenceCount = 5;
    body.data.accounts[0].folders[0].uniqueRemotePathCount = 4;
    await route.fulfill({response, json: body});
  });
  await openLibrary(page, testInfo);
  const nav = page.locator('.archive-nav-item[data-archive-scope="global"]');
  await expect(nav).toContainText('2 个视频');
  await expect(nav).toContainText('2 个视频 · 1 可播放');
  await expect(nav).toContainText('更新于');
  await expect(nav).not.toContainText('来源引用');
  await expect(nav.locator('.archive-nav-count')).toHaveCount(0);
  await expect(page.locator('#archiveLibrarySummary')).not.toContainText('来源引用');
  const stats = page.locator('#archiveLibraryStats');
  await expect(page.locator('#archiveLibraryStatsBody')).not.toBeVisible();
  await stats.locator('summary').click();
  await expect(stats.locator('dt:has-text("来源文件引用") + dd')).toHaveText('4');
  await expect(stats.locator('dt:has-text("不同存储路径") + dd')).toHaveText('3');
  await expect(stats.locator('dt:has-text("索引更新") + dd')).toContainText('2026');
  const box = await stats.locator('.archive-library-stats-body').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const shell = await page.locator('.archive-library-shell').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(shell!.y + shell!.height);
  await stats.locator('summary').press('Escape');
  await expect(stats).not.toHaveAttribute('open');
  await expect(stats.locator('summary')).toBeFocused();
  if (testInfo.project.name !== 'desktop') await page.locator('#archiveLibraryMobileBackBtn').click();
  await page.locator('.archive-nav-item[data-archive-media-id="101"]').click();
  await expect(stats).not.toHaveAttribute('open');
  await stats.locator('summary').click();
  await expect(stats.locator('dt:has-text("来源文件引用") + dd')).toHaveText('5');
  await page.locator('#archiveLibrarySearchInput').fill('Alpha');
  await expect(stats).not.toHaveAttribute('open');
  // The navigation remains in the DOM on mobile; inspect intrinsic containment too.
  const overflow = await nav.evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
});
