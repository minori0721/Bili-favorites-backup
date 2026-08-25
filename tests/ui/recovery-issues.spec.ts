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

type RecoveryFixtureKind = "visibility" | "candidate" | "create_candidate" | "download" | "quality" | "storage";

async function openRecoveryCenter(
  page: Page,
  recoveryIssueKind: RecoveryFixtureKind = "candidate",
  resetData: Record<string, unknown> = {},
) {
  await page.request.post("/__test/reset", { data: { ...resetData, recoveryIssueKind } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto("/");
  const expectedBadge = recoveryIssueKind === "candidate" ? "待处理 0 · 待确认 1" : "待处理 1";
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText(expectedBadge);
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
  await expect(row).toContainText("测试归档视频：新候选待确认");
  await expect(page.locator("#recoveryIssuesSummary")).toContainText("待确认 1");
  await expect(page.locator("#recoveryIssuesListCount")).toHaveText("1 项");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("发生了什么");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("来源收藏夹");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("下一步");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("没有自动覆盖或删除远端文件");
  await expect(page.locator("#recoveryIssuesDetail")).toContainText("正式旧路径保持不变");
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

test("background remote visibility recovery does not ask for manual action", async ({ page, browserProblems }) => {
  void browserProblems;
  await page.request.post("/__test/reset", { data: { recoveryIssueKind: "visibility" } });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.goto("/");
  await expect(page.locator("#recoveryIssuesBtn")).toHaveText("待处理 0");
  await page.locator("#recoveryIssuesBtn").click();
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  await expect(page.locator("#recoveryIssuesEmptyTitle")).toHaveText("当前没有需要处理的问题");
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

test("abandon candidate requires confirmation and is sent only once", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await openRecoveryCenter(page, "candidate");
  const row = page.locator(".recovery-issue-row");
  if (testInfo.project.name === "desktop") await row.click();
  else await row.tap();
  await page.getByRole("button", { name: "放弃本次候选" }).click();
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  await expect(page.locator("#confirmActionDetail")).toContainText("原归档不会被删除或覆盖");
  await page.locator("#confirmActionOkBtn").evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
  expect(state.lastRecoveryAction).toBe("abandon_attempt");
});

test("complete local groups can create one isolated candidate without touching the official path", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop nested confirmation coverage");
  await openRecoveryCenter(page, "create_candidate");
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "生成隔离候选" }).click();
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  await expect(page.locator("#confirmActionTitle")).toHaveText("生成隔离候选");
  await expect(page.locator("#confirmActionDetail")).toContainText("正式旧路径不会覆盖、移动或删除");
  await expect(page.locator("#confirmActionDetail")).toContainText("额外远端空间和上传流量");
  await expect(page.locator("#recoveryIssuesModal")).toHaveAttribute("aria-hidden", "true");
  await page.locator("#confirmActionOkBtn").evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
  expect(state.lastRecoveryAction).toBe("create_candidate");
});

test("alternate-account download recovery submits only the selected account", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await openRecoveryCenter(page, "download");
  const row = page.locator(".recovery-issue-row");
  if (testInfo.project.name === "desktop") await row.click();
  else await row.tap();
  await page.getByRole("button", { name: "换账号下载" }).click();
  await expect(page.locator("#recoveryChoiceModal")).toHaveClass(/active/);
  await expect(page.locator("#recoveryChoiceSelect")).toHaveValue("user-2");
  await expect(page.locator("#recoveryChoiceSelect")).toContainText("备用账号（UID 20002）");
  await page.locator("#recoveryChoiceSubmitBtn").click();
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
  expect(state.lastRecoveryAction).toBe("retry_download_with_account");
  expect(state.lastRecoveryBody).toEqual({ userId: "user-2" });
});

test("quality recovery probes Bili23-style media combinations, refines size, and submits one strict profile", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop encoding dialog coverage");
  await openRecoveryCenter(page, "quality");
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "重新选择画质与编码" }).click();
  await expect(page.locator("#encodingRetryModal")).toHaveClass(/active/);
  await expect(page.locator("#encodingRetryTitle")).toHaveText("重新选择画质与编码");
  await expect(page.locator("#encodingRetryCopy")).toContainText("可用媒体组合和大小");
  await expect(page.locator("#encodingRetryCopy")).toContainText("现有归档不会进入覆盖或删除流程");
  const hevc1080 = page.getByRole("radio", { name: /1080P · HEVC/ });
  await expect(hevc1080).toBeEnabled();
  await expect(hevc1080).toContainText("15.0 MB");
  await hevc1080.click();
  await expect(page.locator("#encodingRetryProbeSummary")).toContainText("已更新所选组合的大小信息");
  await expect(page.locator("#encodingRetryEstimate")).toContainText("预计成品 15.0 MB");
  await expect(page.locator("#encodingRetryEstimate")).toContainText("Range 精确大小");
  await page.locator("#encodingRetrySubmitBtn").click();
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.recoveryActionCount).toBe(1);
  expect(state.lastRecoveryAction).toBe("retry_quality_with_encoding");
  expect(state.lastRecoveryBody).toEqual({ quality: "1080P", encodingPriority: ["HEVC", "AVC", "AV1"], strict: true });
  expect(state.mediaProbeStartCount).toBe(2);
  expect(state.mediaProbeBodies).toEqual([
    { userId: "user-1", bvid: "BV1RECOVERY1", strict: false },
    { userId: "user-1", bvid: "BV1RECOVERY1", quality: "1080P", encoding: "HEVC", strict: true },
  ]);
});

test("an unavailable Bilibili item exposes an explicit unknown-size strict fallback without preselecting a codec", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop media fallback coverage");
  await openRecoveryCenter(page, "quality", { mediaProbeMode: "failed" });
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "重新选择画质与编码" }).click();
  await expect(page.locator("#encodingRetryProbeSummary")).toContainText("稿件不可见");
  await expect(page.locator("#encodingRetryManual")).toBeVisible();
  await expect(page.locator("#encodingRetryQuality").locator("option").first()).toHaveText("不限定画质（沿用任务设置）");
  await expect(page.locator("#encodingRetryEncoding").locator("option").first()).toHaveText("不限定编码（沿用当前偏好）");
  await expect(page.locator(".media-retry-strict-note")).toContainText("已选择的画质或编码会逐分P严格匹配");
  await expect(page.locator("#encodingRetryEncoding")).toHaveValue("");
  await expect(page.locator("#encodingRetrySubmitBtn")).toBeDisabled();
  await page.locator("#encodingRetryQuality").selectOption("1080P");
  await page.locator("#encodingRetryEncoding").selectOption("AV1");
  await expect(page.locator("#encodingRetryEstimate")).toContainText("可用性和大小尚未确认");
  await page.locator("#encodingRetrySubmitBtn").click();
  await expect(page.locator("#confirmActionModal")).toHaveClass(/active/);
  await expect(page.locator("#confirmActionMessage")).toContainText("只能提供估算");
  await page.locator("#confirmActionOkBtn").click();
  await expect(page.locator("#recoveryIssuesEmptyState")).toBeVisible();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.lastRecoveryBody).toEqual({ quality: "1080P", encodingPriority: ["AV1", "HEVC", "AVC"], strict: true });
  expect(state.mediaProbeStartCount).toBe(1);
});

test("strict retry cannot submit while the selected combination is being refined", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop media refinement timing coverage");
  await openRecoveryCenter(page, "quality");
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "重新选择画质与编码" }).click();
  await expect(page.getByRole("radio", { name: /1080P · HEVC/ })).toBeEnabled();

  let delayedRefinement = false;
  await page.route("**/api/media-probe/probe-online-1", async (route) => {
    if (route.request().method() === "GET" && !delayedRefinement) {
      delayedRefinement = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });

  await page.getByRole("radio", { name: /1080P · HEVC/ }).click();
  await expect(page.locator("#encodingRetrySubmitBtn")).toBeDisabled();
  await expect(page.locator("#encodingRetrySubmitBtn")).toHaveText("正在读取大小...");
  await expect(page.locator("#encodingRetryProbeSummary")).toContainText("已更新所选组合的大小信息");
  await expect(page.locator("#encodingRetrySubmitBtn")).toBeEnabled();
});

test("size refinement never substitutes a different media combination", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop media refinement coverage");
  await openRecoveryCenter(page, "quality", { mediaProbeMode: "refine_mismatch" });
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "重新选择画质与编码" }).click();
  const selected = page.getByRole("radio", { name: /1080P · HEVC/ });
  await selected.click();
  await expect(page.locator("#encodingRetryProbeSummary")).toContainText("所选组合没有覆盖全部分P");
  await expect(selected).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: /4K · AV1/ })).toHaveAttribute("aria-checked", "false");
});

test("storage recovery opens settings and performs exactly one read-only draft check", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop settings focus coverage");
  await openRecoveryCenter(page, "storage", { storageCheckMode: "path_error" });
  await page.locator(".recovery-issue-row").click();
  await page.getByRole("button", { name: "检查存储配置" }).click();
  await expect(page.locator("#recoveryIssuesModal")).not.toHaveClass(/active/);
  await expect(page.locator("#storageCheckBtn")).toBeFocused();
  await page.locator("#storageCheckBtn").click();
  await expect(page.locator("#storageCheckStatus")).toContainText("归档目录不可访问");
  await expect(page.locator("#storageCheckStatus")).toContainText("目标目录不存在");
  await expect(page.locator("#alistDest")).toBeFocused();
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.storageCheckCount).toBe(1);
  expect(state.storageCheckBody).toEqual({
    alistUrl: "http://alist:5244",
    alistUsername: "",
    alistPassword: "",
    alistDest: "/archive",
  });
  expect(state.recoveryActionCount).toBe(0);
});
