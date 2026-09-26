import type { listFavoriteItemsPage, resolveSelfVisibleFavoriteItem } from './bili.js';
import { mergeLiveFavoriteDetailItem, selectFavoriteDetailSource } from './favorite-detail.js';
import type { StateManager, FolderDetailFilter } from './state.js';
import type { BiliUser } from './users.js';
type FavoritePage = Awaited<ReturnType<typeof listFavoriteItemsPage>>;
type RequestContext = {
  userId: string;
  uid: number;
  cookie: BiliUser['cookie'];
  credentialId: number;
  generation: number;
};
export function createFavoriteDetailService(deps: {
  state: Pick<StateManager, 'isProcessed' | 'isFailed' | 'recordFavoriteItem' | 'getExistingFolderScan' | 'listFolderItemsForUser' | 'getFolderIndexSummary' | 'getFolderItemForUser'>;
  listPage: typeof listFavoriteItemsPage;
  resolveVisible: typeof resolveSelfVisibleFavoriteItem;
  currentUser(userId: string): BiliUser | null;
  now(): number;
}) {
  const cache = new Map<string, {expiresAt: number; data: FavoritePage}>();
  const requests = new Map<string, Promise<FavoritePage>>();
  const metadataRequests = new Map<string, Promise<FavoritePage>>();
  // UserStore replaces the cookie object on refresh or login; keep credential values out of cache keys.
  const credentialIds = new WeakMap<BiliUser['cookie'], number>();
  let nextCredentialId = 0;
  let generation = 0;
  function clear() { generation++; cache.clear(); requests.clear(); metadataRequests.clear(); }
  function contextFor(user: BiliUser): RequestContext {
    const cookie = user.cookie;
    let credentialId = credentialIds.get(cookie);
    if (credentialId === undefined) {
      credentialId = ++nextCredentialId;
      credentialIds.set(cookie, credentialId);
    }
    return {userId: user.id, uid: user.uid, cookie, credentialId, generation};
  }
  function assertCurrent(context: RequestContext) {
    if (context.generation !== generation || deps.currentUser(context.userId)?.cookie !== context.cookie) {
      throw new Error('收藏页请求已失效，请重新加载');
    }
  }
  function loadPage(context: RequestContext, mediaId: number, page: number, pageSize: number): Promise<FavoritePage> {
    assertCurrent(context);
    const now = deps.now();
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
    const key = JSON.stringify([context.userId, context.credentialId, mediaId, page, pageSize]);
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached.data);
    const pending = requests.get(key);
    if (pending) return pending;
    const work = Promise.resolve().then(() => deps.listPage(context.cookie, mediaId, page, pageSize)).then(data => {
      assertCurrent(context);
      cache.set(key, {expiresAt: deps.now() + 60_000, data});
      return data;
    }).finally(() => { if (requests.get(key) === work) requests.delete(key); });
    requests.set(key, work);
    return work;
  }
async function resolveFavoritePageSelfVisibleItems(
  context: RequestContext,
  pageResult: FavoritePage
) {
  const nextItems = [];
  for (const item of pageResult.items) {
    assertCurrent(context);
    nextItems.push(await deps.resolveVisible(context.cookie, context.uid, item));
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
  context: RequestContext,
  mediaId: number,
  folderTitle: string,
  pageResult: FavoritePage
) {
  const resolvedPage = await resolveFavoritePageSelfVisibleItems(context, pageResult);
  assertCurrent(context);
  resolvedPage.items.forEach((item, indexInPage) => {
    const favOrder = (Math.max(1, pageResult.page) - 1) * Math.max(1, pageResult.pageSize) + indexInPage + 1;
    deps.state.recordFavoriteItem(context.userId, mediaId, folderTitle, item, {
      favOrder,
      favPage: pageResult.page,
      favIndexInPage: indexInPage,
    });
  });
  return resolvedPage;
}
function loadRecordedPage(context: RequestContext, mediaId: number, folderTitle: string, page: number, pageSize: number) {
  assertCurrent(context);
  const key = JSON.stringify([context.userId, context.credentialId, mediaId, page, pageSize, folderTitle]);
  const pending = metadataRequests.get(key);
  if (pending) return pending;
  const work = Promise.resolve().then(async () => {
    const pageResult = await loadPage(context, mediaId, page, pageSize);
    assertCurrent(context);
    return recordFavoritePageMetadata(context, mediaId, folderTitle, pageResult);
  }).finally(() => { if (metadataRequests.get(key) === work) metadataRequests.delete(key); });
  metadataRequests.set(key, work);
  return work;
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

  const context = contextFor(user);
  const pageResult = await loadRecordedPage(context, mediaId, resolvedFolderTitle, page, pageSize);
  assertCurrent(context);
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
    const context = contextFor(user);
    const pageResult = await loadPage(context, mediaId, page, 20);
    assertCurrent(context);
    return withProcessedStatus(user.id, mediaId, pageResult);
  },
};
}
