import { sanitizeSegment, joinRemotePath } from "./utils.js";
import { UploadLayout } from "./config.js";

export interface UploadContext {
  destination: string;
  layout: UploadLayout;
  userName: string;
  folderName: string;
}

export function resolveRemotePath(context: UploadContext) {
  const userSegment = sanitizeSegment(context.userName) || "user";
  const folderSegment = sanitizeSegment(context.folderName) || "favorites";

  switch (context.layout) {
    case "user-folder-video":
      return joinRemotePath(context.destination, userSegment, folderSegment);
    case "folder-video":
      return joinRemotePath(context.destination, folderSegment);
    case "video-only":
    default:
      return joinRemotePath(context.destination);
  }
}

import { createClient, WebDAVClient } from "webdav";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppConfig } from "./config.js";
import { logManager } from "./logger.js";
import { type RemoteFileQualityProfile, type RemoteFileRecord, type UploadFileMetadata } from "./state.js";
import { captureUploadResponseBody, classifyUploadError, sanitizeUploadText, UploadOperationError } from "./upload-health.js";
import {
  TransferSessionStore,
  type TransferSessionFileRecord,
  type TransferSessionPhase,
} from "./transfer-session.js";
import {
  asRemoteOperationsClient,
  createRemoteReplacementRunner,
  type RemoteReplacementRunner,
} from "./remote-operations.js";
import {
  decideUploadGroupPreflight,
  UploadPreflightConflictError,
  type ExistingArchiveProof,
  type UploadGroupPreflightDecision,
  type UploadIntent,
} from "./upload-preflight.js";
import {
  createRemoteFileResolver,
  isRemoteNotFoundError as isResolvedRemoteNotFoundError,
  RemoteFileResolutionConflictError,
  normalizeRemoteDirectoryEntry,
  type RemoteFileResolver,
} from "./remote-file-resolver.js";
import { buildStorageDavUrl } from "./storage-url.js";
import { isRemotePathWithin, normalizeRemotePath, remoteBasename, remoteDirname } from "./remote-path.js";

export function buildDavClient(config: AppConfig): WebDAVClient {
  const davUrl = buildStorageDavUrl(config.alistUrl);
  return createClient(davUrl, {
    username: config.alistUsername,
    password: config.alistPassword,
  });
}

export async function ensureRemoteDir(client: WebDAVClient, remotePath: string) {
  const segments = normalizeRemotePath(remotePath, { allowTrailingSlash: true }).split('/').filter(s => s.length > 0);
  let currentPath = '';
  for (const segment of segments) {
    currentPath += '/' + segment;
    if (await client.exists(currentPath) === false) {
      try {
        await client.createDirectory(currentPath);
      } catch (error) {
        try {
          if (await client.exists(currentPath)) {
            continue;
          }
        } catch (checkError) {
          throw checkError;
        }
        throw error;
      }
    }
  }
}

export interface UploadResult {
  remotePath: string;
  files: RemoteFileRecord[];
  allVerified: boolean;
  disposition?: "uploaded" | "resumed_current_session" | "retained_existing_archive" | "conflict_candidate";
  retainedProof?: ExistingArchiveProof;
  conflictCandidate?: {
    id: string;
    originalRemotePath: string;
    candidateRemotePath: string;
    reasonCode: string;
    reasonSummary: string;
    existingArchiveProof?: ExistingArchiveProof;
  };
  sessionId?: string;
  sessionGeneration?: number;
  phase?: TransferSessionPhase;
  pendingChecks?: Array<{
    remoteFile: string;
    expectedSize: number;
    finalFile: string;
    localRelativePath: string;
  }>;
}

export class UploadStartLimiter {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  ) {}

  async wait(intervalMs: number) {
    const normalizedInterval = Math.max(0, Math.floor(intervalMs));
    if (normalizedInterval === 0) return;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = turn;
    await previous;
    try {
      const delayMs = Math.max(0, this.nextStartAt - this.now());
      if (delayMs > 0) await this.sleep(delayMs);
      this.nextStartAt = this.now() + normalizedInterval;
    } finally {
      release();
    }
  }
}

const sharedUploadStartLimiter = new UploadStartLimiter();

function buildRemoteFileQualityProfile(config: AppConfig): RemoteFileQualityProfile {
  return {
    quality: String(config.bbdownQuality || ""),
    encoding: String(config.bbdownEncoding || ""),
    hiRes: Boolean(config.bbdownHiRes),
    dolby: Boolean(config.bbdownDolby),
  };
}

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".flv": "video/x-flv",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".ass": "text/x-ssa",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

export function detectUploadMimeType(filePath: string) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function buildUploadHeaders(filePath: string, stat: fs.Stats) {
  const modifiedSeconds = Math.max(0, Math.floor(stat.mtimeMs / 1000));
  return {
    "Content-Length": String(stat.size),
    "Content-Type": detectUploadMimeType(filePath),
    "X-OC-Mtime": String(modifiedSeconds),
    "X-OC-Ctime": String(modifiedSeconds),
  };
}

export function hasFourByteCharacters(value: string) {
  return Array.from(value).some((character) => Buffer.byteLength(character, "utf-8") === 4);
}

function stripFourByteCharacters(value: string) {
  return Array.from(value)
    .filter((character) => Buffer.byteLength(character, "utf-8") !== 4)
    .join("");
}

export function buildCompatibilityUploadName(fileName: string, reservedNames: ReadonlySet<string> = new Set()) {
  if (!hasFourByteCharacters(fileName)) return undefined;
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  const safeStem = stripFourByteCharacters(stem) || "file";
  const safeExtension = stripFourByteCharacters(extension);
  const baseCandidate = `${safeStem}${safeExtension}`;
  if (!reservedNames.has(baseCandidate)) return baseCandidate;

  let suffix = 2;
  let candidate = `${safeStem}-compat-${suffix}${safeExtension}`;
  while (reservedNames.has(candidate)) {
    suffix += 1;
    candidate = `${safeStem}-compat-${suffix}${safeExtension}`;
  }
  return candidate;
}

async function toUploadOperationError(error: unknown, remotePath: string) {
  await captureUploadResponseBody(error);
  return error instanceof UploadOperationError
    ? error
    : new UploadOperationError(classifyUploadError(error, remotePath));
}

export async function verifyUploadedFile(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number,
  delaysMs: number[] = [0, 500, 1500],
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  let lastSize: number | undefined;
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const observed = await resolver.inspect(remoteFile, { fallback: "always" });
      lastSize = observed.size;
      if (observed.status === "exists" && !observed.directory && Number.isFinite(lastSize) && lastSize === expectedSize) {
        return;
      }
      const mismatch: any = new Error(
        observed.directory
          ? "Remote upload target is a directory"
          : `Remote size mismatch: expected ${expectedSize}, received ${Number.isFinite(lastSize) ? lastSize : "unknown"}`
      );
      mismatch.status = observed.status === "missing" ? 404 : 409;
      lastError = mismatch;
    } catch (error) {
      lastError = error;
    }
  }
  const verificationError: any = new Error(
    `Remote upload verification failed for ${remoteFile}: ${(lastError as Error)?.message || "file not visible"}`
  );
  verificationError.status = isRemoteNotFoundError(lastError) ? 404 : 409;
  verificationError.cause = lastError;
  throw new UploadOperationError(classifyUploadError(verificationError, remoteFile));
}

async function inspectExpectedRemoteFile(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number,
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
  fallback: "risk_only" | "always" = "risk_only",
) {
  const observed = await resolver.inspect(remoteFile, { fallback });
  if (observed.status === "missing") return "missing" as const;
  if (observed.directory) {
    const directoryConflict: any = new Error("Remote upload target is a directory");
    directoryConflict.status = 409;
    throw directoryConflict;
  }
  if (Number.isFinite(observed.size) && observed.size === expectedSize) return "verified" as const;
  const mismatch: any = new Error(`Remote size conflict: expected ${expectedSize}, received ${Number.isFinite(observed.size) ? observed.size : "unknown"}`);
  mismatch.status = 409;
  throw mismatch;
}

async function inspectRemoteFile(
  client: WebDAVClient,
  remoteFile: string,
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
  fallback: "risk_only" | "always" = "risk_only",
) {
  const observed = await resolver.inspect(remoteFile, { fallback });
  if (observed.status === "missing") return { status: "missing" as const, directory: false, path: observed.path };
  return {
    status: "exists" as const,
    size: observed.size,
    directory: observed.directory,
    path: observed.path,
  };
}

function uploadStatus(error: any) {
  return Number(error?.status || error?.statusCode || error?.response?.status || 0);
}

async function verify405WrittenFile(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number,
  delaysMs: number[],
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  let lastError: unknown;
  for (const delayMs of delaysMs.length > 0 ? delaysMs : [0]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const observed = await resolver.inspect(remoteFile, { fallback: "always" });
      const remoteSize = observed.size;
      if (observed.status === "exists" && !observed.directory && Number.isFinite(remoteSize) && remoteSize === expectedSize) {
        return "verified" as const;
      }
      const mismatch: any = new Error(
        observed.directory
          ? "Remote upload target is a directory"
          : `Remote size conflict: expected ${expectedSize}, received ${Number.isFinite(remoteSize) ? remoteSize : "unknown"}`
      );
      mismatch.status = observed.status === "missing" ? 404 : 409;
      throw mismatch;
    } catch (error) {
      if (isRemoteNotFoundError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  const notVisible: any = new Error(
    `Remote upload verification failed after 405 response: ${(lastError as Error)?.message || "file not visible"}`
  );
  notVisible.status = 405;
  throw notVisible;
}

async function verifyOrAwaitRemoteVisibility(
  client: WebDAVClient,
  remoteFile: string,
  expectedSize: number,
  delaysMs: number[],
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  try {
    await verifyUploadedFile(client, remoteFile, expectedSize, delaysMs, resolver);
    return "verified" as const;
  } catch (error) {
    if (Number((error as any)?.uploadFailure?.status || (error as any)?.status || 0) === 404) {
      return "awaiting_verification" as const;
    }
    if (isRemoteNotFoundError((error as any)?.cause || error)
      || isRemoteNotFoundError((error as any)?.uploadFailure?.summary || error)) {
      return "awaiting_verification" as const;
    }
    const summary = String((error as any)?.message || error || "");
    if (/404|not found|object not found/i.test(summary)) {
      return "awaiting_verification" as const;
    }
    throw error;
  }
}

interface PreparedUploadEntry {
  relativePath: string;
  name: string;
  localFile: string;
  remoteFile: string;
  stat: fs.Stats;
}

async function inspectLocalUploadPath(localRoot: string, localFile: string) {
  const root = path.resolve(localRoot);
  const target = path.resolve(localFile);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("本地上传路径超出下载目录");
  }
  const rootInfo = await fs.promises.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("本地上传根目录不是可信目录");
  }
  const relative = path.relative(root, target);
  const segments = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await fs.promises.lstat(current);
    if (info.isSymbolicLink()) throw new Error("本地上传路径不能包含软链接或junction");
    if (current !== target && !info.isDirectory()) throw new Error("本地上传父路径不是目录");
    if (current === target) {
      if (!info.isFile() || info.size <= 0) throw new Error("本地上传文件为空或无效");
      return info;
    }
  }
  throw new Error("本地上传目标不是文件");
}

async function openVerifiedLocalUpload(localRoot: string, localFile: string, expectedSize: number) {
  const before = await inspectLocalUploadPath(localRoot, localFile);
  const handle = await fs.promises.open(localFile, "r");
  try {
    const opened = await handle.stat();
    const identityMatches = !Number.isFinite(Number(before.ino)) || !Number.isFinite(Number(opened.ino))
      || (before.dev === opened.dev && before.ino === opened.ino);
    if (!identityMatches || !opened.isFile() || opened.size !== expectedSize) {
      throw Object.assign(new Error("本地上传文件在校验后发生变化"), {
        code: "LOCAL_UPLOAD_CHANGED",
        status: 422,
      });
    }
    // Keep ownership of the descriptor here. The upload stream must not close
    // the handle before the post-transfer fstat below runs.
    return { handle, stream: handle.createReadStream({ autoClose: false }), stat: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertLocalUploadUnchanged(
  opened: { handle: { stat(): Promise<fs.Stats> }; stat: fs.Stats },
  expectedSize: number,
) {
  const after = await opened.handle.stat();
  const identityMatches = !Number.isFinite(Number(opened.stat.ino)) || !Number.isFinite(Number(after.ino))
    || (opened.stat.dev === after.dev && opened.stat.ino === after.ino);
  const metadataMatches = after.isFile()
    && after.size === expectedSize
    && after.size === opened.stat.size
    && after.mtimeMs === opened.stat.mtimeMs
    && after.ctimeMs === opened.stat.ctimeMs;
  if (!identityMatches || !metadataMatches) {
    throw Object.assign(new Error("本地上传文件在传输完成后发生变化"), {
      code: "LOCAL_UPLOAD_CHANGED_AFTER_TRANSFER",
      status: 422,
    });
  }
}

async function putAndVerifyLocalFile(
  client: WebDAVClient,
  localRoot: string,
  localFile: string,
  remoteFile: string,
  stat: fs.Stats,
  verificationDelaysMs?: number[],
  beforePut?: () => Promise<void>,
  allowExistingMatch = false,
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  const preflight = await inspectExpectedRemoteFile(client, remoteFile, stat.size, resolver, "risk_only");
  if (preflight === "verified") {
    if (!allowExistingMatch) {
      throw new UploadPreflightConflictError(
        "UPLOAD_UNKNOWN_SAME_SIZE_TARGET",
        "远端目标在PUT前出现同名同大小文件，但缺少可验证的本次上传证明",
      );
    }
    return { verificationStatus: "verified" as const, skippedUpload: true, putAccepted: false };
  }
  await beforePut?.();
  const opened = await openVerifiedLocalUpload(localRoot, localFile, stat.size);
  const fileStream = opened.stream;
  try {
    try {
      const putAccepted = await client.putFileContents(remoteFile, fileStream as any, {
        contentLength: false,
        // The preflight is advisory; conditional PUT closes the race where
        // another writer creates a different file before this request starts.
        overwrite: false,
        headers: buildUploadHeaders(localFile, opened.stat),
      });
      if (putAccepted === false) {
        if (!allowExistingMatch) {
          throw new UploadPreflightConflictError(
            "UPLOAD_CONDITIONAL_TARGET_APPEARED",
            "条件PUT发现远端目标已存在，系统没有把未知文件标记为本次上传成功",
          );
        }
        const verificationStatus = await verifyOrAwaitRemoteVisibility(
          client,
          remoteFile,
          stat.size,
          verificationDelaysMs || [0],
          resolver,
        );
        await assertLocalUploadUnchanged(opened, stat.size);
        return {
          verificationStatus,
          skippedUpload: true,
          putAccepted: false,
        };
      }
    } catch (error) {
      // Some WebDAV drivers persist the PUT body and then incorrectly answer 405.
      // Only accept that response after the exact target is independently verified.
      if (uploadStatus(error) !== 405) throw error;
      await verify405WrittenFile(client, remoteFile, stat.size, verificationDelaysMs || [0], resolver);
      await assertLocalUploadUnchanged(opened, stat.size);
      return { verificationStatus: "verified" as const, skippedUpload: false, putAccepted: true };
    }
    const verificationStatus = await verifyOrAwaitRemoteVisibility(
      client,
      remoteFile,
      stat.size,
      verificationDelaysMs || [0],
      resolver,
    );
    await assertLocalUploadUnchanged(opened, stat.size);
    return { verificationStatus, skippedUpload: false, putAccepted: true };
  } finally {
    fileStream.destroy();
    await opened.handle.close().catch(() => undefined);
  }
}

function promoteProgressive405ToSessionFailure(error: UploadOperationError, completedFiles: number, totalFiles: number) {
  if (error.uploadFailure.status !== 405 || completedFiles <= 0) return error;
  const info = error.uploadFailure;
  info.category = "transient";
  info.retryable = true;
  info.code = "ALIST_UPLOAD_SESSION_AFTER_PROGRESS";
  info.summary = `WebDAV upload session failed after ${completedFiles}/${totalFiles} completed files: ${info.summary}`;
  info.fingerprint = "transient|405|alist-upload-session-after-progress";
  error.message = info.summary;
  error.permanent = false;
  error.deferToNextCycle = false;
  error.uploadSessionTransient = true;
  error.completedFilesBeforeFailure = completedFiles;
  return error;
}

function shouldRetryWithCompatibilityName(error: UploadOperationError, fileName: string) {
  const status = error.uploadFailure.status;
  return hasFourByteCharacters(fileName)
    && error.uploadFailure.category === "deterministic"
    && status !== undefined
    && [400, 405, 422].includes(status);
}

interface UploadOptions {
  cleanupLocal?: boolean;
  client?: WebDAVClient;
  verificationDelaysMs?: number[];
  log?: Pick<typeof logManager, "push">;
  files?: string[];
  filenameMetadataByPath?: Record<string, UploadFileMetadata>;
  uploadStartLimiter?: UploadStartLimiter;
  transferSessionStore?: TransferSessionStore;
  sessionId?: string;
  sessionGeneration?: number;
  sessionDedupeKey?: string;
  allowReupload?: boolean;
  reuploadAuthorizedFiles?: string[];
  consumeReuploadPermission?: (relativePath: string) => boolean;
  resumeOnly?: boolean;
  bvid?: string;
  userId?: string;
  mediaId?: number;
  historyOnly?: boolean;
  historySnapshotAt?: string;
  uploadIntent?: UploadIntent;
  existingArchiveProof?: ExistingArchiveProof;
  legacyConflictSideEffectsStarted?: boolean;
  conflictArchiveSegment?: string;
  conflictArchiveRoot?: string;
  conflictArchiveOldFiles?: RemoteFileRecord[];
  conflictArchiveVerifiedPaths?: string[];
  conflictArchiveRunner?: RemoteReplacementRunner;
  onConflictArchiveTargetVerified?: (file: { name: string; oldPath: string; archivedPath: string; size?: number }) => void | Promise<void>;
  onConflictArchived?: (archive: {
    archivePath: string;
    files: Array<{ name: string; oldPath: string; archivedPath: string; size?: number }>;
  }) => void | Promise<void>;
}

async function uploadWithAListDirect(
  localDir: string,
  remotePath: string,
  config: AppConfig,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const client = options.client || buildDavClient(config);
  const resolver = createRemoteFileResolver(client);
  const logger = options.log || logManager;
  const uploadedFiles: RemoteFileRecord[] = [];
  const qualityProfile = buildRemoteFileQualityProfile(config);
  const uploadStartLimiter = options.uploadStartLimiter || sharedUploadStartLimiter;
  const beforePut = () => uploadStartLimiter.wait(Number(config.uploadFileIntervalSeconds || 0) * 1000);

  const localRoot = path.resolve(localDir);
  const uploadEntries = options.files
    ? options.files.map((relativePath) => ({ relativePath, name: path.basename(relativePath) }))
    : (await fs.promises.readdir(localDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => ({ relativePath: entry.name, name: entry.name }));
  const preparedEntries: PreparedUploadEntry[] = [];
  for (const entry of uploadEntries) {
    const localFile = path.resolve(localDir, entry.relativePath);
    if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
      const localError: any = new Error(`Local upload path escapes the download directory: ${entry.relativePath}`);
      localError.status = 422;
      throw new UploadOperationError(classifyUploadError(localError, remotePath));
    }
    const remoteFile = remotePath.replace(/\/$/, "") + "/" + entry.name;
    let stat: fs.Stats;
    try {
      stat = await inspectLocalUploadPath(localRoot, localFile);
    } catch (error) {
      const localError: any = new Error(`Local upload file is empty or invalid: ${localFile}`);
      localError.status = 422;
      localError.cause = error;
      throw new UploadOperationError(classifyUploadError(localError, remoteFile));
    }
    preparedEntries.push({ ...entry, localFile, remoteFile, stat });
  }

  let groupDecision: UploadGroupPreflightDecision;
  try {
    groupDecision = await preflightUploadGroup(
      client,
      preparedEntries.map((entry) => ({
        remoteFile: entry.remoteFile,
        expectedSize: entry.stat.size,
        currentSessionPutAccepted: false,
      })),
      options,
      resolver,
    );
    if (groupDecision.kind === "retain_existing") {
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: "检测到完整旧归档，已保留旧版并跳过本次上传",
        raw: `[WebDAV] Retained existing archive proof files=${groupDecision.proof.files.length} strength=${groupDecision.proofStrength}`,
        simpleVisible: true,
      });
      return {
        remotePath: groupDecision.proof.remotePath,
        files: groupDecision.proof.files.map((file) => ({ ...file })),
        allVerified: true,
        disposition: "retained_existing_archive",
        retainedProof: groupDecision.proof,
      };
    }
    await ensureRemoteDir(client, remotePath);
  } catch (error) {
    throw await toUploadOperationError(error, remotePath);
  }

  const acceptedExistingPaths = new Set(groupDecision.acceptedExistingPaths);
  const uploadIntent = options.uploadIntent || (options.historyOnly ? "history_upload" : "normal_backup");

  const reservedRemoteNames = new Set(uploadEntries.map((entry) => entry.name));
  for (const entry of preparedEntries) {
      const localFile = entry.localFile;
      // Join using posix style for webdav
      const originalRemoteFile = entry.remoteFile;
      const stat = entry.stat;
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`[WebDAV] Uploading ${entry.name} to ${originalRemoteFile} (${stat.size} bytes)`);
      
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: `正在上传: ${entry.name} (${sizeKB} KB) → ${remotePath}`,
        raw: `[WebDAV] Uploading ${entry.name} to ${originalRemoteFile} (${stat.size} bytes)`,
        simpleVisible: true,
      });

      let uploadedName = entry.name;
      let uploadedRemoteFile = originalRemoteFile;
      let transferResult: Awaited<ReturnType<typeof putAndVerifyLocalFile>>;
      try {
        transferResult = await putAndVerifyLocalFile(
          client,
          localRoot,
          localFile,
          originalRemoteFile,
          stat,
          options.verificationDelaysMs,
          beforePut,
          uploadIntent !== "normal_backup" || acceptedExistingPaths.has(originalRemoteFile.replace(/\\/g, "/")),
          resolver,
        );
      } catch (error) {
        const uploadError = await toUploadOperationError(error, originalRemoteFile);
        const compatibilityName = shouldRetryWithCompatibilityName(uploadError, entry.name)
          ? buildCompatibilityUploadName(entry.name, reservedRemoteNames)
          : undefined;
        if (!compatibilityName) {
          promoteProgressive405ToSessionFailure(uploadError, uploadedFiles.length, preparedEntries.length);
          const info = uploadError.uploadFailure;
          console.error(`[WebDAV] Upload failed status=${info.status || "unknown"} category=${info.category} path=${originalRemoteFile}: ${info.summary}`);
          logger.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "error",
            summary: `上传失败: ${entry.name} - ${info.summary}`,
            raw: `[WebDAV] Failed status=${info.status || "unknown"} category=${info.category} retryable=${info.retryable} path=${originalRemoteFile}: ${info.summary}`,
            simpleVisible: true,
          });
          throw uploadError;
        }

        uploadedName = compatibilityName;
        uploadedRemoteFile = remotePath.replace(/\/$/, "") + "/" + compatibilityName;
        console.warn(`[WebDAV] Retrying with compatible remote name ${entry.name} -> ${compatibilityName}`);
        logger.push({
          timestamp: new Date().toISOString(),
          type: "upload",
          level: "warn",
          summary: `文件名兼容重试: ${entry.name} → ${compatibilityName}`,
          raw: `[WebDAV] Retrying with compatible remote name ${entry.name} -> ${compatibilityName}`,
          simpleVisible: true,
        });
        try {
          transferResult = await putAndVerifyLocalFile(
            client,
            localRoot,
            localFile,
            uploadedRemoteFile,
            stat,
            options.verificationDelaysMs,
            beforePut,
            uploadIntent !== "normal_backup",
            resolver,
          );
        } catch (compatibilityError) {
          const finalError = await toUploadOperationError(compatibilityError, uploadedRemoteFile);
          promoteProgressive405ToSessionFailure(finalError, uploadedFiles.length, preparedEntries.length);
          const info = finalError.uploadFailure;
          console.error(`[WebDAV] Compatible-name upload failed status=${info.status || "unknown"} category=${info.category} path=${uploadedRemoteFile}: ${info.summary}`);
          logger.push({
            timestamp: new Date().toISOString(),
            type: "upload",
            level: "error",
            summary: `兼容文件名上传失败: ${compatibilityName} - ${info.summary}`,
            raw: `[WebDAV] Compatible-name upload failed status=${info.status || "unknown"} category=${info.category} retryable=${info.retryable} path=${uploadedRemoteFile}: ${info.summary}`,
            simpleVisible: true,
          });
          throw finalError;
        }
      }

      reservedRemoteNames.add(uploadedName);
      const awaitingVerification = transferResult.verificationStatus === "awaiting_verification";
      logger.push({
        timestamp: new Date().toISOString(),
        type: "upload",
        level: "info",
        summary: awaitingVerification
          ? `上传已接受，等待远端确认: ${entry.name}`
          : (transferResult.skippedUpload
            ? `远端文件已存在，跳过重复上传: ${entry.name}`
            : (uploadedName === entry.name ? `上传完成: ${entry.name}` : `上传完成: ${entry.name}（远端 ${uploadedName}）`)),
        raw: awaitingVerification
          ? `[WebDAV] PUT accepted; awaiting remote visibility for ${uploadedName}`
          : `[WebDAV] Upload verified for ${entry.name} as ${uploadedName}${transferResult.skippedUpload ? " (preflight)" : ""}`,
        simpleVisible: true,
      });

      const uploadMetadata = options.filenameMetadataByPath?.[entry.relativePath.replace(/\\/g, "/")];
      const { mediaMetadata, ...filenameMetadata } = uploadMetadata || {};
      uploadedFiles.push({
        name: uploadedName,
        path: uploadedRemoteFile,
        size: stat.size,
        qualityProfile,
        mediaMetadata,
        localRelativePath: entry.relativePath,
        filenameMetadata: uploadMetadata ? filenameMetadata : undefined,
        verificationStatus: transferResult.verificationStatus,
        putCompletedAt: transferResult.putAccepted ? new Date().toISOString() : undefined,
        verifyAttempts: transferResult.verificationStatus === "verified" ? 1 : 0,
        nextVerifyAt: transferResult.verificationStatus === "awaiting_verification"
          ? new Date(Date.now() + 2_000).toISOString()
          : undefined,
      });
  }

  if (uploadedFiles.length === 0) {
    const emptyError: any = new Error(`Local upload directory contains no files: ${localDir}`);
    emptyError.status = 422;
    throw new UploadOperationError(classifyUploadError(emptyError, remotePath));
  }

  const allVerified = uploadedFiles.every((file) => file.verificationStatus === "verified");
  if (options.cleanupLocal !== false && allVerified) {
    await fs.promises.rm(localDir, { recursive: true, force: true });
  }
  return {
    remotePath,
    files: uploadedFiles,
    allVerified,
    disposition: groupDecision.kind === "resume_current_session" ? "resumed_current_session" : "uploaded",
  };
}

interface TransactionalPreparedEntry {
  relativePath: string;
  localFile: string;
  stat: fs.Stats;
  sessionFile: TransferSessionFileRecord;
}

function transferFileRecord(
  entry: TransactionalPreparedEntry,
  config: AppConfig,
  metadata?: UploadFileMetadata,
  status: RemoteFileRecord["verificationStatus"] = "awaiting_verification",
): RemoteFileRecord {
  return {
    name: entry.sessionFile.name,
    path: entry.sessionFile.finalPath,
    size: entry.stat.size,
    qualityProfile: buildRemoteFileQualityProfile(config),
    mediaMetadata: metadata?.mediaMetadata,
    localRelativePath: entry.relativePath,
    filenameMetadata: metadata ? (() => {
      const { mediaMetadata: _mediaMetadata, ...filenameMetadata } = metadata;
      return filenameMetadata;
    })() : undefined,
    verificationStatus: status,
    putCompletedAt: entry.sessionFile.putAcceptedAt ? new Date(entry.sessionFile.putAcceptedAt).toISOString() : undefined,
    verifyAttempts: entry.sessionFile.attempts,
    nextVerifyAt: status === "awaiting_verification" ? new Date(Date.now() + 2_000).toISOString() : undefined,
    lastError: entry.sessionFile.lastError,
  };
}

async function inspectPathForExpectedSize(
  client: WebDAVClient,
  remotePath: string,
  expectedSize: number,
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  const result = await inspectRemoteFile(client, remotePath, resolver, "always");
  if (result.status === "missing") return result;
  if (result.directory) {
    const directoryConflict: any = new Error("Remote upload target is a directory");
    directoryConflict.status = 409;
    throw directoryConflict;
  }
  if (result.size !== expectedSize) {
    const mismatch: any = new Error(`Remote size conflict: expected ${expectedSize}, received ${result.size ?? "unknown"}`);
    mismatch.status = 409;
    throw mismatch;
  }
  return result;
}

async function preflightUploadGroup(
  client: WebDAVClient,
  entries: Array<{ remoteFile: string; expectedSize: number; currentSessionPutAccepted: boolean }>,
  options: UploadOptions,
  resolver: RemoteFileResolver = createRemoteFileResolver(client),
) {
  const intent = options.uploadIntent || (options.historyOnly ? "history_upload" : "normal_backup");
  const existingArchiveObservations = [];
  if (intent === "normal_backup" && options.existingArchiveProof) {
    for (const file of options.existingArchiveProof.files) {
      const observed = await inspectRemoteFile(client, file.path, resolver, "always");
      const { path: _observedPath, ...observation } = observed;
      existingArchiveObservations.push({ path: file.path, ...observation });
    }
  }
  const targets = [];
  for (const entry of entries) {
    const observed = await inspectRemoteFile(client, entry.remoteFile, resolver, "risk_only");
    targets.push({
      path: entry.remoteFile,
      expectedSize: entry.expectedSize,
      currentSessionPutAccepted: entry.currentSessionPutAccepted,
      observed: { ...observed, path: entry.remoteFile },
    });
  }
  return decideUploadGroupPreflight({
    intent,
    existingArchiveProof: options.existingArchiveProof,
    existingArchiveObservations,
    targets,
    legacyConflictSideEffectsStarted: options.legacyConflictSideEffectsStarted,
  });
}

async function uploadWithTransferSession(
  localDir: string,
  remotePath: string,
  config: AppConfig,
  options: UploadOptions,
): Promise<UploadResult> {
  const store = options.transferSessionStore!;
  const client = options.client || buildDavClient(config);
  const resolver = createRemoteFileResolver(client);
  const bvid = String(options.bvid || "");
  if (!bvid && !options.sessionId) throw new Error("Transactional upload requires a BVID or session id");
  const session = store.ensure({
    sessionId: options.sessionId,
    dedupeKey: options.sessionDedupeKey || `upload:${options.userId || "video"}:${options.mediaId || 0}:${bvid}:${remotePath}:${options.historySnapshotAt || "main"}`,
    bvid,
    userId: options.userId,
    mediaId: options.mediaId,
    localDir,
    remotePath,
    historyOnly: options.historyOnly,
    historySnapshotAt: options.historySnapshotAt,
    expectedGeneration: options.sessionGeneration,
  });
  const sessionGeneration = session.generation;
  // Re-upload permission belongs to individual files on the leased upload
  // job. The old session-wide flag is cleared and never used as authority.
  if (session.allowReupload) {
    store.updateSession(session.id, { allowReupload: false }, sessionGeneration);
  }
  const legacyAllowReupload = options.allowReupload === true;
  const reuploadAuthorizedFiles = new Set(
    (options.reuploadAuthorizedFiles || []).map((value) => String(value || "").replace(/\\/g, "/"))
  );

  const localRoot = path.resolve(localDir);
  const sessionFiles = store.listFiles(session.id, sessionGeneration);
  const requestedFiles = options.files || sessionFiles.map((file) => file.relativePath);
  const uploadEntries = requestedFiles.length > 0
    ? requestedFiles.map((relativePath) => ({ relativePath, name: path.basename(relativePath) }))
    : (await fs.promises.readdir(localDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ relativePath: entry.name, name: entry.name }));
  const preparedEntries: TransactionalPreparedEntry[] = [];
  for (const entry of uploadEntries) {
    const localFile = path.resolve(localDir, entry.relativePath);
    if (localFile !== localRoot && !localFile.startsWith(`${localRoot}${path.sep}`)) {
      const localError: any = new Error(`Local upload path escapes the download directory: ${entry.relativePath}`);
      localError.status = 422;
      throw new UploadOperationError(classifyUploadError(localError, remotePath));
    }
    let stat: fs.Stats;
    try {
      stat = await inspectLocalUploadPath(localRoot, localFile);
    } catch (error) {
      const localError: any = new Error(`Local upload file is missing: ${entry.relativePath}`);
      localError.status = 422;
      localError.cause = error;
      throw new UploadOperationError(classifyUploadError(localError, remotePath));
    }
    if (!stat.isFile() || stat.size <= 0) {
      const localError: any = new Error(`Local upload file is empty or invalid: ${entry.relativePath}`);
      localError.status = 422;
      throw new UploadOperationError(classifyUploadError(localError, remotePath));
    }
    const sessionFile = store.ensureFile(session.id, { relativePath: entry.relativePath, name: entry.name, expectedSize: stat.size }, sessionGeneration);
    preparedEntries.push({ relativePath: entry.relativePath, localFile, stat, sessionFile });
  }
  if (preparedEntries.length === 0) {
    const emptyError: any = new Error(`Local upload directory contains no files: ${localDir}`);
    emptyError.status = 422;
    throw new UploadOperationError(classifyUploadError(emptyError, remotePath));
  }

  let groupDecision: UploadGroupPreflightDecision;
  try {
    groupDecision = await preflightUploadGroup(
      client,
      preparedEntries.map((entry) => ({
        remoteFile: entry.sessionFile.finalPath,
        expectedSize: entry.stat.size,
        currentSessionPutAccepted: Boolean(entry.sessionFile.putAcceptedAt),
      })),
      options,
      resolver,
    );
    if (groupDecision.kind === "retain_existing") {
      store.supersede(session.id, sessionGeneration);
      return {
        remotePath: groupDecision.proof.remotePath,
        files: groupDecision.proof.files.map((file) => ({ ...file })),
        allVerified: true,
        sessionId: session.id,
        sessionGeneration,
        phase: "superseded",
        disposition: "retained_existing_archive",
        retainedProof: groupDecision.proof,
      };
    }
    await ensureRemoteDir(client, remotePath);
  } catch (error) {
    store.updateSession(session.id, { phase: "failed", lastError: sanitizeUploadText((error as any)?.message || error) }, sessionGeneration);
    throw await toUploadOperationError(error, remotePath);
  }

  const uploadStartLimiter = options.uploadStartLimiter || sharedUploadStartLimiter;
  const beforePut = () => uploadStartLimiter.wait(Number(config.uploadFileIntervalSeconds || 0) * 1000);
  const verificationDelays = options.verificationDelaysMs || [0, 500, 1500];
  const uploadIntent = options.uploadIntent || (options.historyOnly ? "history_upload" : "normal_backup");
  const acceptedExistingPaths = new Set(groupDecision.acceptedExistingPaths);
  const finalFiles: RemoteFileRecord[] = [];
  const pendingChecks: UploadResult["pendingChecks"] = [];
  const reservedRemoteNames = new Set(preparedEntries.map((entry) => entry.sessionFile.name));
  store.updateSession(session.id, { phase: "uploading", lastError: null }, sessionGeneration);

  for (const prepared of preparedEntries) {
    const entry = prepared;
    let sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration) || entry.sessionFile;
    const metadata = options.filenameMetadataByPath?.[entry.relativePath.replace(/\\/g, "/")];
    try {
      let finalResult: Awaited<ReturnType<typeof inspectRemoteFile>>;
      finalResult = await inspectPathForExpectedSize(client, sessionFile.finalPath, entry.stat.size, resolver);
      if (finalResult.status === "exists") {
        const normalizedFinalPath = sessionFile.finalPath.replace(/\\/g, "/");
        if (uploadIntent === "normal_backup"
          && !sessionFile.putAcceptedAt
          && !acceptedExistingPaths.has(normalizedFinalPath)) {
          throw new UploadPreflightConflictError(
            "UPLOAD_UNKNOWN_SAME_SIZE_TARGET",
            "远端目标在整组预检后出现同名同大小文件，但缺少本次Session的PUT证明",
          );
        }
        store.updateFile(session.id, entry.relativePath, {
          status: "verified",
          verifiedAt: Date.now(),
          lastError: null,
          nextCheckAt: null,
        }, sessionGeneration);
        sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration)!;
        finalFiles.push(transferFileRecord({ ...entry, sessionFile }, config, metadata, "verified"));
        continue;
      }

      const hasPriorPut = Boolean(sessionFile.putAcceptedAt);
      const hasReuploadAuthorization = legacyAllowReupload || reuploadAuthorizedFiles.has(entry.relativePath.replace(/\\/g, "/"));
      const mayPut = !options.resumeOnly || hasReuploadAuthorization;
      if (!mayPut) {
        const now = Date.now();
        store.updateFile(session.id, entry.relativePath, {
          status: "awaiting_remote",
          nextCheckAt: now + 2_000,
          lastError: hasPriorPut
            ? "PUT 已接受，但正式文件暂不可见；未自动重复上传"
            : "仅确认模式未执行PUT，等待正式文件可见",
        }, sessionGeneration);
        sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration)!;
        finalFiles.push(transferFileRecord({ ...entry, sessionFile }, config, metadata));
        pendingChecks.push({ remoteFile: sessionFile.finalPath, expectedSize: entry.stat.size, finalFile: sessionFile.finalPath, localRelativePath: entry.relativePath });
        continue;
      }

      store.updateFile(session.id, entry.relativePath, {
        status: "uploading",
        attempts: sessionFile.attempts + 1,
        lastError: null,
      }, sessionGeneration);
      let reuploadPermissionConsumed = false;
      const beforeAuthorizedPut = async () => {
        if (options.resumeOnly && !reuploadPermissionConsumed) {
          const granted = legacyAllowReupload
            || Boolean(options.consumeReuploadPermission?.(entry.relativePath.replace(/\\/g, "/")));
          if (!granted) {
            const permissionError: any = new Error("Re-upload permission is no longer available for this file");
            permissionError.status = 409;
            permissionError.code = "UPLOAD_REUPLOAD_PERMISSION_MISSING";
            throw permissionError;
          }
          reuploadPermissionConsumed = true;
        }
        await beforePut();
      };
      let transfer: Awaited<ReturnType<typeof putAndVerifyLocalFile>>;
      try {
        transfer = await putAndVerifyLocalFile(
          client,
          localRoot,
          entry.localFile,
          sessionFile.finalPath,
          entry.stat,
          verificationDelays,
          beforeAuthorizedPut,
          uploadIntent !== "normal_backup"
            || Boolean(sessionFile.putAcceptedAt)
            || acceptedExistingPaths.has(sessionFile.finalPath.replace(/\\/g, "/")),
          resolver,
        );
      } catch (error) {
        const uploadError = await toUploadOperationError(error, sessionFile.finalPath);
        const compatibilityName = shouldRetryWithCompatibilityName(uploadError, sessionFile.name)
          ? buildCompatibilityUploadName(sessionFile.name, reservedRemoteNames)
          : undefined;
        if (!compatibilityName) throw uploadError;
        const compatibilityPath = joinRemotePath(session.remotePath, compatibilityName);
        await inspectPathForExpectedSize(client, compatibilityPath, entry.stat.size, resolver);
        store.updateFile(session.id, entry.relativePath, {
          name: compatibilityName,
          stagingPath: compatibilityPath,
          finalPath: compatibilityPath,
          status: "uploading",
        }, sessionGeneration);
        sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration)!;
        reservedRemoteNames.add(compatibilityName);
        try {
          transfer = await putAndVerifyLocalFile(
            client,
            localRoot,
            entry.localFile,
            compatibilityPath,
            entry.stat,
            verificationDelays,
            beforeAuthorizedPut,
            uploadIntent !== "normal_backup",
            resolver,
          );
        } catch (compatibilityError) {
          throw await toUploadOperationError(compatibilityError, compatibilityPath);
        }
      }
      if (transfer.verificationStatus === "awaiting_verification") {
        const now = Date.now();
        store.updateFile(session.id, entry.relativePath, {
          status: "awaiting_remote",
          putAcceptedAt: transfer.putAccepted ? now : sessionFile.putAcceptedAt,
          nextCheckAt: now + 2_000,
          lastError: transfer.putAccepted
            ? "PUT 已接受，等待正式文件可见"
            : "远端已有目标，等待正式文件可见",
        }, sessionGeneration);
        sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration)!;
        finalFiles.push(transferFileRecord({ ...entry, sessionFile }, config, metadata));
        pendingChecks.push({ remoteFile: sessionFile.finalPath, expectedSize: entry.stat.size, finalFile: sessionFile.finalPath, localRelativePath: entry.relativePath });
        continue;
      }
      store.updateFile(session.id, entry.relativePath, {
        status: "verified",
        putAcceptedAt: sessionFile.putAcceptedAt || Date.now(),
        verifiedAt: Date.now(),
        nextCheckAt: null,
        lastError: null,
      }, sessionGeneration);
      sessionFile = store.getFile(session.id, entry.relativePath, sessionGeneration)!;
      finalFiles.push(transferFileRecord({ ...entry, sessionFile }, config, metadata, "verified"));
    } catch (error) {
      store.updateFile(session.id, entry.relativePath, {
        status: "failed",
        lastError: sanitizeUploadText((error as any)?.message || error),
        nextCheckAt: null,
      }, sessionGeneration);
      store.updateSession(session.id, { phase: "failed", lastError: sanitizeUploadText((error as any)?.message || error) }, sessionGeneration);
      throw await toUploadOperationError(error, entry.sessionFile.finalPath);
    }
  }

  const allVerified = finalFiles.length === preparedEntries.length && finalFiles.every((file) => file.verificationStatus === "verified");
  const phase: TransferSessionPhase = allVerified
    ? "completed"
    : "awaiting_remote";
  store.updateSession(session.id, { phase, completedAt: allVerified ? Date.now() : null, lastError: allVerified ? null : "等待远端确认" }, sessionGeneration);
  if (allVerified && options.cleanupLocal !== false) await fs.promises.rm(localDir, { recursive: true, force: true });
  return {
    remotePath,
    files: finalFiles,
    allVerified,
    sessionId: session.id,
    sessionGeneration,
    phase,
    pendingChecks,
    disposition: groupDecision.kind === "resume_current_session" ? "resumed_current_session" : "uploaded",
  };
}

export async function uploadWithAList(localDir: string, remotePath: string, config: AppConfig, options: UploadOptions = {}) {
  if (!options.transferSessionStore) return uploadWithAListDirect(localDir, remotePath, config, options);
  return uploadWithTransferSession(localDir, remotePath, config, options);
}

export async function resumeUploadSession(
  config: AppConfig,
  transferSessionStore: TransferSessionStore,
  sessionId: string,
  options: Omit<UploadOptions, "transferSessionStore" | "sessionId"> = {},
) {
  const session = transferSessionStore.get(sessionId);
  if (!session) throw new Error("Upload session does not exist");
  return uploadWithTransferSession(session.localDir, session.remotePath, config, {
    ...options,
    transferSessionStore,
    sessionId,
    sessionGeneration: options.sessionGeneration,
    bvid: session.bvid,
    userId: session.userId,
    mediaId: session.mediaId,
    historyOnly: session.historyOnly,
    historySnapshotAt: session.historySnapshotAt,
    allowReupload: options.allowReupload === true,
    resumeOnly: options.resumeOnly !== false,
    files: options.files || transferSessionStore.listFiles(sessionId, session.generation).map((file) => file.relativePath),
  });
}

export async function verifyRemoteFiles(
  config: AppConfig,
  files: RemoteFileRecord[]
): Promise<{ ok: boolean; missing: string[] }> {
  if (files.length === 0) {
    return { ok: false, missing: ["<no uploaded files recorded>"] };
  }
  const client = buildDavClient(config);
  const resolver = createRemoteFileResolver(client);
  const missing: string[] = [];
  for (const file of files) {
    try {
      const observed = await resolver.inspect(file.path, { fallback: "always" });
      if (observed.status !== "exists"
        || observed.directory
        || (typeof file.size === "number" && (!Number.isFinite(observed.size) || observed.size !== file.size))) {
        missing.push(file.path);
      }
    } catch (error) {
      if (error instanceof RemoteFileResolutionConflictError) throw error;
      missing.push(file.path);
    }
  }
  return { ok: missing.length === 0, missing };
}

export async function inspectRemoteFileSize(
  config: AppConfig,
  remotePath: string,
  expectedSize: number
): Promise<{ status: "verified" | "missing" | "mismatch"; remoteSize?: number }> {
  const client = buildDavClient(config);
  const resolver = createRemoteFileResolver(client);
  const observed = await resolver.inspect(remotePath, { fallback: "always" });
  if (observed.status === "missing") return { status: "missing" };
  if (!observed.directory && Number.isFinite(observed.size) && observed.size === expectedSize) {
    return { status: "verified", remoteSize: observed.size };
  }
  return { status: "mismatch", remoteSize: Number.isFinite(observed.size) ? observed.size : undefined };
}

/** Batch rename files on remote storage via WebDAV MOVE */
export interface RemoteListedFile {
  name: string;
  path: string;
  dir: string;
  size?: number;
}

export interface RenameRemoteItem {
  bvid?: string;
  oldPath: string;
  newPath: string;
}

/** List remote directory contents */
export async function listRemoteDir(config: AppConfig, remotePath: string): Promise<string[]> {
  const client = buildDavClient(config);
  const items = await client.getDirectoryContents(remotePath) as any[];
  return items
    .filter((item: any) => item && item.type !== "directory")
    .map((item: any) => item?.basename)
    .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
}

export async function listRemoteFilesRecursive(
  config: AppConfig,
  rootPath: string,
  options: { maxDepth?: number; maxFiles?: number } = {},
  clientOverride?: Pick<WebDAVClient, "getDirectoryContents">
): Promise<{ files: RemoteListedFile[]; skipped: Array<{ path: string; reason: string }>; complete: boolean }> {
  const client = clientOverride || buildDavClient(config);
  const root = normalizeRemotePath(rootPath, { allowTrailingSlash: true });
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 4));
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 2000));
  const files: RemoteListedFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let complete = true;
  const videoExt = /\.(mp4|mkv|flv|mov|m4v)$/i;
  const tempExt = /\.(part|tmp|download)$/i;

  async function walk(dir: string, depth: number) {
    if (files.length >= maxFiles) {
      complete = false;
      return;
    }
    let items: any[];
    try {
      items = await client.getDirectoryContents(dir) as any[];
    } catch (error: any) {
      complete = false;
      skipped.push({ path: dir, reason: `远端目录读取失败：${error?.message || error}` });
      return;
    }
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      let normalized;
      try {
        normalized = normalizeRemoteDirectoryEntry(dir, item);
      } catch (error) {
        complete = false;
        skipped.push({ path: dir, reason: `远端条目解析失败：${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (files.length >= maxFiles) {
        complete = false;
        skipped.push({ path: dir, reason: `扫描数量超过上限 ${maxFiles}` });
        return;
      }
      const itemPath = normalized.path;
      const name = normalized.name;
      if (!name) continue;
      if (normalized.type === "directory") {
        if (depth >= maxDepth) {
          complete = false;
          skipped.push({ path: itemPath, reason: `超过最大扫描深度 ${maxDepth}` });
          continue;
        }
        await walk(itemPath, depth + 1);
        continue;
      }
      if (!videoExt.test(name)) {
        skipped.push({ path: itemPath, reason: "不是支持的视频文件" });
        continue;
      }
      if (tempExt.test(name)) {
        skipped.push({ path: itemPath, reason: "临时下载文件" });
        continue;
      }
      files.push({
        name,
        path: itemPath,
        dir: remoteDirname(itemPath),
        size: normalized.size,
      });
    }
  }

  await walk(root, 0);
  return { files, skipped, complete };
}

export async function batchRenameRemotePaths(
  config: AppConfig,
  items: RenameRemoteItem[],
  clientOverride?: WebDAVClient
): Promise<{
  success: number;
  failed: number;
  results: Array<{
    oldPath: string;
    newPath: string;
    ok: boolean;
    status: "renamed" | "rolled_back" | "stranded" | "conflict" | "missing";
    actualPath?: string;
    observedPaths: string[];
    error?: string;
  }>;
}> {
  const client = clientOverride || buildDavClient(config);
  const operationId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos", { allowTrailingSlash: true });
  const prepared = items.map((item, index) => {
    const oldPath = normalizeRemotePath(item.oldPath);
    const newPath = normalizeRemotePath(item.newPath);
    return {
      oldPath,
      newPath,
      tempPath: `${remoteDirname(oldPath)}/__bfb_rename_${operationId}_${index}_${remoteBasename(oldPath)}`,
      oldSize: undefined as number | undefined,
    };
  });

  const pathExists = async (target: string) => {
    if (typeof (client as any).exists === "function") return Boolean(await (client as any).exists(target));
    if (typeof (client as any).stat === "function") {
      try {
        await (client as any).stat(target);
        return true;
      } catch (error) {
        if (isRemoteNotFoundError(error)) return false;
        throw error;
      }
    }
    throw new Error("WebDAV client does not support remote existence checks");
  };
  const observe = async (item: typeof prepared[number]) => {
    let observedPaths: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      observedPaths = [];
      for (const target of [item.oldPath, item.tempPath, item.newPath]) {
        if (await pathExists(target)) observedPaths.push(target);
      }
      if (observedPaths.length > 0 || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    const actualPath = observedPaths.length === 1 ? observedPaths[0] : undefined;
    const status = observedPaths.length > 1
      ? "conflict"
      : (actualPath === item.newPath
        ? "renamed"
        : (actualPath === item.oldPath ? "rolled_back" : (actualPath === item.tempPath ? "stranded" : "missing")));
    return { status, actualPath, observedPaths } as const;
  };

  const sourcePaths = new Set(prepared.map((item) => item.oldPath));
  const preflight = new Map<typeof prepared[number], { status: "rolled_back" | "conflict" | "missing"; error: string }>();
  const duplicateTargets = new Set(prepared.filter((item, index) =>
    prepared.findIndex((other) => other.newPath === item.newPath) !== index
  ).map((item) => item.newPath));
  for (const item of prepared) {
    if (!isRemotePathWithin(root, item.oldPath)
      || !isRemotePathWithin(root, item.newPath)
      || remoteDirname(item.oldPath) !== remoteDirname(item.newPath)) {
      preflight.set(item, { status: "conflict", error: "重命名路径超出当前远端存储目标或跨目录" });
      continue;
    }
    if (duplicateTargets.has(item.newPath)) {
      preflight.set(item, { status: "conflict", error: "批次包含重复目标路径" });
      continue;
    }
    if (!await pathExists(item.oldPath)) {
      preflight.set(item, { status: "missing", error: "源文件不存在" });
      continue;
    }
    if (typeof (client as any).stat === "function") {
      const stat = await (client as any).stat(item.oldPath);
      const size = Number(stat?.size);
      if (!Number.isFinite(size)) {
        preflight.set(item, { status: "conflict", error: "无法确认源文件大小" });
        continue;
      }
      item.oldSize = size;
    }
    if (!sourcePaths.has(item.newPath) && await pathExists(item.newPath)) {
      preflight.set(item, { status: "conflict", error: "目标文件已存在" });
      continue;
    }
    if (await pathExists(item.tempPath)) {
      preflight.set(item, { status: "conflict", error: "临时重命名路径已存在" });
    }
  }
  if (preflight.size > 0) {
    const results = [];
    for (const item of prepared) {
      const issue = preflight.get(item);
      const observed = await observe(item);
      results.push({
        oldPath: item.oldPath,
        newPath: item.newPath,
        ok: false,
        status: issue?.status || "rolled_back",
        actualPath: observed.actualPath,
        observedPaths: observed.observedPaths,
        error: issue?.error || "批次预检查失败，未执行重命名",
      });
    }
    return { success: 0, failed: results.length, results };
  }

  const replacementRunner: RemoteReplacementRunner = clientOverride
    && (typeof (clientOverride as any).copyFile !== "function"
      || typeof (clientOverride as any).putFileContents !== "function"
      || typeof (clientOverride as any).deleteFile !== "function"
      || typeof (clientOverride as any).stat !== "function")
    ? async (_config, oldPath, newPath) => {
      await client.moveFile(oldPath, newPath, { overwrite: false });
    }
    : await createRemoteReplacementRunner(config, {
      client: asRemoteOperationsClient(client),
    });

  const staged: typeof prepared = [];
  const completed: typeof prepared = [];
  let operationError = "";
  try {
    for (const item of prepared) {
      await replacementRunner(config, item.oldPath, item.tempPath, item.oldSize);
      staged.push(item);
    }
    for (const item of prepared) {
      await replacementRunner(config, item.tempPath, item.newPath, item.oldSize);
      completed.push(item);
    }
  } catch (error: any) {
    operationError = sanitizeUploadText(error?.message || error);
    for (const item of [...completed].reverse()) {
      await replacementRunner(config, item.newPath, item.oldPath, item.oldSize).catch(() => undefined);
    }
    for (const item of [...staged].reverse()) {
      if (completed.includes(item)) continue;
        await replacementRunner(config, item.tempPath, item.oldPath, item.oldSize).catch(() => undefined);
    }
  }

  const results = [];
  for (const item of prepared) {
    const observed = await observe(item);
    const completedNormally = !operationError && observed.observedPaths.includes(item.newPath);
    const resolvedObservation = completedNormally
      ? { status: "renamed" as const, actualPath: item.newPath, observedPaths: observed.observedPaths }
      : observed;
    const ok = resolvedObservation.status === "renamed";
    const error = ok ? undefined : (operationError || (
      resolvedObservation.status === "rolled_back" ? "重命名失败，已恢复原路径"
        : resolvedObservation.status === "stranded" ? "重命名失败，文件停留在临时路径"
          : resolvedObservation.status === "conflict" ? "远端同时存在多个候选路径"
            : "远端未找到旧路径、临时路径或新路径"
    ));
    results.push({
      oldPath: item.oldPath,
      newPath: item.newPath,
      ok,
      ...resolvedObservation,
      error,
    });
    if (!ok) continue;
    logManager.push({
      timestamp: new Date().toISOString(),
      type: "system",
      level: "info",
      summary: `重命名: ${remoteBasename(item.oldPath)} → ${remoteBasename(item.newPath)}`,
      raw: `[Rename] ${item.oldPath} -> ${item.newPath}`,
      simpleVisible: true,
    });
  }
  return {
    success: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

export async function remotePathExists(config: AppConfig, remotePath: string) {
  const client = buildDavClient(config);
  return client.exists(normalizeRemotePath(remotePath));
}

export async function moveRemoteFile(config: AppConfig, oldPath: string, newPath: string) {
  const client = buildDavClient(config);
  const targetPath = normalizeRemotePath(newPath);
  await ensureRemoteDir(client, remoteDirname(targetPath));
  await client.moveFile(normalizeRemotePath(oldPath), targetPath, { overwrite: false });
}

export function isRemoteNotFoundError(error: any) {
  return isResolvedRemoteNotFoundError(error);
}

export async function deleteRemoteFiles(
  config: AppConfig,
  files: RemoteFileRecord[]
): Promise<{ success: number; failed: number; results: Array<{ path: string; ok: boolean; error?: string; status?: number; code?: string }> }> {
  const client = buildDavClient(config);
  let success = 0;
  let failed = 0;
  const results: Array<{ path: string; ok: boolean; error?: string; status?: number; code?: string }> = [];

  for (const file of files) {
    const targetPath = normalizeRemotePath(file.path);
    try {
      await client.deleteFile(targetPath);
      success++;
      results.push({ path: targetPath, ok: true });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "info",
        summary: `删除旧远端文件: ${remoteBasename(targetPath)}`,
        raw: `[Delete] ${targetPath}`,
        simpleVisible: true,
      });
    } catch (error: any) {
      if (isRemoteNotFoundError(error)) {
        success++;
        results.push({ path: targetPath, ok: true });
        continue;
      }
      failed++;
      const message = sanitizeUploadText(error?.message || error);
      const status = Number(error?.status || error?.response?.status || error?.statusCode || 0) || undefined;
      const code = String(error?.code || error?.cause?.code || "") || undefined;
      results.push({ path: targetPath, ok: false, error: message, status, code });
      logManager.push({
        timestamp: new Date().toISOString(),
        type: "system",
        level: "error",
        summary: `删除旧远端文件失败: ${remoteBasename(targetPath)} - ${message}`,
        raw: `[Delete] Failed: ${targetPath}: ${message}`,
        simpleVisible: true,
      });
    }
  }

  return { success, failed, results };
}
