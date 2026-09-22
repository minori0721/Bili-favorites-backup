import type { TickOptions } from './sync-runtime.js';

export interface SyncCommandPort {
  runNow(): { started: boolean; queued: boolean };
  runReconcileNow(): { started: boolean; queued: boolean };
  runRemoteReconcileNow(): { started: boolean; queued: boolean };
}

interface SyncCommandDependencies {
  canRun(): boolean;
  triggerOrQueue(options: TickOptions): { started: boolean; queued: boolean };
  log(message: string): void;
}

/** Keeps manual command parameters out of the runtime coordinator. */
export function createSyncCommands(dependencies: SyncCommandDependencies): SyncCommandPort {
  const trigger = (message: string, options: TickOptions) => {
    dependencies.log(message);
    if (!dependencies.canRun()) return { started: false, queued: false };
    return dependencies.triggerOrQueue(options);
  };
  return {
    runNow: () => trigger('[Scheduler] Manual sync triggered', { trigger: 'manual', skipFavoriteScan: false }),
    runReconcileNow: () => trigger('[Scheduler] Manual reconcile triggered', {
      trigger: 'reconcile', forceFullRemoteVerify: true, forceFullFavoriteScan: true, skipFavoriteScan: false,
    }),
    runRemoteReconcileNow: () => trigger('[Scheduler] Manual remote-only reconcile triggered', {
      trigger: 'remote_reconcile', forceFullRemoteVerify: true, skipFavoriteScan: true,
    }),
  };
}
