import { test, expect } from "@playwright/test";

test("local-only release warns about the only copy and requires explicit confirmation", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.post("/__test/reset", { data: {} });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  let releases = 0;
  await page.route("**/api/videos/BV1ALPHA001/local-release-preview", (route) => route.fulfill({ json: {
    success: true, data: { fileCount: 1, totalBytes: 5000, candidates: [
      { releaseId: "local-only", fileCount: 1, totalBytes: 5000, requiresExplicitDeletion: true, hasVerifiedArchive: false },
    ] },
  } }));
  await page.route("**/api/videos/BV1ALPHA001/local-release", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ releaseId: "local-only", confirmation: "DELETE LOCAL" });
    releases++;
    await route.fulfill({ status: 202, json: { success: true, data: {} } });
  });
  await page.goto("/");
  await page.locator("#archiveLibraryBtn").click();
  if (info.project.name !== "desktop") await page.locator('.archive-nav-item[data-archive-scope="global"]').tap();
  await page.locator('[data-archive-bvid="BV1ALPHA001"] .archive-library-card-more').click();
  await page.getByRole("button", { name: "释放本地空间", exact: true }).click();
  const modal = page.locator("#confirmActionModal");
  await expect(modal).toContainText("唯一副本");
  await expect(page.locator("#confirmActionOkBtn")).toBeDisabled();
  expect(releases).toBe(0);
  await page.locator("#confirmActionInput").fill("DELETE LOCAL");
  await page.locator("#confirmActionOkBtn").click();
  await expect.poll(() => releases).toBe(1);
  await expect(modal).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});
