import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.BFB_FAKE_UI_PORT || 43197);

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  globalSetup: "./tests/ui/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "mobile-landscape",
      use: { ...devices["Pixel 5 landscape"], viewport: { width: 844, height: 390 } },
    },
  ],
});
