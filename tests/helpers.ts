import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../src/config.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    pollIntervalMinutes: 10,
    perVideoDelaySeconds: 0,
    uploadLayout: "user-folder-video",
    alistUrl: "http://127.0.0.1:1",
    alistUsername: "test",
    alistPassword: "test",
    alistDest: "/backup",
    maxRetries: 2,
    retryDelaySeconds: 1,
    concurrentDownloads: 1,
    concurrentUploads: 2,
    uploadFileIntervalSeconds: 0,
    localCacheLimitGB: 0,
    queuePrefetchLimit: 25,
    bbdownEncoding: "",
    bbdownQuality: "",
    bbdownApiMode: "web",
    bbdownHiRes: false,
    bbdownDolby: false,
    filenameTemplate: "<videoTitle>-<bvid>",
    renameScanMaxFiles: 10_000,
    remoteVerifyConcurrency: 3,
    remoteVerifyRateLimitPerSecond: 2,
    remoteRequeueLimitPerCycle: 20,
    ...overrides,
  };
}

export async function createTestDir(prefix: string) {
  const root = path.join(process.cwd(), ".test-runtime");
  await fs.promises.mkdir(root, { recursive: true });
  return fs.promises.mkdtemp(path.join(root, `${prefix}-`));
}

export async function removeTestDir(target: string) {
  const retryableCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
  const maxAttempts = 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!retryableCodes.has(error?.code) || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
