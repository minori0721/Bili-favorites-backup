import crypto from "node:crypto";
import type { WebDAVClient } from "webdav";
import type { AppConfig } from "./config.js";
import { joinRemotePath, normalizeRemotePath, remoteDirname } from "./remote-path.js";
import { isRemoteNotFoundError as isResolvedRemoteNotFoundError } from "./remote-file-resolver.js";

export type RemoteCapability = "supported" | "unsupported" | "unknown";

export interface RemoteOperationCapabilities {
  copy: RemoteCapability;
  move: RemoteCapability;
}

export interface RemoteOperationsClient {
  createDirectory(path: string): Promise<any>;
  putFileContents(path: string, data: string | Buffer, options?: Record<string, unknown>): Promise<any>;
  copyFile(source: string, destination: string, options?: Record<string, unknown>): Promise<any>;
  moveFile(source: string, destination: string, options?: Record<string, unknown>): Promise<any>;
  stat(path: string): Promise<any>;
  deleteFile(path: string): Promise<any>;
  exists?(path: string): Promise<boolean>;
}

export interface RemoteReplacementAttempt {
  targetPreviouslyVerified?: boolean;
  onTargetVerified?: () => void | Promise<void>;
}

export type RemoteReplacementRunner = (
  config: AppConfig,
  oldPath: string,
  newPath: string,
  expectedSize?: number,
  attempt?: RemoteReplacementAttempt,
) => Promise<void>;

export class RemoteReplacementError extends Error {
  readonly code: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetReady: boolean;
  readonly sourceStillPresent: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      code?: string;
      sourcePath: string;
      targetPath: string;
      targetReady?: boolean;
      sourceStillPresent?: boolean;
      status?: number;
    }
  ) {
    super(message);
    this.name = "RemoteReplacementError";
    this.code = options.code || "REMOTE_REPLACEMENT_FAILED";
    this.sourcePath = options.sourcePath;
    this.targetPath = options.targetPath;
    this.targetReady = Boolean(options.targetReady);
    this.sourceStillPresent = Boolean(options.sourceStillPresent);
    this.status = options.status;
  }
}

function statusCode(error: any) {
  return Number(error?.statusCode || error?.response?.status || error?.status || 0) || undefined;
}

function isRemoteNotFound(error: any) {
  return isResolvedRemoteNotFoundError(error);
}

function isUnsupportedMethod(error: any) {
  const status = statusCode(error);
  if ([405, 501].includes(status || 0)) return true;
  if (status) return false;
  return /method not allowed|not supported|unsupported/i.test(String(error?.message || error || ""));
}

function isDirectory(stat: any) {
  return stat?.type === "directory" || stat?.isDirectory === true || stat?.resourcetype === "collection";
}

async function readRemote(client: RemoteOperationsClient, target: string) {
  try {
    const stat = await client.stat(target);
    return {
      exists: true,
      directory: isDirectory(stat),
      size: Number.isFinite(Number(stat?.size)) ? Number(stat.size) : undefined,
    };
  } catch (error) {
    if (isRemoteNotFound(error)) return { exists: false, directory: false, size: undefined };
    throw error;
  }
}

async function ensureRemoteDirectory(client: RemoteOperationsClient, remotePath: string) {
  const segments = normalizeRemotePath(remotePath, { allowTrailingSlash: true }).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    if (typeof client.exists === "function" && await client.exists(current)) {
      const observed = await readRemote(client, current);
      if (!observed.directory) throw new Error("远端目标父路径不是目录");
      continue;
    }
    const existing = await readRemote(client, current);
    if (existing.exists) {
      if (!existing.directory) throw new Error("远端目标父路径不是目录");
      continue;
    }
    try {
      await client.createDirectory(current);
    } catch (error) {
      const after = await readRemote(client, current);
      if (!after.exists || !after.directory) throw error;
    }
  }
}

async function putProbeFile(client: RemoteOperationsClient, target: string, body: Buffer) {
  try {
    await client.putFileContents(target, body, {
      overwrite: false,
      contentLength: body.length,
      headers: {
        "Content-Length": String(body.length),
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    if (!isUnsupportedMethod(error)) throw error;
    const observed = await readRemote(client, target);
    if (!observed.exists || observed.directory || observed.size !== body.length) throw error;
  }
  const observed = await readRemote(client, target);
  if (!observed.exists || observed.directory || observed.size !== body.length) {
    throw new Error("远端能力探测临时文件未按预期落盘");
  }
}

async function cleanupProbePath(client: RemoteOperationsClient, target: string) {
  try {
    await client.deleteFile(target);
  } catch {
    // Probe cleanup is best effort. The probe root is random and never reused.
  }
}

async function classifyCopyProbe(client: RemoteOperationsClient, source: string, target: string, expectedSize: number): Promise<RemoteCapability> {
  try {
    await client.copyFile(source, target, { overwrite: false });
  } catch (error) {
    if (isUnsupportedMethod(error)) return "unsupported";
    const observed = await readRemote(client, target);
    if (observed.exists && !observed.directory && observed.size === expectedSize) return "supported";
    return "unknown";
  }
  const observed = await readRemote(client, target);
  return observed.exists && !observed.directory && observed.size === expectedSize ? "supported" : "unknown";
}

async function classifyMoveProbe(client: RemoteOperationsClient, source: string, target: string, expectedSize: number): Promise<RemoteCapability> {
  try {
    await client.moveFile(source, target, { overwrite: false });
  } catch (error) {
    if (isUnsupportedMethod(error)) return "unsupported";
    const sourceState = await readRemote(client, source);
    const targetState = await readRemote(client, target);
    if (!sourceState.exists && targetState.exists && !targetState.directory && targetState.size === expectedSize) return "supported";
    return "unknown";
  }
  const sourceState = await readRemote(client, source);
  const targetState = await readRemote(client, target);
  return !sourceState.exists && targetState.exists && !targetState.directory && targetState.size === expectedSize
    ? "supported"
    : "unknown";
}

/** Probe COPY and MOVE independently using random files under the configured archive root. */
export async function probeRemoteCapabilities(
  client: RemoteOperationsClient,
  rootValue: string
): Promise<RemoteOperationCapabilities> {
  const root = normalizeRemotePath(rootValue || "/", { allowTrailingSlash: true });
  const probeRoot = joinRemotePath(root, `._bfb-replace-probe-${crypto.randomUUID()}`);
  const body = Buffer.from("bfb-remote-replacement-probe\n", "utf8");
  const copySource = joinRemotePath(probeRoot, "copy-source.bin");
  const copyTarget = joinRemotePath(probeRoot, "copy-target.bin");
  const moveSource = joinRemotePath(probeRoot, "move-source.bin");
  const moveTarget = joinRemotePath(probeRoot, "move-target.bin");
  let copy: RemoteCapability = "unknown";
  let move: RemoteCapability = "unknown";
  try {
    await ensureRemoteDirectory(client, root);
    await client.createDirectory(probeRoot);
    await putProbeFile(client, copySource, body);
    copy = await classifyCopyProbe(client, copySource, copyTarget, body.length);
    await putProbeFile(client, moveSource, body);
    move = await classifyMoveProbe(client, moveSource, moveTarget, body.length);
    return { copy, move };
  } finally {
    for (const target of [copySource, copyTarget, moveSource, moveTarget, probeRoot]) {
      await cleanupProbePath(client, target);
    }
  }
}

async function inspectReplacementState(client: RemoteOperationsClient, source: string, target: string, expectedSize?: number) {
  const sourceState = await readRemote(client, source);
  const targetState = await readRemote(client, target);
  const targetMatches = targetState.exists
    && !targetState.directory
    && expectedSize !== undefined
    && targetState.size === expectedSize;
  return { sourceState, targetState, targetMatches };
}

async function removeVerifiedSource(
  client: RemoteOperationsClient,
  source: string,
  target: string,
  expectedSize: number,
) {
  try {
    await client.deleteFile(source);
  } catch (error) {
    const observed = await inspectReplacementState(client, source, target, expectedSize);
    if (observed.sourceState.exists) {
      throw replacementError(
        `已验证目标存在，但清理重复源文件失败: ${String((error as any)?.message || error)}`,
        source,
        target,
        observed,
        "REMOTE_VERIFIED_SOURCE_CLEANUP_FAILED",
        statusCode(error),
      );
    }
  }
  const observed = await inspectReplacementState(client, source, target, expectedSize);
  if (observed.sourceState.exists || !observed.targetMatches) {
    throw replacementError(
      "已验证目标存在，但源文件仍可见，未继续替换",
      source,
      target,
      observed,
      "REMOTE_VERIFIED_SOURCE_STILL_VISIBLE",
      409,
    );
  }
}

function replacementError(
  message: string,
  source: string,
  target: string,
  state: { sourceState: { exists: boolean }; targetMatches: boolean },
  code?: string,
  status?: number
) {
  return new RemoteReplacementError(message, {
    code,
    sourcePath: source,
    targetPath: target,
    targetReady: state.targetMatches,
    sourceStillPresent: state.sourceState.exists,
    status,
  });
}

async function replaceWithCapabilities(
  client: RemoteOperationsClient,
  capabilities: RemoteOperationCapabilities,
  oldPathValue: string,
  newPathValue: string,
  expectedSizeHint?: number,
  attempt: RemoteReplacementAttempt = {},
) {
  const source = normalizeRemotePath(oldPathValue);
  const target = normalizeRemotePath(newPathValue);
  if (source === target) return;
  await ensureRemoteDirectory(client, remoteDirname(target));

  const hintedSize = Number.isFinite(expectedSizeHint) ? expectedSizeHint : undefined;
  const initial = await inspectReplacementState(client, source, target, hintedSize);
  if (!initial.sourceState.exists) {
    if (attempt.targetPreviouslyVerified && initial.targetState.exists && !initial.targetState.directory && initial.targetMatches) return;
    throw replacementError("远端替换源文件不存在，且目标文件也未确认", source, target, initial, "REMOTE_SOURCE_MISSING", 404);
  }
  if (initial.sourceState.directory) {
    throw replacementError("远端替换只允许处理文件，拒绝使用目录作为源", source, target, initial, "REMOTE_SOURCE_DIRECTORY", 409);
  }
  const sourceSize = initial.sourceState.size;
  if (sourceSize === undefined) {
    throw replacementError("远端替换源文件大小无法确认，未执行替换", source, target, initial, "REMOTE_SOURCE_SIZE_UNKNOWN", 409);
  }
  if (hintedSize !== undefined && sourceSize !== hintedSize) {
    throw replacementError("远端替换源文件大小与已知证明不一致，未执行替换", source, target, initial, "REMOTE_SOURCE_SIZE_CONFLICT", 409);
  }
  const expectedSize = sourceSize;
  const state = await inspectReplacementState(client, source, target, expectedSize);
  if (state.targetState.exists) {
    if (state.targetState.directory || !state.targetMatches) {
      throw replacementError("远端替换目标已存在且大小或类型不一致", source, target, state, "REMOTE_TARGET_CONFLICT", 409);
    }
    if (!attempt.targetPreviouslyVerified) {
      throw replacementError("远端替换目标已存在，但缺少本次操作的持久验证证明", source, target, state, "REMOTE_TARGET_UNPROVEN", 409);
    }
    if (attempt.targetPreviouslyVerified && state.sourceState.exists) {
      await removeVerifiedSource(client, source, target, expectedSize);
      return;
    }
  }

  let moveCapability = capabilities.move;
  if (moveCapability !== "unsupported") {
    try {
      await client.moveFile(source, target, { overwrite: false });
    } catch (error) {
      const observed = await inspectReplacementState(client, source, target, expectedSize);
      if (!observed.sourceState.exists && observed.targetMatches) {
        await attempt.onTargetVerified?.();
        return;
      }
      if (moveCapability === "unknown" && isUnsupportedMethod(error)) {
        moveCapability = "unsupported";
      } else {
        throw replacementError(
          `远端MOVE替换失败: ${String((error as any)?.message || error)}`,
          source,
          target,
          observed,
          "REMOTE_MOVE_FAILED",
          statusCode(error),
        );
      }
    }
    if (moveCapability !== "unsupported") {
      const observed = await inspectReplacementState(client, source, target, expectedSize);
      if (!observed.sourceState.exists && observed.targetMatches) {
        await attempt.onTargetVerified?.();
        return;
      }
      throw replacementError(
        "远端MOVE返回后未能同时确认源消失和目标大小",
        source,
        target,
        observed,
        "REMOTE_MOVE_UNCONFIRMED",
      );
    }
  }

  if (capabilities.copy === "unsupported") {
    throw replacementError(
      "远端同时不支持安全MOVE和COPY",
      source,
      target,
      state,
      "REMOTE_REPLACEMENT_UNSUPPORTED",
      405
    );
  }

  const targetCreatedThisAttempt = !state.targetState.exists;
  if (targetCreatedThisAttempt) {
    try {
      await client.copyFile(source, target, { overwrite: false });
    } catch (error) {
      const observed = await inspectReplacementState(client, source, target, expectedSize);
      if (!observed.targetMatches) {
        throw replacementError(
          `远端COPY失败，未确认目标文件: ${String((error as any)?.message || error)}`,
          source,
          target,
          observed,
          "REMOTE_COPY_FAILED",
          statusCode(error)
        );
      }
      throw replacementError(
        "远端COPY响应未确认，但目标出现同大小文件；为避免误删，已保留源文件和目标文件",
        source,
        target,
        observed,
        "REMOTE_COPY_RESULT_UNCERTAIN",
        409
      );
    }
  }

  const copied = await inspectReplacementState(client, source, target, expectedSize);
  if (!copied.targetMatches) {
    throw replacementError("远端COPY后目标文件校验失败，保留源文件", source, target, copied, "REMOTE_COPY_UNCONFIRMED", 409);
  }
  if (targetCreatedThisAttempt) await attempt.onTargetVerified?.();
  if (!copied.sourceState.exists) return;

  try {
    await client.deleteFile(source);
  } catch (error) {
    const observed = await inspectReplacementState(client, source, target, expectedSize);
    if (!observed.sourceState.exists && observed.targetMatches) return;
    throw replacementError(
      `COPY已校验但删除源文件失败: ${String((error as any)?.message || error)}`,
      source,
      target,
      observed,
      "REMOTE_COPY_DELETE_PENDING",
      statusCode(error)
    );
  }
  const completed = await inspectReplacementState(client, source, target, expectedSize);
  if (completed.sourceState.exists) {
    throw replacementError("COPY+DELETE后源文件仍可见，未标记替换完成", source, target, completed, "REMOTE_SOURCE_STILL_VISIBLE");
  }
}

export async function createRemoteReplacementRunner(
  config: AppConfig,
  options: { client?: RemoteOperationsClient; capabilities?: RemoteOperationCapabilities } = {}
): Promise<RemoteReplacementRunner> {
  const client = options.client || (await import("./uploader.js")).buildDavClient(config) as unknown as RemoteOperationsClient;
  // Do not write probe files during startup or before a real replacement.
  // Unknown capabilities are resolved by the actual operation and its
  // postcondition checks.
  const capabilities = options.capabilities || { copy: "unknown" as const, move: "unknown" as const };
  return async (_config, oldPath, newPath, expectedSize, attempt) => replaceWithCapabilities(client, capabilities, oldPath, newPath, expectedSize, attempt);
}

export async function replaceRemoteFile(
  config: AppConfig,
  oldPath: string,
  newPath: string,
  options: { client?: RemoteOperationsClient; capabilities?: RemoteOperationCapabilities } = {}
) {
  const runner = await createRemoteReplacementRunner(config, options);
  await runner(config, oldPath, newPath);
}

export function moveOnlyRemoteReplacementRunner(client: Pick<RemoteOperationsClient, "moveFile">): RemoteReplacementRunner {
  return async (_config, oldPath, newPath) => {
    await client.moveFile(normalizeRemotePath(oldPath), normalizeRemotePath(newPath), { overwrite: false });
  };
}

export function remotePathForReplacement(value: string) {
  return normalizeRemotePath(value);
}

export function remotePathJoinForReplacement(root: string, child: string) {
  return joinRemotePath(root, child);
}

export function isRemoteReplacementNotFound(error: any) {
  return isRemoteNotFound(error);
}

export function asRemoteOperationsClient(client: WebDAVClient) {
  return client as unknown as RemoteOperationsClient;
}
