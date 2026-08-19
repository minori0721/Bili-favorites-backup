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

async function openRecoveryCenter(page: Page, recoveryIssueKind: "visibility" | "candidate" = "visibility") {
  await page.request.post("/__test/reset", { data: { recoveryIssueKind } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto("/");
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 1");
  await page.locator("#recoveryIssuesBtn").click();
  await expect(page.locator("#recoveryIssuesModal")).toHaveClass(/active/);
  await expect(page.locator(".recovery-issue-row")).toHaveCount(1);
}

test("problem center explains protection and resolves one action without duplicate requests", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await openRecoveryCenter(page);
  const row = page.locator(".recovery-issue-row");
  if (testInfo.project.name !== "desktop") await row.tap();
  else await row.click();
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("发生了什么");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("没有自动覆盖或删除远端文件");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("只读取远端状态，不上传或删除文件");
  const action = page.getByRole("button", { name: "立即重新检查" });
  await action.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  await expect(page.locator("#recoveryIssuesEmptyTitle")).toHaveText("当前没有需要处理的问题");
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 0");
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
});

test("problem center keeps focus contained and uses a two-level mobile flow", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await openRecoveryCenter(page);
  const modal = page.locator("#recoveryIssuesModal");
  await expect(page.locator("body > main")).toHaveAttribute("inert", "");
  await page.evaluate(() => document.getElementById("logDebugBtn")!.focus());
  await expect(page.locator("#closeRecoveryIssuesBtn")).toBeFocused();

  if (testInfo.project.name === "desktop") {
    await expect(page.locator(".recovery-issues-layout")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).not.toHaveClass(/active/);
    await expect(page.locator("#recoveryIssuesBtn")).toBeFocused();
    return;
  }

  await page.locator(".recovery-issue-row").tap();
  await expect(page.locator(".recovery-issues-shell")).toHaveClass(/show-detail/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".recovery-issues-shell")).not.toHaveClass(/show-detail/);
  await expect(page.locator(".recovery-issue-row")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(modal).not.toHaveClass(/active/);
});

test("problem center uses one compact empty state when no issues exist", async ({ page, browserProblems }) => {
  void browserProblems;
  await page.request.post("/__test/reset", { data: { recoveryIssueEmpty: true } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto("/");
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 0");
  await page.locator("#recoveryIssuesBtn").click();
  await expect(page.locator("#recoveryIssuesModal")).toHaveClass(/active/);
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  await expect(page.locator("#recoveryIssuesEmptyTitle")).toHaveText("当前没有需要处理的问题");
  await expect(page.locator("#recoveryIssuesEmptyMessage")).toContainText("新的异常会出现在这里");
  await expect(page.locator(".recovery-issues-layout")).toHaveClass(/is-empty/);
  await expect(page.locator(".recovery-issues-list-pane")).toBeHidden();
  await expect(page.locator("#recoveryIssuesDetail")).toBeHidden();
  await expect(page.getByText("当前没有需要处理的问题", { exact:true })).toHaveCount(1);
  await expect(page.locator("#closeRecoveryIssuesBtn")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#recoveryIssuesModal")).not.toHaveClass(/active/);
  await expect(page.locator("#recoveryIssuesBtn")).toBeFocused();
});

test("problem center shows a visible retry state and preserves the last list", async ({ page, browserProblems }) => {
  void browserProblems;
  await openRecoveryCenter(page);
  let fail = true;
  await page.route("**/api/queue/state", async (route) => {
    if (fail) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: false, message: "模拟加载失败" }),
      });
      return;
    }
    await route.continue();
  });
  await page.locator("#closeRecoveryIssuesBtn").click();
  await page.locator("#recoveryIssuesBtn").click();
  await expect(page.locator("#recoveryIssuesStatus")).toBeVisible();
  await expect(page.locator("#recoveryIssuesStatus")).toContainText("已有列表会保留");
  await expect(page.locator("#recoveryIssuesList .recovery-issue-row")).toHaveCount(1);
  await expect(page.locator("#recoveryIssuesList")).not.toContainText("当前没有需要你处理的问题");

  fail = false;
  await page.locator("#recoveryIssuesRetryBtn").click();
  await expect(page.locator("#recoveryIssuesStatus")).toBeHidden();
  await expect(page.locator("#recoveryIssuesList .recovery-issue-row")).toHaveCount(1);
});

test("conflict candidate confirmation explains both retained copies and sends one action", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop candidate decision coverage");
  await openRecoveryCenter(page, "candidate");
  await page.locator(".recovery-issue-row").click();
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("正式旧路径保持不变");
  const action = page.getByRole("button", { name: "采用新候选" });
  await action.click();
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  await expect(page.locator("#confirmActionMessage")).toContainText("当前可播放归档");
  await expect(page.locator("#confirmActionDetail")).toContainText("正式旧路径不会移动或删除");
  await page.locator("#confirmActionOkBtn").evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  await expect(page.locator("#recoveryIssuesEmptyTitle")).toHaveText("当前没有需要处理的问题");
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
});
