import type { AppConfig, ConfigStore } from '../config.js';
import { MANUAL_ARCHIVE_MEDIA_ID, type FavoriteRelation, type StateManager } from '../state.js';
import type { UploadTarget } from '../tasks.js';
import type { BiliUser, UserStore } from '../users.js';
import { resolveRemotePath } from '../uploader.js';
import { sanitizeSegment } from '../utils.js';

interface Dependencies {
  config: Pick<ConfigStore, 'get'>;
  state: Pick<StateManager, 'listRelationsForBvid'>;
  users: Pick<UserStore, 'getById'>;
  eligible(user: BiliUser | null | undefined): user is BiliUser;
  sourceBlocked(userId: string, mediaId: number, bvid: string): boolean;
}

/** Resolves archive sources without scheduling work or retaining database connections. */
export function createArchiveTargets(deps: Dependencies) {
  function collectUploadTargets(bvid: string, fallback: UploadTarget[] = []) {
    const config: AppConfig = deps.config.get();
    const targets = new Map<string, UploadTarget>();
    for (const target of fallback) {
      if (deps.sourceBlocked(target.userId, target.mediaId, bvid)) continue;
      targets.set(`${target.userId}:${target.mediaId}`, target);
    }
    for (const relation of deps.state.listRelationsForBvid(bvid)) {
      if (["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || "")) continue;
      if (deps.sourceBlocked(relation.userId, relation.mediaId, bvid)) continue;
      const resolved = resolveRelation(relation);
      if (!resolved) continue;
      targets.set(`${relation.userId}:${relation.mediaId}`, {
        userId: relation.userId,
        mediaId: relation.mediaId,
        folderTitle: resolved.folderTitle,
        remotePath: relation.remotePath || resolveRemotePath({
          destination: config.alistDest,
          layout: config.uploadLayout,
          userName: resolved.user.name,
          folderName: resolved.folderTitle,
        }),
      });
    }
    return [...targets.values()];
  }

  function resolveRelation(relation: FavoriteRelation) {
    const user = deps.users.getById(relation.userId);
    if (!deps.eligible(user)) return null;
    const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
    return {
      user,
      mediaId: folder?.mediaId ?? relation.mediaId,
      folderTitle: folder?.title ?? relation.folderTitle,
    };
  }

  function resolveRelationRemotePath(
    user: BiliUser,
    mediaId: number,
    folderTitle: string,
    config: AppConfig = deps.config.get()
  ) {
    const folderName = mediaId === MANUAL_ARCHIVE_MEDIA_ID
      ? `__BFB_MANUAL_${sanitizeSegment(String(user.uid || user.cookie?.DedeUserID || user.id)).slice(0, 48) || "ACCOUNT"}`
      : folderTitle;
    return resolveRemotePath({
      destination: config.alistDest,
      layout: config.uploadLayout,
      userName: user.name,
      folderName,
    });
  }

  function findBestRelationForBvid(bvid: string) {
    const relations = deps.state.listRelationsForBvid(bvid);
    for (const relation of relations) {
      const user = deps.users.getById(relation.userId);
      if (!deps.eligible(user)) continue;
      const folder = user.favorites.find((item) => item.mediaId === relation.mediaId);
      return {
        user,
        mediaId: folder?.mediaId ?? relation.mediaId,
        folderTitle: folder?.title ?? relation.folderTitle,
      };
    }
    return null;
  }

  return { collectUploadTargets, resolveRelation, resolveRelationRemotePath, findBestRelationForBvid };
}
