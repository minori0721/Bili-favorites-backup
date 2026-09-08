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

test('logout deduplicates clicks, reports failure and cancels on page suspension', async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let releaseSuspended!: () => void;
  const suspended = new Promise<void>(resolve => { releaseSuspended = resolve; });
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.route('**/api/logout', async route => {
    calls++;
    if (calls === 1) await pending;
    if (calls === 3) {
      await suspended;
      await route.fulfill({ json: { success: true, data: {} } });
      return;
    }
    await route.fulfill({ status: 503, json: { success: false, message: '退出暂时失败' } });
  });
  await boot(page);
  const logout = page.locator('#logoutBtn');
  await logout.dispatchEvent('click');
  await logout.dispatchEvent('click');
  await expect.poll(() => calls).toBe(1);
  await expect(logout).toBeDisabled();
  release();
  await expect(logout).toBeEnabled();
  await expect(page.getByText('退出暂时失败', { exact: true })).toBeVisible();
  await logout.click();
  await expect.poll(() => calls).toBe(2);
  await expect(logout).toBeEnabled();
  await logout.click();
  await expect.poll(() => calls).toBe(3);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  releaseSuspended();
  await expect(logout).toBeEnabled();
  await logout.click();
  await expect.poll(() => calls).toBe(4);
  await expect(logout).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(problems).toEqual([]);
});

test('settings and sync help open through the modal boundary and release focus',async({page,browserProblems},testInfo)=>{
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);
  await expect(page.locator('#saveConfigBtn')).toBeEnabled();
  await page.locator('#settingsHelpBtn').click();
  await expect(page.locator('#settingsHelpModal')).toHaveClass(/active/);
  await expect(page.locator('#settingsFlowContent')).toContainText('自动轮询');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsHelpBtn')).toBeFocused();
  await page.locator('#syncHelpBtn').click();
  await expect(page.locator('#syncHelpModal')).toHaveClass(/active/);
  await page.locator('#syncHelpDetailBtn').click();
  await expect(page.locator('#syncHelpContent')).toContainText('SQLite');
  await page.keyboard.press('Escape');
  await expect(page.locator('#syncHelpBtn')).toBeFocused();
});

test('settings template follows loaded order and restores a single editor after page suspension', async ({ page, browserProblems }) => {
  void browserProblems;
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.filenameTemplate = '<bvid>_<ownerName>';
    body.data.alistBrowserUrl = 'https://storage.example.test';
    await route.fulfill({json:body});
  });
  await boot(page);
  await expect(page.locator('#filenameTemplate')).toHaveValue('<bvid>_<ownerName>');
  await expect(page.locator('#selectedTags .template-tag')).toHaveText(['BV号×', 'UP主×']);
  await expect(page.locator('#templatePreview')).toHaveText('BV1xxxxx_UP主名.mp4');
  await expect(page.locator('#alistBrowserUrlHint')).not.toHaveClass(/status-error/);
  await page.locator('#filenameTemplate').evaluate((element: HTMLInputElement) => {
    element.closest('details')?.setAttribute('open','');
  });
  await page.locator('#filenameTemplate').fill('<dfn>-<bvid>');
  await expect(page.locator('#selectedTags .template-tag')).toHaveText(['清晰度×', 'BV号×']);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
  });
  await expect(page.locator('#templateTags .template-tag')).toHaveCount(7);
  await expect(page.locator('#filenameTemplate')).toHaveValue('<bvid>_<ownerName>');
  await expect(page.locator('#selectedTags .template-tag')).toHaveText(['BV号×', 'UP主×']);
});

test('settings save cancels a suspended request and does not duplicate handlers on resume', async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  let writes = 0;
  await page.route('**/api/config', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    await new Promise(resolve => setTimeout(resolve, writes === 1 ? 600 : 0));
    await route.fulfill({json:{success:true,data:{}}});
  });
  await boot(page);
  await expect(page.locator('#saveConfigBtn')).toBeEnabled();
  await page.locator('#saveConfigBtn').evaluate(button => {
    button.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    button.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  });
  await expect.poll(() => writes).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
  });
  await expect(page.locator('#saveConfigBtn')).toBeEnabled();
  await page.waitForTimeout(700);
  await expect(page.locator('#configStatus')).not.toContainText('设置已保存');
  await page.locator('#saveConfigBtn').click();
  await expect.poll(() => writes).toBe(2);
  await expect(page.locator('#configStatus')).toContainText('设置已保存');
});

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

test("favorite folder covers use the cached same-origin image endpoint", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);
  await expect(page.locator(".user-item")).toHaveCount(1);
  await page.getByRole("button", { name: "选择同步收藏夹" }).click();
  await expect(page.locator("#favoritesList")).toContainText("第一账号收藏夹");
  await expect.poll(async () => (await page.request.get("/__test/state").then((response) => response.json())).favoriteCoverQueries)
    .toEqual(["user-1:101"]);
  await expect(page.locator("#favoritesList img.fav-cover")).toHaveCount(1);
  await expect(page.locator("#favoritesList img.fav-cover")).toHaveAttribute("src", /\/api\/users\/user-1\/favorites\/101\/cover$/);
});

test("favorite dialog title stays readable at a narrow mobile width", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "narrow mobile dialog coverage");
  await page.setViewportSize({ width: 320, height: 640 });
  await boot(page);
  await page.getByRole("button", { name: "选择同步收藏夹" }).click();
  await expect(page.locator("#favoritesModal")).toHaveClass(/active/);

  const metrics = await page.locator("#favoritesModalTitle").evaluate((title) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    const lineRects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const titleRect = title.getBoundingClientRect();
    const panelRect = title.closest(".panel")!.getBoundingClientRect();
    return {
      lineCount: lineRects.length,
      titleRight: titleRect.right,
      panelRight: panelRect.right,
    };
  });

  expect(metrics.lineCount).toBe(1);
  expect(metrics.titleRight).toBeLessThanOrEqual(metrics.panelRight);
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

test("page lifecycle closes login and restores one set of event handlers", async ({ page, browserProblems }) => {
  void browserProblems;
  await boot(page);
  await page.locator('#addUserBtn').click();
  await expect(page.locator('#loginStatus')).toContainText('等待扫码中');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true})));
  await expect(page.locator('#loginModal')).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
  });
  await page.locator('#addUserBtn').click();
  await expect(page.locator('#loginStatus')).toContainText('等待扫码中');
  const state = await page.request.get('/__test/state').then(response => response.json());
  expect(state.loginStartCount).toBe(2);
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

  await page.locator("#onlineContentCloseMainBtn").click();
  await page.locator("#onlineContentBtn").click();
  await page.getByRole("button", { name: "手动归档" }).click();
  await expect(page.locator("#manualArchiveProbeBtn")).toBeEnabled();
  await expect(page.locator("#manualArchiveStartBtn")).toBeEnabled();
});

test('late manual archive submission cannot close a newly opened options dialog', async ({page,browserProblems},testInfo)=>{
  void browserProblems;
  desktopOnly(testInfo);
  let submissions=0;
  let releaseResponse!:()=>void;
  const responseGate=new Promise<void>(resolve=>{releaseResponse=resolve;});
  await page.route('**/api/online-content/manual-archive',async route=>{
    submissions++;
    await responseGate;
    await route.fulfill({json:{success:true,data:{status:'queued'}}});
  });
  await boot(page);
  await page.locator('#onlineContentBtn').click();
  await page.getByRole('button',{name:'手动归档'}).click();
  await page.locator('#manualArchiveStartBtn').evaluate(button=>{
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  });
  await expect.poll(()=>submissions).toBe(1);
  await page.locator('#manualArchiveCancelBtn').click();
  await page.getByRole('button',{name:'手动归档'}).click();
  releaseResponse();
  await page.waitForTimeout(100);
  await expect(page.locator('#manualArchiveOptionsModal')).toHaveClass(/active/);
  await expect(page.locator('#manualArchiveStartBtn')).toBeEnabled();
  await expect(page.locator('#manualArchiveProbeResult')).toContainText('默认偏好');
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
