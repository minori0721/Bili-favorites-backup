import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tempDir } from "./paths";
import { buildCookieString, BiliCookie } from "./users";

export interface DownloadResult {
  downloadDir: string;
}

export async function downloadWithBBDown(bvid: string, cookie: BiliCookie): Promise<DownloadResult> {
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
