import type { AppConfig } from "./config.js";
import type { RemoteFilePreviewVideoRecord, RemoteFileRecord } from "./state.js";
import type { RemoteListedFile } from "./uploader.js";
import { renderArchivedFilename } from "./filename.js";
import { resolveRenameLogicalFile } from "./rename-proof.js";
import { remoteBasename, remoteDirname, normalizeRemotePath, normalizeStoredRemoteFilePath, isRemotePathWithin } from "./remote-path.js";
import { remoteNameMatches } from "./remote-file-resolver.js";
import { joinRemotePath } from "./utils.js";
import { SkippedPreviewCollector, type PreviewSkippedSummary } from "./preview-summary.js";

export interface RenamePreviewSkipped {
  path: string;
  reason: string;
}

export interface RenamePreviewCandidate {
  bvid: string;
  title: string;
  ownerName: string;
  remoteDir: string;
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
  reason: string;
  sourceAccessPath: string;
}

export type PublicRenamePreviewCandidate = Omit<RenamePreviewCandidate, "sourceAccessPath">;

export interface RenamePreviewData extends PreviewSkippedSummary<RenamePreviewSkipped> {
  candidates: PublicRenamePreviewCandidate[];
  complete: boolean;
  scannedFiles: number;
  scanLimit: number;
  indexedFiles?: number;
  coverage?: "local" | "remote" | "merged";
}

export interface RenamePreviewScanInput {
  files: RemoteListedFile[];
  skipped: RenamePreviewSkipped[];
  skippedTotal?: number;
  skippedByReason?: Record<string, number>;
  complete: boolean;
}

function extractBvid(value: string) {
  return String(value || "").match(/BV[0-9A-Za-z]+/)?.[0] || "";
}

function isMediaRemoteFile(file: RemoteFileRecord) {
  return /\.(mp4|mkv|flv|mov|m4v)$/i.test(file.name || file.path);
}

function allKnownFiles(record: RemoteFilePreviewVideoRecord) {
  return [...record.remoteFiles, ...record.relations.flatMap((relation) => relation.remoteFiles || [])];
}

function chooseIndexedProof(current: RemoteFileRecord | undefined, candidate: RemoteFileRecord) {
  if (!current) return candidate;
  if (!current.filenameMetadata && candidate.filenameMetadata) return candidate;
  if (!Number.isFinite(current.size) && Number.isFinite(candidate.size)) return candidate;
  return current;
}

export function buildIndexedRemoteFiles(records: RemoteFilePreviewVideoRecord[], rootValue: string) {
  const root = normalizeRemotePath(rootValue, { allowTrailingSlash: true });
  const byPath = new Map<string, RemoteFileRecord>();
  for (const record of records) {
    for (const file of allKnownFiles(record)) {
      if (!isMediaRemoteFile(file)) continue;
      if (file.verificationStatus && file.verificationStatus !== "verified") continue;
      const storedPath = normalizeStoredRemoteFilePath(file.path);
      if (!storedPath || !isRemotePathWithin(root, storedPath, false)) continue;
      byPath.set(storedPath, chooseIndexedProof(byPath.get(storedPath), file));
    }
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([storedPath, file]) => ({
      name: remoteBasename(storedPath),
      accessPath: storedPath,
      accessDir: remoteDirname(storedPath),
      strictPath: storedPath,
      strictDir: remoteDirname(storedPath),
      ...(Number.isFinite(file.size) ? { size: file.size } : {}),
    } satisfies RemoteListedFile));
}

function addScanSkipped(collector: SkippedPreviewCollector<RenamePreviewSkipped>, scan: RenamePreviewScanInput) {
  if (scan.skippedTotal !== undefined && scan.skippedByReason) {
    collector.addSummary({
      skipped: scan.skipped,
      skippedTotal: scan.skippedTotal,
      skippedByReason: scan.skippedByReason,
    });
  } else {
    collector.addMany(scan.skipped);
  }
}

export function buildRenamePreview(options: {
  config: AppConfig;
  root: string;
  records: RemoteFilePreviewVideoRecord[];
  scanned: RenamePreviewScanInput;
  scanLimit: number;
  detailLimit?: number;
  indexedFiles?: number;
  coverage?: "local" | "remote" | "merged";
}): RenamePreviewData {
  const { config, root, records, scanned, scanLimit } = options;
  const collector = new SkippedPreviewCollector<RenamePreviewSkipped>(options.detailLimit);
  addScanSkipped(collector, scanned);
  const recordsByBvid = new Map(records.map((record) => [record.bvid, record]));
  const knownFilesByBvid = new Map(records.map((record) => [record.bvid, allKnownFiles(record)]));
  const resolvedFiles: Array<{
    file: RemoteListedFile;
    bvid: string;
    record: RemoteFilePreviewVideoRecord;
    knownFiles: RemoteFileRecord[];
    logicalPath: string;
    logicalDir: string;
    logicalName: string;
    recorded?: RemoteFileRecord;
  }> = [];

  for (const file of scanned.files) {
    const bvid = extractBvid(file.name);
    if (!bvid) {
      collector.add({ path: file.strictPath || root, reason: "文件名没有 BV 号" });
      continue;
    }
    const record = recordsByBvid.get(bvid);
    if (!record) {
      collector.add({ path: file.strictPath || root, reason: "BV 号在本地状态中找不到" });
      continue;
    }
    const knownFiles = knownFilesByBvid.get(bvid) || [];
    const resolved = resolveRenameLogicalFile(file, knownFiles);
    if (!resolved.ok) {
      collector.add({ path: file.strictPath || root, reason: resolved.reason });
      continue;
    }
    if (!isRemotePathWithin(root, resolved.logicalPath)) {
      collector.add({ path: resolved.logicalPath, reason: "路径不在当前 AList / OpenList 目标路径下" });
      continue;
    }
    resolvedFiles.push({ file, bvid, record, knownFiles, ...resolved });
  }

  const logicalPathCounts = new Map<string, number>();
  for (const item of resolvedFiles) logicalPathCounts.set(item.logicalPath, (logicalPathCounts.get(item.logicalPath) || 0) + 1);

  const proposed: RenamePreviewCandidate[] = [];
  for (const resolved of resolvedFiles) {
    const { file, bvid, record, knownFiles, logicalPath, logicalDir, logicalName, recorded } = resolved;
    if ((logicalPathCounts.get(logicalPath) || 0) > 1) {
      collector.add({ path: logicalPath, reason: "远端目录存在多个可映射到同一本地证明的文件，不能自动处理" });
      continue;
    }
    const mediaCount = new Set(knownFiles
      .filter(isMediaRemoteFile)
      .filter((item) => !item.verificationStatus || item.verificationStatus === "verified")
      .map((item) => item.path)).size;
    const suffixPage = Number(logicalName.replace(/\.[^.]+$/, "").match(/_P(\d+)$/i)?.[1] || 0) || undefined;
    const pageIndex = recorded?.filenameMetadata?.pageIndex || suffixPage;
    const rendered = renderArchivedFilename(config.filenameTemplate, record, recorded?.filenameMetadata, pageIndex, mediaCount > 1);
    if (!rendered.name) {
      collector.add({ path: logicalPath, reason: rendered.reason || "无法根据当前模板生成目标文件名" });
      continue;
    }
    const ext = logicalName.match(/\.[^.]+$/)?.[0] || ".mp4";
    const newName = `${rendered.name}${ext}`;
    if (newName === logicalName) {
      collector.add({ path: logicalPath, reason: "当前文件名已经符合模板" });
      continue;
    }
    proposed.push({
      bvid,
      title: record.title,
      ownerName: record.upperName,
      remoteDir: logicalDir,
      oldName: logicalName,
      newName,
      oldPath: logicalPath,
      newPath: joinRemotePath(logicalDir, newName),
      reason: "同目录内按当前命名模板重命名",
      sourceAccessPath: file.accessPath,
    });
  }

  const targetCounts = new Map<string, number>();
  for (const item of proposed) targetCounts.set(item.newPath, (targetCounts.get(item.newPath) || 0) + 1);
  const sourceAccessPaths = new Set(proposed.map((item) => item.sourceAccessPath));
  const filesByDirectory = new Map<string, RemoteListedFile[]>();
  for (const file of scanned.files) {
    try {
      const directory = normalizeRemotePath(file.accessDir, { allowTrailingSlash: true });
      const existing = filesByDirectory.get(directory) || [];
      existing.push(file);
      filesByDirectory.set(directory, existing);
    } catch {
      // The resolver already fails closed for an unsafe entry.
    }
  }
  const candidates: RenamePreviewCandidate[] = [];
  for (const item of proposed) {
    if ((targetCounts.get(item.newPath) || 0) > 1) {
      collector.add({ path: item.oldPath, reason: `多个文件会重命名为同一目标：${item.newName}` });
      continue;
    }
    const targetExists = (filesByDirectory.get(item.remoteDir) || []).some((file) =>
      !sourceAccessPaths.has(file.accessPath) && remoteNameMatches(item.newName, file.name));
    if (targetExists) {
      collector.add({ path: item.oldPath, reason: `目标文件已存在：${item.newName}` });
      continue;
    }
    candidates.push(item);
  }

  if (!scanned.complete) collector.add({ path: root, reason: `远端文件达到扫描上限 ${scanLimit}，预览不完整，已禁止执行` });
  const skipped = collector.snapshot();
  return {
    candidates: scanned.complete ? candidates.map(({ sourceAccessPath: _sourceAccessPath, ...item }) => item) : [],
    ...skipped,
    complete: scanned.complete,
    scannedFiles: scanned.files.length,
    scanLimit,
    ...(options.indexedFiles === undefined ? {} : { indexedFiles: options.indexedFiles }),
    ...(options.coverage ? { coverage: options.coverage } : {}),
  };
}

export function mergeRenamePreviews(local: RenamePreviewData, remote: RenamePreviewData, detailLimit?: number): RenamePreviewData {
  const candidateByPath = new Map<string, PublicRenamePreviewCandidate>();
  for (const item of local.candidates) candidateByPath.set(item.oldPath, item);
  if (remote.complete) for (const item of remote.candidates) candidateByPath.set(item.oldPath, item);
  const collector = new SkippedPreviewCollector<RenamePreviewSkipped>(detailLimit);
  // A complete remote scan covers the same files as the local index. Prefer its
  // summary so a known file is not counted twice after the background pass.
  if (remote.complete) collector.addSummary(remote);
  else collector.addSummary(local);
  const skipped = collector.snapshot();
  return {
    candidates: [...candidateByPath.values()],
    ...skipped,
    complete: true,
    scannedFiles: remote.scannedFiles,
    scanLimit: remote.scanLimit,
    indexedFiles: local.indexedFiles,
    coverage: remote.complete ? "merged" : "local",
  };
}
