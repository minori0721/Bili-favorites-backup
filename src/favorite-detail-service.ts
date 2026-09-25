import type { listFavoriteItemsPage, resolveSelfVisibleFavoriteItem } from './bili.js';
import { mergeLiveFavoriteDetailItem, selectFavoriteDetailSource } from './favorite-detail.js';
import type { StateManager, FolderDetailFilter } from './state.js';
import type { BiliUser } from './users.js';
type FavoritePage = Awaited<ReturnType<typeof listFavoriteItemsPage>>;
export function createFavoriteDetailService(deps: {
  state: Pick<StateManager, 'isProcessed' | 'isFailed' | 'recordFavoriteItem' | 'getExistingFolderScan' | 'listFolderItemsForUser' | 'getFolderIndexSummary' | 'getFolderItemForUser'>;
  listPage: typeof listFavoriteItemsPage;
  resolveVisible: typeof resolveSelfVisibleFavoriteItem;
  now(): number;
}) {
  const cache = new Map<string, {expiresAt: number; data: FavoritePage}>();
  const requests = new Map<string, Promise<FavoritePage>>();
  let generation = 0;
  function clear() { generation++; cache.clear(); requests.clear(); }
  function assertCurrent(expected: number) {
    if (expected !== generation) throw new Error('收藏页请求已失效，请重新加载');
  }
  function loadPage(user: BiliUser, mediaId: number, page: number, pageSize: number): Promise<FavoritePage> {
    const now = deps.now();
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
    const key = `${user.id}:${mediaId}:${page}:${pageSize}`;
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached.data);
    const pending = requests.get(key);
    if (pending) return pending;
    const expected = generation;
    const work = Promise.resolve().then(() => deps.listPage(user.cookie, mediaId, page, pageSize)).then(data => {
      assertCurrent(expected);
      cache.set(key, {expiresAt: deps.now() + 60_000, data});
      return data;
    }).finally(() => { if (requests.get(key) === work) requests.delete(key); });
    requests.set(key, work);
    return work;
  }
async function resolveFavoritePageSelfVisibleItems(
  user: BiliUser,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  const nextItems = [];
  for (const item of pageResult.items) {
    nextItems.push(await deps.resolveVisible(user.cookie, user.uid, item));
  }
  return {
    ...pageResult,
    items: nextItems,
  };
}

function markFavoriteItemProcessed(
  userId: string,
  mediaId: number,
  item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]
) {
  return {
    ...item,
    processed: deps.state.isProcessed(userId, item.bvid, mediaId),
    failed: deps.state.isFailed(userId, item.bvid, mediaId),
  };
}

function withProcessedStatus(
  userId: string,
  mediaId: number,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  return {
    ...pageResult,
    items: pageResult.items.map((item) => markFavoriteItemProcessed(userId, mediaId, item)),
  };
}

async function recordFavoritePageMetadata(
  user: BiliUser,
  mediaId: number,
  folderTitle: string,
  pageResult: Awaited<ReturnType<typeof listFavoriteItemsPage>>
) {
  const expected = generation;
  const resolvedPage = await resolveFavoritePageSelfVisibleItems(user, pageResult);
  assertCurrent(expected);
  resolvedPage.items.forEach((item, indexInPage) => {
    const favOrder = (Math.max(1, pageResult.page) - 1) * Math.max(1, pageResult.pageSize) + indexInPage + 1;
    deps.state.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
      favOrder,
      favPage: pageResult.page,
      favIndexInPage: indexInPage,
    });
  });
  return resolvedPage;
}

async function loadFavoriteDetailData(
  user: BiliUser,
  mediaId: number,
  folderTitle: string,
  page: number,
  pageSize: number,
  filter: FolderDetailFilter
) {
  const trackedFolder = user.favorites.find((favorite) => favorite.mediaId === mediaId);
  const tracked = Boolean(trackedFolder);
  const source = selectFavoriteDetailSource(tracked, filter);
  const resolvedFolderTitle = trackedFolder?.title || folderTitle;
  const scan = deps.state.getExistingFolderScan(user.id, mediaId);

  if (source === "state") {
    const offset = (page - 1) * pageSize;
    const result = deps.state.listFolderItemsForUser(user.id, mediaId, offset, pageSize, filter);
    const indexSummary = deps.state.getFolderIndexSummary(user.id, mediaId, scan?.total, result.summary);
    return {
      items: result.items,
      summary: result.summary,
      indexSummary,
      page,
      pageSize,
      hasMore: result.hasMore,
      total: result.totalFiltered,
      source,
      tracked,
      lastSyncedAt: scan?.lastScannedAt,
      coverage: indexSummary.complete ? "complete" : "partial",
    };
  }

  let pageResult = await loadPage(user, mediaId, page, pageSize);

  pageResult = await recordFavoritePageMetadata(user, mediaId, resolvedFolderTitle, pageResult);
  const items = pageResult.items.map((item) => mergeLiveFavoriteDetailItem(
    item,
    deps.state.getFolderItemForUser(user.id, mediaId, item.bvid),
    { mediaId, folderTitle: resolvedFolderTitle }
  ));
  const indexed = deps.state.listFolderItemsForUser(user.id, mediaId, 0, 1, "all");
  const indexSummary = deps.state.getFolderIndexSummary(user.id, mediaId, pageResult.total, indexed.summary);
  return {
    items,
    summary: {
      ...indexed.summary,
      total: pageResult.total ?? indexed.summary.activeTotal,
    },
    indexSummary,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
    hasMore: pageResult.hasMore,
    total: pageResult.total ?? items.length,
    source,
    tracked,
    lastSyncedAt: scan?.lastScannedAt,
    coverage: "live" as const,
  };
}

return {clear, detail: loadFavoriteDetailData,
  async items(user: BiliUser, mediaId: number, page: number) {
    return withProcessedStatus(user.id, mediaId, await loadPage(user, mediaId, page, 20));
  },
};
}
