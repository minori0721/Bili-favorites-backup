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

test('opening and closing pending issues shares the in-flight board request', async ({page,browserProblems}) => {
  void browserProblems;
  await page.request.post('/__test/reset',{data:{queueBoardMode:'manual_wait'}});
  await page.route('https://fonts.googleapis.com/**',route => route.fulfill({body:''}));
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/queue/state',async route => {
    requests += 1;
    const response = await route.fetch();
    await pending;
    await route.fulfill({response});
  });
  await page.goto('/');
  try {
    await expect.poll(() => requests).toBe(1);
    await page.locator('#recoveryIssuesBtn').click();
    await expect(page.locator('#recoveryIssuesModal')).toHaveClass(/active/);
    await page.locator('#closeRecoveryIssuesBtn').click();
    expect(requests).toBe(1);
  } finally { release(); }
  await expect(page.locator('.queue-card')).toHaveCount(1);
  expect(requests).toBe(1);
  await page.locator('#recoveryIssuesBtn').click();
  await expect.poll(() => requests).toBe(2);
  await page.locator('#closeRecoveryIssuesBtn').click();
});

test('queue covers prefer local files, fall back once, and do not reset on polling', async ({ page }) => {
  const requests: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64');
  await page.route('**/covers/review*.png', r => { requests.push(r.request().url()); return r.fulfill({ contentType: 'image/png', body: png }); });
  await page.route('https://example.invalid/cover.png', r => { requests.push(r.request().url()); return r.fulfill({ contentType: 'image/png', body: png }); });
  let polls = 0;
  await page.route('**/api/queue/state', async route => {
    const response = await route.fetch();
    const json = await response.json();
    for (const key of ['downloadPending', 'downloadRunning', 'uploadPending', 'uploadRunning']) {
      for (const item of json.data[key] || []) Object.assign(item, {coverLocalPath:'covers/review.png', cover:'https://example.invalid/cover.png'});
    }
    polls++;
    await route.fulfill({json});
  });
  await page.clock.install();
  await openBoard(page);
  const img = page.locator('.queue-card img.queue-cover');
  await expect(img).toHaveAttribute('src', /\/covers\/review.png$/);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).not.toContain('example.invalid');
  await img.evaluate((image) => {
    image.dataset.srcMutations = '0';
    const observer = new MutationObserver(records => { image.dataset.srcMutations = String(Number(image.dataset.srcMutations) + records.length); });
    observer.observe(image, { attributes: true, attributeFilter: ['src'] });
  });
  const before = polls;
  await page.clock.fastForward(16000);
  await expect.poll(() => polls).toBeGreaterThan(before);
  await expect(img).toHaveAttribute('data-src-mutations', '0');
  await img.dispatchEvent('error');
  await expect(img).toHaveAttribute('src', 'https://example.invalid/cover.png');
  await expect.poll(() => requests.length).toBe(2);
  await img.dispatchEvent('error');
  await expect(page.locator('.queue-card .queue-cover')).toHaveText('封面');
  const afterFailure = polls;
  await page.clock.fastForward(16000);
  await expect.poll(() => polls).toBeGreaterThan(afterFailure);
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
  await expect(page.locator('[data-queue-column="uploadPending"] .queue-col-title span').first()).toHaveText('待上传/收尾');
  await expect(page.locator('[data-queue-column="uploadRunning"] .queue-col-title span').first()).toHaveText('上传/收尾中');
  const headingsFit = await page.locator('#queueBoard .queue-col-title').evaluateAll(headings =>
    headings.every(heading => heading.scrollWidth <= heading.clientWidth + 1));
  expect(headingsFit).toBe(true);
  await expect(page.locator("#logConsole")).toBeHidden();
});

test('scheduler shows polling time and account cooldown as separate values', async ({page,browserProblems}) => {
  void browserProblems;
  await page.route('**/api/queue/state',async route => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.scheduler = {status:'cooldown',title:'账号冷却中',detail:'账号稍后恢复',queuedActions:[],
      nextRunAt:Date.parse('2030-01-01T10:00:00Z'),accountCooldown:{count:2,earliestUntil:Date.parse('2030-01-01T11:00:00Z')}};
    json.data.recovery.pendingQualityMaintenance = 1;
    await route.fulfill({json});
  });
  await openBoard(page);
  const box = page.locator('#schedulerStatusBox');
  await expect(box.locator('summary')).toContainText('下次自动同步');
  await box.locator('summary').click();
  await expect(box).toContainText('账号冷却：2 个账号');
  await expect(box).toContainText('画质收尾 1');
  const times = await box.locator('.scheduler-status-grid > div').allTextContents();
  expect(times.find(row => row.startsWith('下次自动同步：'))).not.toEqual(times.find(row => row.startsWith('账号冷却：')));
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

test('queue recovery deduplicates rapid actions and restores controls after failure', async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/queue/recover', async route => {
    calls++;
    if (calls === 1) {
      await pending;
      await route.fulfill({ status: 503, json: { success: false, message: '稍后重试' } });
    } else await route.fulfill({ json: { success: true, data: { resolved: 'verified_archive' } } });
  });
  await openPartialUploadBoard(page);
  const recheck = page.locator('.queue-card').getByRole('button', { name: '重新确认' });
  await recheck.dispatchEvent('click');
  await recheck.dispatchEvent('click');
  await expect.poll(() => calls).toBe(1);
  await expect(recheck).toBeDisabled();
  release();
  await expect(recheck).toBeEnabled();
  await recheck.click();
  await expect.poll(() => calls).toBe(2);
  await expect(recheck).toBeEnabled();
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
