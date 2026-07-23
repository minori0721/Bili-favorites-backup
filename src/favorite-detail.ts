import type { FavoriteItem } from "./bili.js";
import type { FolderDetailFilter, FolderDetailItem } from "./state.js";

export type FavoriteDetailSource = "state" | "bili";
export type FavoriteDetailCoverage = "complete" | "partial" | "live";

const PLACEHOLDER_TITLES = /^(Untitled|Unknown|已失效视频|已删除视频|视频已失效|视频不存在)$/i;
const PLACEHOLDER_UPPERS = /^(Unknown|未知UP|未知)$/i;

function hasUsableText(value: unknown, placeholders: RegExp) {
  const text = String(value || "").trim();
  return Boolean(text) && !placeholders.test(text);
}

export function selectFavoriteDetailSource(tracked: boolean, filter: FolderDetailFilter): FavoriteDetailSource {
  return tracked || filter !== "all" ? "state" : "bili";
}

export function mergeLiveFavoriteDetailItem(
  live: FavoriteItem,
  stored: FolderDetailItem | null,
  context: { mediaId: number; folderTitle: string; observedAt?: string }
): FolderDetailItem {
  const liveUnavailable = Boolean(live.favoriteUnavailable || live.unavailable) && !live.selfVisible;
  const liveTitleUsable = hasUsableText(live.title, PLACEHOLDER_TITLES);
  const liveUpperUsable = hasUsableText(live.upperName, PLACEHOLDER_UPPERS);
  const useStoredTitle = liveUnavailable || !liveTitleUsable;
  const useStoredUpper = liveUnavailable || !liveUpperUsable;
  const observedAt = context.observedAt || new Date().toISOString();
  const favoriteUnavailable = live.favoriteUnavailable ?? live.unavailable ?? stored?.favoriteUnavailable;
  const selfVisible = live.selfVisible ?? stored?.selfVisible;

  return {
    bvid: live.bvid,
    title: useStoredTitle ? stored?.title || (liveTitleUsable ? live.title : live.bvid) : live.title,
    upperName: useStoredUpper ? stored?.upperName || (liveUpperUsable ? live.upperName : "Unknown") : live.upperName,
    cover: liveUnavailable || !live.cover ? stored?.cover || live.cover : live.cover,
    coverLocalPath: stored?.coverLocalPath,
    description: live.description || stored?.description,
    favoriteUnavailable,
    selfVisible,
    favOrder: stored?.favOrder,
    favPage: stored?.favPage,
    favIndexInPage: stored?.favIndexInPage,
    unavailable: liveUnavailable,
    processed: stored?.processed || false,
    failed: stored?.failed || false,
    backupStatus: stored?.backupStatus || "discovered",
    mediaId: stored?.mediaId || context.mediaId,
    folderTitle: stored?.folderTitle || context.folderTitle,
    lastSeenAt: stored?.lastSeenAt || observedAt,
    activeInFavorite: stored?.activeInFavorite ?? true,
    accessRestriction: stored?.accessRestriction,
  };
}
