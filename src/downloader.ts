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
  const filePattern = config.filenameTemplate || "<bvid>";

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
  if (config.bbdownQuality) {
    args.push("--dfn-priority", normalizeQualityPriority(config.bbdownQuality));
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

  const entries = await fs.promises.readdir(downloadDir);
  if (entries.length === 0) {
    throw new Error("BBDown did not produce any files");
  }

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

function isPermanentBBDownError(stderr: string) {
  return (
    stderr.includes("Arg_KeyNotFound") ||
    stderr.includes("未找到此 EP/SS") ||
    stderr.includes("视频不存在") ||
    stderr.includes("稿件不可见") ||
    stderr.includes("已失效")
  );
}

function runCommand(command: string, args: string[], cwd: string, bvid: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stderr = "";
    let stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(chunk);
      stdoutBuffer += text;

      const parsed = parseBBDownOutput(stdoutBuffer, bvid);
      for (const entry of parsed) {
        logManager.push(entry);
      }

      const rawLines = text.split("\n").filter((line: string) => line.trim());
      for (const rawLine of rawLines) {
        logManager.push({
          timestamp: new Date().toISOString(),
          type: "download",
          level: "info",
          summary: rawLine.trim(),
          raw: rawLine,
          bvid,
        });
      }

      stdoutBuffer = "";
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
      if (code === 0) {
        resolve();
        return;
      }

      const errMsg = stderr || `Command failed with code ${code}`;
      if (isPermanentBBDownError(stderr)) {
        const err = new Error(`视频不可用（已删除、下架或不可见）: ${errMsg}`);
        (err as any).permanent = true;
        reject(err);
        return;
      }
      reject(new Error(errMsg));
    });
  });
}
