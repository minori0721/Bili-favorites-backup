import { createRequire } from "node:module";

interface PackageMetadata {
  version?: string;
  homepage?: string;
}

export interface AppInfo {
  version: string;
  buildRef: string;
  revision: string;
  shortRevision: string;
  repositoryUrl: string;
  versionLabel: string;
  versionUrl: string;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

function cleanRevision(value: unknown) {
  const revision = String(value || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(revision) ? revision.toLowerCase() : "";
}

function cleanBuildRef(value: unknown) {
  const buildRef = String(value || "").trim();
  if (!buildRef || buildRef.length > 80 || !/^[0-9A-Za-z._/-]+$/.test(buildRef)) return "local";
  return buildRef;
}

function cleanRepositoryUrl(value: unknown) {
  const fallback = "https://github.com/minori0721/Bili-favorites-backup";
  const url = String(value || "").trim().replace(/\/+$/, "");
  return /^https:\/\/github\.com\/minori0721\/Bili-favorites-backup$/i.test(url) ? url : fallback;
}

export function buildAppInfo(
  env: NodeJS.ProcessEnv = process.env,
  metadata: PackageMetadata = packageMetadata
): AppInfo {
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(metadata.version || ""))
    ? String(metadata.version)
    : "0.0.0";
  const repositoryUrl = cleanRepositoryUrl(metadata.homepage);
  const buildRef = cleanBuildRef(env.BFB_BUILD_REF);
  const revision = cleanRevision(env.BFB_BUILD_REVISION);
  const shortRevision = revision.slice(0, 7);
  const releaseTag = `v${version}`;
  const versionLabel = buildRef === releaseTag
    ? `${releaseTag}${shortRevision ? ` · ${shortRevision}` : ""}`
    : `${releaseTag} · ${buildRef}${shortRevision ? `@${shortRevision}` : ""}`;
  return {
    version,
    buildRef,
    revision,
    shortRevision,
    repositoryUrl,
    versionLabel,
    versionUrl: revision ? `${repositoryUrl}/commit/${revision}` : repositoryUrl,
  };
}

export const appInfo = buildAppInfo();
