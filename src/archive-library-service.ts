import {
  getArchiveLibraryItemDetail,
  getArchiveLibraryNavigation,
  getArchiveLibraryPlaybackQueue, getArchiveLibraryPlaybackSearch,
  queryArchiveLibraryItems,
  type ArchiveLibraryQuery
} from './archive-library.js';
import type { StateDatabase } from './database.js';
import type { BiliUser } from './users.js';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';

/** Resolve storage on each call so import rebind never leaves a stale connection in a route. */
export function createArchiveLibraryService(dependencies: { database(): StateDatabase; users(): BiliUser[]; now?(): number }) {
  type Navigation = ReturnType<typeof getArchiveLibraryNavigation>;
  type Stamp = { changes: number; data_version: number };
  const now = dependencies.now ?? (() => performance.now());
  let counters: { database: StateDatabase; statement: Database.Statement<[], Stamp> } | undefined;
  let cached: { database: StateDatabase; stamp: Stamp; users: string; at: number; value: Navigation } | undefined;
  function navigation() {
    const database = dependencies.database();
    const users = dependencies.users();
    if (database.db.inTransaction) return getArchiveLibraryNavigation(database, users);
    if (counters?.database !== database) {
      counters = { database, statement: database.db.prepare<[], Stamp>('SELECT total_changes() AS changes, data_version FROM pragma_data_version') };
      cached = undefined;
    }
    const statement = counters.statement;
    const stamp = (): Stamp => {
      const row = statement.get();
      if (!row || !Number.isSafeInteger(row.changes) || !Number.isSafeInteger(row.data_version)) throw new Error('Invalid archive navigation change counters');
      return row;
    };
    const same = (a: Stamp, b: Stamp) => a.changes === b.changes && a.data_version === b.data_version;
    const selection = JSON.stringify(users.map(({ id, uid, name, avatar, enabled, favorites }) =>
      ({ id, uid, name, avatar, enabled, favorites: favorites.map(({mediaId, title}) => ({mediaId, title})) })));
    const before = stamp();
    const age = cached ? now() - cached.at : Infinity;
    if (cached?.database === database && cached.users === selection && same(cached.stamp, before) && age >= 0 && age < 30_000) {
      return structuredClone(cached.value);
    }
    const value = getArchiveLibraryNavigation(database, users);
    const after = stamp();
    cached = same(before, after) ? { database, users: selection, stamp: after, at: now(), value: structuredClone(value) } : undefined;
    return value;
  }
  return {
    navigation,
    items: (query: Partial<ArchiveLibraryQuery>) => queryArchiveLibraryItems(dependencies.database(), dependencies.users(), query),
    detail: (query: Partial<ArchiveLibraryQuery>, bvid: string) => getArchiveLibraryItemDetail(dependencies.database(), dependencies.users(), query, bvid),
    playbackQueue: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackQueue>[3]) =>
      getArchiveLibraryPlaybackQueue(dependencies.database(), dependencies.users(), query, options),
    playbackSearch: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackSearch>[3]) =>
      getArchiveLibraryPlaybackSearch(dependencies.database(), dependencies.users(), query, options),
  };
}
export type ArchiveLibraryPort = ReturnType<typeof createArchiveLibraryService>;
