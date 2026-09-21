/** A cancellation handle must invalidate callbacks already queued by the adapter. */
export type ScheduleTimer = (callback: () => void, delayMs: number, recurring: boolean) => () => void;
