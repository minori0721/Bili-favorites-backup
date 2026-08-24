import type { WebDAVClient } from "webdav";
import type { AppConfig } from "./config.js";
import { classifyRemoteFailure } from "./remote-file-resolver.js";
import { buildDavClient } from "./remote-storage.js";

export type StorageDiagnosticCategory =
  | "ok"
  | "network"
  | "auth"
  | "permission"
  | "path"
  | "unsupported"
  | "unknown";

export interface StorageDiagnosticResult {
  ok: boolean;
  category: StorageDiagnosticCategory;
  title: string;
  message: string;
  field?: "alistUrl" | "alistUsername" | "alistPassword" | "alistDest";
  readOnly: true;
  writeVerified: false;
  checkedAt: number;
  status?: number;
}

type StorageDiagnosticClient = Pick<WebDAVClient, "stat">;
const DEFAULT_STORAGE_DIAGNOSTIC_TIMEOUT_MS = 15_000;

async function statWithTimeout(client: StorageDiagnosticClient, remotePath: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    return await client.stat(remotePath, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const timeoutError: any = new Error("WebDAV read-only check timed out");
    timeoutError.code = "ETIMEDOUT";
    throw timeoutError;
  } finally {
    clearTimeout(timer);
  }
}

function failed(
  category: Exclude<StorageDiagnosticCategory, "ok">,
  title: string,
  message: string,
  field: StorageDiagnosticResult["field"],
  status?: number,
): StorageDiagnosticResult {
  return { ok: false, category, title, message, field, readOnly: true, writeVerified: false, checkedAt: Date.now(), status };
}

function classifiedFailure(error: unknown): StorageDiagnosticResult {
  const failure = classifyRemoteFailure(error);
  if (failure.status === 401) {
    return failed("auth", "存储认证失败", "WebDAV 拒绝了登录信息，请检查用户名和密码。", "alistPassword", failure.status);
  }
  if (failure.status === 403 || failure.category === "permission") {
    return failed("permission", "存储权限不足", "账号可以连接服务，但没有读取归档目录的权限。", "alistUsername", failure.status);
  }
  if (failure.category === "transient") {
    return failed("network", "暂时无法连接存储", "网络、反向代理或存储服务暂时不可达，请稍后重试。", "alistUrl", failure.status);
  }
  if (failure.category === "unsupported") {
    return failed("unsupported", "端点不支持只读目录检查", "该地址没有提供 BFB 所需的 WebDAV PROPFIND/stat 能力，请检查是否填写了正确的 WebDAV 端点。", "alistUrl", failure.status);
  }
  return failed("unknown", "存储返回未知结果", "服务已响应，但结果不足以安全判断配置是否可用；没有执行写入测试。", "alistUrl", failure.status);
}

export async function checkRemoteStorageReadOnly(
  config: AppConfig,
  client: StorageDiagnosticClient = buildDavClient(config),
  timeoutMs = DEFAULT_STORAGE_DIAGNOSTIC_TIMEOUT_MS,
): Promise<StorageDiagnosticResult> {
  const destination = String(config.alistDest || "/").trim() || "/";
  try {
    const stat = await statWithTimeout(client, destination, timeoutMs) as any;
    if (String(stat?.type || "").toLowerCase() === "file") {
      return failed("path", "归档路径不是目录", "当前归档路径指向了文件，请填写一个远端目录。", "alistDest");
    }
    return {
      ok: true,
      category: "ok",
      title: "只读连接检查通过",
      message: "WebDAV 地址、认证和归档目录均可读取。此检查没有上传文件，也不代表写入能力已验证。",
      readOnly: true,
      writeVerified: false,
      checkedAt: Date.now(),
    };
  } catch (error) {
    const destinationFailure = classifyRemoteFailure(error);
    if (destinationFailure.category !== "not_found" || destination === "/") {
      return classifiedFailure(error);
    }
    try {
      await statWithTimeout(client, "/", timeoutMs);
      return failed("path", "归档目录不存在", "WebDAV 服务和认证可用，但当前归档目录不存在或路径填写有误。", "alistDest", destinationFailure.status);
    } catch (rootError) {
      const rootFailure = classifyRemoteFailure(rootError);
      if (rootFailure.category === "not_found") {
        return failed("path", "WebDAV 根路径不可见", "服务已响应，但当前端点下无法读取 WebDAV 根路径；请检查地址中的基础路径。", "alistUrl", rootFailure.status);
      }
      return classifiedFailure(rootError);
    }
  }
}
