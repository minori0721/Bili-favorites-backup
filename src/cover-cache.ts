import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { coversDir, tempDir } from "./paths.js";

const activeCoverJobs = new Map<string, Promise<string | null>>();
const pendingCoverJobs: Array<{
  bvid: string;
  coverUrl: string;
  onCached?: (relativePath: string) => void;
}> = [];
let runningCoverJobs = 0;
const maxCoverJobs = 1;

function safeBvid(value: string) {
  return String(value || "").replace(/[^0-9A-Za-z]/g, "");
}

function coverPathForBvid(bvid: string) {
  return path.join(coversDir, `${safeBvid(bvid)}.webp`);
}

export function coverRelativePathForBvid(bvid: string) {
  return `covers/${safeBvid(bvid)}.webp`;
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function runFfmpeg(inputPath: string, outputPath: string) {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vf",
      "scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2",
      "-c:v",
      "libwebp",
      "-quality",
      "70",
      outputPath,
    ];
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function downloadCover(url: string, outputPath: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.bilibili.com/",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`cover download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(outputPath, buffer);
}

async function moveAcrossMounts(source: string, target: string) {
  try {
    await fs.promises.rename(source, target);
  } catch (error: any) {
    if (!["EXDEV", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
    await fs.promises.copyFile(source, target);
    await fs.promises.unlink(source).catch(() => undefined);
  }
}

async function cacheCoverInternal(bvid: string, coverUrl: string) {
  const normalizedBvid = safeBvid(bvid);
  if (!normalizedBvid || !coverUrl) {
    return null;
  }
  await fs.promises.mkdir(coversDir, { recursive: true });
  const finalPath = coverPathForBvid(normalizedBvid);
  if (fs.existsSync(finalPath)) {
    return coverRelativePathForBvid(normalizedBvid);
  }

  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempRoot = await fs.promises.mkdtemp(path.join(tempDir, `cover-${normalizedBvid}-`));
  const rawPath = path.join(tempRoot, "source");
  const tempWebp = path.join(tempRoot, "cover.webp");
  try {
    await downloadCover(coverUrl, rawPath);
    await runFfmpeg(rawPath, tempWebp);
    await moveAcrossMounts(tempWebp, finalPath);
    return coverRelativePathForBvid(normalizedBvid);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

export function queueCoverCache(bvid: string, coverUrl: string, onCached?: (relativePath: string) => void) {
  const normalizedBvid = safeBvid(bvid);
  if (!normalizedBvid || !coverUrl) {
    return;
  }
  if (fs.existsSync(coverPathForBvid(normalizedBvid))) {
    onCached?.(coverRelativePathForBvid(normalizedBvid));
    return;
  }
  if (activeCoverJobs.has(normalizedBvid)) {
    return;
  }
  activeCoverJobs.set(normalizedBvid, Promise.resolve(null));
  pendingCoverJobs.push({ bvid: normalizedBvid, coverUrl, onCached });
  runNextCoverJob();
}

function runNextCoverJob() {
  if (runningCoverJobs >= maxCoverJobs) {
    return;
  }
  const next = pendingCoverJobs.shift();
  if (!next) {
    return;
  }
  runningCoverJobs += 1;
  const job = cacheCoverInternal(next.bvid, next.coverUrl)
    .then((relativePath) => {
      if (relativePath) {
        next.onCached?.(relativePath);
      }
      return relativePath;
    })
    .catch((error) => {
      console.warn(`[CoverCache] Failed to cache ${next.bvid}:`, error?.message || error);
      return null;
    })
    .finally(() => {
      activeCoverJobs.delete(next.bvid);
      runningCoverJobs -= 1;
      runNextCoverJob();
    });
  activeCoverJobs.set(next.bvid, job);
}
