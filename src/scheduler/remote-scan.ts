import { captureRemoteCheckEvidence, copyRemoteFiles, type RemoteCheckOutcome } from '../remote-check.js';
import type { AppConfig } from '../config.js';
import type { StateManager, VideoArchiveEntry, FavoriteRelation } from '../state.js';
import type { BiliUser } from '../users.js';
import type { verifyRemoteFiles } from '../uploader.js';
import type { createRemoteVerificationIO } from './remote-verification-io.js';
import { safeErrorSummary } from '../diagnostics.js';
type RemoteVerifyCandidate = VideoArchiveEntry & { relation: FavoriteRelation };
type RelationContext = { user: BiliUser; mediaId: number; folderTitle: string };
interface RemoteScanStats {
  remoteChecked: number; remoteEligible: number; remoteOk: number; remoteErrors: number;
  remoteMissingDetected: number; remoteMissingUnavailable: number; requeuedFromRemoteMissing: number;
}
interface RemoteScanDependencies {
  config: {get(): AppConfig};
  state: Pick<StateManager, 'listVideosForRemoteVerify' | 'countVideosForRemoteVerify' | 'commitRemoteCheck' | 'listRelationsForBvid'>;
  io: Pick<ReturnType<typeof createRemoteVerificationIO>, 'clearPathReservations' | 'list' | 'waitForSlot'>;
  random(): number;
  sleep(milliseconds: number): Promise<void>;
  generation(): number;
  canContinue(): boolean;
  verify: typeof verifyRemoteFiles;
  resolve(relation: FavoriteRelation): RelationContext | null;
  bestRelation(bvid: string): RelationContext | null;
  remotePath(user: BiliUser, mediaId: number, title: string, config: AppConfig): string;
  enqueue(user: BiliUser, mediaId: number, title: string, bvid: string): boolean;
  progress(patch: {mode?: string; title?: string; detail?: string; userName?: string; folderTitle?: string; mediaId?: number; page?: number; pageSize?: number; indexed?: number; biliTotal?: number; checked?: number; total?: number}): void;
}
/** Reconciles remote evidence; scheduling control retains the parent run until every worker settles. */
export function createRemoteScan(deps: RemoteScanDependencies) {
const remoteVerifyPerTick = 25;

const remoteVerifyPerTickNoNew = 120;

const remoteVerifyPerTickManual = 200;

async function verifyRemoteSamples(manual: boolean, forceFullRemoteVerify: boolean, context: {trigger: string; title: string; newItems: number}) {
    const stats: RemoteScanStats = { remoteChecked: 0, remoteEligible: 0, remoteOk: 0, remoteErrors: 0, remoteMissingDetected: 0, remoteMissingUnavailable: 0, requeuedFromRemoteMissing: 0 };

    const generation = deps.generation();
    const current = () => generation === deps.generation() && deps.canContinue();
    if (!current()) return stats;
    const config = deps.config.get();
    deps.progress({
      mode: forceFullRemoteVerify ? (manual ? "remote_reconcile" : context.trigger) : context.trigger,
      title: forceFullRemoteVerify ? "状态对账" : context.title,
      detail: forceFullRemoteVerify ? "正在准备远端存储状态对账。" : "正在抽样验证远端存储文件。",
      userName: undefined,
      folderTitle: undefined,
      mediaId: undefined,
      page: undefined,
      pageSize: undefined,
      indexed: undefined,
      biliTotal: undefined,
      checked: undefined,
      total: undefined,
    });
    deps.io.clearPathReservations();
    const verifyLimit = forceFullRemoteVerify ? undefined : getRemoteVerifyLimit(manual, context.newItems);
    const includeDeferred = forceFullRemoteVerify;
    const candidates = deps.state.listVideosForRemoteVerify(verifyLimit, includeDeferred);
    stats.remoteChecked = candidates.length;
    stats.remoteEligible = deps.state.countVideosForRemoteVerify(includeDeferred);
    const concurrency = Math.max(1, Math.min(100, Math.floor(config.remoteVerifyConcurrency || 3)));
    const requeueLimit = Math.max(1, Math.min(1000, Math.floor(config.remoteRequeueLimitPerCycle || 20)));
    const rateLimit = Math.max(0.5, Math.min(100, Number(config.remoteVerifyRateLimitPerSecond || 2)));
    let requeueCount = 0;

    const executeOne = async (candidate: RemoteVerifyCandidate) => {
      // Detach all file evidence consumed by I/O; state may expose tracked proxies.
      const relation = {...candidate.relation, remoteFiles: copyRemoteFiles(candidate.relation.remoteFiles)};
      const entry = {...candidate, remoteFiles: copyRemoteFiles(candidate.remoteFiles), relation};
      const expected = captureRemoteCheckEvidence(relation);
      const resolvedRemotePath = relation.remotePath || entry.remotePath || deriveRemotePathFromRelation(entry, relation);
      await applyRemoteVerifyRateLimit(rateLimit, resolvedRemotePath || '<remote-unknown>');
      if (!current()) return;
      await deps.sleep(100 + Math.floor(deps.random() * 201));
      if (!current()) return;
      let observation: Awaited<ReturnType<typeof confirmRemoteStillMissing>>;
      let requestError: unknown;
      try {
        const remoteFiles = await resolveRemoteFilesForVerify(entry, relation, resolvedRemotePath);
        if (!current()) return;
        if (!remoteFiles.length) {
          observation = await confirmRemoteStillMissing(entry, relation, undefined, resolvedRemotePath, config);
        } else {
          const result = await deps.verify(config, remoteFiles);
          if (!current()) return;
          observation = result.ok ? { status: 'ok', remoteFiles }
            : result.unknown.length ? { status: 'unknown', retryAfterMs: result.retryAfterMs }
              : await confirmRemoteStillMissing(entry, relation, remoteFiles, resolvedRemotePath, config);
        }
      } catch (error: unknown) {
        requestError = error;
        observation = { status: 'unknown' };
      }
      if (!current()) return;
      const currentConfig = deps.config.get();
      if (config.alistUrl !== currentConfig.alistUrl || config.alistDest !== currentConfig.alistDest
          || config.uploadLayout !== currentConfig.uploadLayout || config.alistUsername !== currentConfig.alistUsername
          || config.alistPassword !== currentConfig.alistPassword) return;
      const outcome: RemoteCheckOutcome = observation.status === 'ok'
        ? { kind: 'ok', remotePath: resolvedRemotePath || entry.remotePath, files: observation.remoteFiles }
        : observation.status === 'missing'
          ? { kind: 'missing', files: observation.missing }
          : { kind: 'deferred', delayMs: computeRemoteVerifyBackoffMs(entry, observation.retryAfterMs),
              reason: requestError instanceof Error ? safeErrorSummary(requestError) : 'Remote verify inconclusive; deferred.' };
      // The database commit is deliberately outside the external-request catch.
      if (!deps.state.commitRemoteCheck(expected, outcome)) return;
      if (outcome.kind === 'ok') { stats.remoteOk++; return; }
      if (outcome.kind === 'deferred') {
        stats.remoteErrors++;
        if (requestError) console.warn(`[Scheduler] Remote verify failed for ${entry.bvid}: ${safeErrorSummary(requestError)}`);
        return;
      }
      stats.remoteMissingDetected++;
      if (entry.biliStatus === 'unavailable') stats.remoteMissingUnavailable++;
      if (requeueCount < requeueLimit && enqueueMissingIfPossible(entry, relation)) {
        requeueCount++;
        stats.requeuedFromRemoteMissing++;
      }
    };

    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (index < candidates.length && current()) {
        const current = candidates[index];
        index += 1;
        deps.progress({
          checked: index,
          total: candidates.length,
          detail: `正在对账远端存储文件 ${index}/${candidates.length}。`,
        });
        await executeOne(current);
      }
    });
    const outcomes = await Promise.allSettled(workers);
    const failed = outcomes.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return stats;
  }

async function resolveRemoteFilesForVerify(
    entry: VideoArchiveEntry,
    relation?: FavoriteRelation,
    resolvedRemotePath?: string | null
  ) {
    const recordedFiles = relation?.remoteFiles?.length ? relation.remoteFiles : entry.remoteFiles;
    if (recordedFiles?.length) {
      return recordedFiles;
    }
    const pathToUse = resolvedRemotePath || relation?.remotePath || entry.remotePath || deriveRemotePathFromRelation(entry, relation);
    if (!pathToUse) {
      return [];
    }
    const names = await getRemoteDirListing(pathToUse);
    if (!names.length) {
      return [];
    }
    const matchedNames = names.filter((name) => name.includes(entry.bvid));
    if (!matchedNames.length) {
      return [];
    }
    return matchedNames.map((name) => ({
      name,
      path: pathToUse.replace(/\/$/, "") + "/" + name,
    }));
  }

function deriveRemotePathFromRelation(entry: VideoArchiveEntry, relation?: FavoriteRelation) {
    const resolvedRelation = relation ? deps.resolve(relation) : deps.bestRelation(entry.bvid);
    if (!resolvedRelation) {
      return null;
    }
    const config = deps.config.get();
    return deps.remotePath(
      resolvedRelation.user,
      resolvedRelation.mediaId,
      resolvedRelation.folderTitle,
      config,
    );
  }

function getRemoteDirListing(pathToUse:string) {
    return deps.io.list(pathToUse);
  }

function enqueueMissingIfPossible(entry: VideoArchiveEntry, targetRelation?: FavoriteRelation) {
    if (entry.biliStatus === "unavailable") return false;
    const relations = targetRelation ? [targetRelation] : deps.state.listRelationsForBvid(entry.bvid);
    for (const relation of relations) {
      const resolved = deps.resolve(relation);
      if (!resolved) continue;
      return deps.enqueue(
        resolved.user,
        resolved.mediaId,
        resolved.folderTitle,
        entry.bvid
      );
    }
    return false;
  }

async function confirmRemoteStillMissing(
    entry: VideoArchiveEntry,
    relation: FavoriteRelation | undefined,
    knownFiles: VideoArchiveEntry["remoteFiles"],
    resolvedRemotePath: string | null | undefined,
    config: AppConfig
  ): Promise<
    | { status: "ok"; remoteFiles: NonNullable<VideoArchiveEntry["remoteFiles"]> }
    | { status: "missing"; missing: string[] }
    | { status: "unknown"; retryAfterMs?: number }
  > {
    const generation = deps.generation();
    try {
      const remoteFiles = knownFiles?.length ? knownFiles : await resolveRemoteFilesForVerify(entry, relation, resolvedRemotePath);
      if (generation !== deps.generation() || !deps.canContinue()) return { status: 'unknown' };
      if (!remoteFiles?.length) {
        return { status: "missing", missing: [resolvedRemotePath || entry.remotePath || "<remote-path-unknown>"] };
      }
      const result = await deps.verify(config, remoteFiles);
      if (result.ok) {
        return { status: "ok", remoteFiles };
      }
      if (result.unknown.length > 0) {
        return { status: "unknown", retryAfterMs: result.retryAfterMs };
      }
      return { status: "missing", missing: result.missing };
    } catch {
      // Treat transient errors as inconclusive to avoid false-positive "missing".
      return { status: "unknown" };
    }
  }

function applyRemoteVerifyRateLimit(rateLimitPerSecond:number,remotePath:string) {
    return deps.io.waitForSlot(rateLimitPerSecond,remotePath);
  }

function computeRemoteVerifyBackoffMs(entry: VideoArchiveEntry, retryAfterMs?: number) {
    const missingCount = Math.max(0, entry.remoteMissingCount || 0);
    const base = 30_000;
    const max = 30 * 60_000;
    const exp = Math.min(6, missingCount);
    const backoff = Math.min(max, base * Math.pow(2, exp));
    const jitter = Math.floor(deps.random() * 3_000);
    const serverDelay = Number.isFinite(retryAfterMs) ? Math.max(0, Number(retryAfterMs)) : 0;
    return Math.max(backoff, Math.min(max, serverDelay)) + jitter;
  }

function getRemoteVerifyLimit(manual: boolean, newItems: number) {
    if (manual) {
      return remoteVerifyPerTickManual;
    }
    if (newItems === 0) {
      return remoteVerifyPerTickNoNew;
    }
    return remoteVerifyPerTick;
  }
return { run: verifyRemoteSamples };
}
