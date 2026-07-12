import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export type UploadLayout = "user-folder-video" | "folder-video" | "video-only";
export type BBDownApiMode = "web" | "app";

export interface AppConfig {
  pollIntervalMinutes: number;
  perVideoDelaySeconds: number;
  uploadLayout: UploadLayout;
  alistUrl: string;
  alistUsername: string;
  alistPassword: string;
  alistDest: string;
  maxRetries: number;
  retryDelaySeconds: number;
  concurrentDownloads: number;
  concurrentUploads: number;
  uploadFileIntervalSeconds: number;
  localCacheLimitGB: number;
  queuePrefetchLimit: number;
  bbdownEncoding: string;
  bbdownQuality: string;
  bbdownApiMode: BBDownApiMode;
  bbdownHiRes: boolean;
  bbdownDolby: boolean;
  filenameTemplate: string;
  renameScanMaxFiles: number;
  remoteVerifyConcurrency: number;
  remoteVerifyRateLimitPerSecond: number;
  remoteRequeueLimitPerCycle: number;
}

const configPath = path.join(dataDir, "config.json");

const defaultConfig: AppConfig = {
  pollIntervalMinutes: 10,
  perVideoDelaySeconds: 15,
  uploadLayout: "user-folder-video",
  alistUrl: "http://alist:5244",
  alistUsername: "admin",
  alistPassword: "",
  alistDest: "/bili-backup/videos",
  maxRetries: 3,
  retryDelaySeconds: 5,
  concurrentDownloads: 1,
  concurrentUploads: 2,
  uploadFileIntervalSeconds: 10,
  localCacheLimitGB: 10,
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
};

const configKeys = Object.keys(defaultConfig) as (keyof AppConfig)[];

function normalizeFilenameTemplate(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return defaultConfig.filenameTemplate;
  }
  const normalized = value.trim().includes("<bvid>") ? value.trim() : `${value.trim()}-<bvid>`;
  return normalized.length <= 240 ? normalized : defaultConfig.filenameTemplate;
}

export function normalizeLoadedConfig(input: Partial<AppConfig> & { startupRecoveryBatchSize?: number }) {
  const merged: AppConfig = { ...defaultConfig };
  for (const key of configKeys) {
    const value = input[key];
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  }
  const legacyPrefetch = Number(input.startupRecoveryBatchSize);
  if (input.queuePrefetchLimit === undefined && Number.isInteger(legacyPrefetch)) {
    merged.queuePrefetchLimit = legacyPrefetch;
  }
  if (input.bbdownApiMode === undefined && (merged.bbdownHiRes || merged.bbdownDolby)) {
    merged.bbdownApiMode = "app";
  }
  merged.filenameTemplate = normalizeFilenameTemplate(merged.filenameTemplate);
  return merged;
}

function needsConfigMigration(input: Partial<AppConfig>, normalized: AppConfig) {
  if (Object.keys(input).some((key) => !configKeys.includes(key as keyof AppConfig))) {
    return true;
  }
  return configKeys.some((key) => input[key] !== normalized[key]);
}

export class ConfigStore {
  private config: AppConfig;

  constructor() {
    const stored = readJsonFile<Partial<AppConfig>>(configPath, defaultConfig);
    this.config = normalizeLoadedConfig(stored);
    if (needsConfigMigration(stored, this.config)) {
      writeJsonFile(configPath, this.config);
    }
  }

  get() {
    return { ...this.config };
  }

  reload() {
    const stored = readJsonFile<Partial<AppConfig>>(configPath, defaultConfig);
    this.config = normalizeLoadedConfig(stored);
    return this.get();
  }

  update(next: Partial<AppConfig>) {
    const merged: AppConfig = {
      ...this.config,
      ...next,
    };
    this.config = merged;
    writeJsonFile(configPath, this.config);
    return this.get();
  }

  reset() {
    this.config = { ...defaultConfig };
  }
}

const allowedKeys = new Set<keyof AppConfig>([
  "pollIntervalMinutes",
  "perVideoDelaySeconds",
  "uploadLayout",
  "alistUrl",
  "alistUsername",
  "alistPassword",
  "alistDest",
  "maxRetries",
  "retryDelaySeconds",
  "concurrentDownloads",
  "concurrentUploads",
  "uploadFileIntervalSeconds",
  "localCacheLimitGB",
  "queuePrefetchLimit",
  "bbdownEncoding",
  "bbdownQuality",
  "bbdownApiMode",
  "bbdownHiRes",
  "bbdownDolby",
  "filenameTemplate",
  "renameScanMaxFiles",
  "remoteVerifyConcurrency",
  "remoteVerifyRateLimitPerSecond",
  "remoteRequeueLimitPerCycle",
]);

const allowedEncodings = new Set(["", "HEVC", "AVC", "AV1"]);
const allowedQualities = new Set(["", "8K", "4K", "1080P60", "1080P", "720P"]);

export function validateConfig(input: Partial<AppConfig>) {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key as keyof AppConfig)) {
      return `Unknown config field: ${key}`;
    }
  }

  if (input.pollIntervalMinutes !== undefined) {
    if (!Number.isFinite(input.pollIntervalMinutes) || input.pollIntervalMinutes < 1) {
      return "pollIntervalMinutes must be >= 1";
    }
  }

  if (input.perVideoDelaySeconds !== undefined) {
    if (!Number.isFinite(input.perVideoDelaySeconds) || input.perVideoDelaySeconds < 0) {
      return "perVideoDelaySeconds must be >= 0";
    }
  }

  if (input.maxRetries !== undefined) {
    if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 20) {
      return "maxRetries must be an integer between 0 and 20";
    }
  }

  if (input.retryDelaySeconds !== undefined) {
    if (!Number.isFinite(input.retryDelaySeconds) || input.retryDelaySeconds < 1 || input.retryDelaySeconds > 3600) {
      return "retryDelaySeconds must be between 1 and 3600";
    }
  }

  if (input.concurrentDownloads !== undefined) {
    if (!Number.isInteger(input.concurrentDownloads) || input.concurrentDownloads < 1 || input.concurrentDownloads > 5) {
      return "concurrentDownloads must be an integer between 1 and 5";
    }
  }

  if (input.concurrentUploads !== undefined) {
    if (!Number.isInteger(input.concurrentUploads) || input.concurrentUploads < 1 || input.concurrentUploads > 10) {
      return "concurrentUploads must be an integer between 1 and 10";
    }
  }

  if (input.localCacheLimitGB !== undefined) {
    if (!Number.isFinite(input.localCacheLimitGB) || input.localCacheLimitGB < 0 || input.localCacheLimitGB > 1024) {
      return "localCacheLimitGB must be between 0 and 1024";
    }
  }

  if (input.uploadFileIntervalSeconds !== undefined) {
    if (!Number.isFinite(input.uploadFileIntervalSeconds) || input.uploadFileIntervalSeconds < 0 || input.uploadFileIntervalSeconds > 120) {
      return "uploadFileIntervalSeconds must be between 0 and 120";
    }
  }

  if (input.queuePrefetchLimit !== undefined) {
    if (!Number.isInteger(input.queuePrefetchLimit) || input.queuePrefetchLimit < 5 || input.queuePrefetchLimit > 100) {
      return "queuePrefetchLimit must be an integer between 5 and 100";
    }
  }

  if (input.alistUrl !== undefined) {
    if (typeof input.alistUrl !== "string" || input.alistUrl.trim().length === 0) {
      return "alistUrl is required";
    }
    try {
      const url = new URL(input.alistUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "alistUrl must be an http(s) URL";
      }
    } catch {
      return "alistUrl must be a valid URL";
    }
  }

  if (input.alistUsername !== undefined) {
    if (typeof input.alistUsername !== "string") {
      return "alistUsername must be a string";
    }
  }

  if (input.alistPassword !== undefined) {
    if (typeof input.alistPassword !== "string") {
      return "alistPassword must be a string";
    }
  }

  if (input.alistDest !== undefined) {
    if (typeof input.alistDest !== "string" || input.alistDest.trim().length === 0) {
      return "alistDest is required";
    }
    if (!input.alistDest.trim().startsWith("/")) {
      return "alistDest must start with /";
    }
  }

  if (input.uploadLayout !== undefined) {
    if (![
      "user-folder-video",
      "folder-video",
      "video-only",
    ].includes(input.uploadLayout)) {
      return "uploadLayout is invalid";
    }
  }

  if (input.bbdownEncoding !== undefined) {
    if (typeof input.bbdownEncoding !== "string" || !allowedEncodings.has(input.bbdownEncoding)) {
      return "bbdownEncoding is invalid";
    }
  }

  if (input.bbdownQuality !== undefined) {
    if (typeof input.bbdownQuality !== "string" || !allowedQualities.has(input.bbdownQuality)) {
      return "bbdownQuality is invalid";
    }
  }

  if (input.bbdownApiMode !== undefined && input.bbdownApiMode !== "web" && input.bbdownApiMode !== "app") {
    return "bbdownApiMode must be web or app";
  }

  if (input.bbdownHiRes !== undefined && typeof input.bbdownHiRes !== "boolean") {
    return "bbdownHiRes must be a boolean";
  }

  if (input.bbdownDolby !== undefined && typeof input.bbdownDolby !== "boolean") {
    return "bbdownDolby must be a boolean";
  }

  if (input.filenameTemplate !== undefined) {
    if (typeof input.filenameTemplate !== "string" || input.filenameTemplate.trim().length === 0 || input.filenameTemplate.length > 240) {
      return "filenameTemplate must be a non-empty string up to 240 characters";
    }
    if (!input.filenameTemplate.includes("<bvid>")) {
      return "filenameTemplate must include <bvid>";
    }
  }

  if (input.renameScanMaxFiles !== undefined) {
    if (!Number.isInteger(input.renameScanMaxFiles) || input.renameScanMaxFiles < 100 || input.renameScanMaxFiles > 100_000) {
      return "renameScanMaxFiles must be an integer between 100 and 100000";
    }
  }

  if (input.remoteVerifyConcurrency !== undefined) {
    if (!Number.isInteger(input.remoteVerifyConcurrency) || input.remoteVerifyConcurrency < 1 || input.remoteVerifyConcurrency > 100) {
      return "remoteVerifyConcurrency must be an integer between 1 and 100";
    }
  }

  if (input.remoteVerifyRateLimitPerSecond !== undefined) {
    if (!Number.isFinite(input.remoteVerifyRateLimitPerSecond) || input.remoteVerifyRateLimitPerSecond < 0.5 || input.remoteVerifyRateLimitPerSecond > 100) {
      return "remoteVerifyRateLimitPerSecond must be between 0.5 and 100";
    }
  }

  if (input.remoteRequeueLimitPerCycle !== undefined) {
    if (!Number.isInteger(input.remoteRequeueLimitPerCycle) || input.remoteRequeueLimitPerCycle < 1 || input.remoteRequeueLimitPerCycle > 1000) {
      return "remoteRequeueLimitPerCycle must be an integer between 1 and 1000";
    }
  }

  return null;
}

export function validateBBDownRuntimeConfig(
  config: Pick<AppConfig, "bbdownApiMode" | "bbdownHiRes" | "bbdownDolby">,
  users: Array<{ id: string; name?: string; enabled: boolean; accessToken?: string }>
) {
  if (config.bbdownApiMode === "web" && (config.bbdownHiRes || config.bbdownDolby)) {
    return "Hi-Res 和杜比音效必须使用 APP 接口";
  }

  if (config.bbdownApiMode === "app") {
    const missingUsers = users.filter((user) => user.enabled && !String(user.accessToken || "").trim());
    if (missingUsers.length > 0) {
      return `APP 接口需要所有启用账号具有 access token，请重新扫码登录：${missingUsers.map((user) => user.name || user.id).join("、")}`;
    }
  }
  return null;
}
