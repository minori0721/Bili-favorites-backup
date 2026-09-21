export interface ShutdownOptions { closeDatabase?: boolean }

/** Application lifecycle capability; no queues, repositories or task implementations escape. */
export interface SchedulerControl {
  start(): boolean;
  stop(): void;
  beginShutdown(): void;
  shutdown(timeoutMs?: number, options?: ShutdownOptions): Promise<void>;
  isIdle(): boolean;
  waitForIdle(timeoutMs?: number): Promise<boolean>;
  wake(): boolean;
}
