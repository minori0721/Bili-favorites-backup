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

test('queue covers prefer local files, fall back once, and do not reset on polling', async ({ page }) => {
  const requests: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64');
  await page.route('**/covers/review*.png', r => { requests.push(r.request().url()); return r.fulfill({ contentType: 'image/png', body: png }); });
  await page.route('https://example.invalid/cover.png', r => { requests.push(r.request().url()); return r.fulfill({ contentType: 'image/png', body: png }); });
  await openBoard(page);
  await page.evaluate(() => {
    const card = document.querySelector('.queue-card') as any;
    const item = { ...card.__queueItem, coverLocalPath: 'covers/review.png', cover: 'https://example.invalid/cover.png' };
    (window as any).reviewCoverItem = item;
    (window as any).updateQueueCard(card, item, Date.now());
  });
  const img = page.locator('.queue-card img.queue-cover');
  await expect(img).toHaveAttribute('src', /\/covers\/review.png$/);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).not.toContain('example.invalid');
  const mutations = await page.evaluate(() => {
    const card = document.querySelector('.queue-card');
    const image = card!.querySelector('img')!;
    const observer = new MutationObserver(() => {});
    observer.observe(image, { attributes: true, attributeFilter: ['src'] });
    for (let i = 0; i < 5; i++) (window as any).updateQueueCard(card, (window as any).reviewCoverItem, Date.now());
    const n = observer.takeRecords().length; observer.disconnect(); return n;
  });
  expect(mutations).toBe(0);
  await img.dispatchEvent('error');
  await expect(img).toHaveAttribute('src', 'https://example.invalid/cover.png');
  await expect.poll(() => requests.length).toBe(2);
  await img.dispatchEvent('error');
  await expect(page.locator('.queue-card .queue-cover')).toHaveText('封面');
  await page.evaluate(() => (window as any).updateQueueCard(document.querySelector('.queue-card'), (window as any).reviewCoverItem, Date.now()));
  await expect(page.locator('.queue-card .queue-cover')).toHaveText('封面');
});

async function openMediaRetryBoard(page: Page) {
  await page.request.post("/__test/reset", { data: { queueBoardMode: "media_retry" } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator("#queueBoard")).toBeVisible();
  await expect(page.locator(".queue-card")).toHaveCount(1);
}

async function openPartialUploadBoard(page: Page) {
  await page.request.post("/__test/reset", { data: { queueBoardMode: "partial_upload" } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
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

test("codec preference editor supports a stable three-item reorder", async ({ page, browserProblems }) => {
  void browserProblems;
  await openBoard(page);
  const editor = page.locator("#bbdownEncodingPriorityEditor");
  await page.locator('#downloadSettings > summary').click();
  await editor.scrollIntoViewIfNeeded();
  const items = editor.locator(".encoding-priority-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("HEVC");
  await expect(items.nth(1)).toContainText("AVC");
  await expect(items.nth(2)).toContainText("AV1");

  await items.nth(0).getByRole("button", { name: "下移 HEVC" }).click();
  await expect(items.nth(0)).toContainText("AVC");
  await expect(items.nth(1)).toContainText("HEVC");
  await expect(items.nth(2)).toContainText("AV1");

  await items.nth(2).dragTo(items.nth(0));
  await expect(items.nth(0)).toContainText("AV1");
  await expect(items.nth(1)).toContainText("AVC");
  await expect(items.nth(2)).toContainText("HEVC");
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

test("strict media retry card offers a specification picker without unsafe direct upload", async ({ page, browserProblems }) => {
  void browserProblems;
  await openMediaRetryBoard(page);
  const card = page.locator(".queue-card");
  await expect(card.locator(".queue-status")).toContainText("新候选未通过远端确认");
  await expect(card.getByRole("button", { name: "换规格" })).toBeVisible();
  await expect(card.getByRole("button", { name: "重新确认" })).toBeVisible();
  await expect(card.getByRole("button", { name: "继续上传" })).toBeHidden();
});

test("partial multipart recovery shows progress and does not look like a completed upload", async ({ page, browserProblems }) => {
  void browserProblems;
  await openPartialUploadBoard(page);
  const card = page.locator(".queue-card");
  await expect(card.locator(".queue-status")).toContainText("已确认 2/5 个分P");
  await expect(card.locator(".queue-status")).toContainText("已确认分P不会重复上传");
  await expect(card.locator(".queue-status")).not.toContainText("已完成");
  await expect(card.getByRole("button", { name: "重新确认" })).toBeVisible();
});
