import type { BiliUser, UserStore } from '../users.js';
import type { StateManager, SourceAvailabilityReason } from '../state.js';
import { BiliRiskOrLoginError, type listFavoriteItemsPage, type refreshUserAuth, type resolveSelfVisibleFavoriteItem } from '../bili.js';
import type { queueCoverCache } from '../cover-cache.js';
import { isAuthRefreshAttemptBlocked, nextAuthRefreshFailureState } from '../auth-refresh.js';
import { safeErrorSummary } from '../diagnostics.js';
import { logManager } from '../logger.js';
import { availabilityJitter } from './retry-policy.js';
interface ScanDependencies {
    state: Pick<StateManager, 'getRelationStatus' | 'updateFolderScan' | 'markMissingFavoritesInactive' | 'getFolderScan' | 'recordFavoriteItem' | 'recordCoverCache' | 'getSourceAvailability' | 'listRelationsForBvid' | 'markAvailabilityPending'>;
    deletions: {
        folder(userId: string, mediaId: number): boolean;
        source(userId: string, mediaId: number, bvid: string): boolean;
    };
    users: Pick<UserStore, 'getById' | 'updatePartial'>;
    now(): number;
    random(): number;
    sleep(milliseconds: number): Promise<void>;
    generation(): number;
    canRun(): boolean;
    listPage: typeof listFavoriteItemsPage;
    refreshAuth: typeof refreshUserAuth;
    resolveSelfVisible: typeof resolveSelfVisibleFavoriteItem;
    cacheCover: typeof queueCoverCache;
    progress(patch: {
        mode?: string;
        title?: string;
        userName?: string;
        folderTitle?: string;
        mediaId?: number;
        detail?: string;
        page?: number;
        pageSize?: number;
        biliTotal?: number;
        indexed?: number;
    }): void;
    recordCount(newItems: number, queuedItems: number): void;
    probe(bvid: string, options: {
        preferredUserId: string;
        notBefore: number;
        availabilityRound?: number;
        availabilityReason?: SourceAvailabilityReason;
    }): unknown;
    enqueue(user: BiliUser, mediaId: number, folderTitle: string, bvid: string): boolean;
}

export interface FavoriteScanPort {
  all(user: BiliUser, mediaId: number, folderTitle: string): Promise<void>;
  hot(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean): Promise<number>;
  history(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean, startAfterPage?: number): Promise<void>;
}
/** Owns scan policy and observations; admission, persistent enqueue and progress belong to scheduling control. */
export function createFavoriteScan(deps: ScanDependencies): FavoriteScanPort & { reset(): void } {
    let epoch = 0;
    function checkpoint() {
        const currentEpoch = epoch;
        const generation = deps.generation();
        const current = () => currentEpoch === epoch && generation === deps.generation() && deps.canRun();
        return Object.assign(() => { if (!current())
            throw new Error('Favorite scan interrupted by lifecycle change'); }, { current });
    }
    const hotScanMinPages = 3;
    const hotScanMaxPages = 12;
    const hotScanBurstBudget = 3;
    const historyPagesPerTick = 2;
    const initialHistoryPagesPerTick = 12;
    const manualHistoryPagesPerTick = 20;
    const selfVisibleProbeCache = new Map<string, {
        expiresAt: number;
        item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number];
    }>();
    async function listFavoriteItemsPageWithAuthRetry(user: BiliUser, mediaId: number, page: number, pageSize: number) {
        const assertCurrent = checkpoint();
        assertCurrent();
        try {
            const result = await deps.listPage(user.cookie, mediaId, page, pageSize);
            assertCurrent();
            return result;
        }
        catch (error: unknown) {
            assertCurrent();
            if (!(error instanceof BiliRiskOrLoginError)) {
                throw error;
            }
            if (!user.accessToken || !user.refreshToken) {
                throw error;
            }
            if (isAuthRefreshAttemptBlocked(user.authRefreshFailureCategory, user.authRefreshFailureAttempts, user.authRefreshRetryAt, deps.now())) {
                throw error;
            }
            let refreshed;
            try {
                refreshed = await deps.refreshAuth(user.accessToken, user.refreshToken);
                assertCurrent();
            }
            catch (refreshError: unknown) {
                assertCurrent();
                const current = deps.users.getById(user.id) || user;
                const failure = nextAuthRefreshFailureState(current.authRefreshFailureCategory, current.authRefreshFailureAttempts, refreshError, deps.now());
                deps.users.updatePartial(user.id, {
                    lastAuthRefreshError: safeErrorSummary(refreshError),
                    authRefreshFailureCategory: failure.category,
                    authRefreshFailureAttempts: failure.attempts,
                    authRefreshRetryAt: failure.retryAt,
                });
                throw error;
            }
            try {
                const updated = deps.users.updatePartial(user.id, {
                    cookie: refreshed.cookie,
                    rawAuth: refreshed.rawAuth,
                    accessToken: refreshed.accessToken || user.accessToken,
                    refreshToken: refreshed.refreshToken || user.refreshToken,
                    expires: refreshed.expires || user.expires,
                    lastAuthRefreshAt: new Date(deps.now()).toISOString(),
                    lastAuthRefreshError: "",
                    authRefreshFailureCategory: undefined,
                    authRefreshFailureAttempts: undefined,
                    authRefreshRetryAt: undefined,
                });
                if (!updated) {
                    throw error;
                }
                user.cookie = updated.cookie;
                user.accessToken = updated.accessToken;
                user.refreshToken = updated.refreshToken;
                user.expires = updated.expires;
                console.warn(`[Scheduler] Refreshed auth for ${user.name} after login/risk error; retrying page ${page}.`);
                const result = await deps.listPage(user.cookie, mediaId, page, pageSize);
                assertCurrent();
                return result;
            }
            catch (retryError: unknown) {
                // A refreshed token can still be rejected by the specific page request;
                // let the normal Bilibili risk/login cooldown handle that without
                // falsely recording a token-refresh failure.
                if (retryError instanceof BiliRiskOrLoginError)
                    throw retryError;
                throw error;
            }
        }
    }
    function selfVisibleProbeKey(userId: string, bvid: string) {
        return `${userId}:${bvid}`;
    }
    async function resolveSelfVisibleItemForSync(user: BiliUser, mediaId: number, item: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"][number]) {
        const assertCurrent = checkpoint();
        assertCurrent();
        if (!item.unavailable || !user.uid || Number(item.upperMid || 0) !== Number(user.uid)) {
            return item;
        }
        const key = selfVisibleProbeKey(user.id, item.bvid);
        if (selfVisibleProbeCache.size > 500) {
            const now = deps.now();
            for (const [cacheKey, value] of selfVisibleProbeCache) {
                if (value.expiresAt <= now)
                    selfVisibleProbeCache.delete(cacheKey);
            }
        }
        const cached = selfVisibleProbeCache.get(key);
        if (cached && cached.expiresAt > deps.now()) {
            return cached.item;
        }
        const previousRelation = deps.state.getRelationStatus(user.id, mediaId, item.bvid);
        const wasSelfVisible = previousRelation?.selfVisible === true;
        const resolved = await deps.resolveSelfVisible(user.cookie, user.uid, item);
        assertCurrent();
        selfVisibleProbeCache.set(key, {
            expiresAt: deps.now() + 10 * 60000,
            item: resolved,
        });
        if (resolved.selfVisible && !wasSelfVisible) {
            logManager.push({
                timestamp: new Date(deps.now()).toISOString(),
                type: "system",
                level: "info",
                summary: `自稿件失效项已恢复详情 ${item.bvid}`,
                raw: `[SelfVisible] ${user.name}/${item.bvid} resolved from favorite-unavailable to self-visible`,
                bvid: item.bvid,
                simpleVisible: true,
                debugVisible: true,
            });
        }
        return resolved;
    }
    async function scanAllPages(user: BiliUser, mediaId: number, folderTitle: string) {
        const assertCurrent = checkpoint();
        assertCurrent();
        deps.progress({
            mode: "reconcile",
            title: "全量扫描并对账",
            userName: user.name,
            folderTitle,
            mediaId,
            page: 1,
            detail: "正在全量扫描 B 站收藏夹。",
        });
        let page = 1;
        const scanStartedAt = new Date(deps.now()).toISOString();
        const seenBvids = new Set<string>();
        let lastTotal: number | undefined;
        deps.state.updateFolderScan(user.id, mediaId, {
            folderTitle,
            initStatus: "initializing",
            lastHotScanAt: scanStartedAt,
            lastHistoryScanAt: scanStartedAt,
        });
        while (true) {
            const result = await listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
            assertCurrent();
            lastTotal = result.total;
            deps.progress({
                userName: user.name,
                folderTitle,
                mediaId,
                page,
                pageSize: 20,
                indexed: seenBvids.size + result.items.length,
                biliTotal: result.total,
                detail: `正在全量扫描第 ${page} 页。`,
            });
            await recordPage(user, mediaId, folderTitle, result.items, page, 20, scanStartedAt, seenBvids);
            assertCurrent();
            deps.state.updateFolderScan(user.id, mediaId, {
                folderTitle,
                initStatus: "initializing",
                nextHistoryPage: page + 1,
                catchupPage: 1,
                lastHotScanAt: scanStartedAt,
                lastHistoryScanAt: scanStartedAt,
                total: result.total,
            });
            if (!result.hasMore || result.items.length === 0) {
                break;
            }
            page += 1;
            await deps.sleep(1000 + Math.floor(deps.random() * 2000));
            assertCurrent();
        }
        deps.state.updateFolderScan(user.id, mediaId, {
            folderTitle,
            initStatus: "complete",
            nextHistoryPage: 1,
            catchupPage: 1,
            lastHotScanAt: scanStartedAt,
            lastHistoryScanAt: scanStartedAt,
            total: lastTotal,
        });
        if (!deps.deletions.folder(user.id, mediaId)) {
            deps.state.markMissingFavoritesInactive(user.id, mediaId, seenBvids);
        }
    }
    async function scanHotPages(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean) {
        const assertCurrent = checkpoint();
        assertCurrent();
        deps.progress({
            mode: manual ? "manual" : "auto",
            title: manual ? "立即同步" : "自动同步",
            userName: user.name,
            folderTitle,
            mediaId,
            detail: "正在扫描收藏夹近期页面。",
        });
        let consecutiveKnownPages = 0;
        let burstBudget = 0;
        const minPages = manual ? 10 : hotScanMinPages;
        const maxPages = manual ? 40 : hotScanMaxPages;
        let lastPage = 0;
        for (let page = 1; page <= maxPages; page += 1) {
            const result = await listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
            assertCurrent();
            deps.progress({
                userName: user.name,
                folderTitle,
                mediaId,
                page,
                pageSize: 20,
                biliTotal: result.total,
                detail: `正在扫描近期第 ${page} 页。`,
            });
            const pageStats = await recordPage(user, mediaId, folderTitle, result.items, page, 20);
            assertCurrent();
            lastPage = page;
            const previousScan = deps.state.getFolderScan(user.id, mediaId, folderTitle);
            deps.state.updateFolderScan(user.id, mediaId, {
                folderTitle,
                initStatus: previousScan.initStatus === "complete" ? "complete" : "initializing",
                lastHotScanAt: new Date(deps.now()).toISOString(),
                total: result.total,
            });
            if (pageStats.newItems === 0) {
                consecutiveKnownPages += 1;
                if (burstBudget > 0) {
                    burstBudget -= 1;
                }
            }
            else {
                consecutiveKnownPages = 0;
                burstBudget = hotScanBurstBudget;
            }
            const canStopForKnownPages = page >= minPages && consecutiveKnownPages >= 2 && burstBudget === 0;
            if (!result.hasMore || canStopForKnownPages) {
                break;
            }
            await deps.sleep(1000 + Math.floor(deps.random() * 2000));
            assertCurrent();
        }
        return lastPage;
    }
    async function scanHistoryPages(user: BiliUser, mediaId: number, folderTitle: string, manual: boolean, startAfterPage = 0) {
        const assertCurrent = checkpoint();
        assertCurrent();
        deps.progress({
            userName: user.name,
            folderTitle,
            mediaId,
            detail: "正在补扫收藏夹历史页面。",
        });
        const scan = deps.state.getFolderScan(user.id, mediaId, folderTitle);
        const hasKnownTotal = typeof scan.total === "number" && scan.total > 0;
        const totalPages = hasKnownTotal ? Math.max(1, Math.ceil((scan.total || 0) / 20)) : null;
        const historyLoopPage = totalPages ? Math.max(startAfterPage + 1, totalPages) : Math.max(startAfterPage + 1, 1);
        const inCatchupMode = scan.initStatus === "complete" && !manual && totalPages !== null && totalPages > startAfterPage;
        let page = inCatchupMode
            ? Math.max(scan.catchupPage || 1, 1)
            : Math.max(scan.nextHistoryPage || 1, startAfterPage + 1, 1);
        const pagesThisRun = inCatchupMode
            ? historyPagesPerTick
            : (manual ? manualHistoryPagesPerTick : initialHistoryPagesPerTick);
        for (let i = 0; i < pagesThisRun; i += 1) {
            const result = await listFavoriteItemsPageWithAuthRetry(user, mediaId, page, 20);
            assertCurrent();
            deps.progress({
                userName: user.name,
                folderTitle,
                mediaId,
                page,
                pageSize: 20,
                biliTotal: result.total,
                detail: `正在补扫历史第 ${page} 页。`,
            });
            await recordPage(user, mediaId, folderTitle, result.items, page, 20);
            assertCurrent();
            if (!result.hasMore || result.items.length === 0) {
                const completeWithoutTotal = !manual && !totalPages && page > Math.max(startAfterPage + 1, 1);
                deps.state.updateFolderScan(user.id, mediaId, {
                    folderTitle,
                    initStatus: totalPages || completeWithoutTotal ? "complete" : "initializing",
                    nextHistoryPage: totalPages ? 1 : page + 1,
                    catchupPage: 1,
                    lastHistoryScanAt: new Date(deps.now()).toISOString(),
                    total: result.total,
                });
                break;
            }
            page += 1;
            let nextCatchupPage = inCatchupMode ? page : (scan.catchupPage || 1);
            if (inCatchupMode && totalPages) {
                nextCatchupPage = page > historyLoopPage ? 1 : page;
            }
            const hasCompletedInitialScan = Boolean(totalPages && page > totalPages);
            deps.state.updateFolderScan(user.id, mediaId, {
                folderTitle,
                initStatus: totalPages ? (inCatchupMode || hasCompletedInitialScan ? "complete" : "initializing") : "initializing",
                nextHistoryPage: inCatchupMode ? (scan.nextHistoryPage || 1) : (hasCompletedInitialScan ? 1 : page),
                catchupPage: nextCatchupPage,
                lastHistoryScanAt: new Date(deps.now()).toISOString(),
                total: result.total,
            });
            await deps.sleep(1000 + Math.floor(deps.random() * 2000));
            assertCurrent();
        }
    }
    async function recordPage(user: BiliUser, mediaId: number, folderTitle: string, items: Awaited<ReturnType<typeof listFavoriteItemsPage>>["items"], page: number, pageSize = 20, seenAt = new Date(deps.now()).toISOString(), seenBvids?: Set<string>) {
        const assertCurrent = checkpoint();
        assertCurrent();
        let newItems = 0;
        for (const [indexInPage, rawItem] of items.entries()) {
            if (deps.deletions.source(user.id, mediaId, rawItem.bvid)) {
                continue;
            }
            const item = await resolveSelfVisibleItemForSync(user, mediaId, rawItem);
            assertCurrent();
            if (deps.deletions.source(user.id, mediaId, item.bvid))
                continue;
            seenBvids?.add(item.bvid);
            const favOrder = (Math.max(1, page) - 1) * Math.max(1, pageSize) + indexInPage + 1;
            const result = deps.state.recordFavoriteItem(user.id, mediaId, folderTitle, item, {
                favOrder,
                favPage: page,
                favIndexInPage: indexInPage,
            }, seenAt);
            if (!item.unavailable && item.cover) {
                deps.cacheCover(item.bvid, item.cover, (coverLocalPath) => {
                    if (assertCurrent.current())
                        deps.state.recordCoverCache(item.bvid, coverLocalPath);
                });
            }
            if (item.unavailable && !item.selfVisible) {
                const availability = deps.state.getSourceAvailability(item.bvid);
                const shouldAutoProbe = deps.state.listRelationsForBvid(item.bvid).some((relation) => relation.activeInFavorite
                    && relation.sourceKind !== "manual"
                    && !relation.selfVisible
                    && !["uploaded", "verified", "partial_verified"].includes(relation.backupStatus || ""));
                if (shouldAutoProbe && availability && !["confirmed_unavailable", "dormant"].includes(availability.state)) {
                    const persistedNextAt = Date.parse(availability.nextCheckAt || "");
                    const nextAt = Number.isFinite(persistedNextAt) && persistedNextAt > deps.now()
                        ? persistedNextAt
                        : deps.now() + availabilityJitter(item.bvid);
                    if (!availability.nextCheckAt || !Number.isFinite(persistedNextAt) || persistedNextAt <= deps.now()) {
                        deps.state.markAvailabilityPending(item.bvid, "favorite_flag", seenAt, new Date(nextAt).toISOString());
                    }
                    deps.probe(item.bvid, {
                        preferredUserId: user.id,
                        notBefore: nextAt,
                        availabilityRound: availability.checkRound,
                        availabilityReason: availability.reason,
                    });
                }
            }
            if (!result.wasKnown) {
                newItems += 1;
                deps.recordCount(1, 0);
            }
            const queued = deps.enqueue(user, mediaId, folderTitle, item.bvid);
            if (queued) {
                deps.recordCount(0, 1);
            }
        }
        return { newItems };
    }
    return { all: scanAllPages, hot: scanHotPages, history: scanHistoryPages, reset() { epoch++; selfVisibleProbeCache.clear(); } };
}
