import { expect, test as base, type Page } from "@playwright/test";

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

async function openBoard(page: Page) {
  await page.request.post("/__test/reset", { data: { queueBoardMode: "manual_wait" } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator("#logQueueBtn")).toHaveClass(/active/);
  await expect(page.locator("#queueBoard")).toBeVisible();
  await expect(page.locator(".queue-card")).toHaveCount(1);
}

test("defaults to the board and keeps remote verification data separate from retries", async ({ page, browserProblems }) => {
  void browserProblems;
  await openBoard(page);
  const card = page.locator(".queue-card");
  await expect(card).toContainText("99ninth_");
  await expect(card).toContainText("-キリリ-");
  await expect(card).toContainText("BV1wzGP6jEPh");
  await expect(card).toContainText("收藏夹：惨6");
  await expect(card.locator(".queue-status")).toContainText("远端文件暂不可见");
  await expect(card.locator("[data-queue-time=\"1\"]")).toContainText("后自动复核");
  await expect(card.locator(".queue-extra")).not.toContainText("重试");
  await expect(page.locator("#schedulerStatusBox")).toContainText("后台队列待处理");
  await expect(page.locator("#logConsole")).toBeHidden();
});

test("switching to logs and back preserves the board mode and card state", async ({ page, browserProblems }) => {
  void browserProblems;
  await openBoard(page);
  await page.locator("#logSimpleBtn").click();
  await expect(page.locator("#logConsole")).toBeVisible();
  await expect(page.locator("#queueBoard")).toBeHidden();
  await page.locator("#logQueueBtn").click();
  await expect(page.locator("#logQueueBtn")).toHaveClass(/active/);
  await expect(page.locator("#queueBoard")).toBeVisible();
  await expect(page.locator(".queue-card")).toContainText("远端文件暂不可见");
});
