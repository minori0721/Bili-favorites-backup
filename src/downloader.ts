import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tempDir } from "./paths.js";
import { buildCookieString, BiliCookie } from "./users.js";
import { AppConfig, type BBDownApiMode } from "./config.js";
import { logManager, parseBBDownOutput } from "./logger.js";
import { getVideoPageSnapshot, type VideoAccessSnapshot, type VideoPageSnapshotResult } from "./bili.js";
import { cacheLocalCover } from "./cover-cache.js";
import {
  buildSelectPageArgument,
  currentSessionFiles,
  findLegacyCover,
  markDownloadSessionStatus,
  prepareDownloadSession,
  quarantineBrokenAria2Track,
  readDownloadSession,
  refreshDownloadSessionOutputs,
  type Aria2TrackRecoveryIssue,
  type DownloadSessionKind,
  type DownloadSessionManifest,
} from "./download-session.js";

export interface DownloadResult {
  downloadDir: string;
  files: string[];
  recoveredPages: number;
  totalPages: number;
  partial: boolean;
}

export class ChargingRestrictedError extends Error {
  readonly chargingRestricted = true;
  readonly access: VideoAccessSnapshot;
  readonly accountUid: number;

  constructor(bvid: string, accountUid: number, access: VideoAccessSnapshot) {
    super(`Charging-exclusive video requires access: ${bvid}`);
    this.name = "ChargingRestrictedError";
    this.access = access;
    this.accountUid = accountUid;
  }
}

async function listInvalidArtifacts(downloadDir: string) {
  const files = new Set<string>();
  const invalidDir = path.join(downloadDir, "_invalid");
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) files.add(path.relative(downloadDir, fullPath));
    }
  };
  await walk(invalidDir);
  return files;
}

async function cleanupNewInvalidArtifacts(downloadDir: string, baseline: Set<string>) {
  const current = await listInvalidArtifacts(downloadDir);
  let removed = 0;
  for (const relativePath of current) {
    if (baseline.has(relativePath)) continue;
    try {
      await fs.promises.unlink(path.join(downloadDir, relativePath));
      removed += 1;
    } catch {
      // A concurrent cleanup or download may already have moved the file.
    }
  }
  return removed;
}

const activeDownloadChildren = new Set<ReturnType<typeof spawn>>();
let shutdownRequested = false;

export async function shutdownActiveDownloads(timeoutMs = 20_000) {
  shutdownRequested = true;
  const children = [...activeDownloadChildren];
  await Promise.all(children.map((child) => terminateDownloadProcessTree(child, false)));
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeDownloadChildren.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await Promise.all(children.map((child) => terminateDownloadProcessTree(child, true)));
}

async function terminateDownloadProcessTree(child: ReturnType<typeof spawn>, force: boolean) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
      return;
    }
  }
  await new Promise<void>((resolve) => {
    const args = ["/PID", String(child.pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill", args, { windowsHide: true });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

export async function downloadWithBBDown(
  bvid: string,
  cookie: BiliCookie,
  config: AppConfig,
  options: {
    downloadDir?: string;
    kind?: DownloadSessionKind;
    onPrepared?: (downloadDir: string, manifest: DownloadSessionManifest) => void;
    pageSnapshot?: VideoPageSnapshotResult;
    command?: string;
    commandArgsPrefix?: string[];
    qualityUpgrade?: DownloadSessionManifest["qualityUpgrade"];
    apiModeOverride?: BBDownApiMode;
    onApiReady?: (mode: BBDownApiMode) => void;
    accessRecheck?: (cookie: BiliCookie, bvid: string) => Promise<VideoPageSnapshotResult>;
  } = {}
): Promise<DownloadResult> {
  if (shutdownRequested) throw new Error("Application is shutting down");
  const downloadDir = options.downloadDir || path.join(tempDir, bvid);
  const snapshot = options.pageSnapshot || await getVideoPageSnapshot(cookie, bvid);
  if (snapshot.access?.classification === "charging_restricted") {
    throw new ChargingRestrictedError(bvid, Number(cookie.DedeUserID || 0), snapshot.access);
  }
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const previousSession = readDownloadSession(downloadDir);
  const effectivePages = snapshot.pages.length > 0 ? snapshot.pages : previousSession?.pages || [];
  if (effectivePages.length === 0 && snapshot.available) {
    const metadataError: any = new Error("Unable to resolve the current video page list; retrying later");
    metadataError.deferToNextCycle = true;
    throw metadataError;
  }
  const effectiveApiMode: BBDownApiMode = options.apiModeOverride || config.bbdownApiMode || "web";
  const sessionConfig: AppConfig = { ...config, bbdownApiMode: effectiveApiMode };
  const prepared = await prepareDownloadSession({
    downloadDir,
    bvid,
    accountUid: Number(cookie.DedeUserID || 0),
    config: sessionConfig,
    kind: options.kind || "backup",
    pages: effectivePages,
    unavailable: !snapshot.available,
    qualityUpgrade: options.qualityUpgrade,
  });
  options.onPrepared?.(downloadDir, prepared.manifest);
  const legacyCover = findLegacyCover(downloadDir);
  if (legacyCover) {
    void cacheLocalCover(bvid, legacyCover).catch((error) => {
      console.warn(`[CoverCache] Failed to import legacy cover ${bvid}:`, error?.message || error);
    });
  }

  if (prepared.missingPages.length === 0 && prepared.manifest.outputs.length > 0) {
    return {
      downloadDir,
      files: currentSessionFiles(downloadDir),
      recoveredPages: prepared.recoveredPages,
      totalPages: prepared.manifest.pages.length,
      partial: prepared.manifest.status === "partial",
    };
  }
  if (!snapshot.available) {
    if (prepared.manifest.outputs.length > 0) {
      markDownloadSessionStatus(downloadDir, "partial", "Video is unavailable; preserving verified local pages.");
      return {
        downloadDir,
        files: currentSessionFiles(downloadDir),
        recoveredPages: prepared.recoveredPages,
        totalPages: prepared.manifest.pages.length,
        partial: true,
      };
    }
    const unavailableError: any = new Error("Video is unavailable and no verified local pages can be recovered");
    unavailableError.permanent = true;
    throw unavailableError;
  }

  const url = `https://www.bilibili.com/video/${bvid}`;
  const cookieString = buildCookieString(cookie);
  const filePattern = config.filenameTemplate || "<videoTitle>-<bvid>";
  const needsAppToken = effectiveApiMode === "app";
  const appAccessToken = needsAppToken ? String(cookie.accessToken || "") : "";
  if (needsAppToken && !appAccessToken) {
    const error: any = new Error("APP 接口需要 access token。请重新扫码登录后再启用该模式。");
    error.permanent = true;
    throw error;
  }

  const credentialConfig = await createBBDownCredentialConfig(cookieString, appAccessToken);
  try {
    const args = [
      url,
      "--config-file",
      credentialConfig.configPath,
      "--work-dir",
      downloadDir,
      "-F",
      filePattern,
      "-M",
      `${filePattern}_P<pageNumberWithZero>`,
      "--use-aria2c",
      "--aria2c-args",
      "--continue=true --always-resume=true --max-resume-failure-tries=0 --auto-save-interval=5 --auto-file-renaming=false --allow-overwrite=true --file-allocation=none --connect-timeout=10 --timeout=30 --max-tries=5 --retry-wait=3",
    ];

    const selectedPages = buildSelectPageArgument(prepared.missingPages);
    if (selectedPages) args.push("--select-page", selectedPages);

    const encodingPriority = buildEncodingPriority(config);
    if (encodingPriority) {
      args.push("--encoding-priority", encodingPriority);
    }
    const dfnPriority = buildDfnPriority(config);
    if (dfnPriority) {
      args.push("--dfn-priority", dfnPriority);
    }
    if (config.perVideoDelaySeconds > 0) {
      args.push("--delay-per-page", String(config.perVideoDelaySeconds));
    }
    if (needsAppToken) {
      args.push("-app");
    }

    const command = options.command || process.env.BBDOWN_PATH || "BBDown";
    const commandArgsPrefix = options.commandArgsPrefix || [];
    let appFallbackActive = false;
    const runBBDown = async (commandArgs: string[]) => {
      const runMode: BBDownApiMode = appFallbackActive ? "web" : effectiveApiMode;
      const runArgs = runMode === "web" && effectiveApiMode === "app"
        ? commandArgs.filter((arg) => arg !== "-app")
        : commandArgs;
      try {
        await runCommand(
          command,
          [...commandArgsPrefix, ...runArgs],
          downloadDir,
          bvid,
          credentialConfig.sensitiveValues,
          { effectiveApiMode: runMode, onApiReady: options.onApiReady }
        );
      } catch (error: any) {
        if (runMode !== "app" || !error?.appNoVideoInfo) throw error;
        appFallbackActive = true;
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "download",
          level: "warn",
          summary: `APP 接口未返回播放信息，当前视频改用网页接口 ${bvid}`,
          raw: `APP play response had no video info; retrying ${bvid} once with Web API`,
          bvid,
          simpleVisible: true,
          debugVisible: true,
        });
        await runCommand(
          command,
          [...commandArgsPrefix, ...commandArgs.filter((arg) => arg !== "-app")],
          downloadDir,
          bvid,
          credentialConfig.sensitiveValues,
          { effectiveApiMode: "web", onApiReady: options.onApiReady }
        );
      }
    };

    let retriedWithTruncate = false;
    const invalidArtifactsBeforeRun = await listInvalidArtifacts(downloadDir);
    markDownloadSessionStatus(downloadDir, "downloading");
    try {
      await runBBDown(args);
    } catch (error: any) {
      if (!Boolean(error?.filenameTooLong)) {
        await preserveInterruptedDownload(downloadDir, error);
        throw error;
      }

      retriedWithTruncate = true;
      const safeTitle = await fetchSafeVideoTitle(bvid, cookieString);
      const fallbackBase = buildFallbackFilePattern(safeTitle, bvid);
      const retryArgs = replaceFilePatternArgs(args, fallbackBase);
      const afterFailure = await refreshDownloadSessionOutputs(downloadDir);
      const retryPages = buildSelectPageArgument(afterFailure.missingPages);
      replaceOptionValue(retryArgs, "--select-page", retryPages);

      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `文件名过长，自动截断后重试 ${bvid}`,
        raw: `File name too long; retry with truncated title: ${fallbackBase}`,
        bvid,
        simpleVisible: true,
        debugVisible: true,
      });

      try {
        await runBBDown(retryArgs);
      } catch (retryError: any) {
        await preserveInterruptedDownload(downloadDir, retryError);
        throw retryError;
      }
    }

    const refreshed = await refreshDownloadSessionOutputs(downloadDir);
    if (refreshed.missingPages.length > 0) {
      const latestSnapshot = snapshot.access?.classification === "unknown"
        ? await (options.accessRecheck || getVideoPageSnapshot)(cookie, bvid).catch(() => undefined)
        : undefined;
      if (latestSnapshot?.access?.classification === "charging_restricted") {
        await cleanupNewInvalidArtifacts(downloadDir, invalidArtifactsBeforeRun);
        throw new ChargingRestrictedError(bvid, Number(cookie.DedeUserID || 0), latestSnapshot.access);
      }
      const err = new Error(`BBDown did not complete all pages; remaining ${refreshed.missingPages.length}`);
      (err as any).deferToNextCycle = true;
      markDownloadSessionStatus(downloadDir, "failed", err.message);
      throw err;
    }
    const mediaFiles = refreshed.manifest.outputs;
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "download",
      level: "info",
      summary: `下载完成 ${bvid}${retriedWithTruncate ? "（已自动截断标题）" : ""}`,
      raw: `BBDown produced and verified ${mediaFiles.length} media file(s)`,
      bvid,
      simpleVisible: true,
    });

    markDownloadSessionStatus(downloadDir, "complete");
    return {
      downloadDir,
      files: mediaFiles.map((file) => file.relativePath),
      recoveredPages: prepared.recoveredPages,
      totalPages: refreshed.manifest.pages.length,
      partial: false,
    };
  } finally {
    await credentialConfig.cleanup();
  }
}

async function preserveInterruptedDownload(downloadDir: string, error: any) {
  const refreshed = await refreshDownloadSessionOutputs(downloadDir).catch(() => undefined);
  const issue = error?.aria2RecoveryIssue as Aria2TrackRecoveryIssue | undefined;
  if (issue && refreshed?.missingPages.some((page) => page.index === issue.pageIndex)) {
    const moved = await quarantineBrokenAria2Track(downloadDir, issue).catch(() => 0);
    if (moved > 0) {
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `续传数据不兼容，已重置 P${issue.pageIndex}${issue.track === "video" ? "视频" : "音频"}轨道`,
        raw: `Quarantined ${moved} incompatible aria2 artifact(s); reason=${issue.reason}`,
        simpleVisible: true,
        debugVisible: true,
      });
    }
  }
  markDownloadSessionStatus(downloadDir, "failed", sanitizeDownloadDiagnosticText(error?.message || String(error)).slice(0, 1000));
}

export function normalizeEncodingPriority(value: string) {
  const map: Record<string, string> = {
    HEVC: "hevc",
    AVC: "avc",
    AV1: "av1",
  };
  return map[value] || value.toLowerCase();
}

export function normalizeQualityPriority(value: string) {
  const map: Record<string, string> = {
    "8K": "8K \u8d85\u9ad8\u6e05",
    "4K": "4K \u8d85\u6e05",
    "1080P60": "1080P \u9ad8\u5e27\u7387",
    "1080P": "1080P \u9ad8\u6e05",
    "720P": "720P \u9ad8\u6e05",
  };
  return map[value] || value;
}

export function buildEncodingPriority(config: AppConfig) {
  const priorities: string[] = [];
  if (config.bbdownDolby) {
    priorities.push("eac3");
  }
  if (config.bbdownHiRes) {
    priorities.push("flac");
  }
  if (config.bbdownEncoding) {
    priorities.push(normalizeEncodingPriority(config.bbdownEncoding));
  }
  return [...new Set(priorities)].join(",");
}

export function buildDfnPriority(config: AppConfig) {
  const priorities: string[] = [];
  if (config.bbdownQuality) {
    priorities.push(normalizeQualityPriority(config.bbdownQuality));
  }
  if (priorities.length === 0) {
    return "";
  }
  const deduped = [...new Set(priorities)];
  return deduped.join(",");
}

function replaceOptionValue(args: string[], option: string, value: string) {
  const index = args.findIndex((item) => item === option);
  if (!value) {
    if (index >= 0) args.splice(index, 2);
    return;
  }
  if (index >= 0 && index + 1 < args.length) {
    args[index + 1] = value;
  } else {
    args.push(option, value);
  }
}

async function createBBDownCredentialConfig(cookieString: string, appAccessToken: string) {
  await fs.promises.mkdir(tempDir, { recursive: true });
  const configDir = await fs.promises.mkdtemp(path.join(tempDir, "bbdown-credentials-"));
  const configPath = path.join(configDir, "BBDown.config");
  const lines: string[] = [];
  if (cookieString) {
    lines.push(`--cookie ${sanitizeCredentialLine(cookieString)}`);
  }
  if (appAccessToken) {
    lines.push(`--access-token ${sanitizeCredentialLine(appAccessToken)}`);
  }
  await fs.promises.writeFile(configPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    configPath,
    sensitiveValues: [cookieString, appAccessToken].filter((value) => value.length > 0),
    cleanup: () => fs.promises.rm(configDir, { recursive: true, force: true }),
  };
}

function sanitizeCredentialLine(value: string) {
  return value.replace(/[\r\n\0]/g, " ");
}

export function sanitizeDownloadDiagnosticText(value: string, sensitiveValues: string[] = []) {
  let output = value;
  for (const sensitiveValue of sensitiveValues) {
    output = output.split(sensitiveValue).join("[REDACTED]");
    const sanitized = sanitizeCredentialLine(sensitiveValue);
    if (sanitized !== sensitiveValue) {
      output = output.split(sanitized).join("[REDACTED]");
    }
  }
  output = output.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.username = "";
      parsed.password = "";
      if (parsed.search) parsed.search = "?REDACTED";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return output
    .replace(/((?:authorization|cookie|token|sessionkey|sessdata|password|secret|sign|access_key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/[\0]/g, "");
}

function redactSensitiveOutput(value: string, sensitiveValues: string[]) {
  return sanitizeDownloadDiagnosticText(value, sensitiveValues);
}

export function detectAria2TrackRecoveryIssue(output: string): Aria2TrackRecoveryIssue | null {
  const text = String(output || "");
  let reason: Aria2TrackRecoveryIssue["reason"] | null = null;
  if (/\b416\b|range\s+not\s+satisfiable|cannot\s+resume|resume\s+(?:is\s+)?not\s+supported/i.test(text)) {
    reason = "range";
  } else if (/length\s+(?:changed|mismatch|different)|size\s+mismatch|remote\s+file\s+size\s+changed/i.test(text)) {
    reason = "length";
  } else if (/(?:control|\.aria2)\s+file.*(?:corrupt|invalid|damaged)|(?:corrupt|invalid|damaged).*(?:control|\.aria2)\s+file/i.test(text)) {
    reason = "control";
  }
  if (!reason) return null;
  let pageIndex = 0;
  let track: Aria2TrackRecoveryIssue["track"] | undefined;
  for (const match of text.matchAll(/(?:开始下载|download(?:ing)?)\s*P(\d+)\s*(视频|音频|video|audio)/gi)) {
    pageIndex = Number(match[1]);
    track = /音频|audio/i.test(match[2]) ? "audio" : "video";
  }
  return pageIndex > 0 && track ? { pageIndex, track, reason } : null;
}

function attachAria2RecoveryIssue(error: Error, output: string) {
  const issue = detectAria2TrackRecoveryIssue(output);
  if (issue) (error as any).aria2RecoveryIssue = issue;
  return error;
}

function isFilenameTooLongError(message: string) {
  const text = String(message || "");
  return /File name too long|filename too long|ENAMETOOLONG/i.test(text);
}

function sanitizeTitleForPattern(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "");
}

function truncateUtf8ByBytes(value: string, maxBytes: number) {
  if (!value) return "";
  const normalized = value.normalize("NFC");
  let bytes = 0;
  let out = "";
  for (const ch of normalized) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

function buildFallbackFilePattern(safeTitle: string, bvid: string) {
  const title = safeTitle || bvid;
  const truncated = truncateUtf8ByBytes(title, 72) || bvid;
  return sanitizeTitleForPattern(`${truncated}-${bvid}`);
}

function replaceFilePatternArgs(args: string[], fallbackBase: string) {
  const next = [...args];
  const fIndex = next.findIndex((item) => item === "-F");
  if (fIndex >= 0 && fIndex + 1 < next.length) {
    next[fIndex + 1] = fallbackBase;
  } else {
    next.push("-F", fallbackBase);
  }
  const mIndex = next.findIndex((item) => item === "-M");
  if (mIndex >= 0 && mIndex + 1 < next.length) {
    next[mIndex + 1] = `${fallbackBase}_P<pageNumberWithZero>`;
  } else {
    next.push("-M", `${fallbackBase}_P<pageNumberWithZero>`);
  }
  return next;
}

async function fetchSafeVideoTitle(bvid: string, cookieString: string) {
  try {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: {
        Cookie: cookieString,
        Referer: "https://www.bilibili.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!response.ok) return bvid;
    const data: any = await response.json();
    const title = data?.data?.title;
    return sanitizeTitleForPattern(typeof title === "string" ? title : bvid);
  } catch {
    return bvid;
  }
}

function classifyBBDownFailure(output: string) {
  for (const line of output.split(/\r?\n/).map((item) => item.trim())) {
    if (!line) continue;
    if (line.includes("解析此分P失败")) {
      return { line, permanent: false, deferToNextCycle: true };
    }
    if (
      line.includes("Arg_KeyNotFound") ||
      line.includes("未找到此 EP/SS") ||
      line.includes("视频不存在") ||
      line.includes("稿件不可见") ||
      line.includes("已失效") ||
      line.includes("资源不可用")
    ) {
      return { line, permanent: true, deferToNextCycle: false };
    }
  }
  return null;
}

const lowSpeedWatchdog = {
  sampleIntervalMs: 60_000,
  minRuntimeMs: 30 * 60_000,
  windowMs: 10 * 60_000,
  minBytesPerSecond: 10 * 1024,
};

async function getDirectoryTotalSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectoryTotalSize(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.promises.stat(fullPath);
      total += stat.size;
    } catch {
      // file may be renamed by BBDown while sampling
    }
  }
  return total;
}

function createDebugLogPath(bvid: string) {
  const debugDir = path.join(process.cwd(), "data", "debug");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(debugDir, `${stamp}_${bvid}.log`);
}

async function runDebugProbe(
  bvid: string,
  baseArgs: string[],
  cwd: string,
  sensitiveValues: string[]
) {
  const debugLogPath = createDebugLogPath(bvid);
  await fs.promises.mkdir(path.dirname(debugLogPath), { recursive: true });
  const args = [...baseArgs, "--debug", "--only-show-info"];
  return new Promise<string>((resolve) => {
    const child = spawn("BBDown", args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    activeDownloadChildren.add(child);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", async () => {
      activeDownloadChildren.delete(child);
      try {
        await fs.promises.writeFile(debugLogPath, redactSensitiveOutput(out, sensitiveValues), "utf8");
      } catch {
        // ignore write failure
      }
      resolve(debugLogPath);
    });
    child.on("error", async (error) => {
      activeDownloadChildren.delete(child);
      try {
        await fs.promises.writeFile(
          debugLogPath,
          redactSensitiveOutput(`${out}\n[debug probe error] ${error?.message || error}`, sensitiveValues),
          "utf8"
        );
      } catch {
        // ignore write failure
      }
      resolve(debugLogPath);
    });
  });
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  bvid: string,
  sensitiveValues: string[],
  options: { effectiveApiMode: BBDownApiMode; onApiReady?: (mode: BBDownApiMode) => void }
) {
  return new Promise<void>((resolve, reject) => {
    if (shutdownRequested) {
      reject(new Error("Application is shutting down"));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    activeDownloadChildren.add(child);
    const commandStartedAt = Date.now();
    const sizeSamples: Array<{ at: number; size: number }> = [];
    let watchdogTimer: NodeJS.Timeout | null = null;
    let killedByWatchdog = false;
    let settled = false;
    let stderr = "";
    let stdoutAll = "";
    let stdoutPending = "";
    let stderrPending = "";
    let riskSignalSeen = false;
    let appNoVideoInfoSeen = false;
    let readySignalSeen = false;

    const rawSimpleHiddenPatterns = [
      /^BBDown version/i,
      /^遇到问题请首先到以下地址查阅有无相关信息[:：]?$/i,
      /^https:\/\/github\.com\/nilaoda\/BBDown\/issues$/i,
      /检测账号登录/,
      /获取aid/,
      /获取视频信息/,
      /发布时间/,
      /UP主页/,
      /^P\d+:/,
      /共计\s*\d+\s*个分P/,
      /开始解析P\d+/,
      /共计\d+条视频流/,
      /共计\d+条音频流/,
      /^\d+\.\s*\[/,
      /已选择的流/,
      /尝试将视频流强制替换/,
      /尝试将音频流强制替换/,
      /合并视频分片/,
      /合并音频分片/,
      /开始下载P\d+音频/,
      /开始合并音视频/,
      /清理分片/,
      /下载P\d+完毕/,
      /清理临时文件/,
      /跳过下载AI字幕/,
    ];

    const shouldHideInSimple = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return rawSimpleHiddenPatterns.some((pattern) => pattern.test(trimmed));
    };

    const cleanupWatchdog = () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupWatchdog();
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanupWatchdog();
      resolve();
    };

    const sampleDownloadSize = async () => {
      const now = Date.now();
      const size = await getDirectoryTotalSize(cwd);
      sizeSamples.push({ at: now, size });
      while (sizeSamples.length > 0 && now - sizeSamples[0].at > lowSpeedWatchdog.windowMs) {
        sizeSamples.shift();
      }
      if (now - commandStartedAt < lowSpeedWatchdog.minRuntimeMs || sizeSamples.length < 2) {
        return;
      }
      const first = sizeSamples[0];
      const last = sizeSamples[sizeSamples.length - 1];
      const seconds = Math.max(1, (last.at - first.at) / 1000);
      const bytesPerSecond = Math.max(0, (last.size - first.size) / seconds);
      if (bytesPerSecond >= lowSpeedWatchdog.minBytesPerSecond) {
        return;
      }
      killedByWatchdog = true;
      cleanupWatchdog();
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "warn",
        summary: `下载低速卡住，已自动重试 ${bvid}`,
        raw: `Low speed watchdog: ${(bytesPerSecond / 1024).toFixed(2)}KB/s for ${Math.round(seconds)}s after ${Math.round((now - commandStartedAt) / 1000)}s`,
        bvid,
        simpleVisible: true,
        debugVisible: true,
      });
      void terminateDownloadProcessTree(child, false);
    };

    const startWatchdog = () => {
      void sampleDownloadSize();
      watchdogTimer = setInterval(() => {
        void sampleDownloadSize().catch(() => undefined);
      }, lowSpeedWatchdog.sampleIntervalMs);
    };

    const consumeSignal = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.includes("BFB_SIGNAL:RISK_V_VOUCHER")) {
        riskSignalSeen = true;
        return true;
      }
      if (trimmed.includes("BFB_SIGNAL:APP_NO_VIDEO_INFO")) {
        appNoVideoInfoSeen = true;
        return true;
      }
      const ready = /BFB_SIGNAL:PLAYURL_READY:(WEB|APP)/.exec(trimmed);
      if (ready) {
        if (!readySignalSeen) {
          readySignalSeen = true;
          options.onApiReady?.(ready[1].toLowerCase() as BBDownApiMode);
        }
        return true;
      }
      return false;
    };

    const flushStdoutBuffer = (force = false) => {
      const combined = stdoutPending;
      const normalized = combined.replace(/\r/g, "\n");
      const lines = normalized.split("\n");
      if (!force) {
        stdoutPending = lines.pop() || "";
      } else {
        stdoutPending = "";
      }

      if (lines.length === 0) {
        return;
      }

      const visibleLines = lines.filter((line) => !consumeSignal(line));
      if (visibleLines.length === 0) return;
      const visibleText = visibleLines.join("\n");
      stdoutAll += `${visibleText}\n`;
      process.stdout.write(`${visibleText}\n`);
      const parsed = parseBBDownOutput(visibleText, bvid);
      for (const entry of parsed.entries) {
        logManager.push(entry);
      }

      for (const rawLine of parsed.unmatched) {
        const line = rawLine.trim();
        if (!line) continue;
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "download",
          level: "info",
          summary: line,
          raw: line,
          bvid,
          simpleVisible: !shouldHideInSimple(line),
        });
      }
    };

    const flushStderrBuffer = (force = false) => {
      const normalized = stderrPending.replace(/\r/g, "\n");
      const lines = normalized.split("\n");
      if (!force) {
        stderrPending = lines.pop() || "";
      } else {
        stderrPending = "";
      }
      for (const rawLine of lines) {
        if (consumeSignal(rawLine)) continue;
        const line = rawLine.trim();
        if (!line) continue;
        stderr += `${line}\n`;
        process.stderr.write(`${line}\n`);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "download",
          level: "error",
          summary: `[错误] ${line}`,
          raw: line,
          bvid,
        });
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = redactSensitiveOutput(chunk.toString(), sensitiveValues);
      stdoutPending += text;
      flushStdoutBuffer(false);
    });

    child.stderr.on("data", (chunk) => {
      const text = redactSensitiveOutput(chunk.toString(), sensitiveValues);
      stderrPending += text;
      flushStderrBuffer(false);
    });

    startWatchdog();

    child.on("error", (error) => {
      activeDownloadChildren.delete(child);
      rejectOnce(error);
    });

    child.on("close", (code) => {
      activeDownloadChildren.delete(child);
      flushStdoutBuffer(true);
      flushStderrBuffer(true);
      cleanupWatchdog();
      if (killedByWatchdog) {
        rejectOnce(new Error("下载运行超过30分钟且最近10分钟平均速度低于10KB/s，自动重试"));
        return;
      }
      const combinedOutput = `${stdoutAll}\n${stderr}`;
      if (riskSignalSeen) {
        const err: any = new Error("B站播放接口触发风控，下载将在冷却后自动恢复");
        err.biliRiskControl = true;
        err.deferToNextCycle = true;
        err.apiMode = options.effectiveApiMode;
        rejectOnce(err);
        return;
      }
      if (appNoVideoInfoSeen) {
        const err: any = new Error("APP 播放接口未返回视频信息");
        err.appNoVideoInfo = true;
        err.apiMode = options.effectiveApiMode;
        rejectOnce(err);
        return;
      }
      if (isFilenameTooLongError(combinedOutput) || isFilenameTooLongError(stderr)) {
        const err = new Error(`BBDown output filename too long: ${sanitizeDownloadDiagnosticText(combinedOutput || stderr || "unknown error").slice(0, 1000)}`);
        (err as any).filenameTooLong = true;
        rejectOnce(err);
        return;
      }

      const failure = classifyBBDownFailure(combinedOutput);
      if (failure) {
        const finalizeFailure = (finalLine: string) => {
          const err = attachAria2RecoveryIssue(new Error(`BBDown reported failure: ${finalLine}`), combinedOutput);
          (err as any).permanent = failure.permanent;
          (err as any).deferToNextCycle = failure.deferToNextCycle;
          logManager.push({
            timestamp: new Date().toISOString(),
            type: "download",
            level: "error",
            summary: `下载失败 ${bvid}: ${finalLine}`,
            raw: finalLine,
            bvid,
            simpleVisible: true,
            debugVisible: true,
          });
          rejectOnce(err);
        };

        if (!failure.deferToNextCycle) {
          finalizeFailure(failure.line);
          return;
        }

        runDebugProbe(bvid, args, cwd, sensitiveValues)
          .then((debugLogPath) => {
            const finalLine = `${failure.line} (debug: ${debugLogPath})`;
            logManager.push({
              timestamp: new Date().toISOString(),
              type: "download",
              level: "warn",
              summary: `Debug 日志已保存: ${path.basename(debugLogPath)}`,
              raw: `Debug log saved: ${debugLogPath}`,
              bvid,
              simpleVisible: false,
              debugVisible: true,
            });
            finalizeFailure(finalLine);
          })
          .catch((probeError) => {
            const finalLine = `${failure.line} [debug probe failed: ${probeError?.message || probeError}]`;
            finalizeFailure(finalLine);
          });
        return;
      }

      if (code === 0) {
        resolveOnce();
        return;
      }

      const errMsg = sanitizeDownloadDiagnosticText(stderr || combinedOutput || `Command failed with code ${code}`).slice(0, 4000);
      const nonZeroFailure = classifyBBDownFailure(combinedOutput);
      if (nonZeroFailure?.permanent) {
        const err = attachAria2RecoveryIssue(new Error(`视频不可用（已删除、下架或不可见）: ${errMsg}`), combinedOutput);
        (err as any).permanent = true;
        rejectOnce(err);
        return;
      }
      if (nonZeroFailure?.deferToNextCycle) {
        const err = attachAria2RecoveryIssue(new Error(`BBDown reported failure: ${nonZeroFailure.line}`), combinedOutput);
        (err as any).deferToNextCycle = true;
        rejectOnce(err);
        return;
      }
      rejectOnce(attachAria2RecoveryIssue(new Error(errMsg), combinedOutput));
    });
  });
}
