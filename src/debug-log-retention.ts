import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

export interface DebugLogRetentionPolicy {
  maxAgeDays: number;
  maxFiles: number;
  maxBytes: number;
}

export interface DebugLogRotationResult {
  scannedFiles: number;
  removedFiles: number;
  removedBytes: number;
  retainedFiles: number;
  retainedBytes: number;
  failedFiles: number;
}

const DEFAULT_POLICY: DebugLogRetentionPolicy = {
  maxAgeDays: 14,
  maxFiles: 200,
  maxBytes: 256 * 1024 * 1024,
};

export const debugLogDir = path.join(dataDir, "debug");

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  warn: (message: string) => void
) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    warn(`[Security] ${key} 配置无效，已使用安全默认值。`);
    return fallback;
  }
  return parsed;
}

export function readDebugLogRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): DebugLogRetentionPolicy {
  const maxAgeDays = readBoundedInteger(env, "BFB_DEBUG_LOG_RETENTION_DAYS", DEFAULT_POLICY.maxAgeDays, 1, 365, warn);
  const maxFiles = readBoundedInteger(env, "BFB_DEBUG_LOG_MAX_FILES", DEFAULT_POLICY.maxFiles, 10, 10_000, warn);
  const maxMiB = readBoundedInteger(env, "BFB_DEBUG_LOG_MAX_MIB", DEFAULT_POLICY.maxBytes / 1024 / 1024, 16, 102_400, warn);
  return { maxAgeDays, maxFiles, maxBytes: maxMiB * 1024 * 1024 };
}

function errorCode(error: unknown) {
  return String((error as NodeJS.ErrnoException)?.code || "UNKNOWN");
}

async function rotateDebugLogsNow(options: {
  directory: string;
  policy: DebugLogRetentionPolicy;
  nowMs: number;
  warn: (message: string) => void;
}): Promise<DebugLogRotationResult> {
  const result: DebugLogRotationResult = {
    scannedFiles: 0,
    removedFiles: 0,
    removedBytes: 0,
    retainedFiles: 0,
    retainedBytes: 0,
    failedFiles: 0,
  };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(options.directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return result;
    options.warn(`[DebugLog] 无法读取日志目录 (${errorCode(error)})。`);
    return result;
  }

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith(".log")) continue;
    try {
      const filePath = path.join(options.directory, entry.name);
      const stat = await fs.promises.stat(filePath);
      files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      result.failedFiles += 1;
      options.warn(`[DebugLog] 无法读取一个日志文件 (${errorCode(error)})。`);
    }
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  result.scannedFiles = files.length;

  const cutoff = options.nowMs - options.policy.maxAgeDays * 24 * 60 * 60_000;
  const retained: typeof files = [];
  const remove = async (file: typeof files[number]) => {
    try {
      await fs.promises.rm(file.path, { force: true });
      result.removedFiles += 1;
      result.removedBytes += file.size;
      return true;
    } catch (error) {
      result.failedFiles += 1;
      options.warn(`[DebugLog] 无法删除一个过期日志 (${errorCode(error)})。`);
      return false;
    }
  };

  for (const file of files) {
    if (file.mtimeMs < cutoff && await remove(file)) continue;
    retained.push(file);
  }
  let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
  let cursor = 0;
  while ((retained.length - cursor > options.policy.maxFiles || retainedBytes > options.policy.maxBytes) && cursor < retained.length) {
    const file = retained[cursor];
    cursor += 1;
    if (await remove(file)) retainedBytes -= file.size;
  }
  result.retainedFiles = Math.max(0, files.length - result.removedFiles);
  result.retainedBytes = Math.max(0, files.reduce((total, file) => total + file.size, 0) - result.removedBytes);
  return result;
}

const activeRotations = new Map<string, Promise<DebugLogRotationResult>>();

export function rotateDebugLogs(options: {
  directory?: string;
  policy?: DebugLogRetentionPolicy;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  warn?: (message: string) => void;
} = {}) {
  const directory = path.resolve(options.directory || debugLogDir);
  const existing = activeRotations.get(directory);
  if (existing) return existing;
  const warn = options.warn || console.warn;
  const policy = options.policy || readDebugLogRetentionPolicy(options.env || process.env, warn);
  const promise = rotateDebugLogsNow({ directory, policy, nowMs: options.nowMs ?? Date.now(), warn })
    .finally(() => activeRotations.delete(directory));
  activeRotations.set(directory, promise);
  return promise;
}

export function createDebugLogPath(bvid: string, directory = debugLogDir, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return path.join(directory, `${stamp}_${bvid}_${suffix}.log`);
}

export async function writeDebugLogAtomic(filePath: string, content: string) {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
  await rotateDebugLogs({ directory }).catch(() => undefined);
  return filePath;
}
