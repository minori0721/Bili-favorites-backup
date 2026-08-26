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

async function openOnlineContent(page: Page) {
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator("#onlineContentBtn")).toBeVisible();
  await page.locator("#onlineContentBtn").click();
  await expect(page.locator("#onlineContentModal")).toHaveClass(/active/);
  await expect(page.locator(".online-content-card")).toHaveCount(1);
  await expect(page.locator(".online-content-card")).toContainText("在线待归档视频");
}

test("online content loads on demand and keeps its layers isolated from archive library", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  await openOnlineContent(page);
  await expect(page.locator(".archive-library-main")).toHaveCount(1);
  await expect(page.locator(".online-content-main")).toHaveCount(1);
  await expect(page.locator(".archive-library-sidebar")).toHaveCount(1);
  await expect(page.locator(".online-content-sidebar")).toHaveCount(1);
  await expect(page.locator("#onlineContentNav .archive-nav-item").first()).toContainText("11 个视频");
  await expect(page.locator("#onlineContentSummary")).toHaveText("共 1 项");
  const closeButtons = await page.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.getElementById("closeOnlineContentBtn")!).display,
    mainDisplay: getComputedStyle(document.getElementById("onlineContentCloseMainBtn")!).display,
    sidebarVisibility: getComputedStyle(document.querySelector(".online-content-sidebar")!).visibility,
    showContent: document.querySelector(".online-content-shell")!.classList.contains("show-content"),
  }));
  if (testInfo.project.name === "desktop") {
    expect(closeButtons.sidebarDisplay).toBe("none");
    expect(closeButtons.mainDisplay).not.toBe("none");
  } else {
    expect(closeButtons.sidebarDisplay).not.toBe("none");
    expect(closeButtons.sidebarVisibility).toBe("hidden");
    expect(closeButtons.showContent).toBe(true);
  }
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.onlineNavigationCount).toBe(1);
  expect(state.onlineItemQueries).toEqual([""]);
});

test("mobile online content exposes the directory close only after returning to the directory", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "mobile directory controls coverage");
  await openOnlineContent(page);
  await page.locator("#onlineContentMobileBackBtn").tap();
  await expect(page.locator(".online-content-shell")).not.toHaveClass(/show-content/);
  const controls = await page.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.getElementById("closeOnlineContentBtn")!).display,
    sidebarVisibility: getComputedStyle(document.querySelector(".online-content-sidebar")!).visibility,
    mainTransform: getComputedStyle(document.querySelector(".online-content-main")!).transform,
  }));
  expect(controls.sidebarDisplay).not.toBe("none");
  expect(controls.sidebarVisibility).toBe("visible");
  expect(controls.mainTransform).not.toBe("none");
});

test("online manual archive probes a strict target before queueing it", async ({ page, browserProblems }) => {
  void browserProblems;
  await openOnlineContent(page);
  await page.getByRole("button", { name: "手动归档" }).click();
  await expect(page.locator("#manualArchiveOptionsModal")).toHaveClass(/active/);
  await page.locator("#manualArchiveQuality").selectOption("4K");
  await page.locator("#manualArchiveEncoding").selectOption("AV1");
  await page.locator("#manualArchiveProbeBtn").click();
  await expect(page.locator("#manualArchiveProbeResult")).toContainText("已探测 1 个分P");
  await expect(page.locator("#manualArchiveProbeResult")).toContainText("预计成品");
  await expect(page.locator("#manualArchiveProbeResult")).toContainText("本地峰值约");
  await expect(page.locator("#manualArchiveProbeResult")).toContainText("缓存可用");
  await page.locator("#manualArchiveStartBtn").click();
  await expect(page.locator("#manualArchiveOptionsModal")).not.toHaveClass(/active/);
  await expect(page.locator("#onlineContentFooter")).toContainText("已进入手动归档队列");
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.mediaProbeStartCount).toBe(1);
  expect(state.manualArchiveCount).toBe(1);
});

test("closing online content cancels its debounced search", async ({ page, browserProblems }) => {
  void browserProblems;
  await openOnlineContent(page);
  await page.locator("#onlineContentSearchInput").fill("late");
  await page.locator("#onlineContentCloseMainBtn").evaluate((element) => (element as HTMLElement).click());
  await page.waitForTimeout(450);
  const state = await page.request.get("/__test/state").then((response) => response.json());
  expect(state.onlineItemQueries).not.toContain("late");
});
