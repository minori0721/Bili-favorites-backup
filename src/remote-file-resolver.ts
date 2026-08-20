import { joinRemotePath, normalizeRemotePath, remoteBasename } from "./remote-path.js";

export interface RemoteDirectoryClient {
  stat(path: string): Promise<any>;
  getDirectoryContents?(path: string, options?: Record<string, unknown>): Promise<any>;
}

export interface NormalizedRemoteDirectoryEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
}

export type RemoteLookupFallback = "never" | "risk_only" | "always";

export type RemoteFailureCategory = "transient" | "permission" | "unsupported" | "not_found" | "conflict" | "unknown";

export interface RemoteFailureInfo {
  category: RemoteFailureCategory;
  status?: number;
  code?: string;
}

export interface RemoteFileObservation {
  status: "exists" | "missing";
  path: string;
  size?: number;
  directory: boolean;
  source: "stat" | "directory";
  name?: string;
}

export class RemoteFileResolutionConflictError extends Error {
  readonly status = 409;
  readonly code = "REMOTE_FILE_MATCH_AMBIGUOUS";

  constructor(message = "远端目录中存在多个无法唯一确认的同名文件") {
    super(message);
    this.name = "RemoteFileResolutionConflictError";
  }
}

function statusCode(error: any) {
  return Number(error?.statusCode || error?.response?.status || error?.status || 0) || undefined;
}

export function classifyRemoteFailure(error: any): RemoteFailureInfo {
  const status = statusCode(error);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase() || undefined;
  const message = String(error?.message || error || "");
  const networkLike = Boolean(code && new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH",
  ]).has(code)) || /timeout|timed out|socket hang up|network|temporarily unavailable|connection reset|connection refused/i.test(message);

  if (status === 401 || status === 403) return { category: "permission", status, code };
  if (status === 405 || status === 501 || /method not allowed|not implemented/i.test(message)) {
    return { category: "unsupported", status, code };
  }
  if (status === 409 || status === 412 || /conflict|precondition/i.test(message)) {
    return { category: "conflict", status, code };
  }
  if (status === 404 || /not found|enoent|no such file/i.test(message)) {
    return { category: "not_found", status, code };
  }
  if (networkLike || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return { category: "transient", status, code };
  }
  return { category: "unknown", status, code };
}

export function isRemoteNotFoundError(error: any) {
  const status = statusCode(error);
  const message = String(error?.message || error || "").toLowerCase();
  return status === 404 || message.includes("not found") || message.includes("enoent");
}

function isPathLookupFailure(error: any) {
  const status = statusCode(error);
  return status === 400 || status === 404 || status === 405;
}

function decodePercentOnce(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeXmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = String(entity).toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return named[lower] ?? whole;
  });
}

function removeOpenListEscapes(value: string) {
  // OpenList has returned escaped punctuation in href-derived names. Keep this
  // as a comparison candidate only; never rewrite the stored remote path.
  return value
    .replace(/\\(?=['"’‘])/g, "")
    .replace(/\\(?=%[0-9a-f]{2})/gi, "");
}

function textCandidates(value: string) {
  const output = new Set<string>();
  const queue = [String(value || "")];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (output.has(current)) continue;
    output.add(current);
    const xmlDecoded = decodeXmlEntities(current);
    const percentDecoded = decodePercentOnce(current);
    const escapedRemoved = removeOpenListEscapes(current);
    for (const next of [xmlDecoded, percentDecoded, escapedRemoved]) {
      if (next !== current && !output.has(next)) queue.push(next);
    }
  }
  return [...output].flatMap((candidate) => {
    const normalized = candidate.normalize("NFC");
    return normalized === candidate ? [candidate] : [candidate, normalized];
  });
}

export function remoteNameMatches(expected: string, observed: string) {
  const expectedCandidates = new Set(textCandidates(expected));
  return textCandidates(observed).some((candidate) => expectedCandidates.has(candidate));
}

export function isLikelyEncodedFilename(value: string) {
  const name = String(value || "");
  return /[\\'"%#?&<>\[\]]/.test(name) || name.normalize("NFC") !== name;
}

export function normalizeRemoteLookupPath(value: string) {
  const raw = String(value || "");
  if (!raw) return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/g, "") || "/";
}

export function remoteLookupBasename(value: string) {
  const normalized = normalizeRemoteLookupPath(value);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function remoteLookupDirname(value: string) {
  const normalized = normalizeRemoteLookupPath(value);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function joinRemoteLookupPath(parent: string, child: string) {
  const root = normalizeRemoteLookupPath(parent);
  const name = String(child || "").replace(/^\/+/, "");
  return name ? `${root.replace(/\/$/g, "")}/${name}` : root;
}

function normalizeListedPath(value: string) {
  const raw = String(value || "");
  if (!raw.startsWith("/")) throw new Error("远端条目路径必须是绝对路径");
  const withoutTrailingSlash = raw.replace(/\/+$/g, "") || "/";
  if (withoutTrailingSlash === "/") return "/";
  const parts = withoutTrailingSlash.split("/").slice(1);
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("远端条目包含非法路径片段");
  }
  for (const part of parts) {
    const unsafeBackslash = part.replace(/\\(?=['"’‘]|%[0-9a-f]{2})/gi, "").includes("\\");
    if (unsafeBackslash) throw new Error("远端条目包含非法字符");
  }
  return `/${parts.join("/")}`;
}

function decodeHrefPath(value: string) {
  const raw = String(value || "");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.search || url.hash) throw new Error("远端条目URL不能包含查询串或片段");
    return decodeURIComponent(url.pathname);
  }
  if (raw.includes("?") || raw.includes("#")) throw new Error("远端条目路径不能包含查询串或片段");
  return raw;
}

function rawEntryPath(entry: any) {
  return String(entry?.filename || entry?.path || entry?.href || "");
}

function entryResourceType(entry: any) {
  return entry?.resourcetype ?? entry?.props?.resourcetype ?? entry?.props?.resourceType;
}

function entryIsDirectory(entry: any) {
  const resourceType = entryResourceType(entry);
  const collection = typeof resourceType === "string"
    ? /collection/i.test(resourceType)
    : Boolean(resourceType && typeof resourceType === "object" && (
      Object.prototype.hasOwnProperty.call(resourceType, "collection")
      || Object.prototype.hasOwnProperty.call(resourceType, "d:collection")
    ));
  return entry?.type === "directory"
    || entry?.isDirectory === true
    || entry?.isDirectory === "true"
    || entry?.is_dir === true
    || collection;
}

function entrySize(entry: any) {
  const value = Number(entry?.size);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeRemoteDirectoryEntry(parent: string, entry: any): NormalizedRemoteDirectoryEntry {
  const raw = rawEntryPath(entry);
  const fallbackName = String(entry?.basename || entry?.name || "");
  if (!raw && !fallbackName) throw new Error("远端条目缺少路径和名称");
  const decoded = decodeHrefPath(raw || fallbackName);
  // OpenList may escape punctuation in a filename as `\'` or `\%XX`.
  // Keep that spelling in the canonical remote path, but reject every other
  // backslash because it can otherwise become an alternate path separator.
  const unsafeBackslash = decoded
    .replace(/\\(?=['"’‘]|%[0-9a-f]{2})/gi, "")
    .includes("\\");
  if (unsafeBackslash || decoded.includes("\0")) throw new Error("远端条目包含非法字符");
  const path = decoded.startsWith("/")
    ? normalizeListedPath(decoded)
    : normalizeListedPath(joinRemoteLookupPath(normalizeRemotePath(parent, { allowTrailingSlash: true }), decoded));
  const name = fallbackName || remoteLookupBasename(path);
  const unsafeNameBackslash = name
    .replace(/\\(?=['"’‘]|%[0-9a-f]{2})/gi, "")
    .includes("\\");
  if (!name || name === "." || name === ".." || name.includes("/") || unsafeNameBackslash) {
    throw new Error("远端条目名称无效");
  }
  return {
    path,
    name,
    type: entryIsDirectory(entry) ? "directory" : "file",
    size: entrySize(entry),
  };
}

function entryPath(parent: string, entry: any) {
  return normalizeRemoteDirectoryEntry(parent, entry).path;
}

function entryName(parent: string, entry: any) {
  return normalizeRemoteDirectoryEntry(parent, entry).name;
}

function isDirectChild(parent: string, child: string) {
  return remoteLookupDirname(child) === normalizeRemoteLookupPath(parent);
}

export class RemoteFileResolver {
  private readonly directoryCache = new Map<string, Promise<any[]>>();

  constructor(private readonly client: RemoteDirectoryClient) {}

  clear() {
    this.directoryCache.clear();
  }

  private listDirectory(parent: string) {
    const key = normalizeRemoteLookupPath(parent);
    const existing = this.directoryCache.get(key);
    if (existing) return existing;
    if (typeof this.client.getDirectoryContents !== "function") {
      return Promise.resolve([] as any[]);
    }
    const pending = Promise.resolve(this.client.getDirectoryContents(key)).then((result) => {
      if (!Array.isArray(result)) throw new Error("远端目录响应格式无效");
      return result;
    }).catch((error) => {
      this.directoryCache.delete(key);
      throw error;
    });
    this.directoryCache.set(key, pending);
    return pending;
  }

  async inspect(
    remotePath: string,
    options: { fallback?: RemoteLookupFallback } = {},
  ): Promise<RemoteFileObservation> {
    const expectedPath = normalizeRemoteLookupPath(remotePath);
    try {
      const stat = await this.client.stat(expectedPath);
      const size = entrySize(stat);
      return {
        status: "exists",
        path: expectedPath,
        size,
        directory: entryIsDirectory(stat),
        source: "stat",
        name: remoteLookupBasename(expectedPath),
      };
    } catch (error) {
      if (!isPathLookupFailure(error)) throw error;
      const fallback = options.fallback || "never";
      const expectedName = remoteLookupBasename(expectedPath);
      if (fallback === "never" || (fallback === "risk_only" && !isLikelyEncodedFilename(expectedName))) {
        return { status: "missing", path: expectedPath, directory: false, source: "stat", name: expectedName };
      }

      let entries: any[];
      try {
        entries = await this.listDirectory(remoteLookupDirname(expectedPath));
      } catch (listError) {
        if (isRemoteNotFoundError(listError)) {
          return { status: "missing", path: expectedPath, directory: false, source: "directory", name: expectedName };
        }
        throw listError;
      }

      const matches = entries
        .filter((entry) => {
          const parent = remoteLookupDirname(expectedPath);
          const candidatePath = entryPath(parent, entry);
          return isDirectChild(parent, candidatePath)
            && remoteNameMatches(expectedName, entryName(parent, entry));
        })
        .map((entry) => ({
          path: entryPath(remoteLookupDirname(expectedPath), entry),
          name: entryName(remoteLookupDirname(expectedPath), entry),
          size: entrySize(entry),
          directory: entryIsDirectory(entry),
        }));
      if (matches.length > 1) {
        throw new RemoteFileResolutionConflictError("远端目录中存在多个无法唯一确认的同名文件");
      }
      const match = matches[0];
      if (!match) {
        return { status: "missing", path: expectedPath, directory: false, source: "directory", name: expectedName };
      }
      return { status: "exists", ...match, source: "directory" };
    }
  }
}

export function createRemoteFileResolver(client: RemoteDirectoryClient) {
  return new RemoteFileResolver(client);
}
