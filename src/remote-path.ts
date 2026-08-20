export class RemotePathError extends Error {
  readonly code = "REMOTE_PATH_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemotePathError";
  }
}

function splitStrictPath(value: unknown, allowRoot = true, allowTrailingSlash = false) {
  let raw = String(value ?? "");
  if (!raw.startsWith("/")) throw new RemotePathError("远端路径必须是绝对路径");
  if (raw.includes("\\") || raw.includes("\0")) {
    throw new RemotePathError("远端路径包含非法字符");
  }
  if (allowTrailingSlash) raw = raw.replace(/\/+$/, "") || "/";
  if (raw === "/") {
    if (!allowRoot) throw new RemotePathError("远端文件路径不能是根目录");
    return [];
  }
  const parts = raw.split("/").slice(1);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new RemotePathError("远端路径包含非法片段");
  }
  return parts;
}

export function normalizeRemotePath(value: unknown, options: { allowRoot?: boolean; allowTrailingSlash?: boolean } = {}) {
  const parts = splitStrictPath(value, options.allowRoot !== false, options.allowTrailingSlash === true);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function normalizeLegacyRemotePath(value: unknown, options: { allowRoot?: boolean } = {}) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw.startsWith("/")) throw new RemotePathError("远端路径必须是绝对路径");
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new RemotePathError("远端路径包含非法片段");
  }
  if (parts.length === 0 && options.allowRoot === false) {
    throw new RemotePathError("远端文件路径不能是根目录");
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function normalizeStoredRemoteFilePath(value: unknown) {
  const raw = String(value ?? "");
  if (!raw || raw === "/") return null;
  try {
    const normalized = normalizeRemotePath(raw, { allowRoot: false });
    return normalized === raw ? normalized : null;
  } catch {
    return null;
  }
}

export function joinRemotePath(root: string, ...children: string[]) {
  let current = normalizeRemotePath(root, { allowTrailingSlash: true });
  for (const childValue of children) {
    const child = String(childValue ?? "").replace(/^\/+|\/+$/g, "");
    if (!child) continue;
    const relative = child.split("/");
    if (relative.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
      throw new RemotePathError("远端相对路径包含非法片段");
    }
    current = `${current === "/" ? "" : current}/${relative.join("/")}` || "/";
  }
  return current;
}

export function isRemotePathWithin(rootValue: string, targetValue: string, allowRoot = true) {
  try {
    const root = normalizeRemotePath(rootValue, { allowTrailingSlash: true });
    const target = normalizeRemotePath(targetValue, { allowTrailingSlash: true });
    return (allowRoot && target === root) || root === "/" || target.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

export function remoteBasename(value: string) {
  const normalized = normalizeRemotePath(value, { allowRoot: true });
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function remoteDirname(value: string) {
  const normalized = normalizeRemotePath(value, { allowRoot: true });
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}
