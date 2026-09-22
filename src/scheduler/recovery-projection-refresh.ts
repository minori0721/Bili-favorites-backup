interface RecoveryProjectionRefreshDependencies {
  canRefresh(): boolean;
  reconcileLegacy(): void;
  reconcileTransfers(force: boolean): void;
}

/** Keeps recovery projection admission and ordering in one small coordinator. */
export function createRecoveryProjectionRefresh(dependencies: RecoveryProjectionRefreshDependencies) {
  return {
    refresh(force = false) {
      if (!dependencies.canRefresh()) return;
      dependencies.reconcileLegacy();
      dependencies.reconcileTransfers(force);
    },
  };
}
