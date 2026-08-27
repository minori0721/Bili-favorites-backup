import type { RemoteFileRecord } from "./state.js";
import {
  isRemotePathWithin,
  normalizeRemotePath,
  normalizeStoredRemoteFilePath,
  remoteDirname,
} from "./remote-path.js";

export type QualityUpgradeRemoteTarget =
  | { ok: true; remotePath: string; oldFiles: RemoteFileRecord[] }
  | { ok: false; reason: string };

export function resolveQualityUpgradeRemoteTarget(
  rootValue: string,
  relation: { remotePath?: string; remoteFiles?: RemoteFileRecord[] },
): QualityUpgradeRemoteTarget {
  const oldFiles = relation.remoteFiles?.length ? relation.remoteFiles : [];
  if (oldFiles.length === 0) {
    return { ok: false, reason: "没有可替换的远端文件记录" };
  }

  let root: string;
  try {
    root = normalizeRemotePath(rootValue, { allowTrailingSlash: true });
  } catch {
    return { ok: false, reason: "当前远端归档根路径无效" };
  }

  const normalizedFiles: RemoteFileRecord[] = [];
  const directories = new Set<string>();
  for (const file of oldFiles) {
    const normalizedPath = normalizeStoredRemoteFilePath(file.path);
    if (!normalizedPath || !isRemotePathWithin(root, normalizedPath)) {
      return { ok: false, reason: "旧文件证明包含无效或越界的远端路径" };
    }
    const directory = remoteDirname(normalizedPath);
    directories.add(directory);
    normalizedFiles.push({ ...file, path: normalizedPath });
  }
  if (directories.size !== 1) {
    return { ok: false, reason: "旧文件证明分布在多个远端目录，不能安全替换" };
  }

  const derivedPath = [...directories][0];
  let remotePath = derivedPath;
  if (relation.remotePath) {
    try {
      remotePath = normalizeRemotePath(relation.remotePath, { allowTrailingSlash: true });
    } catch {
      return { ok: false, reason: "旧归档目录证明无效" };
    }
    if (!isRemotePathWithin(root, remotePath) || remotePath !== derivedPath) {
      return { ok: false, reason: "旧归档目录与文件证明不一致" };
    }
  }

  return { ok: true, remotePath, oldFiles: normalizedFiles };
}
