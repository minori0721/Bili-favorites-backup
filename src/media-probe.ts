import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import {
  probeMediaWithBBDown,
  type BBDownProbePage,
  type BBDownProbeSizeSource,
  type BBDownProbeTarget,
  type BBDownProbeTrack,
} from "./downloader.js";
import type { BiliUser } from "./users.js";
import { normalizeActualCodec, normalizeBilibiliQualityLabel } from "./media-metadata.js";
import { safeErrorSummary } from "./diagnostics.js";

export interface TargetMediaProfile {
  quality?: string;
  encoding?: "HEVC" | "AVC" | "AV1";
  strict: boolean;
}

export interface MediaProbeCombination extends BBDownProbeTrack {
  encoding?: "HEVC" | "AVC" | "AV1";
  available: boolean;
}

export interface MediaProbeResult {
  probeId: string;
  bvid: string;
  status: "running" | "complete" | "failed";
  target?: TargetMediaProfile;
  createdAt: string;
  finishedAt?: string;
  pages?: Array<BBDownProbePage & { tracks: MediaProbeCombination[] }>;
  combinations?: MediaProbeCombination[];
  estimatedVideoBytes?: number;
  estimatedAudioBytes?: number;
  estimatedBytes?: number;
  estimatedBytesKind?: "final" | "video_only";
  estimatedPeakBytes?: number;
  estimatedBytesSource?: BBDownProbeSizeSource | "mixed";
  cacheAvailableBytes?: number;
  cacheLimitBytes?: number;
  error?: string;
}

export interface MediaProbeCacheCapacity {
  limitBytes: number;
  usedBytes: number;
  reserveBytes: number;
}

export class MediaProbeBusyError extends Error {
  readonly code = "MEDIA_PROBE_BUSY";

  constructor() {
    super("该账号已有媒体探测正在进行");
    this.name = "MediaProbeBusyError";
  }
}

type MediaProbeRunner = (
  bvid: string,
  cookie: BiliUser["cookie"],
  config: AppConfig,
  target?: BBDownProbeTarget,
) => Promise<{ bvid: string; pages: BBDownProbePage[]; source: "bbdown" }>;

function codec(value: unknown): MediaProbeCombination["encoding"] {
  const normalized = normalizeActualCodec(String(value || ""));
  return normalized === "HEVC" || normalized === "AVC" || normalized === "AV1" ? normalized : undefined;
}

function normalizePage(page: BBDownProbePage) {
  return {
    ...page,
    tracks: page.tracks.map((track) => ({
      ...track,
      encoding: codec(track.codec),
      available: true,
    })),
  };
}

function matchesStrictTarget(track: MediaProbeCombination, target?: TargetMediaProfile) {
  if (!target?.strict) return true;
  if (target.encoding && track.encoding !== target.encoding) return false;
  if (target.quality) {
    const requested = normalizeBilibiliQualityLabel(target.quality);
    const actual = normalizeBilibiliQualityLabel(track.bilibiliQuality);
    if (!requested || !actual || actual !== requested) return false;
  }
  return true;
}

function combinationKey(track: MediaProbeCombination) {
  return `${normalizeBilibiliQualityLabel(track.bilibiliQuality)}:${track.encoding || ""}`;
}

function positiveBytes(value: unknown) {
  const bytes = Number(value || 0);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

function mergeSizeSources(sources: Array<BBDownProbeSizeSource | undefined>): MediaProbeResult["estimatedBytesSource"] {
  const normalized = sources.filter((source): source is BBDownProbeSizeSource => Boolean(source));
  if (normalized.length === 0) return "unknown";
  return new Set(normalized).size === 1 ? normalized[0] : "mixed";
}

export class MediaProbeService {
  private readonly jobs = new Map<string, MediaProbeResult>();
  private readonly activeByUser = new Set<string>();
  private readonly ttlMs = 15 * 60_000;

  constructor(
    private readonly configStore: { get(): AppConfig },
    private readonly probeRunner: MediaProbeRunner = (bvid, cookie, config, target) =>
      probeMediaWithBBDown(bvid, cookie, config, { target }),
    private readonly cacheCapacityProvider?: () => MediaProbeCacheCapacity | Promise<MediaProbeCacheCapacity>,
  ) {}

  start(user: BiliUser, bvid: string, target?: TargetMediaProfile) {
    this.prune();
    const normalized = String(bvid || "").trim();
    if (!/^BV[0-9A-Za-z]+$/.test(normalized)) throw new Error("BVID 无效");
    if (this.activeByUser.has(user.id)) throw new MediaProbeBusyError();
    const probeId = crypto.randomUUID();
    const result: MediaProbeResult = {
      probeId,
      bvid: normalized,
      status: "running",
      target: target?.strict ? { ...target } : undefined,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(probeId, result);
    this.activeByUser.add(user.id);
    const probeTarget = target?.strict
      ? { quality: target.quality, encoding: target.encoding }
      : undefined;
    void this.probeRunner(normalized, user.cookie, this.configStore.get(), probeTarget)
      .then(async (probe) => {
        const pages = probe.pages.map((page) => {
          const normalizedPage = normalizePage(page);
          return {
            ...normalizedPage,
            tracks: normalizedPage.tracks.map((track) => ({
              ...track,
              available: matchesStrictTarget(track, target),
            })),
          };
        });
        const combinationEntries = new Map<string, MediaProbeCombination>();
        for (const page of pages) {
          for (const track of page.tracks) {
            const key = combinationKey(track);
            if (!combinationEntries.has(key)) combinationEntries.set(key, track);
          }
        }
        const combinations = [...combinationEntries.entries()].map(([key, track]) => ({
          ...track,
          // A combination is usable only when every page exposes the same
          // target. This keeps a multi-P strict retry from looking available
          // because just its first page matched.
          available: pages.every((page) => page.tracks.some((candidate) => {
            const candidateKey = combinationKey(candidate);
            return candidateKey === key && candidate.available;
          })),
          resolution: (() => {
            const resolutions = new Set(pages.flatMap((page) => page.tracks
              .filter((candidate) => combinationKey(candidate) === key)
              .map((candidate) => String(candidate.resolution || "").trim())
              .filter(Boolean)));
            return resolutions.size > 1 ? "各分P不同" : [...resolutions][0] || track.resolution;
          })(),
        }));
        const selected = pages.map((page) => page.tracks.find((track) => track.available));
        const estimatedVideoBytes = selected.every((track) => positiveBytes(track?.estimatedBytes) > 0)
          ? selected.reduce((sum, track) => sum + positiveBytes(track?.estimatedBytes), 0)
          : 0;
        const hasV2AudioProof = pages.every((page) => page.version >= 2 && Object.prototype.hasOwnProperty.call(page, "selectedAudio"));
        const audioSizes = pages.map((page) => page.selectedAudio === null ? 0 : positiveBytes(page.selectedAudio?.estimatedBytes));
        const audioKnown = hasV2AudioProof && pages.every((page, index) => page.selectedAudio === null || audioSizes[index] > 0);
        const estimatedAudioBytes = audioKnown ? audioSizes.reduce((sum, bytes) => sum + bytes, 0) : 0;
        const estimatedFinalBytes = estimatedVideoBytes > 0 && audioKnown
          ? Math.ceil((estimatedVideoBytes + estimatedAudioBytes) * 1.01)
          : 0;
        const estimatedPeakBytes = estimatedFinalBytes > 0
          ? estimatedVideoBytes + estimatedAudioBytes + estimatedFinalBytes
          : 0;
        let capacity: MediaProbeCacheCapacity | undefined;
        try {
          capacity = await this.cacheCapacityProvider?.();
        } catch {
          // Capacity is advisory. A local cache inspection failure must not
          // discard otherwise valid media probe results.
        }
        const cacheAvailableBytes = capacity && capacity.limitBytes > 0
          ? Math.max(0, capacity.limitBytes - capacity.reserveBytes - capacity.usedBytes)
          : undefined;
        const estimatedBytesSource = mergeSizeSources([
          ...selected.map((track) => track?.sizeSource || "unknown"),
          ...(audioKnown ? pages
            .filter((page) => page.selectedAudio !== null)
            .map((page) => page.selectedAudio?.sizeSource || "unknown") : []),
        ]);
        Object.assign(result, {
          status: "complete",
          finishedAt: new Date().toISOString(),
          pages,
          combinations,
          estimatedVideoBytes: estimatedVideoBytes > 0 ? estimatedVideoBytes : undefined,
          estimatedAudioBytes: audioKnown ? estimatedAudioBytes : undefined,
          estimatedBytes: estimatedFinalBytes > 0 ? estimatedFinalBytes : estimatedVideoBytes || undefined,
          estimatedBytesKind: estimatedFinalBytes > 0 ? "final" : estimatedVideoBytes > 0 ? "video_only" : undefined,
          estimatedPeakBytes: estimatedPeakBytes || undefined,
          estimatedBytesSource,
          cacheAvailableBytes,
          cacheLimitBytes: capacity?.limitBytes || undefined,
        });
      })
      .catch((error) => Object.assign(result, { status: "failed", finishedAt: new Date().toISOString(), error: safeErrorSummary(error, "媒体探测失败") }))
      .finally(() => this.activeByUser.delete(user.id));
    return result;
  }

  get(probeId: string) {
    this.prune();
    return this.jobs.get(String(probeId || "")) || null;
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, result] of this.jobs) {
      if (Date.parse(result.finishedAt || result.createdAt) < cutoff) this.jobs.delete(id);
    }
  }
}
