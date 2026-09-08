export interface RecoveryLockAccess {
  has(key: string): boolean;
  add(key: string): void;
  delete(key: string): boolean;
}

/** Shared recovery ownership: assessments deduplicate, all actions use the same keyed locks. */
export function createRecoveryWork<Result>() {
  const locks = new Set<string>();
  const pending = new Map<string, Promise<Result>>();
  const access: RecoveryLockAccess = {
    has: key => locks.has(key),
    add: key => { locks.add(key); },
    delete: key => locks.delete(key),
  };
  return {
    locks: access,
    get busy() { return pending.size > 0 || locks.size > 0; },
    run(key: string, work: () => Promise<Result>) {
      const existing = pending.get(key);
      if (existing) return existing;
      // Register before calling collaborators, including synchronous reentry.
      const promise = Promise.resolve().then(work).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
      return promise;
    },
  };
}
