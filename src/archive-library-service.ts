import {
  getArchiveLibraryItemDetail,
  getArchiveLibraryNavigation,
  getArchiveLibraryPlaybackQueue, getArchiveLibraryPlaybackSearch,
  queryArchiveLibraryItems,
  type ArchiveLibraryQuery
} from './archive-library.js';
import type { StateDatabase } from './database.js';
import type { BiliUser } from './users.js';

/** Resolve storage on each call so import rebind never leaves a stale connection in a route. */
export function createArchiveLibraryService(dependencies: { database(): StateDatabase; users(): BiliUser[] }) {
  return {
    navigation: () => getArchiveLibraryNavigation(dependencies.database(), dependencies.users()),
    items: (query: Partial<ArchiveLibraryQuery>) => queryArchiveLibraryItems(dependencies.database(), dependencies.users(), query),
    detail: (query: Partial<ArchiveLibraryQuery>, bvid: string) => getArchiveLibraryItemDetail(dependencies.database(), dependencies.users(), query, bvid),
    playbackQueue: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackQueue>[3]) =>
      getArchiveLibraryPlaybackQueue(dependencies.database(), dependencies.users(), query, options),
    playbackSearch: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackSearch>[3]) =>
      getArchiveLibraryPlaybackSearch(dependencies.database(), dependencies.users(), query, options),
  };
}
export type ArchiveLibraryPort = ReturnType<typeof createArchiveLibraryService>;
