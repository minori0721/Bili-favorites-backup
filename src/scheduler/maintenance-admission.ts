import crypto from 'node:crypto';

export type MaintenanceScope = 'cleanup' | 'path_migration' | 'archive_deletion';
export interface MaintenanceLease { readonly scope: MaintenanceScope; readonly id: string; readonly token: string; }

/** Identity based admission barrier. A stale release can never unlock a newer operation. */
export function createMaintenanceAdmission() {
  const active = new Map<MaintenanceScope, MaintenanceLease>();
  const enter = (scope: MaintenanceScope, id: string = crypto.randomUUID()): MaintenanceLease => {
    const existing = active.get(scope);
    if (existing?.id === id) return existing;
    const lease = { scope, id, token: crypto.randomUUID() } satisfies MaintenanceLease;
    active.set(scope, lease);
    return lease;
  };
  const leave = (lease: MaintenanceLease | null | undefined): boolean => {
    if (!lease) return true;
    const current = active.get(lease.scope);
    if (!current) return true;
    if (current.token !== lease.token) return false;
    active.delete(lease.scope);
    return true;
  };
  const leaveById = (scope: MaintenanceScope, id: string): boolean => {
    const current = active.get(scope);
    return Boolean(current && current.id === id && leave(current));
  };
  const isLocked = (scope: MaintenanceScope) => active.has(scope);
  const snapshot = () => new Map(active);
  return { enter, leave, leaveById, isLocked, snapshot };
}
