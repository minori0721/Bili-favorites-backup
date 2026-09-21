import type { getUserInfo, normalizeTvAuthResult } from './bili.js';
import type { UserStore } from './users.js';
import type { ImportMaintenance } from './import-maintenance.js';
import { safeErrorSummary } from './diagnostics.js';
import { waitForQuiescence } from './scheduler/quiescence.js';

export interface QrLoginPort {
  login(): Promise<string>;
  completed(callback: (result: unknown) => void): void;
  failed(callback: (error: unknown) => void): void;
  stop(): void;
}
interface Session {
  status: 'pending' | 'completed' | 'error';
  message?: string;
  updatedAt: number;
  login: QrLoginPort;
  handling: boolean;
}
export function createAccountLogin(deps: {
  create(): QrLoginPort;
  qr(url: string): Promise<string>;
  normalize: typeof normalizeTvAuthResult;
  info: typeof getUserInfo;
  users: Pick<UserStore, 'upsert'>;
  maintenance: Pick<ImportMaintenance, 'enter'>;
  restore(id: string): void;
  id(): string;
  now(): number;
}) {
  const sessions = new Map<string, Session>();
  const active = new Set<Promise<unknown>>();
  let generation = 0;
  let stopped = false;
  function track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => { active.delete(tracked); });
    active.add(tracked);
    return tracked;
  }
  function prune() {
    for (const [id, session] of sessions) {
      if (deps.now() - session.updatedAt > 10 * 60_000) {session.login.stop(); sessions.delete(id);}
    }
  }
  function invalidate() {
    generation++;
    for (const session of sessions.values()) session.login.stop();
    sessions.clear();
  }
  function start() {
    if (stopped) return Promise.reject(new Error('账号登录服务已停止'));
    prune();
    const expected = generation;
    const loginId = deps.id();
    const login = deps.create();
    const session: Session = {status: 'pending', updatedAt: deps.now(), login, handling: false};
    sessions.set(loginId, session);
    const current = () => !stopped && expected === generation && sessions.get(loginId) === session;
    function fail(error: unknown) {
      if (!current() || session.status !== 'pending') return;
      session.status = 'error'; session.message = safeErrorSummary(error, 'Login failed'); session.updatedAt = deps.now();
      login.stop();
    }
    async function complete(result: unknown) {
      let release: (() => void) | undefined;
      try {
        release = deps.maintenance.enter();
        const auth = deps.normalize(result);
        const info = await deps.info(auth.cookie);
        if (!current() || session.status !== 'pending') return;
        const id = String(info.uid);
        const now = new Date(deps.now()).toISOString();
        deps.users.upsert({id, uid: info.uid, name: info.name, avatar: info.avatar, cookie: auth.cookie,
          favorites: [], enabled: true, lastLoginAt: now, rawAuth: auth.rawAuth,
          accessToken: auth.accessToken, refreshToken: auth.refreshToken, expires: auth.expires,
          lastAuthRefreshAt: now, lastAuthRefreshError: '', authRefreshFailureCategory: undefined,
          authRefreshFailureAttempts: undefined, authRefreshRetryAt: undefined,
        });
        deps.restore(id);
        session.status = 'completed'; session.updatedAt = deps.now();
        login.stop();
      } catch (error) { fail(error); }
      finally { release?.(); }
    }
    login.completed(result => {
      if (!current() || session.status !== 'pending' || session.handling) return;
      session.handling = true;
      void track(complete(result));
    });
    login.failed(fail);
    return track((async () => {
      try {
        const url = await login.login();
        // login() can finish creating its polling timer after stop() was called.
        if (!current()) throw new Error('登录请求已失效');
        const qrDataUrl = await deps.qr(url);
        if (!current()) throw new Error('登录请求已失效');
        return {loginId, qrDataUrl};
      } catch (error) {
        login.stop(); sessions.delete(loginId); throw error;
      }
    })());
  }
  return {start, invalidate,
    status(id: string) {prune(); const value = sessions.get(id); return value ? {status: value.status, message: value.message} : undefined;},
    stop(timeout: number) {stopped = true; invalidate(); return waitForQuiescence(() => active.size > 0, timeout);},
  };
}
