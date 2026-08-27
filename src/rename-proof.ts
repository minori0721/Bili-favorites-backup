import type { RemoteFileRecord } from "./state.js";
import {
  normalizeRemotePath,
  normalizeStoredRemoteFilePath,
  remoteBasename,
  remoteDirname,
} from "./remote-path.js";
import { remoteLookupDirname, remoteNameMatches } from "./remote-file-resolver.js";

export interface RenameScanObservation {
  name: string;
  accessPath: string;
  accessDir: string;
  strictPath?: string;
  strictDir?: string;
  size?: number;
}

export type RenameLogicalFileResolution =
  | { ok: true; logicalPath: string; logicalDir: string; logicalName: string; recorded?: RemoteFileRecord }
  | { ok: false; reason: string };

function dedupeProofs(files: RemoteFileRecord[]) {
  const proofs = new Map<string, RemoteFileRecord[]>();
  for (const file of files) {
    const path = normalizeStoredRemoteFilePath(file.path);
    if (!path) continue;
    const existing = proofs.get(path) || [];
    existing.push({ ...file, path });
    proofs.set(path, existing);
  }
  return proofs;
}

function selectConsistentProof(proofs: RemoteFileRecord[]) {
  if (proofs.length === 0) return undefined;
  const sizes = new Set(proofs.map((proof) => proof.size).filter(Number.isFinite));
  if (sizes.size > 1) return undefined;
  return proofs.find((proof) => Number.isFinite(proof.size) && proof.filenameMetadata)
    || proofs.find((proof) => Number.isFinite(proof.size))
    || proofs.find((proof) => proof.filenameMetadata)
    || proofs[0];
}

export function resolveRenameLogicalFile(
  observation: RenameScanObservation,
  knownFiles: RemoteFileRecord[],
): RenameLogicalFileResolution {
  const proofsByPath = dedupeProofs(knownFiles);

  if (observation.strictPath) {
    const strictPath = normalizeRemotePath(observation.strictPath);
    const duplicateProofs = proofsByPath.get(strictPath) || [];
    const proof = selectConsistentProof(duplicateProofs);
    if (duplicateProofs.length > 0 && !proof) {
      return { ok: false, reason: "同一路径存在互相冲突的本地文件证明" };
    }
    if (proof && Number.isFinite(observation.size) && Number.isFinite(proof.size) && observation.size !== proof.size) {
      return { ok: false, reason: "远端文件大小与本地证明不一致" };
    }
    return {
      ok: true,
      logicalPath: strictPath,
      logicalDir: remoteDirname(strictPath),
      logicalName: remoteBasename(strictPath),
      ...(proof ? { recorded: proof } : {}),
    };
  }

  let accessDir: string;
  try {
    accessDir = normalizeRemotePath(remoteLookupDirname(observation.accessPath), { allowTrailingSlash: true });
  } catch {
    return { ok: false, reason: "特殊文件位于无法安全映射的远端目录" };
  }
  if (!Number.isFinite(observation.size)) {
    return { ok: false, reason: "特殊文件缺少大小，无法唯一匹配本地证明" };
  }

  const matches: RemoteFileRecord[] = [];
  for (const [path, proofs] of proofsByPath) {
    if (remoteDirname(path) !== accessDir) continue;
    if (!remoteNameMatches(remoteBasename(path), observation.name)) continue;
    const proof = selectConsistentProof(proofs);
    if (!proof || !Number.isFinite(proof.size) || proof.size !== observation.size) continue;
    matches.push(proof);
  }
  if (matches.length === 0) {
    return { ok: false, reason: "OpenList特殊文件名没有匹配的本地路径和大小证明" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "OpenList特殊文件名匹配到多个本地证明，不能自动处理" };
  }

  const logicalPath = normalizeRemotePath(matches[0].path);
  return {
    ok: true,
    logicalPath,
    logicalDir: remoteDirname(logicalPath),
    logicalName: remoteBasename(logicalPath),
    recorded: matches[0],
  };
}
