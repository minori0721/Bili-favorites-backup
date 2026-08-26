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

async function boot(page: Page) {
  await page.request.post("/__test/reset");
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator(".user-item")).toHaveCount(1);
}

function desktopOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "desktop", "desktop visual-system coverage");
}

test("main workspace and every standard dialog use the shared visual system", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);

  const audit = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const cards = [...document.querySelectorAll<HTMLElement>("body > main > .card")];
    const panels = [...document.querySelectorAll<HTMLElement>(".modal > .panel")];
    const style = (element: Element) => getComputedStyle(element);
    return {
      tokens: {
        panelRadius: root.getPropertyValue("--radius-panel").trim(),
        homeRadius: root.getPropertyValue("--radius-home").trim(),
        homeControlRadius: root.getPropertyValue("--radius-home-control").trim(),
        dialogRadius: root.getPropertyValue("--radius-dialog").trim(),
        controlRadius: root.getPropertyValue("--radius-control").trim(),
      },
      cards: cards.map((card) => ({
        radius: style(card).borderRadius,
        bottomBorder: style(card).borderBottomWidth,
        background: style(card).backgroundColor,
        backdrop: style(card).backdropFilter,
        shadow: style(card).boxShadow,
      })),
      dialogs: panels.map((panel) => {
        const title = panel.querySelector(":scope > h2, :scope > .section-title-row");
        const actions = panel.querySelector(":scope > .modal-actions");
        return {
          id: panel.parentElement?.id || "",
          sizeClass: [...panel.classList].find((name) => /^panel-(sm|md|lg|xl)$/.test(name)) || "",
          radius: style(panel).borderRadius,
          background: style(panel).backgroundColor,
          titleBorder: title ? style(title).borderBottomWidth : "missing",
          titlePosition: title ? style(title).position : "missing",
          actionsBorder: actions ? style(actions).borderTopWidth : "missing",
          actionsPosition: actions ? style(actions).position : "missing",
        };
      }),
      controls: {
        primaryRadius: style(document.getElementById("addUserBtn")!).borderRadius,
        secondaryRadius: style(document.getElementById("syncNowBtn")!).borderRadius,
        helpRadius: style(document.getElementById("syncHelpBtn")!).borderRadius,
        helpWidth: document.getElementById("syncHelpBtn")!.getBoundingClientRect().width,
        primaryBackground: style(document.getElementById("addUserBtn")!).backgroundColor,
        secondaryBackground: style(document.getElementById("syncNowBtn")!).backgroundColor,
      },
      emptySettingsStatusDisplay: [...document.querySelectorAll<HTMLElement>(".settings-actions ~ .status-line")]
        .map((element) => getComputedStyle(element).display),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(audit.tokens).toEqual({ panelRadius: "8px", homeRadius: "10px", homeControlRadius: "8px", dialogRadius: "10px", controlRadius: "6px" });
  expect(audit.cards).toHaveLength(3);
  expect(audit.cards[0].radius).toBe("10px 10px 0px 0px");
  expect(audit.cards[1].radius).toBe("0px");
  expect(audit.cards[2].radius).toBe("0px 0px 10px 10px");
  expect(audit.cards.every((card) => card.background.startsWith("rgba(") && card.backdrop.includes("blur") && card.shadow !== "none")).toBe(true);
  expect(audit.dialogs.length).toBeGreaterThanOrEqual(16);
  expect(audit.dialogs.every((dialog) => dialog.sizeClass && dialog.radius === "10px")).toBe(true);
  expect(audit.dialogs.every((dialog) => dialog.background.startsWith("rgba(") && dialog.background !== "rgba(0, 0, 0, 0)")).toBe(true);
  expect(audit.dialogs.every((dialog) => dialog.titleBorder === "1px" && dialog.titlePosition === "sticky")).toBe(true);
  expect(audit.dialogs.every((dialog) => dialog.actionsBorder === "1px" && dialog.actionsPosition === "sticky")).toBe(true);
  expect(audit.controls.primaryRadius).toBe("8px");
  expect(audit.controls.secondaryRadius).toBe("8px");
  expect(audit.controls.helpRadius).toBe("8px");
  expect(audit.controls.helpWidth).toBe(32);
  expect(audit.controls.primaryBackground).not.toBe(audit.controls.secondaryBackground);
  expect(audit.emptySettingsStatusDisplay).toEqual(["none", "none", "none"]);
  expect(audit.overflow).toBe(0);
});

test("dangerous dialogs keep the safe action on the left and the destructive action on the right", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);

  const removeButton = page.getByRole("button", { name: "删除账号" });
  await removeButton.scrollIntoViewIfNeeded();
  await removeButton.click();
  await expect(page.locator("#accountRemovalModal")).toHaveClass(/active/);
  const positions = await page.locator("#accountRemovalModal .modal-actions").evaluate((footer) => {
    const cancel = footer.querySelector<HTMLElement>("#accountRemovalCancelBtn")!.getBoundingClientRect();
    const submit = footer.querySelector<HTMLElement>("#accountRemovalSubmitBtn")!.getBoundingClientRect();
    const style = getComputedStyle(footer);
    return { cancelLeft: cancel.left, submitLeft: submit.left, justify: style.justifyContent };
  });
  expect(positions.cancelLeft).toBeLessThan(positions.submitLeft);
  expect(positions.justify).toBe("flex-end");
});

test("mobile standard dialogs stay inside the viewport with a reachable sticky footer", async ({ page, browserProblems }) => {
  void browserProblems;
  await boot(page);
  await page.locator("#settingsHelpBtn").click();
  await expect(page.locator("#settingsHelpModal")).toHaveClass(/active/);

  const metrics = await page.locator("#settingsHelpModal .panel").evaluate((panel) => {
    const panelRect = panel.getBoundingClientRect();
    const title = panel.querySelector<HTMLElement>(":scope > h2")!;
    const footer = panel.querySelector<HTMLElement>(":scope > .modal-actions")!;
    const footerRect = footer.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      panelTop: panelRect.top,
      panelBottom: panelRect.bottom,
      panelRadius: getComputedStyle(panel).borderRadius,
      titlePosition: getComputedStyle(title).position,
      footerPosition: getComputedStyle(footer).position,
      footerBottom: footerRect.bottom,
    };
  });

  expect(metrics.documentOverflow).toBe(0);
  expect(metrics.panelLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.panelRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.panelTop).toBeGreaterThanOrEqual(0);
  expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.footerBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.titlePosition).toBe("sticky");
  expect(metrics.footerPosition).toBe("sticky");
  expect(metrics.panelRadius).toMatch(/^10px 10px 0px 0px|10px$/);
});

test("full-screen workspaces share glass chrome while the player keeps its immersive theme", async ({ page, browserProblems }, testInfo) => {
  void browserProblems;
  desktopOnly(testInfo);
  await boot(page);

  await page.locator("#archiveLibraryBtn").click();
  await expect(page.locator("#archiveLibraryModal")).toHaveClass(/active/);
  const archiveChrome = await page.locator("#archiveLibraryModal").evaluate((modal) => {
    const close = modal.querySelector<HTMLElement>("#closeArchiveLibraryBtn")!;
    const topbar = modal.querySelector<HTMLElement>(".archive-library-topbar")!;
    return {
      closeRadius: getComputedStyle(close).borderRadius,
      topbarBackground: getComputedStyle(topbar).backgroundColor,
    };
  });
  await page.locator("#closeArchiveLibraryBtn").click();

  await page.locator("#recoveryIssuesBtn").click();
  await expect(page.locator("#recoveryIssuesModal")).toHaveClass(/active/);
  const recoveryChrome = await page.locator("#recoveryIssuesModal").evaluate((modal) => {
    const close = modal.querySelector<HTMLElement>("#closeRecoveryIssuesBtn")!;
    const header = modal.querySelector<HTMLElement>(".recovery-issues-header")!;
    return {
      closeRadius: getComputedStyle(close).borderRadius,
      headerBackground: getComputedStyle(header).backgroundColor,
    };
  });

  expect(archiveChrome.closeRadius).toBe("6px");
  expect(recoveryChrome.closeRadius).toBe("6px");
  expect(archiveChrome.topbarBackground).toBe(recoveryChrome.headerBackground);
  expect(await page.locator(".playback-shell").evaluate((player) => getComputedStyle(player).backgroundColor)).not.toBe(archiveChrome.topbarBackground);
});
