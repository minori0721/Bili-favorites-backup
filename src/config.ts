import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export type UploadLayout = "user-folder-video" | "folder-video" | "video-only";

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
  bbdownEncoding: string;
  bbdownQuality: string;
  bbdownHiRes: boolean;
  bbdownDolby: boolean;
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
  bbdownEncoding: "",
  bbdownQuality: "",
  bbdownHiRes: false,
  bbdownDolby: false,
};

export class ConfigStore {
  private config: AppConfig;

  constructor() {
    this.config = readJsonFile<AppConfig>(configPath, defaultConfig);
  }

  get() {
    return { ...this.config };
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
}

export function validateConfig(input: Partial<AppConfig>) {
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

  if (input.alistUrl !== undefined) {
    if (typeof input.alistUrl !== "string" || input.alistUrl.trim().length === 0) {
      return "alistUrl is required";
    }
  }

  if (input.alistDest !== undefined) {
    if (typeof input.alistDest !== "string" || input.alistDest.trim().length === 0) {
      return "alistDest is required";
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

  return null;
}
