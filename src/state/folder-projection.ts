import type { FavoriteRelation, VideoArchiveEntry, FolderDetailItem } from '../state.js';
import { playbackAvailability } from '../playback.js';
import { BACKED_UP_STATUSES, archivedSourceUnavailable, relationTreatsUnavailable, displayTitle, displayUpperName, displayCover, displayCoverLocalPath, displayDescription } from './archive-rules.js';

export function projectFolderDetailItem(relation: FavoriteRelation, video: VideoArchiveEntry, failed: boolean): FolderDetailItem {
  const backupStatus = relation.backupStatus || video.backupStatus;
  return {
    archivedSourceUnavailable: archivedSourceUnavailable(relation, video),
    bvid: video.bvid,
    title: displayTitle(video),
    upperName: displayUpperName(video),
    cover: displayCover(video),
    coverLocalPath: displayCoverLocalPath(video),
    description: displayDescription(video),
    favoriteUnavailable: relation.favoriteUnavailable || video.favoriteUnavailable,
    selfVisible: relation.selfVisible || video.selfVisible,
    sourceAvailability: video.sourceAvailability,
    favOrder: relation.favOrder,
    favPage: relation.favPage,
    favIndexInPage: relation.favIndexInPage,
    unavailable: relationTreatsUnavailable(relation, video),
    processed: BACKED_UP_STATUSES.has(backupStatus),
    failed,
    backupStatus,
    mediaId: relation.mediaId,
    folderTitle: relation.folderTitle,
    lastSeenAt: relation.lastSeenAt,
    activeInFavorite: relation.activeInFavorite,
    accessRestriction: video.accessRestriction,
    playback: playbackAvailability(backupStatus, relation.remoteFiles || video.remoteFiles),
  };
}
