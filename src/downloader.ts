import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tempDir } from "./paths.js";
import { buildCookieString, BiliCookie } from "./users.js";

export interface DownloadResult {
  downloadDir: string;
}

import { AppConfig } from "./config.js";

export async function downloadWithBBDown(bvid: string, cookie: BiliCookie, config: AppConfig): Promise<DownloadResult> {
  const downloadDir = path.join(tempDir, bvid);
  await fs.promises.rm(downloadDir, { recursive: true, force: true });
  await fs.promises.mkdir(downloadDir, { recursive: true });

  const url = `https://www.bilibili.com/video/${bvid}`;
  const cookieString = buildCookieString(cookie);
  const args = [
    url,
    "-c",
    cookieString,
    "--work-dir",
    downloadDir,
    "-F",
    "<bvid>",
    "-M",
    "<bvid>_P<pageNumberWithZero>",
  ];

  if (config.bbdownEncoding) {
    args.push("--encoding-priority", config.bbdownEncoding);
  }
  if (config.bbdownQuality) {
    args.push("--dfn-priority", config.bbdownQuality);
  }
  if (config.bbdownHiRes || config.bbdownDolby) {
    // BBDown 需要使用 APP 端接口 (-app) 才能解析出 Hi-Res 和 杜比音效
    args.push("-app");
  }
  
  await runCommand("BBDown", args, downloadDir);

  const entries = await fs.promises.readdir(downloadDir);
  if (entries.length === 0) {
    throw new Error("BBDown did not produce any files");
  }

  return { downloadDir };
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });
  });
}
