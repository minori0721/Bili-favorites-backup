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
  const filePattern = config.filenameTemplate || "<videoTitle>";

  const args = [
    url,
    "-c",
    cookieString,
    "--work-dir",
    downloadDir,
    "-F",
    filePattern,
    "-M",
    `${filePattern}_P<pageNumberWithZero>`,
  ];

  if (config.bbdownEncoding) {
    args.push("--encoding-priority", normalizeEncodingPriority(config.bbdownEncoding));
  }
  const dfnPriority = buildDfnPriority(config);
  if (dfnPriority) {
    args.push("--dfn-priority", dfnPriority);
  }
  if (config.perVideoDelaySeconds > 0) {
    args.push("--delay-per-page", String(config.perVideoDelaySeconds));
  }
  if (config.bbdownHiRes || config.bbdownDolby) {
    if (!cookie.accessToken) {
      throw new Error("下载 Hi-Res/杜比音效需要 APP access token。请重新扫码登录后再启用该选项。");
    }
    args.push("-app", "--access-token", cookie.accessToken);
  }

  await runCommand("BBDown", args, downloadDir, bvid);

  const entries = await fs.promises.readdir(downloadDir, { withFileTypes: true });
  const mediaFiles = entries.filter((entry) => entry.isFile() && isMediaOutputFile(entry.name));
  if (mediaFiles.length === 0) {
    const err = new Error("BBDown did not produce any media files");
    (err as any).permanent = true;
    throw err;
  }
  logManager.push({
    timestamp: new Date().toISOString(),
    type: "download",
    level: "info",
    summary: `下载完成 ${bvid}`,
    raw: `BBDown produced ${mediaFiles.length} media file(s)`,
    bvid,
    simpleVisible: true,
  });

  return { downloadDir };
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
    "1080P60": "1080P 60\u5e27",
    "1080P": "1080P \u9ad8\u6e05",
    "720P": "720P \u9ad8\u6e05",
  };
  return map[value] || value;
}

function buildDfnPriority(config: AppConfig) {
  const priorities: string[] = [];
  if (config.bbdownDolby) {
    priorities.push("\u675c\u6bd4\u5168\u666f\u58f0");
  }
  if (config.bbdownHiRes) {
    priorities.push("Hi-Res\u65e0\u635f");
  }
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

function findBBDownFailure(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) =>
      line.includes("解析此分P失败") ||
      line.includes("Arg_KeyNotFound") ||
      line.includes("未找到此 EP/SS") ||
      line.includes("视频不存在") ||
      line.includes("稿件不可见") ||
      line.includes("已失效") ||
      line.includes("资源不可用") ||
      line.includes("请尝试升级到最新版本后重试")
    );
}

function isPermanentBBDownError(output: string) {
  return (
    output.includes("解析此分P失败") ||
    output.includes("Arg_KeyNotFound") ||
    output.includes("未找到此 EP/SS") ||
    output.includes("视频不存在") ||
    output.includes("稿件不可见") ||
    output.includes("已失效") ||
    output.includes("资源不可用") ||
    output.includes("请尝试升级到最新版本后重试")
  );
}

function runCommand(command: string, args: string[], cwd: string, bvid: string) {
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
      const text = chunk.toString();
      process.stdout.write(chunk);
      stdoutAll += text;
      stdoutPending += text;
      flushStdoutBuffer(false);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
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
      const failureLine = findBBDownFailure(combinedOutput);
      if (failureLine) {
        const err = new Error(`BBDown reported failure: ${failureLine}`);
        (err as any).permanent = isPermanentBBDownError(combinedOutput);
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "download",
          level: "error",
          summary: `下载失败 ${bvid}: ${failureLine}`,
          raw: failureLine,
          bvid,
          simpleVisible: true,
        });
        reject(err);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }

      const errMsg = stderr || combinedOutput || `Command failed with code ${code}`;
      if (isPermanentBBDownError(combinedOutput)) {
        const err = new Error(`视频不可用（已删除、下架或不可见）: ${errMsg}`);
        (err as any).permanent = true;
        reject(err);
        return;
      }
      reject(new Error(errMsg));
    });
  });
}
