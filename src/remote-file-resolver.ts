import { joinRemotePath, normalizeRemotePath, remoteBasename } from "./remote-path.js";
import type { RemoteBackendProfile } from "./remote-storage.js";

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
  retryAfterMs?: number;
}

export interface RemoteFileObservation {
  status: "exists" | "missing" | "unknown";
  path: string;
  size?: number;
  directory: boolean;
  source: "stat" | "directory";
  name?: string;
  failure?: RemoteFailureInfo;
}

export class RemoteFileResolutionConflictError extends Error {
  readonly status = 409;
  readonly code = "REMOTE_FILE_MATCH_AMBIGUOUS";

  constructor(message = "远端目录中存在多个无法唯一确认的同名文件") {
    super(message);
    this.name = "RemoteFileResolutionConflictError";
  }
}

export function remoteStatusCode(error: any) {
  return Number(error?.statusCode || error?.response?.status || error?.status || 0) || undefined;
}

function retryAfterMs(error: any) {
  const headers = error?.response?.headers || error?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function failureInfo(category: RemoteFailureCategory, status: number | undefined, code: string | undefined, error: any): RemoteFailureInfo {
  const retry = retryAfterMs(error);
  return {
    category,
    status,
    code,
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
  };
}

export function classifyRemoteFailure(error: any): RemoteFailureInfo {
  const status = remoteStatusCode(error);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase() || undefined;
  const message = String(error?.message || error || "");
  const networkLike = Boolean(code && new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH",
  ]).has(code)) || /timeout|timed out|socket hang up|network|temporarily unavailable|connection reset|connection refused/i.test(message);

  // Once a transport exposes an HTTP status, that status is authoritative.
  // Do not let a provider's response body (for example, "not found" in a
  // 500 response) change the operation category.
  if (status === 401 || status === 403) return failureInfo("permission", status, code, error);
  if (status === 405 || status === 501) {
    return failureInfo("unsupported", status, code, error);
  }
  if (status === 409 || status === 412) {
    return failureInfo("conflict", status, code, error);
  }
  if (status === 404) {
    return failureInfo("not_found", status, code, error);
  }
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return failureInfo("transient", status, code, error);
  }
  if (status !== undefined) return failureInfo("unknown", status, code, error);

  if (networkLike) return failureInfo("transient", status, code, error);

  // Without an HTTP status only an explicit local missing-file code is safe
  // to interpret as absence. Text-only messages are deliberately unknown.
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failureInfo("not_found", status, code, error);
  }
  return failureInfo("unknown", status, code, error);
}

export function isRemoteNotFoundError(error: any) {
  return classifyRemoteFailure(error).category === "not_found";
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
  const raw = String(value || "");
  const output = new Set<string>([
    raw,
    decodeXmlEntities(raw),
    removeOpenListEscapes(raw),
  ]);
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
  let url: URL;
  try {
    url = new URL(raw, "http://bfb.invalid");
  } catch {
    throw new Error("远端条目URL格式无效");
  }
  if (url.search || url.hash) throw new Error("远端条目URL不能包含查询串或片段");
  const decodedPath = decodeURIComponent(url.pathname);
  // A relative href is uncommon but valid in WebDAV responses. Keep it
  // relative to the directory being listed instead of the synthetic URL root.
  return raw.startsWith("/") || /^https?:\/\//i.test(raw)
    ? decodedPath
    : decodedPath.replace(/^\/+/, "");
}

function entryField(entry: any, key: string) {
  const value = entry?.[key];
  return value === undefined || value === null || value === "" ? "" : String(value);
}

function entryNameHints(entry: any) {
  const hints: string[] = [];
  for (const key of ["basename", "name"] as const) {
    const value = entryField(entry, key);
    if (value) hints.push(value);
  }
  for (const key of ["filename", "path", "href"] as const) {
    const value = entryField(entry, key);
    if (!value) continue;
    const withoutQuery = key === "href" ? value.split(/[?#]/, 1)[0] : value;
    const lastSlash = Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf("\\"));
    const hint = withoutQuery.slice(lastSlash + 1);
    if (hint) hints.push(hint);
  }
  return hints;
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
  const value = Number(
    entry?.size
      ?? entry?.contentLength
      ?? entry?.getcontentlength
      ?? entry?.props?.getcontentlength
      ?? entry?.props?.["d:getcontentlength"]
      ?? entry?.props?.["{DAV:}getcontentlength"]
  );
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeRemoteDirectoryEntry(parent: string, entry: any): NormalizedRemoteDirectoryEntry {
  const structuredPaths = (["filename", "path"] as const)
    .map((key) => ({ key, value: entryField(entry, key) }))
    .filter((item) => item.value);
  const href = entryField(entry, "href");
  const structuredNames = (["basename", "name"] as const)
    .map((key) => ({ key, value: entryField(entry, key) }))
    .filter((item) => item.value);
  if (structuredPaths.length === 0 && !href && structuredNames.length === 0) {
    throw new Error("远端条目缺少路径和名称");
  }

  const fallbackName = structuredNames[0]?.value || "";
  if (structuredNames.some((item) => !remoteNameMatches(fallbackName, item.value))) {
    throw new Error("远端条目名称字段不一致");
  }

  const normalizePathValue = (raw: string, source: "structured" | "href") => {
    const decoded = source === "href" ? decodeHrefPath(raw) : raw;
    const unsafeBackslash = decoded
      .replace(/\\(?=['"’‘]|%[0-9a-f]{2})/gi, "")
      .includes("\\");
    if (unsafeBackslash || decoded.includes("\0")) throw new Error("远端条目包含非法字符");
    return decoded.startsWith("/")
      ? normalizeListedPath(decoded)
      : normalizeListedPath(joinRemoteLookupPath(normalizeRemotePath(parent, { allowTrailingSlash: true }), decoded));
  };

  const normalizedStructuredPaths = structuredPaths.map((item) => normalizePathValue(item.value, "structured"));
  const normalizedHrefPath = href ? normalizePathValue(href, "href") : undefined;
  const normalizedFallbackPath = normalizedStructuredPaths.length === 0 && !normalizedHrefPath && fallbackName
    ? normalizePathValue(fallbackName, "structured")
    : undefined;
  const allPaths = [
    ...normalizedStructuredPaths,
    ...(normalizedHrefPath ? [normalizedHrefPath] : []),
    ...(normalizedFallbackPath ? [normalizedFallbackPath] : []),
  ];
  const path = allPaths[0];
  if (!path) throw new Error("远端条目缺少可用路径");
  if (allPaths.some((candidate) => !remoteNameMatches(path, candidate))) {
    throw new Error("远端条目路径字段不一致");
  }

  const pathName = remoteLookupBasename(path);
  if (fallbackName && !remoteNameMatches(pathName, fallbackName)) {
    throw new Error("远端条目路径和名称不一致");
  }

  // OpenList may escape punctuation in a filename as `\'` or `\%XX`.
  // Keep that spelling in the canonical remote path, but reject every other
  // backslash because it can otherwise become an alternate path separator.
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

function entryMayMatchName(expectedName: string, entry: any) {
  return entryNameHints(entry).some((hint) => remoteNameMatches(expectedName, hint));
}

function isDirectChild(parent: string, child: string) {
  return remoteLookupDirname(child) === normalizeRemoteLookupPath(parent);
}

export class RemoteFileResolver {
  private readonly directoryCache = new Map<string, Promise<any[]>>();

  constructor(
    private readonly client: RemoteDirectoryClient,
    private readonly profile?: RemoteBackendProfile,
  ) {}

  clear() {
    this.directoryCache.clear();
  }

  invalidateDirectory(parent: string) {
    this.directoryCache.delete(normalizeRemoteLookupPath(parent));
  }

  invalidatePath(remotePath: string) {
    this.invalidateDirectory(remoteLookupDirname(remotePath));
  }

  private listDirectory(parent: string) {
    const key = normalizeRemoteLookupPath(parent);
    const existing = this.directoryCache.get(key);
    if (existing) return existing;
    if (this.profile?.capabilities.directoryList === "unsupported") {
      return Promise.reject(Object.assign(new Error("远端不支持目录列表"), { status: 405 }));
    }
    if (typeof this.client.getDirectoryContents !== "function") {
      return Promise.reject(Object.assign(new Error("远端不支持目录列表"), { status: 405 }));
    }
    const pending = Promise.resolve(this.client.getDirectoryContents(key)).then((result) => {
      if (!Array.isArray(result)) throw new Error("远端目录响应格式无效");
      if (this.profile) this.profile.capabilities.directoryList = "supported";
      return result;
    }).catch((error) => {
      this.directoryCache.delete(key);
      const status = remoteStatusCode(error);
      if (this.profile && (status === 405 || status === 501)) this.profile.capabilities.directoryList = "unsupported";
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
      const failure = classifyRemoteFailure(error);
      const fallback = options.fallback || "never";
      const expectedName = remoteLookupBasename(expectedPath);
      if (failure.category === "not_found") {
        // A literal 404 is enough for ordinary names. Encoded or escaped
        // names still get one parent-directory lookup because OpenList-style
        // backends may expose a different access spelling for the same file.
        if (fallback === "never" || (fallback === "risk_only" && !isLikelyEncodedFilename(expectedName))) {
          return { status: "missing", path: expectedPath, directory: false, source: "stat", name: expectedName };
        }
      }
      // A permission, transient, or explicit conflict response does not tell
      // us that the object is absent. A provider may expose a directory listing
      // while denying stat, but treating an empty listing as deletion here can
      // erase a valid proof during an outage or an ACL change.
      if (["permission", "transient", "conflict"].includes(failure.category)) {
        return { status: "unknown", path: expectedPath, directory: false, source: "stat", name: remoteLookupBasename(expectedPath), failure };
      }
      if (fallback === "never" || (fallback === "risk_only" && !isLikelyEncodedFilename(expectedName))) {
        return { status: "unknown", path: expectedPath, directory: false, source: "stat", name: expectedName, failure };
      }

      let entries: any[];
      try {
        entries = await this.listDirectory(remoteLookupDirname(expectedPath));
      } catch (listError) {
        const listFailure = classifyRemoteFailure(listError);
        if (listFailure.category === "not_found") {
          return { status: "missing", path: expectedPath, directory: false, source: "directory", name: expectedName };
        }
        return { status: "unknown", path: expectedPath, directory: false, source: "directory", name: expectedName, failure: listFailure };
      }

      const parent = remoteLookupDirname(expectedPath);
      const matches: NormalizedRemoteDirectoryEntry[] = [];
      for (const entry of entries) {
        let normalized: NormalizedRemoteDirectoryEntry;
        try {
          normalized = normalizeRemoteDirectoryEntry(parent, entry);
        } catch (entryError) {
          if (entryMayMatchName(expectedName, entry)) {
            throw new RemoteFileResolutionConflictError("远端目录中存在无法安全解析的同名条目");
          }
          continue;
        }
        if (isDirectChild(parent, normalized.path) && remoteNameMatches(expectedName, normalized.name)) {
          matches.push(normalized);
        }
      }
      if (matches.length > 1) {
        throw new RemoteFileResolutionConflictError("远端目录中存在多个无法唯一确认的同名文件");
      }
      const match = matches[0];
      if (!match) {
        return { status: "missing", path: expectedPath, directory: false, source: "directory", name: expectedName };
      }
      return {
        status: "exists",
        path: match.path,
        name: match.name,
        size: match.size,
        directory: match.type === "directory",
        source: "directory",
      };
    }
  }
}

export function createRemoteFileResolver(client: RemoteDirectoryClient, profile?: RemoteBackendProfile) {
  return new RemoteFileResolver(client, profile);
}
