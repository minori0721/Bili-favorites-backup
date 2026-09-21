import type { VideoArchiveEntry, FavoriteRelation, RemoteFilePreviewVideoRecord } from './state.js';
export function projectRemoteFilePreviews(videos: Iterable<VideoArchiveEntry>, relations: Iterable<FavoriteRelation>): RemoteFilePreviewVideoRecord[] {
    const records = new Map<string, RemoteFilePreviewVideoRecord>();
    for (const entry of videos) {
      records.set(entry.bvid, {
        bvid: entry.bvid,
        title: entry.title,
        upperName: entry.upperName,
        remotePath: entry.remotePath,
        remoteFiles: [...(entry.remoteFiles || [])],
        relations: [],
      });
    }
    for (const relation of relations) {
      if (!relation.activeInFavorite) continue;
      const record = records.get(relation.bvid);
      if (!record) continue;
      record.relations.push({
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: relation.folderTitle,
        backupStatus: relation.backupStatus,
        hasInterruptedQualityUpgrade: Boolean(relation.qualityUpgrade),
        remotePath: relation.remotePath,
        remoteFiles: [...(relation.remoteFiles || [])],
      });
      records.set(relation.bvid, record);
    }
    return Array.from(records.values());
}
