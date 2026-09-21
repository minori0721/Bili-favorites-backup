import crypto from 'node:crypto';
import type { AppConfig } from './config.js';
import type { StateManager } from './state.js';
import { redactRemotePathForDisplay, sanitizeDiagnosticText } from './diagnostics.js';
import { BackgroundPreviewCache, type BackgroundPreviewSnapshot } from './preview-cache.js';
import { previewDetailLimit } from './preview-options.js';
import { normalizeRemotePath } from './remote-path.js';
import { remoteStorageIdentity } from './remote-storage.js';
import { RenamePreviewSessionStore } from './rename-preview-session.js';
import { buildIndexedRemoteFiles, buildRenamePreviewInternal, mergeRenamePreviewInternals, type InternalRenamePreviewData } from './rename-preview.js';
import type { batchRenameRemotePaths, listRemoteFilesRecursive } from './uploader.js';
type RemoteRenameScan = Awaited<ReturnType<typeof listRemoteFilesRecursive>>;
interface Dependencies {
  config: () => AppConfig;
  state: Pick<StateManager, 'getRemoteFilePreviewRecords' | 'renameRemoteFilesBatch'>;
  hasUnfinishedDeletion(): boolean;
  scan: typeof listRemoteFilesRecursive;
  rename: typeof batchRenameRemotePaths;
}
function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : {};
}
export function createRenameService(deps: Dependencies) {
const renamePreviewScans = new BackgroundPreviewCache<RemoteRenameScan>({ ttlMs: 5 * 60_000, failedTtlMs: 30_000, maxEntries: 32 });
const renamePreviewSessions = new RenamePreviewSessionStore({ ttlMs: 5 * 60_000, maxEntries: 8 });
function extractBvid(value: string) {
  return String(value || "").match(/BV[0-9A-Za-z]+/)?.[0] || "";
}

function renameScanLimit(config: AppConfig) {
  const configured = Number(config.renameScanMaxFiles || 10_000);
  return Number.isFinite(configured)
    ? Math.max(100, Math.min(100_000, Math.floor(configured)))
    : 10_000;
}

function renameRemoteScanKey(config: AppConfig, root: string, scanLimit: number) {
  return crypto.createHash("sha256").update(JSON.stringify({
    url: config.alistUrl,
    username: config.alistUsername,
    password: config.alistPassword,
    root,
    scanLimit,
    maxDepth: 8,
    maxEntries: Math.max(10_000, Math.min(500_000, scanLimit * 5)),
    maxDirectories: Math.max(1_000, Math.min(50_000, scanLimit)),
  })).digest("hex");
}

function renamePreviewConfigKey(config: AppConfig, root: string, scanLimit: number) {
  return crypto.createHash("sha256").update(JSON.stringify({
    storage: remoteStorageIdentity(config),
    root,
    scanLimit,
    maxDepth: 8,
    filenameTemplate: config.filenameTemplate,
  })).digest("hex");
}


function buildLocalRenamePreview(
  config: AppConfig,
  root: string,
  scanLimit: number,
  detailLimit: number | undefined,
  records: ReturnType<StateManager["getRemoteFilePreviewRecords"]>,
) {
  const indexedFiles = buildIndexedRemoteFiles(records, root);
  return buildRenamePreviewInternal({
    config,
    root,
    records,
    scanned: { files: indexedFiles, skipped: [], skippedTotal: 0, skippedByReason: {}, complete: true },
    scanLimit,
    detailLimit,
    indexedFiles: indexedFiles.length,
    coverage: "local",
  });
}

function buildRemoteRenamePreview(
  config: AppConfig,
  root: string,
  scanLimit: number,
  detailLimit: number | undefined,
  records: ReturnType<StateManager["getRemoteFilePreviewRecords"]>,
  scanned: RemoteRenameScan,
) {
  return buildRenamePreviewInternal({
    config,
    root,
    records,
    scanned,
    scanLimit,
    detailLimit,
    coverage: "remote",
  });
}

function renameScanMetadata(snapshot: BackgroundPreviewSnapshot<RemoteRenameScan>) {
  const result = snapshot.result;
  return {
    id: snapshot.id,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    ...(snapshot.completedAt === undefined ? {} : { completedAt: snapshot.completedAt }),
    ...(snapshot.expiresAt === undefined ? {} : { expiresAt: snapshot.expiresAt }),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(result ? {
      complete: result.complete,
      scannedFiles: result.files.length,
      skippedTotal: result.skippedTotal,
      ...(result.scannedEntries === undefined ? {} : { scannedEntries: result.scannedEntries }),
      ...(result.scannedDirectories === undefined ? {} : { scannedDirectories: result.scannedDirectories }),
    } : {}),
  };
}

function renameScanSignature(snapshot: BackgroundPreviewSnapshot<RemoteRenameScan>) {
  const result = snapshot.result;
  return JSON.stringify([
    snapshot.status,
    snapshot.completedAt || 0,
    snapshot.error || "",
    result?.complete === true,
    result?.files.length || 0,
    result?.skippedTotal || 0,
    result?.scannedEntries || 0,
    result?.scannedDirectories || 0,
  ]);
}

function buildRenameSessionCurrent(
  config: AppConfig,
  root: string,
  scanLimit: number,
  detailLimit: number | undefined,
  records: ReturnType<StateManager["getRemoteFilePreviewRecords"]>,
  local: InternalRenamePreviewData,
  snapshot: BackgroundPreviewSnapshot<RemoteRenameScan>,
) {
  if (snapshot.status !== "ready" || !snapshot.result) return local;
  return mergeRenamePreviewInternals(
    local,
    buildRemoteRenamePreview(config, root, scanLimit, detailLimit, records, snapshot.result),
    detailLimit,
  );
}

function syncRenamePreviewSession(
  previewId: string,
  config: AppConfig,
  root: string,
  scanLimit: number,
  detailLimit: number | undefined,
) {
  const session = renamePreviewSessions.get(previewId);
  if (!session) return undefined;
  const scanId = renamePreviewSessions.getScanId(previewId);
  const snapshot = scanId ? renamePreviewScans.get(scanId) : undefined;
  if (snapshot) {
    const signature = renameScanSignature(snapshot);
    if (signature !== renamePreviewSessions.getRemoteSignature(previewId)) {
      const records = deps.state.getRemoteFilePreviewRecords();
      const local = renamePreviewSessions.getLocalPreview(previewId);
      if (!local) return renamePreviewSessions.getResponse(previewId);
      const current = buildRenameSessionCurrent(config, root, scanLimit, detailLimit, records, local, snapshot);
      renamePreviewSessions.applyScan(previewId, {
        current,
        remoteScan: renameScanMetadata(snapshot),
        remoteSignature: signature,
      });
    }
  }
  return renamePreviewSessions.getResponse(previewId);
}

async function preview(input: unknown) {
  if (deps.hasUnfinishedDeletion()) {
    return { status: 409, body: { success: false, message: "仍有未完成的归档清理，不能扫描远端重命名候选" } };
  }
  const body = inputRecord(input);
  const config = deps.config();
  const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos", { allowTrailingSlash: true });
  const scanLimit = renameScanLimit(config);
  const detailLimit = previewDetailLimit(body.detailLimit);
  const configKey = renamePreviewConfigKey(config, root, scanLimit);
  const scanKey = renameRemoteScanKey(config, root, scanLimit);
  const snapshot = renamePreviewScans.start(
    scanKey,
    () => deps.scan(config, root, {
      maxDepth: 8,
      maxFiles: scanLimit,
      maxEntries: Math.max(10_000, Math.min(500_000, scanLimit * 5)),
      maxDirectories: Math.max(1_000, Math.min(50_000, scanLimit)),
      concurrency: 2,
      skippedLimit: 50,
    }),
    { force: body.refresh === true },
  );
  const records = deps.state.getRemoteFilePreviewRecords();
  const local = buildLocalRenamePreview(config, root, scanLimit, detailLimit, records);
  const current = buildRenameSessionCurrent(config, root, scanLimit, detailLimit, records, local, snapshot);
  const response = renamePreviewSessions.create({
    key: configKey,
    configKey,
    scanId: snapshot.id,
    local,
    current,
    remoteScan: renameScanMetadata(snapshot),
    remoteSignature: renameScanSignature(snapshot),
    force: body.refresh === true,
  });
  return { status: 200, body: { success: true, data: response } };
}
async function status(query: Record<string, unknown>) {
  const previewId = String(query.previewId || "").trim();
  if (!previewId) {
    return { status: 404, body: { success: false, message: "远端重命名预览已过期，请重新预览" } };
  }
  const config = deps.config();
  const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos", { allowTrailingSlash: true });
  const scanLimit = renameScanLimit(config);
  const configKey = renamePreviewConfigKey(config, root, scanLimit);
  const previewConfigKey = renamePreviewSessions.getConfigKey(previewId);
  if (previewConfigKey === undefined) {
    return { status: 409, body: { success: false, message: "远端重命名预览已过期，请重新预览" } };
  }
  if (previewConfigKey !== configKey) {
    return { status: 409, body: { success: false, message: "远端配置或扫描范围已变化，请重新预览" } };
  }
  const detailLimit = previewDetailLimit(query.detailLimit);
  const sinceRevisionValue = query.sinceRevision;
  const sinceRevision = sinceRevisionValue === undefined || sinceRevisionValue === ""
    ? undefined
    : Number(sinceRevisionValue);
  if (sinceRevision !== undefined && (!Number.isInteger(sinceRevision) || sinceRevision < 1)) {
    return { status: 400, body: { success: false, message: "预览版本号无效" } };
  }
  const full = syncRenamePreviewSession(previewId, config, root, scanLimit, detailLimit);
  if (!full) {
    return { status: 409, body: { success: false, message: "远端重命名预览已过期，请重新预览" } };
  }
  const response = sinceRevision !== undefined && sinceRevision === full.revision
    ? renamePreviewSessions.getResponse(previewId, true)
    : full;
  return { status: 200, body: { success: true, data: response } };
}
async function execute(input: unknown) {
  if (deps.hasUnfinishedDeletion()) {
    return { status: 409, body: { success: false, message: "仍有未完成的归档清理，不能重命名远端文件" } };
  }
  const body = inputRecord(input);
  const config = deps.config();
  if (Array.isArray(body.items)) {
    return { status: 400, body: { success: false, message: "请先创建重命名预览，再使用 previewId 和 candidateIds 执行" } };
  }
  const previewId = String(body.previewId || "").trim();
  const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds.map((value) => String(value || "")) : [];
  if (!previewId || candidateIds.length === 0 || candidateIds.length > 10_000) {
    return { status: 400, body: { success: false, message: "previewId 和 candidateIds 必填" } };
  }
  const root = normalizeRemotePath(config.alistDest || "/bili-backup/videos", { allowTrailingSlash: true });
  const previewConfigKey = renamePreviewSessions.getConfigKey(previewId);
  if (previewConfigKey === undefined) {
    return { status: 409, body: { success: false, message: "远端重命名预览已过期，请重新预览" } };
  }
  if (previewConfigKey !== renamePreviewConfigKey(config, root, renameScanLimit(config))) {
    return { status: 409, body: { success: false, message: "远端配置或扫描范围已变化，请重新预览" } };
  }
  const started = renamePreviewSessions.beginExecution(previewId, candidateIds);
  if (started.kind === "missing") {
    return { status: 409, body: { success: false, message: "远端重命名预览已过期，请重新预览" } };
  }
  if (started.kind === "invalid") {
    return { status: 409, body: { success: false, message: started.message } };
  }
  if (started.kind === "in_progress") {
    return { status: 202, body: { success: true, data: { status: "running" } } };
  }
  if (started.kind === "completed") {
    return { status: 200, body: { success: true, data: started.result } };
  }
  const safeItems = started.candidates.map((item) => ({
    bvid: item.bvid,
    oldPath: item.oldPath,
    newPath: item.newPath,
    expectedSize: item.expectedSize,
    sourceAccessPath: item.sourceAccessPath,
  }));
  try {
    const result = await deps.rename(config, safeItems);
    const stateRenames = new Map<string, Array<{ oldPath: string; newPath: string }>>();
    for (const item of result.results) {
      const source = safeItems.find((candidate) => candidate.oldPath === item.oldPath && candidate.newPath === item.newPath);
      const bvid = source?.bvid || extractBvid(item.oldPath) || extractBvid(item.newPath);
      if (bvid && item.actualPath && item.actualPath !== item.oldPath) {
        const itemsForBvid = stateRenames.get(bvid) || [];
        itemsForBvid.push({ oldPath: item.oldPath, newPath: item.actualPath });
        stateRenames.set(bvid, itemsForBvid);
      }
    }
    for (const [bvid, renames] of stateRenames) deps.state.renameRemoteFilesBatch(bvid, renames);
    const safeResult = {
      ...result,
      results: result.results.map((entry) => ({
        ...entry,
        oldPath: redactRemotePathForDisplay(entry.oldPath),
        newPath: redactRemotePathForDisplay(entry.newPath),
        actualPath: entry.actualPath ? redactRemotePathForDisplay(entry.actualPath) : entry.actualPath,
        observedPaths: Array.isArray(entry.observedPaths)
          ? entry.observedPaths.map((value: string) => redactRemotePathForDisplay(value))
          : entry.observedPaths,
        error: entry.error ? sanitizeDiagnosticText(entry.error, 500) : entry.error,
      })),
    };
    renamePreviewSessions.finishExecution(previewId, safeResult);
    return { status: 200, body: { success: true, data: safeResult } };
  } catch (error) {
    const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 300);
    const failure = { success: 0, failed: safeItems.length, results: [], error: message };
    renamePreviewSessions.finishExecution(previewId, failure);
    throw error;
  }
}
return { preview, status, execute,
  invalidateConfig(config: AppConfig) {
    const root = normalizeRemotePath(config.alistDest || '/bili-backup/videos', { allowTrailingSlash: true });
    renamePreviewSessions.invalidateConfig(renamePreviewConfigKey(config, root, renameScanLimit(config)));
  },
  waitForIdle: (timeout: number) => renamePreviewScans.waitForIdle(timeout),
  stop: (timeout: number) => renamePreviewScans.stop(timeout),
  clear: () => renamePreviewSessions.clear(),
};
}
