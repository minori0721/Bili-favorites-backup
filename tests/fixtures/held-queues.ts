import { TaskQueue, type Task } from '../../src/queue.js';

/** Exercises real scheduling and leases while the fixture owns whether work executes. */
export class HeldQueue extends TaskQueue {
  private admission: ((task: Task) => boolean) | undefined;
  override setStartGate(gate?: (task: Task) => boolean) {
    this.admission = gate;
    super.setStartGate(() => false);
  }
  admitted(task: Task) { return this.admission?.(task) ?? true; }
}
export function heldQueues() {
  const queues = new Map<'download' | 'upload' | 'verification', HeldQueue>();
  return {
    create(stage: 'download' | 'upload' | 'verification', concurrency: number, maxSize: number) {
      const queue = new HeldQueue(concurrency, maxSize);
      queues.set(stage, queue);
      return queue;
    },
    get(stage: 'download' | 'upload' | 'verification') {
      const queue = queues.get(stage);
      if (!queue) throw new Error(`Queue not assembled: ${stage}`);
      return queue;
    },
  };
}
