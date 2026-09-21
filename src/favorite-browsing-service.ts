import type { listFavoriteFolders } from './bili.js';
import { getBiliListErrorMessage } from './favorite-errors.js';
import type { FavoriteFolderListCache } from './favorite-folder-cache.js';
import type { FavoriteFolderCoverService } from './favorite-folder-cover.js';
import type { UserStore, BiliUser } from './users.js';
export function createFavoriteBrowsing(deps: {
  folders: Pick<FavoriteFolderListCache, 'get' | 'peek' | 'set'>;
  users: Pick<UserStore, 'getById' | 'updateFavorites'>;
  load: typeof listFavoriteFolders;
  covers: Pick<FavoriteFolderCoverService, 'resolve'>;
}) {
  return {
    async select(userId: string, input: unknown) {
  const user = deps.users.getById(userId);
  if (!user) {
    return {status: 404, body: { success: false, message: "User not found" }};
  }
  const mediaIds = Array.isArray(input)
    ? input
        .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0)
    : [];
  let folders;
  try {
    folders = await deps.load(user.cookie);
  } catch (error) {
    return {status: 502, body: { success: false, message: getBiliListErrorMessage(error) }};
  }
  const selected = folders.filter((folder) => mediaIds.includes(folder.mediaId));
  deps.users.updateFavorites(user.id, selected.map((folder) => ({ mediaId: folder.mediaId, title: folder.title })));
  deps.folders.set(user, folders);
  return {status: 200, body: { success: true, data: selected }};
    },
    async folders(user: BiliUser) {
      const folders = await deps.folders.get(user);
      const selected = new Set(user.favorites.map(folder => folder.mediaId));
      return folders.map(folder => ({...folder, selected: selected.has(folder.mediaId)}));
    },
    cover(user: BiliUser, mediaId: number) {
      return deps.covers.resolve(user, mediaId, deps.folders.peek(user.id, mediaId)?.cover);
    },
  };
}
