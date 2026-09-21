import { isAuthRefreshAttemptBlocked, nextAuthRefreshFailureState } from './auth-refresh.js';
import type { getUserInfo, refreshUserAuth } from './bili.js';
import { safeErrorSummary } from './diagnostics.js';
import type { ImportMaintenance } from './import-maintenance.js';
import { waitForQuiescence } from './scheduler/quiescence.js';
import type { UserStore } from './users.js';

export interface AccountRefreshDependencies {
  users: Pick<UserStore, 'getById' | 'list' | 'updatePartial'>;
  maintenance: Pick<ImportMaintenance, 'run' | 'blocked'>;
  refresh: typeof refreshUserAuth;
  info: typeof getUserInfo;
  wake(userId: string): void;
  transfersRunning(): boolean;
  now(): number;
  timers: { set(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clear(timer: ReturnType<typeof setTimeout>): void };
}

/** Owns token refresh requests and the single polling timer for its lifetime. */
export function createAccountRefresh(deps: AccountRefreshDependencies) {
  const { users: userStore, maintenance: importMaintenance, refresh: refreshUserAuth, info: getUserInfo } = deps;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requests = new Map<string, Promise<void>>();
  function refreshUserAuthForStore(userId: string, reason: 'manual' | 'auto' | 'on_error'): Promise<void> {
    if (stopped) return Promise.reject(Object.assign(new Error('Account refresh is stopping'), { statusCode: 503 }));
    const existing = requests.get(userId);
    if (existing) return existing;
    const work = importMaintenance.run(() => refreshUserAuthForStoreUnlocked(userId, reason));
    const tracked = work.finally(() => { requests.delete(userId); });
    requests.set(userId, tracked);
    return tracked;
  }
  async function refreshUserAuthForStoreUnlocked(userId: string, reason: "manual" | "auto" | "on_error") {
    const user = userStore.getById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.accessToken || !user.refreshToken) {
      throw new Error("当前账号缺少 accessToken 或 refreshToken，请重新扫码登录。");
    }

    try {
      const refreshed = await refreshUserAuth(user.accessToken, user.refreshToken);
      const info = await getUserInfo(refreshed.cookie);
      const nowIso = new Date(deps.now()).toISOString();
      userStore.updatePartial(user.id, {
        name: info.name,
        avatar: info.avatar,
        cookie: refreshed.cookie,
        rawAuth: refreshed.rawAuth,
        accessToken: refreshed.accessToken || user.accessToken,
        refreshToken: refreshed.refreshToken || user.refreshToken,
        expires: refreshed.expires || user.expires,
        lastAuthRefreshAt: nowIso,
        lastAuthRefreshError: "",
        authRefreshFailureCategory: undefined,
        authRefreshFailureAttempts: undefined,
        authRefreshRetryAt: undefined,
        lastLoginAt: reason === "manual" ? nowIso : user.lastLoginAt,
      });
      deps.wake(user.id);
    } catch (error) {
      const current = userStore.getById(user.id) || user;
      const failure = nextAuthRefreshFailureState(
        current.authRefreshFailureCategory,
        current.authRefreshFailureAttempts,
        error, deps.now(),
      );
      userStore.updatePartial(user.id, {
        lastAuthRefreshError: safeErrorSummary(error),
        authRefreshFailureCategory: failure.category,
        authRefreshFailureAttempts: failure.attempts,
        authRefreshRetryAt: failure.retryAt,
      });
      throw error;
    }
  }

  // ---------- auto token refresh (biliLive-tools pattern) ----------
  function startTokenRefreshLoop() {
    const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    const RETRY_INTERVAL_ON_BUSY = 60 * 60 * 1000; // 1 hour

    async function checkAndRefresh() {
      if (stopped) return;
      let nextInterval = CHECK_INTERVAL;
      try {
        if (importMaintenance.blocked || deps.transfersRunning()) {
          console.warn("[Auth] Skip auto refresh because transfer tasks are running; retry in 1 hour.");
          nextInterval = RETRY_INTERVAL_ON_BUSY;
          return;
        }

        const users = userStore.list();
        for (const user of users) {
          if (stopped) return;
          const now = deps.now();
          const failureCategory = user.authRefreshFailureCategory;
          const failureAttempts = Math.max(0, Math.floor(Number(user.authRefreshFailureAttempts) || 0));
          const retryAt = user.authRefreshRetryAt ? Date.parse(user.authRefreshRetryAt) : NaN;
          if (isAuthRefreshAttemptBlocked(failureCategory, failureAttempts, user.authRefreshRetryAt, now)) {
            if (Number.isFinite(retryAt) && retryAt > now) {
              nextInterval = Math.min(nextInterval, Math.max(60_000, retryAt - now));
            }
            continue;
          }
          // Refresh if expires in less than 10 days, or if we have refreshToken
          const tenDays = 10 * 24 * 60 * 60 * 1000;
          if (user.refreshToken && user.accessToken) {
            if (!user.expires || user.expires - now < tenDays) {
              console.log(`[Auth] Refreshing token for user ${user.name} (${user.id})`);
              try {
                await refreshUserAuthForStore(user.id, "auto");
                console.log(`[Auth] Token refreshed for user ${user.name}`);
              } catch (error) {
                const updated = userStore.getById(user.id);
                const retry = updated?.authRefreshRetryAt ? Date.parse(updated.authRefreshRetryAt) : NaN;
                if (Number.isFinite(retry)) nextInterval = Math.min(nextInterval, Math.max(60_000, retry - deps.now()));
                console.warn(`[Auth] Token refresh failed for user ${user.name}: ${safeErrorSummary(error)}`);
              }
            }
          }
        }
      } catch (error) {
        console.error(`[Auth] Token refresh check failed: ${safeErrorSummary(error)}`);
        nextInterval = RETRY_INTERVAL_ON_BUSY;
      } finally {
        if (!stopped) timer = deps.timers.set(() => { void checkAndRefresh(); }, nextInterval);
      }
    }

    // Start first check after 1 minute (let server settle)
    timer = deps.timers.set(() => { void checkAndRefresh(); }, 60_000);
  }

  return {
    refresh: refreshUserAuthForStore,
    start() { if (started || stopped) return; started = true; startTokenRefreshLoop(); },
    stop(timeoutMs: number) {
      stopped = true;
      if (timer !== undefined) { deps.timers.clear(timer); timer = undefined; }
      return waitForQuiescence(() => requests.size > 0, timeoutMs);
    },
  };
}
