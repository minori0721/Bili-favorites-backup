import type { SchedulerSnapshot, SyncCycleStats, TickOptions } from '../scheduler/sync-runtime.js';

/** Commands are the only way a caller can request synchronization work. */
export interface SyncWorkflowCommands {
  run(manual?: boolean, options?: TickOptions): Promise<boolean>;
  triggerOrQueue(options: TickOptions): { started: boolean; queued: boolean };
}

/** Runtime-owned lifecycle operations for one synchronization workflow. */
export interface SyncWorkflowLifecycle {
  start(): void;
  stop(): void;
  isBusy(): boolean;
  isIdle(): boolean;
  waitForIdle(timeoutMs?: number): Promise<boolean>;
  resetAfterRebind(): void;
}

/** Read-only projections; callers cannot mutate the workflow's state. */
export interface SyncWorkflowQueries {
  hasPending(): boolean;
  isSyncing(userId: string): boolean;
  getProgress(): Readonly<SchedulerSnapshot> | null;
  getCycle(): Readonly<SyncCycleStats> | null;
  getPending(): Readonly<TickOptions> | null;
  getLastError(): string;
}

/** Scan callbacks report facts back to the workflow's state owner. */
export interface SyncWorkflowScanReports {
  updateProgress(patch: Partial<SchedulerSnapshot>): void;
  recordScanCounts(fresh: number, queued: number): void;
  addQueuedItems(count: number): void;
  clearPending(): void;
}

/** Explicit composition of the four capabilities used by the scheduler. */
export interface SyncWorkflowPort extends SyncWorkflowCommands, SyncWorkflowLifecycle, SyncWorkflowQueries, SyncWorkflowScanReports {}
