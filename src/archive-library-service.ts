import {
  getArchiveLibraryItemDetail,
  getArchiveLibraryNavigation,
  getArchiveLibraryReferenceStats,
  getArchiveLibraryPlaybackQueue, getArchiveLibraryPlaybackSearch,
  queryArchiveLibraryItems,
  type ArchiveLibraryQuery
} from './archive-library.js';
import type { StateDatabase } from './database.js';
import type { BiliUser } from './users.js';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';

/** Resolve storage on each call so import rebind never leaves a stale connection in a route. */
export function createArchiveLibraryService(dependencies: { database(): StateDatabase; users(): BiliUser[]; now?(): number;
  artwork?: {folder(uid:number,mediaId:number):Promise<string|null>;avatar(uid:number,url:string):Promise<string|null>};
}) {
  type Navigation = ReturnType<typeof getArchiveLibraryNavigation>;
  type Stamp = { changes: number; data_version: number };
  const now = dependencies.now ?? (() => performance.now());
  let counters: { database: StateDatabase; statement: Database.Statement<[], Stamp> } | undefined;
  const cached = new Map<boolean,{ database: StateDatabase; stamp: Stamp; users: string; at: number; value: Navigation }>();
  function navigation(options: {includeReferenceStats?: boolean} = {}) {
    const includeReferenceStats = options.includeReferenceStats !== false;
    const database = dependencies.database();
    const users = dependencies.users();
    if (database.db.inTransaction) return getArchiveLibraryNavigation(database, users,options);
    if (counters?.database !== database) {
      counters = { database, statement: database.db.prepare<[], Stamp>('SELECT total_changes() AS changes, data_version FROM pragma_data_version') };
      cached.clear();
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
    const entry = cached.get(includeReferenceStats);
    const age = entry ? now() - entry.at : Infinity;
    if (entry?.database === database && entry.users === selection && same(entry.stamp, before) && age >= 0 && age < 30_000) {
      return structuredClone(entry.value);
    }
    const value = getArchiveLibraryNavigation(database, users,options);
    const after = stamp();
    if (same(before,after)) cached.set(includeReferenceStats,{database,users:selection,stamp:after,at:now(),value:structuredClone(value)});
    else cached.delete(includeReferenceStats);
    return value;
  }
  return {
    navigation,
    referenceStats: (query: Partial<ArchiveLibraryQuery>) => getArchiveLibraryReferenceStats(dependencies.database(),dependencies.users(),query),
    async artwork(userId:string,mediaId:number) {
      const database=dependencies.database();
      if(mediaId<=-2){
        const source=database.upSubscriptions.getByRoute(mediaId);
        if(!source||source.userId!==userId)return null;
        return source.avatar&&dependencies.artwork?dependencies.artwork.avatar(source.uid,source.avatar):null;
      }
      const users=dependencies.users();
      const user=users.find(candidate=>candidate.id===userId);
      const source=database.db.prepare<[string,number],{present:number}>(
        'SELECT EXISTS(SELECT 1 FROM favorite_relations WHERE user_id=? AND media_id=?) AS present'
      ).get(userId,mediaId);
      if(!source?.present&&!user?.favorites.some(folder=>folder.mediaId===mediaId))return null;
      const uid=user?.uid??database.db.prepare<[string],{uid:number}>('SELECT uid FROM archive_accounts WHERE user_id=?').get(userId)?.uid;
      return uid&&dependencies.artwork?dependencies.artwork.folder(uid,mediaId):null;
    },
    items: (query: Partial<ArchiveLibraryQuery>) => queryArchiveLibraryItems(dependencies.database(), dependencies.users(), query),
    detail: (query: Partial<ArchiveLibraryQuery>, bvid: string) => getArchiveLibraryItemDetail(dependencies.database(), dependencies.users(), query, bvid),
    playbackQueue: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackQueue>[3]) =>
      getArchiveLibraryPlaybackQueue(dependencies.database(), dependencies.users(), query, options),
    playbackSearch: (query: Partial<ArchiveLibraryQuery>, options: Parameters<typeof getArchiveLibraryPlaybackSearch>[3]) =>
      getArchiveLibraryPlaybackSearch(dependencies.database(), dependencies.users(), query, options),
  };
}
export type ArchiveLibraryPort = ReturnType<typeof createArchiveLibraryService>;
