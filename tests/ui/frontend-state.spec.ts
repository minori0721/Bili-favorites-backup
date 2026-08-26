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

async function boot(page: Page, data: Record<string, unknown> = {}) {
  await page.request.post("/__test/reset", { data });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
}

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "desktop", "desktop request-state coverage");
}

test("initial failures are visible and retry without unhandled page errors", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page, { configErrorOnce: true, usersErrorOnce: true });

  await expect(page.locator("#configStatus")).toContainText("设置加载失败");
  await expect(page.locator("#userListStatus")).toContainText("账号加载失败");
  await page.locator("#configStatus .retry-button").click();
  await page.locator("#userListStatus .retry-button").click();
  await expect(page.locator("#pollInterval")).toHaveValue("5");
  await expect(page.locator(".user-item")).toHaveCount(1);
  await expect(page.locator("#saveConfigBtn")).toBeEnabled();

  const hiddenModalState = await page.locator(".modal").evaluateAll((modals) => modals.every((modal) => (
    (modal as HTMLElement).hidden
    && (modal as HTMLElement).inert
    && modal.getAttribute("aria-hidden") === "true"
  )));
  expect(hiddenModalState).toBe(true);
});

test("closing one favorites request prevents it from overwriting another account", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page, { usersMode: "double", favoriteRace: true });
  await expect(page.locator(".user-item")).toHaveCount(2);

  await page.locator('.user-item').nth(0).getByRole("button", { name: "选择同步收藏夹" }).click();
  await expect(page.locator("#favoritesModal")).toHaveClass(/active/);
  await page.locator("#closeFavoritesBtn").click();
  await page.locator('.user-item').nth(1).getByRole("button", { name: "选择同步收藏夹" }).click();
  await expect(page.locator("#favoritesList")).toContainText("第二账号收藏夹");
  await page.waitForTimeout(750);
  await expect(page.locator("#favoritesList")).toContainText("第二账号收藏夹");
  await expect(page.locator("#favoritesList")).not.toContainText("第一账号收藏夹");
});

test("favorites save failure keeps the dialog usable and a retry succeeds", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page, { favoriteSaveErrorOnce: true });
  await expect(page.locator(".user-item")).toHaveCount(1);
  await page.getByRole("button", { name: "选择同步收藏夹" }).click();
  await expect(page.locator("#favoritesList")).toContainText("第一账号收藏夹");

  await page.locator("#saveFavoritesBtn").click();
  await expect(page.locator("#favoritesModal")).toHaveClass(/active/);
  await expect(page.locator("#favoritesStatus")).toContainText("保存失败");
  await expect(page.locator("#saveFavoritesBtn")).toBeEnabled();
  await page.locator("#saveFavoritesBtn").click();
  await expect(page.locator("#favoritesModal")).not.toHaveClass(/active/);
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.favoriteSaveCount).toBe(2);
});

test("an old login completion timer cannot close a newly opened login", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page, { loginMode: "first_complete_then_pending" });
  await page.locator("#addUserBtn").click();
  await expect(page.locator("#loginStatus")).toContainText("登录成功");
  await page.locator("#closeLoginBtn").click();
  await page.locator("#addUserBtn").click();
  await expect(page.locator("#loginStatus")).toContainText("等待扫码中");
  await page.waitForTimeout(1_150);
  await expect(page.locator("#loginModal")).toHaveClass(/active/);
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.loginStartCount).toBe(2);
});

test("rapid toggle and sync clicks issue one explicit command", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);
  await expect(page.locator(".user-item")).toHaveCount(1);
  await page.getByRole("button", { name: "暂停同步" }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await page.request.get("/__test/state").then((response) => response.json())).userPatchCount).toBe(1);
  let state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.userPatchBodies).toEqual([{ enabled: false }]);

  await page.locator("#syncNowBtn").evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await page.request.get("/__test/state").then((response) => response.json())).syncNowCount).toBe(1);
  state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.syncNowCount).toBe(1);
});

test("online replacement cancels the slow context and deduplicates cards", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page, { onlineSourceRace: true, onlineDuplicateMode: true });
  await page.locator("#onlineContentBtn").click();
  await expect(page.locator("#onlineContentModal")).toHaveClass(/active/);
  await page.locator("#onlineContentSearchInput").fill("fast");
  await expect(page.locator(".online-content-card")).toContainText("在线搜索 fast");
  await page.waitForTimeout(750);
  await expect(page.locator(".online-content-card")).toHaveCount(1);
  await expect(page.locator(".online-content-card")).not.toContainText("在线待归档视频");
});

test("manual archive controls reset when the reusable dialog opens again", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);
  await page.locator("#onlineContentBtn").click();
  await page.getByRole("button", { name: "手动归档" }).click();
  await page.locator("#manualArchiveStartBtn").click();
  await expect(page.locator("#manualArchiveOptionsModal")).not.toHaveClass(/active/);

  await page.locator("#closeOnlineContentBtn").click();
  await page.locator("#onlineContentBtn").click();
  await page.getByRole("button", { name: "手动归档" }).click();
  await expect(page.locator("#manualArchiveProbeBtn")).toBeEnabled();
  await expect(page.locator("#manualArchiveStartBtn")).toBeEnabled();
});

test("archive reset disables stale cards, rolls back on failure, and deduplicates results", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);
  await page.locator("#archiveLibraryBtn").click();
  await expect(page.locator(".archive-library-card")).toHaveCount(2);
  const search = page.locator("#archiveLibrarySearchInput");
  await search.fill("slow");
  await page.waitForTimeout(340);
  await expect(page.locator("#archiveLibraryResults")).toHaveAttribute("inert", "");
  await search.fill("broken");
  await page.waitForTimeout(340);
  await expect(page.locator("#archiveLibraryResults")).toHaveAttribute("inert", "");
  await expect(page.locator("#archiveLibraryFooter")).toContainText("加载失败");
  await expect(page.locator("#archiveLibraryResults")).not.toHaveAttribute("inert", "");
  await expect(search).toHaveValue("");
  await expect(page.locator(".archive-library-card")).toHaveCount(2);
  const requestCount = (await page.request.get("/__test/state").then((response) => response.json())).itemQueries.length;
  await page.locator("#archiveLibraryResults").dispatchEvent("scroll");
  await page.waitForTimeout(250);
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.itemQueries).toHaveLength(requestCount);

  await search.fill("duplicates");
  await expect(page.locator(".archive-library-card")).toHaveCount(1);
});
