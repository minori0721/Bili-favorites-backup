import path from "node:path";
import { dataDir } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./storage.js";

export type UploadLayout = "user-folder-video" | "folder-video" | "video-only";

export interface AppConfig {
  pollIntervalMinutes: number;
  perVideoDelaySeconds: number;
  rcloneDestination: string;
  uploadLayout: UploadLayout;
  rcloneWebUrl: string;
}

const configPath = path.join(dataDir, "config.json");

const defaultConfig: AppConfig = {
  pollIntervalMinutes: 10,
  perVideoDelaySeconds: 15,
  rcloneDestination: "my_s3:bili-backup/videos",
  uploadLayout: "user-folder-video",
  rcloneWebUrl: "http://localhost:5572",
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

  if (input.rcloneDestination !== undefined) {
    if (typeof input.rcloneDestination !== "string" || input.rcloneDestination.trim().length === 0) {
      return "rcloneDestination is required";
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

  if (input.rcloneWebUrl !== undefined) {
    if (typeof input.rcloneWebUrl !== "string" || input.rcloneWebUrl.trim().length === 0) {
      return "rcloneWebUrl is required";
    }
  }

  return null;
}
