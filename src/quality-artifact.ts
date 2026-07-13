import crypto from "node:crypto";
import type { AppConfig } from "./config.js";

export interface QualityArtifactProfile {
  quality: string;
  encoding: string;
  hiRes: boolean;
  dolby: boolean;
  filenameTemplate: string;
}

export function normalizeQualityArtifactProfile(input: Partial<QualityArtifactProfile>): QualityArtifactProfile {
  return {
    quality: String(input.quality || "").trim().toUpperCase(),
    encoding: String(input.encoding || "").trim().toUpperCase(),
    hiRes: Boolean(input.hiRes),
    dolby: Boolean(input.dolby),
    filenameTemplate: String(input.filenameTemplate || "<videoTitle>-<bvid>").trim(),
  };
}

export function qualityArtifactProfileFromConfig(config: AppConfig): QualityArtifactProfile {
  return normalizeQualityArtifactProfile({
    quality: config.bbdownQuality,
    encoding: config.bbdownEncoding,
    hiRes: config.bbdownHiRes,
    dolby: config.bbdownDolby,
    filenameTemplate: config.filenameTemplate,
  });
}

export function buildQualityArtifactKey(bvid: string, profile: QualityArtifactProfile) {
  const normalizedProfile = normalizeQualityArtifactProfile(profile);
  return crypto.createHash("sha256").update(JSON.stringify({
    bvid: String(bvid || "").trim(),
    ...normalizedProfile,
  })).digest("hex");
}

export function applyQualityArtifactProfile(config: AppConfig, profile: QualityArtifactProfile): AppConfig {
  const normalized = normalizeQualityArtifactProfile(profile);
  return {
    ...config,
    bbdownQuality: normalized.quality,
    bbdownEncoding: normalized.encoding,
    bbdownHiRes: normalized.hiRes,
    bbdownDolby: normalized.dolby,
    filenameTemplate: normalized.filenameTemplate,
  };
}
