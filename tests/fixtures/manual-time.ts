import type { ClockPort } from '../../src/ports/external.js';
import type { ScheduleTimer } from '../../src/ports/timer.js';

/** Explicitly advances scheduler time; never executes network or queue workers. */
export class ManualTime implements ClockPort {
  private instant = 1_800_000_000_000;
  private nextId = 0;
  private timers = new Map<number, { at: number; delay: number; recurring: boolean; callback(): void }>();
  readonly schedule: ScheduleTimer = (callback, delayMs, recurring) => {
    const id = ++this.nextId;
    this.timers.set(id, {at: this.instant + Math.max(0, delayMs), delay: delayMs, recurring, callback});
    return () => { this.timers.delete(id); };
  };
  now = () => this.instant;
  random = () => 0;
  sleep = (ms: number) => new Promise<void>(resolve => { this.schedule(resolve, ms, false); });
  get pending() { return this.timers.size; }
  advance(ms: number) {
    const until = this.instant + ms;
    let invocations = 0;
    while (true) {
      const next = [...this.timers].filter(([,timer]) => timer.at <= until)
        .sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++invocations > 10_000) throw new Error('Zero-delay timer loop');
      const [id, timer] = next;
      this.instant = timer.at;
      if (timer.recurring) timer.at += timer.delay;
      else this.timers.delete(id);
      timer.callback();
    }
    this.instant = until;
    return invocations;
  }
}
