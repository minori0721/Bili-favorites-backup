import type { DownloadCacheInspection, DownloadRecoverySummary } from '../download-session.js';

export interface LocalCapacitySnapshot {
  limitBytes: number;
  usedBytes: number;
  reserveBytes: number;
  paused: boolean;
  checkedAt: number;
}

export function createLocalCapacity(deps: {
  limitGB(): number | undefined;
  inspect(): Promise<DownloadCacheInspection>;
  now(): number;
  generation(): number;
  canRun(): boolean;
  wake(): void;
  failed(error: unknown): void;
}) {
  const ttlMs = 10_000;
  let epoch = 0;
  let snapshot: LocalCapacitySnapshot | null = null;
  let pending: Promise<LocalCapacitySnapshot> | null = null;
  let wakePending: Promise<LocalCapacitySnapshot> | null = null;
  let refreshQueued = false;
  let dirty = false;
  let recovery: DownloadRecoverySummary = {
    resumableSessions: 0, completedPages: 0, totalPages: 0, retainedBytes: 0,
    legacyDirectories: 0, legacyBytes: 0, cleanupEligibleBytes: 0,
  };
  function limitBytes() {
    const value = Number(deps.limitGB() || 0);
    return value > 0 ? value * 1024 ** 3 : 0;
  }
  function reserveBytes(limit = limitBytes()) {
    return limit <= 0 ? 0 : Math.min(limit, Math.max(512 * 1024 ** 2, Math.floor(limit * 0.1)));
  }
  function view(): LocalCapacitySnapshot {
    const limit = limitBytes();
    if (snapshot && snapshot.limitBytes === limit) return { ...snapshot };
    const used = snapshot?.usedBytes ?? 0;
    const reserve = reserveBytes(limit);
    return { limitBytes: limit, usedBytes: used, reserveBytes: reserve,
      paused: limit > 0 && (!snapshot || used >= Math.max(0, limit - reserve)), checkedAt: snapshot?.checkedAt ?? 0 };
  }
  function refresh(force = false): Promise<LocalCapacitySnapshot> {
    if (force) dirty = true;
    if (pending) {
      if (force) refreshQueued = true;
      return pending;
    }
    const limit = limitBytes();
    if (!force && !dirty && snapshot && deps.now() - snapshot.checkedAt < ttlMs && snapshot.limitBytes === limit) return Promise.resolve({ ...snapshot });
    const generation = deps.generation();
    const currentEpoch = epoch;
    const work = (async () => {
      const inspection = await deps.inspect();
      const reserve = reserveBytes(limit);
      const result = { limitBytes: limit, usedBytes: inspection.usedBytes, reserveBytes: reserve,
        paused: limit > 0 && inspection.usedBytes >= Math.max(0, limit - reserve), checkedAt: deps.now() };
      if (generation === deps.generation() && currentEpoch === epoch) {
        snapshot = result;
        dirty = false;
        recovery = { ...inspection.recovery };
      }
      return result;
    })().finally(() => {
      if (pending !== work) return;
      pending = null;
      const queued = refreshQueued;
      refreshQueued = false;
      if (queued && deps.canRun()) refreshAndWake(true);
    });
    pending = work;
    return work;
  }
  function refreshAndWake(force = false) {
    const generation = deps.generation();
    const currentEpoch = epoch;
    const work = refresh(force);
    if (wakePending === work) return;
    wakePending = work;
    void work.then(() => {
      if (!pending && deps.canRun() && generation === deps.generation() && currentEpoch === epoch) deps.wake();
    }).catch(deps.failed).finally(() => { if (wakePending === work) wakePending = null; });
  }
  return {
    refresh, refreshAndWake, view,
    ensureFresh() {
      if (pending) return;
      if (dirty || !snapshot || snapshot.limitBytes !== limitBytes()) refreshAndWake(true);
      else if (deps.now() - snapshot.checkedAt >= ttlMs) refreshAndWake();
    },
    reconfigure() {
      const limit = limitBytes();
      if (limit > 0) snapshot = { limitBytes: limit, usedBytes: snapshot?.usedBytes ?? 0,
        reserveBytes: reserveBytes(limit), paused: true, checkedAt: snapshot?.checkedAt ?? 0 };
      refreshAndWake(true);
    },
    stop() { refreshQueued = false; },
    reset() { epoch++; snapshot = null; dirty = true; refreshQueued = false; },
    get pending() { return pending; },
    get recovery() { return { ...recovery }; },
  };
}
