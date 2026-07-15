import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isBBDownCredentialDirectoryName } from "./credential-temp.js";
import type { AppConfig } from "./config.js";
import type { QualityArtifactProfile } from "./quality-artifact.js";
import { writeJsonFile } from "./storage.js";

export const DOWNLOAD_SESSION_FILE = ".bfb-download.json";
export const DOWNLOAD_RETAINED_FILE = ".bfb-retained.json";
export const BBDOWN_SOURCE_COMMIT = "fcb895f357df49c45010cefab773025d5d50cf7c";
const PREVIOUS_BBDOWN_SOURCE_COMMIT = "42815977dff36d2bab783ce125e209191dcca037";
const LEGACY_BBDOWN_SOURCE_COMMIT = "259a5558cee0a349a7ebb60bd31e40c88e5bc1ed";

export type DownloadSessionKind = "backup" | "quality_upgrade";
export type DownloadSessionStatus = "prepared" | "downloading" | "complete" | "partial" | "failed";

export interface DownloadPageSnapshot {
  index: number;
  cid: number;
  title: string;
  duration: number;
  publishedAt?: number;
}

export interface DownloadOutputRecord {
  pageIndex: number;
  cid: number;
  relativePath: string;
  size: number;
  duration: number;
  videoCodec: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  quickHash: string;
  verifiedAt: string;
}

export interface HistoricalOutputRecord extends DownloadOutputRecord {
  snapshotAt: string;
  reason: "removed" | "replaced" | "legacy_unmatched";
  uploadedTargets?: string[];
}

export interface DownloadSessionManifest {
  schemaVersion: 1;
  sessionId: string;
  kind: DownloadSessionKind;
  bvid: string;
  accountUid: number;
  bbdownCommit: string;
  configFingerprint: string;
  configSnapshot: {
    quality: string;
    encoding: string;
    apiMode?: "web" | "app";
    hiRes: boolean;
    dolby: boolean;
    filenameTemplate: string;
  };
  createdAt: string;
  updatedAt: string;
  snapshotAt: string;
  publishedAt?: number;
  status: DownloadSessionStatus;
  pages: DownloadPageSnapshot[];
  outputs: DownloadOutputRecord[];
  history: HistoricalOutputRecord[];
  qualityUpgrade?: {
    userId: string;
    mediaId: number;
    folderTitle: string;
    remotePath: string;
    oldFiles: Array<{ name: string; path: string; size?: number; qualityProfile?: { quality: string; encoding: string; hiRes: boolean; dolby: boolean } }>;
    artifactKey?: string;
    qualityProfile?: QualityArtifactProfile;
    downloadUserId?: string;
    targets?: Array<{
      userId: string;
      mediaId: number;
      folderTitle: string;
      remotePath: string;
      oldFiles: Array<{ name: string; path: string; size?: number; qualityProfile?: { quality: string; encoding: string; hiRes: boolean; dolby: boolean } }>;
    }>;
  };
  legacyAdopted?: boolean;
  lastError?: string;
}

export interface PreparedDownloadSession {
  manifest: DownloadSessionManifest;
  missingPages: DownloadPageSnapshot[];
  recoveredPages: number;
  incompatibleFragmentsMoved: number;
  unavailable: boolean;
}

export interface DownloadRecoverySummary {
  resumableSessions: number;
  completedPages: number;
  totalPages: number;
  retainedBytes: number;
  legacyDirectories: number;
  legacyBytes: number;
  cleanupEligibleBytes: number;
}

export interface DownloadCacheInspection {
  usedBytes: number;
  fileCount: number;
  exportableBytes: number;
  exportableFiles: number;
  recovery: DownloadRecoverySummary;
}

export interface DownloadCleanupResult {
  removedFiles: number;
  removedDirectories: number;
  removedBytes: number;
}

export interface Aria2TrackRecoveryIssue {
  pageIndex: number;
  track: "video" | "audio";
  reason: "range" | "length" | "control";
}

function nowIso() {
  return new Date().toISOString();
}

function safeStamp(value = nowIso()) {
  return value.replace(/[-:.]/g, "").replace(/Z$/, "Z");
}

export function downloadSessionPath(downloadDir: string) {
  return path.join(downloadDir, DOWNLOAD_SESSION_FILE);
}

function configSnapshot(config: AppConfig): DownloadSessionManifest["configSnapshot"] {
  return {
    quality: String(config.bbdownQuality || ""),
    encoding: String(config.bbdownEncoding || ""),
    apiMode: config.bbdownApiMode === "app" ? "app" : "web",
    hiRes: Boolean(config.bbdownHiRes),
    dolby: Boolean(config.bbdownDolby),
    filenameTemplate: String(config.filenameTemplate || "<videoTitle>-<bvid>"),
  };
}

export function buildDownloadConfigFingerprint(config: AppConfig, accountUid: number) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ accountUid, bbdownCommit: BBDOWN_SOURCE_COMMIT, ...configSnapshot(config) }))
    .digest("hex");
}

export function readDownloadSession(downloadDir: string): DownloadSessionManifest | null {
  const filePath = downloadSessionPath(downloadDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DownloadSessionManifest;
    if (parsed?.schemaVersion !== 1 || !parsed.bvid || !Array.isArray(parsed.pages)) return null;
    parsed.outputs = normalizeManifestOutputPaths<DownloadOutputRecord>(parsed.outputs);
    parsed.history = normalizeManifestOutputPaths<HistoricalOutputRecord>(parsed.history);
    return parsed;
  } catch {
    return null;
  }
}

function normalizeManifestRelativePath(value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return null;
  }
  const normalized = path.normalize(value.replace(/[\\/]+/g, path.sep));
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`) ? normalized : null;
}

function normalizeManifestOutputPaths<T extends { relativePath: string }>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  const outputs: T[] = [];
  for (const output of value) {
    if (!output || typeof output !== "object") continue;
    const relativePath = normalizeManifestRelativePath((output as any).relativePath);
    if (!relativePath) continue;
    outputs.push({ ...(output as T), relativePath });
  }
  return outputs;
}

export function writeDownloadSession(downloadDir: string, manifest: DownloadSessionManifest) {
  manifest.updatedAt = nowIso();
  writeJsonFile(downloadSessionPath(downloadDir), manifest);
}

function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    const extension = process.platform === "win32" ? ".exe" : "";
    const candidate = path.join(path.dirname(process.env.FFMPEG_PATH), `ffprobe${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ffprobe";
}

async function runFfprobe(filePath: string) {
  const args = [
    "-v", "error",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic",
    "-of", "json",
    filePath,
  ];
  return new Promise<any>((resolve, reject) => {
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function quickFileHash(filePath: string, size: number) {
  const sampleSize = Math.min(1024 * 1024, size);
  const file = await fs.promises.open(filePath, "r");
  try {
    const first = Buffer.alloc(sampleSize);
    const last = Buffer.alloc(sampleSize);
    const firstRead = await file.read(first, 0, sampleSize, 0);
    const lastPosition = Math.max(0, size - sampleSize);
    const lastRead = await file.read(last, 0, sampleSize, lastPosition);
    return crypto
      .createHash("sha256")
      .update(String(size))
      .update(first.subarray(0, firstRead.bytesRead))
      .update(last.subarray(0, lastRead.bytesRead))
      .digest("hex");
  } finally {
    await file.close();
  }
}

export async function validateMediaOutput(
  filePath: string,
  expectedDuration = 0
): Promise<Omit<DownloadOutputRecord, "pageIndex" | "cid" | "relativePath" | "verifiedAt">> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("media file is empty");
  const info = await runFfprobe(filePath);
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const video = streams.find((stream: any) => stream?.codec_type === "video" && Number(stream?.disposition?.attached_pic || 0) !== 1);
  if (!video) throw new Error("media file has no playable video stream");
  const audio = streams.find((stream: any) => stream?.codec_type === "audio");
  const duration = Number(info?.format?.duration || video?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("media duration is unavailable");
  if (expectedDuration > 0) {
    const tolerance = Math.max(5, expectedDuration * 0.03);
    if (Math.abs(duration - expectedDuration) > tolerance) {
      throw new Error(`media duration mismatch: expected ${expectedDuration}s, received ${duration.toFixed(3)}s`);
    }
  }
  return {
    size: stat.size,
    duration,
    videoCodec: String(video.codec_name || "unknown"),
    audioCodec: audio?.codec_name ? String(audio.codec_name) : undefined,
    width: Number(video.width || 0) || undefined,
    height: Number(video.height || 0) || undefined,
    quickHash: await quickFileHash(filePath, stat.size),
  };
}

function mediaFileName(value: string) {
  return /\.(mp4|mkv|flv|mov|m4v)$/i.test(value);
}

function inferPageIndex(fileName: string, pageCount: number) {
  if (pageCount === 1) return 1;
  const stem = fileName.replace(/\.[^.]+$/, "");
  const match = /_P0*(\d+)$/i.exec(stem);
  return match ? Number(match[1]) : 0;
}

async function listCandidateMediaFiles(downloadDir: string) {
  const files: string[] = [];
  const walk = async (currentDir: string, depth: number): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, fullPath);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") || (depth === 0 && /^\d+$/.test(entry.name))) continue;
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && mediaFileName(entry.name)) {
        files.push(relativePath);
      }
    }
  };
  await walk(downloadDir, 0);
  return files;
}

async function movePreserving(source: string, target: string) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.promises.rename(source, target);
  } catch (error: any) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source);
  }
}

async function quarantineFile(downloadDir: string, fileName: string, group: "_invalid" | "_incompatible") {
  const source = path.join(downloadDir, fileName);
  const target = path.join(downloadDir, group, safeStamp(), fileName);
  await movePreserving(source, target);
  return path.relative(downloadDir, target);
}

function reindexedOutputPath(relativePath: string, oldIndex: number, newIndex: number) {
  if (oldIndex === newIndex) return relativePath;
  const directory = path.dirname(relativePath);
  const extension = path.extname(relativePath);
  const stem = path.basename(relativePath, extension);
  const match = /_P(\d+)$/i.exec(stem);
  if (!match || Number(match[1]) !== oldIndex) return relativePath;
  const nextPage = String(newIndex).padStart(match[1].length, "0");
  return path.join(directory, `${stem.slice(0, match.index)}_P${nextPage}${extension}`);
}

async function reindexRetainedOutputs(
  downloadDir: string,
  moves: Array<{ output: DownloadOutputRecord; from: string; to: string }>
) {
  if (moves.length === 0) return;
  const stageRoot = path.join(downloadDir, "_reindex", safeStamp());
  const staged: Array<{ output: DownloadOutputRecord; tempPath: string; targetRelative: string }> = [];
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const source = path.join(downloadDir, move.from);
    if (!fs.existsSync(source)) continue;
    const tempPath = path.join(stageRoot, `${index}-${path.basename(move.from)}`);
    await movePreserving(source, tempPath);
    staged.push({ output: move.output, tempPath, targetRelative: move.to });
  }
  for (const item of staged) {
    let targetRelative = item.targetRelative;
    let target = path.join(downloadDir, targetRelative);
    if (fs.existsSync(target)) {
      const extension = path.extname(targetRelative);
      const stem = path.basename(targetRelative, extension);
      targetRelative = path.join(path.dirname(targetRelative), `${stem}-CID${item.output.cid}${extension}`);
      target = path.join(downloadDir, targetRelative);
    }
    await movePreserving(item.tempPath, target);
    item.output.relativePath = targetRelative;
  }
  await fs.promises.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
}

function isUnsafeResumeArtifact(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (/\.(aria2|tmp|vclip|aclip|part|download)$/i.test(normalized)) return true;
  const parts = normalized.split("/");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return false;
  const name = parts[parts.length - 1];
  return /\.P\d+\..*\.(mp4|m4a)$/i.test(name) || /\.P\d+\.back_ground\.m4a$/i.test(name);
}

async function quarantineIncompatibleFragments(downloadDir: string) {
  const stamp = safeStamp();
  let moved = 0;
  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, source);
      if (relativePath.split(path.sep).some((segment) => ["_history", "_invalid", "_incompatible"].includes(segment))) continue;
      if (entry.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!entry.isFile() || !isUnsafeResumeArtifact(relativePath)) continue;
      const target = path.join(downloadDir, "_incompatible", stamp, relativePath);
      await movePreserving(source, target);
      moved += 1;
    }
  };
  await walk(downloadDir);
  return moved;
}

function matchesAria2Track(relativePath: string, issue: Aria2TrackRecoveryIssue) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return false;
  const name = parts[parts.length - 1];
  if (!new RegExp(`\\.P0*${issue.pageIndex}(?:\\.|$)`, "i").test(name)) return false;
  return issue.track === "video"
    ? /\.mp4(?:\.aria2)?$/i.test(name)
    : /\.(?:m4a|aac)(?:\.aria2)?$/i.test(name);
}

export async function quarantineBrokenAria2Track(downloadDir: string, issue: Aria2TrackRecoveryIssue) {
  const candidates: string[] = [];
  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(currentDir, entry.name);
      const relativePath = path.relative(downloadDir, source);
      if (relativePath.split(path.sep).some((segment) => ["_history", "_invalid", "_incompatible"].includes(segment))) continue;
      if (entry.isDirectory()) {
        await walk(source);
      } else if (entry.isFile() && matchesAria2Track(relativePath, issue)) {
        candidates.push(relativePath);
      }
    }
  };
  await walk(downloadDir);
  if (candidates.length === 0) return 0;
  const stamp = `aria2-reset-${safeStamp()}`;
  for (const relativePath of candidates) {
    await movePreserving(
      path.join(downloadDir, relativePath),
      path.join(downloadDir, "_incompatible", stamp, relativePath)
    );
  }
  return candidates.length;
}

async function reconcileChangedPages(downloadDir: string, manifest: DownloadSessionManifest, pages: DownloadPageSnapshot[]) {
  const currentByCid = new Map(pages.map((page) => [page.cid, page]));
  const currentByIndex = new Map(pages.map((page) => [page.index, page]));
  const retained: DownloadOutputRecord[] = [];
  const reindexMoves: Array<{ output: DownloadOutputRecord; from: string; to: string }> = [];
  for (const output of manifest.outputs) {
    const currentPage = currentByCid.get(output.cid);
    if (currentPage) {
      const retainedOutput = { ...output, pageIndex: currentPage.index };
      const nextRelativePath = reindexedOutputPath(output.relativePath, output.pageIndex, currentPage.index);
      if (nextRelativePath !== output.relativePath) {
        reindexMoves.push({ output: retainedOutput, from: output.relativePath, to: nextRelativePath });
      }
      retained.push(retainedOutput);
      continue;
    }
    const source = path.join(downloadDir, output.relativePath);
    if (!fs.existsSync(source)) continue;
    const reason: HistoricalOutputRecord["reason"] = currentByIndex.has(output.pageIndex) ? "replaced" : "removed";
    const historyRelative = path.join("_history", safeStamp(manifest.snapshotAt), path.basename(output.relativePath));
    await movePreserving(source, path.join(downloadDir, historyRelative));
    manifest.history.push({ ...output, relativePath: historyRelative, snapshotAt: manifest.snapshotAt, reason });
  }
  await reindexRetainedOutputs(downloadDir, reindexMoves);
  manifest.outputs = retained;
}

async function scanAndValidateOutputs(downloadDir: string, manifest: DownloadSessionManifest) {
  const candidateFiles = await listCandidateMediaFiles(downloadDir);
  const pagesByIndex = new Map(manifest.pages.map((page) => [page.index, page]));
  const existingByPath = new Map(manifest.outputs.map((output) => [output.relativePath, output]));
  const outputs: DownloadOutputRecord[] = [];
  for (const output of manifest.outputs) {
    const filePath = path.join(downloadDir, output.relativePath);
    const page = pagesByIndex.get(output.pageIndex);
    if (!fs.existsSync(filePath) || !page || page.cid !== output.cid) continue;
    try {
      const details = await validateMediaOutput(filePath, page.duration);
      if (output.quickHash && output.quickHash !== details.quickHash) throw new Error("media quick hash changed");
      outputs.push({ ...output, ...details, verifiedAt: nowIso() });
    } catch {
      if (path.dirname(output.relativePath) === ".") {
        await quarantineFile(downloadDir, output.relativePath, "_invalid");
      }
    }
  }
  const recordedPaths = new Set(outputs.map((output) => output.relativePath));
  for (const relativePath of candidateFiles) {
    if (recordedPaths.has(relativePath)) continue;
    const fileName = path.basename(relativePath);
    const pageIndex = existingByPath.get(relativePath)?.pageIndex || inferPageIndex(fileName, manifest.pages.length);
    const page = pagesByIndex.get(pageIndex);
    if (!page) {
      const details = await validateMediaOutput(path.join(downloadDir, relativePath), 0).catch(() => null);
      if (details) {
        const historyRelative = path.join("_history", safeStamp(manifest.snapshotAt), fileName);
        await movePreserving(path.join(downloadDir, relativePath), path.join(downloadDir, historyRelative));
        manifest.history.push({
          ...details,
          pageIndex: pageIndex || 0,
          cid: 0,
          relativePath: historyRelative,
          verifiedAt: nowIso(),
          snapshotAt: manifest.snapshotAt,
          reason: "legacy_unmatched",
        });
      } else {
        await quarantineFile(downloadDir, relativePath, "_invalid");
      }
      continue;
    }
    try {
      const details = await validateMediaOutput(path.join(downloadDir, relativePath), page.duration);
      outputs.push({
        ...details,
        pageIndex: page.index,
        cid: page.cid,
        relativePath,
        verifiedAt: nowIso(),
      });
      recordedPaths.add(relativePath);
    } catch {
      await quarantineFile(downloadDir, relativePath, "_invalid");
    }
  }
  const uniqueByCid = new Map<number, DownloadOutputRecord>();
  for (const output of outputs) {
    if (output.cid && !uniqueByCid.has(output.cid)) uniqueByCid.set(output.cid, output);
  }
  manifest.outputs = [...uniqueByCid.values()].sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function prepareDownloadSession(options: {
  downloadDir: string;
  bvid: string;
  accountUid: number;
  config: AppConfig;
  kind?: DownloadSessionKind;
  pages: DownloadPageSnapshot[];
  publishedAt?: number;
  unavailable?: boolean;
  qualityUpgrade?: DownloadSessionManifest["qualityUpgrade"];
}) : Promise<PreparedDownloadSession> {
  const { downloadDir, bvid, accountUid, config } = options;
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const fingerprint = buildDownloadConfigFingerprint(config, accountUid);
  let manifest = readDownloadSession(downloadDir);
  let incompatibleFragmentsMoved = 0;
  if (!manifest || manifest.bvid !== bvid) {
    const existingManifestPath = downloadSessionPath(downloadDir);
    if (!manifest && fs.existsSync(existingManifestPath)) {
      const preservedPath = `${existingManifestPath}.corrupt-${safeStamp()}`;
      await fs.promises.copyFile(existingManifestPath, preservedPath).catch(() => undefined);
    }
    const at = nowIso();
    manifest = {
      schemaVersion: 1,
      sessionId: crypto.randomUUID(),
      kind: options.kind || "backup",
      bvid,
      accountUid,
      bbdownCommit: BBDOWN_SOURCE_COMMIT,
      configFingerprint: fingerprint,
      configSnapshot: configSnapshot(config),
      createdAt: at,
      updatedAt: at,
      snapshotAt: at,
      publishedAt: options.publishedAt,
      status: "prepared",
      pages: options.pages,
      outputs: [],
      history: [],
      qualityUpgrade: options.qualityUpgrade,
      legacyAdopted: fs.readdirSync(downloadDir).some((name) => name !== DOWNLOAD_SESSION_FILE),
    };
  } else {
    if (options.qualityUpgrade) manifest.qualityUpgrade = options.qualityUpgrade;
    if (manifest.configFingerprint !== fingerprint || manifest.accountUid !== accountUid || manifest.bbdownCommit !== BBDOWN_SOURCE_COMMIT) {
      const nextSnapshot = configSnapshot(config);
      const previousSnapshot = manifest.configSnapshot;
      const sameRuntimeConfig = manifest.accountUid === accountUid
        && previousSnapshot.quality === nextSnapshot.quality
        && previousSnapshot.encoding === nextSnapshot.encoding
        && previousSnapshot.hiRes === nextSnapshot.hiRes
        && previousSnapshot.dolby === nextSnapshot.dolby
        && previousSnapshot.filenameTemplate === nextSnapshot.filenameTemplate;
      const compatibleBbdownUpgrade = manifest.bbdownCommit === PREVIOUS_BBDOWN_SOURCE_COMMIT
        && previousSnapshot.apiMode === nextSnapshot.apiMode
        && sameRuntimeConfig;
      const legacyWebUpgrade = !previousSnapshot.apiMode
        && nextSnapshot.apiMode === "web"
        && sameRuntimeConfig
        && (
          manifest.bbdownCommit === BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === PREVIOUS_BBDOWN_SOURCE_COMMIT
          || manifest.bbdownCommit === LEGACY_BBDOWN_SOURCE_COMMIT
        );
      if (!legacyWebUpgrade && !compatibleBbdownUpgrade) {
        incompatibleFragmentsMoved = await quarantineIncompatibleFragments(downloadDir);
      }
      manifest.configFingerprint = fingerprint;
      manifest.configSnapshot = nextSnapshot;
      manifest.accountUid = accountUid;
      manifest.bbdownCommit = BBDOWN_SOURCE_COMMIT;
    }
    if (options.pages.length > 0) {
      await reconcileChangedPages(downloadDir, manifest, options.pages);
      manifest.pages = options.pages;
      manifest.snapshotAt = nowIso();
    }
    if (options.publishedAt) manifest.publishedAt = options.publishedAt;
  }
  await scanAndValidateOutputs(downloadDir, manifest);
  if (options.unavailable && manifest.outputs.length === 0 && manifest.history.length > 0) {
    manifest.outputs = manifest.history.map(({ snapshotAt: _snapshotAt, reason: _reason, uploadedTargets: _uploadedTargets, ...output }) => output);
    manifest.history = [];
  }
  const completedCids = new Set(manifest.outputs.map((output) => output.cid));
  const missingPages = manifest.pages.filter((page) => !completedCids.has(page.cid));
  manifest.status = missingPages.length === 0 && manifest.pages.length > 0
    ? "complete"
    : options.unavailable && manifest.outputs.length > 0
      ? "partial"
      : "prepared";
  manifest.lastError = undefined;
  writeDownloadSession(downloadDir, manifest);
  return {
    manifest,
    missingPages,
    recoveredPages: manifest.outputs.length,
    incompatibleFragmentsMoved,
    unavailable: Boolean(options.unavailable),
  };
}

export async function refreshDownloadSessionOutputs(downloadDir: string) {
  const manifest = readDownloadSession(downloadDir);
  if (!manifest) throw new Error(`Download session manifest is missing: ${downloadDir}`);
  await scanAndValidateOutputs(downloadDir, manifest);
  const completedCids = new Set(manifest.outputs.map((output) => output.cid));
  const missingPages = manifest.pages.filter((page) => !completedCids.has(page.cid));
  manifest.status = missingPages.length === 0 && manifest.pages.length > 0 ? "complete" : "prepared";
  writeDownloadSession(downloadDir, manifest);
  return { manifest, missingPages };
}

export function markDownloadSessionStatus(downloadDir: string, status: DownloadSessionStatus, error?: string) {
  const manifest = readDownloadSession(downloadDir);
  if (!manifest) return;
  manifest.status = status;
  manifest.lastError = error;
  writeDownloadSession(downloadDir, manifest);
}

export function buildSelectPageArgument(pages: DownloadPageSnapshot[]) {
  const indexes = [...new Set(pages.map((page) => page.index).filter((value) => value > 0))].sort((a, b) => a - b);
  const groups: string[] = [];
  for (let start = 0; start < indexes.length;) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end] + 1) end += 1;
    groups.push(end > start + 1 ? `${indexes[start]}-${indexes[end]}` : indexes.slice(start, end + 1).join(","));
    start = end + 1;
  }
  return groups.join(",");
}

export function currentSessionFiles(downloadDir: string) {
  const manifest = readDownloadSession(downloadDir);
  return manifest?.outputs.map((output) => output.relativePath) || [];
}

export function historySessionGroups(downloadDir: string) {
  const manifest = readDownloadSession(downloadDir);
  if (!manifest) return [];
  const groups = new Map<string, HistoricalOutputRecord[]>();
  for (const output of manifest.history) {
    const list = groups.get(output.snapshotAt) || [];
    list.push(output);
    groups.set(output.snapshotAt, list);
  }
  return [...groups.entries()].map(([snapshotAt, files]) => ({ snapshotAt, files }));
}

export function markHistoryGroupUploaded(downloadDir: string, snapshotAt: string, targetKey: string) {
  const manifest = readDownloadSession(downloadDir);
  if (!manifest) return;
  let changed = false;
  for (const output of manifest.history) {
    if (output.snapshotAt !== snapshotAt) continue;
    output.uploadedTargets ||= [];
    if (!output.uploadedTargets.includes(targetKey)) {
      output.uploadedTargets.push(targetKey);
      changed = true;
    }
  }
  if (changed) writeDownloadSession(downloadDir, manifest);
}

async function removeEmptyDirectories(target: string, root: string): Promise<void> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(target, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(target, entry.name), root);
  }
  if (target === root) return;
  try {
    if ((await fs.promises.readdir(target)).length === 0) await fs.promises.rmdir(target);
  } catch {
    // Directory changed while cleaning; preserve it.
  }
}

export async function cleanupUploadedSessionFiles(downloadDir: string) {
  const manifest = readDownloadSession(downloadDir);
  if (!manifest) {
    let remaining: string[] = [];
    try { remaining = await fs.promises.readdir(downloadDir); } catch { /* already removed */ }
    if (remaining.length === 0) {
      await fs.promises.rm(downloadDir, { recursive: true, force: true });
      return { removedDirectory: true, retainedBytes: 0 };
    }
    const retainedBytes = directorySizeSync(downloadDir);
    writeJsonFile(path.join(downloadDir, DOWNLOAD_RETAINED_FILE), {
      schemaVersion: 1,
      bvid: path.basename(downloadDir),
      retainedAt: nowIso(),
      reason: "The download session manifest was missing during cleanup; all local files were preserved.",
    });
    return { removedDirectory: false, retainedBytes };
  }
  const uploadedPaths = new Set([
    ...manifest.outputs.map((output) => output.relativePath),
    ...manifest.history.map((output) => output.relativePath),
  ]);
  for (const relativePath of uploadedPaths) {
    await fs.promises.unlink(path.join(downloadDir, relativePath)).catch(() => undefined);
  }
  await fs.promises.unlink(downloadSessionPath(downloadDir)).catch(() => undefined);
  await removeEmptyDirectories(downloadDir, downloadDir);
  const retainedBytes = directorySizeSync(downloadDir);
  let remaining: string[] = [];
  try { remaining = await fs.promises.readdir(downloadDir); } catch { /* removed concurrently */ }
  if (remaining.length === 0) {
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
    return { removedDirectory: true, retainedBytes: 0 };
  }
  writeJsonFile(path.join(downloadDir, DOWNLOAD_RETAINED_FILE), {
    schemaVersion: 1,
    bvid: manifest.bvid,
    sessionId: manifest.sessionId,
    retainedAt: nowIso(),
    reason: "Unverified local artifacts were preserved after all verified outputs were uploaded.",
  });
  return { removedDirectory: false, retainedBytes };
}

function directorySizeSync(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(target).reduce((sum, name) => sum + directorySizeSync(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

function listFilesSync(rootDir: string) {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(path.relative(rootDir, fullPath));
    }
  };
  try { walk(rootDir); } catch { /* files may change while the queue is running */ }
  return files;
}

function emptyDownloadRecoverySummary(): DownloadRecoverySummary {
  return {
    resumableSessions: 0,
    completedPages: 0,
    totalPages: 0,
    retainedBytes: 0,
    legacyDirectories: 0,
    legacyBytes: 0,
    cleanupEligibleBytes: 0,
  };
}

function classifyManifestRecoverySet(manifest: DownloadSessionManifest, files: Iterable<string>) {
  const retained = new Set<string>();
  const cleanup = new Set<string>();
  const existing = new Set([...files].map((file) => file.replace(/\\/g, "/")));
  let aria2Controls = 0;
  for (const output of [...manifest.outputs, ...(manifest.history || [])]) {
    const relativePath = String(output.relativePath || "").replace(/\\/g, "/");
    if (relativePath && existing.has(relativePath)) retained.add(relativePath);
  }
  for (const relativeFile of existing) {
    const segments = relativeFile.split("/");
    if (segments.some((segment) => segment === "_invalid" || segment === "_incompatible")) continue;
    if (!/\.aria2$/i.test(relativeFile)) continue;
    aria2Controls += 1;
    retained.add(relativeFile);
    const dataFile = relativeFile.replace(/\.aria2$/i, "");
    if (existing.has(dataFile)) retained.add(dataFile);
  }
  for (const relativeFile of existing) {
    const segments = relativeFile.split("/");
    if (segments.some((segment) => segment === "_invalid" || segment === "_incompatible")) {
      cleanup.add(relativeFile);
      continue;
    }
    if (/\.aria2$/i.test(relativeFile)) continue;
    if (isUnsafeResumeArtifact(relativeFile) && !retained.has(relativeFile)) cleanup.add(relativeFile);
  }
  return { retained, cleanup, aria2Controls };
}

function classifyManifestRecovery(downloadDir: string, manifest: DownloadSessionManifest) {
  return classifyManifestRecoverySet(manifest, listFilesSync(downloadDir));
}

function summarizeManifestRecovery(downloadDir: string, manifest: DownloadSessionManifest) {
  const { retained, cleanup, aria2Controls } = classifyManifestRecovery(downloadDir, manifest);
  const sizeOf = (items: Set<string>) => [...items].reduce((total, relativeFile) =>
    total + directorySizeSync(path.join(downloadDir, relativeFile)), 0);
  const incomplete = ["prepared", "downloading", "failed"].includes(manifest.status);
  return {
    resumable: incomplete && (manifest.outputs.length > 0 || aria2Controls > 0),
    retainedBytes: sizeOf(retained),
    cleanupEligibleBytes: sizeOf(cleanup),
  };
}

export async function cleanupDownloadRecoveryArtifacts(rootDir: string): Promise<DownloadCleanupResult> {
  const result: DownloadCleanupResult = { removedFiles: 0, removedDirectories: 0, removedBytes: 0 };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const downloadDir = path.join(rootDir, entry.name);
    if (isBBDownCredentialDirectoryName(entry.name)) {
      await fs.promises.rm(downloadDir, { recursive: true, force: true });
      result.removedDirectories += 1;
      continue;
    }
    if (fs.existsSync(path.join(downloadDir, DOWNLOAD_RETAINED_FILE))) {
      result.removedBytes += directorySizeSync(downloadDir);
      await fs.promises.rm(downloadDir, { recursive: true, force: true });
      result.removedDirectories += 1;
      continue;
    }
    if (!/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;

    const manifest = readDownloadSession(downloadDir);
    const candidates = manifest
      ? [...classifyManifestRecovery(downloadDir, manifest).cleanup]
      : listFilesSync(downloadDir).filter((relativeFile) => /\.(aria2|tmp|vclip|aclip|part|download)$/i.test(relativeFile));
    const root = path.resolve(downloadDir);
    for (const relativeFile of candidates) {
      const target = path.resolve(downloadDir, relativeFile);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(target);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fs.promises.unlink(target);
      result.removedFiles += 1;
      result.removedBytes += stat.size;
    }
    await removeEmptyDirectories(downloadDir, downloadDir);
  }
  return result;
}

export function inspectDownloadRecoverySync(rootDir: string): DownloadRecoverySummary {
  const summary = emptyDownloadRecoverySummary();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return summary;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    if (isBBDownCredentialDirectoryName(entry.name)) {
      continue;
    }
    const bytes = directorySizeSync(dir);
    if (fs.existsSync(path.join(dir, DOWNLOAD_RETAINED_FILE))) {
      summary.cleanupEligibleBytes += bytes;
      continue;
    }
    const manifest = readDownloadSession(dir);
    if (manifest) {
      const recovery = summarizeManifestRecovery(dir, manifest);
      if (recovery.resumable) summary.resumableSessions += 1;
      summary.completedPages += manifest.outputs.length;
      summary.totalPages += manifest.pages.length;
      summary.retainedBytes += recovery.retainedBytes;
      summary.cleanupEligibleBytes += recovery.cleanupEligibleBytes;
      continue;
    }
    if (!/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
    summary.legacyDirectories += 1;
    summary.legacyBytes += bytes;
    const walk = (target: string) => {
      for (const name of fs.readdirSync(target)) {
        const fullPath = path.join(target, name);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) walk(fullPath);
        else if (/\.(aria2|tmp|vclip|aclip|part|download)$/i.test(name)) summary.cleanupEligibleBytes += stat.size;
      }
    };
    try { walk(dir); } catch { /* ignore files changing during scan */ }
  }
  return summary;
}

async function listFileSizes(rootDir: string) {
  const files = new Map<string, number>();
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.lstat(fullPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          files.set(path.relative(rootDir, fullPath).replace(/\\/g, "/"), stat.size);
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return files;
}

async function readDownloadSessionAsync(downloadDir: string) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(downloadSessionPath(downloadDir), "utf8")) as DownloadSessionManifest;
    if (parsed?.schemaVersion !== 1 || !parsed.bvid || !Array.isArray(parsed.pages)) return null;
    parsed.outputs = normalizeManifestOutputPaths<DownloadOutputRecord>(parsed.outputs);
    parsed.history = normalizeManifestOutputPaths<HistoricalOutputRecord>(parsed.history);
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function inspectDownloadCache(rootDir: string, concurrency = 4): Promise<DownloadCacheInspection> {
  const result: DownloadCacheInspection = {
    usedBytes: 0,
    fileCount: 0,
    exportableBytes: 0,
    exportableFiles: 0,
    recovery: emptyDownloadRecoverySummary(),
  };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }

  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      const stat = await fs.promises.lstat(path.join(rootDir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      result.usedBytes += stat.size;
      result.fileCount += 1;
      result.exportableBytes += stat.size;
      result.exportableFiles += 1;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < directories.length) {
      const entry = directories[cursor++];
      const downloadDir = path.join(rootDir, entry.name);
      const fileSizes = await listFileSizes(downloadDir);
      const bytes = [...fileSizes.values()].reduce((total, size) => total + size, 0);
      result.usedBytes += bytes;
      result.fileCount += fileSizes.size;
      if (!isBBDownCredentialDirectoryName(entry.name)) {
        result.exportableBytes += bytes;
        result.exportableFiles += fileSizes.size;
      }
      if (isBBDownCredentialDirectoryName(entry.name)) continue;
      if (fileSizes.has(DOWNLOAD_RETAINED_FILE)) {
        result.recovery.cleanupEligibleBytes += bytes;
        continue;
      }
      if (!/^BV[0-9A-Za-z]+$/i.test(entry.name)) continue;
      const manifest = await readDownloadSessionAsync(downloadDir);
      if (!manifest) {
        result.recovery.legacyDirectories += 1;
        result.recovery.legacyBytes += bytes;
        for (const [relativeFile, size] of fileSizes) {
          if (/\.(aria2|tmp|vclip|aclip|part|download)$/i.test(relativeFile)) {
            result.recovery.cleanupEligibleBytes += size;
          }
        }
        continue;
      }
      const classified = classifyManifestRecoverySet(manifest, fileSizes.keys());
      const sizeOf = (items: Set<string>) => [...items].reduce((total, relativeFile) => total + (fileSizes.get(relativeFile) || 0), 0);
      if (["prepared", "downloading", "failed"].includes(manifest.status)
        && (manifest.outputs.length > 0 || classified.aria2Controls > 0)) {
        result.recovery.resumableSessions += 1;
      }
      result.recovery.completedPages += manifest.outputs.length;
      result.recovery.totalPages += manifest.pages.length;
      result.recovery.retainedBytes += sizeOf(classified.retained);
      result.recovery.cleanupEligibleBytes += sizeOf(classified.cleanup);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(concurrency)), directories.length || 1) }, worker));
  return result;
}

export function findLegacyCover(downloadDir: string) {
  const stack = [downloadDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith("_")) stack.push(fullPath);
      if (entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name)) return fullPath;
    }
  }
  return undefined;
}
