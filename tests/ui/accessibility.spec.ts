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

async function resetFixture(page: Page) {
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator("#archiveLibraryBtn")).toBeVisible();
  await expect(page.locator(".user-item")).toHaveCount(1);
}

async function openArchiveLibrary(page: Page, testInfo: TestInfo) {
  await page.locator("#archiveLibraryBtn").click();
  await expect(page.locator("#archiveLibraryModal")).toHaveClass(/active/);
  await expect(page.locator(".archive-library-card")).toHaveCount(2);
  if (testInfo.project.name !== "desktop") {
    await page.locator('.archive-nav-item[data-archive-scope="global"]').tap();
    await expect(page.locator(".archive-library-shell")).toHaveClass(/show-content/);
  }
}

test("settings, dialogs, scroll lock and modal toasts expose one accessible layer", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop semantics coverage");
  await resetFixture(page);

  const unnamedControls = await page.locator("body > main input:not([type=hidden]), body > main select, body > main textarea").evaluateAll((controls) => controls
    .filter((control) => {
      const element = control as HTMLElement;
      return element.getClientRects().length > 0;
    })
    .filter((control) => {
      const element = control as HTMLInputElement;
      if (element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.closest("label")) return false;
      return !element.id || !document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    })
    .map((control) => (control as HTMLElement).id || control.outerHTML.slice(0, 80)));
  expect(unnamedControls).toEqual([]);

  const unnamedDialogs = await page.locator(".modal").evaluateAll((dialogs) => dialogs
    .filter((dialog) => {
      const labelledBy = dialog.getAttribute("aria-labelledby");
      return !dialog.getAttribute("aria-label") && (!labelledBy || !document.getElementById(labelledBy));
    })
    .map((dialog) => (dialog as HTMLElement).id));
  expect(unnamedDialogs).toEqual([]);

  const documentReferenceProblems = await page.evaluate(() => {
    const counts = new Map<string, number>();
    document.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
      counts.set(element.id, (counts.get(element.id) || 0) + 1);
    });
    const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => `duplicate:${id}`);
    const missingReferences: string[] = [];
    document.querySelectorAll<HTMLElement>("[aria-labelledby],[aria-describedby]").forEach((element) => {
      ["aria-labelledby", "aria-describedby"].forEach((attribute) => {
        String(element.getAttribute(attribute) || "").split(/\s+/).filter(Boolean).forEach((id) => {
          if (!document.getElementById(id)) missingReferences.push(`${element.id || element.tagName}:${attribute}:${id}`);
        });
      });
    });
    return [...duplicateIds, ...missingReferences];
  });
  expect(documentReferenceProblems).toEqual([]);

  const removeAccount = page.getByRole("button", { name: "删除账号" });
  await removeAccount.scrollIntoViewIfNeeded();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await removeAccount.click();
  await expect(page.getByRole("dialog", { name: /删除账号/ })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/modal-open/);
  await expect(page.locator("body")).toHaveClass(/modal-open/);
  await expect(page.locator("body > main")).toHaveAttribute("inert", "");
  expect(await page.locator("body").evaluate((body) => getComputedStyle(body).overflow)).toBe("hidden");
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);

  await page.evaluate(() => {
    (window as typeof window & { showToast: (message: string, type: string) => void })
      .showToast("模拟错误", "error");
  });
  await expect(page.locator("#accountRemovalModal [role=alert]")).toContainText("模拟错误");
  await expect(page.locator("#toastContainer .toast")).toHaveCount(0);
  await page.locator("#accountRemovalModal .toast-close").click();
  await expect(page.locator("#accountRemovalModal [role=alert]")).toHaveCount(0);

  await page.locator("#accountRemovalCancelBtn").click();
  await expect(page.locator("html")).not.toHaveClass(/modal-open/);
  await expect(page.locator("body")).not.toHaveClass(/modal-open/);
  await expect(page.locator("body > main")).not.toHaveAttribute("inert", "");
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
});

test("archive nested dialogs keep a single modal owner and readable metadata", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "desktop archive semantics coverage");
  await resetFixture(page);
  await openArchiveLibrary(page, testInfo);
  await page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-more').click();
  await expect(page.getByRole("dialog", { name: /Alpha/ })).toBeVisible();
  await expect(page.locator("#archiveLibraryDetail")).not.toHaveAttribute("aria-modal", "true");
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await expect(page.locator(".archive-library-main")).toHaveAttribute("inert", "");

  const contrast = await page.locator(".archive-nav-meta, .archive-library-meta, .archive-library-memberships, .archive-library-detail-meta").evaluateAll((elements) => {
    type Rgb = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgb | null => {
      const parts = value.match(/[\d.]+/g)?.map(Number) || [];
      return parts.length >= 3 ? { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 } : null;
    };
    const blend = (front: Rgb, back: Rgb): Rgb => ({
      r: front.r * front.a + back.r * (1 - front.a),
      g: front.g * front.a + back.g * (1 - front.a),
      b: front.b * front.a + back.b * (1 - front.a),
      a: 1,
    });
    const luminance = (color: Rgb) => {
      const values = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const background = (element: Element) => {
      let current: Element | null = element;
      while (current) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0) return color;
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    return elements
      .filter((element) => (element as HTMLElement).getClientRects().length > 0 && element.textContent?.trim())
      .map((element) => {
        const foreground = parse(getComputedStyle(element).color)!;
        const back = background(element);
        const rendered = foreground.a < 1 ? blend(foreground, back) : foreground;
        const values = [luminance(rendered), luminance(back)].sort((a, b) => b - a);
        return { selector:(element as HTMLElement).className, ratio:(values[0] + 0.05) / (values[1] + 0.05) };
      });
  });
  expect(contrast.length).toBeGreaterThanOrEqual(3);
  expect(Math.min(...contrast.map((entry) => entry.ratio))).toBeGreaterThanOrEqual(4.5);
});

test("mobile archive panels expose only the visible page and keep touch targets usable", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name === "desktop", "mobile panel coverage");
  await resetFixture(page);
  await page.locator("#archiveLibraryBtn").tap();
  await expect(page.locator(".archive-library-card")).toHaveCount(2);
  await expect(page.locator(".archive-library-sidebar")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".archive-library-main")).toHaveAttribute("inert", "");
  const focusWhileHidden = await page.locator("#archiveLibrarySearchInput").evaluate((input: HTMLInputElement) => {
    input.focus();
    return document.activeElement === input;
  });
  expect(focusWhileHidden).toBe(false);

  await page.locator('.archive-nav-item[data-archive-scope="global"]').tap();
  await expect(page.locator(".archive-library-shell")).toHaveClass(/show-content/);
  await expect(page.locator(".archive-library-sidebar")).toHaveAttribute("inert", "");
  await expect(page.locator(".archive-library-main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".archive-library-card-more")).toHaveCount(2);
  const touchTargets = await page.locator("#archiveLibraryMobileBackBtn, .archive-library-card-more").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width:rect.width, height:rect.height };
  }));
  expect(touchTargets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);

  await page.locator("#archiveLibraryMobileBackBtn").tap();
  await expect(page.locator(".archive-library-sidebar")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".archive-library-main")).toHaveAttribute("inert", "");
  await expect(page.locator('.archive-nav-item[data-archive-scope="global"]')).toBeFocused();
});

test("reduced motion suppresses decorative transitions", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  test.skip(testInfo.project.name !== "desktop", "one viewport is enough for motion preference coverage");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await resetFixture(page);
  const durations = await page.locator(".card").first().evaluate((element) => ({
    animation:getComputedStyle(element).animationDuration,
    transition:getComputedStyle(element).transitionDuration,
  }));
  const seconds = (value: string) => value.split(",").map((part) => {
    const number = Number.parseFloat(part);
    return part.trim().endsWith("ms") ? number / 1000 : number;
  });
  expect(Math.max(...seconds(durations.animation))).toBeLessThanOrEqual(0.001);
  expect(Math.max(...seconds(durations.transition))).toBeLessThanOrEqual(0.001);
});
