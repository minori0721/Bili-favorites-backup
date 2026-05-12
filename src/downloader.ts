import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tempDir } from "./paths.js";
import { buildCookieString, BiliCookie } from "./users.js";
import { AppConfig } from "./config.js";
import { logManager, parseBBDownOutput } from "./logger.js";

export interface DownloadResult {
  downloadDir: string;
}

export async function downloadWithBBDown(bvid: string, cookie: BiliCookie, config: AppConfig): Promise<DownloadResult> {
  const downloadDir = path.join(tempDir, bvid);
  await fs.promises.rm(downloadDir, { recursive: true, force: true });
  await fs.promises.mkdir(downloadDir, { recursive: true });

  const url = `https://www.bilibili.com/video/${bvid}`;
  const cookieString = buildCookieString(cookie);
  const filePattern = config.filenameTemplate || "<videoTitle>-<bvid>";
  const needsAppToken = config.bbdownHiRes || config.bbdownDolby;
  const appAccessToken = needsAppToken ? String(cookie.accessToken || "") : "";
  if (needsAppToken && !appAccessToken) {
    throw new Error("下载 Hi-Res/杜比音效需要 APP access token。请重新扫码登录后再启用该选项。");
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
    ];

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

    let retriedWithTruncate = false;
    try {
      await runCommand("BBDown", args, downloadDir, bvid, credentialConfig.sensitiveValues);
    } catch (error: any) {
      if (!Boolean(error?.filenameTooLong)) {
        throw error;
      }

      retriedWithTruncate = true;
      const safeTitle = await fetchSafeVideoTitle(bvid, cookieString);
      const fallbackBase = buildFallbackFilePattern(safeTitle, bvid);
      const retryArgs = replaceFilePatternArgs(args, fallbackBase);

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

      await fs.promises.rm(downloadDir, { recursive: true, force: true });
      await fs.promises.mkdir(downloadDir, { recursive: true });
      await runCommand("BBDown", retryArgs, downloadDir, bvid, credentialConfig.sensitiveValues);
    }

    const entries = await fs.promises.readdir(downloadDir, { withFileTypes: true });
    const mediaFiles = entries.filter((entry) => entry.isFile() && isMediaOutputFile(entry.name));
    if (mediaFiles.length === 0) {
      const err = new Error("BBDown did not produce any media files");
      (err as any).deferToNextCycle = true;
      throw err;
    }
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "download",
      level: "info",
      summary: `下载完成 ${bvid}${retriedWithTruncate ? "（已自动截断标题）" : ""}`,
      raw: `BBDown produced ${mediaFiles.length} media file(s)`,
      bvid,
      simpleVisible: true,
    });

    return { downloadDir };
  } finally {
    await credentialConfig.cleanup();
  }
}

function normalizeEncodingPriority(value: string) {
  const map: Record<string, string> = {
    HEVC: "hevc",
    AVC: "avc",
    AV1: "av1",
  };
  return map[value] || value.toLowerCase();
}

function normalizeQualityPriority(value: string) {
  const map: Record<string, string> = {
    "8K": "8K \u8d85\u9ad8\u6e05",
    "4K": "4K \u8d85\u6e05",
    "1080P60": "1080P \u9ad8\u5e27\u7387",
    "1080P": "1080P \u9ad8\u6e05",
    "720P": "720P \u9ad8\u6e05",
  };
  return map[value] || value;
}

function buildEncodingPriority(config: AppConfig) {
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

function buildDfnPriority(config: AppConfig) {
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

function isMediaOutputFile(name: string) {
  return /\.(mp4|mkv|flv|mov|m4v)$/i.test(name) && !/\.(part|tmp|download)$/i.test(name);
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

function redactSensitiveOutput(value: string, sensitiveValues: string[]) {
  let output = value;
  for (const sensitiveValue of sensitiveValues) {
    output = output.split(sensitiveValue).join("[REDACTED]");
    const sanitized = sanitizeCredentialLine(sensitiveValue);
    if (sanitized !== sensitiveValue) {
      output = output.split(sanitized).join("[REDACTED]");
    }
  }
  return output;
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
    const child = spawn("BBDown", args, { cwd });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", async () => {
      try {
        await fs.promises.writeFile(debugLogPath, redactSensitiveOutput(out, sensitiveValues), "utf8");
      } catch {
        // ignore write failure
      }
      resolve(debugLogPath);
    });
    child.on("error", async (error) => {
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

function runCommand(command: string, args: string[], cwd: string, bvid: string, sensitiveValues: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stderr = "";
    let stdoutAll = "";
    let stdoutPending = "";

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

      const parsed = parseBBDownOutput(lines.join("\n"), bvid);
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

    child.stdout.on("data", (chunk) => {
      const text = redactSensitiveOutput(chunk.toString(), sensitiveValues);
      process.stdout.write(text);
      stdoutAll += text;
      stdoutPending += text;
      flushStdoutBuffer(false);
    });

    child.stderr.on("data", (chunk) => {
      const text = redactSensitiveOutput(chunk.toString(), sensitiveValues);
      stderr += text;
      process.stderr.write(text);
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "download",
        level: "error",
        summary: `[错误] ${text.trim()}`,
        raw: text,
        bvid,
      });
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      flushStdoutBuffer(true);
      const combinedOutput = `${stdoutAll}\n${stderr}`;
      if (isFilenameTooLongError(combinedOutput) || isFilenameTooLongError(stderr)) {
        const err = new Error(`BBDown output filename too long: ${combinedOutput || stderr || "unknown error"}`);
        (err as any).filenameTooLong = true;
        reject(err);
        return;
      }

      const failure = classifyBBDownFailure(combinedOutput);
      if (failure) {
        const finalizeFailure = (finalLine: string) => {
          const err = new Error(`BBDown reported failure: ${finalLine}`);
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
          reject(err);
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
        resolve();
        return;
      }

      const errMsg = stderr || combinedOutput || `Command failed with code ${code}`;
      const nonZeroFailure = classifyBBDownFailure(combinedOutput);
      if (nonZeroFailure?.permanent) {
        const err = new Error(`视频不可用（已删除、下架或不可见）: ${errMsg}`);
        (err as any).permanent = true;
        reject(err);
        return;
      }
      if (nonZeroFailure?.deferToNextCycle) {
        const err = new Error(`BBDown reported failure: ${nonZeroFailure.line}`);
        (err as any).deferToNextCycle = true;
        reject(err);
        return;
      }
      reject(new Error(errMsg));
    });
  });
}
