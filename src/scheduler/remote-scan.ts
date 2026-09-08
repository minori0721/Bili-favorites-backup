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
  state: Pick<StateManager, 'listVideosForRemoteVerify' | 'countVideosForRemoteVerify' | 'markRemoteCheckOk' | 'markRemoteCheckDeferred' | 'markRemoteCheckMissing' | 'listRelationsForBvid'>;
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

    const executeOne = async (entry: RemoteVerifyCandidate) => {
      try {
        const relation = entry.relation;
        const resolvedRemotePath = relation.remotePath || entry.remotePath || deriveRemotePathFromRelation(entry, relation);
        await applyRemoteVerifyRateLimit(rateLimit, resolvedRemotePath || "<remote-unknown>");
        if (!current()) return;
        const jitter = 100 + Math.floor(deps.random() * 201);
        await deps.sleep(jitter);
        if (!current()) return;
        const remoteFiles = await resolveRemoteFilesForVerify(entry, relation, resolvedRemotePath);
        if (!current()) return;
        if (!remoteFiles?.length) {
          const confirmed = await confirmRemoteStillMissing(entry, relation, undefined, resolvedRemotePath);
        if (!current()) return;
          if (confirmed.status === "ok") {
            deps.state.markRemoteCheckOk(entry.bvid, resolvedRemotePath || entry.remotePath, confirmed.remoteFiles, relation.userId, relation.mediaId);
            stats.remoteOk += 1;
            return;
          }
          if (confirmed.status === "unknown") {
            const delayMs = computeRemoteVerifyBackoffMs(entry);
            deps.state.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
            stats.remoteErrors += 1;
            return;
          }
          const missing = confirmed.missing?.length
            ? confirmed.missing
            : [resolvedRemotePath || entry.remotePath || "<remote-path-unknown>"];
          deps.state.markRemoteCheckMissing(entry.bvid, missing, relation.userId, relation.mediaId);
          stats.remoteMissingDetected += 1;
          if (entry.biliStatus === "unavailable") {
            stats.remoteMissingUnavailable += 1;
          }
          if (requeueCount < requeueLimit) {
            const requeued = enqueueMissingIfPossible(entry, relation);
            if (requeued) {
              requeueCount += 1;
              stats.requeuedFromRemoteMissing += 1;
            }
          }
          return;
        }

        const result = await deps.verify(config, remoteFiles);
        if (!current()) return;
        if (result.ok) {
          deps.state.markRemoteCheckOk(entry.bvid, resolvedRemotePath || entry.remotePath, remoteFiles, relation.userId, relation.mediaId);
          stats.remoteOk += 1;
          return;
        }
        if (result.unknown.length > 0) {
          const delayMs = computeRemoteVerifyBackoffMs(entry, result.retryAfterMs);
          deps.state.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
          stats.remoteErrors += 1;
          return;
        }

        const confirmed = await confirmRemoteStillMissing(entry, relation, remoteFiles, resolvedRemotePath);
        if (!current()) return;
        if (confirmed.status === "ok") {
          deps.state.markRemoteCheckOk(
            entry.bvid,
            resolvedRemotePath || entry.remotePath,
            confirmed.remoteFiles || remoteFiles,
            relation.userId,
            relation.mediaId
          );
          stats.remoteOk += 1;
          return;
        }
        if (confirmed.status === "unknown") {
          const delayMs = computeRemoteVerifyBackoffMs(entry, confirmed.retryAfterMs);
          deps.state.markRemoteCheckDeferred(entry.bvid, delayMs, "Remote verify inconclusive; deferred.", relation.userId, relation.mediaId);
          stats.remoteErrors += 1;
          return;
        }

        const missing = confirmed.missing?.length ? confirmed.missing : result.missing;
        deps.state.markRemoteCheckMissing(entry.bvid, missing, relation.userId, relation.mediaId);
        stats.remoteMissingDetected += 1;
        if (entry.biliStatus === "unavailable") {
          stats.remoteMissingUnavailable += 1;
        }
        if (requeueCount < requeueLimit) {
          const requeued = enqueueMissingIfPossible(entry, relation);
          if (requeued) {
            requeueCount += 1;
            stats.requeuedFromRemoteMissing += 1;
          }
        }
      } catch (error: unknown) {
        if (!current()) return;
        const delayMs = computeRemoteVerifyBackoffMs(entry);
        const relation = entry.relation;
        deps.state.markRemoteCheckDeferred(entry.bvid, delayMs, error instanceof Error ? error.message : "Remote verify failed", relation.userId, relation.mediaId);
        stats.remoteErrors += 1;
        console.warn(`[Scheduler] Remote verify failed for ${entry.bvid}: ${safeErrorSummary(error)}`);
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
    relation?: FavoriteRelation,
    knownFiles?: VideoArchiveEntry["remoteFiles"],
    resolvedRemotePath?: string | null
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
      const config = deps.config.get();
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
